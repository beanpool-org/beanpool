import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type tls from 'node:tls';
import {
    checkVaultTicket,
    isVaultChallenge,
    isVaultPushToken,
    vaultB64,
    vaultTicketNonce,
    vaultUnb64,
    type VaultAnswerKind,
    type VaultTicket,
    type VaultTicketPurpose,
} from '@beanpool/core';
import {
    createJwksCache,
    createSignInVerifier,
    defaultAudiences,
    signInCredentialFrom,
    ssoProviderLabel,
    SsoProviderUnavailableError,
    SsoVerificationError,
    type FetchLike,
    type SsoIdentity,
    type SsoProvider,
} from '@beanpool/signin';
import { BACKUP_NAME_RE, backupNameFor, backupTimeOf, compareBackupNames, parseBackupFile, RESTORE_PENDING_NAME } from '../shared/backup-format.js';
import { isVaultProvider } from '../shared/providers.js';
import {
    parseRestartRequest,
    RESTART_CLOCK_MARGIN_MS,
    RESTART_REQUEST_MAX_AGE_MS,
    RESTART_THRESHOLD,
    restartSigners,
    restartStatus,
    type RestartStatus,
    type SignedRestartRequest,
} from '../shared/restart-request.js';
import {
    canonicalSettings,
    parseSettings,
    parseSettingsFile,
    SETTINGS_MAX_BYTES,
    SettingsError,
    settingsHash,
    settingsSummary,
    type OperatorSettings,
    type SettingsFile,
} from '../shared/settings.js';
import { AlertBook, AlertChannelSender, type Condition } from './alerts.js';
import { NonceStore, verifySignedRequest } from './auth.js';
import { BackupTooLarge, type BackupStore } from './backup-store.js';
import { DB_FILE, VaultDb, type CopyRow, type DeletionRow, type HoldRow } from './db.js';
import { KeyholderCallError, KeyholderClient, KeyholderUnavailable } from './keyholder-client.js';
import { PushSender, type PushKind } from './push.js';
import { addressBucket, RateLimiter } from './rate-limit.js';
import { OffsiteError, S3Store } from './s3-store.js';

/**
 * vault-api (key vault design §1.3, §3): plain `node:http`, the routes, the database, the holds, the pushes, the
 * backups and the daily report. It holds no key: every HMAC, envelope, ticket, release and backup is the keyholder's
 * (over its Unix socket), and it never sees a copy in the clear.
 *
 * While the keyholder is locked (or unreachable, which to the outside is the same), every route but `/v1/health` and
 * `/v1/unlock/*` answers 503 `{locked: true}` (§2.3).
 *
 * A member's request that carries a `challenge` (the phone's always do) gets its answer signed as well: `signed`
 * beside the answer's fields (core vault-wire.ts "Signed answers"). The keyholder signs a release and a deposit receipt
 * as it makes them, and every other answer, refusals (4xx) included, through `signAnswer`. A 5xx is never signed: it
 * leads the phone to do nothing. Without a challenge the answer is exactly what it was before.
 */

export const HOLD_MS = 24 * 60 * 60 * 1000;
/** The only origin whose browser pages may call the vault (§1.2). CORS isn't the lock: sign-ins are. */
export const GLOBAL_ORIGIN = 'https://global.beanpool.org';
export const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const RESTORE_BUILD = `${DB_FILE}.restore`;
/** After a restore from backup failed to finish, the next try waits this long (requests meanwhile get 503 at once). */
export const RESTORE_RETRY_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Locked (or the keyholder unreachable) this long: the custodians are told (design §3). */
export const LOCKED_ALERT_MS = 5 * 60 * 1000;
/** Backups run hourly: two missed hours (and a little, for the timer) and the custodians are told (design §4). */
export const BACKUP_STALE_MS = 2 * 60 * 60 * 1000 + 10 * 60 * 1000;
/** A failure this many times in a row is an alert too. */
export const BACKUP_FAILURES_ALERT = 2;
/**
 * Tidying the off-box store failing this many times in a row (a day of hourly copies, each landing) is an alert: copies
 * past 30 days are piling up there. Fewer is no news, as the next tidy-up removes whatever an earlier one left.
 */
export const OFFSITE_PRUNE_FAILURES_ALERT = 24;
/** An off-box upload that fails is tried once more this long after, before the copy counts as failed. */
export const OFFSITE_RETRY_MS = 30 * 1000;
/** A day's signed report is made at the first check after midnight UTC; by this long after, its absence is an alert. */
export const REPORT_GRACE_MS = 2 * 60 * 60 * 1000;
/** A custodian's settings wait this long for a second custodian to send the same. */
export const SETTINGS_PROPOSAL_MS = 60 * 60 * 1000;
/** How many custodians must send the same settings (the vault's threshold). */
export const SETTINGS_APPROVALS = 2;

/** §1.6. */
export const LIMITS = {
    ticketsPerAddressPerMinute: 10,
    restoresPerAccountPerDay: 5,
    depositsPerKeyPerDay: 10,
    ceremonyCallsPerAddressPerMinute: 20,
} as const;

export interface VaultApiOptions {
    /** The database (and a restore in progress). On V3's image, the encrypted data partition. */
    dataDir: string;
    keyholderSocket: string;
    /** The host names a request may be signed for (`vault.beanpool.org`). */
    hosts: string[];
    store: BackupStore;
    /** For the providers' keys and Expo. Defaults to the global fetch. */
    fetch?: FetchLike;
    clock?: () => number;
    /** Only if Expo requires one for BeanPool's project (§10). */
    expoAccessToken?: string;
    /** Take the client address from the last X-Forwarded-For entry (Caddy on the same machine, V3). */
    trustProxy?: boolean;
    /** What this process is, for `/v1/report`: its API bundle, the release checks, the next restart. */
    about?: () => AboutThisApi;
    /**
     * Where a restart request two custodians signed is left for root (RESTART_REQUEST_FILE on the image, the API's own
     * directory: root's beanpool-vault-restart.path acts on it, after its own checks). Without it, none is taken.
     */
    restartRequestFile?: string;
    /** The release whose new image waits (the updater's `imageWaiting`): a restart request must name it. */
    imageWaiting?: () => { version: string; imageHash: string; staged: boolean } | null;
    /**
     * `dataDir` is where the data partition is mounted once the vault is open (the image: LUKS2 under K_disk). Until
     * it is, no database is opened (it would land on the partition underneath) and the vault answers as locked. Once
     * it is, the API opens the database itself (finishing a restore from backup): it looks every `dataPollMs`.
     */
    requireDataMount?: boolean;
    /**
     * Where a restore from backup waits for the unlock (`restore-pending.bin`, sealed under K_backup). It must not be
     * under `dataDir` when that is a mount point: the mount would hide it and the restore never finish. The image:
     * `/var/lib/beanpool-vault/restore` on the state partition. Defaults to `dataDir` without `requireDataMount`.
     */
    restoreDir?: string;
    /** Whether the data partition is mounted at `dataDir` (default: `dataDir` is on another device than its parent). */
    dataMounted?: () => boolean;
    dataPollMs?: number;
    /**
     * Where the operator settings are kept (shared/settings.ts: the off-box store and the alert channels), set by two
     * custodians through `/v1/unlock/settings`. The image: `/var/lib/beanpool-vault/settings/settings.json` on the state
     * partition, readable while the vault is locked (the alerts need it then). Without it, settings can't be set: the
     * vault keeps its backups on its own disk and sends no alert.
     */
    settingsFile?: string;
    /** The off-box store and the webhook (tests: a stub on this machine). Defaults to the global fetch. */
    outboundFetch?: FetchLike;
    /** How the API waits before trying a failed off-box upload again (tests: their clock moved at once). Defaults to a timer. */
    sleep?: (ms: number) => Promise<void>;
    /** Extra TLS options for the mail server (tests: their own CA). */
    smtpTls?: tls.ConnectionOptions;
}

export interface AboutThisApi {
    /** SHA-256 of the running API bundle, or `source`. */
    api: string;
    /** The updater's last check (updater.ts), or null when this API doesn't check releases. */
    update: unknown;
    /**
     * Whether the vault needs the custodians' restart (D3: nothing restarts it on a schedule): a new image is waiting,
     * staged or not yet. Two custodians run `vault-custodian restart` when both are ready to unlock straight after.
     */
    restart: RestartStatus;
}

export interface VaultApi {
    listen(port?: number, host?: string): Promise<number>;
    /**
     * Listens on a Unix socket of its own beside `linkPath` (`api-<pid>.sock`), then points `linkPath`, a symlink Caddy
     * connects through, at it in one rename. From that moment new connections come here; an API still listening on
     * its own socket keeps the connections it has. Returns the socket's own path.
     */
    listenUnix(linkPath: string, mode?: number): Promise<string>;
    /** Takes no new connection, finishes those it has (up to `timeoutMs`), then closes as {@link close} does. */
    drain(timeoutMs?: number): Promise<void>;
    close(): Promise<void>;
    /** One backup now; the hourly job calls this. Returns its name. */
    runBackup(): Promise<string>;
    /** The hourly job: a backup, and the expiry of holds, deletion records and nonces. */
    maintenance(): Promise<void>;
    /** Looks at what the custodians are told about (locked, backups, the off-box copy, the daily report); every minute. */
    checkAlerts(): Promise<void>;
    /** Resolves once background work (pushes, re-wraps) has finished. */
    idle(): Promise<void>;
}

interface KeyholderStatus {
    state: 'fresh' | 'locked' | 'open';
    since: number;
    custodians: string[];
    /** A genesis or reshare waiting for two of its custodians to confirm their shares. */
    pending: { purpose: string; generation: number; custodians: string[]; confirmed: string[] } | null;
    /** The genesis or reshare that switched at this boot: who has shown they hold their new share (in memory only). */
    switched: { generation: number; custodians: string[]; confirmed: string[] } | null;
    generation: number | null;
    platform: string;
    releaseHash: string;
    restorePending: boolean;
    publicKeys: { ticket: string[]; deposit: { kid: string; key: string }[] } | null;
    wrapVersion: number | null;
    /** The keyholder's memory hygiene (hygiene.ts): what V3's image got wrong shows here and in the report. */
    memory: Record<string, unknown> | null;
    reachable: boolean;
}

interface Ctx {
    req: http.IncomingMessage;
    body: Record<string, unknown>;
    key: string;
    status: KeyholderStatus;
    address: string;
    now: number;
}

interface Answer {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
}

class HttpError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
        super(message);
    }
}

type Handler = (ctx: Ctx) => Promise<Answer>;

interface Route {
    auth: 'none' | 'signed' | 'custodian';
    /** Answers while the keyholder is locked or fresh. */
    whenLocked: boolean;
    handler: Handler;
}

interface WireDeletion {
    id: string;
    pk: string;
    sub: string;
    day: string;
}

function dayOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function newId(): string {
    return vaultB64(crypto.randomBytes(16));
}

function rowRef(row: CopyRow) {
    return { id: row.id, subIndex: vaultB64(row.sub_index), pkIndex: vaultB64(row.pk_index), envelope: vaultB64(row.envelope) };
}

function b64Bytes(value: string): Buffer {
    return Buffer.from(vaultUnb64(value, 64 * 1024) ?? []);
}

function envelopeVersion(envelope: Uint8Array): number {
    return envelope.length >= 5 ? Buffer.from(envelope).readUInt32BE(1) : -1;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const json = (status: number, body: unknown): Answer => ({ status, body });

/** The daily counts (§3): nothing per member, only totals. */
class Counters {
    day = '';
    counts = this.empty();

    private empty() {
        return {
            tickets: 0, deposits: 0, replaced: 0, restores: {} as Record<string, number>, holds: 0, approvals: 0, cancels: 0,
            releases: 0, deletes: 0, pushTokens: 0, errors: 0, backupsOk: 0, backupsFailed: 0, offsiteOk: 0, offsiteFailed: 0,
            // Off-box uploads tried a second time (the copy then counted in offsiteOk or offsiteFailed).
            offsiteRetried: 0,
            // Tidying the off-box store (its copies past 30 days) that failed: counted apart, a copy already up stays counted OK.
            offsitePruneFailed: 0,
        };
    }

    /** The finished day's counts when `now` is on a new day, else null. */
    roll(now: number): { day: string; counts: ReturnType<Counters['empty']> } | null {
        const today = dayOf(now);
        if (this.day === today) return null;
        const finished = this.day ? { day: this.day, counts: this.counts } : null;
        this.day = today;
        this.counts = this.empty();
        return finished;
    }
}

export function createVaultApi(opts: VaultApiOptions): VaultApi {
    const clock = opts.clock ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref()));
    const about = opts.about ?? ((): AboutThisApi => ({ api: 'source', update: null, restart: restartStatus(null) }));
    const startedAt = clock();
    const kh = new KeyholderClient(opts.keyholderSocket);
    const store = opts.store;
    const nonces = new NonceStore();
    const push = new PushSender({ fetch: opts.fetch, accessToken: opts.expoAccessToken });
    const counters = new Counters();
    counters.roll(startedAt);
    let previousReport: { text: string; signature: string } | null = null;
    let lastBackupOkAt: number | null = null;
    let backupFailuresInARow = 0;
    /** Why the last backup failed, for the report: a backup past the store's budget says so; anything else, 'failed'. */
    let backupError: string | null = null;

    // ─── Operator settings: the off-box store and the alert channels (shared/settings.ts) ──────────

    const vaultName = opts.hosts[0] ?? 'vault';
    let settings: SettingsFile | null = loadSettings();
    let offsite: BackupStore | null = null;
    /** When this process first had the off-box store it has now: the first copy is due within the hour after. */
    let offsiteSince = clock();
    const offsiteStatus = {
        lastOkAt: null as number | null, lastName: null as string | null, failuresInARow: 0, error: null as string | null,
        /** The call the last copy failed at (only ever `put`: the upload), beside `error`, its cause. */
        step: null as 'put' | null,
        /** Removing the copies there past 30 days, after a copy went up: which call failed (`list`, `delete`) and why. */
        prune: { lastOkAt: null as number | null, failuresInARow: 0, step: null as 'list' | 'delete' | null, error: null as string | null },
    };
    useSettings(settings);
    /** Settings sent by one custodian, waiting for a second to send the same (by hash). In memory only. */
    const proposals = new Map<string, { settings: OperatorSettings; by: Set<string>; at: number }>();

    function loadSettings(): SettingsFile | null {
        if (!opts.settingsFile || !existsSync(opts.settingsFile)) return null;
        try {
            if (statSync(opts.settingsFile).size > SETTINGS_MAX_BYTES) throw new Error('too large');
            const f = parseSettingsFile(readFileSync(opts.settingsFile, 'utf8'));
            if (!f) throw new Error('not a settings file');
            return f;
        } catch (e) {
            console.error(`vault-api: the settings file is not used: ${(e as Error).message}`);
            return null;
        }
    }

    function useSettings(f: SettingsFile | null): void {
        const before = settings?.settings.offsite ?? null;
        settings = f;
        const o = f?.settings.offsite ?? null;
        // Only a changed store starts afresh: new alert channels alone say nothing about how the copies are going.
        const same = canonicalSettings({ v: 1, offsite: before, alerts: null }) === canonicalSettings({ v: 1, offsite: o, alerts: null });
        if (same && offsite) return;
        offsite = o ? new S3Store(o, { fetch: opts.outboundFetch, clock }) : null;
        offsiteSince = clock();
        offsiteStatus.failuresInARow = 0;
        offsiteStatus.error = null;
        offsiteStatus.step = null;
        offsiteStatus.prune = { lastOkAt: null, failuresInARow: 0, step: null, error: null };
    }

    function saveSettings(f: SettingsFile): void {
        const file = opts.settingsFile as string;
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const part = `${file}.${process.pid}.part`;
        writeFileSync(part, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
        renameSync(part, file);
    }

    // ─── Alerts (alerts.ts) ─────────────────────────────────────────────────────────────────

    const alertSender = new AlertChannelSender({ fetch: opts.outboundFetch, heloName: vaultName, smtpTls: opts.smtpTls, clock });
    const alertBook = new AlertBook({ vaultName, sender: alertSender, channels: () => settings?.settings.alerts ?? null, clock });
    /** Since when the vault has been locked (or unreachable) to the outside, as this process saw it; null while open. */
    let lockedSince: number | null = null;
    /** Since when it has been open, as this process saw it; null while locked. */
    let openSince: number | null = null;
    /** Whether this process has ever seen its keyholder locked or open: after that, `fresh` means its state was lost. */
    let keyholderSeen = false;
    /** The last finished day whose signed report was made, and why the last one wasn't. */
    let lastReportDay: string | null = null;
    let reportFailure: string | null = null;
    let alertRun: Promise<void> | null = null;

    const limits = {
        tickets: new RateLimiter(LIMITS.ticketsPerAddressPerMinute, 60_000),
        restores: new RateLimiter(LIMITS.restoresPerAccountPerDay, DAY_MS),
        deposits: new RateLimiter(LIMITS.depositsPerKeyPerDay, DAY_MS),
        ceremony: new RateLimiter(LIMITS.ceremonyCallsPerAddressPerMinute, 60_000),
    };

    // Tickets spent, by their `n`, until they expire. In memory: see auth.ts on restarts.
    const usedTickets = new Map<string, number>();
    // The ticket each in-flight sign-in check was presented with, by its nonce.
    const pendingTickets = new Map<string, VaultTicket>();

    const jwks = createJwksCache({ fetch: opts.fetch, now: clock });
    const verifier = createSignInVerifier({
        jwks,
        now: clock,
        consumeNonce: (nonce, subject) => {
            const t = pendingTickets.get(nonce);
            if (!t || t.key !== subject || usedTickets.has(t.n)) return false;
            usedTickets.set(t.n, t.exp);
            return true;
        },
    });

    let db: VaultDb | null = null;
    let opening: Promise<VaultDb> | null = null;
    const background = new Set<Promise<unknown>>();
    let writeChain: Promise<unknown> = Promise.resolve();

    if (opts.requireDataMount) {
        // Outside: the way from dataDir to it starts by going up (`..pending` is a name under it).
        const way = opts.restoreDir ? path.relative(opts.dataDir, opts.restoreDir) : '';
        const outside = way === '..' || way.startsWith(`..${path.sep}`) || path.isAbsolute(way);
        if (!opts.restoreDir || !outside) throw new Error('With requireDataMount, restoreDir must be outside dataDir (the mount hides what is under it).');
    }
    const restoreDir = opts.restoreDir ?? opts.dataDir;
    const pendingPath = path.join(restoreDir, RESTORE_PENDING_NAME);
    const dbPath = path.join(opts.dataDir, DB_FILE);

    /** The data directory is ready: always, unless it must be a mount point and isn't yet. */
    function dataReady(): boolean {
        if (!opts.requireDataMount) return true;
        if (opts.dataMounted) return opts.dataMounted();
        try {
            return statSync(opts.dataDir).dev !== statSync(path.dirname(opts.dataDir)).dev;
        } catch {
            return false;
        }
    }

    function track<T>(p: Promise<T>): void {
        const job = p.catch(() => {
            counters.counts.errors++;
        }).finally(() => background.delete(job));
        background.add(job);
    }

    /** Database writes that await the keyholder in between run one at a time, so no update is lost. */
    function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = writeChain.then(fn, fn);
        writeChain = run.catch(() => undefined);
        return run;
    }

    async function call<T>(op: string, args: Record<string, unknown> = {}, binary?: Uint8Array, timeoutMs?: number): Promise<T> {
        return (await kh.call<T>(op, args, binary, timeoutMs)).result;
    }

    async function keyholderStatus(): Promise<KeyholderStatus> {
        try {
            return { ...(await call<Omit<KeyholderStatus, 'reachable'>>('status')), reachable: true };
        } catch {
            return {
                state: 'locked', since: startedAt, custodians: [], pending: null, switched: null, generation: null, platform: 'none', releaseHash: 'unknown',
                restorePending: false, publicKeys: null, wrapVersion: null, memory: null, reachable: false,
            };
        }
    }

    // ─── The database, a restore in progress, and re-wrapping ───────────────────────────────

    let restoreRetryAt = 0;
    /** Why the last try failed: for the custodians' unlock answer and the host's log, never for every caller. */
    let restoreFailure: string | null = null;

    function restoreWaiting(): HttpError {
        return new HttpError(503, 'restoring', 'The key vault is finishing a restore from backup. It will try again shortly.', { locked: true });
    }

    /**
     * The database, opened once the keyholder is open. While the keyholder still names a backup it was restored from,
     * that restore is finished first (built completely, then put in place), and nothing opens until it is: never an
     * empty database, never the backup's without the deletions made after it. A failure leaves the restore pending,
     * answers 503, and is tried again.
     */
    async function ensureDb(): Promise<VaultDb> {
        if (db) return db;
        if (opening) return opening;
        opening = (async () => {
            const status = await keyholderStatus();
            if (status.state !== 'open') throw new KeyholderUnavailable();
            if (!dataReady()) {
                throw new HttpError(503, 'data_not_ready', 'The key vault is opening its data partition. Please try again shortly.', { locked: true });
            }
            if (status.restorePending) {
                // A crash after the keyholder took the backup's state but before the file got its name.
                if (!existsSync(pendingPath) && existsSync(`${pendingPath}.part`)) renameSync(`${pendingPath}.part`, pendingPath);
                if (!existsSync(pendingPath)) {
                    restoreFailure = 'the backup it was started from is missing from the restore directory';
                    throw restoreWaiting();
                }
                if (clock() < restoreRetryAt) throw restoreWaiting();
                try {
                    db = await completeRestore();
                    restoreFailure = null;
                } catch (e) {
                    restoreRetryAt = clock() + RESTORE_RETRY_MS;
                    restoreFailure = (e instanceof Error ? e.message : String(e)).slice(0, 200);
                    counters.counts.errors++;
                    console.error(`vault-api: the restore from backup is not finished: ${restoreFailure}`);
                    throw restoreWaiting();
                }
            } else {
                // No restore, or one that finished (the keyholder forgot its backup) and stopped before tidying up.
                rmSync(pendingPath, { force: true });
                rmSync(`${pendingPath}.part`, { force: true });
                db = VaultDb.open(opts.dataDir);
            }
            track(rewrapAll());
            track(dropRetiredCopies());
            return db;
        })().finally(() => {
            opening = null;
        });
        return opening;
    }

    /*
     * The data partition is mounted by root after the unlock (the image's vault-data helper), with no request to wait
     * for: once it is there, the database opens (a restore from backup finishes) without one. A locked keyholder or a
     * restore still failing only means another try later.
     */
    const dataWatch = opts.requireDataMount ? setInterval(() => {
        if (!db && !opening && dataReady()) ensureDb().catch(() => undefined);
    }, opts.dataPollMs ?? 5000) : null;
    dataWatch?.unref();

    /**
     * After the unlock of a vault restored from a backup: the backup's database is built beside the vault's file, every
     * newer backup's deletion records are applied to it, so a copy deleted after that backup was made is dropped again
     * (§1.7), and only then does it go into place. A newer backup that can't be listed, fetched or opened fails the
     * whole restore, which is tried again: skipping one would bring back copies its members deleted. (A file of another
     * vault in the same store is not one of this vault's backups and says nothing about its copies.)
     *
     * A record the backup already holds is older than the backup and is left alone: a copy deposited again after it
     * must survive. The keyholder forgets the backup (`restoreDone`) only once the built database is in place: a crash
     * before that builds it again; a crash after finds the restore done.
     *
     * Stops and approvals don't ride in backups, so a restore can't know what a member said about a hold after the
     * backup was made. Every hold still open is held again for a fresh 24 hours from the restore, and the member's
     * devices are told again: a Stop is never silently undone.
     */
    async function completeRestore(): Promise<VaultDb> {
        const file = readFileSync(pendingPath);
        const opened = await kh.call<{ header: { name: string; vaultId: string } }>('openBackup', {}, file, 300_000);
        const buildPath = path.join(opts.dataDir, RESTORE_BUILD);
        const removeBuild = () => {
            rmSync(buildPath, { force: true });
            rmSync(`${buildPath}-journal`, { force: true });
        };
        removeBuild();
        writeFileSync(buildPath, opened.binary, { mode: 0o600 });
        opened.binary.fill(0);
        const built = VaultDb.open(opts.dataDir, RESTORE_BUILD);
        let reheld: HoldRow[];
        try {
            const newer = (await allBackupNames()).filter(n => compareBackupNames(n, opened.result.header.name) > 0);
            for (const name of newer) {
                const bytes = await readBackup(name);
                if (parseBackupFile(bytes).header.vaultId !== opened.result.header.vaultId) continue;
                const d = await call<{ deletions: string }>('openBackupDeletions', {}, bytes, 300_000);
                const records = JSON.parse(d.deletions) as WireDeletion[];
                built.transaction(() => {
                    for (const w of records) {
                        const rec: DeletionRow = { copy_id: w.id, pk_index: b64Bytes(w.pk), sub_index: b64Bytes(w.sub), day: w.day };
                        if (!built.hasDeletion(rec)) built.applyDeletion(rec);
                    }
                });
            }
            reheld = built.reholdOpen(clock() + HOLD_MS);
        } catch (e) {
            built.close();
            removeBuild();
            throw e;
        }
        built.close();
        db?.close();
        db = null;
        rmSync(`${dbPath}-journal`, { force: true });
        renameSync(buildPath, dbPath);
        await call('restoreDone');
        rmSync(pendingPath, { force: true });
        const restored = VaultDb.open(opts.dataDir);
        track((async () => {
            for (const hold of reheld) {
                const row = restored.copyById(hold.copy_id);
                if (row) notify(await memberTokens(restored, row.pk_index), 'vault-hold', hold.provider);
            }
        })());
        return restored;
    }

    /**
     * Every backup name in the vault's own store and the off-box one, oldest first. An off-box store that can't be
     * listed fails it: a restore that skipped one could bring back copies their members deleted (completeRestore).
     */
    async function allBackupNames(): Promise<string[]> {
        const names = new Set(await store.list());
        if (offsite) for (const n of await offsite.list()) names.add(n);
        return [...names].sort(compareBackupNames);
    }

    /** A backup by name: from the vault's own store, or else the off-box one (the cold path: a new machine has none). */
    async function readBackup(name: string): Promise<Buffer> {
        try {
            return await store.get(name);
        } catch (e) {
            if (!offsite) throw e;
            return offsite.get(name);
        }
    }

    /** Every envelope under the current K_wrap (after a reshare, or resuming one cut short by a restart). */
    async function rewrapAll(): Promise<number> {
        const status = await keyholderStatus();
        if (status.state !== 'open' || !db || status.wrapVersion === null) return 0;
        let after = '';
        let changed = 0;
        for (;;) {
            const rows = (db as VaultDb).copiesAfter(after, 200);
            if (!rows.length) break;
            after = rows[rows.length - 1].id;
            await withWriteLock(async () => {
                for (const row of rows) {
                    const current = (db as VaultDb).copyById(row.id);
                    if (!current || envelopeVersion(current.envelope) === status.wrapVersion) continue;
                    const r = await call<{ envelope: string; changed: boolean }>('rewrap', { row: rowRef(current) });
                    if (r.changed) {
                        (db as VaultDb).updateEnvelope(row.id, b64Bytes(r.envelope));
                        changed++;
                    }
                }
            });
        }
        return changed;
    }

    /**
     * Every copy for a sign-in the vault no longer keeps (shared/providers.ts), deleted with its holds and a deletion
     * record, so a restore from an older backup drops it again (§1.7). Run whenever the database opens (a start, an
     * unlock, a restore from backup), as the re-wrap is; a pass that finds none writes nothing. The provider is read from
     * each envelope's metadata by the keyholder, since no column names it; the log says how many went, never whose.
     */
    async function dropRetiredCopies(): Promise<number> {
        const status = await keyholderStatus();
        if (status.state !== 'open' || !db) return 0;
        let after = '';
        let dropped = 0;
        for (;;) {
            const rows = (db as VaultDb).copiesAfter(after, 200);
            if (!rows.length) break;
            after = rows[rows.length - 1].id;
            await withWriteLock(async () => {
                const retired: CopyRow[] = [];
                for (const row of rows) {
                    const current = (db as VaultDb).copyById(row.id);
                    if (!current) continue;
                    let provider: string;
                    try {
                        provider = (await metaOf(current)).provider;
                    } catch {
                        // An envelope the keyholder can't read is no copy it could release either; it is left as it is.
                        continue;
                    }
                    if (!isVaultProvider(provider)) retired.push(current);
                }
                if (!retired.length) return;
                const day = dayOf(clock());
                (db as VaultDb).transaction(() => {
                    for (const row of retired) (db as VaultDb).deleteCopy(row, day);
                });
                dropped += retired.length;
            });
        }
        if (dropped) {
            counters.counts.deletes += dropped;
            console.log(`vault-api: removed ${dropped} ${dropped === 1 ? 'copy' : 'copies'} for a sign-in the vault no longer keeps.`);
        }
        return dropped;
    }

    // ─── Sign-in checks ─────────────────────────────────────────────────────────────────────

    function ticketKeys(status: KeyholderStatus): string[] {
        return status.publicKeys?.ticket ?? [];
    }

    /** A ticket signed by this vault, unexpired, naming the request's signer, not yet spent. */
    function acceptTicket(ctx: Ctx, purpose?: VaultTicketPurpose): { ticket: VaultTicket; raw: string; nonce: string } {
        const raw = ctx.body.ticket;
        const check = checkVaultTicket(raw, { ticketKeys: ticketKeys(ctx.status), now: ctx.now, key: ctx.key, purpose });
        if (!check.ok) {
            const words: Record<string, string> = {
                malformed: 'That is not a key vault ticket.',
                signature: 'That ticket is not signed by this key vault.',
                expired: 'That ticket has expired. Start again.',
                wrong_key: 'That ticket was issued to another key.',
                wrong_purpose: 'That ticket was issued for something else.',
            };
            throw new HttpError(401, `ticket_${check.reason}`, words[check.reason]);
        }
        if (usedTickets.has(check.ticket.n)) throw new HttpError(401, 'ticket_used', 'That ticket was already used. Start again.');
        return { ticket: check.ticket, raw: raw as string, nonce: vaultTicketNonce(raw as string) };
    }

    /**
     * The sign-in in a deposit or restore, checked only through @beanpool/signin: BeanPool's own client ids as the
     * audience (no override), and as the provider nonce the hash of the ticket this request carries. The ticket is
     * spent only when the sign-in checks out.
     */
    async function checkSignIn(ctx: Ctx, purpose: VaultTicketPurpose, beforeVerify?: () => void): Promise<{ provider: SsoProvider; identity: SsoIdentity; nonce: string }> {
        const provider = ctx.body.provider;
        if (!isVaultProvider(provider)) throw new HttpError(400, 'bad_provider', 'That is not a sign-in the key vault keeps copies for.');
        const { ticket, nonce } = acceptTicket(ctx, purpose);
        beforeVerify?.();
        pendingTickets.set(nonce, ticket);
        try {
            const identity = await verifier.verifySignIn(provider, signInCredentialFrom(ctx.body), defaultAudiences(provider), nonce, ctx.key);
            return { provider, identity, nonce };
        } finally {
            pendingTickets.delete(nonce);
        }
    }

    // ─── Signed answers ─────────────────────────────────────────────────────────────────────

    /** The challenge a member's request carried, or null: its answer is then unsigned, as before. */
    function challengeOf(body: Record<string, unknown>): string | null {
        return isVaultChallenge(body.challenge) ? body.challenge : null;
    }

    /**
     * `says` as the answer; to a request that carried a challenge, signed by the keyholder as `kind` too, about the
     * request's signer. A release and a receipt are signed where they are made, never here.
     */
    async function answer(ctx: Ctx, kind: VaultAnswerKind, says: Record<string, unknown>, status = 200): Promise<Answer> {
        const challenge = challengeOf(ctx.body);
        if (!challenge) return json(status, says);
        const { signed } = await call<{ signed: string }>('signAnswer', { kind, key: ctx.key, challenge, says });
        return json(status, { ...says, signed });
    }

    async function index(kind: 'sub', provider: string, sub: string): Promise<string>;
    async function index(kind: 'pk', key: string): Promise<string>;
    async function index(kind: 'sub' | 'pk', a: string, b?: string): Promise<string> {
        const args = kind === 'sub' ? { kind, provider: a, sub: b } : { kind, key: a };
        return (await call<{ index: string }>('index', args)).index;
    }

    async function metaOf(row: CopyRow) {
        return call<{ provider: string; pubkey: string; pushTokens: string[]; lastReleasedAt: number | null }>('readMeta', { row: rowRef(row) });
    }

    /** Push tokens from every copy a member key has: the devices holding that account. */
    async function memberTokens(database: VaultDb, pkIndex: Uint8Array): Promise<string[]> {
        const tokens: string[] = [];
        for (const row of database.copiesByPk(pkIndex)) tokens.push(...(await metaOf(row)).pushTokens);
        return tokens;
    }

    function notify(tokens: string[], kind: PushKind, provider: string): void {
        push.notify(tokens, kind, isVaultProvider(provider) ? ssoProviderLabel(provider) : provider);
    }

    function limited(result: { ok: true } | { ok: false; retryAfterMs: number }, what: string): void {
        if (!result.ok) {
            throw new HttpError(429, 'rate_limited', `Too many ${what} just now. Please try again later.`,
                { retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000) });
        }
    }

    // ─── Routes ─────────────────────────────────────────────────────────────────────────────

    const routes: Record<string, Route> = {};
    const route = (method: string, p: string, auth: Route['auth'], whenLocked: boolean, handler: Handler) => {
        routes[`${method} ${p}`] = { auth, whenLocked, handler };
    };

    // A vault still finishing a restore from backup serves nothing yet: locked, to the outside.
    route('GET', '/v1/health', 'none', true, async ctx => json(200, {
        state: ctx.status.state === 'open' && !ctx.status.restorePending && dataReady() ? 'open' : 'locked',
        release: ctx.status.releaseHash,
        since: new Date(ctx.status.since).toISOString(),
    }));

    route('POST', '/v1/ticket', 'signed', false, async ctx => {
        limited(limits.tickets.take(ctx.address, ctx.now), 'tickets from this address');
        const { purpose, provider } = ctx.body;
        if (purpose !== 'deposit' && purpose !== 'restore') throw new HttpError(400, 'bad_purpose', 'A ticket is for a deposit or a restore.');
        if (!isVaultProvider(provider)) throw new HttpError(400, 'bad_provider', 'That is not a sign-in the key vault keeps copies for.');
        const t = await call<{ ticket: string; expiresAt: number }>('signTicket', { key: ctx.key, purpose });
        counters.counts.tickets++;
        return json(200, t);
    });

    route('POST', '/v1/copies', 'signed', false, async ctx => {
        const { provider, identity, nonce } = await checkSignIn(ctx, 'deposit',
            () => limited(limits.deposits.take(ctx.key, ctx.now), 'deposits for this account today'));
        const database = await ensureDb();
        return withWriteLock(async () => {
            const subIndex = b64Bytes(await index('sub', provider, identity.sub));
            const pkIndex = b64Bytes(await index('pk', ctx.key));
            const existing = database.copyBySub(subIndex);
            const sameMember = !!existing && sameBytes(existing.pk_index, pkIndex);
            const replaced = !!existing && !sameMember;
            const id = sameMember ? (existing as CopyRow).id : newId();
            // The receipt (for a request with a challenge) is signed by the keyholder over the copy it opens and wraps.
            const challenge = challengeOf(ctx.body);
            let wrapped: { envelope: string; receipt?: string };
            try {
                wrapped = await call<{ envelope: string; receipt?: string }>('depositWrap', {
                    id, provider, sub: identity.sub, memberKey: ctx.key, box: ctx.body.box, carry: sameMember ? rowRef(existing as CopyRow) : null,
                    ...(challenge ? { challenge, signIn: nonce, replaced } : {}),
                });
            } catch (e) {
                if (e instanceof KeyholderCallError && e.code === 'bad_box') {
                    throw new HttpError(400, 'bad_box', 'The copy did not open as a deposit for this account and sign-in.');
                }
                throw e;
            }
            const oldTokens = replaced ? (await metaOf(existing as CopyRow)).pushTokens : [];
            const day = dayOf(ctx.now);
            database.transaction(() => {
                if (sameMember) {
                    database.updateEnvelope(id, b64Bytes(wrapped.envelope), day);
                } else {
                    if (existing) database.deleteCopy(existing, day);
                    database.insertCopy({ id, sub_index: subIndex, pk_index: pkIndex, envelope: b64Bytes(wrapped.envelope), updated_day: day });
                }
            });
            counters.counts.deposits++;
            if (replaced) {
                counters.counts.replaced++;
                notify(oldTokens, 'vault-replaced', provider);
            }
            // Only once the envelope is stored: a receipt says the vault keeps the copy.
            return json(200, { ok: true, provider, replaced, ...(wrapped.receipt ? { signed: wrapped.receipt } : {}) });
        });
    });

    route('POST', '/v1/copies/status', 'signed', false, async ctx => {
        const database = await ensureDb();
        const pkIndex = b64Bytes(await index('pk', ctx.key));
        const copies = [];
        const holds = [];
        for (const row of database.copiesByPk(pkIndex)) {
            const meta = await metaOf(row);
            copies.push({ provider: meta.provider, lastReleasedAt: meta.lastReleasedAt, updatedDay: row.updated_day });
            const hold = database.openHoldForCopy(row.id);
            if (hold) holds.push({ holdId: hold.id, provider: hold.provider, openedAt: hold.opened_at, releaseAt: hold.release_at });
        }
        return answer(ctx, 'status', { copies, holds });
    });

    route('POST', '/v1/copies/delete', 'signed', false, async ctx => {
        const all = ctx.body.all === true;
        const provider = ctx.body.provider;
        if (!all && !isVaultProvider(provider)) throw new HttpError(400, 'bad_provider', 'Say which sign-in to disconnect, or all.');
        const database = await ensureDb();
        return withWriteLock(async () => {
            const pkIndex = b64Bytes(await index('pk', ctx.key));
            const doomed: CopyRow[] = [];
            for (const row of database.copiesByPk(pkIndex)) {
                if (all || (await metaOf(row)).provider === provider) doomed.push(row);
            }
            const day = dayOf(ctx.now);
            database.transaction(() => {
                for (const row of doomed) database.deleteCopy(row, day);
            });
            counters.counts.deletes += doomed.length;
            return answer(ctx, 'deleted', { deleted: doomed.length });
        });
    });

    route('POST', '/v1/push-token', 'signed', false, async ctx => {
        const token = ctx.body.token;
        if (!isVaultPushToken(token)) throw new HttpError(400, 'bad_token', 'That is not an Expo push token.');
        const database = await ensureDb();
        return withWriteLock(async () => {
            const pkIndex = b64Bytes(await index('pk', ctx.key));
            let updated = 0;
            for (const row of database.copiesByPk(pkIndex)) {
                const r = await call<{ envelope: string }>('updateMeta', { row: rowRef(row), addPushToken: token });
                database.updateEnvelope(row.id, b64Bytes(r.envelope));
                updated++;
            }
            counters.counts.pushTokens++;
            return answer(ctx, 'push-token', { updated });
        });
    });

    /**
     * An account leaves a phone (Sign Out, "Replace this phone's account"): that phone's token comes out of every copy
     * of the key, so the account's notices (a restore waiting, a release, a replaced copy) stop reaching a phone that
     * may now be someone else's. Signed by the account's key, which the phone still holds as it leaves. A token the
     * copies don't hold is no error: `updated` counts the copies it came out of.
     */
    route('POST', '/v1/push-token/remove', 'signed', false, async ctx => {
        const token = ctx.body.token;
        if (!isVaultPushToken(token)) throw new HttpError(400, 'bad_token', 'That is not an Expo push token.');
        const database = await ensureDb();
        return withWriteLock(async () => {
            const pkIndex = b64Bytes(await index('pk', ctx.key));
            let updated = 0;
            for (const row of database.copiesByPk(pkIndex)) {
                if (!(await metaOf(row)).pushTokens.includes(token)) continue;
                const r = await call<{ envelope: string }>('updateMeta', { row: rowRef(row), removePushToken: token });
                database.updateEnvelope(row.id, b64Bytes(r.envelope));
                updated++;
            }
            counters.counts.pushTokens++;
            return answer(ctx, 'push-token', { updated });
        });
    });

    /**
     * A restore (D2): every one is held 24 hours, whichever provider, unless a device holding the account says "Yes,
     * it's me". The member's devices are told at once. A hold already open is answered with, not doubled: to the
     * device that opened it, its hold; to any other, that one is waiting (it can be collected only by the device
     * that started it, whose key the release is sealed to). Once that hold could have been collected and wasn't (its
     * device may have lost its throwaway key), another device's restore takes its place with a fresh 24 hours, told
     * and stoppable like any: never a release sooner than the old hold's.
     */
    route('POST', '/v1/restore', 'signed', false, async ctx => {
        const { provider, identity } = await checkSignIn(ctx, 'restore');
        const database = await ensureDb();
        return withWriteLock(async () => {
            const subIndexB64 = await index('sub', provider, identity.sub);
            limited(limits.restores.take(subIndexB64, ctx.now), 'restores for this sign-in account today');
            const row = database.copyBySub(b64Bytes(subIndexB64));
            if (!row) {
                throw new HttpError(404, 'no_copy', `The key vault keeps no copy for this ${ssoProviderLabel(provider)} account. Your 12 words work any time.`);
            }
            const open = database.openHoldForCopy(row.id);
            if (open) {
                if (open.requester_key === ctx.key) return answer(ctx, 'restore', { status: 'held', holdId: open.id, until: open.release_at });
                if (ctx.now < open.release_at) {
                    throw new HttpError(409, 'hold_open', 'A restore of this account is already waiting on another device.', { until: open.release_at });
                }
            }
            const hold: HoldRow = {
                id: newId(), copy_id: row.id, requester_key: ctx.key, provider, opened_at: ctx.now, release_at: ctx.now + HOLD_MS,
                cancelled_at: null, released_at: null,
            };
            database.transaction(() => {
                if (open) database.cancelHold(open.id, ctx.now);
                database.insertHold(hold);
            });
            counters.counts.restores[provider] = (counters.counts.restores[provider] ?? 0) + 1;
            counters.counts.holds++;
            notify(await memberTokens(database, row.pk_index), 'vault-hold', provider);
            return answer(ctx, 'restore', { status: 'held', holdId: hold.id, until: hold.release_at });
        });
    });

    /**
     * The release, sealed to the key that started the restore. That device may collect again (its answer may have been
     * lost) until the hold is pruned: a fresh seal to the same key gives nobody anything new. The release is recorded,
     * and the member's devices told, once. To a request with a challenge, the keyholder signs the release as it seals it.
     */
    route('POST', '/v1/restore/collect', 'signed', false, async ctx => {
        const database = await ensureDb();
        return withWriteLock(async () => {
            const hold = typeof ctx.body.holdId === 'string' ? database.holdById(ctx.body.holdId) : undefined;
            if (!hold || hold.requester_key !== ctx.key) throw new HttpError(404, 'no_hold', 'There is no restore waiting for this device.');
            if (hold.cancelled_at !== null) return answer(ctx, 'collect', { status: 'stopped' });
            if (ctx.now < hold.release_at) return answer(ctx, 'collect', { status: 'held', until: hold.release_at });
            const row = database.copyById(hold.copy_id);
            if (!row) throw new HttpError(404, 'no_copy', 'The copy this restore was for is no longer kept.');
            const challenge = challengeOf(ctx.body);
            const { release, signed } = await call<{ release: unknown; signed?: string }>('release', {
                row: rowRef(row), requesterKey: ctx.key, ...(challenge ? { challenge } : {}),
            });
            if (hold.released_at === null) {
                const updated = await call<{ envelope: string }>('updateMeta', { row: rowRef(row), lastReleasedAt: ctx.now });
                database.transaction(() => {
                    database.updateEnvelope(row.id, b64Bytes(updated.envelope));
                    database.markReleased(hold.id, ctx.now);
                });
                counters.counts.releases++;
                notify(await memberTokens(database, row.pk_index), 'vault-released', hold.provider);
            }
            return json(200, { status: 'released', release, ...(signed ? { signed } : {}) });
        });
    });

    /** A hold on one of the signer's own copies, or a 404 that says nothing about anyone else's. */
    async function ownHold(ctx: Ctx, database: VaultDb): Promise<HoldRow> {
        const hold = typeof ctx.body.holdId === 'string' ? database.holdById(ctx.body.holdId) : undefined;
        const row = hold ? database.copyById(hold.copy_id) : undefined;
        if (!hold || !row || !sameBytes(row.pk_index, b64Bytes(await index('pk', ctx.key)))) {
            throw new HttpError(404, 'no_hold', 'There is no restore of this account waiting.');
        }
        return hold;
    }

    route('POST', '/v1/holds/cancel', 'signed', false, async ctx => {
        const database = await ensureDb();
        return withWriteLock(async () => {
            const hold = await ownHold(ctx, database);
            if (hold.released_at !== null) throw new HttpError(409, 'collected', 'That restore was already collected.');
            if (hold.cancelled_at === null) {
                database.cancelHold(hold.id, ctx.now);
                counters.counts.cancels++;
            }
            return answer(ctx, 'hold', { status: 'stopped' });
        });
    });

    route('POST', '/v1/holds/approve', 'signed', false, async ctx => {
        const database = await ensureDb();
        return withWriteLock(async () => {
            const hold = await ownHold(ctx, database);
            if (hold.cancelled_at !== null) throw new HttpError(409, 'stopped', 'That restore was stopped.');
            if (hold.released_at !== null) throw new HttpError(409, 'collected', 'That restore was already collected.');
            const releaseAt = Math.min(hold.release_at, ctx.now);
            database.setHoldReleaseAt(hold.id, releaseAt);
            counters.counts.approvals++;
            return answer(ctx, 'hold', { status: 'approved', releaseAt });
        });
    });

    route('GET', '/v1/report', 'none', false, async ctx => {
        const database = await ensureDb();
        await rollReport(ctx.now);
        const text = reportText(ctx.now, counters.day, counters.counts, database, ctx.status);
        const { signature } = await call<{ signature: string }>('signReport', { text });
        return json(200, { report: { text, signature }, previous: previousReport, ticketKey: ticketKeys(ctx.status)[0] });
    });

    function reportText(now: number, day: string, counts: Counters['counts'], database: VaultDb, status: KeyholderStatus): string {
        return JSON.stringify({
            v: 1, day, at: now, copies: database.countCopies(), counts,
            // After a reshare, envelopes still under the old K_wrap (which the old M opens) until the re-wrap is done.
            wraps: { current: status.wrapVersion, older: status.wrapVersion === null ? null : database.countEnvelopesNotUnder(status.wrapVersion) },
            backups: { lastOkAt: lastBackupOkAt, failuresInARow: backupFailuresInARow, error: backupError },
            // The off-box copy (design §4), when a store is set: never its address, bucket or key.
            offsite: offsite ? { ...offsiteStatus } : null,
            // What the custodians are told about, and whether it reached them: never an address or a URL.
            alerts: { ...alertBook.status(), lastReportDay },
            settings: settingsSummary(settings),
            pushes: { sent: push.sent, failed: push.failed },
            // After a genesis or reshare at this boot: how many of the new custodians have shown they hold their share.
            shares: status.switched ? { generation: status.switched.generation, confirmed: status.switched.confirmed.length, of: status.switched.custodians.length } : null,
            release: status.releaseHash, generation: status.generation, platform: status.platform, memory: status.memory,
            api: about().api, update: about().update, restart: about().restart,
            uptimeSeconds: Math.floor((now - startedAt) / 1000),
            // Since when it has been open, as this API saw it (the watcher counts a backup's age from the later of this and the newest).
            openSince: openSince ?? now,
        });
    }

    /**
     * At the first call on a new day: the finished day's report, signed. A day whose report can't be made (the vault
     * wasn't open, or the keyholder didn't sign) is lost, and the alerts say so (checkAlerts: `report`).
     */
    async function rollReport(now: number): Promise<void> {
        const finished = counters.roll(now);
        if (!finished) return;
        const status = await keyholderStatus();
        if (status.state !== 'open' || !db) {
            reportFailure = `the vault was not open to make it at ${new Date(now).toISOString().slice(0, 16)}Z`;
            return;
        }
        const text = reportText(now, finished.day, finished.counts, db, status);
        try {
            previousReport = { text, signature: (await call<{ signature: string }>('signReport', { text })).signature };
            lastReportDay = finished.day;
            reportFailure = null;
        } catch {
            reportFailure = 'the keyholder did not sign it';
        }
    }

    // ─── The ceremonies (custodians only) ───────────────────────────────────────────────────

    route('POST', '/v1/unlock/hello', 'custodian', true, async ctx => {
        if (ctx.status.state === 'open') throw new HttpError(409, 'open', 'The vault is already open.');
        return json(200, await call('hello', { custodianNonce: ctx.body.custodianNonce }));
    });

    /** Nothing is in force after a genesis until two custodians confirm their shares (/v1/unlock/confirm). */
    route('POST', '/v1/unlock/genesis', 'custodian', true, async ctx => {
        if (ctx.status.state !== 'fresh') throw new HttpError(409, 'already_set_up', 'This vault already has its keys.');
        if (existsSync(dbPath)) {
            const leftover = VaultDb.open(opts.dataDir);
            const n = leftover.countCopies();
            leftover.close();
            if (n > 0) throw new HttpError(409, 'data_without_keys', 'The data directory holds copies but the keyholder has no keys: restore a backup instead.');
        }
        return json(200, await call('genesis', { custodian: ctx.key, sig: ctx.body.sig }));
    });

    /**
     * The vault is open once the keyholder is; a restart that cut a re-wrap short is picked up here. A restore from
     * backup that can't finish yet is told to the custodians who unlocked, with why.
     */
    async function unlocked(): Promise<void> {
        try {
            await ensureDb();
        } catch (e) {
            if (e instanceof HttpError && e.code === 'restoring') throw new HttpError(503, 'restoring', e.message, { ...e.extra, reason: restoreFailure });
            // The keys are open; the data partition follows (the image's vault-data helper), and the database, its
            // restore and re-wrap with it, at the first request after that.
            if (e instanceof HttpError && e.code === 'data_not_ready') return;
            throw e;
        }
        track(rewrapAll());
    }

    route('POST', '/v1/unlock/share', 'custodian', true, async ctx => {
        const submission = ctx.body.submission as { custodian?: unknown } | undefined;
        if (!submission || submission.custodian !== ctx.key) throw new HttpError(403, 'not_yours', 'A share is sent by the custodian it belongs to.');
        const result = await call<{ state: string }>('share', { submission });
        if (result.state === 'open') await unlocked();
        return json(200, result);
    });

    /*
     * A genesis or a reshare waiting for its custodians (keyholder.ts): each new custodian fetches their own sealed share
     * again, and confirms it; two current custodians can drop one nobody finished. Under /v1/unlock/ because they answer
     * while locked too: a restart in the middle of a reshare must not strand it.
     */
    route('POST', '/v1/unlock/pending', 'custodian', true, async ctx => json(200, await call('pendingShare', { custodian: ctx.key })));

    route('POST', '/v1/unlock/confirm', 'custodian', true, async ctx => {
        const confirmation = ctx.body.confirmation as { custodian?: unknown } | undefined;
        if (!confirmation || confirmation.custodian !== ctx.key) throw new HttpError(403, 'not_yours', 'A share is confirmed by the custodian it belongs to.');
        const result = await call<{ state: string; switched: boolean; late?: boolean }>('confirm', { confirmation });
        if (result.switched && !result.late && result.state === 'open') await unlocked();
        return json(200, result);
    });

    route('POST', '/v1/unlock/cancel', 'custodian', true, async ctx => {
        const cancel = ctx.body.cancel as { custodian?: unknown } | undefined;
        if (!cancel || cancel.custodian !== ctx.key) throw new HttpError(403, 'not_yours', 'A cancel is sent by the custodian who signs it.');
        return json(200, await call('cancelPending', { cancel }));
    });

    route('POST', '/v1/unlock/restore', 'custodian', true, async ctx => {
        if (ctx.status.state !== 'fresh') throw new HttpError(409, 'already_set_up', 'Only a fresh vault takes a backup.');
        const name = ctx.body.backup;
        if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) throw new HttpError(400, 'bad_backup', 'That is not a backup name.');
        let bytes: Buffer;
        try {
            bytes = await readBackup(name);
        } catch {
            throw new HttpError(404, 'no_backup', 'Neither backup store has a backup by that name (or the off-box one can\'t be reached).');
        }
        let header;
        try {
            header = parseBackupFile(bytes).header;
        } catch (e) {
            throw new HttpError(400, 'bad_backup', (e as Error).message);
        }
        // Off the data partition's mount point (restoreDir): the unlock mounts the partition, which would hide it.
        mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
        writeFileSync(`${pendingPath}.part`, bytes, { mode: 0o600 });
        try {
            await call('adoptState', { custodian: ctx.key, sig: ctx.body.sig, backupName: name, state: header.state });
        } catch (e) {
            rmSync(`${pendingPath}.part`, { force: true });
            throw e;
        }
        renameSync(`${pendingPath}.part`, pendingPath);
        // A database this API still has open (the keyholder came back fresh while it ran) is the one the backup replaces:
        // the next open, after the unlock, runs the restore (ensureDb) rather than serving it.
        await withWriteLock(async () => {
            db?.close();
            db = null;
        });
        return json(200, { state: 'locked', vaultId: header.vaultId, generation: header.generation });
    });

    route('POST', '/v1/reshare/hello', 'custodian', false, async ctx => json(200, await call('hello', { custodianNonce: ctx.body.custodianNonce })));

    route('POST', '/v1/reshare/share', 'custodian', false, async ctx => {
        const submission = ctx.body.submission as { custodian?: unknown } | undefined;
        if (!submission || submission.custodian !== ctx.key) throw new HttpError(403, 'not_yours', 'A share is sent by the custodian it belongs to.');
        await ensureDb();
        // The new shares wait for their custodians' confirmations; the re-wrap follows the switch.
        return json(200, await call('share', { submission }));
    });

    /**
     * The operator settings (shared/settings.ts): where backups go off the box, and where alerts go. They take effect
     * when two of the vault's custodians in force (the genesis keys, on a fresh vault) have each sent the same settings
     * within an hour; each custodian's newest counts. Answered while locked and on a fresh vault too: the alerts are
     * needed then, and the cold path (design §4) needs the off-box store before its restore. The answer never repeats
     * the settings: only their hash, which a custodian checks against their own file (`vault-custodian settings hash`).
     */
    route('POST', '/v1/unlock/settings', 'custodian', true, async ctx => {
        if (!opts.settingsFile) throw new HttpError(409, 'no_settings_file', 'This vault has nowhere to keep settings (no settingsFile in its config).');
        if (!ctx.status.custodians.includes(ctx.key)) throw new HttpError(403, 'not_custodian', 'Settings are agreed by the vault\'s custodians in force.');
        let wanted: OperatorSettings;
        try {
            wanted = parseSettings(ctx.body.settings);
        } catch (e) {
            if (e instanceof SettingsError) throw new HttpError(400, 'bad_settings', e.message);
            throw e;
        }
        const hash = settingsHash(wanted);
        if (settings?.hash === hash) return json(200, { state: 'in_force', hash, approvals: settings.approvedBy.length, needed: SETTINGS_APPROVALS });
        for (const [h, p] of proposals) {
            p.by.delete(ctx.key);
            if (!p.by.size || ctx.now - p.at > SETTINGS_PROPOSAL_MS) proposals.delete(h);
        }
        const p = proposals.get(hash) ?? { settings: wanted, by: new Set<string>(), at: ctx.now };
        p.by.add(ctx.key);
        proposals.set(hash, p);
        if (p.by.size < SETTINGS_APPROVALS) return json(200, { state: 'waiting', hash, approvals: p.by.size, needed: SETTINGS_APPROVALS });
        const file: SettingsFile = { v: 1, settings: wanted, hash, approvedBy: [...p.by].sort(), approvedAt: ctx.now };
        saveSettings(file);
        useSettings(file);
        proposals.clear();
        console.log(`vault-api: settings ${hash.slice(0, 16)} in force (off-box store ${wanted.offsite ? 'set' : 'none'}; alerts ${settingsSummary(file).alerts.join(', ') || 'none'}).`);
        // The new channels hear at once what is already raised, rather than at the next minute's check.
        track(checkAlerts());
        return json(200, { state: 'in_force', hash, approvals: file.approvedBy.length, needed: SETTINGS_APPROVALS });
    });

    // ─── The custodians' restart for a new image (D3, 2026-10-06: nothing restarts the vault on a schedule) ──────────

    /**
     * Restart requests one custodian signed, waiting for a second to sign the same text (shared/restart-request.ts). In
     * memory only. This API decides nothing here: it only carries the request and its signatures to root, which checks
     * them itself from the pinned keys (install.ts). Its own checks only spare a request root would refuse.
     */
    const restarts = new Map<string, { signatures: Map<string, { key: string; sig: string }>; at: number }>();
    route('POST', '/v1/unlock/restart', 'custodian', true, async ctx => {
        if (!opts.restartRequestFile) throw new HttpError(409, 'no_restart_file', 'This vault takes no restart request (no restartRequestFile in its config).');
        if (!ctx.status.custodians.includes(ctx.key)) throw new HttpError(403, 'not_custodian', 'A restart is asked for by the vault\'s custodians in force.');
        for (const [t, p] of restarts) if (ctx.now - p.at > RESTART_REQUEST_MAX_AGE_MS) restarts.delete(t);
        const waiting = opts.imageWaiting?.() ?? null;
        const pending = [...restarts].at(-1);
        // Asked with no request: what waits, for the second custodian to sign the same.
        if (ctx.body.request === undefined) {
            return json(200, {
                imageWaiting: waiting ? { version: waiting.version, imageHash: waiting.imageHash, staged: waiting.staged } : null,
                // With the signatures, so the second custodian's tool checks who signed rather than taking this API's word.
                pending: pending ? { request: pending[0], signedBy: [...pending[1].signatures.keys()], signatures: [...pending[1].signatures.values()] } : null,
                needed: RESTART_THRESHOLD,
            });
        }
        const text = ctx.body.request;
        const r = parseRestartRequest(text);
        if (typeof r === 'string') throw new HttpError(400, 'bad_request', r);
        if (!waiting?.staged) throw new HttpError(409, 'no_image_waiting', 'No new image is staged here: there is nothing to restart for.');
        if (r.version !== waiting.version || r.imageHash !== waiting.imageHash) {
            throw new HttpError(409, 'not_the_waiting_image', `The request names release ${r.version}; the image staged here is release ${waiting.version}'s.`);
        }
        if (ctx.now - r.at > RESTART_REQUEST_MAX_AGE_MS || r.at > ctx.now + RESTART_CLOCK_MARGIN_MS) throw new HttpError(409, 'stale', 'The request was signed more than an hour ago (or ahead of the vault\'s clock): start a new one.');
        const sig = { key: ctx.key, sig: ctx.body.signature as string };
        if (restartSigners(text as string, [sig], [ctx.key]).length !== 1) throw new HttpError(400, 'bad_signature', 'The signature is not yours, of this request.');
        for (const [t, p] of restarts) {
            if (t === text) continue;
            p.signatures.delete(ctx.key);
            if (!p.signatures.size) restarts.delete(t);
        }
        const p = restarts.get(text as string) ?? { signatures: new Map(), at: ctx.now };
        p.signatures.set(ctx.key, sig);
        restarts.set(text as string, p);
        const signedBy = [...p.signatures.keys()];
        if (p.signatures.size < RESTART_THRESHOLD) return json(200, { state: 'waiting', version: r.version, signedBy, needed: RESTART_THRESHOLD });
        const file: SignedRestartRequest = { v: 1, request: text as string, signatures: [...p.signatures.values()] };
        const part = `${opts.restartRequestFile}.part`;
        writeFileSync(part, `${JSON.stringify(file)}\n`, { mode: 0o600 });
        renameSync(part, opts.restartRequestFile);
        restarts.clear();
        console.log(`vault-api: two custodians asked for a restart for release ${r.version}: left for root to check.`);
        return json(200, { state: 'sent', version: r.version, signedBy, needed: RESTART_THRESHOLD });
    });

    /** The backups the vault can see, by name: its own store's and the off-box store's (for the cold path's restore). */
    route('POST', '/v1/unlock/backups', 'custodian', true, async () => {
        let remote: string[] | null = null;
        let offsiteError: string | null = null;
        if (offsite) {
            try {
                remote = await offsite.list();
            } catch (e) {
                offsiteError = e instanceof OffsiteError ? e.short : 'failed';
            }
        }
        return json(200, { local: await store.list(), offsite: remote, offsiteError });
    });

    // ─── Backups ────────────────────────────────────────────────────────────────────────────

    async function runBackup(): Promise<string> {
        const status = await keyholderStatus();
        if (status.state !== 'open') throw new Error('The vault is locked: no backup.');
        const database = await ensureDb();
        let made: { name: string; bytes: Uint8Array; now: number };
        try {
            made = await withWriteLock(async () => {
                const now = clock();
                const existing = new Set(await store.list());
                let name = backupNameFor(now);
                for (let i = 1; existing.has(name); i++) name = backupNameFor(now).replace('.bin', `-${i}.bin`);
                const deletions = JSON.stringify(database.allDeletions().map(d => ({ id: d.copy_id, pk: vaultB64(d.pk_index), sub: vaultB64(d.sub_index), day: d.day })));
                // No transaction is open (writes hold this lock, and node:sqlite is synchronous), and the journal is
                // truncated at every commit: the file is the database as of its last commit.
                const snapshot = readFileSync(database.file);
                const sealed = await kh.call('sealBackup', { name, createdAt: now, deletions }, snapshot, 300_000);
                snapshot.fill(0);
                await store.put(name, sealed.binary);
                for (const old of await store.list()) {
                    if (backupTimeOf(old) < now - BACKUP_RETENTION_MS) await store.delete(old);
                }
                return { name, bytes: sealed.binary, now };
            });
            lastBackupOkAt = clock();
            backupFailuresInARow = 0;
            backupError = null;
            counters.counts.backupsOk++;
        } catch (e) {
            backupFailuresInARow++;
            backupError = e instanceof BackupTooLarge ? e.message : 'failed';
            counters.counts.backupsFailed++;
            throw e;
        }
        // Off the box, outside the write lock: an upload can take minutes, and deposits mustn't wait for it.
        await copyOffsite(made.name, made.bytes, made.now);
        return made.name;
    }

    /**
     * The backup just written, copied to the off-box store (design §4: another provider, another country), and the
     * copies there older than 30 days removed, as at home (§1.7: a deleted copy leaves the backups within 30 days).
     * An upload that fails is tried once more 30 s later. The copy is done once its upload lands: tidying the old ones
     * (pruneOffsite) is a step of its own, counted and said apart, so a listing that fails never turns a copy already
     * there into a failed one. A failure is counted and said (the report, the alerts); the next hour's backup is the
     * next try. Each backup holds every deletion record of the last 30 days, so a gap in the off-box copies loses
     * nothing a restore needs.
     */
    async function copyOffsite(name: string, bytes: Uint8Array, now: number): Promise<void> {
        const target = offsite;
        if (!target) return;
        try {
            try {
                await target.put(name, bytes);
            } catch {
                // A store that hiccups (a reset connection, a 500) mostly takes the same upload a little later.
                await sleep(OFFSITE_RETRY_MS);
                if (target !== offsite) return;
                counters.counts.offsiteRetried++;
                await target.put(name, bytes);
            }
        } catch (e) {
            if (target !== offsite) return;
            offsiteStatus.failuresInARow++;
            offsiteStatus.step = 'put';
            offsiteStatus.error = e instanceof OffsiteError ? e.short : 'failed';
            counters.counts.offsiteFailed++;
            console.error(`vault-api: the off-box copy of a backup failed (put: ${offsiteStatus.error})`);
            return;
        }
        // Settings changed meanwhile: this store's result says nothing about the one in force now.
        if (target !== offsite) return;
        offsiteStatus.lastOkAt = clock();
        offsiteStatus.lastName = name;
        offsiteStatus.failuresInARow = 0;
        offsiteStatus.step = null;
        offsiteStatus.error = null;
        counters.counts.offsiteOk++;
        await pruneOffsite(target, now);
    }

    /**
     * The off-box store's copies older than 30 days removed. A delete that fails doesn't stop the others; the next
     * copy's tidy-up tries again whatever this one left.
     */
    async function pruneOffsite(target: BackupStore, now: number): Promise<void> {
        let failed: { step: 'list' | 'delete'; error: string } | null = null;
        const short = (e: unknown) => (e instanceof OffsiteError ? e.short : 'failed');
        let old: string[] = [];
        try {
            old = (await target.list()).filter(n => backupTimeOf(n) < now - BACKUP_RETENTION_MS);
        } catch (e) {
            failed = { step: 'list', error: short(e) };
        }
        let left = 0;
        for (const n of old) {
            try {
                await target.delete(n);
            } catch (e) {
                left++;
                failed ??= { step: 'delete', error: short(e) };
            }
        }
        if (target !== offsite) return;
        if (failed) {
            const p = offsiteStatus.prune;
            p.failuresInARow++;
            p.step = failed.step;
            p.error = failed.error;
            counters.counts.offsitePruneFailed++;
            const what = failed.step === 'list' ? 'list' : `delete, ${left} of ${old.length} old copies left`;
            console.error(`vault-api: tidying the off-box store failed (${what}: ${failed.error}); the copy itself is there`);
            return;
        }
        if (target !== offsite) return;
        offsiteStatus.prune = { lastOkAt: clock(), failuresInARow: 0, step: null, error: null };
    }

    async function maintenance(): Promise<void> {
        const now = clock();
        nonces.prune(now);
        for (const [n, exp] of usedTickets) if (exp <= now) usedTickets.delete(n);
        const status = await keyholderStatus();
        if (status.state !== 'open') return;
        const database = await ensureDb();
        await rollReport(now);
        database.pruneHolds(now);
        database.pruneDeletions(dayOf(now - BACKUP_RETENTION_MS));
        await runBackup().catch(() => undefined);
    }

    /**
     * What the custodians are told about (alerts.ts), every minute: the vault locked or its keyholder unreachable for
     * five minutes (not a fresh vault, which holds nothing yet); backups failing twice or the newest over two hours old
     * while open; the same for the off-box copy, when a store is set; a finished day with no signed report two hours
     * into the next (only a day this process ran through: its counts live in memory). A new day's report is made here
     * too, so it doesn't wait for the hourly job.
     */
    function checkAlerts(): Promise<void> {
        alertRun ??= runAlertCheck().finally(() => {
            alertRun = null;
        });
        return alertRun;
    }

    function minute(ms: number): string {
        return `${new Date(ms).toISOString().slice(0, 16)}Z`;
    }

    async function runAlertCheck(): Promise<void> {
        const now = clock();
        const status = await keyholderStatus();
        const open = status.state === 'open' && !status.restorePending && dataReady();
        if (status.reachable && (status.state === 'locked' || status.state === 'open')) keyholderSeen = true;
        const freshVault = status.state === 'fresh' && status.reachable;
        if (open) {
            lockedSince = null;
            openSince ??= now;
            if (db) await rollReport(now);
        } else {
            openSince = null;
            if (freshVault && !keyholderSeen) lockedSince = null;
            else lockedSince ??= now;
        }
        const conditions: Condition[] = [];

        const why = !status.reachable ? 'its keyholder does not answer'
            : status.state === 'locked' ? 'its keyholder is locked (it restarted): two custodians must unlock it'
                : status.state === 'fresh' ? 'its keyholder has lost its state (it came back fresh): custodians must restore it from a backup'
                : status.restorePending ? 'a restore from backup is still to finish' : 'its data partition is not open yet';
        conditions.push({
            key: 'locked', active: lockedSince !== null && now - lockedSince >= LOCKED_ALERT_MS, since: lockedSince ?? undefined,
            detail: lockedSince === null ? 'it is open again.'
                : `${why}. Getting back in with a sign-in, and connecting one, are paused, and no backup is taken, until it opens. The 12 words work as always.`,
        });

        // No backup is taken while locked: once open again, the hourly job has its two hours before that is news.
        const backupBase = lastBackupOkAt === null && openSince === null ? null : Math.max(lastBackupOkAt ?? 0, openSince ?? 0);
        const backupStale = open && backupBase !== null && now - backupBase > BACKUP_STALE_MS;
        const backupFailing = backupFailuresInARow >= BACKUP_FAILURES_ALERT;
        conditions.push({
            key: 'backup', active: backupFailing || backupStale, since: lastBackupOkAt ?? backupBase ?? undefined,
            detail: backupFailing ? `${backupFailuresInARow} backups in a row failed (${backupError ?? 'failed'}).`
                : backupStale ? (lastBackupOkAt ? `the newest backup is from ${minute(lastBackupOkAt)}, over two hours ago.` : 'no backup has been made since the vault opened, over two hours ago.')
                    : `backups work again${lastBackupOkAt ? ` (the newest at ${minute(lastBackupOkAt)})` : ''}.`,
        });

        const offsiteBase = openSince === null ? offsiteStatus.lastOkAt : Math.max(offsiteStatus.lastOkAt ?? 0, openSince, offsiteSince);
        const offsiteStale = !!offsite && open && offsiteBase !== null && now - offsiteBase > BACKUP_STALE_MS;
        const offsiteFailing = !!offsite && offsiteStatus.failuresInARow >= BACKUP_FAILURES_ALERT;
        conditions.push({
            key: 'offsite', active: offsiteFailing || offsiteStale, since: offsiteStatus.lastOkAt ?? offsiteBase ?? undefined,
            detail: !offsite ? 'no off-box store is set now.'
                : offsiteFailing ? `${offsiteStatus.failuresInARow} off-box copies in a row failed (${offsiteStatus.step ?? 'put'}: ${offsiteStatus.error ?? 'failed'}): the backups are on the vault's own disk only.`
                    : offsiteStale ? 'no backup has gone off the box for over two hours: the newest are on the vault\'s own disk only.'
                        : `backups go off the box again${offsiteStatus.lastOkAt ? ` (the newest at ${minute(offsiteStatus.lastOkAt)})` : ''}.`,
        });

        // Its own condition: the copies still go up, but the store's budget, and the 30 days a deleted copy may stay
        // in a backup (§1.7), are only kept while the old ones go.
        const prune = offsiteStatus.prune;
        const pruneFailing = !!offsite && prune.failuresInARow >= OFFSITE_PRUNE_FAILURES_ALERT;
        conditions.push({
            key: 'offsite-prune', active: pruneFailing, since: prune.lastOkAt ?? undefined,
            detail: pruneFailing
                ? `${prune.failuresInARow} tidy-ups of the off-box store in a row failed (${prune.step ?? 'list'}: ${prune.error ?? 'failed'}): copies past 30 days are not being removed there. The copies themselves go up.`
                : 'the off-box store is tidied again: copies past 30 days are removed.',
        });

        const midnight = Date.parse(`${dayOf(now)}T00:00:00Z`);
        const yesterday = dayOf(now - DAY_MS);
        const reportMissing = !freshVault && startedAt < midnight && now - midnight >= REPORT_GRACE_MS && (lastReportDay === null || lastReportDay < yesterday);
        conditions.push({
            key: 'report', active: reportMissing, since: midnight,
            detail: reportMissing ? `no signed daily report for ${yesterday}: ${reportFailure ?? 'the vault was not open to make it'}.`
                : `the daily report is signed again (${lastReportDay ?? 'today'}).`,
        });
        await alertBook.update(conditions);
    }

    // ─── HTTP ───────────────────────────────────────────────────────────────────────────────

    function clientAddress(req: http.IncomingMessage): string {
        if (opts.trustProxy) {
            const xff = req.headers['x-forwarded-for'];
            const last = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map(s => s.trim()).filter(Boolean).pop();
            if (last) return addressBucket(last);
        }
        return addressBucket(req.socket.remoteAddress);
    }

    /** The body, up to 64 KB. Past that: 413, and the connection is closed once the answer is out. */
    function readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const tooLarge = () => {
                (req as http.IncomingMessage & { tooLarge?: boolean }).tooLarge = true;
                reject(new HttpError(413, 'too_large', 'That request is too large.'));
            };
            if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return tooLarge();
            const chunks: Buffer[] = [];
            let size = 0;
            req.on('data', (c: Buffer) => {
                size += c.length;
                if (size > MAX_BODY_BYTES) {
                    if (chunks.length) chunks.length = 0;
                    return tooLarge();
                }
                chunks.push(c);
            });
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
        });
    }

    function send(res: http.ServerResponse, answer: Answer): void {
        if (res.headersSent) return;
        const body = JSON.stringify(answer.body);
        res.writeHead(answer.status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            ...answer.headers,
        });
        res.end(body);
    }

    function errorAnswer(e: unknown): Answer {
        if (e instanceof HttpError) {
            const headers: Record<string, string> = {};
            if (typeof e.extra.retryAfterSeconds === 'number') headers['Retry-After'] = String(e.extra.retryAfterSeconds);
            return { status: e.status, body: { error: e.message, code: e.code, ...e.extra }, headers };
        }
        if (e instanceof SsoProviderUnavailableError) return json(503, { error: e.message, code: 'provider_unavailable' });
        if (e instanceof SsoVerificationError) return json(401, { error: e.message, code: 'signin_refused' });
        if (e instanceof KeyholderUnavailable) return json(503, { error: 'The key vault is locked.', code: 'locked', locked: true });
        if (e instanceof KeyholderCallError) {
            const map: Record<string, number> = {
                locked: 503, bad_request: 400, unknown_custodian: 403, bad_signature: 403, bad_share: 400, bad_box: 400,
                bad_backup: 400, already_set_up: 409, open: 409, fresh: 409, proposal_mismatch: 409, no_custodians: 409,
                no_pending: 404, bad_confirmation: 400, restore_pending: 409,
            };
            const status = map[e.code] ?? 500;
            if (status === 500) counters.counts.errors++;
            return json(status, { error: e.message, code: e.code, ...(e.code === 'locked' ? { locked: true } : {}) });
        }
        counters.counts.errors++;
        console.error(`vault-api: ${(e as Error)?.name ?? 'error'}: ${(e as Error)?.message ?? ''}`.slice(0, 300));
        return json(500, { error: 'The key vault could not do that.', code: 'internal' });
    }

    /**
     * A 4xx to a member's request whose signature checked out, signed as a refusal (`status`, `code`) when the request
     * carried a challenge: the phone acts on some (no copy, no hold, already collected) and on none it can't check. A
     * request whose signature didn't check out gets none: nobody may have a refusal signed about someone else's key.
     * If the keyholder can't sign it now, it goes unsigned, and the phone does nothing with it.
     */
    async function signedRefusal(refused: Answer, key: string, body: Record<string, unknown>): Promise<Answer> {
        const challenge = challengeOf(body);
        const said = refused.body as { code?: unknown };
        if (!challenge || refused.status < 400 || refused.status >= 500 || typeof said?.code !== 'string') return refused;
        try {
            const { signed } = await call<{ signed: string }>('signAnswer', {
                kind: 'refusal', key, challenge, says: { status: refused.status, code: said.code },
            });
            return { ...refused, body: { ...(refused.body as Record<string, unknown>), signed } };
        } catch {
            return refused;
        }
    }

    async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const origin = req.headers.origin;
        const cors: Record<string, string> = origin === GLOBAL_ORIGIN ? { 'Access-Control-Allow-Origin': GLOBAL_ORIGIN, Vary: 'Origin' } : {};
        if (req.method === 'OPTIONS') {
            res.writeHead(204, origin === GLOBAL_ORIGIN ? {
                ...cors,
                'Access-Control-Allow-Methods': 'GET, POST',
                'Access-Control-Allow-Headers': 'Content-Type, X-Public-Key, X-Signature, X-Timestamp, X-Nonce, X-Signed-For',
                'Access-Control-Max-Age': '600',
            } : {});
            res.end();
            return;
        }
        const now = clock();
        const url = new URL(req.url ?? '/', 'http://vault.invalid');
        const method = String(req.method ?? 'GET').toUpperCase();
        const r = routes[`${method} ${url.pathname}`];
        let answer: Answer;
        // Known once the request's signature checks out and its body is read: what a refusal is signed about.
        let key = '';
        let body: Record<string, unknown> = {};
        try {
            if (!r) throw new HttpError(404, 'not_found', 'No such route.');
            const raw = await readBody(req);
            const status = await keyholderStatus();
            if (!r.whenLocked && status.state !== 'open') throw new HttpError(503, 'locked', 'The key vault is locked.', { locked: true });
            if (r.auth !== 'none') {
                const check = verifySignedRequest({ headers: req.headers, method, path: url.pathname, body: raw, hosts: opts.hosts, nonces, now });
                if (!check.ok) throw new HttpError(check.status, check.code, check.error);
                key = check.key;
                if (r.auth === 'custodian') {
                    if (!status.custodians.includes(key) && !status.pending?.custodians.includes(key)) {
                        throw new HttpError(403, 'not_custodian', 'That key is not one of this vault\'s custodians.');
                    }
                    limited(limits.ceremony.take(clientAddress(req), now), 'ceremony calls from this address');
                }
            }
            if (raw) {
                try {
                    const parsed = JSON.parse(raw) as unknown;
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
                    body = parsed as Record<string, unknown>;
                } catch {
                    throw new HttpError(400, 'bad_json', 'The body is not a JSON object.');
                }
            }
            answer = await r.handler({ req, body, key, status, address: clientAddress(req), now });
        } catch (e) {
            answer = errorAnswer(e);
            if (r?.auth === 'signed' && key) answer = await signedRefusal(answer, key, body);
        }
        answer.headers = { ...cors, ...answer.headers };
        if ((req as http.IncomingMessage & { tooLarge?: boolean }).tooLarge) {
            answer.headers.Connection = 'close';
            res.on('finish', () => req.socket.destroy());
        }
        send(res, answer);
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch(() => send(res, json(500, { error: 'The key vault could not do that.', code: 'internal' })));
    });

    async function closeRest(): Promise<void> {
        if (dataWatch) clearInterval(dataWatch);
        await Promise.allSettled([...background, alertRun]);
        await push.idle();
        kh.close();
        db?.close();
        db = null;
    }

    return {
        listen: (port = 0, host = '127.0.0.1') => new Promise<number>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
        }),
        listenUnix: async (linkPath, mode = 0o660) => {
            const own = path.join(path.dirname(linkPath), `api-${process.pid}.sock`);
            rmSync(own, { force: true });
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(own, () => resolve());
            });
            chmodSync(own, mode);
            const next = `${linkPath}.${process.pid}`;
            rmSync(next, { force: true });
            symlinkSync(path.basename(own), next);
            renameSync(next, linkPath);
            return own;
        },
        drain: async (timeoutMs = 30_000) => {
            await new Promise<void>(resolve => {
                const timer = setTimeout(() => server.closeAllConnections(), timeoutMs);
                server.close(() => {
                    clearTimeout(timer);
                    resolve();
                });
                server.closeIdleConnections();
            });
            await closeRest();
        },
        close: async () => {
            await Promise.allSettled([...background]);
            await new Promise<void>(resolve => {
                server.closeAllConnections();
                server.close(() => resolve());
            });
            await closeRest();
        },
        runBackup,
        maintenance,
        checkAlerts,
        idle: async () => {
            while (background.size) await Promise.allSettled([...background]);
            await push.idle();
        },
    };
}
