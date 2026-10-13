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
import { getMemberCards, getNodeApiUrl, type CommunityInfo, type MemberCard } from './api';
import { communityInfoOnce } from './visitor-lobby-gate';
import { bounded } from './bounded';

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

/** Whether this community wants people asked for, not read whole. A node that doesn't say: no. */
export function membersOnDemandOn(info: CommunityInfo | null | undefined): boolean {
    return info?.features?.membersOnDemand === true;
}

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

/** The members whose name starts with what was typed; none, without asking, under 2 characters. */
export async function searchMembers(typed: string, signal?: AbortSignal): Promise<MemberCard[]> {
    const path = memberSearchPath(typed);
    return path ? cardsWithin(path, signal) : [];
}

/** The 50 members nearest a stored area, nearest first; none, without asking, with no area. */
export async function membersNear(point: { lat: number; lng: number } | null | undefined, signal?: AbortSignal): Promise<MemberCard[]> {
    const path = membersNearPath(point);
    return path ? cardsWithin(path, signal) : [];
}

/** One batch of people's cards (memberKeysBatches): those the node holds, in the order asked. */
export async function membersByKeys(batch: string[], signal?: AbortSignal): Promise<MemberCard[]> {
    return batch.length ? cardsWithin(memberKeysPath(batch), signal) : [];
}

/**
 * A search box's answer from the node while `enabled`: asked once the typing pauses (MEMBERS_SEARCH_DEBOUNCE_MS), from
 * 2 characters; each new word stops the one asked before it. `found` is null while there is nothing to show.
 */
export function useMemberSearch(typed: string, enabled: boolean): { found: MemberCard[] | null; state: 'idle' | 'searching' | 'failed' } {
    const [found, setFound] = useState<MemberCard[] | null>(null);
    const [state, setState] = useState<'idle' | 'searching' | 'failed'>('idle');
    useEffect(() => {
        if (!enabled || !memberSearchPath(typed)) { setFound(null); setState('idle'); return; }
        const stop = new AbortController();
        setState('searching');
        const timer = setTimeout(() => {
            searchMembers(typed, stop.signal)
                .then(people => { if (!stop.signal.aborted) { setFound(people); setState('idle'); } })
                .catch(() => { if (!stop.signal.aborted) { setFound(null); setState('failed'); } });
        }, MEMBERS_SEARCH_DEBOUNCE_MS);
        return () => { clearTimeout(timer); stop.abort(); };
    }, [typed, enabled]);
    return { found, state };
}

/** Where this browser keeps each node's last answer about the switch: `<prefix><node address>` = '1' or '0'. */
export const MEMBERS_ON_DEMAND_SEEN_PREFIX = 'bp_members_on_demand:';

function seenKey(): string {
    return MEMBERS_ON_DEMAND_SEEN_PREFIX + (getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : ''));
}

/** This node's last answer to this browser, or null when it never gave one (or the store can't be read). */
export function membersOnDemandLastSeen(): boolean | null {
    try {
        const v = localStorage.getItem(seenKey());
        return v === '1' ? true : v === '0' ? false : null;
    } catch {
        return null;
    }
}

function noteMembersOnDemand(on: boolean): void {
    try { localStorage.setItem(seenKey(), on ? '1' : '0'); } catch { /* this page still has the answer */ }
}

/**
 * Whether this community wants people asked for: null until the node's answer (the page's one shared read of
 * /api/community/info), then true or false. A read that fails takes the node's last answer to this browser, so an
 * offline start on the worldwide community still asks, never reads whole (review of #1861, N2); only a node that has
 * never answered here reads as it did before the switch.
 */
export function useMembersOnDemand(): boolean | null {
    const [on, setOn] = useState<boolean | null>(null);
    useEffect(() => {
        let cancelled = false;
        // Asked inside the promise, so a read that throws before it starts is "couldn't say" too, never a broken page.
        Promise.resolve()
            .then(() => communityInfoOnce())
            .then(info => {
                const answer = membersOnDemandOn(info);
                noteMembersOnDemand(answer);
                if (!cancelled) setOn(answer);
            })
            .catch(() => { if (!cancelled) setOn(membersOnDemandLastSeen() ?? false); });
        return () => { cancelled = true; };
    }, []);
    return on;
}
