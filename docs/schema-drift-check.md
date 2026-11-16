# Schema drift check: run it before a deploy

`scripts/deploy/schema-drift.mjs` is a read-only check you run on each node before deploying a new build to it. It
lists every table the node's database already holds in a shape the new build's `schema.sql` would not give it.

## Why

`schema.sql` makes each table with `CREATE TABLE IF NOT EXISTS`. That statement never touches a table that is already
there. So when a change edits a table's definition in place (day zero: no migration), a fresh install gets the new shape
and a kept node keeps the old one. On 16 Nov 2026 this happened twice in one day: `group_guest_outbox` and
`group_guest_mail` gained a kind in their CHECK (#3233), as did `relay_mail` and `relay_outbox` (#3244). Live nodes
already had those tables under the old CHECK, so the new build's writes would have been refused there.

## What it does, and what it never does

- It opens `state.db` read-only, with `query_only` on as well. It never writes, drops or copies anything, and no
  statement it runs can change the file. You act on what it prints.
- It loads the new build's `schema.sql` into an empty in-memory database. Then it compares each table that is in both
  databases: the column set, each column's type, NOT NULL, default, collation and generated form, the primary key, every
  CHECK (a column's own or the table's), every UNIQUE, the foreign keys, WITHOUT ROWID and STRICT, and the full
  definition of a virtual table. Spacing, comments, upper or lower case, quoting and column order don't count as
  differences.
- It counts a column as present when db.ts's `initSchema` adds it at boot before the `schema.sql` exec (its
  `ALTER TABLE … ADD COLUMN` steps). The line names those columns.
- It reads each table's kind from `apps/server/src/engine/replication-manifest.ts`.

It does not compare indexes or triggers. `CREATE INDEX IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS` also keep an
old definition with the same name, so check those by hand when a change edits one in place. It also skips tables that
`schema.sql` doesn't make.

## How to run it

Check out the build you are about to deploy, then run the check inside the node's running container. The container
has node and better-sqlite3, but its files belong to the build that is running now. So `--pack` builds the new build's
`schema.sql`, manifest and boot steps into one program, which you pipe into `node -`:

```bash
git -C <your checkout> checkout --detach <commit about to deploy>
cd <your checkout>
node scripts/deploy/schema-drift.mjs --pack \
  | ssh <host> 'C=$(sudo docker ps -q --filter label=com.docker.compose.project=<project> --filter label=com.docker.compose.service=beanpool-node);
      sudo docker exec -i -w /app/apps/server "$C" node --input-type=module - --db /data/state.db'
```

Run it while the node is running, before the deploy. The running server already holds the database's `-wal` and `-shm`
files, so the read-only open reads its latest writes and creates nothing.

To check a copy of a database on your own machine:

```bash
node scripts/deploy/schema-drift.mjs --db ./state.db
```

`--schema`, `--manifest` and `--boot-steps` point it at other files. By default it reads this checkout's
`apps/server/src/db/schema.sql`, `apps/server/src/engine/replication-manifest.ts` and `apps/server/src/db/db.ts`.

## Reading the output

It prints one line per table that is in both the database and `schema.sql`:

| Line | Meaning | What to do |
| --- | --- | --- |
| `OK <table> <kind>` | Same shape | Nothing |
| `DRIFT-EMPTY-LOCAL <table> rows=0 local: …` | The table is never copied to a standby (`local` in the manifest), and it's empty | It is a candidate to drop so the new build makes it again (below) |
| `DRIFT-HAS-ROWS <table> rows=<n> local: …` | A local table with rows | Stop and ask. Dropping it would lose them |
| `DRIFT-REPLICATED <table> rows=<n> <kind>: …` | The table is copied to standbys or carried by a take-over, whatever its rows. A table the manifest doesn't name reads this way too | Stop and ask |

After the colon, it says what differs, for example
`CHECK only here: kind in ('invite', 'line'); CHECK only in schema.sql: kind in ('invite', 'line', 'edit')`. "Here"
means the node's database.

The first line names the database and the first 12 characters of the `schema.sql` sha256 it compared against. The last
line counts the tables it compared, how many drift, how many the deploy will create, and how many it skipped because
`schema.sql` doesn't make them.

Exit codes: `0` when every table it compared is OK, `1` on any drift, `2` when it couldn't run (a bad argument, a
database it couldn't open read-only, or a build it couldn't read).

## Dropping an empty local table

The check never does this step. A person does it, deliberately, for each `DRIFT-EMPTY-LOCAL` line, on a node whose
owner has agreed:

1. Run the check again just before the deploy. The table must still show `rows=0`.
2. As part of the step that starts the new image, drop the table. The new build makes it again at boot from
   `schema.sql`, along with its indexes and triggers.
3. Once the new build is running, run the check again from the same checkout. Every line must read `OK`.

Never drop a table on a `DRIFT-HAS-ROWS` or `DRIFT-REPLICATED` line: that needs its own decision.
