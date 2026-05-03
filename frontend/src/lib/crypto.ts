const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
};

const fromBase64 = (base64: string): ArrayBuffer => {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
};

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

export type KeyBundle = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBase64: string;
};

export type DemoSignalEnvelope = {
  body: string;
  createdAt: string;
};

type EncryptedEnvelope = {
  ciphertext: string;
  iv: string;
  tag: 'included';
};

type CryptoSession = {
  myKeys: KeyBundle;
  sharedKey: CryptoKey;
};

const sessions = new Map<string, CryptoSession>();

const encodeLegacyEnvelope = (body: string): string =>
  toBase64(
    textEncoder.encode(
      JSON.stringify({ body, createdAt: new Date().toISOString() } satisfies DemoSignalEnvelope),
    ).buffer,
  );

const decodeLegacyEnvelope = (ciphertext: string): DemoSignalEnvelope => {
  const bytes = new Uint8Array(fromBase64(ciphertext));
  const parsed = JSON.parse(textDecoder.decode(bytes)) as Partial<DemoSignalEnvelope>;
  return {
    body: parsed.body ?? '[Encrypted payload]',
    createdAt: parsed.createdAt ?? new Date().toISOString(),
  };
};

const importPublicKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', fromBase64(base64), ECDH_PARAMS, true, []);

const deriveSessionSalt = async (
  myPublicKeyBase64: string,
  peerPublicKeyBase64: string,
): Promise<ArrayBuffer> => {
  const ordered = [myPublicKeyBase64, peerPublicKeyBase64].sort().join(':');
  return crypto.subtle.digest('SHA-256', textEncoder.encode(ordered));
};

export const generateKeyPair = async (): Promise<KeyBundle> => {
  const keyPair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);
  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);

  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    publicKeyBase64: toBase64(rawPublicKey),
  };
};

export const getOrCreateKeyPair = async (username: string): Promise<KeyBundle> => {
  const storageKey = `walkerchat-identity-${username}`;
  const stored = localStorage.getItem(storageKey);

  if (stored) {
    try {
      const parsed = JSON.parse(stored) as {
        privateKeyBase64: string;
        publicKeyBase64: string;
      };
      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        fromBase64(parsed.privateKeyBase64),
        ECDH_PARAMS,
        true,
        ['deriveBits'],
      );
      const publicKey = await crypto.subtle.importKey(
        'raw', // Public key stored as raw
        fromBase64(parsed.publicKeyBase64),
        ECDH_PARAMS,
        true,
        [],
      );
      return {
        privateKey,
        publicKey,
        publicKeyBase64: parsed.publicKeyBase64,
      };
    } catch (error) {
      console.warn('Failed to parse stored identity keys, generating new ones.', error);
      localStorage.removeItem(storageKey);
    }
  }

  const generated = await generateKeyPair();
  const exportedPrivate = await crypto.subtle.exportKey('pkcs8', generated.privateKey);

  localStorage.setItem(storageKey, JSON.stringify({
    privateKeyBase64: toBase64(exportedPrivate),
    publicKeyBase64: generated.publicKeyBase64,
  }));

  return generated;
};

export const deriveSharedKey = async (
  privateKey: CryptoKey,
  myPublicKeyBase64: string,
  peerPublicKeyBase64: string,
): Promise<CryptoKey> => {
  const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  );

  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, [
    'deriveKey',
  ]);
  const sessionSalt = await deriveSessionSalt(myPublicKeyBase64, peerPublicKeyBase64);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: sessionSalt,
      info: textEncoder.encode('walkerchat-session-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

export const getOrCreateSession = async (
  peerId: string,
  peerPublicKeyBase64: string,
  myKeys: KeyBundle,
): Promise<CryptoSession> => {
  const existing = sessions.get(peerId);
  if (existing) {
    return existing;
  }

  const sharedKey = await deriveSharedKey(
    myKeys.privateKey,
    myKeys.publicKeyBase64,
    peerPublicKeyBase64,
  );
  const session = { myKeys, sharedKey };
  sessions.set(peerId, session);
  return session;
};

export const clearAllSessions = () => {
  sessions.clear();
};

export const encryptMessage = async (
  body: string,
  aesKey: CryptoKey | null | undefined,
): Promise<string> => {
  if (!aesKey) {
    throw new Error('Secure session is not established yet.');
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    textEncoder.encode(body),
  );

  const envelope: EncryptedEnvelope = {
    ciphertext: toBase64(encrypted),
    iv: toBase64(iv.buffer),
    tag: 'included',
  };

  return JSON.stringify(envelope);
};

export const decryptMessage = async (
  ciphertext: string,
  aesKey?: CryptoKey | null,
): Promise<DemoSignalEnvelope> => {
  try {
    const parsed = JSON.parse(ciphertext) as Partial<EncryptedEnvelope>;
    if (parsed.iv && parsed.ciphertext && aesKey) {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(fromBase64(parsed.iv)) },
        aesKey,
        fromBase64(parsed.ciphertext),
      );
      return {
        body: textDecoder.decode(decrypted),
        createdAt: new Date().toISOString(),
      };
    }
  } catch {
    // Fall through to legacy handling below.
  }

  try {
    return decodeLegacyEnvelope(ciphertext);
  } catch {
    return {
      body: aesKey ? '[Unable to decrypt]' : '[Secure session required]',
      createdAt: new Date().toISOString(),
    };
  }
};

export const createLegacySeedEnvelope = (body: string): string => encodeLegacyEnvelope(body);
