/**
 * A known community's rule on this phone (scratch/fable-design/DESIGN-balance-rule-fable.md §1 to §4; the words and which
 * card is owed: @beanpool/core known-rule.ts, the same on the web app).
 *
 * The rule's route is public and says nothing of the reader, so it decides whether to ask anything signed: a plain
 * community, or a node older than the rule, costs one public read and the member's own standing is never asked. Both are
 * held ten minutes, as Home and Settings ask on every focus, and let go when the member steps back.
 *
 * What the account has seen is kept per community, like utils/copies-rule.ts: a new `confirmedAt` is a new confirmation,
 * so a re-confirmation shows the card again even if this phone never saw them unconfirmed.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { readKnownRule, readMemberStanding, readRuleSeen, stepBackAnswer, type KnownRule, type MemberStanding, type RuleSeen, type StepBackAnswer } from '@beanpool/core';
import { signedGet } from './node-post';
import { signedRequestWithMethod } from './db';
import { ruleSeenStoreKey } from './storage-keys';
import type { BeanPoolIdentity } from './identity';

export const KNOWN_RULE_TIMEOUT_MS = 8_000;
const HELD_MS = 10 * 60 * 1000;

/** One spelling of a community's address, whichever this phone was given. */
function communityKey(url: string): string {
    return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** The rule at `url`, or null: an older node, a community that doesn't confirm its members, no answer. Never throws. */
export async function fetchKnownRule(url: string, timeoutMs: number = KNOWN_RULE_TIMEOUT_MS): Promise<KnownRule | null> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), timeoutMs);
    try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/api/community/known-rule`, { signal: stop.signal });
        return res.ok ? readKnownRule(await res.json().catch(() => null)) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** The rule and this account's standing under it, together or not at all: a card needs both to say anything true. */
export interface MemberRule {
    rule: KnownRule;
    me: MemberStanding;
}

let held: { key: string; at: number; answer: MemberRule | null } | null = null;

/** Lets go of the held answer: the next screen asks again (a step-back). */
export function forgetMemberRule(): void {
    held = null;
}

/** The rule and standing for `identity` at `url`, or null when there is none to state. Never throws. */
export async function memberRule(url: string, identity: BeanPoolIdentity, now: number = Date.now()): Promise<MemberRule | null> {
    const key = `${communityKey(url)}\n${identity.publicKey}`;
    if (held?.key === key && now - held.at < HELD_MS) return held.answer;
    const rule = await fetchKnownRule(url);
    let answer: MemberRule | null = null;
    if (rule) {
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), KNOWN_RULE_TIMEOUT_MS);
        try {
            const res = await signedGet(url, '/api/community/me', identity, stop.signal);
            const me = res.ok ? readMemberStanding(await res.json().catch(() => null)) : null;
            if (me) answer = { rule, me };
        } catch {
            // As no answer: nothing to say.
        } finally {
            clearTimeout(timer);
        }
    }
    held = { key, at: now, answer };
    return answer;
}

async function allSeen(publicKey: string): Promise<Record<string, unknown>> {
    try {
        const raw = await AsyncStorage.getItem(ruleSeenStoreKey(publicKey));
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

/** What this account last put away at `url`. Never throws. */
export async function ruleSeenAt(publicKey: string, url: string): Promise<RuleSeen | null> {
    return readRuleSeen((await allSeen(publicKey))[communityKey(url)]);
}

/** This account has put the card away at `url`. Not kept: the card shows again next time, which says nothing untrue. */
export async function keepRuleSeen(publicKey: string, url: string, seen: RuleSeen): Promise<void> {
    try {
        const all = await allSeen(publicKey);
        all[communityKey(url)] = seen;
        await AsyncStorage.setItem(ruleSeenStoreKey(publicKey), JSON.stringify(all));
    } catch {
        // See above.
    }
}

/** The member steps back, signed by their own key. Lets go of the held answer whatever comes back. */
export async function stepBackFromConfirmed(): Promise<StepBackAnswer> {
    const answer = await stepBackAnswer(() => signedRequestWithMethod('POST', '/api/names/step-back', {}));
    // A refusal can mean the phone was out of date too (an admin revoked them meanwhile): ask again either way.
    forgetMemberRule();
    return answer;
}
