/**
 * A listing taken off hands out no photo URL to a reader the photo route would refuse (#1653's deciding review, NB).
 *
 * Since #1653 a listing taken off (`active` 0: cancelled or removed by its author, a moderator's takedown, a suspension's
 * pause) serves its photos only to its author, the moderators and whoever may still read it by id (a cancelled event's
 * hosts and the people Going); anyone else gets 404. Three lists still handed everyone that listing's photo URL: a
 * member's trades (`coverImage`, GET /api/marketplace/transactions), their chats (`postPhoto`, GET
 * /api/messages/conversations/:publicKey) and the pricing guide (`thumbnailUrl`). So the buyer of a listing the seller
 * removed after the trade was handed a URL that 404s: an empty photo box rather than the app's no-photo state. Now each
 * list hands a URL only to a reader the photo route serves, by the route's own rule (state-engine offListingPhotoShownTo).
 *
 * The real server over TLS through the real signature middleware, a local node (every listing-photo URL keyed). Alice
 * sells; Bob bought her kettle and is Going to her event; Carol chats with Alice about the event; Mo is an admin.
 *
 *  1. Live: a trade and a chat about a live listing carry the listing's own photo URL, the same answer before and after
 *     another listing is taken off.
 *  2. The seller removes a listing after the trade: Bob's trade and chat carry no photo URL (null); Alice's still do,
 *     and the URL Alice is handed loads for her, signed.
 *  3. A cancelled event: Bob, Going, still gets its photo in his chat; Carol, not Going, gets none.
 *  4. The pricing guide: an item whose thumbnail is a listing's photo keeps it while the listing is live, has none once
 *     the listing is taken off.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-photo-off-listing-urls.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.CF_API_TOKEN;
delete process.env.CF_ZONE_ID;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.PRIVATE_PREVIEW;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { PRICING_CATEGORIES } from '@beanpool/core';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const DAY = 24 * 60 * 60 * 1000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

let beforeCall: () => void = () => {};
type Res = { status: number; text: string; body: any; type: string | null };
async function get(p: string, id?: Id): Promise<Res> {
    beforeCall();
    const res = await fetch(`${BASE}${p}`, { headers: id ? signedHeaders('GET', p, '', id) : {} });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body, type: res.headers.get('content-type') };
}

async function main(): Promise<void> {
    console.log('\n=== A listing taken off hands out no photo URL to a reader the photo route refuses ===\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { savePricingGuideItem } = await import('./db/pricing-guide-db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', ?, 'seed', ?)`)
            .run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString(), `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const alice = member('UrlAlice');
    const bob = member('UrlBob');
    const carol = member('UrlCarol');
    const mo = member('UrlMo');
    db.prepare("INSERT INTO node_roles (member_pubkey, role) VALUES (?, 'admin')").run(mo.pk);

    const make = (title: string, type: 'offer' | 'event' = 'offer', options: any = {}, category = 'food'): string =>
        se.createPost(type, category, title, `${title}, described`, 0, 'fixed', alice.pk, -28.55, 153.5, [TINY_PNG], false, undefined, false, options)!.id as string;
    /** The URL of the listing's first photo, as its author's read by id hands it out. */
    const urlOf = async (postId: string): Promise<string> => {
        const r = await get(`/api/marketplace/posts?id=${postId}&types=offer,need,poll,event`, alice);
        const url = Array.isArray(r.body) ? r.body[0]?.photos?.[0] : undefined;
        if (typeof url !== 'string') throw new Error(`no photo URL for ${postId} (${r.status} ${r.text.slice(0, 120)})`);
        return url;
    };
    const now = new Date().toISOString();
    /** A completed trade of Alice's listing to `buyer`, and a chat between the two about it, as the escrow leaves them. */
    const trade = (postId: string, buyer: Id): void => {
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
                    VALUES (?, ?, ?, ?, 5, 'completed', ?, ?)`).run(crypto.randomUUID(), postId, buyer.pk, alice.pk, now, now);
        db.prepare("UPDATE posts SET status = 'completed', completed_at = ? WHERE id = ?").run(now, postId);
    };
    const chat = (postId: string, other: Id): void => {
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by, created_at) VALUES (?, 'dm', ?, NULL, ?, ?)`).run(id, postId, other.pk, now);
        for (const pk of [alice.pk, other.pk]) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?)').run(id, pk, now);
    };

    const kept = make('Quokka kettle, still listed');
    const removed = make('Bilby teapot, removed after the trade');
    const ev = make('Platypus picnic, cancelled', 'event', { eventStartAt: new Date(Date.now() + 7 * DAY).toISOString() }, 'community');
    db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES (?, ?, 'going', 'test')`).run(ev, bob.pk);
    const url: Record<string, string> = {};
    for (const id of [kept, removed, ev]) url[id] = await urlOf(id);
    trade(kept, bob); chat(kept, bob);
    trade(removed, bob); chat(removed, bob);
    chat(ev, bob); chat(ev, carol);
    const cat = PRICING_CATEGORIES[0] as any;
    const item = (name: string, postId: string) => savePricingGuideItem({
        category: (typeof cat === 'string' ? cat : cat.id) as any, emoji: '🫖', name, description: name, priceBeans: 5, thumbnailUrl: url[postId],
    }).id;
    const keptItem = item('Kettle', kept);
    const removedItem = item('Teapot', removed);

    const trades = async (who: Id) => {
        const r = await get(`/api/marketplace/transactions?publicKey=${who.pk}`, who);
        if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`transactions for ${who.pk.slice(0, 8)}: ${r.status} ${r.text.slice(0, 120)}`);
        return r.body as any[];
    };
    const chats = async (who: Id) => {
        const r = await get(`/api/messages/conversations/${who.pk}`, who);
        const list = Array.isArray(r.body) ? r.body : r.body?.conversations;
        if (r.status !== 200 || !Array.isArray(list)) throw new Error(`chats for ${who.pk.slice(0, 8)}: ${r.status} ${r.text.slice(0, 120)}`);
        return list as any[];
    };
    const tradeOf = (list: any[], postId: string) => list.find(t => t.postId === postId);
    const chatOf = (list: any[], postId: string) => list.find(c => c.postId === postId);
    const guide = async (who: Id) => {
        const r = await get('/api/pricing-guide', who);
        if (r.status !== 200 || !Array.isArray(r.body?.items)) throw new Error(`pricing guide: ${r.status} ${r.text.slice(0, 120)}`);
        return r.body.items as any[];
    };

    // ── 1. live ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. live listings: the photo URL, as before ──');
    const before = { bobTrades: await trades(bob), aliceTrades: await trades(alice), bobChats: await chats(bob), aliceChats: await chats(alice) };
    for (const [who, list] of [['Bob', before.bobTrades], ['Alice', before.aliceTrades]] as const) {
        for (const id of [kept, removed]) {
            assert(tradeOf(list, id)?.coverImage === url[id], `${who}'s trade of a live listing carries its photo URL (got ${tradeOf(list, id)?.coverImage})`);
        }
    }
    for (const [who, list] of [['Bob', before.bobChats], ['Alice', before.aliceChats]] as const) {
        assert(chatOf(list, kept)?.postPhoto === url[kept], `${who}'s chat about a live listing carries its photo URL (got ${chatOf(list, kept)?.postPhoto})`);
    }
    {
        const items = await guide(bob);
        assert(items.find(i => i.id === removedItem)?.thumbnailUrl === url[removed], `the pricing guide's item of a live listing carries its photo (got ${items.find(i => i.id === removedItem)?.thumbnailUrl})`);
    }

    // ── 2. the seller removes a listing after the trade ─────────────────────────────────────
    console.log('\n── 2. the seller removes a listing after the trade ──');
    assert(se.removePost(removed, alice.pk), 'setup: Alice removes the traded teapot (removePost: active 0)');
    assert(se.removePost(ev, alice.pk), 'setup: Alice cancels her event');
    const after = { bobTrades: await trades(bob), aliceTrades: await trades(alice), bobChats: await chats(bob), aliceChats: await chats(alice) };
    {
        const b = tradeOf(after.bobTrades, removed);
        assert(!!b && b.coverImage === null, `Bob's trade of the removed listing carries no photo URL (got ${JSON.stringify(b?.coverImage)})`);
        assert(!!b && b.postTitle === 'Bilby teapot, removed after the trade' && b.status === 'completed', "…and still everything else: the title, the trade's status");
        const a = tradeOf(after.aliceTrades, removed);
        assert(a?.coverImage === url[removed], `Alice's (the seller's) trade still carries it (got ${a?.coverImage})`);
        const bc = chatOf(after.bobChats, removed);
        assert(!!bc && bc.postPhoto === null, `Bob's chat about the removed listing carries no photo URL (got ${JSON.stringify(bc?.postPhoto)})`);
        const ac = chatOf(after.aliceChats, removed);
        assert(ac?.postPhoto === url[removed], `Alice's chat about it still carries it (got ${ac?.postPhoto})`);
        // What each is handed agrees with what the photo route answers them.
        const asAlice = await get(url[removed], alice);
        assert(asAlice.status === 200 && asAlice.type === 'image/png', `the URL Alice is handed loads for her, signed (got ${asAlice.status})`);
        const asBob = await get(url[removed], bob);
        assert(asBob.status === 404, `…and is 404 to Bob, who is handed none (got ${asBob.status})`);
        const asMo = await get(url[removed], mo);
        assert(asMo.status === 200, `…and 200 to Mo, an admin, signed (got ${asMo.status})`);
    }
    {
        // The live listing's rows: the same answer as before, field for field.
        for (const [who, b, a] of [
            ["Bob's trade", tradeOf(before.bobTrades, kept), tradeOf(after.bobTrades, kept)],
            ["Alice's trade", tradeOf(before.aliceTrades, kept), tradeOf(after.aliceTrades, kept)],
            ["Bob's chat", chatOf(before.bobChats, kept), chatOf(after.bobChats, kept)],
            ["Alice's chat", chatOf(before.aliceChats, kept), chatOf(after.aliceChats, kept)],
        ] as const) {
            assert(!!b && JSON.stringify(b) === JSON.stringify(a), `${who} of the live listing is unchanged`);
        }
    }

    // ── 3. a cancelled event ────────────────────────────────────────────────────────────────
    console.log('\n── 3. a cancelled event: the people Going still read it ──');
    {
        const bc = chatOf(after.bobChats, ev);
        assert(bc?.postPhoto === url[ev], `Bob, Going, still has the cancelled event's photo in his chat (got ${JSON.stringify(bc?.postPhoto)})`);
        const asBob = await get(url[ev], bob);
        assert(asBob.status === 200, `…which the photo route serves him, signed (got ${asBob.status})`);
        const cc = chatOf(await chats(carol), ev);
        assert(!!cc && cc.postPhoto === null, `Carol, not Going, has none in hers (got ${JSON.stringify(cc?.postPhoto)})`);
        const asCarol = await get(url[ev], carol);
        assert(asCarol.status === 404, `…as the photo route answers her 404 (got ${asCarol.status})`);
        const ac = chatOf(after.aliceChats, ev);
        assert(ac?.postPhoto === url[ev], `Alice, its host, still has it (got ${JSON.stringify(ac?.postPhoto)})`);
    }

    // ── 4. the pricing guide ────────────────────────────────────────────────────────────────
    console.log('\n── 4. the pricing guide ──');
    for (const [who, reader] of [['Bob', bob], ['Alice', alice]] as const) {
        const items = await guide(reader);
        const gone = items.find(i => i.id === removedItem);
        assert(!!gone && gone.thumbnailUrl == null, `${who}: the item whose listing was removed has no thumbnail (got ${JSON.stringify(gone?.thumbnailUrl)})`);
        assert(items.find(i => i.id === keptItem)?.thumbnailUrl === url[kept], `${who}: the item of the live listing keeps its thumbnail`);
    }

    console.log(`\n${passed}/${run} passed`);
}

main().then(
    () => { const ok = passed === run; console.log(`\n${ok ? 'PASS' : 'FAIL'}: test-photo-off-listing-urls (${passed}/${run})`); process.exit(ok ? 0 : 1); },
    e => { console.error('✗ threw:', e); console.log(`\nFAIL: test-photo-off-listing-urls (${passed}/${run})`); process.exit(1); },
);
