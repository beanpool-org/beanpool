-- 0014: byron reserved for Mullumbimby (Marty, 2026-11-01; design scratch/fable-design/DESIGN-rename-primary-name-fable.md
-- §8). Mullumbimby will claim byron as its new main name, and until it does the name is free to any key. byron was free
-- and tier `auto` on 2026-11-01.
--
-- `gated`, not `blocked` (0005, 0010): a stranger's claim waits for the admin and is released, and nothing is made at
-- Cloudflare until an approve; Mullumbimby's own claim is approved. Nothing allocates a blocked name, so a blocked row
-- would refuse Mullumbimby too.
--
-- Additive: INSERT OR IGNORE, so a row already there (one the admin has moved since) is kept as it is. Re-running changes
-- nothing.

INSERT OR IGNORE INTO name_policy (pattern, tier) VALUES ('byron', 'gated');
