/**
 * A keeper pausing and resuming their enterprise's Offer or Need, over REAL HTTP — through the signature middleware.
 *
 * On the phone and web, a keeper sees Pause on an enterprise Offer. The client sends the member's OWN key as authorPublicKey,
 * signed with their own key.
 *
 * Verifies:
 *  1. A keeper pauses an enterprise Offer (sending member key, as the phone does) -> 200, status flips to 'paused', row author is still the enterprise.
 *  2. A keeper resumes an enterprise Offer -> 200, status flips to 'active', row author is still the enterprise.
 *  3. A Need the same (pause and resume).
 *  4. Refused as today: a member who keeps nothing (400), a keeper of another enterprise (400), stranger naming enterprise in body (403).
 *  5. A muted keeper: pause is allowed (200), resume is refused (403).
 *  6. A muted enterprise: resume is refused (403).
 *  7. A closed enterprise: pause and resume refused (403).
 *  8. A post in a shop keeps its shop bookkeeping (forgetPausedPost, shop_id, 409 while closed).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-post-pause-http.ts
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createTreasury, adminAssignTreasuryOperator } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

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

/** The replay-proof scheme the real middleware requires: method + path + timestamp + nonce + body. */
async function signedFetch(method: 'POST' | 'GET' | 'PUT', path: string, body: unknown, id: Id | null) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = method === 'GET' ? {} : { 'Content-Type': 'application/json' };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any;
    try { json = await res.clone().json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined, res };
}

const rowOf = (id: string) => db.prepare('SELECT title, description, author_pubkey, created_by, type, status, shop_id FROM posts WHERE id = ?').get(id) as
    { title: string; description: string; author_pubkey: string; created_by: string | null; type: string; status: string; shop_id: string | null } | undefined;
const shopRowOf = (id: string) => db.prepare('SELECT id, paused_at, paused_posts FROM shops WHERE id = ?').get(id) as
    { id: string; paused_at: string | null; paused_posts: string | null } | undefined;
const show = (r: { status: number; error?: string; body?: any }) => `${r.status} ${r.error ?? ''}${r.body?.code ? ` [${r.body.code}]` : ''}`;

async function main(): Promise<void> {
    console.log("\nA keeper pausing and resuming their enterprise's Offer or Need, over real HTTP\n");
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const keeper = makeIdentity('KeeperDamo');
    const stranger = makeIdentity('StrangerSam');
    const otherKeeper = makeIdentity('OtherKeeperOli');

    const { publicKey: enterprise } = createTreasury('Mullum Eggs', AVATAR, 0, { leadKeeperPubkey: keeper.pubKeyHex });
    adminAssignTreasuryOperator(enterprise, keeper.pubKeyHex, 'admin');
    const { publicKey: otherEnterprise } = createTreasury('Byron Bikes', AVATAR, 0, { leadKeeperPubkey: otherKeeper.pubKeyHex });
    adminAssignTreasuryOperator(otherEnterprise, otherKeeper.pubKeyHex, 'admin');

    // ── 1. Enterprise Offer pause and resume ──────────────────────────────────────────────────
    console.log('── 1. An enterprise Offer paused then resumed by a keeper ──');
    const offerRes = await signedFetch('POST', `/api/treasury/${enterprise}/offer`, {
        category: 'food', title: 'Dozen eggs', description: 'Fresh farm eggs', credits: 6, priceType: 'fixed', repeatable: true,
    }, keeper);
    assert(offerRes.status === 200 && offerRes.body?.success === true, `keeper creates enterprise Offer (${show(offerRes)})`);
    const offerId: string = offerRes.body?.post?.id;
    assert(rowOf(offerId)?.status === 'active' && rowOf(offerId)?.author_pubkey === enterprise, 'Offer starts active, authored by enterprise');

    // Keeper pauses with member's key, as the phone and web send
    const pauseOffer = await signedFetch('POST', '/api/marketplace/posts/pause', {
        postId: offerId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(pauseOffer.status === 200 && pauseOffer.body?.success === true, `keeper pauses enterprise Offer (${show(pauseOffer)})`);
    assert(rowOf(offerId)?.status === 'paused', 'Offer status is now paused');
    assert(rowOf(offerId)?.author_pubkey === enterprise, 'Offer author is still the enterprise');

    // Keeper resumes with member's key
    const resumeOffer = await signedFetch('POST', '/api/marketplace/posts/resume', {
        postId: offerId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(resumeOffer.status === 200 && resumeOffer.body?.success === true, `keeper resumes enterprise Offer (${show(resumeOffer)})`);
    assert(rowOf(offerId)?.status === 'active', 'Offer status is now active again');
    assert(rowOf(offerId)?.author_pubkey === enterprise, 'Offer author remains the enterprise');

    // ── 2. Enterprise Need pause and resume ───────────────────────────────────────────────────
    console.log('\n── 2. An enterprise Need paused then resumed by a keeper ──');
    const needRes = await signedFetch('POST', `/api/treasury/${enterprise}/need`, {
        category: 'labour', title: 'Tend flock', description: 'Weekend coop help', credits: 10, priceType: 'fixed',
    }, keeper);
    assert(needRes.status === 200 && needRes.body?.success === true, `keeper creates enterprise Need (${show(needRes)})`);
    const needId: string = needRes.body?.post?.id;
    assert(rowOf(needId)?.status === 'active' && rowOf(needId)?.author_pubkey === enterprise, 'Need starts active, authored by enterprise');

    const pauseNeed = await signedFetch('POST', '/api/marketplace/posts/pause', {
        postId: needId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(pauseNeed.status === 200 && pauseNeed.body?.success === true, `keeper pauses enterprise Need (${show(pauseNeed)})`);
    assert(rowOf(needId)?.status === 'paused' && rowOf(needId)?.author_pubkey === enterprise, 'Need status is now paused, author unchanged');

    const resumeNeed = await signedFetch('POST', '/api/marketplace/posts/resume', {
        postId: needId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(resumeNeed.status === 200 && resumeNeed.body?.success === true, `keeper resumes enterprise Need (${show(resumeNeed)})`);
    assert(rowOf(needId)?.status === 'active' && rowOf(needId)?.author_pubkey === enterprise, 'Need status is active again, author unchanged');

    // ── 3. Non-keeper / stranger refused as today ───────────────────────────────────────────
    console.log('\n── 3. Non-keeper refused ──');
    const strangerPause = await signedFetch('POST', '/api/marketplace/posts/pause', {
        postId: offerId, authorPublicKey: stranger.pubKeyHex,
    }, stranger);
    assert(strangerPause.status === 400 && strangerPause.error === 'Post not found, not active, or not owned by author',
        `stranger pause refused as today (${show(strangerPause)})`);

    const otherKeeperPause = await signedFetch('POST', '/api/marketplace/posts/pause', {
        postId: offerId, authorPublicKey: otherKeeper.pubKeyHex,
    }, otherKeeper);
    assert(otherKeeperPause.status === 400 && otherKeeperPause.error === 'Post not found, not active, or not owned by author',
        `keeper of another enterprise refused as today (${show(otherKeeperPause)})`);

    const spoofedPause = await signedFetch('POST', '/api/marketplace/posts/pause', {
        postId: offerId, authorPublicKey: enterprise,
    }, stranger);
    assert(spoofedPause.status === 403, `naming the enterprise in the body without entitlement is refused 403 (${show(spoofedPause)})`);

    // ── 4. Muted keeper and muted enterprise ────────────────────────────────────────────────
    console.log('\n── 4. Muted keeper and muted enterprise ──');
    // Muted keeper: pause is allowed, resume is refused
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + 86_400_000).toISOString(), keeper.pubKeyHex);
    const mutedPause = await signedFetch('POST', '/api/marketplace/posts/pause', {
        postId: offerId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(mutedPause.status === 200 && mutedPause.body?.success === true, `a muted keeper is allowed to pause (${show(mutedPause)})`);

    const mutedResume = await signedFetch('POST', '/api/marketplace/posts/resume', {
        postId: offerId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(mutedResume.status === 403 && mutedResume.body?.code === 'moderation_muted', `a muted keeper is refused from resuming (${show(mutedResume)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(keeper.pubKeyHex);

    // Muted enterprise: resume is refused
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + 86_400_000).toISOString(), enterprise);
    const mutedEnterpriseResume = await signedFetch('POST', '/api/marketplace/posts/resume', {
        postId: offerId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(mutedEnterpriseResume.status === 403 && mutedEnterpriseResume.body?.code === 'moderation_muted', `resuming for a muted enterprise is refused (${show(mutedEnterpriseResume)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(enterprise);

    // Put offer back to active
    const unmutedResume = await signedFetch('POST', '/api/marketplace/posts/resume', {
        postId: offerId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(unmutedResume.status === 200, 'unmuted keeper resumes offer');

    // ── 5. Closed enterprise refused ────────────────────────────────────────────────────────
    console.log('\n── 5. Closed enterprise refused ──');
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(enterprise);
    const closedPause = await signedFetch('POST', '/api/marketplace/posts/pause', {
        postId: offerId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(closedPause.status === 403 && closedPause.error === 'This enterprise has been closed, so it can no longer be modified.',
        `a closed enterprise's Offer takes no pause (${show(closedPause)})`);

    // Put post status to paused in db to test closed resume
    db.prepare("UPDATE posts SET status = 'paused' WHERE id = ?").run(offerId);
    const closedResume = await signedFetch('POST', '/api/marketplace/posts/resume', {
        postId: offerId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(closedResume.status === 403 && closedResume.error === 'This enterprise has been closed, so it can no longer be modified.',
        `a closed enterprise's Offer takes no resume (${show(closedResume)})`);

    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(enterprise);
    db.prepare("UPDATE posts SET status = 'active' WHERE id = ?").run(offerId);

    // ── 6. Shop bookkeeping ─────────────────────────────────────────────────────────────────
    console.log('\n── 6. Shop bookkeeping ──');
    // Create an enterprise shop (it takes the enterprise's name)
    const shopCreate = await signedFetch('PUT', `/api/treasury/${enterprise}/shop`, {
        category: 'food',
    }, keeper);
    assert(shopCreate.status === 200 && !!shopCreate.body?.shop?.id, `enterprise shop created (${show(shopCreate)})`);
    const shopId = shopCreate.body.shop.id;

    // Create an offer in the enterprise shop
    const shopOffer = await signedFetch('POST', `/api/treasury/${enterprise}/offer`, {
        category: 'food', title: 'Carton of eggs', description: 'Fresh in shop', credits: 7, shopId,
    }, keeper);
    assert(shopOffer.status === 200, `created Offer in enterprise shop (${show(shopOffer)})`);
    const shopOfferId = shopOffer.body.post.id;
    assert(rowOf(shopOfferId)?.shop_id === shopId, 'post is linked to enterprise shop');

    // Pause the shop (closes the shop for now)
    const pauseShop = await signedFetch('PUT', `/api/treasury/${enterprise}/shop`, { paused: true }, keeper);
    assert(pauseShop.status === 200, `shop paused for now (${show(pauseShop)})`);
    assert(rowOf(shopOfferId)?.status === 'paused', 'shop pause paused the post');
    const held = JSON.parse(shopRowOf(shopId)?.paused_posts ?? '[]');
    assert(held.includes(shopOfferId), `shop holds post in paused_posts (${JSON.stringify(held)})`);

    // Resuming while shop is closed is refused with 409 shop_paused
    const resumeWhileShopClosed = await signedFetch('POST', '/api/marketplace/posts/resume', {
        postId: shopOfferId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(resumeWhileShopClosed.status === 409 && resumeWhileShopClosed.body?.code === 'shop_paused',
        `cannot resume post while shop is closed (${show(resumeWhileShopClosed)})`);

    // Keeper explicitly pauses the already-paused post: shop bookkeeping forgets it from paused_posts
    const keeperExplicitPause = await signedFetch('POST', '/api/marketplace/posts/pause', {
        postId: shopOfferId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(keeperExplicitPause.status === 200 && keeperExplicitPause.body?.success === true,
        `keeper pauses already-paused shop post (${show(keeperExplicitPause)})`);
    const heldAfter = JSON.parse(shopRowOf(shopId)?.paused_posts ?? '[]');
    assert(!heldAfter.includes(shopOfferId), `post is forgotten from shop's paused_posts (${JSON.stringify(heldAfter)})`);

    // Reopen shop: post stays paused because keeper paused it
    const reopenShop = await signedFetch('PUT', `/api/treasury/${enterprise}/shop`, { paused: false }, keeper);
    assert(reopenShop.status === 200, `shop reopened (${show(reopenShop)})`);
    assert(rowOf(shopOfferId)?.status === 'paused', 'post stays paused after shop reopened');

    // Keeper can now resume the post
    const keeperResumeShopOffer = await signedFetch('POST', '/api/marketplace/posts/resume', {
        postId: shopOfferId, authorPublicKey: keeper.pubKeyHex,
    }, keeper);
    assert(keeperResumeShopOffer.status === 200, `keeper resumes post after shop reopened (${show(keeperResumeShopOffer)})`);
    assert(rowOf(shopOfferId)?.status === 'active', 'post is now active');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log("⭐️ A keeper pausing and resuming their enterprise's Offer or Need over HTTP PASSED.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
