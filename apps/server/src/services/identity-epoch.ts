/**
 * The split-brain guard (sealed-keys.md §5.4; slice 8).
 *
 * A take-over keeps the node key, so the new main server has the old one's PeerId. If the old main server is ever
 * started again, two servers answer as one community. This is the best-effort guard against that:
 *
 * - **The epoch.** Every identity counts its take-overs: `identityEpoch` in local-config.json, carried in the
 *   take-over bundle. A take-over writes the bundle's number + 1 (services/takeover.ts, step "role"). A server that
 *   never took over is at 0.
 * - **The statement.** `GET /api/node/identity-epoch` (public) answers the epoch, signed with the node key. Only a
 *   holder of the node key can make one, and only a take-over raises the number.
 * - **The check.** A main server, at boot and every hour, asks ITS OWN public address (the registrar's hostname,
 *   else CF_RECORD_NAME) for the statement. If it sees a HIGHER epoch signed by its own node key, another server has
 *   taken over from it and the address now leads there: it goes read-only (members' writes refused, the reason in
 *   Settings and the log) and remembers it across restarts. It never refuses to boot.
 * - **What it ignores.** An address it cannot reach, an old server with no such route, and anything not signed by
 *   its own key (a forgery, logged) change nothing: no hard gate. So the manual still says: don't start the old
 *   main server again after a take-over.
 *
 * Read-only covers members' writes over HTTP (every POST/PUT/PATCH/DELETE under /api/ except the admin control
 * plane, /api/local/ and /api/manager/, so the operator can still sign in, read what happened, and take the
 * database off). It is where members and other communities write; it is not a lock on the database.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import type Koa from 'koa';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { getNodeRole, getNodeConfig } from '../state-engine.js';
import { logger } from '../logger.js';
import { readNodeIdentity, type NodeIdentity } from './takeover-envelope.js';

export const IDENTITY_EPOCH_PATH = '/api/node/identity-epoch';
const DOMAIN = 'beanpool-identity-epoch-v1\n';
const CHECK_INTERVAL_MS = Number(process.env.IDENTITY_EPOCH_CHECK_INTERVAL_MS) || 60 * 60_000;
const FETCH_TIMEOUT_MS = Number(process.env.IDENTITY_EPOCH_FETCH_TIMEOUT_MS) || 10_000;
/** A tunnel run from two machines at once is load-balanced between them, so one answer may be our own. */
const ASKS_PER_CHECK = 3;

export interface EpochStatement {
    v: 1;
    peerId: string;
    communityId: string | null;
    epoch: number;
    /** When this server took this epoch (the take-over's start); null for a server that never took over. */
    since: string | null;
}

export interface SignedEpoch {
    statement: EpochStatement;
    /** Ed25519 by the node key over DOMAIN ‖ the canonical statement, base64. */
    sig: string;
}

export function ownIdentityEpoch(): { epoch: number; since: string | null } {
    const c = getLocalConfig();
    const epoch = Number(c.identityEpoch);
    return { epoch: Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0, since: c.identityEpochSince ?? null };
}

/** Fixed field order, so signer and checker hash the same bytes whatever order the JSON arrived in. */
function canonical(s: EpochStatement): Uint8Array {
    return new TextEncoder().encode(DOMAIN + JSON.stringify({
        v: s.v, peerId: s.peerId, communityId: s.communityId, epoch: s.epoch, since: s.since,
    }));
}

export function signEpochStatement(statement: EpochStatement, seed: Uint8Array): SignedEpoch {
    return { statement, sig: Buffer.from(ed25519.sign(canonical(statement), seed)).toString('base64') };
}

function ownCommunityId(): string | null {
    try {
        const dir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        const g = JSON.parse(fs.readFileSync(path.join(dir, 'genesis.json'), 'utf-8'));
        return typeof g?.communityId === 'string' ? g.communityId : null;
    } catch {
        return null;
    }
}

let cached: { key: string; signed: SignedEpoch } | null = null;

/** This server's signed statement, or null when it has no node key yet. */
export function currentSignedEpoch(): SignedEpoch | null {
    const identity = readNodeIdentity();
    if (!identity) return null;
    const communityId = ownCommunityId();
    const { epoch, since } = ownIdentityEpoch();
    const key = `${identity.peerId}|${communityId}|${epoch}|${since}`;
    if (cached?.key === key) return cached.signed;
    const signed = signEpochStatement({ v: 1, peerId: identity.peerId, communityId, epoch, since }, identity.seed);
    cached = { key, signed };
    return signed;
}

export type EpochVerdict =
    | { ok: true; statement: EpochStatement }
    | { ok: false; forged: boolean; why: string };

/** Is this a statement signed by OUR node key? Anything else is not evidence of anything. */
export function verifyEpochStatement(body: unknown, identity: NodeIdentity): EpochVerdict {
    const b = body as Partial<SignedEpoch> | null;
    const s = b?.statement as Partial<EpochStatement> | undefined;
    if (!b || typeof b.sig !== 'string' || !s || s.v !== 1 || typeof s.peerId !== 'string'
        || !Number.isSafeInteger(s.epoch) || (s.epoch as number) < 0
        || !(s.communityId === null || typeof s.communityId === 'string')
        || !(s.since === null || typeof s.since === 'string')) {
        return { ok: false, forged: false, why: 'an answer that is not an identity-epoch statement' };
    }
    const statement: EpochStatement = { v: 1, peerId: s.peerId, communityId: s.communityId, epoch: s.epoch as number, since: s.since };
    let valid = false;
    try {
        valid = ed25519.verify(Buffer.from(b.sig, 'base64'), canonical(statement), ed25519.getPublicKey(identity.seed));
    } catch {
        valid = false;
    }
    if (!valid) return { ok: false, forged: true, why: `a statement for epoch ${statement.epoch} that is NOT signed by this server's node key` };
    if (statement.peerId !== identity.peerId) {
        // Signed by our key but naming another PeerId: only our own key could make it, so it is our own mistake,
        // not a take-over. Never act on it.
        return { ok: false, forged: true, why: `a statement signed by this server's key but naming PeerId ${statement.peerId}` };
    }
    return { ok: true, statement };
}

// ── The check ─────────────────────────────────────────────────────────────────────────────

/** Where this server's own public address serves the statement, or null when it has none. */
export function ownPublicEpochUrl(): string | null {
    // Tests only: the address the suite's "public hostname" answers at. Unset in every real deployment.
    const test = process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL;
    if (test) return test;
    let host: string | null = null;
    try {
        const pa = (getNodeConfig() as any)?.publicAddress;
        if (pa && typeof pa.hostname === 'string' && pa.hostname.trim()) host = pa.hostname.trim();
    } catch { /* no node_config yet */ }
    if (!host && process.env.CF_RECORD_NAME) host = process.env.CF_RECORD_NAME.trim();
    if (!host) return null;
    return `https://${host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}${IDENTITY_EPOCH_PATH}`;
}

export type EpochCheck =
    | { state: 'not-primary' }
    | { state: 'no-identity' }
    | { state: 'no-address' }
    | { state: 'unreachable'; url: string; why: string }
    | { state: 'no-epoch-route'; url: string }
    | { state: 'forged'; url: string; why: string }
    | { state: 'current'; url: string; seen: number; own: number }
    | { state: 'replaced'; url: string; seen: number; own: number; since: string | null };

async function askOnce(url: string): Promise<{ status: number; body: unknown } | { error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        const text = await res.text();
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { body = null; }
        return { status: res.status, body };
    } catch (e: any) {
        return { error: e?.name === 'AbortError' ? `no answer in ${FETCH_TIMEOUT_MS / 1000}s` : (e?.cause?.code || e?.message || String(e)) };
    } finally {
        clearTimeout(timer);
    }
}

let lastLogged = '';
function logOnce(key: string, log: () => void): void {
    if (key === lastLogged) return;
    lastLogged = key;
    log();
}

/**
 * Ask this server's own public address for the epoch, and act on the answer. Never throws. Only a main server
 * checks: a standby has its own key and is not the one a take-over replaces.
 */
export async function checkIdentityEpoch(): Promise<EpochCheck> {
    try {
        if (getNodeRole() !== 'primary') return { state: 'not-primary' };
        const identity = readNodeIdentity();
        if (!identity) return { state: 'no-identity' };
        const url = ownPublicEpochUrl();
        if (!url) return { state: 'no-address' };
        const own = ownIdentityEpoch().epoch;

        let best: EpochStatement | null = null;
        let forged: string | null = null;
        let unreachable: string | null = null;
        let noRoute = false;
        for (let i = 0; i < ASKS_PER_CHECK; i++) {
            const got = await askOnce(url);
            if ('error' in got) { unreachable = got.error; break; }
            if (got.status === 404) { noRoute = true; continue; }
            if (got.status !== 200) { unreachable = `HTTP ${got.status}`; continue; }
            const verdict = verifyEpochStatement(got.body, identity);
            if (!verdict.ok) {
                forged = verdict.why;
                continue;
            }
            if (!best || verdict.statement.epoch > best.epoch) best = verdict.statement;
            if (best.epoch > own) break; // proof enough
        }

        if (best && best.epoch > own) {
            markReplaced(identity.peerId, best, own, url);
            return { state: 'replaced', url, seen: best.epoch, own, since: best.since };
        }
        if (forged) {
            logger.security('SYS', `[Split-brain] Ignored ${forged} at ${url}. This server carries on as the main server.`);
            if (!best) return { state: 'forged', url, why: forged };
        }
        if (best) {
            logOnce(`current|${url}|${best.epoch}`, () => logger.info('SYS', `[Split-brain] ${url} answers identity epoch ${best!.epoch}; this server is at ${own}. No other server has taken over.`));
            return { state: 'current', url, seen: best.epoch, own };
        }
        if (noRoute && !unreachable) {
            logOnce(`no-route|${url}`, () => logger.info('SYS', `[Split-brain] ${url} has no identity-epoch route (an older BeanPool, or another site). Carrying on.`));
            return { state: 'no-epoch-route', url };
        }
        const why = unreachable || 'no answer';
        logOnce(`unreachable|${url}`, () => logger.info('SYS', `[Split-brain] Could not ask ${url} for the identity epoch (${why}). Carrying on as the main server; checking again in an hour.`));
        return { state: 'unreachable', url, why };
    } catch (e: any) {
        logger.warn('SYS', `[Split-brain] Identity epoch check failed: ${e?.message || e}`);
        return { state: 'unreachable', url: '', why: e?.message || String(e) };
    }
}

function markReplaced(peerId: string, seen: EpochStatement, own: number, url: string): void {
    const prev = getLocalConfig().identityReplaced;
    if (prev && prev.peerId === peerId && prev.epoch >= seen.epoch) return;
    const record = { peerId, epoch: seen.epoch, ownEpoch: own, since: seen.since, detectedAt: new Date().toISOString(), url };
    updateLocalConfig({ identityReplaced: record });
    readOnlyMemo = null;
    logger.security('SYS', `[Split-brain] 🛑 ${replacedMessage(record)} ${url} answers identity epoch ${seen.epoch}, signed with this server's own node key; this server is at ${own}. Members' writes are refused from now on. Don't run this server as the main server again.`);
}

// ── Read-only ─────────────────────────────────────────────────────────────────────────────

export interface ReplacedInfo {
    epoch: number;
    ownEpoch: number;
    since: string | null;
    detectedAt: string;
    url: string;
    message: string;
}

function replacedMessage(r: { since: string | null; detectedAt: string }): string {
    const date = (r.since || r.detectedAt).slice(0, 10);
    return `This server was replaced on ${date}. It is now read-only.`;
}

/** Non-null when this server has seen that another took over from it, and it is still that main server. */
export function getReplacedInfo(): ReplacedInfo | null {
    const r = getLocalConfig().identityReplaced;
    if (!r) return null;
    if (getNodeRole() !== 'primary') return null;
    let peerId: string | null = null;
    try { peerId = readNodeIdentity()?.peerId ?? null; } catch { peerId = null; }
    if (peerId !== r.peerId) return null; // a new identity since: the record is about a server this no longer is
    if (ownIdentityEpoch().epoch >= r.epoch) return null;
    return { epoch: r.epoch, ownEpoch: r.ownEpoch, since: r.since, detectedAt: r.detectedAt, url: r.url, message: replacedMessage(r) };
}

let readOnlyMemo: { at: number; info: ReplacedInfo | null } | null = null;
function replacedNow(): ReplacedInfo | null {
    // Asked on every write; the answer changes only when a check runs (which clears the memo) or on restart.
    const now = Date.now();
    if (!readOnlyMemo || now - readOnlyMemo.at > 5_000) readOnlyMemo = { at: now, info: getReplacedInfo() };
    return readOnlyMemo.info;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Koa middleware: while replaced, refuse members' writes with 503 and the reason. */
export async function identityReadOnlyGuard(ctx: Koa.Context, next: Koa.Next): Promise<void> {
    if (MUTATING.has(ctx.method)) {
        const p = ctx.path.toLowerCase();
        if (p.startsWith('/api/') && !p.startsWith('/api/local/') && !p.startsWith('/api/manager/')) {
            const info = replacedNow();
            if (info) {
                ctx.status = 503;
                ctx.set('Cache-Control', 'no-store');
                ctx.body = {
                    error: `${info.message} Another server took over this community; use that one.`,
                    readOnly: true, replacedSince: info.since, detectedAt: info.detectedAt,
                };
                return;
            }
        }
    }
    await next();
}

// ── The watch ─────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * At boot and every hour. Returns the first check, which index.ts does NOT wait for (the boot never waits on the
 * network); the test harness does. A server already marked replaced is read-only from its first request.
 */
export function startIdentityEpochWatch(): Promise<EpochCheck> {
    stopIdentityEpochWatch();
    readOnlyMemo = null;
    const replaced = getReplacedInfo();
    if (replaced) logger.security('SYS', `[Split-brain] 🛑 ${replaced.message} (seen ${replaced.detectedAt} at ${replaced.url}). Members' writes are refused.`);
    const run = () => checkIdentityEpoch().then((r) => { readOnlyMemo = null; return r; });
    timer = setInterval(() => { void run(); }, CHECK_INTERVAL_MS);
    timer.unref?.();
    return run();
}

export function stopIdentityEpochWatch(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
