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
 *      opened → undo-copy → identity-files → admin-settings → roles → public-address → profile → open-door
 *      → community-settings → role → pull-config → restart → audit → announcement → reseal → tunnel → done
 *
 *    Every step is safe to run again, so a crash at any point resumes at the first step not recorded: at boot
 *    (`resumeTakeoverAtBoot`, before the node key is loaded and before anything reads the role) and after boot
 *    (`finishTakeoverAfterBoot`). The opened bundle waits in data/takeover-bundle.json (0600) until the last step;
 *    by then every secret in it is in the files it was written to anyway.
 *
 * ## A step before the restart that fails: rolled back
 *
 * A step that throws (a disk that refuses a write, a bundle whose roles break a constraint) is not left half done. The
 * take-over is rolled back at once (`rollBackTakeover`): the standby's own identity files, settings, roles, web address,
 * community settings and copy cursor are put back from the copy `undo-copy` made of them (data/pre-takeover-…, with
 * standby-state.json for the database's part), the opened keys are deleted, and the journal ends 'failed' with
 * `rolledBack` set: finished, not under way. The server is the standby it was, copying its main server, and a new
 * take-over can start (the code typed again). A crash mid-way through the roll-back leaves the journal 'rolling-back',
 * and the next start finishes it. Before this (F2 of the 2026-10-01 standby review), a 'failed' journal counted as under
 * way for good: no new take-over, and every whole copy the standby built was thrown away at the restart that swapped it
 * in, the next one too. A crash is still resumed, not rolled back: only a step that fails, at the confirm or at the
 * start that resumes it, rolls back; so does a resumed take-over whose opened keys are gone.
 *
 * ## Two standbys, one set of keys
 *
 * Every standby of a community holds the same locked keys, so two of them could each take over (MEDIUM-2 of the
 * 2026-10-01 replication review). Before anything is written, the preview and the confirm ask the community's web address,
 * and the main server's, for its identity epoch (services/identity-epoch.ts newerTakeoverAnswering): a server holding
 * these keys that answers a higher epoch than they were locked at already took over, and this standby refuses. When
 * neither answered in time and both took over anyway, the split-brain guard tells them apart by when each took over:
 * the later one goes read-only.
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
 * re-wraps that one data key), so after a take-over by phone there is no older copy to look in. tunnel-connector.ts now keeps the last
 * token when the registrar leaves it out, so new envelopes stop losing it.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    parseRecoveryCode, checkRecoveryCode, openEnvelope, RecoveryCodeError,
    type CodeStanza, type OwnerStanza, type SealedEnvelopeHeader, type SealedEnvelopeKey,
} from '@beanpool/core';
import { db, markExistingVisitors } from '../db/db.js';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { logger } from '../logger.js';
import {
    getNodeRole, setNodeRole, updateNodeConfig, getNodeConfig, promotionSanityCheck, adminBroadcastAnnouncement,
} from '../state-engine.js';
import { listHeldEnvelopes, readHeldEnvelope, checkEnvelopeFromMirror, HELD_ENVELOPES_DIR } from './standby-envelopes.js';
import {
    BUNDLED_FILES, BUNDLED_LOCAL_CONFIG_FIELDS, ensureTakeoverEnvelope, nodeIdentityOfKeyFile, type TakeoverBundle,
} from './takeover-envelope.js';
import { checkBundle } from './sealed-backup.js';
import { ledgerAgainstLastCopy } from '../engine/audit.js';
import { loadConnectors } from '../connector-manager.js';
import {
    stopBackupPuller, getBackupStatus, forgetPullCursor, stopPullInFlight, savedPullCursor, putPullCursorBack, restartBackupPullerIfStopped,
} from './backup-puller.js';
import { abortStagedCopy, PREVIOUS_DB } from './stager.js';
import { deletePreviousDatabase, previousDatabaseThere } from '../db/swap-at-boot.js';
import { copyCheckForPreview } from './standby-copy-record.js';
import { startTunnelForTakeover } from './tunnel-connector.js';
import { parseRegistrarNames } from '../engine/registrar-names.js';
import {
    getReplacedInfo, forgetSyncEpochHeaderValue, newerTakeoverAnswering, type NewerTakeover, type ReplacedInfo,
} from './identity-epoch.js';
import {
    getNodeProfile, readProfileRecord, writeProfileRecord, takeoverProfileRefusal, NODE_PROFILE_KEY, type NodeProfile,
} from '../config/node-profile.js';
import { resolveNodeRole } from '../config/node-role.js';
import { writeOpenJoinRecord } from '../engine/open-join.js';
import { installCarriedRecoverySealKey, noCarriedKeyLine, RECOVERY_SEAL_KEY_FILE } from './recovery-seal-key.js';
import {
    adoptCarriedOpenJoinKey, installCarriedOpenJoinKey, liveOpenJoinRecords, openJoinKeyOffLine, openJoinKeyState, OPEN_JOIN_KEY_FILE,
    OPEN_JOIN_KEY_ID_ROW,
} from './open-join-key.js';
import {
    installCommunitySettings, keptCommunitySettings, COMMUNITY_DIRECTORY_FIELDS, COMMUNITY_LOCAL_CONFIG_FIELDS, COMMUNITY_NODE_CONFIG_KEYS,
    KEPT_COMMUNITY_SETTINGS_KEY,
} from '../config/community-settings.js';
import { restartScheduler } from './snapshot-scheduler.js';
import { notePhotoUrlShapeNow } from '../engine/photo-keys.js';

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

/**
 * What a standby does not copy (engine/replication-manifest.ts: the tables and settings not yet copied), so a take-over
 * from it does not have, however recent its last copy. Roles are not here: the bundle carries them. Enterprises, their
 * keepers and pledges, and members' holiday and notification settings, vouches, granted credit and freezes are copied
 * (design G2); so are Decisions and their votes, keepers' wages owed, keeper and succession votes, invites, re-key codes,
 * recovery releases and links with other communities (G3); and the phones members get notifications on, muted chats,
 * enterprise thread read marks, event reminders already sent, the activity list and the pricing guide with its members'
 * reports (G4). A price report without a member's key stays on the main server (engine/replication-manifest.ts
 * MEMBERS_REPORTS, #1295 review 4126894855). The last line is the one thing a fresher copy changes.
 */
export const WHAT_WILL_BE_MISSING: readonly string[] = [
    'photos sent in chats',
    'Commons project proposals still waiting for a decision',
    "price reports sent without signing in, or by someone who hadn't joined",
    "the admin IP allowlist, if the community had one: it names addresses on the old server's network, so this server keeps its own",
    'and, on top of everything above, whatever changed on the main server after this standby last copied it',
];

/** What the people running the community do afterwards. Shown with the result. */
export const AFTER_A_TAKEOVER: readonly string[] = [
    "Sign in to this server's Settings with the community's admin password or an owner's key. This standby's own admin password no longer works.",
    'Make a new recovery code: the one you typed is now spent.',
    "If the community's Settings answered only certain internet addresses (the admin IP allowlist, under Gateway & Peers), set it again here: a take-over keeps this server's own allowlist, not the main server's.",
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
    ['profile', "Kept the community's node profile and its switches"],
    ['open-door', 'Kept who joined through the open door'],
    ['community-settings', "Installed the community's own settings: its name, place, contacts, thresholds and directory choices"],
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
const PRE_RESTART: TakeoverStep[] = ['undo-copy', 'identity-files', 'admin-settings', 'roles', 'public-address', 'profile', 'open-door', 'community-settings', 'role', 'pull-config'];
const AFTER_BOOT: TakeoverStep[] = ['announcement', 'reseal', 'tunnel', 'done'];

/**
 * Tests only: BEANPOOL_TEST_TAKEOVER_CRASH_AFTER=<step> kills this process the moment that step is recorded, with
 * no cleanup, as a power cut would; so do the roll-back's own points ('rolling-back': the journal says it is rolling
 * back, nothing put back yet; 'rollback-files': the identity files put back, the settings and database not yet).
 * Unset in every real deployment.
 */
function crashPoint(step: TakeoverStep | RollbackPoint): void {
    if (process.env.BEANPOOL_TEST_TAKEOVER_CRASH_AFTER === step) {
        logger.warn('SYS', `[Takeover] Test crash after step "${step}"`);
        process.kill(process.pid, 'SIGKILL');
    }
}
type RollbackPoint = 'rolling-back' | 'rollback-files';

/**
 * Tests only: BEANPOOL_TEST_TAKEOVER_FAIL_AT=<step> makes that step throw once its own writes are done and before it is
 * recorded, as a disk that refuses its last write would: the worst a failure leaves to roll back. Every time the step
 * runs, at the confirm and at a start that resumes it. Unset in every real deployment.
 */
function failPoint(step: TakeoverStep): void {
    if (process.env.BEANPOOL_TEST_TAKEOVER_FAIL_AT === step) throw new Error(`a test failure at step "${step}", after its writes`);
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
    /**
     * 'failed' with `rolledBack` set: a step failed and the standby was put back as it was; finished, like 'complete'.
     * 'rolling-back': being put back; the next start finishes it. 'failed' without `rolledBack` is only ever an older
     * build's (it was retried at every start); the next start resumes it, and rolls it back if it fails again.
     */
    state: 'running' | 'restarting' | 'complete' | 'failed' | 'rolling-back';
    /** When the standby was put back as it was, and what was put back. Absent until then. */
    rolledBack?: { at: string; detail: string } | null;
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
        // `ok` only when the ledger adds up (`addsUp`) AND is the main server's as this server last copied it (`copy`), so
        // the result can say which failed: an all-zero or empty copy adds up. Both are absent from a journal written before.
        audit: {
            ok: boolean; drift: number; strandedEscrows: number; addsUp?: boolean;
            copy?: NonNullable<ReturnType<typeof getLocalConfig>['lastPromotionAudit']>['copy'] | null;
        } | null;
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

/**
 * A take-over that has restarted this server but not yet reached its tunnel step: the tunnel waits for it
 * (services/tunnel-connector.ts), so the web address comes back after the community is told and the keys are locked again.
 */
export function takeoverHoldsTunnel(): boolean {
    const j = readJournal();
    return !!j && j.state !== 'complete' && !!j.steps.restart && !j.steps.tunnel;
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

/**
 * A take-over under way on this server: neither finished nor rolled back (db/swap-at-boot.ts takeoverUnderWay reads the
 * same from the file). One that stopped and was rolled back is over: a new one can start, and copies land again.
 */
function journalUnderWay(j: Journal | null): boolean {
    return !!j && j.state !== 'complete' && !(j.state === 'failed' && j.rolledBack);
}

/** Checks that do not need the code: this is a standby, nothing is under way, and it holds something to open. */
export function takeoverPreconditions(): void {
    if (journalUnderWay(readJournal())) {
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
        // Locked to owners only: an owner's phone opens it (pickEnvelopeForOwners, newest only); the code can't.
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
 * The envelope an owner's phone is asked to open (§5.2): the newest verified one, and only that one. Its header's
 * owners are who can open it; the phone shows the owner whether they are one. When the newest has no owner stanza
 * the answer is the recovery code, never an older envelope: an owner removed since that older one was sealed could
 * still open it.
 */
export function pickEnvelopeForOwners(): Candidate & { newerSkipped: number; owners: string[] } {
    const newest = verifiedHeld()[0];
    const owners = newest.header.recipients.filter((r): r is OwnerStanza => r.type === 'owner').map((r) => '@' + r.callsign);
    if (!owners.length) {
        throw new TakeoverError(409, "The newest take-over keys this standby holds are locked to the recovery code only: the main server had no owner when it locked them. Take over with the printed recovery code.", { noOwnerStanza: true });
    }
    return { ...newest, newerSkipped: 0, owners };
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
    /** The community's node profile and this server's NODE_PROFILE: equal, or the session would not have opened. */
    profile: { community: NodeProfile | null; thisServer: NodeProfile };
    /** Whether the keys carry the key that opens members' sign-in recovery copies (recovery seal S2). A yes or no. */
    recoverySealKey: boolean;
    tunnel: TunnelOutcome;
    mainServer: { url: string | null; answers: boolean | null; lastCopyAt: number | null; warning: string | null };
    /**
     * This standby's copy of the main server (services/standby-copy-record.ts copyCheckForPreview): "Last exact copy of the
     * main server: <time>", or in plain words what didn't match and when the last exact copy was, that its last copies
     * were refused, or that its last copy is old. `warning` when any of those. It never stops the take-over (design G8,
     * Marty's answer 4: a take-over from a copy known to be stale or wrong goes ahead, with a plain warning).
     */
    copy: ReturnType<typeof copyCheckForPreview>;
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
    // The community's node profile (config/node-profile.ts): the bundle's, or for keys sealed before it travelled,
    // the record this standby copied from the main server. A take-over keeps the community the kind of node it
    // was, so a server whose NODE_PROFILE differs is refused here, before anything is written or the code spent.
    const community = bundle.nodeProfile?.profile ?? readProfileRecord().profile;
    const refusal = takeoverProfileRefusal(community);
    if (refusal) {
        logger.warn('SYS', `[Takeover] Refused: ${refusal}`);
        throw new TakeoverError(409, refusal, { profileMismatch: true, communityProfile: community, thisServerProfile: getNodeProfile() });
    }
    // Another server holding these keys may have taken over already (another standby): asked at the same time as the main
    // server, so the preview waits no longer than it did.
    const [main, newer] = await Promise.all([mainServerAnswers(), newerTakeoverFor(bundle, candidate.header.nodePeerId, publicAddress)]);
    if (newer) refuseNewerTakeover(newer);
    const id = crypto.randomBytes(32).toString('hex');
    session = { id, expiresAt: Date.now() + SESSION_TTL_MS, candidate, bundle, publicAddress, tunnel, authorisedBy };

    const connectors = connectorsFrom(bundle);
    // From this standby's record when the puller has none in memory: after a restart, its last copy is still known.
    const copy = copyCheckForPreview(getBackupStatus().lastSuccessAt);
    const lastCopyAt = copy.lastCopyAt;
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
        profile: { community, thisServer: getNodeProfile() },
        recoverySealKey: carriesSealKey(bundle),
        tunnel,
        mainServer: {
            url: main.url,
            answers: main.answers,
            lastCopyAt,
            warning: main.answers
                ? 'The main server still answers. Take over only if it is really gone: two servers with one identity will compete, and the old one must never be started again.'
                : null,
        },
        copy,
        missing: [
            ...WHAT_WILL_BE_MISSING, ...(carriesSealKey(bundle) ? [] : [MISSING_SEAL_KEY]),
            ...(carriedOpenJoinKey(bundle) || !holdsOpenJoinRecords() ? [] : [MISSING_OPEN_JOIN_KEY]),
            ...(keptCommunitySettings() ? [] : [MISSING_SETTINGS]),
        ],
        afterwards: AFTER_A_TAKEOVER,
    };
}

/** Whether an opened bundle carries a recovery-seal key (one sealed before it travelled has no entry). */
function carriesSealKey(bundle: TakeoverBundle): boolean {
    const b64 = bundle.files[RECOVERY_SEAL_KEY_FILE];
    return typeof b64 === 'string' && Buffer.from(b64, 'base64').length === 32;
}

/** In the preview's list of what will be missing, when the keys carry no recovery-seal key. */
const MISSING_SEAL_KEY = "members' sign-in recovery copies: these keys were locked before they carried the key that opens them, so "
    + 'members connect their sign-in again (their 12 words still work)';

/**
 * The open door's key an opened bundle carries (services/open-join-key.ts), as base64: the `open-join.key` file, or, in a
 * bundle sealed before the key was a file, the old record's `salt` (base64url). Null when it carries none.
 */
function carriedOpenJoinKey(bundle: TakeoverBundle): string | null {
    const file = bundle.files[OPEN_JOIN_KEY_FILE];
    if (typeof file === 'string' && file) return file;
    const legacy = bundle.openJoins?.salt;
    return typeof legacy === 'string' && /^[A-Za-z0-9_-]+$/.test(legacy) ? Buffer.from(legacy, 'base64url').toString('base64') : null;
}

/** Whether this standby holds open-door records a sign-in could match, with no key here they were made with. */
function holdsOpenJoinRecords(): boolean {
    return !openJoinKeyState({ create: false }).on && liveOpenJoinRecords() > 0;
}

/** In the preview's list of what will be missing, when the keys carry no open-door key and this standby holds records. */
const MISSING_OPEN_JOIN_KEY = 'joining through the open door with a sign-in: these keys were locked before they carried the key its records '
    + 'are made with, so the door refuses sign-ins until that key is back (members already here are not affected)';

/** In the preview's list of what will be missing, when this standby holds no copy of the community's settings. */
const MISSING_SETTINGS = "the community's own settings (its name, place, contacts, thresholds and directory choices): the main server never "
    + 'sent them to this standby, so this server keeps its own';

/** Does the main server answer? For the page an owner's phone reads before it unlocks (§5.2 step 3). */
export async function mainServerStatus(): Promise<{ answers: boolean | null; lastCopyAt: number | null }> {
    const main = await mainServerAnswers();
    return { answers: main.answers, lastCopyAt: copyCheckForPreview(getBackupStatus().lastSuccessAt).lastCopyAt };
}

export function discardTakeoverSession(): void {
    session = null;
}

/**
 * A server holding these keys that answers, at the community's web address or at the main server's, a take-over newer
 * than the keys were locked at (services/identity-epoch.ts newerTakeoverAnswering): another standby took over already.
 * Null when none does, or nothing answers in time: no hard gate, the main server is most likely gone with its address.
 */
async function newerTakeoverFor(bundle: TakeoverBundle, peerId: string, publicAddress: unknown): Promise<NewerTakeover | null> {
    const b64 = bundle.files['libp2p_key'];
    if (!b64) return null;
    let identity: ReturnType<typeof nodeIdentityOfKeyFile>;
    try {
        identity = nodeIdentityOfKeyFile(Buffer.from(b64, 'base64'));
    } catch {
        return null;
    }
    if (identity.peerId !== peerId) return null; // checkBundle held them equal; never ask on behalf of another key
    const config = getLocalConfig();
    return newerTakeoverAnswering({
        identity, sealedEpoch: bundleEpoch(bundle), publicAddress, registrarNames: bundle.registrarNames ?? null,
        mainServerUrl: config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || null, timeoutMs: MAIN_SERVER_PROBE_MS,
    });
}

function refuseNewerTakeover(n: NewerTakeover): never {
    const when = n.statement.since ? ` on ${n.statement.since.slice(0, 16).replace('T', ' ')} UTC` : '';
    const message = `Another server already took over this community with these keys${when}: ${n.where} answers as its main server `
        + `(identity epoch ${n.statement.epoch}; the keys this standby holds were locked at ${n.sealedEpoch}). Taking over here too would make `
        + "two main servers, with members' changes split between them, so this standby won't. If that server is the community's main "
        + 'server now, make this standby copy it instead: make a replication token on it and paste it here under Live Backup Server. '
        + 'Nothing has been changed here.';
    logger.warn('SYS', `[Takeover] Refused: ${message}`);
    throw new TakeoverError(409, message, { alreadyTakenOver: true, epoch: n.statement.epoch, since: n.statement.since, url: n.url });
}

/**
 * The confirm, as the route makes it: asks again whether another server took over with these keys since the preview (up
 * to ten minutes ago: a second standby may have been confirmed meanwhile), then confirmTakeover. Refused, the session
 * goes, and nothing is written.
 */
export async function confirmTakeoverAfterCheck(sessionId: unknown): Promise<{ progressToken: string; journalId: string }> {
    const s = session;
    if (s && typeof sessionId === 'string' && sessionId === s.id && Date.now() <= s.expiresAt) {
        const newer = await newerTakeoverFor(s.bundle, s.candidate.header.nodePeerId, s.publicAddress);
        if (newer) {
            if (session === s) session = null;
            refuseNewerTakeover(newer);
        }
    }
    return confirmTakeover(sessionId);
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

// recovery-seal.key and open-join.key: a standby holds neither of its own unless it was once a main server; then each is
// kept here too, byte for byte (and beside the carried one, installCarried…Key), so undoing puts back exactly what was there.
// No tunnel-token: the tunnel runs from publicAddress in node_config (services/tunnel-connector.ts), which is kept below.
const UNDO_FILES = ['libp2p_key', 'community.key', 'genesis.json', 'connectors.json', 'local-config.json', RECOVERY_SEAL_KEY_FILE, OPEN_JOIN_KEY_FILE];

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
            // And what the steps change in the database, so a take-over that stops can put it all back (rollBackTakeover).
            fs.writeFileSync(path.join(dir, UNDO_STATE_FILE), JSON.stringify(readStandbyState()), { mode: 0o600 });
            return `data/${j.undoDir}: ${copied.join(', ') || 'no files'}; the roles, web address and settings in the database`;
        }
        case 'identity-files': {
            for (const f of BUNDLED_FILES) {
                if (f === 'connectors.json' || f === RECOVERY_SEAL_KEY_FILE || f === OPEN_JOIN_KEY_FILE) continue;
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
            return `node key kept (${j.peerId}); ${connectors.length} link(s) with other communities; ${installSealKey(bundle)}`;
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
            // The app addresses an owner confirmed there (engine/own-addresses.ts) come too, so members' apps that
            // reach the community at one of them keep working. A bundle sealed before they travelled keeps this
            // standby's own.
            const owned = Array.isArray(bundle.ownerAddresses) ? bundle.ownerAddresses.filter((a) => typeof a === 'string') : null;
            // So do the registrar names the main server's key held (engine/registrar-names.ts), former ones included:
            // members' apps that still use one are accepted here as they were there. Read (and bounded) as any stored
            // record is. A bundle sealed before they travelled keeps this standby's own, and the stored address's name.
            const names = Array.isArray(bundle.registrarNames) ? parseRegistrarNames(bundle.registrarNames) : null;
            updateNodeConfig({ publicAddress: pa ?? null, ...(owned ? { ownerAddresses: owned } : {}), ...(names ? { registrarNames: names } : {}) } as any);
            j.result.publicAddress = pa ? (pa.hostname || pa.name || null) : null;
            j.result.tunnel = plan.tunnel;
            const extra = (owned && owned.length ? `; confirmed app address(es) ${owned.join(', ')}` : '')
                + (names && names.length ? `; registrar name(s) ${names.map((n) => n.role === 'former' ? `${n.address} (former)` : n.address).join(', ')}` : '');
            return (pa ? `${pa.hostname || pa.name}; ${plan.tunnel.message}` : 'no web address from the registrar') + extra;
        }
        case 'profile': {
            // The community's profile and switch overrides, into this database (config/node-profile.ts), so the
            // promoted server is the same kind of node and its first boot as the main server checks NODE_PROFILE
            // against the community's, not this standby's. The session was refused before this if they differ.
            const record = bundle.nodeProfile;
            if (!writeProfileRecord(record)) {
                const kept = readProfileRecord().profile;
                return `the keys were sealed before the profile travelled with them; kept the copied record (${kept ?? 'none'})`;
            }
            const n = Object.keys(record!.overrides).length;
            return `${record!.profile ?? 'no profile recorded'}${n ? `; ${n} switch override(s)` : ''}`;
        }
        case 'open-door': {
            // Who joined through the open door, and the key their records are hashed with (engine/open-join.ts), so
            // the promoted server refuses a sign-in account that already joined. The key is installed as the file
            // data/open-join.key (services/open-join-key.ts), never over a different key this standby holds, which is
            // kept beside it. The rows are merged over what this standby copied: per member the newer row stands, and a
            // row for a member this standby never copied is left out, so that account can join again rather than be
            // locked out of an identity that is not here. Safe to run again.
            const record = bundle.openJoins;
            const merged = record ? writeOpenJoinRecord(record.joins) : null;
            const key = installOpenJoinKey(bundle);
            if (!record || !merged) return `the keys were sealed before the open door's record travelled with them; kept what this standby copied; ${key}`;
            const held = (db.prepare('SELECT COUNT(*) AS n FROM open_joins').get() as { n: number }).n;
            return `${held} sign-in account(s) on record here (the main server had ${Number(record.total) || 0} when it sealed); `
                + `${merged.written} brought from the keys, ${merged.kept} already copied`
                + `${merged.skipped ? `, ${merged.skipped} for members this standby never copied (they can join again)` : ''}; ${key}`;
        }
        case 'community-settings': {
            // The community's own settings, as this standby last copied them from the main server (config/community-
            // settings.ts): its name, place and contacts in every app and the directory, its currency display, demurrage
            // thresholds, directory choices (a community that hid its contacts or member count keeps them hidden),
            // service area, audit baseline (the audit after the restart holds the ledger to the community's), pricing
            // and snapshot schedule. Nothing of this server's own: the admin password came from the keys, and its
            // replication settings go in `pull-config`. Before `role`, so the first boot as the main server runs on them.
            const done = installCommunitySettings();
            return done.installed ? done.detail : done.why;
        }
        case 'role': {
            // The split-brain guard (identity-epoch.ts): one more take-over than the keys were sealed at. Computed
            // from the bundle, so running this step again writes the same number.
            const epoch = bundleEpoch(bundle) + 1;
            updateLocalConfig({
                nodeRole: 'primary', promotionAuditPending: true,
                identityEpoch: epoch, identityEpochSince: j.startedAt, identityReplaced: null,
            });
            forgetSyncEpochHeaderValue();
            return `nodeRole = primary (local-config.json, over NODE_ROLE in .env); identity epoch ${epoch}`;
        }
        case 'pull-config': {
            stopBackupPuller();
            updateLocalConfig({ backupPrimaryUrl: null, backupReplicationToken: null, backupAdminPassword: null });
            // And where its copies had reached: no pull follows that cursor (design §6.3 T6).
            forgetPullCursor();
            return 'no longer copies from the old main server';
        }
        default:
            return undefined;
    }
}

/**
 * The key that opens members' sign-in recovery copies, from the keys (services/recovery-seal-key.ts). Safe to run again:
 * the same key is left as it is. A key this standby already held (it was once a main server) is kept beside it, never
 * lost. Keys sealed before it travelled promote anyway, and say so.
 */
function installSealKey(bundle: TakeoverBundle): string {
    const done = installCarriedRecoverySealKey(bundle.files[RECOVERY_SEAL_KEY_FILE]);
    if (done.outcome === 'installed' || done.outcome === 'same') return "the key that opens members' sign-in recovery copies";
    if (done.outcome === 'replaced') {
        logger.warn('SYS', `[Takeover] This server already had a recovery-seal key of its own; it is kept as data/${done.retiredAs}, `
            + "and the copies it locked are locked again with the community's key at the next start");
        return `the key that opens members' sign-in recovery copies (this server's own is kept as data/${done.retiredAs})`;
    }
    const line = noCarriedKeyLine('envelope');
    logger.warn('SYS', `[Takeover] ${line}`);
    return line;
}

/**
 * The open door's key, from the keys (services/open-join-key.ts), recorded as the key this database's records were made
 * with. Safe to run again. Keys that carry none promote anyway: the door then refuses sign-ins while this server holds
 * records it cannot check, and says so. Never logs or returns the key's bytes.
 */
function installOpenJoinKey(bundle: TakeoverBundle): string {
    const carried = carriedOpenJoinKey(bundle);
    const done = installCarriedOpenJoinKey(carried);
    if (done.outcome === 'absent' || done.outcome === 'invalid') {
        const state = openJoinKeyState({ create: false });
        const records = liveOpenJoinRecords();
        if (state.on || records === 0) return 'no key for the open door\'s hashes in the keys, and none needed here';
        const line = openJoinKeyOffLine(records, state.why, 'envelope');
        logger.warn('SYS', `[Takeover] ${line}`);
        return line;
    }
    const kept = done.outcome === 'replaced' ? ` (this server's own is kept as data/${done.retiredAs})` : '';
    if (done.outcome === 'replaced') {
        logger.warn('SYS', `[Takeover] This server already had an open-door key of its own; it is kept as data/${done.retiredAs}`);
    }
    if (adoptCarriedOpenJoinKey(carried!) === 'other-key-recorded') {
        const state = openJoinKeyState({ create: false });
        const line = state.on ? null : openJoinKeyOffLine(liveOpenJoinRecords(), state.why);
        if (line) logger.warn('SYS', `[Takeover] ${line}`);
        return `the key for the open door's hashes brought from the keys${kept}; ${line ?? 'it is the key its records were made with'}`;
    }
    return `the key for the open door's hashes brought from the keys${kept}`;
}

/**
 * The steps before the restart, from the first not recorded. One that throws rolls the take-over back (rollBackTakeover)
 * and throws a TakeoverError saying so. `inProcess`: at the confirm, in a server that runs on as the standby after a roll
 * back; false at boot, before anything else has started.
 */
function runPreRestartSteps(j: Journal, plan: Plan, inProcess: boolean): void {
    for (const step of PRE_RESTART) {
        if (j.steps[step]) continue;
        try {
            const detail = runStep(j, plan, step);
            failPoint(step);
            mark(j, step, detail);
        } catch (e: any) {
            j.error = { step, message: e?.message || String(e), at: new Date().toISOString() };
            logger.error('SYS', `[Takeover] Step "${step}" failed: ${j.error.message}. The take-over is rolled back: this server stays the standby it was.`);
            const back = rollBackTakeover(j, inProcess);
            const stopped = `The take-over stopped at "${labelOf(step)}": ${j.error.message}.`;
            throw new TakeoverError(500, back.ok
                ? `${stopped} Nothing of it was kept: this server is the standby it was, with its own keys, settings and copy of the main server, `
                    + 'and it goes on copying. Fix what stopped it, then take over again (the recovery code, or an owner\'s phone, opens the keys again).'
                : `${stopped} Putting this standby back as it was did not finish (${back.why}). Restart the server: it finishes putting itself back `
                    + `before anything else. Its own files from before are in data/${j.undoDir}.`,
            { failedStep: step, rolledBack: back.ok });
        }
    }
}

// ── Rolling back a take-over that stopped ──────────────────────────────────────────────────

/** What `undo-copy` keeps of the database, beside the standby's own files: whatever the steps before the restart change. */
const UNDO_STATE_FILE = 'standby-state.json';
/** node_config rows the steps write: the community's settings and their record, the profile, the open door's key id. */
const UNDO_ROW_KEYS: readonly string[] = [...COMMUNITY_NODE_CONFIG_KEYS, KEPT_COMMUNITY_SETTINGS_KEY, NODE_PROFILE_KEY, OPEN_JOIN_KEY_ID_ROW];
/** The profile's switch overrides (config/node-profile.ts): rows named `nodeProfile.<switch>`. */
const PROFILE_OVERRIDE_PREFIX = `${NODE_PROFILE_KEY}.`;
/** Fields of the `node_config` row the steps write: the web address and its names, and the community's directory choices. */
const UNDO_NODE_CONFIG_FIELDS: readonly string[] = ['publicAddress', 'ownerAddresses', 'registrarNames', ...COMMUNITY_DIRECTORY_FIELDS];
/** local-config.json fields the steps write, through `role` and `pull-config`. Nothing else in the file is touched. */
const UNDO_LOCAL_CONFIG_FIELDS: readonly string[] = [
    ...BUNDLED_LOCAL_CONFIG_FIELDS, 'recoveryCode', 'recoveryCodeLastId', 'recoveryCodeUsed', ...COMMUNITY_LOCAL_CONFIG_FIELDS,
    'nodeRole', 'promotionAuditPending', 'identityEpoch', 'identityEpochSince', 'identityReplaced',
    'backupPrimaryUrl', 'backupReplicationToken', 'backupAdminPassword',
];
/** The files put back: each one the undo copy holds is copied back; one it does not hold was not here, and goes. */
const RESTORED_FILES = UNDO_FILES.filter((f) => f !== 'local-config.json');

interface StandbyState {
    v: 1;
    nodeRoles: Record<string, unknown>[];
    /** node_config rows by key (UNDO_ROW_KEYS); null for a row that was not there. */
    rows: Record<string, string | null>;
    profileOverrides: Record<string, string>;
    /** The UNDO_NODE_CONFIG_FIELDS the `node_config` row held; a field left out was not there. */
    nodeConfig: Record<string, unknown>;
    pullCursor: string | null;
}

function nodeConfigRowValue(key: string): string | null {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
}

/** The `node_config` row as stored (getNodeConfig adds defaults and migrates; a roll-back puts back what was there). */
function storedNodeConfig(): Record<string, unknown> {
    try {
        const value = nodeConfigRowValue('node_config');
        const parsed = value ? JSON.parse(value) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function readStandbyState(): StandbyState {
    const rows: Record<string, string | null> = {};
    for (const key of UNDO_ROW_KEYS) rows[key] = nodeConfigRowValue(key);
    const profileOverrides: Record<string, string> = {};
    const overrides = db.prepare('SELECT key, value FROM node_config WHERE substr(key, 1, ?) = ?')
        .all(PROFILE_OVERRIDE_PREFIX.length, PROFILE_OVERRIDE_PREFIX) as { key: string; value: string }[];
    for (const r of overrides) profileOverrides[r.key] = r.value;
    const stored = storedNodeConfig();
    const nodeConfig: Record<string, unknown> = {};
    for (const f of UNDO_NODE_CONFIG_FIELDS) if (f in stored) nodeConfig[f] = stored[f];
    return {
        v: 1, nodeRoles: db.prepare('SELECT * FROM node_roles').all() as Record<string, unknown>[], rows, profileOverrides, nodeConfig,
        pullCursor: savedPullCursor(),
    };
}

/** The database's part, as `undo-copy` kept it. One transaction; the copy cursor after it. */
function putStandbyStateBack(state: StandbyState): void {
    const columns = new Set((db.prepare('PRAGMA table_info(node_roles)').all() as { name: string }[]).map((c) => c.name));
    const upsert = db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const remove = db.prepare('DELETE FROM node_config WHERE key = ?');
    db.transaction(() => {
        db.prepare('DELETE FROM node_roles').run();
        for (const row of state.nodeRoles ?? []) {
            const cols = Object.keys(row).filter((c) => columns.has(c));
            if (!cols.length) continue;
            db.prepare(`INSERT INTO node_roles (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
                .run(...cols.map((c) => row[c] as string | number | null));
        }
        for (const [key, value] of Object.entries(state.rows ?? {})) {
            if (!UNDO_ROW_KEYS.includes(key)) continue;
            if (value === null || value === undefined) remove.run(key);
            else upsert.run(key, value);
        }
        db.prepare('DELETE FROM node_config WHERE substr(key, 1, ?) = ?').run(PROFILE_OVERRIDE_PREFIX.length, PROFILE_OVERRIDE_PREFIX);
        for (const [key, value] of Object.entries(state.profileOverrides ?? {})) {
            if (key.startsWith(PROFILE_OVERRIDE_PREFIX)) upsert.run(key, value);
        }
        const stored = storedNodeConfig();
        for (const f of UNDO_NODE_CONFIG_FIELDS) {
            if (state.nodeConfig && f in state.nodeConfig) stored[f] = state.nodeConfig[f];
            else delete stored[f];
        }
        upsert.run('node_config', JSON.stringify(stored));
    })();
    putPullCursorBack(state.pullCursor ?? null);
}

/** The settings the steps wrote, as the undo copy of local-config.json had them; read back, since a failed save only logs. */
function putLocalConfigBack(dir: string): void {
    const file = path.join(dir, 'local-config.json');
    const saved: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
    const updates: Record<string, unknown> = {};
    for (const f of UNDO_LOCAL_CONFIG_FIELDS) updates[f] = saved[f]; // undefined: not there before, so not saved now
    updateLocalConfig(updates as Partial<ReturnType<typeof getLocalConfig>>);
    const now = JSON.parse(fs.readFileSync(dataPath('local-config.json'), 'utf-8')) as Record<string, unknown>;
    const unsaved = UNDO_LOCAL_CONFIG_FIELDS.filter((f) => JSON.stringify(now[f]) !== JSON.stringify(saved[f]));
    if (unsaved.length) throw new Error(`local-config.json could not be written (${unsaved.join(', ')} not put back)`);
}

/** The identity files as the undo copy holds them; one it does not hold was not here before the take-over, and goes. */
function putFilesBack(dir: string): void {
    for (const f of RESTORED_FILES) {
        const kept = path.join(dir, f);
        if (fs.existsSync(kept)) writeAtomic(dataPath(f), fs.readFileSync(kept), fs.statSync(kept).mode & 0o777);
        else fs.rmSync(dataPath(f), { force: true });
    }
}

/**
 * Put the standby back as it was before a take-over that stopped, and end the journal 'failed' with `rolledBack` set.
 * Safe to run again: a crash part way leaves it 'rolling-back', and the next start (resumeTakeoverAtBoot) runs it again.
 *
 * - Before `undo-copy` was recorded nothing of the community's was written: the partial copy and the opened keys go.
 * - After it: the identity files (the community's node key, links, recovery-seal.key and open-join.key go; the standby's
 *   own come back, byte for byte), the settings the steps wrote in local-config.json, and the roles, web address,
 *   community settings, profile, open door's key id and copy cursor in the database (standby-state.json; a copy made by an
 *   older build has none, and then only the web address comes back, from public-address.json). The undo copy stays.
 * - The opened keys (data/takeover-bundle.json) go last of all.
 *
 * What a step merged from the main server's own records (open-door records it had newer) stays: they are the main server's,
 * as the next copy brings them. Never throws: says whether it finished, and why not.
 */
function rollBackTakeover(j: Journal, inProcess: boolean): { ok: true } | { ok: false; why: string } {
    try {
        j.state = 'rolling-back';
        writeJournal(j);
        crashPoint('rolling-back');
        const dir = dataPath(j.undoDir);
        let detail: string;
        if (j.steps['undo-copy']) {
            putFilesBack(dir);
            crashPoint('rollback-files');
            putLocalConfigBack(dir);
            const stateFile = path.join(dir, UNDO_STATE_FILE);
            if (fs.existsSync(stateFile)) {
                putStandbyStateBack(JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as StandbyState);
                detail = `put back this standby's own keys, links, settings, roles and web address from data/${j.undoDir}`;
            } else {
                const paFile = path.join(dir, 'public-address.json');
                if (fs.existsSync(paFile)) updateNodeConfig({ publicAddress: JSON.parse(fs.readFileSync(paFile, 'utf-8')) } as any);
                detail = `put back this standby's own keys, links, settings and web address from data/${j.undoDir}; the take-over started on `
                    + "an older version, which kept no copy of the standby's roles, so the community's owners and admins stay on it";
            }
        } else {
            fs.rmSync(dir, { recursive: true, force: true });
            detail = 'nothing of the community\'s had been written yet';
        }
        fs.rmSync(dataPath(TAKEOVER_BUNDLE_FILE), { force: true });
        forgetSyncEpochHeaderValue();
        if (inProcess) {
            // This process runs on as the standby: what it holds in memory follows the files put back.
            loadConnectors();
            restartScheduler();
            restartBackupPullerIfStopped();
        }
        j.state = 'failed';
        j.rolledBack = { at: new Date().toISOString(), detail: `${detail}; deleted the opened keys` };
        writeJournal(j);
        logger.warn('SYS', `[Takeover] Rolled back: ${j.rolledBack.detail}. This server is the standby it was.`);
        return { ok: true };
    } catch (e: any) {
        const why = e?.message || String(e);
        logger.error('SYS', `[Takeover] Rolling back did not finish: ${why}. The next start tries again; this standby's own files are in data/${j.undoDir}.`);
        return { ok: false, why };
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
    // A whole copy being built in a staging database, or one made ready to swap in at the next start, goes first: the
    // promoted server's copy is the last one that landed, and a copy made before the take-over must never replace what
    // the take-over writes (services/stager.ts, db/swap-at-boot.ts).
    if (abortStagedCopy('a take-over was confirmed')) {
        logger.warn('SYS', '[Takeover] A whole copy of the old main server being built here was stopped and deleted: this server takes over on the copy it had.');
    }
    // And any pull under way, a delta's or a one-page whole copy's too: nothing more is asked of the old main server, and
    // nothing of it is imported (services/backup-puller.ts stopPullInFlight).
    if (stopPullInFlight('a take-over was confirmed')) {
        logger.warn('SYS', '[Takeover] A copy of the old main server under way here was stopped: nothing more is asked of it.');
    }

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

    runPreRestartSteps(j, plan, true);
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
        let rolledBackNow = false;
        if (j && j.state === 'rolling-back') {
            // A roll-back a crash (or a refused write) stopped part way: finished before anything reads the role or the keys.
            logger.warn('SYS', '[Takeover] Finishing the roll-back of a take-over that stopped');
            rolledBackNow = rollBackTakeover(j, false).ok;
        } else if (j && journalUnderWay(j) && PRE_RESTART.some((s) => !j.steps[s])) {
            const plan = readPlan(j.id);
            if (!plan) {
                j.error = { step: PRE_RESTART.find((s) => !j.steps[s])!, message: 'the opened keys are gone from data/takeover-bundle.json, so the take-over cannot go on by itself', at: new Date().toISOString() };
                logger.error('SYS', `[Takeover] Cannot resume: ${j.error.message}. It is rolled back: this server stays the standby it was.`);
                rolledBackNow = rollBackTakeover(j, false).ok;
            } else {
                // A crash part way (or a step an older build left failed): resumed. A step that fails now rolls it back.
                logger.warn('SYS', `[Takeover] Resuming an interrupted take-over at "${PRE_RESTART.find((s) => !j.steps[s])}"`);
                j.state = 'running';
                try {
                    runPreRestartSteps(j, plan, false);
                    resumed = true;
                } catch {
                    rolledBackNow = !journalUnderWay(j); // said in the log; a roll-back that didn't finish is finished at the next start
                }
            }
        }
        if (j && journalUnderWay(j) && j.state !== 'rolling-back' && PRE_RESTART.every((s) => j.steps[s]) && !j.steps.restart) {
            j.state = 'restarting';
            mark(j, 'restart', 'finished at boot, after an interruption');
        }
        if (rolledBackNow) {
            // The database's boot read the role before this put the standby's own back (a take-over stopped after its `role`
            // step): this process is a standby again, as local-config.json, or NODE_ROLE, now says.
            const role = resolveNodeRole();
            if (getNodeRole() !== role) setNodeRole(role);
        }

        const configured = getLocalConfig().nodeRole;
        if ((configured === 'primary' || configured === 'backup') && getNodeRole() !== configured) {
            setNodeRole(configured);
            // Promoted here, in this process (a take-over finished at boot after an interruption), after the database's
            // boot left the visitors' rows to a main server as a standby's does: the pass runs now, not at the next
            // restart. It does nothing if the main server's marks were copied (db.ts markExistingVisitors).
            if (configured === 'primary') markExistingVisitors();
            // And the listing-photo URLs' shape, recorded as a standby's by the state engine's boot: a main server's now,
            // so a phone that synced from the server it replaced is answered whole at once (engine/photo-keys.ts).
            notePhotoUrlShapeNow();
        }

        auditRan = runPendingPromotionAudit(j);
        deletePreviousDatabaseOnMainServer(j);
    } catch (e: any) {
        logger.error('SYS', `[Takeover] Boot check failed: ${e?.message || e}`);
    }
    return { resumed, auditRan };
}

/** How long a promoted server keeps the database its last swap replaced after the take-over's audit found trouble. */
const PREVIOUS_KEPT_AFTER_TROUBLE_MS = 30 * 86_400_000;

/**
 * On a main server, the database a swap replaced when this server was a standby (db/swap-at-boot.ts): a take-over promoted
 * it with the database that replaced it, and its puller, which deletes it on a standby, never runs again. It holds rows
 * members deleted since that swap (#1334 review 4144658979), so it goes here, at boot, once the database this server runs on
 * is known good:
 * - the swap that made it is final: this start's swap did not fail part way, and `state.db` is there (swap-at-boot's
 *   deletePreviousDatabase keeps it otherwise, as the only whole database there may be). A copy staged before the take-over
 *   never swaps in after it: the confirm deletes it, and the swap at boot discards one while a take-over is under way;
 * - a take-over's audit has read it and found the ledger adds up and is the main server's as last copied. Until its audit
 *   has run it stays. When the audit found trouble it stays PREVIOUS_KEPT_AFTER_TROUBLE_MS (30 days) from the audit, the
 *   database before that swap being what an operator may need to look at, each start saying the date it goes; then the
 *   first start after that deletes it. Most servers are strangers' installs, where nobody acts on a warning: it never
 *   stays for good.
 * A main server with no take-over (its role set by hand) has only that database to run on: the file goes.
 */
function deletePreviousDatabaseOnMainServer(j: Journal | null): void {
    // Its -wal or -shm alone too: a delete an older build left part done.
    if (getNodeRole() !== 'primary' || !previousDatabaseThere(dataDir())) return;
    // A -wal or -shm with no database is nothing anyone can look at: it goes now.
    const leftOver = !fs.existsSync(dataPath(PREVIOUS_DB));
    if (j && !j.steps.audit && !leftOver) return; // this take-over's audit hasn't read the database yet: a later start deletes it
    let troubleExpired = false;
    if (j && j.result.audit && !j.result.audit.ok && !leftOver) {
        const auditedMs = Date.parse(j.steps.audit!.at);
        const goesMs = (Number.isFinite(auditedMs) ? auditedMs : 0) + PREVIOUS_KEPT_AFTER_TROUBLE_MS;
        if (Date.now() < goesMs) {
            logger.warn('SYS', `[Takeover] ${PREVIOUS_DB}, the database this server's last swap as a standby replaced, is kept until `
                + `${new Date(goesMs).toISOString().slice(0, 10)}: the take-over's audit found trouble, and it may be needed to look into it. `
                + 'It holds rows members deleted since that swap, so the first start after that date deletes it.');
            return;
        }
        troubleExpired = true;
    }
    const r = deletePreviousDatabase(dataDir());
    for (const e of r.errors) logger.warn('SYS', `[Takeover] ${e}`);
    if (r.kept) logger.warn('SYS', `[Takeover] ${PREVIOUS_DB}, the database this server's last swap as a standby replaced, is kept: ${r.kept}.`);
    else if (r.deleted) {
        logger.info('SYS', `[Takeover] ${PREVIOUS_DB}, the database this server's last swap as a standby replaced, deleted: `
            + (leftOver ? 'its -wal or -shm was left on its own by a delete stopped part way.'
                : troubleExpired ? `it was kept ${PREVIOUS_KEPT_AFTER_TROUBLE_MS / 86_400_000} days after the take-over's audit found trouble.`
                : j ? "this server is the main server now, on the database the take-over's audit checked." : 'this server is a main server, which never swaps its database.'));
    }
}

/**
 * The ledger audit, once per take-over: it clears its own flag in the same write that records it. Two questions: does the
 * ledger add up (the conservation check), and is it the main server's as this server last copied it (G0: a ledger with
 * every balance at 0, or with no accounts, adds up, and a standby's copy used to be one of those). It says "ok" only when
 * both hold. Never blocks the take-over: it says what it found.
 */
function runPendingPromotionAudit(j: Journal | null): boolean {
    const config = getLocalConfig();
    let ran = false;
    if (config.promotionAuditPending) {
        // The copy first: the conservation check writes the demurrage any read has applied since boot, and the rows are
        // held to the main server's as they were copied.
        const copy = ledgerAgainstLastCopy();
        const r = promotionSanityCheck();
        const record = {
            at: new Date().toISOString(), ok: r.ok && copy.match, sumBalances: r.sumBalances, drift: r.drift, strandedEscrows: r.strandedEscrows,
            copy: {
                match: copy.match,
                here: { accounts: copy.here.accounts, holdings: copy.here.holdings },
                lastCopy: copy.lastCopy ? { accounts: copy.lastCopy.accounts, holdings: copy.lastCopy.holdings, generatedAt: copy.lastCopy.generatedAt } : null,
            },
        };
        if (!copy.match) logger.error('SYS', `[Takeover] ${ledgerCopyTrouble(record.copy)}`);
        updateLocalConfig({ promotionAuditPending: false, lastPromotionAudit: record });
        ran = true;
    }
    const recorded = getLocalConfig().lastPromotionAudit;
    if (j && j.steps.restart && !j.steps.audit && recorded) {
        const adds = Math.abs(recorded.drift) < 0.01 && recorded.strandedEscrows === 0;
        j.result.audit = { ok: recorded.ok, drift: recorded.drift, strandedEscrows: recorded.strandedEscrows, addsUp: adds, copy: recorded.copy ?? null };
        const troubles = [
            ...(adds ? [] : [`the ledger does NOT add up (drift ${recorded.drift.toFixed(4)}, ${recorded.strandedEscrows} stranded escrow(s))`]),
            ...(recorded.copy && !recorded.copy.match ? [ledgerCopyTrouble(recorded.copy)] : []),
        ];
        mark(j, 'audit', recorded.ok
            ? 'the ledger adds up'
            : `${troubles.join('; ') || 'the ledger does NOT add up'}: check before members trade`);
    }
    return ran;
}

/** What a take-over's audit says when the ledger isn't the main server's as this server last copied it. */
function ledgerCopyTrouble(copy: NonNullable<NonNullable<ReturnType<typeof getLocalConfig>['lastPromotionAudit']>['copy']>): string {
    if (!copy.lastCopy) return "this server has no record of the main server's ledger, so it can't say the ledger is the main server's";
    const held = (s: { accounts: number; holdings: number }) => `${s.accounts} account(s) holding ${s.holdings.toFixed(2)} Beans`;
    return `the ledger is NOT the main server's as this server last copied it (here ${held(copy.here)}; `
        + `the main server's ${held(copy.lastCopy)}${copy.lastCopy.generatedAt ? `, as of ${copy.lastCopy.generatedAt}` : ''})`;
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
                    // Until this step the journal holds the tunnel back (takeoverHoldsTunnel), so it starts here, in order.
                    const t = await startTunnelForTakeover();
                    detail = t.state === 'missing' || t.state === 'off'
                        ? `the tunnel did not start: ${t.reason || t.state}`
                        : 'the tunnel for the web address runs inside this server';
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
    /** 'failed' with `rolledBack`: stopped, and this server is the standby it was; a new take-over can start. */
    state: 'none' | 'running' | 'restarting' | 'complete' | 'failed' | 'rolling-back';
    rolledBack: { at: string; detail: string } | null;
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
        rolledBack: j?.rolledBack ?? null,
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
