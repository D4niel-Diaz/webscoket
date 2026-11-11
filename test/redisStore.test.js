// Runs against a real Redis (default: local server, database 15).
// Skips when Redis is unreachable. Only keys created here are deleted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import * as store from '../redisStore.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const id = `test-${process.pid}-${Date.now()}`;
let available = false;

before(async () => {
  const probe = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.ping();
    available = true;
  } catch {
    available = false;
  } finally {
    probe.disconnect();
  }
  if (available) await store.connectRedis(TEST_REDIS_URL);
});

after(async () => {
  if (!available) return;
  const keys = await store.getRedis().keys(`ws:*${id}*`);
  if (keys.length) await store.getRedis().del(...keys);
  await store.disconnectRedis();
});

const t = (name, fn) => test(name, async (ctx) => {
  if (!available) return ctx.skip(`Redis not reachable at ${TEST_REDIS_URL}`);
  await fn();
});

t('increment starts a window that expires (works without EXPIRE NX)', async () => {
  const key = `ws:ratelimit:msg:${id}-window`;
  assert.equal(await store.increment(key, 60), 1);
  assert.equal(await store.increment(key, 60), 2);
  const ttl = await store.getRedis().ttl(key);
  assert.ok(ttl > 0 && ttl <= 60, `expected a TTL, got ${ttl}`);
});

t('message rate limit trips after the configured count', async () => {
  const guest = `${id}-rate`;
  for (let i = 0; i < 3; i++) {
    assert.equal(await store.checkMessageRateLimit(guest, 3, 60), false);
  }
  assert.equal(await store.checkMessageRateLimit(guest, 3, 60), true);
});

t('auth blocking counts only recorded failures', async () => {
  const ip = `${id}-ip`;
  assert.equal(await store.isAuthBlocked(ip, 2), false);
  await store.recordAuthFailure(ip);
  assert.equal(await store.isAuthBlocked(ip, 2), false);
  await store.recordAuthFailure(ip);
  assert.equal(await store.isAuthBlocked(ip, 2), true);
});

t('pending match is delivered once', async () => {
  const guest = `${id}-match`;
  await store.setPendingMatch(guest, { chat_id: 7 });
  assert.deepEqual(await store.takePendingMatch(guest), { chat_id: 7 });
  assert.equal(await store.takePendingMatch(guest), null);
});

t('pending messages are delivered once, in order', async () => {
  const guest = `${id}-msgs`;
  await store.addPendingMessage(9, guest, { message_id: 1 });
  await store.addPendingMessage(9, guest, { message_id: 2 });
  assert.deepEqual(await store.takePendingMessages(9, guest), [{ message_id: 1 }, { message_id: 2 }]);
  assert.deepEqual(await store.takePendingMessages(9, guest), []);
});

t('chat membership and cleanup', async () => {
  const guest = `${id}-chat`;
  const chatId = `${id}-room`;
  await store.setGuestChat(guest, 42);
  await store.addGuestToRoom(chatId, guest);
  assert.equal(await store.getGuestChat(guest), 42);
  assert.deepEqual(await store.getRoomGuests(chatId), [guest]);

  await store.cleanupGuest(guest);
  await store.deleteRoom(chatId);
  assert.equal(await store.getGuestChat(guest), null);
  assert.deepEqual(await store.getRoomGuests(chatId), []);
});

t('connection counter never goes negative', async () => {
  const ip = `${id}-conn`;
  assert.equal(await store.incrementConnections(ip), 1);
  assert.equal(await store.decrementConnections(ip), 0);
  assert.equal(await store.decrementConnections(ip), 0);
  assert.equal(await store.getConnectionCount(ip), 0);
});
