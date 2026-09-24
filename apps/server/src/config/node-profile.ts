/**
 * The node profile: what kind of node this is, `local` (a community with a shared ledger, every node today) or
 * `global` (the lobby at global.beanpool.org: open sign-up, no Beans, everything searched by place).
 *
 * One codebase and one image for every node. The global node differs ONLY by configuration, so every behaviour it
 * changes is a switch below with a tested default per profile, and a stranger running their own open node can tune
 * each one without a fork.
 *
 * - `NODE_PROFILE` (env) is the source of truth at EVERY boot. Unset, empty or anything unrecognised is `local`; an
 *   unrecognised value says so once in the log. Case and surrounding spaces are forgiven (`GLOBAL`, ` global `),
 *   because the intent is unambiguous; anything else (`glob`, `global-node`, `open`) is not a profile, and guessing
 *   would open a node's door by accident.
 * - At boot the profile is mirrored into `node_config` under `nodeProfile`, so Settings, backups and take-over see
 *   which profile the database was last run as. The mirror is informational and never read back as the profile: a
 *   backup restored from a global node onto a local one must not flip it (the next boot rewrites the mirror).
 * - Each switch can be overridden by its own `node_config` row, `nodeProfile.<switch>` = `true` | `false`. Overrides
 *   live in the database, so they DO travel with a backup: they are the operator's tuning of the community.
 *
 * A switch is only as real as the code behind it. Until the PR that builds a switch lands, the switch is pinned to
 * what the code does today (NOT_BUILT_YET), whatever the profile or an override says, and /api/community/info
 * reports the pinned value: a node never advertises what it can't do.
 */
import { db } from '../db/db.js';

export type NodeProfile = 'local' | 'global';

/** The profile-driven switches (design §4.2). Every code path that differs by profile reads one of these. */
export interface ProfileSwitches {
    /** Anyone may join through `POST /api/join` with a verified sign-in instead of an invite. Off: that route and
     *  `POST /api/join/sso-nonce` are 404 (routes/open-join.ts). */
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
    /** Post listings sort nearest-first unless the caller asks otherwise. Not the same as `features.distanceSearch`. */
    distanceSortDefault: boolean;
    /** Mirror the public communities directory hourly, for "communities near you". Primary only. */
    directoryMirror: boolean;
    /** On: the operator's directory settings decide whether this node is listed, as today. Off: never listed. */
    publishToDirectory: boolean;
    /** New accounts are rate-limited for their first days (posts, photos, new DM recipients, knocks). */
    probation: boolean;
    /** A post reported by enough established members is hidden until a moderator looks. */
    autoHideReports: boolean;
    /** A member with repeated actioned posts can't post or DM until a moderator lifts it. */
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
    beans: true, // G1
    escrow: true, // G1
    enterprises: true, // G1
    treasuries: true, // G1
    crowdfund: true, // G1
    knocks: false, // G6
    distanceSortDefault: false, // G4
    directoryMirror: false, // G5
    publishToDirectory: true, // G5 (the operator's directory settings decide, as they always have)
    probation: false, // G3
    autoHideReports: false, // G3
    autoMute: false, // G3
};

/** What the apps read from `GET /api/community/info`: what this node really does, never what it will do one day. */
export interface NodeFeatures {
    beans: boolean;
    escrow: boolean;
    enterprises: boolean;
    openJoin: boolean;
    knocks: boolean;
    /** The listing answers `?lat&lng&radiusKm&sort=distance`, on every profile (design §3.2). G4 builds it. */
    distanceSearch: boolean;
}

export const NODE_PROFILE_KEY = 'nodeProfile';
const OVERRIDE_PREFIX = `${NODE_PROFILE_KEY}.`;
const SWITCH_NAMES = Object.keys(DEFAULTS.local) as ProfileSwitch[];

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
    const rows = db.prepare('SELECT key, value FROM node_config WHERE substr(key, 1, ?) = ?')
        .all(OVERRIDE_PREFIX.length, OVERRIDE_PREFIX) as { key: string; value: string }[];
    const overrides: Partial<ProfileSwitches> = {};
    for (const { key, value } of rows) {
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

/** The profile's defaults with the operator's overrides on top: what the node is SET to do. */
export function getConfiguredSwitches(profile: NodeProfile = getNodeProfile()): ProfileSwitches {
    return { ...DEFAULTS[profile], ...readProfileOverrides() };
}

/** What the node actually does: the configured switches, with every switch this build can't honour yet pinned. */
export function getProfileSwitches(profile: NodeProfile = getNodeProfile()): ProfileSwitches {
    return { ...getConfiguredSwitches(profile), ...NOT_BUILT_YET };
}

export function getNodeFeatures(): NodeFeatures {
    const s = getProfileSwitches();
    return {
        beans: s.beans,
        escrow: s.escrow,
        enterprises: s.enterprises,
        openJoin: s.openJoin,
        knocks: s.knocks,
        // A capability of the build, not a profile switch: once built, a local node answers distance queries too.
        distanceSearch: false, // G4
    };
}

/**
 * At boot: resolve the profile (logging a bad NODE_PROFILE), write the informational mirror, and say what the node
 * is running as. Returns the profile and what the mirror held before, which differs after a restore from a node
 * that ran as the other profile.
 */
export function mirrorNodeProfileAtBoot(): { profile: NodeProfile; previous: string | null } {
    const profile = getNodeProfile();
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(NODE_PROFILE_KEY) as { value?: string } | undefined;
    const previous = row?.value ?? null;
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(NODE_PROFILE_KEY, profile);

    const overrides = readProfileOverrides();
    const set = (Object.keys(overrides) as ProfileSwitch[]).map((k) => `${k}=${overrides[k]}`);
    console.log(`🧭 Node profile: ${profile}${set.length ? ` (overrides: ${set.join(', ')})` : ''}`);
    if (previous !== null && previous !== profile) {
        console.log(`🧭 This database last ran as ${JSON.stringify(previous)}. NODE_PROFILE decides, so it now runs as ${profile}.`);
    }
    const pinned = (Object.keys(overrides) as ProfileSwitch[]).filter((k) => k in NOT_BUILT_YET && overrides[k] !== NOT_BUILT_YET[k]);
    if (pinned.length) {
        console.log(`🧭 Not built yet, so these overrides do nothing for now: ${pinned.map((k) => `${k}=${overrides[k]}`).join(', ')}.`);
    }
    return { profile, previous };
}
