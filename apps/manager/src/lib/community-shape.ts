/**
 * How this community works: client model and helpers (scratch/fable-design/DESIGN-community-shape-settings-fable.md).
 * Reads GET /api/local/admin/community-shape (slice S1) and writes POST /api/local/admin/community-shape (slice S2).
 */
import { buildAdminHeaders, passwordField, resolveNodeApiUrl } from './node-client';
import { t } from './fresh-proof';

export type ShapeSource = 'owner' | 'profile' | 'default' | 'server';

export const SHAPE_LOCK_CODES = [
    'ledger_moved', 'private_preview', 'invites_off', 'beans_off', 'profile', 'server_env', 'held_back', 'schedule_never',
    'auth_hatch_open', 'open_membership', 'standby',
] as const;
export type ShapeLockCode = (typeof SHAPE_LOCK_CODES)[number];

export interface ShapeLock {
    code: ShapeLockCode;
    why: string;
    unlock?: string;
}

export interface ShapeSetting<T> {
    value: T;
    configured: T;
    source: ShapeSource;
    lock: ShapeLock | null;
}

export type JoinState = 'members' | 'admins' | 'paused' | 'open';
export type VisitorsView = 'nothing' | 'listings' | 'open';
export interface KnownFloorShape {
    on: boolean;
    floor: number;
    cap: number;
    capMax: number;
}

export interface ShapeSettings {
    join: ShapeSetting<JoinState>;
    openDoor: ShapeSetting<boolean>;
    wordsDoor?: ShapeSetting<boolean>;
    knocks: ShapeSetting<boolean>;
    preview: ShapeSetting<boolean>;
    beans: ShapeSetting<boolean> & {
        includes: { escrow: boolean; enterprises: boolean; treasuries: boolean; crowdfund: boolean };
    };
    knownFloor: ShapeSetting<KnownFloorShape>;
    dmRequests?: ShapeSetting<boolean>;
    decisions: ShapeSetting<boolean>;
    listed: ShapeSetting<boolean>;
    shareLocation: ShapeSetting<boolean>;
    shareMemberCount: ShapeSetting<boolean>;
    shareEmail: ShapeSetting<boolean>;
    sharePhone: ShapeSetting<boolean>;
    shareHealth: ShapeSetting<boolean>;
    visitors: ShapeSetting<VisitorsView>;
    probation: ShapeSetting<boolean>;
    autoHide: ShapeSetting<boolean>;
    autoMute: ShapeSetting<boolean>;
    connections: ShapeSetting<boolean>;
}

export interface KindOnlySetting extends ShapeSetting<boolean> {
    id: string;
}

export interface ShapeLogLine {
    id: string;
    kept: 'community_settings_log' | 'known_floor_log';
    at: string;
    actor: string;
    actorCallsign: string | null;
    actorRole: string | null;
    setting: string;
    from: string | null;
    to: string | null;
    note: string | null;
}

export interface Shape {
    kind: 'local' | 'global';
    standby: boolean;
    copiedAt?: string | null;
    version: number;
    settings: ShapeSettings;
    kindOnly: KindOnlySetting[];
    log: ShapeLogLine[];
}

/** 40 Beans is an hour of work (PROTOCOL_CONSTANTS.REFERENCE_RATE). */
export const BEANS_PER_HOUR = 40;

export function hoursWording(beans: number): string {
    const hours = Math.round(beans / BEANS_PER_HOUR);
    return `${beans.toLocaleString('en')} Beans is about ${hours.toLocaleString('en')} ${hours === 1 ? 'hour' : 'hours'} of work the community is trusting you for.`;
}

export const DOOR_PRESETS: ReadonlyArray<{ door: 'members' | 'admins'; name: string; plain: string; detail: string }> = [
    {
        door: 'members',
        name: 'Invite',
        plain: 'any member invites',
        detail: 'Any member can make an invite, from the app or the web app, and answer a request to join. This is how every community starts.',
    },
    {
        door: 'admins',
        name: 'Known',
        plain: 'only admins invite',
        detail: 'Only owners and admins can make invites and answer requests to join. Members are told to ask an admin, and their app shows no invite to make. '
            + 'Owners and admins can also keep a names list of who the members are: it opens in the BeanPool app on their own phones, signed in with their key, not with this password.',
    },
];

export function readDoor(v: unknown): 'open' | 'members' | 'admins' | null {
    return v === 'open' || v === 'members' || v === 'admins' ? v : null;
}

export function readJoinLock(v: unknown): { why: string; unlock?: string } | null {
    if (v === null || v === undefined) return null;
    const l = (typeof v === 'object' ? v : {}) as { why?: unknown; unlock?: unknown };
    const why = typeof l.why === 'string' && l.why.trim() ? l.why : 'This node takes no change to who may invite right now.';
    return typeof l.unlock === 'string' && l.unlock.trim() ? { why, unlock: l.unlock } : { why };
}

export function doorChangeConsequence(from: 'members' | 'admins', to: 'members' | 'admins'): string {
    if (to === 'admins' && from === 'members') {
        return t('Members will stop being able to make invites or answer requests to join. Codes already made still work until they expire, 30 days after they were made. A paper ticket a member made will no longer let anyone in.');
    }
    return t('Every member will be able to make invites and answer requests to join again.');
}

export function unpauseConsequence(to: 'members' | 'admins'): string {
    return to === 'admins'
        ? t('New members will be taken again: only owners and admins can make invites and answer requests to join.')
        : t('New members will be taken again: every member can make invites and answer requests to join.');
}

export interface KnownFloorSettings {
    confirmation: boolean;
    knownFloor: number;
    creditCap: number;
    creditCapDefault: number;
    creditCapMax: number;
}

export function readKnownFloorSettings(v: unknown): KnownFloorSettings | null {
    const o = v as Partial<KnownFloorSettings> | null;
    if (!o || typeof o.confirmation !== 'boolean' || !Number.isInteger(o.knownFloor) || !Number.isInteger(o.creditCap)) return null;
    return {
        confirmation: o.confirmation,
        knownFloor: o.knownFloor!,
        creditCap: o.creditCap!,
        creditCapDefault: Number.isInteger(o.creditCapDefault) ? o.creditCapDefault! : 2000,
        creditCapMax: Number.isInteger(o.creditCapMax) ? o.creditCapMax! : 5000,
    };
}

export function readShapeKnownFloor(shape: unknown, before: KnownFloorSettings): KnownFloorSettings | null {
    const v = (shape as { settings?: { knownFloor?: { value?: { on?: unknown; floor?: unknown; cap?: unknown; capMax?: unknown } } } } | null)
        ?.settings?.knownFloor?.value;
    return v ? readKnownFloorSettings({ confirmation: v.on, knownFloor: v.floor, creditCap: v.cap, creditCapDefault: before.creditCapDefault, creditCapMax: v.capMax }) : null;
}

/**
 * Fetch the community shape from GET /api/local/admin/community-shape.
 */
export async function fetchCommunityShape(
    nodeUrl: string,
    credential?: string,
    tfaToken?: string,
): Promise<Shape> {
    const url = resolveNodeApiUrl(nodeUrl, '/api/local/admin/community-shape');
    const res = await fetch(url, {
        headers: buildAdminHeaders(credential, tfaToken),
        credentials: 'same-origin',
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
}

/**
 * Submit changes to POST /api/local/admin/community-shape.
 * Folded fix 2: one save writes one change (§7's S4 row).
 */
export async function updateCommunityShape(
    nodeUrl: string,
    credential: string | undefined,
    changes: Record<string, unknown>,
    note?: string,
    tfaToken?: string,
): Promise<{ shape: Shape; told: 'members' | 'nobody' }> {
    const keys = Object.keys(changes);
    if (keys.length !== 1) {
        throw new Error('A save writes exactly one change: never send multiple changes in one request.');
    }
    const url = resolveNodeApiUrl(nodeUrl, '/api/local/admin/community-shape');
    const res = await fetch(url, {
        method: 'POST',
        headers: buildAdminHeaders(credential, tfaToken),
        credentials: 'same-origin',
        body: JSON.stringify({
            ...passwordField(credential),
            changes,
            ...(note && note.trim() ? { note: note.trim() } : {}),
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err: any = new Error(body.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = body.code;
        err.setting = body.setting;
        err.unlock = body.unlock;
        throw err;
    }
    return body;
}

/**
 * Consequence sentence for a planned change.
 * Folded fix 1: where the open door is set and Beans are on and the ledger never moved,
 * switching Beans off is ONE-WAY (the read model's profile lock then refuses Beans on).
 */
export function getConsequenceSentence(
    setting: keyof ShapeSettings,
    targetValue: unknown,
    currentShape: Shape,
): string {
    const s = currentShape.settings;
    switch (setting) {
        case 'join': {
            const v = targetValue as JoinState;
            const wasPaused = s.join.value === 'paused' || s.join.configured === 'paused';
            if (wasPaused && (v === 'members' || v === 'admins')) {
                return unpauseConsequence(v);
            }
            if (v === 'admins') {
                return doorChangeConsequence('members', 'admins');
            }
            if (v === 'paused') {
                return t("Nobody new will join until you change this. Codes already made won't work while it's paused.");
            }
            if (v === 'members') {
                return doorChangeConsequence('admins', 'members');
            }
            return '';
        }
        case 'knocks':
            return targetValue === false
                ? t("Nobody can ask to join, and members stop seeing requests. Requests already waiting stay until it's on again.")
                : t('People who find this community can ask to join; a member answers with an invite.');
        case 'beans': {
            if (targetValue === false) {
                // Folded fix 1:
                const openDoorSet = s.openDoor.configured;
                if (openDoorSet) {
                    return t("No prices, sends, escrow, enterprises or crowdfunding. Switching Beans off is one-way: while the open door is set, Beans cannot be switched back on.");
                }
                return t("No prices, sends, escrow, enterprises or crowdfunding. You can't switch Beans off once anyone has traded.");
            }
            return t('Members get a credit line as they trade, and posts can carry a price.');
        }
        case 'knownFloor': {
            const kf = targetValue as { on?: boolean; floor?: number; cap?: number };
            if (kf.on === false) {
                return t('Confirmed members go back to the credit they have earned. Anyone below it is spend-frozen, never charged.');
            }
            const floor = kf.floor ?? s.knownFloor.value.floor;
            return t('Confirmed members can owe up to {floor} Beans while they keep an offer listed.').replace('{floor}', floor.toLocaleString('en'));
        }
        case 'dmRequests':
            return targetValue === true
                ? t("A member's first message to someone who hasn't added them, written to them or traded with them waits until that person accepts.")
                : t('Every message arrives straight away. Requests still waiting become ordinary chats.');
        case 'decisions':
            return targetValue === false
                ? t('Nothing can be proposed or voted on. Open votes close. An emergency suspension lifts by itself after 7 days.')
                : t('Members who have completed a trade, and admins, propose; members vote.');
        case 'listed':
            return targetValue === false
                ? t('This community comes off the directory and the map on beanpool.org at once; nothing new is sent.')
                : t('People nearby can find this community on beanpool.org and in the app.');
        case 'shareLocation':
            return targetValue === false
                ? t('Only members will see roughly where your community is.')
                : t('Anyone will be able to see roughly where your community is (to about a kilometre) on the map and in the directory.');
        case 'shareMemberCount':
            return targetValue === false
                ? t('The directory will no longer show how many members this community has.')
                : t('The directory will show how many members this community has.');
        case 'shareEmail':
            return targetValue === false
                ? t('Your contact email will no longer be listed in the public directory.')
                : t('Your contact email will be listed in the public directory and on the map, where anyone can read it.');
        case 'sharePhone':
            return targetValue === false
                ? t('Your contact phone will no longer be listed in the public directory.')
                : t('Your contact phone will be listed in the public directory and on the map, where anyone can read it.');
        case 'shareHealth':
            return targetValue === false
                ? t('Node health and version diagnostics will no longer be shared.')
                : t('Node health and version diagnostics will be shared with the BeanPool team for monitoring.');
        case 'probation':
            return targetValue === true
                ? t('New members get the limits for 3 days, or 7 with 12 words: 3 posts, 5 photos, 10 new people messaged a day.')
                : t('New members will have no daily limits on posts, photos or messages.');
        case 'autoHide':
            return targetValue === true
                ? t('Reports from three independent groups will hide a post until a moderator looks.')
                : t('Reported posts will stay visible until a moderator reviews them.');
        case 'autoMute':
            return targetValue === true
                ? t('Three posts removed in 30 days will stop a member posting and messaging until a moderator lifts it.')
                : t('Members will not be muted automatically after multiple removals.');
        case 'wordsDoor':
            return targetValue === true
                ? t('People will be able to join with 12 secret words without a sign-in.')
                : t('People will join with a sign-in only.');
        default:
            return '';
    }
}
