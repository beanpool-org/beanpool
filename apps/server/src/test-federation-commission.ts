/**
 * Commissioning across a boundary — Half B (#143, slice step 5).
 *
 * Spec: docs/federation-connector.md §3 (Half B), §7, §8 step 5.
 *
 * WHAT THIS SUITE IS ACTUALLY DEFENDING. The document's own load-bearing sentence is "Half A without Half B
 * is a number that only grows", so the thing under test is that a tab can come DOWN, and that the coming-down
 * is bounded by something real. Three properties, and the second is the one a plausible implementation gets
 * wrong:
 *
 *   1. A keeper may call in credit the community has actually earned, with no ceiling set. Requiring an
 *      operator to type a number before redemption can happen would leave every new link a ratchet — the
 *      exact failure Half B exists to fix.
 *   2. THE CEILING IS CUMULATIVE. `settlementCapacity` bounds only the negative side of a bridge and says so
 *      emphatically, so commissioning — which drives the tab positive — passes it untouched at any size. A
 *      ceiling read per-commission would therefore permit itself over and over: §7 is checked here as a
 *      budget that depletes, because read any other way it is not a safety at all.
 *   3. Nothing is minted. Every refusal and every success is checked against the node total, because the
 *      funding path draws on the Commons pot — which is a GLOBAL whose `COMMONS_POOL` row is only a shadow,
 *      so a naive `SUM(balance)` would miss exactly the mistake worth catching (#124, #126).
 *
 * The route's happy path is NOT exercised here and that is deliberate rather than a gap: past its checks it
 * hands off to `settleCrossNodePurchase`, which needs a live libp2p node. What it hands off is Half A, tested
 * by test-settlement-* and verified between two real nodes. So the arithmetic and the funding are driven
 * directly through `fundCommission`, and the route is tested for the things only it can get wrong —
 * authorisation, resolution, and the ORDER of its checks (§8 below: a request that passes everything and then
 * finds no transport must not have funded anything).
 *
 * RUNS IN BOTH FLAG STATES, and `test-all` runs it twice for that reason. `FEDERATION_SETTLEMENT_ENABLED` is
 * a module const read at import, so one process only ever sees one value. With it OFF the whole suite reduces
 * to the kill switch — which is a distinct line of code in THIS route, not one inherited from the purchase
 * route, and inverting it is the kind of mistake that would otherwise pass every check below.
 *
 * Run with a throwaway data dir:
 *   FEDERATION_SETTLEMENT=true ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) \
 *     pnpm exec tsx src/test-federation-commission.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

import crypto from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { setCommonsBalance } from '@beanpool/core';
import {
    initStateEngine, reconcileLedgerFromDb, getCommonsBalanceExact,
    createTreasury, createPost, adminAssignTreasuryOperator, getAdminPubkey,
} from './state-engine.js';
import { ledger } from './engine/ledger.js';
import { db } from './db/db.js';
import { addConnector, setConnectorCreditCap } from './connector-manager.js';
import { FEDERATION_SETTLEMENT_ENABLED, SETTLEMENT_REFUSED_CODE } from './federation-settlement.js';
import { ensureBridgeAccount, bridgeAccountId } from './federation-bridge.js';
import { ensureFederationLink, setCommissionCeiling, getFederationLink } from './federation-link.js';
import { commissionCapacity, fundCommission, originOfCachedPost } from './federation-commission.js';
import { createFederationCommissionRoutes } from './routes/federation-commission.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const bal = (pk: string): number =>
    r4((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as any)?.balance ?? 0);

/**
 * Every account row except the COMMONS_POOL shadow, plus the live global.
 *
 * The pot is `COMMONS_BALANCE`; the row is rewritten from it after every move. Summing the row instead would
 * double-count or miss the draw depending on flush timing, which is the one thing this must not do.
 */
const nodeTotal = (): number => {
    const s = (db.prepare(`SELECT COALESCE(SUM(balance),0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'`)
        .get() as { s: number }).s;
    return r4(s + getCommonsBalanceExact());
};

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

function makeMember(callsign: string, balance: number, homeNodeUrl?: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit, home_node_url, avatar_url)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 500, ?, ?)`)
        .run(pk, callsign, homeNodeUrl ?? null, TINY_PNG);
    // Epoch at NOW, not 0 — epoch 0 is 1970 and the first read would charge ~56 years of demurrage (#138).
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)`)
        .run(pk, balance, ledger.getCurrentEpoch());
    reconcileLedgerFromDb();
    return pk;
}

/** Move a bridge to a chosen tab. What a settled trade in one direction or the other leaves behind. */
function setTab(peerId: string, balance: number): void {
    ensureBridgeAccount(peerId);
    db.prepare('UPDATE accounts SET balance = ? WHERE public_key = ?').run(balance, bridgeAccountId(peerId));
    reconcileLedgerFromDb();
}

async function main() {
    const flag = FEDERATION_SETTLEMENT_ENABLED;
    console.log(`Running #143 step 5 (Half B — commissioning) checks (settlement flag ${flag ? 'ON' : 'OFF'})...\n`);
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') {
        throw new Error('Run with ENABLE_PEER_CONNECTORS=true — connector reads short-circuit otherwise');
    }
    initStateEngine();

    const peerKey = await generateKeyPair('Ed25519');
    const PEER = peerIdFromPrivateKey(peerKey).toString();
    const PEER_URL = 'https://byron.beanpool.org';
    const PEER_ADDR = `/dns4/byron.beanpool.org/tcp/4001/p2p/${PEER}`;
    addConnector(PEER_ADDR, 'peer', 'byron', PEER_URL);
    setConnectorCreditCap(PEER_ADDR, 500);

    const link = ensureFederationLink(PEER, 'byron', createTreasury)!;
    assert(link !== null && link.commissionCeiling === 0,
        `0a. setup: a link exists for the capped peer, ceiling 0 (got ${link?.commissionCeiling})`);

    // ── 1. THE ALLOWANCE TABLE. Every row of the docstring's table, against the real function. ──────────
    //
    // allowance = ceiling − tab, with the tab SIGNED: positive = we owe them, negative = they owe us.
    const table: Array<[tab: number, ceiling: number, allowance: number, why: string]> = [
        [-480, 0, 480, 'pure redemption — calling in a favour we are owed needs nobody\'s permission'],
        [0, 0, 0, 'square with them and no ceiling → the keeper may do nothing'],
        [0, 500, 500, 'the ceiling is discretion to open a FRESH tab'],
        [500, 500, 0, 'ceiling reached — this is the cumulative bound'],
        [-480, 500, 980, 'redeem the 480, plus 500 of discretion'],
        [750, 500, 0, 'a tab already PAST the ceiling reads as nothing available, never as a negative'],
    ];
    for (const [tab, ceiling, expected, why] of table) {
        setTab(PEER, tab);
        setCommissionCeiling(PEER, ceiling);
        const cap = commissionCapacity(PEER)!;
        assert(cap.allowance === expected,
            `1. tab ${tab}, ceiling ${ceiling} → allowance ${expected} (got ${cap.allowance}) — ${why}`);
    }

    setTab(PEER, -480);
    setCommissionCeiling(PEER, 0);
    const owed = commissionCapacity(PEER)!;
    assert(owed.redeemable === 480 && owed.energyBalance === -480,
        `2a. the two numbers are reported separately (redeemable ${owed.redeemable}, tab ${owed.energyBalance}) — a keeper needs to know how much of their room is credit earned rather than discretion`);
    assert(owed.ceiling === 0 && owed.allowance === 480,
        '2b. and a ceiling of 0 — the default every link is created with — still permits redemption');

    // ── 3. THE FEE IS INSIDE THE ALLOWANCE. ────────────────────────────────────────────────────────────
    //
    // `beginOutboundSettlement` escrows amount + fee. Counting only the amount would let a keeper spend
    // slightly past the ceiling, AND fund short of what the escrow needs — the same off-by-a-fee landing in
    // two places.
    setTab(PEER, 0);
    setCommissionCeiling(PEER, 100);
    setCommonsBalance(1000);
    const atCeiling = fundCommission(PEER, 100);
    assert(atCeiling.ok === false && atCeiling.reason === 'over_allowance',
        `3a. 100 against a ceiling of exactly 100 is REFUSED (${atCeiling.ok ? 'accepted' : (atCeiling as any).reason}) — the 1.5% fee is part of what crosses`);
    const justUnder = fundCommission(PEER, 98);
    assert(justUnder.ok === true && justUnder.total === 99.47,
        `3b. 98 fits, and the total moved is amount + fee = 99.47 (got ${justUnder.ok ? justUnder.total : 'refused'})`);

    // ── 4. FUNDING: the enterprise's own balance first, the Commons for the shortfall only. ─────────────
    //
    // What makes a refused commission self-correcting. If settlement reverses, escrow refunds to the
    // enterprise rather than the Commons; drawing only the shortfall means the next commission consumes that
    // residue instead of needing a sweep nobody would remember to run.
    db.prepare('UPDATE accounts SET balance = 0 WHERE public_key = ?').run(link.treasuryPubkey);
    setCommonsBalance(1000);
    reconcileLedgerFromDb();
    setTab(PEER, 0);
    setCommissionCeiling(PEER, 500);

    const before4 = nodeTotal();
    const fresh = fundCommission(PEER, 100);
    assert(fresh.ok === true && fresh.drawnFromCommons === 101.5,
        `4a. an empty link draws the WHOLE total from the pot (got ${fresh.ok ? fresh.drawnFromCommons : 'refused'})`);
    assert(bal(link.treasuryPubkey) === 101.5 && r4(getCommonsBalanceExact()) === 898.5,
        `4b. and the beans are on the link, not the pot (link ${bal(link.treasuryPubkey)}, pot ${r4(getCommonsBalanceExact())})`);
    assert(nodeTotal() === before4,
        `4c. NOTHING WAS MINTED — the node total is unchanged (${before4} → ${nodeTotal()})`);

    // Now the link already holds beans: a second commission of the same size should draw only the top-up.
    const partial = fundCommission(PEER, 150);
    assert(partial.ok === true && partial.drawnFromCommons === r4(152.25 - 101.5),
        `4d. a link holding 101.5 draws only the 50.75 shortfall for a 152.25 total (got ${partial.ok ? partial.drawnFromCommons : 'refused'}) — the residue from a reversal drains itself`);
    assert(bal(link.treasuryPubkey) === 152.25,
        `4e. leaving exactly the total on the link (got ${bal(link.treasuryPubkey)})`);
    assert(nodeTotal() === before4, '4f. still nothing minted');

    // ── 5. THE CEILING IS CUMULATIVE — the property a per-commission reading gets wrong. ────────────────
    //
    // Each commission moves the tab positive by its amount (that is what settling one does), so it consumes
    // the room it used. Read per-commission, a ceiling of 200 would permit 200 forever.
    db.prepare('UPDATE accounts SET balance = 0 WHERE public_key = ?').run(link.treasuryPubkey);
    setCommonsBalance(10_000);
    reconcileLedgerFromDb();
    setTab(PEER, 0);
    setCommissionCeiling(PEER, 200);

    const first = fundCommission(PEER, 150);
    assert(first.ok === true, '5a. the first 150 against a ceiling of 200 is allowed');
    setTab(PEER, 152.25);   // what settling that commission leaves: the tab moved by amount + fee
    const second = fundCommission(PEER, 150);
    assert(second.ok === false && second.reason === 'over_allowance',
        `5b. THE SECOND 150 IS REFUSED (${second.ok ? 'accepted — the ceiling is not a safety' : (second as any).reason}) — the ceiling is a budget that depletes, not a per-commission formality`);
    const remaining = commissionCapacity(PEER)!;
    assert(remaining.allowance === r4(200 - 152.25),
        `5c. with exactly the unused remainder left (${remaining.allowance})`);
    const fits = fundCommission(PEER, 40);
    assert(fits.ok === true, '5d. and a commission that fits the remainder still goes through');

    // ── 6. THE COMMONS IS NOT PUSHED INTO DEFICIT for one person's discretionary act. ───────────────────
    db.prepare('UPDATE accounts SET balance = 0 WHERE public_key = ?').run(link.treasuryPubkey);
    setCommonsBalance(10);
    reconcileLedgerFromDb();
    setTab(PEER, -1000);
    setCommissionCeiling(PEER, 0);

    const before6 = nodeTotal();
    const short = fundCommission(PEER, 100);
    assert(short.ok === false && short.reason === 'commons_short',
        `6a. a commission well within the allowance still refuses when the pot cannot cover it (${short.ok ? 'accepted' : (short as any).reason})`);
    assert(r4(getCommonsBalanceExact()) === 10 && bal(link.treasuryPubkey) === 0,
        `6b. and NOTHING MOVED (pot ${r4(getCommonsBalanceExact())}, link ${bal(link.treasuryPubkey)}) — no allowDeficit here, unlike a reversal that would otherwise strand a fee`);
    assert(nodeTotal() === before6, '6c. node total unchanged');

    // ── 7. A peer with no link cannot be commissioned from. ────────────────────────────────────────────
    const orphanKey = await generateKeyPair('Ed25519');
    const ORPHAN = peerIdFromPrivateKey(orphanKey).toString();
    const noLink = fundCommission(ORPHAN, 10);
    assert(noLink.ok === false && noLink.reason === 'no_link',
        `7. a peer with no link refuses with no_link (got ${noLink.ok ? 'accepted' : (noLink as any).reason}) — a cap is what creates one`);

    // ══ THE ROUTE ══════════════════════════════════════════════════════════════════════════════════════
    const router = createFederationCommissionRoutes({
        checkAdminAuth: async () => false,
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    });
    const layer = (router as any).stack.find((l: any) =>
        l.path === '/api/federation/commission' && l.methods.includes('POST'));
    if (!layer) throw new Error('The commission route is not mounted — this test is looking at the wrong path');

    const commission = async (actor: string | undefined, body: Record<string, unknown>) => {
        const ctx: any = { state: actor ? { actor } : {}, requestBody: body, status: 200, body: undefined };
        await layer.stack[layer.stack.length - 1](ctx, async () => {});
        return ctx;
    };

    // A remote listing, cached the way the pull writes one: a visitor author and an origin_node.
    const remoteSeller = makeMember('ByronBaker', 0, PEER_URL);
    const remotePost = createPost('offer', 'other', 'A performance in Byron', 'd', 60, 'fixed', remoteSeller)!;
    db.prepare("UPDATE posts SET origin_node = ? WHERE id = ?").run(PEER_URL, remotePost.id);

    const keeper = makeMember('Keeper', 50);
    const bystander = makeMember('Bystander', 50);
    adminAssignTreasuryOperator(link.treasuryPubkey, keeper);

    setCommonsBalance(10_000);
    setTab(PEER, -1000);
    setCommissionCeiling(PEER, 0);
    reconcileLedgerFromDb();

    // ── 8.0 THE KILL SWITCH, when the flag is off. Its own line in this route, and it comes before every
    //        other check — including the 401 — so a node with settlement off never even reveals whether the
    //        caller would have been authorised.
    if (!flag) {
        const beforeK = nodeTotal();
        const off = await commission(keeper, { postId: remotePost.id });
        assert(off.status === 503 && off.body?.code === SETTLEMENT_REFUSED_CODE,
            `K1. with FEDERATION_SETTLEMENT off, a keeper's commission is refused 503 (got ${off.status}/${off.body?.code})`);
        const offUnsigned = await commission(undefined, { postId: remotePost.id });
        assert(offUnsigned.status === 503,
            `K2. and so is an unsigned one — the switch is checked BEFORE the actor, so nothing leaks about authorisation (got ${offUnsigned.status})`);
        assert(nodeTotal() === beforeK && bal(link.treasuryPubkey) === 0,
            `K3. with nothing funded and nothing minted (link ${bal(link.treasuryPubkey)}, total ${beforeK} → ${nodeTotal()})`);
        console.log(`\n${passed}/${run} checks passed (kill-switch state — the rest of the suite needs the flag on).`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ #143 step 5: with settlement off, commissioning is refused before anything else is considered.');
        return;
    }

    const unsigned = await commission(undefined, { postId: remotePost.id });
    assert(unsigned.status === 401,
        `8a. an unsigned request is refused (got ${unsigned.status}) — this spends the community's Commons`);

    const notKeeper = await commission(bystander, { postId: remotePost.id });
    assert(notKeeper.status === 403 && /keeper/i.test(notKeeper.body?.error ?? ''),
        `8b. a member who is not a keeper of THIS link is refused (got ${notKeeper.status}: ${notKeeper.body?.error})`);

    const visitorActor = makeMember('Visiting', 50, 'https://elsewhere.example');
    const visiting = await commission(visitorActor, { postId: remotePost.id });
    assert(visiting.status === 403,
        `8c. a visitor cannot act for one of our enterprises (got ${visiting.status}) — keeping a link is a role in THIS community`);

    // A LOCAL listing is an ordinary purchase, not a commission. Without this a keeper could open a bridge
    // tab against a trade that never left the node — real beans, imaginary obligation.
    const localSeller = makeMember('LocalBaker', 0);
    const localPost = createPost('offer', 'other', 'Bread, here', 'd', 10, 'fixed', localSeller)!;
    const localAttempt = await commission(keeper, { postId: localPost.id });
    assert(localAttempt.status === 404,
        `8d. a LOCAL listing cannot be commissioned (got ${localAttempt.status}) — that is an ordinary purchase`);
    assert(originOfCachedPost(localPost.id) === null,
        '8e. because a post with no origin_node resolves to no peer at all');

    // A cached listing whose peer has since been blocked. The listing disappears at the next pull; until
    // then the refusal has to say something true.
    addConnector(PEER_ADDR, 'blocked', 'byron', PEER_URL);
    const blocked = await commission(keeper, { postId: remotePost.id });
    assert(blocked.status === 403 && /no longer trades/i.test(blocked.body?.error ?? ''),
        `8f. a listing from a now-blocked peer is refused (got ${blocked.status}: ${blocked.body?.error})`);
    addConnector(PEER_ADDR, 'peer', 'byron', PEER_URL);

    // ── 9. THE ORDER OF THE CHECKS. Everything above passes; there is no transport. ─────────────────────
    //
    // The one assertion that proves funding is genuinely LAST. A 503 here with beans already drawn would be
    // a Commons debit for a commission that never started — and it is exactly what putting the transport
    // check after the funding would produce.
    setCommonsBalance(10_000);
    db.prepare('UPDATE accounts SET balance = 0 WHERE public_key = ?').run(link.treasuryPubkey);
    reconcileLedgerFromDb();
    const before9 = nodeTotal();
    const noTransport = await commission(keeper, { postId: remotePost.id });
    assert(noTransport.status === 503,
        `9a. a fully valid commission with no p2p transport returns 503 (got ${noTransport.status}: ${noTransport.body?.error})`);
    assert(r4(getCommonsBalanceExact()) === 10_000 && bal(link.treasuryPubkey) === 0,
        `9b. AND NOTHING WAS FUNDED (pot ${r4(getCommonsBalanceExact())}, link ${bal(link.treasuryPubkey)}) — funding is the last thing the route does, so every refusal above it costs the community nothing`);
    assert(nodeTotal() === before9, '9c. node total unchanged');

    // ── 10. The admin's node-wide override reaches a link like any other enterprise (#106). ────────────
    const admin = getAdminPubkey();
    if (admin) {
        const asAdmin = await commission(admin, { postId: remotePost.id });
        assert(asAdmin.status === 503,
            `10. the admin gets as far as the transport check (got ${asAdmin.status}) — they create the enterprises, so they keep the node-wide override`);
    } else {
        assert(false, '10. setup: no admin pubkey to check the override with');
    }

    // ── 11. An over-allowance refusal comes BEFORE the transport refusal, with numbers a keeper can act on.
    //
    // The transport is still down here — §9 just proved that — so this check is simultaneously about the
    // message and about the ORDER. A keeper over their allowance is over it whether the network is up or not,
    // so a 503 in this position would hide a permanent problem behind a transient one and invite a retry that
    // cannot succeed. This assertion is what made the ordering change; it originally read 503/undefined.
    setTab(PEER, 0);
    setCommissionCeiling(PEER, 0);
    const before11 = nodeTotal();
    const over = await commission(keeper, { postId: remotePost.id });
    assert(over.status === 409 && over.body?.reason === 'over_allowance',
        `11a. square with the peer and no ceiling → 409 over_allowance, NOT the 503 for the dead transport (got ${over.status}/${over.body?.reason})`);
    assert(/square with us/i.test(over.body?.error ?? '') && /ceiling/i.test(over.body?.error ?? ''),
        `11b. and the message names both things a keeper can act on: "${over.body?.error}"`);
    assert(over.body?.ok === undefined,
        '11c. with no `ok` field in the body — the HTTP status answers "did it work", and a body field disagreeing with it is a trap');
    assert(nodeTotal() === before11, '11d. node total unchanged');

    // ── 12. The capacity read is keeper-scoped. ────────────────────────────────────────────────────────
    const capLayer = (router as any).stack.find((l: any) =>
        l.path === '/api/federation/commission/capacity' && l.methods.includes('GET'));
    if (!capLayer) throw new Error('The capacity route is not mounted');
    const readCapacity = async (actor: string | undefined) => {
        const ctx: any = { state: actor ? { actor } : {}, status: 200, body: undefined };
        await capLayer.stack[capLayer.stack.length - 1](ctx, async () => {});
        return ctx;
    };
    const mine = await readCapacity(keeper);
    assert((mine.body?.links ?? []).length === 1 && mine.body.links[0].peerId === PEER,
        `12a. a keeper sees the link they keep (got ${(mine.body?.links ?? []).length})`);
    const theirs = await readCapacity(bystander);
    assert((theirs.body?.links ?? []).length === 0,
        `12b. and a member who keeps nothing sees an empty list, not every link (got ${(theirs.body?.links ?? []).length})`);
    const anon = await readCapacity(undefined);
    assert(anon.status === 401, `12c. unsigned is refused (got ${anon.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ #143 step 5 (Half B): a tab comes down, and the ceiling that bounds it is a budget rather than a formality.');
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ Test failed:', e); process.exit(1); });
