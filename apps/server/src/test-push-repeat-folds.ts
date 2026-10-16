/**
 * A push one member can repeat at will reaches its recipient once an hour, not each time (the push audit, items 1 and 2).
 *
 * Over real HTTPS through the signature middleware, with Expo stubbed (nothing leaves this machine):
 *   1. Let-in: the host lets a Going member in (one push, even to a member who has blocked the host: it answers their own
 *      Going), then takes it back and lets them in again five times: still one push; the let-in itself holds each time.
 *      Another member let in is told (per member). An hour later the same member is told again.
 *   2. Request and cancel: a buyer's first request pushes the seller; five more, each after cancelling the last, push
 *      nothing, while the live request waits in the seller's deals. Another buyer's request pushes. An hour later the same
 *      buyer's does. The seller's answer still reaches the buyer.
 *   3. 1-step accept and cancel: five turns push the seller twice in all (the first accept and its cancel), and the
 *      buyer's Beans come back each time. A seller's cancel of a quiet deal still tells the buyer.
 *
 * Run: BEANPOOL_SUITE_ENV_PASSWORD=1 BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-push-repeat-folds.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (const k of ['CF_RECORD_NAME', 'NODE_ROLE', 'NODE_PROFILE', 'EXPO_ACCESS_TOKEN', 'ENFORCE_READ_AUTH']) delete process.env[k];

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 40)); };
const DAY = 86400_000;
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let BASE = '';
let beforeCall: () => void = () => {};
async function call(method: 'GET' | 'POST', id: Id, route: string, body?: unknown): Promise<{ status: number; body: any }> {
    beforeCall();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now(); const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text(); let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
    console.log('Repeatable pushes fold to one an hour...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const posts: any = await import('./engine/posts.js');
    const escrow: any = await import('./engine/escrow.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };
    await initTls();
    se.initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    posts.resetEventWaitingPushes?.();
    escrow.resetRepeatDealPushes?.();

    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = new URL(url).hostname;
        if (host === 'exp.host' || host.endsWith('expo.dev')) {
            const batch = JSON.parse(init?.body ?? '[]');
            sent.push(...batch);
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (host === 'localhost' || host === '127.0.0.1') return realFetch(input, init);
        throw new Error(`the test refused to contact ${host}`);
    };
    const tokenOwner = new Map<string, Id>();
    const pushesTo = (who: Id, kind?: string) => sent.filter(m => tokenOwner.get(m.to) === who && (!kind || m.data?.k === kind));

    const owner = newId('Olive');
    se.seedGenesisMember(owner.pk, 'Olive');
    const member = (name: string, beans = 0): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, ?, ?, 'active')`)
            .run(id.pk, name, new Date(Date.now() - 60 * DAY).toISOString(), owner.pk, `INV-${name.toUpperCase()}`);
        setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        if (beans > 0 && !(se as any).transfer('genesis', id.pk, beans, 'Seed grant', 'direct', true)) throw new Error('seed grant failed');
        const token = `ExponentPushToken[${name}-${crypto.randomBytes(8).toString('hex')}]`;
        putPushTokenRow(id.pk, token, 'android');
        tokenOwner.set(token, id);
        return id;
    };
    const balanceOf = (id: Id) => (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(id.pk) as any)?.balance;
    const realNow = Date.now;

    try {
        // ── 1. Let-in ──────────────────────────────────────────────────────────────────────────────────────
        console.log('--- 1. A let-in taken back and given again ---');
        const hana = member('Hana'), sam = member('Sam'), tia = member('Tia');
        const ev = se.createPost('event', 'community', 'Garden dinner', 'Bring a plate', 0, 'fixed', hana.pk, -28.55, 153.5, [], false, undefined, false,
            { eventStartAt: inHours(30), eventPlaceName: 'Riverbend hall', eventHostLetsIn: true } as any)!;
        await call('POST', sam, `/api/marketplace/posts/${ev.id}/rsvp`, { status: 'going' });
        await call('POST', tia, `/api/marketplace/posts/${ev.id}/rsvp`, { status: 'going' });
        const blocked = await call('POST', sam, '/api/blocks', { targetPubkey: hana.pk });
        const letIn = (who: Id, yes = true) => call('POST', hana, `/api/marketplace/posts/${ev.id}/let-in`, { memberPublicKey: who.pk, letIn: yes });
        const letInAt = (who: Id) => (db.prepare('SELECT let_in_at FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(ev.id, who.pk) as any)?.let_in_at ?? null;
        await flush(); sent.length = 0;
        const first = await letIn(sam);
        await flush();
        assert(blocked.status === 200 && first.status === 200 && pushesTo(sam, 'event.update').length === 1,
            `the first let-in tells Sam, who blocked the host: it answers his own Going (${blocked.status}, ${first.status}, ${pushesTo(sam).length})`);
        let heldEachTime = true;
        for (let i = 0; i < 5; i++) {
            const back = await letIn(sam, false);
            const again = await letIn(sam, true);
            heldEachTime &&= back.status === 200 && again.status === 200 && letInAt(sam) !== null;
        }
        await flush();
        assert(pushesTo(sam, 'event.update').length === 1, `five take-backs and let-ins push him nothing more (${pushesTo(sam, 'event.update').length} pushes in all)`);
        assert(heldEachTime, 'and each let-in still lets him in');
        sent.length = 0;
        // L2. A member who said Not going then Going is told when let in again
        const ng = await call('POST', sam, `/api/marketplace/posts/${ev.id}/rsvp`, { status: null });
        const g2 = await call('POST', sam, `/api/marketplace/posts/${ev.id}/rsvp`, { status: 'going' });
        const l2 = await letIn(sam, true);
        await flush();
        assert(ng.status === 200 && g2.status === 200 && l2.status === 200 && pushesTo(sam, 'event.update').length === 1,
            `a member who said Not going then Going is told when let in again (1) (${pushesTo(sam, 'event.update').length})`);
        sent.length = 0;
        await letIn(tia);
        await flush();
        assert(pushesTo(tia, 'event.update').length === 1, `Tia, let in once, is told (${pushesTo(tia).length})`);
        sent.length = 0;
        const later = 61 * 60_000; // past the hour
        Date.now = () => realNow() + later;
        await letIn(sam, false); await letIn(sam, true);
        await flush();
        Date.now = realNow;
        assert(pushesTo(sam, 'event.update').length === 1, `an hour later, a let-in tells Sam again (${pushesTo(sam).length})`);

        // ── 2. Request and cancel ──────────────────────────────────────────────────────────────────────────
        console.log('\n--- 2. A request cancelled and made again ---');
        const sid = member('Sid'), bea = member('Bea', 10), cal = member('Cal', 10);
        for (const b of [bea, cal]) se.createPost('offer', 'goods', `${b.name}'s seeds`, 'A packet', 1, 'fixed', b.pk, -28.55, 153.5, [], false);
        const eggs = se.createPost('offer', 'goods', 'Fresh eggs', 'A dozen', 1, 'fixed', sid.pk, -28.55, 153.5, [], true)!;
        const request = (b: Id) => call('POST', b, '/api/marketplace/posts/request', { postId: eggs.id, buyerPublicKey: b.pk });
        const cancel = (b: Id, txId: string) => call('POST', b, '/api/marketplace/transactions/cancel-request', { transactionId: txId, buyerPublicKey: b.pk });
        await flush(); sent.length = 0;
        let rq = await request(bea);
        await flush();
        assert(rq.status === 200 && pushesTo(sid, 'market.request').length === 1, `Bea's first request pushes Sid (${rq.status}, ${pushesTo(sid).length})`);
        let allOk = rq.status === 200;
        for (let i = 0; i < 5; i++) {
            const cx = await cancel(bea, rq.body?.transaction?.id);
            rq = await request(bea);
            allOk &&= cx.status === 200 && rq.status === 200;
        }
        await flush();
        assert(allOk && pushesTo(sid, 'market.request').length === 1, `five more, each after cancelling the last, push him nothing more (${pushesTo(sid, 'market.request').length} in all)`);
        const live = db.prepare("SELECT COUNT(*) AS n FROM marketplace_transactions WHERE post_id = ? AND buyer_pubkey = ? AND status = 'requested'").get(eggs.id, bea.pk) as any;
        assert(live.n === 1, `her live request waits in his deals (${live.n})`);

        // A. An approved deal's cancel after a folded request tells the seller (1 trade.update)
        sent.length = 0;
        const apA = await call('POST', sid, '/api/marketplace/transactions/approve', { transactionId: rq.body?.transaction?.id, authorPublicKey: sid.pk });
        sent.length = 0;
        const cA = await call('POST', bea, '/api/marketplace/transactions/cancel', { transactionId: rq.body?.transaction?.id, cancellerPublicKey: bea.pk });
        await flush();
        assert(apA.status === 200 && cA.status === 200 && pushesTo(sid, 'trade.update').length === 1,
            `an approved deal's cancel after a folded request tells the seller (1 trade.update) (${pushesTo(sid, 'trade.update').length})`);
        sent.length = 0;
        const calRq = await request(cal);
        await flush();
        assert(calRq.status === 200 && pushesTo(sid, 'market.request').length === 1, `Cal's request pushes Sid (${pushesTo(sid).length})`);
        sent.length = 0;
        Date.now = () => realNow() + later;
        rq = await request(bea);
        await flush();
        Date.now = realNow;
        assert(rq.status === 200 && pushesTo(sid, 'market.request').length === 1, `an hour later, Bea's request pushes him again (${pushesTo(sid).length})`);
        sent.length = 0;
        const ok = await call('POST', sid, '/api/marketplace/transactions/approve', { transactionId: rq.body?.transaction?.id, authorPublicKey: sid.pk });
        await flush();
        assert(ok.status === 200 && pushesTo(bea, 'market.answer').length === 1, `Sid's approval tells Bea (${ok.status}, ${pushesTo(bea).length})`);

        // E. A decline of a folded request tells the requester (1)
        const tea = se.createPost('offer', 'goods', 'Tea', 'A tin', 1, 'fixed', sid.pk, -28.55, 153.5, [], true)!;
        await flush(); sent.length = 0;
        const t1 = await call('POST', bea, '/api/marketplace/posts/request', { postId: tea.id, buyerPublicKey: bea.pk });
        await call('POST', bea, '/api/marketplace/transactions/cancel-request', { transactionId: t1.body?.transaction?.id, buyerPublicKey: bea.pk });
        const t2 = await call('POST', bea, '/api/marketplace/posts/request', { postId: tea.id, buyerPublicKey: bea.pk });
        await flush(); sent.length = 0;
        const rj = await call('POST', sid, '/api/marketplace/transactions/reject', { transactionId: t2.body?.transaction?.id, authorPublicKey: sid.pk });
        await flush();
        assert(rj.status === 200 && pushesTo(bea, 'market.answer').length === 1,
            `a decline of a folded request tells the requester (1) (${pushesTo(bea, 'market.answer').length})`);

        // B. On a Need the author's cancel tells the helper (1)
        const ana = member('Ana', 20), hal = member('Hal', 0);
        for (const b of [ana, hal]) se.createPost('offer', 'goods', `${b.name}'s seeds`, 'A packet', 1, 'fixed', b.pk, -28.55, 153.5, [], false);
        const fence = se.createPost('need', 'services', 'Fix my fence', 'Two posts down', 2, 'fixed', ana.pk, -28.55, 153.5, [], true)!;
        await flush(); sent.length = 0;
        const h1 = await call('POST', hal, '/api/marketplace/posts/request', { postId: fence.id, buyerPublicKey: hal.pk });
        await call('POST', hal, '/api/marketplace/transactions/cancel-request', { transactionId: h1.body?.transaction?.id, buyerPublicKey: hal.pk });
        const h2 = await call('POST', hal, '/api/marketplace/posts/request', { postId: fence.id, buyerPublicKey: hal.pk });
        await flush(); sent.length = 0;
        const apB = await call('POST', ana, '/api/marketplace/transactions/approve', { transactionId: h2.body?.transaction?.id, authorPublicKey: ana.pk });
        await flush(); sent.length = 0;
        const cB = await call('POST', ana, '/api/marketplace/transactions/cancel', { transactionId: h2.body?.transaction?.id, cancellerPublicKey: ana.pk });
        await flush();
        assert(apB.status === 200 && cB.status === 200 && pushesTo(hal, 'trade.update').length === 1,
            `on a Need the author's cancel tells the helper (1) (${pushesTo(hal, 'trade.update').length})`);

        // C. An honest second request after a completed deal pushes the author (1)
        const cara = member('Cara', 20);
        se.createPost('offer', 'goods', "Cara's seeds", 'A packet', 1, 'fixed', cara.pk, -28.55, 153.5, [], false);
        const honey = se.createPost('offer', 'goods', 'Honey', 'A jar', 1, 'fixed', sid.pk, -28.55, 153.5, [], true)!;
        await flush(); sent.length = 0;
        const c1 = await call('POST', cara, '/api/marketplace/posts/request', { postId: honey.id, buyerPublicKey: cara.pk });
        await call('POST', sid, '/api/marketplace/transactions/approve', { transactionId: c1.body?.transaction?.id, authorPublicKey: sid.pk });
        const doneC = await call('POST', cara, '/api/marketplace/transactions/complete', { transactionId: c1.body?.transaction?.id, confirmerPublicKey: cara.pk });
        await flush(); sent.length = 0;
        const c2 = await call('POST', cara, '/api/marketplace/posts/request', { postId: honey.id, buyerPublicKey: cara.pk });
        await flush();
        assert(c1.status === 200 && doneC.status === 200 && c2.status === 200 && pushesTo(sid, 'market.request').length === 1,
            `an honest second request after a completed deal pushes the author (1) (${pushesTo(sid, 'market.request').length})`);

        // ── 3. 1-step accept and cancel ────────────────────────────────────────────────────────────────────
        console.log('\n--- 3. A 1-step accept and its cancel, over and over ---');
        const sue = member('Sue'), bix = member('Bix', 10);
        se.createPost('offer', 'goods', "Bix's seeds", 'A packet', 1, 'fixed', bix.pk, -28.55, 153.5, [], false);
        const jam = se.createPost('offer', 'goods', 'Jam', 'A jar', 1, 'fixed', sue.pk, -28.55, 153.5, [], true)!;
        await flush(); sent.length = 0;
        const start = balanceOf(bix);
        let turnsOk = true, refunded = true;
        for (let i = 0; i < 5; i++) {
            const acc = await call('POST', bix, '/api/marketplace/posts/accept', { postId: jam.id, buyerPublicKey: bix.pk });
            const held = balanceOf(bix);
            const can = await call('POST', bix, '/api/marketplace/transactions/cancel', { transactionId: acc.body?.transaction?.id, cancellerPublicKey: bix.pk });
            turnsOk &&= acc.status === 200 && can.status === 200;
            refunded &&= held === start - 1 && balanceOf(bix) === start;
        }
        await flush();
        const kinds = pushesTo(sue).map(m => m.data?.k);
        assert(turnsOk && kinds.length === 2 && kinds.filter(k => k === 'market.request').length === 1 && kinds.filter(k => k === 'trade.update').length === 1,
            `five turns push Sue twice in all: the first accept and its cancel (${JSON.stringify(kinds)})`);
        assert(refunded, "Bix's Bean is held and given back each turn, as before");
        sent.length = 0;
        const acc = await call('POST', bix, '/api/marketplace/posts/accept', { postId: jam.id, buyerPublicKey: bix.pk });
        const sueCancels = await call('POST', sue, '/api/marketplace/transactions/cancel', { transactionId: acc.body?.transaction?.id, cancellerPublicKey: sue.pk });
        await flush();
        assert(acc.status === 200 && sueCancels.status === 200 && pushesTo(bix, 'trade.update').length === 1 && pushesTo(sue).length === 0,
            `Sue's cancel of a quiet deal still tells Bix (${sueCancels.status}, Bix ${pushesTo(bix).length}, Sue ${pushesTo(sue).length})`);

        // D. A second one-step buy pushes (1)
        const dan = member('Dan', 20);
        se.createPost('offer', 'goods', "Dan's seeds", 'A packet', 1, 'fixed', dan.pk, -28.55, 153.5, [], false);
        const bread = se.createPost('offer', 'goods', 'Bread', 'A loaf', 1, 'fixed', sid.pk, -28.55, 153.5, [], true)!;
        await flush(); sent.length = 0;
        const a1 = await call('POST', dan, '/api/marketplace/posts/accept', { postId: bread.id, buyerPublicKey: dan.pk });
        const d1 = await call('POST', dan, '/api/marketplace/transactions/complete', { transactionId: a1.body?.transaction?.id, confirmerPublicKey: dan.pk });
        await flush(); sent.length = 0;
        const a2 = await call('POST', dan, '/api/marketplace/posts/accept', { postId: bread.id, buyerPublicKey: dan.pk });
        await flush();
        assert(a1.status === 200 && d1.status === 200 && a2.status === 200 && pushesTo(sid, 'market.request').length === 1,
            `a second one-step buy pushes (1) (${pushesTo(sid, 'market.request').length})`);
    } finally {
        Date.now = realNow;
        (globalThis as any).fetch = realFetch;
    }
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
