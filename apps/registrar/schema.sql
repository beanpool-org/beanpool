-- Beanpool node-address registrar — D1 schema.
-- One row per claimed name; policy table drives auto/gated/blocked tiers.

CREATE TABLE IF NOT EXISTS name_allocations (
    name           TEXT PRIMARY KEY,          -- 'cairns' (label; ^[a-z0-9-]{3,32}$)
    node_pubkey    TEXT NOT NULL,             -- claimant node's Ed25519 identity key (hex)
    hostname       TEXT NOT NULL,             -- FQDN we attest against, e.g. cairns.beanpool.org
    mode           TEXT NOT NULL,             -- 'tunnel' | 'direct'  ('byo' in Phase 2)
    status         TEXT NOT NULL,             -- 'pending' | 'live' | 'revoked'
    community_name TEXT,                       -- display name of the community / node
    tunnel_id      TEXT,                       -- CF tunnel id (tunnel mode)
    dns_record_id  TEXT,                       -- CF DNS record id (both modes)
    origin         TEXT,                       -- tunnel ingress origin, e.g. http://node:3000
    public_ip      TEXT,                       -- A-record target (direct mode)
    contact        TEXT,                       -- optional operator contact email / handle
    attest_fails   INTEGER NOT NULL DEFAULT 0, -- consecutive *mismatches* (wrong identity) — NOT offline misses
    last_attest_at INTEGER,                    -- unix seconds of last successful attest (old = unverified/offline)
    requested_at   INTEGER NOT NULL,
    decided_at     INTEGER,
    decided_by     TEXT                        -- 'admin' | 'auto'
);

CREATE INDEX IF NOT EXISTS idx_alloc_status ON name_allocations(status);
CREATE INDEX IF NOT EXISTS idx_alloc_pubkey ON name_allocations(node_pubkey);

CREATE TABLE IF NOT EXISTS name_policy (
    pattern TEXT PRIMARY KEY,   -- exact name
    tier    TEXT NOT NULL       -- 'blocked' | 'gated'   (anything absent = auto)
);

-- Seed: blocked = system + our own live subdomains (from the zone, 2026-07-27).
INSERT OR IGNORE INTO name_policy (pattern, tier) VALUES
  ('www','blocked'),('api','blocked'),('app','blocked'),('admin','blocked'),
  ('mail','blocked'),('smtp','blocked'),('ns1','blocked'),('ns2','blocked'),
  ('status','blocked'),('help','blocked'),('support','blocked'),('docs','blocked'),
  ('blog','blocked'),('beanpool','blocked'),('register','blocked'),('i','blocked'),
  ('test','blocked'),('review','blocked'),('mullum','blocked'),('bris','blocked'),
  ('brisbane','blocked'),('melb','blocked'),('castlemaine','blocked'),('gippsland','blocked'),
  ('eastgippy','blocked'),('bindarrabi','blocked'),('laptop','blocked'),('us','blocked'),
  ('ssh-qld','blocked'),('ssh-vic','blocked'),
  -- gated = big-city / high-value place names → require approval
  ('sydney','gated'),('melbourne','gated'),('perth','gated'),('adelaide','gated'),
  ('cairns','gated'),('darwin','gated'),('hobart','gated'),('canberra','gated'),
  ('newcastle','gated'),('wollongong','gated'),('goldcoast','gated'),('townsville','gated'),
  ('geelong','gated'),('ballarat','gated'),('bendigo','gated'),('launceston','gated');

CREATE TABLE IF NOT EXISTS invites (
    code        TEXT PRIMARY KEY,
    node_name   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

