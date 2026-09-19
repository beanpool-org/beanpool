/**
 * Moderation and dispute notices tell the right people, in words, and never carry an admin's key.
 *
 * Found by the node-manual review (#945, "Things operators may push back on" #5 and #6):
 *   - a dispute ruling's push read "Dispute arbitrated by admin (<64-hex key>)" or "(owner:password)", and so
 *     did the chat line and the ledger memos both parties read;
 *   - a takedown told nobody: not the author, not the members who reported the post;
 *   - the reports list could not be filtered by outcome, did not name the reported post's author, and a
 *     removed post's other open reports stayed in the pending count.
 *
 * Signed member sockets and a stranger socket on the real server, pushes caught at the Expo fetch, the admin
 * routes mounted with a stand-in auth check:
 *   1. a ruling by password names "a community admin"; a ruling from a key session names the callsign; no
 *      push, chat line, memo or live event a party receives carries a 64-hex key or "owner:password"
 *   2. a report actioned with deletePost: the author and each reporter get exactly their notice, nobody else
 *      gets one; no reporter learns another reporter, the author never learns who reported
 *   3. a dismissed post report tells its reporter the post was kept, once; the author hears nothing
 *   4. a plain admin delete also tells the author and closes the post's open reports; Marketplace
 *      notifications off means no push, and the live notice still arrives
 *   5. GET /api/local/admin/reports filters open / dismissed / actioned, counts open reports only, and keeps
 *      every field old callers read
 *   6. a report dismissed after the author took the post down does not tell the reporter it was "kept"
 *   7. Prune Stale Posts sends each author ONE notice with the count, worded as tidying, never as a takedown
 *   8. the member-visible enterprise ledger names an arbitrated deal's signer in words, never as a key or
 *      "owner:password"; the transactions column keeps the signer
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-moderation-notifications.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import Koa from 'koa';
import WebSocket from 'ws';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const HEX_KEY = /[0-9a-f]{64}/i;

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string };
function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}
function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

type Sock = { ws: WebSocket; events: any[]; raw: string[] };
function open(url: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [], raw: [] };
        ws.on('message', (d) => { s.raw.push(d.toString()); try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('unexpected-response', (_q, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
        ws.on('error', reject);
    });
}
const clear = (...ss: Sock[]) => { for (const s of ss) { s.events.length = 0; s.raw.length = 0; } };
const notices = (s: Sock) => s.events.filter(e => e.type === 'system_announcement');

async function main() {
    console.log('Moderation and dispute notices...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { createAdminRoutes } = await import('./routes/admin.js');
    const mod = await import('./engine/moderation-notices.js');

    await initTls();
    se.initStateEngine();
    const port = await freePort();
    await startHttpsServer(port);
    const base = `wss://localhost:${port}`;

    const member = (callsign: string): Id => {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed', '/uploads/avatar.jpg')`).run(id.pubKeyHex, callsign);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token, platform) VALUES (?, ?, 'android')`)
            .run(id.pubKeyHex, `ExponentPushToken[${callsign}]`);
        return id;
    };
    const Ann = member('AnnAuthor'), R1 = member('RitaReporter'), R2 = member('RobReporter'), C = member('CarlBystander');
    const Buyer = member('BeaBuyer'), Seller = member('SamSeller');
    const Warden = member('WardenAdmin');
    db.prepare(`INSERT OR IGNORE INTO node_roles (member_pubkey, role) VALUES (?, 'admin')`).run(Warden.pubKeyHex);
    for (const id of [Ann, Buyer, Seller]) se.transfer('genesis', id.pubKeyHex, 300, 'seed', 'direct', true);
    const who = new Map([Ann, R1, R2, C, Buyer, Seller, Warden].map(id => [`ExponentPushToken[${id.callsign}]`, id.callsign]));

    // Pushes, caught where they leave for Expo.
    const realFetch = globalThis.fetch;
    const sent: any[] = [];
    (globalThis as any).fetch = async (url: any, init: any) => {
        if (String(url).includes('exp.host')) {
            sent.push(...JSON.parse(init.body));
            return { ok: true, status: 200, json: async () => ({}) } as any;
        }
        return realFetch(url, init);
    };
    const pushesTo = (id: Id) => sent.filter(m => who.get(m.to) === id.callsign);
    const flush = async () => { await new Promise(r => setImmediate(r)); await sleep(250); };

    // The admin routes, with a stand-in for checkAdminAuth: a password caller, or Warden's key session.
    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.method === 'POST') {
            const raw = await new Promise<string>((resolve) => {
                let data = '';
                ctx.req.on('data', (c) => { data += c; });
                ctx.req.on('end', () => resolve(data));
            });
            try { (ctx as any).requestBody = JSON.parse(raw || '{}'); } catch { (ctx as any).requestBody = {}; }
        }
        await next();
    });
    const checkAdminAuth = async (ctx: any): Promise<boolean> => {
        if (ctx.headers['x-admin-password'] === 'pw') return true;
        if (ctx.headers['x-admin-session'] === 'warden') {
            ctx.state.actor = Warden.pubKeyHex; ctx.state.auth_signer = Warden.pubKeyHex; ctx.state.adminRole = 'admin';
            return true;
        }
        ctx.status = 401; ctx.body = { error: 'Unauthorized' };
        return false;
    };
    const router = createAdminRoutes({
        checkAdminAuth, rateLimit: () => true,
        clampLimit: (v: any, def = 50) => typeof v === 'number' ? v : Number(v) || def,
        clampOffset: (v: any) => Math.max(0, Number(v) || 0),
        activeConnections: new Map(), calculateAnalytics: () => ({}) as any, enforceReadAuth: false,
    } as any);
    app.use(router.routes());
    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, r));
    const adminBase = `http://localhost:${(server.address() as any).port}`;
    const admin = async (method: string, path: string, body?: any, as: 'pw' | 'warden' = 'pw') => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (as === 'pw') headers['x-admin-password'] = 'pw'; else headers['x-admin-session'] = 'warden';
        const res = await realFetch(`${adminBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) as any };
    };

    const socks = {
        Ann: await open(`${base}/ws?${signedWsQuery(Ann)}`),
        R1: await open(`${base}/ws?${signedWsQuery(R1)}`),
        R2: await open(`${base}/ws?${signedWsQuery(R2)}`),
        C: await open(`${base}/ws?${signedWsQuery(C)}`),
        Buyer: await open(`${base}/ws?${signedWsQuery(Buyer)}`),
        Seller: await open(`${base}/ws?${signedWsQuery(Seller)}`),
        stranger: await open(`${base}/ws`),
    };
    const all = Object.values(socks);
    await sleep(150);

    try {
        // ── 1. A dispute ruling ──────────────────────────────────────────────────────────────────
        console.log('— 1. a dispute ruling names who ruled in words —');
        se.createPost('offer', 'services', 'Weeding', 'weeds', 10, 'fixed', Buyer.pubKeyHex);
        const stuck = () => {
            const post = se.createPost('offer', 'goods', `Firewood ${crypto.randomBytes(3).toString('hex')}`, 'dry', 40, 'fixed', Seller.pubKeyHex)!;
            return se.acceptPost(post.id, Buyer.pubKeyHex)!;
        };
        const partyText = (txId: string, postId: string) => {
            const memos = (db.prepare(`SELECT memo FROM transactions WHERE from_pubkey = ? OR to_pubkey = ?`).all(`escrow_${txId}`, `escrow_${txId}`) as any[]).map(r => r.memo);
            const lines = (db.prepare(`SELECT m.ciphertext, m.metadata FROM messages m WHERE m.system_type = 'ESCROW_DISPUTE_RESOLVED' AND m.metadata LIKE ?`).all(`%${txId}%`) as any[]);
            return { memos, lines, postId };
        };

        const tx1 = stuck();
        await flush(); sent.length = 0; clear(...all);
        se.resolveEscrowDispute(tx1.id, 'split', 'owner:password');
        await flush();
        const p1 = [...pushesTo(Buyer), ...pushesTo(Seller)].filter(m => /Dispute/.test(m.title));
        assert(p1.length === 2, `both parties get the ruling push (got ${p1.length})`);
        assert(p1.every(m => !m.body.includes('owner:password') && !HEX_KEY.test(m.body)), 'a password ruling push carries no key and no "owner:password"');
        assert(p1.every(m => m.body.includes('a community admin')), `and says "a community admin" (${p1[0]?.body})`);
        const t1 = partyText(tx1.id, '');
        assert(t1.memos.filter(Boolean).some(m => /Dispute arbitrated by a community admin/.test(m)), 'the ledger memo the parties read says "a community admin"');
        assert(t1.memos.every(m => !String(m).includes('owner:password')), 'no ledger memo carries "owner:password"');
        assert(t1.lines.length > 0 && t1.lines.every(l => !String(l.ciphertext).includes('owner:password') && !String(l.metadata).includes('owner:password')),
            'the chat line and its metadata carry no "owner:password"');
        for (const [name, s] of [['buyer', socks.Buyer], ['seller', socks.Seller]] as const) {
            assert(s.events.some(e => e.type === 'dispute_resolved' && e.resolvedBy === 'a community admin'), `the ${name}'s live ruling says who ruled in words`);
            assert(!s.raw.some(r => r.includes('owner:password')), `the ${name}'s socket never sees "owner:password"`);
        }

        const tx2 = stuck();
        await flush(); sent.length = 0; clear(...all);
        const res2 = await admin('POST', `/api/local/admin/disputes/${tx2.id}/resolve`, { action: 'release_to_seller' }, 'warden');
        assert(res2.status === 200, `a key-session admin resolves through the route (${res2.status})`);
        await flush();
        const p2 = [...pushesTo(Buyer), ...pushesTo(Seller)].filter(m => /Dispute/.test(m.title));
        assert(p2.length === 2 && p2.every(m => m.body.includes('WardenAdmin')), `a key-session ruling names the admin's callsign (${p2[0]?.body})`);
        assert(p2.every(m => !HEX_KEY.test(m.body) && !m.body.includes(Warden.pubKeyHex)), 'and carries no 64-hex key');
        const t2 = partyText(tx2.id, '');
        assert(t2.memos.every(m => !String(m).includes(Warden.pubKeyHex)), "no ledger memo carries the admin's key");
        assert(t2.lines.length > 0 && t2.lines.every(l => !String(l.ciphertext).includes(Warden.pubKeyHex) && !String(l.metadata).includes(Warden.pubKeyHex)),
            "the chat line and its metadata carry no admin key");
        for (const [name, s] of [['buyer', socks.Buyer], ['seller', socks.Seller]] as const) {
            assert(!s.raw.some(r => r.includes(Warden.pubKeyHex)), `the ${name}'s socket never sees the admin's key`);
        }
        const audit = db.prepare('SELECT dispute_resolved_by FROM marketplace_transactions WHERE id = ?').get(tx2.id) as any;
        assert(audit?.dispute_resolved_by === Warden.pubKeyHex, 'the audit column still records the signer');

        // ── 2. A report actioned with deletePost ─────────────────────────────────────────────────
        console.log('\n— 2. a takedown after reports —');
        const P_TITLE = `Miracle cure ${crypto.randomBytes(3).toString('hex')}`;
        const P = se.createPost('offer', 'goods', P_TITLE, 'buy now', 5, 'fixed', Ann.pubKeyHex)!;
        const rep1 = se.submitReport(R1.pubKeyHex, Ann.pubKeyHex, 'Spam or scam', P.id)!;
        const rep2 = se.submitReport(R2.pubKeyHex, Ann.pubKeyHex, 'Misleading post', P.id)!;
        const openBefore = se.getReports('pending').pendingCount;
        await flush(); sent.length = 0; clear(...all);

        const act = await admin('POST', `/api/local/admin/reports/${rep1.id}/action`, { deletePost: true, reasonCategory: 'spam' });
        assert(act.status === 200 && act.body?.success === true, 'the report action route removes the post');
        await flush();

        const annP = pushesTo(Ann), r1P = pushesTo(R1), r2P = pushesTo(R2);
        assert(annP.length === 1 && annP[0].title === mod.POST_REMOVED_TITLE, `the author gets exactly one push (${annP.length})`);
        assert(annP[0]?.body === `Your post "${P_TITLE}" was removed by the community's admins. Reason: spam or a scam.`,
            `saying what was removed, by whom in words, and why (${annP[0]?.body})`);
        assert(annP[0]?.channelId === 'marketplace', 'on the marketplace channel, so the Marketplace preference applies');
        assert(r1P.length === 1 && r1P[0].body === mod.reportedPostRemovedBody(), 'the first reporter gets exactly "the post you reported was removed"');
        assert(r2P.length === 1 && r2P[0].body === mod.reportedPostRemovedBody(), 'so does the second reporter, whose report it also closed');
        for (const id of [C, Warden, Buyer, Seller]) assert(pushesTo(id).length === 0, `${id.callsign} gets no push`);

        for (const [name, s, kind] of [['author', socks.Ann, 'post_removed'], ['reporter 1', socks.R1, 'report_outcome'], ['reporter 2', socks.R2, 'report_outcome']] as const) {
            const n = notices(s);
            assert(n.length === 1 && n[0].kind === kind && n[0].postId === P.id, `the ${name} gets exactly one live ${kind} notice`);
        }
        for (const [name, s] of [['a bystander', socks.C], ['the buyer', socks.Buyer], ['a stranger', socks.stranger]] as const) {
            assert(notices(s).length === 0, `${name} gets no live notice`);
        }
        // Nobody learns who reported, or who else did.
        const annSees = [...socks.Ann.raw, ...annP.map(m => JSON.stringify(m))].join('\n');
        for (const r of [R1, R2]) {
            assert(!annSees.includes(r.pubKeyHex) && !annSees.includes(r.callsign), `the author never learns that ${r.callsign} reported`);
        }
        const r1Sees = [...socks.R1.raw, ...r1P.map(m => JSON.stringify(m))].join('\n');
        const r2Sees = [...socks.R2.raw, ...r2P.map(m => JSON.stringify(m))].join('\n');
        assert(!r1Sees.includes(R2.pubKeyHex) && !r1Sees.includes(R2.callsign), 'reporter 1 never learns about reporter 2');
        assert(!r2Sees.includes(R1.pubKeyHex) && !r2Sees.includes(R1.callsign), 'reporter 2 never learns about reporter 1');
        const statuses = db.prepare('SELECT status FROM abuse_reports WHERE id IN (?, ?)').all(rep1.id, rep2.id) as any[];
        assert(statuses.every(r => r.status === 'actioned'), 'both reports on the removed post are closed as actioned');
        assert(se.getReports('pending').pendingCount === openBefore - 2, 'and neither counts as open any more');

        // Actioning the same report again tells nobody anything new.
        sent.length = 0; clear(...all);
        await admin('POST', `/api/local/admin/reports/${rep1.id}/action`, { deletePost: true });
        await flush();
        assert(sent.length === 0 && notices(socks.Ann).length === 0, 'repeating the action on a removed post sends nothing');

        // ── 3. A dismissed post report ───────────────────────────────────────────────────────────
        console.log('\n— 3. a dismissed report —');
        const Q = se.createPost('offer', 'goods', 'Honest honey', 'jars', 8, 'fixed', Ann.pubKeyHex)!;
        const rep3 = se.submitReport(R1.pubKeyHex, Ann.pubKeyHex, 'Other', Q.id)!;
        const memberReport = se.submitReport(R2.pubKeyHex, C.pubKeyHex, 'rude in chat')!;
        // The phone app files an enterprise report with the enterprise's key where a post id would go.
        const entReport = se.submitReport(R1.pubKeyHex, C.pubKeyHex, 'odd enterprise', C.pubKeyHex)!;
        await flush(); sent.length = 0; clear(...all);
        const dis = await admin('POST', `/api/local/admin/reports/${rep3.id}/dismiss`);
        assert(dis.status === 200, 'the dismiss route answers 200');
        await flush();
        assert(pushesTo(R1).length === 1 && pushesTo(R1)[0].body === mod.reportedPostKeptBody(), 'the reporter hears the post was reviewed and kept');
        assert(notices(socks.R1).length === 1 && notices(socks.R1)[0].outcome === 'kept', 'live, as well');
        assert(pushesTo(Ann).length === 0 && notices(socks.Ann).length === 0, 'the author hears nothing about a report that was dismissed');
        assert(sent.length === 1, `nobody else is pushed (${sent.length})`);
        sent.length = 0;
        await admin('POST', `/api/local/admin/reports/${rep3.id}/dismiss`);
        await flush();
        assert(sent.length === 0, 'dismissing it again sends nothing');
        clear(...all);
        await admin('POST', `/api/local/admin/reports/${entReport.id}/dismiss`);
        await flush();
        assert(sent.length === 0 && notices(socks.R1).length === 0, 'dismissing a report that names no real post says nothing about "the post you reported"');

        // ── 4. A plain admin delete, and the preference ──────────────────────────────────────────
        console.log('\n— 4. a plain admin delete —');
        const Z = se.createPost('offer', 'goods', 'Knock-off watches', 'cheap', 3, 'fixed', Ann.pubKeyHex)!;
        const rep4 = se.submitReport(R2.pubKeyHex, Ann.pubKeyHex, 'Spam or scam', Z.id)!;
        db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_marketplace', 'false')`).run(R2.pubKeyHex);
        await flush(); sent.length = 0; clear(...all);
        const del = await admin('POST', `/api/local/admin/posts/${Z.id}/delete`, { reasonCategory: 'not-a-category' });
        assert(del.status === 200, 'the post delete route answers 200');
        await flush();
        assert(pushesTo(Ann).length === 1 && pushesTo(Ann)[0].body === 'Your post "Knock-off watches" was removed by the community\'s admins.',
            `the author is told, and an unknown reason category is left out (${pushesTo(Ann)[0]?.body})`);
        assert(pushesTo(R2).length === 0, 'a reporter with Marketplace notifications off gets no push');
        assert(notices(socks.R2).length === 1 && notices(socks.R2)[0].outcome === 'removed', 'but still gets the live notice');
        assert((db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(rep4.id) as any).status === 'actioned', 'the open report on it is closed');
        db.prepare(`DELETE FROM member_preferences WHERE public_key = ? AND pref_key = 'notify_marketplace'`).run(R2.pubKeyHex);

        // ── 5. The reports list API ──────────────────────────────────────────────────────────────
        console.log('\n— 5. the reports list —');
        const count = (sql: string) => (db.prepare(`SELECT COUNT(*) AS c FROM abuse_reports WHERE ${sql}`).get() as any).c as number;
        const nOpen = count("status = 'pending' OR status IS NULL"), nDismissed = count("status = 'reviewed'"), nActioned = count("status = 'actioned'");
        assert(nOpen >= 1 && nDismissed >= 1 && nActioned >= 3, `the fixtures hold every outcome (${nOpen}/${nDismissed}/${nActioned})`);

        const allList = await admin('GET', '/api/local/admin/reports');
        assert(allList.status === 200, 'the list answers 200');
        for (const k of ['success', 'reports', 'total', 'pendingCount', 'limit', 'offset']) {
            assert(k in (allList.body || {}), `the response still has "${k}"`);
        }
        assert(allList.body.total === nOpen + nDismissed + nActioned, 'with no filter it lists every report, as before');
        for (const [status, n, outcome] of [['open', nOpen, 'open'], ['dismissed', nDismissed, 'dismissed'], ['actioned', nActioned, 'actioned'],
            ['pending', nOpen, 'open'], ['reviewed', nDismissed, 'dismissed']] as const) {
            const r = await admin('GET', `/api/local/admin/reports?status=${status}`);
            assert(r.body.total === n && r.body.reports.every((x: any) => x.outcome === outcome), `status=${status} lists the ${n} ${outcome} report(s)`);
            assert(r.body.pendingCount === nOpen, `status=${status}: pendingCount counts open reports only (${r.body.pendingCount})`);
        }
        const bogus = await admin('GET', '/api/local/admin/reports?status=bogus');
        assert(bogus.body.total === allList.body.total, 'an unknown status falls back to every report');

        const row = allList.body.reports.find((x: any) => x.id === rep2.id);
        const OLD_FIELDS = ['id', 'reporterPubkey', 'targetPubkey', 'targetPostId', 'reason', 'createdAt', 'status', 'reporterCallsign', 'targetCallsign', 'postTitle', 'pulseItem'];
        assert(Boolean(row) && OLD_FIELDS.every(k => k in row), 'every field old callers read is still there');
        assert(row.status === 'actioned' && row.targetPostId === P.id && row.postTitle === P_TITLE && row.reporterPubkey === R2.pubKeyHex
            && row.targetCallsign === 'AnnAuthor' && row.reporterCallsign === 'RobReporter', 'with the same values');
        assert(row.postId === P.id && row.postAuthorCallsign === 'AnnAuthor' && row.postRemoved === true, 'and the new postId, postAuthorCallsign and postRemoved');
        const live = (await admin('GET', '/api/local/admin/reports?status=dismissed')).body.reports.find((x: any) => x.id === rep3.id);
        assert(live?.postRemoved === false && live?.postId === Q.id, 'a kept post reads postRemoved: false');
        const mem = allList.body.reports.find((x: any) => x.id === memberReport.id);
        assert(mem?.postId === null && mem?.postAuthorCallsign === null && mem?.postRemoved === null, 'a member report has no post fields');
        const ent = allList.body.reports.find((x: any) => x.id === entReport.id);
        assert(ent?.targetPostId === C.pubKeyHex && ent?.postId === null && ent?.postRemoved === null,
            'an enterprise report keeps its old targetPostId but reads as no post');

        // ── 6. A report dismissed after the author took the post down ────────────────────────────
        console.log('\n— 6. a dismissed report on a post its author already took down —');
        const G = se.createPost('offer', 'goods', 'Gone garlic', 'bulbs', 4, 'fixed', Ann.pubKeyHex)!;
        const rep6 = se.submitReport(R1.pubKeyHex, Ann.pubKeyHex, 'Other', G.id)!;
        assert(se.removePost(G.id, Ann.pubKeyHex) === true, 'the author deletes their own post');
        await flush(); sent.length = 0; clear(...all);
        await admin('POST', `/api/local/admin/reports/${rep6.id}/dismiss`);
        await flush();
        assert(pushesTo(R1).length === 1 && pushesTo(R1)[0].body === mod.reportedPostGoneBody(),
            `the reporter hears the post is no longer up (${pushesTo(R1)[0]?.body})`);
        assert(!sent.some(m => m.body === mod.reportedPostKeptBody()), 'and is never told it was "reviewed and kept"');
        assert(notices(socks.R1).length === 1 && notices(socks.R1)[0].outcome === 'gone' && !('screen' in notices(socks.R1)[0]),
            'the live notice says gone, and opens no listing');
        assert(pushesTo(Ann).length === 0, 'the author hears nothing');

        // ── 7. Prune Stale Posts ─────────────────────────────────────────────────────────────────
        console.log('\n— 7. Prune Stale Posts —');
        const oldAt = new Date(Date.now() - 100 * 86_400_000 - 3_600_000).toISOString();
        const annOld = Array.from({ length: 15 }, (_, i) => se.createPost('offer', 'goods', `Old jar ${i}`, 'old', 2, 'fixed', Ann.pubKeyHex)!.id);
        const samOld = Array.from({ length: 2 }, (_, i) => se.createPost('offer', 'goods', `Old crate ${i}`, 'old', 2, 'fixed', Seller.pubKeyHex)!.id);
        const setAge = db.prepare('UPDATE posts SET created_at = ? WHERE id = ?');
        for (const id of [...annOld, ...samOld]) setAge.run(oldAt, id);
        const rep7 = se.submitReport(R2.pubKeyHex, Ann.pubKeyHex, 'Spam or scam', annOld[0])!;
        const rep7b = se.submitReport(R2.pubKeyHex, Seller.pubKeyHex, 'Spam or scam', samOld[0])!;
        await flush(); sent.length = 0; clear(...all);
        const prune = await admin('POST', '/api/local/admin/posts/bulk-delete', { postIds: [...annOld, ...samOld] });
        assert(prune.status === 200 && prune.body?.deleted === 17, `the prune removes all 17 posts (${prune.body?.deleted})`);
        await flush();
        const annPrune = pushesTo(Ann);
        assert(annPrune.length === 1, `a member with 15 old posts gets exactly one push (${annPrune.length})`);
        assert(annPrune[0]?.title === mod.POSTS_CLEARED_TITLE && annPrune[0]?.body === mod.postsClearedBody(15, 100),
            `with the count, the age, and "not a report" (${annPrune[0]?.body})`);
        assert(/15 of your listings older than 100 days/.test(annPrune[0]?.body) && /routine tidying, not a report/.test(annPrune[0]?.body), 'worded as tidying');
        assert(!sent.some(m => m.title === mod.POST_REMOVED_TITLE || /removed by the community's admins/.test(m.body)), 'nobody gets the takedown wording');
        assert(notices(socks.Ann).length === 1 && notices(socks.Ann)[0].kind === 'posts_cleared' && notices(socks.Ann)[0].count === 15,
            'and exactly one live notice, so no alerts stack');
        assert(pushesTo(Seller).length === 1 && pushesTo(Seller)[0].body === mod.postsClearedBody(2, 100), `the other author gets one notice for 2 (${pushesTo(Seller)[0]?.body})`);
        assert(notices(socks.Seller).length === 1, 'and one live notice');
        assert(pushesTo(R2).length === 1 && pushesTo(R2)[0].body === mod.reportedPostsRemovedBody(2), `the reporter of 2 pruned posts hears once (${pushesTo(R2)[0]?.body})`);
        assert(notices(socks.R2).length === 1, 'with one live notice');
        for (const id of [R1, C, Buyer, Warden]) assert(pushesTo(id).length === 0, `${id.callsign} gets no push`);
        assert(notices(socks.stranger).length === 0, 'a stranger gets no live notice');
        const pruned = db.prepare(`SELECT COUNT(*) AS c FROM posts WHERE id IN (${annOld.map(() => '?').join(',')}) AND active = 0 AND status = 'cancelled'`).get(...annOld) as any;
        assert(pruned.c === 15, 'the posts are gone');
        const rs7 = db.prepare('SELECT status FROM abuse_reports WHERE id IN (?, ?)').all(rep7.id, rep7b.id) as any[];
        assert(rs7.length === 2 && rs7.every(r => r.status === 'actioned'), 'the reports on pruned posts are closed');
        sent.length = 0;
        await admin('POST', '/api/local/admin/posts/bulk-delete', { postIds: annOld });
        await flush();
        assert(sent.length === 0, 'pruning the same posts again sends nothing');

        // ── 8. The enterprise ledger after an arbitrated deal ────────────────────────────────────
        console.log('\n— 8. the enterprise ledger names an arbitrated deal\'s signer in words —');
        const { publicKey: farm } = se.createTreasury('FarmCoop', '/uploads/avatar.jpg', 200);
        const farmDeal = () => {
            const post = se.createPost('offer', 'goods', `Farm eggs ${crypto.randomBytes(3).toString('hex')}`, 'dozen', 20, 'fixed', farm)!;
            return se.acceptPost(post.id, Buyer.pubKeyHex)!;
        };
        const fd1 = farmDeal(), fd2 = farmDeal();
        se.resolveEscrowDispute(fd1.id, 'release_to_seller', 'owner:password');
        se.resolveEscrowDispute(fd2.id, 'split', Warden.pubKeyHex);
        await flush();
        const raw = db.prepare(`SELECT auth_signer FROM transactions WHERE (from_pubkey = ? OR to_pubkey = ?) AND auth_signer IS NOT NULL`).all(farm, farm) as any[];
        assert(raw.some(r => r.auth_signer === 'owner:password') && raw.some(r => r.auth_signer === Warden.pubKeyHex),
            'the transactions column still records both raw signers');
        const ledger = se.getEnterpriseLedger(farm);
        const ledgerJson = JSON.stringify(ledger);
        assert(!ledgerJson.includes('owner:password'), 'the member-visible ledger never carries "owner:password"');
        assert(!ledgerJson.includes(Warden.pubKeyHex), "nor the ruling admin's key");
        const signers = ledger.entries.map(e => e.authSigner).filter(Boolean);
        assert(signers.every(v => !HEX_KEY.test(String(v))), `no signer in it is a 64-hex key (${JSON.stringify(signers)})`);
        assert(signers.includes('a community admin') && signers.includes('WardenAdmin'), 'it names them "a community admin" and by callsign');
    } finally {
        (globalThis as any).fetch = realFetch;
        for (const s of all) s.ws.close();
        server.close();
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
