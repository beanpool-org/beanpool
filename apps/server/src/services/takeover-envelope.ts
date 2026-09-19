/**
 * The take-over envelope: this node's keys and admin credentials, sealed to its owners and its printed recovery
 * code, so that any ONE of them can bring the community up on a standby or a fresh server and nobody else can.
 *
 * Design authority: scratch/overnight/design/sealed-keys.md (Fable, 2026-09-19) — §2.1 what the bundle holds,
 * §3 who holds what, §4 when it is re-sealed, §9 a node with nobody to seal to. This is slice 2a: the main
 * server makes and keeps the envelope; the Settings card, the standby's copy and the take-over itself come later.
 * The only crypto here is packages/beanpool-core/src/sealed-envelope.ts (slice 1).
 *
 * ## One function re-seals, many things ask it to
 *
 * `ensureTakeoverEnvelope()` builds the bundle from what is on disk and in the database NOW, and compares an HMAC
 * of it (plus the recipient set) with the one kept beside the envelope. Same → nothing happens. Different → a new
 * data key, a new envelopeId, every current recipient, written atomically to data/takeover-envelope.json.
 *
 * It is asked by: every chokepoint through services/takeover-signal.ts (role grant/revoke, a status change,
 * prune, purge, suspension and its reversal, a local-config save, a connector save, the public address), which
 * schedules a debounced check; the recovery-code route, which waits for it; boot; and a periodic consistency
 * check. The periodic check is what catches a `DELETE FROM node_roles` that no chokepoint saw — three sites in
 * state-engine.ts do exactly that, and a future PR will add a fourth — so nothing depends on every writer
 * remembering to call.
 *
 * ## What never happens
 *
 * - An owner's key is taken from a request. Recipients come from node_roles (owners whose member row is active).
 * - The recovery code is stored or logged. Only its public record (codeId, codePub, salt, scrypt cost) is kept;
 *   the code itself exists in memory for the one response that shows it.
 * - A plaintext field leaves through the envelope route. It serves the sealed bytes and nothing else.
 * - A stale envelope is served. With nobody to seal to (no owner, no code) the file is removed and the status
 *   says why, rather than keep offering keys locked to people who are no longer owners.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
    sealEnvelope, readSealedHeader, createRecoveryCode, checkRecoveryCode, parseRecoveryCode,
    type RecoveryCodeRecord, type SealedEnvelopeHeader,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { logger } from '../logger.js';
import { setTakeoverChangeHandler } from './takeover-signal.js';

export const TAKEOVER_ENVELOPE_FILE = 'takeover-envelope.json';
/** Chokepoints fire in bursts (a prune touches roles, status and config); one re-seal covers the burst. */
const DEBOUNCE_MS = Number(process.env.TAKEOVER_RESEAL_DEBOUNCE_MS) || 2_000;
/** The net under every chokepoint, including the ones nobody wired. Reads a handful of small files. */
const CHECK_INTERVAL_MS = Number(process.env.TAKEOVER_CHECK_INTERVAL_MS) || 30_000;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}
function envelopePath(): string {
    return path.join(dataDir(), TAKEOVER_ENVELOPE_FILE);
}

// ── What is sealed (§2.1) ──────────────────────────────────────────────────────────────────

/** The admin/2FA fields a promoted node needs so the community's owners sign in with the community's credentials. */
const BUNDLED_LOCAL_CONFIG_FIELDS = [
    'adminHash', 'salt', 'totpEnabled', 'totpSecret', 'totpBackupCodesHashes', 'breakGlassMode',
] as const;

/**
 * Identity files, raw bytes as base64 so a take-over writes back exactly what was read.
 * Never in the bundle: the replication token hash, a standby's `backupReplicationToken`, the legacy plain-text
 * `backupAdminPassword` (§2.1).
 */
const BUNDLED_FILES = ['libp2p_key', 'community.key', 'genesis.json', 'connectors.json'] as const;

export interface TakeoverBundle {
    v: 1;
    files: Record<(typeof BUNDLED_FILES)[number], string | null>;
    localConfig: Record<(typeof BUNDLED_LOCAL_CONFIG_FIELDS)[number], unknown>;
    /** The raw table: a standby does not replicate roles (backups-and-replicas.md), so without these a promoted
     *  node has no owners and key sign-in fails. */
    nodeRoles: {
        member_pubkey: string; role: string; granted_at: string | null; granted_by: string | null;
        session_epoch: number; break_glass_hash: string | null;
    }[];
    /** node_config.publicAddress, including the tunnel token, so the tunnel comes back up on the new host. */
    publicAddress: unknown;
    /** The public record of the current code, so the new main server can keep sealing to it. */
    recoveryCode: RecoveryCodeRecord | null;
}

interface NodeIdentity {
    seed: Uint8Array;
    peerId: string;
}

function readFileOrNull(name: string): Buffer | null {
    try {
        return fs.readFileSync(path.join(dataDir(), name));
    } catch (e: any) {
        if (e?.code === 'ENOENT') return null;
        throw e;
    }
}

/** The node's Ed25519 identity, from the file libp2p itself loads (p2p.ts), so it works before libp2p starts. */
function loadNodeIdentity(keyBytes: Buffer): NodeIdentity {
    const priv = privateKeyFromProtobuf(keyBytes);
    if (priv.type !== 'Ed25519') throw new Error(`data/libp2p_key is a ${priv.type} key, not Ed25519`);
    // libp2p's Ed25519 raw private key is seed ‖ public key (64 bytes).
    const seed = new Uint8Array(priv.raw.subarray(0, 32));
    const pub = ed25519.getPublicKey(seed);
    if (Buffer.compare(Buffer.from(pub), Buffer.from(priv.publicKey.raw)) !== 0) {
        throw new Error('data/libp2p_key does not hold a consistent Ed25519 key pair');
    }
    return { seed, peerId: peerIdFromPrivateKey(priv).toString() };
}

function readPublicAddress(): unknown {
    const row = db.prepare("SELECT value FROM node_config WHERE key = 'node_config'").get() as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
        return JSON.parse(row.value)?.publicAddress ?? null;
    } catch {
        return null;
    }
}

function buildBundle(files: TakeoverBundle['files']): TakeoverBundle {
    const config = getLocalConfig() as any;
    const localConfig = {} as TakeoverBundle['localConfig'];
    for (const f of BUNDLED_LOCAL_CONFIG_FIELDS) localConfig[f] = config[f] ?? null;
    const nodeRoles = db.prepare(
        `SELECT member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash
         FROM node_roles ORDER BY member_pubkey`,
    ).all() as TakeoverBundle['nodeRoles'];
    return {
        v: 1,
        files,
        localConfig,
        nodeRoles,
        publicAddress: readPublicAddress(),
        recoveryCode: config.recoveryCode ?? null,
    };
}

// ── Who it is sealed to (§2.3, §4) ─────────────────────────────────────────────────────────

export interface OwnerRecipient { pubkey: string; callsign: string }
export interface SkippedOwner extends OwnerRecipient { why: string }

/** An owner key that converts to a usable X25519 point. A malformed or small-order key would make sealEnvelope
 *  throw for everyone, so it is left out and named in the status instead. */
function ownerKeyProblem(pubkey: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return 'the key is not 32 bytes of hex';
    try {
        const x = ed25519.utils.toMontgomery(Buffer.from(pubkey, 'hex'));
        x25519.getSharedSecret(x25519.utils.randomSecretKey(), x);
        return null;
    } catch {
        return 'the key is not a usable Ed25519 public key';
    }
}

function currentOwners(): { owners: OwnerRecipient[]; skipped: SkippedOwner[] } {
    const rows = db.prepare(
        `SELECT nr.member_pubkey AS pubkey, m.callsign AS callsign
         FROM node_roles nr JOIN members m ON nr.member_pubkey = m.public_key
         WHERE nr.role = 'owner' AND m.status = 'active'
         ORDER BY nr.member_pubkey`,
    ).all() as { pubkey: string; callsign: string | null }[];
    const owners: OwnerRecipient[] = [];
    const skipped: SkippedOwner[] = [];
    for (const r of rows) {
        const pubkey = String(r.pubkey).toLowerCase();
        const callsign = (r.callsign && r.callsign.trim()) || pubkey.slice(0, 8);
        const problem = ownerKeyProblem(pubkey);
        if (problem) skipped.push({ pubkey, callsign, why: problem });
        else owners.push({ pubkey, callsign });
    }
    return { owners, skipped };
}

// ── The fingerprint kept beside the envelope ───────────────────────────────────────────────

/** JSON with sorted keys. Not core's canonicalJson: that admits only integers, and the public-address record
 *  and connectors carry whatever the operator typed. */
function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
        .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

/** Keyed by the node's own seed: the file sits next to plaintext keys anyway, but a bare hash of a bundle whose
 *  only secret parts were low-entropy would be a guessing oracle. */
function fingerprintOf(seed: Uint8Array, owners: OwnerRecipient[], code: RecoveryCodeRecord | null, bundle: TakeoverBundle): string {
    return createHmac('sha256', Buffer.from(seed))
        .update('beanpool-takeover-fingerprint-v1\n')
        .update(stableJson({ owners, code, bundle }))
        .digest('hex');
}

// ── The file on disk ───────────────────────────────────────────────────────────────────────

interface StoredEnvelope {
    v: 1;
    envelopeId: string;
    fingerprint: string;
    sealedAt: string;
    reason: string;
    /** The sealed bytes (u32 header length ‖ header ‖ chunks), base64. */
    envelope: string;
}

function readStored(): StoredEnvelope | null {
    let raw: Buffer | null;
    try {
        raw = readFileOrNull(TAKEOVER_ENVELOPE_FILE);
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const s = JSON.parse(raw.toString('utf-8')) as StoredEnvelope;
        if (s?.v !== 1 || typeof s.envelope !== 'string' || typeof s.envelopeId !== 'string') return null;
        // The header must read, and name the same envelope, or the file is treated as absent and re-made.
        const header = readSealedHeader(new Uint8Array(Buffer.from(s.envelope, 'base64')));
        if (header.envelopeId !== s.envelopeId || header.kind !== 'takeover') return null;
        return s;
    } catch {
        return null;
    }
}

function writeStored(s: StoredEnvelope): void {
    const target = envelopePath();
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, target);
}

function removeStored(): boolean {
    try {
        fs.unlinkSync(envelopePath());
        return true;
    } catch {
        return false;
    }
}

// ── Status ─────────────────────────────────────────────────────────────────────────────────

export type TakeoverState = 'sealed' | 'no-recipients' | 'no-identity' | 'no-genesis' | 'standby' | 'error';

export interface TakeoverStatus {
    state: TakeoverState;
    /** One sentence an operator can read. Never a secret. */
    message: string;
    envelopeId: string | null;
    sealedAt: string | null;
    /** Why the current envelope was made (the chokepoint, a code rotation, boot, the consistency check). */
    sealReason: string | null;
    recipients: {
        owners: OwnerRecipient[];
        codes: { codeId: number; createdAt: string }[];
    };
    /** Owners the envelope could not be sealed to, and why. */
    skippedOwners: SkippedOwner[];
    recoveryCode: { codeId: number; createdAt: string } | null;
}

function recipientsOf(header: SealedEnvelopeHeader): TakeoverStatus['recipients'] {
    const owners: OwnerRecipient[] = [];
    const codes: { codeId: number; createdAt: string }[] = [];
    for (const r of header.recipients) {
        if (r.type === 'owner') owners.push({ pubkey: r.pubkey, callsign: r.callsign });
        else codes.push({ codeId: r.codeId, createdAt: r.createdAt });
    }
    return { owners, codes };
}

function codeSummary(code: RecoveryCodeRecord | null | undefined): TakeoverStatus['recoveryCode'] {
    return code ? { codeId: code.codeId, createdAt: code.createdAt } : null;
}

function statusWithout(state: TakeoverState, message: string, skipped: SkippedOwner[] = []): TakeoverStatus {
    return {
        state, message, envelopeId: null, sealedAt: null, sealReason: null,
        recipients: { owners: [], codes: [] }, skippedOwners: skipped,
        recoveryCode: codeSummary((getLocalConfig() as any).recoveryCode),
    };
}

function sealedStatus(s: StoredEnvelope, skipped: SkippedOwner[]): TakeoverStatus {
    const header = readSealedHeader(new Uint8Array(Buffer.from(s.envelope, 'base64')));
    const recipients = recipientsOf(header);
    const n = recipients.owners.length;
    const parts = [
        n ? `${n} owner${n === 1 ? '' : 's'}` : null,
        recipients.codes.length ? `recovery code #${recipients.codes.map((c) => c.codeId).join(', #')}` : null,
    ].filter(Boolean);
    return {
        state: 'sealed',
        message: `This server's take-over keys are locked to ${parts.join(' and ')}; any one of them can open them.`,
        envelopeId: s.envelopeId,
        sealedAt: s.sealedAt,
        sealReason: s.reason,
        recipients,
        skippedOwners: skipped,
        recoveryCode: codeSummary((getLocalConfig() as any).recoveryCode),
    };
}

// ── Re-seal ────────────────────────────────────────────────────────────────────────────────

let standby = false;
let queue: Promise<unknown> = Promise.resolve();
const pendingReasons = new Set<string>();
let debounceTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let lastStatus: TakeoverStatus | null = null;

/** Run `fn` after every earlier check and code change, one at a time. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
}

async function doEnsure(reason: string): Promise<TakeoverStatus> {
    if (standby) {
        return statusWithout('standby', 'This is a standby: it holds no take-over keys of its own.');
    }
    const keyBytes = readFileOrNull('libp2p_key');
    if (!keyBytes) {
        if (removeStored()) logger.warn('SYS', '[Takeover] Removed the take-over envelope: data/libp2p_key is missing, so it no longer matches this node');
        return statusWithout('no-identity', 'No take-over keys to lock yet: this server has not created its node key (data/libp2p_key).');
    }
    const genesisBytes = readFileOrNull('genesis.json');
    let communityId: string | null = null;
    try {
        communityId = genesisBytes ? JSON.parse(genesisBytes.toString('utf-8'))?.communityId ?? null : null;
    } catch { communityId = null; }
    if (!communityId || typeof communityId !== 'string') {
        if (removeStored()) logger.warn('SYS', '[Takeover] Removed the take-over envelope: genesis.json is missing or unreadable');
        return statusWithout('no-genesis', 'No take-over keys to lock yet: this server has no readable genesis.json.');
    }
    const identity = loadNodeIdentity(keyBytes);

    const { owners, skipped } = currentOwners();
    const code: RecoveryCodeRecord | null = (getLocalConfig() as any).recoveryCode ?? null;
    if (owners.length === 0 && !code) {
        if (removeStored()) {
            logger.warn('SYS', '[Takeover] Removed the take-over envelope: this server now has no owner and no recovery code to lock it to');
        }
        const why = skipped.length
            ? `this server's owner${skipped.length === 1 ? "'s key is" : "s' keys are"} not usable and there is no recovery code`
            : 'this server has no owner and no recovery code';
        return statusWithout('no-recipients', `No take-over envelope: ${why}, so there is nobody to lock its keys to. Make someone an owner, or make a recovery code.`, skipped);
    }

    const files = {} as TakeoverBundle['files'];
    for (const f of BUNDLED_FILES) {
        const b = f === 'libp2p_key' ? keyBytes : f === 'genesis.json' ? genesisBytes : readFileOrNull(f);
        files[f] = b ? b.toString('base64') : null;
    }
    const bundle = buildBundle(files);
    const fingerprint = fingerprintOf(identity.seed, owners, code, bundle);

    const stored = readStored();
    if (stored && stored.fingerprint === fingerprint) return sealedStatus(stored, skipped);

    const sealedAt = new Date().toISOString();
    const bytes = await sealEnvelope(new TextEncoder().encode(JSON.stringify(bundle)), {
        kind: 'takeover',
        communityId,
        nodePeerId: identity.peerId,
        recipients: { owners, codes: code ? [code] : [] },
        signingKey: identity.seed,
        createdAt: sealedAt,
    });
    const header = readSealedHeader(bytes);
    const next: StoredEnvelope = {
        v: 1, envelopeId: header.envelopeId, fingerprint, sealedAt, reason, envelope: Buffer.from(bytes).toString('base64'),
    };
    writeStored(next);
    const who = [
        owners.length ? owners.map((o) => '@' + o.callsign).join(', ') : null,
        code ? `recovery code #${code.codeId}` : null,
    ].filter(Boolean).join(' + ');
    logger.info('SYS', `[Takeover] Sealed take-over envelope ${header.envelopeId.slice(0, 8)} to ${who} (${reason})`);
    return sealedStatus(next, skipped);
}

/**
 * Make sure the envelope on disk matches the node right now; re-seal if not. Serialised, so concurrent callers
 * never race two envelopes onto disk. Never throws: a failure is logged and reported in the status.
 */
export function ensureTakeoverEnvelope(reason: string): Promise<TakeoverStatus> {
    return serial(async () => {
        const reasons = [...pendingReasons];
        pendingReasons.clear();
        const why = reasons.length ? [reason, ...reasons.filter((r) => r !== reason)].join('; ') : reason;
        try {
            lastStatus = await doEnsure(why);
        } catch (e: any) {
            logger.error('SYS', `[Takeover] Could not seal the take-over envelope (${why}): ${e?.message || e}`);
            const stored = readStored();
            lastStatus = {
                ...(stored ? sealedStatus(stored, []) : statusWithout('error', '')),
                state: 'error',
                message: `The take-over keys could not be re-locked: ${e?.message || 'unknown error'}.`
                    + (stored ? ' The envelope on disk is from before the last change, so it is not being handed out.' : ''),
            };
        }
        return lastStatus;
    });
}

/** A chokepoint noticed a change: check once the burst is over. */
export function scheduleTakeoverCheck(reason: string): void {
    pendingReasons.add(reason);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void ensureTakeoverEnvelope('change noticed');
    }, DEBOUNCE_MS);
    debounceTimer.unref?.();
}

/** Run any pending debounced check now and wait for it. For routes that must answer with the current envelope. */
export function flushTakeoverChecks(): Promise<TakeoverStatus> {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    return ensureTakeoverEnvelope(pendingReasons.size ? 'change noticed' : 'consistency check');
}

/**
 * Boot: register the chokepoint handler, check once, then keep checking. `opts.standby` for a node running as a
 * standby, which seals nothing of its own (§3).
 */
export async function startTakeoverEnvelopeService(
    opts: { standby?: boolean; checkIntervalMs?: number } = {},
): Promise<TakeoverStatus> {
    standby = !!opts.standby;
    setTakeoverChangeHandler(scheduleTakeoverCheck);
    if (intervalTimer) clearInterval(intervalTimer);
    intervalTimer = setInterval(() => { void ensureTakeoverEnvelope('consistency check'); }, opts.checkIntervalMs ?? CHECK_INTERVAL_MS);
    intervalTimer.unref?.();
    return ensureTakeoverEnvelope('boot');
}

export function stopTakeoverEnvelopeService(): void {
    setTakeoverChangeHandler(null);
    if (intervalTimer) clearInterval(intervalTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    intervalTimer = debounceTimer = null;
}

export function getTakeoverStatus(): Promise<TakeoverStatus> {
    return flushTakeoverChecks();
}

/** The sealed bytes for the envelope route, or null with the reason. Never anything else from disk. */
export async function getSealedTakeoverEnvelope(): Promise<{ envelopeId: string; bytes: Buffer; header: SealedEnvelopeHeader } | { envelopeId: null; status: TakeoverStatus }> {
    const status = await flushTakeoverChecks();
    // Only a current envelope is served. After a failed re-seal the file on disk may still be locked to someone
    // who is no longer an owner, so it is not handed out until a re-seal succeeds.
    const stored = status.state === 'sealed' ? readStored() : null;
    if (!stored) return { envelopeId: null, status };
    const bytes = Buffer.from(stored.envelope, 'base64');
    return { envelopeId: stored.envelopeId, bytes, header: readSealedHeader(new Uint8Array(bytes)) };
}

// ── The recovery code (§2.6) ───────────────────────────────────────────────────────────────

export class RecoveryCodeExistsError extends Error {
    constructor(public readonly codeId: number) {
        super(`Recovery code #${codeId} already exists. Making a new one replaces it: the old paper stops opening anything locked from now on.`);
    }
}

/**
 * Make (or, with `replace`, rotate) the recovery code. The code is in the return value and nowhere else: only
 * its public record is saved, then the envelope is re-sealed to it before this resolves.
 */
export function makeRecoveryCode(opts: { replace?: boolean } = {}): Promise<{
    code: string; codeId: number; createdAt: string; replacedCodeId: number | null; status: TakeoverStatus;
}> {
    return serial(async () => {
        const config = getLocalConfig() as any;
        const current: RecoveryCodeRecord | null = config.recoveryCode ?? null;
        if (current && !opts.replace) throw new RecoveryCodeExistsError(current.codeId);
        const codeId = Math.max(Number(config.recoveryCodeLastId) || 0, current?.codeId ?? 0) + 1;
        const { code, record } = await createRecoveryCode(codeId);
        updateLocalConfig({ recoveryCode: record, recoveryCodeLastId: codeId } as any);
        const reason = current ? `recovery code #${codeId} replaced #${current.codeId}` : `recovery code #${codeId} made`;
        let status: TakeoverStatus;
        try {
            status = await doEnsure(reason);
        } catch (e: any) {
            logger.error('SYS', `[Takeover] Could not seal the take-over envelope (${reason}): ${e?.message || e}`);
            status = statusWithout('error', `The recovery code was made, but the take-over keys could not be re-locked to it yet: ${e?.message || 'unknown error'}.`);
        }
        lastStatus = status;
        return { code, codeId, createdAt: record.createdAt, replacedCodeId: current?.codeId ?? null, status };
    });
}

/**
 * Does this typed code match the current record? Throws RecoveryCodeError (from core) for a typo — the caller
 * checks that first, before the brake, since the check characters cost nothing.
 */
export async function checkCurrentRecoveryCode(code: string): Promise<{ matches: boolean; codeId: number } | null> {
    const record: RecoveryCodeRecord | null = (getLocalConfig() as any).recoveryCode ?? null;
    if (!record) return null;
    return { matches: await checkRecoveryCode(code, record), codeId: record.codeId };
}

export { parseRecoveryCode };
