/**
 * Privacy by default (Marty, 2026-09-28): balances and trades are private, a local community's listings are its
 * members', and polls are anonymous unless their creator chose an open vote.
 *
 *   1. Balances and trades. A member reads their own balance, transactions and export; another member's is refused
 *      (403 own_only), and so is every transaction with no key. An enterprise's balance stays open, and its keepers
 *      read its history. The Commons pot and the community's info stay public. A visitor's row reads its own only.
 *   2. A Decision about a member: its voters read that member's balance in it, and nobody else does, anywhere: not a
 *      member who joined after it opened, not the stranger, not the live feed, not the balance route.
 *   3. The activity feed: a completed trade reaches its two people only, and one reader's copy is never confirmed to
 *      another with a 304.
 *   4. An enterprise's book: every amount is open, but who paid it and what they wrote only to its keepers and to that
 *      member. Its public page's flow carries no memo to a stranger. A deferred wage it pays goes on the live feed to
 *      the keeper it paid and its keepers, and to no other socket.
 *   5. Who took a listing: the author and the taker read it, on the board and on the live feed; nobody else does.
 *   6. A local community's listings: a stranger (unsigned), a key that is no member here and a visitor's row are refused
 *      the board, one listing, a sync and a delta, with code members_only and the global community's address; a member
 *      reads them, a suspended one included. No public read hands a stranger a listing's id (a photo's URL is made of
 *      it), an enterprise's public page lists no listings to one, and a key-less socket hears no listing doorbell.
 *   7. Polls: one made without the choice (every app before this one) is anonymous, and nobody gets its voters, the
 *      author and the voter included, on a read or on the live feed, which no longer carries the voter's own choice
 *      either. An open vote gives members its voters, and a suspended member none. The choice can change until the
 *      first vote, and never after.
 *
 * The real server, every request over TLS through the signature middleware, with every ENFORCE_* variable removed
 * (the fresh-download default) on a local node (NODE_PROFILE unset). The global node's guest view is the business of
 * test-guest-view, which runs unchanged.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-privacy-defaults.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Module consts read at import: settled before the dynamic imports in main().
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import WebSocket from 'ws';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function signedHeaders(method: string, path: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

let beforeCall: () => void = () => {};

type Res = { status: number; text: string; body: any; etag: string | null };
async function get(path: string, id?: Id, extra: Record<string, string> = {}): Promise<Res> {
    beforeCall();
    const res = await fetch(`${BASE}${path}`, { headers: { ...(id ? signedHeaders('GET', path, '', id) : {}), ...extra } });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, text, body, etag: res.headers.get('etag') };
}
async function post(path: string, payload: unknown, id: Id): Promise<Res> {
    beforeCall();
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', path, body, id) },
        body,
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, text, body: json, etag: res.headers.get('etag') };
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}
type Sock = { ws: WebSocket; events: any[]; raw: string[] };
function openSocket(url: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const events: any[] = [];
        const raw: string[] = [];
        ws.on('message', (d) => { raw.push(d.toString()); try { events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve({ ws, events, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}

async function main() {
    console.log('Privacy by default, on a local node as it ships...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer, PUBLIC_READ_EXACT } = await import('./https-server.js');
    const GLOBAL_COMMUNITY = 'https://global.beanpool.org';
    const { db } = await import('./db/db.js');
    const { recordActivity } = await import('./db/activity-feed-db.js');
    const { getProfileSwitches } = await import('./config/node-profile.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    assert(getProfileSwitches().guestListingsOnly === false, 'setup: a local node, without the visitors\' view');

    const member = (callsign: string, opts: { status?: string; visitor?: boolean; earned?: number; balance?: number; joinedAt?: string } = {}): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url, is_visitor, earned_credit)
                    VALUES (?, ?, ?, ?, 'seed', ?, ?, ?, ?)`)
            .run(id.pk, callsign, opts.status ?? 'active', opts.joinedAt ?? new Date(Date.now() - 60 * DAY).toISOString(),
                `INV-${callsign.toUpperCase()}`, TINY_PNG, opts.visitor ? 1 : 0, opts.earned ?? 0);
        db.prepare('INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)').run(id.pk, opts.balance ?? 0);
        return id;
    };
    const alice = member('PrivAlice', { earned: 10, balance: 42.5 });
    const bob = member('PrivBob', { balance: -12 });
    const carol = member('PrivCarol');
    const sam = member('PrivSam', { status: 'disabled' }); // suspended: still a member, reads as a non-member
    const vera = member('PrivVera', { visitor: true, balance: 3 }); // a visitor's row
    const outsider = newId(); // signs, but no member here

    const tx = (id: string, from: string, to: string, amount: number, memo: string) =>
        db.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, from, to, amount, memo, new Date().toISOString());
    tx('tx-priv-ab', alice.pk, bob.pk, 5, 'Sentinel memo alice to bob');
    tx('tx-priv-bc', bob.pk, carol.pk, 2, 'Sentinel memo bob to carol');
    tx('tx-priv-v', carol.pk, vera.pk, 1, 'Sentinel memo carol to vera');

    // ── 1. balances and trades ─────────────────────────────────────────────────────────────────
    console.log('── 1. balances and trades ──');
    {
        const own = await get(`/api/ledger/balance/${alice.pk}`, alice);
        assert(own.status === 200 && typeof own.body?.balance === 'number', `Alice reads her own balance (got ${own.status} ${own.text.slice(0, 80)})`);
        const other = await get(`/api/ledger/balance/${alice.pk}`, carol);
        assert(other.status === 403 && other.body?.code === 'own_only', `Carol is refused Alice's balance, 403 own_only (got ${other.status} ${other.text.slice(0, 80)})`);
        assert(!other.text.includes('42.5') && !other.text.includes('trustStats'), "the refusal carries none of Alice's figures");
        const missing = await get(`/api/ledger/balance/${newId().pk}`, carol);
        assert(missing.status === 403, `a key that is no member here is refused the same way, never "not found" (got ${missing.status})`);
        const unsigned = await get(`/api/ledger/balance/${alice.pk}`);
        assert(unsigned.status === 401, `an unsigned read of a balance is refused (got ${unsigned.status})`);
        const outsiderRead = await get(`/api/ledger/balance/${alice.pk}`, outsider);
        assert(outsiderRead.status === 403, `a key that is no member here is refused Alice's balance (got ${outsiderRead.status})`);
        const suspended = await get(`/api/ledger/balance/${sam.pk}`, sam);
        assert(suspended.status === 200, `a suspended member still reads their own balance (got ${suspended.status})`);

        const ownTx = await get(`/api/ledger/transactions?publicKey=${bob.pk}`, bob);
        assert(ownTx.status === 200 && Array.isArray(ownTx.body) && ownTx.body.some((t: any) => t.id === 'tx-priv-ab') && ownTx.body.some((t: any) => t.id === 'tx-priv-bc'),
            `Bob reads his own transactions, both sides (got ${ownTx.status})`);
        const otherTx = await get(`/api/ledger/transactions?publicKey=${bob.pk}`, alice);
        assert(otherTx.status === 403 && otherTx.body?.code === 'own_only' && !otherTx.text.includes('Sentinel memo'),
            `Alice, who traded with Bob, is refused his history (got ${otherTx.status})`);
        const noKey = await get('/api/ledger/transactions', carol);
        assert(noKey.status === 403 && noKey.body?.code === 'own_only' && !noKey.text.includes('Sentinel memo'),
            `every transaction on the node, with no key, is refused (got ${noKey.status} ${noKey.text.slice(0, 80)})`);
        const noKeyUnsigned = await get('/api/ledger/transactions');
        assert(noKeyUnsigned.status === 401, `and refused unsigned (got ${noKeyUnsigned.status})`);

        const exp = await get('/api/ledger/export', alice);
        assert(exp.status === 200 && typeof exp.body?.transactionsCsv === 'string' && typeof exp.body?.balancesCsv === 'string',
            `Alice downloads her export (got ${exp.status})`);
        assert(exp.body?.transactionsCsv.includes('tx-priv-ab') && !exp.body?.transactionsCsv.includes('tx-priv-bc') && !exp.body?.transactionsCsv.includes('Sentinel memo bob to carol'),
            'her export holds her own transaction and nobody else\'s');
        assert(exp.body?.balancesCsv.includes(alice.pk) && !exp.body?.balancesCsv.includes(bob.pk) && !exp.body?.balancesCsv.includes(carol.pk)
            && exp.body?.balancesCsv.includes('Community Pool'),
            'its balances hold hers and the Community Pool, and no other member\'s');
        const expUnsigned = await get('/api/ledger/export');
        assert(expUnsigned.status === 401, `an unsigned export is refused (got ${expUnsigned.status})`);

        const vOwn = await get(`/api/ledger/balance/${vera.pk}`, vera);
        const vOther = await get(`/api/ledger/balance/${carol.pk}`, vera);
        const vTx = await get(`/api/ledger/transactions?publicKey=${vera.pk}`, vera);
        assert(vOwn.status === 200 && vTx.status === 200 && vOther.status === 403,
            `a visitor's row reads its own Beans and history and no one else's (own ${vOwn.status}, history ${vTx.status}, Carol's ${vOther.status})`);

        const pool = await get('/api/commons/balance');
        assert(pool.status === 200 && typeof pool.body?.balance === 'number', `the Commons pot stays public (got ${pool.status})`);
        const info = await get('/api/community/info');
        assert(info.status === 200, `the community's info stays public (got ${info.status})`);
    }

    // An enterprise Alice leads; Bob pays it for bread.
    const enterprise = se.createTreasury('Priv Bakery', TINY_PNG, 0, { leadKeeperPubkey: alice.pk, purpose: 'Bread' }).publicKey;
    tx('tx-priv-bread', bob.pk, enterprise, 4, 'Sentinel memo for the rye loaf');
    {
        const bal = await get(`/api/ledger/balance/${enterprise}`, carol);
        assert(bal.status === 200 && typeof bal.body?.balance === 'number', `an enterprise's balance stays open to a member (got ${bal.status})`);
        const keeperTx = await get(`/api/ledger/transactions?publicKey=${enterprise}`, alice);
        assert(keeperTx.status === 200 && Array.isArray(keeperTx.body) && keeperTx.body.some((t: any) => t.id === 'tx-priv-bread'),
            `its keeper reads its history (got ${keeperTx.status})`);
        const memberTx = await get(`/api/ledger/transactions?publicKey=${enterprise}`, carol);
        assert(memberTx.status === 403 && !memberTx.text.includes('Sentinel memo'), `a member who keeps nothing there is refused it (got ${memberTx.status})`);
        const list = await get('/api/treasuries');
        assert(list.status === 200 && list.text.includes(enterprise), `the treasuries list stays public (got ${list.status})`);
    }

    // ── 2. a Decision about a member ───────────────────────────────────────────────────────────
    console.log('\n── 2. a Decision about a member shows their balance to its voters only ──');
    const wsBase = `${BASE.replace('https', 'wss')}/ws`;
    const carolSock = await openSocket(`${wsBase}?${signedWsQuery(carol)}`);
    const strangerSock = await openSocket(wsBase);
    await sleep(200);
    const proposed = await post('/api/commons/decisions', {
        title: 'Remove PrivBob', description: 'A privacy test Decision about Bob', touches: 'member', effect: 'remove_member', subject: bob.pk,
    }, alice);
    const decisionId = proposed.body?.decision?.id as string | undefined;
    assert(proposed.status === 200 && !!decisionId, `Alice proposes removing Bob (got ${proposed.status} ${proposed.text.slice(0, 160)})`);
    assert(proposed.body?.decision?.params?.balance === -12 && proposed.body?.decision?.params?.debt === 12,
        'Alice, who may vote in it, is answered with his balance and debt');
    await sleep(300);
    // Joined after it opened: a member, with no vote in it.
    const dora = member('PrivDora', { joinedAt: new Date(Date.now() + 1000).toISOString() });
    {
        const card = (r: Res) => (r.body?.decisions ?? []).find((d: any) => d.id === decisionId);
        const voterList = await get('/api/commons/decisions', carol);
        const voterOne = await get(`/api/commons/decisions/${decisionId}`, carol);
        assert(card(voterList)?.params?.balance === -12 && card(voterList)?.params?.debt === 12,
            `Carol, a voter, reads Bob's balance on its card in the list (got ${JSON.stringify(card(voterList)?.params)})`);
        assert(voterOne.body?.decision?.params?.balance === -12, 'and in the Decision itself');
        const subject = await get(`/api/commons/decisions/${decisionId}`, bob);
        assert(subject.body?.decision?.params?.balance === -12, 'Bob reads his own');
        for (const [who, id] of [['Dora, who joined after it opened', dora], ['a suspended member', sam], ["a visitor's row", vera], ['a key that is no member here', outsider], ['a stranger (unsigned)', undefined]] as const) {
            const l = await get('/api/commons/decisions', id);
            const one = await get(`/api/commons/decisions/${decisionId}`, id);
            const p1 = card(l)?.params ?? {};
            const p2 = one.body?.decision?.params ?? {};
            assert(l.status === 200 && !!card(l) && !('balance' in p1) && !('debt' in p1) && p1.memberName === 'PrivBob',
                `${who} sees the card, and not Bob's balance or debt, in the list (got ${l.status} ${JSON.stringify(p1)})`);
            assert(one.status === 200 && !('balance' in p2) && !('debt' in p2), `${who} does not see them in the Decision either (got ${one.status})`);
        }
        const created = carolSock.events.find(e => e.type === 'decision_created');
        assert(!!created && !('balance' in (created.decision?.params ?? {})) && !('debt' in (created.decision?.params ?? {})),
            "the live feed's decision_created carries neither, even to a voter's socket (she reads them from the Decision)");
        assert(!strangerSock.raw.some(r => r.includes('"debt"')), "a stranger's socket is sent nothing with a debt in it");
        const outside = await get(`/api/ledger/balance/${bob.pk}`, carol);
        assert(outside.status === 403, `outside the Decision, Carol still may not read Bob's balance (got ${outside.status})`);
    }
    carolSock.ws.close();
    strangerSock.ws.close();

    // ── 3. the activity feed ───────────────────────────────────────────────────────────────────
    console.log('\n── 3. the activity feed shows a trade to its two people only ──');
    {
        recordActivity('member_joined', dora.pk, null, { callsign: 'PrivDora' });
        recordActivity('trade_completed', alice.pk, bob.pk, { postId: 'post-priv', postTitle: 'Sentinel loaf', credits: 6 });
        const feedOf = async (id: Id, extra: Record<string, string> = {}) => get('/api/activity/feed', id, extra);
        const a = await feedOf(alice);
        const b = await feedOf(bob);
        const c = await feedOf(carol);
        const trades = (r: Res) => (r.body?.feed ?? []).filter((e: any) => e.eventType === 'trade_completed');
        assert(a.status === 200 && trades(a).length === 1, `Alice, the seller, sees the trade (got ${trades(a).length})`);
        assert(trades(b).length === 1, `Bob, the buyer, sees it (got ${trades(b).length})`);
        assert(c.status === 200 && trades(c).length === 0 && !c.text.includes('Sentinel loaf'), `Carol does not (got ${trades(c).length})`);
        assert((c.body?.feed ?? []).some((e: any) => e.eventType === 'member_joined'), 'Carol still sees who joined');
        const cached = await feedOf(carol, { 'If-None-Match': a.etag ?? '' });
        assert(cached.status === 200 && trades(cached).length === 0, `Alice's ETag is never confirmed to Carol (got ${cached.status})`);
        const again = await feedOf(alice, { 'If-None-Match': a.etag ?? '' });
        assert(again.status === 304, `Alice's own copy still revalidates (got ${again.status})`);
    }

    // ── 4. an enterprise's book ────────────────────────────────────────────────────────────────
    console.log("\n── 4. an enterprise's book: the amounts are open, the people only to its keepers ──");
    {
        const line = (r: Res) => (r.body?.entries ?? []).find((e: any) => e.id === 'tx-priv-bread');
        const keeper = await get(`/api/treasury/${enterprise}/ledger`, alice);
        assert(keeper.status === 200 && line(keeper)?.counterparty === bob.pk && line(keeper)?.memo === 'Sentinel memo for the rye loaf',
            `its keeper reads who paid and the memo (got ${keeper.status} ${JSON.stringify(line(keeper))})`);
        const payer = await get(`/api/treasury/${enterprise}/ledger`, bob);
        assert(line(payer)?.counterparty === bob.pk && line(payer)?.memo === 'Sentinel memo for the rye loaf', 'Bob reads his own line in full');
        const other = await get(`/api/treasury/${enterprise}/ledger`, carol);
        assert(other.status === 200 && line(other)?.amount === 4 && line(other)?.counterpartyName === 'A member'
            && line(other)?.memo === '' && line(other)?.counterparty === '' && !other.text.includes(bob.pk) && !other.text.includes('rye loaf'),
            `Carol reads the amount, not who paid or what they wrote (got ${JSON.stringify(line(other))})`);
        const flowUnsigned = await get(`/api/treasury/${enterprise}`);
        assert(flowUnsigned.status === 200 && Array.isArray(flowUnsigned.body?.flow) && flowUnsigned.body.flow.some((f: any) => f.amount === 4)
            && !flowUnsigned.text.includes('rye loaf'), `its public page shows the flow's amounts and no memo to a stranger (got ${flowUnsigned.status})`);
        const flowKeeper = await get(`/api/treasury/${enterprise}`, alice);
        assert(flowKeeper.text.includes('rye loaf'), 'and the memo to its keeper');

        // A deferred wage paid out names its keeper and the amount (the deciding review's 4125322206): it goes to that
        // keeper and the enterprise's keepers, and never to another member's socket.
        const kim = member('PrivKim');
        se.adminAssignTreasuryOperator(enterprise, kim.pk);
        se.transfer('genesis', enterprise, 20, 'Seed the bakery', 'direct', true);
        db.prepare('UPDATE members SET earned_surplus = 20 WHERE public_key = ?').run(enterprise);
        const kimSock = await openSocket(`${wsBase}?${signedWsQuery(kim)}`);
        const aliceSock = await openSocket(`${wsBase}?${signedWsQuery(alice)}`);
        const bystanderSock = await openSocket(`${wsBase}?${signedWsQuery(carol)}`);
        const keylessSock = await openSocket(wsBase);
        await sleep(200);
        se.recordDeferredWageClaim(enterprise, kim.pk, 7);
        assert(se.processDeferredWageClaims(enterprise) === 1, 'setup: the bakery pays Kim, a keeper, a deferred wage of 7');
        await sleep(300);
        const wage = (s: Sock) => s.events.find(e => e.type === 'deferred_wage_paid');
        assert(wage(kimSock)?.keeper === kim.pk && wage(kimSock)?.amount === 7, `Kim, the keeper it paid, hears it (got ${JSON.stringify(wage(kimSock))})`);
        assert(wage(aliceSock)?.keeper === kim.pk, "Alice, the bakery's lead keeper, hears it");
        assert(!bystanderSock.raw.some(r => r.includes('deferred_wage_paid')), "Carol, a member who keeps nothing there, hears no wage");
        assert(!keylessSock.raw.some(r => r.includes('deferred_wage_paid') || r.includes(kim.pk)), "a key-less socket hears no wage, and nothing that names Kim");
        for (const s of [kimSock, aliceSock, bystanderSock, keylessSock]) s.ws.close();
    }

    // ── 5 and 6. listings ──────────────────────────────────────────────────────────────────────
    console.log('\n── 5. who took a listing ──');
    const made = await post('/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Sentinel ladder', description: 'A privacy test offer', authorPublicKey: alice.pk,
        lat: -28.5, lng: 153.5, photos: [TINY_PNG],
    }, alice);
    const offerId = made.body?.post?.id as string | undefined;
    assert(made.status === 200 && !!offerId, `Alice lists an offer with a photo (got ${made.status} ${made.text.slice(0, 120)})`);
    const photoUrl = made.body?.post?.photos?.[0] as string | undefined;
    const taken = await post('/api/marketplace/posts', {
        type: 'offer', category: 'other', title: 'Sentinel pumpkins', description: 'Taken by Bob', authorPublicKey: alice.pk, lat: -28.5, lng: 153.5,
    }, alice);
    const takenId = taken.body?.post?.id as string;
    db.prepare("UPDATE posts SET status = 'pending', accepted_by = ?, accepted_at = ?, pending_transaction_id = 'mtx-priv' WHERE id = ?")
        .run(bob.pk, new Date().toISOString(), takenId);
    {
        const byId = (r: Res, id: string) => (Array.isArray(r.body) ? r.body : []).find((p: any) => p.id === id);
        for (const [who, id, party] of [['Alice, its author', alice, true], ['Bob, who took it', bob, true], ['Carol', carol, false]] as const) {
            const r = await get(`/api/marketplace/posts?id=${takenId}`, id);
            const p = byId(r, takenId);
            if (party) assert(p?.acceptedBy === bob.pk && p?.pendingTransactionId === 'mtx-priv', `${who} reads who took it (got ${JSON.stringify({ by: p?.acceptedBy })})`);
            else assert(!!p && p.status === 'pending' && !('acceptedBy' in p) && !('acceptedByCallsign' in p) && !('pendingTransactionId' in p) && !r.text.includes(bob.pk),
                `${who} reads it spoken for, and not by whom (got ${JSON.stringify(p && { status: p.status, by: p.acceptedBy })})`);
        }
        const bobSock = await openSocket(`${wsBase}?${signedWsQuery(bob)}`);
        const carolSock2 = await openSocket(`${wsBase}?${signedWsQuery(carol)}`);
        await sleep(200);
        const full = se.getPosts({ id: takenId, includeAllScopes: true })[0];
        se.broadcast({ type: 'post_updated', post: full });
        await sleep(300);
        const ev = (s: Sock) => s.events.find(e => e.type === 'post_updated' && e.post?.id === takenId);
        assert(ev(bobSock)?.post?.acceptedBy === bob.pk, "Bob's socket gets who took it");
        assert(!!ev(carolSock2) && !('acceptedBy' in ev(carolSock2).post) && !carolSock2.raw.some(r => r.includes(bob.pk)),
            "Carol's socket gets the listing, without who took it");
        bobSock.ws.close();
        carolSock2.ws.close();
    }

    console.log("\n── 6. a local community's listings are its members' ──");
    {
        const reads = [
            '/api/marketplace/posts',
            `/api/marketplace/posts?id=${offerId}`,
            '/api/marketplace/posts?sync=true',
            '/api/marketplace/posts?updatedAfter=2000-01-01T00:00:00.000Z',
            '/api/marketplace/posts?lat=-28.5&lng=153.5&radiusKm=10',
        ];
        for (const path of reads) {
            for (const [who, id, status] of [['a stranger (unsigned)', undefined, 401], ['a key that is no member here', outsider, 403], ["a visitor's row", vera, 403]] as const) {
                const r = await get(path, id);
                assert(r.status === status && r.body?.code === 'members_only' && r.body?.global === GLOBAL_COMMUNITY && !r.text.includes('Sentinel ladder'),
                    `${who} is refused ${path}, ${status} members_only with the global community's address (got ${r.status} ${r.text.slice(0, 100)})`);
            }
            for (const [who, id] of [['Carol, a member', carol], ['a suspended member', sam]] as const) {
                const r = await get(path, id);
                assert(r.status === 200 && Array.isArray(r.body), `${who} reads ${path} (got ${r.status})`);
            }
        }
        const board = await get('/api/marketplace/posts', carol);
        assert(board.body?.some((p: any) => p.id === offerId && typeof p.lat === 'number'), 'the member reads the listing and its pin');

        // A visitor's row may still hold a listing from before visitors were refused one, and may take it down: it reads
        // its own listings, and nothing else of the board.
        db.prepare("INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, active, status) VALUES ('priv-vera-old', 'offer', 'other', 'Sentinel old visitor offer', 'd', 1, ?, 1, 'active')").run(vera.pk);
        const own = await get(`/api/marketplace/posts?author=${vera.pk}`, vera);
        assert(own.status === 200 && Array.isArray(own.body) && own.body.length === 1 && own.body[0].id === 'priv-vera-old',
            `a visitor's row reads its own listing (got ${own.status} ${own.text.slice(0, 100)})`);
        const others = await get(`/api/marketplace/posts?author=${alice.pk}`, vera);
        assert(others.status === 403 && others.body?.code === 'members_only', `and is refused another's (got ${others.status})`);
        const sneaky = await get(`/api/marketplace/posts?author=${vera.pk}&id=${offerId}`, vera);
        assert(sneaky.status === 200 && Array.isArray(sneaky.body) && sneaky.body.length === 0, `its own read never carries anyone else's listing (got ${sneaky.text.slice(0, 80)})`);
        const takeDown = await post('/api/marketplace/posts/remove', { id: 'priv-vera-old', authorPublicKey: vera.pk }, vera);
        assert(takeDown.status === 200, `and takes it down (got ${takeDown.status} ${takeDown.text.slice(0, 100)})`);

        // No public read gives a stranger a listing's id, the one thing its photo's URL is made of.
        let leaks = 0;
        for (const path of PUBLIC_READ_EXACT) {
            const r = await get(path);
            if (r.text.includes(offerId!) || r.text.includes(takenId)) { leaks++; console.error(`  ${path} carries a listing id`); }
        }
        for (const path of [`/api/treasury/${enterprise}`, `/api/enterprise/${enterprise}`, `/api/community/membership/${alice.pk}`]) {
            const r = await get(path);
            if (r.text.includes(offerId!) || r.text.includes(takenId)) { leaks++; console.error(`  ${path} carries a listing id`); }
        }
        assert(leaks === 0, `no public read hands a stranger a listing's id (${leaks} did)`);
        const guessed = await get(`/api/marketplace/posts/${crypto.randomUUID()}/photos/0`);
        assert(guessed.status === 404, `a photo is served only at its listing's id (a made-up one: ${guessed.status})`);
        assert(typeof photoUrl === 'string' && photoUrl.includes(offerId!), 'the photo\'s URL is made of its listing\'s id');

        const entPost = se.createPost('offer', 'food', 'Sentinel bakery loaf', 'Enterprise listing', 1, 'fixed', enterprise, -28.5, 153.5, undefined, false, undefined, false, { createdBy: alice.pk });
        assert(!!entPost?.id, 'setup: the enterprise lists a loaf');
        const pageStranger = await get(`/api/treasury/${enterprise}`);
        const pageMember = await get(`/api/treasury/${enterprise}`, carol);
        assert(pageStranger.status === 200 && Array.isArray(pageStranger.body?.posts) && pageStranger.body.posts.length === 0 && !pageStranger.text.includes('Sentinel bakery loaf'),
            `the enterprise's public page lists no listing to a stranger (got ${pageStranger.body?.posts?.length})`);
        assert(pageMember.body?.posts?.some((p: any) => p.id === entPost!.id), 'and lists it to a member');

        const unsignedSock = await openSocket(wsBase);
        const outsiderSock = await openSocket(`${wsBase}?${signedWsQuery(outsider)}`);
        const memberSock = await openSocket(`${wsBase}?${signedWsQuery(carol)}`);
        await sleep(200);
        const another = await post('/api/marketplace/posts', {
            type: 'offer', category: 'other', title: 'Sentinel spade', description: 'Doorbell check', authorPublicKey: alice.pk, lat: -28.5, lng: 153.5,
        }, alice);
        assert(another.status === 200, 'Alice lists another offer');
        await sleep(400);
        assert(memberSock.events.some(e => e.type === 'new_post'), "a member's socket hears it");
        for (const [who, s] of [['an unsigned', unsignedSock], ['a non-member-signed', outsiderSock]] as const) {
            assert(!s.events.some(e => ['new_post', 'post_updated', 'post_removed'].includes(e.type)), `${who} socket hears no listing doorbell: it may not read the listings here`);
        }
        for (const s of [unsignedSock, outsiderSock, memberSock]) s.ws.close();
    }

    // ── 7. polls ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. polls are anonymous unless their creator chose an open vote ──');
    {
        // Alice's poll is made as every app before the choice made one: nothing said.
        const anon = await post('/api/marketplace/posts', {
            type: 'poll', title: 'Sentinel anonymous poll', description: '', authorPublicKey: alice.pk,
            pollOptions: [{ id: 'opt_a', text: 'Yes' }, { id: 'opt_b', text: 'No' }], durationDays: 7,
        }, alice);
        const anonId = anon.body?.post?.id as string;
        assert(anon.status === 200 && anon.body?.post?.pollOpenVote === false, `a poll made without the choice is anonymous (got ${anon.status} ${JSON.stringify(anon.body?.post?.pollOpenVote)})`);
        const open = await post('/api/marketplace/posts', {
            type: 'poll', title: 'Sentinel open poll', description: '', authorPublicKey: carol.pk, pollOpenVote: true,
            pollOptions: [{ id: 'opt_a', text: 'Yes' }, { id: 'opt_b', text: 'No' }], durationDays: 7,
        }, carol);
        const openId = open.body?.post?.id as string;
        assert(open.status === 200 && open.body?.post?.pollOpenVote === true, `Carol makes an open vote (got ${open.status} ${open.text.slice(0, 120)})`);
        const notQuite = await post('/api/marketplace/posts', {
            type: 'poll', title: 'Sentinel not-quite-open poll', description: '', authorPublicKey: dora.pk, pollOpenVote: 'true',
            pollOptions: [{ id: 'opt_a', text: 'Yes' }, { id: 'opt_b', text: 'No' }], durationDays: 7,
        }, dora);
        assert(notQuite.status === 200 && notQuite.body?.post?.pollOpenVote === false, 'only `true` opens a vote: anything else is anonymous');

        const carolSock3 = await openSocket(`${wsBase}?${signedWsQuery(carol)}`);
        await sleep(200);
        const v1 = await post(`/api/marketplace/posts/${anonId}/vote`, { optionId: 'opt_b' }, bob);
        assert(v1.status === 200 && v1.body?.post?.userVotedOptionId === 'opt_b' && !('pollVotes' in (v1.body?.post ?? {})),
            `Bob votes on the anonymous poll: told his own choice, and no voter list (got ${v1.status} ${v1.text.slice(0, 120)})`);
        const v2 = await post(`/api/marketplace/posts/${openId}/vote`, { optionId: 'opt_a' }, bob);
        assert(v2.status === 200 && Array.isArray(v2.body?.post?.pollVotes) && v2.body.post.pollVotes.some((v: any) => v.voterPubkey === bob.pk),
            `Bob votes on the open one, and a member is answered with its voters (got ${v2.status})`);
        await sleep(400);
        const anonEv = carolSock3.events.filter(e => e.type === 'post_updated' && e.post?.id === anonId);
        assert(anonEv.length > 0 && anonEv.every(e => !('pollVotes' in e.post) && !('userVotedOptionId' in e.post)),
            "a member's socket hears the anonymous poll change, with neither its voters nor Bob's own choice");
        const openEv = carolSock3.events.filter(e => e.type === 'post_updated' && e.post?.id === openId);
        assert(openEv.some(e => Array.isArray(e.post.pollVotes)) && openEv.every(e => !('userVotedOptionId' in e.post)),
            "and hears the open vote's voters, without Bob's own choice riding along as hers");
        carolSock3.ws.close();

        const find = (r: Res, id: string) => (Array.isArray(r.body) ? r.body : []).find((p: any) => p.id === id);
        for (const [who, id] of [['Alice, its author', alice], ['Bob, the voter', bob], ['Carol', carol], ['a suspended member', sam]] as const) {
            for (const path of ['/api/marketplace/posts?type=poll', `/api/marketplace/posts?id=${anonId}`, '/api/marketplace/posts?sync=true']) {
                const r = await get(path, id);
                const p = find(r, anonId);
                if (path.includes('sync') && !p) continue;
                assert(!!p && p.totalVotes === 1 && p.pollOptions?.find((o: any) => o.id === 'opt_b')?.votes === 1 && !('pollVotes' in p) && p.pollOpenVote === false,
                    `${who} reads the anonymous poll's counts and no voters on ${path}`);
            }
        }
        for (const [who, id, voters] of [['Alice', alice, true], ['Bob', bob, true], ['Carol, its creator', carol, true], ['a suspended member', sam, false]] as const) {
            const r = await get(`/api/marketplace/posts?id=${openId}`, id);
            const p = find(r, openId);
            if (voters) assert(p?.pollOpenVote === true && Array.isArray(p?.pollVotes) && p.pollVotes.some((v: any) => v.voterPubkey === bob.pk && v.optionId === 'opt_a'),
                `${who}, a member, reads the open vote's voters`);
            else assert(!!p && !('pollVotes' in p), `${who} reads its counts only`);
        }

        const flipAfter = await post('/api/marketplace/posts/update', { id: openId, authorPublicKey: carol.pk, pollOpenVote: false }, carol);
        assert(flipAfter.status === 400 && /open vote/.test(flipAfter.body?.error ?? ''), `the open vote can't be made anonymous once voted on (got ${flipAfter.status} ${flipAfter.text.slice(0, 120)})`);
        const flipAnon = await post('/api/marketplace/posts/update', { id: anonId, authorPublicKey: alice.pk, pollOpenVote: true }, alice);
        assert(flipAnon.status === 400, `nor the anonymous one opened (got ${flipAnon.status})`);
        const stillAnon = find(await get(`/api/marketplace/posts?id=${anonId}`, carol), anonId);
        assert(stillAnon?.pollOpenVote === false && !('pollVotes' in stillAnon), 'the anonymous poll is still anonymous');
        const flipBefore = await post('/api/marketplace/posts/update', { id: notQuite.body?.post?.id, authorPublicKey: dora.pk, pollOpenVote: true }, dora);
        assert(flipBefore.status === 200 && flipBefore.body?.post?.pollOpenVote === true, `before anyone votes, its creator may still change it (got ${flipBefore.status} ${flipBefore.text.slice(0, 120)})`);

        let stored: number | null = null;
        try { stored = (db.prepare('SELECT poll_open_vote FROM posts WHERE id = ?').get(openId) as { poll_open_vote: number }).poll_open_vote; } catch { /* no such column */ }
        assert(stored === 1, 'the choice is stored with the post');
        const payload = await se.exportSyncState('privacy-test');
        const exported = (payload.posts ?? []).filter((p: any) => p.id === openId || p.id === anonId);
        assert(exported.find((p: any) => p.id === openId)?.pollOpenVote === true && exported.find((p: any) => p.id === anonId)?.pollOpenVote === false,
            'and replicates with it');
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Balances and trades are private, local listings are members-only, and polls are anonymous by default.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
