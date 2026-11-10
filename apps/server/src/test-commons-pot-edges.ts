/**
 * Paying from a Commons pot that isn't a number moves nothing (confirmation of #1445, NB-3, 2026-10-02).
 *
 * The pot is the COMMONS_BALANCE global. It was not a finite number when its COMMONS_POOL row held ±Infinity at boot,
 * and it is unknown (NaN) when the row held text or NULL (NB-1, test-takeover-infinite-balance covers the boot); since
 * whole hundredths a row is read as a safe integer or NaN, so a ±Infinity row reads back as the unknown pot too. Every
 * write of the pot refuses such a value (engine/audit.ts persistCommonsBalance), so a payment that moved the recipient
 * first and wrote the pot last was a half-move: `payFromCommons(…, { allowDeficit })` outside a conservingTransaction
 * credited the recipient, wrote the history row, and only then threw at the pot's flush. The credit stayed and the
 * pot's debit was never written: Beans minted, and the audit counted them as drift once the pot was mended.
 *
 * Checked here, in one process, for a pot of NaN, Infinity and -Infinity:
 *   1. a healthy pot still pays, inside the deficit and into it, and the conservation audit stays ok (no change);
 *   2. payFromCommons, with and without allowDeficit, called outside any transaction: refused (null, no throw), and the
 *      recipient's balance in memory and in its row, the history and the pot's row are all as they were;
 *   3. fundCommission (the one caller outside a conservingTransaction) refuses in the plain words every Bean move gives
 *      while the pot is unknown (COMMONS_POT_PAUSED), and nothing moves; so does a send, as a CommonsPotUnknownError;
 *   4. once the row and the pot are set back to what they held, the conservation audit is ok: nothing was minted or lost.
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-commons-pot-edges.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

import crypto from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { setCommonsBalance, COMMONS_BALANCE } from '@beanpool/core';
import {
    initStateEngine, reconcileLedgerFromDb, getCommonsBalanceExact, payFromCommons, runLedgerAudit, createTreasury, transfer,
} from './state-engine.js';
import * as auditModule from './engine/audit.js';

// The words every Bean move gives while the pot is unknown (engine/audit.ts), written out so this suite still runs, and
// fails by count, on a tree without them.
const COMMONS_POT_PAUSED = 'Payments are paused on this community while its admins fix a problem with its accounts. Nothing has moved.';
import { ledger } from './engine/ledger.js';
import { db } from './db/db.js';
import { addConnector, setConnectorCreditCap } from './connector-manager.js';
import { ensureBridgeAccount, bridgeAccountId } from './federation-bridge.js';
import { ensureFederationLink, setCommissionCeiling } from './federation-link.js';
import { fundCommission } from './federation-commission.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/**
 * The story's figures are Beans; the node's are whole hundredths (1 Bean = 100). `hc` turns a Beans figure into hundredths,
 * and the pot, the rows and the audit's drift are compared as the integers they are, exactly.
 */
const hc = (beans: number) => Math.round(beans * 100);

/** `balance` is the story's Beans; each member has 500 Beans of earned credit. */
function makeMember(callsign: string, balance: number): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit_c) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`)
        .run(pk, callsign, hc(500));
    // Epoch at now: epoch 0 would charge ~56 years of demurrage at the first read.
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, ?, ?)').run(pk, hc(balance), ledger.getCurrentEpoch());
    reconcileLedgerFromDb();
    return pk;
}

const potRow = () => db.prepare("SELECT balance_c, typeof(balance_c) AS t FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as { balance_c: unknown; t: string };
const rowBalance = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c;
const txCount = () => (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
/** Everything a payment could touch, as one string to compare. */
const snapshot = (pks: string[]) => JSON.stringify({
    rows: pks.map((pk) => [pk, rowBalance(pk), ledger.getAccount(pk).balance_c]),
    pot: potRow(), memory: String(COMMONS_BALANCE), tx: txCount(),
});

function attempt<T>(fn: () => T): { value?: T; threw?: string } {
    try { return { value: fn() }; } catch (e: any) { return { threw: String(e?.message || e) }; }
}

async function main(): Promise<void> {
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') throw new Error('Run with ENABLE_PEER_CONNECTORS=true: connector reads short-circuit otherwise');
    initStateEngine();

    const ben = makeMember('Ben', 0);
    const cara = makeMember('Cara', 0);

    // ── 1. A healthy pot: unchanged behaviour ───────────────────────────────────────────────
    console.log('\n── 1. a healthy pot still pays, and the ledger adds up ──');
    setCommonsBalance(hc(20));
    db.prepare("UPDATE accounts SET balance_c = ? WHERE public_key = 'COMMONS_POOL'").run(hc(20));
    db.prepare("DELETE FROM node_config WHERE key = 'ledger_audit_baseline'").run();
    const base = runLedgerAudit();
    assert(base.ok && base.badBalances === 0, `the starting ledger adds up (${JSON.stringify(base)})`);

    const paid = payFromCommons(ben, hc(5), 'a commons grant');
    assert(paid && paid.from === 'COMMONS_POOL' && rowBalance(ben) === hc(5) && getCommonsBalanceExact() === hc(15) && potRow().balance_c === hc(15),
        `5 paid from a pot of 20 outside any transaction: Ben's row 5, the pot 15 in memory and in its row (${rowBalance(ben)}, ${getCommonsBalanceExact()}, ${potRow().balance_c} hundredths)`);
    const refused = payFromCommons(ben, hc(50), 'more than the pot holds');
    assert(refused === null && rowBalance(ben) === hc(5) && getCommonsBalanceExact() === hc(15), 'more than the pot holds, with no deficit allowed: refused, nothing moves');
    const deficit = payFromCommons(cara, hc(25), 'a write-off into deficit', { allowDeficit: true });
    assert(deficit && rowBalance(cara) === hc(25) && getCommonsBalanceExact() === -hc(10) && potRow().balance_c === -hc(10),
        `25 paid with a deficit allowed: Cara's row 25, the pot -10 in memory and in its row (${rowBalance(cara)}, ${getCommonsBalanceExact()}, ${potRow().balance_c} hundredths)`);
    const healthy = runLedgerAudit();
    assert(healthy.ok && healthy.drift === 0 && healthy.badBalances === 0, `the ledger still adds up, exactly (${JSON.stringify(healthy)})`);

    // ── The federation link fundCommission draws for ──────────────────────────────────────────
    const peerKey = await generateKeyPair('Ed25519');
    const PEER = peerIdFromPrivateKey(peerKey).toString();
    const PEER_ADDR = `/dns4/byron.beanpool.org/tcp/4001/p2p/${PEER}`;
    addConnector(PEER_ADDR, 'peer', 'byron', 'https://byron.beanpool.org');
    setConnectorCreditCap(PEER_ADDR, hc(500));
    const link = ensureFederationLink(PEER, 'byron', createTreasury)!;
    ensureBridgeAccount(PEER);
    db.prepare('UPDATE accounts SET balance_c = 0 WHERE public_key = ?').run(bridgeAccountId(PEER));
    reconcileLedgerFromDb();
    setCommissionCeiling(PEER, hc(500));
    assert(link && rowBalance(link.treasuryPubkey) !== undefined, 'a federation link with an empty enterprise to fund');

    // A healthy pot funds a commission, as before.
    setCommonsBalance(hc(200));
    db.prepare("UPDATE accounts SET balance_c = ? WHERE public_key = 'COMMONS_POOL'").run(hc(200));
    db.prepare("DELETE FROM node_config WHERE key = 'ledger_audit_baseline'").run();
    runLedgerAudit();
    const funded = fundCommission(PEER, hc(10));
    // 10 and its fee of 0.15 (1.5% of 1000 hundredths, a whole 15): the pot gives 1015 hundredths.
    assert(funded.ok === true && funded.drawnFromCommons === hc(10.15) && getCommonsBalanceExact() === hc(189.85),
        `a commission of 10 draws 10.15 from a pot of 200 (${JSON.stringify(funded).slice(0, 160)}, pot ${getCommonsBalanceExact()})`);
    const afterFund = runLedgerAudit();
    assert(afterFund.ok, `and the ledger adds up (${JSON.stringify(afterFund)})`);
    db.prepare('UPDATE accounts SET balance_c = 0 WHERE public_key = ?').run(link.treasuryPubkey);
    setCommonsBalance(getCommonsBalanceExact() + hc(10.15));
    db.prepare("UPDATE accounts SET balance_c = ? WHERE public_key = 'COMMONS_POOL'").run(getCommonsBalanceExact());
    reconcileLedgerFromDb();

    // ── 2–4. A pot that isn't a number ───────────────────────────────────────────────────────
    for (const pot of [NaN, Infinity, -Infinity]) {
        console.log(`\n── a pot of ${pot} in memory ──`);
        const rowBefore = potRow();
        // As a boot leaves it: the row holds what makes the pot so (text for the unknown pot, ±9e999 for ±Infinity), and
        // the pot in memory is what the row gives. A failed move's resync reads the row back, so the two must agree.
        // Whole hundredths: a row is read as a safe integer or as the unknown pot, NaN (state-engine.ts commonsPotFromRow),
        // so ±9e999 now reads back as NaN too, and a pot of ±Infinity in memory is one no boot leaves. It is still refused
        // by every move below; the first refusal that resyncs memory to the rows (the send's) leaves the pot the row gives.
        const broken = Number.isNaN(pot) ? "'abc'" : pot > 0 ? '9e999' : '-9e999';
        db.prepare(`UPDATE accounts SET balance_c = ${broken} WHERE public_key = 'COMMONS_POOL'`).run();
        const brokenRow = potRow();
        setCommonsBalance(pot);
        const keys = [ben, cara, link.treasuryPubkey];
        const before = snapshot(keys);
        /** The same, with memory holding the pot this row gives: the unknown pot (NaN) for text and for ±9e999 alike. */
        const asTheRowGives = (snap: string) => snap.replace(`"memory":"${String(pot)}"`, '"memory":"NaN"');

        const withDeficit = attempt(() => payFromCommons(ben, hc(1), 'a grant with a deficit allowed', { allowDeficit: true }));
        assert(withDeficit.threw === undefined && withDeficit.value === null,
            `payFromCommons with allowDeficit, outside any transaction, is refused with null, not a throw (${withDeficit.threw ?? JSON.stringify(withDeficit.value)?.slice(0, 80)})`);
        assert(snapshot(keys) === before, `nothing moved: Ben's balance in memory and in its row, the history, the pot's row (${snapshot(keys)} vs ${before})`);

        const without = attempt(() => payFromCommons(cara, hc(1), 'a grant'));
        assert(without.threw === undefined && without.value === null && snapshot(keys) === before, `without allowDeficit: null, nothing moved (${without.threw ?? 'null'})`);

        const commission = attempt(() => fundCommission(PEER, hc(10)));
        const c = commission.value as any;
        assert(commission.threw === undefined && c?.ok === false && c?.reason === 'commons_not_a_number',
            `fundCommission refuses: the pot isn't a number (${commission.threw ?? JSON.stringify(c).slice(0, 200)})`);
        assert(c?.message === COMMONS_POT_PAUSED, `in the plain words every Bean move gives (${c?.message})`);
        assert(snapshot(keys) === before, 'and nothing moved');

        // Any other move (here a send from genesis, past every gate): refused with the plain words, as a
        // CommonsPotUnknownError a route answers 503, and nothing moves (#1465 review, NB-2). Its refusal resyncs memory to
        // the rows: no Bean moves, and the pot in memory is the one the row gives.
        const sent = attempt(() => transfer('genesis', ben, hc(1), 'a send', 'direct', true));
        assert(sent.threw === COMMONS_POT_PAUSED && snapshot(keys) === asTheRowGives(before),
            `a send is refused in plain words, nothing moved, the pot in memory the unknown pot its row gives (${sent.threw ?? 'no throw'}; ${snapshot(keys)} vs ${asTheRowGives(before)})`);
        let caught: unknown = null;
        try { transfer('genesis', ben, hc(1), 'a send', 'direct', true); } catch (e) { caught = e; }
        const PotError = (auditModule as Record<string, unknown>).CommonsPotUnknownError as (new () => Error) | undefined;
        assert(!!PotError && caught instanceof PotError && (caught as { code?: string }).code === 'COMMONS_POT_UNKNOWN', 'thrown as a CommonsPotUnknownError');

        // The pot set back to what its row holds, as the operator's repair does: the books add up, nothing minted or lost.
        assert(JSON.stringify(potRow()) === JSON.stringify(brokenRow) && String(COMMONS_BALANCE) === 'NaN',
            `the pot's row was never written, and the pot is the unknown pot its row gives, NaN (was ${pot}) (${JSON.stringify(potRow())}, ${String(COMMONS_BALANCE)})`);
        db.prepare("UPDATE accounts SET balance_c = ? WHERE public_key = 'COMMONS_POOL'").run(rowBefore.balance_c);
        setCommonsBalance(rowBefore.balance_c as number);
        const audit = runLedgerAudit();
        assert(audit.ok && audit.badBalances === 0 && audit.drift === 0, `with the pot mended, the ledger adds up, exactly (${JSON.stringify(audit)})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
