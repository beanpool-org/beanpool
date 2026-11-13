import { word } from '@beanpool/core';
import { t } from './fresh-proof';

/**
 * What the owner reads when the node raises a health flag (apps/server state-engine.ts HealthFlag): a plain heading and
 * one sentence on what to do. A flag that reaches the owner says WHO (the members it names, by name), WHAT happened (the
 * heading and the node's own description) and the ONE sensible action (Marty, 4 Nov: "if im going to the trouble of
 * getting a warning and then logging into the backend I dont want my time to be wasted").
 *
 * Every type the server's HealthFlag lists has words here, including two no code raises today (isolated_branch,
 * invite_spam): if something starts raising them, the owner already reads them in words. A type this manager does not
 * know (a newer node, or an older one still raising the inactive-member flag the node no longer has) gets a general
 * heading, never the raw type.
 */

/** The flag as the node sends it (and as the manager's lists hold it). */
export interface FlagLike {
    id?: string;
    type?: string;
    severity?: string;
    description?: string;
    /** The public keys the node names. Shown as names from the roster, never as keys. */
    members?: unknown;
}

export const FLAG_WORDS = {
    // Headings.
    washTrading: word('Two members trading Beans back and forth'),
    sybilRing: word('A tight ring of mostly new accounts'),
    sybilFunnel: word('Invited accounts sending Beans back to the member who invited them'),
    isolatedBranch: word('A branch of invited members who only trade with each other'),
    inviteSpam: word('A member inviting far more people than usual'),
    aggregateSpike: word('Beans owed grew fast in one day'),
    cohortVelocity: word('New accounts went deep into credit within two weeks'),
    delinquency: word('Members who owe Beans have gone quiet'),
    watchdogRecovery: word('The server restarted itself after freezing'),
    watchdogDown: word("The server's watchdog has gone quiet"),
    unhandledRejections: word('Some background jobs on the server failed'),
    unknown: word('Something on this server needs a look'),

    // The one sensible action, in a sentence.
    doWashTrading: word('Look at their trades. If they are not real exchanges, freeze both accounts. Otherwise dismiss this.'),
    doSybilRing: word('If these accounts are really one person, freeze them. Otherwise dismiss this.'),
    doSybilFunnel: word('If the invited accounts are not real people, freeze them and the member who invited them. Otherwise dismiss this.'),
    doIsolatedBranch: word('Look at them under People & Safety, Members. Dismiss this when you have.'),
    doInviteSpam: word('Look at the member under People & Safety, Members. Dismiss this when you have.'),
    doAggregateSpike: word('Open People & Safety, Community health to see the totals. No member is named here, so there is nothing to freeze. Dismiss this when you have looked.'),
    doCohortVelocity: word('Open People & Safety, Community health to see how new members are doing. No member is named here, so there is nothing to freeze. Dismiss this when you have looked.'),
    doDelinquency: word('Open People & Safety, Community health to see the totals of members in debit. No member is named here, so there is nothing to freeze. Dismiss this when you have looked.'),
    doWatchdogRecovery: word('Open Appliance & Data, Diagnostics & Logs. If it keeps happening, send the log to whoever looks after this server. Dismiss this when you have.'),
    doWatchdogDown: word("Check that the watchdog is running on this server's computer. Until it is, a freeze will not restart the server by itself. Dismiss this when it is back."),
    doUnhandledRejections: word('The server kept serving. Open Appliance & Data, Diagnostics & Logs to read what failed. Dismiss this when you have.'),
    doUnknown: word('Read the note below. Dismiss this when you have.'),

    // The window.
    whatHappened: word('What happened'),
    whatWasReported: word('What was reported'),
    theNumbers: word('The numbers'),
    whoIsInvolved: word('Members involved ({count})'),
    noMembersNamed: word('This flag names no member.'),
    reportNamesNobody: word('The node did not say which member this is about.'),
    noDetail: word('The node gave no more detail.'),
    whatToDo: word('What to do'),
    reportHeading: word('USER REPORTED ABUSE'),
    dismiss: word('Dismiss Flag'),
    dismissing: word('Dismissing...'),
    freeze: word('🛑 Freeze Accounts'),
    freezing: word('Freezing...'),
    // Beside a member Freeze leaves out: the node refuses your own account, and an owner to anyone but an owner.
    cantFreezeSelf: word("Can't be frozen by you: this is you"),
    cantFreezeOwner: word("Can't be frozen by you: an owner"),
    exportEvidence: word('📄 Export Evidence'),
    copied: word('📋 Copied!'),
    frozenTag: word('🛑 FROZEN'),
    feedbackFrozen: word('Member access rights frozen. Moderation event logged.'),
    feedbackDismissed: word('Dismissed.'),
    dismissFailed: word('Failed to dismiss the report'),
    freezeFailed: word('Failed to freeze the account'),
    reviewButton: word('Review'),
};

/** The types whose harm is real enough to offer Freeze: wash trading and the sybil patterns (and reports, which are not flags). */
const FREEZABLE = new Set(['wash_trading', 'sybil_ring', 'sybil_funnel']);

/** Freeze is offered only where a flag shows real harm and names members. Unknown types never get it. */
export function flagOffersFreeze(flag: FlagLike | null | undefined): boolean {
    return Boolean(flag && typeof flag.type === 'string' && FREEZABLE.has(flag.type));
}

/** The members a flag names, from its own list (never read out of the description). */
export function flagMembers(flag: FlagLike | null | undefined): string[] {
    const list = flag?.members;
    return Array.isArray(list) ? Array.from(new Set(list.filter((m): m is string => typeof m === 'string' && m.length > 0))) : [];
}

/** The flag's plain heading. Never the raw type. */
export function flagHeading(flag: FlagLike | null | undefined): string {
    const W = FLAG_WORDS;
    switch (flag?.type) {
        case 'wash_trading': return t(W.washTrading);
        case 'sybil_ring': return t(W.sybilRing);
        case 'sybil_funnel': return t(W.sybilFunnel);
        case 'isolated_branch': return t(W.isolatedBranch);
        case 'invite_spam': return t(W.inviteSpam);
        case 'aggregate_spike': return t(W.aggregateSpike);
        case 'cohort_velocity': return t(W.cohortVelocity);
        case 'delinquency': return t(W.delinquency);
        case 'watchdog_recovery': return t(W.watchdogRecovery);
        case 'watchdog_down': return t(W.watchdogDown);
        case 'unhandled_rejections': return t(W.unhandledRejections);
        default: return t(W.unknown);
    }
}

/** The one sensible action, as a sentence. */
export function flagAction(flag: FlagLike | null | undefined): string {
    const W = FLAG_WORDS;
    switch (flag?.type) {
        case 'wash_trading': return t(W.doWashTrading);
        case 'sybil_ring': return t(W.doSybilRing);
        case 'sybil_funnel': return t(W.doSybilFunnel);
        case 'isolated_branch': return t(W.doIsolatedBranch);
        case 'invite_spam': return t(W.doInviteSpam);
        case 'aggregate_spike': return t(W.doAggregateSpike);
        case 'cohort_velocity': return t(W.doCohortVelocity);
        case 'delinquency': return t(W.doDelinquency);
        case 'watchdog_recovery': return t(W.doWatchdogRecovery);
        case 'watchdog_down': return t(W.doWatchdogDown);
        case 'unhandled_rejections': return t(W.doUnhandledRejections);
        default: return t(W.doUnknown);
    }
}
