/**
 * Pictures S6: The enterprise's banner on its listings' cards
 *
 * Verifies that:
 * 1. An enterprise's photoless listing carries its shop's keyed photo URL (authorBannerUrl).
 * 2. A regular member's listing carries none (even if the member has a shop with a banner).
 * 3. A visitor (unsigned caller or non-member) gets none on any listing.
 * 4. A banner a keeper replaces, takes down or closes with the shop moves the list's ETag, so a member's copy held from
 *    before (its URL then opens nothing) is not confirmed with a 304 (engine/shops.ts changeShop, closeShop).
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
    initStateEngine, seedGenesisMember, createTreasury, createPost, adminAssignTreasuryOperator,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { openShop, setShopPhoto } from './engine/shops.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setSwitchOverride } from './config/node-profile.js';
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
interface Res { status: number; body: any; text: string; etag: string | null }
async function call(method: Method, id: Id | null, route: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
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
    return { status: res.status, body: parsed, text, etag: res.headers.get('etag') };
}

function insertPhotolessPost(id: string, authorPubkey: string, title: string, category = 'food', credits = 5) {
    db.prepare(`
        INSERT INTO posts (id, type, category, title, description, credits, price_type, author_pubkey, status, active, created_at, updated_at)
        VALUES (?, 'offer', ?, ?, 'A test offer', ?, 'fixed', ?, 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(id, category, title, credits, authorPubkey);
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const OTHER_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGM4oQEEJwAHrwIxhE/biwAAAABJRU5ErkJggg==';

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

    // 4. Visitor read (unsigned): gets none (with visitors' view enabled)
    setSwitchOverride('guestListingsOnly', true);
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

    // 5. Visitor read (signed non-member) on the visitors' view: gets the listing, and none (guestPost drops it)
    const stranger = newId('Stranger');
    const strangerRes = await call('GET', stranger, '/api/marketplace/posts');
    assert(strangerRes.status === 200, `stranger GET /api/marketplace/posts returns 200 (got ${strangerRes.status})`);
    const strangerPosts: any[] = Array.isArray(strangerRes.body) ? strangerRes.body : strangerRes.body?.posts;
    const entStrangerListing = strangerPosts.find((p: any) => p.title === 'Enterprise Sourdough');
    assert(!!entStrangerListing, 'enterprise listing found in signed non-member feed');
    assert(!('authorBannerUrl' in entStrangerListing),
        `signed non-member gets no authorBannerUrl on enterprise listing (got ${entStrangerListing.authorBannerUrl})`);

    // 5b. Without the visitors' view, a non-member who passes the read gate is no guestView, so guestPost never runs and
    // only the route's `!isMember` strip keeps the banner from them (routes/marketplace.ts). With read auth on, as here,
    // that reader is a paused member: a 'disabled' row passes the gate (passesReadGate) and reads as a non-member
    // (readsAsMember). A key with no row never reaches the route.
    setSwitchOverride('guestListingsOnly', false);
    const paused = member('Paula');
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(paused.pk);
    const pausedRes = await call('GET', paused, '/api/marketplace/posts');
    assert(pausedRes.status === 200, `paused member GET /api/marketplace/posts returns 200 without the visitors' view (got ${pausedRes.status})`);
    assert(pausedRes.text.length > 0 && !pausedRes.text.includes('authorBannerUrl'), 'no listing in the paused member\'s read names a banner');
    const pausedPosts: any[] = Array.isArray(pausedRes.body) ? pausedRes.body : pausedRes.body?.posts;
    const entPausedListing = pausedPosts.find((p: any) => p.title === 'Enterprise Sourdough');
    assert(!!entPausedListing, 'enterprise listing found in the paused member\'s feed');
    assert(entPausedListing.authorCallsign === 'Community Bakery',
        `the paused member's read is the members' shape, not guestPost's (author named: ${entPausedListing.authorCallsign})`);
    assert(!('authorBannerUrl' in entPausedListing),
        `paused member (a non-member reader) gets no authorBannerUrl on enterprise listing (got ${entPausedListing.authorBannerUrl})`);
    const strangerNoViewRes = await call('GET', stranger, '/api/marketplace/posts');
    assert(strangerNoViewRes.status !== 200 && !strangerNoViewRes.text.includes('/api/shops/'),
        `a key with no row is refused before the route without the visitors' view (got ${strangerNoViewRes.status})`);
    setSwitchOverride('guestListingsOnly', true);

    // 6. Home Market rows: enterprise photoless listing carries bannerUrl; a member's and a visitor's row have no bannerUrl key
    const homeMemberRes = await call('GET', alice, '/api/home');
    assert(homeMemberRes.status === 200, `member GET /api/home returns 200 (got ${homeMemberRes.status})`);
    const homeMarketItems = homeMemberRes.body?.cards?.market?.items || [];
    const entHomeItem = homeMarketItems.find((p: any) => p.id === 'post-ent-1');
    const bobHomeItem = homeMarketItems.find((p: any) => p.id === 'post-bob-1');
    assert(!!entHomeItem, 'enterprise listing found in home market items');
    assert(typeof entHomeItem?.bannerUrl === 'string' && entHomeItem.bannerUrl.startsWith(`/api/shops/${entShop.id}/photo?v=`) && entHomeItem.bannerUrl.includes('&k='),
        `enterprise listing in home market items carries shop bannerUrl (got ${entHomeItem?.bannerUrl})`);
    assert(!!bobHomeItem, 'bob listing found in home market items');
    assert(!('bannerUrl' in bobHomeItem),
        `member listing in home market items has no bannerUrl key (got ${bobHomeItem?.bannerUrl})`);

    // Visitor read of /api/home: no bannerUrl key on the enterprise listing (W3: the visitors' answer gains no field)
    const homeVisitorRes = await call('GET', null, '/api/home');
    assert(homeVisitorRes.status === 200, `visitor GET /api/home returns 200 (got ${homeVisitorRes.status})`);
    const homeVisitorItems = homeVisitorRes.body?.cards?.market?.items || [];
    const entVisitorHomeItem = homeVisitorItems.find((p: any) => p.id === 'post-ent-1');
    assert(!!entVisitorHomeItem, 'enterprise listing found in visitor home market items');
    assert(!('bannerUrl' in entVisitorHomeItem),
        `visitor gets no bannerUrl key on enterprise listing in home (got ${entVisitorHomeItem?.bannerUrl})`);

    // 7. Standby sync delta import: multiple shops for an owner do NOT duplicate post rows in feed
    db.prepare(`
        INSERT INTO shops (id, owner_pubkey, opened_at, updated_at)
        VALUES ('shop-standby-dup', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', '-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ','now', '-1 day'))
    `).run(ent.publicKey);

    const dupRes = await call('GET', alice, '/api/marketplace/posts');
    assert(dupRes.status === 200, 'member GET /api/marketplace/posts with multiple shop rows returns 200');
    const dupPosts: any[] = Array.isArray(dupRes.body) ? dupRes.body : dupRes.body?.posts;
    const entDupListings = dupPosts.filter((p: any) => p.id === 'post-ent-1');
    assert(entDupListings.length === 1, `post rows are not duplicated by multiple shops (got ${entDupListings.length})`);
    assert(entDupListings[0].authorBannerUrl?.startsWith(`/api/shops/${entShop.id}/photo?v=`),
        'enterprise listing still selects newest shop photo_ref');

    // 8. A banner changed after a member read the list. The list is tagged by the node's posts version (routes/
    // marketplace.ts), and the old URL's key is bound to the photo as it was (avatar-keys.ts shopPhotoKeyMatches), so a
    // replace, a take-down and a close must each move the tag: a 304 would confirm a body naming a URL that opens nothing.
    // Through the keeper's real routes. A second enterprise, so the rows above are left as they are.
    const mill = createTreasury('Valley Mill', 'bundled://bean-green', 0, { purpose: 'Milling flour' });
    const kit = member('Kit');
    adminAssignTreasuryOperator(mill.publicKey, kit.pk, 'admin');
    const millShop = openShop(mill.publicKey);
    assert(setShopPhoto(millShop.id, TINY_PNG), 'the second enterprise\'s shop banner photo set');
    insertPhotolessPost('post-mill-1', mill.publicKey, 'Mill Wholemeal');
    const millListingOf = (res: Res) => ((Array.isArray(res.body) ? res.body : res.body?.posts) as any[] | undefined)?.find((p: any) => p.id === 'post-mill-1');
    const shopRoute = `/api/treasury/${mill.publicKey}/shop`;

    const heldRes = await call('GET', alice, '/api/marketplace/posts');
    const heldUrl: string | undefined = millListingOf(heldRes)?.authorBannerUrl;
    assert(heldRes.status === 200 && !!heldRes.etag && typeof heldUrl === 'string' && heldUrl.startsWith(`/api/shops/${millShop.id}/photo?v=`),
        `a member reads the list with an ETag and the enterprise's banner URL (${heldRes.etag} ${heldUrl})`);
    assert((await fetch(`${BASE}${heldUrl}`)).status === 200, 'that URL serves the banner');

    const replaced = await call('PUT', kit, shopRoute, { photo: OTHER_PNG });
    assert(replaced.status === 200, `a keeper replaces the banner through PUT /api/treasury/:t/shop (got ${replaced.status})`);
    assert((await fetch(`${BASE}${heldUrl}`)).status === 404, 'the URL the member holds now opens nothing');
    const afterReplace = await call('GET', alice, '/api/marketplace/posts', undefined, { 'If-None-Match': heldRes.etag! });
    const replacedUrl: string | undefined = millListingOf(afterReplace)?.authorBannerUrl;
    assert(afterReplace.status === 200 && afterReplace.etag !== heldRes.etag,
        `revalidating with the ETag held from before the replace is not a 304 (got ${afterReplace.status}, ${afterReplace.etag})`);
    assert(typeof replacedUrl === 'string' && replacedUrl.startsWith(`/api/shops/${millShop.id}/photo?v=`) && replacedUrl !== heldUrl,
        `and the body names the new banner URL (${replacedUrl})`);
    assert((await fetch(`${BASE}${replacedUrl}`)).status === 200, 'which serves the new banner');

    const takenDown = await call('PUT', kit, shopRoute, { photo: null });
    assert(takenDown.status === 200, `a keeper takes the banner down with { photo: null } (got ${takenDown.status})`);
    const afterTakeDown = await call('GET', alice, '/api/marketplace/posts', undefined, { 'If-None-Match': afterReplace.etag! });
    assert(afterTakeDown.status === 200 && afterTakeDown.etag !== afterReplace.etag,
        `revalidating with the ETag held from before the take-down is not a 304 (got ${afterTakeDown.status}, ${afterTakeDown.etag})`);
    const millDown = millListingOf(afterTakeDown);
    assert(!!millDown && !('authorBannerUrl' in millDown), `and the listing names no banner (${millDown?.authorBannerUrl})`);

    // A close: the listing was never in the shop (no listing is cleared), and loses the banner all the same, since it is
    // read by the enterprise (engine posts.ts).
    const putBack = await call('PUT', kit, shopRoute, { photo: TINY_PNG });
    assert(putBack.status === 200, `a keeper puts a banner back up (got ${putBack.status})`);
    const beforeClose = await call('GET', alice, '/api/marketplace/posts');
    assert(typeof millListingOf(beforeClose)?.authorBannerUrl === 'string', `the listing carries it again (${millListingOf(beforeClose)?.authorBannerUrl})`);
    const closed = await call('POST', kit, `${shopRoute}/close`, {});
    assert(closed.status === 200 && closed.body?.cleared === 0, `a keeper closes the shop, which held none of the enterprise's listings (${closed.status} cleared ${closed.body?.cleared})`);
    const afterClose = await call('GET', alice, '/api/marketplace/posts', undefined, { 'If-None-Match': beforeClose.etag! });
    assert(afterClose.status === 200 && afterClose.etag !== beforeClose.etag,
        `revalidating with the ETag held from before the close is not a 304 (got ${afterClose.status}, ${afterClose.etag})`);
    const millClosed = millListingOf(afterClose);
    assert(!!millClosed && !('authorBannerUrl' in millClosed), `and the listing names no banner (${millClosed?.authorBannerUrl})`);

    // With nothing changed the tag holds, so the checks above do not pass on a tag that moves on every read.
    const quiet = await call('GET', alice, '/api/marketplace/posts', undefined, { 'If-None-Match': afterClose.etag! });
    assert(quiet.status === 304, `with nothing changed, the same ETag is answered 304 (got ${quiet.status})`);

    console.log(`\nAll ${passed}/${run} checks passed!\n`);
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
