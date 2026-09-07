# WalkerChat cryptographic protocol

This document describes what WalkerChat's E2EE actually does, including where it
deliberately departs from the published Signal specifications. It is meant to be
auditable: if the code and this document disagree, that is a bug in one of them.

Implementation lives in `frontend/src/lib/crypto/`. Tests are in
`frontend/src/lib/crypto/__tests__/`; run them with `npm run test` from `frontend/`.

## Primitives

| Role | Algorithm | Source |
|---|---|---|
| Diffie-Hellman | X25519 | `@noble/curves` |
| Signatures | XEdDSA over Curve25519 | implemented here, on `@noble/curves` |
| Hash | SHA-256 (SHA-512 for XEdDSA and fingerprints) | `@noble/hashes` |
| KDF | HKDF-SHA256 | `@noble/hashes` |
| Chain KDF | HMAC-SHA256 | `@noble/hashes` |
| AEAD | AES-256-GCM | WebCrypto (`crypto.subtle`) |

`@noble` was chosen over WebCrypto for the protocol layer because WebCrypto has no
X25519 in every target browser and cannot do XEdDSA at all, and because a pure-JS
implementation runs identically under Node, which is what makes the ratchet unit
testable. AES-GCM stays on WebCrypto, where it is native and constant-time.

## XEdDSA

X3DH requires the signed prekey to be signed by the **identity key**, which is an
X25519 key used for Diffie-Hellman. XEdDSA (Signal, *The XEdDSA and VXEdDSA Signature
Schemes*, section 2) lets one Montgomery key do both jobs rather than shipping a
separate Ed25519 identity key.

Two implementation notes that are easy to get wrong:

- The X25519 secret is **clamped** before use, and the clamped value is reduced mod the
  group order `q`. Clamping sets bit 254, so the raw scalar is around 2^254 and exceeds
  `q` (~2^252). Since the base point has order `q`, `kB == (k mod q)B`, so the reduction
  is exact rather than an approximation.
- `calculate_key_pair` clears the sign bit of the derived Ed25519 public key and negates
  the scalar when it was set, so the scalar still matches the published key.

An XEdDSA signature is a valid *standard* Ed25519 signature under the converted public
key. The test suite exploits this to cross-check our signer against `@noble`'s
independent Ed25519 verifier, rather than only against our own verifier.

## X3DH

Per *The X3DH Key Agreement Protocol*, Curve25519 variant.

```
DH1 = DH(IK_A, SPK_B)
DH2 = DH(EK_A, IK_B)
DH3 = DH(EK_A, SPK_B)
DH4 = DH(EK_A, OPK_B)        -- omitted when no one-time prekey is available
SK  = HKDF-SHA256(
        ikm  = F || DH1 || DH2 || DH3 [|| DH4],
        salt = 32 zero bytes,
        info = "WalkerChatX3DHCurve25519",
        len  = 32)
AD  = Encode(IK_A) || Encode(IK_B)
```

`F` is 32 bytes of `0xFF`. `AD` is bound into every subsequent message as AEAD
associated data.

The initiator verifies the signed prekey signature **before performing any DH**. A
bundle that fails verification aborts the handshake. There is no fallback path: an
unsigned or badly signed bundle is precisely what a malicious server would serve.

## Double Ratchet

Per *The Double Ratchet Algorithm*.

```
KDF_RK(rk, dh_out) = HKDF-SHA256(ikm = dh_out, salt = rk,
                                 info = "WalkerChatRatchet", len = 64)
                     -> (rk', ck')

KDF_CK(ck)         = mk  = HMAC-SHA256(ck, 0x01)
                     ck' = HMAC-SHA256(ck, 0x02)

message keys       = HKDF-SHA256(ikm = mk, salt = 32 zero bytes,
                                 info = "WalkerChatMessageKeys", len = 44)
                     -> (aes_key[32], iv[12])
```

Limits: `MAX_SKIP = 1000` message keys per chain, `MAX_SKIPPED_KEYS = 2000` retained
globally with oldest-first eviction. Both are required — a sender controls `n` and can
otherwise claim `n = 2^32 - 1` and exhaust memory.

### Deviations from the specification

**AES-256-GCM instead of AES-256-CBC + HMAC-SHA256.** The specification permits any
AEAD; it recommends CBC+HMAC. GCM is native in WebCrypto, removes a hand-rolled
encrypt-then-MAC construction (a classic source of ordering mistakes), and is
authenticated by construction.

The usual objection to GCM is catastrophic failure under nonce reuse. That cannot occur
here: the IV is **derived from the message key** rather than chosen randomly, and each
message key is used for exactly one message. A repeated nonce would require a repeated
message key, which would already be a total break of the chain KDF.

**Plain headers, not the header-encryption variant.** Ratchet headers travel in the
clear. This leaks the ratchet public key and message counters to the server. That is a
real metadata leak and is documented rather than silently omitted; the judgement is that
it buys little when the server already sees `sender_id`, `chat_id`, and timestamps on
every row, and costs a second set of rotating header keys.

## Message format

Length-prefixed and canonical, because these bytes are used as AEAD associated data —
if the same bytes could be parsed two ways, the binding would not bind.

```
header        := dh[32] || pn[uint32 BE] || n[uint32 BE]              (40 bytes)

normal        := 0x02 || header || ciphertext
prekey        := 0x01 || IK_A[32] || EK_A[32]
                      || len(spk_id)[uint16] || spk_id
                      || opk_present[u8] [|| len(opk_id)[uint16] || opk_id]
                      || header || ciphertext

AEAD AD       := AD_x3dh (64 bytes) || header (40 bytes)
```

A prekey message repeats the X3DH fields on every send until the peer replies. Until
that reply arrives the initiator has no evidence the handshake was ever received.

## Key distribution

The server is a key *directory*, not a trust anchor. It cannot be relied on to be honest
about the material it serves, which is why the client verifies the signed prekey
signature itself and surfaces identity changes through safety numbers.

For that reason the server deliberately does **not** verify XEdDSA signatures. Doing so
would catch buggy clients but protect nothing against a malicious server, and the client
must verify regardless. What the server does instead is refuse structurally impossible
material and make identity changes visible.

| Endpoint | Purpose |
|---|---|
| `POST /api/keys/publish` | Publish identity key, signed prekey and an initial OPK batch |
| `POST /api/keys/signed-prekey` | Rotate the signed prekey |
| `POST /api/keys/opks` | Top up the one-time prekey pool |
| `GET /api/keys/opks/count` | Remaining OPKs for one device, with a replenish hint |
| `GET /api/keys/{user_id}/devices` | Every device an account has |
| `POST /api/keys/{user_id}/bundle` | Claim a bundle per device (consumes one OPK each) |

Four changes from the previous design, each fixing a specific defect:

- **Claiming is a POST, not a GET.** It consumes a one-time prekey, so as a GET any
  prefetch, retry or crawler silently burned prekeys.
- **The claim is atomic**: a single `DELETE ... RETURNING` over a `FOR UPDATE SKIP
  LOCKED` subquery. The previous select-then-update was a race in which two concurrent
  initiators could be handed the *same* one-time prekey, destroying the forward secrecy
  it exists to provide. Claimed prekeys are deleted rather than flagged, so consumed
  rows cannot accumulate forever.
- **Claims are rate limited per requester.** Each call permanently removes one of the
  target's prekeys, so an unlimited rate lets any authenticated user drain another
  user's pool and force every later handshake onto the weaker no-OPK path.
- **Key material is validated as base64 of exactly the right length** (32 bytes for
  keys, 64 for signatures). The old check accepted any non-blank string of 16 to 4096
  characters, which is how the literal sentinel `"pending-client-upload"` came to live
  in a `NOT NULL` public-key column. Accounts now start with genuinely null keys and
  publish them after registration.

Running out of one-time prekeys is expected and does not block a handshake: X3DH simply
omits the `DH4` term. Clients replenish against `GET /api/keys/opks/count` well before
the pool empties.

## Key storage

Implemented in `frontend/src/lib/crypto/store.ts`, backed by IndexedDB.

A master key is derived from the account password with **PBKDF2-SHA256, 600,000
iterations** (OWASP's current floor) over a per-vault random 16-byte salt. The salt and
iteration count are stored in the clear; a sealed known plaintext acts as a verifier so
a wrong password fails immediately with a clear error rather than surfacing later as an
opaque decryption failure inside the ratchet.

Everything sensitive is sealed under that master key with AES-256-GCM and a random IV:

| Store | Sealed | In the clear |
|---|---|---|
| `identity` | private identity key | public key |
| `signedPreKeys` | private prekey | public key, signature, id, createdAt |
| `oneTimePreKeys` | private prekey | public key, id |
| `sessions` | full ratchet state | peer id |
| `peers` | — | peer identity key, trust flag, timestamps |

Ratchet state is sealed as well as the identity key, not instead of it: it holds the
root key and chain keys, which read the current conversation just as effectively.

Three properties worth calling out:

- **Sessions are keyed by `(peerId, peerIdentityKey)`**, not by peer alone. Keying by
  peer alone means a re-registered peer keeps a stale session that produces ciphertext
  nobody can read.
- **Rotated signed prekeys are retained** (pruned to the newest N), because a message
  sent against the previous prekey may still be in flight.
- **A changed peer identity key resets that peer's trust flag.** The earlier
  verification was of a different key and cannot carry over.

One implementation constraint, since it is easy to reintroduce: an IndexedDB transaction
commits as soon as the microtask queue drains without new requests, so awaiting a
WebCrypto promise inside one silently closes it. Every method seals or opens *before*
opening its transaction.

## Safety numbers

60 decimal digits, following Signal's numeric fingerprint construction: 5200 iterations
of SHA-512 over `version || identity_key || identifier`, truncated to six groups of five
digits per participant. Both halves are ordered by value, so both people see the same
string and can read it to each other.

The identifier binds the fingerprint to an account, so the same key under a different
username does not produce a matching safety number.

## Groups: Sender Keys

A pairwise ratchet per recipient would mean encrypting each group message once per
member. Sender Keys instead give every member their own hash chain per group: a message
is encrypted once and delivered to everyone.

```
chain step   mk  = HMAC-SHA256(ck, 0x01)
             ck' = HMAC-SHA256(ck, 0x02)
message keys     = HKDF-SHA256(ikm = mk, salt = 32 zero bytes,
                               info = "WalkerChatSenderKeyMessageKeys", len = 44)
                   -> (aes_key[32], iv[12])
wire format      = iteration[uint32 BE] || ciphertext || XEdDSA signature[64]
AEAD AD          = "<groupId>:<senderId>" || iteration
```

Three properties worth stating plainly:

- **Every message is signed.** Every member holds every other member's chain key, so
  without a per-sender signing key any member could forge messages in another member's
  name. The signing private key never leaves its owner.
- **Groups have no post-compromise security.** A leaked chain key stays useful until
  that member rotates. Forward secrecy is retained (the chain only moves forward), and
  rotation is what bounds the damage.
- **Removing a member requires rotation.** They keep the chain keys they were given, so
  removal alone does not stop them reading future messages. The API says so explicitly
  in its response rather than implying the job is done.

Distribution is the subtle part: a sender key is itself secret, so it travels to each
recipient *device* over the pairwise Double Ratchet session with that device. Groups
therefore depend on 1:1 sessions and inherit their authentication. A distribution
carries the chain's *current* key, so someone added later cannot read earlier messages.

## Multi-device

Key material belongs to a **device**, not an account. It previously lived in a single set
of columns on `users`, which meant signing in on a second browser overwrote the first
device's identity key and silently broke every session it had.

- Each installation generates a stable local device id on first unlock, plus its own
  identity key, signed prekey and one-time prekeys.
- `POST /api/keys/{user_id}/bundle` claims one prekey from **every** device the user has.
- A message is encrypted once per recipient device and stored as one row per device in
  `message_envelopes`. History is resolved per device: which ciphertext you get back
  depends on which installation is asking.
- The sender also encrypts to their **own** other devices, so a conversation is readable
  everywhere they are signed in. Their own device is excluded, because a sender cannot
  decrypt what they encrypted to a peer.
- Safety numbers fold in *all* of an account's device keys, sorted. Adding a device
  therefore changes the safety number, which is the intended behaviour: a new device is a
  new key that can read the conversation, and the other party should be told rather than
  quietly enrolled.

Because a sender cannot decrypt their own ciphertext, sent plaintext is kept in a local
sealed log (`outgoing`). Without it your own messages would be unreadable to you after a
reload -- not a bug that can be fixed with better key management, but an inherent
consequence of encrypting to the recipient's chain.

## What this does not protect

- **Metadata.** The server sees who talks to whom, when, message sizes, and — because
  reactions are sent as messages — a per-reaction event count.
- **Endpoint compromise.** Decrypted plaintext is indexed client-side for search and
  rendered to blob URLs for images. Anything with code execution in the page sees it.
- **Group metadata.** Membership, group size, and who sends how often are all visible.
- **A group member.** Sender Keys give every member the ability to read everything sent
  to the group, and no post-compromise security within it.
