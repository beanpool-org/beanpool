-- A community's name on its members' listings on the global community (list-on-global G5,
-- scratch/fable-design/DESIGN-list-on-global-fable.md §2 and §4): one boolean column on the directory, and the view the
-- readers read carries it.
--
-- NOT APPLIED BY ANY AGENT. The director applies it by hand to the directory's Supabase project (dpemwoermzkaxoctafzg)
-- through the Management API after Marty's yes and the PR's merge, BEFORE deploying the `directory-register` function from
-- this PR (supabase/functions/directory-register/index.ts, which writes the column: a function deployed first would fail
-- every push on a column the table doesn't have). Then the read-only checks in the PR body.
--
-- Until it is applied, nothing changes for anyone: a node's push already carries `listingsFromHere` (true or false, never
-- left out), the function deployed today (v6) stores the fields it names and ignores the rest, the view has no such
-- column, and every global node's mirror reads a row without it as on (apps/server/src/engine/directory-cache.ts
-- listingsFromHere). A community that has switched it off shows its name beside its members' copies until both are done.
--
-- What it changes for existing data: one nullable column, NULL on every row there (every reader takes NULL as on); each
-- node's next push writes true or false. No row is written, deleted or locked by this file beyond the ALTER's own brief
-- lock on directory_nodes. RLS and the public read stay as they are.
--
-- 1. The table: the push's `listingsFromHere`, as the function stores it (rules.ts listingsFromHereOf): true, false, or
--    NULL for a push that said nothing (a node from before the switch) or something that is no boolean. Never refused.
alter table public.directory_nodes
    add column if not exists listings_from_here boolean;

comment on column public.directory_nodes.listings_from_here is
    'Whether the community''s name and Ask to join are drawn beside its members'' listings on the global community: false only where its signed push said so; NULL (an older node) reads as true.';

-- 2. The view (front doors S13, 2026102800_directory_listed.sql) as it is, with the column added at its end: create or
--    replace view may only add columns after the ones it has, with the same names and types before them. Everything else
--    in it is unchanged (scripts/directory-listings-from-here-migration.test.mjs holds it to the S13 view, line for line).
create or replace view public.directory_listed
with (security_invoker = true) as
select
    d.node_id,
    d.callsign,
    d.community_name,
    d.service_radius,
    d.member_count,
    d.contact_email,
    d.contact_phone,
    d.node_version,
    d.node_url,
    d.promise,
    d.accepting_knocks,
    d.closing_on,
    d.updated_at,
    case
        when nullif(btrim(d.community_name), '') is null or lower(btrim(d.community_name)) = 'beanpool community'
            then coalesce(address.host, nullif(btrim(d.community_name), ''))
        else btrim(d.community_name)
    end as shown_name,
    d.updated_at as last_seen_at,
    d.listings_from_here
from public.directory_nodes d
cross join lateral (
    -- The host of an https address (or a bare host), lower case, without a port; null when node_url is no https address
    -- (rule 2 above). The pattern allows nothing between the host (and port) and the path's first "/", so cutting at the
    -- first "/" and then the first ":" leaves the host.
    select case
        when octet_length(btrim(d.node_url)) <= 300
         and btrim(d.node_url) ~* '^(https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/.*)?|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?/?)$'
            then split_part(split_part(regexp_replace(lower(btrim(d.node_url)), '^https://', ''), '/', 1), ':', 1)
    end as host
) address
where d.updated_at >= now() - interval '7 days'
  and (
        address.host is not null
        or nullif(btrim(d.contact_email), '') is not null
        or nullif(btrim(d.contact_phone), '') is not null
  );

comment on view public.directory_listed is
    'The directory rows a stranger is shown (front doors S13): pushed within 7 days, with an https address or a contact; shown_name is the community''s own name or the host of its address; last_seen_at is its last push; listings_from_here is whether its name goes beside its members'' listings on the global community (NULL reads as true). Reads directory_nodes as the caller (security_invoker).';

-- Read-only to everyone who reads the table, as S13 left it (create or replace keeps a view's grants; said again so the file
-- can be run on its own).
revoke all on public.directory_listed from public;
revoke insert, update, delete, truncate, references, trigger on public.directory_listed from anon, authenticated;
grant select on public.directory_listed to anon, authenticated;

-- 3. The function (by hand, `supabase functions deploy directory-register`, after 1 and 2): this PR's index.ts sets
--      listings_from_here: listingsFromHereOf(payload)
--    beside the fields it stores today: the push's boolean, else NULL. Nothing else in it changes.
--
-- To undo: run 2026102800_directory_listed.sql again (the view without the column), then
--          alter table public.directory_nodes drop column if exists listings_from_here;
--          and deploy the function from before this PR (v6).
