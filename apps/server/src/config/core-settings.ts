/**
 * Core settings: set once, when a community starts, then locked (scratch/fable-design/DESIGN-core-settings-fable.md §2,
 * §8.1-§8.3; slice C1, the server half; Marty accepted the design's five answers on 31 Oct 2026).
 *
 * Seven of the settings How this community works holds are the community's foundations: members joined under them, a
 * change to them is one-way, or they are money (design §1.2). An owner confirms them once ("Confirm and lock", POST
 * /api/local/admin/community-shape with `lock: true`), which writes one row, `core_settings_lock`. After that, a change to
 * any of them asks the owner's fresh proof every time (admin-auth.ts requireFreshProof: the phone's unlock within 90 s
 * of Manage, or a current authenticator code with the password; never an automation token, never a break-glass code),
 * is logged with a `core.unlock` line before its own, and every owner is alerted. The group never leaves the locked
 * state: there is no unlocked mode and no way to remove the row (design Q2).
 *
 * Until an owner confirms, nothing changes: the node runs on what is set, and every change is as before (no proof), so
 * older apps and every live node keep working exactly as they did.
 *
 * The row travels to standbys with the community's other rows (config/community-settings.ts), so a promoted standby is
 * locked from its first boot as a main server.
 *
 * Marty, 31 Oct 2026 (register CORE-SETTINGS): the community's place is mandatory in the walkthrough, by the kind of
 * server. A local community confirms only once its place is set (Node Identity's map pin); the global kind is the lobby,
 * not a place on the map (community-shape.ts listedByKind), and confirms without one.
 */
import { db } from '../db/db.js';
import { getNodeConfig } from '../state-engine.js';
import { getLocalConfig } from './local-config.js';
import type { NodeProfile } from './node-profile.js';
import type { CommunityDoor } from './door.js';

/** The node_config row the lock is (one of the community's rows: config/community-settings.ts). */
export const CORE_SETTINGS_LOCK_KEY = 'core_settings_lock';

/** The Core settings, in the shape's names (config/community-shape.ts); every other setting there is everyday. */
export const CORE_SETTINGS = ['join', 'wordsDoor', 'beans', 'knownFloor', 'decisions', 'shareOutside', 'recoveryCopies'] as const;
export type CoreSettingName = (typeof CORE_SETTINGS)[number];

export const isCoreSettingName = (s: string): s is CoreSettingName => (CORE_SETTINGS as readonly string[]).includes(s);

/** The lock as stored: when, and who (the key behind the session, or `owner:password`). */
export interface CoreLock { at: string | null; by: string | null }

/** The longest `by` a row may carry: a key is 64 characters, `owner:password` fewer. */
const BY_MAX = 100;
const isIsoInstant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/** A row's value as the lock it is, or null when it isn't one (`at` an instant, `by` a short string). */
export function parseCoreLockRow(value: unknown): CoreLock | null {
    if (typeof value !== 'string' || value.length > 400) return null;
    let v: unknown;
    try { v = JSON.parse(value); } catch { return null; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const { at, by } = v as { at?: unknown; by?: unknown };
    if (!isIsoInstant(at) || typeof by !== 'string' || by.length === 0 || by.length > BY_MAX) return null;
    return { at, by };
}

let warnedBadRow: string | null = null;

/**
 * The lock a stored row says (null: no row, never confirmed). A row that isn't one still locks, when and by whom
 * unknown: the row is there because an owner confirmed, and reading it as unlocked would drop the proof (fail closed).
 */
export function coreLockFromRow(value: string | null): CoreLock | null {
    if (value === null) return null;
    const lock = parseCoreLockRow(value);
    if (lock) return lock;
    if (warnedBadRow !== value) {
        warnedBadRow = value;
        console.warn(`⚠️  node_config ${CORE_SETTINGS_LOCK_KEY} is not a lock ({ at, by }): the core settings read as locked all the same.`);
    }
    return { at: null, by: null };
}

/** The row an owner's Confirm and lock writes. */
export function coreLockRow(at: string, by: string): string {
    return JSON.stringify({ at, by });
}

/** This server's own row (a standby's copy of its main server's is read by community-shape.ts). */
export function ownCoreLockRow(): string | null {
    const r = db.prepare('SELECT value FROM node_config WHERE key = ?').get(CORE_SETTINGS_LOCK_KEY) as { value: string | null } | undefined;
    return r?.value ?? null;
}

/**
 * Whether a planned change of `setting` (a shape setting, or a known-floor line `knownFloor.<part>`) to `to` is a Core
 * change (design §8.2). Who can join is two things in one setting: the door (Core) and the pause (everyday). A change
 * to a door other than the one stored (`doorBefore`) is Core; pausing, and un-pausing to the door it had, are not. Any
 * line of the known floor is Core, whichever of the dial, the floor and the cap moves.
 */
export function isCoreChange(setting: string, to: string, doorBefore: CommunityDoor): boolean {
    const base = setting.split('.')[0];
    if (base === 'join') return to !== 'paused' && to !== doorBefore;
    return isCoreSettingName(base);
}

/** Whether this kind of server needs its place before its core settings are confirmed (Marty, 31 Oct). */
export const placeNeededFor = (kind: NodeProfile): boolean => kind !== 'global';

const isPlace = (p: unknown): boolean => {
    if (!p || typeof p !== 'object') return false;
    const { lat, lng } = p as { lat?: unknown; lng?: unknown };
    return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
        && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
};

/** Whether this server has the community's place: the service area's centre, or the node's own place (community-place.ts). */
export function placeIsSet(): boolean {
    return isPlace(getNodeConfig().serviceRadius) || isPlace(getLocalConfig().location);
}
