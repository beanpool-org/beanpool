/**
 * How this community works: client model and helpers (scratch/fable-design/DESIGN-community-shape-settings-fable.md).
 * Reads GET /api/local/admin/community-shape (slice S1) and writes POST /api/local/admin/community-shape (slice S2).
 */
import { buildAdminHeaders, passwordField, resolveNodeApiUrl } from './node-client';
import { t, proofField, throwIfFreshProof } from './fresh-proof';

export type ShapeSource = 'owner' | 'profile' | 'default' | 'server';

export const SHAPE_LOCK_CODES = [
    'ledger_moved', 'private_preview', 'invites_off', 'beans_off', 'profile', 'server_env', 'held_back', 'schedule_never',
    'auth_hatch_open', 'open_membership', 'standby', 'pool_too_small',
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
/** Where members' copies go (apps/server config/recovery-copies.ts, vault rethink VR2). */
export type RecoveryCopies = 'vault' | 'server' | 'none';
/** Who decides a removal (apps/server config/removal-decider.ts, DESIGN-removal-jury-fable.md §6). */
export type RemovalDecider = 'automatic' | 'everyone' | 'jury';
export interface KnownFloorShape {
    on: boolean;
    floor: number;
    cap: number;
    capMax: number;
}

export interface ShapeSettings {
    /** `door`: the door the community stores, paused or not: what un-pausing goes back to (server C1, core settings). */
    join: ShapeSetting<JoinState> & { door?: 'members' | 'admins' };
    openDoor: ShapeSetting<boolean>;
    wordsDoor?: ShapeSetting<boolean>;
    doorCheck?: ShapeSetting<boolean>;
    knocks: ShapeSetting<boolean>;
    preview: ShapeSetting<boolean>;
    beans: ShapeSetting<boolean> & {
        includes: { escrow: boolean; enterprises: boolean; treasuries: boolean; crowdfund: boolean };
    };
    knownFloor: ShapeSetting<KnownFloorShape>;
    dmRequests?: ShapeSetting<boolean>;
    decisions: ShapeSetting<boolean>;
    /** Members may share one post outside the community (front doors S6). Absent on a server from before it. */
    shareOutside?: ShapeSetting<boolean>;
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
    /** Absent on a node from before the rule: there every copy goes where each app's build sends it. */
    recoveryCopies?: ShapeSetting<RecoveryCopies>;
    /**
     * Who decides a removal (removal jury). `lock` (pool_too_small) refuses only A jury, while fewer than 36 could serve;
     * `poolSize` is how many could serve today. Absent on a node from before the jury.
     */
    removalDecider?: ShapeSetting<RemovalDecider> & { poolSize: number };
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

/**
 * Core settings (server config/core-settings.ts; DESIGN-core-settings-fable.md §8.2). Absent on a server from before them:
 * the page then shows every Core row as it always did, with no lock.
 */
export interface CoreShape {
    settings: string[];
    lock: { at: string | null; by: string | null; byCallsign: string | null } | null;
    place?: { needed: boolean; set: boolean };
}

export interface Shape {
    kind: 'local' | 'global';
    standby: boolean;
    copiedAt?: string | null;
    version: number;
    settings: ShapeSettings;
    core?: CoreShape;
    kindOnly: KindOnlySetting[];
    log: ShapeLogLine[];
}

/**
 * The Core settings, in the shape's names. The server sends its own list (`core.settings`); this one is the page's, and
 * lib/community-shape.test.ts holds the two equal. Everything else on the shape is everyday and lives where it is used.
 */
export const CORE_SETTINGS = ['join', 'wordsDoor', 'beans', 'knownFloor', 'decisions', 'shareOutside', 'recoveryCopies'] as const;
export type CoreSettingKey = (typeof CORE_SETTINGS)[number];
export const isCoreSetting = (k: string): k is CoreSettingKey => (CORE_SETTINGS as readonly string[]).includes(k);

/** The three one-way changes: once locked, Save waits until this word is typed (design §4.2). */
export function typedWordFor(setting: string, to: unknown): string | null {
    if (setting === 'beans' && to === false) return 'off';
    if (setting === 'shareOutside' && to === false) return 'stop';
    if (setting === 'recoveryCopies' && to === 'none') return 'nowhere';
    return null;
}

/** Whether an owner has confirmed and locked the core settings. A server from before them says nothing: not locked. */
export const coreLocked = (shape: Shape | null | undefined): boolean => Boolean(shape?.core?.lock);
/**
 * What the menu's "!" on Core settings means: an OWNER, on the main server (not a standby), on a server that has the core
 * block (not one from before it), whose core settings are not confirmed and locked yet. Admins never see it.
 */
export const coreAwaitsOwner = (shape: Shape | null | undefined, isOwner: boolean): boolean =>
    isOwner && Boolean(shape) && !shape!.standby && Boolean(shape!.core) && !shape!.core!.lock;

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

/**
 * The three choices for where members' copies go, each with the honest words under it (design DESIGN-vault-rethink-fable.md
 * §5.3, VR2). A copy is a member's key, and their 12 words, locked to a sign-in they link, so the sign-in brings the
 * account back on a new phone. The community path (VR3, VR4) is said too, in each choice that has it: half here under the
 * key vault, whole here under this server.
 */
export const RECOVERY_COPIES_CHOICES: ReadonlyArray<{ rule: RecoveryCopies; name: string; words: string }> = [
    {
        rule: 'vault',
        name: "BeanPool's key vault",
        words: "Members' sign-in copies are kept by BeanPool's key vault, a small server in Iceland, which BeanPool looks after and can open. Where a member lets your admins bring them back, your server keeps half of a locked copy and the vault the other half, and neither can open it alone. Nothing on your server needs the vault.",
    },
    {
        rule: 'server',
        name: 'This server',
        words: "Your server keeps members' copies. The people who run it can open them. If this server is lost, those copies are lost; members' 12 words still work.",
    },
    {
        rule: 'none',
        name: 'Nowhere',
        words: "This community keeps no copies and does not use BeanPool's key vault. Members' 12 words are their way back here, and an admin can re-key them to a new key. A copy a member made elsewhere is theirs: this community can't remove it.",
    },
];

/**
 * Who decides a removal, the three rules as an owner chooses them (DESIGN-removal-jury-fable.md §6, §9's manager row). Every
 * choice is kept as written; a vote already open keeps the rule it opened under.
 */
export const REMOVAL_DECIDER_CHOICES: ReadonlyArray<{ rule: RemovalDecider; name: string; words: string }> = [
    {
        rule: 'automatic',
        name: 'Automatic',
        words: 'A jury of 12 members, drawn at random, once 100 could serve on one (18 from 1,000); everyone who can vote until then.',
    },
    {
        rule: 'everyone',
        name: 'Everyone',
        words: 'Every member who can vote decides, however big the community grows: a quarter of those active must vote.',
    },
    {
        rule: 'jury',
        name: 'A jury',
        words: 'A jury of 12 members, drawn at random, from 36 who could serve on one. Fewer than that, and everyone decides.',
    },
];

/** A rule's short name, for the row and the log. */
export function removalDeciderName(rule: string): string {
    return REMOVAL_DECIDER_CHOICES.find((c) => c.rule === rule)?.name ?? rule;
}

/** A rule's short name, for the row and the log ("BeanPool's key vault", "This server", "Nowhere"). */
export function recoveryCopiesName(rule: string): string {
    return RECOVERY_COPIES_CHOICES.find((c) => c.rule === rule)?.name ?? rule;
}

/** The rule /api/community/info says (`recoveryCopies`), or null when the node doesn't say: one from before the rule. */
export function readRecoveryCopies(v: unknown): RecoveryCopies | null {
    return v === 'vault' || v === 'server' || v === 'none' ? v : null;
}

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
    code?: string,
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
            ...proofField(code),
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        // A locked Core change asks the owner's fresh proof: the page opens the FreshProofBox for it.
        throwIfFreshProof(res.status, body);
        throw shapeError(res.status, body);
    }
    return body;
}

function shapeError(status: number, body: any): Error {
    const err: any = new Error(body.error || `HTTP ${status}`);
    err.status = status;
    err.code = body.code;
    err.setting = body.setting;
    err.unlock = body.unlock;
    return err;
}

/**
 * Confirm and lock the core settings (POST community-shape with `lock: true`): the changes that differ from what the
 * community has now (none is fine) and the lock row, in one transaction. Asks no fresh proof: nothing is undone.
 * Refused with nothing written: 409 core_locked (already), 409 place_needed (a local community with no place yet).
 */
export async function confirmCoreSettings(
    nodeUrl: string,
    credential: string | undefined,
    changes: Record<string, unknown>,
    tfaToken?: string,
): Promise<{ shape: Shape; told: 'members' | 'nobody' }> {
    const url = resolveNodeApiUrl(nodeUrl, '/api/local/admin/community-shape');
    const res = await fetch(url, {
        method: 'POST',
        headers: buildAdminHeaders(credential, tfaToken),
        credentials: 'same-origin',
        body: JSON.stringify({ ...passwordField(credential), changes, lock: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw shapeError(res.status, body);
    return body;
}

/** The longest advice to the owners, in characters (server config/core-advice.ts ADVICE_MAX; the design's §5). */
export const ADVICE_MAX = 200;

/**
 * Advise the owners about one Core setting (POST community-shape/advice; DESIGN-core-settings-fable.md §5): an admin's
 * 200-character note, kept as a line in the Changes log and told to every owner as an alert. It changes nothing and asks no
 * proof. Answers the shape with the new line at the head of its log. The advice is a person's words: the page draws it as
 * text and nothing here reads it back to act on it.
 */
export async function adviseOwners(
    nodeUrl: string,
    credential: string | undefined,
    setting: string,
    advice: string,
    tfaToken?: string,
): Promise<{ shape: Shape; told: 'owners' }> {
    const url = resolveNodeApiUrl(nodeUrl, '/api/local/admin/community-shape/advice');
    const res = await fetch(url, {
        method: 'POST',
        headers: buildAdminHeaders(credential, tfaToken),
        credentials: 'same-origin',
        body: JSON.stringify({ ...passwordField(credential), setting, advice: advice.trim() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw shapeError(res.status, body);
    return body;
}

/**
 * Save the community's place (the walkthrough's mandatory step on a local community; the same route Node Identity uses).
 * Only when none is set yet: Node Identity is where a place already set is changed.
 */
export async function saveCommunityPlace(
    nodeUrl: string,
    credential: string | undefined,
    place: { lat: number; lng: number },
    tfaToken?: string,
): Promise<void> {
    const url = resolveNodeApiUrl(nodeUrl, '/api/local/admin/node/config');
    const res = await fetch(url, {
        method: 'POST',
        headers: buildAdminHeaders(credential, tfaToken),
        credentials: 'same-origin',
        body: JSON.stringify({ ...passwordField(credential), serviceRadius: { lat: place.lat, lng: place.lng, radiusKm: 0 } }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw shapeError(res.status, body);
    }
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
        case 'shareOutside':
            return targetValue === false
                ? t('Every link a member shared outside stops now, and nobody can share a new one. Turned on again, the old links stay stopped.')
                : t('A member can share one listing or event with someone outside: the link shows that post for 7 days, without names or faces.');
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
        case 'removalDecider': {
            const pool = s.removalDecider?.poolSize ?? 0;
            const rule = String(targetValue);
            const everyoneToday = rule === 'everyone' || (rule === 'automatic' && pool < 100) || (rule === 'jury' && pool < 36);
            const today = everyoneToday
                ? t('Today everyone who can vote would decide one ({n} could serve on a jury).')
                : t('Today a jury of 12 would decide one ({n} could serve on a jury).');
            return `${t('The next removal is decided this way; a vote already open keeps its rule. Every member is told.')} ${today.replace('{n}', pool.toLocaleString('en'))}`;
        }
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
        case 'doorCheck':
            return targetValue === true
                ? t('When lots of people are joining, a 12-words join will start with a Cloudflare check, if the keys are on the server. A sign-in never needs it.')
                : t('A 12-words join will never ask for a Cloudflare check.');
        case 'recoveryCopies':
            // Nothing moves by itself (design §5.3): each says what happens to copies already made, and the one thing this
            // server can't hold, a phone app from before the setting, which keeps sending its copies to the vault.
            return targetValue === 'none'
                ? t("No new copy is kept here, and this community's screens offer none. Copies already made stay until each member removes theirs. A phone app from before this setting still keeps new copies at the key vault until it is updated.")
                : targetValue === 'server'
                    ? t("A sign-in a member links keeps its copy on this server, locked with its recovery seal. A copy a member has at the key vault stays there until they move or remove it. A phone app from before this setting still keeps new copies at the key vault until it is updated.")
                    : t("A sign-in a member links in the phone app keeps its copy at BeanPool's key vault. Copies already kept on this server stay until each member moves or removes theirs.");
        default:
            return '';
    }
}
