/**
 * Owner automation tokens (node sign-in design step 7, decision D8): a credential an owner makes in Settings for a script
 * or the fleet manager, so that tooling need not hold the admin password. Presented as
 * `Authorization: Bearer bp_<id>_<secret>` and checked first in checkAdminAuth (admin-auth.ts).
 *
 * - Shown once: the server keeps a SHA-256 of the secret, never the secret. The secret is 256 random bits, so a fast hash
 *   is enough: scrypt slows the guessing of a secret a person chose, and nobody can guess 2^256. A slow hash on every
 *   script request would only cost the server CPU.
 * - Scoped (TOKEN_SCOPES). No scope reaches an owner-only change (admin-auth.ts requireAdminRole / requirePhoneStepUp),
 *   the sign-in routes, or the token routes themselves.
 * - Kept in local-config.json as `automationTokens`, this server's own: left out of every backup file, the stager's copy
 *   and the take-over bundle (engine/replication-manifest.ts LOCAL_CONFIG_FIELDS, per-server).
 * - Revoked by any owner; a revoked token is refused on its next request.
 */
import crypto from 'node:crypto';
import { getLocalConfig, updateLocalConfig, type AutomationTokenRecord } from './config/local-config.js';

export const TOKEN_SCOPES = ['read', 'backups', 'admin'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const TOKEN_PREFIX = 'bp_';
/** bp_ + 12 hex (the public id) + _ + 64 hex (the secret). */
const TOKEN_SHAPE = /^bp_([0-9a-f]{12})_([0-9a-f]{64})$/;
export const TOKEN_NAME_MAX = 60;
/** At most this many tokens on a node: a list an owner can read in Settings. */
export const TOKEN_LIMIT = 50;
/** last-used-at is written to local-config.json at most this often per token; the list shows it to the minute. */
const LAST_USED_WRITE_MS = 60_000;

/**
 * The backups scope: exactly these routes, every one an owner's read of the community's backups (making a snapshot or
 * sending one off the box writes nothing an owner chose). Restoring, deleting, changing where backups go, the
 * replication token and the server this one copies from stay owner-only and refused to every token. The standby's copy
 * routes (sync-*) take the replication token, its own scoped credential, and are not here (design step 7b).
 */
export const BACKUPS_SCOPE_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
    { method: 'POST', path: '/api/local/admin/backup' },
    { method: 'POST', path: '/api/local/admin/backup-status' },
    { method: 'POST', path: '/api/local/admin/backup/verify' },
    { method: 'POST', path: '/api/local/admin/snapshots/list' },
    { method: 'POST', path: '/api/local/admin/snapshots/create' },
    { method: 'GET', path: '/api/local/admin/snapshots/download' },
    { method: 'POST', path: '/api/local/admin/offbox-backups/status' },
    { method: 'POST', path: '/api/local/admin/offbox-backups/list' },
    { method: 'POST', path: '/api/local/admin/offbox-backups/run' },
    { method: 'GET', path: '/api/local/admin/offbox-backups/download' },
];

/** Routes no token reaches whatever its scope: signing in, sessions and the tokens themselves. */
export function isRefusedToEveryToken(method: string, reqPath: string): boolean {
    const p = reqPath.toLowerCase().replace(/\/+$/, '');
    return p.startsWith('/api/local/admin/auth/') || p === '/api/local/admin/auth'
        || p.startsWith('/api/local/admin/automation-tokens')
        || p.startsWith('/api/local/admin/2fa/')
        || p === '/api/local/admin/ws-ticket'
        || p === '/api/local/admin/csrf-token';
}

export function isBackupsScopeRoute(method: string, reqPath: string): boolean {
    const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    const p = reqPath.toLowerCase().replace(/\/+$/, '');
    return BACKUPS_SCOPE_ROUTES.some(r => r.method === m && r.path === p);
}

export function isTokenScope(s: unknown): s is TokenScope {
    return typeof s === 'string' && (TOKEN_SCOPES as readonly string[]).includes(s);
}

/**
 * Whether a value has the whole shape of a token (bp_ + 12 hex + _ + 64 hex), as the check below asks. For tooling that
 * sends one (the harvester; scripts/automation-token.mjs mirrors it for the scripts): a value that fails it is refused
 * before any header is built, so a control character inside never reaches fetch, whose error repeats the whole value.
 */
export function isAutomationTokenShape(value: unknown): value is string {
    return typeof value === 'string' && TOKEN_SHAPE.test(value);
}

/** Whether a bearer value is meant as an automation token (then checkAdminAuth decides on it alone). */
export function looksLikeAutomationToken(bearer: string | null | undefined): boolean {
    return typeof bearer === 'string' && bearer.startsWith(TOKEN_PREFIX);
}

function sha256Hex(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
}

/** What the list shows: never the hash. */
export type AutomationTokenView = Omit<AutomationTokenRecord, 'hash'>;

function viewOf(t: AutomationTokenRecord): AutomationTokenView {
    const { hash: _hash, ...rest } = t;
    return rest;
}

function records(): AutomationTokenRecord[] {
    const list = getLocalConfig().automationTokens;
    return Array.isArray(list) ? list : [];
}

export function listAutomationTokens(): AutomationTokenView[] {
    return records().map(viewOf);
}

export type IssueResult =
    | { ok: true; token: string; record: AutomationTokenView }
    | { ok: false; error: string };

/**
 * Make a token. `createdBy` is the issuing owner's key (only a key session makes one). The plain token is in the answer only;
 * the stored record has its hash.
 */
export function issueAutomationToken(input: { name: unknown; scope: unknown; expiresAt?: unknown; createdBy: string }, now = Date.now()): IssueResult {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) return { ok: false, error: 'Give the token a name, so you know later what uses it' };
    if (name.length > TOKEN_NAME_MAX) return { ok: false, error: `A token's name is at most ${TOKEN_NAME_MAX} characters` };
    if (!isTokenScope(input.scope)) return { ok: false, error: `Unknown scope: pick one of ${TOKEN_SCOPES.join(', ')}` };
    let expiresAt: number | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
        const n = Number(input.expiresAt);
        if (!Number.isFinite(n) || n <= now) return { ok: false, error: 'The expiry must be a time in the future' };
        expiresAt = Math.floor(n);
    }
    const list = records();
    if (list.length >= TOKEN_LIMIT) return { ok: false, error: `This node has ${TOKEN_LIMIT} tokens: revoke one first` };
    let id = crypto.randomBytes(6).toString('hex');
    while (list.some(t => t.id === id)) id = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const record: AutomationTokenRecord = {
        id, name, scope: input.scope, createdBy: input.createdBy, createdAt: now, expiresAt,
        lastUsedAt: null, lastUsedRoute: null, hash: sha256Hex(secret),
    };
    updateLocalConfig({ automationTokens: [...list, record] });
    return { ok: true, token: `${TOKEN_PREFIX}${id}_${secret}`, record: viewOf(record) };
}

export function revokeAutomationToken(id: unknown): boolean {
    const list = records();
    const next = list.filter(t => t.id !== id);
    if (next.length === list.length) return false;
    lastUsedWritten.delete(String(id));
    updateLocalConfig({ automationTokens: next });
    return true;
}

/** A hash no secret has, for an unknown id or a malformed token: the same work as a real comparison. */
const NO_TOKEN_HASH = sha256Hex(crypto.randomBytes(32).toString('hex'));

/**
 * The token a presented bearer value names, if its secret matches and it has not expired; null otherwise. One SHA-256 and
 * one constant-time comparison whatever is wrong with it (shape, id or secret), so the answer's time says nothing.
 */
export function verifyAutomationToken(presented: string, now = Date.now()): AutomationTokenRecord | null {
    const m = TOKEN_SHAPE.exec(presented);
    // The list is read whatever the shape, so a malformed token costs what a well-formed one does.
    const list = records();
    const record = m ? list.find(t => t.id === m[1]) : undefined;
    const presentedHash = Buffer.from(sha256Hex(m ? m[2] : presented), 'hex');
    const storedHash = Buffer.from(record?.hash && /^[0-9a-f]{64}$/.test(record.hash) ? record.hash : NO_TOKEN_HASH, 'hex');
    const match = crypto.timingSafeEqual(presentedHash, storedHash);
    if (!m || !record || !match) return null;
    if (record.expiresAt && now >= record.expiresAt) return null;
    if (!isTokenScope(record.scope)) return null;
    return record;
}

const lastUsedWritten = new Map<string, number>();

/** Record a use for the list (at most once a minute per token to the file). */
export function noteAutomationTokenUse(id: string, route: string, now = Date.now()): void {
    const last = lastUsedWritten.get(id) ?? 0;
    if (now - last < LAST_USED_WRITE_MS) return;
    lastUsedWritten.set(id, now);
    const list = records();
    const i = list.findIndex(t => t.id === id);
    if (i < 0) return;
    list[i] = { ...list[i], lastUsedAt: now, lastUsedRoute: route.slice(0, 120) };
    updateLocalConfig({ automationTokens: list });
}

/** For tests: forget the last-used throttle. */
export function resetAutomationTokenUseThrottle(): void {
    lastUsedWritten.clear();
}
