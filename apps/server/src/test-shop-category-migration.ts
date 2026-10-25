/**
 * A shop picks a Market category (Marty, 25 Oct 2026), so a node made before keeps its shops in the category nearest
 * the kind each had: schema.sql's CREATE TABLE IF NOT EXISTS never changes an existing table, so db.ts renames the column
 * and moves the rows once (moveShopKindsToCategories), by core's one table (SHOP_CATEGORY_KINDS).
 *
 * On a COPY of a real-shaped state.db (a node booted by the real initSchema, its shops table put back as the kinds had
 * it, and a shop of every kind, of a kind no app sends and of none):
 *   1. booted: the column is `category`, where `kind` was, as a fresh install has it; each shop is in its kind's category,
 *      one of a kind no app sends and one of none in no category; a moved row is stamped, so a delta carries it to the
 *      standbys; one whose kind is already a category's id keeps its stamp; the table still refuses a value that is no id
 *   2. booted again: nothing changes, stamp for stamp
 *   3. a standby's copy: moved the same way (its own boot), so it reads as its main server's will
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-shop-category-migration.ts
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { assert, bootInto, runSchemaSuite, tmp } from './schema-upgrade-test-harness.js';

const STAMP = '2026-10-20T00:00:00.000Z';
const owner = (i: number) => i.toString(16).padStart(2, '0').repeat(32);

/** Each stored kind, and the category its shop is in after the boot (null: none). */
const MOVES: Array<[string | null, string | null]> = [
    ['tools', 'tools'], ['food', 'food'], ['baking', 'food'], ['repairs', 'services'], ['crafts', 'arts'], ['lessons', 'education'],
    ['care', 'care'], ['rides', 'transport'], ['rooms', 'housing'], ['buying', 'goods'], ['seeds', 'garden'], ['energy', 'energy'],
    ['animals', 'animals'], ['labour', 'labour'],
    ['weapons', null],
    [null, null],
];

const shopColumns = (db: Database.Database): string[] =>
    (db.prepare(`SELECT name FROM pragma_table_info('shops')`).all() as Array<{ name: string }>).map((c) => c.name);

type Row = { id: string; category: string | null; updated_at: string };
const rowsOf = (db: Database.Database): Row[] =>
    db.prepare('SELECT id, category, updated_at FROM shops ORDER BY id').all() as Row[];

function openCopy(from: string, name: string): string {
    const dir = tmp(name);
    fs.copyFileSync(path.join(from, 'state.db'), path.join(dir, 'state.db'));
    return dir;
}

runSchemaSuite('shops move from kinds to categories', '⭐️ Every shop is in the category nearest its kind, once, on the main server and its standbys.', async () => {
    // A node as a boot makes it, its shops table then put back as the kinds had it (the column `kind`, with its CHECK).
    const fresh = tmp('shop-category-fresh');
    const booted = bootInto(fresh);
    assert(booted.ok, `0. setup: a fresh node boots${booted.ok ? '' : `: ${booted.output.slice(-600)}`}`);
    const made = new Database(path.join(fresh, 'state.db'));
    const freshColumns = shopColumns(made);
    if (freshColumns.includes('category')) made.exec('ALTER TABLE shops RENAME COLUMN category TO kind');
    // As on every node (db.ts): foreign keys are off, so the shops need no members rows here.
    made.pragma('foreign_keys = OFF');
    const put = made.prepare('INSERT INTO shops (id, owner_pubkey, kind, opened_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    MOVES.forEach(([kind], i) => put.run(`shop-${String(i).padStart(2, '0')}`, owner(i + 1), kind, STAMP, STAMP));
    const oldColumns = shopColumns(made);
    assert(oldColumns.includes('kind') && !oldColumns.includes('category') && (made.prepare('SELECT COUNT(*) AS n FROM shops').get() as { n: number }).n === MOVES.length,
        `0. setup: the shops table as the kinds had it, with a shop of every kind, of one no app sends and of none (${oldColumns.join(' ')})`);
    made.close();

    // 1. A copy of it, booted.
    const main = openCopy(fresh, 'shop-category-main');
    const first = bootInto(main);
    assert(first.ok, `1. the copy boots${first.ok ? '' : `: ${first.output.slice(-600)}`}`);
    const db = new Database(path.join(main, 'state.db'));
    const columns = shopColumns(db);
    const want = freshColumns.includes('category') ? freshColumns : freshColumns.map((c) => (c === 'kind' ? 'category' : c));
    assert(JSON.stringify(columns) === JSON.stringify(want),
        `1. the column is category, where kind was, as a fresh install has it (${columns.join(' ')})`);
    const rows = columns.includes('category') ? rowsOf(db) : [];
    const moved = MOVES.map(([kind, category], i) => ({ kind, category, row: rows.find((r) => r.id === `shop-${String(i).padStart(2, '0')}`) }));
    assert(rows.length === MOVES.length && moved.every((m) => m.row && m.row.category === m.category),
        `1. each shop is in its kind's category; a kind no app sends and none are no category (${moved.map((m) => `${m.kind}→${m.row?.category}`).join(', ')})`);
    assert(rows.length === MOVES.length && moved.every((m) => !!m.row && (m.kind === m.category ? m.row.updated_at === STAMP : m.row.updated_at > STAMP)),
        `1. a moved shop is stamped, so a delta carries it; one already in a category's id keeps its stamp (${moved.map((m) => `${m.kind}:${m.row?.updated_at === STAMP ? 'kept' : 'stamped'}`).join(', ')})`);
    let refused = false;
    try { db.prepare("UPDATE shops SET category = 'Tech' WHERE id = 'shop-00'").run(); } catch (e) { refused = /CHECK constraint failed/.test(String(e)); }
    assert(refused, '1. the table still refuses a value that is no id (a capital)');
    db.close();

    // 2. Booted again.
    const before = JSON.stringify(rows);
    const second = bootInto(main);
    const again = new Database(path.join(main, 'state.db'), { readonly: true });
    const after = shopColumns(again).includes('category') ? JSON.stringify(rowsOf(again)) : '';
    again.close();
    assert(second.ok && rows.length > 0 && after === before, '2. booted again, nothing changes, stamp for stamp');

    // 3. A standby's copy.
    const standby = openCopy(fresh, 'shop-category-standby');
    const third = bootInto(standby, { NODE_ROLE: 'backup' });
    const copy = new Database(path.join(standby, 'state.db'), { readonly: true });
    const standbyRows = shopColumns(copy).includes('category') ? rowsOf(copy) : [];
    copy.close();
    assert(third.ok && standbyRows.length === MOVES.length && MOVES.every(([, category], i) => standbyRows[i].category === category),
        `3. a standby's copy moves the same way at its own boot (${standbyRows.map((r) => r.category).join(', ')})`);

    for (const dir of [fresh, main, standby]) fs.rmSync(dir, { recursive: true, force: true });
});
