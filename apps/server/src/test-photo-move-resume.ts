/**
 * #1482 (b), the deciding review's B1: while a main server's move of members' photos out of their rows (db.ts
 * moveMemberPhotosOutOfRows) is stopped part way, no node answer tells a member's phone "no photo" for a photo the node
 * still holds inline, so the phone never publishes its own older copy over it; and the move resumes while the node runs.
 *
 * The phone publishes its canonical photo when the node says it holds none: the member's own redeem card with no
 * servable avatar (native utils/db.ts redeemInvite nodeHasPhoto, app/_layout.tsx), and the offline-edit retry after a
 * members sync whose list gave its own row no avatar (services/pillar-sync.ts → pushProfileToServer). Both read
 * member_photos only, so during the window both said "none" and the older copy replaced the newer photo for good.
 *
 * A node made into one from before the move, the move stopped by a RAISE(ABORT) trigger on Ann's photo (batches of one,
 * the resumed move's first wait 200 ms), then the real node over real HTTPS through the real middleware:
 *   1. the move stopped at Ann at boot; Ann's own redeem card carries her inline photo, servable by the phone's own test
 *      (@beanpool/core isServableAvatarValue); Cal (no photo) and Dee (this node's own address sent back) carry none;
 *      the members list the phone syncs (whole and delta) gives Ann's and Eve's own rows an avatar meanwhile, and
 *      /api/avatar serves Ann's inline photo at it (the deciding review's B2: a null there let the offline-edit retry
 *      publish an older copy, during a stop that lasts and up to an hour after it);
 *   2. while the cause lasts, the timer retries with a doubling wait (measured gaps), not every turn;
 *   3. once the cause is gone, the timer finishes the move without a restart: the old column dropped, Ann's and Eve's
 *      photos in member_photos as they were (NEW, never an older copy), their rows stamped so a standby's delta carries them;
 *      the members list the phone syncs now gives Ann's own row an avatar, which /api/avatar serves; an ETag a phone
 *      took in the window is not answered 304 (the deciding review's N5);
 *   4. memberPhotoResumeWait: a short gap while rows are left, doubling while it stops, never past an hour;
 *   5. a standby (NODE_ROLE=backup, a child process on its own data directory) never resumes its move.
 *
 *   SERVER_SUITES_ONLY=test-photo-move-resume node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Batches of one, so the batch before Ann's commits and hers is the one that throws.
process.env.MEMBER_PHOTO_MOVE_BATCH = '1';
process.env.MEMBER_PHOTO_RESUME_MS = '200';

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bootInto } from './schema-upgrade-test-harness.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Who { name: string; pk: string; priv: crypto.KeyObject }
function newId(name: string): Who {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { name, pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

const NEW = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const EVE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const STAMP = '2025-06-01T00:00:00.000Z';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A database from before the move, its move made to stop at Ann (who must be `ann`); the attempts on Ann counted. */
function makeStoppedDatabase(dir: string, who: Record<'ann' | 'bea' | 'cal' | 'dee' | 'eve', Who>): void {
    if (!bootInto(dir).ok) throw new Error('a fresh node did not boot');
    const d = new Database(path.join(dir, 'state.db'));
    d.exec(`DROP TRIGGER members_touch_updated_at; DROP TABLE member_photos;
            ALTER TABLE members DROP COLUMN avatar_ref; ALTER TABLE members DROP COLUMN avatar_bytes;
            ALTER TABLE members ADD COLUMN avatar_url TEXT;`);
    const ins = d.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, avatar_url, updated_at)
                           VALUES (?, ?, '${STAMP}', 'active', ?, '${STAMP}')`);
    // In rowid order, the order the move walks: Bea (moved at boot), Ann (where it stops), Dee, Cal, Eve (not reached).
    ins.run(who.bea.pk, who.bea.name, NEW);
    ins.run(who.ann.pk, who.ann.name, NEW);
    ins.run(who.dee.pk, who.dee.name, '/api/avatar/abc?size=thumb');
    ins.run(who.cal.pk, who.cal.name, null);
    ins.run(who.eve.pk, who.eve.name, EVE);
    // photo_move_attempt() is the node's own connection's (registered before the boot): each insert tried for Ann.
    d.exec(`CREATE TABLE IF NOT EXISTS member_photos (public_key TEXT PRIMARY KEY, photo TEXT NOT NULL);
            CREATE TRIGGER injected_failure BEFORE INSERT ON member_photos WHEN NEW.public_key = '${who.ann.pk}'
            BEGIN SELECT photo_move_attempt(); SELECT RAISE(ABORT, 'injected: database or disk is full'); END;`);
    d.close();
}

/** Part 5, in a child process: a standby on a database whose move stopped never resumes it. Prints one JSON line. */
async function standbyPart(): Promise<void> {
    const dir = process.env.BEANPOOL_DATA_DIR!;
    const who = { ann: newId('Ann'), bea: newId('Bea'), cal: newId('Cal'), dee: newId('Dee'), eve: newId('Eve') };
    makeStoppedDatabase(dir, who);
    const { db } = await import('./db/db.js');
    let attempts = 0;
    db.function('photo_move_attempt', () => { attempts++; return 1; });
    const { initStateEngine } = await import('./state-engine.js');
    const { getNodeRole } = await import('./config/node-role.js');
    initStateEngine();
    const atBoot = attempts;
    db.exec('DROP TRIGGER injected_failure');
    await sleep(1500); // the main server's first wait is 200 ms: several turns would have run by now
    const inline = (db.prepare('SELECT avatar_url FROM members WHERE public_key = ?').get(who.ann.pk) as { avatar_url: string | null } | undefined)?.avatar_url;
    const column = db.prepare(`SELECT 1 FROM pragma_table_info('members') WHERE name = 'avatar_url'`).get() != null;
    console.log('STANDBY ' + JSON.stringify({ role: getNodeRole(), atBoot, after: attempts, column, annInline: inline === NEW }));
    process.exit(0);
}

async function main(): Promise<void> {
    if (process.env.PHOTO_RESUME_PART === 'standby') return standbyPart();
    console.log('A stopped photo move tells no phone "no photo", and ends while the node runs (#1482 b)\n');
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('BEANPOOL_DATA_DIR is needed (the suite runner gives every suite a fresh one)');

    const ann = newId('Ann'), bea = newId('Bea'), cal = newId('Cal'), dee = newId('Dee'), eve = newId('Eve');
    makeStoppedDatabase(dir, { ann, bea, cal, dee, eve });

    // ── The node boots on it (the move runs, and stops) and runs on ──
    const { db } = await import('./db/db.js');
    const attempts: number[] = [];
    db.function('photo_move_attempt', () => { attempts.push(Date.now()); return 1; });
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { generateInvite } = await import('./engine/invites.js');
    const { installAvatarKeysAtBoot } = await import('./engine/avatar-keys.js');
    const { isServableAvatarValue } = await import('@beanpool/core');
    await initTls();
    se.initStateEngine();
    for (const m of [ann, bea, cal, dee, eve]) db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 100, 0)').run(m.pk);
    const totalSum = (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
    db.prepare(`UPDATE node_config SET value = ? WHERE key = 'ledger_audit_baseline'`).run(String(totalSum));
    se.reconcileLedgerFromDb();
    const port = await startHttpsServer(0);
    const base = `https://localhost:${port}`;

    const request = async (who: Who, method: 'GET' | 'POST', route: string, body?: unknown, extra: Record<string, string> = {}) => {
        const raw = body === undefined ? '' : JSON.stringify(body);
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const res = await fetch(`${base}${route}`, {
            method,
            headers: {
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                'X-Public-Key': who.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
                'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), who.priv).toString('base64'),
                ...extra,
            },
            ...(body === undefined ? {} : { body: raw }),
        });
        return { status: res.status, etag: res.headers.get('etag'), body: await res.json().catch(() => null) as any };
    };
    const redeemCard = async (who: Who) => {
        const code = generateInvite(bea.pk)?.code;
        const res = await request(who, 'POST', '/api/invite/redeem', { code, publicKey: who.pk, callsign: who.name });
        return { ...res, nodeHasPhoto: !!res.body?.alreadyMember && isServableAvatarValue(res.body?.member?.avatarUrl ?? null) };
    };
    const row = (pk: string) => db.prepare('SELECT avatar_ref, updated_at FROM members WHERE public_key = ?').get(pk) as { avatar_ref: string | null; updated_at: string };
    const photo = (pk: string) => (db.prepare('SELECT photo FROM member_photos WHERE public_key = ?').get(pk) as { photo: string } | undefined)?.photo ?? null;
    const urlIn = (list: { body: any }, who: Who): string | null | undefined =>
        Array.isArray(list.body) ? list.body.find((m: any) => m.publicKey === who.pk)?.avatarUrl : undefined;
    const hasColumn = () => db.prepare(`SELECT 1 FROM pragma_table_info('members') WHERE name = 'avatar_url'`).get() != null;

    try {
        // ── 1. The move stopped at Ann; her own card says she has a photo ──
        assert(hasColumn() && row(bea.pk).avatar_ref !== null && row(ann.pk).avatar_ref === null && photo(ann.pk) === null && attempts.length === 1,
            `the move stopped at Ann at boot: Bea's photo moved, Ann's still inline (${JSON.stringify({ column: hasColumn(), bea: row(bea.pk).avatar_ref, attempts: attempts.length })})`);
        const annCard = await redeemCard(ann);
        assert(annCard.status === 200 && annCard.body?.alreadyMember === true && annCard.body?.member?.avatarUrl === NEW && annCard.nodeHasPhoto,
            `Ann's own redeem card carries her inline photo, so her phone reads nodeHasPhoto and publishes nothing (${annCard.status} nodeHasPhoto=${annCard.nodeHasPhoto} ${String(annCard.body?.member?.avatarUrl ?? annCard.body?.error).slice(0, 40)})`);
        const calCard = await redeemCard(cal);
        const deeCard = await redeemCard(dee);
        assert(calCard.status === 200 && calCard.body?.member?.avatarUrl === null && !calCard.nodeHasPhoto
            && deeCard.status === 200 && deeCard.body?.member?.avatarUrl === null && !deeCard.nodeHasPhoto,
            `Cal (no photo) and Dee (this node's own address sent back) still read no photo (${calCard.body?.member?.avatarUrl} / ${deeCard.body?.member?.avatarUrl})`);
        const beaCard = await redeemCard(bea);
        assert(beaCard.status === 200 && beaCard.body?.member?.avatarUrl === NEW && beaCard.nodeHasPhoto, `Bea, moved at boot, reads her photo as before`);

        // The phone's offline-edit retry publishes its own copy when the list gave its own row no avatar
        // (native avatar-value.ts localRowHasNoAvatar), so the list may not say "none" for a photo still inline.
        const whole = await request(ann, 'GET', '/api/members');
        const delta = await request(ann, 'GET', '/api/members?updatedAfter=2025-01-01T00:00:00.000Z');
        const inWindowUrl = urlIn(whole, ann);
        assert(whole.status === 200 && typeof inWindowUrl === 'string' && inWindowUrl.includes(ann.pk) && typeof urlIn(whole, eve) === 'string'
            && typeof urlIn(whole, bea) === 'string' && urlIn(whole, cal) === null,
            `while the move is stopped, the members list gives Ann's and Eve's own rows (photos still inline) an avatar; Cal none (${whole.status} ${String(inWindowUrl).slice(0, 60)} / ${urlIn(whole, eve)} / ${urlIn(whole, cal)})`);
        assert(delta.status === 200 && typeof urlIn(delta, ann) === 'string' && urlIn(delta, ann) === inWindowUrl && typeof urlIn(delta, eve) === 'string',
            `and so does a phone's delta read (${delta.status} ${String(urlIn(delta, ann)).slice(0, 60)})`);
        const inlineServed = typeof inWindowUrl === 'string' ? await fetch(`${base}${inWindowUrl}`) : null;
        const inlineBytes = inlineServed?.status === 200 ? Buffer.from(await inlineServed.arrayBuffer()) : null;
        assert(inlineServed?.status === 200 && (inlineServed.headers.get('content-type') ?? '').startsWith('image/')
            && !!inlineBytes && inlineBytes.equals(Buffer.from(NEW.split(',')[1], 'base64')),
            `and /api/avatar serves Ann's inline photo at it meanwhile, not a 404 (${inlineServed?.status} ${inlineServed?.headers.get('content-type')})`);
        // On a node whose faces are keyed (a private preview, guestListingsOnly), the URL carries the key for its stand-in
        // reference, which the preview's gate and the route take; a wrong key is still refused.
        process.env.PRIVATE_PREVIEW = '1';
        const keyedOn = installAvatarKeysAtBoot();
        const keyedUrl = urlIn(await request(ann, 'GET', '/api/members'), ann);
        const keyedServed = typeof keyedUrl === 'string' ? await fetch(`${base}${keyedUrl}`) : null;
        const wrongKey = typeof keyedUrl === 'string' ? await fetch(`${base}${keyedUrl.replace(/&k=([^&]+)/, (_m, k: string) => `&k=${k[0] === 'A' ? 'B' : 'A'}${k.slice(1)}`)}`) : null;
        delete process.env.PRIVATE_PREVIEW;
        const keyedOff = installAvatarKeysAtBoot();
        assert(keyedOn && !keyedOff && typeof keyedUrl === 'string' && keyedUrl.includes('&k=') && keyedServed?.status === 200 && (wrongKey?.status === 403 || wrongKey?.status === 404),
            `with faces keyed, Ann's in-window URL carries a key the route takes (${keyedServed?.status}), and a wrong key is refused (${wrongKey?.status})`);

        // ── 2. While the cause lasts, the timer retries, each wait twice the last ──
        await sleep(1700); // turns near 200, 400 (+200), 800 (+400), 1600 (+800) ms after boot
        const gaps = attempts.slice(1).map((t, i) => t - attempts[i]);
        const doubling = gaps.slice(2).every((g, i) => g >= gaps[i + 1] * 1.6);
        assert(attempts.length >= 4 && attempts.length <= 6 && doubling && hasColumn() && photo(ann.pk) === null,
            `while it keeps stopping the resumed move retries with a doubling wait (${attempts.length - 1} turns, gaps ${gaps.join('/')} ms)`);

        // ── 3. The cause is gone: the timer finishes the move without a restart ──
        // The list as a phone holds it just before (whole and delta), with its ETag: nothing but the move changes it after.
        const before = await request(ann, 'GET', '/api/members');
        const beforeDelta = await request(ann, 'GET', '/api/members?updatedAfter=2025-01-01T00:00:00.000Z');
        db.exec('DROP TRIGGER injected_failure');
        const deadline = Date.now() + 10_000;
        while (hasColumn() && Date.now() < deadline) await sleep(100);
        assert(!hasColumn(), `the move finished while the node ran, the old column dropped (${hasColumn() ? 'still there after 10 s' : 'gone'})`);
        assert(photo(ann.pk) === NEW && row(ann.pk).avatar_ref !== null && photo(eve.pk) === EVE && row(eve.pk).avatar_ref !== null && photo(bea.pk) === NEW,
            `Ann's photo is NEW (never an older copy), Eve's reached too, Bea's kept`);
        assert(photo(cal.pk) === null && photo(dee.pk) === null && row(cal.pk).avatar_ref === null && row(dee.pk).avatar_ref === null,
            `Cal and Dee still have no photo`);
        assert(row(ann.pk).updated_at !== STAMP && row(eve.pk).updated_at !== STAMP && row(cal.pk).updated_at === STAMP && row(dee.pk).updated_at === STAMP,
            `the rows whose photos moved after boot are stamped, so a standby's delta carries them; the no-photo rows aren't (${row(ann.pk).updated_at}, ${row(cal.pk).updated_at})`);

        // The phone's offline-edit retry reads its own row from this list: now it has an avatar, so nothing is published.
        const list = await request(ann, 'GET', '/api/members');
        const mine = Array.isArray(list.body) ? list.body.find((m: any) => m.publicKey === ann.pk) : null;
        assert(list.status === 200 && typeof mine?.avatarUrl === 'string' && mine.avatarUrl.includes(ann.pk),
            `the members list the phone syncs gives Ann's own row her avatar (${list.status} ${String(mine?.avatarUrl).slice(0, 50)})`);
        const served = mine?.avatarUrl ? await fetch(`${base}${mine.avatarUrl}`) : null;
        assert(served?.status === 200 && (served.headers.get('content-type') ?? '').startsWith('image/'), `and /api/avatar serves it (${served?.status} ${served?.headers.get('content-type')})`);
        // Each turn that cleared rows bumped the members' version, so a phone sending the ETag it got in the window is
        // given the list again, now with Ann's photo at its real reference, not a 304 for the stand-in it holds.
        const again = await request(ann, 'GET', '/api/members', undefined, before.etag ? { 'If-None-Match': before.etag } : {});
        const againDelta = await request(ann, 'GET', '/api/members?updatedAfter=2025-01-01T00:00:00.000Z', undefined,
            beforeDelta.etag ? { 'If-None-Match': beforeDelta.etag } : {});
        assert(!!before.etag && !!beforeDelta.etag && urlIn(before, ann) === inWindowUrl
            && again.status === 200 && typeof urlIn(again, ann) === 'string' && urlIn(again, ann) !== inWindowUrl && !String(urlIn(again, ann)).includes('v=inline')
            && againDelta.status === 200 && urlIn(againDelta, ann) === urlIn(again, ann),
            `a members ETag taken in the window is not answered 304 after the move, whole (${again.status}) or delta (${againDelta.status}); Ann's URL now carries her photo's reference (${String(urlIn(again, ann)).slice(-20)})`);
        const turnsAtDone = attempts.length;
        await sleep(600);
        assert(attempts.length === turnsAtDone && !hasColumn(), `once done, no more turns`);

        // ── 4. The waits ──
        const w = se.memberPhotoResumeWait;
        assert(w('more', 0) === se.MEMBER_PHOTO_RESUME_GAP_MS && w('stopped', 1) === se.MEMBER_PHOTO_RESUME_MS && w('stopped', 2) === 2 * se.MEMBER_PHOTO_RESUME_MS
            && w('stopped', 10) === 512 * se.MEMBER_PHOTO_RESUME_MS && w('stopped', 11) === se.MEMBER_PHOTO_RESUME_MAX_MS && w('stopped', 10_000) === se.MEMBER_PHOTO_RESUME_MAX_MS && se.MEMBER_PHOTO_RESUME_MAX_MS === 3_600_000,
            `the wait: a short gap while rows are left; 5, 10, 20… s while it stops, never past an hour (${[1, 2, 3, 10, 11, 10_000].map((f) => w('stopped', f)).join('/')})`);

        // ── 5. A standby never resumes its move ──
        const standbyDir = path.join(dir, 'standby');
        fs.mkdirSync(standbyDir, { recursive: true });
        const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]], {
            env: { ...process.env, PHOTO_RESUME_PART: 'standby', NODE_ROLE: 'backup', BEANPOOL_DATA_DIR: standbyDir },
            encoding: 'utf8', timeout: 120_000,
        });
        const line = (child.stdout ?? '').split('\n').find((l) => l.startsWith('STANDBY '));
        const sb = line ? JSON.parse(line.slice(8)) : null;
        assert(sb?.role === 'backup' && sb.atBoot === 1 && sb.after === 1 && sb.column === true && sb.annInline === true,
            `a standby whose boot move stopped never resumes it (${line ?? `no answer: ${(child.stderr ?? '').slice(-800)}`})`);
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.stack || e})`);
    }
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && run > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
