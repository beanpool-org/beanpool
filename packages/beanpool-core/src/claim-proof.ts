/**
 * Claim v2: proving a node's one-time claim code without sending it (`/api/local/claim`).
 *
 * The node keeps K = scrypt(sha256(code), salt) and answers the salt publicly. The claimer derives the same K from the
 * code it read on the server and sends HMAC-SHA256(K, claimProofText(host, codeId, publicKey)), signed into the claim
 * statement (request-signing.ts claimText). The code and K never cross the wire; the proof is good only for that host,
 * that code and that key. The scrypt is the claimer's to pay, once: the node only ever runs an HMAC per claim.
 *
 * Byte for byte what the server does with Node's crypto (apps/server/src/claim-code.ts): the code trimmed and lower-
 * cased, its SHA-256 as lower-case hex, that hex string's UTF-8 as the password and the salt's hex string's UTF-8 as the
 * salt. @noble/hashes only, so a phone can run it.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { scrypt, scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { claimProofText } from './request-signing.js';

/**
 * The scrypt the server uses for K: Node's defaults, a 32-byte key. Hard-coded on both sides and never sent: a client
 * must not take N, r or p from a server's answer (a phishing server writes that answer, and a lower N would make a
 * proof it captured cheap to brute-force offline).
 */
export const CLAIM_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, dkLen: 32 });

function password(code: string): Uint8Array {
    return utf8ToBytes(bytesToHex(sha256(utf8ToBytes(String(code).trim().toLowerCase()))));
}

/** K from the code and the node's salt (hex, as GET /api/local/claim answers it), always with CLAIM_SCRYPT, never a server's. */
export function claimKeyFromCode(code: string, salt: string): Uint8Array {
    return scrypt(password(code), utf8ToBytes(salt), CLAIM_SCRYPT);
}

/** The same, yielding to the event loop now and then (a phone's UI thread). */
export function claimKeyFromCodeAsync(code: string, salt: string): Promise<Uint8Array> {
    return scryptAsync(password(code), utf8ToBytes(salt), CLAIM_SCRYPT);
}

/** The proof a claim carries: HMAC-SHA256(K, claimProofText(host, codeId, publicKey)), lower-case hex. */
export function claimProof(key: Uint8Array, host: string, codeId: string, publicKey: string): string {
    return bytesToHex(hmac(sha256, key, utf8ToBytes(claimProofText(host, codeId, publicKey))));
}
