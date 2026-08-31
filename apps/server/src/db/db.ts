import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedPricingGuideIfEmpty } from './pricing-guide-db.js';

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
    try { db.prepare(`ALTER TABLE projects ADD COLUMN updated_at DATETIME`).run(); } catch { }
    try { db.prepare(`ALTER TABLE recovery_requests ADD COLUMN updated_at DATETIME`).run(); } catch { }
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
    try { db.prepare(`ALTER TABLE conversation_participants ADD COLUMN updated_at DATETIME`).run(); } catch { }

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
    // Profile sync: profile mutation timestamp for cache-busting.
    try { db.prepare(`ALTER TABLE members ADD COLUMN profile_updated_at DATETIME`).run(); } catch { }
    // Community Working Style / Archetype signature
    try { db.prepare(`ALTER TABLE members ADD COLUMN archetype TEXT`).run(); } catch { }

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

    try { db.prepare(`ALTER TABLE transactions ADD COLUMN project_id TEXT REFERENCES projects(id)`).run(); } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_transactions_project_id ON transactions(project_id)`).run(); } catch { }

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
    try {
        db.prepare(`ALTER TABLE recovery_requests ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE recovery_requests SET updated_at = COALESCE(executed_at, cooldown_until, created_at) WHERE updated_at IS NULL`).run();
    } catch { }

    // Step 7: recovery share replication audit column
    try { db.prepare(`ALTER TABLE sync_audit_log ADD COLUMN recovery_shares_imported INTEGER NOT NULL DEFAULT 0`).run(); } catch { }
    try { db.prepare(`ALTER TABLE recovery_releases ADD COLUMN kdf_params TEXT`).run(); } catch { }

    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schemaSql);

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

    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_recovery_requests_updated_at ON recovery_requests(updated_at)`).run(); } catch { }

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

    seedTreasuryOperatorsFromLegacyFlag();

    try {
        seedPricingGuideIfEmpty(false, db);
    } catch (err) {
        console.error('[DB] ⚠️ Could not seed pricing guide items:', err);
    }
}

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
        INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey, added_at, is_guardian)
        VALUES (?, ?, ?, ?)
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
                    insertFriend.run(ownerPubkey, friend.publicKey, friend.addedAt, friend.isGuardian ? 1 : 0);
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
}

export function getCrowdfundProjects(): ProjectRow[] {
    // A2-25: cap the full-table read so a request path can't pull an unbounded
    // result set. Projects are low-cardinality; 200 is generous for the public list.
    return db.prepare(`SELECT * FROM projects ORDER BY created_at DESC LIMIT 200`).all() as ProjectRow[];
}

export function getCrowdfundProject(id: string): ProjectRow | undefined {
    return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
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
    db.prepare(`
        INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount, deadline_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, creator_pubkey, title, description, JSON.stringify(photos), goal_amount, deadline_at);
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

    if (deadline_at !== undefined) {
        db.prepare(`
            UPDATE projects
            SET title = ?, description = ?, photos = ?, goal_amount = ?, deadline_at = ?
            WHERE id = ? AND creator_pubkey = ?
        `).run(title, description, JSON.stringify(photos), goal_amount, deadline_at, id, creator_pubkey);
    } else {
        db.prepare(`
            UPDATE projects
            SET title = ?, description = ?, photos = ?, goal_amount = ?
            WHERE id = ? AND creator_pubkey = ?
        `).run(title, description, JSON.stringify(photos), goal_amount, id, creator_pubkey);
    }
}

export function pledgeToProject(txId: string, projectId: string, fromPubkey: string, amount: number, memo: string, auth?: { signer: string; signature: string; payload: string }) {
    // SECURITY (SRV-8): defense-in-depth — reject non-positive amounts at the data
    // layer. A negative amount would otherwise debit-as-credit the backer before the
    // transactions CHECK(amount > 0) aborts the surrounding transaction.
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Pledge amount must be positive");

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as ProjectRow | undefined;
    if (!project) throw new Error("Project not found");
    if (project.status === 'COMPLETED' || project.status === 'FAILED') throw new Error("Project is not accepting pledges");

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
    onSettleDemurrage?.([project.creator_pubkey, fromPubkey]);

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
        if (updatedProject.current_amount >= updatedProject.goal_amount && project.status === 'ACTIVE') {
            db.prepare(`UPDATE projects SET status = 'FUNDED' WHERE id = ?`).run(projectId);

            // Auto-Sweep Escrow to Creator sequentially
            const escrowBalanceRow = db.prepare(`SELECT balance FROM accounts WHERE public_key = ?`).get(escrowPubkey) as { balance: number };
            const escrowBalance = escrowBalanceRow ? escrowBalanceRow.balance : Math.max(0, updatedProject.current_amount);

            if (escrowBalance > 0) {
                // Drain Escrow
                db.prepare(`UPDATE accounts SET balance = 0, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(escrowPubkey);
                // Credit actual Creator
                db.prepare(`UPDATE accounts SET balance = balance + ?, last_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?`).run(escrowBalance, project.creator_pubkey);

                // Record atomic Sweep Transaction
                db.prepare(`
                    INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, project_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(`sweep_${txId}`, escrowPubkey, project.creator_pubkey, escrowBalance, 'Escrow Release: Funding Goal Reached', projectId);
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

        // Shred the Project — and tombstone it so mirrors propagate the delete.
        db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
        writeTombstone('projects', projectId);
    });

    executeDelete();
    // A2-1: refunds/escrow drain above mutated balances via raw SQL — re-sync the
    // in-memory ledger so the next transfer() doesn't clobber the DB with stale values.
    onBalanceMutation?.();
}

