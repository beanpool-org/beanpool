/**
 * Test Suite: data at rest after a delete — snapshots on the main server only and capped; the log with an age limit and a
 * deleted member's name and key taken out of it; a deleted member's photos and picture gone (data-at-rest report F3, F5,
 * F6; scratch/reviews/FABLE-sec-data-at-rest.md).
 *
 * One process, its own data dir, booted as a standby; the backup routes on a local port with the real admin auth.
 *
 *  1. A standby runs no snapshots: the scheduler, started once the role is loaded, arms no timer. A snapshot it took
 *     before, 20 days old, is removed at that start with its photos; one a day old stays.
 *  2. Promoted in this process (setNodeRole, as a take-over finished at boot does), it starts: a timer every 24 hours,
 *     whose tick takes a snapshot. Demoted, it stops: no timer, and a tick of the old timer takes none.
 *  3. The settings route refuses `keep` above 14 (and 0, and 2.5) and takes 14; a row that says 30 (from before the cap)
 *     is read as 14, and so is a kept community settings record. A snapshot 14 days old goes at the next hourly check;
 *     one 13 days old stays.
 *  4. The log: a line older than 30 days goes at the hourly check and at the next hundredth line, whatever the count; one
 *     29 days old stays. The lines Settings' Clean storage archived to data/logs/archived keep the same 30 days: an
 *     archive all older goes, one with lines either side keeps the newer.
 *  5. A member deletes their account. No log line holds their name (any case, in the message or its metadata), nor the
 *     start of their key, nor of the key a re-key replaced; each reads "a deleted member"; nor does an archived line.
 *     Another member's line, and a hex run that is no one's key, are exactly as they were. Their DM photos' stored objects are gone; the other
 *     member's are there, rows and all. Their picture is gone from the row, from the avatar route (404), and from the
 *     route's memory.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-data-retention.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import { lockedDm } from './dm-test-payload.js';

const ADMIN_PW = 'Data-Retention-Pw-8841!k';
process.env.ADMIN_PASSWORD = ADMIN_PW;
// Booted as a standby: the scheduler reads the role once it is loaded (index.ts step 2.61).
process.env.NODE_ROLE = 'backup';
delete process.env.CF_RECORD_NAME;
delete process.env.TRUSTED_PROXIES;

const DATA_DIR = process.env.BEANPOOL_DATA_DIR;
if (!DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

const se = await import('./state-engine.js');
const { db } = await import('./db/db.js');
const { getMemberPhoto, setMemberPhoto } = await import('@beanpool/engine');
const { setNodeRole } = await import('./config/node-role.js');
const { initAdminPassword } = await import('./config/local-config.js');
const { checkAdminAuth } = await import('./admin-auth.js');
const { createBackupRoutes } = await import('./routes/backup.js');
const { parseCommunitySettings } = await import('./config/community-settings.js');
const { getAvatarService } = await import('./engine/avatar.js');
const { sendMessage } = await import('./engine/messaging.js');
const { imagesDir } = await import('./storage/image-store.js');
const { logger } = await import('./logger.js');
const snap = await import('./services/snapshot-scheduler.js');
// This change's own exports: absent on a build from before it, where the checks that need them fail instead of crashing.
const snapNew = snap as unknown as { expireSnapshots?: (now?: number) => number };
const logNew = await import('./logger.js') as unknown as { startSystemLogRetention?: (everyMs?: number) => void };

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}
const j = (v: unknown) => JSON.stringify(v);
const DAY = 24 * 60 * 60_000;
const secs = (ms: number) => ms / 1000;
const quiet = { broadcast: () => 0, dispatchPushNotification: () => {}, registerVisitor: () => {} } as any;
const hexKey = () => crypto.randomBytes(32).toString('hex');

/** A snapshot file as the scheduler names one, with a captured photo beside it, dated `ageMs` ago. */
function fakeSnapshot(name: string, ageMs: number): { db: string; images: string } {
    fs.mkdirSync(snap.SNAPSHOTS_DIR, { recursive: true });
    const file = path.join(snap.SNAPSHOTS_DIR, name);
    fs.writeFileSync(file, 'not a real database: only its name and time matter here');
    const images = snap.snapshotImagesDir(file);
    fs.mkdirSync(path.join(images, 'posts', 'p1'), { recursive: true });
    fs.writeFileSync(path.join(images, 'posts', 'p1', '0.jpg'), 'a deleted member\'s photo, as the snapshot captured it');
    const at = secs(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
    return { db: file, images };
}

/** Every log line as one text, message and metadata. */
const logText = () => (db.prepare(`SELECT group_concat(message || ' ' || COALESCE(metadata, ''), '\n') AS t FROM system_logs`).get() as { t: string | null }).t ?? '';
const logLine = (id: number | bigint) => db.prepare('SELECT message, metadata FROM system_logs WHERE id = ?').get(id) as { message: string; metadata: string | null } | undefined;
/** A log line written straight to the table, at `at`: what a line logged that long ago looks like. */
function oldLine(message: string, at: number): number {
    return Number(db.prepare(`INSERT INTO system_logs (timestamp, level, category, message) VALUES (?, 'INFO', 'SYS', ?)`)
        .run(new Date(at).toISOString(), message).lastInsertRowid);
}
const lineExists = (id: number) => !!db.prepare('SELECT 1 FROM system_logs WHERE id = ?').get(id);

async function main() {
    initAdminPassword();
    se.initStateEngine();

    // ── 1. A standby runs no snapshots, and removes the ones past their age ──────────────────────
    console.log('\n— 1. a standby —');
    const ancient = fakeSnapshot('snapshot-2026-09-01T02-00-00.db', 20 * DAY);
    const recent = fakeSnapshot('snapshot-2026-09-30T02-00-00.db', 1 * DAY);
    snap.initSnapshotScheduler();
    assert(snap.armedSnapshotInterval() === null, `a standby runs no snapshot timer (${j(snap.armedSnapshotInterval())})`);
    assert(!fs.existsSync(ancient.db) && !fs.existsSync(ancient.images),
        'a snapshot it took 20 days ago is removed at its start, with the photos it captured');
    assert(fs.existsSync(recent.db) && fs.existsSync(recent.images), 'one a day old stays');

    // ── 2. Promoted, it starts; demoted, it stops ─────────────────────────────────────────────────
    console.log('\n— 2. promoted, then demoted —');
    const realSetInterval = globalThis.setInterval;
    const ticks: (() => void)[] = [];
    // Recorded as well as set, so a tick can be run by hand: nobody waits 24 hours.
    (globalThis as any).setInterval = (fn: () => void, ms: number) => { if (ms === 24 * 3_600_000) ticks.push(fn); return realSetInterval(fn, ms); };
    try {
        setNodeRole('primary');
    } finally {
        globalThis.setInterval = realSetInterval;
    }
    assert(snap.armedSnapshotInterval() === 24, `promoted, it runs the timer: one snapshot every 24 hours (${j(snap.armedSnapshotInterval())})`);
    const tick = ticks.at(-1);
    const countSnapshots = () => snap.listSnapshots().length;
    const before = countSnapshots();
    tick?.();
    assert(!!tick && countSnapshots() === before + 1, `the main server's tick takes a snapshot (${before} → ${countSnapshots()})`);

    setNodeRole('backup');
    assert(snap.armedSnapshotInterval() === null, `demoted, it stops: no timer (${j(snap.armedSnapshotInterval())})`);
    const afterDemotion = countSnapshots();
    tick?.();
    assert(countSnapshots() === afterDemotion, `and a tick of the old timer takes no snapshot on a standby (${afterDemotion} → ${countSnapshots()})`);
    setNodeRole('primary');
    assert(snap.armedSnapshotInterval() === 24, 'promoted again, it runs again');

    // ── 3. keep is capped; age expiry ──────────────────────────────────────────────────────────────
    console.log('\n— 3. how many are kept, and for how long —');
    const deps = {
        checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
        rateLimit: () => true, clampLimit: (_v: unknown, d = 20) => d, clampOffset: () => 0,
        activeConnections: new Map(), calculateAnalytics: () => ({}), enforceReadAuth: false, broadcast: () => {},
    } as any;
    const app = new Koa();
    app.use(async (ctx, next) => {
        const chunks: Buffer[] = [];
        for await (const c of ctx.req) chunks.push(c as Buffer);
        try { (ctx as any).requestBody = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch { (ctx as any).requestBody = {}; }
        (ctx.request as any).body = (ctx as any).requestBody;
        await next();
    });
    app.use(createBackupRoutes(deps).routes());
    const server = http.createServer(app.callback());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Step 7c: with the node's 2FA off the admin password alone opens no admin route; the snapshot settings (owner only)
    // are changed under an owner's key session.
    const { ownerSessionHeaders } = await import('./admin-auth-test-harness.js');
    const asOwner = ownerSessionHeaders();
    const setConfig = async (body: Record<string, unknown>) => {
        const res = await fetch(`${base}/api/local/admin/snapshots/config`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...asOwner },
            body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) as any };
    };
    try {
        for (const keep of [15, 30, 365, 0, 2.5]) {
            const r = await setConfig({ keep });
            assert(r.status === 400, `the route refuses keep ${keep} (${r.status} ${j(r.body)})`);
        }
        assert(snap.getAutoSnapshotConfig().keep === 7, `and the schedule still keeps 7 (${snap.getAutoSnapshotConfig().keep})`);
        const fourteen = await setConfig({ keep: 14 });
        assert(fourteen.status === 200 && fourteen.body?.config?.keep === 14, `it takes 14 (${fourteen.status} ${j(fourteen.body)})`);
        const seven = await setConfig({ keep: 7 });
        assert(seven.status === 200 && seven.body?.config?.keep === 7, `and 7, the default (${seven.status} ${j(seven.body)})`);
    } finally {
        server.close();
    }
    const own = (db.prepare("SELECT value FROM node_config WHERE key = 'autosnapshot_config'").get() as { value: string }).value;
    db.prepare("UPDATE node_config SET value = ? WHERE key = 'autosnapshot_config'").run(j({ enabled: true, intervalHours: 24, keep: 30 }));
    assert(snap.getAutoSnapshotConfig().keep === 14, `a row from before the cap that says 30 is read as 14 (${snap.getAutoSnapshotConfig().keep})`);
    db.prepare("UPDATE node_config SET value = ? WHERE key = 'autosnapshot_config'").run(own);
    const record = parseCommunitySettings({ localConfig: {}, nodeConfig: { autosnapshot_config: j({ enabled: true, intervalHours: 24, keep: 30 }) }, directory: {} });
    const recordKeep = JSON.parse(record?.record.nodeConfig.autosnapshot_config ?? '{}').keep;
    assert(recordKeep === 14, `a kept community settings record that says 30 is taken as 14 (${j(recordKeep)})`);

    const fortnight = fakeSnapshot('snapshot-2026-09-17T02-00-00.db', 14 * DAY + 60_000);
    const thirteen = fakeSnapshot('snapshot-2026-09-18T02-00-00.db', 13 * DAY);
    const expired = typeof snapNew.expireSnapshots === 'function' ? snapNew.expireSnapshots() : -1;
    assert(expired >= 1 && !fs.existsSync(fortnight.db) && !fs.existsSync(fortnight.images),
        `the hourly check removes a snapshot 14 days old, with its photos (${expired} removed)`);
    assert(fs.existsSync(thirteen.db) && fs.existsSync(recent.db), 'and keeps those 13 days and a day old');

    // ── 4. The log keeps 30 days ──────────────────────────────────────────────────────────────────
    console.log('\n— 4. the log keeps 30 days —');
    const old1 = oldLine('[Test] a line from 40 days ago', Date.now() - 40 * DAY);
    const kept1 = oldLine('[Test] a line from 29 days ago', Date.now() - 29 * DAY);
    // Lines Settings' Clean storage moved out of the table (engine/storage-health.ts): one archive all older than 30 days,
    // one with a line either side of it and a line naming the member who deletes their account in section 5.
    const archiveDir = path.join(DATA_DIR!, 'logs', 'archived');
    fs.mkdirSync(archiveDir, { recursive: true });
    const archive = (name: string, rows: { timestamp: string; message: string; metadata: string | null }[]) => {
        const file = path.join(archiveDir, name);
        fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(rows.map((r, i) => ({ id: i + 1, level: 'INFO', category: 'SYS', ...r }))))));
        return file;
    };
    const readArchive = (file: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as { message: string; metadata: string | null }[];
    const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
    const allOld = archive('logs-1.json.gz', [{ timestamp: iso(45 * DAY), message: '[Test] archived 45 days ago', metadata: null }]);
    const mixed = archive('logs-2.json.gz', [
        { timestamp: iso(35 * DAY), message: '[Test] archived 35 days ago', metadata: null },
        { timestamp: iso(5 * DAY), message: '[Test] archived 5 days ago: Wren Calloway changed their bio', metadata: j({ member: 'Wren Calloway' }) },
        { timestamp: iso(4 * DAY), message: '[Test] archived 4 days ago: Juniper Holt changed their bio', metadata: null },
    ]);
    if (typeof logNew.startSystemLogRetention === 'function') logNew.startSystemLogRetention(60 * 60_000);
    assert(!lineExists(old1), 'the hourly check (run at start) removes a log line 40 days old, though the log is far below 2,500 lines');
    assert(lineExists(kept1), 'and keeps one 29 days old');
    assert(!fs.existsSync(allOld), 'an archive of lines Clean storage moved out, all older than 30 days, is deleted');
    const mixedNow = fs.existsSync(mixed) ? readArchive(mixed).map((r) => r.message) : [];
    assert(j(mixedNow) === j(['[Test] archived 5 days ago: Wren Calloway changed their bio', '[Test] archived 4 days ago: Juniper Holt changed their bio']),
        `an archive with lines either side of 30 days keeps only the newer ones (${j(mixedNow)})`);
    // The next hundredth line prunes too.
    const old2 = oldLine('[Test] another line from 40 days ago', Date.now() - 40 * DAY);
    const nextId = Number((db.prepare('SELECT MAX(id) AS m FROM system_logs').get() as { m: number }).m) + 1;
    for (let i = 0; i < ((100 - (nextId % 100)) % 100) + 1; i++) logger.info('SYS', `[Test] filler line ${i}`);
    assert(!lineExists(old2), 'the next hundredth line removes a line 40 days old too');
    assert(lineExists(kept1), 'and keeps the one 29 days old');

    // ── 5. A member deletes their account ─────────────────────────────────────────────────────────
    console.log('\n— 5. a member deletes their account —');
    const gwen = hexKey();
    const wren = hexKey();
    const juniper = hexKey();
    const wrenOld = hexKey(); // the key a re-key replaced
    se.seedGenesisMember(gwen, 'Gwen');
    const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
    for (const [key, name] of [[wren, 'Wren Calloway'], [juniper, 'Juniper Holt']] as const) {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, updated_at)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(key, name, gwen, `INV-${name.split(' ')[0]}`);
        setMemberPhoto(db, key, AVATAR);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
    }
    db.prepare(`INSERT INTO invalidated_keys (public_key, reason, rekeyed_to) VALUES (?, 'rekey', ?)`).run(wrenOld, wren);

    // The lines the server writes about a member: a re-key (the old key's first 10), an offboard (the first 16), a name in
    // another case, metadata, the first 8 and 12 and the last 8; and lines that are no one's business here.
    logger.info('AUTH', `[Rekey] Re-enrolment code issued for Wren Calloway (${wrenOld.slice(0, 10)}...) by owner:password, valid until tomorrow`);
    logger.info('AUTH', `[Rekey] Completed atomic transfer for Wren Calloway: ${wrenOld.slice(0, 12)} -> ${wren.slice(0, 12)}`);
    logger.info('ADMIN', `[Offboard] Looked at member WREN CALLOWAY (${wren.slice(0, 16)})`, { member: 'Wren Calloway', who: wren.slice(0, 16) });
    logger.info('SYS', `[Test] wren calloway asked about ${wren.slice(0, 8)}... and ...${wren.slice(-8)}`);
    const otherHex = crypto.randomBytes(6).toString('hex');
    logger.info('SYS', `[Test] Juniper Holt (${juniper.slice(0, 8)}...) saved listing ${otherHex}`);
    const juniperLineId = (db.prepare('SELECT MAX(id) AS m FROM system_logs').get() as { m: number }).m;
    const juniperLine = logLine(juniperLineId);
    logger.info('SYS', '[Test] Wrenfield Farm opened its gate');
    const wrenfieldLineId = (db.prepare('SELECT MAX(id) AS m FROM system_logs').get() as { m: number }).m;
    const wrenSeen = () => {
        const text = logText().toLowerCase();
        return {
            name: text.includes('wren calloway'),
            key8: text.includes(wren.slice(0, 8)),
            keyEnd: text.includes(wren.slice(-8)),
            oldKey: text.includes(wrenOld.slice(0, 8)),
        };
    };
    const seenBefore = wrenSeen();
    if (!(seenBefore.name && seenBefore.key8 && seenBefore.keyEnd && seenBefore.oldKey)) throw new Error(`setup: the log does not name Wren as written (${j(seenBefore)})`);

    // A DM with a photo each way: the photos are stored objects (storage/image-columns.ts storeAttachmentColumns).
    const dm = se.createConversation('dm', [wren, juniper], wren)!;
    const send = (author: string) => {
        const cap = lockedDm(24);
        const photo = lockedDm(96);
        return sendMessage(quiet, dm.id, author, cap.ciphertext, cap.nonce, 'image', { data: photo.ciphertext, nonce: photo.nonce })!;
    };
    send(wren); send(wren); send(juniper);
    const objectsOf = (author: string) => (db.prepare(`
        SELECT a.storage_key AS k FROM message_attachments a JOIN messages m ON m.id = a.message_id
         WHERE m.author_pubkey = ? AND a.storage_key IS NOT NULL`).all(author) as { k: string }[]).map((r) => r.k);
    const wrenObjects = objectsOf(wren);
    const juniperObjects = objectsOf(juniper);
    const store = imagesDir(DATA_DIR);
    const inStore = (key: string) => fs.existsSync(path.join(store, key));
    if (wrenObjects.length !== 2 || juniperObjects.length !== 1 || ![...wrenObjects, ...juniperObjects].every(inStore)) {
        throw new Error(`setup: the DM photos are not stored objects (${j({ wrenObjects, juniperObjects })})`);
    }
    const avatars = getAvatarService();
    const shown = await avatars.getAvatar(wren);
    if (shown.status !== 200 || !avatars.cache.get(wren)) throw new Error(`setup: the avatar route did not show Wren's picture (${shown.status})`);

    const result = se.purgeMemberSelf(wren);
    assert(result.ok, `Wren deletes their account (${j(result)})`);

    const seen = wrenSeen();
    assert(!seen.name, 'no log line holds their name, in any case, in its message or metadata');
    assert(!seen.key8 && !seen.keyEnd, `no log line holds the start or the end of their key (${j(seen)})`);
    assert(!seen.oldKey, 'nor the start of the key a re-key replaced');
    assert((logText().match(/a deleted member/g) ?? []).length >= 8, 'each reads "a deleted member"');
    const meta = (db.prepare(`SELECT metadata FROM system_logs WHERE message LIKE '[Offboard] Looked at member%'`).get() as { metadata: string | null })?.metadata;
    let metaParsed: any = null;
    try { metaParsed = JSON.parse(meta ?? 'null'); } catch { /* checked below */ }
    assert(metaParsed?.member === 'a deleted member' && metaParsed?.who === 'a deleted member', `the metadata is still JSON, scrubbed (${meta})`);
    assert(j(logLine(juniperLineId)) === j(juniperLine), `Juniper's line, and a hex run that is no one's key, are exactly as they were (${logLine(juniperLineId)?.message})`);
    assert(logLine(wrenfieldLineId)?.message === '[Test] Wrenfield Farm opened its gate', 'a longer word that starts like their name is left alone');
    const archived = fs.existsSync(mixed) ? readArchive(mixed) : [];
    assert(archived.length === 2 && !/wren calloway/i.test(j(archived)) && archived[0].message === '[Test] archived 5 days ago: a deleted member changed their bio'
        && JSON.parse(archived[0].metadata ?? '{}').member === 'a deleted member',
        `the lines Clean storage archived lose their name too (${j(archived.map((r) => r.message))})`);
    assert(archived[1]?.message === '[Test] archived 4 days ago: Juniper Holt changed their bio', "and Juniper's archived line is as it was");

    assert(wrenObjects.every((k) => !inStore(k)), `their DM photos' stored objects are gone (${wrenObjects.filter(inStore).length} left)`);
    assert(juniperObjects.every(inStore) && objectsOf(juniper).length === 1, "Juniper's photo, row and object, is still there");

    const row = db.prepare('SELECT avatar_ref, avatar_bytes FROM members WHERE public_key = ?').get(wren) as { avatar_ref: string | null; avatar_bytes: number | null };
    assert(row.avatar_ref === null && row.avatar_bytes === null && getMemberPhoto(db, wren) === null,
        'their picture is gone: from member_photos, and its reference from their row (it was never a stored object)');
    const after = await avatars.getAvatar(wren);
    assert(after.status === 404, `the avatar route answers 404 for them (${after.status})`);
    assert(!avatars.cache.get(wren), "and the route's memory no longer holds their picture's bytes");
    assert((await avatars.getAvatar(juniper)).status === 200, "Juniper's picture still shows");

    // ── 6. A callsign that is also a JSON literal or a number ─────────────────────────────────────
    // (review of #1404) The callsign is any trimmed text of 2 to 32 characters. `True`, `null` and `12` must not turn another
    // member's metadata into invalid JSON or rewrite the numbers and dates of a line that has nothing to do with them.
    console.log('\n— 6. a callsign of True, null or 12 —');
    const OTHER_MSG = '[Connectors] Inbound handshake verified for riverbend';
    const OTHER_META = { mutualTrust: true, peer: null, retries: 12, note: 'seen 2026-12-01T02-00-00 by Juniper Holt', list: [12, true, null] };
    const SNAP_MSG = '[Snapshots] Created snapshot snapshot-2026-12-01T02-00-00.db (12 bytes)';
    for (const callsign of ['True', 'null', '12']) {
        const key = hexKey();
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, updated_at)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(key, callsign, gwen, `INV-${callsign}`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
        logger.info('P2P', `${OTHER_MSG} for ${callsign}: mutual=true`, OTHER_META);
        const metaId = (db.prepare('SELECT MAX(id) AS m FROM system_logs').get() as { m: number }).m;
        logger.info('SYS', SNAP_MSG, { bytes: 12, name: 'snapshot-2026-12-01T02-00-00.db' });
        const snapId = (db.prepare('SELECT MAX(id) AS m FROM system_logs').get() as { m: number }).m;
        logger.info('ADMIN', `[Offboard] Looked at member ${callsign}`, { member: callsign, count: 12 });
        const ownId = (db.prepare('SELECT MAX(id) AS m FROM system_logs').get() as { m: number }).m;
        const metaBefore = logLine(metaId), snapBefore = logLine(snapId);
        assert(se.purgeMemberSelf(key).ok, `a member called "${callsign}" deletes their account`);
        const metaAfter = logLine(metaId), snapAfter = logLine(snapId);
        let parsed: any = null;
        try { parsed = JSON.parse(metaAfter?.metadata ?? 'null'); } catch { /* checked below */ }
        assert(parsed && j(parsed) === j(OTHER_META), `another line's metadata is still JSON, untouched, for "${callsign}" (${metaAfter?.metadata})`);
        assert(j(snapAfter) === j(snapBefore), `a line with a date and a count is exactly as it was for "${callsign}" (${snapAfter?.message})`);
        void metaBefore;
        const own = logLine(ownId);
        assert(callsign === '12' ? own?.metadata?.includes('"member":"12"') === true : JSON.parse(own?.metadata ?? 'null')?.member === 'a deleted member',
            `their own line: a name with a letter is scrubbed, one with none is left as a number (${own?.metadata})`);
        assert(callsign === '12' || (own?.message ?? '').endsWith('member a deleted member'), `the message names them by whole word only (${own?.message})`);
    }
    // A real name is still scrubbed structurally: inside strings, even in an array, with the JSON kept valid.
    {
        const key = hexKey();
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, updated_at)
                    VALUES (?, 'Marlow Reed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'INV-Marlow', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(key, gwen);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
        logger.info('ADMIN', '[Offboard] Looked at Marlow Reed', { who: 'Marlow Reed', nested: { list: ['x', 'Marlow Reed wrote'], n: 12, ok: true } });
        const id = (db.prepare('SELECT MAX(id) AS m FROM system_logs').get() as { m: number }).m;
        se.purgeMemberSelf(key);
        const l = logLine(id);
        let p: any = null;
        try { p = JSON.parse(l?.metadata ?? 'null'); } catch { /* checked below */ }
        assert(p && j(p) === j({ who: 'a deleted member', nested: { list: ['x', 'a deleted member wrote'], n: 12, ok: true } }) && l?.message === '[Offboard] Looked at a deleted member',
            `a real name is still scrubbed, in strings only, and the metadata stays JSON (${l?.metadata})`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('💥 Suite crashed:', e);
    process.exit(1);
});
