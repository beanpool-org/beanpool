/**
 * Shared roster answers: one per group, view and filter (docs/global-heavy-lists.md §5(d), slice 3).
 *
 * `GET /api/groups/:id/members` is the same for every reader of one view of one group: the rows carry the group's
 * memberships and each member's name and photo, nothing about who is asking. So each view is built once per version,
 * kept as one Buffer, and sent to every reader of that view with the directory's mechanics (members-snapshot.ts:
 * chunked sends under the heavy-read cap and its deadline, each weighed its window and each body counted once for as long
 * as any send holds it, also once a newer version has replaced it; a gzip copy made once).
 *   - Who may read and which view they get are decided by the route first, per request (#828): an invite-only group
 *     is 404 to an outsider and 403 to an invitee or someone asking, and nothing here is looked at for either. Only
 *     then is the view chosen.
 *   - The view is part of the key, so no view is ever sent another's bytes, even where two would match today:
 *       convenor — an acting convenor (one whose powers aren't resting): requests and invitations as well;
 *       member   — an active member of the group, a suspended convenor included (#828: their powers rest);
 *       outside  — anyone else the route lets read the active roster (an open or request-to-join group's visitor).
 *   - The key also holds the groups version (every write to group_members moves it), the members version (a name or
 *     photo in a roster row, and a re-key, move it), the face-key setting (avatarUrlOf), the group's id and the
 *     filters. A snapshot is served only for its exact key: a removal is in the very next read, never a window.
 *   - It is rebuilt at least every MAX_AGE_MS while it is read, as the directory's is, so a missed version bump is
 *     stale for a minute at most.
 *   - Its ETag is the view's name and a digest of its bytes, and a 304 is given only against the current key's
 *     snapshot: never wrong, and never across views.
 *   - Rosters are held in an LRU under a byte budget (body and gzip copy counted), so many big groups can't add up.
 *     A roster bigger than the budget on its own is sent but not kept.
 */
import { createHash } from 'node:crypto';
import type { MembersSnapshot } from './members-snapshot.js';

export type RosterView = 'convenor' | 'member' | 'outside';

export type RosterSnapshot = MembersSnapshot;

const MAX_AGE_MS = 60_000;
/** What all the kept rosters may hold, bodies and gzip copies together. */
const BYTE_BUDGET = 64 * 1024 * 1024;

let settings = { maxAgeMs: MAX_AGE_MS, byteBudget: BYTE_BUDGET };
/** By slot (group, view, filters), least recently used first. */
const kept = new Map<string, RosterSnapshot>();
let keptBytes = 0;
let builds = 0;

function sizeOf(snap: RosterSnapshot): number {
    return snap.body.length + (snap.gzip?.length ?? 0);
}

/** The slot one view of one group with one set of filters is kept in. */
export function rosterSlot(groupId: string, view: RosterView, status: string | undefined, role: string | undefined): string {
    return JSON.stringify([groupId, view, status ?? null, role ?? null]);
}

/** The key a slot's snapshot must match: the slot and every version and setting its rows are read from. */
export function rosterSnapshotKey(slot: string, groupsVersion: number, membersVersion: number, avatarKeys: boolean): string {
    return `${slot}:${groupsVersion}:${membersVersion}:${avatarKeys ? 'k' : 'o'}`;
}

/** The ready snapshot of `slot` for exactly `key`, or null when it must be (re)built. */
export function usableRosterSnapshot(slot: string, key: string, now = Date.now()): RosterSnapshot | null {
    const snap = kept.get(slot);
    if (!snap || snap.key !== key) return null;
    const age = now - snap.builtAt;
    if (age < 0 || age >= settings.maxAgeMs) return null;
    // Most recently used last.
    kept.delete(slot);
    kept.set(slot, snap);
    return snap;
}

function drop(slot: string): void {
    const snap = kept.get(slot);
    if (!snap) return;
    kept.delete(slot);
    keptBytes -= sizeOf(snap);
}

/** Evict the least recently used until the kept rosters fit the budget. */
function fit(): void {
    for (const slot of kept.keys()) {
        if (keptBytes <= settings.byteBudget) return;
        drop(slot);
    }
}

/** Keep `bodyStr` as `slot`'s snapshot for `key`, replacing the slot's last one. */
export function storeRosterSnapshot(slot: string, key: string, view: RosterView, bodyStr: string, now = Date.now()): RosterSnapshot {
    const body = Buffer.from(bodyStr, 'utf8');
    const digest = createHash('sha256').update(body).digest('base64url').slice(0, 12);
    const snap: RosterSnapshot = { key, builtAt: now, body, etag: `W/"roster-${view}-${digest}"`, gzip: null };
    builds++;
    drop(slot);
    if (body.length > settings.byteBudget) return snap;
    kept.set(slot, snap);
    keptBytes += body.length;
    fit();
    return snap;
}

/**
 * After a send that may have made the gzip copy (sendMembersSnapshot): count it, and evict to fit. A snapshot no longer
 * kept (evicted while it was sent, or never kept) holds nothing here.
 */
export function noteRosterSent(slot: string, snap: RosterSnapshot, sizeBefore: number): void {
    if (kept.get(slot) !== snap) return;
    keptBytes += sizeOf(snap) - sizeBefore;
    fit();
}

export { sizeOf as rosterSnapshotSize };

/** What the kept rosters hold, and how many there are (tests). */
export function rosterSnapshotsHeld(): { bytes: number; count: number; builds: number } {
    return { bytes: keptBytes, count: kept.size, builds };
}

/** Tests only: other limits, and nothing kept. `undefined` puts the defaults back. */
export function setRosterSnapshotsForTests(overrides: Partial<typeof settings> | undefined): void {
    settings = { maxAgeMs: MAX_AGE_MS, byteBudget: BYTE_BUDGET, ...(overrides ?? {}) };
    kept.clear();
    keptBytes = 0;
    builds = 0;
}
