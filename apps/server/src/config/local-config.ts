/**
 * Local Configuration — Node Identity & Settings
 *
 * The node has no admin password (Marty, 11 Nov 2026): a new install's first owner claims it with the claim code
 * (claim-code.ts), and owners sign in with their key. A local-config.json from an older install may still hold the keys
 * adminHash, salt, the totp* keys, backupAdminPassword, breakGlassMode or passwordRetired: nothing reads them, and they
 * are still left out of every backup file (LEFT_OUT_OF_BACKUPS). Deleting them is a hand step for the operator.
 *
 * Locked out: `beanpool recover` on the server adds an owner, who signs in with the app. Deleting data/local-config.json
 * (or Wipe & Reset) starts the server as a new install, with a claim code only if the community has no owner.
 */

import { scryptSync, randomBytes, timingSafeEqual, randomInt, scrypt, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type GatewayConfig, DEFAULT_GATEWAY_CONFIG } from './gateway.js';
import type { RecoveryCodeRecord } from '@beanpool/core';
import { noteTakeoverInputsChanged } from '../services/takeover-signal.js';
import { writeFileAtomic, fsyncDir } from '../write-file-atomic.js';
export { type GatewayConfig, DEFAULT_GATEWAY_CONFIG };

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'local-config.json');
// The last good copy: every save writes it after local-config.json, both atomically, so one of the two always parses.
// It holds the same secrets as local-config.json and keeps its mode.
export const CONFIG_BACKUP_PATH = `${CONFIG_PATH}.bak`;

export interface LocalConfig {
    isLocked: boolean;
    callsign: string | null;
    location: { lat: number; lng: number } | null;
    joinedAt: number | null;
    thresholds?: Thresholds;
    gateway?: GatewayConfig;
    communityName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    currencyType?: 'text' | 'image';
    currencyValue?: string;
    backupPrimaryUrl?: string | null;
    // --- Replication credential (live backup) ---
    // Primary side: scrypt hash of a dedicated replication token. The snapshot-pull
    // endpoint accepts a request bearing the matching token and nothing else (least-privilege,
    // scoped to read-only replication only, and independently rotatable). Never store the plaintext.
    // --- Claim code (claim-code.ts) ---
    // A node with no owner writes a one-time claim code to data/claim-code.txt; only K = scrypt(sha256(code), salt) (hex,
    // a secret: it checks a claim's proof), the public salt, the code's short public id and when it was made are kept
    // here. `claimedBy`/`claimedAt` once a phone key claimed the node with it; the burn deletes `key` and `salt`.
    claim?: { key?: string; salt?: string; id: string; createdAt: number; claimedBy?: string | null; claimedAt?: number | null } | null;

    // --- A name asked for at install (`beanpool claim --name`, address-request.ts) ---
    // The command leaves data/address-request.json; the node moves it here (only the node writes this file) and its
    // public-address agent claims <name>.beanpool.org with the node's own key, as it does for PUBLIC_ADDRESS_NAME (the env
    // wins when both are set). Cleared once the registrar holds the name; `refused` keeps the registrar's reason.
    addressRequest?: { name: string; mode: 'tunnel'; contact?: string | null; requestedAt: number; refused?: string | null } | null;
    // The name of the latest such request that ended without the registrar giving it here (the owner's claim or Take
    // offline, another address held): a late answer about it never brings the community onto it (tunnel-connector.ts
    // answersAboutAnotherName).
    // Superseded by turnedAwayNames (config/turned-away-names.ts reads it into the list, and clears it at the next write).
    endedAddressRequest?: { name: string; at: number } | null;
    // A new name claimed beside an address that keeps working: its host, until the members are told it is live
    // (services/address-notice.ts).
    addressNoticeDue?: string | null;
    // The latest names this server turned away (config/turned-away-names.ts): never stored from a registrar answer while
    // nothing is stored here.
    turnedAwayNames?: { name: string; at: number; why: 'install-request-ended' | 'request-replaced' | 'claim-replaced' | 'late-claim' | 'taken-offline' | 'unanswered' }[] | null;
    // Notices from the address service (services/registrar-notices.ts, registrar slice S2): the latest it sent this server,
    // newest first, as Settings shows them; and the highest notice id it has had, sent back on /status as `seen` so the
    // address service never carries those again.
    registrarNotices?: { id: number; at: number; level: 'info' | 'warning' | 'action'; text: string; name: string; link: string | null; receivedAt: number }[] | null;
    registrarNoticeSeen?: number | null;
    replicationTokenHash?: string | null;
    replicationTokenSalt?: string | null;
    replicationTokenCreatedAt?: number | null;
    // LEFT for its readers in Settings: the copy routes take the replication token only, whatever this says.
    replicationTokenOnly?: boolean;
    // Owner automation tokens (automation-tokens.ts): each one's public id, name, scope, who made it and when, and a
    // SHA-256 of its secret, never the secret. This server's own: never in a backup file, the stager's copy or the bundle.
    automationTokens?: AutomationTokenRecord[];
    // "Allow AI assistants" (agent/mcp-route.ts, admin MCP design §2): the owner switch for /mcp. Left out or true: the
    // endpoint answers (inert until an owner makes an agent token); false: /mcp answers 404 to everyone. This server's own.
    aiAssistantsAllowed?: boolean;
    /** AI assistants connected through OAuth with the phone's approval (agent/oauth.ts): this server's own, never in a backup. */
    agentOAuthGrants?: AgentOAuthGrantRecord[];
    /**
     * "Owner and admin limit", first "Assistant posts a day" (agent/limits.ts agentPostsPerDay): the most posts one owner's
     * assistant ticked "May post for me" makes in a UTC day, and owners' and admins' own content limits in the apps
     * (engine/owner-admin-limit.ts), 1–1,000, an owners' setting. Left out: 100. This server's own, never copied to a standby.
     */
    agentPostsPerDay?: number;
    // Backup side: the plaintext token this backup presents to its primary.
    backupReplicationToken?: string | null;
    // --- Backup pull cadence (operator-tunable, e.g. from the fleet manager) ---
    // How often the backup asks the primary "what changed?" (the cheap delta pull).
    // Small; fine to run every minute or less. Null → env BACKUP_PULL_INTERVAL_MS → 60s.
    backupPullSeconds?: number | null;
    // How often the backup does a FULL re-read as a belt-and-suspenders verification.
    // This one moves the whole DB, so it's spaced out and can be turned off entirely
    // (0) at scale — the per-minute deltas + the stateHash drift canary keep the copy
    // correct, and a drift is corrected on demand. Null → env BACKUP_RECONCILE_EVERY_MS
    // → 15m. 0 → routine full reconcile disabled (drift-triggered fulls still run).
    backupReconcileMinutes?: number | null;
    // --- Sealed keys (scratch/overnight/design/sealed-keys.md §2.6) ---
    // The PUBLIC record of the printed recovery code: codeId, the X25519 public key scrypt(code) derives, the
    // salt and cost. It seals, it never opens. The code itself is shown once and never stored anywhere.
    recoveryCode?: RecoveryCodeRecord | null;
    // The highest code number ever issued, so a new code never reuses a number printed on older paper.
    recoveryCodeLastId?: number | null;
    // --- Take-over (sealed-keys.md §5.3, §5.4; services/takeover.ts) ---
    // This server's role, written by a take-over. When set it wins over NODE_ROLE in .env (engine/sync.ts), so a
    // promoted standby needs no .env edit and a redeploy with the old .env cannot demote it.
    nodeRole?: 'primary' | 'backup' | null;
    // Set by a take-over: the next boot runs the ledger conservation audit once, then clears it.
    promotionAuditPending?: boolean;
    // What that audit found, so Settings can show it after the restart. `copy`: whether the ledger is the main server's as
    // this server last copied it (accounts holding Beans and what they hold, here and in that copy; null when this server
    // has no record of one). `ok` needs both.
    // `sumBalances` and `drift` are null when they aren't a finite number (a balance of Infinity makes both Infinity, which
    // JSON writes as null): every reader takes null, and anything else that isn't a finite number, as "not a number".
    lastPromotionAudit?: {
        at: string; ok: boolean; sumBalances: number | null; drift: number | null; strandedEscrows: number | null;
        // Balances that are not a finite number (engine audit.ts BROKEN_BALANCE_SQL). Absent from a record written before.
        badBalances?: number | null;
        // The audit could not run (a check threw): why. The take-over goes on and says so; never "ok".
        error?: string;
        copy?: { match: boolean; here: { accounts: number; holdings: number }; lastCopy: { accounts: number; holdings: number; generatedAt: string | null } | null } | null;
    } | null;
    // The recovery code a take-over was opened with. While recoveryCode is still that code, Settings says "Your
    // recovery code was used. Make a new one" (a used code is a spent code, §5.3). Making a new code ends it.
    recoveryCodeUsed?: { codeId: number; at: string } | null;
    // --- Split-brain guard (sealed-keys.md §5.4; services/identity-epoch.ts) ---
    // How many take-overs this identity has been through. Carried in the take-over bundle; a take-over writes the
    // bundle's number + 1. The main server serves it, signed with its node key, at GET /api/node/identity-epoch.
    identityEpoch?: number | null;
    // When this server took that number (the take-over's start). Null for a server that never took over.
    identityEpochSince?: string | null;
    // Set when this server saw, at its own public address, a HIGHER epoch signed by its own node key: another server
    // took over from it. It then refuses members' writes. Kept across restarts; applies only while this server still
    // has that PeerId and is a main server. With `conflict`: the SAME epoch from another take-over, made before this
    // server's own (`since` the other's, `conflict.ownSince` this server's): two standbys took over with one set of keys,
    // and this is the later one. Applies only while this server is still at that epoch, from that take-over.
    identityReplaced?: {
        peerId: string; epoch: number; ownEpoch: number; since: string | null; detectedAt: string; url: string;
        conflict?: { ownSince: string | null } | null;
    } | null;
    // --- Lights-out (services/lights-out.ts; design scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §2.1) ---
    // The owner's switch for the hall. This server's own: never in a backup file, the stager's copy, the take-over bundle or
    // anything a standby pulls, so a hall laptop's "on" never comes back to life on the rented server.
    lightsOut?: LightsOutRecord | null;
    // The last backup restored onto this server (routes/backup.ts restoreFromTar): when, when the backup was made, and
    // the take-over count its keys carried (0 when it carried none). What lights-out reads for recordAsOf and the epoch
    // raise (§3.5, §2.1 item 3). This server's own, like lightsOut.
    restoredCopy?: { at: string; madeAt: string | null; epoch: number } | null;
}

/** The lights-out switch as local-config.json keeps it (services/lights-out.ts). */
export interface LightsOutRecord {
    on: boolean;
    /** When it last went on (ISO); kept after it goes off, for the stand-down offer. */
    since: string | null;
    /** The hall address the owner confirmed: http://<a local-network number>[:port]; null when none was given. */
    address: string | null;
    /** How old the record is, written when it went on (§3.5); null on a server that was always the main server. */
    recordAsOf: string | null;
    /** The community's main address when it went on, https://<name>: where phones go home to. */
    home: string | null;
    by?: 'owner-key' | 'password' | 'shell';
    /** When it last went off. */
    offAt?: string | null;
    /** A member wrote here (a write answered 2xx) since it last went on: the hall copy holds something new. */
    hallWrites?: boolean;
    /** The epoch raise this switch made (§2.1 item 3): for which restore (restoredCopy.at), when, and to what. */
    raised?: { for: string; at: string; epoch: number } | null;
}

/**
 * Health heuristics an owner or admin may tune (POST /api/admin/thresholds). Nothing here moves Beans: demurrage is
 * core's protocol constants. The circulation rate and its epoch that were here were read by nothing (design
 * scratch/fable-design/DESIGN-community-shape-settings-fable.md Q10): gone, so no dial reads as a fee it isn't. A stored
 * one is never read (getThresholds), and leaves the file at the next save.
 */
export interface Thresholds {
    // Health flags
    washTradingWindowHours: number;  // Window for wash trading detection (default: 24)
    washTradingMinTxns: number;      // Min txns in window to flag (default: 4)
    inactiveMemberDays: number;      // Days with no trades that make a member count as inactive in the health counts (default: 30). It raises no flag.
    isolatedBranchMinTxns: number;   // Min internal txns to flag isolation (default: 3)
    maxProjectExpiryDays: number;    // Max days allowed for crowdfund expiry (default: 365)
    // Sybil funnel detection
    sybilFunnelMinInvitees: number;  // Min invitees funneling back to flag (default: 2)
    sybilFunnelMinAmount: number;    // Min total beans funneled to flag (default: 100)
    sybilFunnelWindowDays: number;   // Rolling window in days (default: 30)
}

const DEFAULT_CONFIG: LocalConfig = {
    isLocked: false,
    callsign: null,
    location: null,
    joinedAt: null,
    communityName: null,
    contactEmail: null,
    contactPhone: null,
    currencyType: 'image',
    currencyValue: 'bean',
};

/** One AI assistant connected through OAuth (agent/oauth.ts): its client, its member, and its refresh token's hashes. */
export interface AgentOAuthGrantRecord {
    /** oa + 10 hex: never the shape of an automation token's id. */
    id: string;
    clientId: string;
    /** What the client called itself at registration (cleaned): never shown without redirectUri's host. */
    clientName: string;
    redirectUri: string;
    /** The resource it was approved for (this node's /mcp). */
    resource: string;
    /** The owner or admin who approved it on their phone: the assistant acts for them, at their role read per call. */
    member: string;
    createdAt: number;
    lastUsedAt: number | null;
    refreshIssuedAt: number;
    /** SHA-256 (hex) of the live refresh token. */
    refreshHash: string;
    /** SHA-256 (hex) of the last spent refresh tokens: one presented again revokes the grant. */
    spentRefresh: string[];
    /** "May post for me", ticked on the consent page when it was approved (agent/owner-posts.ts): left out, it may not. */
    canPost?: boolean;
    /**
     * "May take down posts for me", ticked on the consent page when it was approved (agent/owner-takedowns.ts, MCP-MODERATION S3):
     * left out, it may not. Only the tick is kept: what it takes down (an owner's one or many, an admin's one a call) is the
     * member's role read at every call.
     */
    canModerate?: boolean;
}

/** One owner automation token as local-config.json keeps it (automation-tokens.ts). */
export interface AutomationTokenRecord {
    id: string;
    name: string;
    scope: 'read' | 'backups' | 'admin' | 'agent';
    /** The issuing owner: their key, or 'owner:password'. */
    createdBy: string;
    createdAt: number;
    expiresAt: number | null;
    lastUsedAt: number | null;
    lastUsedRoute: string | null;
    /** SHA-256 (hex) of the secret. */
    hash: string;
    /** An agent token's "May post for me", ticked when it was made (agent/owner-posts.ts): left out, it may not. */
    canPost?: boolean;
    /** An agent token's "May take down posts for me", ticked when it was made (agent/owner-takedowns.ts): left out, it may not. */
    canModerate?: boolean;
}

/**
 * local-config.json is there but does not parse, and neither does the last good copy: the server stops rather than
 * start as a new install. Defaults would forget the community's address, name, owners' settings, role and retired
 * password, and the next save would write them over the file for good.
 */
export class LocalConfigUnreadableError extends Error {}

/** What the last start found, when local-config.json was broken and the last good copy took its place. */
let restoredFromBackup: { at: string; why: string; brokenCopy: string | null } | null = null;
/**
 * A restore that could not put the last good copy back in place (a full disk, a read-only file): the copy it read, and
 * the broken file as it was then. While the file is unchanged, every later read in this process takes that copy, with
 * no second log line and no second `.broken-*` copy; once the file changes (a save, a hand fix) it is read again.
 */
let restoredInMemory: { size: number; mtimeMs: number; config: string } | null = null;
export function localConfigRestoredNotice(): typeof restoredFromBackup { return restoredFromBackup; }

/** The config in a file's text, or why it isn't one (an empty or cut-off file, JSON that isn't an object). A new object every time. */
function parseConfigText(text: string): { config: LocalConfig } | { error: string } {
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'not a JSON object' };
        return { config: parsed as LocalConfig };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

/** The file's config, or why it isn't one (an empty or cut-off file, JSON that isn't an object). */
function parseConfigFile(file: string): { config: LocalConfig } | { error: string } {
    try {
        return parseConfigText(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
        return { error: (e as Error).message };
    }
}

/**
 * local-config.json's text as the last read found it, kept while the file is the same file. The gateway reads the config
 * on every request (getGatewayConfig, twice), and opening, reading and closing a file on each was 4.5% of the launch mix's
 * busy time on the global node (scratch/global-node/REPORT-global-load-rehearsal-2026-11-07.md §7). The text is kept, not the
 * object: every call still parses a new one, so no caller can change what the next gets.
 *
 * "The same file" is one `stat` that agrees on the device, inode, size, modified time and changed time. A save replaces
 * the file whole (writeFileAtomic), so it is a new inode; a hand edit or another process's save moves the times. Three
 * guards, so nothing stale is ever served:
 *   - the stat is taken BEFORE the file is read: a change between the two is seen as one at the next call (the other order
 *     could keep old text under a new stamp);
 *   - nothing is kept until the file has been still for CONFIG_STILL_MS: a clock that ticks in milliseconds (or seconds)
 *     could give an edit made just after the read the same stamp, and a file changed a moment ago is read every time, as it
 *     always was;
 *   - saveLocalConfig, and a restore that rewrites the file, forget the text at once, whatever the stat would say.
 * A file that does not parse is never kept, so the restore from the last good copy runs on every read of it as before.
 */
let keptConfig: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; text: string } | null = null;
const CONFIG_STILL_MS = 2_000;

/** What local-config.json holds now: null when there is no file, else the config or why it isn't one. */
function readMainConfigFile(): { config: LocalConfig } | { error: string } | null {
    let st: fs.Stats | undefined;
    try { st = fs.statSync(CONFIG_PATH, { throwIfNoEntry: false }); } catch { st = undefined; }
    if (!st) {
        keptConfig = null;
        return null;
    }
    const k = keptConfig;
    if (k && k.size === st.size && k.mtimeMs === st.mtimeMs && k.ctimeMs === st.ctimeMs && k.ino === st.ino && k.dev === st.dev) {
        return parseConfigText(k.text);
    }
    keptConfig = null;
    let text: string;
    try { text = fs.readFileSync(CONFIG_PATH, 'utf-8'); } catch (e) { return { error: (e as Error).message }; }
    const read = parseConfigText(text);
    if ('config' in read && Date.now() - st.mtimeMs > CONFIG_STILL_MS) {
        keptConfig = { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, text };
    }
    return read;
}

/**
 * local-config.json is there and broken: take the last good copy, put it back in place (the broken file is kept
 * beside it for a look), and say so loudly. Neither parses: fail closed.
 */
function restoreFromBackup(why: string): LocalConfig {
    const backup = fs.existsSync(CONFIG_BACKUP_PATH) ? parseConfigFile(CONFIG_BACKUP_PATH) : { error: 'there is none' };
    if (!('config' in backup)) {
        const msg = `${CONFIG_PATH} is unreadable (${why}) and its last good copy ${CONFIG_BACKUP_PATH} is too (${backup.error}). `
            + 'This server will not start as a new install over it: that would forget its address and settings. '
            + 'Put back a good local-config.json (from a backup of this server\'s data dir) and restart. With no backup: both are JSON '
            + 'files, and a cut-off one can often be mended by hand; mend whichever is less damaged and save it as local-config.json. '
            + 'Do not move them aside on a server that took over from another: its role (nodeRole) and take-over count '
            + '(identityEpoch, the split-brain guard) are kept only in local-config.json, so with NODE_ROLE=backup in .env it would '
            + 'start as a standby again and copy from BACKUP_PRIMARY_URL. If they can\'t be mended: on a main '
            + 'server, first make sure .env does not say NODE_ROLE=backup (set NODE_ROLE=primary); then move local-config.json and '
            + 'local-config.json.bak aside (rename them and keep them) and restart. This server then starts with no settings '
            + '(owners still sign in with the BeanPool app, and `beanpool recover` adds an owner); an address request still waiting is forgotten (an address it already holds is kept in the database); '
            + 'its standbys stop copying until each is paired again (a standby paired from Settings stops its own copying too; one set up with BACKUP_PRIMARY_URL in .env carries on); backups are not locked, and are not sent off the server, '
            + 'until an owner makes a new recovery code; the take-over count starts again at 0; and the community\'s name and '
            + 'contact details must be set again. Its community, node key and database are not touched.';
        console.error(`🛑 [Config] ${msg}`);
        throw new LocalConfigUnreadableError(msg);
    }
    let brokenCopy: string | null = `${CONFIG_PATH}.broken-${Date.now()}`;
    try { fs.copyFileSync(CONFIG_PATH, brokenCopy); } catch { brokenCopy = null; }
    keptConfig = null;
    try {
        writeFileAtomic(CONFIG_PATH, JSON.stringify(backup.config, null, 2), { newMode: 0o600 });
        restoredInMemory = null;
    } catch (e) {
        console.error('[Config] Could not put the last good copy back in place (this process uses it until the file changes):', e);
        try {
            const st = fs.statSync(CONFIG_PATH);
            restoredInMemory = { size: st.size, mtimeMs: st.mtimeMs, config: JSON.stringify(backup.config) };
        } catch { restoredInMemory = null; }
    }
    restoredFromBackup = { at: new Date().toISOString(), why, brokenCopy };
    console.error(`🛑 [Config] ${CONFIG_PATH} was unreadable (${why}). This server started from its last good copy, `
        + `${CONFIG_BACKUP_PATH}: the community's address and settings are as they were at the last save.`
        + (brokenCopy ? ` The broken file is kept as ${brokenCopy}.` : ''));
    return backup.config;
}

/** The copy an earlier restore in this process read, while the broken file it could not replace is unchanged. */
function restoredCopyStillApplies(): LocalConfig | null {
    if (!restoredInMemory) return null;
    try {
        const st = fs.statSync(CONFIG_PATH);
        if (st.size === restoredInMemory.size && st.mtimeMs === restoredInMemory.mtimeMs) return JSON.parse(restoredInMemory.config) as LocalConfig;
    } catch { /* gone: read as it is now */ }
    restoredInMemory = null;
    return null;
}

/**
 * At a start (boot-file-safety.ts): local-config.json parses, and its last good copy is missing, broken or older than
 * it: write the copy, atomically, with the file's mode. A node upgraded from before the copy existed has one from its
 * first start on, not only from its first save. A broken local-config.json is left to getLocalConfig. Never throws.
 */
export function ensureLocalConfigBackup(): void {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return;
        const bytes = fs.readFileSync(CONFIG_PATH);
        if (!('config' in parseConfigFile(CONFIG_PATH))) return;
        const st = fs.statSync(CONFIG_PATH);
        let why: string | null = null;
        if (!fs.existsSync(CONFIG_BACKUP_PATH)) why = 'there was none';
        else if (!('config' in parseConfigFile(CONFIG_BACKUP_PATH))) why = 'it was unreadable';
        else if (fs.statSync(CONFIG_BACKUP_PATH).mtimeMs < st.mtimeMs && !fs.readFileSync(CONFIG_BACKUP_PATH).equals(bytes)) why = 'it was older';
        if (!why) return;
        writeFileAtomic(CONFIG_BACKUP_PATH, bytes, { mode: st.mode & 0o777 });
        console.log(`💾 [Config] Wrote the last good copy of local-config.json (${CONFIG_BACKUP_PATH}): ${why}.`);
    } catch (e) {
        console.error(`[Config] Could not write the last good copy ${CONFIG_BACKUP_PATH} at start:`, (e as Error).message);
    }
}

export function getLocalConfig(): LocalConfig {
    // No file: a new install (or one wiped on purpose). A file that is there always parses, since every save replaces it
    // whole (writeFileAtomic); one that doesn't was broken some other way, and never reads as a new install.
    const read = readMainConfigFile();
    if (read === null) return { ...DEFAULT_CONFIG };
    return 'config' in read ? read.config : (restoredCopyStillApplies() ?? restoreFromBackup(read.error));
}

/**
 * The local-config.json in another data dir (a restore writing into one), or its last good copy when it is broken; {}
 * when there is neither. One there that doesn't parse, with no good copy beside it, throws: never read as empty.
 */
export function readLocalConfigFileIn(dir: string): Record<string, unknown> {
    const file = path.join(dir, 'local-config.json');
    if (!fs.existsSync(file)) return {};
    const read = parseConfigFile(file);
    if ('config' in read) return read.config as unknown as Record<string, unknown>;
    const backup = parseConfigFile(`${file}.bak`);
    if ('config' in backup) {
        console.error(`🛑 [Config] ${file} was unreadable (${read.error}): its last good copy is used instead.`);
        return backup.config as unknown as Record<string, unknown>;
    }
    throw new LocalConfigUnreadableError(`${file} is unreadable (${read.error}), and so is its last good copy (${backup.error})`);
}

/** Write another data dir's local-config.json and its last good copy, as saveLocalConfig does this server's. */
export function writeLocalConfigFileIn(dir: string, config: Record<string, unknown>, mode: number): void {
    const json = JSON.stringify(config, null, 2);
    writeFileAtomic(path.join(dir, 'local-config.json'), json, { mode });
    writeFileAtomic(path.join(dir, 'local-config.json.bak'), json, { mode });
}

export function saveLocalConfig(config: LocalConfig): void {
    // Atomic, so no reader and no crash sees half a file; then the last good copy, the same way. A new file is 0600: it
    // holds token hashes.
    const json = JSON.stringify(config, null, 2);
    let saved = false;
    keptConfig = null;
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        writeFileAtomic(CONFIG_PATH, json, { newMode: 0o600 });
        saved = true;
    } catch (e) {
        console.error(`[Config] Failed to save local config (${CONFIG_PATH}; nothing changed on disk):`, e);
    } finally {
        keptConfig = null;
    }
    if (saved) {
        try {
            let mode: number | undefined;
            try { mode = fs.statSync(CONFIG_PATH).mode & 0o777; } catch { /* just written */ }
            writeFileAtomic(CONFIG_BACKUP_PATH, json, { mode: mode ?? 0o600 });
        } catch (e) {
            console.error(`[Config] Saved ${CONFIG_PATH}, but not its last good copy ${CONFIG_BACKUP_PATH} (it is one save behind):`, e);
        }
    }
    // The admin/2FA fields and the recovery-code record are in the take-over envelope. Most saves change
    // neither; the check compares a fingerprint and re-seals only when they did.
    noteTakeoverInputsChanged('local config saved');
}

export function updateLocalConfig(updates: Partial<LocalConfig>): LocalConfig {
    const current = getLocalConfig();
    const updated = { ...current, ...updates };
    saveLocalConfig(updated);
    return updated;
}

export function hashPassword(password: string): { hash: string; salt: string } {
    const salt = randomBytes(32).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
}

export function verifyPassword(password: string, storedHash: string, storedSalt: string): boolean {
    try {
        const hash = scryptSync(password, storedSalt, 64);
        const expected = Buffer.from(storedHash, 'hex');
        return timingSafeEqual(hash, expected);
    } catch {
        return false;
    }
}

/**
 * A2-21 (SRV-14): async password verification. `scryptSync` blocks Node's single
 * event-loop thread for ~100–300 ms on the low-end hardware this targets; with
 * `checkAdminAuth` calling it on EVERY `/api/local/*` + `/api/admin/*` request and
 * the dashboard fanning out several admin POSTs, the synchronous calls serialized
 * and head-of-line-blocked the loop until the front proxy returned 502. This async
 * variant runs scrypt on the libuv threadpool, so concurrent admin requests no
 * longer block the event loop (health probes + other requests stay responsive).
 */
export function verifyPasswordAsync(password: string, storedHash: string, storedSalt: string): Promise<boolean> {
    return new Promise((resolve) => {
        if (!password || !storedHash || !storedSalt) { resolve(false); return; }
        try {
            scrypt(password, storedSalt, 64, (err, derived) => {
                if (err) { resolve(false); return; }
                try {
                    const expected = Buffer.from(storedHash, 'hex');
                    resolve(derived.length === expected.length && timingSafeEqual(derived, expected));
                } catch { resolve(false); }
            });
        } catch { resolve(false); }
    });
}

// ===================== REPLICATION TOKEN =====================

/** Generate a fresh 256-bit replication token (shown to the operator once). */
export function generateReplicationToken(): string {
    return randomBytes(32).toString('hex');
}

/**
 * How long a replication token that verified is taken without its scrypt again (verifyReplicationToken). A standby's copy
 * asks for every listing photo's object it lacks, one request each (routes/backup.ts sync-object): a first copy of a
 * community with 30,000 photos would otherwise be 30,000 scrypts on the main server (review 4148896207).
 */
const REPLICATION_TOKEN_REMEMBERED_MS = 5 * 60_000;

/**
 * The replication token that last verified, remembered: the SHA-256 of what was presented, the stored hash it verified
 * against, and until when. Only a token that verified: a wrong one pays its full scrypt every time, as the admin tarpit and
 * limiter expect. Forgotten when the token is set or cleared, and never taken against a stored hash other than the one it
 * verified against (a config file edited or restored under this process).
 */
let rememberedToken: { digest: Buffer; storedHash: string; until: number } | null = null;

function forgetRememberedToken(): void {
    rememberedToken = null;
}

/** Store the scrypt hash of a replication token (primary side). Plaintext is never persisted. */
export function setReplicationToken(token: string): void {
    forgetRememberedToken();
    const config = getLocalConfig();
    const { hash, salt } = hashPassword(token);
    config.replicationTokenHash = hash;
    config.replicationTokenSalt = salt;
    config.replicationTokenCreatedAt = Date.now();
    saveLocalConfig(config);
}

/**
 * Remove the replication token. Token-only mode is left as it is: clearing the token on a
 * token-only server stops all copying until a new token is made, rather than quietly
 * letting the admin password back in.
 */
export function clearReplicationToken(): void {
    forgetRememberedToken();
    const config = getLocalConfig();
    config.replicationTokenHash = null;
    config.replicationTokenSalt = null;
    config.replicationTokenCreatedAt = null;
    saveLocalConfig(config);
}

/**
 * What a backup file's node_config.json leaves out: this server's credentials. The replication token's hash, the token a
 * standby presents, the owners' automation tokens' hashes, and the keys an older install's file may still hold though
 * nothing reads them now (the admin password's hash and salt, the two-factor secret and backup codes, the plain-text
 * admin password an older standby kept). The notices from the
 * address service too: each holds a live one-use reply link, which would let whoever reads the file reply as the community. A readable backup is a file anyone who has it can
 * read (Fable's replication review HIGH-1, 2026-10-01: the hash was offline guessing, the 2FA secret the second factor
 * gone); a locked one carries them in its take-over bundle, where a restore takes them from.
 */
const LEFT_OUT_OF_BACKUPS = [
    'adminHash', 'salt', 'totpSecret', 'totpBackupCodesHashes', 'totpPendingSecret', 'totpPendingBackupCodesHashes',
    'replicationTokenHash', 'replicationTokenSalt', 'backupReplicationToken', 'backupAdminPassword', 'automationTokens', 'agentOAuthGrants', 'claim', 'addressRequest', 'endedAddressRequest', 'turnedAwayNames',
    'registrarNotices', 'registrarNoticeSeen',
    // Not credentials, but this server's own (services/lights-out.ts): a backup never says "the hall is open", and never
    // says it was restored.
    'lightsOut', 'restoredCopy',
] as const;

/** A copy of the local config that is safe to put in a backup file (LEFT_OUT_OF_BACKUPS). */
export function redactLocalConfig(config: LocalConfig): LocalConfig {
    const rest: Record<string, unknown> = { ...config };
    for (const key of LEFT_OUT_OF_BACKUPS) delete rest[key];
    return rest as unknown as LocalConfig;
}

export function hasReplicationToken(): boolean {
    const config = getLocalConfig();
    return !!(config.replicationTokenHash && config.replicationTokenSalt);
}

/**
 * Constant-time verify of a presented replication token (async — runs scrypt off the event loop). A token that verified is
 * taken for REPLICATION_TOKEN_REMEMBERED_MS without its scrypt again (rememberedToken); any other pays it in full.
 */
export async function verifyReplicationToken(token: string): Promise<boolean> {
    const config = getLocalConfig();
    if (!token || !config.replicationTokenHash || !config.replicationTokenSalt) return false;
    const storedHash = config.replicationTokenHash;
    const digest = createHash('sha256').update(token).digest();
    const r = rememberedToken;
    if (r && r.storedHash === storedHash && Date.now() < r.until && timingSafeEqual(r.digest, digest)) return true;
    const ok = await verifyPasswordAsync(token, storedHash, config.replicationTokenSalt);
    // Remembered only if the token is still the one it verified against once the scrypt is done: set or cleared meanwhile,
    // the new one is not taken for the old.
    if (ok && getLocalConfig().replicationTokenHash === storedHash) {
        rememberedToken = { digest, storedHash, until: Date.now() + REPLICATION_TOKEN_REMEMBERED_MS };
    }
    return ok;
}

// ===================== THRESHOLDS =====================

export const DEFAULT_THRESHOLDS: Thresholds = {
    washTradingWindowHours: 24,
    washTradingMinTxns: 4,
    inactiveMemberDays: 30,
    isolatedBranchMinTxns: 3,
    maxProjectExpiryDays: 365,
    sybilFunnelMinInvitees: 2,
    sybilFunnelMinAmount: 100,
    sybilFunnelWindowDays: 30,
};

/**
 * What each threshold may be: a finite number in its range, a whole number where it counts days, hours or trades. The
 * days are written into SQL date modifiers (state-engine.ts countHealth), where a negative, NaN or Infinity — which a
 * JSON `1e999` parses to, and the config file then keeps as `null` — made the check silently count nothing
 * (FABLE-sec-input LOW F3, 2026-10-01).
 */
export const THRESHOLD_LIMITS: Record<keyof Thresholds, { min: number; max: number; whole: boolean }> = {
    washTradingWindowHours: { min: 1, max: 8760, whole: true },
    washTradingMinTxns: { min: 1, max: 100_000, whole: true },
    inactiveMemberDays: { min: 1, max: 3650, whole: true },
    isolatedBranchMinTxns: { min: 1, max: 100_000, whole: true },
    maxProjectExpiryDays: { min: 1, max: 3650, whole: true },
    sybilFunnelMinInvitees: { min: 1, max: 100_000, whole: true },
    sybilFunnelMinAmount: { min: 0, max: 1_000_000_000, whole: false },
    sybilFunnelWindowDays: { min: 1, max: 3650, whole: true },
};

/** Why `value` can't be threshold `key`, in words for the admin; null when it can. */
export function thresholdProblem(key: string, value: unknown): string | null {
    const limit = (THRESHOLD_LIMITS as Record<string, { min: number; max: number; whole: boolean }>)[key];
    if (!limit) return `${key} is not a threshold`;
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a number`;
    if (limit.whole && !Number.isInteger(value)) return `${key} must be a whole number`;
    if (value < limit.min || value > limit.max) return `${key} must be between ${limit.min} and ${limit.max}`;
    return null;
}

export function getThresholds(): Thresholds {
    const stored = (getLocalConfig().thresholds ?? {}) as Partial<Record<string, unknown>>;
    const merged = { ...DEFAULT_THRESHOLDS };
    // Only the thresholds there are: a value saved before the limits (a negative, or the `null` an Infinity is written
    // as) reads as its default, and a key that is no threshold (the circulation rate that was one) is never read.
    for (const key of Object.keys(THRESHOLD_LIMITS) as (keyof typeof THRESHOLD_LIMITS)[]) {
        if (thresholdProblem(key, stored[key]) === null) merged[key] = stored[key] as number;
    }
    return merged;
}

export function updateThresholds(updates: Partial<Thresholds>): Thresholds {
    const config = getLocalConfig();
    const merged = { ...getThresholds(), ...updates };
    config.thresholds = merged;
    saveLocalConfig(config);
    console.log('⚙️ Thresholds updated:', merged);
    return merged;
}

/**
 * How often a standby asks its main server what changed, in seconds, and how often it re-reads everything, in minutes
 * (0: never routinely). Bounded both ways (#1984 review N2): under 5 s is a busy loop against the main server, and an
 * interval past Node's timer (about 24.8 days) fires at once, so the puller would loop with no wait; long before that
 * the standby has silently stopped copying. The route refuses outside these, and the puller reads a stored value
 * through them.
 */
export const MIN_BACKUP_PULL_SECONDS = 5;
export const MAX_BACKUP_PULL_SECONDS = 3600;
export const MAX_BACKUP_RECONCILE_MINUTES = 1440;
export const clampBackupPullSeconds = (s: number): number => Math.min(MAX_BACKUP_PULL_SECONDS, Math.max(MIN_BACKUP_PULL_SECONDS, Math.round(s)));
export const clampBackupReconcileMinutes = (m: number): number => Math.min(MAX_BACKUP_RECONCILE_MINUTES, Math.max(0, Math.round(m)));

/** Why a cadence change is refused, or null: each given value is null (back to .env or the default) or a whole number in bounds. */
export function backupCadenceRefusal(updates: { pullSeconds?: unknown; reconcileMinutes?: unknown }): string | null {
    const { pullSeconds: s, reconcileMinutes: m } = updates;
    if (s !== undefined && s !== null && !(Number.isInteger(s) && (s as number) >= MIN_BACKUP_PULL_SECONDS && (s as number) <= MAX_BACKUP_PULL_SECONDS)) {
        return `pullSeconds must be a whole number of seconds from ${MIN_BACKUP_PULL_SECONDS} to ${MAX_BACKUP_PULL_SECONDS}, or null for the default`;
    }
    if (m !== undefined && m !== null && !(Number.isInteger(m) && (m as number) >= 0 && (m as number) <= MAX_BACKUP_RECONCILE_MINUTES)) {
        return `reconcileMinutes must be a whole number of minutes from 0 (off) to ${MAX_BACKUP_RECONCILE_MINUTES}, or null for the default`;
    }
    return null;
}

/**
 * Update the backup pull cadence (delta poll seconds and/or full-reconcile minutes).
 * Read live by the backup puller on its next tick, so a change takes effect without a
 * restart. `null` clears an override (falls back to env/default); a number sets it;
 * reconcileMinutes = 0 disables the routine full reconcile. Values are clamped to the
 * bounds above (the route refuses outside them; this is for any other caller).
 */
export function updateBackupCadence(updates: { pullSeconds?: number | null; reconcileMinutes?: number | null }): { backupPullSeconds: number | null; backupReconcileMinutes: number | null } {
    const config = getLocalConfig();
    if (updates.pullSeconds !== undefined) {
        const val = updates.pullSeconds === null ? null : Math.round(updates.pullSeconds);
        config.backupPullSeconds = (val !== null && Number.isFinite(val)) ? clampBackupPullSeconds(val) : null;
    }
    if (updates.reconcileMinutes !== undefined) {
        const val = updates.reconcileMinutes === null ? null : Math.round(updates.reconcileMinutes);
        config.backupReconcileMinutes = (val !== null && Number.isFinite(val)) ? clampBackupReconcileMinutes(val) : null;
    }
    saveLocalConfig(config);
    console.log('⚙️ Backup cadence updated:', { backupPullSeconds: config.backupPullSeconds, backupReconcileMinutes: config.backupReconcileMinutes });
    return { backupPullSeconds: config.backupPullSeconds ?? null, backupReconcileMinutes: config.backupReconcileMinutes ?? null };
}

/**
 * The gateway as stored, over its defaults. Its one switch is `servePwa`: a switch that is gone (gateway.ts
 * REMOVED_GATEWAY_SWITCHES) is never read here, and is carried over and dropped from the file once at boot
 * (config/community-shape-upgrade.ts).
 */
export function getGatewayConfig(): GatewayConfig {
    const config = getLocalConfig();
    const stored = config.gateway?.features as Partial<GatewayConfig['features']> | undefined;
    return {
        ...DEFAULT_GATEWAY_CONFIG,
        ...(config.gateway || {}),
        features: {
            servePwa: typeof stored?.servePwa === 'boolean' ? stored.servePwa : DEFAULT_GATEWAY_CONFIG.features.servePwa,
        },
        rateLimiting: {
            ...DEFAULT_GATEWAY_CONFIG.rateLimiting,
            ...(config.gateway?.rateLimiting || {}),
        },
    };
}

export function updateGatewayConfig(updates: Partial<GatewayConfig>): GatewayConfig {
    const config = getLocalConfig();
    const current = getGatewayConfig();
    
    const merged: GatewayConfig = {
        ...current,
        ...updates,
        features: {
            servePwa: typeof updates.features?.servePwa === 'boolean' ? updates.features.servePwa : current.features.servePwa,
        },
        rateLimiting: {
            ...current.rateLimiting,
            ...(updates.rateLimiting || {}),
        },
    };

    config.gateway = merged;
    saveLocalConfig(config);
    console.log('⚙️ Gateway configuration updated:', merged);
    return merged;
}

