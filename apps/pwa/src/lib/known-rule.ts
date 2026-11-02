/**
 * A known community's rule in the web app (scratch/fable-design/DESIGN-balance-rule-fable.md §1 to §4; the words and
 * which card is owed: @beanpool/core known-rule.ts, the same as the phone's utils/known-rule.ts).
 *
 * The rule's route is public and says nothing of the reader, so it decides whether to ask anything signed: a plain
 * community, or a node older than the rule, costs one public read and the member's own standing is never asked. Both are
 * held ten minutes, as Home opens often, and let go when the member steps back. This page belongs to one community, so
 * what an account has seen is kept per account, in this browser.
 */
import { readKnownRule, readMemberStanding, readRuleSeen, stepBackAnswer, type KnownRule, type MemberStanding, type RuleSeen, type StepBackAnswer } from '@beanpool/core';
import { getCommunityMe, request } from './api';

const HELD_MS = 10 * 60 * 1000;

/** The rule here, or null: an older node, a community that doesn't confirm its members, no answer. Never throws. */
export async function fetchKnownRule(): Promise<KnownRule | null> {
    return request<unknown>('GET', '/api/community/known-rule').then(readKnownRule).catch(() => null);
}

/** The rule and this account's standing under it, together or not at all: a card needs both to say anything true. */
export interface MemberRule {
    rule: KnownRule;
    me: MemberStanding;
}

let held: { key: string; at: number; answer: MemberRule | null } | null = null;

/** Lets go of the held answer: the next screen asks again (a step-back; tests). */
export function forgetMemberRule(): void {
    held = null;
}

/** The rule and standing for `publicKey`, or null when there is none to state. Never throws. */
export async function memberRule(publicKey: string, now: number = Date.now()): Promise<MemberRule | null> {
    if (held?.key === publicKey && now - held.at < HELD_MS) return held.answer;
    const rule = await fetchKnownRule();
    const me = rule ? await getCommunityMe().then(readMemberStanding).catch(() => null) : null;
    const answer = rule && me ? { rule, me } : null;
    held = { key: publicKey, at: now, answer };
    return answer;
}

const seenKey = (publicKey: string) => `beanpool_rule_seen:${publicKey.toLowerCase()}`;

/** What this account last put away in this browser. Never throws. */
export function ruleSeenBy(publicKey: string): RuleSeen | null {
    try {
        return readRuleSeen(JSON.parse(localStorage.getItem(seenKey(publicKey)) ?? 'null'));
    } catch {
        return null;
    }
}

/** This account has put the card away. Not kept: the card shows again next time, which says nothing untrue. */
export function keepRuleSeen(publicKey: string, seen: RuleSeen): void {
    try {
        localStorage.setItem(seenKey(publicKey), JSON.stringify(seen));
    } catch {
        // See above.
    }
}

/** The member steps back, signed by their own key. Lets go of the held answer whatever comes back. */
export async function stepBackFromConfirmed(): Promise<StepBackAnswer> {
    const answer = await stepBackAnswer(() => request<unknown>('POST', '/api/names/step-back', {}));
    // A refusal can mean this page was out of date too (an admin revoked them meanwhile): ask again either way.
    forgetMemberRule();
    return answer;
}
