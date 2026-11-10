/**
 * The index behind "does this member hold a copy from another node?" (routes/home-listings.ts readsListingsAsAnyone, asked
 * by every member's Home read; follow-up to #2959's deciding review). The question was `... FROM posts WHERE origin_node IS
 * NOT NULL`, which no index could answer: a scan of the whole posts table (about 25 ms at 100,000 posts) after every posts
 * version. idx_posts_copy_authors (a plain partial index, no function in it, so an older release still opens the file)
 * makes it one seek.
 *
 *  1. A state.db made by v1.2.18 (__fixtures__/schema-v1.2.18.sql, with posts in it), booted by initSchema: the index is
 *     made, partial on origin_node, every post kept; booted again, nothing changes.
 *  2. The question's plan uses the index, and no EXISTS in it scans the posts table.
 *  3. The answers did not change: a member with a copy of their own posts held from elsewhere, with a post here, with a post
 *     for them or assigned to them, or in no way: false for the first four, true for the last, and the same as an
 *     independent reading of the posts table.
 *  4. A new node (an empty data folder, in a child process) has the index after initSchema, and the same plan.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-home-copy-authors-index)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const INDEX = 'idx_posts_copy_authors';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const key = (c: string) => c.repeat(64);
const GENESIS = 'genesis';
const LOCAL = key('a'), COPY = key('b'), BOTH = key('c'), TARGET = key('d'), ASSIGNED = key('e'), NOBODY = key('f'), FILLER = key('1');

/** What the index is, from the file itself, and the plans of the two questions. */
async function inspect(): Promise<Record<string, unknown>> {
    const { db, initSchema } = await import('./db/db.js');
    const { ANYONE_SQL } = await import('./routes/home-listings.js');
    initSchema();
    const row = db.prepare(`SELECT sql, tbl_name AS tbl FROM sqlite_master WHERE type = 'index' AND name = ?`).get(INDEX) as { sql: string; tbl: string } | undefined;
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ me: NOBODY }) as { detail: string }[]).map((r) => r.detail);
    return {
        sql: row?.sql ?? null, table: row?.tbl ?? null,
        setPlan: plan('SELECT DISTINCT author_pubkey FROM posts WHERE origin_node IS NOT NULL').join(' | '),
        anyonePlan: plan(ANYONE_SQL).join(' | '),
        posts: (db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n,
        indexes: (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'`).get() as { n: number }).n,
    };
}

function checkPlan(who: string, i: Record<string, unknown>): void {
    const anyone = String(i.anyonePlan);
    assert(String(i.setPlan).includes(`USING INDEX ${INDEX}`) && !/SCAN posts(?! USING)/.test(String(i.setPlan)) && !String(i.setPlan).includes('TEMP B-TREE'),
        `${who}: the authors-with-copies question is read from ${INDEX}, not a scan of the posts table (${i.setPlan})`);
    assert(anyone.includes(`SEARCH posts USING INDEX ${INDEX} (author_pubkey=?)`),
        `${who}: the member's own question has a seek on ${INDEX} for the copies (${anyone})`);
    assert(!/\bSCAN (posts|p)\b/.test(anyone), `${who}: no part of readsListingsAsAnyone's statement scans the posts table (${anyone})`);
}

async function child(): Promise<void> {
    process.stdout.write(`CHILD_RESULT ${JSON.stringify(await inspect())}\n`);
    process.exit(0);
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');
    fs.mkdirSync(dataDir!, { recursive: true });

    // ── 1. A database of v1.2.18, with posts in it ──
    console.log('\n── 1. A state.db from before the index, booted ──');
    const old = new Database(path.join(dataDir!, 'state.db'));
    old.exec(fs.readFileSync(path.join(HERE, '__fixtures__', 'schema-v1.2.18.sql'), 'utf8'));
    assert(!old.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(INDEX), '1. the old file has no such index');
    const at = new Date().toISOString();
    old.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'Genesis', ?)`).run(GENESIS, at);
    for (const [pk, name] of [[LOCAL, 'Local'], [COPY, 'Copy'], [BOTH, 'Both'], [TARGET, 'Target'], [ASSIGNED, 'Assigned'], [NOBODY, 'Nobody'], [FILLER, 'Filler']]) {
        old.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by) VALUES (?, ?, ?, ?)`).run(pk, name, at, GENESIS);
        // The v1.2.18 file's own column (REAL `balance`): the boot's hundredths step drops old money (db/hundredths-step.ts).
        old.prepare(`INSERT INTO accounts (public_key, balance) VALUES (?, 0)`).run(pk);
    }
    // The old table has only the columns of its day (no target_pubkey, no assigned_to: the boot adds them), so a post for a
    // member and one assigned to a member are set after the first boot.
    const addPost = old.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, origin_node)
                                 VALUES (?, 'offer', 'food', ?, 'bread', ?, ?)`);
    addPost.run('p-local', 'Local loaves', LOCAL, null);
    addPost.run('p-copy', 'Copied loaves', COPY, 'peer-node-1');
    addPost.run('p-both-here', 'Both here', BOTH, null);
    addPost.run('p-both-copy', 'Both copy', BOTH, 'peer-node-2');
    addPost.run('p-for', 'For one', LOCAL, null);
    addPost.run('p-assigned', 'Assigned', LOCAL, null);
    // Enough posts that the planner has a table worth choosing an index for.
    for (let i = 0; i < 300; i++) addPost.run(`p-fill-${i}`, `Filler ${i}`, FILLER, i % 25 === 0 ? 'peer-node-3' : null);
    old.close();

    const first = await inspect();
    assert(first.table === 'posts' && /^CREATE INDEX idx_posts_copy_authors ON posts\(author_pubkey\) WHERE origin_node IS NOT NULL$/.test(String(first.sql)),
        `1. booting the old file makes ${INDEX}: a plain partial index on posts(author_pubkey) where origin_node IS NOT NULL, no function in it (${first.sql})`);
    assert(first.posts === 306, `1. every post is kept (${first.posts})`);
    const { db, initSchema } = await import('./db/db.js');
    db.prepare(`UPDATE posts SET target_pubkey = ? WHERE id = 'p-for'`).run(TARGET);
    db.prepare(`UPDATE posts SET assigned_to = ? WHERE id = 'p-assigned'`).run(ASSIGNED);
    initSchema();
    const again = await inspect();
    assert(again.sql === first.sql && again.indexes === first.indexes && again.posts === first.posts,
        `1. booted again: the same index, the same number of indexes (${first.indexes}), the same posts`);

    // ── 2. The plans ──
    console.log('\n── 2. The plans ──');
    checkPlan('old file', first);

    // ── 3. The answers did not change ──
    console.log('\n── 3. The answers ──');
    const { readsListingsAsAnyone } = await import('./routes/home-listings.js');
    const answers: Record<string, boolean> = {
        local: readsListingsAsAnyone(LOCAL), copy: readsListingsAsAnyone(COPY), both: readsListingsAsAnyone(BOTH),
        target: readsListingsAsAnyone(TARGET), assigned: readsListingsAsAnyone(ASSIGNED), nobody: readsListingsAsAnyone(NOBODY),
        stranger: readsListingsAsAnyone(key('9')),
    };
    assert(answers.copy === false, '3. a member whose only posts are copies held from another node is read for themselves');
    assert(answers.local === false && answers.both === false, '3. a member with a post here (with or without copies) is read for themselves');
    assert(answers.target === false && answers.assigned === false, '3. a member a post is for, or assigned to, is read for themselves');
    assert(answers.nobody === true && answers.stranger === true, '3. a member with nothing, and a key the node has never seen, are read as nobody');
    // An independent reading of the table, the way the cached set of #2959 did it.
    const withCopies = new Set((db.prepare('SELECT DISTINCT author_pubkey AS a FROM posts WHERE origin_node IS NOT NULL').all() as { a: string }[]).map((r) => r.a));
    const own = (m: string) => !!db.prepare(`SELECT 1 FROM posts WHERE author_pubkey = ? AND origin_node IS NULL
                                              UNION ALL SELECT 1 FROM posts WHERE target_pubkey = ? UNION ALL SELECT 1 FROM posts WHERE assigned_to = ?`).get(m, m, m);
    const members = (db.prepare('SELECT public_key AS k FROM members').all() as { k: string }[]).map((r) => r.k);
    const differ = members.filter((m) => readsListingsAsAnyone(m) !== !(own(m) || withCopies.has(m)));
    assert(members.length === 8 && differ.length === 0, `3. every member's answer is the same as the table read the long way (${members.length} members, ${differ.length} differ)`);
    // A copy held later changes the answer at once (the cached set of #2959 waited for a posts version; a seek does not).
    db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, origin_node) VALUES ('p-late', 'offer', 'food', 'Late', 'x', ?, 'peer-node-9')`).run(NOBODY);
    assert(readsListingsAsAnyone(NOBODY) === false, '3. a copy held from another node for a member who had nothing changes their answer on the next read');

    // ── 4. A new node ──
    console.log('\n── 4. A new node (an empty data folder) ──');
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-authors-fresh-'));
    try {
        const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--child'], {
            env: { ...process.env, BEANPOOL_DATA_DIR: fresh }, encoding: 'utf-8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
        });
        const line = (r.stdout || '').split('\n').find((l) => l.startsWith('CHILD_RESULT '));
        if (!line) console.error((r.stdout || '').slice(-3000), (r.stderr || '').slice(-3000));
        assert(!!line, `4. the child on an empty folder printed a result (exit ${r.status})`);
        if (line) {
            const f = JSON.parse(line.slice('CHILD_RESULT '.length)) as Record<string, unknown>;
            assert(typeof f.sql === 'string' && f.table === 'posts' && String(f.sql) === String(first.sql),
                `4. a new node has ${INDEX}, the same index the old file was given (${f.sql})`);
            checkPlan('new node', f);
        }
    } finally {
        fs.rmSync(fresh, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

(process.argv.includes('--child') ? child() : main()).catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
