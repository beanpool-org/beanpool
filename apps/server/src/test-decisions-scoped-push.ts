/**
 * An enterprise's keepers' vote opened: the push (DESIGN-group-decisions §2.8, slice S2).
 *
 *  1. One push batch per vote, to every keeper on its roll; the proposer is the actor, so the dispatcher drops them.
 *  2. Nobody off the roll is told: not a member, not a keeper of another enterprise, not a suspended keeper.
 *  3. The push names nobody: its kind is `decision.open` (fixed words on the lock screen), and its title, body and data
 *     carry the enterprise's name only — never the vote's title, the member it pays or removes, or the proposer.
 *  4. A push that throws never undoes the vote.
 *
 * In-process, as test-event-notify: the engine is called with a spy where the dispatcher goes.
 *
 * Run: SERVER_SUITES_ONLY=test-decisions-scoped-push node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine, reconcileLedgerFromDb, setUserStatusRow } from './state-engine.js';
import { createScopedDecision, getDecision, type ScopedVotePush } from './decisions-engine.js';
import { PUSH_NOTICE_KINDS } from '@beanpool/core';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const DAY = 86400_000;

function makeMember(callsign: string): string {
    const pk = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit) VALUES (?, ?, ?, 'active', 100)`)
        .run(pk, callsign, new Date(Date.now() - 30 * DAY).toISOString());
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 50, 0)').run(pk);
    return pk;
}

function makeEnterprise(name: string, keepers: string[], balance: number): string {
    const ent = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_treasury, earned_credit, earned_surplus, lifecycle, paused, purpose)
                VALUES (?, ?, ?, 'active', 1, 0, 0, 'ongoing', 0, 'A test enterprise')`)
        .run(ent, name, new Date(Date.now() - 20 * DAY).toISOString());
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)').run(ent, balance);
    keepers.forEach((k, i) => {
        db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_at) VALUES (?, ?, ?, ?)')
            .run(ent, k, i === 0 ? 'lead' : 'keeper', new Date(Date.now() - (10 - i) * DAY).toISOString());
        db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k);
    });
    reconcileLedgerFromDb();
    return ent;
}

interface Call { targets: string[]; actor: string; title: string; body: string; data: Record<string, any>; category: string; kind: string }
let calls: Call[] = [];
const spy: ScopedVotePush = (targets, actor, title, body, data, category, kind) => { calls.push({ targets, actor, title, body, data, category, kind }); };
/** The dispatcher drops the actor itself; read as "who was told". */
const told = (c: Call | undefined) => (c?.targets ?? []).filter(t => t !== c!.actor).sort();

async function main(): Promise<void> {
    initStateEngine();

    const ann = makeMember('AnnSecretname');
    const bob = makeMember('BobSecretname');
    const cat = makeMember('CatSecretname');
    const dee = makeMember('DeeSecretname');
    const stranger = makeMember('StrangerSecretname');
    const otherKeeper = makeMember('OtherKeeperSecretname');
    const bakery = makeEnterprise('Corner Bakery', [ann, bob, cat, dee], 200);
    makeEnterprise('Tool Library', [otherKeeper, stranger], 50);
    // Dee's account is suspended (disabled): off the roll, so not told.
    setUserStatusRow(dee, 'disabled');

    console.log('\n--- 1. One batch, every keeper on the roll ---');
    calls = [];
    const pay = createScopedDecision({
        scopeKind: 'enterprise', scopeId: bakery, authorPubkey: ann, title: 'Pay StrangerSecretname for the oven',
        description: 'StrangerSecretname fixed the oven door.', effect: 'pay_out', params: { to: stranger, amount: 40, memo: 'Oven door' },
    } as any, spy);
    assert(getDecision(pay.id)?.status === 'open', 'the vote opened');
    assert(calls.length === 1, `one push batch for the vote (${calls.length})`);
    assert(told(calls[0]).join() === [bob, cat].sort().join(), 'Bob and Cat (on the roll) are told; Ann proposed it');
    assert(calls[0]?.actor === ann, 'the proposer is the actor, so the dispatcher drops them');
    assert(calls[0]?.targets.filter(t => t === bob).length === 1 && calls[0]?.targets.filter(t => t === cat).length === 1,
        'each elector once');

    console.log('\n--- 2. Nobody off the roll ---');
    assert(!calls[0]?.targets.includes(dee), 'a suspended keeper is not told');
    assert(!calls[0]?.targets.includes(stranger), 'the member it pays (not a keeper) is not told');
    assert(!calls[0]?.targets.includes(otherKeeper), "another enterprise's keeper is not told");

    console.log('\n--- 3. It names nobody ---');
    const c = calls[0];
    assert(c?.kind === 'decision.open' && 'decision.open' in PUSH_NOTICE_KINDS, 'kind decision.open, one of the fixed kinds');
    assert(PUSH_NOTICE_KINDS['decision.open'].body === 'A vote opened in one of your groups.', "the lock screen's fixed words name nobody");
    assert(c?.category === 'chat', "it goes on the chat category, so the member's notify_chat setting applies");
    const words = JSON.stringify({ title: c?.title, body: c?.body, data: c?.data });
    assert(words.includes('Corner Bakery'), `the details say which enterprise (${words})`);
    assert(!/secretname/i.test(words), 'no member is named: not the proposer, the keepers, or the member it pays');
    assert(![ann, bob, cat, dee, stranger].some(pk => words.includes(pk) || words.includes(pk.slice(0, 12))), 'and no key');
    assert(!words.includes('Oven') && !words.includes('40'), "nothing of the vote's own words or amount");

    console.log('\n--- 4. A remove vote names nobody either; a push that throws never undoes the vote ---');
    calls = [];
    const remove = createScopedDecision({
        scopeKind: 'enterprise', scopeId: bakery, authorPubkey: bob, title: 'Remove CatSecretname', description: 'CatSecretname has gone quiet.',
        effect: 'remove_keeper', subject: cat,
    } as any, spy);
    assert(calls.length === 1 && told(calls[0]).join() === [ann, cat].sort().join(), 'Ann and Cat are told (Cat is on the roll of a vote on Cat)');
    assert(!/secretname/i.test(JSON.stringify(calls[0])), 'the push about removing Cat does not name Cat');
    assert(getDecision(remove.id)?.status === 'open', 'that vote opened');
    const thrown = createScopedDecision({
        scopeKind: 'enterprise', scopeId: bakery, authorPubkey: cat, title: 'Make Bob the lead', description: 'Bob is here most days.',
        effect: 'replace_lead', subject: bob,
    } as any, () => { throw new Error('Expo down'); });
    assert(getDecision(thrown.id)?.status === 'open', 'a push that throws: the vote is still open');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
