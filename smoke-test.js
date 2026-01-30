import { io } from 'socket.io-client';
import axios from 'axios';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8000/api/v1';
const WS_URL = process.env.WS_URL || 'http://127.0.0.1:3001';

async function createGuest() {
  const res = await axios.post(`${API_BASE}/guest/create`);
  if (!res.data?.success) throw new Error(`guest/create failed: ${JSON.stringify(res.data)}`);
  return {
    guestId: res.data.data.guest_id,
    token: res.data.data.session_token,
  };
}

function waitForEvent(socket, event, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeoutMs);

    const handler = (data) => {
      cleanup();
      resolve(data);
    };

    const cleanup = () => {
      clearTimeout(t);
      socket.off(event, handler);
    };

    socket.on(event, handler);
  });
}

async function connectClient({ token, guestId }, label) {
  const socket = io(WS_URL, {
    autoConnect: false,
    transports: ['polling', 'websocket'],
    auth: { token, guestId },
    reconnection: false,
    timeout: 10000,
    extraHeaders: {
      Origin: 'http://localhost:5173'
    }
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: connect timeout`)), 10000);
    socket.once('connect', () => {
      clearTimeout(t);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(t);
      reject(new Error(`${label}: connect_error: ${err?.message || err}`));
    });
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
  const socketB = await connectClient(b, 'B');

  console.log('Opting in both users...');
  await axios.post(`${API_BASE}/presence/opt-in`, null, { headers: { Authorization: `Bearer ${a.token}` } });
  await axios.post(`${API_BASE}/presence/opt-in`, null, { headers: { Authorization: `Bearer ${b.token}` } });

  console.log('Joining presence pool via socket...');
  socketA.emit('presence:join');
  socketB.emit('presence:join');

  console.log('Waiting for match events...');
  const matchA = await waitForEvent(socketA, 'match:found');
  const matchB = await waitForEvent(socketB, 'match:found');

  console.log('matchA:', matchA);
  console.log('matchB:', matchB);

  if (!matchA?.chat_id || !matchB?.chat_id) throw new Error('Missing chat_id in match payload');
  if (Number(matchA.chat_id) !== Number(matchB.chat_id)) throw new Error('Chat IDs differ between clients');

  const chatId = Number(matchA.chat_id);

  console.log('Testing typing...');
  const typingPromise = waitForEvent(socketB, 'typing', 10000);
  socketA.emit('typing:start', { chatId });
  const typingEvt = await typingPromise;
  if (!typingEvt?.is_typing) throw new Error('Expected typing start event');

  console.log('Testing message send/receive...');
  const msgPromise = waitForEvent(socketB, 'message', 10000);

  const sendAck = await new Promise((resolve, reject) => {
    socketA.emit('message:send', { chatId, content: 'hello from A' }, (resp) => {
      if (!resp?.success) return reject(new Error(`send ack failed: ${resp?.error}`));
      resolve(resp.message);
    });
  });

  const msgEvt = await msgPromise;
  if (msgEvt?.content !== 'hello from A') throw new Error('Message content mismatch');

  console.log('Ack message:', sendAck);
  console.log('Received message:', msgEvt);

  console.log('Testing chat end...');
  const endedPromise = waitForEvent(socketB, 'chat:ended', 10000);
  await new Promise((resolve, reject) => {
    socketA.emit('chat:end', { chatId }, (resp) => {
      if (!resp?.success) return reject(new Error(`end ack failed: ${resp?.error}`));
      resolve();
    });
  });
  const endedEvt = await endedPromise;
  if (Number(endedEvt?.chat_id) !== chatId) throw new Error('chat:ended chat_id mismatch');

  console.log('PASS: smoke test succeeded');

  socketA.disconnect();
  socketB.disconnect();
}

run().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
