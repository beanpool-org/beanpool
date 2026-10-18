-- 0012: notices to the operators of names, and their one-use reply links (slice S2 of
-- scratch/global-node/DESIGN-registrar-trust-fable.md §3.2; D4 decided by Marty 2026-10-18: reach a living node through its
-- own check-in, collect nothing). src/notices.js, src/index.js handleStatus.
--
--   notices            what the admin sent from /admin ("Send a notice", to one name, a group of names or every name): its
--                      words (at most 500 characters, the BeanPool project's own), a level, whether it carries a reply link,
--                      until when it is delivered, and who it went to, in words. Never a contact, never a person.
--   notice_recipients  one row per node key a notice went to, with the name it was sent about (the key's name then):
--                      `delivered_at` when a /status first carried it, `seen_at` when that node said it has it (its
--                      `seen`). A seen notice is never carried again. A notice is carried only while its name is still
--                      held by that key (pending, live, paused or blocked: a blocked key's /status carries it too); it
--                      stops at release. `reply_token`: the reply link's token as it is carried, kept only until the node
--                      has seen it (then only its hash stays, in reply_tokens), so carrying it again writes nothing.
--   reply_tokens       a reply link (https://beanpool.org/reply/<token>, apps/feedback): the token's SHA-256, never the token;
--                      the name, key and notice it answers; used once (`used_at`), and only before `expires_at`, and only
--                      while that key still holds the name. The token is random: it says nothing of the name or the key.
--
-- The sweep deletes notices past their delivery and reply links past their use or their time, with what it has to spare.
-- Apply before deploying the Worker that reads it (the deploy workflow applies migrations/ first; an older Worker ignores
-- all of it, and this Worker without it carries no notices and answers everything else as before).

CREATE TABLE IF NOT EXISTS notices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,    -- sent (unix s)
    level      TEXT NOT NULL CHECK (level IN ('info', 'warning', 'action')),
    text       TEXT NOT NULL,       -- the admin's words, at most 500 characters
    reply      INTEGER NOT NULL DEFAULT 0,   -- 1: each delivery carries a reply link
    expires_at INTEGER NOT NULL,    -- carried until then (unix s)
    audience   TEXT NOT NULL,       -- who it went to, in words: a name, a source group, a network, every name
    by         TEXT                 -- the admin (Access email), or NULL
);

CREATE TABLE IF NOT EXISTS notice_recipients (
    notice_id    INTEGER NOT NULL,
    node_pubkey  TEXT NOT NULL,     -- the key that held the name when the notice was sent
    name         TEXT NOT NULL,     -- the name it was sent about
    delivered_at INTEGER,           -- the first /status that carried it
    seen_at      INTEGER,           -- the node's `seen` covered it: never carried again
    reply_token  TEXT,              -- the reply link's token, only until seen_at
    PRIMARY KEY (notice_id, node_pubkey)
);
CREATE INDEX IF NOT EXISTS idx_notice_recipients_key ON notice_recipients(node_pubkey, seen_at);

CREATE TABLE IF NOT EXISTS reply_tokens (
    token_hash  TEXT PRIMARY KEY,   -- SHA-256 of the token, hex
    notice_id   INTEGER NOT NULL,
    node_pubkey TEXT NOT NULL,
    name        TEXT NOT NULL,
    at          INTEGER NOT NULL,   -- made (unix s): the first /status that carried the notice
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER             -- the reply was sent: never taken again
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_tokens_recipient ON reply_tokens(notice_id, node_pubkey);
CREATE INDEX IF NOT EXISTS idx_reply_tokens_expires ON reply_tokens(expires_at);
