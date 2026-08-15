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
    -- Community treasury: this "member" is a community-owned account (the Commons' trading
    -- face) — it authors an enterprise's offers/needs and settles escrow, but is exempt from
    -- demurrage and kept out of the member directory. Set once by createTreasury.
    is_treasury INTEGER DEFAULT 0,
    -- Operator capability (treasury steward). Admin-granted like can_vouch: lets this member
    -- drive a treasury (post its offers/needs, approve/release its escrow) from the Commons tab.
    -- Named 'operate' to dodge the 'Steward' tier and 'node role' (topology) name collisions.
    can_operate INTEGER DEFAULT 0,
    -- #127: declared HERE as well as by the guarded ALTER in db.ts, because the ALTER now runs BEFORE
    -- db.exec(schemaSql) — where on a fresh install the table does not exist yet, so the ALTER is a no-op and
    -- this line is the only thing that creates the column. Both are needed: this one for a fresh install, the
    -- ALTER for a node that already has data. A hoisted ALTER without a declaration here silently gives fresh
    -- installs a table missing the column, which is caught by test-schema-upgrade.ts.
    -- Pre-seeded earned credit for the dynamic floor formula (Protocol v1).
    earned_credit REAL DEFAULT 0,
    -- Profile mutation timestamp, for cache-busting.
    profile_updated_at DATETIME,
    -- Community working style / archetype signature (JSON or archetype key)
    archetype TEXT,
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
    intended_for TEXT,
    -- Protocol v1 Admin Genesis Invites. Declared here as well as in db.ts's ALTER because the
    -- ALTER now runs BEFORE this file is exec'd: on a fresh database the table does not exist yet,
    -- the ALTER fails into its empty catch, and this line is the only thing that creates the column.
    genesis_type TEXT DEFAULT 'standard'
);

-- 3. Ledger Accounts & Transactions
CREATE TABLE IF NOT EXISTS accounts (
    public_key TEXT PRIMARY KEY,
    balance REAL DEFAULT 0.0,
    last_updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_demurrage_epoch INTEGER DEFAULT 0
);
-- Phase 2 delta backup: index the ledger mutation watermark so `WHERE
-- last_updated_at > :since` delta scans are covered. All write paths write ISO-8601
-- ('%Y-%m-%dT%H:%M:%fZ') form — the db.ts escrow paths were normalised off
-- CURRENT_TIMESTAMP so lexical `>` ordering against an ISO cursor stays correct.
CREATE INDEX IF NOT EXISTS idx_accounts_last_updated_at ON accounts(last_updated_at);

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
    auth_payload TEXT,
    project_id TEXT REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_pubkey);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_pubkey);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_project_id ON transactions(project_id);

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
    -- #108: this listing has a real cash outlay attached (fuel, consumables used up doing the
    -- job). Deliberately a flag with NO amount: the app can escrow beans, it cannot escrow cash,
    -- and a structured figure would imply it holds or settles money it never touches. Terms live
    -- in the chat. Local-only by nature — cash can't cross a node boundary.
    cash_also_needed INTEGER DEFAULT 0,
    -- #143 step 4: how far this listing travels. 'local' (stays here) | 'peers' (named communities in
    -- reach_peers) | 'everywhere' (any community we settle with).
    --
    -- DEFAULTS TO 'local', which is the only defensible default: a member who has never heard of
    -- federation has not agreed to their listing appearing in another community. Rows written before this
    -- column existed take the default for the same reason.
    --
    -- Rule 9: this is a DISCOVERY FILTER, not an access control. It decides what we choose to send a peer,
    -- not what that peer may do with a copy it already holds.
    reach TEXT NOT NULL DEFAULT 'local' CHECK (reach IN ('local', 'peers', 'everywhere')),
    -- JSON array of peer ids, meaningful only when reach='peers'. Peer IDs rather than callsigns or
    -- addresses: a callsign is a peer's own mutable label and an address is operator config that changes
    -- when a host moves, while the peer id is the thing the trust relationship and the bridge are keyed on.
    reach_peers TEXT,
    CONSTRAINT lat_lng_check CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)
);
-- The pull serves one peer at a time and asks for active, locally-authored, travelling listings. Partial
-- so the index holds only rows that can ever be served: 'local' is the overwhelming majority and would
-- otherwise dominate a full index for no benefit.
--
-- Keyed on created_at ALONE, with `reach` living only in the partial condition. Review finding, and
-- MEASURED rather than accepted on argument — the same EXPLAIN QUERY PLAN check the settlements indexes
-- above document. Leading with `reach` fragments the index by reach value, so the scan cannot deliver
-- `ORDER BY created_at DESC` globally ordered:
--
--   ON posts(reach, created_at DESC)  →  SCAN … + USE TEMP B-TREE FOR ORDER BY
--   ON posts(created_at DESC)         →  SCAN … , no sort
--
-- And `reach` in the leading position buys nothing anyway, because the partial predicate has already
-- excluded the only value the query filters on.
CREATE INDEX IF NOT EXISTS idx_posts_reach ON posts(created_at DESC)
    WHERE status = 'active' AND reach != 'local' AND origin_node IS NULL;

CREATE INDEX IF NOT EXISTS idx_active_posts ON posts(created_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);
CREATE INDEX IF NOT EXISTS idx_posts_updated_at ON posts(updated_at);

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
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Marketplace hygiene: when a lingering escrow deal was last nudged. Same reasoning as
    -- invite_codes.genesis_type above — the ALTER runs pre-exec, so a fresh database gets the
    -- column from here or not at all.
    last_reminded_at DATETIME
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
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (conversation_id, public_key)
);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_pubkey ON conversation_participants(public_key);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_updated_at ON conversation_participants(updated_at);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);

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
    edited_at DATETIME,
    -- Phase 2 delta backup: row mutation watermark. Bumped by the messages touch
    -- trigger on any edit/reaction/move so cursor-based delta sync picks up the
    -- change (messages are mutable: metadata reactions, edited_at edits, moves).
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_messages_updated_at ON messages(updated_at);

-- 7. Relations (Friends, Ratings, Abuse)
CREATE TABLE IF NOT EXISTS friends (
    owner_pubkey TEXT REFERENCES members(public_key),
    friend_pubkey TEXT REFERENCES members(public_key),
    added_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    is_guardian INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (owner_pubkey, friend_pubkey)
);
CREATE INDEX IF NOT EXISTS idx_friends_updated_at ON friends(updated_at);

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
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ratings_created_at ON ratings(created_at);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_updated_at ON abuse_reports(updated_at);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_status_created ON abuse_reports(status, created_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_recovery_approvals_created_at ON recovery_approvals(created_at);

-- 14b. Keyholder model (docs/ONBOARDING.md Part 0) — one encrypted fragment per keeper.
--
-- Distinct from recovery_requests above, which is the guardian-quorum flow for migrating an
-- account to a NEW key. This table serves the other half: rebuilding the ORIGINAL phrase from
-- fragments, so the member keeps the key they had. Both exist, and the approve endpoint feeds
-- both — approving a request also releases that approver's fragment.
--
-- Nothing here is a secret on its own, and that is load-bearing rather than incidental. Member
-- fragments are ECDH-wrapped to the keeper's account key, so this table cannot read them. The
-- hub's own fragment and the sign-in fragment it effectively can: the hub piece carries no
-- node-side wrapping key (see ONBOARDING.md § Hub keeper — an env-held key was specified and
-- withdrawn, because losing it would silently kill every member's K2), and the sign-in piece is
-- derived from a provider subject claim the node may well be able to guess.
--
-- That is fine, and it is exactly why the threshold is 3 rather than 2: a stolen database yields
-- at most two fragments, and two are nothing. It is also why K1 must never be stored here — a
-- third readable piece would turn this table into a complete key. The margin is one human keeper.
CREATE TABLE IF NOT EXISTS recovery_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_pubkey TEXT NOT NULL REFERENCES members(public_key),
    holder_type TEXT NOT NULL CHECK (holder_type IN ('hub', 'member', 'sso')),
    holder_ref TEXT NOT NULL,        -- member pubkey | provider name | 'self'
    share_index INTEGER NOT NULL,    -- Shamir evaluation point (the fragment's x-coordinate)
    encrypted_share TEXT NOT NULL,
    share_iv TEXT NOT NULL,
    share_tag TEXT NOT NULL,
    ephemeral_pubkey TEXT,           -- X25519 ephemeral, for 'member' holders
    sso_lookup_hash TEXT,            -- SHA-256(sub || lookup_salt), for 'sso' holders
    sso_lookup_salt TEXT,
    kdf_params TEXT,
    -- Bumped on every re-split. This is what makes removing a keeper real rather than cosmetic:
    -- a removed keeper physically keeps whatever fragment they already had, so the only way to
    -- revoke it is to make it useless. A re-split does that — fragments of different generations
    -- describe different polynomials and cannot be mixed — and collection refuses any generation
    -- but the current one.
    generation INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Watermark for delta backup. Rows are never updated in place (a re-split writes a new
    -- generation and drops the old), so there is no touch trigger — created_at and updated_at
    -- move together by construction. The column exists so the table can join the delta set
    -- without a later migration; wiring it into engine/sync.ts is a separate, deliberate step.
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Column order is deliberate: leading with (owner_pubkey, generation) means this constraint's
    -- implicit index also serves every read in engine/recovery-shares.ts, all of which filter on
    -- exactly that pair. A separate owner+generation index would duplicate it for no gain.
    UNIQUE(owner_pubkey, generation, holder_type, holder_ref)
);
-- UNIQUE rather than a plain index. `sso_lookup_hash` is SHA-256(sub ‖ per-split random salt), so
-- two owners colliding is not a realistic event — which is the point: if it ever happens it means
-- the salt is not doing its job, and that is a bug worth failing loudly on at write time rather
-- than discovering as findShareBySsoLookup serving one arbitrary row of two at recovery. Partial,
-- because the column is NULL for every keeper that is not a sign-in keeper.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_shares_sso
    ON recovery_shares(sso_lookup_hash)
    WHERE sso_lookup_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recovery_shares_updated_at ON recovery_shares(updated_at);

-- 14b. Recovery collection — one attempt to gather enough fragments to rebuild a phrase.
--
-- A device doing this has NO identity yet: that is the whole situation. It cannot sign as the
-- owner, because the owner's key is precisely what it is trying to rebuild. So the session id is
-- an unguessable bearer secret, handed to whoever opened the session and to nobody else, and
-- every fragment released into it is still gated by its own rule on top. Holding the id alone
-- yields nothing — member fragments are re-wrapped to `requester_ephemeral_pubkey` by the keeper
-- who approves, so the node never sees a plaintext piece and neither does anyone who guesses.
--
-- `generation` is pinned when the session opens and every release checks it. An owner who
-- re-splits mid-collection kills the session — which is not an edge case but the DEFENCE: if you
-- notice a recovery you did not start, re-splitting is how you stop it (R1).
CREATE TABLE IF NOT EXISTS recovery_collections (
    id TEXT PRIMARY KEY,                                   -- 32 random bytes, base64url
    owner_pubkey TEXT NOT NULL REFERENCES members(public_key),
    generation INTEGER NOT NULL,
    -- X25519 public key of the recovering device. Keepers wrap their decrypted fragment to this,
    -- so a released piece is readable only by the device that opened the session.
    requester_ephemeral_pubkey TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete', 'cancelled', 'expired')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL,
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_recovery_collections_owner ON recovery_collections(owner_pubkey, status);
CREATE INDEX IF NOT EXISTS idx_recovery_collections_updated_at ON recovery_collections(updated_at);

-- One fragment released into one collection. The unique constraint is what makes a release
-- idempotent rather than cumulative: a keeper tapping Approve twice, or a client retrying a
-- request that already succeeded, must not look like two of the three pieces.
CREATE TABLE IF NOT EXISTS recovery_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id TEXT NOT NULL REFERENCES recovery_collections(id),
    -- NO foreign key to recovery_shares, deliberately. A release is a historical record of a
    -- fragment that was handed over; the row it came from is DELETED by the next re-split, which
    -- is the entire mechanism by which removing a keeper means anything. Declaring the reference
    -- would assert a lifetime the design breaks on purpose — and while `foreign_keys` is OFF today
    -- so nothing would enforce it, that makes it worse rather than better: correctness would be
    -- resting on a pragma, and turning enforcement on later would break re-splitting for every
    -- member who had ever started a recovery.
    share_id INTEGER NOT NULL,
    holder_type TEXT NOT NULL CHECK (holder_type IN ('hub', 'member', 'sso')),
    share_index INTEGER NOT NULL,
    -- The fragment as the recovering device will read it. For 'member' this is the keeper's
    -- re-wrap to requester_ephemeral_pubkey; for 'hub' and 'sso' it is the stored ciphertext,
    -- which that device can already open (it holds the hub release or has just proved the sub).
    payload TEXT NOT NULL,
    payload_iv TEXT NOT NULL,
    payload_tag TEXT NOT NULL,
    ephemeral_pubkey TEXT,
    kdf_params TEXT,
    -- The keeper who approved, for 'member' releases. NULL for machine-released pieces, which is
    -- exactly the distinction D7 turns on.
    released_by TEXT,
    released_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(collection_id, share_id)
);
CREATE INDEX IF NOT EXISTS idx_recovery_releases_collection ON recovery_releases(collection_id);
CREATE INDEX IF NOT EXISTS idx_recovery_releases_updated_at ON recovery_releases(updated_at);

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
    archetype, elder_vouched_by, can_vouch, vouch_credit, credit_frozen, is_treasury, can_operate, joined_at, public_key
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

-- ============================================================================
-- Phase 2 delta backup — watermark triggers for the remaining mutable tables.
--
-- These tables gained their `updated_at` column via ALTER TABLE on already-live
-- DBs (see db.ts), where SQLite forbids a non-constant DEFAULT. So new rows on an
-- existing node would be inserted with a NULL watermark and be invisible to the
-- `WHERE updated_at > :since` delta filter. Each table therefore gets BOTH:
--   * an AFTER INSERT trigger that stamps updated_at when it came in NULL, and
--   * an AFTER UPDATE touch trigger that bumps it on any mutation.
-- Fresh nodes get the column WITH a DEFAULT from CREATE TABLE above, so the INSERT
-- trigger's `WHEN NEW.updated_at IS NULL` guard is simply never taken there.
--
-- Unlike the members trigger, these are NOT column-whitelisted: they fire on any
-- UPDATE (guarded by NEW.updated_at IS OLD.updated_at so an importer applying a
-- remote row's own timestamp is preserved, and so an explicit updated_at write
-- isn't double-stamped). Firing broadly also means the social-recovery pubkey
-- rewrite (which touches author_pubkey / is_guardian owner keys / reporter keys /
-- participant keys without setting updated_at) is picked up by delta rather than
-- only by the periodic full reconcile.
-- ============================================================================

-- posts already sets updated_at explicitly in every app write path and has a
-- DEFAULT, so it needs no INSERT trigger — but a touch trigger closes the gap for
-- the recovery pubkey rewrite and any future write path that forgets to bump it.
CREATE TRIGGER IF NOT EXISTS posts_touch_updated_at
AFTER UPDATE ON posts
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE posts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_set_updated_at_on_insert
AFTER INSERT ON messages
FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
    UPDATE messages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS messages_touch_updated_at
AFTER UPDATE ON messages
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE messages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS friends_set_updated_at_on_insert
AFTER INSERT ON friends
FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
    UPDATE friends SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE owner_pubkey = NEW.owner_pubkey AND friend_pubkey = NEW.friend_pubkey;
END;
CREATE TRIGGER IF NOT EXISTS friends_touch_updated_at
AFTER UPDATE ON friends
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE friends SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE owner_pubkey = NEW.owner_pubkey AND friend_pubkey = NEW.friend_pubkey;
END;

CREATE TRIGGER IF NOT EXISTS abuse_reports_set_updated_at_on_insert
AFTER INSERT ON abuse_reports
FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
    UPDATE abuse_reports SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER IF NOT EXISTS abuse_reports_touch_updated_at
AFTER UPDATE ON abuse_reports
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE abuse_reports SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS conversation_participants_set_updated_at_on_insert
AFTER INSERT ON conversation_participants
FOR EACH ROW
WHEN NEW.updated_at IS NULL
BEGIN
    UPDATE conversation_participants SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE conversation_id = NEW.conversation_id AND public_key = NEW.public_key;
END;
CREATE TRIGGER IF NOT EXISTS conversation_participants_touch_updated_at
AFTER UPDATE ON conversation_participants
FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE conversation_participants SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE conversation_id = NEW.conversation_id AND public_key = NEW.public_key;
END;

-- 19. System Metrics (Change 3 / Visibility monitors)
CREATE TABLE IF NOT EXISTS system_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    metric_key TEXT NOT NULL,
    metric_value REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_metrics_key_time ON system_metrics(metric_key, timestamp DESC);

-- 20. Treasury keepership (#106)
-- Binds a member to ONE community enterprise (a members row with is_treasury=1).
-- Before this table, members.can_operate was a node-wide boolean: granting someone
-- stewardship of the egg flock also handed them every other treasury on the node.
--
-- Authority = members.can_operate = 1 AND a row here. can_operate is retained as a
-- master switch per member (so an admin can suspend a keeper without dropping their
-- assignments), and adminAssignTreasuryOperator sets it automatically so a row can
-- never be silently inert.
--
-- granted_by holds the granting admin's public key today. It is deliberately a plain
-- TEXT with no FK so an `appoint` Decision id can be recorded here later
-- (docs/community-governance.md) without a migration.
CREATE TABLE IF NOT EXISTS treasury_operators (
    treasury_pubkey TEXT NOT NULL REFERENCES members(public_key),
    member_pubkey   TEXT NOT NULL REFERENCES members(public_key),
    role            TEXT NOT NULL DEFAULT 'keeper',
    granted_at      DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    granted_by      TEXT,
    PRIMARY KEY (treasury_pubkey, member_pubkey)
);
-- Covers "which enterprises does this member steward?" — the stewardOf() lookup that
-- drives the Commons tab's per-enterprise controls.
CREATE INDEX IF NOT EXISTS idx_treasury_operators_member ON treasury_operators(member_pubkey);

-- 21. Cross-node settlements (#104) — the durable state machine behind charge-home settlement.
--
-- Spec: docs/federation-economics.md §2.5. This is the "outbox" the failure-handling rules require, and
-- BOTH sides of a trade keep a row, for different reasons:
--
--   the BUYER's node persists 'committed' before returning a receipt, so a bridge disagreement is
--   DETECTABLE — without it, a receipt that was never acted on is invisible and the mismatch surfaces
--   later as unexplained drift;
--   the SELLER's node persists the receipt before paying its seller, so payment is REPLAYABLE — a crash
--   mid-payment resumes from the receipt instead of losing the fact that it owes someone.
--
-- `key` is the idempotency key, minted by the buyer's node and shared by both sides. Every transition is
-- idempotent on it, so a retry can never double-charge or double-pay.
CREATE TABLE IF NOT EXISTS settlements (
    key             TEXT PRIMARY KEY,
    -- 'outbound' = we are the buyer's node (we debit our member, we owe outward)
    -- 'inbound'  = we are the seller's node (we mint locally, we are owed)
    direction       TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    peer_id         TEXT NOT NULL,
    buyer_pubkey    TEXT NOT NULL,
    buyer_home_node TEXT,
    seller_pubkey   TEXT,
    post_id         TEXT,
    amount          REAL NOT NULL CHECK (amount > 0),
    -- Outbound only. The cross-node fee is paid by the buyer ON TOP of the price (§2.1), so it is a
    -- separate figure from `amount` — the bridge entries carry the price alone, never price plus fee.
    -- Stored rather than recomputed so a reversal refunds exactly what was taken, even if the fee rate
    -- changes between the commit and the reversal.
    fee             REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
    -- Inbound only. When the cap reservation lapses. A reservation moves no beans, so expiry is free —
    -- but a receipt arriving after it must be re-validated against the cap, never honoured on trust.
    reserved_until  DATETIME,
    -- Deliberately NOT a foreign key and NOT reused from marketplace_transactions: a settlement outlives
    -- the trade it came from, and must remain auditable after a post is deleted.
    state           TEXT NOT NULL CHECK (state IN (
                        'escrowed',    -- outbound: buyer's beans held, peer not yet asked
                        'reserved',    -- inbound: our cap reserved, seller NOT yet paid
                        'committed',   -- outbound: real entries written, receipt issued, awaiting confirmation
                        'held',        -- inbound: receipt persisted, seller not yet paid
                        'settled',     -- both: complete and agreed
                        'reversed',    -- compensated by opposite entries (never deleted)
                        'abandoned'    -- refused/expired before any entries were written
                    )),
    receipt         TEXT,
    -- Outbound only: the EXACT canonical receipt object that was signed, as JSON.
    --
    -- Storing the signature alone is not enough. A retried commit has to return a byte-identical payload
    -- or the stored signature fails to verify on the peer's side, and `committedAt` is not reproducible
    -- from `updated_at` (a different clock and format). Keeping the whole object rather than the two
    -- missing fields also means a future payload field can't silently break replay.
    receipt_payload TEXT,
    failure_reason  TEXT,
    created_at      DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Boot recovery scans for unfinalised rows, so index the states it looks for.
-- Keyed on created_at ALONE, with the state set in the partial WHERE.
--
-- Recovery runs `WHERE state IN (4 values) ORDER BY created_at`. A (state, created_at) index is used, but
-- still needs a TEMP B-TREE: an IN over the leading column becomes four separate index seeks, and merging
-- four created_at-ordered ranges is not globally ordered. Measured, not assumed — EXPLAIN QUERY PLAN said
-- `USE TEMP B-TREE FOR ORDER BY`.
--
-- Putting the state set in the partial condition instead means the index contains EXACTLY the unfinalised
-- rows, already in created_at order, so the scan needs no filter and no sort. The test asserts both.
CREATE INDEX IF NOT EXISTS idx_settlements_unfinalised ON settlements(created_at)
    WHERE state IN ('escrowed', 'reserved', 'committed', 'held');
-- Covers reservedAgainstPeer(), which filters peer_id and direction by EQUALITY and state by IN. Equality
-- columns come first: a range/IN predicate stops the index being usable for anything after it.
CREATE INDEX IF NOT EXISTS idx_settlements_peer ON settlements(peer_id, direction, state);
-- memberForeignExposure() sums a member's outbound settlements (Rule 4's aggregate figure) and would
-- otherwise full-scan a table that only ever grows. Column order matches the query's selectivity:
-- buyer_pubkey narrows to one member first, then direction and state.
CREATE INDEX IF NOT EXISTS idx_settlements_buyer ON settlements(buyer_pubkey, direction, state);
-- Reservation expiry runs on every recovery cycle and would otherwise scan every reserved row. Partial,
-- because only inbound reservations ever carry a `reserved_until`.
CREATE INDEX IF NOT EXISTS idx_settlements_reserved_until ON settlements(reserved_until)
    WHERE direction = 'inbound' AND state = 'reserved';

-- 22. Federation links (#143, slice step 3) — a peer relationship as an ENTERPRISE.
--
-- Spec: docs/federation-connector.md §7. "A federation link is an enterprise": each peer we settle with
-- gets a named enterprise in the Commons tab ("Byron Link") with a treasury, a keeper, and a visible
-- energy balance. This table is the join between the two halves that already exist — the peer id that
-- keys `bridge_<peer>`, and the `is_treasury=1` members row that gives an enterprise a face.
--
-- WHY A LINK IS NOT JUST THE BRIDGE ROW. The bridge account is the tab and CANNOT be spent
-- (federation-economics.md §2.2) — it is a record of obligation between two nodes, not a pot. Calling a
-- favour in needs real beans from this community's own circulation, so the link needs an account of its
-- own. Two numbers on one card, and conflating them is the mistake §2.4 exists to prevent:
--
--   energy balance = balance of `bridge_<peer_id>`   — what we owe / are owed. Not spendable.
--   treasury       = balance of `treasury_pubkey`     — real beans the keeper may commission with.
--
-- Rows are DERIVED, never pushed: a link exists for every connector that has a credit cap, and
-- `reconcileFederationLinks()` converges that on boot and whenever a cap is set. Setting a cap is
-- already the deliberate act that enables settlement with a peer (§7), so the enterprise appears at the
-- same moment rather than being a second thing to remember — and there is no way to end up settling
-- with a peer that has no visible home and nobody accountable for it.
CREATE TABLE IF NOT EXISTS federation_links (
    -- The libp2p peer id, which is what `bridge_<peer>` is keyed on. NOT the connector address: an
    -- operator may rewrite an address (a moved host, a new port) without it becoming a different peer,
    -- and the link must survive that — it holds real beans.
    peer_id            TEXT PRIMARY KEY,
    treasury_pubkey    TEXT NOT NULL REFERENCES members(public_key),
    -- The keeper's commissioning ceiling: how much they may commission across the boundary without
    -- asking anyone (§7, "the ceiling is the safety, and it must be visible alongside the balance").
    -- Starts at 0 — a link with no ceiling can hold a balance and show it, but cannot spend. Deliberate:
    -- the link is created automatically, so anything it could do unattended must start switched off.
    commission_ceiling REAL NOT NULL DEFAULT 0 CHECK (commission_ceiling >= 0),
    created_at         DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Answers "is this treasury a federation link?" for the Commons list, which reads every treasury and
-- would otherwise scan this table per row. UNIQUE because one treasury backs exactly one peer: sharing
-- one across two links would pool two separate obligations into one pot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_federation_links_treasury ON federation_links(treasury_pubkey);

-- Onboarding funnel: how many people try to join, and where they stop. Counts only the steps the node
-- cannot reconstruct afterwards — a rejected invite code leaves no row behind, so it has to be counted
-- as it happens. Steps that ARE already recorded elsewhere (join dates, first posts) are derived on
-- read instead, which is why they carry full history from day one. See engine/funnel.ts.
--
-- There is deliberately no public_key column and no foreign key to members. The grain is
-- (day, event, variant) and nothing finer, so an operator can see that four people abandoned the
-- protection screen and cannot see which four. That is the whole difference between a funnel and a
-- surveillance log, and it is this table definition that decides it — a well-meant "just add the
-- pubkey so we can help them" would quietly cross the line. Keep it out.
--
-- Node-local, and it stays that way: sync.ts carries an explicit typed payload rather than
-- enumerating tables, so this does not replicate to peers or backup nodes. Do not add it there.
CREATE TABLE IF NOT EXISTS onboarding_funnel (
    day     TEXT NOT NULL,              -- YYYY-MM-DD, UTC
    event   TEXT NOT NULL,              -- invite_attempt | invite_failed | avatar_published | ...
    variant TEXT NOT NULL DEFAULT '',   -- failure reason, keeper-count state, or choice made
    -- Only ever incremented, so it cannot go negative today. The CHECK is here so it
    -- cannot start to: a tally that reads -3 is worse than one that refuses to write.
    count   INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (day, event, variant)
);
-- The funnel derives "who joined" and "who got started" from these two tables rather than
-- counting them, so both queries group over history every time the dashboard is opened.
-- Partial indexes because both queries only ever look at local rows — a federation
-- visitor is not a signup, and a federated listing is not somebody getting started here.
CREATE INDEX IF NOT EXISTS idx_members_joined_at_local ON members(joined_at) WHERE home_node_url IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_author_created_local ON posts(author_pubkey, created_at) WHERE origin_node IS NULL;

-- 21. Mirror Sync Audit Log (#134)
-- Permanent audit trail: every importRemoteState() call writes one row recording
-- the originating peer's identity and what changed. This makes it possible to
-- trace a corrupt import back to its source peer and roll back deliberately.
-- Only backup nodes write to this table (primary nodes never call importRemoteState).
CREATE TABLE IF NOT EXISTS sync_audit_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at        DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    origin_peer_id   TEXT NOT NULL,   -- libp2p peer ID of the signing mirror connector
    origin_node_id   TEXT NOT NULL,   -- nodeId string from the SyncPayload
    new_members      INTEGER NOT NULL DEFAULT 0,
    updated_members  INTEGER NOT NULL DEFAULT 0,
    new_posts        INTEGER NOT NULL DEFAULT 0,
    updated_posts    INTEGER NOT NULL DEFAULT 0,
    new_transactions INTEGER NOT NULL DEFAULT 0,
    account_changes  INTEGER NOT NULL DEFAULT 0,
    marketplace_txns INTEGER NOT NULL DEFAULT 0,
    new_messages     INTEGER NOT NULL DEFAULT 0,
    tombstones_applied INTEGER NOT NULL DEFAULT 0,
    conflicts_skipped  INTEGER NOT NULL DEFAULT 0,
    recovery_shares_imported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sync_audit_log_peer ON sync_audit_log(origin_peer_id, synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_audit_log_time ON sync_audit_log(synced_at DESC);

-- ===================== RECOVERY PIN =====================
-- Optional 6-digit numeric PIN for non-SSO recovery. When set, a correct PIN entry
-- reveals the member's keeper list (which friends hold their Shamir fragments) —
-- it does NOT gate release of fragment A itself.
--
-- Rate limited: 2 free attempts, then 1 attempt per 15 minutes. No hard lockout.
-- The response for "wrong PIN" and "no such callsign" is intentionally identical
-- to prevent member enumeration.
CREATE TABLE IF NOT EXISTS recovery_pin (
    owner_pubkey   TEXT PRIMARY KEY REFERENCES members(public_key),
    pin_hash       TEXT NOT NULL,
    pin_salt       TEXT NOT NULL,
    attempts       INTEGER NOT NULL DEFAULT 0,
    last_attempt_at DATETIME,
    created_at     DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_recovery_pin_updated_at ON recovery_pin(updated_at);

