/**
 * WalkerChat E2EE — Web Crypto API Implementation
 *
 * Uses ECDH (P-256) for X3DH-style key exchange and AES-256-GCM for
 * symmetric message encryption. All crypto operations use the native
 * Web Crypto API — zero external dependencies.
 *
 * Flow:
 *  1. Each user generates an ECDH identity keypair on login
 *  2. Public keys are uploaded to the server
 *  3. Before chatting, the initiator fetches the peer's prekey bundle
 *  4. Both parties derive a shared secret via ECDH → HKDF → AES-256-GCM key
 *  5. Messages are encrypted with AES-GCM using unique IVs
 */

// ─────────────────────────────────────────────────────────────────────
// Encoding helpers
// ─────────────────────────────────────────────────────────────────────

const te = new TextEncoder();
const td = new TextDecoder();

const toBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return window.btoa(binary);
};

const fromBase64 = (b64: string): ArrayBuffer => {
  const binary = window.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// ─────────────────────────────────────────────────────────────────────
// Key generation & management
// ─────────────────────────────────────────────────────────────────────

export type KeyBundle = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBase64: string;
};

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

/**
 * Generate an ECDH keypair and export the public key as Base64.
 */
export const generateKeyPair = async (): Promise<KeyBundle> => {
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, true, [
    'deriveBits',
  ]);

  const rawPub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyBase64: toBase64(rawPub),
  };
};

/**
 * Import a peer's raw public key from Base64.
 */
const importPublicKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', fromBase64(base64), ECDH_PARAMS, true, []);

/**
 * Derive a shared AES-256-GCM key from our private key + peer's public key.
 * Uses HKDF (SHA-256) for proper key derivation from the raw ECDH shared secret.
 */
export const deriveSharedKey = async (
  privateKey: CryptoKey,
  peerPublicKeyBase64: string,
): Promise<CryptoKey> => {
  const peerPub = await importPublicKey(peerPublicKeyBase64);

  // Step 1: ECDH → raw shared secret (256 bits for P-256)
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPub },
    privateKey,
    256,
  );

  // Step 2: HKDF (import shared secret as HKDF key material)
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey'],
  );

  // Step 3: Derive AES-256-GCM key with info label
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // static salt (could be session-specific)
      info: te.encode('walkerchat-e2ee-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

// ─────────────────────────────────────────────────────────────────────
// Message encryption / decryption (AES-256-GCM)
// ─────────────────────────────────────────────────────────────────────

export type EncryptedEnvelope = {
  ciphertext: string; // Base64 encrypted payload
  iv: string; // Base64 initialization vector
  tag: string; // "included" — GCM tag is appended to ciphertext by Web Crypto
};

/**
 * Encrypt a plaintext message with AES-256-GCM.
 * Returns Base64-encoded ciphertext (which includes the GCM auth tag)
 * and the IV used for this message.
 */
export const encryptWithKey = async (
  plaintext: string,
  aesKey: CryptoKey,
): Promise<EncryptedEnvelope> => {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
  const encoded = te.encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encoded,
  );

  return {
    ciphertext: toBase64(encrypted),
    iv: toBase64(iv.buffer),
    tag: 'included', // Web Crypto appends GCM tag to ciphertext automatically
  };
};

/**
 * Decrypt a ciphertext message with AES-256-GCM.
 */
export const decryptWithKey = async (
  envelope: EncryptedEnvelope,
  aesKey: CryptoKey,
): Promise<string> => {
  const ciphertextBuf = fromBase64(envelope.ciphertext);
  const iv = new Uint8Array(fromBase64(envelope.iv));

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ciphertextBuf,
  );

  return td.decode(decrypted);
};

// ─────────────────────────────────────────────────────────────────────
// Session store (in-memory for this session, per-peer)
// ─────────────────────────────────────────────────────────────────────

type CryptoSession = {
  myKeys: KeyBundle;
  sharedKey: CryptoKey;
};

const sessions = new Map<string, CryptoSession>();

/**
 * Establish or retrieve an E2EE session with a peer.
 */
export const getOrCreateSession = async (
  peerId: string,
  peerPublicKeyBase64: string,
  myKeys: KeyBundle,
): Promise<CryptoSession> => {
  const existing = sessions.get(peerId);
  if (existing) return existing;

  const sharedKey = await deriveSharedKey(myKeys.privateKey, peerPublicKeyBase64);
  const session: CryptoSession = { myKeys, sharedKey };
  sessions.set(peerId, session);
  return session;
};

export const clearSession = (peerId: string) => sessions.delete(peerId);
export const clearAllSessions = () => sessions.clear();

// ─────────────────────────────────────────────────────────────────────
// High-level API (backwards-compatible signatures)
// ─────────────────────────────────────────────────────────────────────

/**
 * Legacy-compatible encrypt: if no AES key is available, falls back to
 * Base64 encoding (for the initial bootstrap before key exchange).
 */
export const encryptMessage = (body: string, aesKey?: CryptoKey): string | Promise<string> => {
  if (!aesKey) {
    // Fallback: Base64 envelope (pre-key-exchange state)
    return toBase64(
      new TextEncoder().encode(
        JSON.stringify({ body, createdAt: new Date().toISOString() }),
      ).buffer,
    );
  }

  // Real encryption path
  return (async () => {
    const envelope = await encryptWithKey(body, aesKey);
    return JSON.stringify(envelope);
  })();
};

export type DemoSignalEnvelope = {
  body: string;
  createdAt: string;
};

/**
 * Legacy-compatible decrypt: tries JSON parse for real encrypted envelopes,
 * falls back to Base64 decode for legacy messages.
 */
export const decryptMessage = (
  ciphertext: string,
  aesKey?: CryptoKey,
): DemoSignalEnvelope | Promise<DemoSignalEnvelope> => {
  // Try real encrypted envelope first
  try {
    const parsed = JSON.parse(ciphertext) as Partial<EncryptedEnvelope>;
    if (parsed.iv && parsed.ciphertext && aesKey) {
      return (async () => {
        const plaintext = await decryptWithKey(parsed as EncryptedEnvelope, aesKey);
        return { body: plaintext, createdAt: new Date().toISOString() };
      })();
    }
  } catch {
    // Not JSON, try base64 fallback
  }

  // Legacy base64 fallback
  try {
    const binary = window.atob(ciphertext);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = JSON.parse(td.decode(bytes)) as Partial<DemoSignalEnvelope>;
    return {
      body: json.body ?? '[Encrypted payload]',
      createdAt: json.createdAt ?? new Date().toISOString(),
    };
  } catch {
    return {
      body: '[Unable to decrypt]',
      createdAt: new Date().toISOString(),
    };
  }
};
