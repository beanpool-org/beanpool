/**
 * Take over as the main server, on a standby, with the printed recovery code (sealed-keys.md §5.3, §5.4, §5.5;
 * slice 5) or an owner's phone (§5.2; slice 6, services/owner-unlock.ts). The standby keeps the community's identity: the same node key (so the same PeerId), its owners and
 * admins, its links with other communities, its admin password and two-factor sign-in, and its web address.
 *
 * ## Two steps, then a journal
 *
 * 1. `openTakeoverSession(code)` — or `openTakeoverSessionWithDataKey`, after an owner's phone re-wrapped the data key
 *    to this standby (the phone never sees the keys) — : the standby picks the newest take-over envelope it holds that is still signed by
 *    its pinned main server (re-checked now, 966 follow-up #2), is for THIS community, and is locked to the code's
 *    number. The route has already put the code through the password brake. The envelope is opened in memory and
 *    its bundle checked (same community, the node key that locked it). Nothing is written. The answer is a preview:
 *    what will happen, what will be missing (§5.5), whether the main server still answers.
 * 2. `confirmTakeover(sessionId)`: the session is single use and lives 10 minutes, in memory only. It starts the
 *    promotion, each step written to data/takeover-journal.json before the next begins:
 *
 *      opened → undo-copy → identity-files → admin-settings → roles → public-address → role → pull-config
 *      → restart → audit → announcement → reseal → tunnel → done
 *
 *    Every step is safe to run again, so a crash at any point resumes at the first step not recorded: at boot
 *    (`resumeTakeoverAtBoot`, before the node key is loaded and before anything reads the role) and after boot
 *    (`finishTakeoverAfterBoot`). The opened bundle waits in data/takeover-bundle.json (0600) until the last step;
 *    by then every secret in it is in the files it was written to anyway.
 *
 * ## What is kept, and why (§1.3)
 *
 * The old scripts/restore-primary.mjs (deleted in slice 8) deleted libp2p_key and connectors.json "for a fresh
 * PeerId". A promoted standby with a fresh PeerId loses its web address (the registrar binds the name to the key),
 * every federation link (peers key trust and the bridge on our PeerId), and every other standby (their mirror pin
 * is the old PeerId). So the node key and the connectors are WRITTEN here, never deleted. The passive mirror connector (this standby's pin on the
 * old main server) goes with the standby's old connectors.json: after the take-over this server imports from nobody.
 *
 * ## Two servers with one identity (slice 8)
 *
 * Keeping the node key means a revived old main server would be a second node with the same identity. The step
 * "role" also writes the identity epoch, one more than the keys were sealed at; services/identity-epoch.ts serves
 * it signed and makes an old main server that sees it at its own address go read-only.
 *
 * ## The tunnel token (967 follow-up #2)
 *
 * The registrar's status can come back without `tunnelToken` when its Cloudflare call fails; before this slice the
 * main server then saved (and sealed) a public address with no token until the next good answer. So the newest
 * envelope may carry none. When the web address is a tunnel with no token, the take-over looks in the older held
 * envelopes the same code opens, for the same name, and uses the newest token found, saying so. None found: the
 * result says the tunnel did not come back and what brings it back. An owner's phone opens one envelope only (it
 * re-wraps that one data key), so after a take-over by phone there is no older copy to look in. public-address-agent.ts now keeps the last
 * token when the registrar leaves it out, so new envelopes stop losing it.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    parseRecoveryCode, checkRecoveryCode, openEnvelope, RecoveryCodeError,
    type CodeStanza, type OwnerStanza, type SealedEnvelopeHeader, type SealedEnvelopeKey,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { logger } from '../logger.js';
import {
    getNodeRole, setNodeRole, updateNodeConfig, getNodeConfig, promotionSanityCheck, adminBroadcastAnnouncement,
} from '../state-engine.js';
import { listHeldEnvelopes, readHeldEnvelope, checkEnvelopeFromMirror, HELD_ENVELOPES_DIR } from './standby-envelopes.js';
import {
    BUNDLED_FILES, BUNDLED_LOCAL_CONFIG_FIELDS, ensureTakeoverEnvelope, type TakeoverBundle,
} from './takeover-envelope.js';
import { checkBundle } from './sealed-backup.js';
import { loadConnectors } from '../connector-manager.js';
import { stopBackupPuller, getBackupStatus } from './backup-puller.js';
import { restartSidecar } from './public-address-agent.js';
import { getReplacedInfo, type ReplacedInfo } from './identity-epoch.js';

export const TAKEOVER_JOURNAL_FILE = 'takeover-journal.json';
export const TAKEOVER_BUNDLE_FILE = 'takeover-bundle.json';
const SESSION_TTL_MS = 10 * 60_000;
const MAIN_SERVER_PROBE_MS = 5_000;

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}
function dataPath(name: string): string {
    return path.join(dataDir(), name);
}

function writeAtomic(file: string, data: string | Buffer, mode: number): void {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
}

// ── What a take-over will not have (§5.5; the standby's list, #958) ─────────────────────────

/** What a standby does not copy, so a take-over from it does not have. Roles are not here: the bundle carries them. */
export const WHAT_WILL_BE_MISSING: readonly string[] = [
    'Decisions and their votes',
    'enterprise pledges and keeper changes',
    'invites',
    "members' notification settings",
    "settings the main server keeps in its database other than its web address (for example what it lists in the directory)",
    'anything that changed on the main server after this standby last copied it',
];

/** What the people running the community do afterwards. Shown with the result. */
export const AFTER_A_TAKEOVER: readonly string[] = [
    "Sign in to this server's Settings with the community's admin password or an owner's key. This standby's own admin password no longer works.",
    'Make a new recovery code: the one you typed is now spent.',
    "Don't start the old main server again. It has the same identity as this one and would compete with it.",
    'Other standbys keep their locked keys and trust this server already (it has the same key), but they need a new replication token from this server before they can copy again.',
    'Keep making file backups: a standby is not a complete copy.',
];

// ── Steps ──────────────────────────────────────────────────────────────────────────────────

export const TAKEOVER_STEPS = [
    ['opened', 'Opened the locked keys'],
    ['undo-copy', "Kept a copy of this standby's own keys and settings"],
    ['identity-files', "Wrote the community's node key, genesis and links with other communities"],
    ['admin-settings', "Installed the community's admin password and two-factor sign-in"],
    ['roles', "Brought back the community's owners and admins"],
    ['public-address', "Brought back the community's web address"],
    ['role', 'Made this server the main server'],
    ['pull-config', 'Stopped copying from the old main server'],
    ['restart', 'Restarted as the main server'],
    ['audit', 'Checked that the ledger adds up'],
    ['announcement', 'Posted a notice for members'],
    ['reseal', 'Locked the keys again, on this server'],
    ['tunnel', 'Brought the tunnel for the web address back up'],
    ['done', 'Finished'],
] as const;
export type TakeoverStep = (typeof TAKEOVER_STEPS)[number][0];
const PRE_RESTART: TakeoverStep[] = ['undo-copy', 'identity-files', 'admin-settings', 'roles', 'public-address', 'role', 'pull-config'];
const AFTER_BOOT: TakeoverStep[] = ['announcement', 'reseal', 'tunnel', 'done'];

/**
 * Tests only: BEANPOOL_TEST_TAKEOVER_CRASH_AFTER=<step> kills this process the moment that step is recorded, with
 * no cleanup, as a power cut would. Unset in every real deployment.
 */
function crashPoint(step: TakeoverStep): void {
    if (process.env.BEANPOOL_TEST_TAKEOVER_CRASH_AFTER === step) {
        logger.warn('SYS', `[Takeover] Test crash after step "${step}"`);
        process.kill(process.pid, 'SIGKILL');
    }
}

// ── The journal ────────────────────────────────────────────────────────────────────────────

export type TunnelOutcome =
    | { source: 'none'; message: string }
    | { source: 'envelope'; message: string }
    | { source: 'older-envelope'; sealedAt: string; message: string }
    | { source: 'missing'; message: string };

interface Journal {
    v: 1;
    id: string;
    state: 'running' | 'restarting' | 'complete' | 'failed';
    startedAt: string;
    completedAt: string | null;
    envelopeId: string;
    sealedAt: string;
    authorisedBy: TakeoverAuthority;
    communityId: string;
    peerId: string;
    /** sha256 of the progress token, which lets the Settings screen follow the take-over across the restart. */
    progressTokenHash: string;
    undoDir: string;
    steps: Partial<Record<TakeoverStep, { at: string; detail?: string }>>;
    error: { step: TakeoverStep; message: string; at: string } | null;
    result: {
        roles: { written: number; owners: string[]; skipped: string[] };
        connectors: number;
        publicAddress: string | null;
        tunnel: TunnelOutcome | null;
        audit: { ok: boolean; drift: number; strandedEscrows: number } | null;
        announcement: string | null;
        reseal: string | null;
    };
}

/** What the take-over writes, kept on disk until the last step so a crash can resume without the code. */
interface Plan {
    v: 1;
    journalId: string;
    bundle: TakeoverBundle;
    /** The web address to install: the bundle's, with a tunnel token from an older envelope when it had none. */
    publicAddress: unknown;
    tunnel: TunnelOutcome;
}

/** Who opened the keys: the printed code, or one owner's phone. */
export type TakeoverAuthority = { type: 'code'; codeId: number } | { type: 'owner'; pubkey: string; callsign: string };

/** "recovery code #1" / "@Anna's phone", for the journal, the log and Settings. */
export function describeAuthority(a: TakeoverAuthority): string {
    return a.type === 'code' ? `recovery code #${a.codeId}` : `@${a.callsign}'s phone`;
}

function readJson<T>(name: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(dataPath(name), 'utf-8')) as T;
    } catch {
        return null;
    }
}

function readJournal(): Journal | null {
    const j = readJson<Journal>(TAKEOVER_JOURNAL_FILE);
    return j && j.v === 1 && typeof j.id === 'string' && j.steps ? j : null;
}

function writeJournal(j: Journal): void {
    writeAtomic(dataPath(TAKEOVER_JOURNAL_FILE), JSON.stringify(j, null, 2), 0o600);
}

function mark(j: Journal, step: TakeoverStep, detail?: string): void {
    j.steps[step] = { at: new Date().toISOString(), ...(detail ? { detail } : {}) };
    j.error = null;
    writeJournal(j);
    logger.info('SYS', `[Takeover] ✔ ${step}${detail ? `: ${detail}` : ''}`);
    crashPoint(step);
}

function readPlan(journalId: string): Plan | null {
    const p = readJson<Plan>(TAKEOVER_BUNDLE_FILE);
    return p && p.v === 1 && p.journalId === journalId && p.bundle ? p : null;
}

// ── Opening: pick, check, open ─────────────────────────────────────────────────────────────

export class TakeoverError extends Error {
    constructor(public readonly status: number, message: string, public readonly extra: Record<string, unknown> = {}) {
        super(message);
    }
}

function ownCommunityId(): string | null {
    const g = readJson<{ communityId?: string }>('genesis.json');
    return typeof g?.communityId === 'string' ? g.communityId : null;
}

function inProgress(j: Journal | null): boolean {
    return !!j && j.state !== 'complete';
}

/** Checks that do not need the code: this is a standby, nothing is under way, and it holds something to open. */
export function takeoverPreconditions(): void {
    if (inProgress(readJournal())) {
        throw new TakeoverError(409, 'A take-over is already under way on this server. Follow it under Take over as the main server.', { inProgress: true });
    }
    if (getNodeRole() !== 'backup') {
        throw new TakeoverError(409, 'This server is not a standby: it is already a main server, so there is nothing to take over.', { notStandby: true });
    }
}

interface Candidate {
    header: SealedEnvelopeHeader;
    bytes: Uint8Array;
    /** The code stanza this candidate was picked for; null when picked for an owner's phone. */
    stanza: CodeStanza | null;
    receivedAt: number;
}

/** A candidate picked for the recovery code: it has a code stanza. */
export type CodeCandidate = Candidate & { stanza: CodeStanza };

/**
 * The held envelopes that are signed by the pinned main server (checked again now, not only on arrival) and are for
 * this community, newest first. Throws TakeoverError saying why when there are none. Reads headers only.
 */
function verifiedHeld(): Candidate[] {
    const mine = ownCommunityId();
    if (!mine) throw new TakeoverError(500, "This standby has no readable genesis.json, so it can't tell which community it copies.");
    const held = listHeldEnvelopes().reverse(); // newest first
    if (!held.length) {
        throw new TakeoverError(404, "This standby holds no take-over keys, so it can't take over. It keeps them when it copies from a main server that has an owner or a recovery code.", { noEnvelope: true });
    }
    const verified: Candidate[] = [];
    let otherCommunity = 0;
    let unverified = 0;
    for (const h of held) {
        const bytes = readHeldEnvelope(h.envelopeId);
        if (!bytes) continue;
        const check = checkEnvelopeFromMirror(bytes);
        if (!check.ok) {
            unverified++;
            logger.security('SYS', `[Takeover] Skipped a held take-over envelope: ${check.why}`);
            continue;
        }
        if (check.header.communityId !== mine) {
            otherCommunity++;
            logger.security('SYS', `[Takeover] Skipped a held take-over envelope for community ${check.header.communityId}; this standby copies ${mine}`);
            continue;
        }
        verified.push({ header: check.header, bytes, stanza: null, receivedAt: h.receivedAt });
    }
    if (!verified.length) {
        if (otherCommunity && !unverified) {
            throw new TakeoverError(409, "The take-over keys this standby holds are for another community, not the one it copies. They can't be used here.", { wrongCommunity: true });
        }
        if (unverified && !otherCommunity) {
            throw new TakeoverError(409, "None of the take-over keys this standby holds are signed by the main server it copies from, so none can be trusted.", { unverified: true });
        }
        throw new TakeoverError(409, "None of the take-over keys this standby holds are both for this community and signed by its main server.", { wrongCommunity: otherCommunity > 0, unverified: unverified > 0 });
    }
    return verified;
}

/**
 * The envelope a code of this number opens: the newest verified one (see verifiedHeld) with a stanza for that code.
 * Throws TakeoverError saying why when there is none. Reads headers only; needs no secret.
 */
export function pickEnvelope(codeId: number | undefined): CodeCandidate & { newerSkipped: number; all: CodeCandidate[] } {
    const verified: CodeCandidate[] = [];
    for (const c of verifiedHeld()) {
        const stanza = c.header.recipients.find((r): r is CodeStanza => r.type === 'code');
        // Locked to owners only: an owner's phone opens it (pickEnvelopeForOwners); the code can't.
        if (stanza) verified.push({ ...c, stanza });
    }
    if (!verified.length) {
        throw new TakeoverError(409, "The take-over keys this standby holds are locked to the owners only, with no recovery code. Take over with an owner's phone instead.", { noCodeStanza: true });
    }
    const matching = codeId === undefined ? verified : verified.filter((c) => c.stanza.codeId === codeId);
    if (!matching.length) {
        const numbers = [...new Set(verified.map((c) => c.stanza.codeId))].map((n) => `#${n}`).join(' or ');
        throw new TakeoverError(400, `The take-over keys this standby holds open with recovery code ${numbers}; the code typed is #${codeId}.`, { wrongCodeNumber: true });
    }
    const newest = matching[0];
    return { ...newest, newerSkipped: verified.indexOf(newest), all: matching };
}

/**
 * The envelope an owner's phone is asked to open (§5.2): the newest verified one locked to at least one owner. Its
 * header's owners are who can open it; the phone shows the owner whether they are one.
 */
export function pickEnvelopeForOwners(): Candidate & { newerSkipped: number; owners: string[] } {
    const verified = verifiedHeld();
    const withOwners = verified.filter((c) => c.header.recipients.some((r) => r.type === 'owner'));
    if (!withOwners.length) {
        throw new TakeoverError(409, "The take-over keys this standby holds are locked to the recovery code only: the main server had no owner when it locked them. Take over with the recovery code.", { noOwnerStanza: true });
    }
    const newest = withOwners[0];
    return {
        ...newest,
        newerSkipped: verified.indexOf(newest),
        owners: newest.header.recipients.filter((r): r is OwnerStanza => r.type === 'owner').map((r) => '@' + r.callsign),
    };
}

/** Is it a recovery code at all? A typo costs nothing and is answered before the brake. */
export function parseTypedCode(code: unknown): { codeId: number | undefined } {
    if (typeof code !== 'string' || !code.trim()) throw new TakeoverError(400, 'Type the recovery code.', { typo: true });
    try {
        return { codeId: parseRecoveryCode(code).codeId };
    } catch (e) {
        throw new TakeoverError(400, e instanceof RecoveryCodeError ? e.message : 'That is not a recovery code: check what you typed.', { typo: true });
    }
}

/** The scrypt check against the stanza's public key. The route runs this inside the password brake. */
export async function codeMatches(code: string, stanza: CodeStanza): Promise<boolean> {
    try {
        const { codeId, codePub, salt, N, r, p, createdAt } = stanza;
        return await checkRecoveryCode(code, { codeId, codePub, salt, N, r, p, createdAt });
    } catch {
        return false;
    }
}

async function openBundle(c: Candidate, key: SealedEnvelopeKey): Promise<TakeoverBundle> {
    let payload: Uint8Array;
    try {
        ({ payload } = await openEnvelope(c.bytes, key, { kind: 'takeover' }));
    } catch {
        throw new TakeoverError(400, 'The take-over keys did not open: the copy this standby holds is damaged.', { damaged: true });
    }
    let bundle: TakeoverBundle;
    try {
        bundle = JSON.parse(new TextDecoder().decode(payload));
    } catch {
        throw new TakeoverError(400, 'The take-over keys opened, but what is inside is not readable.', { damaged: true });
    }
    try {
        checkBundle(bundle, c.header, 'The take-over keys are not usable: ');
    } catch (e: any) {
        const wrongCommunity = /different community/.test(e?.message || '');
        throw new TakeoverError(wrongCommunity ? 409 : 400,
            wrongCommunity ? "The take-over keys are for another community than this standby copies. They can't be used here." : e.message,
            wrongCommunity ? { wrongCommunity: true } : { damaged: true });
    }
    const genesis = JSON.parse(Buffer.from(bundle.files['genesis.json']!, 'base64').toString('utf-8'));
    if (genesis.communityId !== ownCommunityId()) {
        throw new TakeoverError(409, "The take-over keys are for another community than this standby copies. They can't be used here.", { wrongCommunity: true });
    }
    return bundle;
}

function tunnelTokenOf(pa: any): string | null {
    return pa && typeof pa.tunnelToken === 'string' && pa.tunnelToken.trim() ? pa.tunnelToken : null;
}

/**
 * The web address to install, with a tunnel token from an older envelope if the chosen one lost it. `code` is null
 * after an owner's phone opened the chosen envelope: it re-wrapped that one data key, which opens no older copy.
 */
async function resolvePublicAddress(chosen: Candidate, bundle: TakeoverBundle, code: string | null, all: Candidate[]): Promise<{ publicAddress: unknown; tunnel: TunnelOutcome }> {
    const pa: any = bundle.publicAddress && typeof bundle.publicAddress === 'object' ? { ...(bundle.publicAddress as any) } : null;
    if (!pa) return { publicAddress: null, tunnel: { source: 'none', message: 'The main server had no web address from the BeanPool registrar, so there is no tunnel to bring back.' } };
    if (pa.mode === 'direct') return { publicAddress: pa, tunnel: { source: 'none', message: 'The web address points straight at a server (no tunnel), so there is no tunnel token to bring back.' } };
    if (tunnelTokenOf(pa)) return { publicAddress: pa, tunnel: { source: 'envelope', message: 'The tunnel token came with the keys.' } };
    // 967 follow-up #2: the newest lock may have been sealed while the registrar's answer lacked the token.
    for (const older of code === null ? [] : all.filter((c) => c.header.envelopeId !== chosen.header.envelopeId && c.receivedAt < chosen.receivedAt)) {
        try {
            const b = await openBundle(older, { type: 'code', code: code! });
            const opa: any = b.publicAddress;
            const token = tunnelTokenOf(opa);
            if (token && opa?.name === pa.name) {
                pa.tunnelToken = token;
                return {
                    publicAddress: pa,
                    tunnel: { source: 'older-envelope', sealedAt: older.header.createdAt, message: `The newest keys had no tunnel token, so it came from the copy locked ${older.header.createdAt}.` },
                };
            }
        } catch { /* an older copy that won't open is simply not a source */ }
    }
    return {
        publicAddress: pa,
        tunnel: {
            source: 'missing',
            message: 'No tunnel token came with the keys, so the tunnel for the web address did not come back by itself. '
                + (code === null ? "(An owner's phone opens only the newest copy; the recovery code can also look in older ones.) " : '')
                + 'With PUBLIC_ADDRESS_NAME set this server asks the registrar again within a few minutes (it has the same key, so the name is still its own). Otherwise re-claim the address under Public Address.',
        },
    };
}

// ── Sessions ───────────────────────────────────────────────────────────────────────────────

interface Session {
    id: string;
    expiresAt: number;
    candidate: Candidate;
    bundle: TakeoverBundle;
    publicAddress: unknown;
    tunnel: TunnelOutcome;
    authorisedBy: TakeoverAuthority;
}

let session: Session | null = null;

function callsignOf(pubkey: string): string {
    try {
        const row = db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(pubkey) as { callsign?: string } | undefined;
        return row?.callsign ? '@' + row.callsign : pubkey.slice(0, 8);
    } catch {
        return pubkey.slice(0, 8);
    }
}

async function mainServerAnswers(): Promise<{ url: string | null; answers: boolean | null }> {
    const config = getLocalConfig();
    const url = config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || null;
    if (!url) return { url: null, answers: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAIN_SERVER_PROBE_MS);
    try {
        const res = await fetch(url.replace(/\/$/, '') + '/api/community/health', { signal: controller.signal });
        await res.body?.cancel().catch(() => {});
        return { url, answers: true };
    } catch {
        return { url, answers: false };
    } finally {
        clearTimeout(timer);
    }
}

export interface TakeoverPreview {
    sessionId: string;
    expiresAt: number;
    /** `codeId` is null when an owner's phone opened the keys; `openedBy` says who, either way. */
    envelope: { envelopeId: string; sealedAt: string; codeId: number | null; newerCopiesSkipped: number };
    openedBy: string;
    communityId: string;
    /** The PeerId this server will have: the main server's own. */
    peerId: string;
    owners: string[];
    admins: number;
    connectors: number;
    publicAddress: string | null;
    tunnel: TunnelOutcome;
    mainServer: { url: string | null; answers: boolean | null; lastCopyAt: number | null; warning: string | null };
    missing: readonly string[];
    afterwards: readonly string[];
}

/**
 * Open a take-over session with a code that has ALREADY been checked against `candidate.stanza` (codeMatches,
 * under the brake). Opens the envelope in memory; writes nothing.
 */
export async function openTakeoverSession(code: string, candidate: ReturnType<typeof pickEnvelope>): Promise<TakeoverPreview> {
    takeoverPreconditions();
    const bundle = await openBundle(candidate, { type: 'code', code });
    const { publicAddress, tunnel } = await resolvePublicAddress(candidate, bundle, code, candidate.all);
    return startSession(candidate, bundle, publicAddress, tunnel, { type: 'code', codeId: candidate.stanza.codeId });
}

/**
 * Open a take-over session with the data key an owner's phone re-wrapped to this standby (services/owner-unlock.ts
 * has checked the owner's signature and that they are a recipient). The data key must open the body of THIS
 * envelope: a key that does not is refused here like a damaged copy. Writes nothing; the confirm is the same step
 * as for the code.
 */
export async function openTakeoverSessionWithDataKey(
    candidate: Candidate & { newerSkipped: number }, dataKey: Uint8Array, owner: { pubkey: string; callsign: string },
): Promise<TakeoverPreview> {
    takeoverPreconditions();
    const bundle = await openBundle(candidate, { type: 'dataKey', dataKey });
    const { publicAddress, tunnel } = await resolvePublicAddress(candidate, bundle, null, []);
    return startSession(candidate, bundle, publicAddress, tunnel, { type: 'owner', pubkey: owner.pubkey, callsign: owner.callsign });
}

async function startSession(
    candidate: Candidate & { newerSkipped: number }, bundle: TakeoverBundle, publicAddress: unknown, tunnel: TunnelOutcome,
    authorisedBy: TakeoverAuthority,
): Promise<TakeoverPreview> {
    const id = crypto.randomBytes(32).toString('hex');
    session = { id, expiresAt: Date.now() + SESSION_TTL_MS, candidate, bundle, publicAddress, tunnel, authorisedBy };

    const connectors = connectorsFrom(bundle);
    const main = await mainServerAnswers();
    const lastCopyAt = getBackupStatus().lastSuccessAt;
    const pa: any = publicAddress;
    logger.warn('SYS', `[Takeover] ${describeAuthority(authorisedBy)} opened the take-over keys sealed ${candidate.header.createdAt}; waiting for the confirm`);
    return {
        sessionId: id,
        expiresAt: session.expiresAt,
        envelope: {
            envelopeId: candidate.header.envelopeId, sealedAt: candidate.header.createdAt,
            codeId: authorisedBy.type === 'code' ? authorisedBy.codeId : null, newerCopiesSkipped: candidate.newerSkipped,
        },
        openedBy: describeAuthority(authorisedBy),
        communityId: candidate.header.communityId,
        peerId: candidate.header.nodePeerId,
        owners: bundle.nodeRoles.filter((r) => r.role === 'owner').map((r) => callsignOf(r.member_pubkey)),
        admins: bundle.nodeRoles.filter((r) => r.role === 'admin').length,
        connectors: connectors ? connectors.length : 0,
        publicAddress: pa ? (pa.hostname || pa.name || null) : null,
        tunnel,
        mainServer: {
            url: main.url,
            answers: main.answers,
            lastCopyAt,
            warning: main.answers
                ? 'The main server still answers. Take over only if it is really gone: two servers with one identity will compete, and the old one must never be started again.'
                : null,
        },
        missing: WHAT_WILL_BE_MISSING,
        afterwards: AFTER_A_TAKEOVER,
    };
}

/** Does the main server answer? For the page an owner's phone reads before it unlocks (§5.2 step 3). */
export async function mainServerStatus(): Promise<{ answers: boolean | null; lastCopyAt: number | null }> {
    const main = await mainServerAnswers();
    return { answers: main.answers, lastCopyAt: getBackupStatus().lastSuccessAt };
}

export function discardTakeoverSession(): void {
    session = null;
}

// ── The promotion ──────────────────────────────────────────────────────────────────────────

/** The bundle's connectors without any mirror pin: after a take-over this server imports from nobody. */
function connectorsFrom(bundle: TakeoverBundle): any[] | null {
    const b64 = bundle.files['connectors.json'];
    if (!b64) return null;
    try {
        const list = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
        return Array.isArray(list) ? list.filter((c) => c && c.trustLevel !== 'mirror') : null;
    } catch {
        return null;
    }
}

function bundleEpoch(bundle: TakeoverBundle): number {
    const n = Number(bundle.identityEpoch);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

const UNDO_FILES = ['libp2p_key', 'community.key', 'genesis.json', 'connectors.json', 'local-config.json', 'tunnel-token'];

function runStep(j: Journal, plan: Plan, step: TakeoverStep): string | undefined {
    const bundle = plan.bundle;
    switch (step) {
        case 'undo-copy': {
            // Started again from scratch if interrupted: nothing of the community's is written before this is done.
            const dir = dataPath(j.undoDir);
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const copied: string[] = [];
            for (const f of UNDO_FILES) {
                if (fs.existsSync(dataPath(f))) {
                    fs.copyFileSync(dataPath(f), path.join(dir, f));
                    copied.push(f);
                }
            }
            const pa = (getNodeConfig() as any).publicAddress ?? null;
            fs.writeFileSync(path.join(dir, 'public-address.json'), JSON.stringify(pa), { mode: 0o600 });
            return `data/${j.undoDir}: ${copied.join(', ') || 'no files'}`;
        }
        case 'identity-files': {
            for (const f of BUNDLED_FILES) {
                if (f === 'connectors.json') continue;
                const b64 = bundle.files[f];
                if (!b64) continue;
                writeAtomic(dataPath(f), Buffer.from(b64, 'base64'), f === 'genesis.json' ? 0o644 : 0o600);
            }
            const connectors = connectorsFrom(bundle) ?? [];
            writeAtomic(dataPath('connectors.json'), JSON.stringify(connectors, null, 2), 0o644);
            // The standby's own list (its mirror pin) is gone from disk; drop it from memory too, so no later save
            // in this process writes it back.
            loadConnectors();
            j.result.connectors = connectors.length;
            return `node key kept (${j.peerId}); ${connectors.length} link(s) with other communities`;
        }
        case 'admin-settings': {
            const updates: Record<string, unknown> = {};
            for (const f of BUNDLED_LOCAL_CONFIG_FIELDS) updates[f] = (bundle.localConfig as any)[f] ?? null;
            const config = getLocalConfig();
            if (bundle.recoveryCode) {
                updates.recoveryCode = bundle.recoveryCode;
                updates.recoveryCodeLastId = Math.max(Number(config.recoveryCodeLastId) || 0, bundle.recoveryCode.codeId);
            }
            // A used code is a spent code (§5.3): Settings says so until a new one is made. An owner's phone spends
            // nothing: their key is still theirs, and the new server locks to them again.
            if (j.authorisedBy.type === 'code') updates.recoveryCodeUsed = { codeId: j.authorisedBy.codeId, at: j.startedAt };
            updateLocalConfig(updates as any);
            return 'admin password, two-factor sign-in and the recovery code record';
        }
        case 'roles': {
            const owners: string[] = [];
            const skipped: string[] = [];
            let written = 0;
            const memberExists = db.prepare('SELECT 1 FROM members WHERE public_key = ?');
            const insert = db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
                                       VALUES (?, ?, ?, ?, ?, ?)`);
            db.transaction(() => {
                db.prepare('DELETE FROM node_roles').run();
                for (const r of bundle.nodeRoles ?? []) {
                    if (!r || typeof r.member_pubkey !== 'string' || !['owner', 'admin', 'moderator'].includes(r.role)) continue;
                    if (!memberExists.get(r.member_pubkey)) {
                        skipped.push(`${r.role} ${r.member_pubkey.slice(0, 8)} (not in this standby's copy of the members)`);
                        continue;
                    }
                    insert.run(r.member_pubkey, r.role, r.granted_at ?? null, r.granted_by ?? null, Number(r.session_epoch) || 0, r.break_glass_hash ?? null);
                    written++;
                    if (r.role === 'owner') owners.push(callsignOf(r.member_pubkey));
                }
            })();
            j.result.roles = { written, owners, skipped };
            return `${written} role(s)${owners.length ? `; owners ${owners.join(', ')}` : ''}${skipped.length ? `; not brought back: ${skipped.join(', ')}` : ''}`;
        }
        case 'public-address': {
            const pa: any = plan.publicAddress;
            updateNodeConfig({ publicAddress: pa ?? null } as any);
            j.result.publicAddress = pa ? (pa.hostname || pa.name || null) : null;
            j.result.tunnel = plan.tunnel;
            return pa ? `${pa.hostname || pa.name}; ${plan.tunnel.message}` : 'no web address from the registrar';
        }
        case 'role': {
            // The split-brain guard (identity-epoch.ts): one more take-over than the keys were sealed at. Computed
            // from the bundle, so running this step again writes the same number.
            const epoch = bundleEpoch(bundle) + 1;
            updateLocalConfig({
                nodeRole: 'primary', promotionAuditPending: true,
                identityEpoch: epoch, identityEpochSince: j.startedAt, identityReplaced: null,
            });
            return `nodeRole = primary (local-config.json, over NODE_ROLE in .env); identity epoch ${epoch}`;
        }
        case 'pull-config': {
            stopBackupPuller();
            updateLocalConfig({ backupPrimaryUrl: null, backupReplicationToken: null, backupAdminPassword: null });
            return 'no longer copies from the old main server';
        }
        default:
            return undefined;
    }
}

function runPreRestartSteps(j: Journal, plan: Plan): void {
    for (const step of PRE_RESTART) {
        if (j.steps[step]) continue;
        try {
            const detail = runStep(j, plan, step);
            mark(j, step, detail);
        } catch (e: any) {
            j.state = 'failed';
            j.error = { step, message: e?.message || String(e), at: new Date().toISOString() };
            writeJournal(j);
            logger.error('SYS', `[Takeover] Step "${step}" failed: ${j.error.message}. It is tried again when the server restarts.`);
            throw new TakeoverError(500, `The take-over stopped at "${labelOf(step)}": ${j.error.message}. Nothing after that step was done. `
                + 'Restart the server to try that step again; this standby\'s own files from before are in data/' + j.undoDir + '.', { failedStep: step });
        }
    }
}

function labelOf(step: TakeoverStep): string {
    return TAKEOVER_STEPS.find(([s]) => s === step)?.[1] ?? step;
}

/** After a take-over the node restarts to load its new identity. Tests replace it. */
let restartAfterTakeover: () => void = () => process.exit(0);
export function setTakeoverRestartForTests(fn: (() => void) | null): void {
    restartAfterTakeover = fn ?? (() => process.exit(0));
}

/**
 * The confirm: run the journaled promotion up to the restart, then restart. Returns the progress token (shown to
 * the Settings screen that confirmed, and nowhere else) so it can follow the steps after the restart, when this
 * standby's own admin password no longer works.
 */
export function confirmTakeover(sessionId: unknown): { progressToken: string; journalId: string } {
    const s = session;
    if (!s || typeof sessionId !== 'string' || sessionId !== s.id) {
        throw new TakeoverError(400, 'This take-over session is not open any more. Type the recovery code again.', { sessionGone: true });
    }
    session = null; // single use, whatever happens next
    if (Date.now() > s.expiresAt) {
        throw new TakeoverError(400, 'This take-over session ran out (10 minutes). Type the recovery code again.', { sessionGone: true });
    }
    takeoverPreconditions();

    const now = new Date();
    const progressToken = crypto.randomBytes(32).toString('hex');
    const j: Journal = {
        v: 1,
        id: crypto.randomBytes(8).toString('hex'),
        state: 'running',
        startedAt: now.toISOString(),
        completedAt: null,
        envelopeId: s.candidate.header.envelopeId,
        sealedAt: s.candidate.header.createdAt,
        authorisedBy: s.authorisedBy,
        communityId: s.candidate.header.communityId,
        peerId: s.candidate.header.nodePeerId,
        progressTokenHash: crypto.createHash('sha256').update(progressToken).digest('hex'),
        undoDir: `pre-takeover-${now.toISOString().replace(/[:.]/g, '-')}`,
        steps: {},
        error: null,
        result: { roles: { written: 0, owners: [], skipped: [] }, connectors: 0, publicAddress: null, tunnel: null, audit: null, announcement: null, reseal: null },
    };
    const plan: Plan = { v: 1, journalId: j.id, bundle: s.bundle, publicAddress: s.publicAddress, tunnel: s.tunnel };
    // The plan first, then the journal naming it: a crash between the two leaves no journal, so nothing resumes
    // and the plan is swept at the next boot.
    writeAtomic(dataPath(TAKEOVER_BUNDLE_FILE), JSON.stringify(plan), 0o600);
    logger.warn('SYS', `[Takeover] Taking over as the main server, authorised by ${describeAuthority(s.authorisedBy)} (keys sealed ${j.sealedAt})`);
    mark(j, 'opened', `${describeAuthority(s.authorisedBy)}; keys sealed ${j.sealedAt}; envelope ${j.envelopeId.slice(0, 8)}`);

    runPreRestartSteps(j, plan);
    j.state = 'restarting';
    mark(j, 'restart', 'restarting now');
    setTimeout(() => {
        logger.warn('SYS', '[Takeover] Restarting as the main server…');
        restartAfterTakeover();
    }, 1000).unref?.();
    return { progressToken, journalId: j.id };
}

// ── Boot ───────────────────────────────────────────────────────────────────────────────────

/**
 * At boot, after the database is open and BEFORE the node key is loaded or the role read for anything else: finish
 * any step before the restart that a crash interrupted, take the role from the config, and run the promotion audit
 * once if it is pending. Never throws; never stops the boot.
 */
export function resumeTakeoverAtBoot(): { resumed: boolean; auditRan: boolean } {
    let resumed = false;
    let auditRan = false;
    try {
        const j = readJournal();
        if (!j && fs.existsSync(dataPath(TAKEOVER_BUNDLE_FILE))) {
            // Opened, but the journal never started: nothing was written. Don't keep the keys lying about.
            fs.rmSync(dataPath(TAKEOVER_BUNDLE_FILE), { force: true });
            logger.warn('SYS', '[Takeover] Removed keys from a take-over that never started');
        }
        if (j && j.state !== 'complete' && PRE_RESTART.some((s) => !j.steps[s])) {
            const plan = readPlan(j.id);
            if (!plan) {
                j.state = 'failed';
                j.error = { step: PRE_RESTART.find((s) => !j.steps[s])!, message: 'the opened keys are gone from data/takeover-bundle.json, so the take-over cannot go on by itself', at: new Date().toISOString() };
                writeJournal(j);
                logger.error('SYS', `[Takeover] Cannot resume: ${j.error.message}`);
            } else {
                logger.warn('SYS', `[Takeover] Resuming an interrupted take-over at "${PRE_RESTART.find((s) => !j.steps[s])}"`);
                j.state = 'running';
                try {
                    runPreRestartSteps(j, plan);
                    resumed = true;
                } catch { /* recorded in the journal; the next boot tries again */ }
            }
        }
        if (j && j.state !== 'complete' && PRE_RESTART.every((s) => j.steps[s]) && !j.steps.restart) {
            j.state = 'restarting';
            mark(j, 'restart', 'finished at boot, after an interruption');
        }

        const configured = getLocalConfig().nodeRole;
        if ((configured === 'primary' || configured === 'backup') && getNodeRole() !== configured) setNodeRole(configured);

        auditRan = runPendingPromotionAudit(j);
    } catch (e: any) {
        logger.error('SYS', `[Takeover] Boot check failed: ${e?.message || e}`);
    }
    return { resumed, auditRan };
}

/** The ledger conservation audit, once per take-over: it clears its own flag in the same write that records it. */
function runPendingPromotionAudit(j: Journal | null): boolean {
    const config = getLocalConfig();
    let ran = false;
    if (config.promotionAuditPending) {
        const r = promotionSanityCheck();
        const record = { at: new Date().toISOString(), ok: r.ok, sumBalances: r.sumBalances, drift: r.drift, strandedEscrows: r.strandedEscrows };
        updateLocalConfig({ promotionAuditPending: false, lastPromotionAudit: record });
        ran = true;
    }
    const recorded = getLocalConfig().lastPromotionAudit;
    if (j && j.steps.restart && !j.steps.audit && recorded) {
        j.result.audit = { ok: recorded.ok, drift: recorded.drift, strandedEscrows: recorded.strandedEscrows };
        mark(j, 'audit', recorded.ok
            ? 'the ledger adds up'
            : `the ledger does NOT add up (drift ${recorded.drift.toFixed(4)}, ${recorded.strandedEscrows} stranded escrow(s)): check before members trade`);
    }
    return ran;
}

/**
 * After boot (libp2p up, the envelope service started as a main server): tell the community, lock the keys again
 * on this server, bring the tunnel back, finish. Each step recorded; a failure is recorded and never stops the node.
 */
export async function finishTakeoverAfterBoot(): Promise<void> {
    const j = readJournal();
    if (!j || j.state === 'complete' || !j.steps.restart || !j.steps.audit) return;
    for (const step of AFTER_BOOT) {
        if (j.steps[step]) continue;
        try {
            let detail: string | undefined;
            if (step === 'announcement') {
                const date = new Date(j.startedAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
                const by = j.authorisedBy.type === 'code' ? `the recovery code (#${j.authorisedBy.codeId})` : `@${j.authorisedBy.callsign}`;
                const body = `This community moved to a new server on ${date}, authorised by ${by}. `
                    + 'Nothing changes for you: same community, same address.';
                adminBroadcastAnnouncement('This community moved to a new server', body, 'warning');
                j.result.announcement = body;
                detail = body;
            } else if (step === 'reseal') {
                // The standby's copies are from the old main server; this server seals its own from now on.
                fs.rmSync(dataPath(HELD_ENVELOPES_DIR), { recursive: true, force: true });
                const status = await ensureTakeoverEnvelope(`take-over by ${describeAuthority(j.authorisedBy)}`);
                j.result.reseal = status.message;
                detail = status.state === 'sealed' ? `envelope ${status.envelopeId?.slice(0, 8)}` : status.message;
            } else if (step === 'tunnel') {
                const token = tunnelTokenOf((getNodeConfig() as any).publicAddress);
                if (token) {
                    writeAtomic(dataPath('tunnel-token'), token.trim(), 0o644);
                    void restartSidecar(); // a no-op without Docker's socket
                    detail = 'tunnel token written for the cloudflared sidecar';
                } else {
                    detail = j.result.tunnel?.message || 'no tunnel token';
                }
            } else if (step === 'done') {
                fs.rmSync(dataPath(TAKEOVER_BUNDLE_FILE), { force: true });
                j.state = 'complete';
                j.completedAt = new Date().toISOString();
                detail = 'this server is the main server';
            }
            mark(j, step, detail);
        } catch (e: any) {
            j.error = { step, message: e?.message || String(e), at: new Date().toISOString() };
            writeJournal(j);
            logger.error('SYS', `[Takeover] Step "${step}" failed: ${j.error.message}. It is tried again at the next start.`);
            return;
        }
    }
    logger.warn('SYS', `[Takeover] ✅ This server is now the community's main server (PeerId ${j.peerId})`);
}

// ── Progress, for Settings ─────────────────────────────────────────────────────────────────

export function progressTokenMatches(token: unknown): boolean {
    const j = readJournal();
    if (!j || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
    const a = Buffer.from(crypto.createHash('sha256').update(token).digest('hex'));
    const b = Buffer.from(j.progressTokenHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface TakeoverProgress {
    role: 'primary' | 'backup';
    state: 'none' | 'running' | 'restarting' | 'complete' | 'failed';
    startedAt: string | null;
    completedAt: string | null;
    authorisedBy: string | null;
    peerId: string | null;
    sealedAt: string | null;
    steps: { step: TakeoverStep; label: string; done: boolean; at: string | null; detail: string | null }[];
    error: { step: TakeoverStep; label: string; message: string } | null;
    result: Journal['result'] | null;
    missing: readonly string[];
    afterwards: readonly string[];
    /** "Your recovery code was used. Make a new one." while the used code is still the current one. */
    codeUsed: { codeId: number; at: string; message: string } | null;
    /** The split-brain guard (identity-epoch.ts): another server took over from this one, which is now read-only. */
    replaced: ReplacedInfo | null;
}

export function getTakeoverProgress(): TakeoverProgress {
    const j = readJournal();
    const config = getLocalConfig();
    const used = config.recoveryCodeUsed;
    const codeUsed = used && config.recoveryCode?.codeId === used.codeId
        ? { codeId: used.codeId, at: used.at, message: `Your recovery code #${used.codeId} was used to take over on ${used.at}. Make a new one: whoever has that paper can open this community's keys.` }
        : null;
    return {
        role: getNodeRole(),
        state: j ? j.state : 'none',
        startedAt: j?.startedAt ?? null,
        completedAt: j?.completedAt ?? null,
        authorisedBy: j ? describeAuthority(j.authorisedBy) : null,
        peerId: j?.peerId ?? null,
        sealedAt: j?.sealedAt ?? null,
        steps: TAKEOVER_STEPS.map(([step, label]) => ({
            step, label, done: !!j?.steps[step], at: j?.steps[step]?.at ?? null, detail: j?.steps[step]?.detail ?? null,
        })),
        error: j?.error ? { step: j.error.step, label: labelOf(j.error.step), message: j.error.message } : null,
        result: j?.result ?? null,
        missing: WHAT_WILL_BE_MISSING,
        afterwards: AFTER_A_TAKEOVER,
        codeUsed,
        replaced: getReplacedInfo(),
    };
}

/** Tests only. */
export function resetTakeoverSessionForTests(): void {
    session = null;
}
