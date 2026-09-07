import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { GroupSessionManager, decodeDistribution, encodeDistribution } from '../groups';
import { DecryptionFailure, SessionManager, bootstrapIdentity } from '../session';
import { buildDistribution, createSenderKey } from '../senderKey';
import { CryptoStore } from '../store';
import { Directory } from './directory';

const TEST_ITERATIONS = 100;
const GROUP = 'group-1';

let counter = 0;

/** A group member: pairwise sessions plus a group manager. */
class Member {
  store!: CryptoStore;
  sessions!: SessionManager;
  groups!: GroupSessionManager;
  deviceRowId = '';

  readonly userId: string;

  private constructor(userId: string) {
    this.userId = userId;
  }

  static async create(userId: string, directory: Directory, label = 'primary'): Promise<Member> {
    const member = new Member(userId);
    counter += 1;

    member.store = await CryptoStore.unlock('password ' + userId + label, {
      databaseName: `groups-test-${userId}-${label}-${counter}`,
      iterations: TEST_ITERATIONS,
    });

    const bootstrap = await bootstrapIdentity(member.store);
    member.deviceRowId = directory.publish(userId, bootstrap.publish!);

    member.sessions = new SessionManager({
      store: member.store,
      identity: bootstrap.identity,
      fetchBundle: (peerUserId) => directory.claim(peerUserId),
    });
    member.groups = new GroupSessionManager({
      store: member.store,
      sessions: member.sessions,
      selfId: userId,
    });

    return member;
  }

  /** Accept a distribution that arrived over the pairwise session. */
  async receiveDistribution(
    from: { userId: string; deviceRowId: string },
    ciphertext: string,
  ): Promise<void> {
    const plaintext = await this.sessions.decrypt(from, ciphertext);
    const distribution = decodeDistribution(plaintext);
    if (!distribution) {
      throw new Error('Expected a sender key distribution');
    }
    await this.groups.acceptDistribution(distribution);
  }

  close(): void {
    this.store.close();
  }
}

let directory: Directory;

beforeEach(() => {
  directory = new Directory();
});

/** Send a group message and deliver every distribution it produced. */
const broadcast = async (
  sender: Member,
  members: Member[],
  text: string,
): Promise<string> => {
  const memberIds = [...new Set(members.map((member) => member.userId))];
  const { message, distributions } = await sender.groups.encrypt(GROUP, memberIds, text);

  // Distributions are addressed to devices, so each installation of a member gets its
  // own copy over its own pairwise session.
  for (const distribution of distributions) {
    const recipient = members.find(
      (member) => member.deviceRowId === distribution.deviceRowId,
    );
    await recipient?.receiveDistribution(
      { userId: sender.userId, deviceRowId: sender.deviceRowId },
      distribution.ciphertext,
    );
  }

  return message;
};

describe('distribution encoding', () => {
  it('round-trips', () => {
    const state = createSenderKey(GROUP, 'alice');
    const distribution = buildDistribution(state);
    const decoded = decodeDistribution(encodeDistribution(distribution));

    expect(decoded).toEqual(distribution);
  });

  it('returns null for an ordinary message', () => {
    expect(decodeDistribution('just a normal message')).toBeNull();
    expect(decodeDistribution('{"_wc":1,"caption":"hi"}')).toBeNull();
    expect(decodeDistribution('{ not json')).toBeNull();
  });
});

describe('group messaging end to end', () => {
  it('delivers one ciphertext to every member', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);
    const carol = await Member.create('carol', directory);
    const members = [alice, bob, carol];

    const message = await broadcast(alice, members, 'hello everyone');

    expect(await bob.groups.decrypt(GROUP, 'alice', message)).toBe('hello everyone');
    expect(await carol.groups.decrypt(GROUP, 'alice', message)).toBe('hello everyone');

    members.forEach((member) => member.close());
  });

  it('lets every member send', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);
    const members = [alice, bob];

    const fromAlice = await broadcast(alice, members, 'from alice');
    expect(await bob.groups.decrypt(GROUP, 'alice', fromAlice)).toBe('from alice');

    const fromBob = await broadcast(bob, members, 'from bob');
    expect(await alice.groups.decrypt(GROUP, 'bob', fromBob)).toBe('from bob');

    members.forEach((member) => member.close());
  });

  it('distributes the sender key only once', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);
    const members = [alice, bob];

    const first = await alice.groups.encrypt(GROUP, ['alice', 'bob'], 'one');
    expect(first.distributions).toHaveLength(1);

    // The chain already exists, so later sends carry no distribution.
    const second = await alice.groups.encrypt(GROUP, ['alice', 'bob'], 'two');
    expect(second.distributions).toHaveLength(0);

    members.forEach((member) => member.close());
  });

  it('carries a long conversation', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);
    const members = [alice, bob];

    let message = await broadcast(alice, members, 'first');
    expect(await bob.groups.decrypt(GROUP, 'alice', message)).toBe('first');

    for (let index = 0; index < 20; index += 1) {
      message = await broadcast(alice, members, 'message ' + index);
      expect(await bob.groups.decrypt(GROUP, 'alice', message)).toBe('message ' + index);
    }

    members.forEach((member) => member.close());
  });

  it('survives a reload, because chains are persisted', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);
    const members = [alice, bob];

    const message = await broadcast(alice, members, 'before reload');
    expect(await bob.groups.decrypt(GROUP, 'alice', message)).toBe('before reload');

    // Rebuild Bob's manager against the same vault, as a page reload would.
    const revived = new GroupSessionManager({
      store: bob.store,
      sessions: bob.sessions,
      selfId: 'bob',
    });
    const next = await broadcast(alice, members, 'after reload');
    expect(await revived.decrypt(GROUP, 'alice', next)).toBe('after reload');

    members.forEach((member) => member.close());
  });

  it('fails cleanly for a member whose sender key we never received', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);

    const { message } = await alice.groups.encrypt(GROUP, ['alice', 'bob'], 'undelivered key');

    // Bob never got the distribution, so this must fail rather than render anything.
    await expect(bob.groups.decrypt(GROUP, 'alice', message)).rejects.toThrow(DecryptionFailure);

    alice.close();
    bob.close();
  });

  it('rejects a tampered group message', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);
    const members = [alice, bob];

    const message = await broadcast(alice, members, 'authentic');
    const bytes = Uint8Array.from(atob(message), (char) => char.charCodeAt(0));
    bytes[8] ^= 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));

    await expect(bob.groups.decrypt(GROUP, 'alice', tampered)).rejects.toThrow(DecryptionFailure);

    members.forEach((member) => member.close());
  });

  it('rejects a message replayed into another group', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);
    const members = [alice, bob];

    const message = await broadcast(alice, members, 'for group one');
    await expect(bob.groups.decrypt('group-2', 'alice', message)).rejects.toThrow();

    members.forEach((member) => member.close());
  });
});

describe('rotation when membership changes', () => {
  it('stops a removed member reading later messages', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);
    const carol = await Member.create('carol', directory);
    const everyone = [alice, bob, carol];

    const before = await broadcast(alice, everyone, 'while carol was here');
    expect(await carol.groups.decrypt(GROUP, 'alice', before)).toBe('while carol was here');

    // Carol leaves. Alice rotates and redistributes to the remaining members only.
    const remaining = [alice, bob];
    carol.close();
    const distributions = await alice.groups.rotate(GROUP, ['alice', 'bob']);
    for (const distribution of distributions) {
      const recipient = remaining.find(
        (member) => member.deviceRowId === distribution.deviceRowId,
      );
      await recipient?.receiveDistribution(
        { userId: 'alice', deviceRowId: alice.deviceRowId },
        distribution.ciphertext,
      );
    }

    const after = await broadcast(alice, remaining, 'after carol left');

    expect(await bob.groups.decrypt(GROUP, 'alice', after)).toBe('after carol left');
    // Carol still holds the old chain key, which is precisely why rotation is required.
    await expect(carol.groups.decrypt(GROUP, 'alice', after)).rejects.toThrow();

    [alice, bob].forEach((member) => member.close());
  });

  it('forgets every chain for a group', async () => {
    const alice = await Member.create('alice', directory);
    const bob = await Member.create('bob', directory);
    const members = [alice, bob];

    const message = await broadcast(alice, members, 'before leaving');
    expect(await bob.groups.decrypt(GROUP, 'alice', message)).toBe('before leaving');

    await bob.groups.forget(GROUP);
    const next = await broadcast(alice, members, 'after leaving');
    await expect(bob.groups.decrypt(GROUP, 'alice', next)).rejects.toThrow();

    members.forEach((member) => member.close());
  });
});

describe('groups across multiple devices', () => {
  it('distributes a sender key to every device of every member', async () => {
    const alice = await Member.create('alice', directory);
    const bobLaptop = await Member.create('bob', directory, 'laptop');
    const bobPhone = await Member.create('bob', directory, 'phone');
    const members = [alice, bobLaptop, bobPhone];

    const message = await broadcast(alice, members, 'reaches both of bob devices');

    // One group ciphertext, but the *key* to read it had to reach each device
    // separately over its own pairwise session.
    expect(await bobLaptop.groups.decrypt(GROUP, 'alice', message)).toBe(
      'reaches both of bob devices',
    );
    expect(await bobPhone.groups.decrypt(GROUP, 'alice', message)).toBe(
      'reaches both of bob devices',
    );

    members.forEach((member) => member.close());
  });

  it('produces one distribution per device, not per member', async () => {
    const alice = await Member.create('alice', directory);
    await Member.create('bob', directory, 'laptop');
    await Member.create('bob', directory, 'phone');

    const { distributions } = await alice.groups.encrypt(GROUP, ['alice', 'bob'], 'hello');
    expect(distributions).toHaveLength(2);

    alice.close();
  });
});
