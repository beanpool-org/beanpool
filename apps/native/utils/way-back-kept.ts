/**
 * What the phone already knows of an account's way back when its join reaches the way-back step (slice S4 of
 * scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §3.1 E): the step is skipped, and its button reads "Let's go",
 * only on something kept here before, never on a guess.
 *
 * - The key vault keeps a copy of the key (vault.ts `vaultCopyKnown`: a deposit, a restore or a status read said so): a
 *   sign-in brings the account back in every community.
 * - The member said the 12 words are written down (ways-back.ts `wordsWrittenDown`: "Where your account can be brought back
 *   from", or "I still have my 12 words" on the card or after the kit), and has not taken it back.
 *
 * A sign-in added (the "one way back" record's `done: 'linked'`) does not count by itself: LinkSignInSheet writes it for every
 * sign-in added, one with no copy too (the community keeps none, or the copy failed), and a community's `ordinary` says only
 * that a sign-in was added (review of #3330). A copy at the key vault is counted above; one a community keeps shows the step,
 * which is the safe way.
 *
 * A key this join made has none of these unless it was said during this join (Yes after the kit, then a restart). Reads only
 * the phone's storage: no request, nothing waits on a network. A read that fails is "not known", which shows the step.
 */
import { vaultCopyKnown } from './vault';
import { wordsWrittenDown } from './ways-back';

export async function wayBackKeptBefore(publicKey: string): Promise<boolean> {
    const [vault, paper] = await Promise.all([
        vaultCopyKnown(publicKey).catch(() => false),
        wordsWrittenDown(publicKey).catch(() => false),
    ]);
    return vault || paper;
}
