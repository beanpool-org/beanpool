/**
 * People on a community where no app reads the member directory whole (`features.membersOnDemand`, the worldwide one;
 * design scratch/global-node/DESIGN-global-members-by-area-fable.md §2.3, slice M3). The web app asks the node three
 * small questions instead of downloading every member on each page open (15.4 MB at 30,000 members):
 * - who is near: the 50 nearest the member's stored area (`lat&lng&limit=50`), each "about N km";
 * - a name: what was typed, from 2 characters, 20 at most (`q=<text>&limit=20`), the node's prefix search;
 * - these people: up to 100 keys a request (`keys=`), for the names in the member's own conversations.
 * A community without the switch reads exactly what it read before; a node that can't be asked counts as one without.
 */
import { useEffect, useState } from 'react';
import { getMemberCards, type CommunityInfo, type MemberCard } from './api';
import { communityInfoOnce } from './visitor-lobby-gate';

/** The node's floors and ceilings (apps/server routes/community.ts answerMembersOnDemand): asked within them, never refused. */
export const MEMBERS_SEARCH_MIN_CHARS = 2;
export const MEMBERS_SEARCH_LIMIT = 20;
export const MEMBERS_NEAR_LIMIT = 50;
export const MEMBERS_KEYS_MAX = 100;
/** At most this many keys requests at once; the rest wait for the next refresh (the phone's rule, design §2.2). */
export const MEMBERS_KEYS_BATCHES = 3;
/** The pause after typing before a search goes to the node, as on the phone. */
export const MEMBERS_SEARCH_DEBOUNCE_MS = 400;

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
 * The keys requests for these people: each a member key as the node spells them (anything else, such as an escrow or a
 * project, is left out, since one bad key refuses the whole request), each asked once, 100 a request, at most 3.
 */
export function memberKeysPaths(keys: Iterable<string>): string[] {
    const wanted = [...new Set([...keys].filter(k => typeof k === 'string' && MEMBER_KEY.test(k)))];
    const paths: string[] = [];
    for (let i = 0; i < wanted.length && paths.length < MEMBERS_KEYS_BATCHES; i += MEMBERS_KEYS_MAX) {
        paths.push(`/api/members?${new URLSearchParams({ keys: wanted.slice(i, i + MEMBERS_KEYS_MAX).join(',') })}`);
    }
    return paths;
}

/** The members whose name starts with what was typed; none, without asking, under 2 characters. */
export async function searchMembers(typed: string, signal?: AbortSignal): Promise<MemberCard[]> {
    const path = memberSearchPath(typed);
    return path ? getMemberCards(path, signal) : [];
}

/** The 50 members nearest a stored area, nearest first; none, without asking, with no area. */
export async function membersNear(point: { lat: number; lng: number } | null | undefined, signal?: AbortSignal): Promise<MemberCard[]> {
    const path = membersNearPath(point);
    return path ? getMemberCards(path, signal) : [];
}

/** These people's cards, as many as the node holds (memberKeysPaths says which are asked). A failed batch gives none. */
export async function membersByKeys(keys: Iterable<string>, signal?: AbortSignal): Promise<MemberCard[]> {
    const answers = await Promise.all(memberKeysPaths(keys).map(p => getMemberCards(p, signal).catch(() => [] as MemberCard[])));
    return answers.flat();
}

/**
 * Whether this community wants people asked for: null until the node's answer (the page's one shared read of
 * /api/community/info), then true or false. A read that fails is false: the page reads as it did before the switch.
 */
export function useMembersOnDemand(): boolean | null {
    const [on, setOn] = useState<boolean | null>(null);
    useEffect(() => {
        let cancelled = false;
        communityInfoOnce()
            .then(info => { if (!cancelled) setOn(membersOnDemandOn(info)); })
            .catch(() => { if (!cancelled) setOn(false); });
        return () => { cancelled = true; };
    }, []);
    return on;
}
