// Seed the "Community Eggs" treasury on a node AND post its recurring dozen-eggs offer.
// Idempotent — safe to re-run: reuses an existing treasury, and only posts the offer if none is live.
//
//   NODE_URL=https://test.beanpool.org ADMIN_PASSWORD='your-admin-password' \
//     node scripts/bootstrap-community-eggs.mjs
//
// Creates a community treasury (a real member account — the Commons' trading face) with a 200-Bean
// credit line so it can run at a deficit. Mints no beans. The offer step needs the admin-offer route
// (POST /api/local/admin/treasury/:id/offer) deployed — if the node predates it you'll get a clear 404.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // tolerate a direct self-signed node; harmless via Cloudflare

const NODE_URL = (process.env.NODE_URL || 'https://test.beanpool.org').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error('✗ Set ADMIN_PASSWORD env var (your node admin password).'); process.exit(1); }
const admin = { 'content-type': 'application/json', 'x-admin-password': ADMIN_PASSWORD };

const avatar = 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="#fbbf24"/><text x="40" y="54" font-size="42" text-anchor="middle">🥚</text></svg>`
);

// 1. Find or create the treasury.
const list = await (await fetch(`${NODE_URL}/api/treasuries`)).json().catch(() => ({}));
let eggs = (list.treasuries || []).find(t => t.name === 'Community Eggs');
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
