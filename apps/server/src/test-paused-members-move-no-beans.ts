/**
 * A paused or suspended member moves none of their Beans (security inventory 17 Nov, risk 13): one table over every door
 * that moves Beans, credit or a pledge out of a member, each called by a member an admin, a report or a vote paused
 * ('disabled', through the real pause), by one whose status is 'disabled' written directly, and by one a report suspended
 * before the pause wrote 'disabled' ('suspended'). Every one is refused and nothing moves: no balance, no pledge, no room.
 *
 * Boots the real server; every request goes over HTTPS through the real signature middleware.
 *
 * The table is the class, not a sample: every entry of routes/money-limits-gate.ts MONEY_ROUTES (the list of member
 * routes that move Beans out of an account or start a deal) is either a door below or named in NOT_OUT_OF_A_MEMBER with
 * why, and a new entry fails this suite until it is one or the other. Two doors that move a member's value are not in
 * that list and are here too: paying the Commons (POST /api/commons/pay) and giving credit line (POST /api/credit/gift).
 *
 * Each door is first walked by an ACTIVE member with the same fixtures, who must succeed and move something: so a refusal
 * below is the status rule, never a body the door would refuse anyway.
 *
 * Then the engine itself, past the doors: pledgeToProject, transfer and payToCommons, each called by the same paused,
 * disabled and suspended members, all refuse and nothing moves.
 *
 * Before this suite's fix, POST /api/crowdfund/projects/:id/pledge asked only isNodeMember (which admits a paused or
 * suspended member) and pledgeToProject asked nothing about the pledger: a paused member moved their held Beans into a
 * crowdfund's escrow, which the goal then sweeps to the enterprise.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-paused-members-move-no-beans.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;

import crypto from 'node:crypto';
import { HUNDREDTHS_PER_BEAN } from '@beanpool/core';
import { setMemberPhoto } from '@beanpool/engine';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const hc = (beans: number) => Math.round(beans * HUNDREDTHS_PER_BEAN);

type Id = { pk: string; key: crypto.KeyObject; callsign: string };
function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), key: privateKey, callsign };
}

type Answer = { status: number; body: any };
async function send(method: 'POST' | 'DELETE', p: string, payload: unknown, id: Id): Promise<Answer> {
    const body = JSON.stringify(payload);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${p}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': signRequest(id.key, { method, path: p.split('?')[0], timestamp: ts, nonce, body }),
            [SIGNED_FOR_HEADER]: signedForHost(),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body,
    });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
}

/**
 * One request a door is: who signs it (the member, or someone acting on what the member asked before the pause). `yes`:
 * the ask moves no Beans itself, they move when the seller says yes, and this is that yes, for the answer the ask got.
 */
type Call = { method: 'POST' | 'DELETE'; path: string; body: Record<string, unknown>; signer?: Id; yes?: (asked: Answer) => Call };

interface Door {
    name: string;
    /** Builds the request while the member is still active, so the only thing that differs below is their status. */
    setup: (member: Id) => Call;
}

async function main() {
    const { initTls } = await import('./services/tls.js');
    const { wrapCreatePost } = await import('./post-test-helper.js');
    const se = await import('./state-engine.js');
    const de = await import('./decisions-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db, createCrowdfundProject, pledgeToProject, PLEDGE_NOT_ACTIVE_ERROR } = await import('./db/db.js');
    const { MONEY_ROUTES } = await import('./routes/money-limits-gate.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const createPost = wrapCreatePost(se.createPost);

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const today = Math.floor(Date.now() / 86_400_000);
    /** A member here, active, holding `beans`, past their first completed trade (the send gate), with a photo. */
    function member(callsign: string, beans = 1000): Id {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')`).run(id.pk, callsign);
        db.prepare('INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, ?, ?)').run(id.pk, hc(beans), today);
        se.reconcileLedgerFromDb(); // the in-memory ledger reads the balance from here on
        setMemberPhoto(db, id.pk, 'data:image/png;base64,iVBORw0KGgo=');
        // A member lists an offer before they post a need or take one (CONTRIBUTION_REQUIRED).
        createPost('offer', 'misc', `Lessons from ${callsign}`, 'An hour of lessons', hc(10), 'fixed', id.pk);
        return id;
    }
    /** An offer from a seller of its own, so no seller reaches a day's cap on listings. */
    let sellers = 0;
    function offerFor(m: Id, what: string): { seller: Id; postId: string } {
        const s = member(`Sela${++sellers}`);
        return { seller: s, postId: createPost('offer', 'misc', `${what} for ${m.callsign}`, `${what}, fresh`, hc(10), 'fixed', s.pk)!.id };
    }
    const gen = keypair('Gen');
    se.seedGenesisMember(gen.pk, gen.callsign); // the node's first owner
    const helper = member('Hal');
    const friend = member('Fern');
    let billers = 0;
    const voucher = member('Vic');
    const other = member('Otto'); // keeps the enterprise a member asks to keep
    function completedTrade(buyer: string, sellerPk: string, beans: number) {
        const pid = `pmb-post-${crypto.randomBytes(4).toString('hex')}`;
        db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, status) VALUES (?, 'offer', 'misc', 'done', 'done', ?, ?, 'completed')`)
            .run(pid, hc(beans), sellerPk);
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status) VALUES (?, ?, ?, ?, ?, 'completed')`)
            .run(`pmb-mtx-${crypto.randomBytes(4).toString('hex')}`, pid, buyer, sellerPk, hc(beans));
    }
    se.reconcileLedgerFromDb();

    // Shared targets: a crowdfund project (the Commons' door) and a bounded enterprise raising a goal (the enterprise door).
    // Goals far above anything pledged here, so no pledge completes one and every door stays open throughout.
    const project = `proj_${crypto.randomUUID()}`;
    createCrowdfundProject(project, friend.pk, 'Water tank', 'A tank for the hall', [], hc(1_000_000), null);
    const raising = se.createTreasury('Seed library', 'data:image/png;base64,iVBORw0KGgo=', 0, {
        lifecycle: 'bounded', goalAmount: hc(1_000_000), purpose: 'Seeds for everyone',
    });
    const raisingPk = raising.publicKey;
    const askablePk = se.createTreasury('Bike kitchen', 'data:image/png;base64,iVBORw0KGgo=').publicKey;
    se.adminAssignTreasuryOperator(askablePk, other.pk);

    /** Every balance, every backing pledge, every piece of credit line, every keeper's ask with its pledge, every bill. */
    function money(): string {
        return JSON.stringify([
            db.prepare('SELECT public_key, balance_c FROM accounts ORDER BY public_key').all(),
            db.prepare('SELECT enterprise, keeper, amount_c, released_at FROM enterprise_pledges ORDER BY id').all(),
            db.prepare('SELECT from_pubkey, to_pubkey, amount_c, kind FROM room_gifts ORDER BY id').all(),
            db.prepare('SELECT enterprise_pubkey, member_pubkey, pledged_backing_c, status FROM enterprise_keeper_requests ORDER BY id').all(),
            db.prepare('SELECT id, state FROM bills ORDER BY id').all(),
        ]);
    }
    /** All a door could change: the money, and every deal not yet done. */
    function fingerprint(): string {
        return money() + JSON.stringify(db.prepare("SELECT id, status FROM marketplace_transactions WHERE status != 'completed' ORDER BY id").all());
    }

    /** An enterprise `m` keeps (lead), holding Beans, with a need of its own a helper has asked to do. */
    const keptBy = new Map<string, { ent: string; needTx: string }>();
    function keptEnterprise(m: Id) {
        let kept = keptBy.get(m.pk);
        if (kept) return kept;
        const ent = se.createTreasury(`Shed of ${m.callsign}`, 'data:image/png;base64,iVBORw0KGgo=').publicKey;
        se.adminAssignTreasuryOperator(ent, m.pk);
        db.prepare('UPDATE accounts SET balance_c = ? WHERE public_key = ?').run(hc(500), ent);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, ?, ?)').run(ent, hc(500), today);
        se.reconcileLedgerFromDb();
        createPost('offer', 'misc', `Tool hire (${m.callsign})`, 'Tools by the day', hc(10), 'fixed', ent);
        const need = createPost('need', 'misc', `Fix the roof (${m.callsign})`, 'Two hours of work', hc(20), 'fixed', ent)!;
        const tx = se.requestPost(need.id, helper.pk);
        kept = { ent, needTx: tx.id };
        keptBy.set(m.pk, kept);
        return kept;
    }

    const DOORS: Door[] = [
        {
            name: 'send Beans (POST /api/ledger/transfer)',
            setup: (m) => ({ method: 'POST', path: '/api/ledger/transfer', body: { to: friend.pk, amount_c: hc(5), memo: 'thanks' } }),
        },
        {
            name: 'buy an offer in one step (POST /api/marketplace/posts/accept)',
            setup: (m) => ({ method: 'POST', path: '/api/marketplace/posts/accept', body: { postId: offerFor(m, 'Jam').postId, buyerPublicKey: m.pk } }),
        },
        {
            name: 'the seller says yes to what the member asked before (POST /api/marketplace/transactions/approve)',
            setup: (m) => {
                const { seller, postId } = offerFor(m, 'Bread');
                const tx = se.requestPost(postId, m.pk);
                return { method: 'POST', path: '/api/marketplace/transactions/approve', body: { transactionId: tx.id, authorPublicKey: seller.pk }, signer: seller };
            },
        },
        {
            name: 'say yes to a helper on their own need (POST /api/marketplace/transactions/approve)',
            setup: (m) => {
                const need = createPost('need', 'misc', `Weeding for ${m.callsign}`, 'An hour of weeding', hc(10), 'fixed', m.pk)!;
                const tx = se.requestPost(need.id, helper.pk);
                return { method: 'POST', path: '/api/marketplace/transactions/approve', body: { transactionId: tx.id, authorPublicKey: m.pk } };
            },
        },
        {
            name: 'ask for an offer, Beans held on the yes (POST /api/marketplace/posts/request)',
            setup: (m) => {
                const { seller, postId } = offerFor(m, 'Eggs');
                return {
                    method: 'POST', path: '/api/marketplace/posts/request', body: { postId, buyerPublicKey: m.pk },
                    yes: (asked) => ({ method: 'POST', path: '/api/marketplace/transactions/approve', body: { transactionId: asked.body?.transaction?.id, authorPublicKey: seller.pk }, signer: seller }),
                };
            },
        },
        {
            name: 'say yes, for an enterprise they keep, to a helper on its need (POST /api/treasury/:id/approve)',
            setup: (m) => {
                const { ent, needTx } = keptEnterprise(m);
                return { method: 'POST', path: `/api/treasury/${ent}/approve`, body: { transactionId: needTx } };
            },
        },
        {
            name: 'sweep an enterprise they keep to the Commons (POST /api/treasury/:id/sweep)',
            setup: (m) => ({ method: 'POST', path: `/api/treasury/${keptEnterprise(m).ent}/sweep`, body: { amount_c: hc(1) } }),
        },
        {
            name: 'back an enterprise they keep (POST /api/treasury/:id/backing)',
            setup: (m) => ({ method: 'POST', path: `/api/treasury/${keptEnterprise(m).ent}/backing`, body: { amount_c: hc(1) } }),
        },
        {
            name: 'back an enterprise they keep, through the pledge door (POST /api/enterprise/:id/pledge, type backing)',
            setup: (m) => ({ method: 'POST', path: `/api/enterprise/${keptEnterprise(m).ent}/pledge`, body: { type: 'backing', amount_c: hc(1) } }),
        },
        {
            name: 'ask to keep an enterprise with a pledge (POST /api/treasury/:id/keepers/request)',
            setup: (m) => ({ method: 'POST', path: `/api/treasury/${askablePk}/keepers/request`, body: { pledgedBacking_c: hc(1) } }),
        },
        {
            name: 'pledge to an enterprise raising a goal (POST /api/treasury/:id/pledge)',
            setup: () => ({ method: 'POST', path: `/api/treasury/${raisingPk}/pledge`, body: { amount_c: hc(5), memo: 'go seeds' } }),
        },
        {
            name: 'pledge to an enterprise raising a goal (POST /api/enterprise/:id/pledge)',
            setup: () => ({ method: 'POST', path: `/api/enterprise/${raisingPk}/pledge`, body: { amount_c: hc(5) } }),
        },
        {
            name: 'pledge to a crowdfund (POST /api/crowdfund/projects/:id/pledge)',
            setup: () => ({ method: 'POST', path: `/api/crowdfund/projects/${project}/pledge`, body: { amount_c: hc(5), memo: 'for the tank' } }),
        },
        {
            name: 'pay a bill sent to them (POST /api/bills/:id/pay)',
            setup: (m) => {
                // A biller of its own each time: a member bills at most 3 people a day they haven't dealt with.
                const bill = se.sendBill(member(`Bill${++billers}`).pk, { id: crypto.randomUUID(), to: m.pk, amount_c: hc(5), whatFor: 'Mowing' });
                return { method: 'POST', path: `/api/bills/${bill.id}/pay`, body: {} };
            },
        },
        {
            name: 'pay the Commons (POST /api/commons/pay)',
            setup: () => ({ method: 'POST', path: '/api/commons/pay', body: { amount_c: hc(5) } }),
        },
        {
            name: 'give part of their credit line (POST /api/credit/gift)',
            setup: (m) => {
                db.prepare("INSERT INTO room_gifts (id, from_pubkey, to_pubkey, root_pubkey, kind, amount_c) VALUES (?, ?, ?, ?, 'vouch', ?)")
                    .run(crypto.randomUUID(), voucher.pk, m.pk, voucher.pk, hc(50));
                return { method: 'POST', path: '/api/credit/gift', body: { memberPubkey: friend.pk, amount_c: hc(5) } };
            },
        },
    ];

    /**
     * MONEY_ROUTES entries that move nothing OUT of a member: each gives a pledge back to the member who made it, which a
     * paused member may still ask for (their credit, back to them).
     */
    const NOT_OUT_OF_A_MEMBER = [
        { method: 'POST', sample: '/api/treasury/x/release', why: 'a keeper takes their own backing back' },
        { method: 'POST', sample: '/api/treasury/x/pledge/release', why: 'a keeper takes their own backing back' },
        { method: 'POST', sample: '/api/treasury/x/backing/release', why: 'a keeper takes their own backing back' },
        { method: 'DELETE', sample: '/api/treasury/x/pledge', why: 'a keeper takes their own backing back' },
    ];

    // ---- 0. The table is the class -------------------------------------------------------------------------------------
    const doorCalls = DOORS.map((d) => d.setup(member(`Probe${DOORS.indexOf(d)}`)));
    se.reconcileLedgerFromDb();
    for (const r of MONEY_ROUTES) {
        const door = doorCalls.find((c) => c.method === r.method && r.path.test(c.path));
        const named = NOT_OUT_OF_A_MEMBER.find((n) => n.method === r.method && r.path.test(n.sample));
        assert(door || named, `MONEY_ROUTES ${r.method} ${r.path.source} is a door in this table${named ? ` (or named: ${named.why})` : ''}`);
    }

    // ---- 1. An active member walks every door: each succeeds and moves something -------------------------------------
    const ann = member('Ann');
    completedTrade(friend.pk, ann.pk, 50);
    const annCalls = DOORS.map((d) => d.setup(ann));
    se.reconcileLedgerFromDb();
    for (const [i, door] of DOORS.entries()) {
        resetGatewayRateLimit();
        const before = fingerprint();
        const call = annCalls[i];
        const a = await send(call.method, call.path, call.body, call.signer ?? ann);
        const moved = fingerprint() !== before;
        assert(a.status >= 200 && a.status < 300 && moved, `an active member: ${door.name} succeeds and moves something (${a.status}${a.status >= 300 ? ` ${JSON.stringify(a.body)}` : ''}${moved ? '' : ', nothing moved'})`);
    }

    // ---- 2. A paused, a disabled and a suspended member: every door refuses, and nothing moves -------------------------
    const pia = member('Pia');
    const dot = member('Dot');
    const sue = member('Sue');
    const states: Array<{ m: Id; what: string; set: () => void }> = [
        {
            m: pia, what: 'paused by an admin (the pause)',
            set: () => db.transaction(() => { de.pauseMember(se.getMember(pia.pk)!, gen.pk, 'Threats in the market chat', { actor: gen.pk, how: 'suspended' }); })(),
        },
        { m: dot, what: "'disabled'", set: () => se.adminSetUserStatus(dot.pk, 'disabled') },
        { m: sue, what: "'suspended' (a report's suspension before the pause)", set: () => { db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(sue.pk); } },
    ];
    for (const s of states) {
        completedTrade(friend.pk, s.m.pk, 50);
        const calls = DOORS.map((d) => d.setup(s.m));
        se.reconcileLedgerFromDb();
        s.set();
        const status = (db.prepare('SELECT status FROM members WHERE public_key = ?').get(s.m.pk) as { status: string }).status;
        assert(status === 'disabled' || status === 'suspended', `${s.m.callsign} is ${s.what}: status '${status}'`);
        const held = se.getBalance(s.m.pk).balance_c;
        for (const [i, door] of DOORS.entries()) {
            resetGatewayRateLimit();
            const before = fingerprint();
            const call = calls[i];
            const beforeMoney = money();
            const a = await send(call.method, call.path, call.body, call.signer ?? s.m);
            if (call.yes && s.m === sue && a.status === 200) {
                // The one door a member a report suspended before the pause still opens: asking for an offer, which the
                // escrow lets them do (engine/escrow.ts requestPost: 'suspended' trades) and which moves no Bean. The
                // Beans would move at the seller's yes, and that is refused.
                assert(money() === beforeMoney, `${s.m.callsign}, ${s.what}: ${door.name} moves no Bean (the ask is answered, ${a.status})`);
                resetGatewayRateLimit();
                const yes = call.yes(a);
                const y = await send(yes.method, yes.path, yes.body, yes.signer!);
                assert(y.status >= 400 && y.status < 500 && money() === beforeMoney,
                    `${s.m.callsign}, ${s.what}: the seller's yes to that ask is refused (${y.status}) and no Bean moves`);
                continue;
            }
            const moved = fingerprint() !== before;
            // A refusal (4xx), never a server fault (5xx), which an app tries again.
            assert(a.status >= 400 && a.status < 500 && !moved,
                `${s.m.callsign}, ${s.what}: ${door.name} is refused (${a.status}${a.status >= 500 ? ` ${JSON.stringify(a.body)}` : ''}) and nothing moves${moved ? ' (SOMETHING MOVED)' : ''}`);
        }
        assert(se.getBalance(s.m.pk).balance_c === held, `${s.m.callsign} still holds every Bean they held (${held})`);
    }

    // The crowdfund door's own answer: 403 in the words the enterprise pledge door uses.
    resetGatewayRateLimit();
    const piaPledge = await send('POST', `/api/crowdfund/projects/${project}/pledge`, { amount_c: hc(5) }, pia);
    assert(piaPledge.status === 403 && piaPledge.body?.error === PLEDGE_NOT_ACTIVE_ERROR,
        `the crowdfund door answers a paused member 403 "${PLEDGE_NOT_ACTIVE_ERROR}" (${piaPledge.status} ${JSON.stringify(piaPledge.body)})`);

    // ---- 3. The engine itself, past the doors ---------------------------------------------------------------------------
    // Each call against what was there just before it, so one call's outcome is never read as another's.
    function refusedAndNothingMoved(call: () => unknown): { refusal: unknown; moved: boolean } {
        const before = fingerprint();
        let refusal: unknown = null;
        try { refusal = call(); } catch (e) { refusal = e; }
        return { refusal, moved: fingerprint() !== before };
    }
    for (const s of states) {
        const toProject = refusedAndNothingMoved(() => pledgeToProject(crypto.randomUUID(), project, s.m.pk, hc(5), 'Project Pledge'));
        assert(toProject.refusal instanceof Error && toProject.refusal.message === PLEDGE_NOT_ACTIVE_ERROR && (toProject.refusal as any).status === 403 && !toProject.moved,
            `pledgeToProject refuses ${s.m.callsign} (${s.what}) to a crowdfund in plain words, and nothing moves`);
        const toEnterprise = refusedAndNothingMoved(() => pledgeToProject(crypto.randomUUID(), raisingPk, s.m.pk, hc(5), 'Enterprise Pledge'));
        assert(toEnterprise.refusal instanceof Error && toEnterprise.refusal.message === PLEDGE_NOT_ACTIVE_ERROR && !toEnterprise.moved,
            `pledgeToProject refuses ${s.m.callsign} (${s.what}) to an enterprise raising a goal, and nothing moves`);
        const sent = refusedAndNothingMoved(() => se.transfer(s.m.pk, friend.pk, hc(5), 'gift'));
        assert((sent.refusal === null || sent.refusal instanceof Error) && !sent.moved, `transfer refuses ${s.m.callsign} (${s.what}), and nothing moves`);
        const paid = refusedAndNothingMoved(() => se.payToCommons(s.m.pk, hc(5)));
        assert(paid.refusal instanceof Error && !paid.moved, `payToCommons refuses ${s.m.callsign} (${s.what}), and nothing moves`);
    }
    // And an active member's engine pledge still goes through (the check can fail).
    const before = fingerprint();
    pledgeToProject(crypto.randomUUID(), project, ann.pk, hc(5), 'Project Pledge');
    assert(fingerprint() !== before, 'pledgeToProject still takes an active member\'s pledge');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) {
        console.error('test-paused-members-move-no-beans: FAILED');
        process.exit(1);
    }
    console.log('test-paused-members-move-no-beans: all passed');
    process.exit(0);
}

main().catch((e) => {
    console.error('test-paused-members-move-no-beans crashed:', e);
    process.exit(1);
});
