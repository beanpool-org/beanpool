/**
 * Recovery-phrase splitting — the piece every keeper holds one of.
 *
 * The keyholder model (docs/ONBOARDING.md Part 0) replaces "write down twelve words and don't
 * lose them" with "several parties each hold a fragment, any three rebuild the phrase". This
 * module is the split itself: phrase in, N fragments out, any `RECOVERY_THRESHOLD` of them
 * back to the identical phrase. It is deliberately the whole of the cryptography and none of
 * the plumbing — who the keepers are, how each fragment is encrypted to them, and where the
 * rows live are all above this line.
 *
 * ## Why the phrase and not the seed
 *
 * The split operates on the twelve words rather than the 32-byte Ed25519 seed they derive.
 * The seed is smaller and would make marginally shorter shares, but the phrase is the form
 * every existing recovery path already accepts: rebuilding it hands the user something the
 * current "recover from phrase" flow takes unchanged, and something a human can read back
 * and compare against a card in a drawer. A restored seed would need its own entry point and
 * could not be checked by eye.
 *
 * ## The failure this module exists to prevent
 *
 * Raw Shamir has a property that is easy to miss and expensive to discover: combining *too
 * few* shares does not fail. It returns a different, perfectly well-formed secret. Feed two
 * shares to a three-of-N split and you get twelve plausible-looking words that are not the
 * user's phrase — and since any twelve valid words derive *some* keypair, the recovering
 * device would happily land in a stranger's empty account and report success. The user is
 * then looking at a working app with none of their balance, standing or history, at the exact
 * moment they are already frightened about having lost access.
 *
 * So the secret is wrapped in an envelope carrying a checksum of the phrase, and
 * {@link combineRecoveryPhrase} verifies it before returning anything. Insufficient or
 * mismatched shares now raise {@link RecoveryCombineError} instead of silently succeeding.
 * Four bytes puts a false accept at roughly one in four billion, against a failure mode whose
 * cost is a user concluding their community and balance are gone.
 *
 * This is an integrity check, not authentication: it catches wrong or missing shares, and is
 * not intended to resist an attacker who can rewrite shares at will. Such an attacker holds
 * the shares, and holding `RECOVERY_THRESHOLD` of them is the whole secret anyway.
 *
 * ## Hermes
 *
 * `shamir-secret-sharing` draws randomness from `crypto.getRandomValues`, which React Native
 * does not provide natively — the app installs a polyfill over `expo-crypto` as an import
 * side effect (`apps/native/utils/crypto.ts`). That makes the split's correctness depend on
 * module load order, and the symptom of getting it wrong is an opaque throw from inside a
 * dependency. {@link assertRecoveryCsprngAvailable} turns that into a stated error, and is
 * called on the way into every split.
 *
 * Being pure JavaScript is the point: it runs identically under Hermes and in a browser, and
 * adds no native module, so no rebuild is needed to ship it.
 */

import { Buffer } from 'buffer';
import CryptoJS from 'crypto-js';
import { combine, split } from 'shamir-secret-sharing';

/**
 * Shares required to rebuild the phrase (D2 — matches the existing guardian quorum).
 *
 * Three is also why the weaker keepers are safe to have: the sign-in keeper's fragment may be
 * derivable by the node, and the phone-backup fragment is stored unencrypted, but either one
 * alone is nothing. Dropping to two would make each of those a real exposure on its own.
 */
export const RECOVERY_THRESHOLD = 3;

/** Envelope layout version, so a future format change is detectable rather than silent. */
export const RECOVERY_ENVELOPE_VERSION = 1;

/** Bytes of `SHA-256(phrase)` carried in the envelope. */
export const RECOVERY_CHECKSUM_LENGTH = 4;

/** Offset at which the phrase itself starts: one version byte, then the checksum. */
const PHRASE_OFFSET = 1 + RECOVERY_CHECKSUM_LENGTH;

/**
 * Raised when shares do not rebuild a phrase that matches its checksum.
 *
 * Overwhelmingly this means too few shares, or one belonging to a different split — see the
 * module note on why that has to be an error rather than a wrong answer.
 */
export class RecoveryCombineError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RecoveryCombineError';
    }
}

/**
 * Collapses a phrase to the form that gets split and returned.
 *
 * Whitespace is normalised so that a phrase pasted with a trailing newline or a double space
 * produces the same envelope as the same words typed cleanly. Both were always the same
 * secret; without this they would checksum differently and compare unequal downstream.
 *
 * Case is deliberately left alone, even though the key derivation lowercases before hashing
 * (`apps/native/utils/crypto.ts` `mnemonicToKeypair`). Normalising it here too would put the
 * same rule in two places with nothing keeping them in step, and it buys nothing: a phrase
 * that differs only in case already derives the identical key, so the split has no reason to
 * care. Whitespace is different — it would change the checksum without changing the secret.
 */
export function normaliseRecoveryPhrase(phrase: string): string {
    return phrase.trim().replace(/\s+/g, ' ');
}

/** First {@link RECOVERY_CHECKSUM_LENGTH} bytes of `SHA-256(phrase)`. */
function phraseChecksum(normalised: string): Uint8Array {
    const hex = CryptoJS.SHA256(normalised).toString();
    const out = new Uint8Array(RECOVERY_CHECKSUM_LENGTH);
    for (let i = 0; i < RECOVERY_CHECKSUM_LENGTH; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

/**
 * Throws unless a CSPRNG is reachable, naming the fix.
 *
 * Called before every split rather than at import time: the polyfill is itself installed by a
 * module side effect, so checking at import would race whichever module loaded first.
 */
export function assertRecoveryCsprngAvailable(): void {
    const c: unknown = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
    const fn = (c as { getRandomValues?: unknown } | undefined)?.getRandomValues;
    if (typeof fn !== 'function') {
        throw new Error(
            'Recovery split needs crypto.getRandomValues, which is missing. On React Native ' +
            'this means the expo-crypto polyfill in apps/native/utils/crypto.ts has not been ' +
            'imported yet — import it before splitting.',
        );
    }
}

/**
 * Splits a recovery phrase into `shareCount` fragments, any {@link RECOVERY_THRESHOLD} of
 * which rebuild it.
 *
 * Fragments come back as raw bytes and are interchangeable — nothing marks one as the hub's
 * or the inviter's, because which keeper holds which is a property of where it gets stored,
 * not of the fragment. Encrypting each to its keeper happens above this module.
 *
 * @param phrase       the twelve words, in any spacing (see {@link normaliseRecoveryPhrase})
 * @param shareCount   how many keepers there are; must be at least {@link RECOVERY_THRESHOLD}
 */
export async function splitRecoveryPhrase(phrase: string, shareCount: number): Promise<Uint8Array[]> {
    const normalised = normaliseRecoveryPhrase(phrase);
    if (normalised.length === 0) {
        throw new Error('Cannot split an empty recovery phrase.');
    }
    if (!Number.isInteger(shareCount) || shareCount < RECOVERY_THRESHOLD) {
        // Fewer keepers than the threshold splits a phrase into pieces that can never be
        // reassembled — a silent, total loss that only surfaces at recovery, which is the
        // worst possible moment to find out.
        throw new Error(
            `Recovery split needs at least ${RECOVERY_THRESHOLD} keepers, got ${shareCount}. ` +
            'Fewer shares than the threshold could never be recombined.',
        );
    }
    if (shareCount > 255) {
        throw new Error(`Recovery split supports at most 255 keepers, got ${shareCount}.`);
    }

    assertRecoveryCsprngAvailable();

    const phraseBytes = new Uint8Array(Buffer.from(normalised, 'utf8'));
    const envelope = new Uint8Array(PHRASE_OFFSET + phraseBytes.length);
    envelope[0] = RECOVERY_ENVELOPE_VERSION;
    envelope.set(phraseChecksum(normalised), 1);
    envelope.set(phraseBytes, PHRASE_OFFSET);

    return split(envelope, shareCount, RECOVERY_THRESHOLD);
}

/**
 * Rebuilds a recovery phrase from fragments.
 *
 * Order does not matter — each fragment carries its own coordinate — but every fragment must
 * come from the same split. Mixing generations (a re-split after a keeper changed) fails the
 * checksum, which is the intended behaviour rather than a limitation: the two generations
 * protect different phrases only by accident of both being valid.
 *
 * @throws {RecoveryCombineError} if the fragments do not rebuild a phrase matching its checksum
 */
export async function combineRecoveryPhrase(shares: Uint8Array[]): Promise<string> {
    if (!Array.isArray(shares) || shares.length < RECOVERY_THRESHOLD) {
        throw new RecoveryCombineError(
            `Rebuilding a recovery phrase needs ${RECOVERY_THRESHOLD} fragments, got ${shares?.length ?? 0}.`,
        );
    }

    let envelope: Uint8Array;
    try {
        envelope = await combine(shares);
    } catch (e) {
        // The library rejects duplicates and mismatched lengths itself; restate those in the
        // vocabulary of this module so a caller isn't reading about Uint8Arrays and samples.
        throw new RecoveryCombineError(
            `Recovery fragments could not be combined: ${e instanceof Error ? e.message : String(e)}`,
        );
    }

    if (envelope.length <= PHRASE_OFFSET) {
        throw new RecoveryCombineError('Recovery fragments rebuilt an empty phrase.');
    }
    if (envelope[0] !== RECOVERY_ENVELOPE_VERSION) {
        // Either a genuinely newer format, or — far more likely — the wrong shares, since a
        // wrong combine randomises this byte along with everything else.
        throw new RecoveryCombineError(
            `Unrecognised recovery envelope version ${envelope[0]}. The fragments are from a ` +
            'different split, or there are too few of them.',
        );
    }

    const phrase = Buffer.from(envelope.slice(PHRASE_OFFSET)).toString('utf8');
    const expected = envelope.slice(1, PHRASE_OFFSET);
    const actual = phraseChecksum(phrase);
    for (let i = 0; i < RECOVERY_CHECKSUM_LENGTH; i++) {
        if (expected[i] !== actual[i]) {
            throw new RecoveryCombineError(
                'Recovery fragments did not rebuild a valid phrase. This usually means too few ' +
                'fragments, or one belonging to a different split.',
            );
        }
    }

    return phrase;
}
