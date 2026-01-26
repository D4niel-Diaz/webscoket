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
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP || '5', 10);
const MESSAGE_RATE_LIMIT = parseInt(process.env.MESSAGE_RATE_LIMIT || '10', 10);
const MESSAGE_RATE_WINDOW = parseInt(process.env.MESSAGE_RATE_WINDOW || '60000', 10);

// Presence settings
const PRESENCE_TIMEOUT = parseInt(process.env.PRESENCE_TIMEOUT || '90000', 10);
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);

// Create HTTP server with health check
const httpServer = createServer((req, res) => {
  // Handle all requests with a simple response
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'websocket-server',
    timestamp: new Date().toISOString(),
    connections: connectedGuests.size
  }));
});

// Create Socket.IO server with production-safe configuration
const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: parseInt(process.env.PING_TIMEOUT || '60000', 10),
  pingInterval: parseInt(process.env.PING_INTERVAL || '25000', 10),
  maxHttpBufferSize: parseInt(process.env.MAX_HTTP_BUFFER_SIZE || '1e6', 10),
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  upgradeTimeout: 10000
});

// In-memory storage (production should use Redis)
const connectedGuests = new Map(); // guestId -> socket
const chatRooms = new Map(); // chatId -> Set of guestIds
const guestToChat = new Map(); // guestId -> chatId
const presencePool = new Set(); // guestIds waiting for match
const messageSequenceNumbers = new Map(); // chatId -> sequence number
const pendingMessages = new Map(); // guestId -> array of pending messages
const rateLimitTrackers = new Map(); // guestId -> { count, resetTime }
const connectionCounts = new Map(); // ip -> count

// Helper: Validate session token with Laravel backend
async function validateSession(sessionToken) {
  try {
    const response = await axios.get(`${LARAVEL_API_URL}/guest/refresh`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      timeout: 5000
    });
    return response.data.success;
  } catch (error) {
    return false;
  }
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
  return count < MAX_CONNECTIONS_PER_IP;
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

// Helper: Get next sequence number for chat
function getNextSequenceNumber(chatId) {
  const current = messageSequenceNumbers.get(chatId) || 0;
  const next = current + 1;
  messageSequenceNumbers.set(chatId, next);
  return next;
}

// Middleware: Authentication
io.use(async (socket, next) => {
  try {
    const sessionToken = socket.handshake.auth.token;
    const guestId = socket.handshake.auth.guestId;

    if (!sessionToken || !guestId) {
      return next(new Error('Authentication failed: Missing credentials'));
    }

    const isValid = await validateSession(sessionToken);
    if (!isValid) {
      return next(new Error('Authentication failed: Invalid session'));
    }

    // Check connection limit
    const ip = socket.handshake.address;
    if (!checkConnectionLimit(ip)) {
      return next(new Error('Too many connections from this IP'));
    }

    socket.sessionToken = sessionToken;
    socket.guestId = guestId;
    socket.ip = ip;

    incrementConnection(ip);
    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
});

// Connection handler
io.on('connection', (socket) => {
  const { guestId, sessionToken, ip } = socket;

  console.log(`Guest connected: ${guestId}`);

  // Store connection
  connectedGuests.set(guestId, socket);

  // Send pending messages
  const pending = pendingMessages.get(guestId) || [];
  if (pending.length > 0) {
    pending.forEach(msg => socket.emit('message', msg));
    pendingMessages.delete(guestId);
  }

  // Handle join presence pool
  socket.on('presence:join', () => {
    console.log(`Guest ${guestId} joined presence pool`);
    
    // Remove from pool first to prevent duplicates
    presencePool.delete(guestId);
    presencePool.add(guestId);

    // Try to match
    tryMatch(guestId);
  });

  // Handle leave presence pool
  socket.on('presence:leave', () => {
    console.log(`Guest ${guestId} left presence pool`);
    presencePool.delete(guestId);
  });

  // Handle send message
  socket.on('message:send', async (data, callback) => {
    const { chatId, content } = data;

    // Validate input
    if (!chatId || !content || typeof content !== 'string') {
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
    if (currentChatId !== chatId) {
      if (callback) callback({ success: false, error: 'Not in this chat' });
      return;
    }

    try {
      // Get sequence number
      const sequenceNumber = getNextSequenceNumber(chatId);

      // Persist to database via Laravel
      const persisted = await persistMessage(chatId, content, sessionToken);

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
      const participants = chatRooms.get(chatId) || new Set();
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

    // Verify guest is in this chat
    const currentChatId = guestToChat.get(guestId);
    if (currentChatId !== chatId) return;

    const participants = chatRooms.get(chatId) || new Set();
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

    // Verify guest is in this chat
    const currentChatId = guestToChat.get(guestId);
    if (currentChatId !== chatId) return;

    const participants = chatRooms.get(chatId) || new Set();
    const partnerId = Array.from(participants).find(id => id !== guestId);

    if (partnerId) {
      const partnerSocket = connectedGuests.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('typing', { sender_guest_id: guestId, is_typing: false });
      }
    }
  });

  // Handle chat end
  socket.on('chat:end', async (data, callback) => {
    const { chatId } = data;

    // Verify guest is in this chat
    const currentChatId = guestToChat.get(guestId);
    if (currentChatId !== chatId) {
      if (callback) callback({ success: false, error: 'Not in this chat' });
      return;
    }

    try {
      // Notify Laravel
      await notifyChatEnd(chatId, sessionToken);

      // Get participants
      const participants = chatRooms.get(chatId) || new Set();

      // Notify both participants
      participants.forEach(participantId => {
        const participantSocket = connectedGuests.get(participantId);
        if (participantSocket) {
          participantSocket.emit('chat:ended', {
            chat_id: chatId,
            ended_by: guestId,
            ended_at: new Date().toISOString()
          });

          // Clean up
          guestToChat.delete(participantId);
        }
      });

      // Clean up room
      chatRooms.delete(chatId);
      messageSequenceNumbers.delete(chatId);

      if (callback) callback({ success: true });

    } catch (error) {
      console.error('Error ending chat:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    console.log(`Guest disconnected: ${guestId}, reason: ${reason}`);

    // Decrement connection count
    decrementConnection(ip);

    // Remove from presence pool
    presencePool.delete(guestId);

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

      // Clean up room
      chatRooms.delete(chatId);
      messageSequenceNumbers.delete(chatId);
    }

    // Remove connection
    connectedGuests.delete(guestId);
  });

  // Handle reconnection
  socket.on('reconnect_attempt', () => {
    console.log(`Guest ${guestId} attempting to reconnect`);
  });

  socket.on('reconnect', () => {
    console.log(`Guest ${guestId} reconnected`);
  });
});

// Matching logic
function tryMatch(guestId) {
  // Remove current guest from pool first to prevent self-matching
  presencePool.delete(guestId);
  
  // Find a partner (first available guest)
  const pool = Array.from(presencePool);
  const partnerId = pool[0]; // Get first available guest

  if (!partnerId) {
    console.log(`No match found for ${guestId} - waiting for another user`);
    // Add back to pool if no partner found
    presencePool.add(guestId);
    return;
  }

  // Ensure partner is not the same as current guest (double-check)
  if (partnerId === guestId) {
    console.error(`Self-matching detected for ${guestId}, removing from pool`);
    presencePool.delete(guestId);
    return;
  }

  console.log(`Matching ${guestId} with ${partnerId}`);

  // Remove partner from pool
  presencePool.delete(partnerId);

  // Create chat via Laravel
  axios.post(`${LARAVEL_API_URL}/chat/start`, {}, {
    headers: { Authorization: `Bearer ${connectedGuests.get(guestId).sessionToken}` },
    timeout: 5000
  }).then(response => {
    const chatData = response.data.data;
    const chatId = chatData.chat_id;

    // Create room
    const participants = new Set([guestId, partnerId]);
    chatRooms.set(chatId, participants);

    // Map guests to chat
    guestToChat.set(guestId, chatId);
    guestToChat.set(partnerId, chatId);

    // Notify both guests
    const guest1Socket = connectedGuests.get(guestId);
    const guest2Socket = connectedGuests.get(partnerId);

    if (guest1Socket) {
      guest1Socket.emit('match:found', {
        chat_id: chatId,
        partner_id: partnerId,
        started_at: chatData.started_at
      });
    }

    if (guest2Socket) {
      guest2Socket.emit('match:found', {
        chat_id: chatId,
        partner_id: guestId,
        started_at: chatData.started_at
      });
    }

    console.log(`Matched ${guestId} with ${partnerId} in chat ${chatId}`);

  }).catch(error => {
    console.error('Failed to create chat:', error.message);

    // Return to pool
    presencePool.add(guestId);
    presencePool.add(partnerId);
  });
}

// Heartbeat interval to clean up stale connections
setInterval(() => {
  const now = Date.now();
  connectedGuests.forEach((socket, guestId) => {
    if (!socket.connected) {
      console.log(`Cleaning up stale connection: ${guestId}`);
      connectedGuests.delete(guestId);
      presencePool.delete(guestId);
      guestToChat.delete(guestId);
    }
  });

  // Clean up rate limit trackers
  rateLimitTrackers.forEach((tracker, guestId) => {
    if (now > tracker.resetTime) {
      rateLimitTrackers.delete(guestId);
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
      console.log(`✅ Health check: http://0.0.0.0:${PORT}/`);
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
