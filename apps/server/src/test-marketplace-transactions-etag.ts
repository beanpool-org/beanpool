/**
 * A member's trades (GET /api/marketplace/transactions) answer a tag, and a 304 while the phone's copy is still the answer.
 *
 * The phone reads this list on every sync cycle (apps/native services/pillar-sync.ts), and a member with deals was sent
 * all of it each time: 12,617 bytes, 3,288 gzipped, about 470 KB a day at the 5-minute foreground timer (#1792's
 * measurement, the #1999 review), on the prepaid data our members pay for. The phone's platform HTTP cache (OkHttp,
 * NSURLCache) sends the last tag back by itself, so a 304 is the whole saving.
 *
 * Boots the real server and reads over HTTPS, signed, through the signature middleware (read auth on, the fresh-download
 * default). Checks:
 *   - the first read is a 200 with a strong tag, `private, no-cache`, and Vary on the reader's key; the same read with
 *     that tag (plain, as W/"…" as the gzip layer hands it out, or in a list) is a 304 with no body;
 *   - each kind of change to one of the reader's trades moves the tag (a 200 with the change in it), for both parties:
 *     a request, an approval, a completion, a rating, a cancel, a rejected request, a dispute settled, a party renamed;
 *     and a trade between two other members leaves it standing;
 *   - another member's tag never confirms a copy: two members with no trades (the same body, `[]`) get different tags,
 *     and either one's tag on the other's read is a 200; an unsigned read, or a member reading someone else's trades,
 *     with a tag that matches, is refused (401, 403), never a 304;
 *   - what a cycle costs on the wire for a member with 50 deals, before (a 200 every cycle) and after (a 304).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-marketplace-transactions-etag.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Module consts read at import, so they are removed before the dynamic imports in main(): read auth on, as a fresh node.
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;

import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setMemberPhoto } from '@beanpool/engine';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

type Id = { name: string; pk: string; privateKey: crypto.KeyObject };

function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { name, pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
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

interface Read { status: number; text: string; etag: string | null; headers: Headers }

async function get(path: string, id: Id | null, extra: Record<string, string> = {}): Promise<Read> {
    const res = await fetch(`${BASE}${path}`, { headers: { ...(id ? signedHeaders('GET', path, '', id) : {}), ...extra } });
    return { status: res.status, text: await res.text(), etag: res.headers.get('etag'), headers: res.headers };
}

async function post(path: string, payload: unknown, id: Id): Promise<{ status: number; body: any }> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', path, body, id) },
        body,
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

const tradesOf = (who: Id) => `/api/marketplace/transactions?publicKey=${who.pk}&limit=50`;
const bare = (tag: string | null) => (tag ?? '').replace(/^W\//, '');

async function main() {
    console.log('A member\'s trades answer a tag, and a 304 while the copy is still the answer...\n');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, reconcileLedgerFromDb, resolveEscrowDispute } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { ledger } = await import('./engine/ledger.js');
    const { updateGatewayConfig } = await import('./config/local-config.js');
    const { DEFAULT_GATEWAY_CONFIG } = await import('./config/gateway.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const member = (name: string, balance = 1_000): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, ?, 'seed', ?, 'active')`).run(id.pk, name, weekAgo, `INV-${name.toUpperCase()}`);
        setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
        // The epoch now, never 0: epoch 0 is 1970, and the first read would charge decades of demurrage.
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)').run(id.pk, balance, ledger.getCurrentEpoch());
        return id;
    };
    const listing = (owner: Id, title: string, credits = 5): string => {
        const id = `post-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey) VALUES (?, 'offer', 'food', ?, '', ?, ?)`)
            .run(id, title, credits, owner.pk);
        return id;
    };

    const ann = member('Ann'), ben = member('Ben'), cy = member('Cy'), dee = member('Dee');
    reconcileLedgerFromDb();
    const honey = listing(ann, 'Honey'), bread = listing(ann, 'Bread'), jam = listing(ann, 'Jam'), eggs = listing(ann, 'Eggs');
    const plums = listing(dee, 'Plums');
    // A buyer lists an offer of their own first (CONTRIBUTION_REQUIRED).
    listing(ben, 'Kindling'); listing(cy, 'Lemons');

    // ── The first read, and the same read again ──
    const first = await get(tradesOf(ben), ben);
    assert(first.status === 200 && first.text === '[]', `Ben's first read is a 200 with his (empty) list (${first.status} ${first.text})`);
    assert(!!first.etag && /^"mtx-[0-9a-f]{32}"$/.test(first.etag), `it carries a strong tag (${first.etag})`);
    assert(first.headers.get('cache-control') === 'private, no-cache', `Cache-Control: private, no-cache (${first.headers.get('cache-control')})`);
    const vary = (first.headers.get('vary') ?? '').split(',').map(s => s.trim().toLowerCase());
    assert(vary.includes('x-public-key') && !vary.includes('x-signature') && !vary.includes('x-nonce') && !vary.includes('x-timestamp'),
        `Vary names the reader's key and none of the signature headers that change every request (${first.headers.get('vary')})`);

    const again = await get(tradesOf(ben), ben, { 'If-None-Match': first.etag! });
    assert(again.status === 304 && again.text === '', `the same read with that tag is a 304 with no body (${again.status}, ${again.text.length} bytes)`);
    assert(again.etag === first.etag, `the 304 carries the same tag (${again.etag})`);
    const weak = await get(tradesOf(ben), ben, { 'If-None-Match': `W/${first.etag}` });
    assert(weak.status === 304, `the tag as W/"…", the form the gzip layer hands out, is a 304 too (${weak.status})`);
    const listed = await get(tradesOf(ben), ben, { 'If-None-Match': `"something-else", ${first.etag}` });
    assert(listed.status === 304, `a list of tags holding it is a 304 (${listed.status})`);
    const stale = await get(tradesOf(ben), ben, { 'If-None-Match': '"mtx-00000000000000000000000000000000"' });
    assert(stale.status === 200 && stale.text === '[]', `a tag that isn't his is a 200 with the list (${stale.status})`);

    // ── Another member's tag never confirms a copy ──
    const cyFirst = await get(tradesOf(cy), cy);
    assert(cyFirst.status === 200 && cyFirst.text === '[]', `Cy has no trades either: the same body, [] (${cyFirst.text})`);
    assert(bare(cyFirst.etag) !== bare(first.etag), `and a different tag from Ben's (${cyFirst.etag} vs ${first.etag})`);
    const cyWithBens = await get(tradesOf(cy), cy, { 'If-None-Match': first.etag! });
    assert(cyWithBens.status === 200 && cyWithBens.text === '[]', `Ben's tag on Cy's read is a 200 (${cyWithBens.status})`);
    const benWithCys = await get(tradesOf(ben), ben, { 'If-None-Match': cyFirst.etag! });
    assert(benWithCys.status === 200, `Cy's tag on Ben's read is a 200 (${benWithCys.status})`);
    const unsigned = await get(tradesOf(ben), null, { 'If-None-Match': first.etag! });
    assert(unsigned.status === 401 && !unsigned.etag, `an unsigned read of Ben's trades with Ben's tag is refused 401, no tag, never a 304 (${unsigned.status})`);
    const cyReadsBen = await get(tradesOf(ben), cy, { 'If-None-Match': first.etag! });
    assert(cyReadsBen.status === 403 && !cyReadsBen.etag, `Cy reading Ben's trades with Ben's tag is refused 403, never a 304 (${cyReadsBen.status})`);

    // ── Each kind of change to one of the reader's trades moves the tag, for both parties ──
    const tags = new Map<string, string>([[ben.pk, first.etag!], [ann.pk, (await get(tradesOf(ann), ann)).etag!]]);
    /** Both parties read with the tag they hold: a 200 with a new tag whose list shows the change, then a 304 on it. */
    const moved = async (what: string, check: (list: any[]) => boolean) => {
        for (const who of [ben, ann]) {
            const held = tags.get(who.pk)!;
            const read = await get(tradesOf(who), who, { 'If-None-Match': held });
            let list: any[] = [];
            try { list = JSON.parse(read.text); } catch { /* checked below */ }
            assert(read.status === 200 && !!read.etag && bare(read.etag) !== bare(held) && check(list),
                `${what}: ${who.name}'s tag moves, a 200 with it in the list (${read.status}, ${held} → ${read.etag})`);
            const quiet = await get(tradesOf(who), who, { 'If-None-Match': read.etag ?? '' });
            assert(quiet.status === 304, `  and ${who.name}'s next read, nothing changed, is a 304 again (${quiet.status})`);
            if (read.etag) tags.set(who.pk, read.etag);
        }
    };
    const find = (list: any[], id: string) => list.find(t => t.id === id);

    const req = await post('/api/marketplace/posts/request', { postId: honey, buyerPublicKey: ben.pk }, ben);
    assert(req.status === 200 && !!req.body?.transaction?.id, `Ben asks for the honey (${req.status} ${JSON.stringify(req.body).slice(0, 160)})`);
    const t1 = req.body?.transaction?.id as string;
    await moved('a new trade (requested)', l => find(l, t1)?.status === 'requested');

    const ok = await post('/api/marketplace/transactions/approve', { transactionId: t1, authorPublicKey: ann.pk }, ann);
    assert(ok.status === 200, `Ann approves (${ok.status} ${JSON.stringify(ok.body).slice(0, 160)})`);
    await moved('a step on (approved: the Beans held)', l => find(l, t1)?.status === 'pending');

    const done = await post('/api/marketplace/transactions/complete', { transactionId: t1, confirmerPublicKey: ben.pk }, ben);
    assert(done.status === 200, `Ben confirms (${done.status} ${JSON.stringify(done.body).slice(0, 160)})`);
    await moved('completed', l => find(l, t1)?.status === 'completed');

    const rated = await post('/api/ratings', { raterPubkey: ben.pk, targetPubkey: ann.pk, stars: 5, comment: 'Lovely honey', transactionId: t1 }, ben);
    assert(rated.status === 200, `Ben rates Ann (${rated.status} ${JSON.stringify(rated.body).slice(0, 160)})`);
    await moved('a rating', l => find(l, t1)?.ratedByBuyer === true);

    const req2 = await post('/api/marketplace/posts/request', { postId: bread, buyerPublicKey: ben.pk }, ben);
    const t2 = req2.body?.transaction?.id as string;
    assert(req2.status === 200 && !!t2, `Ben asks for the bread (${req2.status})`);
    await moved('a second trade', l => find(l, t2)?.status === 'requested');
    const ok2 = await post('/api/marketplace/transactions/approve', { transactionId: t2, authorPublicKey: ann.pk }, ann);
    assert(ok2.status === 200, `Ann approves it (${ok2.status})`);
    await moved('approved', l => find(l, t2)?.status === 'pending');
    const cancelled = await post('/api/marketplace/transactions/cancel', { transactionId: t2, cancellerPublicKey: ben.pk }, ben);
    assert(cancelled.status === 200, `Ben cancels it (${cancelled.status} ${JSON.stringify(cancelled.body).slice(0, 160)})`);
    await moved('a cancel', l => find(l, t2)?.status === 'cancelled');

    const req3 = await post('/api/marketplace/posts/request', { postId: jam, buyerPublicKey: ben.pk }, ben);
    const t3 = req3.body?.transaction?.id as string;
    assert(req3.status === 200 && !!t3, `Ben asks for the jam (${req3.status})`);
    await moved('a third trade', l => find(l, t3)?.status === 'requested');
    const rejected = await post('/api/marketplace/transactions/reject', { transactionId: t3, authorPublicKey: ann.pk }, ann);
    assert(rejected.status === 200, `Ann turns it down (${rejected.status} ${JSON.stringify(rejected.body).slice(0, 160)})`);
    await moved('a request turned down', l => find(l, t3)?.status !== 'requested');

    const req4 = await post('/api/marketplace/posts/request', { postId: eggs, buyerPublicKey: ben.pk }, ben);
    const t4 = req4.body?.transaction?.id as string;
    assert(req4.status === 200 && !!t4, `Ben asks for the eggs (${req4.status})`);
    const ok4 = await post('/api/marketplace/transactions/approve', { transactionId: t4, authorPublicKey: ann.pk }, ann);
    assert(ok4.status === 200, `Ann approves it (${ok4.status})`);
    await moved('a fourth trade, held in escrow', l => find(l, t4)?.status === 'pending');
    // A dispute is settled by an admin (routes/admin.ts POST /api/local/admin/disputes/:id/resolve): the change is the
    // node's, the read that must see it is the member's, over HTTP.
    resolveEscrowDispute(t4, 'refund_to_buyer', newId('Admin').pk, { reason: 'test' });
    await moved('a dispute settled', l => find(l, t4)?.disputeResolution === 'refund_to_buyer');

    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run('Annie', ann.pk);
    await moved('a party renamed', l => find(l, t1)?.sellerCallsign === 'Annie');

    // ── A trade between two other members leaves the tag standing ──
    const other = await post('/api/marketplace/posts/request', { postId: plums, buyerPublicKey: cy.pk }, cy);
    assert(other.status === 200, `Cy asks Dee for the plums (${other.status})`);
    for (const who of [ben, ann]) {
        const read = await get(tradesOf(who), who, { 'If-None-Match': tags.get(who.pk)! });
        assert(read.status === 304, `a trade between Cy and Dee leaves ${who.name}'s tag standing: a 304 (${read.status})`);
    }
    const cyNow = await get(tradesOf(cy), cy, { 'If-None-Match': cyFirst.etag! });
    assert(cyNow.status === 200 && bare(cyNow.etag) !== bare(cyFirst.etag), `while Cy's moves (${cyNow.status})`);

    // ── What a cycle costs on the wire, for a member with 50 deals (the phone reads limit=50) ──
    const rae = member('Rae'), sam = member('Sam');
    for (let i = 0; i < 50; i++) {
        const postId = listing(sam, `Firewood, a trailer load (${i})`);
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
                    VALUES (?, ?, ?, ?, 5, 'completed', ?, ?)`)
            .run(crypto.randomUUID(), postId, rae.pk, sam.pk, new Date(Date.now() - i * 60_000).toISOString(), new Date().toISOString());
    }
    const headerBytes = (r: Read) => [...r.headers].reduce((n, [k, v]) => n + k.length + 2 + v.length + 2, 0) + `HTTP/1.1 ${r.status} \r\n\r\n`.length;
    const full = await get(tradesOf(rae), rae, { 'Accept-Encoding': 'identity' });
    const zipped = gzipSync(Buffer.from(full.text)).length;
    const gzFull = await get(tradesOf(rae), rae, { 'Accept-Encoding': 'gzip' });
    assert(full.status === 200 && JSON.parse(full.text).length === 50, `Rae's 50 deals: a 200 (${Buffer.byteLength(full.text)} bytes raw)`);
    assert(gzFull.headers.get('content-encoding') === 'gzip' && gzFull.etag === `W/${full.etag}`,
        `gzipped, the same tag made weak (${gzFull.etag}), as api-compression.ts does`);
    const confirmGz = await get(tradesOf(rae), rae, { 'Accept-Encoding': 'gzip', 'If-None-Match': gzFull.etag! });
    const confirmRaw = await get(tradesOf(rae), rae, { 'Accept-Encoding': 'identity', 'If-None-Match': full.etag! });
    assert(confirmGz.status === 304 && confirmRaw.status === 304, `a revalidation with either form of the tag is a 304 (${confirmGz.status}, ${confirmRaw.status})`);
    console.log(`\n  bytes per cycle, Rae (50 deals): before, a 200 every cycle: ${Buffer.byteLength(full.text)} B raw body`
        + ` (+ ${headerBytes(full)} B headers), ~${zipped} B gzipped body (+ ${headerBytes(gzFull)} B headers);`
        + ` after, nothing changed: a 304, 0 B body + ${headerBytes(confirmGz)} B headers\n`);

    console.log(`\n${passed}/${run} checks passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
    console.error('✗ crashed:', e);
    process.exit(1);
});
