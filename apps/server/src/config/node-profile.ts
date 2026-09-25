/**
 * The node profile: what kind of node this is, `local` (a community with a shared ledger, every node today) or
 * `global` (the lobby at global.beanpool.org: open sign-up, no Beans, everything searched by place).
 *
 * One codebase and one image for every node. The global node differs ONLY by configuration, so every behaviour it
 * changes is a switch below with a tested default per profile, and a stranger running their own open node can tune
 * each one without a fork.
 *
 * ## Where the profile comes from
 *
 * - `NODE_PROFILE` (env) is what a server RUNS as, read every time it is asked. Unset, empty or anything
 *   unrecognised is `local`; an unrecognised value says so once in the log. Case and surrounding spaces are forgiven
 *   (`GLOBAL`, ` global `), because the intent is unambiguous; anything else (`glob`, `global-node`, `open`) is not a
 *   profile, and guessing would open a node's door by accident.
 * - `node_config.nodeProfile` is the database's RECORD of the profile it runs as. A main server writes it at every
 *   boot. It is never read as the profile, but a main server whose record says `global` REFUSES TO START while
 *   `NODE_PROFILE` says anything else (`NodeProfileMismatchError`): run as local, a global node would switch Beans
 *   on for strangers who joined an open door. To convert one on purpose, start it once with
 *   `NODE_PROFILE_ALLOW_CHANGE_FROM=global`. A record of `local` under `NODE_PROFILE=global` starts, and says so:
 *   that direction switches money off, and the ledger lock below keeps it on wherever Beans have ever moved.
 * - Each switch can be overridden by its own `node_config` row, `nodeProfile.<switch>` = `true` | `false`: the
 *   operator's tuning of the community.
 *
 * ## What travels where (the record and the overrides together, `readProfileRecord`)
 *
 * - A file or sealed backup is the whole database, so both are in it, and a restore brings them back: restored on a
 *   server whose `NODE_PROFILE` doesn't match a global record, it refuses to start as above.
 * - The take-over bundle (services/takeover-envelope.ts) carries both, signed and sealed. A take-over is refused
 *   before anything is written when this server's `NODE_PROFILE` doesn't match the community's, and its `profile`
 *   step writes the record and the overrides into the promoted server's database (services/takeover.ts).
 * - Every replication payload to a standby carries both, signed (`SyncPayload.nodeProfile`), and the standby keeps
 *   them as the main server's (services/backup-puller.ts). A standby never writes its own profile over that record
 *   and never refuses to start (it only copies), but says when its own `NODE_PROFILE` differs, so a standby
 *   promoted by hand, without a take-over, meets the same refusal at its first boot as a main server.
 *
 * ## What a switch really does
 *
 * A switch is only as real as the code behind it. Until the PR that builds a switch lands, the switch is pinned to
 * what the code does today (NOT_BUILT_YET), whatever the profile or an override says, and /api/community/info
 * reports the pinned value: a node never advertises what it can't do.
 *
 * The money switches (`beans`, `escrow`, `enterprises`, `treasuries`, `crowdfund`) can only be OFF on a node whose
 * ledger has never moved (`ledgerHistory`). Off on a live community they would freeze what its members hold, so
 * there the switch stays on, whatever the profile or an override says, and the log says why. Escrow, enterprises,
 * treasuries and crowdfunds hold Beans, so with Beans off they are off too.
 *
 * The open door (`openJoin`) is the other way round: it can only be ON on a node whose ledger has never moved. The
 * door is built for a node where Beans are off (design §1, D6), and a live community switched to the global profile
 * keeps its money on (above), so open sign-up would meet a live credit system. There the door stays shut, whatever
 * the profile or an override says: /api/community/info reports `openJoin: false`, every door route answers 404, and
 * the boot log says why. Both locks only ever keep money on and the door shut, never the reverse.
 */
import { db } from '../db/db.js';

export type NodeProfile = 'local' | 'global';

/** The profile-driven switches (design §4.2). Every code path that differs by profile reads one of these. */
export interface ProfileSwitches {
    /** Anyone may join through `POST /api/join` with a verified sign-in instead of an invite. Off: that route and
     *  every other door route are 404 (routes/open-join.ts). Never on where the ledger has moved. */
    openJoin: boolean;
    /** The open door needs an SSO sign-in (D1 = a, Marty 2026-09-24). Means nothing while `openJoin` is off. */
    ssoRequiredForJoin: boolean;
    /** Beans move: member-to-member sends and credit. Off: the money entry points refuse, and posts carry no price. */
    beans: boolean;
    escrow: boolean;
    enterprises: boolean;
    treasuries: boolean;
    crowdfund: boolean;
    /** This node takes "ask to join" requests from non-members (D4 = a: on for every community, with an opt-out). */
    knocks: boolean;
    /** A post listing read with a point (`lat`, `lng`) and no `sort` comes nearest first; off, it keeps the most
     *  recently updated first. Without a point every profile keeps that order (routes/marketplace.ts). Not the same as
     *  `features.distanceSearch`, which every node reports. */
    distanceSortDefault: boolean;
    /** Mirror the public communities directory hourly, for "communities near you", and serve it with place watches
     *  and the landing card under /api/global (services/directory-mirror.ts, routes/global-directory.ts). Off: no
     *  fetch, and every /api/global route is 404. Main servers only: a standby never fetches. */
    directoryMirror: boolean;
    /** On: the operator's directory settings decide whether this node is listed, as today. Off: never listed: the
     *  publisher sends nothing and sets no timer (services/directory-publisher.ts). */
    publishToDirectory: boolean;
    /** New accounts are rate-limited for their first days: posts, photos, new DM recipients, knocks
     *  (engine/probation.ts). */
    probation: boolean;
    /** A post reported by enough established members is hidden until a moderator looks
     *  (engine/auto-moderation.ts). Off: reports go to the queue only, as on every node before G3. */
    autoHideReports: boolean;
    /** A member with repeated posts removed by a moderator can't post or DM until a moderator lifts it
     *  (engine/auto-moderation.ts). */
    autoMute: boolean;
}

export type ProfileSwitch = keyof ProfileSwitches;

/**
 * The defaults per profile (design §4.2). Not here: federation (the env `ENABLE_PEER_CONNECTORS`, unchanged, off
 * unless set) and the landing card (the app keys it on `profile`).
 */
const DEFAULTS: Record<NodeProfile, ProfileSwitches> = {
    local: {
        openJoin: false,
        ssoRequiredForJoin: true,
        beans: true,
        escrow: true,
        enterprises: true,
        treasuries: true,
        crowdfund: true,
        knocks: true,
        distanceSortDefault: false,
        directoryMirror: false,
        publishToDirectory: true,
        probation: false,
        autoHideReports: false,
        autoMute: false,
    },
    global: {
        openJoin: true,
        ssoRequiredForJoin: true,
        beans: false,
        escrow: false,
        enterprises: false,
        treasuries: false,
        crowdfund: false,
        // Nobody knocks on the lobby: people knock on a local community from here.
        knocks: false,
        distanceSortDefault: true,
        directoryMirror: true,
        // The lobby is not a place, so it is not a pin on the directory map.
        publishToDirectory: false,
        probation: true,
        autoHideReports: true,
        autoMute: true,
    },
};

/**
 * Switches this build can't honour yet, pinned to what the code does today. Until a switch's PR lands neither the
 * profile nor an override changes it. The PR that builds a switch deletes its line here, with its tests.
 */
const NOT_BUILT_YET: Readonly<Partial<ProfileSwitches>> = {
    // G2 built the door with a sign-in (routes/open-join.ts). A door WITHOUT one (D1 b: no provider, a stricter
    // probation) is not built, so an override asking for it is reported at boot and changes nothing.
    ssoRequiredForJoin: true,
    knocks: false, // G6
};

/** The switches that hold or move Beans. None of them can be off on a node whose ledger has ever moved. */
const MONEY_SWITCHES = ['beans', 'escrow', 'enterprises', 'treasuries', 'crowdfund'] as const satisfies readonly ProfileSwitch[];

/** What the apps read from `GET /api/community/info`: what this node really does, never what it will do one day. */
export interface NodeFeatures {
    beans: boolean;
    escrow: boolean;
    enterprises: boolean;
    openJoin: boolean;
    knocks: boolean;
    /** This server understands the distance parameters, on every profile (design §3.2, G4): the posts listing's
     *  `lat`, `lng`, `radiusKm` and `sort=distance|recent`, a point on the People lists, and a member's coarse area
     *  (POST /api/community/me/area). Apps from before G4 ignore it. */
    distanceSearch: boolean;
    /** New accounts have daily limits; `GET /api/community/me` says a member's own. */
    probation: boolean;
    /** A post reported by 3 established members is hidden until a moderator looks. */
    autoHideReports: boolean;
    /** 3 posts removed by a moderator in 30 days stop a member posting and messaging until a moderator lifts it. */
    autoMute: boolean;
}

export const NODE_PROFILE_KEY = 'nodeProfile';
const OVERRIDE_PREFIX = `${NODE_PROFILE_KEY}.`;
const SWITCH_NAMES = Object.keys(DEFAULTS.local) as ProfileSwitch[];
/** Set for one boot to convert a database recorded as global into the profile NODE_PROFILE now names. */
export const ALLOW_CHANGE_ENV = 'NODE_PROFILE_ALLOW_CHANGE_FROM';

// getNodeProfile runs on every /api/community/info, so each distinct complaint is logged once, not per request.
const warned = new Set<string>();
function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    console.warn(message);
}

/** Reads a raw `NODE_PROFILE` value. `unrecognised` is the raw value when it was set to something that isn't a profile. */
export function parseNodeProfile(raw: string | undefined): { profile: NodeProfile; unrecognised: string | null } {
    const value = (raw ?? '').trim().toLowerCase();
    if (value === '' || value === 'local') return { profile: 'local', unrecognised: null };
    if (value === 'global') return { profile: 'global', unrecognised: null };
    return { profile: 'local', unrecognised: raw as string };
}

/** This node's profile, from `NODE_PROFILE` every time it is asked. Never from the database. */
export function getNodeProfile(): NodeProfile {
    const { profile, unrecognised } = parseNodeProfile(process.env.NODE_PROFILE);
    if (unrecognised !== null) {
        warnOnce(`⚠️  NODE_PROFILE=${JSON.stringify(unrecognised)} is not a node profile (local or global), so this node runs as local.`);
    }
    return profile;
}

export function profileDefaults(profile: NodeProfile): ProfileSwitches {
    return { ...DEFAULTS[profile] };
}

/** The operator's overrides from `node_config`, valid ones only. An unknown switch or a value other than true/false is logged and ignored. */
export function readProfileOverrides(): Partial<ProfileSwitches> {
    const overrides: Partial<ProfileSwitches> = {};
    for (const { key, value } of overrideRows()) {
        const name = key.slice(OVERRIDE_PREFIX.length) as ProfileSwitch;
        if (!SWITCH_NAMES.includes(name)) {
            warnOnce(`⚠️  node_config ${key} is not a profile switch, so it is ignored. The switches: ${SWITCH_NAMES.join(', ')}.`);
            continue;
        }
        const v = String(value).trim().toLowerCase();
        if (v !== 'true' && v !== 'false') {
            warnOnce(`⚠️  node_config ${key}=${JSON.stringify(value)} is not true or false, so the profile's default is kept.`);
            continue;
        }
        overrides[name] = v === 'true';
    }
    return overrides;
}

function overrideRows(): { key: string; value: string }[] {
    return db.prepare('SELECT key, value FROM node_config WHERE substr(key, 1, ?) = ? ORDER BY key')
        .all(OVERRIDE_PREFIX.length, OVERRIDE_PREFIX) as { key: string; value: string }[];
}

/** The profile's defaults with the operator's overrides on top: what the node is SET to do. */
export function getConfiguredSwitches(profile: NodeProfile = getNodeProfile()): ProfileSwitches {
    return { ...DEFAULTS[profile], ...readProfileOverrides() };
}

/**
 * What the node actually does: the configured switches, with every switch this build can't honour yet pinned, and
 * money kept on and the open door shut wherever the ledger has moved.
 */
export function getProfileSwitches(profile: NodeProfile = getNodeProfile()): ProfileSwitches {
    return lockToLedger({ ...getConfiguredSwitches(profile), ...NOT_BUILT_YET });
}

export function getNodeFeatures(): NodeFeatures {
    const s = getProfileSwitches();
    return {
        beans: s.beans,
        escrow: s.escrow,
        // One construct under two names in this build: the treasury routes serve both, so it is here only with both on.
        enterprises: s.enterprises && s.treasuries,
        openJoin: s.openJoin,
        knocks: s.knocks,
        // A capability of the build, not a profile switch: a local node answers distance queries too.
        distanceSearch: true,
        probation: s.probation,
        autoHideReports: s.autoHideReports,
        autoMute: s.autoMute,
    };
}

// ── Money is never frozen, and the door never opens onto it ──────────────────────────────

/**
 * What shows this node's ledger has moved, or null when it never has: a transaction, an escrow, a non-zero
 * balance (the Commons pool included), a backing pledge, a cross-node settlement. Cheapest first.
 */
export function ledgerHistory(): string | null {
    const any = (sql: string) => !!db.prepare(sql).get();
    if (any('SELECT 1 FROM transactions LIMIT 1')) return 'it has recorded transactions';
    if (any('SELECT 1 FROM marketplace_transactions LIMIT 1')) return 'it has opened escrows';
    if (any('SELECT 1 FROM accounts WHERE balance != 0 LIMIT 1')) return 'an account holds a balance';
    if (any('SELECT 1 FROM enterprise_pledges LIMIT 1')) return 'members have pledged backing';
    if (any('SELECT 1 FROM settlements LIMIT 1')) return 'it has settled with another community';
    return null;
}

// A ledger that has moved has moved for good, so what was found is kept for the life of the process. "Never moved"
// is kept only while Beans are configured off, because only then can nothing here move it: every read of the
// switches with Beans on drops it, and every money path reads them before it writes. An import or a restore writes
// the ledger from outside, so it forgets (forgetLedgerHistory).
let historyFound: string | null = null;
let quietWhileBeansOff = false;

/** Something wrote the ledger without the guards (a standby's import): look again next time. */
export function forgetLedgerHistory(): void {
    quietWhileBeansOff = false;
}

function cachedLedgerHistory(beansConfigured: boolean): string | null {
    if (historyFound) return historyFound;
    if (quietWhileBeansOff) return null;
    historyFound = ledgerHistory();
    quietWhileBeansOff = historyFound === null && !beansConfigured;
    return historyFound;
}

function lockToLedger(s: ProfileSwitches): ProfileSwitches {
    // Whether or not any money switch is off: Beans switched back on with every switch on would otherwise keep
    // "never moved" through the sends that follow, and switched off again the ledger would freeze.
    if (s.beans) quietWhileBeansOff = false;
    const off = MONEY_SWITCHES.filter((k) => !s[k]);
    // The ledger is looked at only when a switch depends on it. With Beans configured on and the door open it is
    // looked at on every read, so the first Bean that moves shuts the door.
    const history = off.length > 0 || s.openJoin ? cachedLedgerHistory(s.beans) : null;
    if (history && off.length > 0) {
        for (const k of off) s[k] = true;
        warnOnce(moneyLockMessage(off, history));
    }
    if (history && s.openJoin) {
        s.openJoin = false;
        warnOnce(doorShutMessage(history));
    }
    if (!s.beans) {
        s.escrow = false;
        s.enterprises = false;
        s.treasuries = false;
        s.crowdfund = false;
    }
    return s;
}

function moneyLockMessage(off: readonly ProfileSwitch[], history: string): string {
    return `⚠️  ${off.join(', ')} ${off.length === 1 ? 'stays' : 'stay'} ON: this node's ledger has moved (${history}), and switching `
        + `${off.length === 1 ? 'it' : 'them'} off would freeze what its members hold. Only a node whose ledger has never moved `
        + 'can run with Beans off.';
}

function doorShutMessage(history: string): string {
    return `⚠️  The open door stays SHUT: this node's ledger has moved (${history}), and open sign-up must never meet a `
        + 'live credit system. openJoin is off here whatever the profile or an override says: /api/join and its sign-in '
        + 'routes answer 404, and /api/community/info reports openJoin false. Only a node whose ledger has never moved '
        + 'can open the door.';
}

/** The refusal a member sees when Beans are off: a send, a Beans price on a post, a pledge, a grant. */
export const PROFILE_NO_BEANS = 'profile_no_beans';
export const BEANS_OFF_MESSAGE = "Beans are switched off on this node, so nothing here can send, hold or price Beans. They live in your local community's own node.";
export const BEANS_OFF_PRICE_MESSAGE = 'Beans are switched off on this node, so a post can’t carry a Beans price. Post it without one: say in the description what you’d like in return, or that it’s free.';

export class BeansOffError extends Error {
    readonly code = PROFILE_NO_BEANS;
    readonly status = 403;
    constructor(message: string = BEANS_OFF_MESSAGE) {
        super(message);
        this.name = 'BeansOffError';
    }
}

/** For every path that moves Beans or prices something in them: throws BeansOffError when this node's `beans` switch is off. */
export function assertBeansOn(message?: string): void {
    if (!getProfileSwitches().beans) throw new BeansOffError(message);
}

/** A feature a switch has turned off. Routes answer 404 `feature_off` (routes/profile-feature-gate.ts). */
export const FEATURE_OFF = 'feature_off';

export class FeatureOffError extends Error {
    readonly code = FEATURE_OFF;
    readonly status = 404;
    constructor(readonly feature: ProfileSwitch) {
        super(featureOffMessage(feature));
        this.name = 'FeatureOffError';
    }
}

const FEATURE_OFF_MESSAGES: Partial<Record<ProfileSwitch, string>> = {
    beans: 'Beans are switched off on this node.',
    escrow: 'Escrow trades are switched off on this node, so nothing here is bought or sold for Beans.',
    enterprises: 'Enterprises are switched off on this node.',
    treasuries: 'Treasuries are switched off on this node.',
    crowdfund: 'Crowdfunding is switched off on this node.',
    directoryMirror: 'This node does not keep the communities directory. Find communities near you on the global community.',
};

export function featureOffMessage(feature: ProfileSwitch): string {
    return FEATURE_OFF_MESSAGES[feature] ?? `${feature} is switched off on this node.`;
}

/** Throws FeatureOffError when `feature` is off here. */
export function assertFeatureOn(feature: ProfileSwitch): void {
    if (!getProfileSwitches()[feature]) throw new FeatureOffError(feature);
}

// ── The record that travels ───────────────────────────────────────────────────────────────

/** The profile this database runs as and the operator's overrides, raw: what a take-over and a standby carry. */
export interface ProfileRecord {
    profile: NodeProfile | null;
    overrides: Record<string, string>;
}

function recordedProfile(): NodeProfile | null {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(NODE_PROFILE_KEY) as { value?: string } | undefined;
    if (row?.value == null) return null;
    const { profile, unrecognised } = parseNodeProfile(row.value);
    return unrecognised === null ? profile : null;
}

export function readProfileRecord(): ProfileRecord {
    const overrides: Record<string, string> = {};
    for (const { key, value } of overrideRows()) overrides[key.slice(OVERRIDE_PREFIX.length)] = String(value);
    return { profile: recordedProfile(), overrides };
}

/**
 * Keep a record that came from the main server (a take-over bundle, a replication payload): the profile, and the
 * overrides in place of this database's own. Only `nodeProfile` and `nodeProfile.<a known switch>` rows are ever
 * written, whatever the record holds. Returns false, writing nothing, for something that isn't a record.
 */
export function writeProfileRecord(record: unknown): boolean {
    const r = record as Partial<ProfileRecord> | null;
    if (!r || typeof r !== 'object' || (r.profile !== 'local' && r.profile !== 'global' && r.profile !== null)) return false;
    if (!r.overrides || typeof r.overrides !== 'object' || Array.isArray(r.overrides)) return false;
    const rows = Object.entries(r.overrides)
        .filter(([name, value]) => SWITCH_NAMES.includes(name as ProfileSwitch) && typeof value === 'string' && value.length <= 16);
    // A standby is sent the same record every pull: write only what changed.
    const now = readProfileRecord();
    const sameOverrides = JSON.stringify(Object.fromEntries([...rows].sort(([a], [b]) => a.localeCompare(b))))
        === JSON.stringify(Object.fromEntries(Object.entries(now.overrides).sort(([a], [b]) => a.localeCompare(b))));
    if (sameOverrides && (r.profile === null || r.profile === now.profile)) return true;
    const upsert = db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    db.transaction(() => {
        if (r.profile) upsert.run(NODE_PROFILE_KEY, r.profile);
        db.prepare('DELETE FROM node_config WHERE substr(key, 1, ?) = ?').run(OVERRIDE_PREFIX.length, OVERRIDE_PREFIX);
        for (const [name, value] of rows) upsert.run(OVERRIDE_PREFIX + name, value);
    })();
    return true;
}

/**
 * Why this server must not take over a community recorded as `community`, or null when it may. A take-over keeps
 * a community as it was, so the profile must match in both directions.
 */
export function takeoverProfileRefusal(community: NodeProfile | null | undefined): string | null {
    if (community !== 'local' && community !== 'global') return null;
    const here = getNodeProfile();
    if (community === here) return null;
    return community === 'global'
        ? 'This community is a global node, but this server runs with NODE_PROFILE unset (local). Taken over as it '
            + 'stands, it would switch Beans on for members who joined a node without them. Set NODE_PROFILE=global in '
            + 'this server\'s .env, restart it, and take over again. Nothing has been changed.'
        : 'This community is a local node, but this server runs with NODE_PROFILE=global, which is a different kind of '
            + 'node. Remove NODE_PROFILE from this server\'s .env, restart it, and take over again. Nothing has been changed.';
}

// ── Boot ──────────────────────────────────────────────────────────────────────────────────

/** A main server whose database is recorded as global, started under another NODE_PROFILE. */
export class NodeProfileMismatchError extends Error {
    constructor(readonly recorded: NodeProfile, readonly running: NodeProfile) {
        super(`This database is a ${recorded} node, but NODE_PROFILE here is ${running === 'local' ? 'unset (local)' : running}. `
            + `Started as ${running}, it would switch Beans on for members who joined a node without them, so it will not start. `
            + `Set NODE_PROFILE=${recorded} in this server's .env. To make it a ${running} node on purpose, start it once with `
            + `${ALLOW_CHANGE_ENV}=${recorded}.`);
        this.name = 'NodeProfileMismatchError';
    }
}

function pinnedLine(profile: NodeProfile): string {
    const wanted = DEFAULTS[profile];
    const parts = (Object.keys(NOT_BUILT_YET) as ProfileSwitch[]).map((k) =>
        wanted[k] !== NOT_BUILT_YET[k] ? `${k}=${NOT_BUILT_YET[k]} (${profile} wants ${wanted[k]})` : `${k}=${NOT_BUILT_YET[k]}`);
    return `🧭 Not built yet, so these run as on any node today, whatever the ${profile} profile says: ${parts.join(', ')}.`;
}

/**
 * At boot: resolve the profile (logging a bad NODE_PROFILE), refuse a main server whose database is a global node
 * under another profile, write the record, and say what the node runs as: its overrides, the switches still
 * pinned, and money kept on where it has moved. Returns the profile and what the record held before.
 *
 * A standby (`role` backup) keeps the main server's record as copied, never writes its own over it, and never
 * refuses: it says when its NODE_PROFILE differs.
 */
export function mirrorNodeProfileAtBoot(role: 'primary' | 'backup' = 'primary'): { profile: NodeProfile; previous: string | null } {
    const profile = getNodeProfile();
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(NODE_PROFILE_KEY) as { value?: string } | undefined;
    const previous = row?.value ?? null;
    const recorded = recordedProfile();
    historyFound = null;
    quietWhileBeansOff = false;

    if (role === 'backup') {
        console.log(`🧭 Node profile: ${profile} (a standby: it keeps the main server's record, ${recorded ?? 'not copied yet'})`);
        if (recorded && recorded !== profile) {
            console.warn(`⚠️  The main server this standby copies runs as ${recorded}, but NODE_PROFILE here is ${profile}. `
                + `A take-over from here is refused until NODE_PROFILE=${recorded === 'local' ? '(unset)' : recorded} is set.`);
        }
    } else {
        if (recorded === 'global' && profile !== 'global') {
            const allow = (process.env[ALLOW_CHANGE_ENV] ?? '').trim().toLowerCase();
            if (allow !== 'global') throw new NodeProfileMismatchError('global', profile);
            console.warn(`⚠️  ${ALLOW_CHANGE_ENV}=global: this database ran a global node and now runs as ${profile}, on purpose.`);
        }
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(NODE_PROFILE_KEY, profile);
        const overrides = readProfileOverrides();
        const set = (Object.keys(overrides) as ProfileSwitch[]).map((k) => `${k}=${overrides[k]}`);
        console.log(`🧭 Node profile: ${profile}${set.length ? ` (overrides: ${set.join(', ')})` : ''}`);
        if (previous !== null && previous !== profile) {
            console.log(`🧭 This database last ran as ${JSON.stringify(previous)}. NODE_PROFILE decides, so it now runs as ${profile}.`);
        }
    }

    const overrides = readProfileOverrides();
    const pinned = (Object.keys(overrides) as ProfileSwitch[]).filter((k) => k in NOT_BUILT_YET && overrides[k] !== NOT_BUILT_YET[k]);
    if (pinned.length) {
        console.log(`🧭 Not built yet, so these overrides do nothing for now: ${pinned.map((k) => `${k}=${overrides[k]}`).join(', ')}.`);
    }
    if (profile === 'global') console.log(pinnedLine(profile));

    const configured = { ...getConfiguredSwitches(profile), ...NOT_BUILT_YET };
    const off = MONEY_SWITCHES.filter((k) => !configured[k]);
    const history = off.length > 0 || configured.openJoin ? ledgerHistory() : null;
    if (history) historyFound = history;
    const loudly = (message: string) => {
        warned.add(message);
        console.warn(message);
    };
    if (off.length > 0) {
        if (history) loudly(moneyLockMessage(off, history));
        else if (!configured.beans) {
            console.log('🧭 Beans are off: sends, escrow, enterprises, treasuries and crowdfunds are refused here, and posts carry no Beans price.');
        }
    }
    if (configured.openJoin) {
        if (history) loudly(doorShutMessage(history));
        else console.log('🚪 The open door is open: anyone may join here with a sign-in instead of an invite. It shuts for good if Beans ever move here.');
    }
    return { profile, previous };
}
