/**
 * Does recovery actually work on THIS device?
 *
 * ## Why this is production code and not a diagnostic
 *
 * Everything under `recovery-split.ts` and `keeper-crypto.ts` has only ever executed under Node.
 * The phone runs Hermes, a different JavaScript engine, and the way crypto code fails on an
 * unfamiliar engine is not always a crash — it can be a wrong answer. Fragments that recombine
 * to the wrong phrase, or randomness that is not random.
 *
 * The tempting response is a developer-only probe screen. There is already one of those in this
 * repo (`app/apple-probe.tsx`, issue #231) which has never been run, because a diagnostic nobody
 * is forced to open is a diagnostic nobody opens. So this is not that. This runs on the way into
 * enrolment, in front of every member, and its result decides whether we are allowed to tell them
 * their keepers are set.
 *
 * That matters because of what the failure looks like otherwise. A member enrols four keepers, is
 * told they are safe, and finds out the split never worked on the day they lose their phone —
 * which is exactly the "false-success limbo" the onboarding principles rule out. Better to say
 * "recovery isn't available on this device yet" on a day when nothing is wrong.
 *
 * ## What it actually proves
 *
 * A full round trip on a throwaway phrase: split into four, seal one fragment to a throwaway
 * keypair, open it again, and rebuild the phrase from three. If the bytes come back identical,
 * every layer worked on this engine.
 *
 * **The phrase here is a constant and is deliberately NOT the member's.** The check needs a
 * phrase, and the member's real one is the single most sensitive value in the app. There is no
 * reason to move it through extra code paths to learn something a fixed string proves equally
 * well.
 *
 * ## The three dependencies this is really watching
 *
 * `@noble/curves`, `@noble/ciphers` and `@noble/hashes` are already proven under Hermes — the
 * app encrypts direct messages with them in production. The ones with no such history are
 * `buffer`, `crypto-js` and `shamir-secret-sharing`, which the native app has never bundled at
 * all. Those three are what this exercises that nothing else does.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
    RECOVERY_THRESHOLD,
    combineRecoveryPhrase,
    splitRecoveryPhrase,
} from './recovery-split.js';
import { openShareAsMember, sealShareToMember } from './keeper-crypto.js';

/**
 * The stage that failed, for a caller deciding what to say and what to log.
 *
 * Named rather than a boolean because the stages mean very different things: `csprng` is a
 * missing polyfill and a wiring bug, `split`/`combine` implicate `shamir-secret-sharing` under
 * this engine, and `seal`/`open` implicate the cipher — which would be a surprise, since direct
 * messages already use it here.
 */
export type RecoverySelfCheckStage = 'csprng' | 'split' | 'seal' | 'open' | 'combine';

export interface RecoverySelfCheckResult {
    /** Whether a phrase survived the whole round trip on this device. */
    ok: boolean;
    /** Absent when `ok`. */
    failedAt?: RecoverySelfCheckStage;
    /**
     * For logs and bug reports, never for a member.
     *
     * Same split the trust model already uses: this string talks about polynomials and byte
     * comparisons, cannot be translated and cannot carry an action button. The client owns the
     * sentence a member sees, matched on {@link failedAt}.
     */
    detail?: string;
}

/**
 * A phrase that is valid BIP-39 English and belongs to nobody.
 *
 * It derives a real keypair, as any twelve valid words do. Nothing is ever stored against it and
 * no balance can exist on it, but it is worth stating that this is a throwaway rather than
 * something that only looks like one.
 */
const THROWAWAY_PHRASE =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * One more keeper than the threshold, so the check proves "ANY three of them" rather than "all
 * of them" — the promise the model actually makes.
 *
 * Derived from {@link RECOVERY_THRESHOLD} rather than written as 4 (CR). The first draft
 * hard-coded three fragments into the rebuild and asserted afterwards that the threshold was
 * still three. Review pointed out that assertion could never fire: raise the threshold to four
 * and `combineRecoveryPhrase` rejects three fragments first, returning a generic combine failure
 * and never reaching the specific message. Adapting removes the failure instead of reporting it.
 */
const CHECK_KEEPERS = RECOVERY_THRESHOLD + 1;

/**
 * The fragments a rebuild should use: `threshold - 1` taken from the front, plus the one that
 * went through the encryption round trip.
 *
 * Extracted so it can be tested at thresholds other than the current one. Inline, the property
 * "adapts to RECOVERY_THRESHOLD" was untestable — with a threshold of 3, taking the first two
 * plus the reopened fragment is indistinguishable from hard-coding `[0], [1], opened`, and a
 * test asserting the length reads as meaningful while proving nothing. Mutation-checking caught
 * that: re-introducing the hard-coded version failed no test at all.
 *
 * Generic because the property is about selection, not about bytes.
 */
export function rebuildSet<T>(fragments: readonly T[], reopened: T, threshold: number): T[] {
    return [...fragments.slice(0, threshold - 1), reopened];
}

/**
 * Run the whole recovery path once and report whether it survived.
 *
 * Never throws: a caller reaching for this is asking "is this safe to offer?", and an exception
 * escaping would make the check itself the thing that breaks enrolment.
 */
export async function checkRecoveryWorksHere(): Promise<RecoverySelfCheckResult> {
    let fragments: Uint8Array[];
    try {
        // Covers the csprng assertion too — splitRecoveryPhrase calls it on the way in — but the
        // message is distinguishable, so the two are reported apart.
        fragments = await splitRecoveryPhrase(THROWAWAY_PHRASE, CHECK_KEEPERS);
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            failedAt: detail.includes('getRandomValues') ? 'csprng' : 'split',
            detail,
        };
    }

    if (fragments.length !== CHECK_KEEPERS) {
        return {
            ok: false,
            failedAt: 'split',
            detail: `Asked for ${CHECK_KEEPERS} fragments and got ${fragments.length}.`,
        };
    }

    // The LAST fragment, so it never overlaps the first RECOVERY_THRESHOLD - 1 used in the rebuild.
    const sealedIndex = fragments.length - 1;

    // Inside the try as well (CR): the stated contract is that this never throws, and generating
    // the throwaway keypair reads `crypto.getRandomValues` like everything else here. The
    // missing-polyfill case is already caught above — `splitRecoveryPhrase` asserts it on the way
    // in — but "the most likely trigger is covered elsewhere" is not the same as "cannot throw",
    // and this function breaking enrolment would be the exact opposite of its job.
    let sealed;
    try {
        const keeperSeed = randomBytes(32);
        const keeperPublicKey = ed25519.getPublicKey(keeperSeed);
        sealed = { share: sealShareToMember(fragments[sealedIndex], keeperPublicKey), keeperSeed };
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return { ok: false, failedAt: detail.includes('getRandomValues') ? 'csprng' : 'seal', detail };
    }

    let opened: Uint8Array;
    try {
        opened = openShareAsMember(sealed.share, sealed.keeperSeed);
    } catch (e) {
        return { ok: false, failedAt: 'open', detail: e instanceof Error ? e.message : String(e) };
    }

    // Compared by hand rather than through `Buffer.compare` (CR). Nothing here needs a Buffer, and
    // `buffer` is one of the three packages this whole function exists to be uncertain about — no
    // reason to route the check itself through a dependency it is meant to be testing.
    const original = fragments[sealedIndex];
    const identical = opened.length === original.length && opened.every((b, i) => b === original[i]);
    if (!identical) {
        // The quiet failure this whole function exists for: the cipher ran, the tag verified, and
        // the bytes are still wrong. Checked explicitly rather than trusted, because every layer
        // above here would carry on as though nothing had happened.
        return {
            ok: false,
            failedAt: 'open',
            detail: 'A fragment survived the tag check but came back with different bytes.',
        };
    }

    try {
        // The sealed-and-reopened fragment is deliberately one of the three, so the rebuild
        // depends on the encryption round trip rather than running alongside it. The others are
        // taken from the front, leaving one fragment unused — which is what makes this "any
        // three" rather than "all of them".
        const rebuilt = await combineRecoveryPhrase(
            rebuildSet(fragments, opened, RECOVERY_THRESHOLD),
        );
        if (rebuilt !== THROWAWAY_PHRASE) {
            return {
                ok: false,
                failedAt: 'combine',
                detail: 'Fragments rebuilt a phrase, and it was not the one they came from.',
            };
        }
    } catch (e) {
        return { ok: false, failedAt: 'combine', detail: e instanceof Error ? e.message : String(e) };
    }

    return { ok: true };
}
