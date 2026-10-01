/**
 * The door: who may bring someone into this community (community modes, slice 1;
 * scratch/global-node/DESIGN-community-modes-fable.md §3, §5 and §8 item 1, Marty's answers 2026-10-01). It is one of
 * the two dials; the other, confirming members against a names list, is a later slice.
 *
 *   - `members`: any member makes an invite (a code, a QR, an offline ticket) and answers a request to join. Every
 *     local community until now, and the default: a node with no setting is this, so nothing changes for anyone on
 *     upgrade. Settings calls it "Invite".
 *   - `admins`: only the community's owners and admins (node_roles) do. Settings calls it "Known", in plain words
 *     "only admins invite", until the names list exists.
 *   - `open`: anyone joins through the open door with one sign-in, and nobody makes an invite: the global node, whose
 *     profile has the open door on and invites off (config/node-profile.ts, #1391). Never stored and never set from
 *     Settings: it is what a node reports when its profile opens the door and takes no invites.
 *
 * ## Why a local community can't be `open`
 *
 * Open means anyone with a sign-in is a member at once. On a community with Beans that hands credit to strangers on
 * day one, and the profile already keeps the open door shut wherever the ledger has moved (node-profile.ts). Open is
 * for a node with Beans off (design §3.1: "Credit it can safely give: none"), so Settings refuses it (409), says why,
 * and a community chooses between the two doors above.
 *
 * ## What `admins` changes (each path that registers a member through an invite or a knock)
 *
 *   - A member's new invite code (`POST /api/invite/generate`, engine/invites.ts generateInvite): refused, 403
 *     `admins_only`, before any limit is counted or anything written. An owner's or admin's works as before.
 *   - Answering a request to join (engine/knocks.ts approveKnock, declineKnock): only an owner or admin, 403
 *     `admins_only`; the list of requests is theirs to read too (routes/knocks.ts), so a member's app shows none.
 *   - An offline ticket (redeemOfflineTicket): made on a phone and first seen here when someone joins with it, so the
 *     date it carries is its maker's own claim. A ticket made by a member is refused whenever it says it was made; one
 *     made by an owner or admin joins as before. The pre-flight check (`GET /api/invite/check`) says the same first.
 *   - A code made before the door closed (a member's, or a knock's answer): still joins, until it lapses 30 days after
 *     it was made. The node made it under the rule of the day (design §5: "outstanding invites keep working until they
 *     expire"), and wrote when.
 *   - The seed invite (`POST /api/admin/seed-invite`): an owner's or admin's on every door, so unchanged.
 *
 * Tiers gate nothing: this is the community's choice of who brings people in, by role, never a tier.
 *
 * ## What travels
 *
 * The setting is a node_config row (`door`), one of the community's own settings (config/community-settings.ts): a
 * standby keeps the main server's in every copy, and a take-over or a hand promotion installs it. A file or sealed
 * backup is the whole database, so it carries the row.
 */
import { db } from '../db/db.js';
import { getProfileSwitches } from './node-profile.js';
import { isNodeAdmin } from '../engine/node-roles.js';

export type Door = 'open' | 'members' | 'admins';
/** The doors a community chooses between, and the only values ever stored. */
export type CommunityDoor = Exclude<Door, 'open'>;

export const DOOR_KEY = 'door';
export const DEFAULT_DOOR: CommunityDoor = 'members';

export function isCommunityDoor(v: unknown): v is CommunityDoor {
    return v === 'members' || v === 'admins';
}

let warnedBadRow: string | null = null;

/**
 * The door Settings chose: the row, or `members` when there is none. A row holding anything else reads as `members`,
 * today's door, and the log says so once: the community's behaviour never becomes something nobody chose.
 */
export function configuredDoor(): CommunityDoor {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(DOOR_KEY) as { value: string | null } | undefined;
    const value = row?.value ?? null;
    if (value === null || isCommunityDoor(value)) return value ?? DEFAULT_DOOR;
    if (warnedBadRow !== value) {
        warnedBadRow = value;
        console.warn(`⚠️  node_config door=${JSON.stringify(value)} is not a door (members or admins), so any member may invite here.`);
    }
    return DEFAULT_DOOR;
}

/** The door as it works here now: `open` where the profile opens the door and takes no invites, else the setting. */
export function getDoor(): Door {
    const s = getProfileSwitches();
    if (s.openJoin && !s.invites) return 'open';
    return configuredDoor();
}

/** Whether `pubkey` may invite and answer requests to join here, by the door. Members' standing is checked by the caller. */
export function mayInviteHere(pubkey: string): boolean {
    return getDoor() !== 'admins' || isNodeAdmin(pubkey);
}

export const ADMINS_ONLY = 'admins_only';
export const ADMINS_ONLY_INVITE_MESSAGE = 'In this community only its admins invite people. Ask an admin to bring them in.';
export const ADMINS_ONLY_ANSWER_MESSAGE = 'In this community only its admins see and answer requests to join.';
export const ADMINS_ONLY_TICKET_MESSAGE = 'This invite was made by a member, and in this community only its admins bring people in now. Ask an admin for a fresh invite.';

export class DoorClosedError extends Error {
    readonly code = ADMINS_ONLY;
    readonly status = 403;
    constructor(message: string = ADMINS_ONLY_INVITE_MESSAGE) {
        super(message);
        this.name = 'DoorClosedError';
    }
}

/** Throws DoorClosedError when the door is `admins` and `pubkey` is no owner or admin here. */
export function assertMayInviteHere(pubkey: string): void {
    if (!mayInviteHere(pubkey)) throw new DoorClosedError();
}

export const OPEN_DOOR_REFUSED = 'A community with Beans can’t open its door to anyone with a sign-in: strangers would hold credit from their first day. '
    + 'Only a node with Beans off, like the global community, has an open door, and its profile sets that. Choose who invites: any member, or only admins.';
export const DOOR_SET_BY_PROFILE = 'Anyone joins this node with a sign-in, and nobody makes invites here. Its profile sets that, so there is no door to choose.';

/** Why the door can't be set to `door` here, or null when it can. */
export function doorSettingRefusal(door: unknown): { status: number; error: string; code: string } | null {
    if (door === 'open') return { status: 409, error: OPEN_DOOR_REFUSED, code: 'door_open_refused' };
    if (!isCommunityDoor(door)) return { status: 400, error: "door must be 'members' or 'admins'", code: 'bad_door' };
    if (getDoor() === 'open') return { status: 409, error: DOOR_SET_BY_PROFILE, code: 'door_set_by_profile' };
    return null;
}

/**
 * Set the door. The default removes the row instead, so the record holds only what a community changed, and a copy
 * of it installs "none" as the default. Check doorSettingRefusal first.
 */
export function setDoor(door: CommunityDoor): void {
    if (!isCommunityDoor(door)) throw new Error(`${String(door)} is not a door`);
    if (door === DEFAULT_DOOR) db.prepare('DELETE FROM node_config WHERE key = ?').run(DOOR_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(DOOR_KEY, door);
}
