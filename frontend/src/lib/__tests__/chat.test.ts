import { describe, expect, it } from 'vitest';

import { acknowledgeMessage, compareSentAt, mergeMessages } from '../chat';
import type { DisplayMessage } from '../../types/chat';

const message = (overrides: Partial<DisplayMessage>): DisplayMessage => ({
  id: 'id',
  clientMessageId: 'client-1',
  serverMessageId: undefined,
  senderId: 'alice',
  body: 'body',
  sentAt: '2026-09-05T10:00:00.000Z',
  state: 'sending',
  ...overrides,
});

describe('compareSentAt', () => {
  it('orders the server format and the client format consistently', () => {
    // The server sends naive UTC; the client uses toISOString(). Comparing these as
    // strings gives the wrong answer, which is what this guards.
    const serverFormat = '2026-09-05T10:00:01';
    const clientFormat = '2026-09-05T10:00:00.000Z';

    expect(compareSentAt(clientFormat, serverFormat)).toBeLessThan(0);
    expect(compareSentAt(serverFormat, clientFormat)).toBeGreaterThan(0);
  });

  it('treats the same instant in both formats as equal', () => {
    expect(compareSentAt('2026-09-05T10:00:00', '2026-09-05T10:00:00.000Z')).toBe(0);
  });

  it('sorts unparseable values last instead of throwing', () => {
    expect(compareSentAt('not a date', '2026-09-05T10:00:00Z')).toBeGreaterThan(0);
    expect(compareSentAt('2026-09-05T10:00:00Z', 'not a date')).toBeLessThan(0);
    expect(compareSentAt('not a date', 'also not a date')).toBe(0);
  });
});

describe('mergeMessages', () => {
  it('keeps two pending sends apart', () => {
    // Both have an undefined serverMessageId. Matching on that made the second send
    // replace the first, so one message visibly vanished.
    const first = message({ clientMessageId: 'client-1', body: 'first' });
    const second = message({
      clientMessageId: 'client-2',
      body: 'second',
      sentAt: '2026-09-05T10:00:01.000Z',
    });

    const merged = mergeMessages(mergeMessages([], first), second);

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.body)).toEqual(['first', 'second']);
  });

  it('replaces the optimistic copy when the server echo arrives', () => {
    const optimistic = message({ clientMessageId: 'client-1', body: 'hello' });
    const acknowledged = message({
      clientMessageId: 'client-1',
      serverMessageId: 'server-1',
      body: 'hello',
      state: 'sent',
    });

    const merged = mergeMessages(mergeMessages([], optimistic), acknowledged);

    expect(merged).toHaveLength(1);
    expect(merged[0].state).toBe('sent');
    expect(merged[0].serverMessageId).toBe('server-1');
  });

  it('deduplicates a repeated server echo', () => {
    const acknowledged = message({
      clientMessageId: 'client-1',
      serverMessageId: 'server-1',
      state: 'sent',
    });

    const merged = mergeMessages(mergeMessages([], acknowledged), acknowledged);
    expect(merged).toHaveLength(1);
  });

  it('matches on server id even when client ids differ', () => {
    // History fetched after a reload has no client id to match on.
    const fromHistory = message({
      clientMessageId: 'server-1',
      serverMessageId: 'server-1',
      state: 'sent',
    });
    const fromSocket = message({
      clientMessageId: 'client-1',
      serverMessageId: 'server-1',
      state: 'sent',
    });

    expect(mergeMessages(mergeMessages([], fromHistory), fromSocket)).toHaveLength(1);
  });

  it('sorts inserted messages by instant, across both timestamp formats', () => {
    const later = message({ clientMessageId: 'b', sentAt: '2026-09-05T10:00:05.000Z' });
    const earlier = message({ clientMessageId: 'a', sentAt: '2026-09-05T10:00:01' });

    const merged = mergeMessages(mergeMessages([], later), earlier);
    expect(merged.map((entry) => entry.clientMessageId)).toEqual(['a', 'b']);
  });
});

describe('acknowledgeMessage', () => {
  it('marks the optimistic copy sent without touching its body', () => {
    // The echo of our own message is never decrypted, so the body has to survive.
    const pending = message({ clientMessageId: 'client-1', body: 'what I said' });
    const acknowledged = acknowledgeMessage(
      [pending],
      'client-1',
      'server-1',
      '2026-09-05T10:00:02',
    );

    expect(acknowledged).toHaveLength(1);
    expect(acknowledged[0].body).toBe('what I said');
    expect(acknowledged[0].state).toBe('sent');
    expect(acknowledged[0].serverMessageId).toBe('server-1');
    expect(acknowledged[0].id).toBe('server-1');
  });

  it('adopts the server timestamp', () => {
    const pending = message({ clientMessageId: 'client-1', sentAt: '2026-09-05T09:59:00.000Z' });
    const acknowledged = acknowledgeMessage([pending], 'client-1', 'server-1', '2026-09-05T10:00:02');

    expect(acknowledged[0].sentAt).toBe('2026-09-05T10:00:02');
  });

  it('ignores an echo with no local copy', () => {
    // Sent from another tab or device: nothing to reconcile, and nothing decryptable.
    const existing = message({ clientMessageId: 'client-1' });
    expect(acknowledgeMessage([existing], 'client-999', 'server-9', '2026-09-05T10:00:02')).toEqual([
      existing,
    ]);
  });

  it('leaves other messages untouched', () => {
    const first = message({ clientMessageId: 'client-1', body: 'first' });
    const second = message({
      clientMessageId: 'client-2',
      body: 'second',
      sentAt: '2026-09-05T10:00:01.000Z',
    });

    const acknowledged = acknowledgeMessage([first, second], 'client-1', 'server-1', '2026-09-05T10:00:00');
    expect(acknowledged.find((entry) => entry.clientMessageId === 'client-2')?.state).toBe('sending');
  });
});
