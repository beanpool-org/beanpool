/**
 * Groups' own pictures out of their rows (#1486): the boot's move on a node from before, and a standby's copy.
 *
 * A group's picture sat inline in groups.avatar_url and went out with every read of the group. A fresh install keeps it in
 * group_pictures, its reference and size in the row. A node from before moves them at boot (db.ts
 * moveGroupPicturesOutOfRows), as #1475 moved members' photos: in batches (by bytes here: a group's picture may be up to
 * 2 MB), each its own transaction, before it listens; killed part way, the next boot carries on; a move that stops part
 * way never puts back a picture set or removed since; no row is stamped. Then, unlike members' move, the table is written
 * again in fresh pages (repackGroups), so no group that had a picture keeps a page of its own.
 *
 *   1. Killed part way (SIGKILL, watched through the database): the batches done are done, nothing is half moved.
 *   2. The next boot finishes: every picture exactly as it was, its version and size in the row, no picture no picture;
 *      no row stamped, rowids kept; the column gone, the table a fresh install's, its triggers and indexes back, its
 *      members and its posts untouched; and `groups` as dense as a vacuumed copy of it.
 *   3. Booting again does nothing.
 *   4. A standby moves its own the same way.
 *   5. A move that STOPS part way (a batch throws), and a running node on which X sets a new picture and Y removes theirs:
 *      the next boot finishes, and puts neither old picture back.
 *   6. A standby's copy carries the pictures (a real main server and standby, standby-pair-test-harness.ts): its first
 *      copy, in pages, holds every group's picture as the main server does, every copied table hashed equal; a delta
 *      brings a changed picture, a removed one and a new group's, the main server's stamps kept.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-group-pictures-out-of-rows.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPagedCopyChild } from './paged-copies-test-harness.js';
import {
    type Id, assert, require_, step, api, built, newPair, startMain, startStandby, pairHelpers, closePair, first,
} from './standby-pair-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const HERE = path.dirname(SCRIPT);
const DB_TS = path.join(HERE, 'db', 'db.ts');
const STATE_ENGINE_TS = path.join(HERE, 'state-engine.ts');

/** A JPEG the photo rules take (its structure walks), about `size` bytes, as a data URL. */
function jpegUrl(size: number, seed = 1): string {
    const head = Buffer.from([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
        0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(0x08),
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x00, 0x02, 0x00, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ...Array(12).fill(0x01),
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    ]);
    const body = Buffer.alloc(Math.max(0, size - head.length - 2));
    for (let i = 0; i < body.length; i++) body[i] = ((i * 7 + seed) % 254) + 1;
    return `data:image/jpeg;base64,${Buffer.concat([head, body, Buffer.from([0xff, 0xd9])]).toString('base64')}`;
}

const columns = (d: Database.Database, table: string): string[] =>
    (d.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name).sort();
const indexes = (d: Database.Database, table: string): string[] =>
    (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'`).all(table) as { name: string }[]).map((r) => r.name).sort();
const triggers = (d: Database.Database, table: string): string[] =>
    (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`).all(table) as { name: string }[]).map((r) => r.name).sort();

/**
 * The real boot's schema step (or `source`, a boot script that prints BOOT_OK) against `dir`, in a node process of its own
 * (the db module is a singleton), run with this process's own node flags (tsx's loader), so it is node itself.
 */
function bootInto(dir: string, env: Record<string, string> = {}, source?: string): { ok: boolean; output: string } {
    const script = path.join(dir, `boot-${crypto.randomUUID()}.mjs`);
    fs.writeFileSync(script, source ?? `
        console.error = (...a) => console.log(...a);
        const { initSchema } = await import(${JSON.stringify(DB_TS)});
        initSchema();
        console.log('BOOT_OK');
    `);
    const r = spawnSync(process.execPath, [...process.execArgv, script], {
        cwd: path.dirname(HERE), env: { ...process.env, BEANPOOL_DATA_DIR: dir, ...env }, encoding: 'utf-8', timeout: 120_000,
    });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return { ok: r.status === 0 && output.includes('BOOT_OK'), output };
}

/** groups as origin/main made it, before #1486: the picture in the row. */
const OLD_GROUPS = `
    CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        avatar_url TEXT,
        category TEXT DEFAULT 'social' CHECK (category IN ('working_group', 'social', 'guild', 'project', 'general')),
        created_by TEXT NOT NULL REFERENCES members(public_key),
        lead_pubkey TEXT REFERENCES members(public_key),
        join_policy TEXT NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open', 'request_to_join', 'invite_only')),
        created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX idx_groups_updated_at ON groups(updated_at);
    CREATE INDEX idx_groups_slug ON groups(slug);
    CREATE INDEX idx_groups_created_by ON groups(created_by);
    CREATE TRIGGER groups_touch_updated_at AFTER UPDATE ON groups FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
    BEGIN UPDATE groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid; END;
    CREATE TRIGGER posts_cleanup_on_group_delete AFTER DELETE ON groups FOR EACH ROW
    BEGIN UPDATE posts SET target_group_id = NULL, active = 0, status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE target_group_id = OLD.id; END;
`;

/** The URL's version as @beanpool/core avatarRefOf makes it, worked out here on its own: sha256 of the trimmed value. */
const versionOf = (v: string) => crypto.createHash('sha256').update(v.trim(), 'utf8').digest('hex').slice(0, 8);
// Every kind of value a live node's groups.avatar_url can hold, and what the move makes of it.
const KINDS: [string, string | null, 'moved' | 'none'][] = [
    ['a picture as a data URL', jpegUrl(27_000, 1), 'moved'],
    ['a picture with spaces around it', `  ${jpegUrl(9_000, 2)}\n`, 'moved'],
    ['a legacy bare-base64 picture', jpegUrl(5_000, 3).slice('data:image/jpeg;base64,'.length), 'moved'],
    ['a shipped picture', 'bundled://leaf', 'moved'],
    ['a link', 'https://example.org/group.jpg', 'moved'],
    ['a member\'s avatar address, sent back', '/api/avatar/abc?size=thumb', 'none'],
    ['an absolute avatar address', 'https://mullum.example/api/avatar/abc?size=thumb&v=0123abcd', 'none'],
    ['an empty string', '', 'none'],
    ['blanks', '   ', 'none'],
    ['no picture', null, 'none'],
];
const FILLER = 600; // groups with a 30 KB picture, enough for a kill to land inside the move
// Every planted row's stamp: four months before the run (only this process plants and reads it).
const STAMP = new Date(Date.now() - 120 * 24 * 3600_000).toISOString();
const CREATOR = 'c'.repeat(64);
type Planted = { id: string; label: string; value: string | null; kind: 'moved' | 'none'; rowid: number };

/** A fresh node made into one from before the move: groups as origin/main made it, each picture in its row. */
function plantLegacy(dir: string): Planted[] {
    require_(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
    const d = new Database(path.join(dir, 'state.db'));
    d.exec(`DROP TABLE IF EXISTS group_pictures; DROP TABLE groups; ${OLD_GROUPS}`);
    d.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, 'Creator', ?, 'INV-CREATOR', 'active')`).run(CREATOR, STAMP);
    const ins = d.prepare(`INSERT INTO groups (id, name, slug, description, avatar_url, category, created_by, lead_pubkey, join_policy, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, 'social', ?, ?, 'open', ?, ?)`);
    const member = d.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at) VALUES (?, ?, 'convenor', 'active', ?, ?)`);
    const rows: Planted[] = [];
    d.transaction(() => {
        for (let i = 0; i < FILLER; i++) {
            // Each kind among the filler, not only at the start: the batches walk by rowid.
            const k = i % 60 === 0 ? KINDS[(i / 60) % KINDS.length] : null;
            const [label, value, kind] = k ?? [`filler ${i}`, jpegUrl(30_000, 100 + i), 'moved' as const];
            const id = crypto.randomUUID();
            const r = ins.run(id, `Group ${i}`, `group-${i}`, `Group ${i}, planted`, value, CREATOR, CREATOR, STAMP, STAMP);
            member.run(id, CREATOR, STAMP, STAMP);
            rows.push({ id, label, value, kind, rowid: Number(r.lastInsertRowid) });
        }
        d.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, target_group_id, audience_scope)
                   VALUES ('group-post', 'offer', 'food', 'For the group', 'A post to group 1', 1, ?, ?, ?, ?, 'group')`).run(CREATOR, STAMP, STAMP, rows[1].id);
    })();
    d.close();
    return rows;
}

type Held = { avatar_ref: string | null; avatar_bytes: number | null; updated_at: string; rowid: number; picture: string | null; inline: string | null };
function heldIn(dir: string): { cols: string[]; rows: Map<string, Held>; pictures: number; members: number; post: any } {
    const d = new Database(path.join(dir, 'state.db'), { readonly: true });
    const cols = columns(d, 'groups');
    const hasTable = !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'group_pictures'`).get();
    const inline = cols.includes('avatar_url') ? 'g.avatar_url' : 'NULL';
    const rows = new Map((d.prepare(`SELECT g.id, g.rowid AS rowid, g.updated_at, g.avatar_ref, g.avatar_bytes, ${inline} AS inline,
                                            ${hasTable ? 'gp.picture' : 'NULL'} AS picture
                                     FROM groups g ${hasTable ? 'LEFT JOIN group_pictures gp ON gp.group_id = g.id' : ''}
                                     WHERE g.created_by = ?`).all(CREATOR) as (Held & { id: string })[]).map((r) => [r.id, r]));
    const pictures = hasTable ? (d.prepare('SELECT COUNT(*) AS n FROM group_pictures gp JOIN groups g ON g.id = gp.group_id WHERE g.created_by = ?').get(CREATOR) as { n: number }).n : 0;
    const members = (d.prepare('SELECT COUNT(*) AS n FROM group_members WHERE member_pubkey = ?').get(CREATOR) as { n: number }).n;
    const post = d.prepare(`SELECT target_group_id, active, status, updated_at FROM posts WHERE id = 'group-post'`).get();
    d.close();
    return { cols, rows, pictures, members, post };
}
const refOf = (value: string) => (value.trim().startsWith('bundled://') ? value : versionOf(value));
/** Whether a planted group's row and picture are what the move makes of it. */
const movedRight = (p: Planted, r: Held) => p.kind === 'none'
    ? r.picture === null && r.avatar_ref === null && r.avatar_bytes === null
    : r.picture === p.value && r.avatar_ref === refOf(p.value!) && r.avatar_bytes === Buffer.byteLength(p.value!);

async function migration(root: string): Promise<void> {
    const freshDir = path.join(root, 'fresh');
    fs.mkdirSync(freshDir, { recursive: true });
    require_(bootInto(freshDir).ok, 'a fresh install boots');
    const f = new Database(path.join(freshDir, 'state.db'), { readonly: true });
    const fresh = { cols: columns(f, 'groups'), idx: indexes(f, 'groups'), trig: triggers(f, 'groups'), pictures: columns(f, 'group_pictures') };
    f.close();
    assert(!fresh.cols.includes('avatar_url') && fresh.cols.includes('avatar_ref') && fresh.cols.includes('avatar_bytes')
        && JSON.stringify(fresh.pictures) === JSON.stringify(['group_id', 'picture']),
        'a fresh install: groups has avatar_ref and avatar_bytes and no avatar_url, and group_pictures holds the picture');

    let planted: Planted[] = [];
    let movedMid: Planted[] = [];
    let inPlacePages = 0;
    const dir = path.join(root, 'legacy');
    fs.mkdirSync(dir, { recursive: true });
    await step('1. a boot killed part way through the move', async () => {
        planted = plantLegacy(dir);
        const script = path.join(dir, 'boot-kill.mjs');
        fs.writeFileSync(script, `
            const { initSchema } = await import(${JSON.stringify(DB_TS)});
            initSchema();
            console.log('BOOT_OK');
        `);
        // The node process itself (this process's node flags, tsx's loader), killed once a few batches are in: watched
        // through the database, which WAL lets another connection read meanwhile.
        const child = spawn(process.execPath, [...process.execArgv, script], {
            cwd: path.dirname(HERE), env: { ...process.env, BEANPOOL_DATA_DIR: dir, GROUP_PICTURE_MOVE_BYTES: '100000' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout!.on('data', (b) => { out += b; });
        child.stderr!.on('data', (b) => { out += b; });
        const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
        let killedAt = -1;
        const watch = new Database(path.join(dir, 'state.db'), { readonly: true, fileMustExist: true });
        for (let i = 0; i < 6000 && killedAt < 0 && child.exitCode === null; i++) {
            try {
                const n = (watch.prepare('SELECT COUNT(*) AS n FROM group_pictures').get() as { n: number }).n;
                if (n >= 40) { child.kill('SIGKILL'); killedAt = n; }
            } catch { /* not made yet */ }
            if (killedAt < 0) await new Promise((r) => setTimeout(r, 2));
        }
        watch.close();
        await exited;
        const mid = heldIn(dir);
        const movable = planted.filter((p) => p.kind === 'moved');
        movedMid = movable.filter((p) => mid.rows.get(p.id)?.picture != null);
        assert(killedAt >= 40 && !out.includes('BOOT_OK') && mid.cols.includes('avatar_url') && movedMid.length > 0 && movedMid.length < movable.length,
            `killed part way (seen ${killedAt} moved): ${movedMid.length} of ${movable.length} pictures out, the column still there`);
        // For comparison below: these rows as a move that empties each row in place and then drops the column (DROP COLUMN
        // alone, as members' move does) leaves them.
        const inPlace = path.join(root, 'in-place.db');
        const src = new Database(path.join(dir, 'state.db'), { readonly: true });
        src.exec(`VACUUM INTO '${inPlace.replace(/'/g, "''")}'`);
        src.close();
        const ip = new Database(inPlace);
        ip.exec('DROP TRIGGER IF EXISTS groups_touch_updated_at; UPDATE groups SET avatar_url = NULL; ALTER TABLE groups DROP COLUMN avatar_url;');
        inPlacePages = (ip.prepare(`SELECT COUNT(*) AS n FROM dbstat WHERE name = 'groups'`).get() as { n: number }).n;
        ip.close();
        fs.rmSync(inPlace, { force: true });
        const half = planted.filter((p) => {
            const r = mid.rows.get(p.id)!;
            const out = r.picture !== null || r.avatar_ref !== null;
            // Out: the row holds no picture, and its reference, size and picture are all there. In: the row still holds it.
            return out ? (r.inline !== null || !movedRight(p, r)) : r.inline !== p.value;
        });
        assert(half.length === 0, `and nothing is half moved: each group still holds its picture or holds it in group_pictures, whole (${half.length} not)`);
    });

    await step('2. the next boot finishes it, and writes the table again in fresh pages', async () => {
        const finish = bootInto(dir, { GROUP_PICTURE_MOVE_BYTES: '100000' });
        const done = heldIn(dir);
        const movable = planted.filter((p) => p.kind === 'moved').length;
        const line = /Groups' pictures are in group_pictures now: (\d+) moved, (\d+) that were no picture left out/.exec(finish.output);
        assert(finish.ok && !!line && Number(line[1]) === movable - movedMid.length && Number(line[2]) === planted.filter((p) => p.kind === 'none' && p.value !== null).length,
            `the next boot moves the rest (${line?.[1]} of ${movable - movedMid.length}) and leaves out what was no picture (${line?.[2]})`);
        assert(JSON.stringify(done.cols) === JSON.stringify(fresh.cols), `then the column is gone: groups has exactly a fresh install's columns (${done.cols.join(' ')})`);
        const wrong = planted.filter((p) => !movedRight(p, done.rows.get(p.id)!));
        assert(wrong.length === 0, `every picture is in group_pictures exactly as it was, its version and size in the row; no picture is none (${wrong.length} wrong: ${wrong.slice(0, 3).map((p) => p.label).join(', ')})`);
        for (const [label, , kind] of KINDS) {
            const p = planted.find((x) => x.label === label)!;
            assert(movedRight(p, done.rows.get(p.id)!), `${label}: ${kind === 'moved' ? 'moved as it was' : 'no picture'}`);
        }
        assert(planted.every((p) => done.rows.get(p.id)!.updated_at === STAMP), 'no group is stamped by the move: it is no change to send a standby');
        assert(planted.every((p) => done.rows.get(p.id)!.rowid === p.rowid), 'every group keeps its rowid');
        assert(done.members === FILLER && done.post?.target_group_id === planted[1].id && done.post?.active === 1 && done.post?.updated_at === STAMP,
            `its members (${done.members}) and a post to a group are untouched: writing the table again deleted nothing`);
        const d = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(indexes(d, 'groups')) === JSON.stringify(fresh.idx) && JSON.stringify(triggers(d, 'groups')) === JSON.stringify(fresh.trig),
            `its indexes and triggers are a fresh install's (${triggers(d, 'groups').join(', ')})`);
        const g0 = planted[0].id;
        d.prepare("UPDATE groups SET name = 'Renamed' WHERE id = ?").run(g0);
        const touched = (d.prepare('SELECT updated_at FROM groups WHERE id = ?').get(g0) as { updated_at: string }).updated_at;
        assert(touched !== STAMP, 'and the touch trigger stamps a change again');
        d.prepare('UPDATE groups SET name = ?, updated_at = ? WHERE id = ?').run('Group 0', STAMP, g0);
        // Dense: as many pages as a vacuumed copy of the same rows needs.
        const pagesOf = (db: Database.Database) => db.prepare(`SELECT COUNT(*) AS pages, COALESCE(SUM(unused), 0) AS unused, COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = 'groups'`).get() as { pages: number; unused: number; bytes: number };
        const here = pagesOf(d);
        const vacuumed = path.join(dir, 'vacuumed.db');
        d.exec(`VACUUM INTO '${vacuumed.replace(/'/g, "''")}'`);
        d.close();
        const v = new Database(vacuumed, { readonly: true });
        const there = pagesOf(v);
        v.close();
        assert(here.pages <= there.pages + 1 && here.unused / here.bytes < 0.25 && inPlacePages > 4 * there.pages,
            `and groups is dense: ${here.pages} pages (${(here.unused / here.bytes * 100).toFixed(0)}% unused), a vacuumed copy ${there.pages}; `
            + `emptied in place and the column dropped, the same rows keep ${inPlacePages}`);
    });

    await step('3. once moved, a boot does nothing more', async () => {
        const before = heldIn(dir);
        const again = bootInto(dir);
        const after = heldIn(dir);
        assert(again.ok && !/Groups' pictures/.test(again.output) && after.pictures === before.pictures
            && planted.every((p) => JSON.stringify(after.rows.get(p.id)) === JSON.stringify(before.rows.get(p.id))),
            'booting again is a no-op');
    });

    await step('4. a standby moves its own the same way', async () => {
        const standbyDir = path.join(root, 'legacy-standby');
        fs.mkdirSync(standbyDir, { recursive: true });
        const standbyPlanted = plantLegacy(standbyDir);
        const boot = bootInto(standbyDir, { NODE_ROLE: 'backup' });
        const s = heldIn(standbyDir);
        assert(boot.ok && !s.cols.includes('avatar_url') && standbyPlanted.every((p) => movedRight(p, s.rows.get(p.id)!) && s.rows.get(p.id)!.updated_at === STAMP),
            'a standby from before the move boots, holding every picture in group_pictures, its rows unstamped, as its main server will');
        fs.rmSync(standbyDir, { recursive: true, force: true });
    });

    await step('5. a move that stops part way, a picture set and one removed meanwhile, then the next boot', async () => {
        const stopDir = path.join(root, 'legacy-stopped');
        fs.mkdirSync(stopDir, { recursive: true });
        const stopPlanted = plantLegacy(stopDir);
        const walked = stopPlanted.filter((p) => p.value !== null && p.kind === 'moved');
        const failing = walked[60];
        const [x, y] = [walked[200], walked[210]];
        {
            // The failure: one group's picture can't be written (a full disk). The move makes group_pictures IF NOT EXISTS,
            // so it is made here first, as the move makes it, to hang the trigger on.
            const d = new Database(path.join(stopDir, 'state.db'));
            d.exec(`CREATE TABLE IF NOT EXISTS group_pictures (group_id TEXT PRIMARY KEY, picture TEXT NOT NULL);
                    CREATE TRIGGER injected_failure BEFORE INSERT ON group_pictures WHEN NEW.group_id = '${failing.id}'
                    BEGIN SELECT RAISE(ABORT, 'injected: database or disk is full'); END;`);
            d.close();
        }
        const NEW_PICTURE = jpegUrl(12_000, 77);
        // Boot 1, and the node runs on: the disk is freed (the trigger goes), and X's convenor sets a new picture and Y's
        // removes theirs, by the group route's own writer (state-engine updateGroup).
        const boot1 = bootInto(stopDir, { GROUP_PICTURE_MOVE_BYTES: '100000' }, `
            console.error = (...a) => console.log(...a);
            const se = await import(${JSON.stringify(STATE_ENGINE_TS)});
            const { db } = await import(${JSON.stringify(DB_TS)});
            se.initStateEngine();
            console.log('COMMITTED=' + db.prepare('SELECT COUNT(*) AS n FROM group_pictures gp JOIN groups g ON g.id = gp.group_id WHERE g.created_by = ?').get(${JSON.stringify(CREATOR)}).n);
            db.exec('DROP TRIGGER injected_failure');
            se.updateGroup(${JSON.stringify(x.id)}, ${JSON.stringify(CREATOR)}, { avatarUrl: ${JSON.stringify(NEW_PICTURE)} });
            se.updateGroup(${JSON.stringify(y.id)}, ${JSON.stringify(CREATOR)}, { avatarUrl: '' });
            console.log('BOOT_OK');
            process.exit(0);
        `);
        const stopped = /the move out of their rows stopped after (\d+)/.exec(boot1.output);
        const committed = /COMMITTED=(\d+)/.exec(boot1.output);
        assert(boot1.ok && !!stopped && boot1.output.includes('injected: database or disk is full'),
            `a batch that throws stops the move, loudly, and the node runs on (${stopped ? stopped[0] : boot1.output.split('\n').slice(-4).join(' | ')})`);
        assert(!!stopped && !!committed && Number(stopped[1]) === Number(committed[1]) && Number(committed[1]) > 0 && Number(committed[1]) <= 60,
            `the count it logs is what was committed (logged ${stopped?.[1]}, group_pictures holds ${committed?.[1]})`);
        const between = heldIn(stopDir);
        const xNow = between.rows.get(x.id)!, yNow = between.rows.get(y.id)!;
        assert(between.cols.includes('avatar_url') && xNow.picture !== null && xNow.picture !== x.value && xNow.avatar_ref !== null && xNow.inline === null
            && yNow.picture === null && yNow.avatar_ref === null && yNow.inline === null,
            'on the running node X holds the new picture and Y none, each one\'s old picture cleared from the row, the column still there');

        const boot2 = bootInto(stopDir, { GROUP_PICTURE_MOVE_BYTES: '100000' });
        const end = heldIn(stopDir);
        assert(boot2.ok && /Groups' pictures are in group_pictures now/.test(boot2.output) && !end.cols.includes('avatar_url'), 'the next boot finishes the move and drops the column');
        const xEnd = end.rows.get(x.id)!, yEnd = end.rows.get(y.id)!;
        assert(xEnd.picture === xNow.picture && xEnd.avatar_ref === xNow.avatar_ref && xEnd.avatar_bytes === xNow.avatar_bytes,
            `X keeps the picture set after the move stopped, not the one from before it (ref ${xEnd.avatar_ref}, set ${xNow.avatar_ref}, old ${versionOf(x.value!)})`);
        assert(yEnd.picture === null && yEnd.avatar_ref === null && yEnd.avatar_bytes === null, `Y's removal holds: no picture comes back (ref ${yEnd.avatar_ref})`);
        const others = stopPlanted.filter((p) => p.id !== x.id && p.id !== y.id && !(movedRight(p, end.rows.get(p.id)!) && end.rows.get(p.id)!.updated_at === STAMP));
        assert(others.length === 0, `every other group's picture moved whole, the one that failed included, rows unstamped (${others.length} wrong)`);
        fs.rmSync(stopDir, { recursive: true, force: true });
    });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(freshDir, { recursive: true, force: true });
}

async function standbyCopy(): Promise<void> {
    const pair = newPair(SCRIPT);
    const { ann, bo, cy, dee } = pair;
    try {
        const { main, m } = await startMain(pair);
        const As = (who: Id, route: string, body: unknown = {}) => api(m, 'POST', route, { as: who, body });
        const Patch = async (who: Id, route: string, body: unknown) => {
            // The harness signs GET and POST; a PATCH is signed the same way.
            const raw = JSON.stringify(body);
            const ts = Date.now();
            const nonce = crypto.randomBytes(16).toString('hex');
            const res = await fetch(`${m}${route}`, {
                method: 'PATCH', body: raw, headers: {
                    'Content-Type': 'application/json', 'X-Public-Key': who.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
                    'X-Signature': crypto.sign(null, Buffer.from(`PATCH\n${route}\n${ts}\n${nonce}\n${raw}`), who.priv).toString('base64'),
                },
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        };
        const groupsOf = async (node: typeof main) => node.send('rows', {
            sql: `SELECT g.id, g.avatar_ref, g.avatar_bytes, g.updated_at, gp.picture FROM groups g LEFT JOIN group_pictures gp ON gp.group_id = g.id ORDER BY g.id`,
        }) as Promise<{ id: string; avatar_ref: string | null; avatar_bytes: number | null; updated_at: string; picture: string | null }[]>;
        const same = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);

        const garden = built('Ann starts a group with a picture', await As(ann, '/api/groups', { name: 'Gardeners', avatarUrl: jpegUrl(30_000, 31) }));
        const quiet = built('Ann starts an invite-only one with a picture', await As(ann, '/api/groups', { name: 'Quiet circle', joinPolicy: 'invite_only', avatarUrl: jpegUrl(40_000, 32) }));
        built('Bo starts one with a shipped picture', await As(bo, '/api/groups', { name: 'Leafy', avatarUrl: 'bundled://leaf' }));
        built('Cy starts one with none', await As(cy, '/api/groups', { name: 'Plain' }));
        const standby = await startStandby(pair, 'standby', main);
        const { exactNow, pullAndSwap } = pairHelpers(() => ({ main, standby }));

        await step('6a. a standby\'s first copy carries every group\'s picture', async () => {
            const p = await pullAndSwap(false);
            const [s, mm] = [await groupsOf(standby), await groupsOf(main)];
            const pictured = mm.filter((g) => g.picture !== null);
            assert(p.ok && pictured.length === 3 && same(s, mm),
                `S's copy holds each group's picture, reference, size and stamp as M does (${pictured.length} pictures; ${s.length} groups on S, ${mm.length} on M)`);
            const diff = await exactNow();
            assert(diff.length === 0, `every copied table hashes the same on S as on M, group_pictures and groups included (differences ${first(diff)})`);
        });

        await step('6b. a delta brings a changed picture, a removed one and a new group\'s', async () => {
            const changed = await Patch(ann, `/api/groups/${garden.id}`, { avatarUrl: jpegUrl(25_000, 41) });
            const removed = await Patch(ann, `/api/groups/${quiet.id}`, { avatarUrl: '' });
            require_(changed.status === 200 && removed.status === 200, `M: Ann changes one picture and removes another (${changed.status}, ${removed.status})`);
            built('Dee starts a group with a picture', await As(dee, '/api/groups', { name: 'Late', avatarUrl: jpegUrl(20_000, 42) }));
            const p = await pullAndSwap(false);
            const [s, mm] = [await groupsOf(standby), await groupsOf(main)];
            assert(p.ok && p.mode !== 'resync' && same(s, mm) && mm.find((g) => g.id === quiet.id)?.picture === null && mm.filter((g) => g.picture !== null).length === 3,
                `S's delta (${p.mode}) brings the change, the removal and the new group's picture, each with M's stamp (S ${s.length} groups, M ${mm.length})`);
            const diff = await exactNow();
            assert(diff.length === 0, `and every copied table still hashes the same (differences ${first(diff)})`);
        });
    } finally {
        await closePair(pair);
    }
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const started = Date.now();
    console.log('\n— groups\' pictures: kept out of the row on a fresh install, moved at boot on a node from before —');
    await migration(root);
    console.log(`  (the move: ${((Date.now() - started) / 1000).toFixed(0)} s)`);
    console.log('\n— a standby\'s copy carries the pictures —');
    await standbyCopy();
}

if (process.argv.includes('--child')) {
    runPagedCopyChild().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
