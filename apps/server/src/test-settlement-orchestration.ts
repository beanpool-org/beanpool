/**
 * #104 step 4 — the BUYER's side of a cross-node purchase, driven end to end.
 *
 * WHAT WAS MISSING. Steps 1–3b built the whole outbound state machine (`beginOutboundSettlement`,
 * `commitOutboundSettlement`, `reverseOutboundSettlement`, `abandonOutboundSettlement`,
 * `finaliseOutboundSettlement`) and `federation-protocol.ts` built all three wire calls — but nothing
 * composed them. `beginOutboundSettlement` had no caller outside tests, so **no cross-node purchase was
 * reachable in production**: #104's acceptance criteria were unreachable by construction, not merely
 * unimplemented. `runOutboundSettlement` is that composition, and this suite is what holds it honest.
 *
 * THE DECISION THAT MATTERS. Once step 3 commits, the buyer's beans have left escrow for the bridge and the
 * seller's node may or may not have paid its seller. From there every answer sorts into exactly two piles:
 *
 *   • "we will NEVER pay this"  → reverse, with compensating entries. The buyer is made whole.
 *   • anything else             → WAIT. Leave the row `committed` for recovery.
 *
 * Reversing on an answer from the second pile is a double-spend: their seller is paid from the bridge while
 * we hand the buyer their beans back, so the pair stops summing to zero and the difference is real beans. A
 * transport failure after commit is the most likely instance — the request may have arrived and only the
 * reply been lost — which is why it maps to `pending` and not to a refund.
 *
 * The wire is STUBBED here, deliberately. Every branch below is a decision about money, and a stub is the
 * only way to reach all of them — a real peer cannot be made to answer `BAD_SIGNATURE` on demand. The real
 * transport is exercised separately, against a second live node.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-settlement-orchestration.ts
 */
import crypto from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { initStateEngine, reconcileLedgerFromDb, getCommonsBalanceExact } from './state-engine.js';
import { ledger } from './engine/ledger.js';
import { db } from './db/db.js';
import { addConnector, setConnectorCreditCap } from './connector-manager.js';
import { bridgeAccountId } from './federation-bridge.js';
import { getSettlement } from './federation-settlement-state.js';
import {
    runOutboundSettlement, crossNodeFee, type SettlementWire,
    PURCHASE_ASK_TIMEOUT_MS, RECEIPT_DELIVERY_TIMEOUT_MS, RESERVATION_TTL_MS,
} from './federation-settlement-exchange.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const balanceOf = (pk: string): number =>
    r4((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as any)?.balance ?? 0);
const stateOf = (key: string): string | undefined => getSettlement(key)?.state;
/** Ledger rows naming this settlement — how we prove a reversal ADDS entries rather than removing them. */
const txnsFor = (key: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE memo LIKE ?`).get(`%(${key})%`) as any).n;

/**
 * The whole ledger as one number: every account row except the COMMONS_POOL shadow, plus the live global.
 * A settlement only ever MOVES value between rows of one node, so this must not budge — not on the happy
 * path, and least of all on a compensating one.
 */
const nodeTotal = (): number => {
    const s = (db.prepare(`SELECT COALESCE(SUM(balance),0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'`)
        .get() as { s: number }).s;
    return r4(s + getCommonsBalanceExact());
};

function makeMember(callsign: string, balance: number, homeNodeUrl?: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit, home_node_url)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 500, ?)`)
        .run(pk, callsign, homeNodeUrl ?? null);
    // Epoch at NOW, not 0. Epoch 0 is 1970, so the first read would apply ~56 years of compound demurrage
    // and every balance assertion below would be measuring decay instead of settlement (#138).
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)`)
        .run(pk, balance, ledger.getCurrentEpoch());
    reconcileLedgerFromDb();
    return pk;
}

/** A wire whose two answers are fixed up front. `null` for either means "the transport failed". */
const stubWire = (askReply: any, deliverReply: any): SettlementWire & { asked: number; delivered: number } => {
    const w = {
        asked: 0,
        delivered: 0,
        async ask() {
            w.asked++;
            if (askReply === null) throw new Error('Read timeout');
            return askReply;
        },
        async deliver() {
            w.delivered++;
            if (deliverReply === null) throw new Error('Read timeout');
            return deliverReply;
        },
    };
    return w;
};

const ACCEPTED = { accepted: true, key: '', reservedUntil: new Date(Date.now() + RESERVATION_TTL_MS).toISOString() };
const PRICE = 40;
const FEE = crossNodeFee(PRICE);

async function main() {
    console.log('Running #104 buyer-side settlement orchestration tests...\n');
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') {
        throw new Error('Run with ENABLE_PEER_CONNECTORS=true — connector reads short-circuit otherwise');
    }
    initStateEngine();

    // A genuine peer id: `commitOutboundSettlement` signs a receipt whose verification recovers the public
    // key FROM the peer id, so a made-up string would fail for the wrong reason.
    const ourKey = await generateKeyPair('Ed25519');
    const OURS = peerIdFromPrivateKey(ourKey).toString();
    const peerKey = await generateKeyPair('Ed25519');
    const PEER = peerIdFromPrivateKey(peerKey).toString();
    const PEER_ADDR = `/dns4/byron.beanpool.org/tcp/4001/p2p/${PEER}`;
    addConnector(PEER_ADDR, 'peer', 'Byron', 'https://byron.beanpool.org');
    setConnectorCreditCap(PEER_ADDR, 10_000);

    const bridge = bridgeAccountId(PEER);
    const seller = 'seller-on-their-node';

    // Both members seeded BEFORE the baseline. Seeding mints beans out of nothing — that is a fixture's
    // privilege, not the code's — so a baseline taken first would read every later check as a 500-bean
    // conservation failure. (It did, on the first run of this file.)
    const buyer = makeMember('Buyer', 500);
    const pauper = makeMember('Pauper', 0);
    const baseline = nodeTotal();

    // ── 0. The timeout ordering constraint the whole protocol rests on ──────────────────────────────
    // §2.5: the seller's reservation must outlive the buyer's ask AND delivery timeouts. If it does not,
    // CAPACITY_LAPSED fires in normal operation and the rare compensating path becomes the routine one.
    assert(RESERVATION_TTL_MS > PURCHASE_ASK_TIMEOUT_MS + RECEIPT_DELIVERY_TIMEOUT_MS,
        `a reservation (${RESERVATION_TTL_MS}ms) outlives ask + delivery (${PURCHASE_ASK_TIMEOUT_MS}`
        + ` + ${RECEIPT_DELIVERY_TIMEOUT_MS}ms) — so a slow link never looks like a lapsed cap`);

    // ── 1. The happy path, and the buyer's three entries ───────────────────────────────────────────
    const KEY_OK = 'orch-ok';
    const wire1 = stubWire({ ...ACCEPTED, key: KEY_OK }, { settled: true, key: KEY_OK });
    const commonsBefore = getCommonsBalanceExact();
    const out1 = await runOutboundSettlement(
        { key: KEY_OK, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, postId: 'post-1', amount: PRICE },
        wire1, OURS, ourKey,
    );

    assert(out1.status === 'settled', `a purchase the peer accepts and pays settles (${out1.status})`);
    assert(stateOf(KEY_OK) === 'settled', 'and the row is terminal at `settled`');
    assert(wire1.asked === 1 && wire1.delivered === 1, 'one ask, one delivery — no retries on the happy path');
    // The buyer pays price + fee; the bridge carries the PRICE ONLY, and the fee stays home.
    assert(balanceOf(buyer) === r4(500 - PRICE - FEE),
        `the buyer is debited ${PRICE} + ${FEE} fee = ${r4(PRICE + FEE)}`);
    assert(balanceOf(bridge) === PRICE,
        `the bridge carries the price alone (${balanceOf(bridge)}) — a fee must never cross the border`);
    assert(r4(getCommonsBalanceExact() - commonsBefore) === FEE,
        'and the fee landed in our own Commons pot');
    assert(nodeTotal() === baseline, 'conservation: a settled purchase moved value between our own rows only');

    // ── 2. The peer says no at step 2 — nothing crossed, so it is a plain release ───────────────────
    const KEY_NO = 'orch-refused';
    const wire2 = stubWire({ accepted: false, reason: 'PEER_CAP_EXCEEDED', message: 'Not right now.' }, undefined);
    const beforeNo = balanceOf(buyer);
    const out2 = await runOutboundSettlement(
        { key: KEY_NO, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
        wire2, OURS, ourKey,
    );

    assert(out2.status === 'refused' && (out2 as any).reason === 'PEER_CAP_EXCEEDED',
        `a refusal at step 2 is reported as refused, with the peer's reason (${out2.status})`);
    assert(stateOf(KEY_NO) === 'abandoned', 'the hold is `abandoned`, not `reversed` — there is nothing to compensate');
    assert(wire2.delivered === 0, 'and no receipt was ever delivered');
    assert(balanceOf(buyer) === beforeNo, 'the buyer is whole again, fee included');
    assert(nodeTotal() === baseline, 'conservation holds through a refusal');

    // ── 3. The ask never arrives — the ONE transport failure that is safe to release ────────────────
    // Step 2 moves no beans on either side, so releasing our hold cannot leave the ledgers disagreeing.
    const KEY_UNREACHABLE = 'orch-unreachable';
    const wire3 = stubWire(null, undefined);
    const out3 = await runOutboundSettlement(
        { key: KEY_UNREACHABLE, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
        wire3, OURS, ourKey,
    );

    assert(out3.status === 'refused' && (out3 as any).reason === 'ASK_UNREACHABLE',
        `an unreachable peer at step 2 releases the hold rather than stranding it (${out3.status})`);
    assert(stateOf(KEY_UNREACHABLE) === 'abandoned', 'the row is abandoned');
    assert(balanceOf(buyer) === beforeNo, 'and the buyer keeps every bean, immediately');
    assert(nodeTotal() === baseline, 'conservation holds when the peer is unreachable');

    // ── 4. CAPACITY_LAPSED after commit — terminal on their side, so we compensate ──────────────────
    const KEY_LAPSED = 'orch-lapsed';
    const wire4 = stubWire({ ...ACCEPTED, key: KEY_LAPSED },
        { settled: false, reason: 'CAPACITY_LAPSED', message: 'Cap reached.' });
    const beforeLapsed = balanceOf(buyer);
    const out4 = await runOutboundSettlement(
        { key: KEY_LAPSED, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
        wire4, OURS, ourKey,
    );

    assert(out4.status === 'reversed' && (out4 as any).reason === 'CAPACITY_LAPSED',
        `a lapsed cap after commit reverses (${out4.status})`);
    assert(stateOf(KEY_LAPSED) === 'reversed', 'the row is `reversed`');
    assert(balanceOf(buyer) === beforeLapsed, 'the buyer is made whole — principal AND fee, since no trade happened');
    assert(balanceOf(bridge) === PRICE,
        `the bridge is back to the one settled purchase (${balanceOf(bridge)}) — compensated, not unwound`);
    assert(txnsFor(KEY_LAPSED) >= 4,
        `and the reversal ADDED entries rather than deleting any (${txnsFor(KEY_LAPSED)} rows name it)`);
    assert(nodeTotal() === baseline, 'conservation holds through a compensating reversal');

    // ── 5. THE ASYMMETRY: a non-terminal refusal must NOT reverse ──────────────────────────────────
    // `settlement_error` is their node failing to pay a receipt it has already persisted as `held`. It will
    // retry on its next boot. Reversing here would refund the buyer while their seller gets paid — the
    // double-spend this whole decision table exists to prevent.
    const KEY_RETRY = 'orch-retrying';
    const wire5 = stubWire({ ...ACCEPTED, key: KEY_RETRY },
        { settled: false, reason: 'settlement_error', message: 'It is recorded and will be retried.' });
    const beforeRetry = balanceOf(buyer);
    const out5 = await runOutboundSettlement(
        { key: KEY_RETRY, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
        wire5, OURS, ourKey,
    );

    assert(out5.status === 'pending', `a retryable failure is PENDING, never reversed (${out5.status})`);
    assert(stateOf(KEY_RETRY) === 'committed',
        `the row stays \`committed\` for recovery (${stateOf(KEY_RETRY)}) — reversing it while they still hold `
        + 'the receipt would pay their seller and refund our buyer for the same trade');
    assert(balanceOf(buyer) === r4(beforeRetry - PRICE - FEE),
        'the buyer stays debited, because the trade may yet complete');
    assert(balanceOf(bridge) === r4(PRICE * 2), 'and we still owe outward on the bridge');
    assert(nodeTotal() === baseline, 'conservation holds while a settlement is in flight');

    // ── 6. Delivery times out after commit — ambiguous, so also PENDING ────────────────────────────
    // The request may have arrived and only the reply been lost, so their seller may already be paid.
    const KEY_LOST = 'orch-lost-reply';
    const wire6 = stubWire({ ...ACCEPTED, key: KEY_LOST }, null);
    const out6 = await runOutboundSettlement(
        { key: KEY_LOST, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
        wire6, OURS, ourKey,
    );

    assert(out6.status === 'pending' && (out6 as any).reason === 'DELIVERY_UNRESOLVED',
        `a lost reply after commit waits for recovery rather than guessing (${out6.status})`);
    assert(stateOf(KEY_LOST) === 'committed', 'left `committed` — GET_RECEIPT_STATUS decides, and UNKNOWN means wait');
    assert(nodeTotal() === baseline, 'conservation holds on an unresolved delivery');

    // ── 7. The other terminal refusals ────────────────────────────────────────────────────────────
    for (const reason of ['BAD_SIGNATURE', 'RECEIPT_MISMATCH', 'NOT_FOUND']) {
        const key = `orch-${reason.toLowerCase()}`;
        const before = balanceOf(buyer);
        const out = await runOutboundSettlement(
            { key, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
            stubWire({ ...ACCEPTED, key }, { settled: false, reason, message: reason }), OURS, ourKey,
        );
        assert(out.status === 'reversed' && stateOf(key) === 'reversed',
            `${reason} is terminal — they will never honour the receipt, so it reverses (${out.status})`);
        assert(balanceOf(buyer) === before, `and the buyer is made whole after ${reason}`);
    }
    assert(nodeTotal() === baseline, 'conservation holds across every terminal refusal');

    // ── 8. An unrecognised refusal defaults to WAITING, not to refunding ──────────────────────────
    // The fail-safe direction. A future reason code we have never seen, or a garbled reply, must not be
    // able to talk this node into undoing a trade the peer completed.
    const KEY_ALIEN = 'orch-unknown-reason';
    const out8 = await runOutboundSettlement(
        { key: KEY_ALIEN, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
        stubWire({ ...ACCEPTED, key: KEY_ALIEN }, { settled: false, reason: 'SOME_FUTURE_CODE' }), OURS, ourKey,
    );
    assert(out8.status === 'pending' && stateOf(KEY_ALIEN) === 'committed',
        `an unrecognised reason waits (${out8.status}) — only a KNOWN terminal refusal may trigger a refund`);

    // ── 9. Step 1 refuses on its own terms, and records nothing ───────────────────────────────────
    // Below the credit floor: the throw is the buyer's answer, and there is nothing to compensate because
    // nothing was ever held.
    const KEY_BROKE = 'orch-cannot-afford';
    let threw = '';
    try {
        await runOutboundSettlement(
            { key: KEY_BROKE, peerId: PEER, buyerPublicKey: pauper, sellerPublicKey: seller, amount: 100_000 },
            stubWire({ ...ACCEPTED, key: KEY_BROKE }, { settled: true, key: KEY_BROKE }), OURS, ourKey,
        );
    } catch (e: any) { threw = e?.message || String(e); }
    assert(!!threw, `a purchase the buyer cannot fund throws rather than returning an outcome (${threw})`);
    assert(stateOf(KEY_BROKE) === undefined || stateOf(KEY_BROKE) === 'abandoned',
        'and it never becomes a live settlement');
    assert(balanceOf(pauper) === 0, 'the buyer is untouched');

    // ── 10. RETRYING A KEY resumes from the row; it does not start again ──────────────────────────
    // `beginOutboundSettlement` is idempotent on the key, so a retry gets the EXISTING row back. Ignoring
    // that state was a real bug (review finding): the retry path is the one a member hits after a network
    // wobble, which is exactly when it must not misfire. Every retry below passes the SAME payload, because
    // `openSettlement` validates it and a mismatched retry is meant to throw rather than be treated as a hit.

    // A finished key is answered from the row, with no wire traffic at all.
    const retryOk = stubWire({ ...ACCEPTED, key: KEY_OK }, { settled: true, key: KEY_OK });
    const buyerBeforeRetries = balanceOf(buyer);
    const again1 = await runOutboundSettlement(
        { key: KEY_OK, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, postId: 'post-1', amount: PRICE },
        retryOk, OURS, ourKey,
    );
    assert(again1.status === 'settled' && retryOk.asked === 0,
        `retrying a settled key answers from the row without asking again (${again1.status}, ${retryOk.asked} asks)`);
    assert(balanceOf(buyer) === buyerBeforeRetries, 'and does not debit the buyer a second time');

    const again2 = await runOutboundSettlement(
        { key: KEY_NO, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
        stubWire({ ...ACCEPTED, key: KEY_NO }, undefined), OURS, ourKey,
    );
    assert(again2.status === 'refused' && (again2 as any).reason === 'PEER_CAP_EXCEEDED',
        `retrying an abandoned key repeats the original refusal (${again2.status})`);

    const again3 = await runOutboundSettlement(
        { key: KEY_LAPSED, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
        stubWire({ ...ACCEPTED, key: KEY_LAPSED }, undefined), OURS, ourKey,
    );
    assert(again3.status === 'reversed' && (again3 as any).reason === 'CAPACITY_LAPSED',
        `retrying a reversed key repeats the reversal (${again3.status})`);

    // THE HAZARD ITSELF. A `committed` key retried while the peer is unreachable for the ASK. Before the fix
    // the ask ran anyway, threw, and the catch called `abandonOutboundSettlement` on a committed row — which
    // throws `not an unasked hold`, escaping the compensation path entirely, for a settlement we owe outward
    // on. The ask must be skipped: the receipt is already signed, and step 3 replays it byte-for-byte.
    const resumeWire = stubWire(null, { settled: true, key: KEY_RETRY });
    let resumeThrew = '';
    let again4: any;
    try {
        again4 = await runOutboundSettlement(
            { key: KEY_RETRY, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
            resumeWire, OURS, ourKey,
        );
    } catch (e: any) { resumeThrew = e?.message || String(e); }

    assert(!resumeThrew, `retrying a committed key does not throw (${resumeThrew || 'no throw'})`);
    assert(resumeWire.asked === 0,
        `the ask is skipped entirely on a committed row (${resumeWire.asked} asks) — the question was already answered`);
    assert(again4?.status === 'settled' && stateOf(KEY_RETRY) === 'settled',
        `and the retry finishes the trade it resumed (${again4?.status})`);
    assert(balanceOf(buyer) === buyerBeforeRetries, 'with no further debit to the buyer across any retry');

    // ── 10b. A peer's words never reach our member ───────────────────────────────────────────────
    // A refusal arrives from a node we do not control, running a build we did not ship. Its `message` is no
    // more trustworthy than its `error`, so neither is rendered — the member reads our copy, keyed off the
    // reason code, and the peer's text goes to the log for an operator.
    const KEY_HOSTILE = 'orch-hostile-copy';
    const HOSTILE = 'Error: ENOENT /srv/beanpool/secrets — call 1-800-SEND-BEANS';
    const out10 = await runOutboundSettlement(
        { key: KEY_HOSTILE, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: PRICE },
        stubWire({ accepted: false, reason: 'cap_exhausted', message: HOSTILE, error: HOSTILE }, undefined),
        OURS, ourKey,
    );
    assert(!(out10 as any).message.includes('ENOENT') && !(out10 as any).message.includes('SEND-BEANS'),
        `the peer's own text is not shown to our member ("${(out10 as any).message}")`);
    assert((out10 as any).message.includes('not accepting purchases'),
        'our own copy is used instead, chosen by the reason code');
    assert((out10 as any).reason === 'cap_exhausted', 'while the reason CODE is kept, for the row and for operators');

    // ── 10c. A reversal's ledger memo names the cause ────────────────────────────────────────────
    // `NOT_FOUND` reached `reversalMemo` unlisted, so a member whose purchase reversed on the live delivery
    // path read the generic fallback while the same event via recovery (`RECEIPT_NOT_FOUND`) read the real
    // reason (review finding).
    const notFoundMemo = (db.prepare(
        `SELECT memo FROM transactions WHERE memo LIKE ? AND from_pubkey = ?`,
    ).get('%(orch-not_found)%', bridge) as any)?.memo ?? '';
    assert(notFoundMemo.includes('did not complete the sale'),
        `a NOT_FOUND reversal explains itself in the member's own ledger ("${notFoundMemo}")`);

    // ── 11. Every outcome, in one ledger ──────────────────────────────────────────────────────────
    assert(nodeTotal() === baseline,
        `conservation across all ${run} checks: ${nodeTotal()} vs ${baseline} — one settled purchase, five `
        + 'refusals, retries and resumptions, and the node still sums to where it started');
    // The bridge is the tab, so it must equal exactly the purchases that are settled or still owed: the one
    // settled, plus the three left committed. Reversed and abandoned ones must have left no trace on it.
    assert(balanceOf(bridge) === r4(PRICE * 4),
        `the bridge owes exactly the settled + in-flight purchases (${balanceOf(bridge)} = 4 × ${PRICE}) — `
        + 'nothing reversed or abandoned is still sitting on the tab');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ #104 buyer-side orchestration PASSED — no ambiguous answer can trigger a refund.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
