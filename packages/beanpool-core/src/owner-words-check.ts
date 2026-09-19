/**
 * "Check your 12 words" — owners only (sealed-keys.md §7, slice 7).
 *
 * For an owner, the 12 words are the only thing that turns "phone lost" into "still fine" when the main server
 * is dead: they rebuild the member key, and the community's take-over lock and every sealed backup are locked to
 * that key. So an owner is asked, gently and never as a gate, to type them once and prove they are the right ones.
 *
 * What the check proves, all on the device:
 *   1. The words derive a keypair (the same double SHA-256 both clients use, native `utils/crypto.ts` and PWA
 *      `lib/mnemonic.ts`) whose public key is this account's.
 *   2. If the device's stored private key is passed, it is the same seed. It may be the native raw 32-byte seed
 *      or the PWA's 48-byte PKCS8 — it only ever goes through `toEd25519Seed` (identity-key-format-divergence).
 *   3. The *derived* seed opens a throwaway envelope sealed to this account's public key — the same code path a
 *      take-over or a restore will use — so "these words" means "these words open the safe on this device".
 *
 * The words never leave this function in any form: nothing derived from them is returned, the seed buffers are
 * zeroed before it returns, and the only result is a yes or a no. What goes to the server afterwards is the fact
 * and the date, signed by the member key the app already holds (see {@link OWNER_WORDS_CHECK_PATH}).
 * A no gives no hint which word is wrong — a wrong word and a missing one are the same answer.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Seed } from './ed25519-key.js';
import { sealEnvelope, openEnvelope } from './sealed-envelope.js';

/** Signed POST records a check; signed GET reads the owner's own last check. Owner-only on the server. */
export const OWNER_WORDS_CHECK_PATH = '/api/node/owner/words-check';

/** An owner is asked again 12 months after their last check (§7 "When"). */
export const OWNER_WORDS_CHECK_RENEW_MS = 365 * 24 * 60 * 60 * 1000;

export type OwnerWordsCheckResult = { matches: true } | { matches: false; reason: 'count' | 'mismatch' };

/** Split what the member typed into words: any whitespace, any case, surrounding space ignored. */
export function splitTypedWords(input: string | string[]): string[] {
    const joined = Array.isArray(input) ? input.join(' ') : input;
    return joined.toLowerCase().split(/\s+/).filter(Boolean);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

function asBytes(key: string | Uint8Array): Uint8Array {
    return typeof key === 'string' ? hexToBytes(key.trim().toLowerCase()) : key;
}

/**
 * Are these the 12 words for this account?
 *
 * @param typed     what the member typed: one string or one entry per box.
 * @param account   the account's public key (hex), and optionally the device's stored private key in either
 *                  format (raw seed or PKCS8, hex or bytes). A stored key that does not parse is ignored: the
 *                  public key is what the lock is sealed to, so it is the one that decides.
 */
export async function checkOwnerWords(
    typed: string | string[],
    account: { publicKeyHex: string; privateKey?: string | Uint8Array | null },
): Promise<OwnerWordsCheckResult> {
    const words = splitTypedWords(typed);
    if (words.length !== 12) return { matches: false, reason: 'count' };

    const phraseBytes = utf8ToBytes(words.join(' '));
    const inner = sha256(phraseBytes);
    const seed = sha256(inner);
    phraseBytes.fill(0);
    inner.fill(0);
    let storedSeed: Uint8Array | null = null;
    try {
        const expected = asBytes(account.publicKeyHex);
        if (!constantTimeEqual(ed25519.getPublicKey(seed), expected)) {
            return { matches: false, reason: 'mismatch' };
        }
        if (account.privateKey) {
            try {
                storedSeed = toEd25519Seed(asBytes(account.privateKey));
            } catch {
                storedSeed = null;
            }
            if (storedSeed && !constantTimeEqual(storedSeed, seed)) {
                return { matches: false, reason: 'mismatch' };
            }
        }
        // Seal a throwaway payload to the account's public key and open it with the derived seed. The payload
        // and the signing key are random and thrown away; nothing here is kept or sent.
        const probe = randomBytes(32);
        const signingKey = randomBytes(32);
        try {
            const sealed = await sealEnvelope(probe, {
                kind: 'backup',
                communityId: 'owner-words-check',
                nodePeerId: 'owner-words-check',
                recipients: { owners: [{ pubkey: bytesToHex(expected), callsign: 'owner' }] },
                signingKey,
            });
            const opened = await openEnvelope(sealed, { type: 'owner', privateKey: seed }, { kind: 'backup' });
            if (!constantTimeEqual(opened.payload, probe)) return { matches: false, reason: 'mismatch' };
        } catch {
            return { matches: false, reason: 'mismatch' };
        } finally {
            signingKey.fill(0);
        }
        return { matches: true };
    } catch {
        return { matches: false, reason: 'mismatch' };
    } finally {
        seed.fill(0);
        storedSeed?.fill(0);
    }
}

/**
 * Is a gentle prompt due? Never checked, or checked 12 months ago or more. The Settings card is always there for
 * an owner; this decides only whether the one-off prompt shows.
 */
export function isOwnerWordsCheckDue(lastCheckedAt: number | null | undefined, now: number = Date.now()): boolean {
    if (!lastCheckedAt || !Number.isFinite(lastCheckedAt)) return true;
    return now - lastCheckedAt >= OWNER_WORDS_CHECK_RENEW_MS;
}

/**
 * Which "round" of prompting this is. "Later" stores this value, and the prompt stays away until it changes:
 * a never-checked owner who says Later is not asked again until they have checked once and a year has passed.
 * That is the whole cadence: on becoming an owner, and 12 months after the last check (§7).
 */
export function ownerWordsPromptRound(lastCheckedAt: number | null | undefined): string {
    return lastCheckedAt ? `renew:${lastCheckedAt}` : 'never';
}
