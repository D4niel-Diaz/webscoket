/**
 * Redis store for WebSocket server state.
 *
 * Holds the state that must survive a process restart: which chat a guest is
 * in, who is in each chat room, queued events for briefly-disconnected guests,
 * and rate-limit counters. Live socket objects stay in-process (server.js).
 *
 * Key schema (all prefixed `ws:`):
 *  ws:guest:{guestId}:socket      → socketId  (TTL: 5min, refreshed on connect)
 *  ws:guest:{guestId}:chat        → chatId    (TTL: 24h)
 *  ws:chat:{chatId}:guests        → Set of guestIds (TTL: 24h)
 *  ws:pending:match:{guestId}     → JSON match payload (TTL: 10min)
 *  ws:pending:msg:{chatId}:{guestId} → List of JSON messages (TTL: 1h)
 *  ws:ratelimit:authfail:{ip}     → failed-auth counter
 *  ws:ratelimit:msg:{guestId}     → message counter
 *  ws:conncount:{ip}              → open connection counter (TTL: 1h)
 *
 * Compatible with Redis >= 2.6.12 (no EXPIRE ... NX, which needs Redis 7).
 */

// ioredis uses a default export — the Redis class itself.
import Redis from 'ioredis';

let redis;

export function getRedis() {
  return redis;
}

export async function connectRedis(url = process.env.REDIS_URL || 'redis://localhost:6379') {
  redis = new Redis(url, {
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

export async function disconnectRedis() {
  if (redis) await redis.quit();
}

// ── TTL constants (seconds) ───────────────────────────────────────────────

const TTL_SOCKET  = 5  * 60;
const TTL_CHAT    = 24 * 60 * 60;
const TTL_PENDING = 10 * 60;
const TTL_MESSAGE = 60 * 60;
const TTL_CONN    = 60 * 60;

// ── Guest ↔ socket mapping ─────────────────────────────────────────────────

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

export async function addGuestToRoom(chatId, guestId) {
  await redis.multi()
    .sadd(`ws:chat:${chatId}:guests`, guestId)
    .expire(`ws:chat:${chatId}:guests`, TTL_CHAT)
    .exec();
}

export async function getRoomGuests(chatId) {
  return redis.smembers(`ws:chat:${chatId}:guests`);
}

export async function deleteRoom(chatId) {
  await redis.del(`ws:chat:${chatId}:guests`);
}

// ── Pending match events ───────────────────────────────────────────────────

/** Store a match:found event to deliver on the guest's next connect */
export async function setPendingMatch(guestId, matchData) {
  await redis.set(`ws:pending:match:${guestId}`, JSON.stringify(matchData), 'EX', TTL_PENDING);
}

/** Read and delete in one step so a match is delivered at most once */
export async function takePendingMatch(guestId) {
  const key = `ws:pending:match:${guestId}`;
  const [[, raw]] = await redis.multi().get(key).del(key).exec();
  return raw ? JSON.parse(raw) : null;
}

// ── Pending messages ───────────────────────────────────────────────────────

/** Queue a message for a guest who is briefly disconnected */
export async function addPendingMessage(chatId, guestId, message) {
  const key = `ws:pending:msg:${chatId}:${guestId}`;
  await redis.multi()
    .rpush(key, JSON.stringify(message))
    .expire(key, TTL_MESSAGE)
    .exec();
}

/** Read and delete in one step so queued messages are delivered once */
export async function takePendingMessages(chatId, guestId) {
  const key = `ws:pending:msg:${chatId}:${guestId}`;
  const [[, raw]] = await redis.multi().lrange(key, 0, -1).del(key).exec();
  return (raw || []).map((r) => JSON.parse(r));
}

export async function deletePendingMessages(chatId, guestId) {
  await redis.del(`ws:pending:msg:${chatId}:${guestId}`);
}

// ── Rate limiting ──────────────────────────────────────────────────────────

/**
 * Increment a fixed-window counter and return the new count. The window
 * starts on the first increment (SET NX EX), so later increments don't
 * extend it.
 */
export async function increment(key, windowSeconds) {
  const results = await redis.multi()
    .set(key, 0, 'EX', windowSeconds, 'NX')
    .incr(key)
    .exec();
  return results[1][1];
}

// ── IP connection count ────────────────────────────────────────────────────

export async function incrementConnections(ip) {
  return increment(`ws:conncount:${ip}`, TTL_CONN);
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

// ── Failed-auth limiting (brute-force prevention) ──────────────────────────
// Only failures are counted: many legitimate users can share one campus IP.

const AUTH_FAIL_WINDOW = 60;

export async function isAuthBlocked(ip, maxFailures) {
  const val = await redis.get(`ws:ratelimit:authfail:${ip}`);
  return val ? Number(val) >= maxFailures : false;
}

export async function recordAuthFailure(ip) {
  return increment(`ws:ratelimit:authfail:${ip}`, AUTH_FAIL_WINDOW);
}

// ── Message rate limiting ──────────────────────────────────────────────────

/** Returns true when the guest is over the limit */
export async function checkMessageRateLimit(guestId, maxMessages, windowSeconds) {
  const count = await increment(`ws:ratelimit:msg:${guestId}`, windowSeconds);
  return count > maxMessages;
}

// ── Cleanup helpers ────────────────────────────────────────────────────────

/** Called when a guest is gone for good (grace period expired) */
export async function cleanupGuest(guestId) {
  await redis.del(
    `ws:guest:${guestId}:socket`,
    `ws:guest:${guestId}:chat`,
    `ws:pending:match:${guestId}`,
  );
}
