/**
 * An enterprise's keepers' vote (DESIGN-group-decisions §2, slice S1) — over a REAL HTTPS round trip, through the
 * signature middleware. The enterprise is the PATH's; the actor is the signer; the tick carries a vote out.
 *
 * Verifies (§4 row S1):
 *  - A 3-keeper enterprise pays 40 Beans by 2–1, closing early once all have voted; the 1.5% fee lands in the Commons
 *    (where a Need's payment fee lands); the ledger line is signed by the Decision; ledger conservation before and after
 *    (reconcileLedgerFromDb).
 *  - While open every read shows turnout only (no Yes / No); at close the split.
 *  - A 2-keeper roll needs both; a one-keeper enterprise holds no vote; a wage to a keeper is refused without surplus.
 *  - A non-keeper gets 404 on the list, the detail, propose and vote; a keeper of enterprise A gets 404 on enterprise B.
 *  - A forged roll can't be made through the body; a replayed vote counts once; a vote can't be changed.
 *  - A keeper who steps down mid-vote drops (their vote with them); a removed keeper's vote stands.
 *  - Wind-up voids an open vote; a paused enterprise still pays; a standby carries out nothing.
 *  - The community's list never carries a scoped vote, and its detail and vote routes answer it as missing.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: node scripts/run-server-suite.mjs test-decisions-scoped (or via scripts/server-suites.mjs)
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, tickDecisions, reconcileLedgerFromDb, stepDownAsKeeper, removeKeeperByVote, setNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { getCommonsBalanceExact } from './state-engine.js';
import { ROLL_OF_ONE, WAGE_NEEDS_SURPLUS, WINDING_UP_VOID, SCOPED_ALREADY_VOTED } from './decisions-engine.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
const DAY = 86400_000;

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pubKeyHex, privateKey };
}

function makeMember(callsign: string, balance = 50): Id {
    const id = keypair();
    const joinedAt = new Date(Date.now() - 30 * DAY).toISOString();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit)
                VALUES (?, ?, ?, 'active', 100)`).run(id.pubKeyHex, callsign, joinedAt);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(id.pubKeyHex, balance);
    return id;
}

/** An enterprise with these keepers (the first is the lead), holding `balance`. */
function makeEnterprise(name: string, keepers: Id[], balance: number, opts: { paused?: boolean; lifecycle?: 'ongoing' | 'bounded'; surplus?: number } = {}): string {
    const ent = keypair().pubKeyHex;
    const created = new Date(Date.now() - 20 * DAY).toISOString();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_treasury, earned_credit, earned_surplus, lifecycle, paused, purpose)
                VALUES (?, ?, ?, 'active', 1, 0, ?, ?, ?, 'A test enterprise')`)
        .run(ent, name, created, opts.surplus ?? 0, opts.lifecycle ?? 'ongoing', opts.paused ? 1 : 0);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(ent, balance);
    keepers.forEach((k, i) => {
        db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_at) VALUES (?, ?, ?, ?)`)
            .run(ent, k.pubKeyHex, i === 0 ? 'lead' : 'keeper', new Date(Date.now() - (10 - i) * DAY).toISOString());
        db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k.pubKeyHex);
    });
    reconcileLedgerFromDb();
    return ent;
}

type Signed = { status: number; body: any; error?: string; replay: () => Promise<{ status: number; body: any }> };

/** The replay-proof scheme the real middleware requires: method + path + timestamp + nonce + body. */
async function signedFetch(method: 'GET' | 'POST', path: string, body: unknown, id: Id | null): Promise<Signed> {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const send = async () => {
        const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
        let json: any;
        try { json = await res.json(); } catch { /* not JSON */ }
        return { status: res.status, body: json };
    };
    const first = await send();
    return { ...first, error: first.body?.error, replay: send };
}

const balanceOf = (pk: string) => Number((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as any)?.balance ?? NaN);
const row = (id: string) => db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as any;
const totalSupply = () => Number((db.prepare("SELECT SUM(balance) AS s FROM accounts").get() as any).s);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function propose(ent: string, by: Id, body: Record<string, unknown>) {
    return signedFetch('POST', `/api/enterprise/${ent}/decisions`, {
        title: 'Pay for the stall repairs', description: 'The stall roof leaks and Ali fixed it last week.', ...body,
    }, by);
}
const vote = (ent: string, id: string, by: Id, support: boolean) => signedFetch('POST', `/api/enterprise/${ent}/decisions/${id}/vote`, { support }, by);
const detail = (ent: string, id: string, by: Id) => signedFetch('GET', `/api/enterprise/${ent}/decisions/${id}`, null, by);
const list = (ent: string, by: Id) => signedFetch('GET', `/api/enterprise/${ent}/decisions`, null, by);

function hasNoSplit(t: any): boolean {
    return !!t && !('yes' in t) && !('no' in t) && !('yesWeight' in t) && !('noWeight' in t) && !('supportRatio' in t);
}

async function main(): Promise<void> {
    console.log('\nAn enterprise\'s keepers\' vote, over real HTTPS\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const ali = makeMember('Ali');           // the one paid
    const outsider = makeMember('Olive');    // a member who keeps nothing
    const [k1, k2, k3] = [makeMember('Kai'), makeMember('Kim'), makeMember('Kit')];
    const e1 = makeEnterprise('Bakery', [k1, k2, k3], 100);

    // ── 1. 3 keepers pay 40 by 2–1, early close, fee, conservation ─────────────────────────────────────
    const supplyBefore = totalSupply();
    const commonsBefore = getCommonsBalanceExact();
    const p1 = await propose(e1, k1, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 40 } });
    assert(p1.status === 200 && p1.body?.decision?.scopeKind === 'enterprise' && p1.body.decision.scopeId === e1,
        `a keeper proposes a 40-Bean pay-out in the enterprise (got ${p1.status} ${p1.error ?? ''})`);
    const d1 = p1.body?.decision?.id as string;
    const closesAt7d = Date.parse(row(d1).closes_at);
    assert(Math.abs(closesAt7d - Date.now() - 7 * DAY) < 60_000, 'the window is 7 days');
    assert((db.prepare('SELECT COUNT(*) AS n FROM decision_electors WHERE decision_id = ?').get(d1) as any).n === 3, 'the roll is frozen at three keepers');

    assert((await vote(e1, d1, k1, true)).status === 200, 'the first keeper votes yes');
    assert((await vote(e1, d1, k3, false)).status === 200, 'the third keeper votes no');
    tickDecisions();
    assert(row(d1).status === 'open', `one yes and one no out of three: still open (got ${row(d1).status})`);
    const open1 = await detail(e1, d1, k2);
    assert(open1.status === 200 && open1.body.decision.tally.voted === 2 && open1.body.decision.tally.roll === 3 && hasNoSplit(open1.body.decision.tally),
        `while open the detail shows turnout only: 2 of 3, no Yes/No (got ${JSON.stringify(open1.body?.decision?.tally)})`);
    const openList = await list(e1, k2);
    assert(openList.status === 200 && openList.body.decisions.every((d: any) => d.status !== 'open' || hasNoSplit(d.tally)),
        'while open the list shows turnout only');
    assert(openList.body.decisions[0]?.myVote === null, 'a keeper who has not voted sees no vote of theirs');

    assert((await vote(e1, d1, k2, true)).status === 200, 'the second keeper votes yes: 2–1');
    tickDecisions();
    const r1 = row(d1);
    assert(r1.status === 'executed', `the tick closes it early and carries it out (got ${r1.status} ${r1.execution_error ?? r1.execution_reason ?? ''})`);
    assert(Date.parse(r1.closes_at) < closesAt7d - DAY, 'it closed well before its 7 days');
    assert(near(balanceOf(ali.pubKeyHex), 50 + 40 * 0.985), `Ali receives 40 less the 1.5% fee: 39.40 (got ${balanceOf(ali.pubKeyHex)})`);
    assert(near(balanceOf(e1), 60), `the enterprise pays 40 out of what it holds (got ${balanceOf(e1)})`);
    assert(near(getCommonsBalanceExact() - commonsBefore, 0.6), `the 0.60 fee lands in the Commons, as a Need's payment fee does (got ${getCommonsBalanceExact() - commonsBefore})`);
    const tx = db.prepare("SELECT * FROM transactions WHERE from_pubkey = ? AND to_pubkey = ?").get(e1, ali.pubKeyHex) as any;
    assert(tx?.auth_signer === `system:decision:${d1}` && near(tx.tax_fee, 0.6) && near(tx.amount, 40),
        `the ledger line is signed by the Decision and carries the fee (got ${tx?.auth_signer} fee ${tx?.tax_fee})`);
    assert(near(totalSupply(), supplyBefore), `no Bean made or lost (supply ${supplyBefore} → ${totalSupply()})`);
    reconcileLedgerFromDb();
    assert(near(balanceOf(ali.pubKeyHex), 50 + 39.4) && near(balanceOf(e1), 60) && near(totalSupply(), supplyBefore),
        'reconcileLedgerFromDb reloads the same balances: memory and disk agree');
    const closed1 = await detail(e1, d1, k3);
    assert(closed1.body?.decision?.tally?.yes === 2 && closed1.body.decision.tally.no === 1, `at close the split shows: 2 yes, 1 no (got ${JSON.stringify(closed1.body?.decision?.tally)})`);

    // ── 2. Replay, a changed vote, forged roll ─────────────────────────────────────────────────────────
    const k4 = makeMember('Kev'), k5 = makeMember('Kya');
    const e2 = makeEnterprise('Garden', [k4, k5], 50);
    const forgedAuthor = await propose(e2, k4, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 10 }, authorPubkey: k5.pubKeyHex });
    assert(forgedAuthor.status === 403, `a body naming another author is refused by the middleware (got ${forgedAuthor.status})`);
    const p2 = await propose(e2, k4, {
        effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 10 },
        // Fields no route reads: the scope and the roll come from the path and the keepers.
        scopeId: e1, scopeKind: 'community', scope_id: e1, electors: [outsider.pubKeyHex], decision_electors: [outsider.pubKeyHex],
    });
    const d2 = p2.body?.decision?.id as string;
    assert(p2.status === 200 && row(d2).scope_id === e2 && row(d2).author_pubkey === k4.pubKeyHex && row(d2).scope_kind === 'enterprise',
        'a body naming another scope, author or roll is ignored: the path and the signer decide');
    const roll2 = (db.prepare('SELECT member_pubkey FROM decision_electors WHERE decision_id = ? ORDER BY member_pubkey').all(d2) as any[]).map(r => r.member_pubkey);
    assert(roll2.length === 2 && !roll2.includes(outsider.pubKeyHex), 'a forged elector is not on the roll: only the two keepers');
    assert((await vote(e2, d2, outsider, true)).status === 404, 'and the outsider named in the body cannot vote');

    const v4 = await vote(e2, d2, k4, true);
    assert(v4.status === 200, 'a keeper of the 2-keeper roll votes yes');
    const replayed = await v4.replay();
    assert(replayed.status !== 200, `the same signed vote replayed is refused by the middleware (got ${replayed.status})`);
    const changed = await vote(e2, d2, k4, false);
    assert(changed.status === 400 && changed.error === SCOPED_ALREADY_VOTED, `a vote can't be changed (got ${changed.status} ${changed.error ?? ''})`);
    assert((db.prepare('SELECT COUNT(*) AS n, MAX(support) AS s FROM decision_votes WHERE decision_id = ?').get(d2) as any).n === 1, 'the vote counts once');
    tickDecisions();
    assert(row(d2).status === 'open', 'a 2-keeper roll with one vote stays open: both must vote');
    assert((await vote(e2, d2, k5, true)).status === 200, 'the second keeper votes yes');
    tickDecisions();
    assert(row(d2).status === 'executed', `2 of 2: carried out at once (got ${row(d2).status} ${row(d2).execution_error ?? ''})`);

    // ── 3. A one-keeper enterprise, a wage without surplus ────────────────────────────────────────────
    const k6 = makeMember('Kyle');
    const e3 = makeEnterprise('Solo', [k6], 30);
    const solo = await propose(e3, k6, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 5 } });
    assert(solo.status === 400 && solo.error === ROLL_OF_ONE, `a one-keeper enterprise holds no vote (got ${solo.status} ${solo.error ?? ''})`);
    const soloList = await list(e3, k6);
    assert(soloList.status === 200 && soloList.body.canPropose === false, 'and its lone keeper is offered no propose button');
    const wage = await propose(e1, k1, { effect: 'pay_out', params: { to: k2.pubKeyHex, amount: 5 } });
    assert(wage.status === 400 && String(wage.error).startsWith(WAGE_NEEDS_SURPLUS), `a pay-out to a keeper is a wage, refused without earned surplus (got ${wage.status} ${wage.error ?? ''})`);
    const self = await propose(e1, k1, { effect: 'pay_out', params: { to: k1.pubKeyHex, amount: 5 } });
    assert(self.status === 400, 'nobody proposes paying themselves');
    const over = await propose(e1, k1, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 61 } });
    assert(over.status === 400 && /holds 60 Beans/.test(String(over.error)), `more than it holds is refused at proposal (got ${over.error})`);

    // ── 4. Who may see: a non-keeper, and a keeper of another enterprise ──────────────────────────────
    const p4 = await propose(e1, k2, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 5 } });
    const d4 = p4.body?.decision?.id as string;
    assert(p4.status === 200, 'another vote opens in the bakery');
    for (const [who, label] of [[outsider, 'a member who keeps nothing'], [k4, 'a keeper of another enterprise']] as const) {
        assert((await list(e1, who)).status === 404, `${label} gets 404 on the list`);
        assert((await detail(e1, d4, who)).status === 404, `${label} gets 404 on the detail`);
        assert((await vote(e1, d4, who, true)).status === 404, `${label} gets 404 voting`);
        assert((await propose(e1, who, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 1 } })).status === 404, `${label} gets 404 proposing`);
        assert((await detail(e2, d4, k4)).status === 404, 'a vote asked for under the wrong enterprise is missing');
    }
    const community = await signedFetch('GET', '/api/commons/decisions', null, k1);
    assert(community.status === 200 && !community.body.decisions.some((d: any) => d.id === d4 || d.id === d1), 'the community list never carries a keepers\' vote');
    assert((await signedFetch('GET', `/api/commons/decisions/${d4}`, null, k1)).status === 404, 'the community detail answers it as missing');
    assert((await signedFetch('POST', `/api/commons/decisions/${d4}/vote`, { support: true }, k1)).status === 404, 'and the community vote route too');
    assert((await signedFetch('GET', `/api/enterprise/${e1}/decisions`, null, null)).status === 401, 'an unsigned read is refused by the middleware');

    // ── 5. Mid-vote changes: stepping down drops, a removal stands ────────────────────────────────────
    const [m1, m2, m3] = [makeMember('Mo'), makeMember('Mia'), makeMember('Max')];
    const e5 = makeEnterprise('Mill', [m1, m2, m3], 40);
    const d5 = (await propose(e5, m1, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 5 } })).body?.decision?.id as string;
    assert((await vote(e5, d5, m2, true)).status === 200, 'a keeper votes yes');
    stepDownAsKeeper(e5, m2.pubKeyHex);
    const after5 = await detail(e5, d5, m1);
    assert(after5.body?.decision?.tally?.roll === 2 && after5.body.decision.tally.voted === 0,
        `a keeper who steps down leaves the roll and their vote is dropped (got ${JSON.stringify(after5.body?.decision?.tally)})`);

    const [n1, n2, n3] = [makeMember('Ned'), makeMember('Nia'), makeMember('Noa')];
    const e6 = makeEnterprise('Nursery', [n1, n2, n3], 40);
    const d6 = (await propose(e6, n1, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 5 } })).body?.decision?.id as string;
    assert((await vote(e6, d6, n2, true)).status === 200, 'a keeper votes yes');
    db.transaction(() => removeKeeperByVote(e6, n2.pubKeyHex, 'test:lead-removed-them'))();
    const after6 = await detail(e6, d6, n1);
    assert(after6.body?.decision?.tally?.roll === 3 && after6.body.decision.tally.voted === 1,
        `a keeper removed mid-vote stays on the roll and their vote stands (got ${JSON.stringify(after6.body?.decision?.tally)})`);

    // ── 6. Wind-up voids; a pause still pays; a standby carries out nothing ───────────────────────────
    const [w1, w2] = [makeMember('Wes'), makeMember('Wyn')];
    const e7 = makeEnterprise('Workshop', [w1, w2], 40);
    const d7 = (await propose(e7, w1, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 5 } })).body?.decision?.id as string;
    db.prepare("UPDATE members SET status = 'winding_up' WHERE public_key = ?").run(e7);
    tickDecisions();
    assert(row(d7).status === 'execution_void' && row(d7).execution_reason === WINDING_UP_VOID, `winding up voids an open vote (got ${row(d7).status} ${row(d7).execution_reason})`);
    assert(near(balanceOf(e7), 40), 'and nothing is paid');

    const [q1, q2] = [makeMember('Quinn'), makeMember('Quy')];
    const e8 = makeEnterprise('Quarry', [q1, q2], 40, { paused: true });
    const d8 = (await propose(e8, q1, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 10 } })).body?.decision?.id as string;
    await vote(e8, d8, q1, true); await vote(e8, d8, q2, true);
    tickDecisions();
    assert(row(d8).status === 'executed' && near(balanceOf(e8), 30), `a paused enterprise still pays (got ${row(d8).status} ${balanceOf(e8)})`);

    const [s1, s2] = [makeMember('Sam'), makeMember('Sol')];
    const e9 = makeEnterprise('Smithy', [s1, s2], 40);
    const d9 = (await propose(e9, s1, { effect: 'pay_out', params: { to: ali.pubKeyHex, amount: 10 } })).body?.decision?.id as string;
    await vote(e9, d9, s1, true); await vote(e9, d9, s2, true);
    const aliBefore9 = balanceOf(ali.pubKeyHex);
    setNodeRole('backup');
    let refused = false;
    try { tickDecisions(); } catch { refused = true; }
    assert(refused && row(d9).status === 'open' && near(balanceOf(e9), 40) && near(balanceOf(ali.pubKeyHex), aliBefore9),
        `a standby carries out nothing: its tick refuses and no Bean moves (status ${row(d9).status})`);
    setNodeRole('primary');
    tickDecisions();
    assert(row(d9).status === 'executed' && near(balanceOf(e9), 30), 'the same vote is carried out once the node is primary again');

    // ── 7. A project's leader stays; conservation over everything ─────────────────────────────────────
    const [l1, l2] = [makeMember('Lea'), makeMember('Lou')];
    const eP = makeEnterprise('Playground build', [l1, l2], 10, { lifecycle: 'bounded' });
    const lead = await propose(eP, l2, { effect: 'replace_lead', subject: l2.pubKeyHex });
    assert(lead.status === 400 && /project's leader/.test(String(lead.error)), `a project's collaborators can't vote its leader out (got ${lead.error})`);

    // ── 8. Removing a keeper, then replacing the lead, by the keepers' vote ───────────────────────────
    const [ra, rb, rc] = [makeMember('Rae'), makeMember('Rex'), makeMember('Roo')];
    const eR = makeEnterprise('Ropeworks', [ra, rb, rc], 20);
    const roleOf = (pk: string) => (db.prepare('SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?').get(eR, pk) as any)?.role ?? null;
    const dR = (await propose(eR, rb, { effect: 'remove_keeper', subject: rc.pubKeyHex })).body?.decision?.id as string;
    await vote(eR, dR, ra, true); await vote(eR, dR, rb, true);
    tickDecisions();
    assert(row(dR).status === 'executed' && roleOf(rc.pubKeyHex) === null, `two of three remove a keeper (got ${row(dR).status} ${row(dR).execution_error ?? ''}, role ${roleOf(rc.pubKeyHex)})`);
    const lone = await propose(eR, ra, { effect: 'remove_keeper', subject: ra.pubKeyHex });
    assert(lone.status === 400, 'nobody proposes removing themselves');
    const dL = (await propose(eR, rb, { effect: 'replace_lead', subject: rb.pubKeyHex })).body?.decision?.id as string;
    await vote(eR, dL, ra, true); await vote(eR, dL, rb, true);
    tickDecisions();
    assert(row(dL).status === 'executed' && roleOf(rb.pubKeyHex) === 'lead' && roleOf(ra.pubKeyHex) === 'keeper',
        `the keepers make another keeper the lead; the old lead stays a keeper (got ${row(dL).status}, ${roleOf(rb.pubKeyHex)}/${roleOf(ra.pubKeyHex)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ AN ENTERPRISE\'S KEEPERS CAN VOTE TO PAY OUT.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
