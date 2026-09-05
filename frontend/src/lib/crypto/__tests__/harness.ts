/**
 * Two-party test harness.
 *
 * Models a full client pair -- key publication, bundle fetch, X3DH, and a live ratchet
 * on each side -- so the protocol tests can drive realistic conversations without any
 * network, storage, or React involvement.
 */
import { fromUtf8, utf8 } from '../primitives';
import type { RatchetState } from '../doubleRatchet';
import { initReceiver, initSender, ratchetDecrypt, ratchetEncrypt } from '../doubleRatchet';
import { MESSAGE_TYPE_PREKEY, decodeMessage } from '../serialization';
import {
  createIdentityKeyPair,
  createOneTimePreKeys,
  createSignedPreKey,
  initiateX3DH,
  respondX3DH,
} from '../x3dh';
import type { OneTimePreKey, PreKeyBundle, SignedPreKey } from '../x3dh';
import type { IdentityKeyPair } from '../x3dh';

export class Client {
  readonly name: string;
  readonly identity: IdentityKeyPair;
  readonly signedPreKey: SignedPreKey;
  oneTimePreKeys: OneTimePreKey[];
  state: RatchetState | null = null;

  constructor(name: string, oneTimePreKeyCount = 5) {
    this.name = name;
    this.identity = createIdentityKeyPair();
    this.signedPreKey = createSignedPreKey(this.identity, name + '-spk-1');
    let counter = 0;
    this.oneTimePreKeys = createOneTimePreKeys(oneTimePreKeyCount, () => {
      counter += 1;
      return name + '-opk-' + counter;
    });
  }

  /** What the server would hand out. `withOneTimePreKey` false models an exhausted OPK pool. */
  publishBundle(withOneTimePreKey = true): PreKeyBundle {
    const oneTimePreKey = withOneTimePreKey ? this.oneTimePreKeys[0] : undefined;
    return {
      identityKey: this.identity.publicKey,
      signedPreKeyId: this.signedPreKey.keyId,
      signedPreKey: this.signedPreKey.keyPair.publicKey,
      signedPreKeySignature: this.signedPreKey.signature,
      oneTimePreKeyId: oneTimePreKey ? oneTimePreKey.keyId : null,
      oneTimePreKey: oneTimePreKey ? oneTimePreKey.keyPair.publicKey : null,
    };
  }

  /** Run X3DH as the initiator and open a sending chain. */
  startSessionWith(peer: Client, withOneTimePreKey = true): void {
    const bundle = peer.publishBundle(withOneTimePreKey);
    const result = initiateX3DH(this.identity, bundle);

    this.state = initSender(result.sharedSecret, result.associatedData, bundle.signedPreKey, {
      identityKey: this.identity.publicKey,
      ephemeralKey: result.ephemeralKey.publicKey,
      signedPreKeyId: result.signedPreKeyId,
      oneTimePreKeyId: result.usedOneTimePreKeyId,
    });
  }

  async send(text: string): Promise<Uint8Array> {
    if (!this.state) {
      throw new Error(this.name + ' has no session');
    }
    const { state, message } = await ratchetEncrypt(this.state, utf8(text));
    this.state = state;
    return message;
  }

  /**
   * Receive a message, establishing the session from the prekey fields when this is
   * the first one to arrive.
   */
  async receive(encoded: Uint8Array): Promise<string> {
    if (!this.state) {
      const message = decodeMessage(encoded);
      if (message.type !== MESSAGE_TYPE_PREKEY) {
        throw new Error(this.name + ' received a normal message with no session');
      }

      const oneTimePreKey = this.oneTimePreKeys.find(
        (candidate) => candidate.keyId === message.prekey.oneTimePreKeyId,
      );
      const result = respondX3DH(
        this.identity,
        this.signedPreKey.keyPair.privateKey,
        oneTimePreKey ? oneTimePreKey.keyPair.privateKey : null,
        message.prekey.identityKey,
        message.prekey.ephemeralKey,
      );

      // A one-time prekey is exactly that: delete it so it can never be reused.
      if (oneTimePreKey) {
        this.oneTimePreKeys = this.oneTimePreKeys.filter(
          (candidate) => candidate.keyId !== oneTimePreKey.keyId,
        );
      }

      this.state = initReceiver(
        result.sharedSecret,
        result.associatedData,
        this.signedPreKey.keyPair,
      );
    }

    const { state, plaintext } = await ratchetDecrypt(this.state, encoded);
    this.state = state;
    return fromUtf8(plaintext);
  }
}

/** Establish a session in both directions and return the pair. */
export const connectedPair = async (): Promise<{ alice: Client; bob: Client }> => {
  const alice = new Client('alice');
  const bob = new Client('bob');
  alice.startSessionWith(bob);
  await bob.receive(await alice.send('handshake'));
  await alice.receive(await bob.send('handshake reply'));
  return { alice, bob };
};
