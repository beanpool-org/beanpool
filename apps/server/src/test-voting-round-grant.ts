/**
 * A2-5 regression test — commons voting-round close must:
 *   (a) pick the winner by total QUADRATIC-VOTE WEIGHT, not raw voter count, and
 *   (b) grant the award ATOMICALLY and AUDITABLY — credit the proposer in the DB
 *       (not just in memory), record a COMMONS_POOL→proposer transaction, and keep
 *       the in-memory ledger in lockstep with the DB.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-voting-round-grant.ts
 */
import {
    initStateEngine, createProject, createVotingRound, closeVotingRound, getBalance,
} from './state-engine.js';
import { setCommonsBalance } from '@beanpool/core';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function seedMember(pk: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, pk.slice(0, 8));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}
const dbBalance = (pk: string) => (db.prepare(`SELECT balance FROM accounts WHERE public_key=?`).get(pk) as { balance: number } | undefined)?.balance ?? 0;

async function main() {
    console.log('Running A2-5 voting-round grant test...\n');
    initStateEngine();
    setCommonsBalance(1000);

    const admin = 'admin-' + Date.now();      // invited_by NULL → eligible round creator
    const prop1 = 'p1-' + Date.now();
    const prop2 = 'p2-' + Date.now();
    [admin, prop1, prop2].forEach(seedMember);

    const winnerProj = createProject(prop1, 'High-weight project', 'desc', 100);
    const loserProj = createProject(prop2, 'Many-cheap-votes project', 'desc', 100);
    if (!winnerProj || !loserProj) throw new Error('setup: createProject failed');

    const round = createVotingRound(admin, [winnerProj.id, loserProj.id], new Date(Date.now() + 3600_000).toISOString());
    if (!round) throw new Error('setup: createVotingRound failed');

    // Set votes directly: winner has FEWER voters (1) but MORE weight (5); loser has
    // MORE voters (2) but LESS weight (2). Count-based selection would wrongly pick
    // the loser; weight-based picks the winner.
    const projects = JSON.parse((db.prepare("SELECT value FROM node_config WHERE key='commons_projects'").get() as any).value);
    for (const p of projects) {
        if (p.id === winnerProj.id) p.votes = [{ pubkey: 'v1', weight: 5, creditsUsed: 25 }];
        if (p.id === loserProj.id) p.votes = [{ pubkey: 'v2', weight: 1, creditsUsed: 1 }, { pubkey: 'v3', weight: 1, creditsUsed: 1 }];
    }
    db.prepare(`UPDATE node_config SET value=? WHERE key='commons_projects'`).run(JSON.stringify(projects));

    const commonsBefore = getBalance('COMMONS_POOL').commonsBalance;
    const res = closeVotingRound(round.id);

    assert(res.success && res.winner?.id === winnerProj.id, 'A2-5: winner chosen by vote WEIGHT (5), not voter count (loser had 2 voters)');
    assert(dbBalance(prop1) === 100, 'A2-5: proposer credited in the DB (durable), not just in memory');
    assert(getBalance(prop1).balance === dbBalance(prop1), 'A2-5: in-memory ledger == DB for the proposer (no desync)');

    const tx = db.prepare(`SELECT * FROM transactions WHERE from_pubkey='COMMONS_POOL' AND to_pubkey=? AND amount=100`).get(prop1) as any;
    assert(!!tx, 'A2-5: a COMMONS_POOL→proposer transaction row was recorded (auditable)');

    assert(Math.abs(getBalance('COMMONS_POOL').commonsBalance - (commonsBefore - 100)) < 1e-9, 'A2-5: commons balance debited by the grant (conservation)');
    assert(dbBalance(loserProj.id) === 0 && dbBalance(prop2) === 0, 'A2-5: the losing project / proposer received nothing');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A2-5 voting-round grant checks PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
