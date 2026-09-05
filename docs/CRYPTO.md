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

## What this does not protect

- **Metadata.** The server sees who talks to whom, when, message sizes, and — because
  reactions are sent as messages — a per-reaction event count.
- **Endpoint compromise.** Decrypted plaintext is indexed client-side for search and
  rendered to blob URLs for images. Anything with code execution in the page sees it.
- **Group and multi-device** are not covered by this document yet.
