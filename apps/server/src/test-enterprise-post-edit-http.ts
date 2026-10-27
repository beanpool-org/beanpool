/**
 * A keeper editing their enterprise's Offer or Need, over REAL HTTP — through the signature middleware, not the router
 * alone (Damo, 26 Oct: "Error — Post not found or not owned by you" on his enterprise's Offer, a photo added or not).
 *
 * The phone and the web sign an edit with the member's OWN key and name it as `authorPublicKey`: the middleware refuses
 * the enterprise's key in a body (test-enterprise-event-http §5), and members' phones already send the request this way,
 * so the node has to take it as it is. Only events had a keeper path (isEventHost); an Offer or a Need answered 404.
 *
 * Verifies:
 *  1. A keeper's Offer, made through POST /api/treasury/:t/offer WITH a photo, keeps it, and the photo's bytes are
 *     charged to the keeper who sent them, never the enterprise (as its logo is, test-enterprise-shopfront).
 *  2. A phone-shaped edit (every field the phone sends, the member's key) changes the title: 200, and the row is still
 *     the enterprise's, made by the same keeper.
 *  3. The same edit adding a photo: 200, the photo is served, and its bytes are the keeper's; the photo already there
 *     comes back as its own URL and is not stored or charged again.
 *  4. A Need the same.
 *  5. Refused as today: a member who keeps nothing (404, the same words), a keeper of ANOTHER enterprise (404), a muted
 *     keeper (403 moderation_muted), a keeper of a closed enterprise (403); a group's or a direct post the enterprise
 *     wrote stays its author's alone (404). Nothing changes on any of them.
 *  6. The web's edit (the web sends `photos` as a list every time) works the same.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-post-edit-http.ts
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
import { getMemberPhotoUsageForTests } from './engine/photo-upload-budget.js';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
// Two different JPEGs (the magic bytes the node checks, and a different tail), so the second is a new photo.
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const PHOTO_2 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

// Every assertion runs and failures are reported together, so one broken finding does not hide the others.
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
async function signedFetch(method: 'POST' | 'GET', path: string, body: unknown, id: Id | null) {
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

const rowOf = (id: string) => db.prepare('SELECT title, description, author_pubkey, created_by, type FROM posts WHERE id = ?').get(id) as
    { title: string; description: string; author_pubkey: string; created_by: string | null; type: string } | undefined;
const photoCountOf = (id: string) => (db.prepare('SELECT COUNT(*) c FROM post_photos WHERE post_id = ?').get(id) as { c: number }).c;
const bytesOf = (pk: string) => getMemberPhotoUsageForTests(pk).usedBytes;
const show = (r: { status: number; error?: string; body?: any }) => `${r.status} ${r.error ?? ''}${r.body?.code ? ` [${r.body.code}]` : ''}`;

/** The phone's edit (apps/native/utils/db.ts updatePost): every field, the member's own key, photos only when it has some. */
const phoneEdit = (id: string, keeper: Id, fields: { title: string; photos?: string[]; type?: string; category?: string; credits?: number; description?: string }) => ({
    id,
    authorPublicKey: keeper.pubKeyHex,
    type: fields.type ?? 'offer',
    category: fields.category ?? 'food',
    title: fields.title,
    description: fields.description ?? 'Laid this week',
    credits: fields.credits ?? 6,
    priceType: 'fixed',
    repeatable: true,
    photos: fields.photos,
});

async function main(): Promise<void> {
    console.log("\nA keeper editing their enterprise's Offer or Need, over real HTTP\n");
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

    // ── 1. The enterprise's Offer, with a photo, as the composer sends it ────────────────────────
    console.log('── 1. An Offer posted with a photo ──');
    const keeperBytes0 = bytesOf(keeper.pubKeyHex);
    const enterpriseBytes0 = bytesOf(enterprise);
    const offer = await signedFetch('POST', `/api/treasury/${enterprise}/offer`, {
        category: 'food', title: 'Dozen eggs', description: 'Laid this week', credits: 6, priceType: 'fixed', repeatable: true, photos: [PHOTO],
    }, keeper);
    assert(offer.status === 200 && offer.body?.success === true, `a keeper posts the enterprise's Offer with a photo (${show(offer)})`);
    const offerId: string = offer.body?.post?.id;
    assert(!!offerId && photoCountOf(offerId) === 1, '...and it keeps the photo');
    assert(bytesOf(keeper.pubKeyHex) > keeperBytes0 && bytesOf(enterprise) === enterpriseBytes0,
        `...whose bytes are charged to the keeper who sent it, not the enterprise (keeper +${bytesOf(keeper.pubKeyHex) - keeperBytes0}, enterprise +${bytesOf(enterprise) - enterpriseBytes0})`);

    // ── 2. A title-only edit, the phone's way ────────────────────────────────────────────────────
    console.log('\n── 2. Editing the title, signed as the keeper ──');
    const ownPhotoUrl: string | undefined = offer.body?.post?.photos?.[0];
    const titled = await signedFetch('POST', '/api/marketplace/posts/update', phoneEdit(offerId, keeper, { title: 'Dozen free-range eggs', photos: ownPhotoUrl ? [ownPhotoUrl] : undefined }), keeper);
    assert(titled.status === 200 && titled.body?.success === true, `a keeper's edit of the enterprise's Offer is accepted (${show(titled)})`);
    const afterTitle = rowOf(offerId);
    assert(afterTitle?.title === 'Dozen free-range eggs', '...the title is changed');
    assert(afterTitle?.author_pubkey === enterprise && afterTitle?.created_by === keeper.pubKeyHex, "...and the Offer is still the enterprise's, made by the same keeper");
    assert(titled.body?.post?.authorPublicKey === enterprise && titled.body?.post?.title === 'Dozen free-range eggs', '...and the answer is the saved Offer, the enterprise its author');
    assert(photoCountOf(offerId) === 1, '...its photo sent back as its own URL is kept');

    // ── 3. Adding a photo while editing ─────────────────────────────────────────────────────────
    console.log('\n── 3. Adding a photo ──');
    const keeperBytes1 = bytesOf(keeper.pubKeyHex);
    const enterpriseBytes1 = bytesOf(enterprise);
    const photoed = await signedFetch('POST', '/api/marketplace/posts/update',
        phoneEdit(offerId, keeper, { title: 'Dozen free-range eggs', photos: [ownPhotoUrl ?? PHOTO, PHOTO_2] }), keeper);
    assert(photoed.status === 200 && photoed.body?.success === true, `a keeper adds a photo to the enterprise's Offer (${show(photoed)})`);
    assert(photoCountOf(offerId) === 2, '...and the Offer holds both photos');
    const servedUrl: string | undefined = photoed.body?.post?.photos?.[1];
    const served = servedUrl ? await fetch(servedUrl.startsWith('http') ? servedUrl : `${BASE}${servedUrl}`) : null;
    assert(!!served && served.status === 200 && /^image\//.test(served.headers.get('content-type') ?? ''),
        `...the new photo is served (${served?.status} ${served?.headers.get('content-type') ?? ''})`);
    assert(bytesOf(keeper.pubKeyHex) > keeperBytes1 && bytesOf(enterprise) === enterpriseBytes1,
        `...charged to the keeper, not the enterprise (keeper +${bytesOf(keeper.pubKeyHex) - keeperBytes1}, enterprise +${bytesOf(enterprise) - enterpriseBytes1})`);
    assert(rowOf(offerId)?.author_pubkey === enterprise, "...and it is still the enterprise's Offer");

    // ── 4. A Need ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. A Need ──');
    const need = await signedFetch('POST', `/api/treasury/${enterprise}/need`, {
        category: 'food', title: 'Tend the flock', description: 'Saturday mornings', credits: 10, priceType: 'fixed', photos: [PHOTO],
    }, keeper);
    assert(need.status === 200 && need.body?.success === true, `a keeper posts the enterprise's Need (${show(need)})`);
    const needId: string = need.body?.post?.id;
    const needEdit = await signedFetch('POST', '/api/marketplace/posts/update',
        phoneEdit(needId, keeper, { type: 'need', title: 'Tend the flock (and the garden)', credits: 10, description: 'Saturday mornings', photos: [PHOTO] }), keeper);
    assert(needEdit.status === 200 && needEdit.body?.success === true, `a keeper edits the enterprise's Need and adds a photo (${show(needEdit)})`);
    const needRow = rowOf(needId);
    assert(needRow?.title === 'Tend the flock (and the garden)' && needRow?.author_pubkey === enterprise && needRow?.type === 'need' && photoCountOf(needId) === 1,
        "...the Need is changed, still the enterprise's, with its photo");

    // ── 5. Refused as today ─────────────────────────────────────────────────────────────────────
    console.log('\n── 5. Everyone else, as today ──');
    const before = rowOf(offerId)?.title;
    const strangerEdit = await signedFetch('POST', '/api/marketplace/posts/update', phoneEdit(offerId, stranger, { title: 'Hijacked' }), stranger);
    assert(strangerEdit.status === 404 && strangerEdit.error === 'Post not found or not owned by you',
        `a member who keeps nothing is answered as before (${show(strangerEdit)})`);
    const otherEdit = await signedFetch('POST', '/api/marketplace/posts/update', phoneEdit(offerId, otherKeeper, { title: 'Hijacked' }), otherKeeper);
    assert(otherEdit.status === 404 && otherEdit.error === 'Post not found or not owned by you',
        `a keeper of another enterprise is answered the same (${show(otherEdit)})`);
    const spoofed = await signedFetch('POST', '/api/marketplace/posts/update', { ...phoneEdit(offerId, stranger, { title: 'Hijacked' }), authorPublicKey: enterprise }, stranger);
    assert(spoofed.status === 403, `naming the enterprise in the body is still refused by the middleware (${show(spoofed)})`);

    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + 86_400_000).toISOString(), keeper.pubKeyHex);
    const muted = await signedFetch('POST', '/api/marketplace/posts/update', phoneEdit(offerId, keeper, { title: 'Muted words' }), keeper);
    assert(muted.status === 403 && muted.body?.code === 'moderation_muted', `a muted keeper is refused (${show(muted)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(keeper.pubKeyHex);

    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + 86_400_000).toISOString(), enterprise);
    const mutedEnterprise = await signedFetch('POST', '/api/marketplace/posts/update', phoneEdit(offerId, keeper, { title: 'Muted words' }), keeper);
    assert(mutedEnterprise.status === 403 && mutedEnterprise.body?.code === 'moderation_muted', `nobody edits for a muted enterprise (${show(mutedEnterprise)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(enterprise);

    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(enterprise);
    const closed = await signedFetch('POST', '/api/marketplace/posts/update', phoneEdit(offerId, keeper, { title: 'Closed words' }), keeper);
    assert(closed.status === 403 && closed.error === 'This enterprise has been closed, so it can no longer be modified.',
        `a closed enterprise's Offer takes no edit, as it takes no new one (${show(closed)})`);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(enterprise);

    // A group's or a direct post keeps today's rule (only its author edits it), whoever wrote it.
    db.prepare("UPDATE posts SET audience_scope = 'direct', target_pubkey = ? WHERE id = ?").run(stranger.pubKeyHex, needId);
    const direct = await signedFetch('POST', '/api/marketplace/posts/update', phoneEdit(needId, keeper, { type: 'need', title: 'Direct words', credits: 10 }), keeper);
    assert(direct.status === 404, `a direct post the enterprise wrote is not widened to its keepers (${show(direct)})`);
    db.prepare("UPDATE posts SET audience_scope = 'public', target_pubkey = NULL WHERE id = ?").run(needId);

    assert(rowOf(offerId)?.title === before && rowOf(needId)?.title === 'Tend the flock (and the garden)', 'no refused edit changed anything');

    // ── 6. An edit cannot remove the last photo ──────────────────────────────────────────────────
    console.log("\n── 6. An edit cannot remove the last photo ──");
    const web = await signedFetch('POST', '/api/marketplace/posts/update', {
        id: offerId, authorPublicKey: keeper.pubKeyHex, type: 'offer', category: 'food', title: 'Eggs, by the dozen',
        description: 'Laid this week', credits: 6, priceType: 'fixed', repeatable: true, photos: [],
    }, keeper);
    assert(web.status === 400 && web.error === 'Add a photo first',
        `an edit taking a post with photos down to zero is refused 400 (${show(web)})`);
    const kept = await signedFetch('POST', '/api/marketplace/posts/update', {
        id: offerId, authorPublicKey: keeper.pubKeyHex, type: 'offer', category: 'food', title: 'Eggs, by the dozen',
        description: 'Laid this week', credits: 6, priceType: 'fixed', repeatable: true, photos: [PHOTO],
    }, keeper);
    assert(kept.status === 200 && rowOf(offerId)?.title === 'Eggs, by the dozen' && photoCountOf(offerId) === 1,
        `an edit keeping at least one photo saves (${show(kept)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log("⭐️ A keeper editing their enterprise's Offer or Need over HTTP PASSED.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
