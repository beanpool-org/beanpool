/**
 * How this community works: one read of its structural settings (scratch/fable-design/DESIGN-community-shape-settings-fable.md
 * §5, §6.1; slice S1). Who can join, Beans and the known floor, message requests, votes, being found, visitors, the safety
 * switches and connections, each as it is SET (`configured`), as the node really RUNS it (`value`), where the setting comes
 * from (`source`), and, where the value can't follow the setting or can't be changed by one, why, in the server's own words
 * (`lock`). The owners' page "How this community works" and, later, the members' card read it.
 *
 * A view over today's stores, never a store of its own: the profile switches and the operator's overrides
 * (config/node-profile.ts), the community's node_config rows (the door, the known floor) and the `node_config` object's
 * directory switches (config/community-settings.ts), and this server's env. Each value comes from the reader the node's own
 * gates use (getProfileSwitches, getNodeFeatures, doorFor, the engine's known-floor readers, directoryHeldBack), so the
 * shape can't say one thing while the node does another (test-community-shape-read.ts holds it to the gates for every
 * stored combination). Nothing here writes: the write path is slice S2, and every change it makes is a line in
 * `community_settings_log` (schema.sql), which `log` reads with the known floor's own community lines.
 *
 * ## Sources
 *   - `owner`: a choice this community stored: an override row (`nodeProfile.<switch>`), a door or known-floor row, a
 *     directory switch in the node_config object. Settings writes some of them today (the door, the known floor, requests
 *     to join, the directory switches); the operator writes the rest by hand.
 *   - `profile`: no override, so the default of the server's kind (NODE_PROFILE: local or global).
 *   - `default`: no row of the community's, so the default every community starts with.
 *   - `server`: this server's env (PRIVATE_PREVIEW, ENABLE_PEER_CONNECTORS), which no setting of the community's changes.
 *
 * ## Locks
 * Only what the code does today, each where the node would refuse or undo the change it names:
 *   - `ledger_moved`: Beans can't go off, nor the open door open, once the ledger has moved (node-profile.ts lockToLedger).
 *   - `private_preview`: the preview makes the door `admins`, takes no requests to join, shuts the open door and shows
 *     visitors nothing (private-preview.ts, door.ts, lockToPrivatePreview).
 *   - `invites_off`: no requests to join without invites (lockKnocksToInvites).
 *   - `beans_off`: no known floor without Beans (the engine's dial; setKnownFloorSettings refuses 409 `no_beans`).
 *   - `profile`: the open door and no invites leave no door to choose (doorSettingRefusal, 409 `door_set_by_profile`).
 *   - `server_env`: set in this server's env (the preview, connections, DIRECTORY_UNLISTED).
 *   - `held_back`, `schedule_never`: set to be listed, but nothing is sent (directory-publisher.ts: no name of its own, the
 *     address service's probation, the update schedule at Never).
 *   - `auth_hatch_open`: ENFORCE_READ_AUTH=false or ENFORCE_WS_AUTH=false open what only members should read.
 *   - `open_membership`: members on demand stays on while the whole directory is closed (lockOnDemandToOpenMembership).
 *   - `standby`: a standby never publishes to the directory.
 * Nothing is locked for being set by the server's kind alone: an operator's override changes those, and which of them an
 * owner may change on the page is the write path's to decide (the design's questions 1, 2, 5 and 12).
 *
 * ## On a standby
 * A standby keeps its main server's community rows as a copy it applies to nothing, while its own rows stay its own
 * (config/community-settings.ts), so the shape reads the copy: each row the copy names, over its own, as a take-over would
 * install them. The profile overrides are already the main server's (a standby keeps them as copied), and the env is this
 * server's. `copiedAt` says when the copy is from; null, there is none yet, and the rows are its own, which is what a
 * promotion would run with. Listed says a standby never publishes.
 *
 * Not here yet: the members' `knownFloor` in `features` (design §6.2), which waits on Marty's answer to the design's Q7.
 */
import { db } from '../db/db.js';
import { CREDIT_CAP_MAX } from '@beanpool/core';
import {
    CONFIRMATION_DIAL_KEY, KNOWN_FLOOR_KEY, CREDIT_CAP_KEY,
    confirmationDialFrom, confirmationDialSetFrom, savedCreditCapFrom, knownFloorFrom,
} from '@beanpool/engine';
import { getNodeConfig, type NodeConfig } from '../state-engine.js';
import { getNodeRole } from './node-role.js';
import {
    getNodeProfile, getConfiguredSwitches, getProfileSwitches, getNodeFeatures, readProfileOverrides, profileDefaults,
    ledgerHistory, guestViewAuthFlagsOff, type NodeProfile, type ProfileSwitch, type ProfileSwitches,
} from './node-profile.js';
import { isPrivatePreview, PRIVATE_PREVIEW_ENV } from './private-preview.js';
import { DOOR_KEY, doorFor, doorFromRow, isCommunityDoor, type CommunityDoor } from './door.js';
import { keptCommunitySettings, parseCommunitySettings } from './community-settings.js';
import {
    directoryHeldBack, directoryUnlistedByEnv, HELD_BACK_NAME_MESSAGE, HELD_BACK_PROBATION_MESSAGE, HELD_BACK_UNLISTED_MESSAGE,
    type DirectoryHoldBack,
} from '../services/directory-publisher.js';
import { ENABLE_PEER_CONNECTORS } from '../connector-manager.js';
import { adminActorName, COMMUNITY_ADMIN } from '../engine/admin-actor-name.js';

// ── The shape ──────────────────────────────────────────────────────────────────────────────

export type ShapeSource = 'owner' | 'profile' | 'default' | 'server';

export const SHAPE_LOCK_CODES = [
    'ledger_moved', 'private_preview', 'invites_off', 'beans_off', 'profile', 'server_env', 'held_back', 'schedule_never',
    'auth_hatch_open', 'open_membership', 'standby',
] as const;
export type ShapeLockCode = (typeof SHAPE_LOCK_CODES)[number];

/** Why a setting's value is what it is whatever is set, in the server's words, and what would change that, if anything. */
export interface ShapeLock { code: ShapeLockCode; why: string; unlock?: string }

export interface ShapeSetting<T> {
    /** What the node does now. */
    value: T;
    /** What the community's settings say. */
    configured: T;
    source: ShapeSource;
    lock: ShapeLock | null;
}

/** Who can join: any member invites, only admins do, nobody new for now (invites off), or anyone through the open door. */
export type JoinState = CommunityDoor | 'paused' | 'open';
/** What a visitor sees: nothing of the community's, the listings and their rough area, or what only members should. */
export type VisitorsView = 'nothing' | 'listings' | 'open';
export interface KnownFloorShape { on: boolean; floor: number; cap: number; capMax: number }

export interface ShapeSettings {
    join: ShapeSetting<JoinState>;
    openDoor: ShapeSetting<boolean>;
    /** The 12-words door beside the sign-in one: only where the open door is set on (it means nothing elsewhere). */
    wordsDoor?: ShapeSetting<boolean>;
    knocks: ShapeSetting<boolean>;
    preview: ShapeSetting<boolean>;
    /** `includes`: what holds Beans, each off with them (lockToLedger), never a switch of its own on the page (design Q9). */
    beans: ShapeSetting<boolean> & { includes: { escrow: boolean; enterprises: boolean; treasuries: boolean; crowdfund: boolean } };
    knownFloor: ShapeSetting<KnownFloorShape>;
    /** Message requests (#2392): only on a build that has the switch. */
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

/** A switch the server's kind sets for a lobby of strangers, listed only where it differs from a local community's. */
export interface KindOnlySetting extends ShapeSetting<boolean> { id: ProfileSwitch }

export interface ShapeLogLine {
    id: string;
    /** Which log the line is from: the shape's own, or the known floor's community-wide lines. */
    kept: 'community_settings_log' | 'known_floor_log';
    at: string;
    /** The key behind the session, or `owner:password`. */
    actor: string;
    /** Their callsign, for a member's key; null for the password and a key with none. */
    actorCallsign: string | null;
    actorRole: string | null;
    setting: string;
    from: string | null;
    to: string | null;
    note: string | null;
}

export interface Shape {
    kind: NodeProfile;
    standby: boolean;
    /** On a standby only: when its copy of the main server's settings is from, or null with none yet. */
    copiedAt?: string | null;
    /** The newest community_settings_log id (0 with none): what changed since a page last read it. */
    version: number;
    settings: ShapeSettings;
    kindOnly: KindOnlySetting[];
    /** The newest LOG_LINES changes, newest first. */
    log: ShapeLogLine[];
}

// ── Where each profile switch is read ──────────────────────────────────────────────────────

/** The switches no owner sets, read-only under "Set by this server's kind" (design §1.5). */
export const KIND_ONLY_SWITCHES = [
    'distanceSortDefault', 'directoryMirror', 'exampleListings', 'announceJoins', 'announceProfiles', 'nearbyListings',
    'membersOnDemand', 'showcase', 'openMembership', 'retention',
] as const satisfies readonly ProfileSwitch[];

/** Every profile switch, and the setting of the shape that reads it: a switch added later fails the suite until it has one. */
export const SHAPE_SWITCH_PLACES: Readonly<Record<ProfileSwitch | 'dmRequests', keyof ShapeSettings | 'kindOnly'>> = {
    openJoin: 'openDoor',
    ssoRequiredForJoin: 'wordsDoor',
    invites: 'join',
    knocks: 'knocks',
    beans: 'beans',
    escrow: 'beans',
    enterprises: 'beans',
    treasuries: 'beans',
    crowdfund: 'beans',
    dmRequests: 'dmRequests',
    decisions: 'decisions',
    publishToDirectory: 'listed',
    guestListingsOnly: 'visitors',
    probation: 'probation',
    autoHideReports: 'autoHide',
    autoMute: 'autoMute',
    ...Object.fromEntries(KIND_ONLY_SWITCHES.map((s) => [s, 'kindOnly' as const])) as Record<(typeof KIND_ONLY_SWITCHES)[number], 'kindOnly'>,
};

// ── The words of each lock ─────────────────────────────────────────────────────────────────

const UNLOCK_PREVIEW = `Turn the private preview off on the server (${PRIVATE_PREVIEW_ENV}).`;
const ASK_THE_SERVER = 'Ask whoever runs the server.';
const LOCK_WORDS = {
    beansStayOn: (history: string) => `Can't be turned off: Beans have moved here (${history}), and switching them off would freeze what members hold.`,
    doorStaysShut: (history: string) => `The open door stays shut: Beans have moved here (${history}), and open sign-up must never meet a live credit system.`,
    previewJoin: 'While the private preview is on, only owners and admins invite, and nobody can ask to join.',
    previewDoor: "While the private preview is on, the open door takes nobody: only an owner's or admin's invite gets in.",
    previewVisitors: 'While the private preview is on, a visitor sees nothing but its message.',
    invitesOff: 'Off while no new members are taken: a request to join is answered with an invite, and this community makes none.',
    unlockInvites: 'Take new members again, with any member or only admins inviting, and requests to join follow their own setting.',
    beansOffFloor: 'This community has no Beans, so it has no known floor.',
    openByKind: (profile: NodeProfile, words: boolean, fromOverrides: boolean) =>
        `Anyone joins with ${words ? '12 secret words or a sign-in' : 'a sign-in'}, and nobody makes invites: `
        + (fromOverrides ? "this server's own rows set that (nodeProfile.openJoin, nodeProfile.invites)" : `this server's kind (${profile}) sets that`)
        + '. Whoever runs the server changes it.',
    onTheServer: (env: string) => `Set on the server (${env}). ${ASK_THE_SERVER}`,
    scheduleNever: 'Set to be listed, but the directory update schedule is Never, so nothing is sent. Choose a schedule under Node Identity.',
    standbyListed: 'This server is a standby: it never publishes to the directory. The main server does.',
    openMembership: 'On while nobody can read the whole member directory (openMembership): the apps find people on demand.',
    hatchOpen: (flags: string[]) => `This server's settings open ${flags.map((f) => `${HATCH_WORDS[f] ?? f} (${f}=false)`).join(' and ')} to anyone. `
        + 'Nothing here can close that: ask whoever runs the server.',
};
const HATCH_WORDS: Record<string, string> = { ENFORCE_READ_AUTH: "members' reads", ENFORCE_WS_AUTH: 'the live feed of new posts' };
const HELD_BACK_WORDS: Record<DirectoryHoldBack, string> = {
    unnamed: HELD_BACK_NAME_MESSAGE, probation: HELD_BACK_PROBATION_MESSAGE, unlisted: HELD_BACK_UNLISTED_MESSAGE,
};

const lock = (code: ShapeLockCode, why: string, unlock?: string): ShapeLock => (unlock ? { code, why, unlock } : { code, why });

// ── The community's rows ───────────────────────────────────────────────────────────────────

const DIRECTORY_FIELDS = ['publishLocation', 'publishMembers', 'publishContactEmail', 'publishContactPhone', 'publishHealth', 'directoryPushIntervalHours'] as const;
type DirectoryField = (typeof DIRECTORY_FIELDS)[number];
type Directory = Required<Pick<NodeConfig, DirectoryField>>;

/** The community's own rows the shape reads: on a main server its own, on a standby its copy of the main server's. */
interface CommunityRows {
    door: string | null;
    confirmation: string | null;
    knownFloor: string | null;
    creditCap: string | null;
    directory: Directory;
    /** The directory switches the community stored; the rest read as their defaults. */
    stored: ReadonlySet<DirectoryField>;
}

function row(key: string): string | null {
    const r = db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string | null } | undefined;
    return r?.value ?? null;
}

function ownRows(): CommunityRows {
    const n = getNodeConfig();
    let raw: Record<string, unknown> = {};
    try { raw = JSON.parse(row('node_config') ?? '{}') ?? {}; } catch { /* getNodeConfig reads it as the defaults too */ }
    return {
        door: row(DOOR_KEY),
        confirmation: row(CONFIRMATION_DIAL_KEY),
        knownFloor: row(KNOWN_FLOOR_KEY),
        creditCap: row(CREDIT_CAP_KEY),
        directory: Object.fromEntries(DIRECTORY_FIELDS.map((f) => [f, n[f]])) as Directory,
        stored: new Set(DIRECTORY_FIELDS.filter((f) => raw && typeof raw === 'object' && f in raw)),
    };
}

/** A standby's: each row its copy names, over its own (config/community-settings.ts installCommunitySettings). */
function standbyRows(): { rows: CommunityRows; copiedAt: string | null } {
    const own = ownRows();
    const kept = keptCommunitySettings();
    const parsed = kept ? parseCommunitySettings(kept.record) : null;
    if (!kept || !parsed) return { rows: own, copiedAt: null };
    const nc = parsed.record.nodeConfig as Record<string, string | null | undefined>;
    const dir = parsed.record.directory as Partial<Record<DirectoryField, unknown>>;
    const copied = (key: string, mine: string | null) => (key in nc ? nc[key] ?? null : mine);
    const directory = { ...own.directory };
    const stored = new Set(own.stored);
    for (const f of DIRECTORY_FIELDS) {
        if (dir[f] === undefined || dir[f] === null) continue;
        (directory as Record<string, unknown>)[f] = dir[f];
        stored.add(f);
    }
    // As a take-over installs them: a record from before the two contact switches were split publishes neither.
    for (const f of ['publishContactEmail', 'publishContactPhone'] as const) if (!(f in dir)) directory[f] = false;
    return {
        rows: {
            door: copied(DOOR_KEY, own.door),
            confirmation: copied(CONFIRMATION_DIAL_KEY, own.confirmation),
            knownFloor: copied(KNOWN_FLOOR_KEY, own.knownFloor),
            creditCap: copied(CREDIT_CAP_KEY, own.creditCap),
            directory,
            stored,
        },
        copiedAt: kept.copiedAt ?? null,
    };
}

// ── The log ────────────────────────────────────────────────────────────────────────────────

export const LOG_LINES = 50;
/** The known floor's community-wide lines, as the shape's settings: a member's exception or the health lines are not. */
const KNOWN_FLOOR_ACTIONS: Record<string, string> = { confirmation: 'knownFloor.on', known_floor: 'knownFloor.floor', credit_cap: 'knownFloor.cap' };

function callsignOf(actor: string): string | null {
    const name = adminActorName(actor);
    return name === COMMUNITY_ADMIN ? null : name;
}

function readLog(): ShapeLogLine[] {
    const shapeLines = (db.prepare(`SELECT id, actor_pubkey, actor_role, setting, old_value, new_value, note, at
        FROM community_settings_log ORDER BY id DESC LIMIT ?`).all(LOG_LINES) as any[])
        .map((r): ShapeLogLine => ({
            id: String(r.id), kept: 'community_settings_log', at: r.at, actor: r.actor_pubkey, actorCallsign: callsignOf(r.actor_pubkey),
            actorRole: r.actor_role, setting: r.setting, from: r.old_value, to: r.new_value, note: r.note,
        }));
    const actions = Object.keys(KNOWN_FLOOR_ACTIONS);
    const floorLines = (db.prepare(`SELECT id, actor_pubkey, action, old_value, new_value, at FROM known_floor_log
        WHERE member_pubkey IS NULL AND action IN (${actions.map(() => '?').join(', ')}) ORDER BY at DESC, rowid DESC LIMIT ?`)
        .all(...actions, LOG_LINES) as any[])
        .map((r): ShapeLogLine => ({
            id: r.id, kept: 'known_floor_log', at: r.at, actor: r.actor_pubkey, actorCallsign: callsignOf(r.actor_pubkey),
            actorRole: null, setting: KNOWN_FLOOR_ACTIONS[r.action], from: r.old_value, to: r.new_value, note: null,
        }));
    return [...shapeLines, ...floorLines].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, LOG_LINES);
}

// ── The read ───────────────────────────────────────────────────────────────────────────────

/** The community's shape as this node runs it now. Reads only. */
export function readShape(): Shape {
    const kind = getNodeProfile();
    const standby = getNodeRole() === 'backup';
    const { rows, copiedAt } = standby ? standbyRows() : { rows: ownRows(), copiedAt: undefined };
    const cfg = getConfiguredSwitches(kind);
    const s = getProfileSwitches(kind);
    const features = getNodeFeatures();
    const overrides = readProfileOverrides() as Record<string, boolean>;
    const preview = isPrivatePreview();
    const history = ledgerHistory();
    const sourceOf = (name: string): ShapeSource => (name in overrides ? 'owner' : 'profile');
    const plain = (name: ProfileSwitch): ShapeSetting<boolean> => ({ value: s[name], configured: cfg[name], source: sourceOf(name), lock: null });

    // Who can join: the door the gates use (doorFor reads the row only when the setting decides), and invites.
    const door = doorFor(() => doorFromRow(rows.door));
    const configuredJoin: JoinState = cfg.openJoin && !cfg.invites ? 'open' : !cfg.invites ? 'paused' : doorFromRow(rows.door);
    const join: ShapeSetting<JoinState> = {
        value: door === 'open' ? 'open' : !s.invites ? 'paused' : door,
        configured: configuredJoin,
        source: configuredJoin === 'open' ? (sourceOf('openJoin') === 'owner' || sourceOf('invites') === 'owner' ? 'owner' : 'profile')
            : configuredJoin === 'paused' ? sourceOf('invites')
            : rows.door !== null && isCommunityDoor(rows.door) ? 'owner' : 'default',
        lock: preview ? lock('private_preview', LOCK_WORDS.previewJoin, UNLOCK_PREVIEW)
            : door === 'open' ? lock('profile', LOCK_WORDS.openByKind(kind, features.wordsDoor, sourceOf('openJoin') === 'owner' || sourceOf('invites') === 'owner'))
            : configuredJoin === 'open' && !s.openJoin ? lock('ledger_moved', LOCK_WORDS.doorStaysShut(history ?? 'its ledger has moved'))
            : null,
    };

    // The open door, which a preview and a moved ledger keep shut, and the 12-words door beside it.
    const doorLock = preview ? lock('private_preview', LOCK_WORDS.previewDoor, UNLOCK_PREVIEW)
        : history ? lock('ledger_moved', LOCK_WORDS.doorStaysShut(history)) : null;
    const openDoor: ShapeSetting<boolean> = { value: features.openJoin, configured: cfg.openJoin, source: sourceOf('openJoin'), lock: doorLock };
    const wordsDoor: ShapeSetting<boolean> | undefined = cfg.openJoin ? {
        value: features.wordsDoor,
        configured: !cfg.ssoRequiredForJoin,
        source: sourceOf('ssoRequiredForJoin'),
        lock: !cfg.ssoRequiredForJoin && !features.wordsDoor ? doorLock : null,
    } : undefined;

    const knocks: ShapeSetting<boolean> = {
        ...plain('knocks'),
        lock: preview ? lock('private_preview', LOCK_WORDS.previewJoin, UNLOCK_PREVIEW)
            : !s.invites ? lock('invites_off', LOCK_WORDS.invitesOff, LOCK_WORDS.unlockInvites) : null,
    };

    const cap = savedCreditCapFrom(rows.creditCap);
    const floor = knownFloorFrom(rows.knownFloor, cap);
    const knownFloor: ShapeSetting<KnownFloorShape> = {
        value: { on: confirmationDialFrom(rows.confirmation), floor, cap, capMax: CREDIT_CAP_MAX },
        configured: { on: confirmationDialSetFrom(rows.confirmation), floor, cap, capMax: CREDIT_CAP_MAX },
        source: rows.confirmation !== null || rows.knownFloor !== null || rows.creditCap !== null ? 'owner' : 'default',
        lock: s.beans ? null : lock('beans_off', LOCK_WORDS.beansOffFloor),
    };

    const switches = cfg as unknown as Record<string, boolean>;
    const running = s as unknown as Record<string, boolean>;
    const dmRequests: ShapeSetting<boolean> | undefined = 'dmRequests' in switches
        ? { value: running.dmRequests, configured: switches.dmRequests, source: sourceOf('dmRequests'), lock: null }
        : undefined;

    const share = (field: Exclude<DirectoryField, 'directoryPushIntervalHours'>): ShapeSetting<boolean> => ({
        value: rows.directory[field], configured: rows.directory[field], source: rows.stored.has(field) ? 'owner' : 'default', lock: null,
    });

    const hatches = guestViewAuthFlagsOff();
    const visitors: ShapeSetting<VisitorsView> = {
        value: preview ? 'nothing' : hatches.length > 0 ? 'open' : s.guestListingsOnly ? 'listings' : 'nothing',
        configured: cfg.guestListingsOnly ? 'listings' : 'nothing',
        source: sourceOf('guestListingsOnly'),
        lock: preview ? lock('private_preview', LOCK_WORDS.previewVisitors, UNLOCK_PREVIEW)
            : hatches.length > 0 ? lock('auth_hatch_open', LOCK_WORDS.hatchOpen(hatches)) : null,
    };

    const local = profileDefaults('local');
    const kindOnly: KindOnlySetting[] = KIND_ONLY_SWITCHES.filter((id) => s[id] !== local[id]).map((id) => ({
        id,
        ...plain(id),
        lock: id === 'membersOnDemand' && s.openMembership ? lock('open_membership', LOCK_WORDS.openMembership) : null,
    }));

    const settings: ShapeSettings = {
        join,
        openDoor,
        ...(wordsDoor ? { wordsDoor } : {}),
        knocks,
        preview: { value: preview, configured: preview, source: 'server', lock: lock('server_env', LOCK_WORDS.onTheServer(PRIVATE_PREVIEW_ENV)) },
        beans: {
            ...plain('beans'),
            lock: history ? lock('ledger_moved', LOCK_WORDS.beansStayOn(history)) : null,
            includes: { escrow: s.escrow, enterprises: s.enterprises, treasuries: s.treasuries, crowdfund: s.crowdfund },
        },
        knownFloor,
        ...(dmRequests ? { dmRequests } : {}),
        decisions: plain('decisions'),
        listed: listed(standby, cfg, s, rows.directory, sourceOf('publishToDirectory')),
        shareLocation: share('publishLocation'),
        shareMemberCount: share('publishMembers'),
        shareEmail: share('publishContactEmail'),
        sharePhone: share('publishContactPhone'),
        shareHealth: share('publishHealth'),
        visitors,
        probation: plain('probation'),
        autoHide: plain('autoHideReports'),
        autoMute: plain('autoMute'),
        connections: {
            value: ENABLE_PEER_CONNECTORS, configured: ENABLE_PEER_CONNECTORS, source: 'server',
            lock: lock('server_env', LOCK_WORDS.onTheServer('ENABLE_PEER_CONNECTORS')),
        },
    };
    const version = (db.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM community_settings_log').get() as { v: number }).v;
    return { kind, standby, ...(standby ? { copiedAt } : {}), version, settings, kindOnly, log: readLog() };
}

/**
 * Listed: whether the directory is sent this community's entry, as the publisher decides at each push (and its timer, at
 * the schedule): the switch, then DIRECTORY_UNLISTED, the schedule's Never, and the hold-backs (directoryHeldBack).
 */
function listed(standby: boolean, cfg: ProfileSwitches, s: ProfileSwitches, directory: Directory, source: ShapeSource): ShapeSetting<boolean> {
    const base = { configured: cfg.publishToDirectory, source };
    if (standby) return { ...base, value: false, lock: lock('standby', LOCK_WORDS.standbyListed) };
    if (!s.publishToDirectory) return { ...base, value: false, lock: null };
    if (directoryUnlistedByEnv()) return { ...base, value: false, lock: lock('server_env', HELD_BACK_UNLISTED_MESSAGE) };
    if (directory.directoryPushIntervalHours === 0) return { ...base, value: false, lock: lock('schedule_never', LOCK_WORDS.scheduleNever) };
    const held = directoryHeldBack();
    if (held) return { ...base, value: false, lock: lock(held === 'unlisted' ? 'server_env' : 'held_back', HELD_BACK_WORDS[held]) };
    return { ...base, value: true, lock: null };
}
