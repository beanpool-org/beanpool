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
 * - An owner's key is taken from a request. Recipients come from node_roles (owners whose role acts: an active
 *   member's row, not a visitor's; engine/node-roles.ts NODE_ROLE_ACTS).
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
import { readProfileRecord, type ProfileRecord } from '../config/node-profile.js';
import { readOpenJoinRecord, OPEN_JOINS_IN_BUNDLE, type OpenJoinRecord } from '../engine/open-join.js';
import { logger } from '../logger.js';
import { setTakeoverChangeHandler } from './takeover-signal.js';
import { NODE_ROLE_ACTS } from '../engine/node-roles.js';
import { RECOVERY_SEAL_KEY_FILE } from './recovery-seal-key.js';

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
export const BUNDLED_LOCAL_CONFIG_FIELDS = [
    'adminHash', 'salt', 'totpEnabled', 'totpSecret', 'totpBackupCodesHashes', 'breakGlassMode',
] as const;

/**
 * Identity files, raw bytes as base64 so a take-over writes back exactly what was read.
 * Never in the bundle: the replication token hash, a standby's `backupReplicationToken`, the legacy plain-text
 * `backupAdminPassword` (§2.1).
 *
 * `recovery-seal.key` opens members' sign-in recovery copies (services/recovery-seal-key.ts). This bundle, so the
 * envelope and a sealed backup, is the ONLY place it travels: never the database, a sync payload, a snapshot, a plain
 * backup, a log or an HTTP answer. A take-over and a restore install it with installCarriedRecoverySealKey, never as a
 * plain file write, so a different key already there is kept. A bundle sealed before it travelled has no such entry.
 */
export const BUNDLED_FILES = ['libp2p_key', 'community.key', 'genesis.json', 'connectors.json', RECOVERY_SEAL_KEY_FILE] as const;

export interface TakeoverBundle {
    v: 1;
    /** A bundle sealed before the recovery-seal key travelled has no `recovery-seal.key` entry at all. */
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
    /** How many take-overs this identity has been through (services/identity-epoch.ts). A take-over writes this + 1.
     *  Absent in a bundle sealed before slice 8: read as 0. */
    identityEpoch?: number;
    /** The node profile this community runs as and the operator's switch overrides (config/node-profile.ts), so a
     *  promoted server is the same kind of node. A take-over is refused when the standby's NODE_PROFILE doesn't
     *  match, and writes these into its database otherwise (the `profile` step). Absent in a bundle sealed before
     *  this field existed: the record the standby copied with the replication payload decides. */
    nodeProfile?: ProfileRecord;
    /** The open door's record (engine/open-join.ts): the key its hashes are made with and the newest
     *  OPEN_JOINS_IN_BUNDLE rows, never the address hashes. The take-over's `open-door` step merges them, so the
     *  promoted server refuses a sign-in account that already joined, even one its last copy missed. Absent in a
     *  bundle sealed before this field existed: what the standby copied with the replication payloads stands. */
    openJoins?: OpenJoinRecord;
}

export interface NodeIdentity {
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

/** This node's identity from data/libp2p_key, or null when there is none yet. Throws on a malformed key. */
export function readNodeIdentity(): NodeIdentity | null {
    const keyBytes = readFileOrNull('libp2p_key');
    return keyBytes ? loadNodeIdentity(keyBytes) : null;
}

/** The PeerId a libp2p_key file's bytes belong to. Throws when they are not an Ed25519 key. */
export function peerIdOfKeyFile(keyBytes: Buffer): string {
    return loadNodeIdentity(keyBytes).peerId;
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
        identityEpoch: Number.isSafeInteger(config.identityEpoch) && config.identityEpoch > 0 ? config.identityEpoch : 0,
        nodeProfile: readProfileRecord(),
        openJoins: readOpenJoinRecord(OPEN_JOINS_IN_BUNDLE),
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
         WHERE nr.role = 'owner' AND ${NODE_ROLE_ACTS}
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
    /** Whether the bundle sealed inside carries data/recovery-seal.key: a yes or no, never the key. Absent in an envelope
     *  sealed before the key travelled, which did not carry it. */
    carriesRecoverySealKey?: boolean;
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
    /** Whether the envelope on disk carries the key that opens members' sign-in recovery copies, in words (recovery
     *  seal S2); null when there is no envelope. A yes or no: never the key. */
    recoverySealKey: { carried: boolean; message: string } | null;
}

/** What the take-over card says about the recovery-seal key in the envelope (design §4, "Status"). */
export function recoverySealKeyStatus(carried: boolean): { carried: boolean; message: string } {
    return carried
        ? { carried, message: "The locked keys carry the key that opens members' sign-in recovery copies, so a server that takes over opens them." }
        : {
            carried,
            message: "The locked keys do not carry the key that opens members' sign-in recovery copies: this server's data/recovery-seal.key is "
                + "missing or is not a key. A server that takes over from them cannot open those copies; members' 12 words still work, and they "
                + 'connect their sign-in again.',
        };
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
        recoverySealKey: null,
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
        recoverySealKey: recoverySealKeyStatus(s.carriesRecoverySealKey === true),
    };
}

// ── Re-seal ────────────────────────────────────────────────────────────────────────────────

// Read once, at boot (index.ts, from getNodeRole()). Nothing changes a node's role while it runs today; if a standby is
// ever promoted without a restart, this must be updated too, or the promoted node goes on refusing to make a code
// (RecoveryCodeOnStandbyError, 409) and sealing nothing.
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

/**
 * Everything a seal needs, read from disk and the database now: the node's signing identity, its community, who
 * to lock to, and the take-over bundle. Shared by the take-over envelope and sealed backups (§6.1), so a backup
 * is always locked to exactly the people the envelope is.
 */
export type SealingInputs =
    | {
        ok: true; identity: NodeIdentity; communityId: string; owners: OwnerRecipient[]; skipped: SkippedOwner[];
        code: RecoveryCodeRecord | null; bundle: TakeoverBundle;
    }
    | { ok: false; state: 'no-identity' | 'no-genesis' | 'no-recipients'; message: string; skipped: SkippedOwner[] };

export function readSealingInputs(): SealingInputs {
    const keyBytes = readFileOrNull('libp2p_key');
    if (!keyBytes) {
        return { ok: false, state: 'no-identity', skipped: [], message: 'this server has not created its node key (data/libp2p_key)' };
    }
    const genesisBytes = readFileOrNull('genesis.json');
    let communityId: string | null = null;
    try {
        communityId = genesisBytes ? JSON.parse(genesisBytes.toString('utf-8'))?.communityId ?? null : null;
    } catch { communityId = null; }
    if (!communityId || typeof communityId !== 'string') {
        return { ok: false, state: 'no-genesis', skipped: [], message: 'this server has no readable genesis.json' };
    }
    const identity = loadNodeIdentity(keyBytes);

    const { owners, skipped } = currentOwners();
    const code: RecoveryCodeRecord | null = (getLocalConfig() as any).recoveryCode ?? null;
    if (owners.length === 0 && !code) {
        const why = skipped.length
            ? `this server's owner${skipped.length === 1 ? "'s key is" : "s' keys are"} not usable and there is no recovery code`
            : 'this server has no owner and no recovery code';
        return { ok: false, state: 'no-recipients', skipped, message: why };
    }

    const files = {} as TakeoverBundle['files'];
    for (const f of BUNDLED_FILES) {
        const b = f === 'libp2p_key' ? keyBytes : f === 'genesis.json' ? genesisBytes : readFileOrNull(f);
        // A recovery-seal key file that is not a 32-byte key opens nothing: it is not carried (nor ever overwritten here).
        files[f] = b && !(f === RECOVERY_SEAL_KEY_FILE && b.length !== 32) ? b.toString('base64') : null;
    }
    return { ok: true, identity, communityId, owners, skipped, code, bundle: buildBundle(files) };
}

async function doEnsure(reason: string): Promise<TakeoverStatus> {
    if (standby) {
        return statusWithout('standby', 'This is a standby: it holds no take-over keys of its own.');
    }
    const inputs = readSealingInputs();
    if (!inputs.ok) {
        if (inputs.state === 'no-identity') {
            if (removeStored()) logger.warn('SYS', '[Takeover] Removed the take-over envelope: data/libp2p_key is missing, so it no longer matches this node');
            return statusWithout('no-identity', 'No take-over keys to lock yet: this server has not created its node key (data/libp2p_key).');
        }
        if (inputs.state === 'no-genesis') {
            if (removeStored()) logger.warn('SYS', '[Takeover] Removed the take-over envelope: genesis.json is missing or unreadable');
            return statusWithout('no-genesis', 'No take-over keys to lock yet: this server has no readable genesis.json.');
        }
        if (removeStored()) {
            logger.warn('SYS', '[Takeover] Removed the take-over envelope: this server now has no owner and no recovery code to lock it to');
        }
        return statusWithout('no-recipients', `No take-over envelope: ${inputs.message}, so there is nobody to lock its keys to. Make someone an owner, or make a recovery code.`, inputs.skipped);
    }
    const { identity, communityId, owners, skipped, code, bundle } = inputs;
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
        carriesRecoverySealKey: !!bundle.files[RECOVERY_SEAL_KEY_FILE],
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

// ── Which standby holds which envelope (§4: "standby @ 203.0.113.9 holds the keys sealed today 14:02") ──

/** One standby's last fetch of the envelope, keyed by the address it came from. */
export interface EnvelopeHolderRecord {
    ip: string;
    envelopeId: string;
    /** When that envelope was sealed (its header's createdAt). */
    sealedAt: string;
    lastFetchAt: number;
    /** 'sent': the bytes went out. 'confirmed': the standby named this envelope in If-None-Match (a 304). */
    how: 'sent' | 'confirmed';
}

export interface EnvelopeHolder extends EnvelopeHolderRecord {
    /** It is the envelope this server hands out now. */
    current: boolean;
    message: string;
}

const HOLDERS_KEY = 'takeover_envelope_holders';
const HOLDERS_KEEP = 10;

function readHolderRecords(): EnvelopeHolderRecord[] {
    try {
        const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(HOLDERS_KEY) as { value?: string } | undefined;
        const list = row?.value ? JSON.parse(row.value) : [];
        return Array.isArray(list) ? list.filter((h) => h && typeof h.ip === 'string' && typeof h.envelopeId === 'string') : [];
    } catch {
        return [];
    }
}

/** The envelope route saw a standby (replication token) fetch or confirm an envelope. Never throws. */
export function noteEnvelopeFetch(ip: string, envelopeId: string, sealedAt: string, how: EnvelopeHolderRecord['how']): void {
    try {
        const others = readHolderRecords().filter((h) => h.ip !== ip);
        const list = [{ ip, envelopeId, sealedAt, lastFetchAt: Date.now(), how }, ...others]
            .sort((a, b) => b.lastFetchAt - a.lastFetchAt)
            .slice(0, HOLDERS_KEEP);
        db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(HOLDERS_KEY, JSON.stringify(list));
    } catch (e: any) {
        logger.warn('SYS', `[Takeover] Could not record which standby fetched the envelope: ${e?.message || e}`);
    }
}

/**
 * Who holds what, newest fetch first. Reads the envelope on disk as it is (no re-seal), so it is cheap. A standby
 * that last fetched an older envelope is named as holding keys from before the latest change, with its reason.
 */
export function getEnvelopeHolders(): EnvelopeHolder[] {
    const stored = readStored();
    return readHolderRecords().map((h) => {
        const current = !!stored && stored.envelopeId === h.envelopeId;
        const verb = h.how === 'confirmed' ? 'holds' : 'was sent';
        const message = current
            ? `The standby at ${h.ip} ${verb} the take-over keys sealed ${h.sealedAt}, the current lock.`
            : `The standby at ${h.ip} ${verb} take-over keys sealed ${h.sealedAt}, from before the latest change`
                + (stored ? ` (${stored.reason}, ${stored.sealedAt}).` : '.');
        return { ...h, current, message };
    });
}

// ── The recovery code (§2.6) ───────────────────────────────────────────────────────────────

export class RecoveryCodeExistsError extends Error {
    constructor(public readonly codeId: number) {
        super(`Recovery code #${codeId} already exists. Making a new one replaces it: the old paper stops opening anything locked from now on.`);
    }
}

/** A standby seals nothing of its own (§3), so a code made there would open nothing. */
export class RecoveryCodeOnStandbyError extends Error {
    constructor() {
        super('This server is a standby: it seals nothing, so a recovery code made here would open nothing. Make the code in the main server\'s Settings.');
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
        if (standby) throw new RecoveryCodeOnStandbyError();
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
