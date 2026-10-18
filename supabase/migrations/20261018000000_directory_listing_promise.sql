-- The listing promise in the public directory (mothership slice A2, DESIGN-global-mothership-fable.md §1.2).
--
-- NOT APPLIED BY ANY AGENT. The director applies it by hand to the directory's Supabase project (dpemwoermzkaxoctafzg),
-- then changes the `directory-register` Edge Function (not in this repo) as below. Until both are done, every node keeps
-- being listed as before: a node's push carries the three fields, and if the registry refuses them it pushes again
-- without them (apps/server/src/services/directory-publisher.ts); a registry that ignores them stores the row as before.
--
-- What a node's push (POST, signed by its node key over the raw body) now also carries:
--   promise          null, or exactly {"v":1,"owners":<whole number from 2>,"backups":true,"reports":true,"notice":true}:
--                    counts and booleans only, never a name
--   acceptingKnocks  true or false: whether a stranger can ask to join from the directory
--   closingOn        null, or a day "YYYY-MM-DD": when the community says it closes
--
-- 1. The table: three columns, nullable, so every existing row and every older node's push stays valid.
alter table public.directory_nodes
    add column if not exists promise jsonb,
    add column if not exists accepting_knocks boolean,
    add column if not exists closing_on date;

-- The shape at the table too, so a row can't hold more than the promise even if the function is changed carelessly.
-- NOT VALID: rows already there are not checked (they hold no promise), only rows written from now on.
alter table public.directory_nodes
    drop constraint if exists directory_nodes_promise_shape;
alter table public.directory_nodes
    add constraint directory_nodes_promise_shape check (
        promise is null or (
            -- Each test in turn (a CASE runs its branches in order; an AND may not), so nothing is cast that isn't a number.
            case when jsonb_typeof(promise) <> 'object' then false
                 -- the five keys, and nothing left once they are taken away
                 when not (promise ?& array['v', 'owners', 'backups', 'reports', 'notice']) then false
                 when (promise - array['v', 'owners', 'backups', 'reports', 'notice']) <> '{}'::jsonb then false
                 when jsonb_typeof(promise -> 'owners') <> 'number' then false
                 else promise -> 'v' = '1'::jsonb
                      and (promise ->> 'owners')::numeric between 2 and 1000
                      and (promise ->> 'owners')::numeric = floor((promise ->> 'owners')::numeric)
                      and promise -> 'backups' = 'true'::jsonb
                      and promise -> 'reports' = 'true'::jsonb
                      and promise -> 'notice' = 'true'::jsonb
            end
        )
    ) not valid;

-- 2. The Edge Function `directory-register` (by hand, in the Supabase dashboard or `supabase functions deploy`). Beside
--    the fields it stores today (node_id ← nodeId, callsign, community_name ← communityName, service_radius ←
--    serviceRadius, member_count ← memberCount, contact_email ← contactEmail, contact_phone ← contactPhone, node_version ←
--    nodeVersion, node_url ← publicUrl), after it has verified the signature as today, ALWAYS set all three (null when
--    the push leaves one out, so an older node's push, or a promise that lapsed, clears what was stored):
--
--      promise:          body.promise is an object with exactly the five keys above and those values ? body.promise : null
--      accepting_knocks: typeof body.acceptingKnocks === 'boolean' ? body.acceptingKnocks : null
--      closing_on:       /^\d{4}-\d{2}-\d{2}$/.test(body.closingOn) ? body.closingOn : null
--
--    Nothing else from the body. A value of the wrong shape is stored as null, never refused: refusing would cost the
--    community its whole listing (the node then pushes again without the fields, but an older function must not depend
--    on that).
--
-- 3. Reading: the website (anon/publishable key, `select=*`) and every global node's mirror
--    (apps/server/src/services/directory-mirror.ts, `select=*`) read the new columns with no change. If the table's read
--    policy grants columns one by one rather than rows, grant select on the three new columns to anon as well.
--
-- To undo: alter table public.directory_nodes drop constraint if exists directory_nodes_promise_shape,
--          drop column if exists promise, drop column if exists accepting_knocks, drop column if exists closing_on;
