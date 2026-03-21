import { createServer } from 'http';
import { Server } from 'socket.io';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  connectRedis,
  setGuestSocket,
  getGuestSocketId,
  deleteGuestSocket,
  setGuestChat,
  getGuestChat,
  deleteGuestChat,
  addGuestToRoom,
  removeGuestFromRoom,
  getRoomGuests,
  deleteRoom,
  addToWaiting,
  removeFromWaiting,
  isInWaiting,
  setPendingMatch,
  getPendingMatch,
  deletePendingMatch,
  addPendingMessage,
  getPendingMessages,
  deletePendingMessages,
  incrementConnections,
  decrementConnections,
  getConnectionCount,
  checkAuthRateLimit,
  checkMessageRateLimit,
  cleanupGuest,
} from './redisStore.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT             = process.env.PORT             || 3001;
const LARAVEL_API_URL  = process.env.LARAVEL_API_URL  || 'http://localhost:8000/api/v1';
const CORS_ORIGIN      = process.env.CORS_ORIGIN      || 'http://localhost:5173';
const REDIS_URL        = process.env.REDIS_URL        || 'redis://localhost:6379';

const MAX_CONNECTIONS_PER_IP = parseInt(
  process.env.MAX_CONNECTIONS_PER_IP || (process.env.NODE_ENV === 'production' ? '5' : '20'), 10
);
const MESSAGE_RATE_LIMIT  = parseInt(process.env.MESSAGE_RATE_LIMIT  || '10',    10);
const MESSAGE_RATE_WINDOW = parseInt(process.env.MESSAGE_RATE_WINDOW || '60',    10); // seconds
const PRESENCE_TIMEOUT    = parseInt(process.env.PRESENCE_TIMEOUT    || '90000', 10);
const HEARTBEAT_INTERVAL  = parseInt(process.env.HEARTBEAT_INTERVAL  || '30000', 10);
const MATCH_RETRY_INTERVAL= parseInt(process.env.MATCH_RETRY_INTERVAL|| '2000',  10);

// ─── Local (per-process) state ────────────────────────────────────────────────
// connectedGuests and messageSequenceNumbers remain in-memory because they
// track live socket objects and per-message ordering respectively —
// both are inherently per-process and don't need cross-instance sharing.
const connectedGuests        = new Map(); // guestId -> socket (local only — socket objects can't be serialized)
const messageSequenceNumbers = new Map(); // chatId  -> number (resets on reconnect — acceptable)
// All other state (chatRooms, guestToChat, pendingMessages, pendingMatch,
// rateLimiting, connectionCounts) is now in Redis via redisStore.js.

// ─── HTTP server (health check only) ─────────────────────────────────────────
const httpServer = createServer((req, res) => {
  // Let Socket.IO handle its own routes
  if (req.url?.startsWith('/socket.io/')) return;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status:      'ok',
    service:     'websocket-server',
    timestamp:   new Date().toISOString(),
    connections: connectedGuests.size, // live sockets on this process
    redis:       'connected',          // if we reach here, redis startup succeeded
  }));
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
// SECURITY FIX: Removed wildcard *.vercel.app — any Vercel app could connect.
// Only explicit origins are allowed in production.
const getCorsOriginChecker = () => {
  // Start with explicitly configured origins
  const origins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : [CORS_ORIGIN];

  // Add specific known production origins
  if (process.env.NODE_ENV === 'production') {
    const productionOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
    productionOrigins.forEach(o => { if (!origins.includes(o)) origins.push(o); });
  }

  return (origin, callback) => {
    // Allow requests with no origin (server-to-server, Postman, mobile)
    if (!origin) return callback(null, true);

    if (origins.includes(origin)) return callback(null, true);

    // In development, allow everything
    if (process.env.NODE_ENV !== 'production') return callback(null, true);

    console.warn(`CORS rejected origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  };
};

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin:      getCorsOriginChecker(),
    methods:     ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout:       parseInt(process.env.PING_TIMEOUT    || '60000', 10),
  pingInterval:      parseInt(process.env.PING_INTERVAL   || '25000', 10),
  maxHttpBufferSize: (() => {
    const val = Number(process.env.MAX_HTTP_BUFFER_SIZE || 1_000_000);
    return Number.isFinite(val) && val > 0 ? val : 1_000_000;
  })(),
  transports:    ['websocket', 'polling'],
  allowUpgrades: true,
  upgradeTimeout: 10000,
});

io.engine.on('connection_error', (err) => {
  console.error('Engine.IO connection_error:', { code: err.code, message: err.message });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * SECURITY FIX: Use the read-only GET /guest/validate instead of the
 * state-changing POST /guest/refresh. This avoids unintended session
 * extensions on every WebSocket handshake.
 */
async function validateSession(sessionToken) {
  try {
    if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.length < 10) {
      console.error('❌ Invalid session token format');
      return null;
    }

    const response = await axios.get(
      `${LARAVEL_API_URL}/guest/validate`,
      {
        headers: { Authorization: `Bearer ${sessionToken}` },
        timeout: 10000,
      }
    );

    if (!response.data?.success || !response.data?.data?.guest_id) {
      console.error('❌ Session validation failed:', response.data);
      return null;
    }

    return { guestId: response.data.data.guest_id };
  } catch (error) {
    if (error.response) {
      console.error('❌ Session validation — backend error:', {
        status:  error.response.status,
        data:    error.response.data,
        url:     `${LARAVEL_API_URL}/guest/validate`,
      });
    } else {
      console.error('❌ Session validation — no response:', {
        message: error.message,
        code:    error.code,
        hint:    'Is the Laravel backend running?',
      });
    }
    return null;
  }
}

async function startChat(sessionToken) {
  const response = await axios.post(
    `${LARAVEL_API_URL}/chat/start`,
    null,
    { headers: { Authorization: `Bearer ${sessionToken}` }, timeout: 5000 }
  );
  return response.data;
}

async function persistMessage(chatId, content, sessionToken) {
  try {
    const response = await axios.post(
      `${LARAVEL_API_URL}/chat/message`,
      { chat_id: chatId, content },
      { headers: { Authorization: `Bearer ${sessionToken}` }, timeout: 5000 }
    );
    return response.data.data;
  } catch (error) {
    console.error('Failed to persist message:', error.message);
    throw error;
  }
}

async function notifyChatEnd(chatId, sessionToken) {
  try {
    await axios.post(
      `${LARAVEL_API_URL}/chat/end`,
      { chat_id: chatId },
      { headers: { Authorization: `Bearer ${sessionToken}` }, timeout: 5000 }
    );
  } catch (error) {
    console.error('Failed to notify chat end:', error.message);
  }
}

/**
 * Message rate limit check — delegates to Redis.
 * Returns true if the guest is WITHIN the limit (allowed), false if over.
 */
async function checkRateLimit(guestId) {
  const limited = await checkMessageRateLimit(guestId, MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW);
  return !limited; // returns true = allowed
}

/** Connection count check — delegates to Redis. */
async function checkConnectionLimit(ip) {
  const count   = await getConnectionCount(ip);
  const allowed = count < MAX_CONNECTIONS_PER_IP;
  if (!allowed) console.warn(`[WS] Connection limit exceeded for IP ${ip}: ${count}/${MAX_CONNECTIONS_PER_IP}`);
  return allowed;
}

// checkAuthRateLimit is imported directly from redisStore.js as:
//   checkAuthRateLimit(ip) → Promise<boolean> (true = blocked)
// Used in the io.use() auth middleware.

/** Track a new connection for this IP. */
async function incrementConnection(ip) {
  await incrementConnections(ip);
}

/** Track a closed connection for this IP. */
async function decrementConnection(ip) {
  await decrementConnections(ip);
}

// NOTE: Sequence numbers remain local (per-process) — reset on restart is acceptable.
function getNextSequenceNumber(chatId) {
  const next = (messageSequenceNumbers.get(chatId) || 0) + 1;
  messageSequenceNumbers.set(chatId, next);
  return next;
}


// ─── Auth middleware ───────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const ip = socket.handshake.address;

    // checkAuthRateLimit from redisStore returns true = BLOCKED
    if (await checkAuthRateLimit(ip)) {
      return next(new Error('Too many authentication attempts. Please try again later.'));
    }

    const sessionToken  = socket.handshake.auth?.token;
    const claimedGuestId= socket.handshake.auth?.guestId;

    if (!sessionToken) {
      console.error('❌ Auth failed: missing token', { ip });
      return next(new Error('Authentication failed: Missing credentials'));
    }

    console.log('🔐 Validating session...', { tokenPrefix: sessionToken.substring(0, 10) + '...' });

    const session = await validateSession(sessionToken);
    if (!session?.guestId) {
      console.error('❌ Auth failed: invalid session', { ip });
      return next(new Error('Authentication failed: Invalid session. Please refresh the page.'));
    }

    if (claimedGuestId && claimedGuestId !== session.guestId) {
      console.error('❌ Auth failed: guest ID mismatch', { claimed: claimedGuestId, validated: session.guestId });
      return next(new Error('Authentication failed: Guest mismatch'));
    }

    if (!(await checkConnectionLimit(ip))) {
      return next(new Error(`Too many connections from this IP (max ${MAX_CONNECTIONS_PER_IP}). Please close other tabs.`));
    }

    socket.sessionToken = sessionToken;
    socket.guestId      = session.guestId;
    socket.ip           = ip;

    console.log('✅ Auth successful', { guestId: session.guestId, ip });
    await incrementConnection(ip);
    next();
  } catch (error) {
    console.error('❌ Auth error:', error.message);
    next(new Error('Authentication failed: ' + error.message));
  }
});

// ─── Connection handler ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const { guestId, sessionToken, ip } = socket;
  console.log(`✅ Guest connected: ${guestId}`);

  // FIX: Track matchRetryInterval on the socket itself so that if the same
  // guest reconnects (new socket, same guestId), the old interval is cleanly
  // stopped before creating a new one — prevents duplicate polling intervals.
  socket._matchRetryInterval = null;

  // Replace any stale socket for this guest
  const existingSocket = connectedGuests.get(guestId);
  if (existingSocket && existingSocket.id !== socket.id) {
    console.log(`♻️  Replacing stale socket for guest ${guestId}`);
    // Clear old socket's match retry if it has one
    if (existingSocket._matchRetryInterval) {
      clearInterval(existingSocket._matchRetryInterval);
      existingSocket._matchRetryInterval = null;
    }
  }
  connectedGuests.set(guestId, socket);

  // Mark user online
  axios.post(`${LARAVEL_API_URL}/presence/heartbeat`, {}, {
    headers: { Authorization: `Bearer ${sessionToken}` },
    timeout: 5000,
  }).catch(err => console.error(`Failed to mark ${guestId} as online:`, err.message));

  // Deliver any messages queued while disconnected
  const pending = pendingMessages.get(guestId) || [];
  if (pending.length > 0) {
    pending.forEach(msg => socket.emit('message', msg));
    pendingMessages.delete(guestId);
  }

  // Deliver any queued match notification
  const pendingMatch = pendingMatchFound.get(guestId);
  if (pendingMatch) {
    socket.emit('match:found', pendingMatch);
    pendingMatchFound.delete(guestId);
  }

  // ── Match helpers ────────────────────────────────────────────────────────

  const stopMatchRetry = () => {
    if (socket._matchRetryInterval) {
      clearInterval(socket._matchRetryInterval);
      socket._matchRetryInterval = null;
    }
  };

  const attemptMatch = async () => {
    try {
      const result = await startChat(sessionToken);
      const data   = result?.data;

      if (!result?.success || !data?.status) return;
      if (data.status !== 'matched' && data.status !== 'already_matched') return;

      const chatId    = Number(data.chat_id);
      const partnerId = data.partner_id;

      if (!chatId || !partnerId || partnerId === guestId) return;

      stopMatchRetry();

      // Update in-memory room state
      const participants = new Set([guestId, partnerId]);
      chatRooms.set(chatId, participants);
      guestToChat.set(guestId, chatId);
      guestToChat.set(partnerId, chatId);

      socket.emit('match:found', {
        chat_id:    chatId,
        partner_id: partnerId,
        started_at: data.started_at,
      });

      const partnerSocket = connectedGuests.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('match:found', {
          chat_id:    chatId,
          partner_id: guestId,
          started_at: data.started_at,
        });
      } else {
        pendingMatchFound.set(partnerId, {
          chat_id:    chatId,
          partner_id: guestId,
          started_at: data.started_at,
        });
      }
    } catch (_) {
      // Transient failure — retry interval will try again
    }
  };

  // ── Socket event handlers ─────────────────────────────────────────────────

  socket.on('presence:join', () => {
    console.log(`👥 Guest ${guestId} joined presence pool`);
    stopMatchRetry();
    attemptMatch();
    socket._matchRetryInterval = setInterval(attemptMatch, MATCH_RETRY_INTERVAL);
  });

  socket.on('presence:leave', () => {
    console.log(`👋 Guest ${guestId} left presence pool`);
    stopMatchRetry();
  });

  socket.on('message:send', async (data, callback) => {
    const { chatId, content } = data;
    const normalizedChatId = Number(chatId);

    if (!normalizedChatId || !content || typeof content !== 'string') {
      if (callback) callback({ success: false, error: 'Invalid message data' });
      return;
    }

    if (content.length > 1000) {
      if (callback) callback({ success: false, error: 'Message too long (max 1000 characters)' });
      return;
    }

    if (!checkRateLimit(guestId)) {
      if (callback) callback({ success: false, error: 'Rate limit exceeded' });
      return;
    }

    const currentChatId = guestToChat.get(guestId);
    if (currentChatId !== normalizedChatId) {
      if (callback) callback({ success: false, error: 'Not in this chat' });
      return;
    }

    try {
      const sequenceNumber = getNextSequenceNumber(normalizedChatId);
      const persisted      = await persistMessage(normalizedChatId, content, sessionToken);

      const message = {
        message_id:      persisted.message_id,
        sender_guest_id: guestId,
        chat_id:         normalizedChatId,           // FIX: include chat_id for client-side filtering
        content:         persisted.content,
        created_at:      persisted.created_at,
        is_flagged:      persisted.is_flagged || false,
        sequence_number: sequenceNumber,
      };

      const participants = chatRooms.get(normalizedChatId) || new Set();
      const partnerId    = Array.from(participants).find(id => id !== guestId);

      if (partnerId) {
        const partnerSocket = connectedGuests.get(partnerId);
        if (partnerSocket) {
          partnerSocket.emit('message', message);
        } else {
          const queue = pendingMessages.get(partnerId) || [];
          queue.push(message);
          pendingMessages.set(partnerId, queue);
        }
      }

      if (callback) callback({ success: true, message });
    } catch (error) {
      console.error('Error sending message:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('typing:start', (data) => {
    const normalizedChatId = Number(data?.chatId);
    if (!normalizedChatId || guestToChat.get(guestId) !== normalizedChatId) return;

    const participants = chatRooms.get(normalizedChatId) || new Set();
    const partnerId    = Array.from(participants).find(id => id !== guestId);
    const partnerSocket= partnerId ? connectedGuests.get(partnerId) : null;
    if (partnerSocket) partnerSocket.emit('typing', { sender_guest_id: guestId, is_typing: true });
  });

  socket.on('typing:stop', (data) => {
    const normalizedChatId = Number(data?.chatId);
    if (!normalizedChatId || guestToChat.get(guestId) !== normalizedChatId) return;

    const participants = chatRooms.get(normalizedChatId) || new Set();
    const partnerId    = Array.from(participants).find(id => id !== guestId);
    const partnerSocket= partnerId ? connectedGuests.get(partnerId) : null;
    if (partnerSocket) partnerSocket.emit('typing', { sender_guest_id: guestId, is_typing: false });
  });

  socket.on('chat:rejoin', async (data) => {
    const normalizedChatId = Number(data?.chatId);

    if (!normalizedChatId) {
      // FIX: was calling undefined `warn()` — use console.warn
      console.warn(`Invalid chat rejoin request from ${guestId}`);
      return;
    }

    const currentChatId = guestToChat.get(guestId);
    if (currentChatId === normalizedChatId) {
      console.log(`Guest ${guestId} already in chat ${normalizedChatId}`);
      return;
    }

    // Restore from backend if WS state lost (e.g. after restart)
    try {
      const response = await axios.get(
        `${LARAVEL_API_URL}/chat/${normalizedChatId}/messages`,
        { headers: { Authorization: `Bearer ${sessionToken}` }, timeout: 5000 }
      );

      if (response.data?.success) {
        const participants = chatRooms.get(normalizedChatId) || new Set();
        participants.add(guestId);
        chatRooms.set(normalizedChatId, participants);
        guestToChat.set(guestId, normalizedChatId);
        console.log(`Guest ${guestId} rejoined chat ${normalizedChatId}`);
      }
    } catch (error) {
      console.error(`Failed to rejoin chat ${normalizedChatId}:`, error.message);
    }
  });

  socket.on('chat:end', async (data, callback) => {
    const normalizedChatId = Number(data?.chatId);

    if (!normalizedChatId || guestToChat.get(guestId) !== normalizedChatId) {
      if (callback) callback({ success: false, error: 'Not in this chat' });
      return;
    }

    try {
      await notifyChatEnd(normalizedChatId, sessionToken);

      const participants = chatRooms.get(normalizedChatId) || new Set();
      const endedPayload = {
        chat_id:  normalizedChatId,
        ended_by: guestId,
        ended_at: new Date().toISOString(),
      };

      participants.forEach(participantId => {
        const pSocket = connectedGuests.get(participantId);
        if (pSocket) pSocket.emit('chat:ended', endedPayload);
        guestToChat.delete(participantId);
      });

      chatRooms.delete(normalizedChatId);
      messageSequenceNumbers.delete(normalizedChatId);

      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error ending chat:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('disconnect', async (reason) => {
    console.log(`❌ Guest disconnected: ${guestId}, reason: ${reason}`);

    // Always decrement first to prevent connection limit blocking new connections
    decrementConnection(ip);
    connectedGuests.delete(guestId);
    stopMatchRetry();

    // Notify Laravel (fire-and-forget)
    axios.post(`${LARAVEL_API_URL}/presence/disconnect`, {}, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    }).catch(err => console.error('Failed to notify disconnect:', err.message));

    // Notify partner if in active chat
    const chatId = await getGuestChat(guestId);
    if (chatId) {
      const participants = await getRoomGuests(chatId);
      const endedPayload = {
        chat_id:  Number(chatId),
        ended_by: guestId,
        ended_at: new Date().toISOString(),
      };

      for (const participantId of participants) {
        if (participantId === guestId) continue;
        const pSocket = connectedGuests.get(participantId);
        if (pSocket) pSocket.emit('chat:ended', endedPayload);
        await deleteGuestChat(participantId);
      }

      await deleteRoom(chatId);
      messageSequenceNumbers.delete(chatId);
    }

    await cleanupGuest(guestId);
  });

});

// ─── Heartbeat / stale connection cleanup ─────────────────────────────────────
setInterval(() => {
  connectedGuests.forEach((sock, guestId) => {
    if (!sock.connected) {
      console.log(`♻️  Cleaning up stale local socket: ${guestId}`);
      connectedGuests.delete(guestId);
      // Redis-backed state expires via TTLs — explicit cleanup on disconnect event.
    }
  });
  // rateLimitTrackers, connectionAttempts, connectionCounts live in Redis
  // with TTLs and expire automatically — no manual iteration needed.
}, HEARTBEAT_INTERVAL);

// ─── Server startup ───────────────────────────────────────────────────────────
const startServer = async () => {
  console.log('🚀 Starting WebSocket server...');
  console.log(`📋 PORT:        ${PORT}`);
  console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📋 Backend API: ${LARAVEL_API_URL}`);

  // Connect to Redis BEFORE accepting any WebSocket connections
  try {
    await connectRedis();
    console.log('✅ Redis connected');
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
    console.error('Cannot start without Redis — set REDIS_URL in .env');
    process.exit(1);
  }

  httpServer.on('listening', () => {
    const addr = httpServer.address();
    console.log(`✅ WebSocket server running on port ${PORT}`);
    console.log(`✅ Health check: http://localhost:${PORT}/`);
    console.log(`✅ Address: ${JSON.stringify(addr)}`);
  });

  httpServer.on('error', (err) => {
    console.error('❌ Server error:', err);
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use`);
    }
    process.exit(1);
  });

  httpServer.listen(PORT, '0.0.0.0');
};

startServer();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down gracefully`);
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));


