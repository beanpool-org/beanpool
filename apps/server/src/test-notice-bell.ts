/**
 * The bell on both apps (scratch/fable-design/DESIGN-web-notifications-fable.md §2.1, slice W0; Marty, 9 Nov 2026: the bell
 * takes the needs-you row; 10 Nov: a row also leaves with its ✕ and all of them with "Clear all", on the old rows still red
 * days later). The server keeps the list of what happened for every member, a phone or not, and each app reads and marks
 * its member's own.
 *
 * Over REAL HTTPS through the real signature middleware; every push is caught where it leaves for Expo:
 *   1. kept for all: a push to a member with no phone keeps them a notice as it does a member with one (the phone still the
 *      only one Expo is asked to reach); a member with the category off, and a key that is no member here, get none
 *   2. the socket: the member's own sockets hear `{ type: 'push_notice', id, kind }` the moment it is kept, with no words;
 *      nobody else's socket hears it, nor a socket of an app from before the bell (no `bell=1`), which would take it for a
 *      doorbell
 *   3. the list (GET /api/notices/push): the signer's own only, newest first, with their words, where a tap lands, and
 *      seenAt; unseen=1 the unseen only; unsigned 401, a key that is no member 403; private, no-store
 *   4. the mark (POST /api/notices/push/seen): only the signer's own ids are marked (another member's stay unseen), once;
 *      a bad body 400; unsigned 401, no member 403; the member's sockets hear it; reading the list marks nothing
 *   5. opening the chat marks its rows: POST /api/messages/mark-read takes that chat's notices off the bell, and no other's
 *   6. the moderation notices fold in: each is a row; acknowledging its alert (POST /api/notices/seen) marks the row, and a
 *      tap on the row marks the alert's kept copy
 *   7. a standby answers the read and refuses the mark, 503 `standby`, writing nothing
 *   8. the bounds: at most 100, nothing older than 7 days, whatever the hourly tidy last did
 *   9. one request to join, one row for the member whose shared listing it came after, a phone or not (shared-listing door A3)
 *  10. every sender that keeps a notice and pushes it (a voucher's budget, a credit gift, a standing deal, unfunded pledges
 *      returned, a removal vote opened, a reply taken down, an owner's decision, an invite ask answered): its row names the
 *      alert's kept copy, so acknowledging the alert takes the row off the bell, and a tap on the row marks the alert
 *  11. a tap on a phone notification (its details read, GET /api/notices/push/:id: only that tap reads them) takes its row
 *      off the bell, and a moderation notice's alert with it; another member's read marks nothing; a standby marks nothing
 * 12. "Clear all" (POST .../push/seen { all: true }): every notice of the signer's own and no one else's, a moderation
 *      notice's alert with its row, the member's sockets told once, a bad body 400, unsigned 401, no member 403, a standby 503
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-notice-bell)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_ROLE;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.EXPO_ACCESS_TOKEN;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without the bell (no such column, no such function) fails its assertion, not the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 300);

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

let BASE = '';
interface Res { status: number; body: any; headers: Headers }
async function call(method: 'GET' | 'POST', id: Id | null, route: string, body?: unknown): Promise<Res> {
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
}

type Sock = { ws: WebSocket; events: any[] };
/** A member's socket; `bell` false: an app from before the bell, which never said it reads its events. */
function socket(id: Id, bell = true): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}&nr=1${bell ? '&bell=1' : ''}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}

async function main() {
    console.log('The bell: what happened, kept for every member, read and marked by them alone...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const mod = await import('./engine/moderation-notices.js');
    const notices: any = await import('./engine/push-notices.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = new URL(url).hostname;
        if (host === 'exp.host') {
            const batch = JSON.parse(init?.body ?? '[]');
            sent.push(...batch);
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (host === 'localhost' || host === '127.0.0.1') return realFetch(input, init);
        throw new Error(`the test refused to contact ${host}`);
    };

    const owner = newId('Olive');
    se.seedGenesisMember(owner.pk, 'Olive');
    const member = (name: string): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, name, new Date(Date.now() - 60 * DAY).toISOString(), owner.pk);
        setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const ann = member('Ann'); // a phone
    const web = member('Wes'); // the web app only: no phone registered here
    const cat = member('Cat'); // the web app only, chat notices off
    const nemo = newId('Nemo'); // no member here
    putPushTokenRow(ann.pk, `ExponentPushToken[ann-${crypto.randomBytes(8).toString('hex')}]`, 'android');
    db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_chat', 'false')`).run(cat.pk);
    const rowsOf = (id: Id | string) => attempt(() => db.prepare('SELECT * FROM push_notices WHERE recipient = ? ORDER BY sent_at DESC, rowid DESC')
        .all(typeof id === 'string' ? id : id.pk) as any[]) ?? [];
    const list = async (id: Id | null, query = '') => {
        const r = await call('GET', id, `/api/notices/push${query}`);
        return { ...r, notices: Array.isArray(r.body?.notices) ? r.body.notices as any[] : [] };
    };

    const webSock = await socket(web);
    const annSock = await socket(ann);
    const webOld = await socket(web, false);
    await sleep(100);

    try {
        // ── 1. Kept for all ────────────────────────────────────────────────────────────────────────────────
        console.log('--- 1. Kept for every member, a phone or not ---');
        const conv = se.createConversation('dm', [web.pk, ann.pk], ann.pk)!;
        sent.length = 0;
        const phones = se.dispatchPushNotification([web.pk, ann.pk, cat.pk, nemo.pk], owner.pk, '💬 New Message', 'Olive sent you a message',
            { screen: 'chat', conversationId: conv.id }, 'chat', 'chat.message');
        await sleep(100);
        const webRows = rowsOf(web);
        assert(webRows.length === 1 && webRows[0].kind === 'chat.message' && webRows[0].body === 'Olive sent you a message',
            `a member with no phone has the notice kept, with its words (${show(webRows.map(r => [r.kind, r.body]))})`);
        assert(rowsOf(ann).length === 1, 'a member with a phone has it too');
        assert(phones === 1 && sent.length === 1, `Expo is still asked to reach the one phone only (${phones}, ${sent.length} sent)`);
        assert(rowsOf(cat).length === 0, 'a member with that category off has none');
        assert(rowsOf(nemo).length === 0, 'a key that is no member here has none');
        assert(webRows.length === 1 && webRows[0].seen_at === null, 'it is kept unseen');

        // ── 2. The socket ──────────────────────────────────────────────────────────────────────────────────
        console.log('\n--- 2. The member\'s own sockets hear it at once ---');
        const heard = webSock.events.filter(e => e.type === 'push_notice');
        assert(heard.length === 1 && heard[0].id === webRows[0]?.id && heard[0].kind === 'chat.message',
            `the member's socket hears { type: 'push_notice', id, kind } (${show(heard)})`);
        assert(heard.length === 1 && Object.keys(heard[0]).sort().join(',') === 'id,kind,type', 'and nothing else: no words, no chat, no sender');
        const annHeard = annSock.events.filter(e => e.type === 'push_notice');
        assert(annHeard.length === 1 && annHeard[0].id === rowsOf(ann)[0]?.id, "another member's socket hears only their own notice");
        // An app from before the bell takes any event it doesn't know for a doorbell (an old phone: a full sync each).
        assert(!webOld.events.some(e => e.type === 'push_notice'), "the same member's socket from an app before the bell (no bell=1) hears nothing of it");

        // ── 3. The list ────────────────────────────────────────────────────────────────────────────────────
        console.log('\n--- 3. GET /api/notices/push: the signer\'s own ---');
        se.dispatchPushNotification([web.pk], owner.pk, '🤝 Request', 'Olive asked for your jam', { postId: 'p-jam' }, 'marketplace', 'market.request');
        await sleep(20);
        const mine = await list(web);
        assert(mine.status === 200 && mine.notices.length === 2 && mine.notices[0].kind === 'market.request' && mine.notices[1].kind === 'chat.message',
            `the member reads their notices, newest first (${mine.status} ${show(mine.notices.map(n => n.kind))})`);
        const first = mine.notices[1];
        assert(first && first.id === webRows[0]?.id && first.title === '💬 New Message' && first.body === 'Olive sent you a message'
            && first.data?.conversationId === conv.id && Number.isSafeInteger(first.sentAt) && first.seenAt === null,
            `each with its words, where a tap lands, when, and seenAt null (${show(first)})`);
        assert(/no-store/.test(mine.headers.get('cache-control') ?? ''), 'private, no-store');
        const annList = await list(ann);
        assert(annList.status === 200 && annList.notices.length === 1 && !annList.notices.some(n => mine.notices.some(m => m.id === n.id)),
            `another member reads only their own (${show(annList.notices.map(n => n.id))})`);
        assert((await list(web, `?publicKey=${ann.pk}`)).notices.every(n => mine.notices.some(m => m.id === n.id)), 'a key in the query changes nothing');
        assert((await list(null)).status === 401, 'unsigned: 401');
        assert((await list(nemo)).status === 403, 'a key that is no member here: 403');
        const again = await list(web, '?unseen=1');
        assert(again.notices.length === 2 && rowsOf(web).every(r => r.seen_at === null), 'reading the list marks nothing (opening the sheet clears nothing)');

        // ── 4. The mark ────────────────────────────────────────────────────────────────────────────────────
        console.log('\n--- 4. POST /api/notices/push/seen: the signer\'s own ids only ---');
        webSock.events.length = 0;
        const annId = rowsOf(ann)[0]?.id;
        const mark = await call('POST', web, '/api/notices/push/seen', { ids: [first?.id, annId, 'nope'] });
        assert(mark.status === 200 && mark.body?.marked === 1, `the member's own id is marked, and nothing else (${mark.status} ${show(mark.body)})`);
        assert(rowsOf(ann)[0]?.seen_at === null, "another member's notice stays unseen");
        const unseen = await list(web, '?unseen=1');
        assert(unseen.notices.length === 1 && unseen.notices[0].kind === 'market.request', `unseen=1 leaves it out (${show(unseen.notices.map(n => n.kind))})`);
        const full = await list(web);
        assert(full.notices.find(n => n.id === first?.id)?.seenAt > 0, 'the full list has it, with seenAt');
        assert((await call('POST', web, '/api/notices/push/seen', { ids: [first?.id] })).body?.marked === 0, 'marked once: again marks nothing');
        await sleep(50);
        const seenHeard = webSock.events.filter(e => e.type === 'push_notices_seen');
        assert(!webOld.events.some(e => e.type === 'push_notices_seen'), 'nor of the mark');
        assert(seenHeard.length === 1 && JSON.stringify(seenHeard[0].ids) === JSON.stringify([first?.id]),
            `the member's sockets hear which were marked, so every open app's count follows (${show(seenHeard)})`);
        for (const [body, why] of [[{}, 'no ids'], [{ ids: [] }, 'an empty list'], [{ ids: 'x' }, 'not a list'], [{ ids: Array(101).fill('a') }, 'more than 100'], [{ ids: [7] }, 'not a string']] as const) {
            assert((await call('POST', web, '/api/notices/push/seen', body)).status === 400, `${why}: 400`);
        }
        assert((await call('POST', null, '/api/notices/push/seen', { ids: [annId] })).status === 401, 'unsigned: 401');
        assert((await call('POST', nemo, '/api/notices/push/seen', { ids: [annId] })).status === 403, 'no member here: 403');
        assert(rowsOf(ann)[0]?.seen_at === null, 'and none of those marked anything');

        // ── 5. Opening the chat marks its rows ─────────────────────────────────────────────────────────────
        console.log('\n--- 5. Opening the chat takes its notices off the bell ---');
        const other = se.createConversation('dm', [web.pk, owner.pk], owner.pk)!;
        se.dispatchPushNotification([web.pk], ann.pk, '💬 New Message', 'Ann sent you a message', { screen: 'chat', conversationId: conv.id }, 'chat', 'chat.message');
        se.dispatchPushNotification([web.pk], owner.pk, '💬 New Message', 'Olive sent you a message', { screen: 'chat', conversationId: other.id }, 'chat', 'chat.message');
        const read = await call('POST', web, '/api/messages/mark-read', { conversationId: conv.id });
        const left = (await list(web, '?unseen=1')).notices;
        assert(read.status === 200 && !left.some(n => n.data?.conversationId === conv.id),
            `the chat's notices are marked when the member opens it (${read.status} ${show(left.map(n => n.data?.conversationId?.slice(0, 6)))})`);
        assert(left.some(n => n.data?.conversationId === other.id) && left.some(n => n.kind === 'market.request'), "another chat's notice, and the request, stay");

        // ── 6. The moderation notices fold in ──────────────────────────────────────────────────────────────
        console.log('\n--- 6. A moderation notice is a row, one with its alert ---');
        const cb = { broadcast: se.broadcast, dispatchPushNotification: se.dispatchPushNotification };
        mod.tell(cb as any, [web.pk], '🛡️ Your post was hidden', 'Your post "Jam" is hidden while the moderators look at it.', { kind: 'post_hidden', postId: 'p-1' });
        const kept1 = attempt(() => db.prepare("SELECT id FROM moderation_notices WHERE recipient = ? AND data LIKE '%p-1%'").get(web.pk) as any)?.id;
        const row1 = (await list(web, '?unseen=1')).notices.find(n => n.kind === 'community.notice' && n.data?.postId === 'p-1');
        assert(!!row1 && row1.data?.noticeId === kept1, `the moderation notice is a row on the bell, naming its alert's kept copy (${show(row1?.data)})`);
        const ack = await call('POST', web, '/api/notices/seen', { ids: [kept1] });
        assert(ack.status === 200 && !(await list(web, '?unseen=1')).notices.some(n => n.id === row1?.id),
            `acknowledging the alert takes the row off the bell (${ack.status})`);
        mod.tell(cb as any, [web.pk], '🛡️ Your report', 'The post you reported was reviewed and kept.', { kind: 'report_dismissed', postId: 'p-2' });
        const kept2 = attempt(() => db.prepare("SELECT id FROM moderation_notices WHERE recipient = ? AND data LIKE '%p-2%'").get(web.pk) as any)?.id;
        const row2 = (await list(web, '?unseen=1')).notices.find(n => n.kind === 'community.notice' && n.data?.postId === 'p-2');
        await call('POST', web, '/api/notices/push/seen', { ids: [row2?.id] });
        const keptRow = attempt(() => db.prepare('SELECT seen_at FROM moderation_notices WHERE id = ?').get(kept2) as any);
        assert(!!row2 && typeof keptRow?.seen_at === 'string', `a tap on the row marks the alert's kept copy, so the alert never shows after (${show(keptRow)})`);

        // ── 7. A standby ───────────────────────────────────────────────────────────────────────────────────
        console.log('\n--- 7. A standby reads, and refuses the mark ---');
        const before = JSON.stringify(rowsOf(web).map(r => [r.id, r.seen_at]));
        const target = (await list(web, '?unseen=1')).notices[0]?.id;
        se.setNodeRole('backup');
        try {
            const r = await list(web);
            const m = await call('POST', web, '/api/notices/push/seen', { ids: [target] });
            assert(r.status === 200 && Array.isArray(r.body?.notices), `a standby answers the read (${r.status})`);
            assert(m.status === 503 && m.body?.code === 'standby', `and refuses the mark: 503 standby (${m.status} ${show(m.body)})`);
        } finally {
            se.setNodeRole('primary');
        }
        assert(JSON.stringify(rowsOf(web).map(r => [r.id, r.seen_at])) === before, 'nothing was written');

        // ── 8. The bounds ──────────────────────────────────────────────────────────────────────────────────
        console.log('\n--- 8. At most 100, and nothing older than 7 days ---');
        const now = Math.floor(Date.now() / 1000);
        attempt(() => notices.keepPushNotices(Array.from({ length: 110 }, (_, i) => ({
            id: crypto.randomBytes(16).toString('hex'), recipient: web.pk, kind: 'market.request', title: `T${i}`, body: `B${i}`, data: {}, sentAt: now - 100 - i,
        }))));
        const oldId = crypto.randomBytes(16).toString('hex');
        attempt(() => notices.keepPushNotices([{ id: oldId, recipient: web.pk, kind: 'market.request', title: 'Old', body: 'Old', data: {}, sentAt: now - 8 * 86400 }]));
        const bounded = await list(web);
        assert(bounded.notices.length === 100, `the list holds at most 100, before any tidy (${bounded.notices.length})`);
        assert(!bounded.notices.some(n => n.id === oldId), 'nothing older than 7 days is listed');
        assert(bounded.notices.every((n, i, a) => i === 0 || a[i - 1].sentAt >= n.sentAt), 'newest first');
        attempt(() => notices.tidyPushNotices());
        assert(rowsOf(web).length === 100 && !rowsOf(web).some(r => r.id === oldId), `the hourly tidy keeps the newest 100 and drops the old (${rowsOf(web).length})`);

        // ── 9. One request to join, one row for its sharer ─────────────────────────────────────────────────
        // A request to join after a listing a member shared outside (shared-listing door A3, engine/knocks.ts
        // notifyKnockReceived): the sharer is told by their own notice instead of the plain one. On the bell that holds with
        // no phone too: an admin who shared it and has only the web app gets one row, as one with a phone gets one push.
        console.log('\n--- 9. A request to join after a shared listing: one row for its sharer, a phone or not ---');
        const knocks = await import('./engine/knocks.js');
        const sid = member('Sid'); // an admin, the web app only, who shared the listing
        db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'owner:password')").run(sid.pk);
        const ownerBefore = rowsOf(owner).filter(r => r.kind === 'community.knock').length;
        attempt(() => knocks.notifyKnockReceived(Date.now(), sid.pk));
        await sleep(100);
        const sidRows = rowsOf(sid);
        assert(sidRows.length === 1 && sidRows[0].kind === 'community.knock-shared',
            `the sharer, an admin with no phone, has one row, the shared one, not the plain one as well (${show(sidRows.map(r => r.kind))})`);
        assert(rowsOf(owner).filter(r => r.kind === 'community.knock').length === ownerBefore + 1, 'the owner has the plain one');

        // ── 10. Every kept notice that is pushed: its row and its alert clear together ─────────────────────────────
        // Review of #3006: only moderation's tell() named the kept copy, so for every other sender acknowledging the alert
        // left the row on the bell, and a tap on the row left the alert to show again at the next open. Each case below
        // sends one through the sender's own code; every case checks the row names its kept copy, and each clears it one
        // way (acknowledge the alert, or tap the row), so both ways are walked across the senders.
        console.log('\n--- 10. Every sender that keeps a notice and pushes it: the row and the alert clear together ---');
        const { keepNotice } = await import('./engine/kept-notices.js');
        const vouchers = await import('./engine/vouchers.js');
        const standing = await import('./engine/standing-deals.js');
        const de = await import('./decisions-engine.js');
        const { setDoor } = await import('./config/door.js');
        const { createCrowdfundProject, pledgeToProject } = await import('./db/db.js');
        const bea = member('Bea'); // the web app only: a voucher, a gift's recipient, a backer, an asker
        const rex = member('Rex'); // the web app only: the member a removal vote is about
        const hooks = { broadcast: se.broadcast, dispatchPushNotification: se.dispatchPushNotification };
        const KEPT_KINDS = new Set(['community.notice', 'community.invite-ask', 'account.removal-vote', 'account.reply-taken-down']);
        const keptOf = (id: Id) => attempt(() => db.prepare('SELECT id, seen_at FROM moderation_notices WHERE recipient = ? ORDER BY created_at, rowid').all(id.pk) as any[]) ?? [];
        const clearsTogether = async (label: string, who: Id, way: 'acknowledge' | 'tap', send: () => unknown) => {
            const rowsBefore = new Set(rowsOf(who).map(r => r.id));
            const keptBefore = new Set(keptOf(who).map(k => k.id));
            const outcome = await attempt(send);
            await sleep(50);
            const rows = rowsOf(who).filter(r => !rowsBefore.has(r.id) && KEPT_KINDS.has(r.kind));
            const kept = keptOf(who).filter(k => !keptBefore.has(k.id));
            const data = attempt(() => JSON.parse(rows[0]?.data ?? '{}')) ?? {};
            assert(rows.length === 1 && kept.length === 1 && data.noticeId === kept[0].id,
                `${label}: one row on the bell, naming the alert's kept copy (${show({ outcome, rows: rows.map(r => [r.kind, r.data]), kept: kept.map(k => k.id) })})`);
            if (way === 'acknowledge') {
                const ack = await call('POST', who, '/api/notices/seen', { ids: [kept[0]?.id] });
                const row = rowsOf(who).find(r => r.id === rows[0]?.id);
                assert(ack.status === 200 && !!row && row.seen_at !== null, `${label}: acknowledging the alert takes the row off the bell (${ack.status}, seen_at ${row?.seen_at})`);
            } else {
                const tap = await call('POST', who, '/api/notices/push/seen', { ids: [rows[0]?.id] });
                const k = keptOf(who).find(x => x.id === kept[0]?.id);
                assert(tap.status === 200 && typeof k?.seen_at === 'string', `${label}: a tap on the row marks the alert, which never shows again (${tap.status}, seen_at ${k?.seen_at})`);
            }
        };
        const voucherNotice = (data: Record<string, unknown>, title: string, body: string) =>
            vouchers.tellVoucherNotice({ to: bea.pk, title, body, data, id: keepNotice(bea.pk, title, body, data) }, hooks as any);
        for (const way of ['acknowledge', 'tap'] as const) {
            await clearsTogether(`a voucher's budget (${way})`, bea, way, () => voucherNotice({ kind: 'voucher_budget', change: 'made', level: 2 },
                'Your vouching budget', 'You can now vouch for members you know, up to 100 Beans each.'));
            // A credit gift's notice goes out the same way (routes/community.ts giveCreditLine's tell).
            await clearsTogether(`a credit gift (${way})`, bea, way, () => voucherNotice({ kind: 'credit_gift', amount: 20, from: owner.pk },
                'Credit given to you', 'Olive gave you 20 Beans of their credit line.'));
            await clearsTogether(`a standing deal (${way})`, bea, way, () => {
                const data = { kind: 'standing_started', standing: `sd-${way}`, postId: `p-sd-${way}` };
                const title = 'Your standing deal';
                const body = 'Olive took up your standing deal. The first period is held in trust.';
                standing.tellStanding(hooks as any, [{ to: bea.pk, title, body, data, id: keepNotice(bea.pk, title, body, data) }]);
            });
        }
        // Unfunded pledges, through the node's own return (state-engine.ts returnUnfundedProjectPledges, the minute tick's).
        se.payFromCommons(bea.pk, 50, 'Beans to pledge', { allowDeficit: true } as any);
        const project = crypto.randomUUID();
        createCrowdfundProject(project, owner.pk, 'Seed Library', 'Seeds for the valley', [], 100, new Date(Date.now() + 5 * DAY).toISOString());
        pledgeToProject(crypto.randomUUID(), project, bea.pk, 10, 'Project Pledge');
        const over = new Date(Date.now() - 8 * DAY).toISOString();
        db.prepare('UPDATE members SET deadline_at = ? WHERE public_key = ?').run(over, project);
        db.prepare('UPDATE projects SET deadline_at = ? WHERE id = ?').run(over, project);
        await clearsTogether('unfunded pledges returned', bea, 'tap', () => se.returnUnfundedProjectPledges());
        // An invite ask answered, over HTTP as both apps answer it.
        setDoor('admins');
        const ask = async () => {
            const made = await call('POST', bea, '/api/invite/asks', { firstName: 'Joan', howKnown: 'From the garden club' });
            const askId = attempt(() => (db.prepare('SELECT id FROM invite_asks WHERE asker_pubkey = ? ORDER BY asked_at DESC LIMIT 1').get(bea.pk) as any)?.id);
            const no = await call('POST', owner, `/api/invite/asks/${askId}/no`, { reason: 'We are full this month' });
            return { made: made.status, no: no.status };
        };
        await clearsTogether('an invite ask answered (acknowledge)', bea, 'acknowledge', ask);
        await clearsTogether('an invite ask answered (tap)', bea, 'tap', ask);
        // A removal vote, its reply taken down, and an owner's decision on it (decisions-engine.ts, with the node's push).
        let vote: any;
        await clearsTogether('a removal vote opened', rex, 'acknowledge', () => {
            db.transaction(() => { vote = de.pauseMember(se.getMember(rex.pk)!, owner.pk, 'Sent threats in the market chat', { actor: owner.pk, how: 'suspended' }); })();
            de.announcePause(vote);
            return vote?.id;
        });
        const replied = attempt(() => de.replyToRemovalCase(vote?.id, rex.pk, 'I did not send threats. Please read the whole chat first.'));
        assert(replied?.success === true, `(the member replies to the case: ${show(replied)})`);
        await clearsTogether('a reply taken down', rex, 'tap', () => de.adminHideReply(vote?.id, owner.pk, 'It names another member and where they live'));
        // An owner decides only a vote too few could vote on (fewer than 3 active in 30 days, decisions-engine.ts
        // QUORUM_FLOOR): a community where nobody but the owner has been active of late, as this suite's signed requests
        // made every member here.
        db.prepare('UPDATE members SET last_active_at = NULL WHERE public_key != ?').run(owner.pk);
        await clearsTogether("an owner's decision", rex, 'acknowledge', () => de.ownerDecideTooFew(vote?.id, owner.pk, 'Too few members could vote, so I decided it'));

        // ── 11. A tap on a phone notification ──────────────────────────────────────────────────────────────────────
        console.log('\n--- 11. A tap on a phone notification takes its row off the bell ---');
        annSock.events.length = 0;
        se.dispatchPushNotification([ann.pk], owner.pk, '🤝 Request', 'Olive asked for your honey', { postId: 'p-honey' }, 'marketplace', 'market.request');
        await sleep(20);
        const tapped = rowsOf(ann)[0];
        const seenOf = (id: string | undefined) => rowsOf(ann).find(r => r.id === id)?.seen_at;
        const byOther = await call('GET', web, `/api/notices/push/${tapped?.id}`);
        assert(tapped?.kind === 'market.request' && byOther.status === 404 && seenOf(tapped?.id) === null, `another member's read of it is a 404 and marks nothing (${byOther.status})`);
        se.setNodeRole('backup');
        try {
            await call('GET', ann, `/api/notices/push/${tapped?.id}`);
        } finally {
            se.setNodeRole('primary');
        }
        assert(seenOf(tapped?.id) === null, "a standby's read marks nothing (its copy follows the main server's)");
        const opened = await call('GET', ann, `/api/notices/push/${tapped?.id}`);
        assert(opened.status === 200 && opened.body?.id === tapped?.id && typeof seenOf(tapped?.id) === 'number',
            `the tap reads its details (followTap), and its row leaves the bell (${opened.status}, seen_at ${seenOf(tapped?.id)})`);
        await sleep(50);
        assert(annSock.events.some(e => e.type === 'push_notices_seen' && Array.isArray(e.ids) && e.ids.includes(tapped?.id)),
            `the member's open apps hear it, so the bell's count follows (${show(annSock.events.map(e => e.type))})`);
        mod.tell(cb as any, [ann.pk], '🛡️ Your post was hidden', 'Your post "Honey" is hidden while the moderators look at it.', { kind: 'post_hidden', postId: 'p-3' });
        const keptAnn = attempt(() => db.prepare("SELECT id FROM moderation_notices WHERE recipient = ? AND data LIKE '%p-3%'").get(ann.pk) as any)?.id;
        const modRow = rowsOf(ann).find(r => r.kind === 'community.notice' && (attempt(() => JSON.parse(r.data)) ?? {}).postId === 'p-3');
        await call('GET', ann, `/api/notices/push/${modRow?.id}`);
        const keptAnnRow = attempt(() => db.prepare('SELECT seen_at FROM moderation_notices WHERE id = ?').get(keptAnn) as any);
        assert(!!modRow && typeof seenOf(modRow.id) === 'number' && typeof keptAnnRow?.seen_at === 'string',
            `a moderation notice tapped on the phone: its row off the bell and its alert marked (${show(keptAnnRow)})`);

        // ── 12. "Clear all" (Marty, 10 Nov 2026) ───────────────────────────────────────────────────────────────────────
        console.log('\n--- 12. POST /api/notices/push/seen { all: true }: every notice of the signer\'s own, and no one else\'s ---');
        const dot = member('Dot');
        const eve = member('Eve');
        const dotSock = await socket(dot);
        await sleep(50);
        se.dispatchPushNotification([dot.pk], owner.pk, '💬 New Message', 'Olive sent you a message', { screen: 'chat', conversationId: other.id }, 'chat', 'chat.message');
        se.dispatchPushNotification([dot.pk], owner.pk, '🤝 Request', 'Olive asked for your jam', { postId: 'p-jam' }, 'marketplace', 'market.request');
        mod.tell(cb as any, [dot.pk], '🛡️ Your post was hidden', 'Your post "Tea" is hidden while the moderators look at it.', { kind: 'post_hidden', postId: 'p-4' });
        se.dispatchPushNotification([eve.pk], owner.pk, '🤝 Request', 'Olive asked for your honey', { postId: 'p-honey' }, 'marketplace', 'market.request');
        se.dispatchPushNotification([eve.pk], owner.pk, '💬 New Message', 'Olive sent you a message', { screen: 'chat', conversationId: other.id }, 'chat', 'chat.message');
        await sleep(50);
        const unseenOf = (id: Id) => rowsOf(id).filter(r => r.seen_at === null).length;
        const dotKept = attempt(() => db.prepare("SELECT id, seen_at FROM moderation_notices WHERE recipient = ? AND data LIKE '%p-4%'").get(dot.pk) as any);
        assert(unseenOf(dot) === 3 && unseenOf(eve) === 2 && !!dotKept && dotKept.seen_at === null, `set up: Dot has 3 unseen (one a moderation notice), Eve 2 (${unseenOf(dot)}, ${unseenOf(eve)})`);
        const annUnseenBefore = unseenOf(ann);
        const webUnseenBefore = unseenOf(web);

        assert((await call('POST', null, '/api/notices/push/seen', { all: true })).status === 401, 'unsigned: 401');
        assert((await call('POST', nemo, '/api/notices/push/seen', { all: true })).status === 403, 'a key that is no member here: 403');
        for (const [body, why] of [[{ all: false }, 'all: false'], [{ all: 'yes' }, 'all as a string'], [{ all: 1 }, 'all as a number'], [{ all: true, ids: [rowsOf(dot)[0]?.id] }, 'all with ids beside it'], [{ all: null }, 'all: null']] as const) {
            assert((await call('POST', dot, '/api/notices/push/seen', body)).status === 400, `${why}: 400`);
        }
        assert(unseenOf(dot) === 3, 'and none of those marked anything');
        se.setNodeRole('backup');
        try {
            const m = await call('POST', dot, '/api/notices/push/seen', { all: true });
            assert(m.status === 503 && m.body?.code === 'standby', `a standby refuses it: 503 standby (${m.status} ${show(m.body)})`);
        } finally {
            se.setNodeRole('primary');
        }
        assert(unseenOf(dot) === 3, 'and writes nothing');

        // Only the signer's own: a body that names another member's key is refused by the middleware (403, identity mismatch)
        // and marks nothing; Eve clearing all leaves Dot's, Ann's and Wes's rows unseen.
        const named = await call('POST', eve, '/api/notices/push/seen', { all: true, publicKey: dot.pk });
        assert(named.status === 403 && unseenOf(dot) === 3 && unseenOf(eve) === 2, `a body naming another member's key is refused and marks nothing (${named.status})`);
        const eveClear = await call('POST', eve, '/api/notices/push/seen', { all: true });
        assert(eveClear.status === 200 && eveClear.body?.marked === 2 && /no-store/.test(eveClear.headers.get('cache-control') ?? ''),
            `Eve clears all of hers: 2 marked, private, no-store (${eveClear.status} ${show(eveClear.body)})`);
        assert(unseenOf(eve) === 0 && unseenOf(dot) === 3 && unseenOf(ann) === annUnseenBefore && unseenOf(web) === webUnseenBefore,
            `and no one else's changes (Dot ${unseenOf(dot)}, Ann ${unseenOf(ann)}/${annUnseenBefore}, Wes ${unseenOf(web)}/${webUnseenBefore})`);

        dotSock.events.length = 0;
        const dotClear = await call('POST', dot, '/api/notices/push/seen', { all: true });
        assert(dotClear.status === 200 && dotClear.body?.success === true && dotClear.body?.marked === 3, `Dot clears all: 3 marked (${dotClear.status} ${show(dotClear.body)})`);
        assert((await list(dot, '?unseen=1')).notices.length === 0, 'their unseen list is empty, so the red count is 0');
        const dotFull = await list(dot);
        assert(dotFull.notices.length === 3 && dotFull.notices.every(n => n.seenAt > 0), 'the full list still has the three, each with seenAt (cleared, not deleted)');
        const dotKeptAfter = attempt(() => db.prepare('SELECT seen_at FROM moderation_notices WHERE id = ?').get(dotKept?.id) as any);
        assert(typeof dotKeptAfter?.seen_at === 'string', `the moderation notice\'s alert is marked with its row, as a tap does (${show(dotKeptAfter)})`);
        await sleep(50);
        const dotHeard = dotSock.events.filter(e => e.type === 'push_notices_seen');
        assert(dotHeard.length === 1 && dotHeard[0].ids.length === 3 && dotHeard[0].ids.every((id: string) => dotFull.notices.some(n => n.id === id)),
            `their sockets hear one push_notices_seen with the three ids, so every device's count follows (${show(dotHeard)})`);
        assert((await call('POST', dot, '/api/notices/push/seen', { all: true })).body?.marked === 0, 'clearing again marks nothing');
        await sleep(50);
        assert(dotSock.events.filter(e => e.type === 'push_notices_seen').length === 1, 'and tells no one');
        se.dispatchPushNotification([dot.pk], owner.pk, '🤝 Request', 'Olive asked for your milk', { postId: 'p-milk' }, 'marketplace', 'market.request');
        await sleep(30);
        const afterClear = (await list(dot, '?unseen=1')).notices;
        assert(afterClear.length === 1 && afterClear[0].data?.postId === 'p-milk', 'a notice kept after the clear is on the bell');
        dotSock.ws.close();

        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ Notice bell checks PASSED.');
    } finally {
        (globalThis as any).fetch = realFetch;
        webSock.ws.close();
        webOld.ws.close();
        annSock.ws.close();
    }
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
