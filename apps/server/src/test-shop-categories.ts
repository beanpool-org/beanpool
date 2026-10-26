/**
 * A shop picks one of the Market's categories (Marty, 25 Oct 2026: "Seems like it should have used the categories already
 * present?"): one list for shops and listings (@beanpool/core SHOP_CATEGORIES), kept by the node (engine/shops.ts).
 *
 * Over REAL HTTPS through the real signature middleware:
 *
 *   1. a member's shop: its category saved and answered as `category` (Tech among them), cleared by null; refused in a
 *      sentence, writing nothing: a value that is none of the Market's ids (a made-up one, a capital, an old kind that is
 *      no category, a number)
 *   2. an app from before categories, which sends a kind: each kind saved as its category (core's one table), null
 *      clears, a kind that is none of the fourteen refused; a category sent beside a kind wins; an enterprise's shop the same
 *   3. its read: a member's whole shop and a visitor's view name the category, and neither names a kind
 *   4. new listings: an Offer put in a shop with no category of its own starts in the shop's; one with its own keeps it; one
 *      outside a shop is as before; an enterprise's Offer through its own route the same, and one with neither a category
 *      nor a shop is still refused
 *
 * Local only: it talks to the server it starts on localhost, and to nothing else.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-shop-categories.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
process.env.ADMIN_PASSWORD = 'ShopCategoriesPass123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { TEST_PHOTOS } from './post-test-helper.js';
import { initStateEngine, seedGenesisMember, reconcileLedgerFromDb } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { setSwitchOverride } from './config/node-profile.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { ledger } from './engine/ledger.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A read that throws on a tree without the column fails its assertion, not the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}

let BASE = '';

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

type Method = 'GET' | 'PUT' | 'POST';
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

const MINE = '/api/shops/mine';
const shopPath = (id: string) => `/api/shops/${id}`;
const entShop = (t: string) => `/api/treasury/${t}/shop`;
const categoryOfRow = (pk: string) => attempt(() => (db.prepare('SELECT category FROM shops WHERE owner_pubkey = ?').get(pk) as { category: string | null } | undefined)?.category);
const MULLUM = { lat: -28.55, lng: 153.50 };

async function main(): Promise<void> {
    console.log('\n=== Shops pick a Market category ===\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const damo = member('DamoSentinel');
    const ann = member('AnnSentinel');
    const bo = member('BoSentinel');
    reconcileLedgerFromDb();

    // ── 1. a member's shop ──────────────────────────────────────────────────────────────────────
    console.log('── 1. a member\'s shop: one of the Market\'s categories ──');
    const tech = await call('PUT', damo, MINE, { name: 'Damo Tech and Security', category: 'tech' });
    assert(tech.status === 200 && tech.body?.shop?.category === 'tech' && !('kind' in (tech.body?.shop ?? {})) && categoryOfRow(damo.pk) === 'tech',
        `a shop in Tech: saved and answered as its category, never a kind (${show(tech)})`);
    const before = categoryOfRow(damo.pk);
    const refusals = [
        await call('PUT', damo, MINE, { category: 'weapons' }),
        await call('PUT', damo, MINE, { category: 'Tech' }),
        await call('PUT', damo, MINE, { category: 'baking' }),
        await call('PUT', damo, MINE, { category: 42 }),
    ];
    assert(refusals.every((r) => r.status === 400 && r.body?.code === 'shop_category_refused' && typeof r.body?.error === 'string' && r.body.error.length > 10)
        && categoryOfRow(damo.pk) === before,
        `refused in a sentence, writing nothing: a made-up one, a capital, an old kind that is no category, a number (${refusals.map(show).join(' | ')})`);
    const cleared = await call('PUT', damo, MINE, { category: null });
    assert(cleared.status === 200 && cleared.body?.shop?.category === null && categoryOfRow(damo.pk) === null, `null clears it (${show(cleared)})`);
    await call('PUT', damo, MINE, { category: 'tech' });

    // ── 2. an app from before categories ────────────────────────────────────────────────────────
    console.log('\n── 2. an app from before categories sends a kind ──');
    const kinds: Array<[string, string]> = [['repairs', 'services'], ['baking', 'food'], ['crafts', 'arts'], ['seeds', 'garden'], ['tools', 'tools']];
    const saved: string[] = [];
    for (const [kind, category] of kinds) {
        const r = await call('PUT', ann, MINE, { kind });
        saved.push(`${kind}→${r.body?.shop?.category}`);
        assert(r.status === 200 && r.body?.shop?.category === category && categoryOfRow(ann.pk) === category, `the kind ${kind} is saved as ${category} (${show(r)})`);
    }
    const oldNull = await call('PUT', ann, MINE, { kind: null });
    assert(oldNull.status === 200 && oldNull.body?.shop?.category === null, `an old app's None clears it (${show(oldNull)})`);
    await call('PUT', ann, MINE, { kind: 'rooms' });
    const oldRefused = await call('PUT', ann, MINE, { kind: 'weapons' });
    assert(oldRefused.status === 400 && oldRefused.body?.code === 'shop_category_refused' && categoryOfRow(ann.pk) === 'housing',
        `a kind that is none of the fourteen is refused, writing nothing (${show(oldRefused)})`);
    const both = await call('PUT', ann, MINE, { category: 'garden', kind: 'baking' });
    assert(both.status === 200 && both.body?.shop?.category === 'garden', `a category sent beside a kind wins (${show(both)})`);

    const ent = await call('POST', bo, '/api/enterprise', { name: 'Bo Fix-it Sentinel', purpose: 'Phones and laptops fixed.' });
    const fixit: string = ent.body?.publicKey;
    if (!fixit) throw new Error(`setup: Bo could not start an enterprise: ${show(ent)}`);
    setMemberPhoto(db, fixit, 'https://example.com/e.jpg');
    const entOld = await call('PUT', bo, entShop(fixit), { kind: 'repairs' });
    assert(entOld.status === 200 && entOld.body?.shop?.category === 'services' && categoryOfRow(fixit) === 'services',
        `an enterprise's shop: an old app's kind is saved as its category too (${show(entOld)})`);

    // ── 3. its read ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. its read names the category ──');
    const damoShop: string = tech.body?.shop?.id ?? '';
    const read = await call('GET', ann, shopPath(damoShop));
    assert(read.status === 200 && read.body?.category === 'tech' && !('kind' in (read.body ?? {})), `a member's read: its category (${show(read)})`);
    setSwitchOverride('guestListingsOnly', true);
    const visitor = await call('GET', null, shopPath(damoShop));
    setSwitchOverride('guestListingsOnly', false);
    assert(visitor.status === 200 && JSON.stringify(Object.keys(visitor.body ?? {}).sort()) === JSON.stringify(['category', 'counts', 'id']) && visitor.body.category === 'tech',
        `a visitor's view: its id, category and counts, and nobody (${show(visitor)})`);

    // ── 4. new listings ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. a shop\'s new listings start in its category ──');
    const annShop: string = both.body?.shop?.id ?? '';
    const post = (who: Id, title: string, extra: Record<string, unknown>) => call('POST', who, '/api/marketplace/posts', {
        type: 'offer', title, description: `${title}, in good order`, credits: 0, authorPublicKey: who.pk, lat: MULLUM.lat, lng: MULLUM.lng, photos: TEST_PHOTOS, ...extra,
    });
    const inShop = await post(ann, 'Tomato seedlings', { shopId: annShop });
    assert(inShop.status === 200 && inShop.body?.post?.shopId === annShop && inShop.body.post.category === 'garden',
        `an Offer put in the shop with no category of its own starts in the shop's (${show(inShop)})`);
    const ownCategory = await post(ann, 'A spade', { shopId: annShop, category: 'tools' });
    assert(ownCategory.status === 200 && ownCategory.body?.post?.category === 'tools', `one with its own category keeps it (${show(ownCategory)})`);
    const outside = await post(ann, 'Jam', {});
    assert(outside.status === 200 && outside.body?.post?.category === 'other' && !outside.body.post.shopId, `one outside a shop is as before (${show(outside)})`);

    const fixitShop: string = entOld.body?.shop?.id ?? '';
    const entOffer = await call('POST', bo, `/api/treasury/${fixit}/offer`, { title: 'Phone screen swap', credits: 0, shopId: fixitShop, lat: MULLUM.lat, lng: MULLUM.lng, photos: TEST_PHOTOS });
    assert(entOffer.status === 200 && entOffer.body?.post?.shopId === fixitShop && entOffer.body.post.category === 'services',
        `an enterprise's Offer put in its shop with no category starts in the shop's (${show(entOffer)})`);
    const entNeither = await call('POST', bo, `/api/treasury/${fixit}/offer`, { title: 'No category, no shop', credits: 0, lat: MULLUM.lat, lng: MULLUM.lng, photos: TEST_PHOTOS });
    assert(entNeither.status === 400, `one with neither a category nor a shop is still refused (${show(entNeither)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ A shop is in one of the Market\'s categories, an old app\'s kind is read as its category, and its new listings start there.');
    process.exit(0);
}

main().catch((e) => {
    console.error('✗ the suite stopped:', e);
    process.exit(1);
});
