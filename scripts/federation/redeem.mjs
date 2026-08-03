/**
 * #143 step 5 live verification — a real redemption between gippsland and eastgippy.
 *
 * THE THING BEING PROVEN: a bridge tab comes DOWN. §3 calls "Half A without Half B is a number that only
 * grows" the most important sentence in the document, and every run so far has only ever pushed a tab up or
 * netted it by accident of reciprocal trade. This drives it down deliberately, from the Commons pot, inside a
 * ceiling of ZERO — which is the claim I most want to see on real hardware, because a ceiling of 0 permitting
 * redemption is what stops every new link being a ratchet.
 *
 * WHY THE SETUP IS AS LONG AS IT IS. Both Commons pots hold exactly 0.075 — one fee each — so a commission of
 * any meaningful size refuses `commons_short`. And the fee from a CROSS-NODE purchase goes to the BUYER's
 * Commons, so the trade that puts gippsland in credit fills eastgippy's pot, not gippsland's. The only honest
 * way to fill gippsland's is gippsland members paying fees locally. So:
 *
 *   phase 1  a local gippsland trade, to put real beans in gippsland's Commons via its fee
 *   phase 2  eastgippy BUYS from gippsland  →  gippsland is owed, its bridge goes NEGATIVE
 *   phase 3  a cheap travelling offer on eastgippy, and one pull cycle
 *   phase 4  gippsland's keeper commissions it  →  the bridge moves back toward zero
 *
 * Run phases individually: `node redeem.mjs 1`, or `node redeem.mjs all`.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { NODES, plain, signed, admin, newIdentity, postOffer, setAvatar, loadState, saveState } from './fed.mjs';

/**
 * A member who is definitely NOT one we already have.
 *
 * `seedElder()` short-circuits on `state[node].identity` and returns the stored identity — so
 * `seedElder('gippsland', 'FedLocal')` handed back FedBuyer, and phase 1 tried to buy FedBuyer's own offer.
 * `acceptPost` refuses that outright ("Cannot accept your own post"), so phase 1 could never have worked as
 * first written. This mints unconditionally and stores under its own key.
 */
async function makeFreshMember(node, callsign, stateKey) {
    const state = loadState();
    if (state[stateKey]) {
        console.log(`  reusing ${state[stateKey].callsign} (${state[stateKey].publicKey.slice(0, 12)}…)`);
        return state[stateKey];
    }
    const invite = await admin(node, '/api/admin/seed-invite', { type: 'elder' });
    if (invite.status !== 200 || !invite.json?.code) {
        throw new Error(`${node}: seed-invite failed ${invite.status} ${JSON.stringify(invite.json)}`);
    }
    const identity = newIdentity(callsign);
    const redeemed = await plain(node, 'POST', '/api/invite/redeem', {
        code: invite.json.code, publicKey: identity.publicKey, callsign,
    });
    if (redeemed.status !== 200) {
        throw new Error(`${node}: redeem failed ${redeemed.status} ${JSON.stringify(redeemed.json)}`);
    }
    console.log(`  minted ${callsign} (${identity.publicKey.slice(0, 12)}…) on ${node}`);
    state[stateKey] = identity;
    saveState(state);
    return identity;
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const phase = process.argv[2] ?? 'report';
const state = loadState();

const money = (n) => (n === undefined || n === null ? '—' : Number(n).toFixed(4));

/** Everything that matters, from both nodes, in one block. */
async function report(label) {
    console.log(`\n════ ${label} ════`);
    for (const node of ['gippsland', 'eastgippy']) {
        const links = await plain(node, 'GET', '/api/treasuries');
        const lk = (links.json?.treasuries ?? []).find(t => t.link);
        const info = await plain(node, 'GET', '/api/community/info');
        console.log(`  ${node.padEnd(10)} commons=${money(info.json?.commonsBalance)}`
            + `  tab=${money(lk?.link?.energyBalance)}`
            + `  allowance=${money(lk?.link?.commissionAllowance)}`
            + `  ceiling=${money(lk?.link?.commissionCeiling)}`
            + `  linkTreasury=${money(lk?.balance)}`);
    }
}

// ── Phase 1: put real beans in gippsland's Commons, the only way there is — a local fee. ────────────────
async function phase1() {
    console.log('── Phase 1: a local gippsland trade, so its Commons has something to commission with ──');
    const local = await makeFreshMember('gippsland', 'FedLocal', 'gippslandLocal');
    if (!local.offerId) {
        await setAvatar('gippsland', local);
        const offer = await postOffer('gippsland', local, 'Fence posts, split and delivered', 100);
        local.offerId = offer.id;
        const s = loadState();
        s.gippslandLocal = local;
        saveState(s);
    }
    const buyer = state.gippsland.identity;
    // The ordinary local accept — 1.5% of 100 lands in gippsland's Commons.
    const acc = await signed('gippsland', buyer, 'POST', '/api/marketplace/posts/accept', {
        postId: local.offerId, buyerPublicKey: buyer.publicKey,
    });
    console.log(`  accept 100-bean local offer → ${acc.status} ${acc.status !== 200 ? JSON.stringify(acc.json) : ''}`);
    if (acc.status !== 200) return;
    const txId = acc.json.transaction.id;
    // Both sides confirm, which is what actually moves the beans and charges the fee.
    const c1 = await signed('gippsland', buyer, 'POST', '/api/marketplace/transactions/complete', {
        transactionId: txId, confirmerPublicKey: buyer.publicKey,
    });
    const c2 = await signed('gippsland', local, 'POST', '/api/marketplace/transactions/complete', {
        transactionId: txId, confirmerPublicKey: local.publicKey,
    });
    console.log(`  complete (buyer) → ${c1.status}   complete (seller) → ${c2.status}`);
}

// ── Phase 2: eastgippy buys from gippsland, so gippsland is OWED. ───────────────────────────────────────
async function phase2() {
    console.log('── Phase 2: eastgippy buys gippsland work → gippsland bridge goes NEGATIVE (they owe us) ──');
    const theirBuyer = state.eastgippy.identity;      // an eastgippy member, spending eastgippy beans
    const ourSeller = state.gippsland.identity;       // a gippsland member, doing the work
    // The peer resolved from eastgippy's OWN connector list rather than constructed here — the route looks the
    // connector up by address or public URL, so a hand-built multiaddr that differs by a character 404s.
    const conns = await plain('eastgippy', 'GET', '/api/local/connectors');
    const gipps = (conns.json?.connectors ?? conns.json ?? [])
        .find(c => c.address?.includes(NODES.gippsland.containerIp));
    if (!gipps) { console.log('  eastgippy has no connector pointing at gippsland — stop'); return; }
    console.log(`  via connector ${gipps.address}`);

    const r = await signed('eastgippy', theirBuyer, 'POST', '/api/federation/purchase', {
        peerAddress: gipps.address,
        sellerPublicKey: ourSeller.publicKey,
        amount: 20,
        key: `xn-redeem-setup-${state.attempt ?? 1}`,
    });
    console.log(`  cross-node purchase (20 beans) → ${r.status} ${JSON.stringify(r.json).slice(0, 240)}`);
}

// ── Phase 3: something cheap for the keeper to commission. ───────────────────────────────────────────────
async function phase3() {
    console.log('── Phase 3: a cheap travelling offer on eastgippy, priced inside gippsland\'s Commons ──');
    const seller = state.eastgippy.identity;
    if (!state.commissionOfferId) {
        const p = await postOffer('eastgippy', seller, 'A song at the Gippsland harvest supper', 1,
            { reach: 'everywhere' });
        state.commissionOfferId = p.id;
        saveState(state);
    }
    console.log(`  offer ${state.commissionOfferId} — wait one pull cycle (≤5 min) before phase 4`);
}

// ── Phase 4: THE REDEMPTION. ────────────────────────────────────────────────────────────────────────────
async function phase4() {
    console.log('── Phase 4: gippsland\'s keeper commissions it, from the Commons, at ceiling 0 ──');
    const keeper = state.gippsland.identity;

    // The link's treasury, and the keeper binding (#106) that authorises acting for it.
    const t = await plain('gippsland', 'GET', '/api/treasuries');
    const link = (t.json?.treasuries ?? []).find(x => x.link);
    if (!link) { console.log('  NO LINK on gippsland — stop'); return; }
    console.log(`  link: "${link.name}" treasury=${link.publicKey.slice(0, 10)}… keepers=${JSON.stringify(link.keepers)}`);

    if (!(link.keepers ?? []).some(k => (k.publicKey ?? k) === keeper.publicKey)) {
        const a = await plain('gippsland', 'POST', `/api/local/admin/treasury/${link.publicKey}/operators`,
            { password: ADMIN_PASSWORD, pubkey: keeper.publicKey });
        console.log(`  assign keeper → ${a.status} ${JSON.stringify(a.json).slice(0, 160)}`);
    }

    // The cached copy of the eastgippy listing, on gippsland's own board.
    const posts = await plain('gippsland', 'GET', '/api/marketplace/posts');
    const arr = Array.isArray(posts.json) ? posts.json : (posts.json?.posts ?? []);
    const target = arr.find(p => String(p.id).includes(state.commissionOfferId ?? ' '));
    if (!target) {
        console.log('  the travelling offer has NOT been pulled yet — wait for the next tick');
        console.log('  cached remote listings currently on the board:',
            arr.filter(p => p.originNode).map(p => `${p.title} (${p.credits})`));
        return;
    }
    console.log(`  target: ${target.id.slice(0, 34)}… "${target.title}" ${target.credits} 🫘 from ${target.originNode}`);

    const cap = await signed('gippsland', keeper, 'GET', '/api/federation/commission/capacity', undefined);
    console.log(`  capacity → ${cap.status} ${JSON.stringify(cap.json).slice(0, 300)}`);

    const r = await signed('gippsland', keeper, 'POST', '/api/federation/commission', { postId: target.id });
    console.log(`\n  ►► COMMISSION → ${r.status} ${JSON.stringify(r.json).slice(0, 400)}\n`);
}

const phases = { 1: phase1, 2: phase2, 3: phase3, 4: phase4 };

if (phase === 'report') {
    await report('CURRENT STATE');
} else if (phase === 'all') {
    await report('BEFORE');
    for (const p of [1, 2, 3, 4]) { await phases[p](); await report(`after phase ${p}`); }
} else {
    await report('BEFORE');
    await phases[phase]();
    await report(`AFTER phase ${phase}`);
}
