import { describe, expect, it } from 'vitest';

import { fromUtf8, utf8 } from '../primitives';
import {
  MAX_SENDER_KEY_SKIP,
  acceptDistribution,
  buildDistribution,
  createSenderKey,
  groupAssociatedData,
  senderKeyDecrypt,
  senderKeyEncrypt,
} from '../senderKey';
import type { SenderKeyState } from '../senderKey';

const GROUP = 'group-1';
const AD = groupAssociatedData(GROUP, 'alice');

/** A sender chain plus a receiver's view of it. */
const chainPair = (senderId = 'alice') => {
  const sender = createSenderKey(GROUP, senderId);
  const receiver = acceptDistribution(buildDistribution(sender));
  return { sender, receiver };
};

const send = async (state: SenderKeyState, text: string) => {
  const result = await senderKeyEncrypt(state, utf8(text), AD);
  return { state: result.state, message: result.message };
};

const receive = async (state: SenderKeyState, message: Uint8Array) => {
  const result = await senderKeyDecrypt(state, message, AD);
  return { state: result.state, text: fromUtf8(result.plaintext) };
};

describe('sender key distribution', () => {
  it('lets a recipient read messages on the chain', async () => {
    const { sender, receiver } = chainPair();

    const sent = await send(sender, 'hello group');

    expect((await receive(receiver, sent.message)).text).toBe('hello group');
  });

  it('does not share the signing private key', () => {
    const { sender, receiver } = chainPair();

    // If it did, any member could forge messages as any other.
    expect(sender.signingPrivateKey).not.toBeNull();
    expect(receiver.signingPrivateKey).toBeNull();
    expect(receiver.signingPublicKey).toEqual(sender.signingPublicKey);
  });

  it('refuses to send on a receive-only chain', async () => {
    const { receiver } = chainPair();
    await expect(senderKeyEncrypt(receiver, utf8('nope'), AD)).rejects.toThrow(
      /no signing private key/,
    );
  });

  it('rejects a malformed distribution', () => {
    const { sender } = chainPair();
    expect(() =>
      acceptDistribution({ ...buildDistribution(sender), chainKey: new Uint8Array(16) }),
    ).toThrow(/malformed chain key/);
    expect(() =>
      acceptDistribution({ ...buildDistribution(sender), signingPublicKey: new Uint8Array(8) }),
    ).toThrow(/malformed signing key/);
  });

  it('does not let a late joiner read earlier messages', async () => {
    const { sender: initial, receiver } = chainPair();

    const early = await send(initial, 'before you joined');
    const sender = early.state;

    // The distribution carries the *current* chain key, so history stays unreadable.
    const lateJoiner = acceptDistribution(buildDistribution(sender));
    await expect(senderKeyDecrypt(lateJoiner, early.message, AD)).rejects.toThrow();

    const after = await send(sender, 'after you joined');
    expect((await receive(lateJoiner, after.message)).text).toBe('after you joined');

    // The original member is unaffected.
    expect((await receive(receiver, early.message)).text).toBe('before you joined');
  });
});

describe('group messaging', () => {
  it('carries a long run of messages', async () => {
    const pair = chainPair();
    let sender = pair.sender;
    let receiver = pair.receiver;

    for (let index = 0; index < 50; index += 1) {
      const sent = await send(sender, 'message ' + index);
      sender = sent.state;
      const got = await receive(receiver, sent.message);
      receiver = got.state;
      expect(got.text).toBe('message ' + index);
    }
  });

  it('encrypts once for the whole group', async () => {
    const sender = createSenderKey(GROUP, 'alice');
    const members = [0, 1, 2, 3].map(() => acceptDistribution(buildDistribution(sender)));

    const sent = await send(sender, 'one ciphertext, four readers');

    for (const member of members) {
      expect((await receive(member, sent.message)).text).toBe('one ciphertext, four readers');
    }
  });

  it('derives a distinct key per message', async () => {
    const { sender } = chainPair();
    const first = await send(sender, 'identical');
    const second = await send(first.state, 'identical');

    expect(first.message).not.toEqual(second.message);
  });

  it('handles out-of-order delivery', async () => {
    const pair = chainPair();
    let sender = pair.sender;
    let receiver = pair.receiver;

    const messages = [];
    for (const text of ['one', 'two', 'three']) {
      const sent = await send(sender, text);
      sender = sent.state;
      messages.push(sent.message);
    }

    let got = await receive(receiver, messages[2]);
    receiver = got.state;
    expect(got.text).toBe('three');

    got = await receive(receiver, messages[0]);
    receiver = got.state;
    expect(got.text).toBe('one');

    expect((await receive(receiver, messages[1])).text).toBe('two');
  });

  it('tolerates dropped messages', async () => {
    const pair = chainPair();
    let sender = pair.sender;
    const receiver = pair.receiver;
    for (const text of ['dropped one', 'dropped two']) {
      sender = (await send(sender, text)).state;
    }

    const delivered = await send(sender, 'delivered');
    expect((await receive(receiver, delivered.message)).text).toBe('delivered');
  });
});

describe('rejecting forged and replayed messages', () => {
  it('rejects a message signed by a different member', async () => {
    // The attack Sender Keys must prevent: every member holds this sender's chain key,
    // so only the signature stops one member speaking as another.
    const sender = createSenderKey(GROUP, 'alice');
    const receiver = acceptDistribution(buildDistribution(sender));

    // Mallory holds Alice's chain key and builds a message on it with her own signature.
    const mallory: SenderKeyState = {
      ...createSenderKey(GROUP, 'alice'),
      chainKey: sender.chainKey,
      iteration: sender.iteration,
    };
    const forged = await senderKeyEncrypt(mallory, utf8('I am alice'), AD);

    await expect(senderKeyDecrypt(receiver, forged.message, AD)).rejects.toThrow(
      /signature is not valid/,
    );
  });

  it('rejects a tampered ciphertext', async () => {
    const { sender, receiver } = chainPair();
    const sent = await send(sender, 'authentic');
    sent.message[10] ^= 0xff;

    await expect(senderKeyDecrypt(receiver, sent.message, AD)).rejects.toThrow();
  });

  it('rejects a tampered iteration header', async () => {
    const { sender, receiver } = chainPair();
    const sent = await send(sender, 'authentic');
    sent.message[3] ^= 0x01;

    await expect(senderKeyDecrypt(receiver, sent.message, AD)).rejects.toThrow();
  });

  it('rejects a message replayed into another group', async () => {
    const { sender, receiver } = chainPair();
    const sent = await send(sender, 'for group one');

    const otherGroup = groupAssociatedData('group-2', 'alice');
    await expect(senderKeyDecrypt(receiver, sent.message, otherGroup)).rejects.toThrow();
  });

  it('rejects a message attributed to a different sender', async () => {
    const { sender, receiver } = chainPair();
    const sent = await send(sender, 'from alice');

    await expect(
      senderKeyDecrypt(receiver, sent.message, groupAssociatedData(GROUP, 'bob')),
    ).rejects.toThrow();
  });

  it('rejects a replay of a consumed iteration', async () => {
    const pair = chainPair();
    const sent = await send(pair.sender, 'only once');

    const receiver = (await receive(pair.receiver, sent.message)).state;
    await expect(senderKeyDecrypt(receiver, sent.message, AD)).rejects.toThrow(/replay/);
  });

  it('rejects a replay of a skipped message once consumed', async () => {
    const pair = chainPair();
    const first = await send(pair.sender, 'one');
    const second = await send(first.state, 'two');

    let receiver = (await receive(pair.receiver, second.message)).state;
    receiver = (await receive(receiver, first.message)).state;

    await expect(senderKeyDecrypt(receiver, first.message, AD)).rejects.toThrow();
  });

  it('does not advance state when verification fails', async () => {
    const { sender, receiver } = chainPair();
    const good = await send(sender, 'good message');

    const forged = Uint8Array.from(good.message);
    forged[10] ^= 0xff;
    await expect(senderKeyDecrypt(receiver, forged, AD)).rejects.toThrow();

    expect((await receive(receiver, good.message)).text).toBe('good message');
  });

  it('refuses to skip more than the limit', async () => {
    const pair = chainPair();
    let sender = pair.sender;
    const receiver = pair.receiver;
    for (let index = 0; index <= MAX_SENDER_KEY_SKIP; index += 1) {
      sender = (await send(sender, 'skipped ' + index)).state;
    }

    const tooFar = await send(sender, 'too far ahead');
    await expect(senderKeyDecrypt(receiver, tooFar.message, AD)).rejects.toThrow(/limit is/);
  });

  it('rejects a truncated message', async () => {
    const { receiver } = chainPair();
    await expect(senderKeyDecrypt(receiver, new Uint8Array(10), AD)).rejects.toThrow(/Malformed/);
  });
});

describe('rotation on membership change', () => {
  it('leaves a removed member unable to read messages after rotation', async () => {
    const original = createSenderKey(GROUP, 'alice');
    const staying = acceptDistribution(buildDistribution(original));
    const removed = acceptDistribution(buildDistribution(original));

    // Rotation is a brand new chain, so the key the removed member holds is useless.
    const rotated = createSenderKey(GROUP, 'alice');
    const rotatedRecipient = acceptDistribution(buildDistribution(rotated));

    const after = await send(rotated, 'after removal');

    expect((await receive(rotatedRecipient, after.message)).text).toBe('after removal');
    await expect(senderKeyDecrypt(removed, after.message, AD)).rejects.toThrow();
    await expect(senderKeyDecrypt(staying, after.message, AD)).rejects.toThrow();
  });
});
