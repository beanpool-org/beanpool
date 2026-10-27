-- The directory forgets a community that stopped pushing a month ago (front doors S13, DESIGN-doors-follow-through-fable.md
-- §2.2): one daily pg_cron job deletes the rows of public.directory_nodes whose last signed push (updated_at) is more than
-- 30 days old. The view (2026102800_directory_listed.sql) already stops showing a row after 7 days; this keeps the table
-- small. A community that was only off comes back with its next push, as a new row.
--
-- NOT APPLIED BY ANY AGENT. The director applies it by hand to the directory's Supabase project (dpemwoermzkaxoctafzg)
-- through the Management API after the PR merges and after function v6 is deployed, then checks the job is listed:
--   select jobname, schedule, command, active from cron.job where jobname = 'directory-purge-30d';
-- pg_cron 1.6.4 is available on the project but not installed (measured 27 Oct 2026); this installs it.
--
-- What it changes for existing data: from the first run (03:17 UTC each day), every row not pushed for more than 30 days
-- is deleted; nothing else is touched. The director's read-check counts them before applying:
--   select count(*) from public.directory_nodes where updated_at < now() - interval '30 days';
--
-- Idempotent: the extension only if missing, and cron.schedule with a job name replaces a job of the same name (pg_cron
-- 1.3 and later), so a second run leaves one job.
--
-- To undo: select cron.unschedule('directory-purge-30d');

create extension if not exists pg_cron;

select cron.schedule(
    'directory-purge-30d',
    '17 3 * * *',
    $$delete from public.directory_nodes where updated_at < now() - interval '30 days'$$
);
