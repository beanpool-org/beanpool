/**
 * People → Community on the web: the order of the whole list (Marty, 14 Nov 2026: "should I be able to sort these by recently
 * joined?" ... "make them consistent"). The phone's five sorts, its order and its words (core member-sort.ts), with the rules
 * of the phone's query (apps/native/app/(tabs)/people.tsx loadMembers): every sort but Name breaks a tie newest first.
 *
 * What a sort may read. The web holds the node's whole member answer (GET /api/community/members), and orders it only by what
 * this viewer may see:
 *   - Newest and Name: each row shows the joined date and the name.
 *   - Friends: the viewer's own friends.
 *   - Active: the node serves the last-active DAY only to anyone but the member (state-engine lastActiveForViewer, secret
 *     ballots), as each profile shows it; within a day the order is the joined date, so nothing finer is told.
 *   - Trusted: the node's `earnedCredit` on each row is members.earned_credit_c, the granted-credit lane (engine trust.ts),
 *     a part of a person's credit line that only an owner's or admin's credit view shows (`granted_c`, server
 *     engine/credit-sight.ts). A voucher's view shows the whole line, never that part, and a member's nothing, so only an
 *     owner or admin is offered it ({@link memberSortsFor}); the page learns that from the Show credit panel's own read.
 *
 * The choice is kept as the phone keeps it: the phone's screen holds it in its state for as long as the app runs (People stays
 * mounted inside Talk) and stores it nowhere. The web's People page is drawn afresh at each visit, so the choice lives here, in
 * memory, for the life of the page: a reload starts at Newest again, as a restart of the phone's app does.
 */
import { MEMBER_SORTS, type MemberSort } from '@beanpool/core';

/** What ordering reads from a row of the node's member answer. */
export interface SortableMember {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    lastActiveAt?: string | null;
    earnedCredit?: number;
}

/** The list draws this many rows, and this many more each time the end comes into view or Show more is pressed. */
export const MEMBERS_DRAWN_STEP = 50;

/** The sorts this viewer is offered, in the phone's order: Trusted only where their credit view shows its figure. */
export function memberSortsFor(seesGrantedCredit: boolean): MemberSort[] {
    return MEMBER_SORTS.filter((s) => s !== 'trusted' || seesGrantedCredit);
}

/** A time to order by; one that can't be read sorts as the oldest. */
function when(iso: string | null | undefined): number {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
}

/** Larger first, without the NaN that -Infinity minus -Infinity gives. */
function larger(a: number, b: number): number {
    return a === b ? 0 : a > b ? -1 : 1;
}

const credit = (m: SortableMember) => (typeof m.earnedCredit === 'number' && Number.isFinite(m.earnedCredit) ? m.earnedCredit : 0);
const newest = (a: SortableMember, b: SortableMember) => larger(when(a.joinedAt), when(b.joinedAt));

/** A new list in `sort`'s order; the one given is left as it was. */
export function orderMembers<T extends SortableMember>(people: readonly T[], sort: MemberSort, friends: ReadonlySet<string>): T[] {
    const out = [...people];
    switch (sort) {
        case 'name':
            return out.sort((a, b) => a.callsign.localeCompare(b.callsign, undefined, { sensitivity: 'base' }));
        case 'friends':
            return out.sort((a, b) => larger(friends.has(a.publicKey) ? 1 : 0, friends.has(b.publicKey) ? 1 : 0) || newest(a, b));
        case 'trusted':
            return out.sort((a, b) => larger(credit(a), credit(b)) || newest(a, b));
        case 'active':
            return out.sort((a, b) => larger(when(a.lastActiveAt), when(b.lastActiveAt)) || newest(a, b));
        default:
            return out.sort(newest);
    }
}

let kept: MemberSort = MEMBER_SORTS[0];

/** The sort last picked on this page (Newest until one is). */
export function keptMemberSort(): MemberSort {
    return kept;
}

export function keepMemberSort(sort: MemberSort): void {
    kept = sort;
}

/** Back to Newest: for tests, which share one page. */
export function forgetKeptMemberSort(): void {
    kept = MEMBER_SORTS[0];
}
