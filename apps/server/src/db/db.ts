import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedPricingGuideIfEmpty } from './pricing-guide-db.js';
import { avatarUrlOf, formatHundredths, isHundredths, isPastDeadline, isSelfAvatarUrl, isSyntheticAccount, replaceLoneSurrogates, word } from '@beanpool/core';
import { registerGeoFunctions, installNameFold, foldName, projectRowName, setMemberPhoto, closeWashSnapshotHandle } from '@beanpool/engine';
import { stripImageValue } from '../storage/image-metadata.js';
import { getNodeRole, assertLedgerWritable } from '../config/node-role.js';
import { PLAIN_TABLES, plainTableTriggers } from '../engine/replication-manifest.js';
import { createTableText, checkRules } from './table-rules.js';
import { swapStagedCopyAtBoot } from './swap-at-boot.js';
import { readSchemaGate, writeSchemaStamp } from './schema-gate.js';
import { getVersion } from '../version.js';
import { assertEnterpriseText } from '../engine/enterprise-text.js';
import { upgradeBreakGlassHashes } from '../break-glass-code.js';
import { assertMayStorePhotoBytes, incomingPhotoBytes, incomingPhotosBytes, recordStoredPhotoBytes } from '../engine/photo-upload-budget.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'state.db');

// A standby's whole copy made ready in data/staging is swapped in first (db/swap-at-boot.ts), by rename, before this
// process opens the database, whichever module imported this one first: a rename under an open connection would leave
// this process writing to the file it replaced.
swapStagedCopyAtBoot(DATA_DIR);

// Initialize Database connection
export const db: Database.Database = new Database(DB_PATH);
// `haversine_km`, for the posts listing searched by distance (G4). A function lives on the connection, not in the file,
// and this is the one connection that runs the listing; the read-only handles opened on backups and snapshots never do.
registerGeoFunctions(db);
// `name_fold`, the one rule by which two member names are the same name, and the TEMP triggers that write callsign_fold
// from it (names.ts in the engine), on this connection: TEMP, never in the file, so no writer here can forget the fold
// and an older image or the sqlite3 shell never meets a function it doesn't have (#1956).
installNameFold(db);

const pendingPostCommitHooks: (() => void)[] = [];

let postCommitDepth = 0;
const postCommitBatchOver: (() => void)[] = [];

/**
 * Runs `fn` once the batch of post-commit hooks now running is over (a hook's own transaction runs its hooks inside the
 * batch), or at once when none is running. For state that belongs to one batch of after-commit work and must not reach
 * unrelated work later in the same event-loop turn (state-engine.ts sweepRepayment's).
 */
export function whenPostCommitBatchOver(fn: () => void): void {
    if (postCommitDepth === 0) fn();
    else postCommitBatchOver.push(fn);
}

export function afterTransactionCommit(fn: () => void): void {
    if (!(db as any).inTransaction) {
        fn();
    } else {
        pendingPostCommitHooks.push(fn);
    }
}

function wrapTxnFn(origFn: any) {
    if (typeof origFn !== 'function') return origFn;
    const wrapped = function (this: any, ...args: any[]) {
        const isOuter = !(db as any).inTransaction;
        const hookCountBefore = pendingPostCommitHooks.length;
        try {
            const res = origFn.apply(this, args);
            if (isOuter && pendingPostCommitHooks.length > 0) {
                const hooks = pendingPostCommitHooks.splice(0, pendingPostCommitHooks.length);
                postCommitDepth++;
                try {
                    for (const hook of hooks) {
                        try { hook(); } catch (e) { console.error('[DB] Post-commit hook failed:', e); }
                    }
                } finally { postCommitDepth--; }
                if (postCommitDepth === 0) {
                    for (const over of postCommitBatchOver.splice(0, postCommitBatchOver.length)) {
                        try { over(); } catch (e) { console.error('[DB] Post-commit batch end failed:', e); }
                    }
                }
            }
            return res;
        } catch (err) {
            pendingPostCommitHooks.length = hookCountBefore;
            throw err;
        }
    };
    return wrapped;
}

/**
 * For a catch inside a transaction that leaves one row out and goes on (a copied row this table's rules refuse): rethrows
 * unless the error is that row's own and the transaction is still open. SQLite rolls the WHOLE transaction back on some
 * errors (a disk that is full or failing, a trigger's RAISE(ROLLBACK)), and every write after that would commit on its
 * own, one by one: a standby's copy refused, and part of it landed anyway. A disk, memory or lock error is never one
 * row's, whether or not the transaction survived it.
 */
export function rethrowUnlessRowRefused(e: unknown): void {
    if (!(db as any).inTransaction) throw e;
    const code = (e as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && NOT_A_ROWS_ERROR.test(code)) throw e;
}
const NOT_A_ROWS_ERROR = /^SQLITE_(IOERR|FULL|NOMEM|CORRUPT|NOTADB|READONLY|BUSY|LOCKED|INTERRUPT|CANTOPEN|PROTOCOL|ABORT|PERM)/;

const origTransaction = db.transaction.bind(db);
db.transaction = function (fn: any) {
    const txn = origTransaction(fn);
    const wrapped: any = wrapTxnFn(txn);
    wrapped.default = wrapTxnFn(txn.default);
    wrapped.deferred = wrapTxnFn(txn.deferred);
    wrapped.immediate = wrapTxnFn(txn.immediate);
    wrapped.exclusive = wrapTxnFn(txn.exclusive);
    return wrapped;
} as any;

// A2-1: the in-memory LedgerManager (in state-engine) is the source of truth for
// balance checks — getBalance/transfer read it, and transfer writes it back over
// the accounts table. A few crowdfund operations below mutate accounts.balance_c
// directly via raw SQL, outside the ledger. Without a resync the in-memory ledger
// goes stale and the next transfer() clobbers the DB with the stale value,
// ERASING the raw-SQL mutation (credit minting / pledge-debit loss). state-engine
// registers reconcileLedgerFromDb() here so any such mutation re-syncs the ledger
// from the DB. Because db.ts is the lower-level module (state-engine imports db,
// not vice-versa), the dependency is inverted via a hook to avoid a module cycle.
let onBalanceMutation: (() => void) | null = null;
export function setBalanceMutationHook(fn: (() => void) | null): void {
    onBalanceMutation = fn;
}

// #138: the mirror of the hook above, and it must run BEFORE the mutation rather than after.
//
// The raw-SQL writes below also RAISE balances — the escrow sweep to a project creator, a refund to every
// backer of a deleted project — and `balance = balance + ?` leaves `last_demurrage_epoch` untouched. Since
// demurrage is principal × time × rate, an account with a stale window then has that whole interval charged
// against its new, larger balance on the next read: a creator who has not traded for months is taxed on the
// amount their community just raised for them. Measured at the core level, a 60-day window over a balance of
// 200.005 receiving 10,000 costs 465.33 beans.
//
// state-engine registers settleDemurrage() here — it charges what the old principal actually owes and
// persists the closed window, so the credit lands on a settled row. Inverted through a hook for the same
// reason as onBalanceMutation: state-engine imports db, not the other way round.
let onSettleDemurrage: ((publicKeys: string[]) => void) | null = null;
export function setDemurrageSettleHook(fn: ((publicKeys: string[]) => void) | null): void {
    onSettleDemurrage = fn;
}

// The node profile's Beans switch (config/node-profile.ts), for the raw-SQL pledge below: on a node with Beans off
// it throws before a row is written. state-engine registers it; inverted for the same module-cycle reason.
let assertMoneyMayMove: (() => void) | null = null;
export function setMoneyGuardHook(fn: (() => void) | null): void {
    assertMoneyMayMove = fn;
}

// Whether a key is an owner or admin of the node who may act (state-engine.ts isAdminPubkey), for a project's cancel
// (mayCancelProject). state-engine registers it; inverted for the same module-cycle reason. Unregistered, nobody is.
let isNodeAdminKey: ((publicKey: string) => boolean) | null = null;
export function setNodeAdminCheckHook(fn: ((publicKey: string) => boolean) | null): void {
    isNodeAdminKey = fn;
}

// A project's cancel (deleteCrowdfundProject) refunds its backers but a closed account, whose share goes to the Commons as
// the return of an unfunded project's pledges sends it: which account is closed (engine/stranded-pledges.ts
// isClosedAccount), that move (engine/unfunded-pledges.ts closedPledgeToCommons), and the conserving transaction all of
// the cancel's moves run in (state-engine.ts conservingTransaction). state-engine registers them; inverted for the same
// module-cycle reason. Unregistered, a cancel that would refund anyone is refused.
export interface ProjectCancelLedger {
    conservingTransaction: <T>(fn: () => T) => T;
    isClosedAccount: (publicKey: string) => boolean;
    closedPledgeToCommons: (escrow: string, projectId: string, amount: number) => void;
}
let projectCancelLedger: ProjectCancelLedger | null = null;
export function setProjectCancelLedgerHook(hooks: ProjectCancelLedger | null): void {
    projectCancelLedger = hooks;
}

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
// Zero what is deleted or replaced, where it lay, rather than leaving it in the file's free space for anyone who copies
// state.db: a re-deposit's dropped recovery copy, a copy a member removed, a purged member's rows, what a standby's
// import replaces and a force-resync clears. ON, not FAST: FAST leaves whole freed pages as they were. The connection
// default was off, so the recovery seal clears what was deleted before this once (services/recovery-seal-key.ts).
db.pragma('secure_delete = ON');

// Cheap "has the ledger changed?" probe for the backup snapshot endpoint.
// PRAGMA data_version only increments for changes made by OTHER connections, and
// every server write goes through the main `db` handle above — so a separate
// read-only connection sees exactly the writes we care about. Lazy so tests and
// tooling that never serve snapshots don't open a second handle.
let changeProbe: Database.Database | null = null;
export function getDbDataVersion(): number {
    if (!changeProbe) changeProbe = new Database(DB_PATH, { readonly: true });
    return changeProbe.pragma('data_version', { simple: true }) as number;
}
/**
 * Close the probe, for a restore about to replace state.db (routes/backup.ts). While it is open, closing `db` is not the
 * last close, so SQLite leaves state.db-wal behind unfolded, and the next open plays it over whatever file is put there.
 * The wash analysis's read-only handle (engine trust.ts runWashAnalysisInSlices) closes with it, for the same reason: a
 * refresh reading through it then lands nothing, and the next opens a new one.
 */
export function closeDbDataVersionProbe(): void {
    try { changeProbe?.close(); } catch { /* closed either way */ }
    changeProbe = null;
    closeWashSnapshotHandle(db);
}
// A2-31 / SRV-7 — ACCEPTED RISK (documented, intentional): FK enforcement is OFF so
// out-of-order P2P/backup sync can insert rows whose referenced parent hasn't
// arrived yet (e.g. a transaction before its account, a message before its
// conversation). Referential integrity is therefore by convention; orphan rows are
// possible. Do NOT flip this to ON without first auditing existing data and adding a
// periodic orphan sweep — enabling it naively would make legitimate sync imports
// fail mid-transaction.
db.pragma('foreign_keys = OFF');

/**
 * Record a hard-delete in the tombstones table so delta-sync can propagate it.
 * `rowKey` is the serialized primary key — for compound keys, join components
 * with `|` (e.g. `${ownerPubkey}|${friendPubkey}`). INSERT OR REPLACE means
 * re-deleting a re-created row just refreshes the tombstone timestamp.
 */
export function writeTombstone(tableName: string, rowKey: string): void {
    db.prepare(
        `INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    ).run(tableName, rowKey);
}

/**
 * How long every server keeps a tombstone (design scratch/global-node/DESIGN-replica-flood-bounds-opus.md §6.3 T6). A delta
 * carries a delete only as its tombstone, so a standby whose cursor is older than this has missed deletes its main server
 * no longer holds: it takes a force-resync instead of a delta (services/backup-puller.ts).
 */
export const TOMBSTONE_RETENTION_DAYS = 30;
export const TOMBSTONE_RETENTION_MS = TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Drops the tombstones older than TOMBSTONE_RETENTION_MS, whatever this server's role (connector-manager.ts, daily). No
 * floor from the pull cursors: only this server's own puller writes one (`backup:primary`), so a promoted server's last
 * pull kept every tombstone written after its take-over, for good, and a standby whose copies were refused for longer than
 * this kept every one newer than its last copy that landed. Returns how many went.
 */
export function pruneTombstones(now = Date.now()): number {
    return db.prepare('DELETE FROM tombstones WHERE deleted_at < ?').run(new Date(now - TOMBSTONE_RETENTION_MS).toISOString()).changes;
}

/**
 * Deletes the rows of a plain table (engine/replication-manifest.ts PLAIN_TABLES) that `where` matches, each with a
 * tombstone keyed by its primary key's values joined with `|` (engine/plain-tables.ts plainRowKey), so a standby deletes
 * them too: a delta carries a delete only as its tombstone. A row the table's RowRule doesn't hold (a phone of a key that
 * isn't a member's) never travelled, and goes with none, so no key can fill a copy with them. `table` and `where` are
 * the caller's own SQL, never a value; `args` fill the `where`. Returns how many rows went.
 */
export function deletePlainRows(table: string, where: string, ...args: unknown[]): number {
    const key = (db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk').all(table) as { name: string }[]).map((c) => c.name);
    const spec = PLAIN_TABLES.find((t) => t.table === table);
    if (!spec || key.length === 0) throw new Error(`${table} is no plain table with a key`);
    const travelled = spec.where ? `(${spec.where})` : '1';
    return db.transaction(() => {
        // Which rows travelled, read before the delete: the rule may read the row's own columns.
        const rows = db.prepare(`SELECT ${key.join(', ')}, ${travelled} AS travelled FROM ${table} WHERE ${where}`).raw().all(...args) as unknown[][];
        const gone = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args).changes;
        for (const r of rows) if (r[key.length]) writeTombstone(table, r.slice(0, key.length).map((v) => String(v)).join('|'));
        return gone;
    })();
}

/**
 * A person's row with no record of joining (members.is_visitor, markExistingVisitors). Every way in writes one: an
 * invite and an offline ticket write the inviter's key into `invited_by` and the code into `invite_code` (and use the
 * code, `invite_codes.used_by`), the open door `open:<provider>` and an `open_joins` row, the genesis member `genesis`,
 * and each joiner has a `member_joined` line in the activity feed. The only row written with none of these is
 * registerVisitor's, and it has been so since the first public release. Not an enterprise's row (`is_treasury`), which
 * no key holds, nor the SYSTEM account.
 */
const NO_RECORD_OF_JOINING = `
    COALESCE(m.is_treasury, 0) = 0
    AND m.public_key NOT IN ('SYSTEM', 'genesis')
    AND COALESCE(m.invited_by, '') = ''
    AND COALESCE(m.invite_code, '') = ''
    AND NOT EXISTS (SELECT 1 FROM invite_codes i WHERE i.used_by = m.public_key)
    AND NOT EXISTS (SELECT 1 FROM open_joins o WHERE o.member_pubkey = m.public_key)
    AND NOT EXISTS (SELECT 1 FROM node_roles r WHERE r.member_pubkey = m.public_key)
    AND NOT EXISTS (SELECT 1 FROM activity_feed a WHERE a.event_type = 'member_joined' AND a.actor_pubkey = m.public_key)`;

/**
 * Signs that the person behind a row with no record of joining uses this node as their community, which a visitor
 * never needs: a profile set up here (a photo, a bio, contact details, or any profile edit) or an invite made. A
 * visitor who took an invite before this version was answered "already a member", kept its visitor row, and then set
 * up its profile in the join wizard; these keep that person a member.
 */
const USED_AS_A_MEMBER = `
    m.avatar_ref IS NOT NULL OR COALESCE(m.bio, '') != '' OR COALESCE(m.contact_value, '') != ''
    OR m.profile_updated_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM invite_codes c WHERE c.created_by = m.public_key)`;

/** node_config: this node's visitors' rows are marked, by its own pass or by its main server's (markExistingVisitors). */
const VISITORS_MARKED = 'migration_mark_visitors_v1';

/** Whether this node's visitors' rows are marked (VISITORS_MARKED): the sync export tells a standby so. */
export function visitorsMarked(): boolean {
    return !!db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(VISITORS_MARKED);
}

/**
 * VISITORS_MARKED's value on a standby that has its main server's word but not yet a whole copy since (4110436371): the
 * rows it copied before it had the column carry no mark, the main server never stamps them again, and only a whole copy
 * brings them (engine/sync.ts's member import takes the mark at the same stamp). Its puller asks for one; then 'copied'.
 */
const MARKS_BEFORE_WHOLE_COPY = 'copied, whole copy to come';

/**
 * A standby's import, when its main server's copy says its visitors are marked: the marks are the main server's, so this
 * node never runs the pass itself, not even once promoted, where it would judge on less than its main server did.
 */
export function noteVisitorsMarkedByMainServer(): void {
    db.prepare('INSERT OR IGNORE INTO node_config (key, value) VALUES (?, ?)').run(VISITORS_MARKED, MARKS_BEFORE_WHOLE_COPY);
}

/** A standby's puller, before a pull: whether it still wants a whole copy of its main server's marks (above). */
export function visitorMarksWantWholeCopy(): boolean {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(VISITORS_MARKED) as { value: string } | undefined;
    return row?.value === MARKS_BEFORE_WHOLE_COPY;
}

/** A standby's puller, after importing a whole copy from a main server whose visitors are marked: every row has its mark. */
export function noteWholeCopyOfVisitorMarks(): void {
    db.prepare("UPDATE node_config SET value = 'copied' WHERE key = ? AND value = ?").run(VISITORS_MARKED, MARKS_BEFORE_WHOLE_COPY);
}

/**
 * Marks the visitors' rows a node already holds, once: the first boot with members.is_visitor (node_config
 * `migration_mark_visitors_v1`, written in the same transaction, so a crash leaves it to run again). A row is marked
 * when it has no record of joining (NO_RECORD_OF_JOINING) and no sign of being used as a member (USED_AS_A_MEMBER).
 *
 * The safe side is that no member is ever made a visitor by mistake, so anything ambiguous stays a member: a row with no
 * record of joining that shows a sign of use is kept, and counted in the log as such. A member wrongly marked would
 * still hold their account, Beans and history, and joining with an invite makes the same row a member's again. Each
 * marked row's updated_at is stamped, so delta sync takes the mark to a standby.
 *
 * Never on a standby (NODE_ROLE=backup, 4110268549): its copy lacks the node roles the rule reads (the take-over bundle
 * brings them, sealed), and its stamp would outlive its main server's answer. It writes no marker either: its main server's marks reach it by delta sync, with the main's word
 * that they are made (noteVisitorsMarkedByMainServer), then one whole copy for the rows it copied before it had the
 * column (visitorMarksWantWholeCopy); promoted before that whole copy, it logs so at boot. A standby promoted without
 * that word (its main server predates the column, so nobody ever marked) runs the pass at its first boot as the main
 * server, or when a take-over finishes at boot (services/takeover.ts), on what it holds: what that older main server
 * copied of the members' rows, the open door's record, invites and the activity feed (a main server copies them all
 * since designs G2a, G3 and G4, which came after the column), and, after a take-over, the node roles it brings.
 */
export function markExistingVisitors(): void {
    try {
        if (visitorsMarked()) {
            if (getNodeRole() === 'primary' && visitorMarksWantWholeCopy()) {
                console.warn("[DB] ⚠️ Visitors' rows: this server was promoted from a standby before it took the whole copy of its main server "
                    + 'that brings every visitor\'s mark. A visitor whose row it copied before this version may read as a member here.');
            }
            return;
        }
        if (getNodeRole() === 'backup') {
            console.log("[DB] Visitors' rows: a standby marks none itself; its main server's marks arrive with its copies");
            return;
        }
        db.transaction(() => {
            const marked = db.prepare(`
                SELECT m.public_key FROM members m WHERE m.is_visitor = 0 AND ${NO_RECORD_OF_JOINING} AND NOT (${USED_AS_A_MEMBER})
            `).all() as { public_key: string }[];
            const kept = (db.prepare(`
                SELECT COUNT(*) AS n FROM members m WHERE m.is_visitor = 0 AND ${NO_RECORD_OF_JOINING} AND (${USED_AS_A_MEMBER})
            `).get() as { n: number }).n;
            const mark = db.prepare(`UPDATE members SET is_visitor = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`);
            for (const r of marked) mark.run(r.public_key);
            db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES (?, '1')").run(VISITORS_MARKED);
            if (marked.length > 0 || kept > 0) {
                console.log(`[DB] Visitors' rows marked: ${marked.length}${marked.length > 0 ? ` (${marked.slice(0, 20).map(r => r.public_key.slice(0, 12)).join(', ')}${marked.length > 20 ? ', …' : ''})` : ''}; `
                    + `kept as members, with no record of joining but used as a member here: ${kept}`);
            }
        })();
    } catch (e) {
        // Nobody is marked and the marker isn't written, so the next boot tries again; until then visitors read as
        // members, as they did before this version.
        console.error('[DB] ❌ Could not mark visitors\' rows:', e);
    }
}

/** node_config: this node's members rows keep the fresh schema's rules (bringMembersToSchemaRules). */
export const MEMBERS_SCHEMA_RULES = 'migration_members_schema_rules_v1';

/**
 * Brings this node's members rows into the rules a fresh install's table has (schema.sql's CHECKs on members, read from its
 * text, db/table-rules.ts), once: the first boot with this pass (node_config `migration_members_schema_rules_v1`, written
 * in the same transaction). A node whose members table predates a column got it from an ALTER above with no CHECK
 * (`goal_amount`, `lifecycle`, `paused`: Slice 3's), so its rows can hold what a fresh table refuses: a goal below 0 was
 * accepted by `POST /api/treasury` until it refused one. Such a value is set to the column's default (a goal to none,
 * `lifecycle` to 'ongoing', `paused` to 0), as a new row would hold it; a rule over several columns (the pin's latitude
 * and longitude) sets each it names. The touch triggers stamp each changed row, so a delta takes it to a standby, whose
 * table refuses the old value (engine/sync.ts writeMemberStanding leaves it out and the whole-copy check reports it).
 * A fresh install changes nothing and writes the marker. Never on a standby: its rows are its main server's, which its
 * import alone writes; it writes no marker either, so once promoted it runs this at its first boot as the main server.
 */
function bringMembersToSchemaRules(schemaSql: string): void {
    try {
        if (getNodeRole() === 'backup') return;
        if (db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(MEMBERS_SCHEMA_RULES)) return;
        const fresh = createTableText(schemaSql, 'members');
        if (!fresh) throw new Error('schema.sql declares no members table');
        const info = db.prepare('SELECT name, dflt_value FROM pragma_table_info(?)').all('members') as { name: string; dflt_value: string | null }[];
        const defaults = new Map(info.map((c) => [c.name, c.dflt_value ?? 'NULL']));
        const rules = checkRules(fresh, info.map((c) => c.name));
        const changed: string[] = [];
        db.transaction(() => {
            for (const rule of rules) {
                const set = rule.columns.map((c) => `"${c}" = ${defaults.get(c)}`).join(', ');
                const n = db.prepare(`UPDATE members SET ${set} WHERE CAST((${rule.expr}) AS NUMERIC) = 0`).run().changes;
                if (n > 0) changed.push(`${n} × ${rule.columns.join('/')}`);
            }
            db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES (?, '1')").run(MEMBERS_SCHEMA_RULES);
        })();
        if (changed.length > 0) console.log(`[DB] Members rows brought into the schema's rules (set to the column's default): ${changed.join(', ')}`);
    } catch (e) {
        // Nothing is changed and the marker isn't written, so the next boot tries again. A standby leaves such a value out.
        console.error('[DB] ❌ Could not bring members rows into the schema\'s rules:', e);
    }
}

/** Where movePlainPushTablesAside puts a push_tokens from before, tokens in the clear, until the boot locks or drops its rows. */
export const PLAIN_PUSH_TOKENS = 'push_tokens_plain';
/** And its leave statements, which named each token in the clear too. */
export const PLAIN_PUSH_LEAVES = 'push_token_leaves_plain';

/**
 * Before schema.sql runs: a push_tokens or push_token_leaves from before (a `token` column: each phone's token in the
 * clear, and in the key) is moved aside as it is, into PLAIN_PUSH_TOKENS and PLAIN_PUSH_LEAVES, and dropped with its
 * indexes and triggers, so schema.sql makes the new tables and stampPlainTables their triggers. One transaction: a server
 * stopped part way has moved nothing. Needs no key and no role: the boot locks the rows under the key, on a main server,
 * or drops them, on a standby (services/push-token-seal.ts installPushTokenSealAtBoot). Leaves anything else as it is.
 */
function movePlainPushTablesAside(): void {
    const hasTable = (name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    const hasColumn = (table: string, column: string) => !!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
    const tokens = hasTable('push_tokens') && hasColumn('push_tokens', 'token');
    const leaves = hasTable('push_token_leaves') && hasColumn('push_token_leaves', 'token');
    if (!tokens && !leaves) return;
    db.transaction(() => {
        if (tokens) {
            db.exec(`CREATE TABLE IF NOT EXISTS ${PLAIN_PUSH_TOKENS} (public_key TEXT, token TEXT, platform TEXT, created_at TEXT, registered_at INTEGER)`);
            const registered = hasColumn('push_tokens', 'registered_at') ? 'registered_at' : 'NULL';
            db.exec(`INSERT INTO ${PLAIN_PUSH_TOKENS} (public_key, token, platform, created_at, registered_at)
                SELECT public_key, token, platform, created_at, ${registered} FROM push_tokens`);
            db.exec('DROP TABLE push_tokens');
        }
        if (leaves) {
            db.exec(`CREATE TABLE IF NOT EXISTS ${PLAIN_PUSH_LEAVES} (public_key TEXT, token TEXT, left_at INTEGER, applied_at TEXT)`);
            db.exec(`INSERT INTO ${PLAIN_PUSH_LEAVES} (public_key, token, left_at, applied_at)
                SELECT public_key, token, left_at, applied_at FROM push_token_leaves`);
            db.exec('DROP TABLE push_token_leaves');
        }
    })();
    console.log('[DB] Moved the push tokens stored in the clear aside: the boot locks them (a standby drops them).');
}

/**
 * Whether a member has a photo this node serves: its reference in the row (`avatar_ref`), which setMemberPhoto, the one
 * writer of a member's photo, keeps with the photo in member_photos. The marketplace's photo gates read this.
 */
export function memberHasPhoto(publicKey: string): boolean {
    const row = db.prepare('SELECT avatar_ref FROM members WHERE public_key = ?').get(publicKey) as { avatar_ref: string | null } | undefined;
    return !!row?.avatar_ref;
}

/**
 * The file refused at open (db/schema-gate.ts): one line, and the process stops, before anything has written to it.
 */
function refuseToOpen(line: string): never {
    console.error(line);
    process.exit(1);
}

/**
 * The gate alone, for the node's first step (index.ts main), before any boot step that may log: the logger writes its lines
 * to system_logs, and a refused file must be left exactly as it was. initSchema asks the gate again for its own callers.
 */
export function refuseUnopenableDatabase(): void {
    const gate = readSchemaGate(db);
    if (gate.kind === 'refused') refuseToOpen(gate.line);
}

/**
 * The boot's schema work, at every start (state-engine.ts initStateEngine). The gate first (db/schema-gate.ts): a file this
 * release may not open is refused before anything writes. Then the schema steps born since 1.4.0, schema.sql, and the
 * passes every boot runs. The stamp is written last, once all of it has run, so `schema_release` names the release whose
 * steps ran on this file in full.
 */
export function initSchema() {
    const gate = readSchemaGate(db);
    if (gate.kind === 'refused') refuseToOpen(gate.line);
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    // A fresh install: schema.sql and the stamp in one transaction, so a first boot stopped part way leaves no half-made
    // file, which the gate would refuse. Everything below then runs as on any later boot, and finds nothing to do.
    if (gate.kind === 'fresh') db.transaction(() => { db.exec(schemaSql); writeSchemaStamp(db, getVersion()); })();

    // ── The schema steps born since 1.4.0 ─────────────────────────────────────────────────────────────────────────────
    // The gate opens a file 1.4.0 or later last started (db/schema-gate.ts). These bring one from 1.4.0 to this release's
    // shape, and do nothing on a file that has it. Before the schema.sql exec, which may index their columns: CREATE INDEX
    // on a missing column stops the whole exec (test-schema-upgrade-fresh-shape.ts holds every column schema.sql names to
    // that). (The steps born between 1.2.36 and 1.4.0, the hundredths step among them, were log rows CUT2, B10 and B11,
    // removed once every kept node had started 1.4.0.)

    // Born with Local knowledge (slice K1; DESIGN-local-knowledge-fable.md §4.1, §4.4): seven columns on posts, empty on every
    // row that is there (knowledge_helped takes its default, 0). Additions, not conversion code (Marty's pick 6, 11 Nov
    // 2026): nothing is read or rewritten. On a fresh install each finds its column and does nothing.
    for (const column of ['knowledge_sources TEXT', 'knowledge_place TEXT', 'knowledge_lang TEXT', 'knowledge_checked_at TEXT',
        'knowledge_outdated_at TEXT', 'knowledge_outdated_note TEXT', 'knowledge_helped INTEGER NOT NULL DEFAULT 0']) {
        try { db.prepare(`ALTER TABLE posts ADD COLUMN ${column}`).run(); } catch { }
    }

    // Born with per-item prices (DESIGN-per-item-price-fable.md §3, §6; Marty's Q5, 12 Nov 2026): four empty columns, each with
    // schema.sql's own CHECK, NULL on every row that is there. Nothing is read, filled in or rewritten: a listing becomes
    // per-item only by its seller's own edit. On a fresh install each finds its column and does nothing.
    // CONVERSION CODE (schema step), log row PERITEM-S1, remove in the release after the one that ships per-item.
    try { db.prepare(`ALTER TABLE posts ADD COLUMN units_left INTEGER CHECK (units_left IS NULL OR (units_left >= 0 AND units_left <= 9999))`).run(); } catch { }
    // CONVERSION CODE (schema step), log row PERITEM-S2, remove in the release after the one that ships per-item.
    try { db.prepare(`ALTER TABLE posts ADD COLUMN lot_price_c INTEGER CHECK (lot_price_c IS NULL OR lot_price_c > 0)`).run(); } catch { }
    // CONVERSION CODE (schema step), log row PERITEM-S3, remove in the release after the one that ships per-item.
    try { db.prepare(`ALTER TABLE posts ADD COLUMN lot_units INTEGER CHECK (lot_units IS NULL OR lot_units >= 2)`).run(); } catch { }
    // CONVERSION CODE (schema step), log row PERITEM-S4, remove in the release after the one that ships per-item.
    try { db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN item_option TEXT CHECK (item_option IS NULL OR item_option IN ('each', 'lot'))`).run(); } catch { }

    // Born with the community's name on its members' listings on the global community (list-on-global G5): one empty column on
    // the directory mirror's cache, with schema.sql's own CHECK, NULL on every row that is there, which reads as on. Nothing is
    // read, filled in or rewritten: the mirror's next run writes it where a community says false. An addition, as Local
    // knowledge's are (Marty's pick 6, 11 Nov 2026). On a fresh install it finds its column and does nothing.
    try { db.prepare(`ALTER TABLE directory_cache ADD COLUMN listings_from_here INTEGER CHECK (listings_from_here IS NULL OR listings_from_here IN (0, 1))`).run(); } catch { }

    // An older conversion pass not yet removed: it finds nothing to do on a file the gate opens (every kept node ran it;
    // MEASURE-conversion-code.md M2), and goes in its own removal with the seal's half (the split-off N1b lists it). Push
    // tokens stored in the clear go aside for the boot to lock or drop (services/push-token-seal.ts, A25).
    try {
        movePlainPushTablesAside();
    } catch (e) {
        console.error('[DB] ❌ Could not move the push tokens stored in the clear aside; the next boot tries again:', e);
    }

    db.exec(schemaSql);
    // The name fold's TEMP triggers (the one write path of members.callsign_fold): the call where this connection opened
    // made none on a fresh install, which had no members table yet. On any other file they are there already, and this
    // does nothing (CREATE TEMP TRIGGER IF NOT EXISTS).
    installNameFold(db);

    // The passes still run at every boot after the exec, each its own guard. markExistingVisitors and
    // bringMembersToSchemaRules write their node_config marker on a fresh install and find it on every kept node (A32,
    // A35); the enterprise threads (A19) wait on the read of the create paths; the break-glass hashes (A29) find none
    // in the old form. Each goes in its own removal.
    markExistingVisitors();
    bringMembersToSchemaRules(schemaSql);
    // Enterprise discussion threads (docs/the-commons.md §2.2, Slice 6). created_at is when the row is written, not the
    // enterprise's joined_at: the delta backup exporter cursors conversations on created_at, so a back-dated row would never
    // reach a replica (#837 review).
    try {
        db.prepare(`
            INSERT OR IGNORE INTO conversations (id, type, name, created_by, created_at)
            SELECT public_key, 'enterprise_thread', callsign, public_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            FROM members
            WHERE is_treasury = 1
        `).run();
    } catch { }
    upgradeBreakGlassHashesAtBoot();
    seedPricingGuideOnMainServer();

    // Last: the plain tables' watermark triggers, made again at every boot, then the rule's start and the stamp.
    stampPlainTables();
    stampBalanceRuleFrom();
    writeSchemaStamp(db, getVersion());
}

/**
 * The moment the rule on what the admins can see started here (config/balance_c-rule.ts): this first boot, no notice. Written
 * once on a main server and never moved: INSERT OR IGNORE, so a restart or a later boot changes nothing. Writes node_config
 * only and reads no balance_c (a read at boot, before the exemptions, destroys Beans: #2313). A standby writes none: its take-over brings its
 * main server's (config/community-settings.ts), or, from a main server older than the rule, this runs as it takes over.
 * A failure leaves no row, which lists nobody on the rule (engine/community-health.ts), and the next boot tries again.
 */
function stampBalanceRuleFrom(): void {
    if (getNodeRole() === 'backup') return;
    try {
        db.prepare(`INSERT OR IGNORE INTO node_config (key, value) VALUES ('balance_rule_from', ?)`)
            .run(new Date().toISOString());
    } catch (e) {
        console.error('[DB] ❌ Could not stamp when the rule on what the admins can see starts (nobody is listed on it until it does):', e);
    }
}

/**
 * Break-glass codes' hashes still in the old unsalted SHA-256 form become salted scrypt (break-glass-code.ts), at this boot
 * rather than on each code's next use, which may be never; a suspended member's too on a main server.
 */
function upgradeBreakGlassHashesAtBoot(): void {
    try {
        const upgraded = upgradeBreakGlassHashes(db, { suspendedToo: getNodeRole() !== 'backup' });
        if (upgraded) console.log(`[DB] ✅ ${upgraded} break-glass code hash(es) moved from unsalted SHA-256 to scrypt`);
    } catch (e) {
        console.error('[DB] ❌ Could not upgrade the break-glass code hashes (they still work, and the next boot tries again):', e);
    }
}

/**
 * On a main server only: a standby's guide is its main server's, copied (a plain table, design G4), and a server that
 * takes over boots as a main server, which seeds one if the copy brought none.
 */
function seedPricingGuideOnMainServer(): void {
    if (getNodeRole() === 'backup') return;
    try {
        seedPricingGuideIfEmpty(false, db);
    } catch (err) {
        console.error('[DB] ⚠️ Could not seed pricing guide items:', err);
    }
}

/**
 * What initSchema runs only on a main server, run now: for a standby a take-over made the main server in this process, after
 * its database booted as a standby's (services/takeover.ts resumeTakeoverAtBoot, through state-engine.ts
 * becomeMainServerInPlace). The same passes, each idempotent and each its own guard: the visitors' marks, the members'
 * schema rules, the break-glass hashes of suspended members, the pricing guide and the rule's start. Nothing on a standby.
 * Never throws.
 */
export function runMainServerSchemaPasses(): void {
    if (getNodeRole() === 'backup') return;
    markExistingVisitors();
    try {
        bringMembersToSchemaRules(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
    } catch (e) {
        console.error('[DB] ❌ Could not read schema.sql for the members\' schema rules:', e);
    }
    upgradeBreakGlassHashesAtBoot();
    seedPricingGuideOnMainServer();
    stampBalanceRuleFrom();
}

/**
 * The watermark of every plain table (engine/replication-manifest.ts PLAIN_TABLES, design G3): a delta finds each write
 * by it, so every write moves it. For each table, at every boot, the #878 drop-and-recreate pattern: its two triggers are
 * dropped and made again from here, so the ones in force are always these (CREATE TRIGGER IF NOT EXISTS would keep an
 * older shape). An insert that leaves the stamp NULL is stamped; an update that leaves it as it was is stamped, as the
 * Phase 2 triggers do (schema.sql). A standby's import sets both aside while it writes its main server's rows, stamps and
 * all (engine/sync.ts IMPORT_KEEPS_STAMPS).
 */
function stampPlainTables(): void {
    const now = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
    for (const t of PLAIN_TABLES) {
        const { table, watermark } = t;
        const { insert, touch } = plainTableTriggers(t);
        try {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_${table}_${watermark} ON ${table}(${watermark});
                DROP TRIGGER IF EXISTS ${insert};
                CREATE TRIGGER ${insert}
                AFTER INSERT ON ${table}
                FOR EACH ROW
                WHEN NEW.${watermark} IS NULL
                BEGIN
                    UPDATE ${table} SET ${watermark} = ${now} WHERE rowid = NEW.rowid;
                END;
                DROP TRIGGER IF EXISTS ${touch};
                CREATE TRIGGER ${touch}
                AFTER UPDATE ON ${table}
                FOR EACH ROW
                WHEN NEW.${watermark} IS OLD.${watermark}
                BEGIN
                    UPDATE ${table} SET ${watermark} = ${now} WHERE rowid = NEW.rowid;
                END;
            `);
        } catch (e) {
            // A delta would miss this table's writes until the next boot makes them; a whole copy still carries them.
            console.error(`[DB] ❌ Could not stamp ${table}'s writes for its standbys:`, e);
        }
    }
}


// ==========================================
// CROWDFUNDING PROJECTS
// ==========================================

export interface ProjectRow {
    id: string;
    creator_pubkey: string;
    title: string;
    description: string;
    photos: string; // JSON string array
    goal_amount_c: number;
    current_amount_c: number;
    deadline_at: string | null;
    status: string;
    created_at: string;
    enterprise_pubkey?: string;
    migrated_at?: string | null;
}

function rowToProjectRow(e: any, legacyP?: any): ProjectRow {
    const creator = e.lead_keeper || e.any_keeper || legacyP?.creator_pubkey || e.public_key;
    const title = e.callsign;
    const description = e.purpose || e.bio || legacyP?.description || '';
    let photos = legacyP?.photos;
    if (!photos) {
        photos = e.avatar_url ? JSON.stringify([e.avatar_url]) : '[]';
    }
    const goalAmount = Number(e.goal_amount_c ?? legacyP?.goal_amount_c ?? 0);

    let currentAmount = 0;
    if (legacyP && legacyP.current_amount_c != null) {
        currentAmount = Number(legacyP.current_amount_c);
    }
    try {
        // Pledges in, less any sent back out of the escrow to a backer (a pledge made after the goal, returned at boot by
        // engine/stranded-pledges.ts, or an unfunded project's, a week after its end date by engine/unfunded-pledges.ts): those
        // never reached the project. The sweep to the enterprise is neither.
        const txSum = (db.prepare(`
            SELECT COALESCE(SUM(CASE WHEN from_pubkey = 'escrow_' || ? THEN -amount_c ELSE amount_c END), 0) as s FROM transactions
            WHERE project_id = ? AND (
                ((to_pubkey = ? OR to_pubkey = 'escrow_' || ?) AND id NOT LIKE 'sweep_%' AND from_pubkey NOT LIKE 'escrow_%')
                OR (from_pubkey = 'escrow_' || ? AND to_pubkey != ?)
            )
        `).get(e.public_key, e.public_key, e.public_key, e.public_key, e.public_key, e.public_key) as any)?.s || 0;
        const accBal = (db.prepare(`SELECT balance_c FROM accounts WHERE public_key = ?`).get(e.public_key) as any)?.balance_c || 0;
        // The sum in cents, as every pledge is: SQLite's sum of REALs is not 0 where every pledge went back (0.1, 0.2 and 0.7
        // from one backer, 0.3 and 0.6 from another, leave 2.8e-17), and the update read that as pledges received. Review of #2525.
        currentAmount = Math.max(currentAmount, (Number(txSum)), accBal);
    } catch { }

    const status = (e.status || legacyP?.status || 'ACTIVE').toUpperCase();

    return {
        id: e.public_key,
        creator_pubkey: creator,
        title,
        description,
        photos,
        goal_amount_c: goalAmount,
        current_amount_c: currentAmount,
        deadline_at: e.deadline_at ?? legacyP?.deadline_at ?? null,
        status,
        created_at: e.joined_at ?? legacyP?.created_at ?? new Date().toISOString(),
        enterprise_pubkey: e.public_key || legacyP?.enterprise_pubkey || legacyP?.id,
    };
}

/**
 * A project's row as the list reads it: every column rowToProjectRow takes but `photos`, which the list never reads.
 */
const PROJECT_LIST_COLUMNS = 'id, creator_pubkey, description, goal_amount_c, current_amount_c, deadline_at, status, created_at, enterprise_pubkey';

/**
 * Every project, newest first (200 at most), its `photos` the enterprise's photo as its URL (avatarUrlOf, from the row's
 * avatar_ref) or none, never a photo: a list reads no photo (#1486, as the member list since #1475 and the rosters since
 * #1478). Every crowdfund the apps make has a projects row whose `photos` holds the photo itself (a bounded
 * POST /api/enterprise copies it there; POST /api/crowdfund/projects keeps up to ten), and the list sent those as stored.
 * The first is the enterprise's photo, so its URL stands for it. The others have no URL and no app draws them (the phone
 * stores the list's `photos` and never shows them; the web app and the manager don't read them), so the list leaves them
 * out. Only the listed enterprises' projects rows are read, and never their photos. The one project's read
 * (getCrowdfundProject) still hands every photo out as stored: a read of one.
 */
export function getCrowdfundProjects(): ProjectRow[] {
    const enterprises = (db.prepare(`
        SELECT m.public_key, m.callsign, m.avatar_ref, m.bio, m.purpose,
               m.goal_amount_c, m.deadline_at, m.status, m.joined_at,
               (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key AND role = 'lead' LIMIT 1) as lead_keeper,
               (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key LIMIT 1) as any_keeper
        FROM members m
        WHERE m.is_treasury = 1 AND m.lifecycle = 'bounded' AND m.status NOT IN ('pruned', 'deleted')
        ORDER BY m.joined_at DESC
        LIMIT 200
    `).all() as any[]).map(e => ({ ...e, avatar_url: avatarUrlOf(e.public_key, e.avatar_ref) }));

    const projectMap = new Map<string, any>();
    try {
        const pRows = db.prepare(`SELECT ${PROJECT_LIST_COLUMNS} FROM projects
            WHERE id IN (SELECT value FROM json_each(?)) AND status NOT IN ('pruned', 'deleted', 'PRUNED', 'DELETED')`)
            .all(JSON.stringify(enterprises.map(e => e.public_key))) as any[];
        for (const p of pRows) projectMap.set(p.id, p);
    } catch { }

    // No `photos` in the projects row read: rowToProjectRow takes the enterprise's photo, its URL here, or none.
    return enterprises.map(e => rowToProjectRow(e, projectMap.get(e.public_key)));
}

export function getCrowdfundProject(id: string): ProjectRow | undefined {
    const e = db.prepare(`
        SELECT m.public_key, m.callsign, mp.photo AS avatar_url, m.bio, m.purpose,
               m.goal_amount_c, m.deadline_at, m.status, m.joined_at,
               (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key AND role = 'lead' LIMIT 1) as lead_keeper,
               (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key LIMIT 1) as any_keeper
        FROM members m LEFT JOIN member_photos mp ON mp.public_key = m.public_key
        WHERE m.public_key = ? AND m.is_treasury = 1 AND m.status NOT IN ('pruned', 'deleted')
    `).get(id) as any;

    // If e was soft-deleted or pruned in members, it's deleted - don't resurrect from legacy projects table
    const prunedOrDeleted = db.prepare("SELECT 1 FROM members WHERE public_key = ? AND status IN ('pruned', 'deleted')").get(id);
    if (prunedOrDeleted) return undefined;

    const legacyP = db.prepare("SELECT * FROM projects WHERE id = ? AND status NOT IN ('pruned', 'deleted', 'PRUNED', 'DELETED')").get(id) as any;
    if (!e && !legacyP) return undefined;
    if (e) return rowToProjectRow(e, legacyP);
    return legacyP as ProjectRow;
}

/**
 * Whether `pubkey` leads the project: the rule its edit (updateCrowdfundProject) asks. Its lead is getCrowdfundProject's
 * creator_pubkey: its lead keeper (treasury_operators, role 'lead'); with no lead row, its first keeper; with no keepers at
 * all, the projects row's own creator_pubkey. That column keeps whoever made it, and the lead changes after (a keepers'
 * vote, or a lead who stepped down or closed their account and a keeper promoted in their place). Asked of that column
 * first, the maker who no longer led it could still change it, and the new lead could not (review of #2525). Its cancel asks
 * its own rule (mayCancelProject).
 */
export function leadsProject(projectId: string, pubkey: string): boolean {
    const lead = getCrowdfundProject(projectId)?.creator_pubkey;
    return !!lead && lead === pubkey;
}

/**
 * May `pubkey` cancel the project (deleteCrowdfundProject), refunding every backer and deleting it? The cancel is its
 * wind-up (docs/the-commons.md) and can't be undone, so it asks for the people wind-up allows (isLeadOrSoleKeeperOrAdmin),
 * and its maker only where nobody else could ever have run it (Marty, board, 29 Oct 2026, CF-Q1 and CF-Q2):
 * - A node admin (an owner or admin of the node, isAdminPubkey, which asks that their account is active).
 * - Its lead keeper (treasury_operators, role 'lead').
 * - With no lead, its only keeper. Nobody leads it when its lead left and no keeper was active with operator access to take
 *   over (promoteOrPauseAfterLeadLeft paused it). One of two or more keepers can't, and nothing names a lead after: its
 *   keepers can't vote one (decisions-engine.ts PROJECT_LEADER_STAYS), succession replaces only a lead it has
 *   (proposeLeadSuccession), and an admin's assign binds a keeper. So a node admin alone cancels it then. Every binding
 *   counts, a suspended keeper's too, as isLeadOrSoleKeeperOrAdmin counts them.
 * - Its maker, only while it has no keepers and never had one that left (projects.keeper_left_at, noteKeeperLeftProject):
 *   a maker an admin or the community removed as its last keeper, or who stepped down, no longer may ("removal ends it").
 *   Every way of making a project binds its maker as its lead, so that is a projects row no keeper was ever bound to.
 * The lead, the only keeper and the maker only while they may act now: an active account with operator access on. Such a
 * keeper acts for no enterprise (docs/enterprises-and-operators.md §4.1), as createCrowdfundProject and wind-up ask.
 */
export function mayCancelProject(projectId: string, pubkey: string): boolean {
    if (!pubkey) return false;
    const project = db.prepare('SELECT creator_pubkey, keeper_left_at FROM projects WHERE id = ?').get(projectId) as
        { creator_pubkey: string | null; keeper_left_at: string | null } | undefined;
    if (!project || namesNoProject(projectId)) return false;
    if (isNodeAdminKey?.(pubkey) === true) return true;
    const keepers = db.prepare('SELECT member_pubkey, role FROM treasury_operators WHERE treasury_pubkey = ?')
        .all(projectId) as { member_pubkey: string; role: string }[];
    const lead = keepers.find((k) => k.role === 'lead');
    const named = lead ? lead.member_pubkey === pubkey
        : keepers.length === 1 ? keepers[0].member_pubkey === pubkey
        : keepers.length === 0 && !project.keeper_left_at && project.creator_pubkey === pubkey;
    return named && isMemberActive(pubkey) && !isOperatorSwitchedOff(pubkey);
}

/**
 * A keeper left the project: they stepped down, its lead, a node admin or the community removed them, they closed their
 * account, or its wind-up released them. The first time stamps projects.keeper_left_at, after which its maker no longer
 * stands in for its cancel (mayCancelProject). Nothing for an enterprise that is no project (no projects row). Runs in the
 * caller's transaction, on a main server: a standby takes the stamp with the row.
 */
export function noteKeeperLeftProject(projectId: string): void {
    db.prepare("UPDATE projects SET keeper_left_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND keeper_left_at IS NULL")
        .run(projectId);
}

/**
 * Has an admin switched this member's operator access off? True when they keep at least one
 * treasury_operators binding but members.can_operate = 0 (adminSetOperator suspends a steward node-wide
 * without deleting their bindings). A member with no binding at all is simply not a keeper yet.
 */
export function isOperatorSwitchedOff(memberPubkey: string): boolean {
    const row = db.prepare(`
        SELECT COALESCE(m.can_operate, 0) AS can_operate,
               EXISTS (SELECT 1 FROM treasury_operators o WHERE o.member_pubkey = m.public_key) AS has_binding
        FROM members m WHERE m.public_key = ?
    `).get(memberPubkey) as any;
    return !!row && row.has_binding === 1 && row.can_operate !== 1;
}

export const INACTIVE_MEMBER_CREATE_ERROR = word('Only active community members can create an enterprise or a project');

/**
 * A goal a fresh members table holds (its CHECK: `goal_amount_c IS NULL OR goal_amount_c >= 0`): none, or whole hundredths of
 * a Bean, 0 or more. Asked by every writer of a goal, because a node whose table got the column from an ALTER has no such
 * CHECK, and a goal below 0 there is one its standby's table refuses (bringMembersToSchemaRules).
 */
export const GOAL_AMOUNT_ERROR = word('The goal must be a number of Beans, 0 or more');
export function isAcceptableGoal(goal: number | null): boolean {
    return goal === null || (isHundredths(goal) && goal >= 0);
}

/** Is this member's account active? Missing rows and every other status (disabled, suspended, pruned) are not. */
/** An active member's row: not a visitor's (members.is_visitor), which starts nothing, as a key with no row starts nothing. */
export function isMemberActive(memberPubkey: string): boolean {
    const row = db.prepare('SELECT status, is_visitor FROM members WHERE public_key = ?').get(memberPubkey) as any;
    return !!row && !row.is_visitor && (row.status || 'active') === 'active';
}

export const OPERATOR_SWITCHED_OFF_CREATE_ERROR =
    'Your operator access is switched off by a node admin, so you cannot create an enterprise or a project';

/**
 * Raise the operator switch for the creator of a new enterprise, ONLY when that enterprise is their first
 * binding. Creation must never switch back on a member who already keeps something: if their switch is off,
 * an admin turned it off, and every enterprise they keep would go live for them again. Callers refuse such a
 * member before writing; this keeps the write itself from ever undoing a suspension.
 */
export function raiseCreatorOperatorSwitch(creatorPubkey: string, newEnterprisePubkey: string): void {
    db.prepare(`
        UPDATE members SET can_operate = 1
        WHERE public_key = ?
          AND NOT EXISTS (SELECT 1 FROM treasury_operators WHERE member_pubkey = ? AND treasury_pubkey != ?)
    `).run(creatorPubkey, creatorPubkey, newEnterprisePubkey);
}

export const PROJECT_ID_TAKEN_ERROR = word('A new project needs an id nothing else has');

/** A pledge to a project that has reached its goal: refused before anything moves (pledgeToProject). */
export const PROJECT_FUNDED_NO_PLEDGES_ERROR = word('This project has already reached its goal, so it is not taking more pledges. Your Beans have not moved.');
/** A pledge to a project whose deadline has passed: refused before anything moves (pledgeToProject). */
export const PROJECT_DEADLINE_PASSED_ERROR = word("This project's deadline has passed: it takes no more pledges.");

/**
 * Is `id` free for a new crowdfund project? A project's id is its enterprise's key, its account's and its escrow's
 * (`escrow_<id>`), so it must name nothing already there: no member, visitor or enterprise row, no account, no project,
 * none of the ledger's own accounts (the Commons, an escrow, a bridge), and no escrow named after it. Before
 * POST /api/crowdfund/projects made ids itself, one naming a member's key had pledges paid into that member's balance
 * and their status changed to funded; one naming a deal's escrow would have swept that deal's Beans into the project.
 */
export function isFreshProjectId(id: unknown): id is string {
    if (typeof id !== 'string' || id.length === 0 || isSyntheticAccount(id)) return false;
    return !db.prepare(`
        SELECT 1 FROM members WHERE public_key = @id
        UNION ALL SELECT 1 FROM accounts WHERE public_key = @id OR public_key = 'escrow_' || @id
        UNION ALL SELECT 1 FROM projects WHERE id = @id
        LIMIT 1
    `).get({ id });
}

/**
 * Does `id` name money already on this node: one of the ledger's own accounts (the Commons, an escrow, a bridge), any
 * account or member row, the escrow `escrow_<id>`, a crowdfund project, a deal, or a cross-community settlement?
 *
 * For ids a caller chooses. A cross-community settlement holds its Beans in `escrow_<key>`, so a key naming a project's
 * or a deal's escrow had that escrow paid out to whoever abandoned the settlement (federation-settlement-exchange.ts
 * beginOutboundSettlement). A post's id once named `escrow_<post id>` too. Every other id that names an account is made
 * by the node (a deal's, a pledge's, a project's, an enterprise's key), so it names nothing until the node makes it.
 * Only an outbound settlement counts: an inbound one's key is the peer's choice and names no account here (the seller's
 * side has no escrow), so counting it would let a trading peer take ids the node makes itself, like `pulse_<date>`.
 */
export function idNamesMoney(id: string): boolean {
    if (isSyntheticAccount(id)) return true;
    return !!db.prepare(`
        SELECT 1 FROM members WHERE public_key = @id
        UNION ALL SELECT 1 FROM accounts WHERE public_key = @id OR public_key = 'escrow_' || @id
        UNION ALL SELECT 1 FROM projects WHERE id = @id
        UNION ALL SELECT 1 FROM marketplace_transactions WHERE id = @id
        UNION ALL SELECT 1 FROM settlements WHERE key = @id AND direction = 'outbound'
        LIMIT 1
    `).get({ id });
}

/**
 * Does `id` name something that is never a crowdfund project: a person (a member's or visitor's row that isn't an
 * enterprise), or one of the ledger's own accounts (the Commons, an escrow, a bridge)? Every project is its own
 * enterprise row (createCrowdfundProject, a bounded POST /api/enterprise, the Slice 3 migration), or an older projects
 * row with none. But the crowdfund route took ids from callers before it made them itself, and a projects row under a
 * person's key paid pledges into their balance, set their status to funded, and let its "creator" rename or prune them:
 * such a row is no project here.
 */
function namesNoProject(id: string): boolean {
    if (isSyntheticAccount(id)) return true;
    const row = db.prepare('SELECT is_treasury FROM members WHERE public_key = ?').get(id) as { is_treasury: number | null } | undefined;
    return !!row && row.is_treasury !== 1;
}

/**
 * A project's photos as an edit sends them, with this node's own avatar URL read as the photo it stands for, never stored
 * as itself (#1475's rule for a member's photo). The crowdfund list sends each project's photo as that URL (#1486), and
 * an older phone's edit screen (before #792) sends back the photos it read from the list. Sent back alone, the photos are
 * unchanged: every one kept as stored, the ones the list leaves out included. Beside new ones, the URL is the
 * enterprise's photo, the one it opens.
 */
function ownAvatarUrlsAsStored(enterpriseId: string, storedJson: string | undefined, sent: string[]): string[] {
    if (!Array.isArray(sent) || !sent.some((p) => isSelfAvatarUrl(p))) return sent;
    if (sent.every((p) => isSelfAvatarUrl(p))) {
        let stored: unknown = [];
        try { stored = JSON.parse(storedJson || '[]'); } catch { /* none */ }
        return Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : [];
    }
    const own = (db.prepare('SELECT photo FROM member_photos WHERE public_key = ?').get(enterpriseId) as { photo: string } | undefined)?.photo;
    return sent.flatMap((p) => (isSelfAvatarUrl(p) ? (own ? [own] : []) : [p]));
}

export function createCrowdfundProject(
    id: string,
    creator_pubkey: string,
    title: string,
    description: string,
    photos: string[],
    goal_amount: number,
    deadline_at: string | null
) {
    if (!isFreshProjectId(id)) throw new Error(PROJECT_ID_TAKEN_ERROR);
    if (!isAcceptableGoal(goal_amount)) throw new Error(GOAL_AMOUNT_ERROR);
    // The title is the enterprise's name and the description its purpose: each held to its limit (#1493).
    title = typeof title === 'string' ? replaceLoneSurrogates(title) : title;
    description = typeof description === 'string' ? replaceLoneSurrogates(description) : description;
    assertEnterpriseText(title, description);
    if (creator_pubkey && !isMemberActive(creator_pubkey)) throw new Error(INACTIVE_MEMBER_CREATE_ERROR);
    if (creator_pubkey && isOperatorSwitchedOff(creator_pubkey)) throw new Error(OPERATOR_SWITCHED_OFF_CREATE_ERROR);
    // Every photo is served to anyone who asks (/api/crowdfund/projects, /api/avatar/:pubkey), so each is stored
    // without its metadata (G9a-3). Anything that is not an image comes back exactly as given.
    photos = Array.isArray(photos) ? photos.map(stripImageValue) : photos;
    photos = ownAvatarUrlsAsStored(id, undefined, photos || []);
    const incomingBytes = incomingPhotosBytes((photos || []).filter(p => !isSelfAvatarUrl(p)));
    if (incomingBytes > 0 && creator_pubkey) {
        assertMayStorePhotoBytes(creator_pubkey, incomingBytes);
    }
    // photos[0] becomes the enterprise's avatar (member_photos), served by /api/avatar/:pubkey. An
    // editor that read the enterprise back from the node holds THIS node's own avatar URL
    // there, not the photo; storing it would point the avatar at itself. Same rule as
    // updateProfile: read it as "no photo" rather than rejecting the whole save.
    const rawPhotoUrl = photos && photos.length > 0 ? photos[0] : '';
    const photoUrl = isSelfAvatarUrl(rawPhotoUrl) ? '' : rawPhotoUrl;
    const now = new Date().toISOString();
    const callsign = projectRowName(db, title, id);

    // A fresh id (isFreshProjectId, above): every row below is new, so a clash throws rather than writing over another's.
    // The description is its purpose; its About (members.bio) is its keepers' own words, so it starts with none
    // (engine/enterprise-shopfront.ts).
    db.transaction(() => {
        db.prepare(`
            INSERT INTO members (
                public_key, callsign, joined_at, status,
                is_treasury, earned_credit_c, earned_surplus_c,
                purpose, goal_amount_c, deadline_at, lifecycle, paused, updated_at
            ) VALUES (?, ?, ?, 'active', 1, 0, 0, ?, ?, ?, 'bounded', 0, ?)
        `).run(id, callsign, now, description || title.trim(), goal_amount, deadline_at, now);
        setMemberPhoto(db, id, photoUrl || null);
        db.prepare("INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)").run(id);
        if (creator_pubkey) {
            db.prepare(`
                INSERT OR IGNORE INTO treasury_operators (
                    treasury_pubkey, member_pubkey, role, granted_at, granted_by
                ) VALUES (?, ?, 'lead', ?, 'creator')
            `).run(id, creator_pubkey, now);
            raiseCreatorOperatorSwitch(creator_pubkey, id);
        }

        db.prepare(`
            INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount_c, deadline_at, status, migrated_at, enterprise_pubkey, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?)
        `).run(id, creator_pubkey, title, description, JSON.stringify(photos), goal_amount, deadline_at, id, now, now);
    })();

    if (incomingBytes > 0 && creator_pubkey) {
        recordStoredPhotoBytes(creator_pubkey, incomingBytes);
    }
}

export function updateCrowdfundProject(
    id: string,
    creator_pubkey: string,
    title: string,
    description: string,
    photos: string[],
    goal_amount: number,
    deadline_at?: string | null
) {
    if (!isAcceptableGoal(goal_amount)) throw new Error(GOAL_AMOUNT_ERROR);
    // Never a person's row (namesNoProject): a projects row under a member's key renamed that member.
    if (namesNoProject(id)) throw new Error("Project not found");
    const project = getCrowdfundProject(id);
    if (!project) throw new Error("Project not found");
    if (!leadsProject(id, creator_pubkey)) throw new Error("Unauthorized: You do not own this project");
    // As on a create (#1493); the title and description it already holds, sent back unchanged, are kept.
    title = typeof title === 'string' ? replaceLoneSurrogates(title) : title;
    description = typeof description === 'string' ? replaceLoneSurrogates(description) : description;
    assertEnterpriseText(title, description, { name: project.title, purpose: project.description });

    // In cents, as pledgeToProject reads a goal: a float residue where every pledge went back is no pledge received.
    if (Number(project.current_amount_c) > 0 && Number(goal_amount) !== project.goal_amount_c) {
        throw new Error("Cannot change funding goal after receiving pledges");
    }

    const now = new Date().toISOString();
    photos = Array.isArray(photos) ? photos.map(stripImageValue) : photos; // as in createCrowdfundProject (G9a-3)
    photos = ownAvatarUrlsAsStored(id, project.photos, photos || []);
    const incomingBytes = incomingPhotosBytes((photos || []).filter(p => !isSelfAvatarUrl(p)));
    if (incomingBytes > 0 && creator_pubkey) {
        assertMayStorePhotoBytes(creator_pubkey, incomingBytes);
    }
    // As in createCrowdfundProject: this node's own avatar URL, sent back by an editor that
    // loaded the enterprise from the node, means "unchanged": read as no photo, which leaves the
    // stored one as it is (setMemberPhoto is called only for a photo given), so it survives the edit.
    const rawPhotoUrl = photos && photos.length > 0 ? photos[0] : '';
    const photoUrl = isSelfAvatarUrl(rawPhotoUrl) ? '' : rawPhotoUrl;
    // The enterprise row's name, by the one name rule, as at the create (projectRowName): the title is stored as typed.
    // Its name and purpose, never its About (members.bio): that is its keepers' (PUT /api/treasury/:t/profile).
    const rowName = projectRowName(db, title, id);

    // The projects row by its id alone: its creator_pubkey is whoever made the project, and the check above already
    // holds the change to the lead today (leadsProject). Matched on the maker, a new lead's change
    // (the leader closed their account, a keeper took over) was answered 200 and missed the row the return, the end-date
    // notice and the pledge gate read (review of #2525).
    db.transaction(() => {
        if (deadline_at !== undefined) {
            db.prepare(`
                UPDATE projects
                SET title = ?, description = ?, photos = ?, goal_amount_c = ?, deadline_at = ?, updated_at = ?
                WHERE id = ?
            `).run(title, description, JSON.stringify(photos), goal_amount, deadline_at, now, id);

            db.prepare(`
                UPDATE members
                SET callsign = ?, purpose = ?, goal_amount_c = ?, deadline_at = ?, updated_at = ?
                WHERE public_key = ?
            `).run(rowName, description, goal_amount, deadline_at, now, id);
        } else {
            db.prepare(`
                UPDATE projects
                SET title = ?, description = ?, photos = ?, goal_amount_c = ?, updated_at = ?
                WHERE id = ?
            `).run(title, description, JSON.stringify(photos), goal_amount, now, id);

            db.prepare(`
                UPDATE members
                SET callsign = ?, purpose = ?, goal_amount_c = ?, updated_at = ?
                WHERE public_key = ?
            `).run(rowName, description, goal_amount, now, id);
        }
        // Its chat is titled by its name: a rename carries over, as the face's does (engine/enterprise-shopfront.ts).
        db.prepare("UPDATE conversations SET name = ? WHERE id = ? AND type = 'enterprise_thread'").run(rowName, id);
        if (photoUrl) setMemberPhoto(db, id, photoUrl);
    })();

    if (incomingBytes > 0 && creator_pubkey) {
        recordStoredPhotoBytes(creator_pubkey, incomingBytes);
    }
}

/** What a member's money door says to an amount that is not whole hundredths above 0 (a pledge, a send, a payment to the Commons). */
export const WHOLE_CENTS_ERROR = word('The amount is a number of Beans above 0, to the cent.');

export function pledgeToProject(txId: string, projectId: string, fromPubkey: string, amount: number, memo: string, auth?: { signer: string; signature: string; payload: string }) {
    if (typeof memo === 'string') memo = replaceLoneSurrogates(memo);
    // SECURITY (SRV-8): defense-in-depth — reject non-positive amounts at the data
    // layer. A negative amount would otherwise debit-as-credit the backer before the
    // transactions CHECK(amount > 0) aborts the surrounding transaction.
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Pledge amount must be positive");
    // Whole hundredths, as a payment to the Commons is (state-engine.ts payToCommons). Before anything moves: a refusal in words.
    if (!isHundredths(amount)) throw new Error(WHOLE_CENTS_ERROR);
    assertMoneyMayMove?.();
    // Nor on a standby, whose ledger is its main server's (config/node-role.ts): before the project row below.
    assertLedgerWritable();
    // Never into a person's account (namesNoProject): a projects row under a member's key paid the pledge into their
    // balance and set their status to funded.
    if (namesNoProject(projectId)) throw new Error("Project not found");

    let project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined;
    if (!project) {
        const memberEnterprise = db.prepare(`SELECT public_key, callsign, purpose, bio, goal_amount_c, deadline_at, status FROM members WHERE public_key = ? AND is_treasury = 1 AND lifecycle = 'bounded'`).get(projectId) as any;
        if (!memberEnterprise) throw new Error("Project not found");
        const lead = (db.prepare(`SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ? AND role = 'lead' LIMIT 1`).get(projectId) as any)?.member_pubkey || memberEnterprise.public_key;
        db.prepare(`
            INSERT OR IGNORE INTO projects (id, creator_pubkey, title, description, photos, goal_amount_c, deadline_at, status, migrated_at, enterprise_pubkey, created_at, updated_at)
            VALUES (?, ?, ?, ?, '[]', ?, ?, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `).run(projectId, lead, memberEnterprise.callsign, memberEnterprise.purpose || memberEnterprise.bio || '', memberEnterprise.goal_amount_c || 0, memberEnterprise.deadline_at, projectId);
        project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow;
    }
    // Only an ACTIVE project takes a pledge. A FUNDED one used to take it too: the Beans went into its escrow, but only
    // the pledge that reached the goal sweeps the escrow to the enterprise, and nothing else ever drains it (delete
    // refuses a project that isn't ACTIVE), so a later pledge sat there for good (FABLE-sec-money MEDIUM 1). Before
    // anything moves, so a refused pledge leaves every balance as it was. The ones already stranded go back to their
    // backers at boot (engine/stranded-pledges.ts).
    if (project.status !== 'ACTIVE') {
        throw new Error(project.status === 'FUNDED'
            ? PROJECT_FUNDED_NO_PLEDGES_ERROR
            : 'This project is no longer taking pledges. Your Beans have not moved.');
    }
    const entPub = (project as any).enterprise_pubkey || project.id;
    const ent = db.prepare('SELECT is_treasury, paused, status, deadline_at FROM members WHERE public_key = ?').get(entPub) as any;
    if (ent?.is_treasury) {
        if (ent.paused === 1) throw new Error("Enterprise is paused — not accepting pledges");
        if (ent.status === 'winding_up' || ent.status === 'completed') throw new Error("Enterprise is not accepting pledges");
        // The goal also marks the enterprise's own row (below): read that too, for a projects row made above from it.
        if (ent.status === 'funded') throw new Error(PROJECT_FUNDED_NO_PLEDGES_ERROR);
    }
    const deadline = project.deadline_at ?? ent?.deadline_at;
    if (isPastDeadline(deadline)) {
        const err: any = new Error(PROJECT_DEADLINE_PASSED_ERROR);
        err.code = 'project_closed';
        err.status = 409;
        throw err;
    }

    // #138: close the creator's demurrage window before this pledge can complete the goal and sweep escrow
    // into their balance. Settled unconditionally rather than only inside the FUNDED branch, because the
    // branch is decided from a row this same transaction is about to move — and settling an account that
    // turns out not to be paid is free (it collects what was already owed and stamps the epoch).
    //
    // THE BACKER TOO (review finding), and deliberately BEFORE the affordability read below rather than just
    // before the write. That read is a raw `SELECT balance`, so against an unsettled row it approves a pledge
    // out of beans demurrage has already taken — the member spends them once and is charged for them again on
    // their next read. Settling the payer was already unavoidable in the creator-pledges-to-their-own-project
    // case, so excluding it for everyone else would only have made the same path behave two different ways.
    const targetAccount = project.enterprise_pubkey || projectId;
    onSettleDemurrage?.([targetAccount, project.creator_pubkey, fromPubkey]);

    const sender = db.prepare(`SELECT balance_c FROM accounts WHERE public_key = ?`).get(fromPubkey) as { balance_c: number } | undefined;
    if (!sender) throw new Error("Sender account not found");
    if (sender.balance_c < amount) throw new Error("Insufficient balance for pledge");

    const escrowPubkey = `escrow_${projectId}`;

    const executePledge = db.transaction(() => {
        // Ensure synthetic escrow account exists natively
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_updated_at, last_demurrage_epoch) VALUES (?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0)`).run(escrowPubkey);

        // These escrow legs write last_updated_at in ISO-8601 form (not
        // CURRENT_TIMESTAMP's space-separated shape) so the ledger watermark stays
        // lexically ordered against the ISO delta cursor — a CURRENT_TIMESTAMP value
        // sorts BEFORE any same-day ISO cursor (' ' < 'T'), which would make the
        // `WHERE last_updated_at > :since` delta scan silently miss the mutated row.
        // Debit backer
        db.prepare(`UPDATE accounts SET balance_c = balance_c - ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(amount, fromPubkey);

        // Credit Escrow instead of Creator
        db.prepare(`UPDATE accounts SET balance_c = balance_c + ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(amount, escrowPubkey);

        // Record tx — SRV-20: this is the member-authored leg (backer → escrow),
        // so persist the caller's request signature for re-verification on import.
        // The escrow sweep/refund legs below are node-authoritative (from escrow_)
        // and accepted via the payload-level pin gate (verifySyncPayload).
        db.prepare(`
            INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, memo, project_id, auth_signer, auth_signature, auth_payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(txId, fromPubkey, escrowPubkey, amount, memo, projectId,
            auth?.signer ?? null, auth?.signature ?? null, auth?.payload ?? null);

        // Update Project Goals
        db.prepare(`UPDATE projects SET current_amount_c = current_amount_c + ? WHERE id = ?`).run(amount, projectId);

        const updatedProject = db.prepare(`SELECT current_amount_c, goal_amount_c FROM projects WHERE id = ?`).get(projectId) as ProjectRow;
        // In cents: SQLite sums REALs, and 0.70 + 0.10 + 0.10 + 0.10 is 0.9999999999999999, short of a goal of 1.
        if (updatedProject && updatedProject.current_amount_c >= updatedProject.goal_amount_c && project.status === 'ACTIVE') {
            db.prepare(`UPDATE projects SET status = 'FUNDED' WHERE id = ?`).run(projectId);
            db.prepare(`UPDATE members SET status = 'funded' WHERE public_key = ?`).run(projectId);

            // Auto-Sweep Escrow to Enterprise Account (Slice 3: pledges land in enterprise account!)
            const escrowBalanceRow = db.prepare(`SELECT balance_c FROM accounts WHERE public_key = ?`).get(escrowPubkey) as { balance_c: number };
            const escrowBalance = escrowBalanceRow ? escrowBalanceRow.balance_c : Math.max(0, updatedProject.current_amount_c);

            if (escrowBalance > 0) {
                // Drain Escrow
                db.prepare(`UPDATE accounts SET balance_c = 0, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(escrowPubkey);
                // Credit Enterprise Treasury Account (Slice 3: pledges land in enterprise account)
                db.prepare(`UPDATE accounts SET balance_c = balance_c + ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(escrowBalance, targetAccount);

                // Record atomic Sweep Transaction to the enterprise
                db.prepare(`
                    INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, memo, project_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(`sweep_${txId}`, escrowPubkey, targetAccount, escrowBalance, 'Escrow Release: Funding Goal Reached', projectId);
            }
        }
    });

    executePledge();
    // A2-1: the transaction above debited the backer / moved escrow via raw SQL.
    // Re-sync the in-memory ledger so a subsequent transfer() can't write a stale
    // (pre-pledge) balance back over the DB and mint the pledged amount.
    onBalanceMutation?.();
}

/**
 * The pledges a project's escrow still holds (@escrow, @project): each pledge into it with no row out of it after it. Out of
 * an ACTIVE project's escrow only the return of its pledges a week after its end date pays (engine/unfunded-pledges.ts), and
 * it pays out every pledge the escrow holds at once, so the pledges before it went back then. Once its date moves, the
 * project takes pledges again, and only those are still held. Before any return, every pledge, as it always was.
 */
const HELD_PLEDGES_SQL = `
    SELECT t.from_pubkey, t.amount_c, t.id FROM transactions t
    WHERE t.to_pubkey = @escrow AND t.project_id = @project
      AND NOT EXISTS (
          SELECT 1 FROM transactions o
          WHERE o.from_pubkey = @escrow AND o.project_id = @project
            AND (o.timestamp > t.timestamp OR (o.timestamp = t.timestamp AND o.rowid > t.rowid)))`;

export function deleteCrowdfundProject(projectId: string, requesterPubkey: string) {
    // It refunds the backers from the project's escrow (raw SQL below): never on a standby (config/node-role.ts).
    assertLedgerWritable();
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined;
    // Never a person's row (namesNoProject): a projects row under a member's key pruned that member.
    if (!project || namesNoProject(projectId)) throw new Error("Project not found");
    // A node admin's, its lead's, its only keeper's when nobody leads it, or its maker's when it never had a keeper
    // (mayCancelProject): this row's creator_pubkey is whoever made it.
    if (!mayCancelProject(projectId, requesterPubkey)) throw new Error("Unauthorized to delete this project");

    // Guard against deleting funded/completed projects
    if (project.status !== 'ACTIVE') {
        throw new Error('Cannot delete a project that is already funded or completed');
    }

    // Guard against non-zero account balance to maintain ledger conservation
    const account = db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(projectId) as { balance_c: number } | undefined;
    if (account && account.balance_c !== 0) {
        throw new Error(`Cannot delete project enterprise with non-zero balance (${formatHundredths(account.balance_c, 'en')} Beans). Drain or sweep funds first.`);
    }

    // If still ACTIVE, funds are locked in Escrow. Refund them to backers: the pledges it still holds, never one that already
    // went back a week after the project's end date (HELD_PLEDGES_SQL), which would be paid twice. But a closed account's
    // (isClosedAccount: deleted by its owner, removed by the community, or an enterprise that wound up), which can't be paid
    // here: its share goes to the Commons, by the very move the return of an unfunded project's pledges makes
    // (engine/unfunded-pledges.ts, A CLOSED ACCOUNT; Marty, board, 27 Oct 2026: "To the Commons"), one row each. Until
    // this, the cancel credited the closed account (#2599's deciding pass: Ann's 7 onto her removed account, the Commons
    // unmoved). Decided here, before anything moves.
    const escrowPubkey = `escrow_${projectId}`;
    const pledges = project.status === 'ACTIVE'
        ? db.prepare(HELD_PLEDGES_SQL).all({ escrow: escrowPubkey, project: projectId }) as { from_pubkey: string, amount_c: number, id: string }[]
        : [];
    const ledger = projectCancelLedger;
    if (pledges.length > 0 && !ledger) throw new Error('Cannot refund the backers: the ledger is not running');
    const refunds: typeof pledges = [];
    const toCommons = new Map<string, number>();
    for (const pledge of pledges) {
        if (ledger?.isClosedAccount(pledge.from_pubkey)) toCommons.set(pledge.from_pubkey, (toCommons.get(pledge.from_pubkey) ?? 0) + pledge.amount_c);
        else refunds.push(pledge);
    }
    // That move needs Beans switched on (config/node-profile.ts), as the return's does: refused before anything moves.
    if (toCommons.size > 0) assertMoneyMayMove?.();

    // #138: close every backer's demurrage window before the refunds raise their balances. This is the
    // widest of the three paths — one deleted project refunds all of its pledgers at once, so an open window
    // on any of them becomes a retrospective tax on money they are merely getting back. Not a closed
    // account's: nothing is paid into it.
    //
    // Settled OUTSIDE executeDelete on purpose. Settling is independently correct and must not be undone by
    // an unrelated failure later in the delete.
    if (refunds.length > 0) onSettleDemurrage?.([...new Set(refunds.map(p => p.from_pubkey))]);

    const executeDelete = () => {
        if (project.status === 'ACTIVE') {
            // A closed account's share first, while the rows and the in-memory ledger agree: the move writes the escrow's
            // row from memory, so after the raw refunds below it would put back what they took out.
            for (const amount of toCommons.values()) ledger!.closedPledgeToCommons(escrowPubkey, projectId, amount);

            let totalRefunded = 0;
            for (const pledge of refunds) {
                // Return Beans to Backer
                db.prepare(`UPDATE accounts SET balance_c = balance_c + ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(pledge.amount_c, pledge.from_pubkey);

                // Record the localized Refund Transaction
                db.prepare(`
                    INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, memo, project_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(`refund_${pledge.id}`, escrowPubkey, pledge.from_pubkey, pledge.amount_c, 'Escrow Refund: Project Deleted', projectId);

                totalRefunded += pledge.amount_c;
            }

            // Drain the escrow account to reconcile the economy symmetrically
            db.prepare(`UPDATE accounts SET balance_c = balance_c - ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(totalRefunded, escrowPubkey);
        }

        // #139: Unlink transactions from the project before deletion to prevent SQLITE_CONSTRAINT_FOREIGNKEY
        // failure while retaining complete transaction history (pledges, refunds, sweeps) in the ledger.
        db.prepare(`UPDATE transactions SET project_id = NULL WHERE project_id = ?`).run(projectId);

        const acc = db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(projectId) as { balance_c: number } | undefined;
        if (acc && acc.balance_c !== 0) {
            throw new Error(`Cannot delete enterprise account with non-zero balance (${formatHundredths(acc.balance_c, 'en')} Beans). Sweep or refund funds first.`);
        }

        // Shred the Project — and tombstone it so mirrors propagate the delete.
        db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
        db.prepare(`DELETE FROM treasury_operators WHERE treasury_pubkey = ?`).run(projectId);
        db.prepare(`DELETE FROM accounts WHERE public_key = ? AND balance_c = 0`).run(projectId);
        db.prepare(`UPDATE members SET status = 'pruned', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(projectId);
        try {
            const cpRow = db.prepare("SELECT value FROM node_config WHERE key = 'commons_projects'").get() as any;
            if (cpRow && cpRow.value) {
                const projects = JSON.parse(cpRow.value);
                if (Array.isArray(projects)) {
                    const filtered = projects.filter((p: any) => p.id !== projectId);
                    if (filtered.length !== projects.length) {
                        db.prepare("UPDATE node_config SET value = ? WHERE key = 'commons_projects'").run(JSON.stringify(filtered));
                    }
                }
            }
        } catch { }
        writeTombstone('projects', projectId);
        writeTombstone('members', projectId);
    };

    // In one conserving transaction: a failure after a closed account's share went to the Commons puts the pot back in
    // memory as well as in its row (a plain one rolled back the row and left memory holding it). One that refunds nobody
    // needs no ledger.
    if (ledger) ledger.conservingTransaction(executeDelete);
    else db.transaction(executeDelete)();
    // A2-1: refunds/escrow drain above mutated balances via raw SQL — re-sync the
    // in-memory ledger so the next transfer() doesn't clobber the DB with stale values.
    onBalanceMutation?.();
}

