/**
 * The account-protection sheet's connect (components/SsoEnrolSheet.tsx): a ticket from BeanPool's key vault, the
 * provider's sign-in with that ticket's nonce, then the deposit of the seed, sealed to that sign-in, at the vault
 * (utils/vault.ts). Never the member's community: no community is asked for a nonce or sent a token or a copy.
 *
 * The deposit seals the account's key and 12 words to whichever sign-in account is used, so linking one is a way to
 * take the account: the phone's lock is asked first (`phoneLock`), before the vault, the provider or the words. A check
 * that doesn't pass reads as a cancel (PR #1205 review 4112404429).
 *
 * The ticket is checked against the vault's pinned keys and this member's key before the provider's sheet opens
 * (vault.ts `vaultTicket`): a ticket that isn't the vault's, or names another key, opens no sheet.
 *
 * The sheet offers Cancel only while a cancel is honoured, which is until the deposit is sent:
 * - While the provider is going, a cancel means nothing is deposited when it is done. (The provider's own
 *   sheet has its own cancel.)
 * - `onSignedIn` runs the moment the provider is done. The sheet takes its Cancel down there.
 * - A cancel that landed while the sign-in was finishing, before the sheet caught up, is still honoured
 *   after `onSignedIn`: nothing has been deposited, so nothing is.
 *
 * Past that the deposit goes ahead, and its outcome is reported even if the sheet was closed meanwhile.
 * Once sent it may be at the vault, and "cancelled" over a deposit the vault kept would be untrue the other
 * way round.
 *
 * A vault that is paused (locked, design §2.3) links nothing and says so; the sign-in is offered again at the next app
 * open (vault.ts `rememberConnectWanted`, the move card). Nothing is shown as linked that isn't.
 *
 * A build without a vault (vault.ts `signInCopiesAt`) connects exactly as the app did before the vault: the member's
 * community's nonce (sso-signin.ts `startSsoSignIn`), the provider, and the deposit at that community (`url`).
 *
 * ## The community's rule (vault rethink VR2, design §5.3)
 *
 * In a build with the vault, the community the phone is on (`url`) says where members' copies go (utils/copies-rule.ts),
 * asked at this moment: `server` connects at the community as a build without a vault does, so the vault is never
 * contacted; `none` links nothing and opens no sheet, in the community's words; `vault` goes to the vault. Not answered
 * and never heard: nothing is linked, as the phone can't tell the community wants a copy made. With no community at all
 * (`url` null), the vault, as before the rule. A build without a vault asks nothing new before the community's nonce:
 * every copy goes to the community, whose server refuses one it keeps none of (409 `no_copies_here`). That refusal is
 * the rule `none`, said in its words as a build with the vault says it, and only then is the rule asked, once, so the
 * screen finds the community's fresh answer when it reads where a copy goes again.
 *
 * The screen that opened the sheet told the member where the copy goes (`shownAt`), from its own, earlier read of the
 * rule. A copy goes only there: when the rule asked now sends it elsewhere (the owners changed it since, or that read got
 * no answer), nothing is linked, no ticket is asked for and no sheet opens, so the member reads where it goes first.
 */

import { signInWithProvider, startSsoSignIn, SsoSignInError } from './sso-signin';
import type { SsoProvider, SsoSignIn } from './sso-signin';
import { enrolSsoKeeper, type KeeperEnrolmentResult } from './keeper-enrolment';
import type { BeanPoolIdentity } from './identity';
import { rememberConnectWanted, signInCopiesAt, vaultTicket, VaultError, VAULT_MESSAGES, type VaultFailure } from './vault';
import type { SignInCopies } from './vault-config';
import type { CopyCommunity } from '@beanpool/core';
import { copiesRuleNow } from './copies-rule';

/**
 * What a member reads when the community keeps no copies, can't be asked where it keeps them, or now keeps them somewhere
 * other than the screen said. Plain English (this file is beside the 12 words' key path); the screens translate them
 * (components/welcome/welcome-lines.ts).
 */
export const CONNECT_RULE_MESSAGES = {
    none: "Your community keeps no copies of members' accounts, so no sign-in was linked. Your 12 words are your way back there.",
    unknown: "Your community couldn't be asked where it keeps copies, so no sign-in was linked. Try again when you're connected.",
    changed: 'Your community changed where it keeps copies, so no sign-in was linked. Close this to see where a copy goes now, then link it again.',
} as const;

/** The code a community's refusal carries where it keeps no copies (apps/server config/recovery-copies.ts NO_COPIES_HERE). */
export const NO_COPIES_HERE = 'no_copies_here';

/**
 * Decode the `sub` claim from a JWT id_token without signature verification. The copy is sealed to it, and the vault
 * reads the same claim once it has verified the token; a restore reads it again from a fresh token.
 */
export function extractSub(idToken: string): string {
    const parts = idToken?.split('.');
    if (!parts || parts.length < 2 || !parts[1]) {
        throw new Error('Could not determine user identifier for this sign-in.');
    }
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const payload = JSON.parse(globalThis.atob(pad)) as Record<string, unknown>;
        if (typeof payload?.sub === 'string' && payload.sub) {
            return payload.sub;
        }
    } catch {}
    throw new Error('ID token missing subject claim (sub).');
}

/** Nothing linked and nothing to offer again: the community's rule said no, or couldn't be asked. */
function nothingLinked(error: string): KeeperEnrolmentResult {
    return { enrolled: [], generation: null, skipped: [], available: 0, error };
}

/** Nothing linked, in the member's words: the vault's refusal, or ours. A paused vault is offered again later. */
async function notLinked(identity: BeanPoolIdentity, provider: SsoProvider, error: string, failure?: VaultFailure): Promise<KeeperEnrolmentResult> {
    if (failure === 'locked') {
        await rememberConnectWanted(identity.publicKey, provider);
        error = VAULT_MESSAGES.pausedConnect;
    }
    return { enrolled: [], generation: null, skipped: [], available: 0, error, ...(failure ? { failure } : {}) };
}

export async function connectAndDeposit(options: {
    provider: SsoProvider;
    /**
     * The community the phone is set to: where the copy goes in a build without a vault, and nowhere in a build with
     * one (the vault's address is the build's, never a community's).
     */
    url?: string | null;
    identity: BeanPoolIdentity;
    /**
     * `community`: to the community the phone is set to, as a build without a vault does, whatever this build is (an
     * account a claim made: nothing of ours in its path, components/SsoEnrolSheet.tsx).
     */
    copyAt?: 'community';
    /**
     * Where the screen that opened the sheet told the member the copy goes (its `copiesAt`, from the community's rule as
     * that screen read it). A copy is made only there: when the rule asked now sends it elsewhere, nothing is linked
     * (`CONNECT_RULE_MESSAGES.changed`). Absent: wherever the rule says now.
     */
    shownAt?: SignInCopies;
    /**
     * The phone's lock, asked before anything starts. The sheet hands it Settings' check (LocalAuth.authenticateUser);
     * null only for a key the join wizard has just made, the member's own new account.
     */
    phoneLock: (() => Promise<boolean>) | null;
    /** The provider is done and the deposit is next: Cancel no longer applies. */
    onSignedIn: () => void | Promise<void>;
    /** The sheet closed: a sign-in still going deposits nothing once it is done. */
    signal: AbortSignal;
    /**
     * The member's communities, sealed inside the copy when their tick is on (utils/copy-communities.ts, vault rethink
     * VR5). Null or absent: no list, the copy as before lists.
     */
    communities?: readonly CopyCommunity[] | null;
}): Promise<KeeperEnrolmentResult> {
    const { provider, identity, signal } = options;
    if (options.phoneLock && !(await options.phoneLock())) {
        throw new SsoSignInError('cancelled', "The phone's lock was not passed, so no sign-in was linked.");
    }
    // Closed while the check was up: nothing starts.
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    // A build without a vault, and an account a claim made: the copy goes to the community, exactly as before the rule,
    // with exactly the requests it always made. The community's own server holds its rule there: under `none` its nonce
    // answers 409 `no_copies_here`, nothing is kept, and the member reads the rule's sentence (`connectAtCommunity`). A
    // claim's community was claimed a moment ago, so its rule is the default, and nothing of ours is in its path (Marty,
    // 24 Oct).
    if (signInCopiesAt() === 'community' || options.copyAt === 'community') return connectAtCommunity({ ...options, url: options.url ?? null });
    // A build with the vault: the community's rule, asked now (the header's "The community's rule").
    const rule = options.url ? await copiesRuleNow(options.url) : undefined;
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    if (rule === null) return nothingLinked(CONNECT_RULE_MESSAGES.unknown);
    const at = signInCopiesAt(rule);
    if (at === 'none') return nothingLinked(CONNECT_RULE_MESSAGES.none);
    // The member was told it goes elsewhere: never a copy of the key where they weren't told it would be.
    if (options.shownAt && options.shownAt !== at) return nothingLinked(CONNECT_RULE_MESSAGES.changed);
    if (at === 'community') return connectAtCommunity({ ...options, url: options.url ?? null });

    let grant: { ticket: string; nonce: string };
    try {
        grant = await vaultTicket(identity, 'deposit', provider);
    } catch (e) {
        if (e instanceof VaultError) return notLinked(identity, provider, e.message, e.reason);
        throw e;
    }
    // Closed while the ticket was on its way: no sheet opens.
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');

    const signin = await signInWithProvider(provider, grant.nonce);
    await options.onSignedIn();
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');

    let sub: string;
    try {
        sub = extractSub(signin.idToken);
    } catch {
        // Refused here rather than sealed to nothing: a copy sealed to a missing subject can never be opened.
        return notLinked(identity, provider, "That sign-in didn't say which account it was, so nothing was linked. Try again.");
    }
    const result = await enrolSsoKeeper({
        identity, provider, sub, idToken: signin.idToken, ticket: grant.ticket, communities: options.communities,
    });
    return result.error ? notLinked(identity, provider, result.error, result.failure) : result;
}

/**
 * A build without a vault: exactly the connect the app made before the vault, at the member's community. A nonce refused
 * because the community keeps no copies is its rule `none` ({@link keepsNoCopiesNow}).
 */
async function connectAtCommunity(options: {
    provider: SsoProvider;
    url: string | null;
    identity: BeanPoolIdentity;
    onSignedIn: () => void | Promise<void>;
    signal: AbortSignal;
    communities?: readonly CopyCommunity[] | null;
}): Promise<KeeperEnrolmentResult> {
    const { provider, url, identity, signal } = options;
    if (!url) return { enrolled: [], generation: null, skipped: [], available: 0, error: 'No node configured yet.' };
    let signin: SsoSignIn;
    try {
        signin = await startSsoSignIn(provider, url, identity);
    } catch (e) {
        if (e instanceof SsoSignInError && e.code === NO_COPIES_HERE) return keepsNoCopiesNow(url, signal);
        throw e;
    }
    await options.onSignedIn();
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');

    return enrolSsoKeeper({
        identity,
        provider: signin.provider,
        sub: extractSub(signin.idToken),
        idToken: signin.idToken,
        nonce: signin.nonce,
        communities: options.communities,
    });
}

/**
 * The community's nonce said it keeps no copies (409 `no_copies_here`), so no sheet opened: nothing linked, in the rule's
 * words, as when a build with the vault asks the rule first (never the node's answer as it came). This connect asked
 * nothing before the nonce, so the screen that opened the sheet went by an earlier read that said a copy is kept: the rule
 * is asked once now, and the community's fresh answer is kept for that screen's next read (utils/copies-rule.ts).
 */
async function keepsNoCopiesNow(url: string, signal: AbortSignal): Promise<KeeperEnrolmentResult> {
    await copiesRuleNow(url);
    if (signal.aborted) throw new SsoSignInError('cancelled', 'Sign-in was cancelled.');
    return nothingLinked(CONNECT_RULE_MESSAGES.none);
}
