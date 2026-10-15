-- 0010: our own servers' other names, reserved (F1 of scratch/reviews/fable-security-registrar.md, 2026-10-15). Each is a
-- hostname of ours under beanpool.org, routed by a record made by hand at Cloudflare, outside the registrar, and none
-- is in 0001's seed or 0005. Without a policy row any node key could claim it, and a claim's ensure() would PATCH or
-- replace the record it finds there and delete a bp-<name> tunnel it does not know (0005 tells the same story for
-- global). Where each was found:
--   vault        wrangler.toml WATCH_TARGETS (kind "vault"); apps/vault (Caddyfile, api.json, README); the key vault
--   auth         docs/recovery-model.md "Sign in with Apple & auth.beanpool.org" (the Apple callback host)
--   mullum1      apps/server/README.md (fleet table, failover primary); ROADMAP.md; scripts/bp-diagnose.mjs
--   mullum2      apps/server/README.md (fleet table, failover secondary); ROADMAP.md; scripts/bp-diagnose.mjs
--   mullum3      apps/server/README.md (failover tertiary)
--   test-mirror  apps/server/README.md (fleet table, node 6); ROADMAP.md; scripts/bp-diagnose.mjs
--   p2p-mullum2  apps/server/README.md (libp2p WebSocket CNAME); ROADMAP.md
-- Not here, on purpose: test and yarravalley (our nodes that claim their names THROUGH the registrar: a policy row would
-- refuse their own claims; the live table dropped `test` for that reason), and every name already reserved by 0001 or
-- 0005. The zone may hold others the repo never names: scripts/check-zone-reserved.mjs, run by the director at deploy
-- with the zone's record list, fails until each has a row.
--
-- `blocked`, not `gated`, for 0005's reason: a gated claim goes live on the admin's approve, which runs ensure().
--
-- Additive: INSERT OR IGNORE, so a row already there (the live database's, or one the admin has moved since) is kept as
-- it is. Re-running changes nothing.

INSERT OR IGNORE INTO name_policy (pattern, tier) VALUES
  ('vault','blocked'),('auth','blocked'),('mullum1','blocked'),('mullum2','blocked'),('mullum3','blocked'),
  ('test-mirror','blocked'),('p2p-mullum2','blocked');
