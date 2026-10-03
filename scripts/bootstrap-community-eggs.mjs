// Seed the "Community Eggs" treasury on a node AND post its recurring dozen-eggs offer.
// Idempotent — safe to re-run: reuses an existing treasury, and only posts the offer if none is live.
//
//   NODE_URL=https://test.beanpool.org BEANPOOL_TOKEN='bp_…' \
//     node scripts/bootstrap-community-eggs.mjs
//
// BEANPOOL_TOKEN is an owner's automation token with the ADMIN scope (Settings → Automation tokens, made by an owner
// signed in with their key), read from the environment only, never an argument: arguments show in `ps`.
// ADMIN_PASSWORD (the node's admin password) still works in its place, as before; with a token it is never sent.
//
// Creates a community treasury (a real member account — the Commons' trading face) with a 200-Bean
// credit line so it can run at a deficit. Mints no beans. The offer step needs the admin-offer route
// (POST /api/local/admin/treasury/:id/offer) deployed — if the node predates it you'll get a clear 404.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // tolerate a direct self-signed node; harmless via Cloudflare

const NODE_URL = (process.env.NODE_URL || 'https://test.beanpool.org').replace(/\/$/, '');
const BEANPOOL_TOKEN = process.env.BEANPOOL_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!BEANPOOL_TOKEN && !ADMIN_PASSWORD) { console.error('✗ Set BEANPOOL_TOKEN (an owner\'s automation token, admin scope) or, as before, ADMIN_PASSWORD.'); process.exit(1); }
if (BEANPOOL_TOKEN && !BEANPOOL_TOKEN.startsWith('bp_')) { console.error('✗ BEANPOOL_TOKEN is not an automation token (bp_…): make one in Settings → Automation tokens.'); process.exit(1); }
// The token alone, or the password alone: never both.
const auth = BEANPOOL_TOKEN ? { authorization: `Bearer ${BEANPOOL_TOKEN}` } : { 'x-admin-password': ADMIN_PASSWORD };
const admin = { 'content-type': 'application/json', ...auth };

// A bundled avatar, not an SVG data URL: /api/avatar/:pubkey serves raster images only, and the node
// now refuses any `data:` avatar that is not a base64 JPEG/PNG/WebP/GIF.
const avatar = 'bundled://sunflower';

// 1. Find or create the treasury.
// The admin list (the same answer as /api/treasuries, which is members-only now): an unsigned ask of that one is refused,
// and an empty list made this create a second "Community Eggs" on every run.
// Only an OK answer says whether one exists: a rate limit, a restart or a refused credential is not "none yet", and
// reading it as that made a second one.
const listRes = await fetch(`${NODE_URL}/api/local/admin/treasury`, { headers: auth }).catch((e) => {
    console.error(`✗ Could not reach ${NODE_URL} to list the treasuries: ${e?.cause?.code || e?.message || e}. Nothing was created.`);
    process.exit(1);
});
const list = await listRes.json().catch(() => null);
if (!listRes.ok || !Array.isArray(list?.treasuries)) {
    console.error(`✗ Listing the treasuries failed (HTTP ${listRes.status}): ${list?.error || listRes.statusText || 'no list in the answer'}. Nothing was created; run it again once the node answers.`);
    process.exit(1);
}
let eggs = list.treasuries.find(t => t.name === 'Community Eggs');
if (!eggs) {
    const res = await fetch(`${NODE_URL}/api/local/admin/treasury`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Community Eggs', avatar, creditLine: 200 }) });
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
} else {
    const res = await fetch(`${NODE_URL}/api/local/admin/treasury/${eggs.publicKey}/offer`, {
        method: 'POST', headers: admin,
        body: JSON.stringify({ category: 'food', title: 'Dozen free-range eggs', description: 'Fresh daily from the community flock — pays for the feed.', credits: 12, priceType: 'fixed', repeatable: true }),
    });
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
