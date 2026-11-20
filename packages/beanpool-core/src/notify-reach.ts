/**
 * The owner's count (notifications amendment 2, slice N6; scratch/fable-design/DESIGN-notify-and-backup-asks-fable.md
 * §4.7, decided as "a count only"): how many of a community's members have a phone this community's server can send a
 * notification to, out of how many members. One rule for every place it is counted (apps/server state-engine.ts
 * getAdminMemberCounts) and one wording for every place it is shown (apps/manager MembersModule, the Members page).
 *
 * What the server knows, and so what this can say: a member has a phone registered here (a push token, `push_tokens`),
 * or not. It cannot tell why one has none (the web only, never turned on, said no, signed out, a dead token), and a
 * phone that later switched notifications off in its own settings keeps its token. So: a count, the honest second line,
 * and never a name. The phone chip on each member's row is a separate thing and stays as it is.
 */
import { word, wordn, type TFunction, type TnFunction } from './words.js';

/** One row of the members table, as the count needs it, with the platforms of that member's push tokens. */
export interface NotifyReachRow {
    /** members.status: 'pruned' is gone (removed, or deleted by its owner); every other status is still a member. */
    status: string | null | undefined;
    /** members.is_treasury: the community's own account, not a person. */
    isTreasury: boolean;
    /** members.is_visitor: someone a member wrote to, or a member of another community; not a member here. */
    isVisitor: boolean;
    /** An empty duplicate an owner retired (retired_accounts): it acts and lists as nothing. */
    retired: boolean;
    /** The `platform` of each of this member's push tokens, as stored (any case), none when it has no token. */
    tokenPlatforms: readonly (string | null | undefined)[];
}

/** `phone`: a member with a phone registered here; `no-phone`: a member with none; `not-counted`: not a member here. */
export type NotifyReachKind = 'phone' | 'no-phone' | 'not-counted';

/** The platforms whose push token is a phone's: the phone app's own names (React Native's Platform.OS). */
export const NOTIFY_PHONE_PLATFORMS = ['ios', 'android'] as const;

/** Whether a push token's stored platform is a phone's. Anything else (none, 'web', a word some other client sent) is not. */
export function isNotifyPhonePlatform(platform: string | null | undefined): boolean {
    return typeof platform === 'string' && (NOTIFY_PHONE_PLATFORMS as readonly string[]).includes(platform.toLowerCase());
}

/** Where one row goes in the count. */
export function notifyReachOf(row: NotifyReachRow): NotifyReachKind {
    if (row.status === 'pruned' || row.isTreasury || row.isVisitor || row.retired) return 'not-counted';
    return row.tokenPlatforms.some(isNotifyPhonePlatform) ? 'phone' : 'no-phone';
}

/** The count: `phones` members with a phone registered here, of `members`. */
export interface NotifyReach {
    phones: number;
    members: number;
}

/** The count over every row (a row of any kind may be passed: the rule decides which are members). */
export function notifyReachCount(rows: Iterable<NotifyReachRow>): NotifyReach {
    let phones = 0;
    let members = 0;
    for (const row of rows) {
        const kind = notifyReachOf(row);
        if (kind === 'not-counted') continue;
        members++;
        if (kind === 'phone') phones++;
    }
    return { phones, members };
}

/** A count as a node sends it: two whole numbers, none below 0, and never more phones than members. Else none to show. */
export function isNotifyReach(value: unknown): value is NotifyReach {
    if (!value || typeof value !== 'object') return false;
    const { phones, members } = value as Record<string, unknown>;
    return Number.isSafeInteger(phones) && Number.isSafeInteger(members)
        && (phones as number) >= 0 && (members as number) >= (phones as number);
}

export const NOTIFY_REACH_WORDS = {
    headline: word('Members a phone can notify: {n} of {m}'),
    others: wordn(
        "The other {n} uses the web only, hasn't turned notifications on, or said no. The server can't tell which.",
        "The other {n} use the web only, haven't turned notifications on, or said no. The server can't tell which.",
    ),
} as const;

/**
 * What the Members page says of a count: the headline, and the second line only when some members are not counted as a
 * phone (none when every member is one, or there are no members). Information only: no warning and no action.
 */
export function notifyReachLines(reach: NotifyReach, w: { t: TFunction; tn: TnFunction }): { headline: string; others: string | null } {
    const W = NOTIFY_REACH_WORDS;
    const rest = reach.members - reach.phones;
    return {
        headline: w.t(W.headline, { n: reach.phones, m: reach.members }),
        others: rest > 0 ? w.tn(rest, W.others.one, W.others.other) : null,
    };
}
