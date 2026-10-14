/**
 * Off-box backups: the main server sends its LOCKED backups, on a schedule, to S3-compatible stores its operator
 * chooses — so a lost disk, a lost server or a lost hosting account does not take the community with it.
 *
 * ## Optional, and nothing of ours
 *
 * No destination is built in and none is required. A server with none configured does exactly what it did before. The
 * operator picks the store (Cloudflare R2, Backblaze B2, Wasabi, AWS, a MinIO of their own…) and gives its endpoint,
 * bucket, region, an optional folder (prefix) and a key, in .env or in Settings. Nothing here ever talks to a BeanPool
 * server, domain or account.
 *
 * ## Only locked backups leave the server
 *
 * What goes off the box is the `.bpsealed` file the Backup tab's download makes (services/sealed-backup.ts): locked to
 * the community's recovery code and its owners, signed by the server. The store holds bytes it cannot read. It does see
 * the file's public header: which community and server it is from, when it was made, and the owners it is locked to.
 *
 * A server with no recovery code sends NOTHING off the box: its backups are readable by anyone who holds the file, and
 * a readable file in someone else's bucket is the community's every message in the clear. It says so in words, in the
 * Backup tab and in the owner's health, and keeps every other part of the server working (no hard gate).
 *
 * ## The main server only
 *
 * A standby's database is its main server's, copied; a second set of uploads would be the same community twice, and
 * one that had fallen behind could put an older copy beside the newest. So a standby touches no bucket at all. Each
 * tick reads the role, so a standby that takes over starts sending (with the destinations configured on it) and a
 * demoted main stops. A main server that has seen another take over its identity (services/identity-epoch.ts) stops
 * too: it is read-only and no longer the community's copy of record.
 *
 * ## Schedule, retries, retention
 *
 * Every {@link TICK_MS} the server checks each destination. One is due when its last good upload is older than the
 * interval (default {@link DEFAULT_OFFBOX_INTERVAL_HOURS} hours), or it never had one. All due destinations get the
 * SAME file, made once per run. Each request is tried three times (services/offbox-s3.ts); a destination that still
 * failed is tried again after 15 minutes, then 30, doubling up to 6 hours, and shows as failing until it works.
 *
 * Each destination keeps this community's backups for {@link DEFAULT_OFFBOX_RETENTION_DAYS} days by default and never
 * longer than {@link MAX_OFFBOX_RETENTION_DAYS}: a backup is the whole database, so a member who deletes their account
 * is in every backup made before, and the members' guide promises that this ends within 30 days. Pruning runs after
 * every upload and every hour besides, also while nothing is being sent (no recovery code), and deletes only files this
 * feature names (`beanpool-backup-<time>.bpsealed`) in this community's own folder. A destination removed from the
 * settings keeps what it holds: the server cannot reach it any more, and the operator manual says so.
 *
 * ## Credentials
 *
 * Kept in .env, or in data/offbox-backups.json (mode 600) when set in Settings — never in the database, so never in a
 * snapshot, a backup or a standby's copy, and never in node_config.json. Never logged: every message names a
 * destination by its label and bucket. Never shown back: the key id is shortened, and the secret is only "set".
 */

import fs from 'node:fs';
import { writeFileAtomic } from '../write-file-atomic.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { logger } from '../logger.js';
import { getNodeRole } from '../config/node-role.js';
import { backupLockState, createSealedBackup, SEALED_BACKUP_EXT, type BackupLock } from './sealed-backup.js';
import { getReplacedInfo } from './identity-epoch.js';
import { OffboxBucket, OffboxS3Error, type OffboxObject, type OffboxTuning } from './offbox-s3.js';

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

/** The destinations, schedule and retention set in Settings. Credentials included, so mode 600 and never in a backup. */
export const OFFBOX_SETTINGS_FILE = 'offbox-backups.json';
/** What each destination last did: times, sizes and errors, never a credential. */
export const OFFBOX_STATE_FILE = 'offbox-backups-state.json';

export const DEFAULT_OFFBOX_INTERVAL_HOURS = 24;
export const MAX_OFFBOX_INTERVAL_HOURS = 168;
export const DEFAULT_OFFBOX_RETENTION_DAYS = 30;
/** The deletion promise: a deleted member's data is in no off-box backup after 30 days. */
export const MAX_OFFBOX_RETENTION_DAYS = 30;
export const MAX_OFFBOX_DESTINATIONS = 5;
/** BACKUP_OFFBOX_1_… and BACKUP_OFFBOX_2_…, the two docker-compose.yml passes through; more go in Settings. */
const ENV_SLOTS = 2;

const TICK_MS = 5 * 60_000;
/** The first check after a start: soon, but not in the boot's own minute. */
const FIRST_TICK_MS = 2 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const FIRST_RETRY_MS = 15 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;

/** The name of every file this feature puts in a store, and the only names its pruning ever deletes. */
const BACKUP_NAME = /^beanpool-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.bpsealed$/;
/** A community's folder under a destination's prefix: its id (16 hex characters today). */
const COMMUNITY_FOLDER = /^[A-Za-z0-9_-]{1,128}$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9!_.*'()-]{1,128}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// ── Settings ───────────────────────────────────────────────────────────────────────────────

/** One place backups go. `secretAccessKey` never leaves this module except to the S3 client. */
export interface OffboxDestination {
    /** `env-1`… for .env, `d-<hex>` for one set in Settings. */
    id: string;
    name: string;
    source: 'env' | 'settings';
    endpoint: string;
    bucket: string;
    region: string;
    /** '' or a folder ending in '/'. */
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
}

/** A destination that cannot be used, and why — by setting name, never a value. */
export interface BrokenDestination {
    id: string;
    name: string;
    source: 'env' | 'settings';
    problems: string[];
}

interface StoredSettings {
    intervalHours?: number | null;
    retentionDays?: number | null;
    destinations?: Partial<OffboxDestination>[];
}

export interface DestinationInput {
    name?: unknown;
    endpoint?: unknown;
    bucket?: unknown;
    region?: unknown;
    prefix?: unknown;
    accessKeyId?: unknown;
    secretAccessKey?: unknown;
}

/** The parts of a destination's address. A change to any of them is a new place: its history starts again. */
function whereOf(d: Pick<OffboxDestination, 'endpoint' | 'bucket' | 'prefix'>): string {
    return `${d.endpoint}|${d.bucket}|${d.prefix}`;
}

/** '' for none, else `a/b/` — each segment checked, no `.` or `..`; slashes at the ends and doubled ones tidied away. Null when unusable. */
export function normalisePrefix(raw: unknown): string | null {
    const s = typeof raw === 'string' ? raw.trim().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '') : '';
    if (!s) return '';
    if (s.length > 256) return null;
    const segments = s.split('/');
    for (const seg of segments) {
        if (!PREFIX_SEGMENT.test(seg) || seg === '.' || seg === '..') return null;
    }
    return `${segments.join('/')}/`;
}

/**
 * Check a destination. Every problem is named by the setting it is about, never by its value, so the list is safe for
 * a log and a screen. `names` maps each field to what the operator calls it (an env name, or a Settings label).
 */
export function checkDestination(input: DestinationInput, names: Record<keyof DestinationInput, string>):
    { ok: true; value: Omit<OffboxDestination, 'id' | 'source'> } | { ok: false; problems: string[] } {
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const problems: string[] = [];
    const missing: string[] = [];
    const endpointRaw = str(input.endpoint);
    const bucket = str(input.bucket);
    const region = str(input.region);
    const accessKeyId = str(input.accessKeyId);
    const secretAccessKey = typeof input.secretAccessKey === 'string' ? input.secretAccessKey : '';
    const name = nameOf(input.name);
    if (!endpointRaw) missing.push(names.endpoint);
    if (!bucket) missing.push(names.bucket);
    if (!region) missing.push(names.region);
    if (!accessKeyId) missing.push(names.accessKeyId);
    if (!secretAccessKey.trim()) missing.push(names.secretAccessKey);
    if (missing.length) problems.push(`missing: ${missing.join(', ')}`);

    let endpoint = '';
    if (endpointRaw) {
        let url: URL | null = null;
        try { url = new URL(endpointRaw); } catch { /* reported below */ }
        if (!url) problems.push(`${names.endpoint} is not a URL`);
        else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
            problems.push(`${names.endpoint} must start with https:// (a backup never travels in the clear)`);
        } else if ((url.pathname && url.pathname !== '/') || url.search || url.hash || url.username || url.password) {
            problems.push(`${names.endpoint} must be the bare address, e.g. https://<account>.r2.cloudflarestorage.com: no path `
                + `(the bucket goes in ${names.bucket}), no query, no password`);
        } else endpoint = url.origin;
    }
    if (bucket && !BUCKET_NAME.test(bucket)) problems.push(`${names.bucket} is not a bucket name (3-63 lowercase letters, digits, dots, hyphens)`);
    if (region && !REGION_NAME.test(region)) problems.push(`${names.region} is not a region name (use "auto" for Cloudflare R2)`);
    if (accessKeyId && (/\s/.test(accessKeyId) || accessKeyId.length > 256)) problems.push(`${names.accessKeyId} is not a key id`);
    if (secretAccessKey.trim() && (secretAccessKey !== secretAccessKey.trim() || secretAccessKey.length > 512)) {
        problems.push(`${names.secretAccessKey} has spaces at its start or end, or is too long`);
    }
    const prefix = normalisePrefix(input.prefix);
    if (prefix === null) problems.push(`${names.prefix} is not a folder name (letters, digits and ! _ . * ' ( ) -, separated by /)`);
    if (problems.length) return { ok: false, problems };
    return { ok: true, value: { name: name || `${bucket} at ${new URL(endpoint).host}`, endpoint, bucket, region, prefix: prefix!, accessKeyId, secretAccessKey } };
}

/**
 * A destination's name as typed, in any script: only control and formatting characters (a newline, a right-to-left
 * override, a zero-width space) go, which is what keeps it safe in a log line and on a screen. Spaces are tidied, and it
 * is cut at 40 characters, never through one.
 */
function nameOf(raw: unknown): string {
    const s = typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim() : '';
    return Array.from(s).slice(0, 40).join('').trim();
}

const SETTINGS_NAMES: Record<keyof DestinationInput, string> = {
    name: 'name', endpoint: 'endpoint', bucket: 'bucket', region: 'region', prefix: 'folder',
    accessKeyId: 'access key id', secretAccessKey: 'secret access key',
};

function envNames(n: number): Record<keyof DestinationInput, string> {
    const p = `BACKUP_OFFBOX_${n}_`;
    return {
        name: `${p}NAME`, endpoint: `${p}ENDPOINT`, bucket: `${p}BUCKET`, region: `${p}REGION`, prefix: `${p}PREFIX`,
        accessKeyId: `${p}ACCESS_KEY_ID`, secretAccessKey: `${p}SECRET_ACCESS_KEY`,
    };
}

function readStoredSettings(): StoredSettings {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir(), OFFBOX_SETTINGS_FILE), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function writeStoredSettings(s: StoredSettings): void {
    const file = path.join(dataDir(), OFFBOX_SETTINGS_FILE);
    writeFileAtomic(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* the rename kept the temp file's mode */ }
}

const isInterval = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_OFFBOX_INTERVAL_HOURS;
const isRetention = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_OFFBOX_RETENTION_DAYS;

export interface OffboxSettings {
    intervalHours: number;
    intervalFrom: 'settings' | 'env' | 'default';
    retentionDays: number;
    retentionFrom: 'settings' | 'env' | 'default';
    /** The ones backups go to: the first {@link MAX_OFFBOX_DESTINATIONS} usable ones, .env's first. */
    destinations: OffboxDestination[];
    /**
     * Usable ones past {@link MAX_OFFBOX_DESTINATIONS}: sent nothing, and listed in `broken` so the owner sees why, but
     * still pruned — the backups already there keep the 30-day promise.
     */
    overflow: OffboxDestination[];
    broken: BrokenDestination[];
}

export const TOO_MANY_DESTINATIONS = `more than ${MAX_OFFBOX_DESTINATIONS} destinations: this one gets no new backups, and its old `
    + `ones are still removed on time. Remove one, here or in .env, to use it`;

/** Everything configured, from Settings and .env. A setting from Settings wins over .env; .env over the default. */
export function readOffboxSettings(env: NodeJS.ProcessEnv = process.env): OffboxSettings {
    const stored = readStoredSettings();
    const envNumber = (name: string) => {
        const raw = String(env[name] ?? '').trim();
        return raw ? Number(raw) : null;
    };
    const envInterval = envNumber('BACKUP_OFFBOX_INTERVAL_HOURS');
    const envRetention = envNumber('BACKUP_OFFBOX_RETENTION_DAYS');
    const [intervalHours, intervalFrom] = isInterval(stored.intervalHours) ? [stored.intervalHours, 'settings' as const]
        : isInterval(envInterval) ? [envInterval, 'env' as const] : [DEFAULT_OFFBOX_INTERVAL_HOURS, 'default' as const];
    // Past the promise from .env is read as the promise, never as longer.
    const [retentionDays, retentionFrom] = isRetention(stored.retentionDays) ? [stored.retentionDays, 'settings' as const]
        : envRetention !== null && Number.isInteger(envRetention) && envRetention >= 1
            ? [Math.min(envRetention, MAX_OFFBOX_RETENTION_DAYS), 'env' as const]
            : [DEFAULT_OFFBOX_RETENTION_DAYS, 'default' as const];

    const destinations: OffboxDestination[] = [];
    const broken: BrokenDestination[] = [];
    for (let n = 1; n <= ENV_SLOTS; n++) {
        const names = envNames(n);
        const input: DestinationInput = {
            name: env[names.name], endpoint: env[names.endpoint], bucket: env[names.bucket], region: env[names.region],
            prefix: env[names.prefix], accessKeyId: env[names.accessKeyId], secretAccessKey: env[names.secretAccessKey],
        };
        const any = Object.entries(input).some(([k, v]) => k !== 'name' && typeof v === 'string' && v.trim() !== '');
        if (!any) continue;
        const checked = checkDestination(input, names);
        if (checked.ok) destinations.push({ id: `env-${n}`, source: 'env', ...checked.value });
        else broken.push({ id: `env-${n}`, name: `.env destination ${n}`, source: 'env', problems: checked.problems });
    }
    for (const d of Array.isArray(stored.destinations) ? stored.destinations : []) {
        const id = typeof d?.id === 'string' && /^d-[0-9a-f]{8,32}$/.test(d.id) ? d.id : null;
        if (!id) continue;
        const checked = checkDestination(d as DestinationInput, SETTINGS_NAMES);
        if (checked.ok) destinations.push({ id, source: 'settings', ...checked.value });
        else broken.push({ id, name: nameOf(d.name) || id, source: 'settings', problems: checked.problems });
    }
    const overflow = destinations.slice(MAX_OFFBOX_DESTINATIONS);
    for (const d of overflow) broken.push({ id: d.id, name: d.name, source: d.source, problems: [TOO_MANY_DESTINATIONS] });
    return {
        intervalHours, intervalFrom, retentionDays, retentionFrom,
        destinations: destinations.slice(0, MAX_OFFBOX_DESTINATIONS), overflow, broken,
    };
}

export type SettingsUpdate = {
    intervalHours?: unknown;
    retentionDays?: unknown;
    /** Add one, or change one by `id`. A change with no `secretAccessKey` or `accessKeyId` keeps the stored one. */
    destination?: DestinationInput & { id?: unknown };
    /** Remove one set in Settings, by id. */
    removeId?: unknown;
};

/**
 * Change what Settings holds. Refuses (`ok: false` and a sentence) anything out of range or unusable, changing nothing.
 * Destinations from .env are not changed here: they are the operator's file.
 */
export function updateOffboxSettings(update: SettingsUpdate): { ok: true } | { ok: false; error: string } {
    const stored = readStoredSettings();
    const next: StoredSettings = {
        intervalHours: stored.intervalHours ?? null,
        retentionDays: stored.retentionDays ?? null,
        destinations: Array.isArray(stored.destinations) ? stored.destinations.slice() : [],
    };
    if (update.intervalHours !== undefined) {
        if (update.intervalHours !== null && !isInterval(update.intervalHours)) {
            return { ok: false, error: `intervalHours must be a whole number of hours from 1 to ${MAX_OFFBOX_INTERVAL_HOURS}` };
        }
        next.intervalHours = update.intervalHours as number | null;
    }
    if (update.retentionDays !== undefined) {
        if (update.retentionDays !== null && !isRetention(update.retentionDays)) {
            return { ok: false, error: `retentionDays must be a whole number of days from 1 to ${MAX_OFFBOX_RETENTION_DAYS}: a deleted `
                + `member's data must be gone from every off-box backup within ${MAX_OFFBOX_RETENTION_DAYS} days` };
        }
        next.retentionDays = update.retentionDays as number | null;
    }
    if (update.removeId !== undefined) {
        const before = next.destinations!.length;
        next.destinations = next.destinations!.filter((d) => d?.id !== update.removeId);
        if (next.destinations.length === before) return { ok: false, error: 'No destination with that id is set in Settings' };
    }
    if (update.destination !== undefined) {
        const input = update.destination ?? {};
        const id = typeof input.id === 'string' && input.id ? input.id : null;
        const existing = id ? next.destinations!.find((d) => d?.id === id) : null;
        if (id && !existing) return { ok: false, error: 'No destination with that id is set in Settings' };
        const merged: DestinationInput = { ...input };
        // The screen never has the secret or the whole key id, so a change that leaves them empty keeps the stored ones.
        if (existing && (typeof input.secretAccessKey !== 'string' || input.secretAccessKey === '')) {
            merged.secretAccessKey = existing.secretAccessKey;
        }
        if (existing && (typeof input.accessKeyId !== 'string' || input.accessKeyId.trim() === '')) {
            merged.accessKeyId = existing.accessKeyId;
        }
        const checked = checkDestination(merged, SETTINGS_NAMES);
        if (!checked.ok) return { ok: false, error: `This destination can't be used: ${checked.problems.join('; ')}` };
        const configured = readOffboxSettings();
        if (!existing && configured.destinations.length + configured.overflow.length >= MAX_OFFBOX_DESTINATIONS) {
            return { ok: false, error: `At most ${MAX_OFFBOX_DESTINATIONS} destinations` };
        }
        const value = { id: existing?.id ?? `d-${crypto.randomBytes(6).toString('hex')}`, ...checked.value };
        next.destinations = existing
            ? next.destinations!.map((d) => (d?.id === existing.id ? value : d))
            : [...next.destinations!, value];
    }
    writeStoredSettings(next);
    return { ok: true };
}

// ── State ──────────────────────────────────────────────────────────────────────────────────

interface DestinationState {
    where: string;
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    lastSuccessKey: string | null;
    lastSuccessBytes: number | null;
    lastError: string | null;
    failures: number;
    lastPruneAt: number | null;
    lastPruned: number;
    lastPruneError: string | null;
}

interface OffboxState {
    destinations: Record<string, DestinationState>;
    lastRunAt: number | null;
    lastRunError: string | null;
}

function readState(): OffboxState {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir(), OFFBOX_STATE_FILE), 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.destinations && typeof parsed.destinations === 'object') return parsed;
    } catch { /* none yet */ }
    return { destinations: {}, lastRunAt: null, lastRunError: null };
}

function writeState(s: OffboxState): void {
    const file = path.join(dataDir(), OFFBOX_STATE_FILE);
    try {
        writeFileAtomic(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    } catch (e) {
        logger.warn('SYS', `[Off-box] Could not save what the off-box backups did: ${(e as Error)?.message || e}`);
    }
}

function destState(s: OffboxState, d: OffboxDestination): DestinationState {
    const have = s.destinations[d.id];
    if (have && have.where === whereOf(d)) return have;
    // A new destination, or one now pointing somewhere else: its history starts again.
    const fresh: DestinationState = {
        where: whereOf(d), lastAttemptAt: null, lastSuccessAt: null, lastSuccessKey: null, lastSuccessBytes: null,
        lastError: null, failures: 0, lastPruneAt: null, lastPruned: 0, lastPruneError: null,
    };
    s.destinations[d.id] = fresh;
    return fresh;
}

function retryDelayMs(failures: number): number {
    return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1));
}

function staleAfterMs(intervalHours: number): number {
    const interval = intervalHours * 3_600_000;
    return interval + Math.max(3_600_000, interval / 2);
}

/**
 * When this destination is next tried: by the retry ladder while its last try failed (so a failing one is retried, and
 * its warning cleared, as soon as it works again, even right after a good upload), else at the interval after the last
 * upload that arrived. 0 for one never tried.
 */
function nextAttemptAt(st: DestinationState, intervalHours: number): number {
    if (st.failures > 0 && st.lastAttemptAt !== null) return st.lastAttemptAt + retryDelayMs(st.failures);
    return st.lastSuccessAt === null ? 0 : st.lastSuccessAt + intervalHours * 3_600_000;
}

// ── Where files go ─────────────────────────────────────────────────────────────────────────

function communityFolder(): string | null {
    try {
        const id = JSON.parse(fs.readFileSync(path.join(dataDir(), 'genesis.json'), 'utf8'))?.communityId;
        return typeof id === 'string' && COMMUNITY_FOLDER.test(id) ? id : null;
    } catch {
        return null;
    }
}

/** When a file this feature named was made, from its name; null for any other name. */
function timeFromName(file: string): number | null {
    const m = BACKUP_NAME.exec(file);
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return Number.isFinite(t) ? t : null;
}

/** A key this feature made under `prefix`: `<prefix><community>/beanpool-backup-<time>.bpsealed`. */
function parseBackupKey(prefix: string, key: string): { community: string; file: string; madeAt: number } | null {
    if (!key.startsWith(prefix)) return null;
    const rest = key.slice(prefix.length).split('/');
    if (rest.length !== 2 || !COMMUNITY_FOLDER.test(rest[0])) return null;
    const madeAt = timeFromName(rest[1]);
    return madeAt === null ? null : { community: rest[0], file: rest[1], madeAt };
}

let tuning: Partial<OffboxTuning> = {};
/** Tests: fewer, quicker retries. */
export function setOffboxTuningForTests(t: Partial<OffboxTuning>): void {
    tuning = t;
}

function clientFor(d: OffboxDestination): OffboxBucket {
    return new OffboxBucket(d, tuning);
}

/** An error's words for the state file and the screens: a store's sentence as it is, anything else as its message. */
function wordsOf(e: unknown): string {
    if (e instanceof OffboxS3Error) return e.message;
    return String((e as Error)?.message || e).slice(0, 300);
}

// ── Running ────────────────────────────────────────────────────────────────────────────────

/** Why nothing is sent now, or null when this server sends. */
type Standing =
    | { sends: true; lock: Extract<BackupLock, { locked: true }> }
    | { sends: false; why: 'standby' | 'replaced' | 'none' | 'not-locked'; message: string; lock: BackupLock | null };

export const NOT_LOCKED_OFFBOX_MESSAGE = 'Nothing goes off the box: this server has no recovery code, so its backups are not locked, '
    + 'and only a locked backup may leave the server. Make a recovery code (Who can unlock this community) and the next backup '
    + 'goes off the box locked. Everything else keeps working.';

function standing(settings: OffboxSettings): Standing {
    if (getNodeRole() !== 'primary') {
        return { sends: false, why: 'standby', lock: null, message: 'This server is a standby: it sends no backups off the box (its main server does). '
            + 'If it takes over, it starts sending to the destinations set on it.' };
    }
    if (getReplacedInfo()) {
        return { sends: false, why: 'replaced', lock: null, message: 'This server was replaced by another that took over the community: '
            + 'it sends no more backups off the box.' };
    }
    if (settings.destinations.length === 0) {
        return { sends: false, why: 'none', lock: null, message: settings.broken.length
            ? 'No usable destination: fix the one below and backups go off the box.'
            : 'No destination set: backups stay on this server only.' };
    }
    const lock = backupLockState();
    if (!lock.locked) return { sends: false, why: 'not-locked', lock, message: NOT_LOCKED_OFFBOX_MESSAGE };
    return { sends: true, lock };
}

let running: Promise<RunResult> | null = null;

export interface RunResult {
    /** Destinations a backup went to, by id. */
    sent: string[];
    /** Destinations it did not reach, by id, with why. */
    failed: { id: string; error: string }[];
    pruned: number;
    /** Set when nothing may be sent, with why. */
    skipped: Extract<Standing, { sends: false }>['why'] | null;
}

/** Make one sealed backup into a temp file under the data folder, with its SHA-256. */
async function sealedBackupFile(): Promise<{ file: string; filename: string; sha256: string; bytes: number }> {
    const backup = await createSealedBackup();
    const file = path.join(dataDir(), `.offbox-${crypto.randomBytes(6).toString('hex')}${SEALED_BACKUP_EXT}`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    try {
        await pipeline(
            backup.body,
            new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } }),
            fs.createWriteStream(file, { mode: 0o600 }),
        );
    } catch (e) {
        backup.cleanup();
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
        throw e;
    }
    backup.cleanup();
    return { file, filename: backup.filename, sha256: hash.digest('hex'), bytes };
}

/**
 * Delete this community's backups past the retention in one destination. Only names this feature makes, only in this
 * community's folder. A file's age is the older of the time in its name and the store's own time for it, so a server
 * clock that ran slow cannot keep one past the promise.
 */
async function prune(d: OffboxDestination, st: DestinationState, retentionDays: number, community: string, now: number): Promise<number> {
    const bucket = clientFor(d);
    const folder = `${d.prefix}${community}/`;
    const cutoff = now - retentionDays * 86_400_000;
    let removed = 0;
    try {
        const objects = await bucket.list(folder);
        for (const o of objects) {
            const parsed = parseBackupKey(d.prefix, o.key);
            if (!parsed || parsed.community !== community) continue;
            const madeAt = Math.min(parsed.madeAt, o.mtimeMs || parsed.madeAt);
            if (madeAt > cutoff) continue;
            await bucket.delete(o.key);
            removed++;
        }
        st.lastPruneError = null;
        if (removed) logger.info('SYS', `[Off-box] ${d.name}: removed ${removed} backup(s) older than ${retentionDays} days`);
    } catch (e) {
        st.lastPruneError = wordsOf(e);
        logger.warn('SYS', `[Off-box] ${d.name}: could not remove backups older than ${retentionDays} days: ${st.lastPruneError}`);
    }
    st.lastPruneAt = now;
    st.lastPruned = removed;
    return removed;
}

async function runInner(opts: { force: boolean; now: number }): Promise<RunResult> {
    const settings = readOffboxSettings();
    const state = readState();
    const result: RunResult = { sent: [], failed: [], pruned: 0, skipped: null };
    const stand = standing(settings);
    // A standby, and a replaced main server, leave the stores alone altogether; a server with no destination has
    // nothing to do, and writes nothing (this runs every five minutes on every server).
    if (!stand.sends && (stand.why === 'standby' || stand.why === 'replaced' || settings.destinations.length + settings.overflow.length === 0)) {
        result.skipped = stand.why;
        return result;
    }
    const community = communityFolder();
    const due = stand.sends
        ? settings.destinations.filter((d) => opts.force || nextAttemptAt(destState(state, d), settings.intervalHours) <= opts.now)
        : [];
    if (!stand.sends) result.skipped = stand.why;

    if (due.length > 0 && community) {
        let made: Awaited<ReturnType<typeof sealedBackupFile>> | null = null;
        try {
            made = await sealedBackupFile();
        } catch (e) {
            const words = `the backup could not be made: ${wordsOf(e)}`;
            state.lastRunError = words;
            for (const d of due) {
                const st = destState(state, d);
                st.lastAttemptAt = opts.now;
                st.failures++;
                st.lastError = words;
                result.failed.push({ id: d.id, error: words });
            }
            logger.warn('SYS', `[Off-box] Nothing sent: ${words}`);
        }
        if (made) {
            state.lastRunError = null;
            const key = (d: OffboxDestination) => `${d.prefix}${community}/${made!.filename}`;
            try {
                for (const d of due) {
                    const st = destState(state, d);
                    st.lastAttemptAt = opts.now;
                    try {
                        await clientFor(d).putFile(key(d), made.file, made.sha256);
                        st.lastSuccessAt = opts.now;
                        st.lastSuccessKey = key(d);
                        st.lastSuccessBytes = made.bytes;
                        st.lastError = null;
                        st.failures = 0;
                        result.sent.push(d.id);
                        logger.info('SYS', `[Off-box] ${d.name}: sent ${made.filename} (${made.bytes} bytes, locked)`);
                    } catch (e) {
                        st.failures++;
                        st.lastError = wordsOf(e);
                        result.failed.push({ id: d.id, error: st.lastError });
                        logger.warn('SYS', `[Off-box] ${d.name}: backup not sent (try ${st.failures}): ${st.lastError}. `
                            + `Next try in ${Math.round(retryDelayMs(st.failures) / 60_000)} minutes.`);
                    }
                    writeState(state);
                }
            } finally {
                try { fs.rmSync(made.file, { force: true }); } catch { /* best effort */ }
            }
        }
    } else if (due.length > 0) {
        const words = 'this server has no community yet (no genesis.json)';
        for (const d of due) {
            const st = destState(state, d);
            st.lastAttemptAt = opts.now;
            st.failures++;
            st.lastError = words;
            result.failed.push({ id: d.id, error: words });
        }
    }

    // Retention, on every destination this server can reach: after a run that sent, and hourly besides — also while
    // nothing may be sent, because the promise to a deleted member does not wait for a recovery code.
    let pruned = false;
    if (community) {
        for (const d of [...settings.destinations, ...settings.overflow]) {
            const st = destState(state, d);
            if (!opts.force && !result.sent.includes(d.id) && st.lastPruneAt !== null && opts.now - st.lastPruneAt < PRUNE_EVERY_MS) continue;
            result.pruned += await prune(d, st, settings.retentionDays, community, opts.now);
            pruned = true;
        }
    }
    // Only when something was tried: most checks find nothing due, and need not touch the disk.
    if (due.length > 0 || pruned) {
        state.lastRunAt = opts.now;
        writeState(state);
    }
    return result;
}

/**
 * Check every destination now and send to each one that is due (all of them with `force`), then prune. One run at a
 * time: a second call while one runs gets that run's result. Never throws.
 */
export function runOffboxBackups(opts: { force?: boolean; now?: number } = {}): Promise<RunResult> {
    if (running) return running;
    running = runInner({ force: !!opts.force, now: opts.now ?? Date.now() })
        .catch((e): RunResult => {
            logger.warn('SYS', `[Off-box] The run failed: ${wordsOf(e)}`);
            return { sent: [], failed: [], pruned: 0, skipped: null };
        })
        .finally(() => { running = null; });
    return running;
}

export function offboxRunning(): boolean {
    return running !== null;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Remove what a run that was cut off (a crash, a deploy, an OOM kill, a restart mid-upload) left in the data folder,
 * which nothing else would ever remove:
 *  - `.offbox-<hex>.bpsealed`, a locked backup on its way out;
 *  - `.backup-tmp-<hex>/`, a backup's staging folder (services/sealed-backup.ts). It holds an UNLOCKED copy of the
 *    database, and a member who deletes their account afterwards would stay in it for good. A run that FAILS removes its
 *    own (createSealedBackup and {@link sealedBackupFile} clean up on any error); this is for one that was killed.
 * Only at start (boot step 2.62, before the HTTPS server), when no backup or download can be using either.
 */
function removeLeftovers(): void {
    let names: string[];
    try { names = fs.readdirSync(dataDir()); } catch { return; /* no data folder yet */ }
    for (const f of names) {
        if (!/^\.offbox-[0-9a-f]{12}\.bpsealed$/.test(f) && !/^\.backup-tmp-[0-9a-f]{12}$/.test(f)) continue;
        try {
            fs.rmSync(path.join(dataDir(), f), { recursive: true, force: true });
            logger.info('SYS', `[Off-box] Removed ${f}, left by a backup that was cut off`);
        } catch (e) {
            logger.warn('SYS', `[Off-box] Could not remove ${f}, left by a backup that was cut off: ${(e as Error)?.message || e}`);
        }
    }
}

/** Start the checks: the first a couple of minutes after boot, then every five minutes. Every role: each tick reads it. */
export function initOffboxBackups(): void {
    stopOffboxBackups();
    removeLeftovers();
    const settings = readOffboxSettings();
    if (settings.destinations.length || settings.broken.length) {
        logger.info('SYS', `[Off-box] ${settings.destinations.length} destination(s), every ${settings.intervalHours} h, kept ${settings.retentionDays} days`
            + (settings.broken.length ? `; ${settings.broken.length} not usable: ${settings.broken.map((b) => `${b.name} (${b.problems.join('; ')})`).join(', ')}` : ''));
    }
    firstTimer = setTimeout(() => { void runOffboxBackups(); }, FIRST_TICK_MS);
    firstTimer.unref?.();
    tickTimer = setInterval(() => { void runOffboxBackups(); }, TICK_MS);
    tickTimer.unref?.();
}

export function stopOffboxBackups(): void {
    if (tickTimer) clearInterval(tickTimer);
    if (firstTimer) clearTimeout(firstTimer);
    tickTimer = null;
    firstTimer = null;
}

// ── What the owner sees ────────────────────────────────────────────────────────────────────

/** A key id as a screen may show it: enough to recognise, never the whole. */
export function maskKeyId(id: string): string {
    if (id.length <= 6) return `${id.slice(0, 1)}…`;
    return `${id.slice(0, 4)}…${id.slice(-2)}`;
}

export type DestinationHealth = 'ok' | 'waiting' | 'failing' | 'stale' | 'broken';

export interface DestinationStatus {
    id: string;
    name: string;
    source: 'env' | 'settings';
    endpoint: string | null;
    bucket: string | null;
    region: string | null;
    prefix: string | null;
    /** Shortened ({@link maskKeyId}); null for a broken destination. */
    accessKeyId: string | null;
    /** Whether a secret is set. The secret itself is never sent. */
    secretSet: boolean;
    problems: string[];
    health: DestinationHealth;
    lastSuccessAt: number | null;
    lastSuccessBytes: number | null;
    lastAttemptAt: number | null;
    lastError: string | null;
    failures: number;
    nextAttemptAt: number | null;
    lastPruneAt: number | null;
    lastPruneError: string | null;
}

export interface OffboxStatus {
    /** `sending`: this server sends; otherwise why it does not. */
    state: 'sending' | 'none' | 'not-locked' | 'standby' | 'replaced';
    message: string;
    intervalHours: number;
    intervalFrom: OffboxSettings['intervalFrom'];
    retentionDays: number;
    retentionFrom: OffboxSettings['retentionFrom'];
    maxRetentionDays: number;
    maxIntervalHours: number;
    running: boolean;
    destinations: DestinationStatus[];
}

export function getOffboxStatus(now = Date.now()): OffboxStatus {
    const settings = readOffboxSettings();
    const state = readState();
    const stand = standing(settings);
    const destinations: DestinationStatus[] = settings.destinations.map((d) => {
        const have = state.destinations[d.id];
        const st = have && have.where === whereOf(d) ? have : null;
        const lastSuccessAt = st?.lastSuccessAt ?? null;
        let health: DestinationHealth = 'waiting';
        if (st && st.failures > 0) health = 'failing';
        else if (lastSuccessAt !== null) health = now - lastSuccessAt > staleAfterMs(settings.intervalHours) ? 'stale' : 'ok';
        return {
            id: d.id, name: d.name, source: d.source, endpoint: d.endpoint, bucket: d.bucket, region: d.region, prefix: d.prefix,
            accessKeyId: maskKeyId(d.accessKeyId), secretSet: true, problems: [], health,
            lastSuccessAt, lastSuccessBytes: st?.lastSuccessBytes ?? null, lastAttemptAt: st?.lastAttemptAt ?? null,
            lastError: st?.lastError ?? null, failures: st?.failures ?? 0,
            nextAttemptAt: stand.sends ? (st ? nextAttemptAt(st, settings.intervalHours) : now) : null,
            lastPruneAt: st?.lastPruneAt ?? null, lastPruneError: st?.lastPruneError ?? null,
        };
    });
    for (const b of settings.broken) {
        // One past five is still pruned: its errors at that show like any other's.
        const over = settings.overflow.find((d) => d.id === b.id);
        const ost = over && state.destinations[b.id]?.where === whereOf(over) ? state.destinations[b.id] : null;
        destinations.push({
            id: b.id, name: b.name, source: b.source, endpoint: null, bucket: null, region: null, prefix: null, accessKeyId: null,
            secretSet: false, problems: b.problems, health: 'broken', lastSuccessAt: null, lastSuccessBytes: null, lastAttemptAt: null,
            lastError: null, failures: 0, nextAttemptAt: null, lastPruneAt: ost?.lastPruneAt ?? null, lastPruneError: ost?.lastPruneError ?? null,
        });
    }
    return {
        state: stand.sends ? 'sending' : stand.why,
        message: stand.sends
            ? `Locked backups go off the box every ${settings.intervalHours} hours to ${settings.destinations.length} `
                + `destination${settings.destinations.length === 1 ? '' : 's'}, each kept ${settings.retentionDays} days. ${stand.lock.message}`
            : stand.message,
        intervalHours: settings.intervalHours, intervalFrom: settings.intervalFrom,
        retentionDays: settings.retentionDays, retentionFrom: settings.retentionFrom,
        maxRetentionDays: MAX_OFFBOX_RETENTION_DAYS, maxIntervalHours: MAX_OFFBOX_INTERVAL_HOURS,
        running: offboxRunning(), destinations,
    };
}

/**
 * The owner's health lines (Home and the diagnostics): only what needs them, in words, with nothing about any member.
 * Null when there is nothing configured and nothing to say, or on a standby.
 */
export function getOffboxHealth(now = Date.now()): { problems: string[] } | null {
    const status = getOffboxStatus(now);
    if (status.state === 'standby' || status.state === 'replaced') return null;
    if (status.destinations.length === 0) return null;
    const problems: string[] = [];
    if (status.state === 'not-locked') problems.push(status.message);
    const when = (t: number | null) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never');
    for (const d of status.destinations) {
        if (d.health === 'broken') {
            problems.push(`Off-box destination "${d.name}" can't be used: ${d.problems.join('; ')}.`);
            continue;
        }
        if (status.state === 'sending' && d.health === 'failing') {
            problems.push(`Off-box backup to "${d.name}" failed${d.failures > 1 ? ` ${d.failures} times in a row` : ''}: ${d.lastError}. `
                + `Last one that arrived: ${when(d.lastSuccessAt)}. Next try: ${when(d.nextAttemptAt)}.`);
        } else if (status.state === 'sending' && d.health === 'stale') {
            problems.push(`No off-box backup has reached "${d.name}" since ${when(d.lastSuccessAt)}.`);
        }
        if (d.lastPruneError) problems.push(`Old off-box backups in "${d.name}" could not be removed: ${d.lastPruneError}.`);
    }
    return { problems };
}

// ── Reading a destination back (restore) ───────────────────────────────────────────────────

export interface ListedBackup {
    key: string;
    community: string;
    file: string;
    madeAt: number;
    bytes: number;
    /** True for this server's own community. */
    ours: boolean;
}

function destinationById(id: unknown): OffboxDestination | null {
    if (typeof id !== 'string') return null;
    return readOffboxSettings().destinations.find((d) => d.id === id) ?? null;
}

/**
 * The backups a destination holds, newest first: every community's under its folder (a fresh server restoring a lost
 * one has a community id of its own until the restore). Only names this feature makes. Throws {@link OffboxS3Error}.
 */
export async function listOffboxBackups(id: unknown): Promise<{ destinationId: string; backups: ListedBackup[] } | null> {
    const d = destinationById(id);
    if (!d) return null;
    const own = communityFolder();
    const objects: OffboxObject[] = await clientFor(d).list(d.prefix);
    const backups: ListedBackup[] = [];
    for (const o of objects) {
        const parsed = parseBackupKey(d.prefix, o.key);
        if (!parsed) continue;
        backups.push({ key: o.key, community: parsed.community, file: parsed.file, madeAt: parsed.madeAt, bytes: o.bytes, ours: parsed.community === own });
    }
    backups.sort((a, b) => b.madeAt - a.madeAt);
    // The id, never the destination: it holds the secret, and nothing that leaves this module may.
    return { destinationId: d.id, backups };
}

/** One backup from a destination as a stream, for the owner to save and restore. Null when the key is not one of ours. */
export async function openOffboxBackup(id: unknown, key: unknown) {
    const d = destinationById(id);
    if (!d || typeof key !== 'string') return null;
    const parsed = parseBackupKey(d.prefix, key);
    if (!parsed) return null;
    const opened = await clientFor(d).openRead(key);
    return opened ? { ...opened, file: parsed.file } : null;
}
