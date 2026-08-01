/**
 * Inter-node energy balances and the per-peer credit cap (#104, step 1).
 *
 * Spec: docs/federation-economics.md §2.2 / §2.4 / §3.2.
 *
 * What these checks pin:
 *   1. A bridge row is a synthetic account — not addressable, not decayable.
 *   2. The sign convention (Rule 2): positive = owed outward, negative = credit extended.
 *   3. The cap has NO DEFAULT, so an unconfigured peer is fail-closed — and that is the same state
 *      the #102 kill switch already produces, rather than a new path.
 *   4. The cap is ONE-WAY: it bounds only credit extended, so flow that brings the balance back toward
 *      zero is never blocked. A check like abs(balance) > cap would freeze a drained community.
 *
 * MUST run with ENABLE_PEER_CONNECTORS=true — getConnectors()/getPeerOrigins() short-circuit otherwise,
 * and the flag is a module-level const read at import (ES imports are hoisted above the module body).
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-federation-bridge.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { isSyntheticAccount, bridgeAccountId, peerFromBridgeAccountId } from '@beanpool/core';
import { initStateEngine, transfer, reconcileLedgerFromDb } from './state-engine.js';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { addConnector, setConnectorCreditCap, getConnectorCreditCap } from './connector-manager.js';
import {
    ensureBridgeAccount, registerBridgeDecayExemptions, getEnergyBalance,
    creditExtendedTo, settlementCapacity, listEnergyBalances, totalEnergyPosition,
} from './federation-bridge.js';

const PEER = 'byron.beanpool.org';
const PEER_ID = '12D3KooWByronTestPeerId';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const balanceOf = (pk: string): number =>
    (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as any)?.balance ?? 0;

function makeMember(callsign: string, balance: number) {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 500)`).run(pk, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(pk, balance);
    return pk;
}

async function main() {
    console.log('Running inter-node energy balance tests (#104 step 1)...\n');
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') {
        throw new Error('Run with ENABLE_PEER_CONNECTORS=true — connector reads short-circuit otherwise');
    }
    initStateEngine();

    // ── 1. A bridge row is synthetic ────────────────────────────────────────────
    const bridge = ensureBridgeAccount(PEER_ID);
    assert(bridge === `bridge_${PEER_ID}`, 'bridgeAccountId is bridge_<peerId>');
    assert(peerFromBridgeAccountId(bridge) === PEER_ID, 'the peer id round-trips out of the account id');
    assert(isSyntheticAccount(bridge) === true, 'a bridge account is a synthetic account');
    assert(isSyntheticAccount('escrow_x') && isSyntheticAccount('COMMONS_POOL'), 'the shared predicate still covers the pre-existing synthetics');
    assert(isSyntheticAccount(makeMember('RealPerson', 0)) === false, 'a real member is not synthetic');
    assert(isSyntheticAccount(undefined) === false, 'a missing id is not synthetic (guards may run pre-validation)');
    assert(!!db.prepare('SELECT 1 FROM accounts WHERE public_key=?').get(bridge), 'the account row exists');
    assert(ensureBridgeAccount(PEER_ID) === bridge, 'ensureBridgeAccount is idempotent');
    const seeded = db.prepare('SELECT last_demurrage_epoch AS e FROM accounts WHERE public_key=?').get(bridge) as any;
    assert(seeded.e > 0 && seeded.e >= ledger.getCurrentEpoch() - 1,
        'seeded at the CURRENT epoch, not 0 — epoch 0 would be ~56 years of compound decay if ever unexempt');

    // ── 2. Not decayable ────────────────────────────────────────────────────────
    // Push it positive, then run the ledger far into the future. A member balance would erode.
    // The decay check needs a BALANCE, not a transfer — set it directly and resync the in-memory
    // ledger, rather than routing through member send-gates that are irrelevant here.
    const memberCtl = makeMember('ControlHolder', 1000);
    const funder = makeMember('Funder', 3000);
    db.prepare('UPDATE accounts SET balance=?, last_demurrage_epoch=? WHERE public_key=?')
        .run(1000, ledger.getCurrentEpoch(), bridge);
    reconcileLedgerFromDb();
    assert(balanceOf(bridge) === 1000, 'the bridge really holds 1000 before the decay run');

    // Run the ledger far into the future. A non-exempt balance of 1000 sits in the 1.5%/mo bracket, so
    // a member control MUST erode while the bridge must not — that contrast is what makes this a test
    // rather than a tautology.
    const before = balanceOf(bridge);
    const futureEpoch = ledger.getCurrentEpoch() + 720;   // ~24 months
    const ctlBefore = ledger.getAccount(memberCtl).balance;
    (ledger as any).applyDecay?.((ledger as any).accounts?.get(bridge), futureEpoch);
    (ledger as any).applyDecay?.((ledger as any).accounts?.get(memberCtl), futureEpoch);
    assert(ledger.getAccount(bridge).balance === before, 'a bridge balance does not decay');
    assert(ledger.getAccount(memberCtl).balance < ctlBefore, 'a MEMBER balance of the same size does decay — the exemption is doing real work');
    assert(registerBridgeDecayExemptions() >= 1, 'boot re-registration finds existing bridge accounts');

    // ── 2b. An UNSEEDED bridge account must still persist (review finding) ──────
    // ledger.getAccount() auto-creates in memory, but transfer() persisted with a bare UPDATE, which
    // matched 0 rows for an account SQLite had never seen — silently desyncing memory from disk forever.
    const UNSEEDED = '12D3KooWNeverSeededPeer';
    const unseededId = bridgeAccountId(UNSEEDED);
    assert(!db.prepare('SELECT 1 FROM accounts WHERE public_key=?').get(unseededId), 'the account genuinely does not exist yet');
    assert(!!transfer(funder, unseededId, 25, 'settle into an unseeded bridge', 'escrow', true), 'the transfer succeeded');
    assert(!!db.prepare('SELECT 1 FROM accounts WHERE public_key=?').get(unseededId), 'transferring to an unseeded bridge CREATES the DB row');
    assert(getEnergyBalance(UNSEEDED) === 25, 'and the balance is readable from SQLite — no memory/DB desync');

    // ── 3. Sign convention ──────────────────────────────────────────────────────
    db.prepare('UPDATE accounts SET balance=? WHERE public_key=?').run(0, bridge);
    assert(getEnergyBalance(PEER_ID) === 0, 'a fresh energy balance is 0 — square');

    db.prepare('UPDATE accounts SET balance=? WHERE public_key=?').run(40, bridge);
    assert(getEnergyBalance(PEER_ID) === 40, 'positive = value taken from our member, owed outward');
    assert(creditExtendedTo(PEER_ID) === 0, 'owing outward is NOT credit extended');

    db.prepare('UPDATE accounts SET balance=? WHERE public_key=?').run(-40, bridge);
    assert(getEnergyBalance(PEER_ID) === -40, 'negative = we minted locally against a claim');
    assert(creditExtendedTo(PEER_ID) === 40, 'the negative magnitude IS the credit we have extended');

    // ── 4. No default cap → fail closed ─────────────────────────────────────────
    addConnector(PEER, 'peer', 'Byron', `https://${PEER}`);
    assert(getConnectorCreditCap(PEER) === null, 'a new peer has NO credit cap — there is no default');
    const unset = settlementCapacity(PEER_ID, PEER, 5);
    assert(unset.ok === false && unset.reason === 'no_cap_configured', 'settlement is refused while no cap is set');
    assert(!unset.ok && /limit/i.test(unset.message), 'the refusal explains an operator must choose a limit');

    // ── 5. A configured cap, and exhausting it ──────────────────────────────────
    setConnectorCreditCap(PEER, 100);
    assert(getConnectorCreditCap(PEER) === 100, 'the cap persists on the connector record');
    const room = settlementCapacity(PEER_ID, PEER, 5);
    assert(room.ok === true && room.headroom === 60, `headroom is cap − extended (100 − 40 = 60, got ${room.ok ? room.headroom : 'n/a'})`);

    const tooMuch = settlementCapacity(PEER_ID, PEER, 61);
    assert(tooMuch.ok === false && tooMuch.reason === 'cap_exhausted', 'a request beyond headroom is refused as cap_exhausted');
    assert(!tooMuch.ok && tooMuch.reason === 'cap_exhausted' && /buy from us/i.test(tooMuch.message),
        'the exhausted message points at the cure — they can buy from us');
    assert(settlementCapacity(PEER_ID, PEER, 60).ok === true, 'exactly the headroom is allowed');

    // ── 6. The cap is ONE-WAY — the cure is never blocked ───────────────────────
    // Drive the balance to the cap, then confirm movement back toward zero is unaffected.
    db.prepare('UPDATE accounts SET balance=? WHERE public_key=?').run(-100, bridge);
    assert(settlementCapacity(PEER_ID, PEER, 1).ok === false, 'at the cap, extending more is refused');

    // Now the peer's members buy from us: our bridge moves POSITIVE, past zero.
    db.prepare('UPDATE accounts SET balance=? WHERE public_key=?').run(250, bridge);
    const wayPositive = settlementCapacity(PEER_ID, PEER, 50);
    assert(wayPositive.ok === true, 'a large POSITIVE balance does not trip the cap — it is not abs(balance)');
    assert(wayPositive.ok && wayPositive.extended === 0, 'credit extended is 0 while the balance is positive');

    // Headroom is `cap + balance`, not `cap`. The rule is that the balance may not fall BELOW −cap, so a
    // +250 position with a cap of 100 can absorb 350 of payments before it would extend any credit at all.
    //
    // This assertion previously expected 100, which quietly encoded the bug a reviewer later found: taking
    // `max(0, −balance)` discarded the positive side, so with a small cap the REBALANCING direction — the
    // one §3.2 insists must stay open — was refused. A test can make a bug look deliberate; this is what
    // that looks like.
    assert(wayPositive.ok && wayPositive.headroom === 350,
        'headroom is measured from the signed balance: 250 owed outward plus a 100 cap = 350');
    assert(settlementCapacity(PEER_ID, PEER, 350).ok === true, 'so a payment that lands exactly on −cap is allowed');
    assert(settlementCapacity(PEER_ID, PEER, 350.01).ok === false, 'and one bean past it is not');

    // The case that matters most: a ZERO cap must still let the balance be paid back down to zero.
    setConnectorCreditCap(PEER, 0);
    assert(settlementCapacity(PEER_ID, PEER, 250).ok === true,
        'with a cap of ZERO, paying the whole positive balance down to zero is still allowed — it extends nothing');
    assert(settlementCapacity(PEER_ID, PEER, 250.01).ok === false, 'while a single bean beyond zero is refused');
    setConnectorCreditCap(PEER, 100);

    // Clearing the cap returns to fail-closed — an operator kill switch that keeps discovery open.
    setConnectorCreditCap(PEER, null);
    assert(getConnectorCreditCap(PEER) === null, 'a cap can be cleared');
    const recleared = settlementCapacity(PEER_ID, PEER, 1);
    assert(!recleared.ok && recleared.reason === 'no_cap_configured', 'clearing the cap re-closes settlement');
    setConnectorCreditCap(PEER, 100);

    // ── 7. Guards + the operator view ───────────────────────────────────────────
    let threw = '';
    try { setConnectorCreditCap(PEER, -5); } catch (e: any) { threw = e.message; }
    assert(/non-negative/.test(threw), `a negative cap is rejected rather than coerced (got "${threw}")`);
    assert(setConnectorCreditCap('nope.example', 10) === null, 'setting a cap on an unknown connector returns null');

    const listed = listEnergyBalances().find(b => b.address === PEER);
    assert(!!listed, 'the peer appears in the operator energy-balance view');
    assert(listed!.cap === 100, 'the view carries the configured cap');
    // Never connected in this test, so there is no peerId — and the view must NOT guess by falling back
    // to the address, which would report a different account's position as this peer's.
    assert(listed!.peerId === null, 'an unconnected peer reports no peerId rather than guessing');
    assert(listed!.balance === 0 && listed!.settleable === false,
        'no known peerId means no balance and NOT settleable — fail closed on either missing piece');
    assert(typeof totalEnergyPosition() === 'number', 'the total position is readable for audits');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Inter-node energy balance checks PASSED (#104 step 1).');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
