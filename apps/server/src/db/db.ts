import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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
    try { db.prepare(`ALTER TABLE conversation_participants ADD COLUMN updated_at DATETIME`).run(); } catch { }

    // Deploy 2: drop the Deploy 1 members trigger so schema.sql re-creates it with the
    // column-whitelist form that excludes last_active_at heartbeats from cursor sync.
    // CREATE TRIGGER IF NOT EXISTS is a no-op against an existing trigger.
    try { db.prepare(`DROP TRIGGER IF EXISTS members_touch_updated_at`).run(); } catch { }

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

    try { db.prepare(`ALTER TABLE posts ADD COLUMN price_type TEXT DEFAULT 'fixed'`).run(); } catch { }
    try { db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN hours REAL`).run(); } catch { }
    try { db.prepare(`ALTER TABLE transactions ADD COLUMN project_id TEXT REFERENCES projects(id)`).run(); } catch { }
    try { db.prepare(`ALTER TABLE transactions ADD COLUMN tax_fee REAL DEFAULT 0.0`).run(); } catch { }
    // SRV-20: cryptographic authorship columns on transactions (see schema.sql).
    try { db.prepare(`ALTER TABLE transactions ADD COLUMN auth_signer TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE transactions ADD COLUMN auth_signature TEXT`).run(); } catch { }
    try { db.prepare(`ALTER TABLE transactions ADD COLUMN auth_payload TEXT`).run(); } catch { }
    try {
        db.prepare(`ALTER TABLE posts ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE posts SET updated_at = created_at WHERE updated_at IS NULL`).run();
    } catch { }
    // Protocol v1: Admin Genesis Invites — store invite tier type
    try { db.prepare(`ALTER TABLE invite_codes ADD COLUMN genesis_type TEXT DEFAULT 'standard'`).run(); } catch { }
    // Protocol v1: Track pre-seeded earned credit for dynamic floor formula
    try { db.prepare(`ALTER TABLE members ADD COLUMN earned_credit REAL DEFAULT 0`).run(); } catch { }
    // Profile sync: Track profile mutation timestamp for cache-busting
    try { db.prepare(`ALTER TABLE members ADD COLUMN profile_updated_at DATETIME`).run(); } catch { }
    // FTS5 Search: Add search_keywords column to posts
    try { db.prepare(`ALTER TABLE posts ADD COLUMN search_keywords TEXT DEFAULT ''`).run(); } catch { }
    // Moderation: Add status tracking to abuse reports
    try { db.prepare(`ALTER TABLE abuse_reports ADD COLUMN status TEXT DEFAULT 'pending'`).run(); } catch { }
    // Marketplace hygiene: track when a lingering escrow deal was last nudged
    try { db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN last_reminded_at DATETIME`).run(); } catch { }
    // Edit-message window: timestamp of the most recent edit (null = never edited)
    try { db.prepare(`ALTER TABLE messages ADD COLUMN edited_at DATETIME`).run(); } catch { }
    // Perf: Add index to conversation_participants
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversation_participants_pubkey ON conversation_participants(public_key)`).run(); } catch { }
    // Perf: Add index to marketplace_transactions for status and completed_at (PR 26 review fix)
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_status_completed ON marketplace_transactions(status, completed_at)`).run(); } catch { }

    // Phase 2 delta sync: add updated_at columns + indexes to mutable tables that
    // didn't previously track row-level mutation timestamps. Backfill from the
    // most recent existing timestamp so cursor scans don't miss pre-migration rows.
    try {
        db.prepare(`ALTER TABLE members ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE members SET updated_at = COALESCE(profile_updated_at, last_active_at, joined_at) WHERE updated_at IS NULL`).run();
    } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_members_updated_at ON members(updated_at)`).run(); } catch { }

    try {
        db.prepare(`ALTER TABLE post_photos ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE post_photos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE updated_at IS NULL`).run();
    } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_post_photos_updated_at ON post_photos(updated_at)`).run(); } catch { }

    try {
        db.prepare(`ALTER TABLE marketplace_transactions ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE marketplace_transactions SET updated_at = COALESCE(completed_at, created_at) WHERE updated_at IS NULL`).run();
    } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_updated_at ON marketplace_transactions(updated_at)`).run(); } catch { }

    try {
        db.prepare(`ALTER TABLE projects ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE projects SET updated_at = created_at WHERE updated_at IS NULL`).run();
    } catch { }
    try { db.prepare(`CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at)`).run(); } catch { }

    try {
        db.prepare(`ALTER TABLE recovery_requests ADD COLUMN updated_at DATETIME`).run();
        db.prepare(`UPDATE recovery_requests SET updated_at = COALESCE(executed_at, cooldown_until, created_at) WHERE updated_at IS NULL`).run();
    } catch { }
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
        db.pragma('foreign_keys = ON');
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

        // Shred the Project — and tombstone it so mirrors propagate the delete.
        db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
        writeTombstone('projects', projectId);
    });

    executeDelete();
    // A2-1: refunds/escrow drain above mutated balances via raw SQL — re-sync the
    // in-memory ledger so the next transfer() doesn't clobber the DB with stale values.
    onBalanceMutation?.();
}

