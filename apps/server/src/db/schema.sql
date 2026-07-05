-- 1. Members and Profiles
CREATE TABLE IF NOT EXISTS members (
    public_key TEXT PRIMARY KEY,
    callsign TEXT NOT NULL,
    joined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    invited_by TEXT REFERENCES members(public_key),
    invite_code TEXT,
    home_node_url TEXT,
    
    avatar_url TEXT,
    bio TEXT,
    contact_value TEXT,
    contact_visibility TEXT,
    status TEXT DEFAULT 'active',
    last_active_at DATETIME,
    -- Elder vouch: the Elder who endorsed this member. For a founding member
    -- (0 completed trades, not genesis pre-seeded) this also lifts the no-overdraft
    -- floor-gate. Distinct from `invited_by` ("Vouched in by" — who brought them in).
    elder_vouched_by TEXT REFERENCES members(public_key),
    -- Vouch capability (the "appointed voucher" / super-Elder switch). Admin-granted only,
    -- via adminSetVoucher. Handing out the -20 credit floor is the one Sybil-critical power,
    -- so it is NOT derived from Elder *tier* (an earned cosmetic badge) — it is this flag.
    can_vouch INTEGER DEFAULT 0,
    -- The vouch level's credit floor (25/50/100) recorded when an appointed voucher vouches.
    -- 0 when not vouched. Paired with elder_vouched_by (who vouched).
    vouch_credit REAL DEFAULT 0,
    -- Hard credit freeze: forced 0 floor when set by admin.
    credit_frozen INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_members_updated_at ON members(updated_at);

-- 2. Invite Codes
CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES members(public_key),
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    used_by TEXT REFERENCES members(public_key),
    used_at DATETIME,
    intended_for TEXT
);

-- 3. Ledger Accounts & Transactions
CREATE TABLE IF NOT EXISTS accounts (
    public_key TEXT PRIMARY KEY,
    balance REAL DEFAULT 0.0,
    last_updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_demurrage_epoch INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    from_pubkey TEXT NOT NULL,
    to_pubkey TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    tax_fee REAL DEFAULT 0.0,
    memo TEXT,
    timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- SRV-20: cryptographic authorship. For member-authored transactions these hold
    -- the request signature (auth_signer = signer pubkey, auth_signature = base64 sig,
    -- auth_payload = the exact signed `METHOD\nPATH\nTS\nNONCE\nBODY` string) so any
    -- importing node can re-verify who authored the transaction. System-generated
    -- transactions (demurrage/escrow/genesis) are node-signed. NULL on legacy rows.
    auth_signer TEXT,
    auth_signature TEXT,
    auth_payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_pubkey);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_pubkey);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp DESC);

-- 4. Marketplace Posts & Photos
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    credits REAL NOT NULL DEFAULT 0,
    author_pubkey TEXT NOT NULL REFERENCES members(public_key),
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    active INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'pending', 'paused', 'completed', 'cancelled')),
    price_type TEXT DEFAULT 'fixed',
    repeatable INTEGER DEFAULT 0,
    accepted_by TEXT REFERENCES members(public_key),
    accepted_at DATETIME,
    pending_transaction_id TEXT,
    completed_at DATETIME,
    lat REAL,
    lng REAL,
    origin_node TEXT,
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    search_keywords TEXT DEFAULT '',
    CONSTRAINT lat_lng_check CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS idx_active_posts ON posts(created_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);

CREATE TABLE IF NOT EXISTS post_photos (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    photo_data TEXT NOT NULL,
    order_num INTEGER NOT NULL,
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (post_id, order_num)
);
CREATE INDEX IF NOT EXISTS idx_post_photos_updated_at ON post_photos(updated_at);

-- Encrypted message attachments (lazy-loaded; the node only ever holds ciphertext).
-- data = base64 AEAD ciphertext of the image; nonce = its x25519-xc20p-v2 nonce.
CREATE TABLE IF NOT EXISTS message_attachments (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    nonce TEXT NOT NULL,
    mime TEXT,
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 5. Marketplace Transactions
CREATE TABLE IF NOT EXISTS marketplace_transactions (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id),
    buyer_pubkey TEXT NOT NULL,
    seller_pubkey TEXT NOT NULL,
    credits REAL NOT NULL,
    hours REAL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at DATETIME,
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_updated_at ON marketplace_transactions(updated_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_status_completed ON marketplace_transactions(status, completed_at);

-- 6. Messaging & Chat
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
    name TEXT,
    created_by TEXT REFERENCES members(public_key),
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    public_key TEXT REFERENCES members(public_key),
    last_read_at DATETIME,
    PRIMARY KEY (conversation_id, public_key)
);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_pubkey ON conversation_participants(public_key);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_pubkey TEXT NOT NULL REFERENCES members(public_key),
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    system_type TEXT,
    metadata TEXT,
    timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    edited_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, timestamp ASC);

-- 7. Relations (Friends, Ratings, Abuse)
CREATE TABLE IF NOT EXISTS friends (
    owner_pubkey TEXT REFERENCES members(public_key),
    friend_pubkey TEXT REFERENCES members(public_key),
    added_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    is_guardian INTEGER DEFAULT 0,
    PRIMARY KEY (owner_pubkey, friend_pubkey)
);

CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY,
    target_pubkey TEXT NOT NULL REFERENCES members(public_key),
    rater_pubkey TEXT NOT NULL REFERENCES members(public_key),
    role TEXT NOT NULL,
    stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
    comment TEXT,
    transaction_id TEXT REFERENCES marketplace_transactions(id),
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(rater_pubkey, transaction_id)
);

CREATE TABLE IF NOT EXISTS abuse_reports (
    id TEXT PRIMARY KEY,
    reporter_pubkey TEXT NOT NULL REFERENCES members(public_key),
    target_pubkey TEXT NOT NULL REFERENCES members(public_key),
    target_post_id TEXT,
    reason TEXT NOT NULL,
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 8. Config
CREATE TABLE IF NOT EXISTS node_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 9. Community Crowdfunding Projects
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    creator_pubkey TEXT NOT NULL REFERENCES members(public_key),
    title TEXT NOT NULL,
    description TEXT,
    photos TEXT, -- JSON array of URLs
    goal_amount INTEGER NOT NULL,
    current_amount INTEGER DEFAULT 0,
    deadline_at DATETIME,
    status TEXT DEFAULT 'ACTIVE', -- 'ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED'
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);

-- 10. Invite Links (Deferred Deep Linking Shortener)
CREATE TABLE IF NOT EXISTS invite_links (
    hash_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 11. Push Notification Tokens (Expo Push)
CREATE TABLE IF NOT EXISTS push_tokens (
    public_key TEXT NOT NULL REFERENCES members(public_key),
    token TEXT NOT NULL,
    platform TEXT DEFAULT 'ios',
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (public_key, token)
);

-- 12. Member Notification Preferences
CREATE TABLE IF NOT EXISTS member_preferences (
    public_key TEXT NOT NULL REFERENCES members(public_key),
    pref_key TEXT NOT NULL,
    pref_value TEXT NOT NULL DEFAULT 'true',
    PRIMARY KEY (public_key, pref_key)
);

-- 13. Full-Text Search Index (FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    title, description, search_keywords,
    content='posts',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, title, description, search_keywords)
    VALUES (new.rowid, new.title, new.description, new.search_keywords);
END;

CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, description, search_keywords)
    VALUES ('delete', old.rowid, old.title, old.description, old.search_keywords);
END;

CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, description, search_keywords)
    VALUES ('delete', old.rowid, old.title, old.description, old.search_keywords);
    INSERT INTO posts_fts(rowid, title, description, search_keywords)
    VALUES (new.rowid, new.title, new.description, new.search_keywords);
END;

-- 14. Social Recovery
CREATE TABLE IF NOT EXISTS recovery_requests (
    id TEXT PRIMARY KEY,
    old_pubkey TEXT NOT NULL REFERENCES members(public_key),
    new_pubkey TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'cancelled', 'expired', 'executed')),
    quorum_required INTEGER DEFAULT 3,
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cooldown_until DATETIME,
    executed_at DATETIME,
    expires_at DATETIME,
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_recovery_requests_updated_at ON recovery_requests(updated_at);

CREATE TABLE IF NOT EXISTS recovery_approvals (
    request_id TEXT NOT NULL REFERENCES recovery_requests(id) ON DELETE CASCADE,
    guardian_pubkey TEXT NOT NULL REFERENCES members(public_key),
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (request_id, guardian_pubkey)
);

-- 15. Administrative System Logs
CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR', 'SECURITY', 'SYNC')),
    category TEXT NOT NULL CHECK (category IN ('P2P', 'LEDGER', 'TLS', 'ADMIN', 'AUTH', 'DB', 'SYS')),
    message TEXT NOT NULL,
    metadata TEXT -- JSON string metadata
);

CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);

-- 16. Tombstones — track hard-deleted rows so delta sync can propagate deletes.
-- row_key is the serialized primary key (e.g. "post_id", or "owner|friend" for compound keys).
CREATE TABLE IF NOT EXISTS tombstones (
    table_name TEXT NOT NULL,
    row_key TEXT NOT NULL,
    deleted_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (table_name, row_key)
);
CREATE INDEX IF NOT EXISTS idx_tombstones_deleted_at ON tombstones(deleted_at);

-- 17. Per-peer sync cursors — tracks the timestamp of the last successful delta sync
-- with each peer, so the next pull only requests rows updated after that point.
CREATE TABLE IF NOT EXISTS sync_cursors (
    peer_id TEXT PRIMARY KEY,
    last_synced_at DATETIME NOT NULL,
    last_sync_attempt_at DATETIME NOT NULL
);

-- 18. updated_at touch triggers — auto-bump the row mutation watermark on UPDATE
-- so every write path participates in cursor-based delta sync without per-callsite
-- code changes. The WHEN guard skips firing when the caller explicitly set
-- updated_at (e.g. the sync importer applying a remote row with its own timestamp),
-- and prevents recursion (which is also disabled by the SQLite default
-- PRAGMA recursive_triggers = OFF).

-- members trigger uses an explicit column whitelist (AFTER UPDATE OF …) instead
-- of firing on any UPDATE. This intentionally excludes `last_active_at` so user
-- heartbeats don't flood delta-sync exports with member rows that have no
-- semantic change. ⚠️ MAINTENANCE: whenever you add a profile-relevant column
-- to the `members` table above, add it to this whitelist too — otherwise
-- mutations to that column won't be picked up by cursor-based delta sync.
CREATE TRIGGER IF NOT EXISTS members_touch_updated_at
AFTER UPDATE OF
    callsign, invited_by, invite_code, home_node_url, avatar_url, bio,
    contact_value, contact_visibility, status, earned_credit, profile_updated_at,
    elder_vouched_by, can_vouch, vouch_credit, credit_frozen, joined_at, public_key
ON members
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE members SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS post_photos_touch_updated_at
AFTER UPDATE ON post_photos
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE post_photos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS marketplace_transactions_touch_updated_at
AFTER UPDATE ON marketplace_transactions
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE marketplace_transactions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS projects_touch_updated_at
AFTER UPDATE ON projects
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE projects SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS recovery_requests_touch_updated_at
AFTER UPDATE ON recovery_requests
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE recovery_requests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

-- 19. System Metrics (Change 3 / Visibility monitors)
CREATE TABLE IF NOT EXISTS system_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    metric_key TEXT NOT NULL,
    metric_value REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_metrics_key_time ON system_metrics(metric_key, timestamp DESC);
