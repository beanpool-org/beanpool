/**
 * The cross-node settlement exchange — signed receipts and the ledger entries (#104, step 3b).
 *
 * Spec: docs/federation-economics.md §2.1 (the four entries), §2.5 (the exchange and its failure paths),
 * §3.1 (Rule 4), §3.2 (Rule 5).
 *
 * What these checks pin, in rough order of how much damage the failure would do:
 *   1. A receipt is bound to the PEER that issued it. Otherwise peer B can spend peer A's credit line,
 *      because the bridge account we debit is chosen by who issued the receipt.
 *   2. A receipt cannot name an amount, seller, or trade other than the reservation it settles — each of
 *      those routes real beans somewhere the cap check never authorised.
 *   3. The cap is re-checked ATOMICALLY at payment, not trusted from the reservation. A late receipt must
 *      not be able to push us past the number the operator chose.
 *   4. The four entries are exactly §2.1's, and the bridge carries the PRICE ONLY — never price plus fee.
 *   5. A reversal is a COMPENSATING entry, never a deletion. Both halves stay in the ledger.
 *   6. Boot recovery never reverses on ambiguity. UNKNOWN means wait.
 *   7. The protocol boundary refuses everything while the flag is off.
 *
 * WHAT THESE CHECKS CANNOT PIN: both halves run against ONE database here, so this verifies the arithmetic
 * of a crossing and that the pair nets to zero — not that two real nodes agree over a real network. That
 * needs the two-process harness (step 4), and it is where the timeout values get their first honest test.
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-settlement-exchange.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { initStateEngine, reconcileLedgerFromDb, exportSyncState } from './state-engine.js';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { addConnector, setConnectorCreditCap } from './connector-manager.js';
import {
    bridgeAccountId, getEnergyBalance, energyBalanceExact, ensureBridgeAccount, settlementCapacityForPeer,
} from './federation-bridge.js';
import { signReceipt, verifyReceipt, type SettlementReceipt } from './federation-receipt.js';
import {
    getSettlement, memberForeignExposure, receiptStatus,
} from './federation-settlement-state.js';
import {
    beginOutboundSettlement, commitOutboundSettlement, reverseOutboundSettlement,
    abandonOutboundSettlement, finaliseOutboundSettlement,
    handlePurchaseRequest, handleReceiptDelivery, settleHeldReceipt, answerReceiptStatus,
    expireStaleReservations, recoverSettlements, crossNodeFee, stuckSettlements, verifyStoredReceipt,
    RESERVATION_TTL_MS, PURCHASE_ASK_TIMEOUT_MS, RECEIPT_DELIVERY_TIMEOUT_MS, STUCK_SETTLEMENT_AFTER_MS,
} from './federation-settlement-exchange.js';
import {
    settlementGateRefusal, SETTLEMENT_ACTIONS,
    SETTLE_PURCHASE, SETTLE_RECEIPT, SETTLE_RECEIPT_STATUS,
} from './federation-protocol.js';
import { FEDERATION_SETTLEMENT_ENABLED } from './federation-settlement.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function throws(fn: () => unknown, re: RegExp, msg: string) {
    let m = '';
    try { fn(); } catch (e: any) { m = e.message; }
    assert(re.test(m), `${msg} (got "${m}")`);
}

/** The ledger keeps raw floats, so every arithmetic comparison here rounds to 4dp on both sides. */
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const balanceOf = (pk: string): number =>
    r4((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as any)?.balance ?? 0);
const near = (a: number, b: number): boolean => r4(a) === r4(b);
const escrowFor = (key: string): string => `escrow_${key}`;

/** Ledger rows whose memo names this settlement — how we prove a reversal ADDS entries, not removes them. */
const txnsFor = (key: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE memo LIKE ?`).get(`%(${key})%`) as any).n;

/** The exact amount of a settlement's fee entry, straight from the ledger row that recorded it. */
const feeTxnAmount = (key: string): number | null =>
    (db.prepare(`SELECT amount FROM transactions WHERE to_pubkey='COMMONS_POOL' AND memo LIKE ?`)
        .get(`%fee (${key})%`) as any)?.amount ?? null;

/**
 * The Commons row is now persisted EXACTLY, so these are equalities rather than tolerances.
 *
 * The earlier version of this file carried a 0.005 tolerance and justified it as pre-existing rounding in
 * `persistCommonsBalance`. That was wrong to accept: it hid a real conservation failure this very PR
 * introduces — a 0.075 fee persisted as 0.08, reloaded after a restart, then reversed by refunding 0.075,
 * leaves 0.005 minted from nothing. A tolerance in a conservation test is how that stays invisible.
 */
const exactly = (a: number, b: number): boolean => r4(a) === r4(b);

function makeMember(callsign: string, balance: number, homeNodeUrl?: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit, home_node_url)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 500, ?)`)
        .run(pk, callsign, homeNodeUrl ?? null);
    // Seed the epoch at NOW, not 0. Epoch 0 is 1970, so the first transfer would apply ~56 years of
    // compound demurrage and every balance assertion below would be measuring decay instead of settlement.
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)`)
        .run(pk, balance, ledger.getCurrentEpoch());
    reconcileLedgerFromDb();
    return pk;
}

async function main() {
    console.log('Running settlement exchange tests (#104 step 3b)...\n');
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') {
        throw new Error('Run with ENABLE_PEER_CONNECTORS=true — connector reads short-circuit otherwise');
    }
    initStateEngine();

    // Two real node identities. A peer id must be genuine here: verification recovers the public key
    // FROM the peer id, so a made-up string would fail for the wrong reason and prove nothing.
    const brisKey = await generateKeyPair('Ed25519');
    const otherKey = await generateKeyPair('Ed25519');
    const BRIS = peerIdFromPrivateKey(brisKey).toString();
    const OTHER = peerIdFromPrivateKey(otherKey).toString();

    addConnector(`/dns4/brisbane.beanpool.org/tcp/4001/p2p/${BRIS}`, 'peer', 'Brisbane', 'https://brisbane.beanpool.org');
    addConnector(`/dns4/melbourne.beanpool.org/tcp/4001/p2p/${OTHER}`, 'peer', 'Melbourne', 'https://melbourne.beanpool.org');
    const BRIS_ADDR = `/dns4/brisbane.beanpool.org/tcp/4001/p2p/${BRIS}`;
    const OTHER_ADDR = `/dns4/melbourne.beanpool.org/tcp/4001/p2p/${OTHER}`;

    // `buyer` is one of OURS — they are who the outbound half debits. `remoteBuyer` carries a home node,
    // which is what a cross-node buyer looks like on the SELLER's side. Two identities, not one, because
    // the two halves see genuinely different kinds of member and a single stand-in would hide that.
    const buyer = makeMember('Buyer', 1000);
    const seller = makeMember('Seller', 0);
    const remoteBuyer = makeMember('Remote Buyer', 0, 'https://brisbane.beanpool.org');
    const visitor = makeMember('Visitor', 0, 'https://elsewhere.beanpool.org');

    // ── 0. The timeout ordering constraint ──────────────────────────────────────────────────────
    // §2.5: the seller's reservation must outlive the buyer's timeouts by a clear margin, or
    // CAPACITY_LAPSED fires in normal operation and the rare compensating path becomes the routine one.
    assert(RESERVATION_TTL_MS > PURCHASE_ASK_TIMEOUT_MS + RECEIPT_DELIVERY_TIMEOUT_MS,
        'the reservation outlives the ask + delivery timeouts');
    assert(STUCK_SETTLEMENT_AFTER_MS > RESERVATION_TTL_MS * 10,
        'and escalation is far beyond the reservation, so a slow link is never mistaken for a dispute');

    // ── 1. Receipts are bound to their issuer ───────────────────────────────────────────────────
    const proto: SettlementReceipt = {
        key: 'r-1', issuerPeerId: BRIS, buyerPublicKey: buyer, buyerHomeNode: 'https://brisbane.beanpool.org',
        sellerPublicKey: seller, postId: 'post-1', amount: 5, committedAt: '2026-08-01T00:00:00.000Z',
    };
    const goodSig = await signReceipt(proto, brisKey);
    assert(await verifyReceipt(proto, goodSig, BRIS) === true, 'a receipt verifies against its issuer');

    assert(await verifyReceipt({ ...proto, amount: 50 }, goodSig, BRIS) === false,
        'inflating the amount breaks the signature');
    assert(await verifyReceipt({ ...proto, sellerPublicKey: visitor }, goodSig, BRIS) === false,
        'redirecting the seller breaks the signature');
    assert(await verifyReceipt({ ...proto, key: 'r-2' }, goodSig, BRIS) === false,
        'moving a receipt onto another settlement breaks the signature');

    // The one that matters most: the bridge account we debit is chosen by who issued the receipt.
    assert(await verifyReceipt(proto, goodSig, OTHER) === false,
        'a receipt presented by a DIFFERENT peer is refused — no peer can spend another peer\'s credit line');
    const forged = await signReceipt({ ...proto, issuerPeerId: OTHER }, otherKey);
    assert(await verifyReceipt({ ...proto, issuerPeerId: OTHER }, forged, BRIS) === false,
        'and re-signing it as themselves does not help — the claim is pinned to the connection');
    assert(await verifyReceipt({ ...proto, issuerPeerId: OTHER }, forged, OTHER) === true,
        '(that same receipt IS valid on their own connection — the check is binding, not blanket)');

    assert(await verifyReceipt(proto, '', BRIS) === false, 'an empty signature is refused');
    assert(await verifyReceipt(proto, 'not-base64!!', BRIS) === false, 'a garbage signature is refused, not thrown');
    assert(await verifyReceipt({ ...proto, issuerPeerId: 'nonsense' }, goodSig, 'nonsense') === false,
        'an unparseable peer id fails closed rather than throwing');

    // ── 2. The buyer's node: escrow, then the four entries (§2.1) ────────────────────────────────
    const buyerBefore = balanceOf(buyer);
    const commonsBefore = balanceOf('COMMONS_POOL');
    const KEY = 'k-cross-1';
    const AMOUNT = 5;
    const FEE = crossNodeFee(AMOUNT);
    assert(FEE === 0.075, 'the fee on a 5-bean crossing is 0.075 (1.5%)');

    const opened = beginOutboundSettlement({
        key: KEY, peerId: BRIS, buyerPublicKey: buyer, buyerHomeNode: 'https://brisbane.beanpool.org',
        sellerPublicKey: seller, postId: 'post-1', amount: AMOUNT,
    });
    assert(opened.state === 'escrowed', 'a purchase opens in escrow — nothing has crossed the border');
    assert(near(balanceOf(`escrow_${KEY}`), AMOUNT + FEE), 'escrow holds price AND fee — the buyer pays the fee on top');
    assert(near(balanceOf(buyer), buyerBefore - AMOUNT - FEE), 'and it has left the buyer\'s spendable balance');
    assert(beginOutboundSettlement({
        key: KEY, peerId: BRIS, buyerPublicKey: buyer, buyerHomeNode: 'https://brisbane.beanpool.org',
        sellerPublicKey: seller, postId: 'post-1', amount: AMOUNT,
    }).state === 'escrowed', 'a retried purchase reuses the same hold rather than taking twice');
    assert(near(balanceOf(`escrow_${KEY}`), AMOUNT + FEE), 'confirmed: the retry did not double-charge');

    const { receipt: rc1, signature: sig1 } = await commitOutboundSettlement(KEY, BRIS, brisKey, 'https://brisbane.beanpool.org');

    assert(near(balanceOf(buyer), buyerBefore - AMOUNT - FEE), 'buyer is debited price + fee (−5.075)');
    assert(feeTxnAmount(KEY) === FEE, 'the fee entry records EXACTLY 0.075 — not a rounded stand-in');
    assert(exactly(balanceOf('COMMONS_POOL'), commonsBefore + FEE),
        'and it lands in OUR Commons EXACTLY — not rounded to 2dp on the way to disk');
    assert(near(getEnergyBalance(BRIS), AMOUNT), 'the bridge carries the PRICE ONLY (+5.000), never price plus fee');
    assert(balanceOf(`escrow_${KEY}`) === 0, 'escrow closes to exactly zero — no dust left behind');
    assert(getSettlement(KEY)!.state === 'committed', 'and the row is committed BEFORE the receipt is handed out');

    const { receipt: rc2, signature: sig2 } = await commitOutboundSettlement(KEY, BRIS, brisKey);
    assert(sig1 === sig2, 'a re-commit returns the SAME receipt — never a second valid one for one key');
    assert(near(getEnergyBalance(BRIS), AMOUNT), 'and writes no second set of entries');

    // The replayed pair must actually VERIFY. Rebuilding the receipt from the row returned the old
    // signature next to different bytes (committedAt came from a different clock, buyerHomeNode was never
    // stored), so the retry — the path that runs after a network failure — produced a receipt the peer
    // would reject. The exact signed object is persisted now.
    assert(await verifyReceipt(rc2, sig2, BRIS) === true,
        'and the replayed receipt+signature still verify as a pair — the retry path is the one that matters');
    assert(rc2.committedAt === rc1.committedAt && rc2.buyerHomeNode === 'https://brisbane.beanpool.org',
        'because the exact signed object is replayed, not reconstructed from the row');

    // ── 2b. Two OVERLAPPING commits must not double-credit the bridge ─────────────────────────────
    // Reachable, unlike the other races here: commitOutboundSettlement awaits signReceipt between reading
    // `escrowed` and opening its transaction, so two retries genuinely both got through. The second repeated
    // the bridge and Commons moves — and a synthetic escrow_ account has an UNBOUNDED floor, so the transfer
    // did not refuse, it drove escrow negative. One trade, double the tab, and the second signature
    // overwriting the first.
    const RACE = 'k-race';
    beginOutboundSettlement({
        key: RACE, peerId: BRIS, buyerPublicKey: buyer, buyerHomeNode: 'https://brisbane.beanpool.org',
        sellerPublicKey: seller, postId: 'post-r', amount: 4,
    });
    const bridgeBeforeRace = getEnergyBalance(BRIS);
    const [raceA, raceB] = await Promise.all([
        commitOutboundSettlement(RACE, BRIS, brisKey, 'https://brisbane.beanpool.org'),
        commitOutboundSettlement(RACE, BRIS, brisKey, 'https://brisbane.beanpool.org'),
    ]);
    assert(near(getEnergyBalance(BRIS), bridgeBeforeRace + 4),
        'two overlapping commits credit the bridge ONCE — the second sees the committed row and replays it');
    assert(balanceOf(escrowFor(RACE)) === 0, 'and escrow closes to zero rather than being driven negative');
    assert(raceA.signature === raceB.signature, 'both callers get the SAME receipt, not two valid ones');
    assert(await verifyReceipt(raceA.receipt, raceA.signature, BRIS) === true, 'and it verifies');
    assert(getSettlement(RACE)!.state === 'committed', 'with a single committed row');
    reverseOutboundSettlement(RACE, 'CAPACITY_LAPSED');   // tidy up so later totals are unaffected

    // ── 3. A reversal compensates; it never deletes ──────────────────────────────────────────────
    const txnsBeforeReversal = txnsFor(KEY);
    const reversed = reverseOutboundSettlement(KEY, 'CAPACITY_LAPSED');
    assert(reversed.state === 'reversed' && reversed.failureReason === 'CAPACITY_LAPSED', 'the row records the reason');

    // The CODE stays on the row for operators; the member's ledger gets words. "CAPACITY_LAPSED" tells
    // someone reading their own history nothing about what happened, or that it wasn't their fault.
    // EVERY memo for this key, not `ORDER BY timestamp DESC LIMIT 1`. The principal refund and the fee refund
    // are written inside one transaction and share a timestamp, so "the last one" was arbitrary — this
    // assertion passed or failed by luck between runs. Assert the property, not the ordering.
    const reversalMemos = (db.prepare(
        `SELECT memo FROM transactions WHERE memo LIKE ? AND to_pubkey = ?`,
    ).all(`%(${KEY})%`, buyer) as any[]).map(r => r.memo as string);
    assert(reversalMemos.some(m => /credit limit/i.test(m)),
        'and the member-visible memo explains it in plain language');
    assert(reversalMemos.every(m => !/CAPACITY_LAPSED/.test(m)),
        'with no internal enum anywhere in what the member sees');
    assert(near(balanceOf(buyer), buyerBefore), 'the buyer is made whole — fee refunded too, since no crossing happened');
    assert(getEnergyBalance(BRIS) === 0, 'the bridge is back to square');
    assert(exactly(balanceOf('COMMONS_POOL'), commonsBefore),
        'and the Commons gives the fee back');
    assert(txnsFor(KEY) > txnsBeforeReversal,
        'the reversal ADDS ledger rows — deleting them would make a settled trade look like one that never happened');
    assert(reverseOutboundSettlement(KEY, 'again').state === 'reversed', 'reversing twice is an idempotent no-op');
    assert(near(balanceOf(buyer), buyerBefore), 'confirmed: no double refund');

    // ── 4. An unasked hold is released, not compensated ──────────────────────────────────────────
    const K2 = 'k-cross-2';
    beginOutboundSettlement({ key: K2, peerId: BRIS, buyerPublicKey: buyer, sellerPublicKey: seller, amount: 8 });
    assert(balanceOf(buyer) < buyerBefore, 'the hold really took the beans');
    abandonOutboundSettlement(K2, 'INTERRUPTED_BEFORE_ASK');
    assert(near(balanceOf(buyer), buyerBefore), 'releasing an unasked hold refunds price + fee');
    assert(getSettlement(K2)!.state === 'abandoned', 'and marks it abandoned — nothing crossed, nothing to compensate');
    throws(() => reverseOutboundSettlement(K2, 'x'), /not reversible/,
        'an abandoned hold cannot then be "reversed" — there are no entries to compensate');

    // ── 5. The seller's node: the cap gates the reservation (Rule 5) ──────────────────────────────
    const R1 = 'k-in-1';
    const ask = (
        key: string, amount: number, peerId = BRIS, sellerPublicKey = seller, buyerPublicKey = remoteBuyer,
    ) => handlePurchaseRequest({
        key, peerId, buyerPublicKey, buyerCallsign: 'Bris Buyer',
        buyerHomeNode: 'https://brisbane.beanpool.org', sellerPublicKey, postId: 'post-9', amount,
    });

    let decision = ask(R1, 5);
    assert(decision.accepted === false && (decision as any).reason === 'no_cap_configured',
        'with no cap set, settlement is refused — the safe state is the current state (§3.2)');
    assert(!getSettlement(R1), 'and a refusal writes no row: refusing is not a commitment');

    setConnectorCreditCap(BRIS_ADDR, 100);
    decision = ask(R1, 5);
    assert(decision.accepted === true, 'with a cap set, the reservation is accepted');
    assert(getSettlement(R1)!.state === 'reserved', 'state reserved — the seller is NOT paid yet (Rule 3c)');
    assert(new Date(getSettlement(R1)!.reservedUntil!).getTime() > Date.now(), 'and the hold has a future expiry');

    const retry = ask(R1, 5);
    assert(retry.accepted === true && (retry as any).reservedUntil === getSettlement(R1)!.reservedUntil,
        'a retried ask returns the SAME reservation, not a second one');

    const conflict = ask(R1, 5, OTHER);
    assert(conflict.accepted === false && (conflict as any).reason === 'key_conflict',
        'a key already held for another peer is refused — otherwise one peer\'s receipt pays from another\'s line');

    const amountConflict = ask(R1, 500);
    assert(amountConflict.accepted === false && (amountConflict as any).reason === 'key_conflict',
        're-asking with the same key for a BIGGER amount is refused, not answered yes at the reserved figure');
    assert(getSettlement(R1)!.amount === 5, 'and the reservation still holds its original amount');

    setConnectorCreditCap(OTHER_ADDR, 10);
    const over = ask('k-in-over', 999, OTHER);
    assert(over.accepted === false && (over as any).reason === 'cap_exhausted', 'an amount beyond the cap is refused');
    assert(/limit/i.test((over as any).message), 'and says so in plain language, not a code');

    const notLocal = ask('k-in-visitor', 5, BRIS, visitor);
    assert(notLocal.accepted === false && (notLocal as any).reason === 'seller_not_local',
        'we will not pay a non-member out of a bridge account — that is #102 wearing a different hat');
    for (const bad of [0, -5, NaN, Infinity]) {
        const r = ask(`k-in-bad-${bad}`, bad as number);
        assert(r.accepted === false && (r as any).reason === 'invalid_amount', `an amount of ${bad} is refused`);
    }

    // A peer naming one of OUR members as its buyer is refused. Not a cosmetic check: accepting it reaches
    // registerVisitor, which would stamp a home_node_url onto that local row and — via #102's guard —
    // freeze the member out of spending on their own node. Any peer knowing a public key could do it.
    const impersonation = ask('k-in-impersonate', 5, BRIS, seller, buyer);
    assert(impersonation.accepted === false && (impersonation as any).reason === 'buyer_is_local',
        'a peer cannot name one of our own members as a cross-node buyer');
    const localRow = db.prepare('SELECT home_node_url AS h FROM members WHERE public_key=?').get(buyer) as any;
    assert(localRow.h === null,
        'and our member is still local afterwards — no home node was stamped onto their row');

    // The genuine remote buyer keeps their home-node tag, so the seller can see who they are serving.
    const remoteRow = db.prepare('SELECT home_node_url AS h FROM members WHERE public_key=?').get(remoteBuyer) as any;
    assert(remoteRow.h === 'https://brisbane.beanpool.org',
        'the cross-node buyer is recorded as belonging to their home community, never confused with a local member');

    // ── 6. The receipt pays the seller — and only if it matches ──────────────────────────────────
    const sellerBefore = balanceOf(seller);
    const inReceipt: SettlementReceipt = {
        key: R1, issuerPeerId: BRIS, buyerPublicKey: remoteBuyer, buyerHomeNode: 'https://brisbane.beanpool.org',
        sellerPublicKey: seller, postId: 'post-9', amount: 5, committedAt: new Date().toISOString(),
    };
    const inSig = await signReceipt(inReceipt, brisKey);

    const badSig = await handleReceiptDelivery({ key: R1, receipt: inReceipt, signature: 'AAAA', peerId: BRIS });
    assert(badSig.settled === false && (badSig as any).reason === 'BAD_SIGNATURE', 'an unverifiable receipt is refused');
    assert(balanceOf(seller) === sellerBefore, 'and the seller is not paid');

    const inflated = { ...inReceipt, amount: 500 };
    const inflatedSig = await signReceipt(inflated, brisKey);
    const infOut = await handleReceiptDelivery({ key: R1, receipt: inflated, signature: inflatedSig, peerId: BRIS });
    assert(infOut.settled === false && (infOut as any).reason === 'RECEIPT_MISMATCH',
        'a VALIDLY SIGNED receipt for a bigger amount than we reserved is refused — the cap check bounded 5, not 500');
    assert(balanceOf(seller) === sellerBefore, 'and still nobody is paid');

    const wrongPeer = await handleReceiptDelivery({ key: R1, receipt: inReceipt, signature: inSig, peerId: OTHER });
    assert(wrongPeer.settled === false && (wrongPeer as any).reason === 'NOT_FOUND',
        'another peer cannot settle this key at all');

    const paid = await handleReceiptDelivery({ key: R1, receipt: inReceipt, signature: inSig, peerId: BRIS });
    assert(paid.settled === true, 'a matching, verified receipt pays the seller');
    assert(near(balanceOf(seller), sellerBefore + 5), 'the seller receives EXACTLY the agreed amount — no fee deducted');
    assert(near(getEnergyBalance(BRIS), -5), 'our bridge goes NEGATIVE by the price: that negative IS the credit we extended');
    assert(getSettlement(R1)!.state === 'settled', 'and the settlement is closed');

    const redeliver = await handleReceiptDelivery({ key: R1, receipt: inReceipt, signature: inSig, peerId: BRIS });
    assert(redeliver.settled === true && near(balanceOf(seller), sellerBefore + 5),
        'a redelivered receipt is an idempotent no-op — the seller is never paid twice');

    // ── 7. GET_RECEIPT_STATUS is scoped to the asker ──────────────────────────────────────────────
    assert(answerReceiptStatus(R1, BRIS) === 'SETTLED', 'the owning peer is told SETTLED');
    assert(answerReceiptStatus(R1, OTHER) === 'UNKNOWN',
        'another peer gets UNKNOWN — never NOT_FOUND, which would instruct them to reverse');
    assert(answerReceiptStatus('never-existed', BRIS) === 'UNKNOWN', 'an unrecognised key is UNKNOWN');

    // ── 8. CAPACITY_LAPSED: the cap is re-checked at payment, not trusted from the reservation ────
    const R2 = 'k-in-lapse';
    setConnectorCreditCap(BRIS_ADDR, 100);
    assert(ask(R2, 20).accepted === true, 'a fresh reservation is accepted inside the cap');

    // The operator drops the cap below what we have already extended while the receipt is in flight.
    setConnectorCreditCap(BRIS_ADDR, 1);
    const lapseReceipt: SettlementReceipt = {
        key: R2, issuerPeerId: BRIS, buyerPublicKey: remoteBuyer, buyerHomeNode: 'https://brisbane.beanpool.org',
        sellerPublicKey: seller, postId: 'post-9', amount: 20, committedAt: new Date().toISOString(),
    };
    const lapseSig = await signReceipt(lapseReceipt, brisKey);
    const sellerBeforeLapse = balanceOf(seller);
    const lapsed = await handleReceiptDelivery({ key: R2, receipt: lapseReceipt, signature: lapseSig, peerId: BRIS });
    assert(lapsed.settled === false && (lapsed as any).reason === 'CAPACITY_LAPSED',
        'a reservation is a HINT that reduces headroom, not a promise — the cap is the only authority at payment time');
    assert(balanceOf(seller) === sellerBeforeLapse, 'the seller is not paid past the operator\'s number');
    assert(getSettlement(R2)!.state === 'reversed', 'the row is reversed so the buyer\'s node can compensate its own entries');
    assert(receiptStatus(R2) === 'NOT_FOUND', 'and it now answers NOT_FOUND — the buyer SHOULD reverse');

    // ── 9. A lapsed reservation is released; a late receipt is refused, not honoured ──────────────
    const R3 = 'k-in-stale';
    setConnectorCreditCap(BRIS_ADDR, 100);
    assert(ask(R3, 3).accepted === true, 'a reservation to be left to expire');
    db.prepare(`UPDATE settlements SET reserved_until = '2020-01-01T00:00:00.000Z' WHERE key = ?`).run(R3);
    const sellerBeforeExpiry = balanceOf(seller);
    assert(expireStaleReservations() >= 1, 'a lapsed reservation is released');
    assert(getSettlement(R3)!.state === 'abandoned', 'marked abandoned');
    assert(balanceOf(seller) === sellerBeforeExpiry, 'and no beans moved — a reservation never held any');
    const lateReceipt: SettlementReceipt = { ...lapseReceipt, key: R3, amount: 3 };
    const late = await handleReceiptDelivery({
        key: R3, receipt: lateReceipt, signature: await signReceipt(lateReceipt, brisKey), peerId: BRIS,
    });
    assert(late.settled === false, 'a receipt arriving after expiry is refused rather than honoured on trust');

    // ── 10. Boot recovery ────────────────────────────────────────────────────────────────────────
    // An inbound row stuck at 'held' — we crashed after persisting a verified receipt, before paying.
    const R4 = 'k-in-held';
    assert(ask(R4, 4).accepted === true, 'reserve one to strand at held');
    const heldReceipt: SettlementReceipt = { ...lapseReceipt, key: R4, amount: 4 };
    db.prepare(`UPDATE settlements SET state='held', receipt=?, receipt_payload=? WHERE key=?`)
        .run(await signReceipt(heldReceipt, brisKey), JSON.stringify(heldReceipt), R4);
    const sellerBeforeRecovery = balanceOf(seller);

    // An outbound row stuck at 'escrowed' — we took the beans and crashed before asking the peer.
    const R5 = 'k-out-stranded';
    beginOutboundSettlement({ key: R5, peerId: BRIS, buyerPublicKey: buyer, sellerPublicKey: seller, amount: 6 });

    // An outbound row stuck at 'committed' — the receipt went out and we never learned its fate.
    const R6 = 'k-out-unconfirmed';
    beginOutboundSettlement({ key: R6, peerId: OTHER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: 7 });
    await commitOutboundSettlement(R6, OTHER, otherKey);

    // Captured last, so the delta below measures recovery alone and not the setup above it.
    const buyerBeforeRecovery = balanceOf(buyer);
    const rec = await recoverSettlements(async () => 'UNKNOWN');
    assert(near(balanceOf(seller), sellerBeforeRecovery + 4), 'recovery replays the payment we already owed');
    assert(getSettlement(R4)!.state === 'settled', 'the held row is settled');
    assert(rec.paid === 1, 'and it is counted as paid');
    assert(getSettlement(R5)!.state === 'abandoned'
        && near(balanceOf(buyer), buyerBeforeRecovery + 6 + crossNodeFee(6)),
        'a hold interrupted before the ask is refunded in full rather than held hostage to a purchase nobody awaits');
    assert(getSettlement(R6)!.state === 'committed',
        'UNKNOWN leaves the committed row ALONE — reversing on ambiguity is how a settled trade gets silently undone');
    assert(rec.stillOpen >= 1, 'and it is reported as still open, for the next boot');

    await recoverSettlements(async () => 'NOT_FOUND');
    assert(getSettlement(R6)!.state === 'reversed', 'NOT_FOUND — and only NOT_FOUND — triggers the compensating reversal');

    const R7 = 'k-out-confirmed';
    beginOutboundSettlement({ key: R7, peerId: OTHER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: 2 });
    await commitOutboundSettlement(R7, OTHER, otherKey);
    await recoverSettlements(async () => 'SETTLED');
    assert(getSettlement(R7)!.state === 'settled', 'SETTLED finalises: both bridges agree');

    const R8 = 'k-out-nopeer';
    beginOutboundSettlement({ key: R8, peerId: OTHER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: 2 });
    await commitOutboundSettlement(R8, OTHER, otherKey);
    const noAsk = await recoverSettlements();
    assert(getSettlement(R8)!.state === 'committed' && noAsk.stillOpen >= 1,
        'with no way to ask the peer, a committed row waits — waiting is always safe, guessing is not');
    assert(noAsk.stuck.length === 0, 'and a fresh one is not yet anybody\'s problem');

    // ── 10b. But the wait is BOUNDED, and the bound escalates rather than reverses ─────────────────
    // "UNKNOWN means wait" without a bound leaves a buyer's beans committed forever, re-counted as "still
    // open" on every boot and never surfacing to anyone.
    db.prepare(`UPDATE settlements SET updated_at = '2020-01-01T00:00:00.000Z' WHERE key = ?`).run(R8);
    assert(stuckSettlements().some(r => r.key === R8), 'a long-unresolved committed settlement is reported stuck');
    const stale = await recoverSettlements(async () => 'UNKNOWN');
    assert(stale.stuck.some(r => r.key === R8), 'recovery surfaces it for an operator');
    assert(getSettlement(R8)!.state === 'committed',
        'and does NOT auto-reverse it — an ambiguous crossing is a dispute between two communities, not a guess');
    assert(stale.stuck[0].amount === 2 && !!stale.stuck[0].peerId,
        'the report carries what an operator needs: the amount at stake and which community to talk to');
    finaliseOutboundSettlement(R8);
    assert(stuckSettlements().every(r => r.key !== R8), 'once resolved it stops being reported');

    // ── 10c. A temporary cap change must not permanently strand a held receipt ────────────────────
    // `reversed` is terminal, so latching a refusal during recovery would mean restoring the cap later
    // could never pay the seller — we would owe someone with no way left to pay them.
    const R9 = 'k-in-maintenance';
    setConnectorCreditCap(BRIS_ADDR, 1000);
    assert(ask(R9, 6).accepted === true, 'a reservation made while the cap is healthy');
    const r9Receipt: SettlementReceipt = { ...lapseReceipt, key: R9, amount: 6 };
    // Both the signature AND the payload: recovery re-verifies before paying, so a row carrying only a
    // signature is (correctly) not payable — `committedAt` would live nowhere and could not be rebuilt.
    db.prepare(`UPDATE settlements SET state='held', receipt=?, receipt_payload=? WHERE key=?`)
        .run(await signReceipt(r9Receipt, brisKey), JSON.stringify(r9Receipt), R9);

    setConnectorCreditCap(BRIS_ADDR, 1);            // operator lowers it during maintenance
    const recoverUnderLowCap = await recoverSettlements();
    assert(getSettlement(R9)!.state === 'held',
        'recovery leaves it HELD rather than latching a temporary cap change into a terminal reversal');
    assert(recoverUnderLowCap.stillOpen >= 1, 'and reports it as still open, to retry');

    setConnectorCreditCap(BRIS_ADDR, 1000);         // ...and restores it
    const sellerBeforeRestore = balanceOf(seller);
    await recoverSettlements();
    assert(getSettlement(R9)!.state === 'settled' && near(balanceOf(seller), sellerBeforeRestore + 6),
        'once the cap is restored the seller is paid — the receipt was never thrown away');

    // Live delivery is the opposite: a peer is waiting on an answer, so the refusal IS latched (§2.5) —
    // `reversed` is what tells them to compensate their own entries. Verified in section 8 above.
    assert(getSettlement(R2)!.state === 'reversed', 'live delivery still latches CAPACITY_LAPSED');

    // ── 10d. A failed write resyncs the in-memory ledger to the rolled-back rows ───────────────────
    // transfer()/moveToCommons() mutate the in-memory ledger AND SQLite; db.transaction rolls back only
    // the latter. Without a resync the two disagree permanently and every later read is served the wrong
    // number. Forced here by making the state transition illegal at the moment the ledger has already moved.
    const R10 = 'k-rollback';
    beginOutboundSettlement({ key: R10, peerId: OTHER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: 3 });
    const buyerBeforeFailedCommit = balanceOf(buyer);
    const bridgeBeforeFailedCommit = getEnergyBalance(OTHER);
    db.prepare(`UPDATE settlements SET state='settled' WHERE key=?`).run(R10);   // commit is now illegal
    let threw = false;
    try { await commitOutboundSettlement(R10, OTHER, otherKey); } catch { threw = true; }
    assert(threw, 'committing into an illegal state throws rather than writing');
    assert(near(balanceOf(buyer), buyerBeforeFailedCommit) && near(getEnergyBalance(OTHER), bridgeBeforeFailedCommit),
        'and the DB rows are unchanged');
    assert(near(ledger.getAccount(escrowFor(R10)).balance, balanceOf(escrowFor(R10))),
        'and the IN-MEMORY ledger agrees with them — a rollback resyncs memory instead of leaving it ahead');

    // ── 10e. A reservation actually REDUCES headroom (§2.5) ───────────────────────────────────────
    // "A reservation is a hint that reduces headroom" was prose only: capacity read the bridge balance and
    // ignored open reservations, so N concurrent purchases were each measured against the same full
    // headroom, all accepted, and their receipts then predictably lapsed AFTER their buyers had committed.
    // Derived from the EXACT balance: headroom is now `cap + balance − reserved`, and the display helper
    // rounds to 2dp, which would leave the target headroom slightly off.
    setConnectorCreditCap(BRIS_ADDR, r4(-energyBalanceExact(BRIS)) + 10);   // exactly 10 of headroom
    assert(ask('k-res-a', 7).accepted === true, 'the first purchase fits inside the headroom');
    const second = ask('k-res-b', 7);
    assert(second.accepted === false && (second as any).reason === 'cap_exhausted',
        'a second purchase that only fits if the first is ignored is REFUSED, not accepted then lapsed later');
    assert(ask('k-res-c', 3).accepted === true, 'while one that fits in what actually remains is accepted');

    // ── 10f. The cap is enforced on the UNROUNDED balance ─────────────────────────────────────────
    // getEnergyBalance rounds to 2dp but prices are carried at 4dp, so an exposure of 99.994 read as 99.99
    // let another 0.01 through against a 100 cap — past the number the operator chose.
    const FRAC = '12D3KooWFractionalPeer';
    addConnector(`/dns4/frac.beanpool.org/tcp/4001/p2p/${FRAC}`, 'peer', 'Frac', 'https://frac.beanpool.org');
    ensureBridgeAccount(FRAC);
    db.prepare('UPDATE accounts SET balance = ? WHERE public_key = ?').run(-99.994, bridgeAccountId(FRAC));
    reconcileLedgerFromDb();
    setConnectorCreditCap(`/dns4/frac.beanpool.org/tcp/4001/p2p/${FRAC}`, 100);
    assert(getEnergyBalance(FRAC) === -99.99, 'the DISPLAY balance rounds to 2dp, as it should');
    assert(settlementCapacityForPeer(FRAC, 0.01).ok === false,
        'but enforcement uses the stored value, so the last 0.01 against a 100 cap is refused');

    // ── 10g. The cap must not block the REBALANCING direction (§3.2) ──────────────────────────────
    // The cap bounds how far NEGATIVE the bridge may go. Measuring headroom from "credit extended so far"
    // threw away a POSITIVE balance — and a positive balance is exactly the state where paying their seller
    // reduces what we owe. With +5 and a cap of 0, paying a 5-bean seller ends at 0 and extends no credit at
    // all, yet the old arithmetic refused it, closing the one direction §3.2 insists stays open.
    const REBAL = '12D3KooWRebalancePeer';
    const REBAL_ADDR = `/dns4/rebal.beanpool.org/tcp/4001/p2p/${REBAL}`;
    addConnector(REBAL_ADDR, 'peer', 'Rebalance', 'https://rebal.beanpool.org');
    ensureBridgeAccount(REBAL);
    db.prepare('UPDATE accounts SET balance = 5 WHERE public_key = ?').run(bridgeAccountId(REBAL));
    reconcileLedgerFromDb();
    setConnectorCreditCap(REBAL_ADDR, 0);

    const rebal = settlementCapacityForPeer(REBAL, 5);
    assert(rebal.ok === true, 'a +5 position with a ZERO cap still allows a 5-bean payment — it ends at zero');
    assert(rebal.ok === true && rebal.headroom === 5, 'headroom is measured from the signed balance, not from zero');
    assert(settlementCapacityForPeer(REBAL, 5.01).ok === false,
        'but a hair beyond that WOULD extend credit past the cap, so it is refused');
    setConnectorCreditCap(REBAL_ADDR, 10);
    assert(settlementCapacityForPeer(REBAL, 15).ok === true, 'and a cap of 10 on a +5 position allows 15');
    assert(settlementCapacityForPeer(REBAL, 15.01).ok === false, 'while 15.01 is one hair too far');

    // ── 10h. A held receipt is re-verifiable after a reboot ───────────────────────────────────────
    // §2.6 says the persisted signature is the evidence authorising the payment and stays checkable in an
    // audit. Storing only the signature made that false on the seller's side: `committedAt` lived nowhere
    // else, so the payload could not be rebuilt and the receipt could never be re-checked.
    const heldRow = getSettlement(R4)!;
    assert(!!heldRow.receiptPayload, 'the seller side stores the receipt OBJECT, not just its signature');
    assert(await verifyStoredReceipt(heldRow) === true, 'so it can be re-verified with no live connection');
    assert(await verifyStoredReceipt({ ...heldRow, peerId: OTHER }) === false,
        'and it does not verify against a different peer — the binding survives persistence');
    assert(await verifyStoredReceipt({ ...heldRow, receiptPayload: null }) === false,
        'a row with no stored payload is NOT payable — fail closed rather than pay on a mutable row');

    // ── 10h2. A redelivery REPAIRS a held row left without a payload by an older build ────────────
    // The upgrade shape: a settlement that reached `held` before receipts were stored as objects has a
    // signature and no payload. Recovery now refuses to pay what it cannot re-verify — so without repair
    // that row would be rejected FOREVER, an in-flight trade made permanently unpayable by an upgrade.
    const LEGACY = 'k-legacy-held';
    setConnectorCreditCap(BRIS_ADDR, 1000);
    assert(ask(LEGACY, 3).accepted === true, 'a reservation to age into the legacy shape');
    const legacyReceipt: SettlementReceipt = { ...lapseReceipt, key: LEGACY, amount: 3 };
    const legacySig = await signReceipt(legacyReceipt, brisKey);
    // Signature only — exactly what an older build persisted.
    db.prepare(`UPDATE settlements SET state='held', receipt=?, receipt_payload=NULL WHERE key=?`)
        .run(legacySig, LEGACY);
    assert(await verifyStoredReceipt(getSettlement(LEGACY)!) === false,
        'the legacy row cannot be re-verified, so recovery will not pay it');
    assert((await recoverSettlements()).stillOpen >= 1, 'and recovery leaves it alone rather than paying blind');

    const sellerBeforeRepair = balanceOf(seller);
    const repaired = await handleReceiptDelivery({
        key: LEGACY, receipt: legacyReceipt, signature: legacySig, peerId: BRIS,
    });
    assert(repaired.settled === true, 'a redelivery settles it');
    assert(!!getSettlement(LEGACY)!.receiptPayload, 'and repairs the missing payload while it has it in hand');
    assert(near(balanceOf(seller), sellerBeforeRepair + 3), 'so the seller is finally paid');

    // ── 10h3. A stored receipt must match the ROW, not merely be signed ───────────────────────────
    // Payment is made from the ROW's amount and seller. A signature only proves who signed — so if the row
    // and its receipt disagree, a genuinely signed receipt authorises terms nobody agreed to.
    const DRIFT = 'k-drift';
    assert(ask(DRIFT, 5).accepted === true, 'a reservation whose row we will then tamper with');
    const driftReceipt: SettlementReceipt = { ...lapseReceipt, key: DRIFT, amount: 5 };
    db.prepare(`UPDATE settlements SET state='held', receipt=?, receipt_payload=? WHERE key=?`)
        .run(await signReceipt(driftReceipt, brisKey), JSON.stringify(driftReceipt), DRIFT);
    assert(await verifyStoredReceipt(getSettlement(DRIFT)!) === true, 'row and receipt agree, so it verifies');

    db.prepare(`UPDATE settlements SET amount = 500 WHERE key = ?`).run(DRIFT);   // row drifts from receipt
    assert(await verifyStoredReceipt(getSettlement(DRIFT)!) === false,
        'but once the row says 500 and the signed receipt says 5, verification FAILS — the signature is still valid');
    const sellerBeforeDrift = balanceOf(seller);
    assert((await recoverSettlements()).paid === 0, 'so recovery does not pay it');
    assert(near(balanceOf(seller), sellerBeforeDrift), 'and the seller is not paid 500 on a receipt for 5');

    // ── 10h4. A cross-node buyer is never registered as a LOCAL member ────────────────────────────
    // registerVisitor(pk, callsign, undefined) writes home_node_url = NULL, which is indistinguishable from
    // a local member: the buyer then trips the buyer_is_local guard forever, and a remote key has entered the
    // member table without going through local membership at all.
    const NOHOME = 'k-no-home';
    const orphanBuyer = crypto.randomBytes(32).toString('hex');
    const noHome = handlePurchaseRequest({
        key: NOHOME, peerId: BRIS, buyerPublicKey: orphanBuyer, buyerCallsign: 'No Home',
        buyerHomeNode: '   ', sellerPublicKey: seller, postId: 'post-9', amount: 2,
    });
    assert(noHome.accepted === true, 'a blank home node falls back to the peer\'s own configured URL');
    const orphanRow = db.prepare('SELECT home_node_url AS h FROM members WHERE public_key=?').get(orphanBuyer) as any;
    assert(orphanRow.h === 'https://brisbane.beanpool.org',
        'so the buyer is recorded against the community we are actually talking to, never as local');
    assert(getSettlement(NOHOME)!.buyerHomeNode === 'https://brisbane.beanpool.org',
        'and the settlement row agrees with the visitor record');

    // ── 10i. Settlements survive into a backup snapshot ──────────────────────────────────────────
    // A promoted backup inherits the LEDGER EFFECTS of an in-flight settlement — escrow held, a bridge
    // credited — so without the row it cannot query, reverse or pay it. recoverSettlements() would find
    // nothing while the beans sat in escrow forever.
    // A row deliberately left IN FLIGHT at snapshot time — the case that matters, since a settled row needs
    // nothing from the replica. (R1/R4 have since been resolved by the recovery sections above.)
    const INFLIGHT = 'k-snapshot-held';
    setConnectorCreditCap(BRIS_ADDR, 1000);
    assert(ask(INFLIGHT, 9).accepted === true, 'a reservation to leave in flight across the snapshot');
    const snapReceipt: SettlementReceipt = { ...lapseReceipt, key: INFLIGHT, amount: 9 };
    db.prepare(`UPDATE settlements SET state='held', receipt=?, receipt_payload=? WHERE key=?`)
        .run(await signReceipt(snapReceipt, brisKey), JSON.stringify(snapReceipt), INFLIGHT);

    const snapshot = await exportSyncState('test-node');
    assert(Array.isArray(snapshot.settlements) && snapshot.settlements.length > 0,
        'a full snapshot carries the settlement outbox');
    const snapKeys = snapshot.settlements!.map(s => s.key);
    assert(snapKeys.includes(R1) && snapKeys.includes(INFLIGHT),
        'including both finalised and in-flight rows');
    const snapHeld = snapshot.settlements!.find(s => s.key === INFLIGHT)!;
    assert(!!snapHeld.receiptPayload && !!snapHeld.receipt,
        'and carries the receipt a promoted node needs in order to pay its seller');
    assert(snapHeld.state === 'held' && snapHeld.direction === 'inbound' && snapHeld.amount === 9,
        'with the state, direction and amount that decide what recovery does with it');
    assert(snapshot.commonsBalance === undefined || r4(snapshot.commonsBalance) === r4(balanceOf('COMMONS_POOL')),
        'and the snapshot Commons figure is exact, so a replica can balance against the primary');

    // ── 11. The pair nets to zero (§2.1) ─────────────────────────────────────────────────────────
    // Both halves of one crossing, run against this single database. That proves the ARITHMETIC of the
    // four entries and that the pair sums to zero. It does NOT prove two live nodes agree — the bridge
    // rows here are two rows in one table rather than one row on each of two nodes. Step 4's harness.
    const PAIR_OUT = 'k-pair-out', PAIR_IN = 'k-pair-in';
    const b0 = balanceOf(buyer), s0 = balanceOf(seller), c0 = balanceOf('COMMONS_POOL');
    const outBridge0 = getEnergyBalance(OTHER), inBridge0 = getEnergyBalance(BRIS);

    setConnectorCreditCap(BRIS_ADDR, 1000);
    beginOutboundSettlement({ key: PAIR_OUT, peerId: OTHER, buyerPublicKey: buyer, sellerPublicKey: seller, postId: 'p', amount: 5 });
    await commitOutboundSettlement(PAIR_OUT, OTHER, otherKey);

    assert(ask(PAIR_IN, 5).accepted === true, 'the mirror-image reservation on the other side');
    const pairReceipt: SettlementReceipt = {
        key: PAIR_IN, issuerPeerId: BRIS, buyerPublicKey: remoteBuyer, buyerHomeNode: 'https://brisbane.beanpool.org',
        sellerPublicKey: seller, postId: 'post-9', amount: 5, committedAt: new Date().toISOString(),
    };
    assert((await handleReceiptDelivery({
        key: PAIR_IN, receipt: pairReceipt, signature: await signReceipt(pairReceipt, brisKey), peerId: BRIS,
    })).settled === true, 'and it settles');

    const dBuyer = r4(balanceOf(buyer) - b0);
    const dSeller = r4(balanceOf(seller) - s0);
    const dCommons = r4(balanceOf('COMMONS_POOL') - c0);
    const dOutBridge = r4(getEnergyBalance(OTHER) - outBridge0);
    const dInBridge = r4(getEnergyBalance(BRIS) - inBridge0);

    assert(dBuyer === -5.075, `buyer −5.075 (got ${dBuyer})`);
    assert(feeTxnAmount(PAIR_OUT) === 0.075, 'the fee entry is exactly +0.075 to the Commons');
    assert(dOutBridge === 5, `bridge on the buyer's side +5.000 (got ${dOutBridge})`);
    assert(dSeller === 5, `seller +5.000 (got ${dSeller})`);
    assert(dInBridge === -5, `bridge on the seller's side −5.000 (got ${dInBridge})`);
    assert(dOutBridge + dInBridge === 0, 'the two bridge rows are equal and opposite — drift here is a reconciliation failure');

    // The whole crossing nets to zero. Measured with the EXACT fee from its ledger entry rather than the
    // Commons row's 2dp delta, so this asserts conservation of beans and not the persistence precision.
    assert(r4(dBuyer + 0.075 + dOutBridge + dSeller + dInBridge) === 0,
        'and the whole crossing nets to exactly zero — no beans created, none destroyed');
    assert(exactly(dCommons, 0.075),
        'with the persisted Commons figure agreeing exactly');

    // ── 12. Rule 4: foreign exposure is reported, and enforced by the escrow floor check ──────────
    const exposure = memberForeignExposure(buyer);
    assert(exposure > 0, 'a committed crossing shows up as the buyer\'s foreign exposure');
    assert(!Number.isNaN(exposure), 'and it is a number, not NaN from a null sum');
    const reversedExposure = memberForeignExposure(seller);
    assert(reversedExposure === 0, 'a member who has bought nothing abroad has no exposure');

    // ── 13. The protocol boundary refuses while the flag is off ──────────────────────────────────
    assert(FEDERATION_SETTLEMENT_ENABLED === false,
        'settlement ships OFF — the mechanism lands before the switch, not with it');
    const gated = settlementGateRefusal('peer', BRIS, SETTLE_PURCHASE);
    assert(gated !== null && gated.code === 'federation_settlement_disabled',
        'a NEW purchase is refused at the wire, even from a fully trusted peer');
    assert(SETTLEMENT_ACTIONS.has(SETTLE_PURCHASE) && SETTLEMENT_ACTIONS.has(SETTLE_RECEIPT)
        && SETTLEMENT_ACTIONS.has(SETTLE_RECEIPT_STATUS) && SETTLEMENT_ACTIONS.size === 3,
        'and all three actions are in the gated set — an ungated fourth is the mistake this shape prevents');

    // The flag stops NEW trades; it must not strand ones already in flight. Refusing a receipt we already
    // issued would leave the seller unable to accept it and the buyer's recovery reading every answer as
    // UNKNOWN — which contradicts the recovery policy this module states.
    assert(settlementGateRefusal('peer', BRIS, SETTLE_RECEIPT) === null,
        'but a receipt for a trade already in flight is still accepted with the flag off');
    assert(settlementGateRefusal('peer', BRIS, SETTLE_RECEIPT_STATUS) === null,
        'and so is a status query — otherwise switching settlement off strands committed beans');

    // Trust and identity are checked for EVERY action, flag or no flag.
    for (const action of [SETTLE_PURCHASE, SETTLE_RECEIPT, SETTLE_RECEIPT_STATUS]) {
        assert(settlementGateRefusal('mirror', BRIS, action, 'primary', true)?.code === 'federation_settlement_disabled',
            `a MIRROR is refused for ${action} — a backup replica is not a trading partner`);
        assert(settlementGateRefusal(null, BRIS, action, 'primary', true) !== null, `an untrusted connection is refused for ${action}`);
        assert(settlementGateRefusal('peer', 'unknown', action, 'primary', true) !== null, `an unidentified peer is refused for ${action}`);
        assert(settlementGateRefusal('peer', '', action, 'primary', true) !== null, `an empty peer id is refused for ${action}`);
    }
    assert(settlementGateRefusal('peer', BRIS, SETTLE_PURCHASE, 'primary', true) === null, 'once enabled, a trading peer is admitted');

    // A BACKUP replica refuses EVERY settlement action, even fully enabled and from a trusted peer. Its
    // ledger is replaced by the next snapshot import, so entries written here would vanish while the peer
    // believed it had been paid — and the two nodes' bridge rows would silently disagree.
    for (const action of [SETTLE_PURCHASE, SETTLE_RECEIPT, SETTLE_RECEIPT_STATUS]) {
        assert(settlementGateRefusal('peer', BRIS, action, 'backup', true)?.code === 'federation_settlement_disabled',
            `a backup replica refuses ${action} — a replica mirrors a ledger, it does not author one`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Settlement exchange checks PASSED (#104 step 3b).');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
