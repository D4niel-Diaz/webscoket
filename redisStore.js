/**
 * Redis store for WebSocket server state.
 *
 * REPLACES all in-memory Maps (connectedGuests, chatRooms, guestToChat, etc.)
 * so that state survives process restarts and can be shared across multiple
 * WebSocket server instances (horizontal scaling).
 *
 * Architecture:
 *  - Redis key namespacing: All keys are prefixed with `ws:` to avoid
 *    collision with any Laravel/app Redis keys.
 *  - TTLs: All keys have TTLs aligned with the presence heartbeat window
 *    to auto-expire stale entries even if disconnect events are missed.
 *
 * Key schema:
 *  ws:guest:{guestId}:socket      → socketId  (TTL: 5min)
 *  ws:guest:{guestId}:chat        → chatId    (TTL: 24h)
 *  ws:chat:{chatId}:guests        → Set of guestIds (TTL: 24h)
 *  ws:waiting                     → Set of guestIds
 *  ws:pending:match:{guestId}     → JSON match payload (TTL: 10min)
 *  ws:pending:msg:{chatId}:{ts}   → JSON message payload (TTL: 1h)
 *  ws:ratelimit:auth:{ip}         → counter (TTL: 1min)
 *  ws:ratelimit:msg:{guestId}     → counter (TTL configured by env)
 *  ws:conncount:{ip}              → counter of open connections (TTL: 1h)
 */

// ioredis uses a default export — the Redis class itself.
// Do NOT use `import { createClient }` (that's the 'redis' npm package).
import Redis from 'ioredis';

// ── Redis client setup ─────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redis;

export function getRedis() {
  return redis;
}

export async function connectRedis() {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest : 3,
    lazyConnect         : true,
    enableReadyCheck    : true,
    connectTimeout      : 10000,
    retryStrategy       : (times) => Math.min(times * 200, 5000),
    reconnectOnError    : (err) => err.message.includes('READONLY'),
  });

  redis.on('error',        (err) => console.error('[Redis] Error:', err.message));
  redis.on('connect',      ()    => console.log('[Redis] Connected'));
  redis.on('reconnecting', ()    => console.log('[Redis] Reconnecting...'));

  await redis.connect();
  console.log('[Redis] Ready');
  return redis;
}

// ── TTL constants (seconds) ───────────────────────────────────────────────

const TTL_SOCKET  = 5  * 60;         //  5 minutes — socket lifespan
const TTL_CHAT    = 24 * 60 * 60;    // 24 hours
const TTL_PENDING = 10 * 60;         // 10 minutes for queued match events
const TTL_MESSAGE = 60 * 60;         //  1 hour for pending messages
const TTL_CONN    = 60 * 60;         //  1 hour for IP connection count

// ── Guest ↔ socket mapping ─────────────────────────────────────────────────

/** Map guestId → socketId so we can look up the socket on reconnect */
export async function setGuestSocket(guestId, socketId) {
  await redis.set(`ws:guest:${guestId}:socket`, socketId, 'EX', TTL_SOCKET);
}

export async function getGuestSocketId(guestId) {
  return redis.get(`ws:guest:${guestId}:socket`);
}

export async function deleteGuestSocket(guestId) {
  await redis.del(`ws:guest:${guestId}:socket`);
}

// ── Guest ↔ chat mapping ───────────────────────────────────────────────────

/** Track which chat a guest is currently in */
export async function setGuestChat(guestId, chatId) {
  await redis.set(`ws:guest:${guestId}:chat`, String(chatId), 'EX', TTL_CHAT);
}

export async function getGuestChat(guestId) {
  const val = await redis.get(`ws:guest:${guestId}:chat`);
  return val ? Number(val) : null;
}

export async function deleteGuestChat(guestId) {
  await redis.del(`ws:guest:${guestId}:chat`);
}

// ── Chat room membership ───────────────────────────────────────────────────

/** Add a guest to a chat room set */
export async function addGuestToRoom(chatId, guestId) {
  await redis.sadd(`ws:chat:${chatId}:guests`, guestId);
  await redis.expire(`ws:chat:${chatId}:guests`, TTL_CHAT);
}

export async function removeGuestFromRoom(chatId, guestId) {
  await redis.srem(`ws:chat:${chatId}:guests`, guestId);
}

export async function getRoomGuests(chatId) {
  return redis.smembers(`ws:chat:${chatId}:guests`);
}

export async function deleteRoom(chatId) {
  await redis.del(`ws:chat:${chatId}:guests`);
}

// ── Waiting pool ───────────────────────────────────────────────────────────

/** Guests waiting to be matched */
export async function addToWaiting(guestId) {
  await redis.sadd('ws:waiting', guestId);
}

export async function removeFromWaiting(guestId) {
  await redis.srem('ws:waiting', guestId);
}

export async function getWaitingGuests() {
  return redis.smembers('ws:waiting');
}

export async function isInWaiting(guestId) {
  return (await redis.sismember('ws:waiting', guestId)) === 1;
}

// ── Pending match events ───────────────────────────────────────────────────

/** Store a match:found event to deliver on the guest's next reconnect */
export async function setPendingMatch(guestId, matchData) {
  await redis.set(
    `ws:pending:match:${guestId}`,
    JSON.stringify(matchData),
    'EX', TTL_PENDING
  );
}

export async function getPendingMatch(guestId) {
  const raw = await redis.get(`ws:pending:match:${guestId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function deletePendingMatch(guestId) {
  await redis.del(`ws:pending:match:${guestId}`);
}

// ── Pending messages ───────────────────────────────────────────────────────

/** Queue a message for a disconnected guest */
export async function addPendingMessage(chatId, guestId, message) {
  const key = `ws:pending:msg:${chatId}:${guestId}`;
  await redis.rpush(key, JSON.stringify(message));
  await redis.expire(key, TTL_MESSAGE);
}

export async function getPendingMessages(chatId, guestId) {
  const key  = `ws:pending:msg:${chatId}:${guestId}`;
  const raw  = await redis.lrange(key, 0, -1);
  return raw.map((r) => JSON.parse(r));
}

export async function deletePendingMessages(chatId, guestId) {
  await redis.del(`ws:pending:msg:${chatId}:${guestId}`);
}

// ── Rate limiting ──────────────────────────────────────────────────────────

/**
 * Increment a rate-limit counter. Returns the new count.
 * On first increment, sets TTL so the window auto-expires.
 */
export async function increment(key, windowSeconds) {
  const pipe    = redis.pipeline();
  pipe.incr(key);
  pipe.expire(key, windowSeconds, 'NX'); // NX = only set if not exists (preserves window)
  const results = await pipe.exec();
  return results[0][1]; // count after increment
}

// ── IP connection count ────────────────────────────────────────────────────

export async function incrementConnections(ip) {
  const key = `ws:conncount:${ip}`;
  const count = await increment(key, TTL_CONN);
  return count;
}

export async function decrementConnections(ip) {
  const key   = `ws:conncount:${ip}`;
  const count = await redis.decr(key);
  if (count <= 0) await redis.del(key);
  return Math.max(0, count);
}

export async function getConnectionCount(ip) {
  const val = await redis.get(`ws:conncount:${ip}`);
  return val ? Number(val) : 0;
}

// ── Auth rate limiting (brute-force prevention) ────────────────────────────

const AUTH_WINDOW    = 60;   // 1 minute
const AUTH_MAX_TRIES = 10;

export async function checkAuthRateLimit(ip) {
  const key   = `ws:ratelimit:auth:${ip}`;
  const count = await increment(key, AUTH_WINDOW);
  return count > AUTH_MAX_TRIES;
}

// ── Message rate limiting ──────────────────────────────────────────────────

export async function checkMessageRateLimit(guestId, maxMessages, windowSeconds) {
  const key   = `ws:ratelimit:msg:${guestId}`;
  const count = await increment(key, windowSeconds);
  return count > maxMessages;
}

// ── Cleanup helpers ────────────────────────────────────────────────────────

/** Called when a guest fully disconnects (not just a socket drop) */
export async function cleanupGuest(guestId) {
  await Promise.all([
    deleteGuestSocket(guestId),
    deleteGuestChat(guestId),
    removeFromWaiting(guestId),
    deletePendingMatch(guestId),
  ]);
}
