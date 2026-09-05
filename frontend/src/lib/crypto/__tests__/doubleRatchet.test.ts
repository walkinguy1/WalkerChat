import { describe, expect, it } from 'vitest';

import { MAX_SKIP, ratchetDecrypt } from '../doubleRatchet';
import { utf8 } from '../primitives';
import { HEADER_LEN, MESSAGE_TYPE_PREKEY, decodeMessage } from '../serialization';
import { Client, connectedPair } from './harness';

describe('Double Ratchet', () => {
  it('completes a handshake and delivers the first message', async () => {
    const alice = new Client('alice');
    const bob = new Client('bob');
    alice.startSessionWith(bob);

    expect(await bob.receive(await alice.send('hello bob'))).toBe('hello bob');
  });

  it('marks the first message as a prekey message and later ones as normal', async () => {
    const alice = new Client('alice');
    const bob = new Client('bob');
    alice.startSessionWith(bob);

    const first = await alice.send('one');
    expect(decodeMessage(first).type).toBe(MESSAGE_TYPE_PREKEY);
    await bob.receive(first);

    // Alice keeps resending the X3DH fields until Bob replies -- she has no evidence
    // the handshake landed before that.
    expect(decodeMessage(await alice.send('two')).type).toBe(MESSAGE_TYPE_PREKEY);
    await alice.receive(await bob.send('reply'));
    expect(decodeMessage(await alice.send('three')).type).not.toBe(MESSAGE_TYPE_PREKEY);
  });

  it('consumes the one-time prekey so it cannot be reused', async () => {
    const alice = new Client('alice');
    const bob = new Client('bob');
    const before = bob.oneTimePreKeys.length;
    alice.startSessionWith(bob);
    await bob.receive(await alice.send('hello'));

    expect(bob.oneTimePreKeys).toHaveLength(before - 1);
  });

  it('carries a conversation in both directions', async () => {
    const { alice, bob } = await connectedPair();

    for (let index = 0; index < 10; index += 1) {
      expect(await bob.receive(await alice.send('a' + index))).toBe('a' + index);
      expect(await alice.receive(await bob.send('b' + index))).toBe('b' + index);
    }
  });

  it('handles a long unidirectional run without a reply', async () => {
    const { alice, bob } = await connectedPair();

    for (let index = 0; index < 100; index += 1) {
      expect(await bob.receive(await alice.send('burst ' + index))).toBe('burst ' + index);
    }
  });

  it('derives a distinct key per message', async () => {
    const { alice, bob } = await connectedPair();
    const first = await alice.send('identical');
    const second = await alice.send('identical');

    // Same plaintext, different ciphertext: this is forward secrecy visible on the wire.
    expect(first).not.toEqual(second);
    expect(await bob.receive(first)).toBe('identical');
    expect(await bob.receive(second)).toBe('identical');
  });

  it('decrypts messages that arrive out of order', async () => {
    const { alice, bob } = await connectedPair();
    const messages = [await alice.send('one'), await alice.send('two'), await alice.send('three')];

    expect(await bob.receive(messages[2])).toBe('three');
    expect(await bob.receive(messages[0])).toBe('one');
    expect(await bob.receive(messages[1])).toBe('two');
  });

  it('decrypts a message from a previous chain after the conversation turns', async () => {
    const { alice, bob } = await connectedPair();
    const straggler = await alice.send('sent before the turn');

    // Bob replies without having seen it, forcing a DH ratchet step, and only then does
    // the straggler arrive.
    await alice.receive(await bob.send('bob replies'));
    await bob.receive(await alice.send('alice replies'));

    expect(await bob.receive(straggler)).toBe('sent before the turn');
  });

  it('handles both sides sending simultaneously', async () => {
    const { alice, bob } = await connectedPair();
    const fromAlice = await alice.send('from alice');
    const fromBob = await bob.send('from bob');

    expect(await bob.receive(fromAlice)).toBe('from alice');
    expect(await alice.receive(fromBob)).toBe('from bob');
  });

  it('tolerates permanently dropped messages', async () => {
    const { alice, bob } = await connectedPair();
    await alice.send('dropped one');
    await alice.send('dropped two');

    expect(await bob.receive(await alice.send('delivered'))).toBe('delivered');
  });

  it('rejects a replayed message', async () => {
    const { alice, bob } = await connectedPair();
    const message = await alice.send('only once');

    expect(await bob.receive(message)).toBe('only once');
    // The message key was consumed, so the replay has nothing to decrypt with.
    await expect(bob.receive(message)).rejects.toThrow();
  });

  it('rejects a replayed skipped message', async () => {
    const { alice, bob } = await connectedPair();
    const first = await alice.send('one');
    const second = await alice.send('two');

    await bob.receive(second);
    expect(await bob.receive(first)).toBe('one');
    await expect(bob.receive(first)).rejects.toThrow();
  });

  it('rejects a tampered ciphertext', async () => {
    const { alice, bob } = await connectedPair();
    const message = await alice.send('authentic');
    message[message.length - 1] ^= 0xff;

    await expect(bob.receive(message)).rejects.toThrow();
  });

  it('rejects a tampered header', async () => {
    const { alice, bob } = await connectedPair();
    const message = await alice.send('authentic');

    // Flip a byte inside the header. It is bound as associated data, so this must fail
    // rather than silently decrypt under a re-derived key.
    message[1 + HEADER_LEN - 1] ^= 0x01;
    await expect(bob.receive(message)).rejects.toThrow();
  });

  it('rejects a message forged without any key material', async () => {
    const { bob } = await connectedPair();
    // This is the concrete regression test for the legacy plaintext fallback: a payload
    // that is not a valid sealed message must never yield a plaintext.
    await expect(bob.receive(utf8('{"body":"injected by the server"}'))).rejects.toThrow();
  });

  it('does not advance state when decryption fails', async () => {
    const { alice, bob } = await connectedPair();
    const good = await alice.send('good message');

    const forged = Uint8Array.from(good);
    forged[forged.length - 1] ^= 0xff;
    await expect(bob.receive(forged)).rejects.toThrow();

    // A forgery must not be able to desynchronise the session.
    expect(await bob.receive(good)).toBe('good message');
  });

  it('refuses to skip more than MAX_SKIP messages', async () => {
    const { alice, bob } = await connectedPair();

    for (let index = 0; index <= MAX_SKIP; index += 1) {
      await alice.send('skipped ' + index);
    }

    await expect(bob.receive(await alice.send('too far ahead'))).rejects.toThrow(/MAX_SKIP/);
  });

  it('skips up to MAX_SKIP messages successfully', async () => {
    const { alice, bob } = await connectedPair();
    for (let index = 0; index < MAX_SKIP - 1; index += 1) {
      await alice.send('skipped ' + index);
    }

    expect(await bob.receive(await alice.send('at the limit'))).toBe('at the limit');
  });

  it('keeps state serialisable so it can survive a reload', async () => {
    const { alice, bob } = await connectedPair();
    const message = await alice.send('after a reload');

    // Round-trip Bob's state through the kind of encoding IndexedDB persistence uses.
    const revived = JSON.parse(
      JSON.stringify(bob.state, (_key, value) =>
        value instanceof Uint8Array ? { __bytes: Array.from(value) } : value,
      ),
      (_key, value) =>
        value && typeof value === 'object' && '__bytes' in value
          ? new Uint8Array(value.__bytes as number[])
          : value,
    );

    const { plaintext } = await ratchetDecrypt(revived, message);
    expect(new TextDecoder().decode(plaintext)).toBe('after a reload');
  });

  it('survives a randomised send/reorder workload', async () => {
    // A scripted conversation only covers the interleavings we thought of. This drives
    // several hundred randomised operations and asserts every delivery.
    const { alice, bob } = await connectedPair();
    const clients = { alice, bob };
    const inFlight: { to: 'alice' | 'bob'; message: Uint8Array; text: string }[] = [];

    let seed = 42;
    const random = (max: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };

    for (let step = 0; step < 400; step += 1) {
      const shouldSend = inFlight.length === 0 || random(100) < 60;

      if (shouldSend) {
        const from = random(2) === 0 ? 'alice' : 'bob';
        const to = from === 'alice' ? 'bob' : 'alice';
        const text = from + '-' + step;
        inFlight.push({ to, message: await clients[from].send(text), text });
        continue;
      }

      // Deliver a random pending message, so ordering is genuinely shuffled.
      const [pending] = inFlight.splice(random(inFlight.length), 1);
      expect(await clients[pending.to].receive(pending.message)).toBe(pending.text);
    }

    for (const pending of inFlight) {
      expect(await clients[pending.to].receive(pending.message)).toBe(pending.text);
    }
  });
});
