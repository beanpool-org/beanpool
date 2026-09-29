import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
    checkVaultTicket,
    isVaultPushToken,
    vaultB64,
    vaultTicketNonce,
    vaultUnb64,
    type VaultTicket,
    type VaultTicketPurpose,
} from '@beanpool/core';
import {
    BEANPOOL_GITHUB_CLIENT_IDS,
    createGithubDeviceFlow,
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
import { BACKUP_NAME_RE, backupNameFor, backupTimeOf, compareBackupNames, parseBackupFile } from '../shared/backup-format.js';
import { isVaultProvider } from '../shared/providers.js';
import { NonceStore, verifySignedRequest } from './auth.js';
import type { BackupStore } from './backup-store.js';
import { DB_FILE, VaultDb, type CopyRow, type DeletionRow, type HoldRow } from './db.js';
import { KeyholderCallError, KeyholderClient, KeyholderUnavailable } from './keyholder-client.js';
import { PushSender, type PushKind } from './push.js';
import { addressBucket, RateLimiter } from './rate-limit.js';

/**
 * vault-api (key vault design §1.3, §3): plain `node:http`, the routes, the database, the holds, the pushes, the
 * backups and the daily report. It holds no key: every HMAC, envelope, ticket, release and backup is the keyholder's
 * (over its Unix socket), and it never sees a copy in the clear.
 *
 * While the keyholder is locked (or unreachable, which to the outside is the same), every route but `/v1/health` and
 * `/v1/unlock/*` answers 503 `{locked: true}` (§2.3).
 */

export const HOLD_MS = 24 * 60 * 60 * 1000;
/** The only origin whose browser pages may call the vault (§1.2). CORS isn't the lock: sign-ins are. */
export const GLOBAL_ORIGIN = 'https://global.beanpool.org';
export const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const RESTORE_PENDING = 'restore-pending.bin';
const RESTORE_BUILD = `${DB_FILE}.restore`;
/** After a restore from backup failed to finish, the next try waits this long (requests meanwhile get 503 at once). */
export const RESTORE_RETRY_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** §1.6. GitHub's own limit for one app's device flow is unverified (§10): the vault-wide ceiling stays well under it. */
export const LIMITS = {
    ticketsPerAddressPerMinute: 10,
    githubStartsPerAddressPerHour: 5,
    githubStartsPerHourVaultWide: 40,
    githubPollsPerAddressPerMinute: 30,
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
    /** For the providers' keys, GitHub and Expo. Defaults to the global fetch. */
    fetch?: FetchLike;
    clock?: () => number;
    /** Only if Expo requires one for BeanPool's project (§10). */
    expoAccessToken?: string;
    /** Take the client address from the last X-Forwarded-For entry (Caddy on the same machine, V3). */
    trustProxy?: boolean;
}

export interface VaultApi {
    listen(port?: number, host?: string): Promise<number>;
    close(): Promise<void>;
    /** One backup now; the hourly job calls this. Returns its name. */
    runBackup(): Promise<string>;
    /** The hourly job: a backup, and the expiry of holds, deletion records and nonces. */
    maintenance(): Promise<void>;
    /** Resolves once background work (pushes, re-wraps) has finished. */
    idle(): Promise<void>;
}

interface KeyholderStatus {
    state: 'fresh' | 'locked' | 'open';
    since: number;
    custodians: string[];
    /** A genesis or reshare waiting for two of its custodians to confirm their shares. */
    pending: { purpose: string; generation: number; custodians: string[]; confirmed: string[] } | null;
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
            releases: 0, deletes: 0, pushTokens: 0, errors: 0, backupsOk: 0, backupsFailed: 0,
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

    const limits = {
        tickets: new RateLimiter(LIMITS.ticketsPerAddressPerMinute, 60_000),
        githubStarts: new RateLimiter(LIMITS.githubStartsPerAddressPerHour, HOUR_MS),
        githubStartsAll: new RateLimiter(LIMITS.githubStartsPerHourVaultWide, HOUR_MS),
        githubPolls: new RateLimiter(LIMITS.githubPollsPerAddressPerMinute, 60_000),
        restores: new RateLimiter(LIMITS.restoresPerAccountPerDay, DAY_MS),
        deposits: new RateLimiter(LIMITS.depositsPerKeyPerDay, DAY_MS),
        ceremony: new RateLimiter(LIMITS.ceremonyCallsPerAddressPerMinute, 60_000),
    };

    // Tickets spent, by their `n`, until they expire. In memory: see auth.ts on restarts.
    const usedTickets = new Map<string, number>();
    // The ticket each in-flight sign-in check was presented with, by its nonce.
    const pendingTickets = new Map<string, VaultTicket>();

    const jwks = createJwksCache({ fetch: opts.fetch, now: clock });
    const github = createGithubDeviceFlow({ fetch: opts.fetch, now: clock, userAgent: 'BeanPool-Vault' });
    const verifier = createSignInVerifier({
        jwks,
        now: clock,
        consumeNonce: (nonce, subject) => {
            const t = pendingTickets.get(nonce);
            if (!t || t.key !== subject || usedTickets.has(t.n)) return false;
            usedTickets.set(t.n, t.exp);
            return true;
        },
        consumeGithubSession: (sessionId, subject) => github.consume(sessionId, subject),
    });

    let db: VaultDb | null = null;
    let opening: Promise<VaultDb> | null = null;
    const background = new Set<Promise<unknown>>();
    let writeChain: Promise<unknown> = Promise.resolve();

    const pendingPath = path.join(opts.dataDir, RESTORE_PENDING);
    const dbPath = path.join(opts.dataDir, DB_FILE);

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
                state: 'locked', since: startedAt, custodians: [], pending: null, generation: null, platform: 'none', releaseHash: 'unknown',
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
            if (status.restorePending) {
                // A crash after the keyholder took the backup's state but before the file got its name.
                if (!existsSync(pendingPath) && existsSync(`${pendingPath}.part`)) renameSync(`${pendingPath}.part`, pendingPath);
                if (!existsSync(pendingPath)) {
                    restoreFailure = 'the backup it was started from is missing from the data directory';
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
            return db;
        })().finally(() => {
            opening = null;
        });
        return opening;
    }

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
            const newer = (await store.list()).filter(n => compareBackupNames(n, opened.result.header.name) > 0).sort(compareBackupNames);
            for (const name of newer) {
                const bytes = await store.get(name);
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

    const githubSubject = (nonce: string) => `vault-ticket:${nonce}`;

    /**
     * The sign-in in a deposit or restore, checked only through @beanpool/signin: BeanPool's own client ids as the
     * audience (no override), and as the provider nonce the hash of the ticket this request carries. GitHub's is the
     * vault's own device-flow session, started for this ticket. The ticket is spent only when the sign-in checks out.
     */
    async function checkSignIn(ctx: Ctx, purpose: VaultTicketPurpose, beforeVerify?: () => void): Promise<{ provider: SsoProvider; identity: SsoIdentity }> {
        const provider = ctx.body.provider;
        if (!isVaultProvider(provider)) throw new HttpError(400, 'bad_provider', 'That is not a sign-in the key vault keeps copies for.');
        const { ticket, nonce } = acceptTicket(ctx, purpose);
        beforeVerify?.();
        pendingTickets.set(nonce, ticket);
        try {
            const subject = provider === 'github' ? githubSubject(nonce) : ctx.key;
            const identity = await verifier.verifySignIn(provider, signInCredentialFrom(ctx.body), defaultAudiences(provider), nonce, subject);
            if (provider === 'github') {
                if (usedTickets.has(ticket.n)) throw new HttpError(401, 'ticket_used', 'That ticket was already used. Start again.');
                usedTickets.set(ticket.n, ticket.exp);
            }
            return { provider, identity };
        } finally {
            pendingTickets.delete(nonce);
        }
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
        state: ctx.status.state === 'open' && !ctx.status.restorePending ? 'open' : 'locked',
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

    route('POST', '/v1/github/start', 'signed', false, async ctx => {
        limited(limits.githubStarts.take(ctx.address, ctx.now), 'GitHub sign-ins from this address');
        limited(limits.githubStartsAll.take('all', ctx.now), 'GitHub sign-ins');
        const { nonce } = acceptTicket(ctx);
        return json(200, await github.start(githubSubject(nonce), BEANPOOL_GITHUB_CLIENT_IDS[0]));
    });

    route('POST', '/v1/github/poll', 'signed', false, async ctx => {
        limited(limits.githubPolls.take(ctx.address, ctx.now), 'GitHub checks from this address');
        const { nonce } = acceptTicket(ctx);
        const sessionId = typeof ctx.body.sessionId === 'string' ? ctx.body.sessionId : '';
        const polled = await github.poll(sessionId, githubSubject(nonce));
        // The GitHub id is what seals and opens the copy on the phone; the address is not the vault's business.
        return json(200, polled.status === 'ok' ? { status: 'ok', sub: polled.sub } : polled);
    });

    route('POST', '/v1/copies', 'signed', false, async ctx => {
        const { provider, identity } = await checkSignIn(ctx, 'deposit',
            () => limited(limits.deposits.take(ctx.key, ctx.now), 'deposits for this account today'));
        const database = await ensureDb();
        return withWriteLock(async () => {
            const subIndex = b64Bytes(await index('sub', provider, identity.sub));
            const pkIndex = b64Bytes(await index('pk', ctx.key));
            const existing = database.copyBySub(subIndex);
            const sameMember = !!existing && sameBytes(existing.pk_index, pkIndex);
            const id = sameMember ? (existing as CopyRow).id : newId();
            let wrapped: { envelope: string };
            try {
                wrapped = await call<{ envelope: string }>('depositWrap', {
                    id, provider, sub: identity.sub, memberKey: ctx.key, box: ctx.body.box, carry: sameMember ? rowRef(existing as CopyRow) : null,
                });
            } catch (e) {
                if (e instanceof KeyholderCallError && e.code === 'bad_box') {
                    throw new HttpError(400, 'bad_box', 'The copy did not open as a deposit for this account and sign-in.');
                }
                throw e;
            }
            const oldTokens = existing && !sameMember ? (await metaOf(existing)).pushTokens : [];
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
            if (existing && !sameMember) {
                counters.counts.replaced++;
                notify(oldTokens, 'vault-replaced', provider);
            }
            return json(200, { ok: true, provider, replaced: !!existing && !sameMember });
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
        return json(200, { copies, holds });
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
            return json(200, { deleted: doomed.length });
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
            return json(200, { updated });
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
                if (open.requester_key === ctx.key) return json(200, { status: 'held', holdId: open.id, until: open.release_at });
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
            return json(200, { status: 'held', holdId: hold.id, until: hold.release_at });
        });
    });

    /**
     * The release, sealed to the key that started the restore. That device may collect again (its answer may have been
     * lost) until the hold is pruned: a fresh seal to the same key gives nobody anything new. The release is recorded,
     * and the member's devices told, once.
     */
    route('POST', '/v1/restore/collect', 'signed', false, async ctx => {
        const database = await ensureDb();
        return withWriteLock(async () => {
            const hold = typeof ctx.body.holdId === 'string' ? database.holdById(ctx.body.holdId) : undefined;
            if (!hold || hold.requester_key !== ctx.key) throw new HttpError(404, 'no_hold', 'There is no restore waiting for this device.');
            if (hold.cancelled_at !== null) return json(200, { status: 'stopped' });
            if (ctx.now < hold.release_at) return json(200, { status: 'held', until: hold.release_at });
            const row = database.copyById(hold.copy_id);
            if (!row) throw new HttpError(404, 'no_copy', 'The copy this restore was for is no longer kept.');
            const { release } = await call<{ release: unknown }>('release', { row: rowRef(row), requesterKey: ctx.key });
            if (hold.released_at === null) {
                const updated = await call<{ envelope: string }>('updateMeta', { row: rowRef(row), lastReleasedAt: ctx.now });
                database.transaction(() => {
                    database.updateEnvelope(row.id, b64Bytes(updated.envelope));
                    database.markReleased(hold.id, ctx.now);
                });
                counters.counts.releases++;
                notify(await memberTokens(database, row.pk_index), 'vault-released', hold.provider);
            }
            return json(200, { status: 'released', release });
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
            return json(200, { status: 'stopped' });
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
            return json(200, { status: 'approved', releaseAt });
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
            backups: { lastOkAt: lastBackupOkAt, failuresInARow: backupFailuresInARow },
            pushes: { sent: push.sent, failed: push.failed },
            release: status.releaseHash, generation: status.generation, platform: status.platform, memory: status.memory,
            uptimeSeconds: Math.floor((now - startedAt) / 1000),
        });
    }

    async function rollReport(now: number): Promise<void> {
        const finished = counters.roll(now);
        if (!finished || !db) return;
        const status = await keyholderStatus();
        if (status.state !== 'open') return;
        const text = reportText(now, finished.day, finished.counts, db, status);
        previousReport = { text, signature: (await call<{ signature: string }>('signReport', { text })).signature };
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
        const result = await call<{ state: string; switched: boolean }>('confirm', { confirmation });
        if (result.switched && result.state === 'open') await unlocked();
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
            bytes = await store.get(name);
        } catch {
            throw new HttpError(404, 'no_backup', 'The backup store has no backup by that name.');
        }
        let header;
        try {
            header = parseBackupFile(bytes).header;
        } catch (e) {
            throw new HttpError(400, 'bad_backup', (e as Error).message);
        }
        mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
        writeFileSync(`${pendingPath}.part`, bytes, { mode: 0o600 });
        try {
            await call('adoptState', { custodian: ctx.key, sig: ctx.body.sig, backupName: name, state: header.state });
        } catch (e) {
            rmSync(`${pendingPath}.part`, { force: true });
            throw e;
        }
        renameSync(`${pendingPath}.part`, pendingPath);
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

    // ─── Backups ────────────────────────────────────────────────────────────────────────────

    async function runBackup(): Promise<string> {
        const status = await keyholderStatus();
        if (status.state !== 'open') throw new Error('The vault is locked: no backup.');
        const database = await ensureDb();
        try {
            const name = await withWriteLock(async () => {
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
                return name;
            });
            lastBackupOkAt = clock();
            backupFailuresInARow = 0;
            counters.counts.backupsOk++;
            return name;
        } catch (e) {
            backupFailuresInARow++;
            counters.counts.backupsFailed++;
            throw e;
        }
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
        try {
            if (!r) throw new HttpError(404, 'not_found', 'No such route.');
            const raw = await readBody(req);
            const status = await keyholderStatus();
            if (!r.whenLocked && status.state !== 'open') throw new HttpError(503, 'locked', 'The key vault is locked.', { locked: true });
            let key = '';
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
            let body: Record<string, unknown> = {};
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

    return {
        listen: (port = 0, host = '127.0.0.1') => new Promise<number>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
        }),
        close: async () => {
            await Promise.allSettled([...background]);
            await push.idle();
            await new Promise<void>(resolve => {
                server.closeAllConnections();
                server.close(() => resolve());
            });
            kh.close();
            db?.close();
            db = null;
        },
        runBackup,
        maintenance,
        idle: async () => {
            while (background.size) await Promise.allSettled([...background]);
            await push.idle();
        },
    };
}
