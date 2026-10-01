-- 0006: the one-use nonces of signed requests (signing protocol v2, src/sign.js). A v2 request signs an x-bp-nonce;
-- the Worker records it here before acting, and refuses a second request from the same key carrying the same one, so a
-- captured request can't be replayed while its timestamp is still inside the clock window (±300 s). A row is needed only
-- while its request's timestamp could still verify: the sweep deletes rows whose timestamp is over 600 s old.
-- v1 requests sign no nonce and write nothing here.
--
-- Additive: one new table. Apply before deploying the Worker that writes it (an older Worker never reads it). Re-running
-- changes nothing.

CREATE TABLE IF NOT EXISTS request_nonces (
    pubkey TEXT NOT NULL,      -- the signing key (hex, lower case)
    nonce  TEXT NOT NULL,      -- x-bp-nonce: 32 hex
    ts     INTEGER NOT NULL,   -- the request's signed timestamp (unix s)
    PRIMARY KEY (pubkey, nonce)
);
CREATE INDEX IF NOT EXISTS idx_request_nonces_ts ON request_nonces(ts);
