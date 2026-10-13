/**
 * Reviews and the trades behind them (Marty, 2026-10-14, decision A): a review is public opinion about the RATED member;
 * the trade behind it stays the two parties'.
 *
 * Through the real server and its middleware. Ana sells to Ben twice and each rates the other each time; Cat trades with
 * nobody; Dee signs with a key that has no row; Vic is a visitor and Sue a suspended member.
 *   T1 Cat reads Ana's and Ben's reviews: stars, words, side, day, and no rater key, name, picture URL or deal id; the
 *      union of Cat's reads over every member names no pair.
 *   T2 Given is the reader's own: Cat → Ana's 403 own_only (a `?requester=` changes nothing); Ana → 200, Ben and the deals.
 *   T3 Ana reads her received reviews in full; Ben reads his own rows on Ana's list in full, marked mine; Cat sees no
 *      mine, a `?requester=` and a callsign shared with Ben change nothing.
 *   T4 Unsigned 401; Dee, Vic, Sue 403 members_only (in both boots).
 *   T5 The feed: Cat's has no rating_given, Ana's and Ben's do; Cat's If-None-Match with Ana's ETag is never a 304.
 *   T6 The header: count 2, raters 1, the average as before.
 *   T7 Cat's createdAt is the day at 12:00Z; Ana's is the exact second.
 *   T8 /api/marketplace/transactions?publicKey=Ana as Cat is refused (in both boots).
 *
 * Run (read auth on, the default; the opt-out is a second registered run), through the suite runner:
 *   SERVER_SUITES_ONLY=test-ratings-privacy node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const READ_AUTH = process.env.ENFORCE_READ_AUTH !== 'false';

let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

function signedHeaders(method: string, path: string, signer: Identity, bodyString = ''): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    return {
        'X-Public-Key': signer.pub,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

interface Answer { status: number; body: any; text: string; headers: Headers }
async function send(method: string, pathAndQuery: string, body?: unknown, signer?: Identity, extra: Record<string, string> = {}): Promise<Answer> {
    const bodyString = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { ...extra };
    if (bodyString !== undefined) headers['Content-Type'] = 'application/json';
    // Signed over the path only (the server's ctx.path), as both apps sign.
    if (signer) Object.assign(headers, signedHeaders(method, pathAndQuery.split('?')[0], signer, bodyString || ''));
    const res = await fetch(`${BASE}${pathAndQuery}`, { method, headers, body: bodyString });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text, headers: res.headers };
}

const show = (a: Answer) => `${a.status} ${a.text.slice(0, 200)}`;

async function main() {
    console.log(`Ratings privacy (read auth ${READ_AUTH ? 'on' : 'opted out'})`);
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const ana = keypair(), ben = keypair(), cat = keypair(), dee = keypair(), vic = keypair(), sue = keypair();
    seedGenesisMember(ana.pub, 'ana_r');
    const row = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_visitor)
                            VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis', ?)`);
    row.run(ben.pub, 'ben_r', 'active', 0);
    row.run(cat.pub, 'cat_r', 'active', 0);
    row.run(vic.pub, 'vic_r', 'active', 1);
    row.run(sue.pub, 'sue_r', 'suspended', 0);
    // Ben has a picture: its URL carries his key (M2).
    db.prepare("UPDATE members SET avatar_ref = 'v1' WHERE public_key = ?").run(ben.pub);

    // Two finished deals: Ana sells to Ben twice.
    const deals: string[] = [];
    for (let i = 1; i <= 2; i++) {
        const postId = `post-rp-${i}`, dealId = `deal-rp-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO posts (id, author_pubkey, title, description, type, category, created_at) VALUES (?, ?, ?, ?, 'offer', 'goods', ?)`)
            .run(postId, ana.pub, `Eggs ${i}`, 'A dozen', new Date().toISOString());
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at) VALUES (?, ?, ?, ?, 10, 'completed', ?)`)
            .run(dealId, postId, ben.pub, ana.pub, new Date().toISOString());
        deals.push(dealId);
    }
    const stars = [5, 3];
    for (let i = 0; i < 2; i++) {
        const byBen = await send('POST', '/api/ratings', { targetPubkey: ana.pub, stars: stars[i], comment: `Lovely eggs ${i + 1}`, transactionId: deals[i] }, ben);
        const byAna = await send('POST', '/api/ratings', { targetPubkey: ben.pub, stars: 4, comment: `Paid promptly ${i + 1}`, transactionId: deals[i] }, ana);
        assert(byBen.status === 200 && byAna.status === 200, `setup: Ben and Ana rate deal ${i + 1} (${byBen.status}/${byAna.status})`);
    }

    const memberKeys = [ana.pub, ben.pub, cat.pub, vic.pub, sue.pub];
    const leaks = (text: string, keys: string[]): string[] => {
        const found: string[] = [];
        for (const k of keys) if (text.includes(k)) found.push(`key ${k.slice(0, 8)}…`);
        for (const d of deals) if (text.includes(d)) found.push(`deal ${d}`);
        for (const c of ['ana_r', 'ben_r']) if (text.includes(c)) found.push(`callsign ${c}`);
        if (text.includes('/api/avatar/')) found.push('an /api/avatar/ URL');
        if (/"(raterPubkey|rater_callsign|rater_avatar|transactionId|targetPubkey|id)"/.test(text)) found.push('a party/deal field');
        return found;
    };

    // ── T1: a third member reads a review and nobody behind it ──
    const catOnAna = await send('GET', `/api/ratings/${ana.pub}`, undefined, cat);
    const catOnBen = await send('GET', `/api/ratings/${ben.pub}`, undefined, cat);
    assert(catOnAna.status === 200 && Array.isArray(catOnAna.body?.ratings) && catOnAna.body.ratings.length === 2,
        `T1a. Cat reads Ana's two reviews (${show(catOnAna)})`);
    const first = catOnAna.body?.ratings?.[0] ?? {};
    assert(first.stars === 3 && first.comment === 'Lovely eggs 2' && first.role === 'provider' && typeof first.createdAt === 'string',
        `T1b. each carries stars, words, side and a date (${JSON.stringify(first)})`);
    assert(leaks(catOnAna.text, memberKeys).length === 0, `T1c. Ana's reviews as Cat name no key, name, picture or deal (${leaks(catOnAna.text, memberKeys).join(', ') || 'none'})`);
    assert(catOnBen.status === 200 && leaks(catOnBen.text, memberKeys).length === 0,
        `T1d. Ben's reviews as Cat name no key, name, picture or deal (${catOnBen.status}; ${leaks(catOnBen.text, memberKeys).join(', ') || 'none'})`);
    let union = '';
    for (const k of memberKeys) union += (await send('GET', `/api/ratings/${k}`, undefined, cat)).text;
    assert(!(union.includes(ana.pub) || union.includes(ben.pub)) && leaks(union, memberKeys).length === 0,
        `T1e. Cat's reads over every member name no pair (${leaks(union, memberKeys).join(', ') || 'none'})`);
    assert((catOnAna.headers.get('cache-control') || '').includes('no-store') && (catOnAna.headers.get('cache-control') || '').includes('private'),
        `T1f. no shared or stored copy (Cache-Control: ${catOnAna.headers.get('cache-control')})`);

    // ── T2: the reviews a member wrote are theirs alone ──
    const catGiven = await send('GET', `/api/ratings/${ana.pub}?direction=given`, undefined, cat);
    assert(catGiven.status === 403 && catGiven.body?.code === 'own_only' && !catGiven.text.includes(ben.pub),
        `T2a. Cat → Ana's given: 403 own_only (${show(catGiven)})`);
    const catGivenSpoof = await send('GET', `/api/ratings/${ana.pub}?direction=given&requester=${ana.pub}`, undefined, cat);
    assert(catGivenSpoof.status === 403 && catGivenSpoof.body?.code === 'own_only', `T2b. a ?requester= naming Ana changes nothing (${show(catGivenSpoof)})`);
    const anaGiven = await send('GET', `/api/ratings/${ana.pub}?direction=given`, undefined, ana);
    assert(anaGiven.status === 200 && anaGiven.body?.ratings?.length === 2 && anaGiven.text.includes(ben.pub) && deals.every(d => anaGiven.text.includes(d)),
        `T2c. Ana → her own given: 200, Ben and both deals (${anaGiven.status}, ${anaGiven.body?.ratings?.length} rows)`);

    // ── T3: the two parties read in full ──
    const anaOwn = await send('GET', `/api/ratings/${ana.pub}`, undefined, ana);
    assert(anaOwn.status === 200 && anaOwn.body.ratings.every((r: any) => r.raterPubkey === ben.pub && deals.includes(r.transactionId) && r.rater_callsign === 'ben_r'),
        `T3a. Ana reads her received reviews in full: Ben, his name and the deals (${anaOwn.status})`);
    const benOnAna = await send('GET', `/api/ratings/${ana.pub}`, undefined, ben);
    assert(benOnAna.status === 200 && benOnAna.body.ratings.length === 2
        && benOnAna.body.ratings.every((r: any) => r.mine === true && r.raterPubkey === ben.pub && deals.includes(r.transactionId)),
        `T3b. Ben reads his own rows on Ana's list in full, marked mine (${benOnAna.text.slice(0, 160)})`);
    assert(catOnAna.body.ratings.every((r: any) => !('mine' in r)), 'T3c. Cat\'s view has no mine');
    const catSpoof = await send('GET', `/api/ratings/${ana.pub}?requester=${ana.pub}`, undefined, cat);
    assert(catSpoof.status === 200 && leaks(catSpoof.text, memberKeys).length === 0 && catSpoof.body.ratings.every((r: any) => !('mine' in r)),
        `T3d. a ?requester= naming Ana gives Cat nothing more (${leaks(catSpoof.text, memberKeys).join(', ') || 'none'})`);
    // A review is its writer's by key, never by a name. Ben renames: his rows are still his.
    db.prepare("UPDATE members SET callsign = 'ben_renamed' WHERE public_key = ?").run(ben.pub);
    const benRenamed = await send('GET', `/api/ratings/${ana.pub}`, undefined, ben);
    assert(benRenamed.body?.ratings?.every((r: any) => r.mine === true && r.raterPubkey === ben.pub),
        `T3e. renamed, Ben's rows are still his (${benRenamed.text.slice(0, 120)})`);
    // Ben, back to his name, leaves (a pruned account frees its name: idx_members_callsign_unique), and Cat takes it.
    db.prepare("UPDATE members SET callsign = 'ben_r', status = 'pruned' WHERE public_key = ?").run(ben.pub);
    db.prepare("UPDATE members SET callsign = 'ben_r' WHERE public_key = ?").run(cat.pub);
    const catAsBenR = await send('GET', `/api/ratings/${ana.pub}`, undefined, cat);
    assert(catAsBenR.status === 200 && catAsBenR.body.ratings.length === 2
        && catAsBenR.body.ratings.every((r: any) => !('mine' in r) && !('raterPubkey' in r)) && !catAsBenR.text.includes(ben.pub),
        `T3f. Cat, now called what Ben was, gets nothing of his (${catAsBenR.text.slice(0, 120)})`);
    db.prepare("UPDATE members SET callsign = 'cat_r' WHERE public_key = ?").run(cat.pub);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(ben.pub);

    // ── T4: who reads at all, whatever ENFORCE_READ_AUTH says ──
    const unsigned = await send('GET', `/api/ratings/${ana.pub}`);
    assert(unsigned.status === 401 && !unsigned.text.includes(ben.pub), `T4a. unsigned: 401 (${show(unsigned)})`);
    // Under read auth the gate in front refuses a key with no row and a visitor first, in its own words; the route's own
    // refusal (members_only) answers them under the opt-out, and a suspended member (who passes the gate) in both.
    const GATE_REFUSAL = 'Read access requires a member identity';
    for (const [who, reader, gated] of [['Dee, a key with no row', dee, true], ['Vic, a visitor', vic, true], ['Sue, suspended', sue, false]] as Array<[string, Identity, boolean]>) {
        const r = await send('GET', `/api/ratings/${ana.pub}`, undefined, reader);
        const refused = READ_AUTH && gated ? r.body?.error === GATE_REFUSAL : r.body?.code === 'members_only';
        assert(r.status === 403 && refused && !r.text.includes(ben.pub) && !r.text.includes('Lovely'),
            `T4b. ${who}: 403 ${READ_AUTH && gated ? 'by the read gate' : 'members_only'} (${show(r)})`);
    }

    // ── T5: the feed line reaches the two parties only ──
    const feedOf = (reader: Identity, extra: Record<string, string> = {}) => send('GET', '/api/activity/feed?limit=50', undefined, reader, extra);
    const anaFeed = await feedOf(ana), benFeed = await feedOf(ben), catFeed = await feedOf(cat);
    const rated = (a: Answer) => (a.body?.feed ?? []).filter((e: any) => e.eventType === 'rating_given').length;
    assert(anaFeed.status === 200 && rated(anaFeed) === 4 && benFeed.status === 200 && rated(benFeed) === 4,
        `T5a. Ana's and Ben's feeds carry the reviews (${rated(anaFeed)}/${rated(benFeed)})`);
    assert(catFeed.status === 200 && rated(catFeed) === 0 && !catFeed.text.includes('Lovely eggs'),
        `T5b. Cat's feed has no rating_given (${rated(catFeed)})`);
    const anaEtag = anaFeed.headers.get('etag') || '';
    const catWithAnasEtag = await feedOf(cat, { 'If-None-Match': anaEtag });
    assert(!!anaEtag && catWithAnasEtag.status === 200 && rated(catWithAnasEtag) === 0,
        `T5c. Cat's If-None-Match with Ana's ETag is answered with Cat's own body, never a 304 (${catWithAnasEtag.status})`);

    // ── T6: the header ──
    assert(catOnAna.body.count === 2 && catOnAna.body.raters === 1 && catOnAna.body.average === 4
        && catOnAna.body.asProvider?.count === 2 && catOnAna.body.asProvider?.average === 4,
        `T6. Ana's header: count 2, raters 1, average 4 (${JSON.stringify({ count: catOnAna.body.count, raters: catOnAna.body.raters, average: catOnAna.body.average, asProvider: catOnAna.body.asProvider })})`);

    // ── T7: the day, not the second ──
    const stored = (db.prepare('SELECT created_at FROM ratings WHERE target_pubkey = ? ORDER BY created_at DESC, rowid DESC').all(ana.pub) as { created_at: string }[]).map(r => r.created_at);
    assert(catOnAna.body.ratings.every((r: any, i: number) => /^\d{4}-\d{2}-\d{2}T12:00:00(\.000)?Z$/.test(r.createdAt) && r.createdAt.slice(0, 10) === stored[i].slice(0, 10)),
        `T7a. Cat reads the day at 12:00Z (${catOnAna.body.ratings.map((r: any) => r.createdAt).join(', ')})`);
    assert(anaOwn.body.ratings.map((r: any) => r.createdAt).join(',') === stored.join(','),
        `T7b. Ana reads the exact time (${anaOwn.body.ratings.map((r: any) => r.createdAt).join(', ')})`);

    // ── T8: another member's deals are not listed (open PR #1909 moves this rule out of the switch) ──
    const catOnAnaDeals = await send('GET', `/api/marketplace/transactions?publicKey=${ana.pub}`, undefined, cat);
    assert(catOnAnaDeals.status === 403 && !catOnAnaDeals.text.includes(ben.pub),
        `T8. Cat listing Ana's deals is refused (${show(catOnAnaDeals)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
