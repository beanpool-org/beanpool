/**
 * The community's own settings (design scratch/global-node/DESIGN-standby-takeover-gaps-opus.md §2 G5): what its owners
 * and admins chose, as opposed to what belongs to one server. Without them a promoted standby ran the community under its
 * own name, place and contacts, published contacts and a member count the community had chosen to hide (every directory
 * switch reads unset as "publish"), ran demurrage on the defaults, and held the promotion audit to its own baseline.
 *
 * ## What travels
 *
 * - local-config.json: `callsign`, `communityName`, `location`, `contactEmail`, `contactPhone`, `currencyType`,
 *   `currencyValue`, `thresholds`, and `gateway` without its admin IP allowlist. The gateway is the community's:
 *   origins its web app may call from, the subsystem switches (marketplace, messaging, federation, invites, the web
 *   app) and the request limit. The allowlist names addresses on one server's own network (a LAN, a home address, the
 *   old host's), so it stays with each server: taken over, it could lock the owners out of the Settings they need
 *   right then.
 * - node_config rows: the accepted audit baseline and its note, the pricing guide's source and seasonality, the snapshot
 *   schedule. The baseline travels only where the main server has one (every main server writes one at its first
 *   boot): installing "none" would make the next audit accept whatever the ledger sums to, and hide a drift.
 * - The `node_config` row's object: the service area, the four directory switches and how often the directory is told.
 *
 * Never: the admin password and two-factor (the take-over bundle brings those), the replication token, a standby's
 * main server and its pull settings, TLS, the node key, the identity epoch, the role. Every field is named here, and
 * engine/replication-manifest.ts classifies each one the same way (test-replication-manifest.ts checks both agree).
 *
 * ## Where it goes
 *
 * The main server puts the record in every sync payload, signed with the rest (engine/sync.ts exportSyncState). A
 * standby keeps it, checked field by field, as node_config `replica_community_settings` (services/backup-puller.ts),
 * and applies none of it: while it is a standby its own name, directory choices and thresholds are its own. A take-over
 * installs the kept record in its `community-settings` step, before `role` (services/takeover.ts); a standby promoted by
 * hand installs it at its first boot as a main server (initStateEngine). Installing is safe to run again.
 */
import { db } from '../db/db.js';
import { logger } from '../logger.js';
import { getLocalConfig, updateLocalConfig, DEFAULT_THRESHOLDS, type LocalConfig, type GatewayConfig } from './local-config.js';
import { getNodeConfig, updateNodeConfig, type NodeConfig } from '../state-engine.js';
import type { SyncCommunitySettings } from '@beanpool/engine';

export type { SyncCommunitySettings };

// ── The fields ─────────────────────────────────────────────────────────────────────────────

/** Fields of local-config.json that are the community's. */
export const COMMUNITY_LOCAL_CONFIG_FIELDS = [
    'callsign', 'communityName', 'location', 'contactEmail', 'contactPhone', 'currencyType', 'currencyValue', 'thresholds', 'gateway',
] as const;

/** node_config rows that are the community's. */
export const COMMUNITY_NODE_CONFIG_KEYS = [
    'ledger_audit_baseline', 'ledger_audit_rebaseline_note', 'pricing_data_source', 'pricing_show_seasonality', 'autosnapshot_config',
] as const;

/** Fields of the `node_config` row's object that are the community's. */
export const COMMUNITY_DIRECTORY_FIELDS = [
    'serviceRadius', 'publishLocation', 'publishMembers', 'publishContacts', 'publishHealth', 'directoryPushIntervalHours',
] as const;

/** Where a standby keeps its main server's record. */
export const KEPT_COMMUNITY_SETTINGS_KEY = 'replica_community_settings';

// ── On the main server: the record ─────────────────────────────────────────────────────────

function nodeConfigRow(key: string): string | null {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
}

/** The gateway as the community set it, without the admin IP allowlist, which stays with each server. */
function communityGateway(g: Partial<GatewayConfig>): NonNullable<SyncCommunitySettings['localConfig']['gateway']> {
    const { adminIpAllowlist: _own, ...rest } = g;
    void _own;
    return rest as NonNullable<SyncCommunitySettings['localConfig']['gateway']>;
}

/** This server's community settings, as a record for its standbys. */
export function readCommunitySettings(): SyncCommunitySettings {
    const c = getLocalConfig();
    const n = getNodeConfig();
    const nodeConfig: SyncCommunitySettings['nodeConfig'] = {};
    for (const key of COMMUNITY_NODE_CONFIG_KEYS) {
        const value = nodeConfigRow(key);
        if (key === 'ledger_audit_baseline') {
            if (value !== null) nodeConfig.ledger_audit_baseline = value;
        } else {
            nodeConfig[key] = value;
        }
    }
    return {
        localConfig: {
            callsign: c.callsign ?? null,
            communityName: c.communityName ?? null,
            location: c.location ?? null,
            contactEmail: c.contactEmail ?? null,
            contactPhone: c.contactPhone ?? null,
            currencyType: c.currencyType ?? null,
            currencyValue: c.currencyValue ?? null,
            thresholds: (c.thresholds as unknown as Record<string, number> | undefined) ?? null,
            gateway: c.gateway ? communityGateway(c.gateway) : null,
        },
        nodeConfig,
        directory: {
            serviceRadius: n.serviceRadius ?? null,
            publishLocation: n.publishLocation !== false,
            publishMembers: n.publishMembers !== false,
            publishContacts: n.publishContacts !== false,
            publishHealth: n.publishHealth !== false,
            directoryPushIntervalHours: n.directoryPushIntervalHours ?? 12,
        },
    };
}

// ── Field by field ─────────────────────────────────────────────────────────────────────────

/** A value a field can't take: the field is left out, and this server keeps its own. */
const BAD = Symbol('bad');
type Check<T> = (v: unknown) => T | typeof BAD;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const orNull = <T>(check: Check<T>): Check<T | null> => (v) => (v === null ? null : check(v));

/** A string, cut to what the route that sets it keeps (routes/community.ts update-identity). */
const text = (max: number): Check<string> => (v) => (typeof v === 'string' ? v.slice(0, max) : BAD);
const oneOf = <T extends string>(...allowed: T[]): Check<T> => (v) => (allowed.includes(v as T) ? v as T : BAD);
const bool: Check<boolean> = (v) => (typeof v === 'boolean' ? v : BAD);

const place: Check<{ lat: number; lng: number }> = (v) =>
    isObject(v) && finite(v.lat) && finite(v.lng) && Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180 ? { lat: v.lat, lng: v.lng } : BAD;

/** The known thresholds with a number each; anything else in the object is left out. */
const thresholds: Check<Record<string, number>> = (v) => {
    if (!isObject(v)) return BAD;
    const out: Record<string, number> = {};
    for (const k of Object.keys(DEFAULT_THRESHOLDS)) if (finite(v[k])) out[k] = v[k] as number;
    return out;
};

const GATEWAY_FEATURES = ['marketplace', 'messaging', 'federation', 'invites', 'servePwa'] as const;

/** The gateway's community parts; an admin IP allowlist in it is never read. */
const gateway: Check<NonNullable<SyncCommunitySettings['localConfig']['gateway']>> = (v) => {
    if (!isObject(v)) return BAD;
    const out: NonNullable<SyncCommunitySettings['localConfig']['gateway']> = {};
    if (Array.isArray(v.corsAllowedOrigins) && v.corsAllowedOrigins.length <= 50
        && v.corsAllowedOrigins.every((o) => typeof o === 'string' && o.length <= 200)) {
        out.corsAllowedOrigins = [...v.corsAllowedOrigins];
    }
    if (isObject(v.features)) {
        const features: Record<string, boolean> = {};
        for (const f of GATEWAY_FEATURES) if (typeof v.features[f] === 'boolean') features[f] = v.features[f] as boolean;
        out.features = features;
    }
    if (isObject(v.rateLimiting)) {
        const r = v.rateLimiting;
        out.rateLimiting = {
            ...(typeof r.enabled === 'boolean' ? { enabled: r.enabled } : {}),
            ...(finite(r.maxRequestsPerMinute) && r.maxRequestsPerMinute > 0 ? { maxRequestsPerMinute: r.maxRequestsPerMinute } : {}),
        };
    }
    return out;
};

/** A number, as the row stores it. */
const baseline: Check<string> = (v) => (typeof v === 'string' && v.length <= 40 && v.trim() !== '' && Number.isFinite(Number(v)) ? v : BAD);

/** The snapshot schedule as snapshot-scheduler.ts updateAutoSnapshotConfig writes it. */
const snapshotSchedule: Check<string> = (v) => {
    if (typeof v !== 'string' || v.length > 200) return BAD;
    let s: unknown;
    try { s = JSON.parse(v); } catch { return BAD; }
    if (!isObject(s) || typeof s.enabled !== 'boolean' || !finite(s.intervalHours) || s.intervalHours < 1 || !finite(s.keep) || s.keep < 1) return BAD;
    return JSON.stringify({ enabled: s.enabled, intervalHours: Math.round(s.intervalHours), keep: Math.round(s.keep) });
};

const radius: Check<{ lat: number; lng: number; radiusKm: number }> = (v) => {
    const p = place(v);
    if (p === BAD || !isObject(v) || !finite(v.radiusKm) || v.radiusKm < 0 || v.radiusKm > 20_000) return BAD;
    return { ...p, radiusKm: v.radiusKm };
};

const LOCAL_CONFIG_CHECKS: Record<(typeof COMMUNITY_LOCAL_CONFIG_FIELDS)[number], Check<unknown>> = {
    callsign: orNull(text(20)),
    communityName: orNull(text(60)),
    location: orNull(place),
    contactEmail: orNull(text(100)),
    contactPhone: orNull(text(30)),
    currencyType: orNull(oneOf('text', 'image')),
    currencyValue: orNull(text(200)),
    thresholds: orNull(thresholds),
    gateway: orNull(gateway),
};

const NODE_CONFIG_CHECKS: Record<(typeof COMMUNITY_NODE_CONFIG_KEYS)[number], Check<unknown>> = {
    ledger_audit_baseline: baseline,
    ledger_audit_rebaseline_note: orNull(text(1000)),
    pricing_data_source: orNull(oneOf('local', 'federation', 'all')),
    pricing_show_seasonality: orNull(oneOf('true', 'false')),
    autosnapshot_config: orNull(snapshotSchedule),
};

/**
 * How often the directory is told, in whole hours; 0 is never. The publisher's timer (services/directory-publisher.ts)
 * can't wait longer than 2^31 - 1 ms: past that, below zero, or a fraction of an hour that rounds to nothing, and Node
 * fires it every millisecond, a flood on the directory registry every community shares. The admin route
 * (routes/settings.ts) takes the same, and both Settings screens offer 0 to 24.
 */
export const MAX_DIRECTORY_PUSH_INTERVAL_HOURS = Math.floor((2 ** 31 - 1) / 3_600_000);
export function isDirectoryPushInterval(v: unknown): v is number {
    return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_DIRECTORY_PUSH_INTERVAL_HOURS;
}

const DIRECTORY_CHECKS: Record<(typeof COMMUNITY_DIRECTORY_FIELDS)[number], Check<unknown>> = {
    serviceRadius: orNull(radius),
    publishLocation: bool,
    publishMembers: bool,
    publishContacts: bool,
    publishHealth: bool,
    directoryPushIntervalHours: (v) => (isDirectoryPushInterval(v) ? v : BAD),
};

/**
 * A record as this server will keep it: each known field whose value it can take, nothing else. `left` names what was
 * left out (a field that is no community setting, or a value it can't take). Null for something that isn't a record.
 */
export function parseCommunitySettings(raw: unknown): { record: SyncCommunitySettings; left: string[] } | null {
    if (!isObject(raw) || !isObject(raw.localConfig) || !isObject(raw.nodeConfig) || !isObject(raw.directory)) return null;
    const left: string[] = [];
    const section = <K extends string>(name: string, given: Record<string, unknown>, checks: Record<K, Check<unknown>>): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(given)) {
            if (!Object.prototype.hasOwnProperty.call(checks, field)) {
                left.push(`${name}.${field} (not a community setting)`);
                continue;
            }
            const checked = checks[field as K](value);
            if (checked === BAD) left.push(`${name}.${field} (not a value it can take)`);
            else out[field] = checked;
        }
        return out;
    };
    return {
        record: {
            localConfig: section('localConfig', raw.localConfig, LOCAL_CONFIG_CHECKS),
            nodeConfig: section('nodeConfig', raw.nodeConfig, NODE_CONFIG_CHECKS),
            directory: section('directory', raw.directory, DIRECTORY_CHECKS),
        } as SyncCommunitySettings,
        left,
    };
}

// ── On a standby: kept, not applied ────────────────────────────────────────────────────────

export interface KeptCommunitySettings {
    record: SyncCommunitySettings;
    /** The `generatedAt` of the copy that first carried the record as it is. */
    copiedAt: string | null;
    /** When this server installed it; null until then, and again after a copy brings a record once more. */
    installedAt: string | null;
}

export function keptCommunitySettings(): KeptCommunitySettings | null {
    const value = nodeConfigRow(KEPT_COMMUNITY_SETTINGS_KEY);
    if (!value) return null;
    try {
        const kept = JSON.parse(value);
        return isObject(kept) && isObject(kept.record) ? kept as unknown as KeptCommunitySettings : null;
    } catch {
        return null;
    }
}

/**
 * A record from the main server, in a copy the import has verified (signed by the main server this standby pins): kept
 * as it can take it, applied to nothing. Written only when it differs from the one kept, or that one was installed.
 * Returns what was left out, and false, keeping nothing new, for something that isn't a record.
 */
export function keepMainServerCommunitySettings(raw: unknown, copiedAt: string | null): { kept: boolean; left: string[] } {
    const parsed = parseCommunitySettings(raw);
    if (!parsed) return { kept: false, left: ['the record (not a record)'] };
    const now = keptCommunitySettings();
    if (now && !now.installedAt && JSON.stringify(now.record) === JSON.stringify(parsed.record)) return { kept: true, left: parsed.left };
    const kept: KeptCommunitySettings = { record: parsed.record, copiedAt, installedAt: null };
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(KEPT_COMMUNITY_SETTINGS_KEY, JSON.stringify(kept));
    return { kept: true, left: parsed.left };
}

// ── A take-over or a hand promotion: installed ─────────────────────────────────────────────

export type InstallOutcome = { installed: true; detail: string } | { installed: false; why: string };

/**
 * Install the kept record: every community setting it names becomes this server's, as the main server had it, and no
 * other setting is touched. Safe to run again (the same record writes the same values). A field the record leaves out
 * keeps this server's own. Throws, with nothing marked installed, when local-config.json can't be written: the next run
 * (the take-over's step again, or the next start) installs it.
 */
export function installCommunitySettings(): InstallOutcome {
    const kept = keptCommunitySettings();
    if (!kept) {
        return { installed: false, why: 'the main server never sent its settings to this standby (it ran a version from before they travelled), so this server keeps its own' };
    }
    // Read again: the row is this server's own, but nothing is written from it unchecked.
    const parsed = parseCommunitySettings(kept.record);
    if (!parsed) return { installed: false, why: "this standby's copy of the main server's settings can't be read, so this server keeps its own" };
    const { localConfig: lc, nodeConfig: nc, directory: dir } = parsed.record;
    let count = 0;

    // local-config.json. Null is the main server's "none": a field with a default is removed, so the default applies.
    const updates: Partial<LocalConfig> = {};
    const own = getLocalConfig();
    for (const field of COMMUNITY_LOCAL_CONFIG_FIELDS) {
        if (!(field in lc)) continue;
        const value = (lc as Record<string, unknown>)[field];
        count++;
        if (field === 'gateway') {
            const g = value as SyncCommunitySettings['localConfig']['gateway'];
            const allowlist = own.gateway?.adminIpAllowlist;
            updates.gateway = g || allowlist ? { ...(g ?? {}), ...(allowlist ? { adminIpAllowlist: allowlist } : {}) } as GatewayConfig : undefined;
        } else if (field === 'currencyType' || field === 'currencyValue' || field === 'thresholds') {
            (updates as Record<string, unknown>)[field] = value ?? undefined;
        } else {
            (updates as Record<string, unknown>)[field] = value;
        }
    }

    const directory: Partial<NodeConfig> = {};
    for (const field of COMMUNITY_DIRECTORY_FIELDS) {
        if (!(field in dir)) continue;
        (directory as Record<string, unknown>)[field] = (dir as Record<string, unknown>)[field] ?? undefined;
        count++;
    }

    const upsert = db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const remove = db.prepare('DELETE FROM node_config WHERE key = ?');
    const installedAt = new Date().toISOString();
    // The file first: a crash before the rows below leaves the record not installed, and it is installed again.
    updateLocalConfig(updates);
    // saveLocalConfig logs a failed write (a full disk, a file it may not write) and carries on. Read back: a record marked
    // installed over a file that doesn't hold it would never be installed again, and the take-over would say it was.
    const saved = getLocalConfig() as unknown as Record<string, unknown>;
    const unsaved = Object.keys(updates).filter((f) => JSON.stringify(saved[f]) !== JSON.stringify((updates as Record<string, unknown>)[f]));
    if (unsaved.length > 0) {
        throw new Error(`local-config.json could not be written (${unsaved.join(', ')} not saved), so the community's settings are not installed yet`);
    }
    db.transaction(() => {
        for (const key of COMMUNITY_NODE_CONFIG_KEYS) {
            if (!(key in nc)) continue;
            const value = (nc as Record<string, string | null>)[key];
            if (value === null) remove.run(key);
            else upsert.run(key, value);
            count++;
        }
        if (Object.keys(directory).length > 0) updateNodeConfig(directory);
        upsert.run(KEPT_COMMUNITY_SETTINGS_KEY, JSON.stringify({ ...kept, installedAt }));
    })();

    const name = lc.communityName || lc.callsign || null;
    const hidden = [dir.publishContacts === false ? 'contacts' : null, dir.publishMembers === false ? 'member count' : null]
        .filter(Boolean);
    return {
        installed: true,
        detail: `${name ? `"${name}"; ` : ''}${count} setting(s) as the main server had them${kept.copiedAt ? ` at ${kept.copiedAt}` : ''}`
            + (hidden.length ? `; the directory is not sent its ${hidden.join(' or ')}` : ''),
    };
}

/**
 * At boot, on a main server: a standby promoted by hand (its role changed in .env, no take-over) installs its main
 * server's settings once, before the ledger audit and anything that publishes. A take-over installed them already in
 * its own step; a server that never was a standby has none kept. Never throws.
 */
export function installCommunitySettingsAtBoot(role: 'primary' | 'backup'): void {
    if (role !== 'primary') return;
    try {
        const kept = keptCommunitySettings();
        if (!kept || kept.installedAt) return;
        const done = installCommunitySettings();
        if (done.installed) logger.warn('SYS', `[Settings] This server was a standby and now runs as the main server: installed the community's settings (${done.detail}).`);
        else logger.warn('SYS', `[Settings] This server was a standby and now runs as the main server, but ${done.why}.`);
    } catch (e: any) {
        logger.error('SYS', `[Settings] Could not install the community's settings kept from the main server: ${e?.message || e}. They are tried again at the next start.`);
    }
}
