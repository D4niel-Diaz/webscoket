# Sorsu Talk WebSocket Server

Socket.IO server that sits between the browser and the Laravel API. It validates guest
sessions against Laravel, matches waiting guests (by retrying `POST /chat/start`), relays
messages and typing, and ends chats. Laravel stays the source of truth: messages are
persisted through `POST /chat/message` before they are delivered.

```
Frontend (React, Vercel) ──Socket.IO──▶ this server ──REST──▶ Laravel API (Postgres)
                                             │
                                           Redis (room state, queues, rate limits)
```

## Requirements

- Node.js 18+
- Redis 2.6.12 or newer
- The Laravel API running and reachable at `LARAVEL_API_URL`

## Running

```bash
npm install
cp .env.example .env
npm run dev      # watch mode
npm start        # production
```

## Tests

```bash
npm test         # syntax check + Redis store unit tests (uses Redis db 15; skips if Redis is down)
npm run smoke    # end-to-end: needs the API (API_BASE) and this server (WS_URL) running
```

## Configuration

See `.env.example`. The important ones:

| Variable | Default | Notes |
|---|---|---|
| `LARAVEL_API_URL` | `http://localhost:8000/api/v1` | |
| `REDIS_URL` | `redis://localhost:6379` | |
| `CORS_ORIGINS` | `CORS_ORIGIN` | Comma-separated exact origins (enforced in production) |
| `TRUST_PROXY` | `false` | Set `true` on Render so limits use the client IP |
| `MAX_CONNECTIONS_PER_IP` | 200 (prod) / 50 | Generous: campus users share public IPs |
| `MAX_AUTH_FAILURES` | 30 | Failed handshakes per IP per minute |
| `MESSAGE_RATE_LIMIT` / `MESSAGE_RATE_WINDOW` | 10 / 60 | Messages per guest per window (**seconds**) |
| `DISCONNECT_GRACE_MS` | 15000 | How long a dropped guest may reconnect before the chat ends |

## Socket.IO events

Client → server: `presence:join`, `presence:leave`, `message:send` (ack), `typing:start`,
`typing:stop`, `chat:rejoin` (ack), `chat:end` (ack).

Server → client: `match:found`, `message`, `typing`, `chat:ended`.

Message payload: `{ message_id, chat_id, sender_guest_id, content, created_at, is_flagged }`.
Clients dedupe by `message_id`.

## Disconnects

A dropped socket keeps its chat for `DISCONNECT_GRACE_MS`. Messages sent meanwhile are queued
and delivered on reconnect. If the guest does not return, the chat is ended in Laravel and the
partner receives `chat:ended`.

## Scaling

Live sockets are tracked in-process, so run **one instance**. To scale out, add the
Socket.IO Redis adapter and route partner delivery through rooms.
