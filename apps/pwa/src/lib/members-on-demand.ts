/**
 * People on a community where no app reads the member directory whole (`features.membersOnDemand`, the worldwide one;
 * design scratch/global-node/DESIGN-global-members-by-area-fable.md §2.3, slice M3). The web app asks the node three
 * small questions instead of downloading every member on each page open (15.4 MB at 30,000 members):
 * - who is near: the 50 nearest the member's stored area (`lat&lng&limit=50`), each "about N km";
 * - a name: what was typed, from 2 characters, 20 at most (`q=<text>&limit=20`), the node's prefix search;
 * - these people: up to 100 keys a request (`keys=`), for the names in the member's own conversations.
 * A community without the switch reads exactly what it read before. A node that can't be asked counts as it last
 * answered this browser, and as one without only when it never has.
 */
import { useEffect, useState } from 'react';
import { getMemberCards, getMembers, type Member, type MemberCard } from './api';
import { communityInfoOnce } from './visitor-lobby-gate';
import { bounded } from './bounded';
import { membersOnDemandOn, membersOnDemandLastSeen, noteMembersOnDemand } from './members-on-demand-seen';

export { membersOnDemandOn, membersOnDemandLastSeen, MEMBERS_ON_DEMAND_SEEN_PREFIX } from './members-on-demand-seen';

/** The node's floors and ceilings (apps/server routes/community.ts answerMembersOnDemand): asked within them, never refused. */
export const MEMBERS_SEARCH_MIN_CHARS = 2;
export const MEMBERS_SEARCH_LIMIT = 20;
export const MEMBERS_NEAR_LIMIT = 50;
export const MEMBERS_KEYS_MAX = 100;
/** At most this many keys requests at once; the rest wait for the next refresh (the phone's rule, design §2.2). */
export const MEMBERS_KEYS_BATCHES = 3;
/** The pause after typing before a search goes to the node, as on the phone. */
export const MEMBERS_SEARCH_DEBOUNCE_MS = 400;
/**
 * Each small form's time limit (review of #1861, N4): without one, a node that never answers left "Finding who's near
 * you…" or "Searching…" up for good. The node's own caps make it generous: an answer is at most 50 cards near, 20 for a
 * name, 100 by key (each card about 400 bytes, so 20, 8 and 40 KB), built from an index, and sent straight past the
 * heavy-read cap, so it is never queued or answered busy and only the network takes time. 40 KB at 64 kbit/s is 5 s
 * plus the handshake; past 30 s the node isn't answering. The same as the area read's (lib/member-area).
 */
export const MEMBERS_REQUEST_TIMEOUT_MS = 30_000;

const MEMBER_KEY = /^[0-9a-f]{64}$/;

/** The search's path, or null when what was typed is too short to ask (the node refuses under 2 characters). */
export function memberSearchPath(typed: string): string | null {
    const q = typed.trim();
    if (q.length < MEMBERS_SEARCH_MIN_CHARS) return null;
    return `/api/members?${new URLSearchParams({ q, limit: String(MEMBERS_SEARCH_LIMIT) })}`;
}

/** The nearest-first path from a stored area, or null with no area: nothing is asked without a point. */
export function membersNearPath(point: { lat: number; lng: number } | null | undefined): string | null {
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
    return `/api/members?${new URLSearchParams({ lat: String(point.lat), lng: String(point.lng), limit: String(MEMBERS_NEAR_LIMIT) })}`;
}

/**
 * The keys asked for these people, in requests of 100, at most 3: each a member key as the node spells them (anything
 * else, such as an escrow or a project, is left out, since one bad key refuses the whole request), each asked once.
 */
export function memberKeysBatches(keys: Iterable<string>): string[][] {
    const wanted = [...new Set([...keys].filter(k => typeof k === 'string' && MEMBER_KEY.test(k)))];
    const batches: string[][] = [];
    for (let i = 0; i < wanted.length && batches.length < MEMBERS_KEYS_BATCHES; i += MEMBERS_KEYS_MAX) {
        batches.push(wanted.slice(i, i + MEMBERS_KEYS_MAX));
    }
    return batches;
}

/** One keys request's path. */
export function memberKeysPath(batch: string[]): string {
    return `/api/members?${new URLSearchParams({ keys: batch.join(',') })}`;
}

/** The keys requests for these people (memberKeysBatches). */
export function memberKeysPaths(keys: Iterable<string>): string[] {
    return memberKeysBatches(keys).map(memberKeysPath);
}

/** One small form's answer, given up (rejected) after MEMBERS_REQUEST_TIMEOUT_MS or when `signal` stops it. */
function cardsWithin(path: string, signal?: AbortSignal): Promise<MemberCard[]> {
    return bounded(stop => getMemberCards(path, stop), MEMBERS_REQUEST_TIMEOUT_MS, signal);
}

/**
 * Where anyone can join in a minute the node counts each search by name and each "near you" against a day's budget
 * (100 each a member), so the web app never spends one the member didn't ask for (Marty's call 3, 15 Oct 2026): the same
 * search or "near you" asked again soon is answered from here. A page opened again, a re-render, a tab switched back: none
 * of them asks the node twice. A read by key is never counted, and never kept.
 */
export const RECENT_LOOKUP_MS = 2 * 60 * 1000;
const RECENT_LOOKUPS_MAX = 50;
const recentLookups = new Map<string, { at: number; cards: MemberCard[] }>();

/** Forget the answers kept: App does on every change of the signed-in account (they are kept by path alone), and tests. */
export function forgetRecentLookups(): void {
    recentLookups.clear();
}

async function countedCards(path: string, signal?: AbortSignal): Promise<MemberCard[]> {
    const kept = recentLookups.get(path);
    if (kept && Date.now() - kept.at < RECENT_LOOKUP_MS) return kept.cards;
    const cards = await cardsWithin(path, signal);
    recentLookups.delete(path);
    recentLookups.set(path, { at: Date.now(), cards });
    if (recentLookups.size > RECENT_LOOKUPS_MAX) recentLookups.delete(recentLookups.keys().next().value!);
    return cards;
}

/** The members whose name starts with what was typed; none, without asking, under 2 characters. */
export async function searchMembers(typed: string, signal?: AbortSignal): Promise<MemberCard[]> {
    const path = memberSearchPath(typed);
    return path ? countedCards(path, signal) : [];
}

/** The 50 members nearest a stored area, nearest first; none, without asking, with no area. */
export async function membersNear(point: { lat: number; lng: number } | null | undefined, signal?: AbortSignal): Promise<MemberCard[]> {
    const path = membersNearPath(point);
    return path ? countedCards(path, signal) : [];
}

/** One batch of people's cards (memberKeysBatches): those the node holds, in the order asked. */
export async function membersByKeys(batch: string[], signal?: AbortSignal): Promise<MemberCard[]> {
    return batch.length ? cardsWithin(memberKeysPath(batch), signal) : [];
}

/**
 * The node's own words when it refused a lookup because the member has used up today's (a 429 `…_day_budget`, where
 * anyone can join in a minute): how many, until when, and what still works. Null for any other failure, which the
 * screens still call a connection problem. Never "check your connection" for a day that is spent (#1965 review N4).
 */
export function dayBudgetWords(e: unknown): string | null {
    const code = (e as { code?: unknown } | null)?.code;
    const words = (e as { message?: unknown } | null)?.message;
    return typeof code === 'string' && code.endsWith('_day_budget') && typeof words === 'string' && words.trim() ? words : null;
}

/**
 * A search box's answer from the node while `enabled`: asked once the typing pauses (MEMBERS_SEARCH_DEBOUNCE_MS), from
 * 2 characters; each new word stops the one asked before it. `found` is null while there is nothing to show.
 */
export function useMemberSearch(typed: string, enabled: boolean): { found: MemberCard[] | null; state: 'idle' | 'searching' | 'failed'; refusal: string | null } {
    const [found, setFound] = useState<MemberCard[] | null>(null);
    const [state, setState] = useState<'idle' | 'searching' | 'failed'>('idle');
    // With 'failed': the node's words when the day's searches are spent (dayBudgetWords), else null.
    const [refusal, setRefusal] = useState<string | null>(null);
    useEffect(() => {
        if (!enabled || !memberSearchPath(typed)) { setFound(null); setState('idle'); return; }
        const stop = new AbortController();
        setState('searching');
        const timer = setTimeout(() => {
            searchMembers(typed, stop.signal)
                .then(people => { if (!stop.signal.aborted) { setFound(people); setState('idle'); setRefusal(null); } })
                .catch((e) => { if (!stop.signal.aborted) { setFound(null); setState('failed'); setRefusal(dayBudgetWords(e)); } });
        }, MEMBERS_SEARCH_DEBOUNCE_MS);
        return () => { clearTimeout(timer); stop.abort(); };
    }, [typed, enabled]);
    return { found, state, refusal };
}

/** The node's code when it refused the whole directory because people are asked for there (routes/community.ts). */
export const MEMBERS_ON_DEMAND_CODE = 'members_on_demand';

/** Whether a failed read is the node refusing the whole directory as one where people are asked for (403 `members_on_demand`). */
export function isMembersOnDemandRefusal(e: unknown): boolean {
    const err = e as { status?: unknown; code?: unknown } | null;
    return err?.status === 403 && err?.code === MEMBERS_ON_DEMAND_CODE;
}

/** Every useMembersOnDemand on the page, told when the node refused a whole read as one where people are asked for. */
const refusedWholeListeners = new Set<() => void>();

/**
 * The whole directory, where the node said it reads whole or couldn't say (useMembersOnDemand false). A 403
 * `members_on_demand` is the node saying people are asked for here (the worldwide community, whose info read failed:
 * review of #1999, item 1): kept as its answer, every useMembersOnDemand on the page turns true, and the error goes on to
 * the caller, which keeps no list from it. Any other failure switches nothing: the caller says it couldn't read.
 */
export async function getMembersWhole(): Promise<Member[]> {
    try {
        return await getMembers();
    } catch (e) {
        if (isMembersOnDemandRefusal(e)) {
            noteMembersOnDemand(true);
            for (const told of [...refusedWholeListeners]) told();
        }
        throw e;
    }
}

/**
 * Whether this community wants people asked for: null until the node's answer (the page's one shared read of
 * /api/community/info), then true or false. A read that fails takes the node's last answer to this browser, so an
 * offline start on the worldwide community still asks, never reads whole (review of #1861, N2); a node that has never
 * answered here reads as it did before the switch, until a whole read is refused 403 `members_on_demand`
 * (getMembersWhole), which turns it true.
 */
export function useMembersOnDemand(): boolean | null {
    const [on, setOn] = useState<boolean | null>(null);
    useEffect(() => {
        let cancelled = false;
        // A refusal is the node's newest word: an info answer that lands after it doesn't turn it back.
        let refused = false;
        const told = () => { refused = true; if (!cancelled) setOn(true); };
        refusedWholeListeners.add(told);
        // Asked inside the promise, so a read that throws before it starts is "couldn't say" too, never a broken page.
        Promise.resolve()
            .then(() => communityInfoOnce())
            .then(info => {
                const answer = refused || membersOnDemandOn(info);
                noteMembersOnDemand(answer);
                if (!cancelled) setOn(answer);
            })
            .catch(() => { if (!cancelled) setOn(refused || (membersOnDemandLastSeen() ?? false)); });
        return () => { cancelled = true; refusedWholeListeners.delete(told); };
    }, []);
    return on;
}
