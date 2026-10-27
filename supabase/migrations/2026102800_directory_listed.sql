-- The directory tells the truth (front doors S13, DESIGN-doors-follow-through-fable.md §2): the rows a stranger is shown.
--
-- NOT APPLIED BY ANY AGENT. The director applies it by hand to the directory's Supabase project (dpemwoermzkaxoctafzg)
-- through the Management API after the PR merges, then runs the read-only checks in the PR body. It reads no new column,
-- so it can go before or after the function's v6.
--
-- What it changes for existing data: nothing. No row of public.directory_nodes is written, deleted or locked; the table's
-- RLS and its public read stay exactly as they are (global's mirror reads the view from its next release; the
-- organiser's own diagnostics and anything else that reads the table keep working). The 30-day purge is a separate
-- migration (2026102801_directory_purge.sql).
--
-- A row is in public.directory_listed (what the website map, global's mirror and from there both apps read) only when:
--   1. Live: its last signed push (updated_at) is within the last 7 days. A node pushes 30 s after boot and every 12 h by
--      default, so 7 days is 14 missed pushes. It comes back on its next push.
--   2. Somewhere to go: node_url is an https address, or there is a contact email or phone. "An https address" is one
--      every reader turns into a link (global's engine/directory-cache.ts communityUrl, the website's nodeHref, and the
--      phone's utils/community-origin.ts after global): at most 300 bytes (so at most the 300 characters a reader allows,
--      however it counts them), and either
--        - `https://` + host + an optional port from 1 to 65535 + an optional path from "/", or
--        - a bare host with nothing after it but an optional "/" (a reader reads it as `https://host`; one with a port
--          or a path reads as no address there, so it is none here),
--      where the host is two or more labels of letters, digits and inner hyphens, each 1 to 63 characters, the last one
--      starting with a letter, with no trailing dot. Not http://, not user:password@, not an IP address, not localhost.
--      The one thing a pattern cannot check is punycode: an `xn--` label is taken as written. One that does not decode
--      is no link to a reader, so such a row with no contact would be listed with nowhere to go. A node pushes the host
--      its owners typed, so only a mistyped `xn--` name gets here, and like any mistyped host name (which no pattern can
--      tell either) it leads nowhere; refusing every `xn--` label would hide the communities on internationalised
--      domains (.рф among them) instead.
--   3. Named: `shown_name` is the trimmed community_name, unless it is blank or the default "BeanPool Community" (in any
--      case), when it is the host of node_url, so two unnamed rows are never one name. A default-named row with no address
--      (a contact only) keeps its own name.
-- And `last_seen_at` = updated_at, which the readers use for "Not answering lately" (more than 36 h).
--
-- The fourth guarantee (Real: never our test servers) is the function's (DIRECTORY_DENY_HOSTS), not this view's.
--
-- security_invoker: the view reads public.directory_nodes as the caller (anon, authenticated), through the table's own
-- RLS and its public read policy, never as the view's owner. A plain view would read as its owner and step around RLS
-- (Supabase's advisor flags that). Needs Postgres 15 or later (the read-check in the PR asks first).
--
-- Idempotent: create or replace, and grants and revokes that can be run again.
--
-- To undo: drop view if exists public.directory_listed;

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
    d.updated_at as last_seen_at
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
    'The directory rows a stranger is shown (front doors S13): pushed within 7 days, with an https address or a contact; shown_name is the community''s own name or the host of its address; last_seen_at is its last push. Reads directory_nodes as the caller (security_invoker).';

-- Read-only to everyone who reads the table. Supabase grants every new relation in public to anon and authenticated by
-- default (insert, update and delete included); a view is no place to write, so those are taken back.
revoke all on public.directory_listed from public;
revoke insert, update, delete, truncate, references, trigger on public.directory_listed from anon, authenticated;
grant select on public.directory_listed to anon, authenticated;
