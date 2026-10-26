/**
 * Every new Offer, Need and event carries a photo (Marty, 26 Oct: market-photo-required).
 *
 * Verifies over real HTTP through the real signature middleware:
 *  1. A member Offer without photos -> 400 "Add a photo first", nothing stored; with 1 photo -> created.
 *  2. A member Need (Beans on AND Beans off) without photos -> 400 "Add a photo first", nothing stored; with 1 photo -> created.
 *  3. An enterprise Offer and Need posted by a keeper without photos -> 400 "Add a photo first", nothing stored; with 1 photo -> created.
 *  4. An event without photos -> 400 "Add a photo first", nothing stored; with 1 photo -> created.
 *  5. An edit that removes the last photo -> refused (400 "Add a photo first"), post keeps its photo.
 *  6. An edit of a stored photoless post (inserted directly) with no photo -> allowed (200).
 *  7. A synced/federated photoless post is still accepted (via cacheRemoteListings ingest).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-market-photo-required.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createTreasury, adminAssignTreasuryOperator } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { cacheRemoteListings } from './federation-listings.js';
import { NODE_PROFILE_KEY } from './config/node-profile.js';

let PORT = 0;
let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function makeIdentity(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(pubKeyHex, callsign);
    setMemberPhoto(db, pubKeyHex, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'POST', path: string, body: unknown, id: Id | null) {
    const bodyString = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(`${NODE_PROFILE_KEY}.${name}`, value);

async function main(): Promise<void> {
    console.log('\nMarket: photo required on every new Offer, Need and event (real HTTP)\n');
    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    const alice = makeIdentity('AliceMember');
    const bob = makeIdentity('BobMember');
    const keeper = makeIdentity('KeeperDan');

    const { publicKey: enterprise } = createTreasury('Community Orchard', AVATAR, 0, { leadKeeperPubkey: keeper.pubKeyHex });
    adminAssignTreasuryOperator(enterprise, keeper.pubKeyHex, 'admin');

    // ── 1. Member Offer ──────────────────────────────────────────────────────
    console.log('── 1. Member Offer ──');
    const offerNoPhoto = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'offer',
        authorPublicKey: alice.pubKeyHex,
        title: 'Sourdough loaf no photo',
        category: 'food',
        credits: 5,
        description: 'Fresh bread',
        lat: -28.55,
        lng: 153.5,
    }, alice);
    assert(offerNoPhoto.status === 400 && offerNoPhoto.error === 'Add a photo first',
        `member Offer without photos refused 400 with "Add a photo first" (got ${offerNoPhoto.status}: ${offerNoPhoto.error})`);
    const storedOfferNoPhoto = db.prepare("SELECT 1 FROM posts WHERE title = 'Sourdough loaf no photo'").get();
    assert(!storedOfferNoPhoto, 'photoless member Offer was NOT stored');

    const offerWithPhoto = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'offer',
        authorPublicKey: alice.pubKeyHex,
        title: 'Sourdough loaf with photo',
        category: 'food',
        credits: 5,
        description: 'Fresh bread',
        lat: -28.55,
        lng: 153.5,
        photos: [PHOTO],
    }, alice);
    assert(offerWithPhoto.status === 200 && offerWithPhoto.body?.success === true,
        `member Offer with photo accepted 200 (got ${offerWithPhoto.status})`);
    const storedOfferWithPhoto = db.prepare("SELECT id FROM posts WHERE title = 'Sourdough loaf with photo'").get() as any;
    assert(!!storedOfferWithPhoto, 'member Offer with photo was stored');

    // ── 2. Member Need (Beans on) ────────────────────────────────────────────
    console.log('── 2. Member Need (Beans on) ──');
    // Alice has an active offer now, so offerFirst gate passes.
    const needNoPhoto = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'need',
        authorPublicKey: alice.pubKeyHex,
        title: 'Gardening help no photo',
        category: 'help',
        credits: 10,
        description: 'Need weeding',
        lat: -28.55,
        lng: 153.5,
    }, alice);
    assert(needNoPhoto.status === 400 && needNoPhoto.error === 'Add a photo first',
        `member Need without photos (Beans on) refused 400 with "Add a photo first" (got ${needNoPhoto.status}: ${needNoPhoto.error})`);
    const storedNeedNoPhoto = db.prepare("SELECT 1 FROM posts WHERE title = 'Gardening help no photo'").get();
    assert(!storedNeedNoPhoto, 'photoless member Need (Beans on) was NOT stored');

    const needWithPhoto = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'need',
        authorPublicKey: alice.pubKeyHex,
        title: 'Gardening help with photo',
        category: 'help',
        credits: 10,
        description: 'Need weeding',
        lat: -28.55,
        lng: 153.5,
        photos: [PHOTO],
    }, alice);
    assert(needWithPhoto.status === 200 && needWithPhoto.body?.success === true,
        `member Need with photo (Beans on) accepted 200 (got ${needWithPhoto.status})`);

    // ── 3. Member Need (Beans off) ───────────────────────────────────────────
    console.log('── 3. Member Need (Beans off) ──');
    setOverride('beans', 'false');
    // Bob has no offers listed; where Beans are off, offerFirst does not block him, but photo is still required.
    const globalNeedNoPhoto = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'need',
        authorPublicKey: bob.pubKeyHex,
        title: 'Global need no photo',
        category: 'help',
        credits: 0,
        description: 'Need assistance',
        lat: -28.55,
        lng: 153.5,
    }, bob);
    assert(globalNeedNoPhoto.status === 400 && globalNeedNoPhoto.error === 'Add a photo first',
        `member Need without photos (Beans off) refused 400 with "Add a photo first" (got ${globalNeedNoPhoto.status}: ${globalNeedNoPhoto.error})`);
    const storedGlobalNoPhoto = db.prepare("SELECT 1 FROM posts WHERE title = 'Global need no photo'").get();
    assert(!storedGlobalNoPhoto, 'photoless member Need (Beans off) was NOT stored');

    const globalNeedWithPhoto = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'need',
        authorPublicKey: bob.pubKeyHex,
        title: 'Global need with photo',
        category: 'help',
        credits: 0,
        description: 'Need assistance',
        lat: -28.55,
        lng: 153.5,
        photos: [PHOTO],
    }, bob);
    assert(globalNeedWithPhoto.status === 200 && globalNeedWithPhoto.body?.success === true,
        `member Need with photo (Beans off) accepted 200 (got ${globalNeedWithPhoto.status})`);
    setOverride('beans', 'true');

    // ── 4. Enterprise Offer & Need (Keeper) ─────────────────────────────────
    console.log('── 4. Enterprise Offer & Need (Keeper) ──');
    const entOfferNoPhoto = await signedFetch('POST', `/api/treasury/${enterprise}/offer`, {
        title: 'Orchard apples no photo',
        category: 'produce',
        credits: 8,
        description: 'Box of apples',
    }, keeper);
    assert(entOfferNoPhoto.status === 400 && entOfferNoPhoto.error === 'Add a photo first',
        `enterprise Offer without photos refused 400 with "Add a photo first" (got ${entOfferNoPhoto.status}: ${entOfferNoPhoto.error})`);
    const storedEntOfferNoPhoto = db.prepare("SELECT 1 FROM posts WHERE title = 'Orchard apples no photo'").get();
    assert(!storedEntOfferNoPhoto, 'photoless enterprise Offer was NOT stored');

    const entOfferWithPhoto = await signedFetch('POST', `/api/treasury/${enterprise}/offer`, {
        title: 'Orchard apples with photo',
        category: 'produce',
        credits: 8,
        description: 'Box of apples',
        photos: [PHOTO],
    }, keeper);
    assert(entOfferWithPhoto.status === 200 && entOfferWithPhoto.body?.success === true,
        `enterprise Offer with photo accepted 200 (got ${entOfferWithPhoto.status})`);

    const entNeedNoPhoto = await signedFetch('POST', `/api/treasury/${enterprise}/need`, {
        title: 'Orchard pruning no photo',
        category: 'labour',
        credits: 20,
        description: 'Winter pruning',
    }, keeper);
    assert(entNeedNoPhoto.status === 400 && entNeedNoPhoto.error === 'Add a photo first',
        `enterprise Need without photos refused 400 with "Add a photo first" (got ${entNeedNoPhoto.status}: ${entNeedNoPhoto.error})`);
    const storedEntNeedNoPhoto = db.prepare("SELECT 1 FROM posts WHERE title = 'Orchard pruning no photo'").get();
    assert(!storedEntNeedNoPhoto, 'photoless enterprise Need was NOT stored');

    const entNeedWithPhoto = await signedFetch('POST', `/api/treasury/${enterprise}/need`, {
        title: 'Orchard pruning with photo',
        category: 'labour',
        credits: 20,
        description: 'Winter pruning',
        photos: [PHOTO],
    }, keeper);
    assert(entNeedWithPhoto.status === 200 && entNeedWithPhoto.body?.success === true,
        `enterprise Need with photo accepted 200 (got ${entNeedWithPhoto.status})`);

    // ── 5. Event ─────────────────────────────────────────────────────────────
    console.log('── 5. Event ──');
    const eventNoPhoto = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'event',
        authorPublicKey: alice.pubKeyHex,
        title: 'Harvest festival no photo',
        description: 'Gather at the orchard',
        lat: -28.55,
        lng: 153.5,
        eventStartAt: inHours(24),
    }, alice);
    assert(eventNoPhoto.status === 400 && eventNoPhoto.error === 'Add a photo first',
        `event without photos refused 400 with "Add a photo first" (got ${eventNoPhoto.status}: ${eventNoPhoto.error})`);
    const storedEventNoPhoto = db.prepare("SELECT 1 FROM posts WHERE title = 'Harvest festival no photo'").get();
    assert(!storedEventNoPhoto, 'photoless event was NOT stored');

    const eventWithPhoto = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'event',
        authorPublicKey: alice.pubKeyHex,
        title: 'Harvest festival with photo',
        description: 'Gather at the orchard',
        lat: -28.55,
        lng: 153.5,
        eventStartAt: inHours(24),
        photos: [PHOTO],
    }, alice);
    assert(eventWithPhoto.status === 200 && eventWithPhoto.body?.success === true,
        `event with photo accepted 200 (got ${eventWithPhoto.status})`);

    // ── 6. Edits: removing last photo refused vs photoless post allowed ─────
    console.log('── 6. Edits ──');
    const photoPostId = storedOfferWithPhoto.id;
    const removePhotoEdit = await signedFetch('POST', '/api/marketplace/posts/update', {
        id: photoPostId,
        authorPublicKey: alice.pubKeyHex,
        photos: [],
    }, alice);
    assert(removePhotoEdit.status === 400 && removePhotoEdit.error === 'Add a photo first',
        `edit taking post with photos down to zero refused 400 (got ${removePhotoEdit.status}: ${removePhotoEdit.error})`);
    const photoStillPresent = db.prepare("SELECT COUNT(*) AS c FROM post_photos WHERE post_id = ?").get(photoPostId) as { c: number };
    assert(photoStillPresent.c > 0, 'post still has its photo stored');

    // Direct insert of an older photoless post
    const olderPostId = 'photoless-legacy-post-1';
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, price_type, author_pubkey, created_at, active, status)
                VALUES (?, 'offer', 'food', 'Old bread legacy', 'Old loaf', 5, 'fixed', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, 'active')`)
        .run(olderPostId, alice.pubKeyHex);

    const editOlderPost = await signedFetch('POST', '/api/marketplace/posts/update', {
        id: olderPostId,
        authorPublicKey: alice.pubKeyHex,
        title: 'Old bread renamed',
        photos: [],
    }, alice);
    assert(editOlderPost.status === 200 && editOlderPost.body?.success === true,
        `edit of an older photoless post without adding photo is allowed (got ${editOlderPost.status})`);
    const updatedOlderTitle = (db.prepare("SELECT title FROM posts WHERE id = ?").get(olderPostId) as any)?.title;
    assert(updatedOlderTitle === 'Old bread renamed', 'older photoless post was updated successfully');

    // ── 7. Synced/federated photoless post is accepted ────────────────────────
    console.log('── 7. Sync / federation ingest ──');
    const ingestRes = cacheRemoteListings('peer-123456789012', 'https://remote-peer.local', [{
        id: 'remote-post-1',
        type: 'offer',
        category: 'food',
        title: 'Remote peer bread',
        description: 'From peer without photos',
        credits: 10,
        priceType: 'fixed',
        authorPublicKey: crypto.randomBytes(32).toString('hex'),
        authorCallsign: 'RemoteAuthor',
        createdAt: new Date().toISOString(),
        updatedAt: null,
    }]);
    assert(ingestRes.cached === 1 && ingestRes.dropped === 0,
        `cacheRemoteListings cached 1 photoless remote listing (cached: ${ingestRes.cached}, dropped: ${ingestRes.dropped})`);
    const storedRemote = db.prepare("SELECT 1 FROM posts WHERE title = 'Remote peer bread'").get();
    assert(!!storedRemote, 'federated photoless post was stored successfully in posts table');

    console.log(`\nAll done: ${passed}/${run} assertions passed.\n`);
    if (passed < run) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed with unhandled error:', err);
    process.exit(1);
});
