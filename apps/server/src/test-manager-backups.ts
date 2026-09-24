/**
 * Integration Test for Fleet Manager Backup Routes (`routes/manager-backups.ts`).
 *
 * Verifies:
 * 1. GET /api/manager/backups/status enforces admin auth & returns node/harvest status payload.
 * 2. GET /api/manager/backups/download-db returns 400 when missing nodeId, 404 when backup DB missing.
 * 3. GET /api/manager/backups/history returns 400 when missing nodeId, history array when missing history dir.
 * 4. GET /api/manager/backups/download-history returns 400 for path-traversal or missing parameters.
 * 8. A SHORT harvested backup says how short on the wire, and the gzip that builds the archive does NOT hold
 *    the fleet manager's event loop (round 4: this route compresses more bytes than either backup path).
 * 9. The label is MEASURED off the kept database, not read off the node's manifest: a copy with no images
 *    beside it, or only some, is labelled short; a whole one is labelled whole; an unreadable one is never
 *    labelled whole.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-manager-backups.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestManagerAdmin123!';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';

const PORT = 8563;
const BASE = `https://localhost:${PORT}`;
const ADMIN_PW = 'TestManagerAdmin123!';

/**
 * How long the fleet manager's event loop may be held in one go while a download's archive is built.
 *
 * Gzipping 24 MB of incompressible objects takes a few hundred ms on this machine and far longer on the
 * 1 vCPU manager node, so a synchronous `tar` shows up as one stall of that order. Async `execFile` leaves
 * only the ordinary jitter of streaming the response.
 */
const STALL_BUDGET_MS = 120;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/**
 * The bytes of a real SQLite database whose rows reference `keys`: `posts/…` as post photos, anything else as
 * message attachments. The two tables and the one column `referencedStorageKeys` reads, and nothing more.
 */
function dbReferencing(keys: string[], opts: { wal?: boolean } = {}): Buffer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-db-'));
    const file = path.join(dir, 'state.db');
    const handle = new Database(file);
    // WAL leaves the file's header saying so after a clean close, which is what makes a read-only open of it
    // create `-wal` and `-shm` beside it.
    if (opts.wal) handle.pragma('journal_mode = WAL');
    handle.exec('CREATE TABLE post_photos (post_id TEXT, storage_key TEXT); CREATE TABLE message_attachments (message_id TEXT, storage_key TEXT);');
    for (const key of keys) {
        if (key.startsWith('posts/')) handle.prepare('INSERT INTO post_photos VALUES (?, ?)').run(key.split('/')[1], key);
        else handle.prepare('INSERT INTO message_attachments VALUES (?, ?)').run(key, key);
    }
    handle.close();
    const bytes = fs.readFileSync(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return bytes;
}

async function main(): Promise<void> {
    console.log('Running Fleet Manager Backups integration tests...\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // 1. GET /api/manager/backups/status
    // Unauthenticated request -> 401
    const unauthStatus = await fetch(`${BASE}/api/manager/backups/status`);
    assert(unauthStatus.status === 401, `GET /api/manager/backups/status requires admin auth (got ${unauthStatus.status})`);

    // Authenticated request -> 200 with payload
    const authStatus = await fetch(`${BASE}/api/manager/backups/status`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(authStatus.status === 200, `GET /api/manager/backups/status with admin auth succeeds (got ${authStatus.status})`);
    const statusBody = await authStatus.json();
    assert(Array.isArray(statusBody.nodes), 'Status response contains nodes array');
    assert(typeof statusBody.harvestState === 'object' && statusBody.harvestState !== null, 'Status response contains harvestState object');

    // 2. GET /api/manager/backups/download-db
    const downloadDbNoNode = await fetch(`${BASE}/api/manager/backups/download-db`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadDbNoNode.status === 400, `download-db requires nodeId parameter (got ${downloadDbNoNode.status})`);

    const downloadDbNotFound = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=nonexistent-node`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadDbNotFound.status === 404, `download-db returns 404 for missing backup DB (got ${downloadDbNotFound.status})`);

    const downloadDbTraversal = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=../../secret`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadDbTraversal.status === 400, `download-db rejects path-traversal nodeId (got ${downloadDbTraversal.status})`);

    // 3. GET /api/manager/backups/history
    const historyNoNode = await fetch(`${BASE}/api/manager/backups/history`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(historyNoNode.status === 400, `history requires nodeId parameter (got ${historyNoNode.status})`);

    const historyNotFound = await fetch(`${BASE}/api/manager/backups/history?nodeId=nonexistent-node`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(historyNotFound.status === 200, `history returns 200 empty history array when dir absent (got ${historyNotFound.status})`);
    const historyBody = await historyNotFound.json();
    assert(Array.isArray(historyBody.history) && historyBody.history.length === 0, 'History response is an empty array');

    // 4. GET /api/manager/backups/download-history
    const downloadHistoryNoParams = await fetch(`${BASE}/api/manager/backups/download-history`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadHistoryNoParams.status === 400, `download-history returns 400 when missing parameters (got ${downloadHistoryNoParams.status})`);

    const downloadHistoryTraversal = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=node1&filename=../secret.txt`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadHistoryTraversal.status === 400, `download-history rejects path-traversal filename (got ${downloadHistoryTraversal.status})`);

    const downloadHistoryBackslash = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=node1&filename=..\\secret.txt`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadHistoryBackslash.status === 400, `download-history rejects backslash traversal filename (got ${downloadHistoryBackslash.status})`);

    const downloadHistoryInvalidPattern = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=node1&filename=arbitrary.txt`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadHistoryInvalidPattern.status === 400, `download-history rejects non-snapshot filename pattern (got ${downloadHistoryInvalidPattern.status})`);

    // 5. GET /api/manager/backups/download-identity
    const downloadIdentityTraversal = await fetch(`${BASE}/api/manager/backups/download-identity?nodeId=../../secret`, {
        headers: { 'X-Admin-Password': ADMIN_PW },
    });
    assert(downloadIdentityTraversal.status === 400, `download-identity rejects path-traversal nodeId (got ${downloadIdentityTraversal.status})`);

    // 6. Sealed backups (sealed-keys slice 3): a locked node's .bpsealed files are served as they are. The plain
    //    identity bundle is gone (410), and nothing here is gzip.
    const sealedDir = path.join(process.env.BEANPOOL_DATA_DIR!, 'backups', 'mullum', 'sealed');
    fs.mkdirSync(sealedDir, { recursive: true });
    const fakeSealed = Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from('{}'), Buffer.from('ciphertext')]);
    fs.writeFileSync(path.join(sealedDir, 'beanpool-2026-09-19T01-02-03.bpsealed'), fakeSealed);
    const isGz = (b: Buffer) => b[0] === 0x1f && b[1] === 0x8b;
    const dbRes = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const dbBody = Buffer.from(await dbRes.arrayBuffer());
    assert(dbRes.status === 200 && dbBody.equals(fakeSealed) && /\.bpsealed"/.test(dbRes.headers.get('content-disposition') || ''),
        `download-db serves the newest sealed file as it is (got ${dbRes.status})`);
    const histRes = await fetch(`${BASE}/api/manager/backups/history?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const hist = await histRes.json() as any;
    assert(hist.history?.length === 1 && hist.history[0].filename === 'beanpool-2026-09-19T01-02-03.bpsealed' && hist.history[0].sealed === true,
        'history lists the sealed files');
    const oneRes = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-2026-09-19T01-02-03.bpsealed`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const oneBody = Buffer.from(await oneRes.arrayBuffer());
    assert(oneRes.status === 200 && oneBody.equals(fakeSealed), `download-history serves a sealed file (got ${oneRes.status})`);
    const missing = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-2026-09-10.db`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    assert(missing.status === 404, `download-history: a daily .db copy that is not held is 404 (got ${missing.status})`);
    const badName = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-2026-09-10.tar.gz`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    assert(badName.status === 400, `download-history refuses any other kind of name (got ${badName.status})`);
    const idRes = await fetch(`${BASE}/api/manager/backups/download-identity?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const idBody = Buffer.from(await idRes.arrayBuffer());
    assert(idRes.status === 410 && !isGz(idBody) && /locked backup/.test(idBody.toString()), `download-identity is gone: 410 with the reason (got ${idRes.status})`);

    // 7. A node whose backups are not locked yet (seal review round 1): the harvester keeps the readable state.db and
    //    daily copies as before, and these routes serve them as before, marked not locked. The locked legacy key
    //    file is listed (identity: true) and downloadable.
    const nodeDir = path.join(process.env.BEANPOOL_DATA_DIR!, 'backups', 'mullum');
    fs.mkdirSync(path.join(nodeDir, 'history'), { recursive: true });
    // A real database now, referencing the one photo placed beside it below. This was 116 bytes of SQLite
    // header that nothing opened; the route now reads the kept database to measure its label (section 9).
    const sqlite = dbReferencing(['posts/p1/0-abcdef01.jpg']);
    fs.writeFileSync(path.join(nodeDir, 'state.db'), sqlite);
    fs.writeFileSync(path.join(nodeDir, 'history', 'beanpool-2026-09-18.db'), sqlite);
    const past = new Date(Date.now() - 3 * 86_400_000);
    fs.utimesSync(path.join(sealedDir, 'beanpool-2026-09-19T01-02-03.bpsealed'), past, past);
    fs.writeFileSync(path.join(sealedDir, 'beanpool-identity-2026-09-01-legacy.bpsealed'), fakeSealed);
    fs.utimesSync(path.join(sealedDir, 'beanpool-identity-2026-09-01-legacy.bpsealed'), past, past);
    // CHANGED in round 3, because what these three asserted is the defect the round found: a readable
    // download used to be the bare `.db`, which since the image store is a database whose every photo and
    // attachment is a `storage_key` pointing at bytes the file does not carry — and which the restore
    // wizard could not take anyway, since it extracts a tar. The database's bytes are still checked, to
    // the byte; they are now checked inside the archive that carries the images with them.
    fs.mkdirSync(path.join(nodeDir, 'state.db.images', 'posts', 'p1'), { recursive: true });
    const heldObject = Buffer.from('the bytes of a photo the database references');
    fs.writeFileSync(path.join(nodeDir, 'state.db.images', 'posts', 'p1', '0-abcdef01.jpg'), heldObject);
    const openTar = (bytes: Buffer): Record<string, Buffer> => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-dl-'));
        fs.writeFileSync(path.join(dir, 'x.tar.gz'), bytes);
        execFileSync('tar', ['-xzf', path.join(dir, 'x.tar.gz'), '-C', dir]);
        fs.rmSync(path.join(dir, 'x.tar.gz'));
        const out: Record<string, Buffer> = {};
        const walk = (d: string) => {
            for (const f of fs.readdirSync(d)) {
                const full = path.join(d, f);
                if (fs.lstatSync(full).isDirectory()) walk(full);
                else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full);
            }
        };
        walk(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        return out;
    };
    const plainRes = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const plainBody = Buffer.from(await plainRes.arrayBuffer());
    const plainMembers = openTar(plainBody);
    assert(plainRes.status === 200 && plainMembers['state.db']?.equals(sqlite) === true
        && plainRes.headers.get('x-backup-locked') === 'no'
        && /beanpool-backup-mullum\.tar\.gz"/.test(plainRes.headers.get('content-disposition') || ''),
        `download-db serves the readable backup as a restorable archive when it is newer than any locked file, marked not locked (got ${plainRes.status}, ${Object.keys(plainMembers).join(', ')})`);
    assert(plainMembers['images/posts/p1/0-abcdef01.jpg']?.equals(heldObject) === true,
        '…and the images beside that database come with it, byte for byte, so a restore from it is whole');
    assert(plainRes.headers.get('x-backup-contents') === 'database+images'
        && plainRes.headers.get('x-backup-images') === '1/1'
        && plainRes.headers.get('x-backup-missing-images') === null,
        `…and is labelled whole, because it is: 1 of the 1 object its database references `
        + `(${plainRes.headers.get('x-backup-contents')}, ${plainRes.headers.get('x-backup-images')})`);
    const hist2 = (await (await fetch(`${BASE}/api/manager/backups/history?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } })).json() as any).history;
    const names = hist2.map((h: any) => `${h.filename}:${h.sealed}:${h.identity}`).sort();
    assert(JSON.stringify(names) === JSON.stringify([
        'beanpool-2026-09-18.db:false:false',
        'beanpool-2026-09-19T01-02-03.bpsealed:true:false',
        'beanpool-identity-2026-09-01-legacy.bpsealed:true:true',
    ]), `history lists readable daily copies, locked backups and the locked key file (${names.join(', ')})`);
    const dayRes = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-2026-09-18.db`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const dayMembers = openTar(Buffer.from(await dayRes.arrayBuffer()));
    assert(dayRes.status === 200 && dayMembers['state.db']?.equals(sqlite) === true && dayRes.headers.get('x-backup-locked') === 'no',
        `download-history serves a readable daily copy as a restorable archive, marked not locked (got ${dayRes.status})`);
    // That daily copy has no `.images` beside it — a day kept by a harvester older than the image store — so
    // the one photo its database references is not in the file, and the label says so.
    assert(dayRes.headers.get('x-backup-contents') === 'database+images-partial'
        && dayRes.headers.get('x-backup-images') === '0/1'
        && dayRes.headers.get('x-backup-missing-images') === '1',
        `…and a daily copy with no images beside it is labelled short, not whole `
        + `(${dayRes.headers.get('x-backup-contents')}, ${dayRes.headers.get('x-backup-images')}, missing ${dayRes.headers.get('x-backup-missing-images')})`);
    const keyRes = await fetch(`${BASE}/api/manager/backups/download-history?nodeId=mullum&filename=beanpool-identity-2026-09-01-legacy.bpsealed`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    assert(keyRes.status === 200 && Buffer.from(await keyRes.arrayBuffer()).equals(fakeSealed), `the locked legacy key file downloads (got ${keyRes.status})`);
    // Narrowed in round 3, and for the same reason: a LOCKED file and the 410 must never be a plain archive
    // (that is what this was protecting), while the readable download now must be one.
    assert(![dbBody, oneBody, idBody].some(isGz), 'no locked download starts with gzip magic: a sealed file is served as it is');
    assert(isGz(plainBody), 'while a readable backup IS a gzip archive now — the database and its images together');

    // 8a. The shortfall on the wire. The harvester keeps the node's `missing-images.json` beside the database,
    //     so the manager's own download can say how short the file is in the same headers a node's backup
    //     route sets — one reader per UI covers both, and nothing has to open the archive to find out.
    //     The database a short node sends still names the objects it could not send; the manifest says which.
    fs.writeFileSync(path.join(nodeDir, 'state.db'),
        dbReferencing(['posts/p1/0-abcdef01.jpg', 'posts/p2/0-deadbeef.jpg', 'attachments/m9.bin']));
    fs.writeFileSync(path.join(nodeDir, 'state.db.missing-images.json'), JSON.stringify({
        note: 'This backup is SHORT.', takenAt: '2026-09-24T02:03:04.000Z',
        referenced: 3, staged: 1, missing: ['posts/p2/0-deadbeef.jpg', 'attachments/m9.bin'],
    }));
    const shortRes = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const shortMembers = openTar(Buffer.from(await shortRes.arrayBuffer()));
    assert(shortRes.status === 200 && shortRes.headers.get('x-backup-contents') === 'database+images-partial',
        `download-db says the harvested backup is partial (got ${shortRes.headers.get('x-backup-contents')})`);
    assert(shortRes.headers.get('x-backup-missing-images') === '2',
        `…with the count a UI can show (${shortRes.headers.get('x-backup-missing-images')})`);
    assert(shortRes.headers.get('x-backup-images') === '1/3',
        `…as <staged>/<referenced>, spelled exactly as a node's own backup route spells it (${shortRes.headers.get('x-backup-images')})`);
    assert(!!shortMembers['missing-images.json'],
        '…and the manifest rides inside the archive, so a restore from it reports the shortfall too');
    fs.rmSync(path.join(nodeDir, 'state.db.missing-images.json'));

    // 8b. The gzip must not hold the event loop.
    //
    // `createPlainBackup` and `createSealedBackup` went async for exactly this reason, and this route
    // compresses MORE bytes than either: the harvester's kept database plus every object beside it, per
    // download. On the 1 vCPU manager node a synchronous `tar` stalls every other request for the duration,
    // including the harvester's own pulls. Measured rather than asserted about the source: a timer ticking
    // every 2 ms cannot fire at all while the loop is blocked in `execFileSync`.
    const bulkDir = path.join(nodeDir, 'state.db.images', 'posts', 'bulk');
    fs.mkdirSync(bulkDir, { recursive: true });
    // Incompressible, so gzip has to do real work rather than run away with a run of zeroes.
    for (let i = 0; i < 12; i++) {
        fs.writeFileSync(path.join(bulkDir, `${i}-bulk.jpg`), crypto.randomBytes(2 * 1024 * 1024));
    }
    //
    // The measurement is the LONGEST SINGLE STALL, not the number of ticks: a synchronous `tar` blocks only
    // for the compression, and the rest of the request — TLS, the 24 MB response — leaves plenty of room for
    // a tick either way. Counting ticks therefore passes on the blocking version too (measured: 39 of them).
    // One gap the length of the gzip is the thing that actually distinguishes them.
    let ticks = 0;
    let worstStallMs = 0;
    let lastTickAt = Date.now();
    const ticker = setInterval(() => {
        const now = Date.now();
        worstStallMs = Math.max(worstStallMs, now - lastTickAt);
        lastTickAt = now;
        ticks++;
    }, 2);
    const startedAt = Date.now();
    const bulkRes = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=mullum`, { headers: { 'X-Admin-Password': ADMIN_PW } });
    const bulkBytes = Buffer.from(await bulkRes.arrayBuffer());
    const elapsed = Date.now() - startedAt;
    clearInterval(ticker);
    assert(bulkRes.status === 200 && isGz(bulkBytes),
        `download-db still serves the archive with 24 MB of objects in it (got ${bulkRes.status}, ${bulkBytes.length} bytes)`);
    console.log(`   …the download took ${elapsed} ms: ${ticks} timer tick(s), worst single stall ${worstStallMs} ms.`);
    assert(worstStallMs < STALL_BUDGET_MS,
        `the event loop is never held for the length of a gzip — async execFile, not execFileSync `
        + `(worst stall ${worstStallMs} ms of ${elapsed} ms, budget ${STALL_BUDGET_MS} ms)`);
    fs.rmSync(bulkDir, { recursive: true, force: true });

    // 9. The label is a measurement (#1097 round-5 follow-up).
    //
    //    It used to be `staged + the manifest's count`, so a kept copy short for any reason the NODE never
    //    reported went out labelled whole, and neither UI said a word. Two real ways to get one: a node upgraded
    //    while a harvester older than the image store kept only its state.db (thousands of storage_keys, no
    //    `.images` at all), and a pull that hit ENOSPC while replacing `.images` after state.db was already
    //    overwritten (a new database beside a partial store). Neither has a manifest. The count now comes from
    //    the kept database's own storage_keys, as a node's backup and a restore count theirs.
    const labelDir = path.join(process.env.BEANPOOL_DATA_DIR!, 'backups', 'bris');
    fs.mkdirSync(labelDir, { recursive: true });
    const labelKeys = ['posts/q1/0-aa11bb22.jpg', 'posts/q1/1-cc33dd44.jpg', 'attachments/msg-q.bin'];
    const labelObjects: Record<string, Buffer> = Object.fromEntries(labelKeys.map(k => [k, crypto.randomBytes(700)]));
    const labelDb = dbReferencing(labelKeys);
    fs.writeFileSync(path.join(labelDir, 'state.db'), labelDb);
    const holdHere = (keys: string[]) => {
        fs.rmSync(path.join(labelDir, 'state.db.images'), { recursive: true, force: true });
        for (const k of keys) {
            const to = path.join(labelDir, 'state.db.images', k);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.writeFileSync(to, labelObjects[k]);
        }
    };
    const labelOf = async () => {
        const res = await fetch(`${BASE}/api/manager/backups/download-db?nodeId=bris`, { headers: { 'X-Admin-Password': ADMIN_PW } });
        const members = openTar(Buffer.from(await res.arrayBuffer()));
        return {
            status: res.status, members,
            contents: res.headers.get('x-backup-contents'),
            images: res.headers.get('x-backup-images'),
            missing: res.headers.get('x-backup-missing-images'),
        };
    };
    const said = (l: { contents: string | null; images: string | null; missing: string | null }) =>
        `${l.contents}, ${l.images}, missing ${l.missing}`;

    // 9a. Kept by an old harvester: the database and nothing beside it.
    holdHere([]);
    const noImages = await labelOf();
    assert(noImages.status === 200 && noImages.members['state.db']?.equals(labelDb) === true,
        `a kept state.db with no images beside it still downloads, database byte for byte (got ${noImages.status})`);
    assert(noImages.contents === 'database+images-partial' && noImages.images === '0/3' && noImages.missing === '3',
        `…labelled short by every object its database references, not "0/0" (${said(noImages)})`);

    // 9b. A pull cut short part-way through replacing `.images`: one of the three made it.
    holdHere([labelKeys[0]]);
    const partial = await labelOf();
    assert(partial.contents === 'database+images-partial' && partial.images === '1/3' && partial.missing === '2',
        `a partial images directory with no manifest is labelled short by the two it lacks (${said(partial)})`);
    assert(partial.members[`images/${labelKeys[0]}`]?.equals(labelObjects[labelKeys[0]]) === true && !partial.members['missing-images.json'],
        '…while still carrying the one it has, and inventing no manifest the node never wrote');

    // 9c. All three: whole, and labelled whole.
    holdHere(labelKeys);
    const whole = await labelOf();
    assert(whole.contents === 'database+images' && whole.images === '3/3' && whole.missing === null,
        `a complete copy is labelled whole (${said(whole)})`);
    assert(labelKeys.every(k => whole.members[`images/${k}`]?.equals(labelObjects[k]) === true),
        '…and carries all three objects byte for byte');

    // 9c′. The same, kept as a WAL-mode file (an older node's copy of its live database). Reading it read-only
    //      creates `-wal` and `-shm` beside it, so the read must happen outside the tree that gets tarred.
    const walDb = dbReferencing(labelKeys, { wal: true });
    fs.writeFileSync(path.join(labelDir, 'state.db'), walDb);
    const walWhole = await labelOf();
    assert(walWhole.contents === 'database+images' && walWhole.images === '3/3' && walWhole.members['state.db']?.equals(walDb) === true,
        `a WAL-mode kept database is measured the same (${said(walWhole)})`);
    assert(Object.keys(walWhole.members).every(m => !/-(wal|shm)$/.test(m)),
        `…and reading it leaves no -wal or -shm in the archive (${Object.keys(walWhole.members).join(', ')})`);

    // 9d. A kept file that is not a database this can read. Nothing was measured, so nothing is claimed: it
    //     is still handed over (it is the operator's copy, and a restore measures for itself), but never as
    //     whole, and with no `<staged>/<referenced>` that would be a guess.
    const notADb = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]);
    fs.writeFileSync(path.join(labelDir, 'state.db'), notADb);
    const unread = await labelOf();
    assert(unread.status === 200 && unread.members['state.db']?.equals(notADb) === true,
        `an unreadable kept database still downloads, byte for byte (got ${unread.status})`);
    assert(unread.contents === 'database+images-partial' && unread.images === null,
        `…but is never labelled whole, and claims no count it did not take (${said(unread)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ Fleet Manager Backups tests PASSED.');
    process.exit(0);
}

main().catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
