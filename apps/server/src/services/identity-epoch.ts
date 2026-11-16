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
 *   else CF_RECORD_NAME; never a name another community holds, services/registrar-name-watch.ts) and every address on
 *   its signed address list (several addresses S2, design scratch/fable-design/DESIGN-several-addresses-fable.md §6: after
 *   a take-over a beanpool.org name can lead to the promoted server while an own domain or a number still leads here) for
 *   the statement, each at once. If any of them shows a HIGHER epoch signed by its own node key, another server has
 *   taken over from it and that address now leads there: it goes read-only (members' writes refused, the reason in
 *   Settings and the log; its address list and proofs refused, services/address-list.ts, so phones on its addresses leave)
 *   and remembers it across restarts. It never refuses to boot.
 * - **What it ignores.** An address it cannot reach, an old server with no such route, and anything not signed by
 *   its own key (a forgery, logged) change nothing: no hard gate. So the manual still says: don't start the old
 *   main server again after a take-over.
 * - **Two take-overs to one epoch** (MEDIUM-2 of the 2026-10-01 replication review). Every standby holds the same locked
 *   keys, so two standbys can each take over, and both write the keys' epoch + 1. The statement's `since` (when that
 *   take-over started, signed with the rest) tells them apart. A main server that sees its OWN epoch at its address with
 *   another `since` answers 'conflict', never 'current': the earlier take-over stays the main server, and the later one
 *   goes read-only as a replaced one does, saying why, and remembers it. Both compare the same two signed times, so they
 *   agree on which is which. Before a take-over, a standby asks too (newerTakeoverAnswering): a higher epoch than its
 *   keys were locked at, signed by them, means another server took over already, and the take-over is refused.
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
import { getNodeRole, resolvePublicNodeUrl, PUBLIC_URL_RULES, type NodeConfig } from '../state-engine.js';
import { addressListContent } from '../engine/own-addresses.js';
import { logger } from '../logger.js';
import { readNodeIdentity, type NodeIdentity } from './takeover-envelope.js';

export const IDENTITY_EPOCH_PATH = '/api/node/identity-epoch';
const DOMAIN = 'beanpool-identity-epoch-v1\n';
const CHECK_INTERVAL_MS = Number(process.env.IDENTITY_EPOCH_CHECK_INTERVAL_MS) || 60 * 60_000;
const FETCH_TIMEOUT_MS = Number(process.env.IDENTITY_EPOCH_FETCH_TIMEOUT_MS) || 10_000;
/**
 * A tunnel run from two machines at once is load-balanced between them, so one answer may be our own. Six asks miss the
 * other machine one time in 64 when the two share it evenly (three missed it one time in 8), and a check stops at the
 * first proof.
 */
const ASKS_PER_CHECK = 6;

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

// ── The epoch on the phone's sync reads ───────────────────────────────────────────────────
//
// A promoted standby never had what the old main server wrote after its last copy (up to a minute at the default
// pull). A phone syncs by cursor, so a listing made in that tail would stay on its Market for good: no tombstone will
// ever come. The reads a phone syncs by carry the epoch, and a phone that sees it change drops its cursors and
// replaces its cache with a full sync (apps/native services/pillar-sync.ts). Not in the CORS exposed headers: the
// web app is served from the node's own origin, and the phone is not a browser.

export const EPOCH_HEADER = 'X-BeanPool-Epoch';

let epochHeaderMemo: string | null = null;

/** The epoch as the sync reads send it. Read from local-config.json once; the take-over's "role" step forgets it. */
export function syncEpochHeaderValue(): string {
    return epochHeaderMemo ??= String(ownIdentityEpoch().epoch);
}

export function forgetSyncEpochHeaderValue(): void {
    epochHeaderMemo = null;
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

/** The community id in genesis.json, or null when there is none to read. */
export function ownCommunityId(): string | null {
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
        // Strict RFC 8032, as every other verifier here: noble's default (ZIP-215) takes non-canonical encodings.
        valid = ed25519.verify(Buffer.from(b.sig, 'base64'), canonical(statement), ed25519.getPublicKey(identity.seed), { zip215: false });
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

/**
 * Is this a statement signed by the node key `peerId` names, naming that key (services/standby-main.ts: a pairing code's
 * address answering as the code's key)? Anything else is false.
 */
export function epochStatementSignedBy(body: unknown, peerId: string, publicKey: Uint8Array): boolean {
    const b = body as Partial<SignedEpoch> | null;
    const s = b?.statement as Partial<EpochStatement> | undefined;
    if (!b || typeof b.sig !== 'string' || !s || s.v !== 1 || s.peerId !== peerId || !Number.isSafeInteger(s.epoch)) return false;
    try {
        return ed25519.verify(Buffer.from(b.sig, 'base64'), canonical(s as EpochStatement), publicKey, { zip215: false });
    } catch {
        return false;
    }
}

// ── The check ─────────────────────────────────────────────────────────────────────────────

/**
 * Where this server's own public address serves the statement, or null when it has none: the registrar's hostname, else
 * CF_RECORD_NAME as set. A name another community holds (services/registrar-name-watch.ts) leads to that community:
 * never asked (state-engine.ts PUBLIC_URL_RULES.identityEpoch).
 */
export function ownPublicEpochUrl(): string | null {
    // Tests only: the address the suite's "public hostname" answers at. Unset in every real deployment.
    const test = process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL;
    if (test) return test;
    const origin = resolvePublicNodeUrl(PUBLIC_URL_RULES.identityEpoch);
    return origin ? `${origin}${IDENTITY_EPOCH_PATH}` : null;
}

/** Tests only: where each listed address answers (address → origin), so an in-process suite never asks a real host. */
let addressOriginsForTests: ReadonlyMap<string, string> | null = null;
export function askAddressesAtForTests(origins: Record<string, string> | null): void {
    addressOriginsForTests = origins ? new Map(Object.entries(origins)) : null;
}

/**
 * Every URL the check asks for the statement, each once: this server's own public address as before (ownPublicEpochUrl),
 * then every address on its signed list (engine/own-addresses.ts addressListContent: published, with a route, a port kept).
 * A suite's stand-in (BEANPOOL_TEST_IDENTITY_EPOCH_URL) is asked alone: a suite's nodes have real-looking names, never asked.
 */
export function ownEpochUrls(): string[] {
    const test = process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL;
    if (test) return [test];
    const urls: string[] = [];
    const add = (url: string | null) => { if (url && !urls.includes(url)) urls.push(url); };
    const origins = addressOriginsForTests;
    if (!origins) add(ownPublicEpochUrl());
    for (const address of addressListContent()?.addresses ?? []) {
        if (!origins) add(`https://${address}${IDENTITY_EPOCH_PATH}`);
        else if (origins.has(address)) add(`${origins.get(address)}${IDENTITY_EPOCH_PATH}`);
    }
    return urls;
}

export type EpochCheck =
    | { state: 'not-primary' }
    | { state: 'no-identity' }
    | { state: 'no-address' }
    | { state: 'unreachable'; url: string; why: string }
    | { state: 'no-epoch-route'; url: string }
    | { state: 'forged'; url: string; why: string }
    | { state: 'current'; url: string; seen: number; own: number }
    | { state: 'replaced'; url: string; seen: number; own: number; since: string | null }
    /** Another take-over to this server's own epoch. `readOnly`: it came first, so this server refuses members' writes. */
    | { state: 'conflict'; url: string; epoch: number; ownSince: string | null; otherSince: string | null; readOnly: boolean };

async function askOnce(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ status: number; body: unknown } | { error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        const text = await res.text();
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { body = null; }
        return { status: res.status, body };
    } catch (e: any) {
        return { error: e?.name === 'AbortError' ? `no answer in ${timeoutMs / 1000}s` : (e?.cause?.code || e?.message || String(e)) };
    } finally {
        clearTimeout(timer);
    }
}

// ── Before a take-over ────────────────────────────────────────────────────────────────────

/** A server holding a take-over's keys that answers a newer take-over than they were locked at. */
export interface NewerTakeover {
    url: string;
    /** In words, for the refusal: "the community's web address (https://…)" or "the main server's address (https://…)". */
    where: string;
    statement: EpochStatement;
    sealedEpoch: number;
}

/** Tests only: a suite's main servers have real-looking hostnames, which a take-over must never ask. */
let askCommunityAddress = true;
export function neverAskCommunityAddressForTests(): void {
    askCommunityAddress = false;
}

/**
 * Before a take-over (services/takeover.ts, at the preview and again at the confirm): ask the community's web address from
 * the keys (PUBLIC_URL_RULES.takeoverCheck; a suite's stand-in in BEANPOOL_TEST_IDENTITY_EPOCH_URL) and the main server's
 * URL this standby copies from, at once, for the identity-epoch statement. The first signed by the keys' own node key with
 * a higher epoch than they were locked at: another server took over with them already (another standby). Null when none
 * does, or none answers in `timeoutMs`: no hard gate, since the main server is most likely gone and its address with it.
 * A server answering the keys' own epoch is the main server itself, which the preview warns about already. Never throws.
 */
export async function newerTakeoverAnswering(opts: {
    identity: NodeIdentity; sealedEpoch: number; publicAddress: unknown; registrarNames: unknown; mainServerUrl: string | null; timeoutMs: number;
}): Promise<NewerTakeover | null> {
    try {
        const asks: { url: string; where: string }[] = [];
        const test = process.env.BEANPOOL_TEST_IDENTITY_EPOCH_URL;
        if (test) {
            asks.push({ url: test, where: `the community's web address (${test})` });
        } else if (askCommunityAddress) {
            const config = { publicAddress: opts.publicAddress, registrarNames: opts.registrarNames } as unknown as NodeConfig;
            const origin = resolvePublicNodeUrl(PUBLIC_URL_RULES.takeoverCheck, config);
            if (origin) asks.push({ url: `${origin}${IDENTITY_EPOCH_PATH}`, where: `the community's web address (${origin})` });
        }
        if (opts.mainServerUrl) {
            const base = opts.mainServerUrl.replace(/\/+$/, '');
            const url = `${base}${IDENTITY_EPOCH_PATH}`;
            if (!asks.some((a) => a.url === url)) asks.push({ url, where: `the main server's address (${base})` });
        }
        // A few asks each: an address shared by two servers (one tunnel run from both) answers either.
        const ask = async (a: { url: string; where: string }): Promise<NewerTakeover | null> => {
            for (let i = 0; i < 3; i++) {
                const got = await askOnce(a.url, opts.timeoutMs);
                if ('error' in got || got.status !== 200) return null;
                const verdict = verifyEpochStatement(got.body, opts.identity);
                if (verdict.ok && verdict.statement.epoch > opts.sealedEpoch) {
                    return { url: a.url, where: a.where, statement: verdict.statement, sealedEpoch: opts.sealedEpoch };
                }
            }
            return null;
        };
        const found = await Promise.all(asks.map(ask));
        return found.find((f) => f !== null) ?? null;
    } catch (e: any) {
        logger.warn('SYS', `[Split-brain] Could not ask whether another server took over already: ${e?.message || e}`);
        return null;
    }
}

let lastLogged = '';
function logOnce(key: string, log: () => void): void {
    if (key === lastLogged) return;
    lastLogged = key;
    log();
}

/** What the asks at one address found. */
interface AddressSeen {
    url: string;
    best: EpochStatement | null;
    /** The same epoch from another take-over (another `since`): only a take-over has an epoch above 0. */
    rival: EpochStatement | null;
    forged: string | null;
    unreachable: string | null;
    noRoute: boolean;
}

/** Up to ASKS_PER_CHECK asks at one address, stopping at the first proof (a higher epoch, or a rival take-over). */
async function askAddress(url: string, identity: NodeIdentity, own: { epoch: number; since: string | null }): Promise<AddressSeen> {
    const seen: AddressSeen = { url, best: null, rival: null, forged: null, unreachable: null, noRoute: false };
    for (let i = 0; i < ASKS_PER_CHECK; i++) {
        const got = await askOnce(url);
        if ('error' in got) { seen.unreachable = got.error; break; }
        if (got.status === 404) { seen.noRoute = true; continue; }
        if (got.status !== 200) { seen.unreachable = `HTTP ${got.status}`; continue; }
        const verdict = verifyEpochStatement(got.body, identity);
        if (!verdict.ok) {
            seen.forged = verdict.why;
            continue;
        }
        if (!seen.best || verdict.statement.epoch > seen.best.epoch) seen.best = verdict.statement;
        if (seen.best.epoch > own.epoch) break; // proof enough
        if (own.epoch > 0 && verdict.statement.epoch === own.epoch && verdict.statement.since !== own.since) {
            seen.rival = verdict.statement;
            break; // proof enough
        }
    }
    return seen;
}

/**
 * Ask this server's own public address and every address on its list for the epoch (ownEpochUrls), all at once, and act on
 * the answers: a higher epoch at any one of them replaces this server. Never throws. Only a main server checks: a standby
 * has its own key and is not the one a take-over replaces.
 */
export async function checkIdentityEpoch(): Promise<EpochCheck> {
    try {
        if (getNodeRole() !== 'primary') return { state: 'not-primary' };
        const identity = readNodeIdentity();
        if (!identity) return { state: 'no-identity' };
        const urls = ownEpochUrls();
        if (!urls.length) return { state: 'no-address' };
        const ownNow = ownIdentityEpoch();
        const own = ownNow.epoch;
        const seen = await Promise.all(urls.map((u) => askAddress(u, identity, ownNow)));

        // The highest epoch above this server's own, wherever it answered.
        const higher = seen.filter((a) => a.best && a.best.epoch > own).sort((a, b) => b.best!.epoch - a.best!.epoch)[0];
        if (higher) {
            markReplaced(identity.peerId, higher.best!, own, higher.url);
            return { state: 'replaced', url: higher.url, seen: higher.best!.epoch, own, since: higher.best!.since };
        }
        const rivalAt = seen.find((a) => a.rival);
        if (rivalAt) {
            const url = rivalAt.url;
            const other = rivalAt.rival!;
            const first = firstTakeover(ownNow.since, other.since) < 0;
            if (first) {
                logOnce(`conflict-first|${url}|${own}|${other.since}`, () => logger.security('SYS', `[Split-brain] ⚠️ ${url} answers identity epoch ${own} `
                    + `from another take-over (${when(other.since)}), signed with this server's own node key: two servers took over with the same keys. `
                    + `This one took over first (${when(ownNow.since)}) and stays the main server; the other goes read-only once it sees this one. `
                    + 'Stop the other server, and set it up again as a standby of this one.'));
            } else {
                markConflict(identity.peerId, other, ownNow, url);
            }
            return { state: 'conflict', url, epoch: own, ownSince: ownNow.since, otherSince: other.since, readOnly: !first };
        }
        for (const a of seen) {
            if (a.forged) logger.security('SYS', `[Split-brain] Ignored ${a.forged} at ${a.url}. This server carries on as the main server.`);
        }
        const answered = seen.filter((a) => a.best);
        if (answered.length) {
            // A take-over this server lost, seen before: still read-only, so never "current" (the address answered this server).
            const lost = getReplacedInfo();
            const url = answered[0].url;
            if (lost?.conflict) return { state: 'conflict', url, epoch: lost.epoch, ownSince: lost.ownSince, otherSince: lost.since, readOnly: true };
            const best = Math.max(...answered.map((a) => a.best!.epoch));
            const where = answered.map((a) => a.url).join(', ');
            logOnce(`current|${where}|${best}`, () => logger.info('SYS', `[Split-brain] ${where} answer${answered.length === 1 ? 's' : ''} identity epoch ${best}; this server is at ${own}. No other server has taken over.`));
            return { state: 'current', url, seen: best, own };
        }
        const forgedAt = seen.find((a) => a.forged);
        if (forgedAt) return { state: 'forged', url: forgedAt.url, why: forgedAt.forged! };
        const noRouteAt = seen.find((a) => a.noRoute && !a.unreachable);
        if (noRouteAt) {
            logOnce(`no-route|${noRouteAt.url}`, () => logger.info('SYS', `[Split-brain] ${noRouteAt.url} has no identity-epoch route (an older BeanPool, or another site). Carrying on.`));
            return { state: 'no-epoch-route', url: noRouteAt.url };
        }
        const why = seen[0].unreachable || 'no answer';
        const where = seen.map((a) => a.url).join(', ');
        logOnce(`unreachable|${where}`, () => logger.info('SYS', `[Split-brain] Could not ask ${where} for the identity epoch (${why}). Carrying on as the main server; checking again in an hour.`));
        return { state: 'unreachable', url: seen[0].url, why };
    } catch (e: any) {
        logger.warn('SYS', `[Split-brain] Identity epoch check failed: ${e?.message || e}`);
        return { state: 'unreachable', url: '', why: e?.message || String(e) };
    }
}

function markReplaced(peerId: string, seen: EpochStatement, own: number, url: string): void {
    const prev = getLocalConfig().identityReplaced;
    if (prev && prev.peerId === peerId && prev.epoch >= seen.epoch && !prev.conflict) return;
    const record = { peerId, epoch: seen.epoch, ownEpoch: own, since: seen.since, detectedAt: new Date().toISOString(), url };
    updateLocalConfig({ identityReplaced: record });
    readOnlyMemo = null;
    logger.security('SYS', `[Split-brain] 🛑 ${replacedMessage(record)} ${url} answers identity epoch ${seen.epoch}, signed with this server's own node key; this server is at ${own}. Members' writes are refused from now on. Don't run this server as the main server again.`);
}

/**
 * Of two take-overs to one epoch, which came first: negative when `a` did. The earlier `since` (each signed in its
 * server's statement), so both servers decide the same; a time that does not read as one sorts last. 0 only when the two
 * cannot be told apart, which is no conflict at all.
 */
export function firstTakeover(a: string | null, b: string | null): number {
    const ta = a ? Date.parse(a) : NaN;
    const tb = b ? Date.parse(b) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1;
    if (a === b) return 0;
    return (a ?? '') < (b ?? '') ? -1 : 1;
}

/** "2026-10-02 09:14:05 UTC" (two take-overs can be a minute apart), or "an unknown time". */
function when(since: string | null): string {
    return since && Number.isFinite(Date.parse(since)) ? `${since.slice(0, 19).replace('T', ' ')} UTC` : 'an unknown time';
}

/** This server took over second, with the same keys as the server at its address: read-only from now on, remembered. */
function markConflict(peerId: string, other: EpochStatement, own: { epoch: number; since: string | null }, url: string): void {
    const prev = getLocalConfig().identityReplaced;
    if (prev && prev.peerId === peerId && (prev.conflict
        ? prev.epoch === other.epoch && prev.since === other.since && prev.conflict.ownSince === own.since
        : prev.epoch > own.epoch)) return; // recorded already, or a newer take-over replaced this server anyway
    const record = {
        peerId, epoch: other.epoch, ownEpoch: own.epoch, since: other.since, detectedAt: new Date().toISOString(), url,
        conflict: { ownSince: own.since },
    };
    updateLocalConfig({ identityReplaced: record });
    readOnlyMemo = null;
    logger.security('SYS', `[Split-brain] 🛑 ${replacedMessage(record)} ${url} answers identity epoch ${other.epoch} from that take-over, signed with `
        + `this server's own node key. Members' writes are refused here from now on: they go to the other server. Stop this server, and set it `
        + 'up again as a standby of the other one.');
}

// ── Read-only ─────────────────────────────────────────────────────────────────────────────

export interface ReplacedInfo {
    epoch: number;
    ownEpoch: number;
    /** When the other server took over. */
    since: string | null;
    detectedAt: string;
    url: string;
    message: string;
    /** Another take-over to this server's own epoch, made first (two standbys, one set of keys). */
    conflict: boolean;
    /** When this server took over: set for a conflict. */
    ownSince: string | null;
}

function replacedMessage(r: { since: string | null; detectedAt: string; conflict?: { ownSince: string | null } | null }): string {
    if (r.conflict) {
        return `Another server took over this community with the same keys on ${when(r.since)}, before this server did (${when(r.conflict.ownSince)}). `
            + 'This server is now read-only.';
    }
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
    const own = ownIdentityEpoch();
    if (r.conflict) {
        // About this server's own take-over only: one it made since (a higher epoch, or another `since`) is not the one that lost.
        if (own.epoch !== r.epoch || own.since !== r.conflict.ownSince) return null;
    } else if (own.epoch >= r.epoch) {
        return null;
    }
    return {
        epoch: r.epoch, ownEpoch: r.ownEpoch, since: r.since, detectedAt: r.detectedAt, url: r.url, message: replacedMessage(r),
        conflict: !!r.conflict, ownSince: r.conflict?.ownSince ?? null,
    };
}

let readOnlyMemo: { at: number; info: ReplacedInfo | null } | null = null;
/** getReplacedInfo, read at most every 5 s: the members' writes and the address list's reads ask it on every request. */
export function replacedNow(): ReplacedInfo | null {
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
                    error: `${info.message} ${info.conflict ? "Members' changes go to the other server; use that one." : 'Another server took over this community; use that one.'}`,
                    readOnly: true, replacedSince: info.since, detectedAt: info.detectedAt, ...(info.conflict ? { conflict: true } : {}),
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
