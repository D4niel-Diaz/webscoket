// End-to-end smoke test. Needs the Laravel API, Redis and this WebSocket server
// running. Usage: npm run smoke   (env: API_BASE, WS_URL)
import { io } from 'socket.io-client';
import axios from 'axios';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8000/api/v1';
const WS_URL = process.env.WS_URL || 'http://127.0.0.1:3001';
const auth = (token) => ({ headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });

async function createGuest() {
  const res = await axios.post(`${API_BASE}/guest/create`);
  if (!res.data?.success) throw new Error(`guest/create failed: ${JSON.stringify(res.data)}`);
  return { guestId: res.data.data.guest_id, token: res.data.data.session_token };
}

function waitForEvent(socket, event, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeoutMs);

    const handler = (data) => {
      clearTimeout(t);
      socket.off(event, handler);
      resolve(data);
    };

    socket.on(event, handler);
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit(event, payload, (err, resp) => {
      if (err) return reject(new Error(`${event}: no ack`));
      if (!resp?.success) return reject(new Error(`${event} failed: ${resp?.error}`));
      resolve(resp);
    });
  });
}

async function connectClient({ token, guestId }, label) {
  const socket = io(WS_URL, {
    autoConnect: false,
    transports: ['websocket'],
    auth: { token, guestId },
    reconnection: false,
    timeout: 10000,
  });

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', (err) => reject(new Error(`${label}: connect_error: ${err?.message || err}`)));
    socket.connect();
  });

  return socket;
}

async function run() {
  console.log('Creating 2 guests...');
  const a = await createGuest();
  const b = await createGuest();

  console.log('Connecting sockets...');
  const socketA = await connectClient(a, 'A');
  let socketB = await connectClient(b, 'B');

  console.log('Opting in both users...');
  const prefs = { role: 'learner', subject: 'General', availability: [9, 10, 11] };
  await axios.post(`${API_BASE}/presence/opt-in`, prefs, auth(a.token));
  await axios.post(`${API_BASE}/presence/opt-in`, prefs, auth(b.token));

  console.log('Joining presence pool via socket...');
  const matchPromises = [waitForEvent(socketA, 'match:found'), waitForEvent(socketB, 'match:found')];
  socketA.emit('presence:join');
  socketB.emit('presence:join');
  const [matchA, matchB] = await Promise.all(matchPromises);

  if (!matchA?.chat_id || Number(matchA.chat_id) !== Number(matchB?.chat_id)) {
    throw new Error(`Bad match payloads: ${JSON.stringify({ matchA, matchB })}`);
  }
  if (matchA.partner_id !== b.guestId || matchB.partner_id !== a.guestId) throw new Error('Partner IDs wrong');
  const chatId = Number(matchA.chat_id);
  console.log(`Matched in chat ${chatId}`);

  console.log('Testing typing...');
  const typingPromise = waitForEvent(socketB, 'typing', 10000);
  socketA.emit('typing:start', { chatId });
  if (!(await typingPromise)?.is_typing) throw new Error('Expected typing start event');

  console.log('Testing messages in both directions...');
  for (const [from, to, text] of [[socketA, socketB, "hi, I'm A & ready"], [socketB, socketA, 'hello from B'], [socketA, socketB, 'second from A']]) {
    const received = waitForEvent(to, 'message', 10000);
    await emitWithAck(from, 'message:send', { chatId, content: text });
    const msg = await received;
    if (msg?.content !== text) throw new Error(`Expected "${text}", got ${JSON.stringify(msg)}`);
  }

  console.log('Testing reconnect within the grace period...');
  socketB.disconnect();
  await new Promise((r) => setTimeout(r, 500));
  await emitWithAck(socketA, 'message:send', { chatId, content: 'sent while B was away' });
  socketB = await connectClient(b, 'B (reconnected)');
  const queued = await waitForEvent(socketB, 'message', 5000);
  if (queued?.content !== 'sent while B was away') throw new Error('Queued message not delivered after reconnect');

  console.log('Testing chat end...');
  const endedPromise = waitForEvent(socketB, 'chat:ended', 10000);
  await emitWithAck(socketA, 'chat:end', { chatId });
  const endedEvt = await endedPromise;
  if (Number(endedEvt?.chat_id) !== chatId) throw new Error('chat:ended chat_id mismatch');

  const messages = await axios.get(`${API_BASE}/chat/${chatId}/messages`, auth(a.token));
  if (messages.data.data.chat_status !== 'ended') throw new Error('Chat not ended in Laravel');

  console.log('PASS: smoke test succeeded');
  socketA.disconnect();
  socketB.disconnect();
}

run().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
