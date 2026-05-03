const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64 = (value: string) => {
  const bytes = textEncoder.encode(value);
  let binary = '';

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return window.btoa(binary);
};

const fromBase64 = (value: string) => {
  const binary = window.atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return textDecoder.decode(bytes);
};

export type DemoSignalEnvelope = {
  body: string;
  createdAt: string;
};

export const encryptMessage = (body: string) =>
  toBase64(
    JSON.stringify({
      body,
      createdAt: new Date().toISOString(),
    } satisfies DemoSignalEnvelope),
  );

export const decryptMessage = (ciphertext: string): DemoSignalEnvelope => {
  const parsed = JSON.parse(fromBase64(ciphertext)) as Partial<DemoSignalEnvelope>;

  return {
    body: parsed.body ?? '[Encrypted payload]',
    createdAt: parsed.createdAt ?? new Date().toISOString(),
  };
};
