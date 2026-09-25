import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedPricingGuideIfEmpty } from './pricing-guide-db.js';
import { migrateProjectsAndCommonsToEnterprises } from './unify-projects-migration.js';
import { ripOutLegacyVoting } from './rip-out-legacy-voting-migration.js';
import { isSelfAvatarUrl } from '@beanpool/core';
import { registerGeoFunctions } from '@beanpool/engine';
import { stripImageValue } from '../storage/image-metadata.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'state.db');
const STATE_JSON_PATH = path.join(DATA_DIR, 'state.json');
const STATE_BACKUP_PATH = path.join(DATA_DIR, `state.backup-${Date.now()}.json`);

// Initialize Database connection
export const db: Database.Database = new Database(DB_PATH);
// `haversine_km`, for the posts listing searched by distance (G4). A function lives on the connection, not in the file,
// and this is the one connection that runs the listing; the read-only handles opened on backups and snapshots never do.
registerGeoFunctions(db);

const pendingPostCommitHooks: (() => void)[] = [];

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
                for (const hook of hooks) {
                    try { hook(); } catch (e) { console.error('[DB] Post-commit hook failed:', e); }
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
// the accounts table. A few crowdfund operations below mutate accounts.balance
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

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

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

// Function to initialize schema
export function initSchema() {
    const userVersion = db.pragma('user_version', { simple: true }) as number;
    if (userVersion < 3) {
        console.log("🧨 Nuking messages and conversations for Version 3 Typed Messaging overhaul...");
        db.exec(`
            DROP TABLE IF EXISTS messages;
            DROP TABLE IF EXISTS conversation_participants;
            DROP TABLE IF EXISTS conversations;
        `);
        db.pragma('user_version = 3');
    }

    const ratingsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ratings'").get() as any;
    if (ratingsSql && ratingsSql.sql.includes('marketplace_transactions_old')) {
        console.log("🧨 Fixing corrupted ratings table schema...");
        db.exec("ALTER TABLE ratings RENAME TO ratings_corrupted;");
    }

    // Ensure all tables have updated_at columns so schema.sql triggers/indexes can compile successfully
    try { db.prepare(`ALTER TABLE members ADD COLUMN updated_at DATETIME`).run(); } catch { }
    // Elder vouch column — added BEFORE schema.sql exec so the re-created
    // members_touch_updated_at trigger (which whitelists elder_vouched_by) compiles.
    try { db.prepare(`ALTER TABLE members ADD COLUMN elder_vouched_by TEXT REFERENCES members(public_key)`).run(); } catch { }
    // Vouch capability (super-Elder). Added BEFORE schema.sql exec so the re-created
    // members_touch_updated_at trigger (which whitelists can_vouch) compiles.
    try { db.prepare(`ALTER TABLE members ADD COLUMN can_vouch INTEGER DEFAULT 0`).run(); } catch { }
    // Vouch level's credit floor (25/50/100). Also added before schema.sql for the trigger whitelist.
    try { db.prepare(`ALTER TABLE members ADD COLUMN vouch_credit REAL DEFAULT 0`).run(); } catch { }
    // Hard credit freeze: forced 0 floor when set by admin. Also added before schema.sql for the trigger whitelist.
    try { db.prepare(`ALTER TABLE members ADD COLUMN credit_frozen INTEGER DEFAULT 0`).run(); } catch { }
    // Community treasury + operator capability. Added BEFORE schema.sql exec so the re-created
    // members_touch_updated_at trigger (which now whitelists them) compiles on already-live DBs.
    try { db.prepare(`ALTER TABLE members ADD COLUMN is_treasury INTEGER DEFAULT 0`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN can_operate INTEGER DEFAULT 0`).run(); } catch { }
    try { db.prepare(`ALTER TABLE post_photos ADD COLUMN updated_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN updated_at DATETIME`).run(); } catch { }
    // ── Images out of the database (storage design §7) ─────────────────────────────────────────
    //
    // The rows that used to carry base64 learn to point at the image store instead. Adding the columns is
    // an ALTER; making the old column optional is not — SQLite cannot drop a NOT NULL — so the two tables
    // are rebuilt, once, on nodes whose table still declares it. `CREATE TABLE IF NOT EXISTS` in schema.sql
    // is a no-op on an existing table, so a live node would otherwise keep NOT NULL forever and the
    // evacuation job would have nothing it could null.
    //
    // The rebuild copies every column across by name, so it survives whatever else has been ALTERed on in
    // front of it, and runs inside a transaction: interrupted, nothing happened.
    try { db.prepare(`ALTER TABLE post_photos ADD COLUMN storage_key TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE post_photos ADD COLUMN sha256 TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE post_photos ADD COLUMN bytes INTEGER`).run(); } catch { }
    try { db.prepare(`ALTER TABLE post_photos ADD COLUMN mime TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE message_attachments ADD COLUMN storage_key TEXT`).run(); } catch { }
    try {
        const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='post_photos'").get() as any)?.sql as string | undefined;
        if (ddl && /photo_data\s+TEXT\s+NOT\s+NULL/i.test(ddl)) {
            db.transaction(() => {
                db.prepare(`
                    CREATE TABLE post_photos_imgstore_new (
                        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                        photo_data TEXT,
                        order_num INTEGER NOT NULL,
                        updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        storage_key TEXT,
                        sha256 TEXT,
                        bytes INTEGER,
                        mime TEXT,
                        PRIMARY KEY (post_id, order_num)
                    )
                `).run();
                db.prepare(`
                    INSERT INTO post_photos_imgstore_new
                        (post_id, photo_data, order_num, updated_at, storage_key, sha256, bytes, mime)
                    SELECT post_id, photo_data, order_num, updated_at, storage_key, sha256, bytes, mime
                      FROM post_photos
                `).run();
                db.prepare(`DROP TABLE post_photos`).run();
                db.prepare(`ALTER TABLE post_photos_imgstore_new RENAME TO post_photos`).run();
                db.prepare(`CREATE INDEX IF NOT EXISTS idx_post_photos_updated_at ON post_photos(updated_at)`).run();
            })();
            console.log('[DB] post_photos.photo_data is now optional — the image store holds the bytes.');
        }
    } catch (e) {
        // A node that cannot be rebuilt keeps working exactly as before: every row stays inline, the
        // evacuation job finds nothing it may null, and nothing is lost. Loud, because the saving is not
        // happening on this node and an operator should know why.
        console.error('[DB] ⚠️  Could not make post_photos.photo_data optional; photos stay in the database:', e);
    }
    try {
        const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_attachments'").get() as any)?.sql as string | undefined;
        if (ddl && /\bdata\s+TEXT\s+NOT\s+NULL/i.test(ddl)) {
            db.transaction(() => {
                db.prepare(`
                    CREATE TABLE message_attachments_imgstore_new (
                        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                        data TEXT,
                        nonce TEXT NOT NULL,
                        mime TEXT,
                        created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        storage_key TEXT
                    )
                `).run();
                db.prepare(`
                    INSERT INTO message_attachments_imgstore_new
                        (message_id, data, nonce, mime, created_at, storage_key)
                    SELECT message_id, data, nonce, mime, created_at, storage_key
                      FROM message_attachments
                `).run();
                db.prepare(`DROP TABLE message_attachments`).run();
                db.prepare(`ALTER TABLE message_attachments_imgstore_new RENAME TO message_attachments`).run();
            })();
            console.log('[DB] message_attachments.data is now optional — the image store holds the ciphertext.');
        }
    } catch (e) {
        console.error('[DB] ⚠️  Could not make message_attachments.data optional; attachments stay in the database:', e);
    }

    try { db.prepare(`ALTER TABLE projects ADD COLUMN updated_at DATETIME`).run(); } catch { }
    // Phase 2 delta backup — the remaining mutable tables gain their watermark
    // column here, BEFORE schema.sql exec, so the messages/friends/abuse_reports/
    // conversation_participants touch triggers below can reference updated_at at
    // compile time on already-live DBs. SQLite forbids a non-constant DEFAULT on
    // ALTER ADD COLUMN, so these come in NULL on existing rows (backfilled after
    // schema.sql) and NULL on new inserts (stamped by the AFTER INSERT triggers).
    try { db.prepare(`ALTER TABLE messages ADD COLUMN updated_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE friends ADD COLUMN updated_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE abuse_reports ADD COLUMN updated_at DATETIME`).run(); } catch { }
    // Moderation status. MUST be before the schema.sql exec below: schema.sql declares
    // idx_abuse_reports_status_created ON abuse_reports(status, ...), and on a node whose
    // abuse_reports table predates this column the exec hits that index, fails, and the node does
    // not boot. Adding the column afterwards is too late — the exec has already thrown.
    try { db.prepare(`ALTER TABLE abuse_reports ADD COLUMN status TEXT DEFAULT 'pending'`).run(); } catch { }
    // A report can target a Pulse item. Before schema.sql like its neighbours, so any later index
    // or trigger naming it compiles on already-live DBs.
    try { db.prepare(`ALTER TABLE abuse_reports ADD COLUMN target_pulse_item_id TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE conversation_participants ADD COLUMN updated_at DATETIME`).run(); } catch { }
    // The open door's replication watermark (engine/open-join.ts). Before schema.sql, which indexes it; a node that has
    // no open_joins table yet gets the column from schema.sql itself. Backfilled from joined_at after the exec.
    try { db.prepare(`ALTER TABLE open_joins ADD COLUMN updated_at TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE pulse_items ADD COLUMN curated INTEGER NOT NULL DEFAULT 0`).run(); } catch { }

    // #104 step 3b: the settlement exchange needs four more columns on `settlements`.
    //
    // These MUST come BEFORE the schema.sql exec below, exactly like the trigger-referenced member columns
    // above (review finding — this was a hard boot failure). schema.sql defines
    // `idx_settlements_reserved_until` over `settlements(reserved_until)`, and on a node that already
    // created `settlements` from step 3a the `CREATE TABLE IF NOT EXISTS` no-ops against the OLD shape —
    // so the index then references a column that does not exist, SQLite aborts the whole `db.exec` with
    // "no such column", and the node fails to boot. Adding the columns first makes the index compile.
    //
    //   seller_pubkey   — inbound: who we pay when the receipt lands
    //   fee             — outbound: charged to the buyer on top of the price (§2.1), refunded on reversal
    //   reserved_until  — inbound: when the cap reservation lapses (indexed by schema.sql)
    //   receipt_payload — outbound: the exact signed receipt object, so a retry replays identical bytes
    //
    // A CHECK constraint cannot be added by ALTER TABLE in SQLite, so `fee >= 0` binds only on tables
    // created from schema.sql. Pre-existing rows are all fee = 0, and every writer goes through
    // crossNodeFee(), which cannot return a negative for a positive amount.
    try { db.prepare(`ALTER TABLE settlements ADD COLUMN seller_pubkey TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE settlements ADD COLUMN fee REAL NOT NULL DEFAULT 0`).run(); } catch { }
    try { db.prepare(`ALTER TABLE settlements ADD COLUMN reserved_until DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE settlements ADD COLUMN receipt_payload TEXT`).run(); } catch { }

    // #127: columns that schema.sql OBJECTS reference, so they have to exist before the exec.
    //
    // Same failure as the settlements block above, found by auditing for the class rather than waiting for
    // the next report. `db.exec()` runs the whole file as one unit, and one failing statement aborts all of
    // it — so the node will not start. `CREATE TABLE IF NOT EXISTS` no-ops against an existing table, so only
    // nodes that ALREADY HAVE DATA are affected: every deployed node, and no test suite, because they all
    // start from an empty data dir.
    //
    // ONE of these was the actual boot failure. Measured, not assumed — each reference kind was probed
    // against a legacy `posts` table:
    //
    //   posts.updated_at        → INDEX idx_posts_updated_at        FATAL: "no such column: updated_at"
    //   posts.search_keywords   → TRIGGERS posts_ai / ad / au       boots fine (FTS5 mirror, body reference)
    //   members.earned_credit   → TRIGGER members_touch_updated_at  boots fine, and later FIRES correctly
    //   members.profile_updated_at → same trigger                   boots fine
    //
    // Indexes resolve their columns at CREATE time; triggers resolve theirs when they fire. Only the index
    // breaks. The other three are hoisted anyway: trigger tolerance is an implementation detail of the SQLite
    // build we ship rather than a documented guarantee, and "if schema.sql names it, add it before the exec"
    // is a cheaper rule to keep than an exception list.
    //
    // test-schema-upgrade.ts enforces this statically for EVERY late-added column — separating the fatal
    // index case from the defensive trigger one — so a column added below the exec fails in CI rather than on
    // somebody's node.
    try {
        db.prepare(`ALTER TABLE posts ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE posts SET updated_at = created_at WHERE updated_at IS NULL`).run();
    } catch { }
    // FTS5 search: the posts_ai/ad/au triggers mirror this into posts_fts.
    try { db.prepare(`ALTER TABLE posts ADD COLUMN search_keywords TEXT DEFAULT ''`).run(); } catch { }
    // Protocol v1: pre-seeded earned credit for the dynamic floor formula.
    try { db.prepare(`ALTER TABLE members ADD COLUMN earned_credit REAL DEFAULT 0`).run(); } catch { }
    // Enterprise Credit Model (Rules 6 & 7)
    try { db.prepare(`ALTER TABLE members ADD COLUMN earned_surplus REAL DEFAULT 0`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN working_capital_ceiling REAL DEFAULT NULL`).run(); } catch { }
    // Grandfathered enterprise floor (Slice 4)
    try { db.prepare(`ALTER TABLE members ADD COLUMN legacy_credit_floor REAL DEFAULT NULL`).run(); } catch { }
    // Profile sync: profile mutation timestamp for cache-busting.
    try { db.prepare(`ALTER TABLE members ADD COLUMN profile_updated_at DATETIME`).run(); } catch { }
    // Community Working Style / Archetype signature
    try { db.prepare(`ALTER TABLE members ADD COLUMN archetype TEXT`).run(); } catch { }
    // Enterprise / Project unification (docs/the-commons.md §2.1, Slice 3)
    try { db.prepare(`ALTER TABLE members ADD COLUMN purpose TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN goal_amount REAL DEFAULT NULL`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN deadline_at DATETIME DEFAULT NULL`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN lifecycle TEXT DEFAULT 'ongoing'`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN paused INTEGER DEFAULT 0`).run(); } catch { }
    try { db.prepare(`ALTER TABLE projects ADD COLUMN migrated_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE projects ADD COLUMN enterprise_pubkey TEXT`).run(); } catch { }

    // Deploy 2: drop the Deploy 1 members trigger so schema.sql re-creates it with the
    // column-whitelist form that excludes last_active_at heartbeats from cursor sync.
    // CREATE TRIGGER IF NOT EXISTS is a no-op against an existing trigger.
    try { db.prepare(`DROP TRIGGER IF EXISTS members_touch_updated_at`).run(); } catch { }

    // #143 step 4: per-listing reach. Existing rows take 'local', which is the point — nobody who posted
    // before federation existed agreed to their listing travelling.
    //
    // MUST BE HERE, BEFORE the schema.sql exec below, because schema.sql defines idx_posts_reach over these
    // columns and CREATE INDEX on a missing column is a hard error, not a no-op. test-schema-upgrade caught
    // exactly that when these two lines sat with the other posts migrations further down — the suite exists
    // for this failure and earned its keep.
    //
    // NO CHECK CONSTRAINT on the migrated column, unlike the fresh-schema definition: SQLite cannot add one
    // via ALTER TABLE, and rebuilding `posts` to acquire it would be a table copy on every live node for a
    // constraint the write paths already enforce. Fresh databases get it; upgraded ones rely on
    // `normaliseReach` at the boundary, which is where a bad value would come from anyway.
    try { db.prepare(`ALTER TABLE posts ADD COLUMN reach TEXT NOT NULL DEFAULT 'local'`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN reach_peers TEXT`).run(); } catch { }

    // Audience scoping on posts (docs/the-commons.md §9, Item 10)
    // Additive and idempotent migration: every existing post defaults to 'public'.
    //
    // ORPHANED ROWS NOTE: SQLite does NOT enforce REFERENCES ... ON DELETE CASCADE added via
    // ALTER TABLE ADD COLUMN on upgraded nodes (the clause is parsed by SQLite but ignored).
    // If a group is deleted on an upgraded node without compensation, group-scoped posts would
    // retain a dangling target_group_id, rendering them orphaned and invisible to everyone.
    // We enforce this cascade explicitly via the posts_cleanup_on_group_delete trigger defined
    // in schema.sql and ensured below.
    try { db.prepare(`ALTER TABLE posts ADD COLUMN audience_scope TEXT NOT NULL DEFAULT 'public'`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN target_group_id TEXT REFERENCES groups(id) ON DELETE CASCADE`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN target_pubkey TEXT REFERENCES members(public_key)`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN assigned_to TEXT REFERENCES members(public_key)`).run(); } catch { }
    // Dormant: nothing reads or writes target_archetypes (archetypes gate nothing, docs/the-commons.md).
    // Kept because dropping a column means rebuilding posts on every node.
    try { db.prepare(`ALTER TABLE posts ADD COLUMN target_archetypes TEXT`).run(); } catch { }
    try { db.prepare(`UPDATE posts SET audience_scope = 'public' WHERE audience_scope IS NULL`).run(); } catch { }

    try { db.prepare(`ALTER TABLE transactions ADD COLUMN project_id TEXT REFERENCES projects(id)`).run(); } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_transactions_project_id ON transactions(project_id)`).run(); } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_members_pubkey_nocase ON members(public_key COLLATE NOCASE)`).run(); } catch { }

    // ---------------------------------------------------------------------------------
    // EVERY `ALTER TABLE ... ADD COLUMN` LIVES ABOVE THE schema.sql EXEC. DO NOT ADD ONE BELOW IT.
    //
    // schema.sql may define an index, view or trigger over any of these columns. CREATE INDEX
    // against a missing column is a hard error, not a no-op — so an ALTER that runs after the
    // exec cannot save a database that the exec has already refused to open. The node does not
    // start, and the only symptom is `no such column: <x>` at boot.
    //
    // This has now happened twice: #127 (posts.updated_at, posts.search_keywords,
    // members.earned_credit, members.profile_updated_at) and #172 (abuse_reports.status).
    // Both times the fix was to move the one offending column. test-schema-alter-ordering.ts
    // enforces the rule for all of them instead, and will fail the build if a new ALTER
    // appears below this point or names a column that schema.sql does not also declare.
    //
    // On a FRESH database these ALTERs fail into their empty catch (the table does not exist
    // yet) and schema.sql creates each column as part of the CREATE TABLE. That is why the
    // schema.sql declaration is mandatory, not merely tidy.
    // ---------------------------------------------------------------------------------
    try { db.prepare(`ALTER TABLE posts ADD COLUMN price_type TEXT DEFAULT 'fixed'`).run(); } catch { }
    try { db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN hours REAL`).run(); } catch { }
    try { db.prepare(`ALTER TABLE transactions ADD COLUMN tax_fee REAL DEFAULT 0.0`).run(); } catch { }
    try { db.prepare(`ALTER TABLE transactions ADD COLUMN auth_signer TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE transactions ADD COLUMN auth_signature TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE transactions ADD COLUMN auth_payload TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE invite_codes ADD COLUMN genesis_type TEXT DEFAULT 'standard'`).run(); } catch { }
    try { db.prepare(`ALTER TABLE invite_codes ADD COLUMN issued_by TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN cash_also_needed INTEGER DEFAULT 0`).run(); } catch { }
    try { db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN last_reminded_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE messages ADD COLUMN edited_at DATETIME`).run(); } catch { }
    try {
        db.prepare(`ALTER TABLE members ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE members SET updated_at = COALESCE(profile_updated_at, last_active_at, joined_at) WHERE updated_at IS NULL`).run();
    } catch { }
    try {
        db.prepare(`ALTER TABLE post_photos ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE post_photos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE updated_at IS NULL`).run();
    } catch { }
    try {
        db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE marketplace_transactions SET updated_at = COALESCE(completed_at, created_at) WHERE updated_at IS NULL`).run();
    } catch { }
    try {
        db.prepare(`ALTER TABLE projects ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE projects SET updated_at = created_at WHERE updated_at IS NULL`).run();
    } catch { }

    // Step 7: recovery share replication audit column
    try { db.prepare(`ALTER TABLE sync_audit_log ADD COLUMN recovery_shares_imported INTEGER NOT NULL DEFAULT 0`).run(); } catch { }
    try { db.prepare(`ALTER TABLE recovery_releases ADD COLUMN kdf_params TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN created_by TEXT REFERENCES members(public_key) ON DELETE SET NULL`).run(); } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_posts_created_by ON posts(created_by)`).run(); } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_buyer_status_created ON marketplace_transactions(buyer_pubkey, status, created_at DESC)`).run(); } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_seller_status_created ON marketplace_transactions(seller_pubkey, status, created_at DESC)`).run(); } catch { }

    // Community Polls (§3.2, §8): JSON array of {id, text} options, and expiration timestamp
    try { db.prepare(`ALTER TABLE posts ADD COLUMN poll_options TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN poll_closes_at DATETIME`).run(); } catch { }
    try { db.exec(`DROP INDEX IF EXISTS idx_poll_votes_post_id;`); } catch { }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_poll_votes_voter_pubkey ON poll_votes(voter_pubkey);`); } catch { }
    try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_author_active_poll ON posts(author_pubkey) WHERE type = 'poll' AND status = 'active';`); } catch { }

    // Events (docs/events-on-the-map.md §2.1). Before the schema.sql exec, which indexes event_end_at.
    try { db.prepare(`ALTER TABLE posts ADD COLUMN event_start_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN event_end_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN event_place_name TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN event_private_note TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN event_state TEXT CHECK (event_state IS NULL OR event_state IN ('scheduled', 'updated', 'cancelled'))`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN event_conversation_id TEXT`).run(); } catch { }
    // Moderation on the global profile (G3, engine/auto-moderation.ts). Before the schema.sql exec, which indexes
    // hidden_by_reports_at and (author_pubkey, removed_by_moderator_at), and whose members_touch_updated_at (dropped
    // below, so the exec recreates it) lists moderation_muted_until. NULL on every existing row: nothing hidden,
    // nothing removed by a moderator, nobody muted.
    try { db.prepare(`ALTER TABLE posts ADD COLUMN hidden_by_reports_at TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE posts ADD COLUMN removed_by_moderator_at TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN moderation_muted_until TEXT`).run(); } catch { }
    // A person's coarse area (G4, engine/member-area.ts). Before the schema.sql exec, whose members_touch_updated_at
    // (dropped below, so the exec recreates it) lists all three. NULL on every existing row: nobody has an area.
    try { db.prepare(`ALTER TABLE members ADD COLUMN area_lat REAL CHECK (area_lat IS NULL OR (area_lat >= -90 AND area_lat <= 90))`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN area_lng REAL CHECK (area_lng IS NULL OR (area_lng >= -180 AND area_lng <= 180))`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN area_updated_at TEXT`).run(); } catch { }
    // Per-person reminders for one event (docs/events-on-the-map.md §2.1). Here with the other event
    // columns and BEFORE the schema.sql exec, for the same reason they are: schema.sql indexes
    // event_rsvps, and a CREATE INDEX that runs against a table the exec has already refused to re-shape
    // is not the failure we want to discover at boot. NULL on every existing row means "my default
    // applies", which is exactly the behaviour a node that upgrades into this should have.
    try { db.prepare(`ALTER TABLE event_rsvps ADD COLUMN reminder_offsets TEXT`).run(); } catch { }

    // Enterprise pause and wind-up (docs/the-commons.md §2.2, §2.6, Slice 6)
    try { db.prepare(`ALTER TABLE members ADD COLUMN paused_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN paused_by TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN paused_floor_snapshot REAL`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN wind_up_initiated_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN wind_up_initiated_by TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN wind_up_finalised_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE treasury_operators ADD COLUMN backing REAL DEFAULT 0`).run(); } catch { }
    try { db.prepare(`DROP TRIGGER IF EXISTS members_touch_updated_at`).run(); } catch { }

    // Enterprise keeper answers (A, G, M): a lead installed automatically (community removal of the old lead, or
    // the old lead stepping down) is marked, which opens succession at once; succession gets a deadline, a
    // closing reason (rejected / expired / lead returned) and a yes-or-no vote.
    try { db.prepare(`ALTER TABLE treasury_operators ADD COLUMN auto_promoted_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE enterprise_succession_proposals ADD COLUMN deadline_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE enterprise_succession_proposals ADD COLUMN closed_reason TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE enterprise_succession_votes ADD COLUMN choice TEXT NOT NULL DEFAULT 'yes' CHECK (choice IN ('yes', 'no'))`).run(); } catch { }

    // Enterprise location (docs/the-commons.md §2.2, Slice 6)
    try { db.prepare(`ALTER TABLE members ADD COLUMN lat REAL CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90))`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN lng REAL CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180))`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN location_auth_signer TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN auth_signer TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE members ADD COLUMN location_updated_at DATETIME`).run(); } catch { }
    try { db.prepare(`DROP TRIGGER IF EXISTS members_touch_updated_at`).run(); } catch { }

    // Key-based admin auth & break-glass (docs/admin-surface.md §2, §5)
    const hasNodeRoles = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_roles'").get();
    if (hasNodeRoles) {
        const nrColumns = (db.prepare("PRAGMA table_info(node_roles)").all() as any[]).map(c => c.name);
        if (!nrColumns.includes('session_epoch')) {
            db.prepare(`ALTER TABLE node_roles ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0`).run();
        }
        if (!nrColumns.includes('break_glass_hash')) {
            db.prepare(`ALTER TABLE node_roles ADD COLUMN break_glass_hash TEXT`).run();
        }
    }

    // node_roles: ensure check constraint allows 'moderator'
    try {
        const nrSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='node_roles'").get() as any;
        if (nrSql?.sql && !nrSql.sql.includes('moderator')) {
            db.transaction(() => {
                db.exec(`
                    DROP TABLE IF EXISTS node_roles_migration;
                    CREATE TABLE node_roles_migration (
                        member_pubkey    TEXT NOT NULL PRIMARY KEY REFERENCES members(public_key) ON DELETE CASCADE,
                        role             TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'moderator')),
                        granted_at       DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        granted_by       TEXT,
                        session_epoch    INTEGER NOT NULL DEFAULT 0,
                        break_glass_hash TEXT
                    );
                    INSERT INTO node_roles_migration (member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
                        SELECT member_pubkey, role, granted_at, granted_by,
                               COALESCE(session_epoch, 0), break_glass_hash FROM node_roles;
                    DROP TABLE node_roles;
                    ALTER TABLE node_roles_migration RENAME TO node_roles;
                    CREATE INDEX IF NOT EXISTS idx_node_roles_role ON node_roles(role);
                `);
            })();
            console.log('[DB] ✅ Migrated node_roles CHECK constraint to allow moderator');
        }
    } catch (err: any) {
        console.error('[DB] ❌ Failed to migrate node_roles table for moderator role:', err?.message || err);
    }

    // group_members: the status CHECK gains 'removed', so a convenor's removal is kept as a record instead of a
    // deleted row that an open group's Join button re-creates. A CHECK cannot be altered in place, so the table
    // is rebuilt. BEFORE the schema.sql exec on purpose: dropping the table drops its touch trigger and indexes,
    // and the exec below re-creates them against the new table.
    try {
        const gmSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='group_members'").get() as any;
        if (gmSql?.sql && !gmSql.sql.includes("'removed'")) {
            db.transaction(() => {
                db.exec(`
                    DROP TABLE IF EXISTS group_members_migration;
                    CREATE TABLE group_members_migration (
                        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                        member_pubkey TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
                        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('convenor', 'member', 'observer')),
                        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_approval', 'invited', 'removed')),
                        joined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        invited_by TEXT REFERENCES members(public_key),
                        updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        PRIMARY KEY (group_id, member_pubkey)
                    );
                    INSERT INTO group_members_migration (group_id, member_pubkey, role, status, joined_at, invited_by, updated_at)
                        SELECT group_id, member_pubkey, role, status, joined_at, invited_by, updated_at FROM group_members;
                    DROP TABLE group_members;
                    ALTER TABLE group_members_migration RENAME TO group_members;
                `);
            })();
            console.log("[DB] ✅ Migrated group_members CHECK constraint to allow 'removed'");
        }
    } catch (err: any) {
        console.error("[DB] ❌ Failed to migrate group_members for the 'removed' status:", err?.message || err);
    }

    // groups.lead_pubkey: the group's LEAD convenor (2026-09-23). A plain ADD COLUMN, on purpose — a fourth value
    // in group_members.role would mean rebuilding that table for its CHECK constraint. Before the schema.sql exec
    // so anything the exec re-creates already sees the column. The backfill is further down, behind a marker.
    try { db.prepare(`ALTER TABLE groups ADD COLUMN lead_pubkey TEXT REFERENCES members(public_key)`).run(); } catch { }

    // Escrow dispute arbitration (§5 item 2, §6 correction 2)
    try { db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN dispute_resolution TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN dispute_resolved_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN dispute_resolved_by TEXT`).run(); } catch { }

    // activity_feed: ensure check constraint allows 'dispute_resolved'
    try {
        const afSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='activity_feed'").get() as any;
        if (afSql?.sql && !afSql.sql.includes('dispute_resolved')) {
            db.transaction(() => {
                db.exec(`
                    DROP TABLE IF EXISTS activity_feed_migration;
                    CREATE TABLE activity_feed_migration (
                        id            INTEGER PRIMARY KEY AUTOINCREMENT,
                        event_type    TEXT NOT NULL CHECK (event_type IN ('member_joined', 'trade_completed', 'rating_given', 'post_created', 'dispute_resolved')),
                        actor_pubkey  TEXT NOT NULL,
                        target_pubkey TEXT,
                        metadata      TEXT,
                        created_at    DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    );
                    INSERT INTO activity_feed_migration (id, event_type, actor_pubkey, target_pubkey, metadata, created_at)
                        SELECT id, event_type, actor_pubkey, target_pubkey, metadata, created_at FROM activity_feed;
                    INSERT OR REPLACE INTO sqlite_sequence (name, seq)
                        SELECT 'activity_feed_migration', seq FROM sqlite_sequence WHERE name = 'activity_feed';
                    DROP TABLE activity_feed;
                    ALTER TABLE activity_feed_migration RENAME TO activity_feed;
                    CREATE INDEX IF NOT EXISTS idx_activity_feed_created ON activity_feed(created_at DESC, id DESC);
                    CREATE INDEX IF NOT EXISTS idx_activity_feed_event ON activity_feed(event_type, created_at DESC);
                `);
            })();
            console.log('[DB] ✅ Migrated activity_feed CHECK constraint to allow dispute_resolved');
        }
    } catch (err: any) {
        console.error('[DB] ❌ Failed to migrate activity_feed table for dispute_resolved:', err?.message || err);
    }

    // posts_au gained a WHEN guard (#878: the posts_touch_updated_at nested UPDATE fired it a second time and
    // desynced posts_fts). CREATE TRIGGER IF NOT EXISTS is a no-op against the old unguarded trigger, so drop
    // it here and let schema.sql create the guarded one. Keyed on the trigger's own text, so this only ever
    // drops the old shape: once replaced, every later boot finds the guard and does nothing.
    try {
        const au = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'posts_au'`).get() as { sql: string } | undefined;
        if (au && !/WHEN\s+OLD\.title\s+IS\s+NOT\s+NEW\.title/i.test(au.sql)) {
            db.prepare(`DROP TRIGGER posts_au`).run();
            console.log('[DB] Replacing posts_au with the guarded FTS trigger');
        }
    } catch (e) {
        console.error('[DB] ❌ Could not replace posts_au:', e);
    }

    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schemaSql);

    // A succession proposal opened before deadlines existed gets the same 14 days from when it opened.
    try {
        db.prepare(`UPDATE enterprise_succession_proposals
                    SET deadline_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+14 days')
                    WHERE deadline_at IS NULL`).run();
    } catch { }

    // One-time posts_fts rebuild, for whatever the unguarded posts_au left behind. A rebuild recomputes the
    // whole external-content index from `posts`, so it repairs any drift and is idempotent — the marker only
    // saves doing it on every boot. user_version moves to 4 AFTER the rebuild succeeds, so a crash in between
    // just means it runs again next boot. Fresh installs pass through here too, on an empty index.
    if ((db.pragma('user_version', { simple: true }) as number) < 4) {
        try {
            const started = Date.now();
            db.exec(`INSERT INTO posts_fts(posts_fts) VALUES('rebuild')`);
            db.pragma('user_version = 4');
            console.log(`[DB] Rebuilt posts_fts (${Date.now() - started}ms)`);
        } catch (e) {
            // Search is degraded, not the node: keep booting, and try again next boot (user_version unchanged).
            console.error('[DB] ❌ posts_fts rebuild failed:', e);
        }
    }


    // Enterprise discussion threads (docs/the-commons.md §2.2, Slice 6)
    // created_at is when the row is written, not the enterprise's joined_at: the delta backup exporter cursors
    // conversations on created_at, so a back-dated row would never reach a replica (#837 review).
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type);`); } catch { }
    try {
        db.prepare(`
            INSERT OR IGNORE INTO conversations (id, type, name, created_by, created_at)
            SELECT public_key, 'enterprise_thread', callsign, public_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            FROM members
            WHERE is_treasury = 1
        `).run();
    } catch { }

    if (ratingsSql && ratingsSql.sql.includes('marketplace_transactions_old')) {
        try {
            console.log("📦 Restoring ratings data...");
            const cols = (db.prepare('PRAGMA table_info(ratings_corrupted)').all() as any[]).map(c => c.name).join(', ');
            db.exec(`INSERT INTO ratings (${cols}) SELECT ${cols} FROM ratings_corrupted;`);
            db.exec(`DROP TABLE ratings_corrupted;`);
            console.log("✅ Ratings table fixed.");
        } catch (err: any) {
            console.error("❌ Ratings fix failed:", err.message);
        }
    }

    // Slice 4 Grandfather migration: existing enterprises keep their fixed line as legacy_credit_floor (min 200)
    // until keepers' pledges exceed it. Gated behind node_config so it runs strictly once.
    try {
        const alreadyMigrated = db.prepare("SELECT 1 FROM node_config WHERE key = 'migration_legacy_credit_floor_v1'").get();
        if (!alreadyMigrated) {
            db.prepare(`
                UPDATE members
                SET legacy_credit_floor = CASE WHEN earned_credit > 200 THEN earned_credit ELSE 200 END
                WHERE is_treasury = 1 AND legacy_credit_floor IS NULL
            `).run();
            db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('migration_legacy_credit_floor_v1', '1')").run();
        }
    } catch { }

    // Slice 6 lead succession (PR #838 B2): a lead becomes replaceable after 30 days with no recorded
    // activity, falling back to joined_at when last_active_at is NULL. Activity used to be recorded only
    // from unverified body fields, so most members have NULL here — on deploy every long-standing lead
    // would be instantly eligible, and in a two-keeper enterprise the other keeper could take the lead at
    // once. Stamp the NULLs with this migration's run time so every lead gets a full 30 days of verified
    // activity recording first. Runs once (node_config marker), so a later boot extends nobody.
    try {
        const alreadyBackfilled = db.prepare("SELECT 1 FROM node_config WHERE key = 'migration_backfill_last_active_at_v1'").get();
        if (!alreadyBackfilled) {
            db.transaction(() => {
                db.prepare(`UPDATE members SET last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE last_active_at IS NULL`).run();
                db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('migration_backfill_last_active_at_v1', '1')").run();
            })();
        }
    } catch { }

    // Every existing group gets its lead convenor (2026-09-23). The rule, and the ONLY thing this touches:
    //   groups.lead_pubkey, where it is NULL — the creator while they are an active convenor of the group,
    //   otherwise the longest-serving active convenor (joined_at ascending, member_pubkey to break a tie so two
    //   nodes reach the same answer). A group with no active convenor keeps a NULL lead and gains one the moment
    //   it has a convenor again, because the read path falls back to this same rule.
    // No membership row, no role and no other column is written. Gated by a marker so it runs strictly once: a
    // later boot must never hand the lead back to a creator the group has since replaced through hand-over, the
    // silence vote or a Decision.
    try {
        const alreadyBackfilled = db.prepare("SELECT 1 FROM node_config WHERE key = 'migration_group_lead_pubkey_v1'").get();
        if (!alreadyBackfilled) {
            db.transaction(() => {
                // Two branches, not one ORDER BY that prefers the creator: SQLite resolves a subquery's ORDER BY
                // against that subquery's own FROM clause, where groups.created_by is not visible. Same shape as
                // leadPubkeySql in @beanpool/engine, which the read path falls back to.
                const res = db.prepare(`
                    UPDATE groups SET lead_pubkey = COALESCE(
                        (SELECT gmc.member_pubkey FROM group_members gmc
                          WHERE gmc.group_id = groups.id AND gmc.member_pubkey = groups.created_by
                            AND gmc.role = 'convenor' AND gmc.status = 'active'),
                        (SELECT gmf.member_pubkey FROM group_members gmf
                          WHERE gmf.group_id = groups.id AND gmf.role = 'convenor' AND gmf.status = 'active'
                          ORDER BY gmf.joined_at ASC, gmf.member_pubkey ASC
                          LIMIT 1)
                    )
                    WHERE lead_pubkey IS NULL
                      AND EXISTS (
                        SELECT 1 FROM group_members gm
                        WHERE gm.group_id = groups.id AND gm.role = 'convenor' AND gm.status = 'active'
                      )
                `).run();
                db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('migration_group_lead_pubkey_v1', '1')").run();
                if (res.changes > 0) console.log(`[DB] ✅ Gave ${res.changes} group(s) a lead convenor`);
            })();
        }
    } catch (err: any) {
        console.error('[DB] ❌ Failed to backfill groups.lead_pubkey:', err?.message || err);
    }

    // PR #839 Blocker A: a wound-up enterprise never keeps its map location. finaliseWindUp now clears it, but
    // an enterprise wound up before that fix still holds the coordinates a keeper may have set on their own
    // house. Clear them. Idempotent without a marker: it matches only completed rows that still have
    // coordinates, so a later boot (or a row that arrives from an older peer) is handled the same way.
    // updated_at is set explicitly so delta sync carries the clear even if the touch trigger is absent.
    try {
        db.prepare(`
            UPDATE members
            SET lat = NULL, lng = NULL,
                location_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE is_treasury = 1 AND status = 'completed' AND (lat IS NOT NULL OR lng IS NOT NULL)
        `).run();
    } catch (err: any) {
        console.error('[DB] ❌ Failed to clear locations of wound-up enterprises:', err?.message || err);
    }

    // Drop dead plaintext private keys from node_config (docs/the-commons.md §6 Slice 4)
    try {
        db.prepare(`DELETE FROM node_config WHERE key LIKE 'treasury_privkey_%'`).run();
    } catch { }

    // SRV-20: cryptographic authorship columns on transactions (see schema.sql).
    // posts.updated_at, posts.search_keywords, members.earned_credit and members.profile_updated_at used to
    // be added HERE. They moved above the exec (#127) because schema.sql objects depend on them.
    //
    // Protocol v1: Admin Genesis Invites — store invite tier type
    // #108: a listing may carry a real cash outlay (fuel/consumables). Flag only, no amount —
    // the app never touches the money, so it must not imply a figure it holds or settles.
    // Rule 4's per-member aggregate exposure read would otherwise full-scan `settlements`.
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_settlements_buyer ON settlements(buyer_pubkey, direction, state)`).run(); } catch { }
    // Reservation expiry runs every recovery cycle; without this it scans every reserved row.
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_settlements_reserved_until ON settlements(reserved_until) WHERE direction = 'inbound' AND state = 'reserved'`).run(); } catch { }
    // Both settlement indexes are recreated rather than left as-is: CREATE INDEX IF NOT EXISTS keeps an
    // older narrower definition on an already-live DB, so the DROP is what actually applies the change.
    //   peer:        equality columns (peer_id, direction) before the IN range on state
    //   unfinalised: created_at, matching the ORDER BY, so recovery avoids a temp sort
    try {
        db.prepare(`DROP INDEX IF EXISTS idx_settlements_peer`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_settlements_peer ON settlements(peer_id, direction, state)`).run();
    } catch { }
    try {
        db.prepare(`DROP INDEX IF EXISTS idx_settlements_unfinalised`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_settlements_unfinalised ON settlements(created_at) WHERE state IN ('escrowed', 'reserved', 'committed', 'held')`).run();
    } catch { }
    // Moderation status column moved ABOVE the schema.sql exec — see the note there. The index
    // stays: it is idempotent, and it covers a node that somehow reached this point without it.
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_abuse_reports_status_created ON abuse_reports(status, created_at DESC)`).run(); } catch { }
    // Marketplace hygiene: track when a lingering escrow deal was last nudged
    // Edit-message window: timestamp of the most recent edit (null = never edited)
    // Perf: Add index to conversation_participants
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversation_participants_pubkey ON conversation_participants(public_key)`).run(); } catch { }
    // Perf: Add index to marketplace_transactions for status and completed_at (PR 26 review fix)
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_status_completed ON marketplace_transactions(status, completed_at)`).run(); } catch { }

    // Dropped, not replaced. `idx_creator_channels_syndicate(syndicate_to_node, category)` led on a
    // two-valued column and matched no query that ships: the only read of syndicate_to_node is
    // listPublicChannels, whose selective term is owner_pubkey and which uses
    // idx_creator_channels_owner. Every insert, update and tombstone-scrub paid to maintain it —
    // and a delete writes three times. Phase 2's feed query can add one led by the column it
    // actually filters on, once that query exists to be measured.
    try { db.prepare(`DROP INDEX IF EXISTS idx_creator_channels_syndicate`).run(); } catch { }

    // Phase 2 delta sync: add updated_at columns + indexes to mutable tables that
    // didn't previously track row-level mutation timestamps. Backfill from the
    // most recent existing timestamp so cursor scans don't miss pre-migration rows.
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_members_updated_at ON members(updated_at)`).run(); } catch { }
    try { db.prepare(`UPDATE open_joins SET updated_at = joined_at WHERE updated_at IS NULL`).run(); } catch { }

    // Per-node callsign uniqueness: case-insensitive, excluding 'migrated' and 'pruned'
    // members (they left — their name is reclaimable). Guarded on purpose: if a node
    // still has duplicate callsigns the index BUILD fails, and we must NOT crash
    // startup over it. We log loudly instead — the app-level check in updateProfile
    // still enforces new renames; the admin de-dupes and the index builds next boot.
    // Fresh nodes start empty, so it builds cleanly and enforces at the DB level too.
    //
    // The DROP is a migration: nodes built before 'pruned' was reclaimable carry the
    // narrower `status != 'migrated'` predicate, and CREATE ... IF NOT EXISTS would
    // silently keep it — leaving the DB rejecting renames that isCallsignAvailable()
    // has already allowed (a raw SQLITE_CONSTRAINT surfacing as a 500). Dropping is
    // safe: the new predicate indexes a strict SUBSET of the old one's rows, so any
    // node whose old index built cleanly will build this one cleanly too.
    try {
        db.prepare(`DROP INDEX IF EXISTS idx_members_callsign_unique`).run();
        db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_callsign_unique ON members(lower(callsign)) WHERE status NOT IN ('migrated', 'pruned')`).run();
    } catch (e) {
        console.error(`[DB] ⚠️  Could not build unique callsign index — this node has duplicate callsigns. De-duplicate the members table and restart to enforce uniqueness at the DB level. App-level rename checks remain active.`, e);
    }

    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_post_photos_updated_at ON post_photos(updated_at)`).run(); } catch { }

    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_updated_at ON marketplace_transactions(updated_at)`).run(); } catch { }

    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at)`).run(); } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_members_invited_by ON members(invited_by)`).run(); } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_members_is_treasury ON members(public_key, callsign, paused, status) WHERE is_treasury = 1`).run(); } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_transactions_auth_signer ON transactions(auth_signer) WHERE auth_signer IS NOT NULL`).run(); } catch { }

    // Enterprise Credit Model (Rule 6): One-time backfill of earned_surplus for pre-existing enterprises
    // from historical completed external sales. Gated behind node_config so it runs strictly once
    // and never resets legitimately spent surplus on server reboot ("infinite wage glitch").
    try {
        const alreadyMigrated = db.prepare("SELECT 1 FROM node_config WHERE key = 'migration_earned_surplus_backfilled_v1'").get();
        if (!alreadyMigrated) {
            db.prepare(`
                UPDATE members
                SET earned_surplus = MAX(0, COALESCE((
                    SELECT SUM(credits) FROM marketplace_transactions
                    WHERE seller_pubkey = members.public_key AND status = 'completed'
                      AND buyer_pubkey NOT IN (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = members.public_key)
                ), 0) - COALESCE((
                    SELECT SUM(credits) FROM marketplace_transactions
                    WHERE buyer_pubkey = members.public_key AND status = 'completed'
                      AND seller_pubkey IN (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = members.public_key)
                ), 0))
                WHERE is_treasury = 1
            `).run();
            db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('migration_earned_surplus_backfilled_v1', '1')").run();
        }
    } catch (e) {
        console.error('[DB] Failed to backfill earned_surplus:', e);
    }

    // Migration: Replace table-wide transaction_id UNIQUE on deferred_wage_claims with partial unique index
    try {
        const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deferred_wage_claims'").get() as any)?.sql || '';
        if (tableSql.includes('transaction_id    TEXT UNIQUE') || tableSql.includes('transaction_id TEXT UNIQUE')) {
            db.exec(`
                CREATE TABLE deferred_wage_claims_new (
                    id                TEXT PRIMARY KEY,
                    enterprise_pubkey TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
                    keeper_pubkey     TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
                    post_id           TEXT REFERENCES posts(id) ON DELETE SET NULL,
                    transaction_id    TEXT REFERENCES marketplace_transactions(id) ON DELETE CASCADE,
                    amount            REAL NOT NULL,
                    status            TEXT NOT NULL DEFAULT 'pending',
                    created_at        DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    paid_at           DATETIME
                );
                INSERT INTO deferred_wage_claims_new SELECT id, enterprise_pubkey, keeper_pubkey, post_id, transaction_id, amount, status, created_at, paid_at FROM deferred_wage_claims;
                DROP TABLE deferred_wage_claims;
                ALTER TABLE deferred_wage_claims_new RENAME TO deferred_wage_claims;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_deferred_claims_tx_active
                ON deferred_wage_claims(transaction_id)
                WHERE transaction_id IS NOT NULL AND status IN ('pending', 'paid');
                CREATE INDEX IF NOT EXISTS idx_deferred_claims_enterprise ON deferred_wage_claims(enterprise_pubkey, status);
                CREATE INDEX IF NOT EXISTS idx_deferred_claims_lookup ON deferred_wage_claims(enterprise_pubkey, keeper_pubkey, post_id, status);
            `);
        }
    } catch (e) {
        console.error('[DB] Failed to rebuild deferred_wage_claims schema:', e);
    }

    // Phase 2 delta backup — backfill the four newly-watermarked mutable tables.
    // Seed each row's updated_at from the best existing timestamp so a first delta
    // pull after this migration doesn't have to full-reconcile them. COALESCE falls
    // back to now() only if every source column is NULL (shouldn't happen, but keeps
    // the watermark non-NULL so the row stays visible to `WHERE updated_at > :since`).
    // Idempotent: WHERE updated_at IS NULL means re-running is a no-op. The indexes +
    // touch triggers themselves come from schema.sql (already exec'd above).
    try { db.prepare(`UPDATE messages SET updated_at = COALESCE(edited_at, timestamp, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE updated_at IS NULL`).run(); } catch { }
    try { db.prepare(`UPDATE friends SET updated_at = COALESCE(added_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE updated_at IS NULL`).run(); } catch { }
    try { db.prepare(`UPDATE abuse_reports SET updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE updated_at IS NULL`).run(); } catch { }
    try { db.prepare(`UPDATE conversation_participants SET updated_at = COALESCE(last_read_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE updated_at IS NULL`).run(); } catch { }

    // The role was briefly labelled 'steward', which collided with the Steward TRUST TIER
    // (protocol-rules §7) — two different meanings for one word. Renamed to 'keeper'. Cheap and
    // idempotent; the column isn't read yet, so this is tidiness rather than a behaviour change.
    try { db.prepare(`UPDATE treasury_operators SET role='keeper' WHERE role='steward'`).run(); } catch { }
    try {
        ripOutLegacyVoting(db);
    } catch (err) {
        console.error('[DB] ⚠️ Could not remove retired voting data:', err);
    }
    // One open Decision per member author; the node's own "Keep this suspension?" votes (author SYSTEM) are exempt.
    try { db.exec(`DROP INDEX IF EXISTS idx_decisions_author_open;`); } catch { }
    try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_member_author_open ON decisions(author_pubkey) WHERE status = 'open' AND author_pubkey != 'SYSTEM';`); } catch { }
    try {
        db.exec(`
            DROP TRIGGER IF EXISTS posts_cleanup_on_group_delete;
            CREATE TRIGGER IF NOT EXISTS posts_cleanup_on_group_delete
            AFTER DELETE ON groups
            FOR EACH ROW
            BEGIN
                UPDATE posts SET target_group_id = NULL,
                       active = 0, status = 'cancelled',
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE target_group_id = OLD.id;
            END;
        `);
    } catch { }

    seedTreasuryOperatorsFromLegacyFlag();
    seedNodeRolesFromGenesis();

    try {
        seedPricingGuideIfEmpty(false, db);
    } catch (err) {
        console.error('[DB] ⚠️ Could not seed pricing guide items:', err);
    }

    try {
        migrateProjectsAndCommonsToEnterprises(db);
    } catch (err) {
        console.error('[DB] ⚠️ Could not run unify projects migration:', err);
    }
}

export { migrateProjectsAndCommonsToEnterprises };

/**
 * #106 treasury keepership — seed the join table from the legacy node-wide flag.
 *
 * Before `treasury_operators` existed, `members.can_operate = 1` granted authority over EVERY
 * treasury on the node. Existing keepers must not silently lose access on upgrade, and we cannot
 * know which enterprise each of them was actually meant to run — so we **over-grant** (a row per
 * existing treasury) and let the admin prune. That is deliberately the safe direction: briefly-broad
 * access beats locking a community out of its own enterprises on a deploy.
 *
 * Guarded on the table being EMPTY rather than on individual rows: once an admin has pruned,
 * re-running must not resurrect what they removed.
 *
 * @returns how many rows were written (0 when it was a no-op)
 */
export function seedTreasuryOperatorsFromLegacyFlag(): number {
    try {
        const already = db.prepare(`SELECT COUNT(*) AS c FROM treasury_operators`).get() as any;
        if (already?.c) return 0;

        const legacy = db.prepare(`SELECT public_key FROM members WHERE can_operate = 1`).all() as any[];
        const treasuries = db.prepare(`SELECT public_key FROM members WHERE is_treasury = 1`).all() as any[];
        if (!legacy.length || !treasuries.length) return 0;

        const ins = db.prepare(
            `INSERT OR IGNORE INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by)
             VALUES (?, ?, 'keeper', 'migration:can_operate')`
        );
        db.transaction(() => {
            for (const t of treasuries) for (const m of legacy) ins.run(t.public_key, m.public_key);
        })();

        const written = legacy.length * treasuries.length;
        console.log(`🏛️  Treasury keepership migrated: ${legacy.length} keeper(s) × ${treasuries.length} enterprise(s) = ${written} binding(s). Prune per-enterprise in Settings.`);
        return written;
    } catch (e) {
        console.error('[DB] ⚠️  Could not seed treasury_operators from can_operate. Existing keepers may need re-assigning per enterprise.', e);
        return 0;
    }
}

/**
 * #node-roles — seed the node_roles table from legacy genesis members.
 * (docs/admin-surface.md §1, §5; docs/the-commons.md §9.2)
 *
 * On boot, if `node_roles` is empty, seed it from today's de-facto admin: the genesis member(s),
 * EXCLUDING the 'SYSTEM' row. If there are several genesis members, seed them all as 'owner' and
 * log loudly which ones. If there are NONE, log a loud warning and leave the table empty rather
 * than inventing an owner.
 *
 * Make it idempotent — it runs on every boot. Guarded on the table being EMPTY rather than on
 * individual rows: once an owner has been removed or appointed, re-running must not resurrect
 * what was removed.
 *
 * @returns how many rows were written (0 when it was a no-op)
 */
export function seedNodeRolesFromGenesis(): number {
    try {
        const genesisMembers = db.prepare(
            `SELECT public_key, callsign FROM members
             WHERE invited_by = 'genesis' AND public_key != 'SYSTEM' AND status = 'active'
               AND public_key NOT IN (SELECT member_pubkey FROM node_roles)
             ORDER BY rowid ASC`
        ).all() as { public_key: string; callsign: string }[];

        if (!genesisMembers.length) {
            const currentRoles = (db.prepare(`SELECT COUNT(*) as c FROM node_roles`).get() as any)?.c || 0;
            if (currentRoles === 0) {
                console.warn('[DB] ⚠️  No genesis member found to seed node_roles! node_roles left empty. Node has no owner until one is enrolled.');
            }
            return 0;
        }

        const ins = db.prepare(
            `INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by)
             VALUES (?, 'owner', 'migration:genesis')`
        );
        db.transaction(() => {
            for (const g of genesisMembers) {
                ins.run(g.public_key);
            }
        })();

        console.log(`👑 Node roles seeded: ${genesisMembers.length} genesis member(s) granted 'owner': ${genesisMembers.map(g => `${g.callsign} (${g.public_key})`).join(', ')}`);
        return genesisMembers.length;
    } catch (e) {
        console.error('[DB] ⚠️  Could not seed node_roles from genesis members:', e);
        return 0;
    }
}

// Function to migrate from legacy JSON state
export function migrateLegacyState() {
    if (!fs.existsSync(STATE_JSON_PATH)) {
        return; // Nothing to migrate
    }

    // Check if we already migrated (e.g., db has members)
    const countQuery = db.prepare("SELECT COUNT(*) as count FROM members").get() as { count: number };
    if (countQuery.count > 0) {
        console.log('📒 SQLite DB already populated. Skipping state.json migration.');
        // Rename anyway to prevent future confusion
        fs.renameSync(STATE_JSON_PATH, STATE_BACKUP_PATH);
        return;
    }

    console.log('🔄 Starting migration from state.json to SQLite...');
    const raw = fs.readFileSync(STATE_JSON_PATH, 'utf-8');
    let state;
    try {
        state = JSON.parse(raw);
    } catch (err: any) {
        console.error('❌ Failed to parse state.json:', err.message);
        return;
    }

    // Prepare statements
    const insertMember = db.prepare(`
        INSERT OR IGNORE INTO members (
            public_key, callsign, joined_at, invited_by, invite_code, home_node_url,
            avatar_url, bio, contact_value, contact_visibility, status, last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertInviteCode = db.prepare(`
        INSERT OR IGNORE INTO invite_codes (code, created_by, created_at, used_by, used_at, intended_for)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertAccount = db.prepare(`
        INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch)
        VALUES (?, ?, ?)
    `);

    const insertTransaction = db.prepare(`
        INSERT OR IGNORE INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertPost = db.prepare(`
        INSERT OR IGNORE INTO posts (
            id, type, category, title, description, credits, author_pubkey, created_at,
            active, status, repeatable, accepted_by, accepted_at, pending_transaction_id,
            completed_at, lat, lng, origin_node
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertPostPhoto = db.prepare(`
        INSERT OR IGNORE INTO post_photos (post_id, photo_data, order_num)
        VALUES (?, ?, ?)
    `);

    const insertMarketplaceTx = db.prepare(`
        INSERT OR IGNORE INTO marketplace_transactions (
            id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertConversation = db.prepare(`
        INSERT OR IGNORE INTO conversations (id, type, post_id, name, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertParticipant = db.prepare(`
        INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key, last_read_at)
        VALUES (?, ?, ?)
    `);

    const insertMessage = db.prepare(`
        INSERT OR IGNORE INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertFriend = db.prepare(`
        INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey, added_at)
        VALUES (?, ?, ?)
    `);

    const insertRating = db.prepare(`
        INSERT OR IGNORE INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertReport = db.prepare(`
        INSERT OR IGNORE INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertConfig = db.prepare(`
        INSERT OR IGNORE INTO node_config (key, value)
        VALUES (?, ?)
    `);

    // Perform the entire migration inside a transaction
    const migrate = db.transaction(() => {
        // 1. Members and Profiles
        if (state.members) {
            for (const m of state.members) {
                const profile = state.profiles?.[m.publicKey] || {};
                const contactValue = profile.contact?.value || null;
                const contactVis = profile.contact?.visibility || null;

                insertMember.run(
                    m.publicKey, m.callsign, m.joinedAt,
                    m.invitedBy || 'genesis', m.inviteCode || 'legacy', m.homeNodeUrl || null,
                    profile.avatar || null, profile.bio || null, contactValue, contactVis,
                    profile.status || 'active', profile.lastActiveAt || null
                );
            }
        }

        // 2. Invite Codes
        if (state.inviteCodes) {
            for (const inv of state.inviteCodes) {
                insertInviteCode.run(
                    inv.code, inv.createdBy, inv.createdAt,
                    inv.usedBy || null, inv.usedAt || null, inv.intendedFor || null
                );
            }
        }

        // 3. Accounts
        if (state.ledgerAccounts) {
            for (const acc of state.ledgerAccounts) {
                insertAccount.run(acc.id, acc.balance, acc.lastDemurrageEpoch || 0);
            }
        }

        // 4. Transactions
        if (state.transactions) {
            for (const tx of state.transactions) {
                insertTransaction.run(tx.id, tx.from, tx.to, tx.amount, tx.memo || '', tx.timestamp);
            }
        }

        // 5. Posts and Photos
        if (state.posts) {
            for (const p of state.posts) {
                insertPost.run(
                    p.id, p.type, p.category, p.title, p.description, p.credits || 0,
                    p.authorPublicKey, p.createdAt,
                    p.active ? 1 : 0, p.status || (p.active ? 'active' : 'cancelled'),
                    p.repeatable ? 1 : 0, p.acceptedBy || null, p.acceptedAt || null,
                    p.pendingTransactionId || null, p.completedAt || null,
                    p.lat ?? null, p.lng ?? null, p.originNode || null
                );

                if (p.photos && Array.isArray(p.photos)) {
                    p.photos.forEach((photoData: string, idx: number) => {
                        insertPostPhoto.run(p.id, photoData, idx);
                    });
                }
            }
        }

        // 6. Marketplace Transactions
        if (state.marketplaceTransactions) {
            for (const mtx of state.marketplaceTransactions) {
                insertMarketplaceTx.run(
                    mtx.id, mtx.postId, mtx.buyerPublicKey, mtx.sellerPublicKey,
                    mtx.credits, mtx.status || 'pending', mtx.createdAt, mtx.completedAt || null
                );
            }
        }

        // 7. Conversations and Messages
        if (state.conversations) {
            for (const conv of state.conversations) {
                insertConversation.run(conv.id, conv.type, conv.postId || null, conv.name || null, conv.createdBy || null, conv.createdAt);

                if (conv.participants) {
                    const uniqueParticipants = Array.from(new Set(conv.participants));
                    for (const pubkey of uniqueParticipants) {
                        const pk = pubkey as string;
                        const lastRead = state.readCursors?.[pk]?.[conv.id] || null;
                        insertParticipant.run(conv.id, pk, lastRead);
                    }
                }
            }
        }

        if (state.messages) {
            for (const msg of state.messages) {
                insertMessage.run(msg.id, msg.conversationId, msg.authorPubkey, msg.ciphertext, msg.nonce || '', msg.timestamp);
            }
        }

        // 8. Friends
        if (state.friends) {
            for (const ownerPubkey of Object.keys(state.friends)) {
                const uniqueFriends = new Map();
                for (const friend of state.friends[ownerPubkey]) {
                    if (!uniqueFriends.has(friend.publicKey)) {
                        uniqueFriends.set(friend.publicKey, friend);
                    }
                }
                for (const friend of uniqueFriends.values()) {
                    insertFriend.run(ownerPubkey, friend.publicKey, friend.addedAt);
                }
            }
        }

        // 9. Ratings
        if (state.ratings) {
            for (const r of state.ratings) {
                insertRating.run(r.id, r.targetPubkey, r.raterPubkey, r.role || 'provider', r.stars, r.comment || '', r.transactionId, r.createdAt);
            }
        }

        // 10. Abuse Reports
        if (state.reports) {
            for (const r of state.reports) {
                insertReport.run(r.id, r.reporterPubkey, r.targetPubkey, r.targetPostId || null, r.reason, r.createdAt);
            }
        }

        // 11. Node Config
        if (state.nodeConfig) {
            insertConfig.run('node_config', JSON.stringify(state.nodeConfig));
        }
    });

    try {
        db.pragma('foreign_keys = OFF');
        migrate();
        console.log('✅ Successfully migrated state.json to SQLite database.');
        fs.renameSync(STATE_JSON_PATH, STATE_BACKUP_PATH);
        console.log(`📦 Legacy JSON renamed to ${STATE_BACKUP_PATH}`);
    } catch (err: any) {
        console.error('❌ Database migration failed:', err.message);
        throw err;
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
    goal_amount: number;
    current_amount: number;
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
    const goalAmount = Number(e.goal_amount ?? legacyP?.goal_amount ?? 0);

    let currentAmount = 0;
    if (legacyP && legacyP.current_amount != null) {
        currentAmount = Number(legacyP.current_amount);
    }
    try {
        const txSum = (db.prepare(`
            SELECT COALESCE(SUM(amount), 0) as s FROM transactions 
            WHERE project_id = ? AND (to_pubkey = ? OR to_pubkey = 'escrow_' || ?)
              AND id NOT LIKE 'sweep_%' AND from_pubkey NOT LIKE 'escrow_%'
        `).get(e.public_key, e.public_key, e.public_key) as any)?.s || 0;
        const accBal = (db.prepare(`SELECT balance FROM accounts WHERE public_key = ?`).get(e.public_key) as any)?.balance || 0;
        currentAmount = Math.max(currentAmount, txSum, accBal);
    } catch { }

    const status = (e.status || legacyP?.status || 'ACTIVE').toUpperCase();

    return {
        id: e.public_key,
        creator_pubkey: creator,
        title,
        description,
        photos,
        goal_amount: goalAmount,
        current_amount: currentAmount,
        deadline_at: e.deadline_at ?? legacyP?.deadline_at ?? null,
        status,
        created_at: e.joined_at ?? legacyP?.created_at ?? new Date().toISOString(),
        enterprise_pubkey: e.public_key || legacyP?.enterprise_pubkey || legacyP?.id,
    };
}

export function getCrowdfundProjects(): ProjectRow[] {
    const enterprises = db.prepare(`
        SELECT m.public_key, m.callsign, m.avatar_url, m.bio, m.purpose,
               m.goal_amount, m.deadline_at, m.status, m.joined_at,
               (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key AND role = 'lead' LIMIT 1) as lead_keeper,
               (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key LIMIT 1) as any_keeper
        FROM members m
        WHERE m.is_treasury = 1 AND m.lifecycle = 'bounded' AND m.status NOT IN ('pruned', 'deleted')
        ORDER BY m.joined_at DESC
        LIMIT 200
    `).all() as any[];

    const projectMap = new Map<string, any>();
    try {
        const pRows = db.prepare("SELECT * FROM projects WHERE status NOT IN ('pruned', 'deleted', 'PRUNED', 'DELETED')").all() as any[];
        for (const p of pRows) projectMap.set(p.id, p);
    } catch { }

    return enterprises.map(e => rowToProjectRow(e, projectMap.get(e.public_key)));
}

export function getCrowdfundProject(id: string): ProjectRow | undefined {
    const e = db.prepare(`
        SELECT m.public_key, m.callsign, m.avatar_url, m.bio, m.purpose,
               m.goal_amount, m.deadline_at, m.status, m.joined_at,
               (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key AND role = 'lead' LIMIT 1) as lead_keeper,
               (SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = m.public_key LIMIT 1) as any_keeper
        FROM members m
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

export const INACTIVE_MEMBER_CREATE_ERROR = 'Only active community members can create an enterprise or a project';

/** Is this member's account active? Missing rows and every other status (disabled, suspended, pruned) are not. */
export function isMemberActive(memberPubkey: string): boolean {
    const row = db.prepare('SELECT status FROM members WHERE public_key = ?').get(memberPubkey) as any;
    return !!row && (row.status || 'active') === 'active';
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

export function createCrowdfundProject(
    id: string,
    creator_pubkey: string,
    title: string,
    description: string,
    photos: string[],
    goal_amount: number,
    deadline_at: string | null
) {
    if (creator_pubkey && !isMemberActive(creator_pubkey)) throw new Error(INACTIVE_MEMBER_CREATE_ERROR);
    if (creator_pubkey && isOperatorSwitchedOff(creator_pubkey)) throw new Error(OPERATOR_SWITCHED_OFF_CREATE_ERROR);
    // Every photo is served to anyone who asks (/api/crowdfund/projects, /api/avatar/:pubkey), so each is stored
    // without its metadata (G9a-3). Anything that is not an image comes back exactly as given.
    photos = Array.isArray(photos) ? photos.map(stripImageValue) : photos;
    // photos[0] becomes the enterprise's members.avatar_url, served by /api/avatar/:pubkey. An
    // editor that read the enterprise back from the node holds THIS node's own avatar URL
    // there, not the photo; storing it would point the avatar at itself. Same rule as
    // updateProfile: read it as "no photo" rather than rejecting the whole save.
    const rawPhotoUrl = photos && photos.length > 0 ? photos[0] : '';
    const photoUrl = isSelfAvatarUrl(rawPhotoUrl) ? '' : rawPhotoUrl;
    const now = new Date().toISOString();
    const baseCallsign = (title || 'Project').trim().slice(0, 40) || 'Project';
    const existingCallsign = db.prepare(
        "SELECT public_key FROM members WHERE lower(callsign) = lower(?) AND status NOT IN ('migrated', 'pruned') AND public_key != ?"
    ).get(baseCallsign, id) as any;
    const callsign = existingCallsign ? `${baseCallsign.slice(0, 33)}-${id.slice(0, 6)}` : baseCallsign;

    db.transaction(() => {
        const existing = db.prepare("SELECT 1 FROM members WHERE public_key = ?").get(id);
        if (!existing) {
            db.prepare(`
                INSERT INTO members (
                    public_key, callsign, joined_at, avatar_url, bio, status,
                    is_treasury, earned_credit, earned_surplus,
                    purpose, goal_amount, deadline_at, lifecycle, paused, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'active', 1, 0, 0, ?, ?, ?, 'bounded', 0, ?)
            `).run(id, callsign, now, photoUrl, description || '', description || title.trim(), goal_amount, deadline_at, now);
            db.prepare("INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)").run(id);
            if (creator_pubkey) {
                db.prepare(`
                    INSERT OR IGNORE INTO treasury_operators (
                        treasury_pubkey, member_pubkey, role, granted_at, granted_by
                    ) VALUES (?, ?, 'lead', ?, 'creator')
                `).run(id, creator_pubkey, now);
                raiseCreatorOperatorSwitch(creator_pubkey, id);
            }
        }

        db.prepare(`
            INSERT OR REPLACE INTO projects (id, creator_pubkey, title, description, photos, goal_amount, deadline_at, status, migrated_at, enterprise_pubkey, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?)
        `).run(id, creator_pubkey, title, description, JSON.stringify(photos), goal_amount, deadline_at, id, now, now);
    })();
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
    const project = getCrowdfundProject(id);
    if (!project) throw new Error("Project not found");
    if (project.creator_pubkey !== creator_pubkey) throw new Error("Unauthorized: You do not own this project");

    if (project.current_amount > 0 && Number(goal_amount) !== project.goal_amount) {
        throw new Error("Cannot change funding goal after receiving pledges");
    }

    const now = new Date().toISOString();
    photos = Array.isArray(photos) ? photos.map(stripImageValue) : photos; // as in createCrowdfundProject (G9a-3)
    // As in createCrowdfundProject: this node's own avatar URL, sent back by an editor that
    // loaded the enterprise from the node, means "unchanged" — the UPDATEs below COALESCE a
    // null onto the existing avatar_url, so the stored photo survives the edit.
    const rawPhotoUrl = photos && photos.length > 0 ? photos[0] : '';
    const photoUrl = isSelfAvatarUrl(rawPhotoUrl) ? '' : rawPhotoUrl;

    db.transaction(() => {
        if (deadline_at !== undefined) {
            db.prepare(`
                UPDATE projects
                SET title = ?, description = ?, photos = ?, goal_amount = ?, deadline_at = ?, updated_at = ?
                WHERE id = ? AND creator_pubkey = ?
            `).run(title, description, JSON.stringify(photos), goal_amount, deadline_at, now, id, creator_pubkey);

            db.prepare(`
                UPDATE members
                SET callsign = ?, purpose = ?, bio = ?, avatar_url = COALESCE(?, avatar_url), goal_amount = ?, deadline_at = ?, updated_at = ?
                WHERE public_key = ?
            `).run(title.trim(), description, description, photoUrl || null, goal_amount, deadline_at, now, id);
        } else {
            db.prepare(`
                UPDATE projects
                SET title = ?, description = ?, photos = ?, goal_amount = ?, updated_at = ?
                WHERE id = ? AND creator_pubkey = ?
            `).run(title, description, JSON.stringify(photos), goal_amount, now, id, creator_pubkey);

            db.prepare(`
                UPDATE members
                SET callsign = ?, purpose = ?, bio = ?, avatar_url = COALESCE(?, avatar_url), goal_amount = ?, updated_at = ?
                WHERE public_key = ?
            `).run(title.trim(), description, description, photoUrl || null, goal_amount, now, id);
        }
    })();
}

export function pledgeToProject(txId: string, projectId: string, fromPubkey: string, amount: number, memo: string, auth?: { signer: string; signature: string; payload: string }) {
    // SECURITY (SRV-8): defense-in-depth — reject non-positive amounts at the data
    // layer. A negative amount would otherwise debit-as-credit the backer before the
    // transactions CHECK(amount > 0) aborts the surrounding transaction.
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Pledge amount must be positive");
    assertMoneyMayMove?.();

    let project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined;
    if (!project) {
        const memberEnterprise = db.prepare(`SELECT public_key, callsign, purpose, bio, goal_amount, deadline_at, status FROM members WHERE public_key = ? AND is_treasury = 1 AND lifecycle = 'bounded'`).get(projectId) as any;
        if (!memberEnterprise) throw new Error("Project not found");
        const lead = (db.prepare(`SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ? AND role = 'lead' LIMIT 1`).get(projectId) as any)?.member_pubkey || memberEnterprise.public_key;
        db.prepare(`
            INSERT OR IGNORE INTO projects (id, creator_pubkey, title, description, photos, goal_amount, deadline_at, status, migrated_at, enterprise_pubkey, created_at, updated_at)
            VALUES (?, ?, ?, ?, '[]', ?, ?, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        `).run(projectId, lead, memberEnterprise.callsign, memberEnterprise.purpose || memberEnterprise.bio || '', memberEnterprise.goal_amount || 0, memberEnterprise.deadline_at, projectId);
        project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow;
    }
    if (project.status === 'COMPLETED' || project.status === 'FAILED') throw new Error("Project is not accepting pledges");
    const entPub = (project as any).enterprise_pubkey || project.id;
    const ent = db.prepare('SELECT is_treasury, paused, status FROM members WHERE public_key = ?').get(entPub) as any;
    if (ent?.is_treasury) {
        if (ent.paused === 1) throw new Error("Enterprise is paused — not accepting pledges");
        if (ent.status === 'winding_up' || ent.status === 'completed') throw new Error("Enterprise is not accepting pledges");
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

    const sender = db.prepare(`SELECT balance FROM accounts WHERE public_key = ?`).get(fromPubkey) as { balance: number } | undefined;
    if (!sender) throw new Error("Sender account not found");
    if (sender.balance < amount) throw new Error("Insufficient balance for pledge");

    const escrowPubkey = `escrow_${projectId}`;

    const executePledge = db.transaction(() => {
        // Ensure synthetic escrow account exists natively
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch) VALUES (?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0)`).run(escrowPubkey);

        // These escrow legs write last_updated_at in ISO-8601 form (not
        // CURRENT_TIMESTAMP's space-separated shape) so the ledger watermark stays
        // lexically ordered against the ISO delta cursor — a CURRENT_TIMESTAMP value
        // sorts BEFORE any same-day ISO cursor (' ' < 'T'), which would make the
        // `WHERE last_updated_at > :since` delta scan silently miss the mutated row.
        // Debit backer
        db.prepare(`UPDATE accounts SET balance = balance - ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(amount, fromPubkey);

        // Credit Escrow instead of Creator
        db.prepare(`UPDATE accounts SET balance = balance + ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(amount, escrowPubkey);

        // Record tx — SRV-20: this is the member-authored leg (backer → escrow),
        // so persist the caller's request signature for re-verification on import.
        // The escrow sweep/refund legs below are node-authoritative (from escrow_)
        // and accepted via the payload-level mirror-trust gate.
        db.prepare(`
            INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, project_id, auth_signer, auth_signature, auth_payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(txId, fromPubkey, escrowPubkey, amount, memo, projectId,
            auth?.signer ?? null, auth?.signature ?? null, auth?.payload ?? null);

        // Update Project Goals
        db.prepare(`UPDATE projects SET current_amount = current_amount + ? WHERE id = ?`).run(amount, projectId);

        const updatedProject = db.prepare(`SELECT current_amount, goal_amount FROM projects WHERE id = ?`).get(projectId) as ProjectRow;
        if (updatedProject && updatedProject.current_amount >= updatedProject.goal_amount && project.status === 'ACTIVE') {
            db.prepare(`UPDATE projects SET status = 'FUNDED' WHERE id = ?`).run(projectId);
            db.prepare(`UPDATE members SET status = 'funded' WHERE public_key = ?`).run(projectId);

            // Auto-Sweep Escrow to Enterprise Account (Slice 3: pledges land in enterprise account!)
            const escrowBalanceRow = db.prepare(`SELECT balance FROM accounts WHERE public_key = ?`).get(escrowPubkey) as { balance: number };
            const escrowBalance = escrowBalanceRow ? escrowBalanceRow.balance : Math.max(0, updatedProject.current_amount);

            if (escrowBalance > 0) {
                // Drain Escrow
                db.prepare(`UPDATE accounts SET balance = 0, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(escrowPubkey);
                // Credit Enterprise Treasury Account (Slice 3: pledges land in enterprise account)
                db.prepare(`UPDATE accounts SET balance = balance + ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(escrowBalance, targetAccount);

                // Record atomic Sweep Transaction to the enterprise
                db.prepare(`
                    INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, project_id)
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

export function deleteCrowdfundProject(projectId: string, requesterPubkey: string) {
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined;
    if (!project) throw new Error("Project not found");
    if (project.creator_pubkey !== requesterPubkey) throw new Error("Unauthorized to delete this project");

    // Guard against deleting funded/completed projects
    if (project.status !== 'ACTIVE') {
        throw new Error('Cannot delete a project that is already funded or completed');
    }

    // Guard against non-zero account balance to maintain ledger conservation
    const account = db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(projectId) as { balance: number } | undefined;
    if (account && Math.abs(account.balance) > 0.0001) {
        throw new Error(`Cannot delete project enterprise with non-zero balance (${account.balance}). Drain or sweep funds first.`);
    }

    // #138: close every backer's demurrage window before the refunds raise their balances. This is the
    // widest of the three paths — one deleted project refunds all of its pledgers at once, so an open window
    // on any of them becomes a retrospective tax on money they are merely getting back.
    //
    // Read out here and settled OUTSIDE executeDelete on purpose. Settling is independently correct and must
    // not be undone by an unrelated failure later in the delete; and a decay credit taken in memory inside a
    // transaction that then rolls back is the exact conservation hazard conservingTransaction exists for
    // (state-engine.ts) — which this module cannot reach.
    if (project.status === 'ACTIVE') {
        const backers = db.prepare(`
            SELECT DISTINCT from_pubkey FROM transactions WHERE to_pubkey = ? AND project_id = ?
        `).all(`escrow_${projectId}`, projectId) as { from_pubkey: string }[];
        if (backers.length > 0) onSettleDemurrage?.(backers.map(b => b.from_pubkey));
    }

    const executeDelete = db.transaction(() => {
        // If still ACTIVE, funds are locked in Escrow. Refund them to backers.
        if (project.status === 'ACTIVE') {
            const escrowPubkey = `escrow_${projectId}`;
            const pledges = db.prepare(`
                SELECT from_pubkey, amount, id FROM transactions 
                WHERE to_pubkey = ? AND project_id = ?
            `).all(escrowPubkey, projectId) as { from_pubkey: string, amount: number, id: string }[];

            let totalRefunded = 0;
            for (const pledge of pledges) {
                // Return Beans to Backer
                db.prepare(`UPDATE accounts SET balance = balance + ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(pledge.amount, pledge.from_pubkey);

                // Record the localized Refund Transaction
                db.prepare(`
                    INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, project_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(`refund_${pledge.id}`, escrowPubkey, pledge.from_pubkey, pledge.amount, 'Escrow Refund: Project Deleted', projectId);

                totalRefunded += pledge.amount;
            }

            // Drain the escrow account to reconcile the economy symmetrically
            db.prepare(`UPDATE accounts SET balance = balance - ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(totalRefunded, escrowPubkey);
        }

        // #139: Unlink transactions from the project before deletion to prevent SQLITE_CONSTRAINT_FOREIGNKEY
        // failure while retaining complete transaction history (pledges, refunds, sweeps) in the ledger.
        db.prepare(`UPDATE transactions SET project_id = NULL WHERE project_id = ?`).run(projectId);

        const acc = db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(projectId) as { balance: number } | undefined;
        if (acc && Math.abs(acc.balance) > 1e-9) {
            throw new Error(`Cannot delete enterprise account with non-zero balance (${acc.balance} Beans). Sweep or refund funds first.`);
        }

        // Shred the Project — and tombstone it so mirrors propagate the delete.
        db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
        db.prepare(`DELETE FROM treasury_operators WHERE treasury_pubkey = ?`).run(projectId);
        db.prepare(`DELETE FROM accounts WHERE public_key = ? AND ABS(balance) < 0.0001`).run(projectId);
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
    });

    executeDelete();
    // A2-1: refunds/escrow drain above mutated balances via raw SQL — re-sync the
    // in-memory ledger so the next transfer() doesn't clobber the DB with stale values.
    onBalanceMutation?.();
}

