-- Fail migration if recovery_shares is not empty, because removing a keeper type requires a re-split.
-- The node will need to be wiped/reset for this upgrade if testing with existing rows.
-- (SQLite does not support RAISE outside triggers, so we use a deliberate error on row existence)
SELECT (CASE WHEN COUNT(*) > 0 THEN ABS('Migration failed: recovery_shares has data, please wipe database') ELSE 1 END) FROM recovery_shares HAVING COUNT(*) > 0;

PRAGMA foreign_keys=OFF;

-- Drop and recreate to alter the CHECK constraint
CREATE TABLE new_recovery_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_pubkey TEXT NOT NULL REFERENCES members(public_key),
    holder_type TEXT NOT NULL CHECK (holder_type IN ('hub', 'member', 'sso')),
    holder_ref TEXT NOT NULL,
    share_index INTEGER NOT NULL,
    encrypted_share TEXT NOT NULL,
    share_iv TEXT NOT NULL,
    share_tag TEXT NOT NULL,
    ephemeral_pubkey TEXT,
    sso_lookup_hash TEXT,
    sso_lookup_salt TEXT,
    kdf_params TEXT,
    generation INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(owner_pubkey, generation, holder_type, holder_ref)
);

INSERT INTO new_recovery_shares SELECT * FROM recovery_shares;

DROP TABLE recovery_shares;
ALTER TABLE new_recovery_shares RENAME TO recovery_shares;

CREATE UNIQUE INDEX idx_recovery_shares_sso ON recovery_shares(sso_lookup_hash) WHERE sso_lookup_hash IS NOT NULL;
CREATE INDEX idx_recovery_shares_updated_at ON recovery_shares(updated_at);

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
