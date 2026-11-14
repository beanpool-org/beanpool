// The directory's listings_from_here migration (list-on-global G5; supabase/migrations/2026111500_directory_listings_from_here.sql).
// No Postgres runs here and no agent may reach the live project, so this reads the SQL and holds it to what the readers and
// the function depend on: one nullable boolean column on directory_nodes, added only if missing; the view the readers read
// (directory_listed) is the S13 view (2026102800_directory_listed.sql) exactly, with that column after its last one, as
// create or replace view allows; security_invoker and the read-only grants stay; and the function writes the column from the
// push alone (index.ts and rules.ts listingsFromHereOf).
//
// Run: node --import tsx --test scripts/directory-listings-from-here-migration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'supabase/migrations/2026111500_directory_listings_from_here.sql');
const S13_FILE = path.join(ROOT, 'supabase/migrations/2026102800_directory_listed.sql');
const FUNCTION_FILE = path.join(ROOT, 'supabase/functions/directory-register/index.ts');

/** The SQL without its comments, whitespace folded, lower case: what Postgres runs. */
function statements(file) {
    const sql = fs.readFileSync(file, 'utf-8');
    return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The view's own statement, from `create or replace view` to its `;`, comments and whitespace folded. */
function viewOf(file) {
    const all = statements(file);
    const start = all.indexOf('create or replace view public.directory_listed');
    assert.ok(start >= 0, `${path.basename(file)} defines the view`);
    return all.slice(start, all.indexOf(';', start) + 1);
}

test('one nullable boolean column, added only if missing, and nothing else done to the table', () => {
    const sql = statements(FILE);
    assert.match(sql, /alter table public\.directory_nodes add column if not exists listings_from_here boolean;/);
    assert.ok(!/listings_from_here boolean (not null|default)/.test(sql), 'no NOT NULL and no default: NULL on every row there, read as on');
    assert.equal((sql.match(/alter table/g) ?? []).length, 1, 'one ALTER');
    for (const word of ['delete from', 'update public', 'insert into', 'drop table', 'drop column', 'truncate public', 'truncate table']) assert.ok(!sql.includes(word), `no ${word}`);
});

test('the view is the S13 view exactly, with listings_from_here after its last column', () => {
    const s13 = viewOf(S13_FILE);
    const g5 = viewOf(FILE);
    assert.equal(g5.replace('d.updated_at as last_seen_at, d.listings_from_here from', 'd.updated_at as last_seen_at from'), s13,
        'nothing else in the view changed: every row S13 shows, and every column, is the same');
    assert.match(g5, /d\.updated_at as last_seen_at, d\.listings_from_here from public\.directory_nodes d /);
    assert.match(g5, /^create or replace view public\.directory_listed with \( ?security_invoker = true ?\) as select /);
});

test('anon and authenticated may still read it, and nobody may write through it', () => {
    const sql = statements(FILE);
    assert.match(sql, /revoke all on public\.directory_listed from public;/);
    assert.match(sql, /revoke insert, update, delete, truncate, references, trigger on public\.directory_listed from anon, authenticated;/);
    assert.match(sql, /grant select on public\.directory_listed to anon, authenticated;/);
});

test('the function writes the column from the signed push alone, beside the fields it stores today', () => {
    const fn = fs.readFileSync(FUNCTION_FILE, 'utf-8');
    assert.match(fn, /listings_from_here: listingsFromHereOf\(payload\),/);
    assert.match(fn, /import \{[^}]*listingsFromHereOf[^}]*\} from '\.\/rules\.ts';/);
    assert.equal((fn.match(/\blistings_from_here\s*:/g) ?? []).length, 1, 'set once, in the upsert');
});
