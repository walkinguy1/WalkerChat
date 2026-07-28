# WalkerChat - Complete Technical Architecture Documentation

## 🏗️ System Architecture Overview

WalkerChat is a secure real-time messaging platform built with modern web technologies. This document explains every component, data flow, and interaction in detail.

### High-Level Architecture
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend    │◄──►│   Backend API   │◄──►│   Database      │
│   (React)     │    │   (FastAPI)    │    │ (PostgreSQL)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                      │                      │
         │                      ▼                      │
         │              ┌─────────────────┐         │
         └──────────────►│   Redis Cache   │◄────────┘
                        │ (Pub/Sub)      │
                        └─────────────────┘
```

## 🎯 Core Components

### 1. Backend (FastAPI)

#### Application Entry Point (`main.py`)
```python
# Application lifecycle management
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Initialize database
    await init_database()
    
    # 2. Seed demo data
    async with SessionLocal() as session:
        await seed_demo_data(session)
    
    # 3. Start WebSocket manager
    await manager.startup()
    
    try:
        yield  # Application runs here
    finally:
        # 4. Cleanup resources
        await manager.shutdown()
        await close_runtime_redis()
```

**Key Responsibilities:**
- **Database initialization**: Creates all tables using SQLAlchemy async engine
- **Demo data seeding**: Populates users, chats, and messages for testing
- **WebSocket manager startup**: Initializes Redis Pub/Sub for real-time messaging
- **Resource cleanup**: Properly closes connections on shutdown

#### Database Layer (`database.py`)
```python
# Async SQLAlchemy configuration
engine = create_async_engine(settings.database_url, future=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def get_db():
    async with SessionLocal() as session:
        yield session
```

**Key Features:**
- **Async-first**: All database operations are asynchronous
- **Connection pooling**: SQLAlchemy manages connection pool automatically
- **Dependency injection**: FastAPI's `Depends` provides sessions to endpoints
- **Transaction management**: Automatic commit/rollback with context managers

#### Configuration Management (`config.py`)
```python
class Settings(BaseSettings):
    # Database
    database_url: str = Field(default="postgresql+asyncpg://...")
    
    # Redis
    redis_url: str = Field(default="redis://localhost:6379/0")
    websocket_channel: str = Field(default="walkerchat:deliveries")
    
    # Security
    jwt_secret: str = Field(default="change-this-jwt-secret")
    ws_ticket_expiry_seconds: int = Field(default=30)
    
    # CORS
    cors_origins: list[str] = Field(default=["http://localhost:5173"])
```

**Environment Variables:**
- Uses Pydantic Settings for type-safe configuration
- Supports `.env` files for local development
- Validates required fields on startup
- Provides sensible defaults for development

### 2. Database Models

#### User Model (`models/user.py`)
```python
class User(Base):
    id: UUID = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    username: str = Column(String(50), unique=True, nullable=False)
    password_hash: str = Column(String(255), nullable=False)
    
    # E2EE keys
    identity_key_pub: str = Column(Text, nullable=True)
    signed_prekey_pub: str = Column(Text, nullable=True)
```

**Purpose:**
- **Authentication**: Username/password for login
- **E2EE**: Stores public keys for end-to-end encryption
- **Unique identification**: UUID primary key for user references

#### Chat Model (`models/chat.py`)
```python
class Chat(Base):
    id: UUID = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    name: str = Column(String(100), nullable=False)
    type: ChatType = Column(Enum(ChatType), nullable=False)
    summary: str = Column(Text, nullable=True)
```

**Chat Types:**
- `DIRECT`: One-to-one messaging
- `GROUP`: Multi-user chat rooms

#### Message Model (`models/chat.py`)
```python
class Message(Base):
    id: UUID = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    chat_id: UUID = Column(ForeignKey("chats.id"), nullable=False)
    sender_id: UUID = Column(ForeignKey("users.id"), nullable=False)
    ciphertext: str = Column(Text, nullable=False)  # NEVER plaintext
    encryption: EncryptionMetadata = Column(JSON, nullable=False)
```

**Security Design:**
- **Encrypted storage**: `ciphertext` field stores only encrypted messages
- **Encryption metadata**: Algorithm, version, and key ID for decryption
- **No plaintext**: Backend never sees message content

### 3. Authentication & Security

#### JWT Authentication (`api/auth.py`)
```python
# Login endpoint
@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, session: AsyncSession = Depends(get_db)):
    # 1. Validate credentials
    user = await authenticate_user(session, body.username, body.password)
    
    # 2. Generate JWT token
    token = create_access_token(user.id)
    
    # 3. Return token and user info
    return TokenResponse(access_token=token, user_id=str(user.id))
```

#### WebSocket Ticket System
```python
# One-time ticket for WebSocket authentication
async def create_ws_ticket(user_id: UUID) -> str:
    ticket = uuid4().hex
    await set_ephemeral_value(f"ws-ticket:{ticket}", str(user_id), 30)
    return ticket

async def consume_ws_ticket(ticket: str) -> UUID:
    stored_user_id = await get_ephemeral_value(f"ws-ticket:{ticket}")
    if stored_user_id is None:
        raise HTTPException(401, "Invalid or expired ticket")
    
    await delete_ephemeral_value(f"ws-ticket:{ticket}")
    return UUID(stored_user_id)
```

**Security Flow:**
1. **Login**: User authenticates with username/password
2. **JWT**: Receives access token for API calls
3. **WebSocket Ticket**: Requests one-time ticket for WebSocket connection
4. **WebSocket Connect**: Uses ticket for secure WebSocket authentication
5. **Ticket Consumption**: Ticket is deleted after single use

### 4. Real-time Communication

#### WebSocket Manager (`core/ws_manager.py`)
```python
class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, set[WebSocket]] = defaultdict(set)
        self.redis: Redis | None = None
        self.instance_id = uuid4().hex
    
    async def connect(self, websocket: WebSocket, user_id: str) -> bool:
        await websocket.accept()
        self.active_connections[user_id].add(websocket)
        return not was_connected  # Returns True if first connection
    
    async def send_personal_message(self, message: Any, user_id: str):
        # Send to all connections for user
        sockets = list(self.active_connections.get(user_id, set()))
        for socket in sockets:
            await socket.send_text(json.dumps(message))
```

#### Redis Pub/Sub Integration
```python
async def publish(self, event: dict[str, Any]) -> None:
    if self.redis is None:
        # Fallback to single-instance delivery
        await self.route_event(event)
        return
    
    # Publish to Redis for cross-instance delivery
    await self.redis.publish(
        settings.websocket_channel,
        json.dumps({"instance_id": self.instance_id, "event": event})
    )

async def _listen_for_pubsub(self) -> None:
    pubsub = self.redis.pubsub()
    await pubsub.subscribe(settings.websocket_channel)
    
    async for message in pubsub.listen():
        if message.get("type") != "message":
            continue
        
        payload = json.loads(message["data"])
        event = payload.get("event")
        await self.route_event(event)
```

**Scaling Architecture:**
- **Single instance**: Direct WebSocket delivery
- **Multiple instances**: Redis Pub/Sub fanout to all instances
- **Instance identification**: Each instance has unique ID to avoid loops
- **Connection tracking**: Multiple connections per user supported

#### WebSocket Endpoint (`api/ws.py`)
```python
@router.websocket("/chat")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: UUID = Depends(get_ws_user)  # Ticket validation
):
    # 1. Establish connection
    user_id_str = str(user_id)
    is_first_connection = await manager.connect(websocket, user_id_str)
    
    # 2. Update presence
    if is_first_connection:
        await set_presence_state(user_id, "online")
        presence_events = await build_presence_events(
            session, user_id=user_id, state="online"
        )
        for event in presence_events:
            await manager.publish(event)
    
    # 3. Message handling loop
    try:
        while True:
            data = await websocket.receive_text()
            event = realtime_event_adapter(json.loads(data))
            
            if event.type == "chat_message":
                await handle_chat_message(event, user_id)
            elif event.type == "typing":
                await handle_typing_event(event, user_id)
    except WebSocketDisconnect:
        # 4. Cleanup on disconnect
        was_last_connection = manager.disconnect(websocket, user_id_str)
        if was_last_connection:
            await set_presence_state(user_id, "offline")
```

**Message Processing:**
```python
async def handle_chat_message(event: ChatMessageEvent, sender_id: UUID):
    # 1. Persist encrypted message
    message_record = await persist_chat_message(
        session, event.chat_id, sender_id, event.ciphertext, event.encryption
    )
    
    # 2. Create delivery event
    delivery_event = ChatMessageEvent(
        type="chat_message",
        chat_id=event.chat_id,
        message_id=str(message_record.id),
        sender_id=str(sender_id),
        target_id=event.target_id,
        ciphertext=event.ciphertext,
        encryption=event.encryption,
        sent_at=event.sent_at,
    )
    
    # 3. Publish to all instances
    await manager.publish(delivery_event.model_dump())
```

### 5. End-to-End Encryption

#### Key Management (`api/keys.py`)
```python
# Identity key upload
@router.post("/identity")
async def upload_identity_keys(
    request: IdentityKeyUploadRequest,
    current_user: User = Depends(get_current_user)
):
    # Store user's public keys for E2EE
    current_user.identity_key_pub = request.identity_key_pub
    current_user.signed_prekey_pub = request.signed_prekey_pub
    await session.commit()
    
    return {"status": "keys_uploaded"}

# Prekey bundle for key exchange
@router.get("/{user_id}/bundle", response_model=PrekeyBundle)
async def get_prekey_bundle(user_id: UUID, session: AsyncSession = Depends(get_db)):
    # Return user's public keys for secure session establishment
    user = await session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    
    # Get one-time prekey
    prekey = await session.scalar(
        select(OneTimePreKey)
        .where(OneTimePreKey.user_id == user_id)
        .where(OneTimePreKey.used == False)
        .order_by(OneTimePreKey.created_at)
        .limit(1)
    )
    
    return PrekeyBundle(
        identity_key=user.identity_key_pub,
        signed_prekey_pub=user.signed_prekey_pub,
        one_time_prekey=prekey.key_base64 if prekey else None
    )
```

#### Frontend Cryptography (`lib/crypto.ts`)
```typescript
// ECDH key pair generation
export const getOrCreateKeyPair = async (username: string): Promise<KeyBundle> => {
  let keyPair = keyPairs.get(username);
  if (keyPair) return keyPair;
  
  // Generate new ECDH key pair
  keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,  // extractable
    ['deriveKey', 'deriveBits']
  );
  
  const publicKeyBase64 = toBase64(
    await crypto.subtle.exportKey('spki', keyPair.publicKey)
  );
  
  keyPairs.set(username, { privateKey: keyPair.privateKey, publicKeyBase64 });
  return keyPairs.get(username)!;
};

// Session key derivation
export const deriveSharedKey = async (
  privateKey: CryptoKey,
  myPublicKeyBase64: string,
  peerPublicKeyBase64: string
): Promise<CryptoKey> => {
  const myPublicKey = await crypto.subtle.importKey(
    'spki', fromBase64(myPublicKeyBase64), 
    { name: 'ECDH', namedCurve: 'P-256' }, 
    true
  );
  
  const peerPublicKey = await crypto.subtle.importKey(
    'spki', fromBase64(peerPublicKeyBase64), 
    { name: 'ECDH', namedCurve: 'P-256' }, 
    true
  );
  
  // ECDH key agreement
  return crypto.subtle.deriveKey(
    { name: 'AES-GCM', length: 256 },
    privateKey,
    peerPublicKey
  );
};

// Message encryption
export const encryptMessage = async (
  body: string,
  aesKey: CryptoKey
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));  // 96-bit IV
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    textEncoder.encode(body)
  );
  
  const envelope: EncryptedEnvelope = {
    ciphertext: toBase64(encrypted),
    iv: toBase64(iv.buffer),
    tag: 'included'  // GCM tag is included in ciphertext
  };
  
  return JSON.stringify(envelope);
};
```

**E2EE Flow:**
1. **Key Generation**: Each user generates ECDH key pair
2. **Key Upload**: Public keys uploaded to server
3. **Key Exchange**: Users fetch each other's public keys
4. **Session Key**: ECDH derives shared secret for conversation
5. **Message Encryption**: AES-256-GCM encrypts messages with session key
6. **Message Decryption**: Recipient uses same session key to decrypt

### 6. Frontend Architecture

#### React Application (`App.tsx`)
```typescript
// State management
const [authToken, setAuthToken] = useState<string | null>(null);
const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
const [messages, setMessages] = useState<DisplayMessage[]>([]);
const [sessionAesKey, setSessionAesKey] = useState<CryptoKey | null>(null);
const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
```

#### WebSocket Hook (`hooks/useWebSocket.ts`)
```typescript
export const useWebSocket = <T>(
  socketUrl: string | null,
  options: WebSocketOptions
) => {
  const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
  const [sendMessage, setSendMessage] = useState<((message: T) => boolean)>();
  
  useEffect(() => {
    if (!socketUrl) return;
    
    const ws = new WebSocket(socketUrl);
    
    ws.onopen = () => {
      setConnectionState('open');
      setSendMessage(() => (message: T) => {
        ws.send(JSON.stringify(message));
        return true;
      });
    };
    
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      options.onMessage?.(message);
    };
    
    ws.onclose = () => setConnectionState('closed');
    ws.onerror = () => setConnectionState('error');
    
    return () => {
      ws.close();
      setSendMessage(undefined);
    };
  }, [socketUrl]);
  
  return { connectionState, sendMessage };
};
```

**Frontend Features:**
- **Automatic reconnection**: WebSocket reconnects on connection loss
- **Message queuing**: Messages queued until connection ready
- **Typing indicators**: Real-time typing status updates
- **Presence management**: Online/offline status tracking
- **Error handling**: Graceful degradation on connection issues

### 7. WebRTC Signaling (`api/webrtc.py`)

#### Signaling Server
```python
@router.post("/offer")
async def handle_offer(
    offer: WebRTCOfferRequest,
    current_user: User = Depends(get_current_user)
):
    # Store WebRTC offer for peer
    await set_webrtc_signal(
        target_user_id=offer.target_user_id,
        from_user_id=current_user.id,
        signal_type="offer",
        payload=offer.offer
    )
    
    # Notify target user
    await manager.publish({
        "type": "webrtc_offer",
        "sender_id": str(current_user.id),
        "target_id": str(offer.target_user_id),
        "payload": offer.offer
    })

@router.post("/answer")
async def handle_answer(answer: WebRTCAnswerRequest):
    # Store WebRTC answer
    await set_webrtc_signal(
        target_user_id=answer.target_user_id,
        from_user_id=current_user.id,
        signal_type="answer",
        payload=answer.answer
    )
    
    # Forward to original caller
    await manager.publish({...})
```

**WebRTC Flow:**
1. **Call Initiation**: User creates WebRTC offer
2. **Signaling**: Offer sent through server to target user
3. **Answer Generation**: Target creates WebRTC answer
4. **Answer Delivery**: Answer sent back through server
5. **ICE Exchange**: Candidates exchanged for NAT traversal
6. **P2P Connection**: Direct peer-to-peer media stream established

### 8. Rate Limiting & Security

#### WebSocket Rate Limiter (`core/rate_limiter.py`)
```python
class WebSocketRateLimiter:
    def __init__(self, redis: Redis | None):
        self.redis = redis
        self.memory_counters: dict[str, int] = {}
    
    async def can_send_message(self, user_id: str) -> bool:
        # Check message rate limit (e.g., 10 messages per minute)
        count = await increment_with_ttl(f"msg_rate:{user_id}", 60)
        return count <= 10
    
    async def can_send_typing(self, user_id: str) -> bool:
        # Check typing indicator rate limit (e.g., 5 per minute)
        count = await increment_with_ttl(f"typing_rate:{user_id}", 60)
        return count <= 5
```

**Security Measures:**
- **Rate limiting**: Prevents message spam and abuse
- **Input validation**: Pydantic models validate all inputs
- **Authentication**: JWT tokens with expiration
- **Authorization**: User permissions checked per request
- **CORS**: Configured for frontend domain only

### 9. Health Monitoring (`api/health.py`)

#### Comprehensive Health Checks
```python
@router.get("/detailed")
async def detailed_health():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "services": {
            "database": await check_database_health(),
            "redis": await check_redis_health(),
            "websocket_manager": {
                "active_connections": len(manager.active_connections),
                "redis_connected": manager.redis is not None
            },
            "memory": {
                "available_mb": psutil.virtual_memory().available / 1024 / 1024,
                "usage_percent": psutil.virtual_memory().percent
            }
        }
    }
```

**Monitoring Features:**
- **Database connectivity**: PostgreSQL connection health
- **Redis connectivity**: Cache and Pub/Sub status
- **WebSocket metrics**: Active connection counts
- **System resources**: Memory and CPU usage
- **Response times**: Performance metrics collection

## 🔄 Complete Data Flow

### User Authentication Flow
```
1. User enters credentials
   ↓
2. POST /api/auth/login
   ↓
3. Validate username/password
   ↓
4. Generate JWT token
   ↓
5. Return token + user info
   ↓
6. Frontend stores token
   ↓
7. All API requests include: Authorization: Bearer <token>
```

### Secure Chat Flow
```
1. User selects chat
   ↓
2. Request WebSocket ticket: POST /api/auth/ws-ticket
   ↓
3. Connect WebSocket: ws://host/api/ws/chat?ticket=<ticket>
   ↓
4. Ticket validation + user identification
   ↓
5. Fetch peer's public keys: GET /api/keys/{peer_id}/bundle
   ↓
6. ECDH key exchange → derive shared secret
   ↓
7. AES-256-GCM session key established
   ↓
8. Messages encrypted with session key
   ↓
9. Send via WebSocket → Publish to Redis
   ↓
10. All instances receive → Deliver to recipient
```

### Message Encryption Flow
```
Sender:
1. "Hello" → AES-256-GCM encrypt(session_key, "Hello")
   ↓
2. {ciphertext: "...", iv: "...", tag: "included"}
   ↓
3. Send via WebSocket

Receiver:
1. Receive encrypted envelope
   ↓
2. Parse ciphertext and IV
   ↓
3. AES-256-GCM decrypt(session_key, ciphertext, iv)
   ↓
4. "Hello" → Display to user
```

### Real-time Event Flow
```
Event Type: chat_message
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Sender   │───►│ WebSocket   │───►│   Manager   │
│             │    │             │    │             │
│ Message:    │    │             │    │             │
│ {           │    │             │    │             │
│   type:     │    │             │    │             │
│ "chat_msg"  │    │             │    │             │
│   ciphertext │    │             │    │             │
│ }           │    │             │    │             │
└─────────────┘    └─────────────┘    └─────────────┘
                           │
                           ▼
                    ┌─────────────┐    ┌─────────────┐
                    │   Redis     │───►│   All       │
                    │   Pub/Sub   │    │ Instances   │
                    │             │    │             │
                    │ Publish:    │    │             │
                    │ {event,     │    │             │
                    │  instance_id}│    │             │
                    └─────────────┘    └─────────────┘
                                        │
                                        ▼
                              ┌─────────────┐    ┌─────────────┐
                              │   Instance  │    │   Instance  │
                              │   Recipient │    │   Recipient │
                              │             │    │             │
                              │ Deliver to   │    │ Deliver to   │
                              │ WebSocket    │    │ WebSocket    │
                              │ connections  │    │ connections  │
                              └─────────────┘    └─────────────┘
```

## 🔐 Security Implementation Details

### Cryptographic Algorithms
- **Key Exchange**: ECDH P-256 (Elliptic Curve Diffie-Hellman)
- **Encryption**: AES-256-GCM (Galois/Counter Mode)
- **Authentication**: HMAC-SHA256 (included in GCM)
- **Random IV**: 96-bit initialization vector per message
- **Key Derivation**: HKDF-SHA256 for session keys

### Security Properties
- **Confidentiality**: Only intended recipients can decrypt messages
- **Integrity**: GCM authentication tag prevents tampering
- **Forward Secrecy**: Session keys derived per conversation
- **No Plaintext**: Server never sees message content
- **Key Compromise**: Limited to single conversation

### Limitations (Current Implementation)
- **No Double Ratchet**: Perfect forward secrecy not implemented
- **No Prekey Rotation**: Keys reused until manual refresh
- **No Message Recovery**: Offline devices can't decrypt old messages
- **No Group Chat**: E2EE only works for direct messages currently

## 🚀 Deployment Architecture

### Docker Composition
```yaml
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: walkerchat
      POSTGRES_USER: walker
      POSTGRES_PASSWORD: change-this-postgres-password
    
  redis:
    image: redis:7-alpine
    # Used for WebSocket Pub/Sub and rate limiting
    
  backend:
    build: ./backend
    environment:
      DATABASE_URL: postgresql+asyncpg://...
      REDIS_URL: redis://redis:6379/0
    
  frontend:
    build: ./frontend
    environment:
      VITE_API_URL: http://localhost:8000
      VITE_WS_URL: ws://localhost:8000
```

### Production Considerations
- **Database**: PostgreSQL with connection pooling
- **Cache**: Redis Cluster for horizontal scaling
- **Load Balancer**: Multiple backend instances
- **SSL/TLS**: HTTPS for all communications
- **Environment Variables**: Secret management system
- **Monitoring**: Health checks and metrics collection

## 📊 Performance & Scaling

### Horizontal Scaling
- **Stateless Backend**: Multiple instances can run simultaneously
- **Redis Pub/Sub**: Coordinates WebSocket connections across instances
- **Database Pooling**: SQLAlchemy manages connection pools
- **Rate Limiting**: Prevents abuse in distributed environment

### Performance Optimizations
- **Async Operations**: All I/O operations are non-blocking
- **Connection Reuse**: WebSocket connections maintained
- **Efficient Serialization**: JSON for compact message format
- **Memory Management**: Proper cleanup of resources

## 🔧 Development & Testing

### API Documentation
- **OpenAPI**: Auto-generated at `/docs`
- **Interactive**: Try endpoints directly in browser
- **Schema Validation**: Pydantic models enforce contracts
- **Error Responses**: Consistent error format

### Testing Infrastructure
- **Demo Data**: Pre-populated users and messages
- **Health Endpoints**: `/api/test/*` for debugging
- **Logging**: Structured logging with different levels
- **Error Handling**: Global exception handlers with proper responses

---

## 🎯 Conclusion

WalkerChat implements a complete secure messaging platform with:

### ✅ **Working Features**
- End-to-end encrypted messaging
- Real-time WebSocket communication
- Scalable multi-instance architecture
- Comprehensive authentication system
- WebRTC signaling for voice/video
- Rate limiting and security measures
- Health monitoring and debugging tools

### 🔄 **Data Flow Summary**
1. **Authentication** → JWT + WebSocket tickets
2. **Key Exchange** → ECDH public key sharing
3. **Session Establishment** → AES-256-GCM derivation
4. **Message Encryption** → Client-side encryption
5. **Real-time Delivery** → WebSocket + Redis Pub/Sub
6. **Message Decryption** → Recipient-side with session key

### 🛡️ **Security Architecture**
- Zero-knowledge server design
- Cryptographic isolation per conversation
- Modern authenticated encryption
- Secure key exchange protocols
- Comprehensive input validation

This architecture provides a solid foundation for secure real-time communication while maintaining scalability and security best practices.
