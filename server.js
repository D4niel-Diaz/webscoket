import { createServer } from 'http';
import { Server } from 'socket.io';
import axios from 'axios';
import dotenv from 'dotenv';
import {
  connectRedis,
  disconnectRedis,
  getRedis,
  setGuestSocket,
  getGuestSocketId,
  setGuestChat,
  getGuestChat,
  deleteGuestChat,
  addGuestToRoom,
  getRoomGuests,
  deleteRoom,
  setPendingMatch,
  takePendingMatch,
  addPendingMessage,
  takePendingMessages,
  deletePendingMessages,
  incrementConnections,
  decrementConnections,
  getConnectionCount,
  isAuthBlocked,
  recordAuthFailure,
  checkMessageRateLimit,
  cleanupGuest,
} from './redisStore.js';

dotenv.config();

// ─── Configuration ────────────────────────────────────────────────────────────
const int = (name, fallback) => {
  const value = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
};

const PORT              = process.env.PORT            || 3001;
const LARAVEL_API_URL   = process.env.LARAVEL_API_URL || 'http://localhost:8000/api/v1';
const CORS_ORIGIN       = process.env.CORS_ORIGIN     || 'http://localhost:5173';
const IS_PRODUCTION     = process.env.NODE_ENV === 'production';
// Behind Render's proxy the socket address is the proxy; use X-Forwarded-For instead
const TRUST_PROXY       = process.env.TRUST_PROXY === 'true';

// Campus users often share one public IP, so these defaults are generous
const MAX_CONNECTIONS_PER_IP = int('MAX_CONNECTIONS_PER_IP', IS_PRODUCTION ? 200 : 50);
const MAX_AUTH_FAILURES      = int('MAX_AUTH_FAILURES', 30);   // failed handshakes per IP per minute
const MESSAGE_RATE_LIMIT     = int('MESSAGE_RATE_LIMIT', 10);
const MESSAGE_RATE_WINDOW    = int('MESSAGE_RATE_WINDOW', 60); // seconds
const HEARTBEAT_INTERVAL     = int('HEARTBEAT_INTERVAL', 30000);
const MATCH_RETRY_INTERVAL   = int('MATCH_RETRY_INTERVAL', 2000);
// How long a dropped socket may reconnect before its chat is ended
const DISCONNECT_GRACE_MS    = int('DISCONNECT_GRACE_MS', 15000);
const ACK_TIMEOUT_MS         = 5000;

// ─── Local (per-process) state ────────────────────────────────────────────────
// Live socket objects can't be stored in Redis. NOTE: partner delivery uses this
// map, so run a single instance (or add the Socket.IO Redis adapter) to scale out.
const connectedGuests  = new Map(); // guestId -> socket
const disconnectTimers = new Map(); // guestId -> timeout pending final cleanup

// ─── HTTP server (health check only) ─────────────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.url?.startsWith('/socket.io/')) return; // handled by Socket.IO

  const redisStatus = getRedis()?.status ?? 'disconnected';
  const healthy = redisStatus === 'ready';
  res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status:      healthy ? 'ok' : 'degraded',
    service:     'websocket-server',
    timestamp:   new Date().toISOString(),
    connections: connectedGuests.size,
    redis:       redisStatus,
  }));
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [CORS_ORIGIN]),
  ...(process.env.ALLOWED_ORIGINS || '').split(','),
].map((o) => o.trim()).filter(Boolean);

const corsOriginChecker = (origin, callback) => {
  // Non-browser clients (server-to-server, smoke test) send no Origin
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  if (!IS_PRODUCTION) return callback(null, true);

  console.warn(`CORS rejected origin: ${origin}`);
  callback(new Error('Not allowed by CORS'));
};

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin:      corsOriginChecker,
    methods:     ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout:       int('PING_TIMEOUT', 20000),
  pingInterval:      int('PING_INTERVAL', 25000),
  maxHttpBufferSize: int('MAX_HTTP_BUFFER_SIZE', 1_000_000),
  transports:        ['websocket', 'polling'],
});

io.engine.on('connection_error', (err) => {
  console.error('Engine.IO connection_error:', { code: err.code, message: err.message });
});

// ─── Laravel API helpers ──────────────────────────────────────────────────────

const api = (sessionToken, timeout = 5000) => ({
  headers: { Authorization: `Bearer ${sessionToken}`, Accept: 'application/json' },
  timeout,
});

/** Read-only session check; does not extend the session. */
async function validateSession(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.length < 10) {
    return null;
  }

  try {
    const response = await axios.get(`${LARAVEL_API_URL}/guest/validate`, api(sessionToken, 10000));
    const guestId = response.data?.data?.guest_id;
    return response.data?.success && guestId ? { guestId } : null;
  } catch (error) {
    if (error.response) {
      console.error('❌ Session validation rejected:', error.response.status);
    } else {
      console.error('❌ Session validation — no response (is the Laravel backend running?):', error.message);
    }
    return null;
  }
}

async function startChat(sessionToken) {
  const response = await axios.post(`${LARAVEL_API_URL}/chat/start`, null, api(sessionToken));
  return response.data;
}

async function persistMessage(chatId, content, sessionToken) {
  const response = await axios.post(
    `${LARAVEL_API_URL}/chat/message`,
    { chat_id: chatId, content },
    api(sessionToken)
  );
  return response.data.data;
}

/** Returns true when Laravel ended the chat or it was already ended. */
async function notifyChatEnd(chatId, sessionToken) {
  try {
    await axios.post(`${LARAVEL_API_URL}/chat/end`, { chat_id: chatId }, api(sessionToken));
    return true;
  } catch (error) {
    // 404 means the chat is already ended or we're not a participant: nothing to undo
    if (error.response?.status === 404) return true;
    console.error(`Failed to end chat ${chatId} in Laravel:`, error.message);
    return false;
  }
}

function notifyPresence(path, sessionToken, guestId) {
  axios.post(`${LARAVEL_API_URL}/presence/${path}`, {}, api(sessionToken))
    .catch((err) => console.error(`presence/${path} failed for ${guestId}:`, err.message));
}

/** Laravel error message for a failed request, if it sent one. */
const apiErrorMessage = (error, fallback) => error.response?.data?.message || fallback;

function clientIp(socket) {
  if (TRUST_PROXY) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return socket.handshake.address;
}

/** Emit to a guest's live socket, or queue it for when they reconnect. */
async function deliverToGuest(guestId, chatId, event, payload) {
  const socket = connectedGuests.get(guestId);
  if (socket?.connected) {
    socket.emit(event, payload);
    return;
  }
  if (event === 'message') await addPendingMessage(chatId, guestId, payload);
}

/** Remove chat state for both participants and tell the other side. */
async function closeChat(chatId, endedBy) {
  const participants = await getRoomGuests(chatId);
  const payload = { chat_id: chatId, ended_by: endedBy, ended_at: new Date().toISOString() };

  for (const participantId of participants) {
    connectedGuests.get(participantId)?.emit('chat:ended', payload);
    await deleteGuestChat(participantId);
    await deletePendingMessages(chatId, participantId);
  }
  await deleteRoom(chatId);
}

// ─── Auth middleware ───────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  const ip = clientIp(socket);

  try {
    if (await isAuthBlocked(ip, MAX_AUTH_FAILURES)) {
      return next(new Error('Too many authentication attempts. Please try again later.'));
    }

    const sessionToken   = socket.handshake.auth?.token;
    const claimedGuestId = socket.handshake.auth?.guestId;

    const session = await validateSession(sessionToken);
    if (!session) {
      await recordAuthFailure(ip);
      return next(new Error('Authentication failed: Invalid session. Please refresh the page.'));
    }

    if (claimedGuestId && claimedGuestId !== session.guestId) {
      await recordAuthFailure(ip);
      return next(new Error('Authentication failed: Guest mismatch'));
    }

    if ((await getConnectionCount(ip)) >= MAX_CONNECTIONS_PER_IP) {
      console.warn(`[WS] Connection limit reached for IP ${ip}`);
      return next(new Error(`Too many connections from this IP (max ${MAX_CONNECTIONS_PER_IP}). Please close other tabs.`));
    }

    socket.sessionToken = sessionToken;
    socket.guestId      = session.guestId;
    socket.ip           = ip;

    await incrementConnections(ip);
    next();
  } catch (error) {
    console.error('❌ Auth error:', error.message);
    next(new Error('Authentication failed: server error'));
  }
});

// ─── Connection handler ───────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  const { guestId, sessionToken, ip } = socket;
  console.log(`✅ Guest connected: ${guestId}`);

  socket._matchRetryInterval = null;

  // A reconnect within the grace period keeps the guest's chat alive
  const pendingCleanup = disconnectTimers.get(guestId);
  if (pendingCleanup) {
    clearTimeout(pendingCleanup);
    disconnectTimers.delete(guestId);
  }

  // Replace a stale socket for the same guest (e.g. a second tab or a reconnect
  // that raced the old disconnect). The old one must not end the chat.
  const existingSocket = connectedGuests.get(guestId);
  if (existingSocket && existingSocket.id !== socket.id) {
    existingSocket._replaced = true;
    if (existingSocket._matchRetryInterval) clearInterval(existingSocket._matchRetryInterval);
    existingSocket.disconnect(true);
  }
  connectedGuests.set(guestId, socket);

  const stopMatchRetry = () => {
    if (socket._matchRetryInterval) {
      clearInterval(socket._matchRetryInterval);
      socket._matchRetryInterval = null;
    }
  };

  const attemptMatch = async () => {
    if (socket._matching) return; // previous attempt still in flight
    socket._matching = true;
    let markedPartner = null; // set once this attempt owns notifying both sides
    let notified = false;

    try {
      const result = await startChat(sessionToken);
      const data   = result?.data;
      if (!result?.success || (data?.status !== 'matched' && data?.status !== 'already_matched')) return;

      const chatId    = Number(data.chat_id);
      const partnerId = data.partner_id;
      if (!chatId || !partnerId || partnerId === guestId) return;

      stopMatchRetry();

      // Both guests' match attempts can be in flight at once: the first one to
      // finish notifies both sides, and the other gets "already_matched" for the
      // same chat. Mark both sockets synchronously (before any await) so the
      // second attempt sends nothing instead of a duplicate match:found.
      if (socket._notifiedChatId === chatId) return;
      socket._notifiedChatId = chatId;
      const partnerSocket = connectedGuests.get(partnerId);
      if (partnerSocket) partnerSocket._notifiedChatId = chatId;
      markedPartner = partnerSocket || true;

      await Promise.all([
        setGuestChat(guestId, chatId),
        setGuestChat(partnerId, chatId),
        addGuestToRoom(chatId, guestId),
        addGuestToRoom(chatId, partnerId),
      ]);

      socket.emit('match:found', { chat_id: chatId, partner_id: partnerId, started_at: data.started_at });
      notified = true;

      const partnerPayload = { chat_id: chatId, partner_id: guestId, started_at: data.started_at };
      if (partnerSocket?.connected) {
        // The partner's own retry loop would otherwise keep calling /chat/start
        if (partnerSocket._matchRetryInterval) {
          clearInterval(partnerSocket._matchRetryInterval);
          partnerSocket._matchRetryInterval = null;
        }
        partnerSocket.emit('match:found', partnerPayload);
      } else {
        await setPendingMatch(partnerId, partnerPayload);
      }
    } catch (_) {
      // Transient failure (or rate limit). If it happened after this attempt
      // claimed the notification but before anyone was told, undo the marks and
      // keep retrying so the match is still delivered.
      if (markedPartner && !notified) {
        socket._notifiedChatId = null;
        if (markedPartner !== true) markedPartner._notifiedChatId = null;
        if (!socket._matchRetryInterval && socket.connected) {
          socket._matchRetryInterval = setInterval(attemptMatch, MATCH_RETRY_INTERVAL);
        }
      }
    } finally {
      socket._matching = false;
    }
  };

  // ── Socket event handlers ─────────────────────────────────────────────────
  // Registered before any await so no early client events are missed.

  socket.on('presence:join', () => {
    stopMatchRetry();
    attemptMatch();
    socket._matchRetryInterval = setInterval(attemptMatch, MATCH_RETRY_INTERVAL);
  });

  socket.on('presence:leave', () => {
    stopMatchRetry();
  });

  socket.on('message:send', async (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const normalizedChatId = Number(data?.chatId);
    const content          = data?.content;

    if (!normalizedChatId || typeof content !== 'string' || content.trim() === '') {
      return reply({ success: false, error: 'Invalid message data' });
    }
    if (content.length > 1000) {
      return reply({ success: false, error: 'Message too long (max 1000 characters)' });
    }

    try {
      if (await checkMessageRateLimit(guestId, MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW)) {
        return reply({ success: false, error: 'You are sending messages too fast. Please slow down.' });
      }

      if ((await getGuestChat(guestId)) !== normalizedChatId) {
        return reply({ success: false, error: 'Not in this chat' });
      }

      const persisted = await persistMessage(normalizedChatId, content, sessionToken);

      const message = {
        message_id:      persisted.message_id,
        sender_guest_id: guestId,
        chat_id:         normalizedChatId,
        content:         persisted.content,
        created_at:      persisted.created_at,
        is_flagged:      persisted.is_flagged || false,
      };

      const participants = await getRoomGuests(normalizedChatId);
      for (const participantId of participants) {
        if (participantId !== guestId) {
          await deliverToGuest(participantId, normalizedChatId, 'message', message);
        }
      }

      reply({ success: true, message });
    } catch (error) {
      reply({ success: false, error: apiErrorMessage(error, 'Failed to send message') });
    }
  });

  const relayTyping = (isTyping) => async (data) => {
    try {
      const normalizedChatId = Number(data?.chatId);
      if (!normalizedChatId || (await getGuestChat(guestId)) !== normalizedChatId) return;

      const participants = await getRoomGuests(normalizedChatId);
      for (const participantId of participants) {
        if (participantId !== guestId) {
          connectedGuests.get(participantId)?.emit('typing', { sender_guest_id: guestId, is_typing: isTyping });
        }
      }
    } catch (error) {
      console.error('Typing relay failed:', error.message);
    }
  };

  socket.on('typing:start', relayTyping(true));
  socket.on('typing:stop', relayTyping(false));

  // Restore room membership after a WS server restart (Redis state lost or stale)
  socket.on('chat:rejoin', async (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const normalizedChatId = Number(data?.chatId);
    if (!normalizedChatId) return reply({ success: false, error: 'Invalid chat' });

    try {
      if ((await getGuestChat(guestId)) === normalizedChatId) {
        await addGuestToRoom(normalizedChatId, guestId);
        return reply({ success: true });
      }

      // Laravel confirms participation and whether the chat is still active
      const response = await axios.get(
        `${LARAVEL_API_URL}/chat/${normalizedChatId}/messages`,
        { ...api(sessionToken), params: { limit: 1 } }
      );

      if (response.data?.data?.chat_status !== 'active') {
        socket.emit('chat:ended', { chat_id: normalizedChatId, ended_by: null, ended_at: new Date().toISOString() });
        return reply({ success: false, error: 'Chat has ended' });
      }

      await setGuestChat(guestId, normalizedChatId);
      await addGuestToRoom(normalizedChatId, guestId);
      reply({ success: true });
    } catch (error) {
      console.error(`Failed to rejoin chat ${normalizedChatId}:`, error.message);
      reply({ success: false, error: 'Could not rejoin chat' });
    }
  });

  socket.on('chat:end', async (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    const normalizedChatId = Number(data?.chatId);

    try {
      if (!normalizedChatId || (await getGuestChat(guestId)) !== normalizedChatId) {
        return reply({ success: false, error: 'Not in this chat' });
      }

      if (!(await notifyChatEnd(normalizedChatId, sessionToken))) {
        return reply({ success: false, error: 'Could not end chat. Please try again.' });
      }

      await closeChat(normalizedChatId, guestId);
      reply({ success: true });
    } catch (error) {
      console.error('Error ending chat:', error.message);
      reply({ success: false, error: 'Could not end chat. Please try again.' });
    }
  });

  socket.on('disconnect', async (reason) => {
    console.log(`❌ Guest disconnected: ${guestId}, reason: ${reason}`);
    stopMatchRetry();

    try {
      await decrementConnections(ip);
    } catch (error) {
      console.error('Failed to decrement connection count:', error.message);
    }

    // A newer socket for this guest took over; it owns the chat now
    if (socket._replaced) return;

    if (connectedGuests.get(guestId) === socket) connectedGuests.delete(guestId);

    // Give the guest time to reconnect (network blip, page navigation) before
    // ending their chat for both sides.
    const timer = setTimeout(async () => {
      disconnectTimers.delete(guestId);
      try {
        const currentSocketId = await getGuestSocketId(guestId);
        if (connectedGuests.has(guestId) || (currentSocketId && currentSocketId !== socket.id)) {
          return; // reconnected (possibly to another instance)
        }

        const chatId = await getGuestChat(guestId);
        if (chatId) {
          await notifyChatEnd(chatId, sessionToken);
          await closeChat(chatId, guestId);
        }

        notifyPresence('disconnect', sessionToken, guestId);
        await cleanupGuest(guestId);
      } catch (error) {
        console.error(`Cleanup after disconnect failed for ${guestId}:`, error.message);
      }
    }, DISCONNECT_GRACE_MS);

    disconnectTimers.set(guestId, timer);
  });

  // ── Async connection setup ────────────────────────────────────────────────
  try {
    await setGuestSocket(guestId, socket.id);
    notifyPresence('heartbeat', sessionToken, guestId);

    // Deliver anything queued while the guest was briefly disconnected
    const pendingMatch = await takePendingMatch(guestId);
    if (pendingMatch) socket.emit('match:found', pendingMatch);

    const chatId = await getGuestChat(guestId);
    if (chatId) {
      const pending = await takePendingMessages(chatId, guestId);
      pending.forEach((msg) => socket.emit('message', msg));
    }
  } catch (error) {
    console.error(`Connection setup failed for ${guestId}:`, error.message);
  }
});

// ─── Stale local socket sweep ─────────────────────────────────────────────────
const sweepInterval = setInterval(() => {
  connectedGuests.forEach((sock, guestId) => {
    if (!sock.connected) connectedGuests.delete(guestId);
  });
}, HEARTBEAT_INTERVAL);

// ─── Server startup ───────────────────────────────────────────────────────────
const startServer = async () => {
  console.log('🚀 Starting WebSocket server...');
  console.log(`📋 PORT:        ${PORT}`);
  console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📋 Backend API: ${LARAVEL_API_URL}`);

  try {
    await connectRedis(process.env.REDIS_URL);
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
    console.error('Cannot start without Redis — set REDIS_URL in .env');
    process.exit(1);
  }

  httpServer.on('error', (err) => {
    console.error('❌ Server error:', err);
    if (err.code === 'EADDRINUSE') console.error(`❌ Port ${PORT} is already in use`);
    process.exit(1);
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ WebSocket server running on port ${PORT}`);
  });
};

startServer();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down gracefully`);
  clearInterval(sweepInterval);
  disconnectTimers.forEach(clearTimeout);
  io.close(async () => {
    await disconnectRedis().catch(() => {});
    console.log('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
