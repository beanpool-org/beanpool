// Seed the "Community Eggs" treasury on a node AND post its recurring dozen-eggs offer.
// Idempotent — safe to re-run: reuses an existing treasury, and only posts the offer if none is live.
//
//   NODE_URL=https://test.beanpool.org BEANPOOL_TOKEN='bp_…' EGGS_PHOTO=./eggs.jpg \
//     node scripts/bootstrap-community-eggs.mjs
//
// EGGS_PHOTO is a photo of the eggs (a JPEG, PNG or WebP file), sent with the Offer: the node refuses a new Offer with no
// photo, this admin route included, because every listing in the Market has one. The script does not resize it, so give
// it one no larger than 800 px on its longest side (BeanPool keeps no bigger copy). Without it the treasury is still
// made, and the script stops at the Offer and says so; run it again with EGGS_PHOTO set and it reuses the treasury.
//
// BEANPOOL_TOKEN is an owner's automation token with the ADMIN scope (Settings → Automation tokens, made by an owner
// signed in with their key), read from the environment only, never an argument: arguments show in `ps`.
// ADMIN_PASSWORD (the node's admin password) still works in its place, as before; with a token it is never sent.
//
// Creates a community treasury (a real member account — the Commons' trading face) with a 200-Bean
// credit line so it can run at a deficit. Mints no beans. The offer step needs the admin-offer route
// (POST /api/local/admin/treasury/:id/offer) deployed — if the node predates it you'll get a clear 404.

import { readFileSync } from 'node:fs';
import { automationTokenProblem, headerValueProblem, fetchNoRedirect } from './automation-token.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // tolerate a direct self-signed node; harmless via Cloudflare

const NODE_URL = (process.env.NODE_URL || 'https://test.beanpool.org').replace(/\/$/, '');
const BEANPOOL_TOKEN = process.env.BEANPOOL_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!BEANPOOL_TOKEN && !ADMIN_PASSWORD) { console.error('✗ Set BEANPOOL_TOKEN (an owner\'s automation token, admin scope) or, as before, ADMIN_PASSWORD.'); process.exit(1); }
// Checked whole before any request, and never repeated: see automation-token.mjs.
const credentialProblem = BEANPOOL_TOKEN ? automationTokenProblem('BEANPOOL_TOKEN', BEANPOOL_TOKEN) : headerValueProblem('ADMIN_PASSWORD', ADMIN_PASSWORD);
if (credentialProblem) { console.error(`✗ ${credentialProblem}`); process.exit(1); }
// The token alone, or the password alone: never both.
const auth = BEANPOOL_TOKEN ? { authorization: `Bearer ${BEANPOOL_TOKEN}` } : { 'x-admin-password': ADMIN_PASSWORD };
const admin = { 'content-type': 'application/json', ...auth };

// The Offer's photo, read and checked before any request: a path that cannot be read, or a file that is not a JPEG, PNG
// or WebP picture, stops the script with nothing sent. The node checks the rest (its pixel limit) and answers in words.
const PHOTO_TYPES = [
    ['jpeg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
    ['png', (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
    ['webp', (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
];
let offerPhoto = null;
if (process.env.EGGS_PHOTO) {
    let bytes;
    try { bytes = readFileSync(process.env.EGGS_PHOTO); } catch (e) {
        console.error(`✗ Could not read EGGS_PHOTO (${process.env.EGGS_PHOTO}): ${e?.code || e?.message || e}. Nothing was sent.`);
        process.exit(1);
    }
    const type = PHOTO_TYPES.find(([, is]) => is(bytes))?.[0];
    if (!type) { console.error(`✗ EGGS_PHOTO (${process.env.EGGS_PHOTO}) is not a JPEG, PNG or WebP picture. Nothing was sent.`); process.exit(1); }
    offerPhoto = `data:image/${type};base64,${bytes.toString('base64')}`;
}

// A bundled avatar, not an SVG data URL: /api/avatar/:pubkey serves raster images only, and the node
// now refuses any `data:` avatar that is not a base64 JPEG/PNG/WebP/GIF.
const avatar = 'bundled://sunflower';

// Every request carries the credential, so none follows a redirect (automation-token.mjs): a redirect, or no answer at
// all, stops the script with a plain message.
const toNode = (route, init, doing, after = '') => fetchNoRedirect(`${NODE_URL}${route}`, init).catch((e) => {
    console.error(e?.redirect ? `✗ ${e.message}` : `✗ Could not reach ${NODE_URL} to ${doing}: ${e?.cause?.code || e?.message || e}.${after}`);
    process.exit(1);
});

// 1. Find or create the treasury.
// The admin list (the same answer as /api/treasuries, which is members-only now): an unsigned ask of that one is refused,
// and an empty list made this create a second "Community Eggs" on every run.
// Only an OK answer says whether one exists: a rate limit, a restart or a refused credential is not "none yet", and
// reading it as that made a second one.
const listRes = await toNode('/api/local/admin/treasury', { headers: auth }, 'list the treasuries', ' Nothing was created.');
const list = await listRes.json().catch(() => null);
if (!listRes.ok || !Array.isArray(list?.treasuries)) {
    console.error(`✗ Listing the treasuries failed (HTTP ${listRes.status}): ${list?.error || listRes.statusText || 'no list in the answer'}. Nothing was created; run it again once the node answers.`);
    process.exit(1);
}
let eggs = list.treasuries.find(t => t.name === 'Community Eggs');
if (!eggs) {
    const res = await toNode('/api/local/admin/treasury', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Community Eggs', avatar, creditLine: 200 }) }, 'create the treasury');
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.success) { console.error(`✗ create failed (HTTP ${res.status}):`, d.error || d); process.exit(1); }
    eggs = { publicKey: d.publicKey, liveOffers: 0 };
    console.log(`✅ Created "Community Eggs": ${d.publicKey}`);
} else {
    console.log(`ℹ️  "Community Eggs" already exists: ${eggs.publicKey}  (${eggs.liveOffers} live offer(s))`);
}

// 2. Post the recurring dozen-eggs offer, if none is live yet.
if ((eggs.liveOffers ?? 0) > 0) {
    console.log('   Already has a live offer — nothing to post. Done. 🥚');
} else if (!offerPhoto) {
    console.error('✗ The eggs Offer was not posted: every Offer in the Market needs a photo. Set EGGS_PHOTO to a JPEG, PNG or WebP of the eggs and run this again; it reuses "Community Eggs".');
    process.exit(1);
} else {
    const res = await toNode(`/api/local/admin/treasury/${eggs.publicKey}/offer`, {
        method: 'POST', headers: admin,
        body: JSON.stringify({ category: 'food', title: 'Dozen free-range eggs', description: 'Fresh daily from the community flock — pays for the feed.', credits: 12, priceType: 'fixed', repeatable: true, photos: [offerPhoto] }),
    }, 'post the offer');
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.success) {
        console.log(`✅ Posted recurring offer: "Dozen free-range eggs" @ 12 Beans`);
        console.log(`\n   → Community Eggs now shows "1 live offer".`);
        console.log(`   → The offer is live in the Market tab — a member can accept it and buy a dozen; watch the balance climb.`);
    } else if (res.status === 404) {
        console.error(`✗ Offer route not found (404). Redeploy the node with the new admin-offer route first, then re-run this.`);
    } else {
        console.error(`✗ Offer failed (HTTP ${res.status}):`, d.error || d);
    }
}
