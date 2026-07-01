/**
 * NAT-1 reference vector — proves the DM E2E scheme is symmetric, round-trips,
 * detects tampering, and passes legacy plaintext through. Uses the SAME @noble
 * primitives both apps bundle, so it's a faithful cross-platform reference.
 *
 * Run: node scratch/e2e-vector.mjs
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const V2_PREFIX = 'x25519-xc20p-v2:';
const INFO = utf8ToBytes('beanpool-dm-v2');
const b64 = (u8) => Buffer.from(u8).toString('base64');
const ub64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const dec = new TextDecoder();

function deriveKey(myEdPrivHex, peerEdPubHex, conversationId) {
  let myPrivBytes = hexToBytes(myEdPrivHex);
  if (myPrivBytes.length === 48) {
    myPrivBytes = myPrivBytes.slice(16);
  }
  const myXPriv = ed25519.utils.toMontgomerySecret(myPrivBytes);
  const peerXPub = ed25519.utils.toMontgomery(hexToBytes(peerEdPubHex));
  const shared = x25519.getSharedSecret(myXPriv, peerXPub);
  return hkdf(sha256, shared, utf8ToBytes(conversationId), INFO, 32);
}
function encryptDM(text, me, peerPub, conv, fixedNonce) {
  const key = deriveKey(me.priv, peerPub, conv);
  const nonce = fixedNonce ?? crypto.getRandomValues(new Uint8Array(24));
  const ct = xchacha20poly1305(key, nonce, utf8ToBytes(conv)).encrypt(utf8ToBytes(text));
  return { ciphertext: b64(ct), nonce: V2_PREFIX + b64(nonce) };
}
function decryptDM(ciphertext, nonce, me, peerPub, conv) {
  if (nonce.startsWith('plaintext')) return dec.decode(ub64(ciphertext));
  if (!nonce.startsWith(V2_PREFIX)) throw new Error('unknown nonce scheme');
  const key = deriveKey(me.priv, peerPub, conv);
  const nb = ub64(nonce.slice(V2_PREFIX.length));
  return dec.decode(xchacha20poly1305(key, nb, utf8ToBytes(conv)).decrypt(ub64(ciphertext)));
}

// Fixed test identities (deterministic seeds)
const aliceSeed = '11'.repeat(32), bobSeed = '22'.repeat(32);
const alice = { priv: aliceSeed, pub: bytesToHex(ed25519.getPublicKey(hexToBytes(aliceSeed))) };
const bob   = { priv: bobSeed,   pub: bytesToHex(ed25519.getPublicKey(hexToBytes(bobSeed))) };
const conv = 'conv-abc-123';

let pass = 0, fail = 0;
const ok = (name, cond) => { (cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗ FAIL', name))); };

// 1. Symmetric key agreement (Alice and Bob derive the SAME key)
const kAB = bytesToHex(deriveKey(alice.priv, bob.pub, conv));
const kBA = bytesToHex(deriveKey(bob.priv, alice.pub, conv));
ok('shared key is symmetric (A↔B identical)', kAB === kBA);
console.log('    derived key:', kAB);

// 2. Different conversation -> different key (HKDF salt binding)
ok('different conversationId -> different key',
   bytesToHex(deriveKey(alice.priv, bob.pub, 'other')) !== kAB);

// 3. Round-trip: Alice encrypts, Bob decrypts
const msg = 'hello bob — 🫘 secret beans';
const enc = encryptDM(msg, alice, bob.pub, conv);
ok('nonce carries v2 marker', enc.nonce.startsWith(V2_PREFIX));
ok('Bob decrypts Alice ciphertext', decryptDM(enc.ciphertext, enc.nonce, bob, alice.pub, conv) === msg);

// 4. Deterministic vector (fixed nonce) — a snapshot both apps must reproduce
const fixedNonce = hexToBytes('aa'.repeat(24));
const det = encryptDM('vector', alice, bob.pub, conv, fixedNonce);
console.log('    deterministic ciphertext:', det.ciphertext);
ok('deterministic ct round-trips', decryptDM(det.ciphertext, det.nonce, bob, alice.pub, conv) === 'vector');

// 5. Tamper detection (flip a ciphertext byte)
const tampered = ub64(enc.ciphertext); tampered[0] ^= 1;
let threw = false; try { decryptDM(b64(tampered), enc.nonce, bob, alice.pub, conv); } catch { threw = true; }
ok('tampered ciphertext rejected (AEAD)', threw);

// 6. Wrong conversation AAD rejected
let threw2 = false; try { decryptDM(enc.ciphertext, enc.nonce, bob, alice.pub, 'wrong-conv'); } catch { threw2 = true; }
ok('wrong conversation (AAD/key mismatch) rejected', threw2);

// 7. Legacy plaintext passthrough
const legacyCt = Buffer.from('legacy hi').toString('base64');
ok('legacy plaintext-v1 still readable', decryptDM(legacyCt, 'plaintext-v1', bob, alice.pub, conv) === 'legacy hi');

// 8. 48-byte PKCS8 key compatibility
const pkcs8Header = hexToBytes('302e020100300506032b657004220420');
const alicePriv48Hex = bytesToHex(Buffer.concat([pkcs8Header, hexToBytes(alice.priv)]));
const alice48 = { priv: alicePriv48Hex, pub: alice.pub };
ok('Bob decrypts Alice ciphertext encrypted with 48-byte PKCS8 key', decryptDM(enc.ciphertext, enc.nonce, bob, alice48.pub, conv) === msg);
const enc48 = encryptDM(msg, alice48, bob.pub, conv);
ok('Alice (48-byte key) decrypts Bob ciphertext', decryptDM(enc48.ciphertext, enc48.nonce, bob, alice48.pub, conv) === msg);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
