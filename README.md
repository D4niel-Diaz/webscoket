# Sorsu Talk WebSocket Server

Dedicated WebSocket server for real-time chat functionality.

## Features

- **Message Sequencing**: Every message has a sequence number for guaranteed ordering
- **Delivery Guarantees**: Acknowledgment system ensures messages are delivered
- **Room Management**: Efficient room-based chat architecture
- **Presence Tracking**: Real-time presence and matching system
- **Rate Limiting**: Per-IP and per-guest rate limiting
- **Automatic Reconnection**: Handles connection drops gracefully
- **Message Deduplication**: Prevents duplicate messages
- **State Synchronization**: Proper state sync after reconnection

## Architecture

```
Frontend (Next.js on Vercel)
    ↓ Socket.IO Client
WebSocket Server (Node.js + Socket.IO)
    ↓ REST API
Laravel Backend (REST + Auth + Persistence)
```

## Installation

```bash
cd websocket-server
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```env
PORT=3001
LARAVEL_API_URL=http://localhost:8000/api/v1
CORS_ORIGIN=http://localhost:5173
```

## Running

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

## Socket.IO Events

### Client → Server

- `presence:join` - Join the matching pool
- `presence:leave` - Leave the matching pool
- `message:send` - Send a message (with ack)
- `typing:start` - Start typing indicator
- `typing:stop` - Stop typing indicator
- `chat:end` - End the chat (with ack)

### Server → Client

- `match:found` - Matched with a partner
- `message` - Receive a message
- `typing` - Typing indicator
- `chat:ended` - Chat ended

## Message Format

### Message Object
```json
{
  "message_id": 1,
  "sender_guest_id": "uuid",
  "content": "Hello",
  "created_at": "2024-01-01T00:00:00Z",
  "is_flagged": false,
  "sequence_number": 1
}
```

## Rate Limiting

- **Per IP**: 5 connections max
- **Per Guest**: 10 messages per 60 seconds
- Configurable via environment variables

## Production Deployment

### Recommended Platforms

1. **Railway** - Best for Node.js WebSocket servers
2. **Render** - Good alternative with WebSocket support
3. **Fly.io** - Global edge deployment

### Example Railway Deployment

```bash
railway up
```

### Environment Variables for Production

```env
PORT=3001
NODE_ENV=production
LARAVEL_API_URL=https://your-laravel-api.com/api/v1
CORS_ORIGIN=https://your-frontend.com
```

## Monitoring

The server logs:
- Connection events
- Matching events
- Message delivery
- Errors and warnings

## Security

- Session token validation via Laravel backend
- IP-based connection limiting
- Rate limiting on messages
- CORS protection
- Input validation

## Scaling

For production, consider:
- Using Redis for shared state across multiple instances
- Load balancing with sticky sessions
- Horizontal scaling for high traffic

## License

Proprietary - Campus Use Only
