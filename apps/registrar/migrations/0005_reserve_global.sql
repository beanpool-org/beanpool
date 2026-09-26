-- 0005: the global node's names, reserved. The global node is global.beanpool.org, and earth.beanpool.org redirects to
-- it; both are routed by records made by hand at Cloudflare, outside the registrar, as our own nodes' names are. The
-- live name_policy already has these rows (added by hand); 0001's seed does not, so a registrar built fresh from this
-- repo would let any node key claim them — and a claim's ensure() PATCHes a record it finds at the hostname, re-pointing
-- the global node's address at the claimant.
--
-- `blocked`, not `gated`: a gated claim goes live on the admin's approve, which runs that same ensure(). Nothing
-- allocates a blocked name, and nothing needs to: the global node's address is not the registrar's.
--
-- Additive: two policy rows, each only where the table has no row for that name, so a row already there (the live
-- database's, or one the admin has moved to another tier since) is kept as it is. Re-running changes nothing.

INSERT OR IGNORE INTO name_policy (pattern, tier) VALUES ('global','blocked'),('earth','blocked');
