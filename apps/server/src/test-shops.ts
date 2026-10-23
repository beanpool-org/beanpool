/**
 * Shops on the server (slice S1 of scratch/tools/DESIGN-shops-and-tools-fable.md §9.1 and §12; Marty's answers and
 * decision of 19 Oct 2026; the tool template's §6 row S1): a shop is a front window on an account, a member's or an
 * enterprise's (engine/shops.ts, routes/shops.ts).
 *
 * Over REAL HTTPS through the real signature middleware:
 *
 *   1. a member's shop: none at first; opened by a PUT with nothing in it (no name: the apps say "<name>'s shop" in the
 *      member's language), one per member (the same id again); dressed one field at a time (name, kind, blurb, how I
 *      deal), each held to its bound in a sentence, an empty one cleared; a kind that is none of the fourteen refused
 *   2. what goes in it: an Offer put in at create, by the edit toggle (and out again), and by "Add my live Offers"; refused,
 *      writing nothing: a Need or an event, another member's shop, a shop that isn't there, an Offer for a group or one
 *      person, a batch naming anything but the member's own live Offers. An enterprise's Offers go in its shop through its
 *      own route, by a keeper; a keeper's own Offer can't go in the enterprise's shop, nor the enterprise's in the
 *      keeper's, nor its Need or its event
 *   3. `shop=` on the listings: that shop's listings only, each naming its shop; with `author=` its owner sees the paused
 *      ones too; given twice, 400
 *   4. a shop read by a member: its name, owner, words and counts (things, available, to borrow, to buy, out, new this
 *      week); one that isn't there 404
 *   5. a visitor (the global profile's visitors' view): one shop and the shops near a place answer kind and counts
 *      only, never the name, the owner or their words; no member's key or name anywhere in the answer; the listings keep
 *      their shop and lose their author; a member reads the whole shop; without the visitors' view a stranger is refused
 *   6. shops near a place: those with a live listing within the radius, nearest first, each once; a shop with more
 *      Offers than a page of listings hides none past it, for a member and a visitor alike, up to the most one read answers
 *   7. pause and reopen: refused while a deal on one of its things is open, saying how many; paused, its live Offers leave
 *      the board and the shop says closed, back on a date if given; nothing goes in while it is; one of its Offers can't be
 *      put back up alone; reopened, what the pause took down comes back and what its owner had paused stays paused
 *   8. close: refused while a deal is open; closed, the row goes with a tombstone and its Offers stay as ordinary Offers,
 *      or end when asked; a shop opened after is a new one; muted, a close that would put a pause's Offers back up is
 *      refused, and one that ends them is not
 *   9. an enterprise's shop: made with the enterprise; its name is the enterprise's and follows a rename; its blurb is
 *      the purpose until a keeper writes one; only a keeper reads it as its keeper or changes it; its name can't be set
 *  10. accounts: a re-key moves the shop to the new key; a member's deletion and an admin's removal take it, with a
 *      tombstone, and their listings name it no more
 *  11. a standby: refuses every change, 409; a whole copy carries every shop and each listing's shop verbatim; a delta
 *      carries a dressing, a new shop, a close's tombstone and the listings it cleared; a member's close and new shop in
 *      one delta leave the standby the new shop, not none; the standby answers each shop read as the main server does,
 *      and an enterprise's shop's name follows the enterprise's row
 *  12. Home's "Your shop and tools" (slice S4′, built by the node): asked by its id, the reader's own shop (its name or
 *      none, its owner's name, kind, counts as their own read says, closed for now and back on), or none in it, never left
 *      out; nothing of another member's; not asked, not built; with no `cards=`, built when the member's layout holds it
 *  13. the owner's word over a shop closed for now: their pause of an Offer the shop paused is taken (anyone else's is
 *      not) and makes the pause theirs, as ending it or editing it out of the shop does; a pause of one they paused already
 *      is taken too; the reopen puts back up only what the shop paused and still holds
 *
 * Local only: it talks to the server it starts on localhost, and to nothing else.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-shops.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
process.env.ADMIN_PASSWORD = 'ShopsPass123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, adminPruneUser, purgeMemberSelf, exportSyncState, signSyncPayload, importRemoteState,
    setNodeRole, reconcileLedgerFromDb, createProject, updateProject, createPost,
} from './state-engine.js';
import { SHOPS_NEAR_MAX } from './routes/shops.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { setSwitchOverride } from './config/node-profile.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { emptyCopiedTables } from './engine/copied-tables.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { ledger } from './engine/ledger.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without shops (no such table, no such column) fails its assertion, not the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}

let BASE = '';

// ── members and signed requests ─────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
const WEEK_AGO = () => new Date(Date.now() - 7 * 86_400_000).toISOString();
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor)
                VALUES (?, ?, ?, ?, 'TEST', 'active', 0)`).run(id.pk, name, WEEK_AGO(), owner.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, ledger.getCurrentEpoch());
    return id;
}

type Method = 'GET' | 'PUT' | 'DELETE' | 'POST';
interface Res { status: number; body: any; text: string }
async function call(method: Method, id: Id | null, route: string, body?: unknown): Promise<Res> {
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
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 220)}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** By id, in code-unit order, as SQLite's ORDER BY id is. */
const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// ── the shop's routes ───────────────────────────────────────────────────────────────────────────
const MINE = '/api/shops/mine';
const shopPath = (id: string) => `/api/shops/${id}`;
const nearPath = (lat: number, lng: number, km?: number) => `/api/shops?lat=${lat}&lng=${lng}${km ? `&radiusKm=${km}` : ''}`;
const entShop = (t: string) => `/api/treasury/${t}/shop`;

// ── what is kept, read straight from the database ─────────────────────────────────────────────────
interface ShopRow { id: string; owner_pubkey: string; name: string | null; kind: string | null; blurb: string | null; how_to_deal: string | null;
    opened_at: string; paused_at: string | null; back_on: string | null; paused_posts: string | null; updated_at: string }
const shopRowOf = (pk: string) => attempt(() => db.prepare('SELECT * FROM shops WHERE owner_pubkey = ?').get(pk) as ShopRow | undefined);
const shopRowById = (id: string) => attempt(() => db.prepare('SELECT * FROM shops WHERE id = ?').get(id) as ShopRow | undefined);
const everyShop = () => attempt(() => db.prepare('SELECT * FROM shops ORDER BY id').all() as ShopRow[]) ?? [];
const shopTomb = (id: string) => (db.prepare("SELECT deleted_at FROM tombstones WHERE table_name = 'shops' AND row_key = ?").get(id) as { deleted_at: string } | undefined)?.deleted_at ?? null;
interface PostRow { id: string; type: string; status: string; active: number; shop_id: string | null; author_pubkey: string; updated_at: string }
const postRow = (id: string) => attempt(() => db.prepare('SELECT id, type, status, active, shop_id, author_pubkey, updated_at FROM posts WHERE id = ?').get(id) as PostRow | undefined);
const shopIdOf = (postId: string) => postRow(postId)?.shop_id ?? null;

const MULLUM = { lat: -28.55, lng: 153.50 };
const NEAR_MULLUM = { lat: -28.65, lng: 153.60 }; // ~15 km
const CASTLEMAINE = { lat: -37.06, lng: 144.21 };
const HOBART = { lat: -42.88, lng: 147.33 };

async function main(): Promise<void> {
    console.log('\n=== Shops: a front window on an account ===\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const shopsModule: any = await import('./engine/shops.js').catch(() => null);
    assert(typeof shopsModule?.shopOf === 'function', 'engine/shops.ts exports shopOf');

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const dave = member('DaveSentinel');
    const ann = member('AnnSentinel');
    const bo = member('BoSentinel');
    const cy = member('CySentinel');
    const eve = member('EveSentinel');
    const fay = member('FaySentinel');
    const gus = member('GusSentinel');
    const outsider = newId('Nemo'); // a key that is no member here
    reconcileLedgerFromDb();

    const offer = async (who: Id, title: string, extra: Record<string, unknown> = {}) => call('POST', who, '/api/marketplace/posts', {
        type: 'offer', category: 'tools', title, description: `${title}, in good order`, credits: 0, authorPublicKey: who.pk,
        lat: MULLUM.lat, lng: MULLUM.lng, ...extra,
    });
    const offerId = async (who: Id, title: string, extra: Record<string, unknown> = {}): Promise<string> => {
        const r = await offer(who, title, extra);
        if (r.status !== 200 || !r.body?.post?.id) throw new Error(`setup: ${who.name} could not offer ${title}: ${show(r)}`);
        return r.body.post.id;
    };
    const edit = (who: Id, id: string, body: Record<string, unknown>) => call('POST', who, '/api/marketplace/posts/update', { id, authorPublicKey: who.pk, ...body });
    const listShop = async (reader: Id | null, shopId: string, extra = '') =>
        call('GET', reader, `/api/marketplace/posts?shop=${encodeURIComponent(shopId)}${extra}`);
    const ids = (r: Res): string[] => (Array.isArray(r.body) ? r.body : []).map((p: any) => p.id).sort();

    // ── 1. a member's shop ──────────────────────────────────────────────────────────────────────
    console.log('── 1. a member\'s shop: opened, one each, dressed one field at a time ──');
    const none = await call('GET', dave, MINE);
    assert(none.status === 200 && none.body?.shop === null, `none at first (${show(none)})`);
    const opened = await call('PUT', dave, MINE, {});
    const daveShop: string = opened.body?.shop?.id;
    assert(opened.status === 200 && typeof daveShop === 'string' && opened.body.shop.name === null && opened.body.shop.ownerName === 'DaveSentinel'
        && opened.body.shop.ownerPublicKey === dave.pk && opened.body.shop.enterprise === false && opened.body.shop.kind === null
        && opened.body.shop.paused === false && opened.body.shop.counts?.things === 0,
        `opened by a PUT with nothing in it: no name of its own, its owner named, nothing in it (${show(opened)})`);
    const row1 = shopRowOf(dave.pk);
    assert(!!row1 && row1.id === daveShop && row1.name === null && typeof row1.opened_at === 'string' && typeof row1.updated_at === 'string',
        'one row, keyed by its own id, owned by the signer');
    const again = await call('PUT', dave, MINE, {});
    assert(again.status === 200 && again.body?.shop?.id === daveShop && everyShop().filter(s => s.owner_pubkey === dave.pk).length === 1,
        `one shop per member: a second PUT is the same shop (${show(again)})`);
    const dressed = await call('PUT', dave, MINE, { name: "Dave's Tool Shed", kind: 'tools', blurb: 'Drills, ladders, a tent.', howToDeal: 'Pick up from the front gate, back within a week.' });
    assert(dressed.status === 200 && dressed.body?.shop?.name === "Dave's Tool Shed" && dressed.body.shop.kind === 'tools'
        && dressed.body.shop.blurb === 'Drills, ladders, a tent.' && dressed.body.shop.howToDeal === 'Pick up from the front gate, back within a week.',
        `dressed: name, kind, blurb and how I deal (${show(dressed)})`);
    const onlyKind = await call('PUT', dave, MINE, { kind: 'repairs' });
    assert(onlyKind.status === 200 && onlyKind.body?.shop?.kind === 'repairs' && onlyKind.body.shop.name === "Dave's Tool Shed" && onlyKind.body.shop.blurb === 'Drills, ladders, a tent.',
        'one field at a time: the others stay as they were');
    const before = JSON.stringify(shopRowOf(dave.pk));
    const refusals = [
        await call('PUT', dave, MINE, { kind: 'weapons' }),
        await call('PUT', dave, MINE, { name: 'x'.repeat(61) }),
        await call('PUT', dave, MINE, { blurb: 'y'.repeat(301) }),
        await call('PUT', dave, MINE, { howToDeal: 'z'.repeat(301) }),
        await call('PUT', dave, MINE, { name: 42 }),
        await call('PUT', dave, MINE, { backOn: 'soon', paused: true }),
    ];
    assert(refusals.every(r => r.status === 400 && typeof r.body?.error === 'string' && r.body.error.length > 10) && JSON.stringify(shopRowOf(dave.pk)) === before,
        `refused in a sentence, writing nothing: a kind that isn't one, a name over 60, a blurb or how I deal over 300, a name that isn't text, a back-on that isn't a date (${refusals.map(r => r.status).join(', ')}: ${refusals.map(r => r.body?.error).join(' | ')})`);
    const cleared = await call('PUT', dave, MINE, { howToDeal: '  ', kind: null });
    assert(cleared.status === 200 && cleared.body?.shop?.howToDeal === null && cleared.body.shop.kind === null && shopRowOf(dave.pk)?.how_to_deal === null,
        'an empty one is cleared, and null clears a kind');
    await call('PUT', dave, MINE, { kind: 'tools' });
    const annShop: string = (await call('PUT', ann, MINE, { name: "Ann's Garden", kind: 'food' })).body?.shop?.id;
    assert(typeof annShop === 'string' && annShop !== daveShop, "another member's shop is their own");
    const unsignedMine = await call('GET', null, MINE);
    assert(unsignedMine.status === 401 || unsignedMine.status === 403, `a member's own shop is a signed read (${show(unsignedMine)})`);

    // ── 2. what goes in it ──────────────────────────────────────────────────────────────────────
    console.log('\n── 2. what goes in it: an Offer only, the author\'s own shop only ──');
    const drill = await offer(dave, 'Drill', { shopId: daveShop });
    const drillId: string = drill.body?.post?.id;
    assert(drill.status === 200 && drill.body?.post?.shopId === daveShop && shopIdOf(drillId) === daveShop,
        `an Offer put in at create: stored and answered with its shop (${show(drill)})`);
    const ladderId = await offerId(dave, 'Ladder', { shopId: daveShop, lendable: true, lendMaxDays: 7 });
    const tentId = await offerId(dave, 'Tent', { shopId: daveShop });
    const postsBefore = (db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n;
    const need = await call('POST', dave, '/api/marketplace/posts', { type: 'need', category: 'tools', title: 'Need a saw', description: '', credits: 0, authorPublicKey: dave.pk, shopId: daveShop });
    const event = await call('POST', dave, '/api/marketplace/posts', { type: 'event', title: 'Tool swap', description: 'Bring one, take one', authorPublicKey: dave.pk,
        lat: MULLUM.lat, lng: MULLUM.lng, eventStartAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), shopId: daveShop });
    const others = await offer(dave, 'Into Ann\'s', { shopId: annShop });
    const madeUp = await offer(dave, 'Into nowhere', { shopId: 'no-such-shop' });
    const notText = await offer(dave, 'Into a number', { shopId: 12 });
    const direct = await offer(dave, 'For Cy alone', { shopId: daveShop, audienceScope: 'direct', targetPubkey: cy.pk });
    const postsAfter = (db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n;
    assert(need.status === 400 && need.body?.code === 'shop_offers_only' && /Offer/.test(need.body?.error ?? ''),
        `a Need is refused in a sentence (${show(need)})`);
    assert(event.status === 400 && event.body?.code === 'shop_offers_only', `so is an event, not made without its shop (${show(event)})`);
    assert([others, madeUp, notText].every(r => r.status === 403 && r.body?.code === 'shop_not_yours'),
        `another member's shop, one that isn't there and an id that isn't one are refused alike (${[others, madeUp, notText].map(show).join(' | ')})`);
    assert(direct.status === 400 && direct.body?.code === 'shop_public_only', `an Offer for one person stays out of a shop (${show(direct)})`);
    assert(postsAfter === postsBefore, `and none of them wrote a post (${postsBefore} → ${postsAfter})`);

    const oldOfferId = await offerId(dave, 'Wheelbarrow'); // posted before it went in the shop
    const toggledIn = await edit(dave, oldOfferId, { shopId: daveShop });
    assert(toggledIn.status === 200 && toggledIn.body?.post?.shopId === daveShop && shopIdOf(oldOfferId) === daveShop,
        `the edit toggle puts an Offer posted before into the shop (${show(toggledIn)})`);
    const stampIn = postRow(oldOfferId)?.updated_at ?? '';
    const toggledOut = await edit(dave, oldOfferId, { shopId: null });
    assert(toggledOut.status === 200 && !('shopId' in (toggledOut.body?.post ?? { shopId: 1 })) && shopIdOf(oldOfferId) === null && (postRow(oldOfferId)?.updated_at ?? '') > stampIn,
        `and takes it out again, the row restamped for the copies (${show(toggledOut)})`);
    const daveNeed = await call('POST', dave, '/api/marketplace/posts', { type: 'need', category: 'tools', title: 'Need a saw', description: '', credits: 0, authorPublicKey: dave.pk });
    const needIntoShop = await edit(dave, daveNeed.body?.post?.id, { shopId: daveShop });
    const editOthers = await edit(dave, oldOfferId, { shopId: annShop });
    assert(needIntoShop.status === 400 && needIntoShop.body?.code === 'shop_offers_only' && shopIdOf(daveNeed.body?.post?.id) === null
        && editOthers.status === 403 && editOthers.body?.code === 'shop_not_yours' && shopIdOf(oldOfferId) === null,
        `the edit is held to the same rules: a Need, another member's shop (${show(needIntoShop)}; ${show(editOthers)})`);
    const annOffer = await offerId(ann, 'Ann spade');
    const cancelledOfferId = await offerId(dave, 'Old rake');
    await call('POST', dave, '/api/marketplace/posts/remove', { id: cancelledOfferId, authorPublicKey: dave.pk });
    const batchBad = await call('POST', dave, `${MINE}/offers`, { postIds: [oldOfferId, daveNeed.body?.post?.id, annOffer, cancelledOfferId] });
    assert(batchBad.status === 400 && batchBad.body?.code === 'shop_offers_not_yours' && shopIdOf(oldOfferId) === null,
        `"Add my live Offers" naming a Need, someone else's Offer or an ended one is refused whole, writing nothing (${show(batchBad)})`);
    const batchOthers = await call('POST', dave, `${MINE}/offers`, { postIds: [annOffer] });
    assert(batchOthers.status === 400 && batchOthers.body?.code === 'shop_offers_not_yours' && shopIdOf(annOffer) === null,
        `and one naming only another member's live Offer, writing nothing (${show(batchOthers)})`);
    const hoseId = await offerId(dave, 'Hose');
    const batch = await call('POST', dave, `${MINE}/offers`, { postIds: [oldOfferId, hoseId] });
    assert(batch.status === 200 && same([...(batch.body?.added ?? [])].sort(), [oldOfferId, hoseId].sort()) && shopIdOf(oldOfferId) === daveShop && shopIdOf(hoseId) === daveShop,
        `"Add my live Offers" puts the member's own live Offers in (${show(batch)})`);

    // An enterprise: Bo leads it, Cy keeps it too.
    const ent = await call('POST', bo, '/api/enterprise', { name: 'Bo Bikes Sentinel', purpose: 'Bikes fixed and lent around town.' });
    const bikes: string = ent.body?.publicKey;
    if (!bikes) throw new Error(`setup: Bo could not start an enterprise: ${show(ent)}`);
    setMemberPhoto(db, bikes, 'https://example.com/e.jpg');
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(cy.pk);
    db.prepare('INSERT OR IGNORE INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(bikes, cy.pk);
    const bikesShopRow = shopRowOf(bikes);
    const bikesShop = bikesShopRow?.id ?? '';
    assert(!!bikesShopRow && bikesShopRow.name === null && bikesShopRow.owner_pubkey === bikes, 'an enterprise\'s shop is made with it, owned by the enterprise');
    const entOffer = await call('POST', bo, `/api/treasury/${bikes}/offer`, { category: 'transport', title: 'Bike tune-up', credits: 0, shopId: bikesShop, lat: MULLUM.lat, lng: MULLUM.lng });
    assert(entOffer.status === 200 && entOffer.body?.post?.shopId === bikesShop && shopIdOf(entOffer.body?.post?.id) === bikesShop,
        `a keeper puts the enterprise's Offer in its shop through its own route (${show(entOffer)})`);
    const keeperOwnIntoEnt = await offer(bo, 'Bo\'s own pump', { shopId: bikesShop });
    const boShop: string = (await call('PUT', bo, MINE, {})).body?.shop?.id;
    const entIntoKeeper = await call('POST', bo, `/api/treasury/${bikes}/offer`, { category: 'transport', title: 'Into Bo\'s', credits: 0, shopId: boShop });
    const entNeed = await call('POST', bo, `/api/treasury/${bikes}/need`, { category: 'transport', title: 'Need tubes', credits: 0, shopId: bikesShop });
    const entPostsBefore = (db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n;
    const entEvent = await call('POST', bo, `/api/treasury/${bikes}/event`, { title: 'Bike repair night', description: 'Bring a bike',
        lat: MULLUM.lat, lng: MULLUM.lng, eventStartAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), shopId: bikesShop });
    const entPostsAfter = (db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n;
    assert(keeperOwnIntoEnt.status === 403 && keeperOwnIntoEnt.body?.code === 'shop_not_yours' && entIntoKeeper.status === 403 && entIntoKeeper.body?.code === 'shop_not_yours',
        `a keeper's own Offer can't go in the enterprise's shop, nor the enterprise's in the keeper's (${show(keeperOwnIntoEnt)}; ${show(entIntoKeeper)})`);
    assert(entNeed.status === 400 && entNeed.body?.code === 'shop_offers_only', `nor an enterprise's Need (${show(entNeed)})`);
    assert(entEvent.status === 400 && entEvent.body?.code === 'shop_offers_only' && entPostsAfter === entPostsBefore,
        `nor an enterprise's event, refused in the engine's words and not made (${show(entEvent)})`);

    // ── 3. shop= on the listings ────────────────────────────────────────────────────────────────
    console.log('\n── 3. shop= on the listings ──');
    const listed = await listShop(cy, daveShop);
    assert(listed.status === 200 && same(ids(listed), [drillId, ladderId, tentId, oldOfferId, hoseId].sort())
        && (listed.body as any[]).every(p => p.shopId === daveShop),
        `that shop's listings only, each naming its shop (${listed.status}: ${ids(listed).length})`);
    const notInShop = await call('GET', cy, `/api/marketplace/posts?id=${annOffer}`);
    assert(notInShop.status === 200 && notInShop.body?.[0] && !('shopId' in notInShop.body[0]), 'a listing in no shop says nothing about one');
    await call('POST', dave, '/api/marketplace/posts/pause', { postId: hoseId, authorPublicKey: dave.pk });
    const ownerView = await listShop(dave, daveShop, `&author=${dave.pk}`);
    const othersView = await listShop(cy, daveShop);
    assert(ids(ownerView).includes(hoseId) && !ids(othersView).includes(hoseId),
        `with author= its owner sees their paused one too; nobody else does (${ids(ownerView).length} / ${ids(othersView).length})`);
    const twice = await call('GET', cy, `/api/marketplace/posts?shop=${daveShop}&shop=${annShop}`);
    assert(twice.status === 400, `shop= given twice is a 400 (${show(twice)})`);
    const nowhere = await listShop(cy, 'no-such-shop');
    assert(nowhere.status === 200 && Array.isArray(nowhere.body) && nowhere.body.length === 0, 'a shop that isn\'t there lists nothing');

    // ── 4. a member's read ──────────────────────────────────────────────────────────────────────
    console.log('\n── 4. a shop read by a member ──');
    const read = await call('GET', cy, shopPath(daveShop));
    const c = read.body?.counts ?? {};
    assert(read.status === 200 && read.body?.id === daveShop && read.body.name === "Dave's Tool Shed" && read.body.ownerName === 'DaveSentinel'
        && read.body.ownerPublicKey === dave.pk && read.body.kind === 'tools' && read.body.blurb === 'Drills, ladders, a tent.' && read.body.enterprise === false,
        `its name, owner and words (${show(read)})`);
    assert(c.things === 4 && c.available === 4 && c.toBorrow === 1 && c.toBuy === 3 && c.out === 0 && c.newThisWeek === 4,
        `its counts: 4 things (the paused hose not among them), 1 to borrow, 3 to buy (${JSON.stringify(c)})`);
    const missing = await call('GET', cy, shopPath('no-such-shop'));
    assert(missing.status === 404 && missing.body?.code === 'shop_not_found', `one that isn't there: 404 (${show(missing)})`);
    await call('POST', dave, '/api/marketplace/posts/resume', { postId: hoseId, authorPublicKey: dave.pk });

    // ── 5. a visitor ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. a visitor: kind and counts only ──');
    const sentinels = [dave.pk, ann.pk, 'DaveSentinel', 'AnnSentinel', "Dave's Tool Shed", 'Drills, ladders', 'Pick up from', "Ann's Garden"];
    const leaks = (text: string) => sentinels.filter(s => text.includes(s));
    const localStranger = await call('GET', null, shopPath(daveShop));
    const localNonMember = await call('GET', outsider, shopPath(daveShop));
    const localNear = await call('GET', null, nearPath(MULLUM.lat, MULLUM.lng, 50));
    assert([localStranger, localNonMember, localNear].every(r => (r.status === 401 || r.status === 403) && leaks(r.text).length === 0),
        `without the visitors' view, a shop is its community's members' (${[localStranger, localNonMember, localNear].map(r => r.status).join(', ')})`);
    attempt(() => setSwitchOverride('guestListingsOnly', true));
    try {
        for (const [who, id] of [['unsigned', null], ['a non-member signer', outsider]] as Array<[string, Id | null]>) {
            const one = await call('GET', id, shopPath(daveShop));
            assert(one.status === 200 && same(Object.keys(one.body ?? {}).sort(), ['counts', 'id', 'kind']) && one.body.kind === 'tools'
                && one.body.counts?.things === 5 && leaks(one.text).length === 0,
                `${who}: one shop is its id, kind and counts, and nobody (${show(one)})`);
            const near = await call('GET', id, nearPath(MULLUM.lat, MULLUM.lng, 50));
            const shops: any[] = near.body?.shops ?? [];
            assert(near.status === 200 && shops.length === 2 && shops.every(s => same(Object.keys(s).sort(), ['counts', 'distanceKm', 'id', 'kind']) && Number.isInteger(s.distanceKm))
                && leaks(near.text).length === 0,
                `${who}: the shops near a place are each id, kind, counts and a whole-km distance, and nobody (${show(near)})`);
            const posts = await listShop(id, daveShop);
            assert(posts.status === 200 && (posts.body as any[]).length === 5 && (posts.body as any[]).every(p => p.shopId === daveShop && p.authorPublicKey === 'hidden')
                && leaks(posts.text).length === 0,
                `${who}: the listings keep their shop and lose their author (${posts.status}, ${(posts.body as any[])?.length})`);
            const mine = await call('GET', id, MINE);
            assert(mine.status === 401 || mine.status === 403, `${who}: no shop of their own to read (${show(mine)})`);
        }
        const memberRead = await call('GET', cy, shopPath(daveShop));
        assert(memberRead.status === 200 && memberRead.body?.name === "Dave's Tool Shed" && memberRead.body?.ownerPublicKey === dave.pk,
            'a member reads the whole shop there too');
    } finally {
        attempt(() => setSwitchOverride('guestListingsOnly', false));
    }

    // ── 6. near a place ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. shops near a place ──');
    await offerId(ann, 'Ann seedlings', { shopId: annShop, lat: NEAR_MULLUM.lat, lng: NEAR_MULLUM.lng });
    const eveShop: string = (await call('PUT', eve, MINE, { kind: 'baking' })).body?.shop?.id;
    await offerId(eve, 'Eve bread', { shopId: eveShop, lat: CASTLEMAINE.lat, lng: CASTLEMAINE.lng });
    const fromAnn = await call('GET', cy, nearPath(NEAR_MULLUM.lat, NEAR_MULLUM.lng, 50));
    const order = (fromAnn.body?.shops ?? []).map((s: any) => s.id);
    // Ann's seedlings are at the point; Dave's things and the enterprise's tune-up about 15 km off, at one place.
    assert(fromAnn.status === 200 && order[0] === annShop && same(order.slice(1).sort(), [daveShop, bikesShop].sort()),
        `nearest first, each once, none beyond the radius, and none with nothing live in it (${JSON.stringify(order)})`);
    assert((fromAnn.body?.shops ?? []).every((s: any) => typeof s.name !== 'undefined' && typeof s.distanceKm === 'number')
        && (fromAnn.body?.shops ?? [])[0]?.distanceKm < 1,
        'a member gets each shop whole, with its distance');
    const fromCastlemaine = await call('GET', cy, nearPath(CASTLEMAINE.lat, CASTLEMAINE.lng, 50));
    assert(same((fromCastlemaine.body?.shops ?? []).map((s: any) => s.id), [eveShop]), `elsewhere, the shops there (${show(fromCastlemaine)})`);
    const noPoint = await call('GET', cy, '/api/shops');
    const badPoint = await call('GET', cy, '/api/shops?lat=nope&lng=1');
    assert(noPoint.status === 400 && badPoint.status === 400, `near a place needs a place (${show(noPoint)}; ${show(badPoint)})`);
    // A shop with more Offers than a page of listings holds doesn't hide the shops past it (the review of b4f941f6): far from
    // the rest, Ivy's shop holds 210 Offers at the point, and 30 more shops one Offer each, each farther south than the last,
    // every one in an area of its own. A member (by exact places, and by neighbourhood where anyone can join) and a visitor
    // alike get the most shops one read answers, Ivy's first, then the others nearest first, and the farthest one left out.
    const ivy = member('Ivy');
    const ivyShop: string = shopsModule.openShop(ivy.pk).id;
    for (let i = 0; i < 210; i++) {
        createPost('offer', 'tools', `Ivy thing ${i}`, '', 0, 'fixed', ivy.pk, HOBART.lat, HOBART.lng, undefined, false, undefined, false, { shopId: ivyShop });
    }
    const southShops: string[] = [];
    for (let i = 0; i < 30; i++) {
        const keeper = member(`Keeper${i}`);
        const shop: string = shopsModule.openShop(keeper.pk).id;
        createPost('offer', 'tools', `Keeper ${i} thing`, '', 0, 'fixed', keeper.pk, HOBART.lat - 0.12 * (i + 1), HOBART.lng, undefined, false, undefined, false, { shopId: shop });
        southShops.push(shop);
    }
    const wanted = [ivyShop, ...southShops.slice(0, SHOPS_NEAR_MAX - 1)];
    const memberPast = await call('GET', cy, nearPath(HOBART.lat, HOBART.lng, 1000));
    attempt(() => setSwitchOverride('openMembership', true));
    let neighbourhoodPast: Res;
    try {
        neighbourhoodPast = await call('GET', cy, nearPath(HOBART.lat, HOBART.lng, 1000));
    } finally {
        attempt(() => setSwitchOverride('openMembership', false));
    }
    attempt(() => setSwitchOverride('guestListingsOnly', true));
    let visitorPast: Res;
    try {
        visitorPast = await call('GET', null, nearPath(HOBART.lat, HOBART.lng, 1000));
    } finally {
        attempt(() => setSwitchOverride('guestListingsOnly', false));
    }
    for (const [who, r] of [['a member', memberPast], ['a member where anyone can join (by neighbourhood)', neighbourhoodPast], ['a visitor', visitorPast]] as Array<[string, Res]>) {
        const got: string[] = (r.body?.shops ?? []).map((s: any) => s.id);
        assert(r.status === 200 && same(got, wanted),
            `${who}: a shop with 210 Offers hides none past it: the ${SHOPS_NEAR_MAX} nearest shops, each once, nearest first (${r.status}: ${got.length} shops, `
            + `${got.filter(id => wanted.includes(id)).length} of the ${wanted.length} wanted)`);
    }

    // ── 7. pause and reopen ─────────────────────────────────────────────────────────────────────
    console.log('\n── 7. pause and reopen ──');
    // Fay and Gus each list an Offer first, as anyone who asks for one must where Beans are on.
    await offerId(fay, 'Fay odd jobs', { lat: CASTLEMAINE.lat, lng: CASTLEMAINE.lng });
    await offerId(gus, 'Gus odd jobs', { lat: CASTLEMAINE.lat, lng: CASTLEMAINE.lng });
    const asked = await call('POST', fay, '/api/marketplace/posts/request', { postId: drillId, buyerPublicKey: fay.pk });
    const dealId: string = asked.body?.transaction?.id;
    assert(asked.status === 200 && typeof dealId === 'string', `Fay asks for the drill (${show(asked)})`);
    const rowBeforePause = JSON.stringify(shopRowOf(dave.pk));
    const pauseRefused = await call('PUT', dave, MINE, { paused: true });
    assert(pauseRefused.status === 409 && pauseRefused.body?.code === 'shop_deals_open' && /1 open deal/.test(pauseRefused.body?.error ?? '')
        && JSON.stringify(shopRowOf(dave.pk)) === rowBeforePause && postRow(drillId)?.status === 'active',
        `refused while a deal on one of its things is open, saying how many, writing nothing (${show(pauseRefused)})`);
    await call('POST', fay, '/api/marketplace/transactions/cancel-request', { transactionId: dealId, buyerPublicKey: fay.pk });
    await call('POST', dave, '/api/marketplace/posts/pause', { postId: tentId, authorPublicKey: dave.pk }); // his own pause
    const backOn = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const paused = await call('PUT', dave, MINE, { paused: true, backOn });
    assert(paused.status === 200 && paused.body?.shop?.paused === true && paused.body.shop.backOn === backOn,
        `paused, back on a date (${show(paused)})`);
    assert([drillId, ladderId, oldOfferId, hoseId].every(id => postRow(id)?.status === 'paused') && postRow(tentId)?.status === 'paused',
        'its live Offers leave the board');
    const whilePaused = await listShop(cy, daveShop);
    const shopWhilePaused = await call('GET', cy, shopPath(daveShop));
    assert(ids(whilePaused).length === 0 && shopWhilePaused.body?.paused === true && shopWhilePaused.body?.counts?.things === 0,
        `the shop says closed and lists nothing (${show(shopWhilePaused)})`);
    const addWhilePaused = await offer(dave, 'Sander', { shopId: daveShop });
    const resumeOne = await call('POST', dave, '/api/marketplace/posts/resume', { postId: drillId, authorPublicKey: dave.pk });
    assert(addWhilePaused.status === 409 && addWhilePaused.body?.code === 'shop_paused' && resumeOne.status === 409 && resumeOne.body?.code === 'shop_paused'
        && postRow(drillId)?.status === 'paused',
        `nothing goes in while it is, and one of its Offers can't be put back up alone (${show(addWhilePaused)}; ${show(resumeOne)})`);
    const badBack = await call('PUT', dave, MINE, { backOn: '2001-01-01' });
    assert(badBack.status === 400, `a back-on date in the past is refused (${show(badBack)})`);
    // Today is the member's, on any clock: at 03:00 UTC it is still yesterday in Hawaii, at 20:00 UTC already tomorrow in Kiribati.
    const backOnAt = (day: string, at: string): string => {
        try { shopsModule.changeShop(dave.pk, { backOn: day }, { enterprise: false }, Date.parse(at)); return 'taken'; } catch (e: any) { return e?.code ?? String(e); }
    };
    const clocks = [backOnAt('2030-06-14', '2030-06-15T03:00:00.000Z'), backOnAt('2030-06-13', '2030-06-15T03:00:00.000Z'),
        backOnAt('2031-06-17', '2030-06-15T20:00:00.000Z'), backOnAt('2031-06-18', '2030-06-15T20:00:00.000Z')];
    assert(same(clocks, ['taken', 'shop_back_on_refused', 'taken', 'shop_back_on_refused']),
        `a back-on date runs from today to a year ahead on the member's clock, west or east of UTC (${clocks.join(', ')})`);
    const reopened = await call('PUT', dave, MINE, { paused: false });
    assert(reopened.status === 200 && reopened.body?.shop?.paused === false && reopened.body.shop.backOn === null
        && [drillId, ladderId, oldOfferId, hoseId].every(id => postRow(id)?.status === 'active') && postRow(tentId)?.status === 'paused'
        && shopRowOf(dave.pk)?.paused_posts === null,
        `reopened: what the pause took down is back, the tent its owner paused stays paused (${show(reopened)})`);
    await call('POST', dave, '/api/marketplace/posts/resume', { postId: tentId, authorPublicKey: dave.pk });

    // ── 8. close ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. close ──');
    const annThing = await offerId(ann, 'Ann hoe', { shopId: annShop });
    const annDeal = await call('POST', gus, '/api/marketplace/posts/request', { postId: annThing, buyerPublicKey: gus.pk });
    const closeRefused = await call('POST', ann, `${MINE}/close`, {});
    assert(closeRefused.status === 409 && closeRefused.body?.code === 'shop_deals_open' && !!shopRowOf(ann.pk),
        `refused while a deal is open (${show(closeRefused)})`);
    await call('POST', gus, '/api/marketplace/transactions/cancel-request', { transactionId: annDeal.body?.transaction?.id, buyerPublicKey: gus.pk });
    const annThings = (db.prepare('SELECT id FROM posts WHERE shop_id = ?').all(annShop) as { id: string }[]).map(r => r.id);
    const closed = await call('POST', ann, `${MINE}/close`, {});
    assert(closed.status === 200 && closed.body?.cleared === annThings.length && closed.body?.ended === 0 && shopRowOf(ann.pk) === undefined
        && typeof shopTomb(annShop) === 'string',
        `closed: the row goes with a tombstone (${show(closed)})`);
    assert(annThings.length >= 2 && annThings.every(id => shopIdOf(id) === null && postRow(id)?.status === 'active'),
        'and its Offers stay as ordinary Offers');
    const goneRead = await call('GET', cy, shopPath(annShop));
    assert(goneRead.status === 404, `a closed shop reads as none (${show(goneRead)})`);
    const reopenedAnn: string = (await call('PUT', ann, MINE, {})).body?.shop?.id;
    assert(typeof reopenedAnn === 'string' && reopenedAnn !== annShop, 'a shop opened after is a new one');
    const gusThing = await offerId(gus, 'Gus mower', { shopId: (await call('PUT', gus, MINE, {})).body?.shop?.id });
    const gusShop = shopRowOf(gus.pk)?.id ?? '';
    const endIt = await call('POST', gus, `${MINE}/close`, { endOffers: true });
    assert(endIt.status === 200 && endIt.body?.ended === 1 && postRow(gusThing)?.status === 'cancelled' && postRow(gusThing)?.active === 0
        && shopIdOf(gusThing) === null && shopRowById(gusShop) === undefined,
        `closed with its Offers ended, when asked (${show(endIt)})`);
    // Muted (G3), a close that would put a pause's Offers back up is a reopen, refused writing nothing; one that ends them is not.
    const hal = member('HalSentinel');
    const halShop: string = (await call('PUT', hal, MINE, {})).body?.shop?.id;
    const halThing = await offerId(hal, 'Hal wheelbarrow', { shopId: halShop });
    await call('PUT', hal, MINE, { paused: true });
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + 86_400_000).toISOString(), hal.pk);
    const halRowMuted = JSON.stringify(shopRowOf(hal.pk));
    const mutedClose = await call('POST', hal, `${MINE}/close`, {});
    assert(mutedClose.status === 403 && mutedClose.body?.code === 'moderation_muted' && postRow(halThing)?.status === 'paused'
        && shopIdOf(halThing) === halShop && JSON.stringify(shopRowOf(hal.pk)) === halRowMuted,
        `muted, a close that would put the pause's Offers back up is refused, writing nothing (${show(mutedClose)})`);
    const mutedEnd = await call('POST', hal, `${MINE}/close`, { endOffers: true });
    assert(mutedEnd.status === 200 && mutedEnd.body?.ended === 1 && postRow(halThing)?.status === 'cancelled' && shopRowById(halShop) === undefined,
        `muted, a close that ends them is not (${show(mutedEnd)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(hal.pk);

    // ── 9. an enterprise's shop ─────────────────────────────────────────────────────────────────
    console.log('\n── 9. an enterprise\'s shop ──');
    const asKeeper = await call('GET', cy, entShop(bikes));
    assert(asKeeper.status === 200 && asKeeper.body?.shop?.id === bikesShop && asKeeper.body.shop.name === 'Bo Bikes Sentinel'
        && asKeeper.body.shop.blurb === 'Bikes fixed and lent around town.' && asKeeper.body.shop.enterprise === true,
        `its name is the enterprise's, its blurb the purpose (${show(asKeeper)})`);
    const notKeeper = await call('PUT', dave, entShop(bikes), { kind: 'repairs' });
    const notKeeperRead = await call('GET', dave, entShop(bikes));
    assert(notKeeper.status === 403 && notKeeperRead.status === 403, `only a keeper reads it as its keeper or changes it (${show(notKeeper)}; ${show(notKeeperRead)})`);
    const keeperPut = await call('PUT', cy, entShop(bikes), { kind: 'repairs', blurb: 'Tune-ups on Saturdays.' });
    const nameRefused = await call('PUT', cy, entShop(bikes), { name: 'Another name' });
    assert(keeperPut.status === 200 && keeperPut.body?.shop?.kind === 'repairs' && keeperPut.body.shop.blurb === 'Tune-ups on Saturdays.'
        && nameRefused.status === 400 && nameRefused.body?.code === 'shop_name_is_enterprise',
        `a keeper dresses it; its name can't be set apart from the enterprise's (${show(keeperPut)}; ${show(nameRefused)})`);
    const entRead = await call('GET', dave, shopPath(bikesShop));
    assert(entRead.status === 200 && entRead.body?.name === 'Bo Bikes Sentinel' && entRead.body.ownerName === 'Bo Bikes Sentinel' && entRead.body.counts?.things === 1,
        `a member reads it like any shop (${show(entRead)})`);
    // A Commons project is an enterprise too; its proposer opens its shop, and a rename carries over.
    const project = attempt(() => createProject(fay.pk, 'Fay Seed Library', 'A library of seeds to borrow.', 50));
    const projectKey = project?.id ?? '';
    const projectShop = await call('PUT', fay, entShop(projectKey), {});
    assert(projectShop.status === 200 && projectShop.body?.shop?.name === 'Fay Seed Library', `its keeper opens one (${show(projectShop)})`);
    attempt(() => updateProject(fay.pk, projectKey, 'Fay Seed Commons', 'Seeds to borrow and return.', 50));
    const renamed = await call('GET', cy, shopPath(projectShop.body?.shop?.id ?? 'none'));
    assert(renamed.status === 200 && renamed.body?.name === 'Fay Seed Commons' && renamed.body?.blurb === 'Seeds to borrow and return.',
        `an enterprise's shop follows its rename (${show(renamed)})`);

    // ── 10. accounts ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 10. accounts: a re-key, a deletion, a removal ──');
    const eveNew = newId('EveSentinel');
    const moved = attempt(() => { const code = issueRekeyCode(eve.pk, owner.pk).code; return completeRekey(eve.pk, eveNew.pk, code, owner.pk); });
    assert(!!moved && shopRowOf(eveNew.pk)?.id === eveShop && shopRowOf(eve.pk) === undefined, 'a re-key moves the shop to the new key');
    const daveThings = (db.prepare('SELECT id FROM posts WHERE shop_id = ?').all(daveShop) as { id: string }[]).map(r => r.id);
    attempt(() => purgeMemberSelf(dave.pk));
    assert(shopRowOf(dave.pk) === undefined && typeof shopTomb(daveShop) === 'string' && daveThings.length > 0 && daveThings.every(id => shopIdOf(id) === null),
        'a member\'s deletion takes their shop with a tombstone, and their listings name it no more');
    const boShopId = shopRowOf(bo.pk)?.id ?? '';
    attempt(() => adminPruneUser(bo.pk, 'owner:password'));
    assert(boShopId !== '' && shopRowOf(bo.pk) === undefined && typeof shopTomb(boShopId) === 'string' && !!shopRowOf(bikes),
        'an admin\'s removal takes theirs too, and the enterprise they led keeps its own');

    // ── 11. a standby ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 11. a standby ──');
    const snapshot = JSON.stringify(everyShop());
    setNodeRole('backup');
    const sChanges = [await call('PUT', cy, MINE, {}), await call('PUT', cy, entShop(bikes), { kind: 'tools' }),
        await call('POST', ann, `${MINE}/close`, {}), await call('POST', cy, `${entShop(bikes)}/close`, {}), await call('POST', ann, `${MINE}/offers`, { postIds: [] })];
    const sRead = await call('GET', cy, shopPath(bikesShop));
    setNodeRole('primary');
    assert(sChanges.every(r => r.status === 409) && JSON.stringify(everyShop()) === snapshot && sRead.status === 200,
        `a standby refuses every change, 409, and answers the read (${sChanges.map(r => r.status).join(', ')}; ${sRead.status})`);

    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4291/p2p/${nodeId}`);
    const mainShops = everyShop();
    const shopPosts = () => (db.prepare('SELECT id, shop_id FROM posts WHERE shop_id IS NOT NULL ORDER BY id').all() as { id: string; shop_id: string }[]);
    const mainShopPosts = shopPosts();
    const reads = async () => JSON.stringify(await Promise.all([bikesShop, reopenedAnn, eveShop].map(async id => (await call('GET', cy, shopPath(id))).body)));
    const mainReads = await reads();
    const whole: any = await exportSyncState(nodeId);
    const exported: any[] = whole.plainTables?.shops ?? [];
    assert(mainShops.length >= 4 && same(byId(exported), mainShops),
        `a whole copy carries every shop verbatim (${exported.length} of ${mainShops.length})`);
    const exportedPosts = byId((whole.posts ?? []).filter((p: any) => p.shopId).map((p: any) => ({ id: p.id as string, shop_id: p.shopId as string })));
    assert(mainShopPosts.length >= 2 && same(exportedPosts, mainShopPosts), `and each listing's shop (${exportedPosts.length} of ${mainShopPosts.length})`);
    const wholeCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(whole));
    attempt(() => emptyCopiedTables(db));
    db.prepare('UPDATE posts SET shop_id = NULL').run();
    assert(everyShop().length === 0, 'a new standby holds none');
    setNodeRole('backup');
    let importError = '';
    try { await importRemoteState(wholeCopy, { full: true }); } catch (e: any) { importError = e?.message || String(e); }
    const standbyReads = await reads();
    setNodeRole('primary');
    reconcileLedgerFromDb();
    assert(importError === '' && same(everyShop(), mainShops) && same(shopPosts(), mainShopPosts),
        `the standby holds them exactly, row for row and stamp for stamp (${importError || `${everyShop().length} shops, ${shopPosts().length} listings`})`);
    assert(standbyReads === mainReads, 'and answers each shop read as the main server does');

    // A delta: a dressing, a new shop with a listing in it, and a close that clears its listings.
    const since = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    const keptShops = everyShop();
    const keptPosts = shopPosts();
    await call('PUT', cy, entShop(bikes), { howToDeal: 'Ring the bell.' });
    const cyShop: string = (await call('PUT', cy, MINE, { kind: 'rides' })).body?.shop?.id;
    const cyThing = await offerId(cy, 'Cy rides', { shopId: cyShop });
    const eveThings = (db.prepare('SELECT id FROM posts WHERE shop_id = ?').all(eveShop) as { id: string }[]).map(r => r.id);
    await call('POST', eveNew, `${MINE}/close`, {});
    const afterShops = everyShop();
    const afterPosts = shopPosts();
    const delta: any = await exportSyncState(nodeId, since);
    const dShops: any[] = delta.plainTables?.shops ?? [];
    const dTomb = (delta.tombstones ?? []).find((t: any) => t.tableName === 'shops' && t.rowKey === eveShop);
    const dCleared = (delta.posts ?? []).filter((p: any) => eveThings.includes(p.id));
    assert(same(dShops.map((s: any) => s.id).sort(), [bikesShop, cyShop].sort()) && !!dTomb && dCleared.length === eveThings.length && dCleared.every((p: any) => !p.shopId),
        `a delta carries the dressing, the new shop, the close's tombstone and the listings it cleared (${dShops.length}, ${!!dTomb}, ${dCleared.length})`);
    // The standby as it was before the delta: its shops, and each listing the delta carries as it was, at an old stamp, so
    // the copy's row is the newer one.
    db.transaction(() => {
        db.prepare('DELETE FROM shops').run();
        const cols = Object.keys(keptShops[0] ?? {});
        const ins = db.prepare(`INSERT INTO shops (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        for (const s of keptShops) ins.run(...cols.map(k => (s as any)[k]));
        const was = new Map(keptPosts.map(p => [p.id, p.shop_id]));
        const put = db.prepare("UPDATE posts SET shop_id = ?, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?");
        for (const p of (delta.posts ?? []) as any[]) put.run(was.get(p.id) ?? null, p.id);
        db.prepare("DELETE FROM tombstones WHERE table_name = 'shops' AND row_key = ?").run(eveShop);
    })();
    const deltaCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(delta));
    setNodeRole('backup');
    importError = '';
    try { await importRemoteState(deltaCopy); } catch (e: any) { importError = e?.message || String(e); }
    const sGone = await call('GET', cy, shopPath(eveShop));
    const sCy = await call('GET', ann, shopPath(cyShop));
    setNodeRole('primary');
    assert(importError === '' && same(everyShop(), afterShops) && same(shopPosts(), afterPosts),
        `the standby follows: the dressing and the new shop in, the closed one gone, its listings cleared (${importError || `${everyShop().length} shops`})`);
    assert(sGone.status === 404 && sCy.status === 200 && sCy.body?.counts?.things === 1 && shopIdOf(cyThing) === cyShop,
        `and answers as the main server does (${show(sGone)}; ${show(sCy)})`);
    // A close and a new shop for the same member in one delta: the copy's rows go in before its tombstones, so the new shop
    // is written while the old one is still on the standby, and the tombstone then takes the old one only.
    const sinceReopen = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    const keptShops2 = everyShop();
    const keptPosts2 = shopPosts();
    await call('POST', cy, `${MINE}/close`, {});
    const cyShop2: string = (await call('PUT', cy, MINE, { kind: 'tools' })).body?.shop?.id;
    const afterShops2 = everyShop();
    const afterPosts2 = shopPosts();
    const reopenDelta: any = await exportSyncState(nodeId, sinceReopen);
    const rShops: any[] = reopenDelta.plainTables?.shops ?? [];
    const rTomb = (reopenDelta.tombstones ?? []).find((t: any) => t.tableName === 'shops' && t.rowKey === cyShop);
    assert(!!cyShop2 && cyShop2 !== cyShop && same(rShops.map((s: any) => s.id), [cyShop2]) && !!rTomb,
        `a delta carries the closed shop's tombstone and the same member's new shop (${rShops.length}, ${!!rTomb})`);
    db.transaction(() => {
        db.prepare('DELETE FROM shops').run();
        const cols = Object.keys(keptShops2[0] ?? {});
        const ins = db.prepare(`INSERT INTO shops (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        for (const s of keptShops2) ins.run(...cols.map(k => (s as any)[k]));
        const was = new Map(keptPosts2.map(p => [p.id, p.shop_id]));
        const put = db.prepare("UPDATE posts SET shop_id = ?, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?");
        for (const p of (reopenDelta.posts ?? []) as any[]) put.run(was.get(p.id) ?? null, p.id);
        db.prepare("DELETE FROM tombstones WHERE table_name = 'shops' AND row_key = ?").run(cyShop);
    })();
    assert(shopRowOf(cy.pk)?.id === cyShop && shopIdOf(cyThing) === cyShop, 'the standby before it holds the old shop, its listing in it');
    const reopenCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(reopenDelta));
    setNodeRole('backup');
    importError = '';
    try { await importRemoteState(reopenCopy); } catch (e: any) { importError = e?.message || String(e); }
    const sOld = await call('GET', ann, shopPath(cyShop));
    const sNew = await call('GET', ann, shopPath(cyShop2));
    setNodeRole('primary');
    assert(importError === '' && same(everyShop(), afterShops2) && same(shopPosts(), afterPosts2)
        && shopRowOf(cy.pk)?.id === cyShop2 && shopRowById(cyShop) === undefined && shopIdOf(cyThing) === null,
        `the standby follows: the new shop in, the old one gone (${importError || `${everyShop().filter(s => s.owner_pubkey === cy.pk).map(s => s.id === cyShop2 ? 'new' : 'old').join(', ') || 'none'}`})`);
    assert(sOld.status === 404 && sNew.status === 200 && sNew.body?.kind === 'tools',
        `and answers as the main server does (${show(sOld)}; ${show(sNew)})`);
    // An enterprise's name travels in its members row: the shop's follows it on the standby too.
    const projectShopId: string = projectShop.body?.shop?.id ?? '';
    const sinceRename = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    attempt(() => updateProject(fay.pk, projectKey, 'Fay Seed Circle', 'Seeds to borrow and return.', 50));
    const renameDelta: any = await exportSyncState(nodeId, sinceRename);
    // The standby as it was: the old name, at an old stamp, so the copy's row is the newer one.
    db.prepare("UPDATE members SET callsign = 'Fay Seed Commons', updated_at = '2000-01-01T00:00:00.000Z' WHERE public_key = ?").run(projectKey);
    const renameCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(renameDelta));
    setNodeRole('backup');
    importError = '';
    try { await importRemoteState(renameCopy); } catch (e: any) { importError = e?.message || String(e); }
    const sRenamed = await call('GET', cy, shopPath(projectShopId));
    setNodeRole('primary');
    assert(importError === '' && sRenamed.status === 200 && sRenamed.body?.name === 'Fay Seed Circle',
        `an enterprise's shop's name follows the enterprise's row on the standby (${importError || show(sRenamed)})`);

    // ── 12. Home's "Your shop and tools" ────────────────────────────────────────────────────────
    console.log('\n── 12. Home\'s "Your shop and tools": the reader\'s own shop, built by the node ──');
    const homeModule: any = await import('./routes/home-answer.js');
    const builds = () => homeModule.homeCardBuilds?.shop ?? 0;
    const ida = member('IdaSentinel');
    const jo = member('JoSentinel');
    const home = (who: Id, cards: string | null) => call('GET', who, `/api/home${cards === null ? '' : `?cards=${cards}`}`);
    const idaHome = await home(ida, 'needs,shop,community');
    assert(idaHome.status === 200 && same(idaHome.body?.cards?.shop, { shop: null }),
        `asked by its id, a member with no shop gets the card with none in it, never left out (${show(idaHome)})`);
    const joShop: string = (await call('PUT', jo, MINE, { name: "Jo's Bike Fixes", kind: 'repairs' })).body?.shop?.id;
    await offerId(jo, 'Puncture fix', { shopId: joShop });
    await offerId(jo, 'Pump to borrow', { shopId: joShop, lendable: true, lendMaxDays: 7 });
    await offerId(jo, 'Old saddle'); // not in the shop
    const joRead = await call('GET', jo, MINE);
    const joHome = await home(jo, 'shop');
    const card = joHome.body?.cards?.shop?.shop;
    assert(joHome.status === 200 && card?.id === joShop && card.name === "Jo's Bike Fixes" && card.ownerName === 'JoSentinel' && card.kind === 'repairs'
        && card.paused === false && card.backOn === null && same(card.counts, joRead.body?.shop?.counts) && card.counts?.things === 2 && card.counts?.toBorrow === 1,
        `a member's own shop: its name, kind and counts as their own read of it says (${show(joHome)})`);
    const unnamed: string = (await call('PUT', ida, MINE, {})).body?.shop?.id;
    const idaOpened = (await home(ida, 'shop')).body?.cards?.shop?.shop;
    assert(idaOpened?.id === unnamed && idaOpened.name === null && idaOpened.ownerName === 'IdaSentinel',
        'a shop with no name of its own: none, and its owner\'s name for the apps to say "<name>\'s shop"');
    const joBack = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await call('PUT', jo, MINE, { paused: true, backOn: joBack });
    const joPaused = (await home(jo, 'shop')).body?.cards?.shop?.shop;
    assert(joPaused?.paused === true && joPaused.backOn === joBack && joPaused.counts?.things === 0,
        `closed for now: said, with its back-on day, and nothing on the board (${JSON.stringify(joPaused)})`);
    await call('PUT', jo, MINE, { paused: false });
    const idaSeesOwn = (await home(ida, 'shop')).body?.cards?.shop?.shop;
    assert(idaSeesOwn?.id === unnamed && !JSON.stringify((await home(ida, 'shop')).body).includes(jo.pk) && !JSON.stringify((await home(ida, 'shop')).body).includes("Jo's Bike"),
        "each member's card is their own shop: nothing of another member's is in it");
    const longName = await call('PUT', jo, MINE, { name: 'W'.repeat(60) });
    const clipped = (await home(jo, 'shop')).body?.cards?.shop?.shop;
    assert(longName.status === 200 && clipped?.name === 'W'.repeat(60), 'a name of the longest a shop keeps (60) comes through whole, never cut');
    const beforeSkip = builds();
    await home(jo, 'needs,community');
    assert(builds() === beforeSkip, `not asked, not built (${beforeSkip} → ${builds()})`);
    db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'home.layout', ?)`)
        .run(jo.pk, JSON.stringify({ v: 2, cards: [{ id: 'shop', type: 'shop' }], dismissed: {}, updatedAt: new Date().toISOString() }));
    const fromLayout = await home(jo, null);
    assert(fromLayout.status === 200 && fromLayout.body?.cards?.shop?.shop?.id === joShop && builds() === beforeSkip + 1,
        `with no cards=, built when the member's own layout holds it (${show(fromLayout)})`);
    const joNoCard = await home(ida, null);
    assert(joNoCard.status === 200 && joNoCard.body?.cards?.shop === undefined, 'and not when it doesn\'t');

    // ── 13. the owner's word over a closed shop's ───────────────────────────────────────────────
    console.log('\n── 13. the owner\'s own pause, end or edit wins over a shop closed for now ──');
    // The Tool shed pauses a thing's Offer when it is lent, taken out or deleted (#2373). With the shop closed for now, that
    // Offer is already paused, by the shop: the owner's pause makes it theirs, so the reopen leaves it down.
    const kit = member('KitSentinel');
    const kitShop: string = (await call('PUT', kit, MINE, {})).body?.shop?.id;
    const hammerId = await offerId(kit, 'Kit hammer', { shopId: kitShop });
    const kitDrillId = await offerId(kit, 'Kit drill', { shopId: kitShop });
    const kitTentId = await offerId(kit, 'Kit tent', { shopId: kitShop });
    const rakeId = await offerId(kit, 'Kit rake', { shopId: kitShop });
    const held = () => { try { return JSON.parse(shopRowOf(kit.pk)?.paused_posts ?? 'null'); } catch { return 'unreadable'; } };
    const kitPause = (postId: string, who: Id = kit) => call('POST', who, '/api/marketplace/posts/pause', { postId, authorPublicKey: who.pk });
    await call('PUT', kit, MINE, { paused: true });
    assert(same([...(held() ?? [])].sort(), [hammerId, kitDrillId, kitTentId, rakeId].sort()), `closed for now, the shop holds its four Offers (${JSON.stringify(held())})`);
    const strangerPause = await kitPause(hammerId, cy);
    assert(strangerPause.status === 400 && (held() ?? []).includes(hammerId) && postRow(hammerId)?.status === 'paused',
        `someone else's pause of one is refused, and the shop still holds it (${show(strangerPause)})`);
    const ownPause = await kitPause(kitDrillId);
    assert(ownPause.status === 200 && ownPause.body?.success === true && postRow(kitDrillId)?.status === 'paused' && !(held() ?? []).includes(kitDrillId),
        `its owner's pause of one the shop paused is taken, and the pause is theirs now: the shop holds it no more (${show(ownPause)})`);
    const pauseAgain = await kitPause(kitDrillId);
    assert(pauseAgain.status === 200 && postRow(kitDrillId)?.status === 'paused', `paused by its owner already, a pause is still taken, changing nothing (${show(pauseAgain)})`);
    const resumeWhileClosed = await call('POST', kit, '/api/marketplace/posts/resume', { postId: kitDrillId, authorPublicKey: kit.pk });
    assert(resumeWhileClosed.status === 409 && resumeWhileClosed.body?.code === 'shop_paused' && postRow(kitDrillId)?.status === 'paused',
        `still in the shop, it can't be put back up alone while the shop is closed (${show(resumeWhileClosed)})`);
    const ended = await call('POST', kit, '/api/marketplace/posts/remove', { id: kitTentId, authorPublicKey: kit.pk });
    assert(ended.status === 200 && postRow(kitTentId)?.status === 'cancelled' && !(held() ?? []).includes(kitTentId),
        `its owner ends one: the shop holds it no more (${show(ended)})`);
    const editedOut = await edit(kit, rakeId, { shopId: null });
    assert(editedOut.status === 200 && shopIdOf(rakeId) === null && postRow(rakeId)?.status === 'paused' && !(held() ?? []).includes(rakeId),
        `an edit takes one out of the shop: the shop holds it no more (${show(editedOut)})`);
    assert(same(held(), [hammerId]), `what the shop still holds is only what it paused and nobody has since (${JSON.stringify(held())})`);
    const kitReopened = await call('PUT', kit, MINE, { paused: false });
    assert(kitReopened.status === 200 && same(kitReopened.body?.resumed, [hammerId]) && postRow(hammerId)?.status === 'active',
        `reopened, the shop puts back up only what it paused and still holds (${show(kitReopened)})`);
    assert(postRow(kitDrillId)?.status === 'paused' && postRow(kitTentId)?.status === 'cancelled' && postRow(kitTentId)?.active === 0 && postRow(rakeId)?.status === 'paused',
        `the one its owner paused stays paused, the ended one stays ended, the one edited out stays paused (${[kitDrillId, kitTentId, rakeId].map(id => postRow(id)?.status).join(', ')})`);
    const ownResume = await call('POST', kit, '/api/marketplace/posts/resume', { postId: kitDrillId, authorPublicKey: kit.pk });
    assert(ownResume.status === 200 && postRow(kitDrillId)?.status === 'active', `its owner puts theirs back up once the shop is open (${show(ownResume)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ A shop is a front window on an account: the owner\'s alone to dress, a visitor\'s kind and counts, on every standby.');
    process.exit(0);
}

main().catch((e) => {
    console.error('✗ the suite stopped:', e);
    process.exit(1);
});
