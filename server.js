import { createServer } from 'http';
import { Server } from 'socket.io';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3001;
const LARAVEL_API_URL = process.env.LARAVEL_API_URL || 'http://localhost:8000/api/v1';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// Rate limiting configuration
// CRITICAL: Higher limit for development to allow multiple tabs/devices
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP || (process.env.NODE_ENV === 'production' ? '5' : '20'), 10);
const MESSAGE_RATE_LIMIT = parseInt(process.env.MESSAGE_RATE_LIMIT || '10', 10);
const MESSAGE_RATE_WINDOW = parseInt(process.env.MESSAGE_RATE_WINDOW || '60000', 10);

// Presence settings
const PRESENCE_TIMEOUT = parseInt(process.env.PRESENCE_TIMEOUT || '90000', 10);
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);

// In-memory storage (production should use Redis)
// CRITICAL: Declare before HTTP server to avoid reference errors
const connectedGuests = new Map(); // guestId -> socket
const chatRooms = new Map(); // chatId -> Set of guestIds
const guestToChat = new Map(); // guestId -> chatId
const messageSequenceNumbers = new Map(); // chatId -> sequence number
const pendingMessages = new Map(); // guestId -> array of pending messages
const pendingMatchFound = new Map(); // guestId -> match payload
const rateLimitTrackers = new Map(); // guestId -> { count, resetTime }
const connectionCounts = new Map(); // ip -> count
const connectionAttempts = new Map(); // ip -> { count, resetTime } for auth rate limiting

// Create HTTP server with health check
const httpServer = createServer((req, res) => {
  // IMPORTANT: Don't intercept Socket.IO/Engine.IO handshake routes
  if (req.url?.startsWith('/socket.io/')) {
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'websocket-server',
    timestamp: new Date().toISOString(),
    connections: connectedGuests.size
  }));
});

// Parse CORS origins - support multiple origins and wildcards
const getCorsOriginChecker = () => {
  const origins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()) : [CORS_ORIGIN];
  
  // Add Vercel patterns for production
  if (process.env.NODE_ENV === 'production') {
    origins.push(
      'https://sochat-frontend.vercel.app',
      'https://sochat-livid.vercel.app',
      'https://sochat-git-main-daniels-projects-8c2bbb7b.vercel.app',
      'https://sochat-*.vercel.app',
      'https://*.vercel.app'
    );
  }
  
  return (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    // Check exact matches
    if (origins.includes(origin)) {
      return callback(null, true);
    }
    
    // Check wildcard patterns
    for (const pattern of origins) {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        if (regex.test(origin)) {
          return callback(null, true);
        }
      }
    }
    
    // Default: allow in development, deny in production
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    // Log rejected origin for debugging
    console.warn(`CORS rejected origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  };
};

// Create Socket.IO server with production-safe configuration
const io = new Server(httpServer, {
  cors: {
    origin: getCorsOriginChecker(),
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: parseInt(process.env.PING_TIMEOUT || '60000', 10),
  pingInterval: parseInt(process.env.PING_INTERVAL || '25000', 10),
  maxHttpBufferSize: (() => {
    const raw = process.env.MAX_HTTP_BUFFER_SIZE;
    const val = raw ? Number(raw) : 1_000_000;
    return Number.isFinite(val) && val > 0 ? val : 1_000_000;
  })(),
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  upgradeTimeout: 10000
});

io.engine.on('connection_error', (err) => {
  console.error('Engine.IO connection_error:', {
    code: err.code,
    message: err.message,
    context: err.context
  });
});

// Helper: Validate session token with Laravel backend
async function validateSession(sessionToken) {
  try {
    if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.length < 10) {
      console.error('❌ Invalid session token format:', sessionToken ? `${sessionToken.substring(0, 10)}...` : 'null');
      return null;
    }

    const response = await axios.post(
      `${LARAVEL_API_URL}/guest/refresh`,
      null,
      {
        headers: { Authorization: `Bearer ${sessionToken}` },
        timeout: 10000 // Increased from 5s to 10s
      }
    );

    if (!response.data?.success) {
      console.error('❌ Session validation failed - backend returned success=false:', {
        status: response.status,
        data: response.data
      });
      return null;
    }

    if (!response.data?.data?.guest_id) {
      console.error('❌ Session validation failed - missing guest_id in response:', response.data);
      return null;
    }

    return {
      guestId: response.data.data.guest_id,
    };
  } catch (error) {
    // CRITICAL: Log detailed error information for debugging
    if (error.response) {
      // Backend responded with error status
      console.error('❌ Session validation failed - backend error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        url: `${LARAVEL_API_URL}/guest/refresh`
      });
    } else if (error.request) {
      // Request was made but no response received
      console.error('❌ Session validation failed - no response from backend:', {
        message: error.message,
        code: error.code,
        url: `${LARAVEL_API_URL}/guest/refresh`,
        hint: 'Is the Laravel backend running?'
      });
    } else {
      // Error setting up request
      console.error('❌ Session validation failed - request setup error:', {
        message: error.message,
        url: `${LARAVEL_API_URL}/guest/refresh`
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

// Helper: Send message via Laravel API for persistence
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

// Helper: Notify Laravel of chat end
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

// Helper: Check rate limit
function checkRateLimit(guestId) {
  const now = Date.now();
  const tracker = rateLimitTrackers.get(guestId) || { count: 0, resetTime: now + MESSAGE_RATE_WINDOW };

  if (now > tracker.resetTime) {
    tracker.count = 0;
    tracker.resetTime = now + MESSAGE_RATE_WINDOW;
  }

  tracker.count++;
  rateLimitTrackers.set(guestId, tracker);

  return tracker.count <= MESSAGE_RATE_LIMIT;
}

// Helper: Check connection limit per IP
function checkConnectionLimit(ip) {
  const count = connectionCounts.get(ip) || 0;
  const allowed = count < MAX_CONNECTIONS_PER_IP;
  
  if (!allowed) {
    console.warn(`Connection limit exceeded for IP ${ip}: ${count}/${MAX_CONNECTIONS_PER_IP}`);
  }
  
  return allowed;
}

// Helper: Check authentication rate limit
function checkAuthRateLimit(ip) {
  const now = Date.now();
  const AUTH_RATE_LIMIT = 10; // Max 10 auth attempts
  const AUTH_RATE_WINDOW = 60000; // Per minute
  
  const tracker = connectionAttempts.get(ip) || { count: 0, resetTime: now + AUTH_RATE_WINDOW };
  
  if (now > tracker.resetTime) {
    tracker.count = 0;
    tracker.resetTime = now + AUTH_RATE_WINDOW;
  }
  
  tracker.count++;
  connectionAttempts.set(ip, tracker);
  
  return tracker.count <= AUTH_RATE_LIMIT;
}

// Helper: Increment connection count
function incrementConnection(ip) {
  const count = connectionCounts.get(ip) || 0;
  connectionCounts.set(ip, count + 1);
}

// Helper: Decrement connection count
function decrementConnection(ip) {
  const count = connectionCounts.get(ip) || 0;
  connectionCounts.set(ip, Math.max(0, count - 1));
}

// Helper: Get next sequence number for chat (atomic operation)
function getNextSequenceNumber(chatId) {
  // Use atomic increment to prevent race conditions
  const current = messageSequenceNumbers.get(chatId) || 0;
  const next = current + 1;
  messageSequenceNumbers.set(chatId, next);
  return next;
}

// CRITICAL: Ensure sequence numbers are unique per chat
// In production, this should use Redis INCR for true atomicity

// Middleware: Authentication
io.use(async (socket, next) => {
  try {
    const ip = socket.handshake.address;
    
    // CRITICAL: Rate limit authentication attempts
    if (!checkAuthRateLimit(ip)) {
      return next(new Error('Too many authentication attempts. Please try again later.'));
    }
    
    const sessionToken = socket.handshake.auth?.token;
    const claimedGuestId = socket.handshake.auth?.guestId;

    if (!sessionToken) {
      console.error('❌ Authentication failed: Missing session token', {
        ip,
        hasAuth: !!socket.handshake.auth,
        authKeys: socket.handshake.auth ? Object.keys(socket.handshake.auth) : []
      });
      return next(new Error('Authentication failed: Missing credentials'));
    }

    console.log('🔐 Validating session token...', {
      tokenPrefix: sessionToken.substring(0, 10) + '...',
      claimedGuestId,
      backendUrl: LARAVEL_API_URL
    });

    const session = await validateSession(sessionToken);
    if (!session?.guestId) {
      console.error('❌ Authentication failed: Session validation returned null', {
        ip,
        tokenPrefix: sessionToken.substring(0, 10) + '...',
        backendUrl: LARAVEL_API_URL
      });
      return next(new Error('Authentication failed: Invalid session. Please refresh the page to get a new session.'));
    }

    if (claimedGuestId && claimedGuestId !== session.guestId) {
      console.error('❌ Authentication failed: Guest ID mismatch', {
        claimed: claimedGuestId,
        validated: session.guestId
      });
      return next(new Error('Authentication failed: Guest mismatch'));
    }

    // Check connection limit
    if (!checkConnectionLimit(ip)) {
      return next(new Error(`Too many connections from this IP (max ${MAX_CONNECTIONS_PER_IP}). Please close other tabs or wait a moment.`));
    }

    socket.sessionToken = sessionToken;
    socket.guestId = session.guestId;
    socket.ip = ip;

    console.log('✅ Authentication successful', {
      guestId: session.guestId,
      ip
    });

    incrementConnection(ip);
    next();
  } catch (error) {
    console.error('❌ Authentication error:', error.message, error.stack);
    next(new Error('Authentication failed: ' + error.message));
  }
});

// Connection handler
io.on('connection', (socket) => {
  const { guestId, sessionToken, ip } = socket;

  let matchRetryInterval = null;

  console.log(`Guest connected: ${guestId}`);

  // Store connection
  connectedGuests.set(guestId, socket);

  // Send pending messages
  const pending = pendingMessages.get(guestId) || [];
  if (pending.length > 0) {
    pending.forEach(msg => socket.emit('message', msg));
    pendingMessages.delete(guestId);
  }

  const pendingMatch = pendingMatchFound.get(guestId);
  if (pendingMatch) {
    socket.emit('match:found', pendingMatch);
    pendingMatchFound.delete(guestId);
  }

  const stopMatchRetry = () => {
    if (matchRetryInterval) {
      clearInterval(matchRetryInterval);
      matchRetryInterval = null;
    }
  };

  const attemptMatch = async () => {
    try {
      const result = await startChat(sessionToken);
      const data = result?.data;

      if (!result?.success || !data?.status) {
        return;
      }

      if (data.status !== 'matched' && data.status !== 'already_matched') {
        return;
      }

      const chatId = Number(data.chat_id);
      const partnerId = data.partner_id;

      if (!chatId || !partnerId || partnerId === guestId) {
        return;
      }

      stopMatchRetry();

      const participants = new Set([guestId, partnerId]);
      chatRooms.set(chatId, participants);
      guestToChat.set(guestId, chatId);
      guestToChat.set(partnerId, chatId);

      const payloadForRequester = {
        chat_id: chatId,
        partner_id: partnerId,
        started_at: data.started_at
      };

      const payloadForPartner = {
        chat_id: chatId,
        partner_id: guestId,
        started_at: data.started_at
      };

      socket.emit('match:found', payloadForRequester);

      const partnerSocket = connectedGuests.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('match:found', payloadForPartner);
      } else {
        pendingMatchFound.set(partnerId, payloadForPartner);
      }
    } catch (e) {
      // ignore transient failures
    }
  };

  // Handle join presence pool
  socket.on('presence:join', () => {
    console.log(`Guest ${guestId} joined presence pool`);

    stopMatchRetry();
    attemptMatch();
    matchRetryInterval = setInterval(attemptMatch, parseInt(process.env.MATCH_RETRY_INTERVAL || '2000', 10));
  });

  // Handle leave presence pool
  socket.on('presence:leave', () => {
    console.log(`Guest ${guestId} left presence pool`);
    stopMatchRetry();
  });

  // Handle send message
  socket.on('message:send', async (data, callback) => {
    const { chatId, content } = data;
    const normalizedChatId = Number(chatId);

    // Validate input
    if (!normalizedChatId || !content || typeof content !== 'string') {
      if (callback) callback({ success: false, error: 'Invalid message data' });
      return;
    }

    if (content.length > 1000) {
      if (callback) callback({ success: false, error: 'Message too long' });
      return;
    }

    // Check rate limit
    if (!checkRateLimit(guestId)) {
      if (callback) callback({ success: false, error: 'Rate limit exceeded' });
      return;
    }

    // Verify guest is in this chat
    const currentChatId = guestToChat.get(guestId);
    if (currentChatId !== normalizedChatId) {
      if (callback) callback({ success: false, error: 'Not in this chat' });
      return;
    }

    try {
      // Get sequence number
      const sequenceNumber = getNextSequenceNumber(normalizedChatId);

      // Persist to database via Laravel
      const persisted = await persistMessage(normalizedChatId, content, sessionToken);

      // Create message object
      const message = {
        message_id: persisted.message_id,
        sender_guest_id: guestId,
        content: persisted.content,
        created_at: persisted.created_at,
        is_flagged: persisted.is_flagged || false,
        sequence_number: sequenceNumber
      };

      // Get chat participants
      const participants = chatRooms.get(normalizedChatId) || new Set();
      const partnerId = Array.from(participants).find(id => id !== guestId);

      // Send to partner if connected
      if (partnerId) {
        const partnerSocket = connectedGuests.get(partnerId);
        if (partnerSocket) {
          partnerSocket.emit('message', message);
        } else {
          // Store as pending
          const pending = pendingMessages.get(partnerId) || [];
          pending.push(message);
          pendingMessages.set(partnerId, pending);
        }
      }

      // Acknowledge send
      if (callback) callback({ success: true, message });

    } catch (error) {
      console.error('Error sending message:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Handle typing indicator
  socket.on('typing:start', (data) => {
    const { chatId } = data;
    const normalizedChatId = Number(chatId);

    // Verify guest is in this chat
    const currentChatId = guestToChat.get(guestId);
    if (currentChatId !== normalizedChatId) return;

    const participants = chatRooms.get(normalizedChatId) || new Set();
    const partnerId = Array.from(participants).find(id => id !== guestId);

    if (partnerId) {
      const partnerSocket = connectedGuests.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('typing', { sender_guest_id: guestId, is_typing: true });
      }
    }
  });

  socket.on('typing:stop', (data) => {
    const { chatId } = data;
    const normalizedChatId = Number(chatId);

    // Verify guest is in this chat
    const currentChatId = guestToChat.get(guestId);
    if (currentChatId !== normalizedChatId) return;

    const participants = chatRooms.get(normalizedChatId) || new Set();
    const partnerId = Array.from(participants).find(id => id !== guestId);

    if (partnerId) {
      const partnerSocket = connectedGuests.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('typing', { sender_guest_id: guestId, is_typing: false });
      }
    }
  });

  // Handle chat rejoin (after reconnection)
  socket.on('chat:rejoin', async (data) => {
    const { chatId } = data;
    const normalizedChatId = Number(chatId);

    if (!normalizedChatId) {
      warn(`Invalid chat rejoin request from ${guestId}`);
      return;
    }

    // Verify guest is in this chat
    const currentChatId = guestToChat.get(guestId);
    if (currentChatId !== normalizedChatId) {
      // Try to restore from backend
      try {
        const response = await axios.get(
          `${LARAVEL_API_URL}/chat/${normalizedChatId}/messages`,
          { headers: { Authorization: `Bearer ${sessionToken}` }, timeout: 5000 }
        );
        
        if (response.data?.success) {
          // Restore chat room membership
          const participants = chatRooms.get(normalizedChatId) || new Set();
          participants.add(guestId);
          chatRooms.set(normalizedChatId, participants);
          guestToChat.set(guestId, normalizedChatId);
          
          console.log(`Guest ${guestId} rejoined chat ${normalizedChatId}`);
        }
      } catch (error) {
        console.error(`Failed to rejoin chat ${normalizedChatId}:`, error.message);
      }
    } else {
      // Already in chat, just confirm
      console.log(`Guest ${guestId} already in chat ${normalizedChatId}`);
    }
  });

  // Handle chat end
  socket.on('chat:end', async (data, callback) => {
    const { chatId } = data;
    const normalizedChatId = Number(chatId);

    // Verify guest is in this chat
    const currentChatId = guestToChat.get(guestId);
    if (currentChatId !== normalizedChatId) {
      if (callback) callback({ success: false, error: 'Not in this chat' });
      return;
    }

    try {
      // Notify Laravel
      await notifyChatEnd(normalizedChatId, sessionToken);

      // Get participants
      const participants = chatRooms.get(normalizedChatId) || new Set();

      // Notify both participants
      participants.forEach(participantId => {
        const participantSocket = connectedGuests.get(participantId);
        if (participantSocket) {
          participantSocket.emit('chat:ended', {
            chat_id: normalizedChatId,
            ended_by: guestId,
            ended_at: new Date().toISOString()
          });

          // Clean up
          guestToChat.delete(participantId);
        }
      });

      // Clean up room
      chatRooms.delete(normalizedChatId);
      messageSequenceNumbers.delete(normalizedChatId);

      if (callback) callback({ success: true });

    } catch (error) {
      console.error('Error ending chat:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    console.log(`Guest disconnected: ${guestId}, reason: ${reason}`);

    // CRITICAL: Always decrement connection count on disconnect FIRST
    // This must happen before any other cleanup to prevent connection limit issues
    decrementConnection(ip);
    
    // Remove from connected guests immediately to prevent stale connections
    connectedGuests.delete(guestId);

    stopMatchRetry();

    // Notify Laravel of disconnect
    axios.post(`${LARAVEL_API_URL}/presence/disconnect`, {}, {
      headers: { Authorization: `Bearer ${sessionToken}` }
    }).catch(err => console.error('Failed to notify disconnect:', err.message));

    // Handle chat cleanup if guest was in a chat
    const chatId = guestToChat.get(guestId);
    if (chatId) {
      const participants = chatRooms.get(chatId) || new Set();

      // Notify partner
      const partnerId = Array.from(participants).find(id => id !== guestId);
      if (partnerId) {
        const partnerSocket = connectedGuests.get(partnerId);
        if (partnerSocket) {
          partnerSocket.emit('chat:ended', {
            chat_id: chatId,
            ended_by: guestId,
            ended_at: new Date().toISOString()
          });
        }

        // Clean up partner
        guestToChat.delete(partnerId);
      }

      guestToChat.delete(guestId);

      // Clean up room
      chatRooms.delete(chatId);
      messageSequenceNumbers.delete(chatId);
    }

    // Always remove guest->chat mapping (prevents stale state blocking future chats)
    guestToChat.delete(guestId);

    // Connection already removed above
  });

  // Handle reconnection
  socket.on('reconnect_attempt', () => {
    console.log(`Guest ${guestId} attempting to reconnect`);
  });

  socket.on('reconnect', () => {
    console.log(`Guest ${guestId} reconnected`);
  });
});

// Heartbeat interval to clean up stale connections
setInterval(() => {
  const now = Date.now();
  connectedGuests.forEach((socket, guestId) => {
    if (!socket.connected) {
      console.log(`Cleaning up stale connection: ${guestId}`);
      const ip = socket.ip;
      
      // Decrement connection count for this IP
      if (ip) {
        decrementConnection(ip);
      }
      
      connectedGuests.delete(guestId);
      guestToChat.delete(guestId);
    }
  });

  // Clean up rate limit trackers
  rateLimitTrackers.forEach((tracker, guestId) => {
    if (now > tracker.resetTime) {
      rateLimitTrackers.delete(guestId);
    }
  });

  // Clean up connection attempt trackers
  connectionAttempts.forEach((tracker, ip) => {
    if (now > tracker.resetTime) {
      connectionAttempts.delete(ip);
    }
  });

}, HEARTBEAT_INTERVAL);

// Start server
const startServer = () => {
  console.log('🚀 Starting WebSocket server...');
  console.log(`📋 PORT: ${PORT}`);
  console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📋 CORS Origin: ${CORS_ORIGIN}`);

  try {
    httpServer.on('listening', () => {
      const address = httpServer.address();
      console.log(`✅ WebSocket server running on port ${PORT}`);
      console.log(`✅ Server address: ${JSON.stringify(address)}`);
      // CRITICAL: 0.0.0.0 is a bind address, not accessible from browser
      // Show localhost instead for health check access
      console.log(`✅ Health check: http://localhost:${PORT}/`);
      console.log(`   (Also accessible at: http://127.0.0.1:${PORT}/)`);
    });

    httpServer.on('error', (err) => {
      console.error('❌ Server error:', err);
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use`);
      }
      process.exit(1);
    });

    httpServer.listen(PORT, '0.0.0.0');

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    console.error('Error stack:', error.stack);
    process.exit(1);
  }
};

// Start the server
startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
