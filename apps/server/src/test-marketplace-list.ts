/**
 * Pictures S6: The enterprise's banner on its listings' cards
 *
 * Verifies that:
 * 1. An enterprise's photoless listing carries its shop's keyed photo URL (authorBannerUrl).
 * 2. A regular member's listing carries none (even if the member has a shop with a banner).
 * 3. A visitor (unsigned caller or non-member) gets none on any listing.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
process.env.ADMIN_PASSWORD = 'MarketplaceListPass123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, createTreasury, createPost,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { openShop, setShopPhoto } from './engine/shops.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setMemberPhoto } from '@beanpool/engine';
import { ledger } from './engine/ledger.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); throw new Error(`Assertion failed: ${msg}`); }
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
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, name, WEEK_AGO(), owner.pk);
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

function insertPhotolessPost(id: string, authorPubkey: string, title: string, category = 'food', credits = 5) {
    db.prepare(`
        INSERT INTO posts (id, type, category, title, description, credits, price_type, author_pubkey, status, active, created_at, updated_at)
        VALUES (?, 'offer', ?, ?, 'A test offer', ?, 'fixed', ?, 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(id, category, title, credits, authorPubkey);
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
    console.log('\n=== test-marketplace-list: Pictures S6 enterprise banner on cards ===\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const alice = member('Alice');
    const bob = member('Bob');

    // 1. Enterprise with a shop and banner photo
    const ent = createTreasury('Community Bakery', 'bundled://bean-green', 0, { purpose: 'Baking bread' });
    const entShop = openShop(ent.publicKey);
    const entPhotoSet = setShopPhoto(entShop.id, TINY_PNG);
    assert(entPhotoSet, 'enterprise shop banner photo set successfully');

    // Enterprise photoless listing
    insertPhotolessPost('post-ent-1', ent.publicKey, 'Enterprise Sourdough');

    // 2. Member with a shop and banner photo
    const bobShop = openShop(bob.pk);
    const bobPhotoSet = setShopPhoto(bobShop.id, TINY_PNG);
    assert(bobPhotoSet, 'member shop banner photo set successfully');

    // Member photoless listing
    insertPhotolessPost('post-bob-1', bob.pk, 'Bob Homemade Jam');

    // 3. Member read: enterprise photoless listing carries authorBannerUrl, member's carries none
    const memberRes = await call('GET', alice, '/api/marketplace/posts');
    assert(memberRes.status === 200, `member GET /api/marketplace/posts returns 200 (got ${memberRes.status})`);
    const posts: any[] = Array.isArray(memberRes.body) ? memberRes.body : memberRes.body?.posts;
    assert(Array.isArray(posts) && posts.length >= 2, 'member received listings');

    const entListing = posts.find((p: any) => p.title === 'Enterprise Sourdough');
    const bobListing = posts.find((p: any) => p.title === 'Bob Homemade Jam');

    assert(!!entListing, 'enterprise listing found in feed');
    assert(typeof entListing.authorBannerUrl === 'string' && entListing.authorBannerUrl.startsWith(`/api/shops/${entShop.id}/photo?v=`) && entListing.authorBannerUrl.includes('&k='),
        `enterprise photoless listing carries keyed shop photo URL (got ${entListing.authorBannerUrl})`);

    assert(!!bobListing, 'bob listing found in feed');
    assert(bobListing.authorBannerUrl === undefined,
        `member photoless listing carries no authorBannerUrl (got ${bobListing.authorBannerUrl})`);

    // 4. Visitor read (unsigned): gets none
    const visitorRes = await call('GET', null, '/api/marketplace/posts');
    assert(visitorRes.status === 200, `visitor GET /api/marketplace/posts returns 200 (got ${visitorRes.status})`);
    const visitorPosts: any[] = Array.isArray(visitorRes.body) ? visitorRes.body : visitorRes.body?.posts;
    assert(Array.isArray(visitorPosts) && visitorPosts.length >= 2, 'visitor received listings');

    const entVisitorListing = visitorPosts.find((p: any) => p.title === 'Enterprise Sourdough');
    const bobVisitorListing = visitorPosts.find((p: any) => p.title === 'Bob Homemade Jam');

    assert(!!entVisitorListing, 'enterprise listing found in visitor feed');
    assert(entVisitorListing.authorBannerUrl === undefined,
        `visitor gets no authorBannerUrl on enterprise listing (got ${entVisitorListing.authorBannerUrl})`);
    assert(!!bobVisitorListing, 'bob listing found in visitor feed');
    assert(bobVisitorListing.authorBannerUrl === undefined,
        `visitor gets no authorBannerUrl on member listing (got ${bobVisitorListing.authorBannerUrl})`);

    // 5. Visitor read (signed non-member): gets none
    const stranger = newId('Stranger');
    const strangerRes = await call('GET', stranger, '/api/marketplace/posts');
    assert(strangerRes.status === 200, `stranger GET /api/marketplace/posts returns 200 (got ${strangerRes.status})`);
    const strangerPosts: any[] = Array.isArray(strangerRes.body) ? strangerRes.body : strangerRes.body?.posts;
    const entStrangerListing = strangerPosts.find((p: any) => p.title === 'Enterprise Sourdough');
    assert(entStrangerListing?.authorBannerUrl === undefined,
        `signed non-member gets no authorBannerUrl on enterprise listing (got ${entStrangerListing?.authorBannerUrl})`);

    console.log(`\nAll ${passed}/${run} checks passed!\n`);
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
