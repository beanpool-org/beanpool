/**
 * Which community the member's own name and picture belong to (utils/use-own-profile.ts). One source of truth per account
 * and community: that community's own members row, in its copy on this phone (scratch/fable-design/
 * DESIGN-per-community-profile-fable.md §3). The header, My Profile, Settings and the Ledger stay mounted when the phone
 * changes community, so what each holds names the community it was read for: a row read for any other one is never
 * shown, not even while the new one's is still on its way (until then: the ready-made picture the key picks).
 *
 * No imports, so it runs under vitest as it is (as node-profile-anchor.ts).
 */

/** The own members row, in the shape the readers draw. */
export interface OwnRow {
    callsign: string | null;
    /** As the row holds it: the node's `/api/avatar/…` path, a `data:` or `bundled://` value a Save wrote, or null. */
    avatarUrl: string | null;
    /** The row's `profile_updated_at`: what tells an avatar a picture at the same address is a new one. */
    updatedAt: string | null;
}

export interface OwnProfile extends OwnRow {
    /** The phone's community (`beanpool_anchor_url`) this was read for; null before the first read, or with none. */
    community: string | null;
    /** Whether that community's row has been read yet: before then every field is null because it is on its way. */
    read: boolean;
}

export const UNKNOWN_OWN_PROFILE: OwnProfile = { community: null, read: false, callsign: null, avatarUrl: null, updatedAt: null };

/** A value worth drawing: the strings a row can hold for "none" are none. */
function present(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v === '' || v === 'null' || v === 'undefined' ? null : value;
}

/** The members row as the copy holds it (`getMemberProfile`), or null where this community holds none for the account. */
export function ownRowOf(row: { callsign?: unknown; avatar_url?: unknown; profile_updated_at?: unknown } | null | undefined): OwnRow | null {
    if (!row) return null;
    return { callsign: present(row.callsign), avatarUrl: present(row.avatar_url), updatedAt: present(row.profile_updated_at) };
}

/** The phone's community was read. The same one keeps what it has; any other one (or none) starts from unknown. */
export function ownCommunityRead(state: OwnProfile, url: string | null): OwnProfile {
    return state.community === url ? state : { ...UNKNOWN_OWN_PROFILE, community: url };
}

/**
 * The row for `url` was read (`row` null: this community holds none for the account yet). Shown only while the phone is
 * still on `url`. An answer that changes nothing returns the state as it was, so no reader draws again for it.
 */
export function ownRowArrived(state: OwnProfile, url: string | null, row: OwnRow | null): OwnProfile {
    if (state.community !== url) return state;
    const next: OwnProfile = {
        community: url,
        read: true,
        callsign: row?.callsign ?? null,
        avatarUrl: row?.avatarUrl ?? null,
        updatedAt: row?.updatedAt ?? null,
    };
    const same = state.read && state.callsign === next.callsign && state.avatarUrl === next.avatarUrl && state.updatedAt === next.updatedAt;
    return same ? state : next;
}
