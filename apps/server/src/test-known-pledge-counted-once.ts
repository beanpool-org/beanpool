/**
 * A keeper's known pledge counts once in an enterprise's spend floor, and a released pledge gives that floor back
 * (#2309's STOP-and-report), over HTTPS through the real middleware. The spend floor is the keepers' pledge rows: the
 * earned ones, plus the known ones as the known floor counts them (engine known-floor.ts). treasury_operators.backing, the
 * figure a keeper pledged as they joined, known part included, is never part of it: read there, a known pledge made by
 * joining counted twice, and a joining pledge kept its floor after it was released.
 *
 *   1. the measured sequence: a confirmed Kai with no earned credit asks to join Kai Co pledging 500 (all of it from his
 *      known grant) and an admin approves: the floor is -500 in the spend check, the balance read and the engine; Kai
 *      approving a 900-Bean Need of Kai Co's is refused and moves nothing; 500 goes through and one Bean more doesn't;
 *      THE BOUND holds (his own line + what his known pledges back <= his grant)
 *   2. a top-up (POST /backing) after joining with a known 200: 100 more is -300, never -500
 *   3. the lead keeper approves, the objection window passes and the scheduler binds (applyDueKeeperChanges): -400,
 *      never -800
 *   4. a keeper with earned credit E and a known part: joining with E + 300 is -(E + 300), never -(E + 600); releasing
 *      E + 100 (the known part first) leaves the 200 still pledged
 *   5. a partial release of a known joining pledge: 400 less 150 is -250, never -650
 *   6. the dial off (its owner switched it off; on by default): a joining pledge of earned credit released in full gives
 *      the floor back, 0, and a spend moves nothing
 *   7. unbinding: a step-down while solvent gives the floor back; an admin's unbinding in debt keeps locked only the part
 *      the debt needs, counted once
 *   8. a stored row as origin/main wrote it (a joining figure with a known part, and an enterprise that spent past its
 *      pledges on that figure): it reads its pledges and is spend-frozen with nothing clawed back, and backingFigureDrift
 *      counts it
 *   9. conservation: the balances still add up to zero
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-known-pledge-counted-once.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'KnownPledgeOnce123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import * as se from './state-engine.js';
import { wrapCreatePost, TEST_PHOTOS } from './post-test-helper.js';
import {
    initStateEngine, transfer, seedGenesisMember, createPost as rawCreatePost, acceptPost, getBalance, getEnterpriseUnderlyingFloor,
    getMemberTrustProfile, adminAssignTreasuryOperator, applyDueKeeperChanges, getCommonsBalanceExact,
} from './state-engine.js';
const createPost = wrapCreatePost(rawCreatePost);
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto, getEnterpriseFloor, clearEnterpriseFloorCache, confirmationDialOn, CONFIRMATION_DIAL_KEY } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

/** An enterprise with five live offers (the most the offer bands let it spend) and no keeper yet. */
function makeEnterprise(name: string): string {
    const pk = keypair(name).pk;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active', 1)`).run(pk, name, ago(DAY));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    setMemberPhoto(db, pk, AVATAR);
    for (let i = 0; i < 5; i++) createPost('offer', 'produce', `${name} goods ${i}`, 'Goods', 10, 'fixed', pk);
    return pk;
}

function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
}

/** Completed trades with `n` different members: earned credit, as the derived-floor suite builds it. */
function earnByTrading(member: Id, n: number): number {
    for (let i = 0; i < n; i++) {
        const peer = makeMember(`${member.name}'s peer ${i}`);
        const post = `post-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'misc', 'goods', 'goods', 100, ?, 'completed')`)
            .run(post, peer.pk);
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, 100, 'completed')`)
            .run(`mtx-${crypto.randomUUID()}`, post, member.pk, peer.pk);
    }
    return getMemberTrustProfile(member.pk).earnedCredit;
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

async function main(): Promise<void> {
    console.log('A known pledge counts once in an enterprise\'s spend floor, over HTTPS\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const sink = makeMember('Sink');
    for (let i = 0; i < 2; i++) createPost('offer', 'produce', `Sink goods ${i}`, 'Goods', 10, 'fixed', sink.pk);
    const dial = async (on: boolean) => {
        const r = await call('POST', null, '/api/local/admin/community-shape', { changes: { knownFloor: { on: on } } }, owner);
        assert(r.status === 200 && r.body?.shape?.settings?.knownFloor?.value?.on === on, `the owner turns the confirmation dial ${on ? 'on' : 'off'} (${show(r)})`);
    };

    // The figures every check reads: the spend check's floor, the balance read over HTTPS (any member may read an
    // enterprise's), the engine's (the badge, the enterprise page), and the floor a spend is held to.
    const floors = async (co: string) => {
        clearEnterpriseFloorCache(db, co);
        const read = await call('GET', sink, `/api/ledger/balance/${co}`);
        return {
            spend: getEnterpriseUnderlyingFloor(co).floor, http: read.body?.floor, httpUsable: read.body?.usableFloor,
            engine: getEnterpriseFloor(db, co).floor, balance: getBalance(co).balance, frozen: getBalance(co).frozen,
        };
    };
    const allAt = (f: Awaited<ReturnType<typeof floors>>, floor: number) =>
        f.spend === floor && f.http === floor && f.httpUsable === floor && f.engine === floor;
    // A keeper spends for their enterprise as the app does, signed, through the real routes: the enterprise's Need of
    // `beans`, Sink offers to do it (refused there when the enterprise can't pay it), and the keeper approves, which puts
    // the Beans in escrow. A refusal counts only as the floor's: the Need was posted, the words are the balance check's,
    // and nothing moved.
    const spendAs = async (keeper: Id, co: string, beans: number) => {
        const need = await call('POST', keeper, `/api/treasury/${co}/need`, { title: `Help wanted ${crypto.randomUUID().slice(0, 6)}`, category: 'work', credits: beans, photos: TEST_PHOTOS });
        const before = getBalance(co).balance;
        const bid = await call('POST', sink, '/api/marketplace/posts/request', { postId: need.body?.post?.id, buyerPublicKey: sink.pk });
        const approved = bid.status === 200 ? await call('POST', keeper, `/api/treasury/${co}/approve`, { transactionId: bid.body?.transaction?.id }) : null;
        const stop = approved && approved.status !== 200 ? approved : bid.status !== 200 ? bid : null;
        return { posted: need.status === 200, ok: approved?.status === 200, why: stop ? show(stop) : '', moved: Math.round((before - getBalance(co).balance) * 100) / 100 };
    };
    type Spend = Awaited<ReturnType<typeof spendAs>>;
    const refused = (s: Spend) => s.posted && !s.ok && /Insufficient balance/.test(s.why) && s.moved === 0;
    const spent = (s: Spend, beans: number) => s.posted && s.ok && s.moved === beans;
    const said = (s: Spend) => `${s.posted ? '' : 'NOT POSTED '}${s.ok ? 'approved' : s.why}, moved ${s.moved}`;
    // A buy for an enterprise no keeper can sign for any more, in process.
    const buyInProcess = (co: string, beans: number): number => {
        const before = getBalance(co).balance;
        try { acceptPost(createPost('offer', 'produce', `Sink's ${beans}-Bean crate ${crypto.randomUUID().slice(0, 6)}`, 'Veg', beans, 'fixed', sink.pk)!.id, co); } catch { /* refused */ }
        return Math.round((before - getBalance(co).balance) * 100) / 100;
    };
    const join = async (member: Id, co: string, pledged: number, approver: Id) => {
        const asked = await call('POST', member, `/api/enterprise/${co}/keepers/request`, { pledgedBacking: pledged });
        assert(asked.status === 200 && typeof asked.body?.request?.id === 'string', `${member.name} asks to join, pledging ${pledged} (${show(asked)})`);
        const approved = await call('POST', approver, `/api/enterprise/${co}/keepers/requests/${asked.body?.request?.id}/approve`, {});
        return approved;
    };
    const pledgeRows = (co: string) => (db.prepare('SELECT id, amount FROM enterprise_pledges WHERE enterprise = ? AND released_at IS NULL ORDER BY id').all(co) as { id: string; amount: number }[])
        .map(r => `${r.id.startsWith('known:') ? 'known' : 'earned'} ${r.amount}`).sort();
    const figure = (co: string, keeper: Id) => (db.prepare('SELECT backing FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?').get(co, keeper.pk) as { backing: number } | undefined)?.backing;

    // The dial is on by default (Marty, 21 Oct): a new node has no row and reads on, and the owner's "on" writes none, so
    // every check below with the dial on runs on the default, never on a stored 'on'.
    const dialRow = () => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CONFIRMATION_DIAL_KEY) as { value: string } | undefined)?.value ?? null;
    assert(confirmationDialOn(db) && dialRow() === null, `a new node reads the dial on with no row: on by default (${dialRow()})`);
    await dial(true);
    assert(dialRow() === null, `and the owner turning it on writes no row (${dialRow()})`);

    // ── 1. the measured sequence ─────────────────────────────────────────────────────────────────
    console.log('── 1. Kai joins by request with a known 500 ──');
    const kai = makeMember('Kai');
    confirm(kai, ada);
    createPost('offer', 'produce', 'Kai mends bikes', 'Bikes', 10, 'fixed', kai.pk);
    const kaiCo = makeEnterprise('Kai Co');
    const kaiIn = await join(kai, kaiCo, 500, ada);
    assert(kaiIn.status === 200 && kaiIn.body?.applied === true, `an admin approves him at once (${show(kaiIn)})`);
    assert(JSON.stringify(pledgeRows(kaiCo)) === JSON.stringify(['known 500']) && figure(kaiCo, kai) === 500,
        `his pledge is one known row of 500, and the keepers list keeps the figure he joined with, 500 (${pledgeRows(kaiCo)}; ${figure(kaiCo, kai)})`);
    const f1 = await floors(kaiCo);
    assert(allAt(f1, -500), `Kai Co's floor is -500 in the spend check, the balance read and the engine, never -1,000 (${JSON.stringify(f1)})`);
    const s900 = await spendAs(kai, kaiCo, 900);
    assert(refused(s900), `a 900-Bean spend past its 500 of backing is refused and moves nothing (${said(s900)})`);
    const s500 = await spendAs(kai, kaiCo, 500);
    assert(spent(s500, 500), `a 500-Bean spend, to the floor, goes through (${said(s500)})`);
    const s1 = await spendAs(kai, kaiCo, 1);
    assert(refused(s1) && getBalance(kaiCo).balance === -500, `one Bean more is refused: Kai Co owes 500, no more (${said(s1)}; ${getBalance(kaiCo).balance})`);
    const kaiOwn = await call('GET', kai, `/api/ledger/balance/${kai.pk}`);
    assert(kaiOwn.status === 200 && kaiOwn.body?.floor === -500 && -kaiOwn.body?.floor + -getBalance(kaiCo).balance <= 1000,
        `THE BOUND: Kai's own line (${-kaiOwn.body?.floor}) + the debt his known pledge backs (${-getBalance(kaiCo).balance}) is at most his grant, 1,000`);

    // ── 2. a top-up after joining ────────────────────────────────────────────────────────────────
    console.log('── 2. a top-up after joining ──');
    const tia = makeMember('Tia');
    confirm(tia, ada);
    const tiaCo = makeEnterprise('Tia Co');
    assert((await join(tia, tiaCo, 200, ada)).status === 200, 'Tia joins Tia Co with a known 200');
    const topUp = await call('POST', tia, `/api/enterprise/${tiaCo}/backing`, { amount: 100 });
    assert(topUp.status === 200, `Tia pledges 100 more (${show(topUp)})`);
    const f2 = await floors(tiaCo);
    assert(allAt(f2, -300) && figure(tiaCo, tia) === 200,
        `Tia Co reads -300, her pledges, never -500 (the joining figure 200 beside them, still 200) (${JSON.stringify(f2)})`);
    const s301 = await spendAs(tia, tiaCo, 301);
    const s300 = await spendAs(tia, tiaCo, 300);
    assert(refused(s301) && spent(s300, 300), `it may spend 300 and not 301 (${said(s301)}; ${said(s300)})`);

    // ── 3. the scheduler's add ───────────────────────────────────────────────────────────────────
    console.log('── 3. the lead approves, the window passes, the scheduler binds ──');
    const lou = makeMember('Lou');
    const ned = makeMember('Ned');
    const kim = makeMember('Kim');
    confirm(kim, ada);
    const louCo = makeEnterprise('Lou Co');
    adminAssignTreasuryOperator(louCo, lou.pk, 'admin');
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(louCo, lou.pk);
    adminAssignTreasuryOperator(louCo, ned.pk, 'admin');
    const kimIn = await join(kim, louCo, 400, lou);
    assert(kimIn.status === 200 && kimIn.body?.applied === false && kimIn.body?.change?.status === 'pending',
        `with two keepers, the lead's approval waits out the objection window (${show(kimIn)})`);
    assert((await floors(louCo)).spend === 0, 'until then Lou Co has no backing');
    const due = applyDueKeeperChanges(louCo, Date.now() + 4 * DAY);
    const f3 = await floors(louCo);
    assert(due.applied === 1 && allAt(f3, -400) && figure(louCo, kim) === 400,
        `the scheduler binds Kim: Lou Co reads -400, never -800 (${JSON.stringify(due)}; ${JSON.stringify(f3)})`);
    const s401 = await spendAs(kim, louCo, 401);
    const s400 = await spendAs(kim, louCo, 400);
    assert(refused(s401) && spent(s400, 400), `Kim may spend 400 for it and not 401 (${said(s401)}; ${said(s400)})`);

    // ── 4. earned and known together ─────────────────────────────────────────────────────────────
    console.log('── 4. a keeper with earned credit and a known part ──');
    const mia = makeMember('Mia');
    confirm(mia, ada);
    const earned = earnByTrading(mia, 6);
    assert(earned > 0 && earned < 500, `Mia has ${earned} of earned credit from her trades`);
    const miaCo = makeEnterprise('Mia Co');
    assert((await join(mia, miaCo, earned + 300, ada)).status === 200, `Mia joins Mia Co with ${earned + 300}: ${earned} earned, 300 known`);
    const f4 = await floors(miaCo);
    assert(JSON.stringify(pledgeRows(miaCo)) === JSON.stringify([`earned ${earned}`, 'known 300']) && allAt(f4, -(earned + 300)),
        `Mia Co reads -${earned + 300}, never -${earned + 600} (${pledgeRows(miaCo)}; ${JSON.stringify(f4)})`);
    const miaOver = await spendAs(mia, miaCo, earned + 301);
    assert(refused(miaOver), `a spend one Bean past it is refused (${said(miaOver)})`);
    const miaRelease = await call('POST', mia, `/api/enterprise/${miaCo}/release`, { amount: earned + 100 });
    const f4b = await floors(miaCo);
    assert(miaRelease.status === 200 && JSON.stringify(pledgeRows(miaCo)) === JSON.stringify(['earned 200']) && allAt(f4b, -200),
        `releasing ${earned + 100} (the known part first) leaves 200 earned pledged: -200, never -${earned + 300} (${show(miaRelease)}; ${JSON.stringify(f4b)})`);

    // ── 5. a partial release of a known joining pledge ───────────────────────────────────────────
    console.log('── 5. a partial release ──');
    const lia = makeMember('Lia');
    confirm(lia, ada);
    const liaCo = makeEnterprise('Lia Co');
    assert((await join(lia, liaCo, 400, ada)).status === 200, 'Lia joins Lia Co with a known 400');
    const liaRelease = await call('POST', lia, `/api/enterprise/${liaCo}/release`, { amount: 150 });
    const f5 = await floors(liaCo);
    assert(liaRelease.status === 200 && JSON.stringify(pledgeRows(liaCo)) === JSON.stringify(['known 250']) && allAt(f5, -250),
        `releasing 150 leaves a known 250: -250, never -650 (${show(liaRelease)}; ${JSON.stringify(f5)})`);
    const liaOwn = await call('GET', lia, `/api/ledger/balance/${lia.pk}`);
    assert(liaOwn.body?.floor === -750, `and the 150 is back on Lia's own line: -750 (${liaOwn.body?.floor})`);
    const s251 = await spendAs(lia, liaCo, 251);
    assert(refused(s251), `a 251-Bean spend is refused (${said(s251)})`);

    // ── 6. the dial off: a released joining pledge gives the floor back ──────────────────────────
    console.log('── 6. the dial off: a joining pledge released in full ──');
    await dial(false);
    const lee = makeMember('Lee');
    const leeEarned = earnByTrading(lee, 6);
    const leeCo = makeEnterprise('Lee Co');
    assert((await join(lee, leeCo, leeEarned, ada)).status === 200, `Lee joins Lee Co with all ${leeEarned} of his earned credit`);
    assert(allAt(await floors(leeCo), -leeEarned), `Lee Co reads -${leeEarned}`);
    const leeRelease = await call('POST', lee, `/api/enterprise/${leeCo}/release`, {});
    const f6 = await floors(leeCo);
    assert(leeRelease.status === 200 && pledgeRows(leeCo).length === 0 && allAt(f6, 0) && figure(leeCo, lee) === leeEarned,
        `releasing it all gives the floor back: 0, though the joining figure says ${leeEarned} (${show(leeRelease)}; ${JSON.stringify(f6)})`);
    const leeSpend = await spendAs(lee, leeCo, 50);
    assert(refused(leeSpend), `and a 50-Bean spend with nothing pledged is refused (${said(leeSpend)})`);
    await dial(true);
    assert(confirmationDialOn(db) && dialRow() === null, `switched back on, the 'off' row is gone: the default again (${dialRow()})`);

    // ── 7. unbinding ────────────────────────────────────────────────────────────────────────────
    console.log('── 7. unbinding ──');
    const pia = makeMember('Pia');
    const quin = makeMember('Quin');
    confirm(pia, ada);
    const piaCo = makeEnterprise('Pia Co');
    adminAssignTreasuryOperator(piaCo, quin.pk, 'admin');
    assert((await join(pia, piaCo, 300, ada)).status === 200 && (await floors(piaCo)).spend === -300, 'Pia joins Pia Co with a known 300: -300');
    const stepped = await call('POST', pia, `/api/enterprise/${piaCo}/keepers/step-down`, {});
    const f7 = await floors(piaCo);
    assert(stepped.status === 200 && stepped.body?.releasedBacking === 300 && allAt(f7, 0),
        `she steps down while it owes nothing: her 300 is released and the floor is 0 (${show(stepped)}; ${JSON.stringify(f7)})`);
    const quinSpend = await spendAs(quin, piaCo, 10);
    assert(refused(quinSpend), `and Quin can spend nothing for it (${said(quinSpend)})`);

    const ria = makeMember('Ria');
    confirm(ria, ada);
    const riaCo = makeEnterprise('Ria Co');
    assert((await join(ria, riaCo, 500, ada)).status === 200, 'Ria joins Ria Co with a known 500');
    const riaSpend = await spendAs(ria, riaCo, 400);
    assert(spent(riaSpend, 400) && getBalance(riaCo).balance === -400, `Ria Co spends 400 of it (${said(riaSpend)}; ${getBalance(riaCo).balance})`);
    const unbound = await call('DELETE', null, `/api/local/admin/treasury/${riaCo}/operators/${ria.pk}`, undefined, owner);
    const f7b = await floors(riaCo);
    assert(unbound.status === 200 && JSON.stringify(pledgeRows(riaCo)) === JSON.stringify(['known 400']) && allAt(f7b, -400) && !f7b.frozen,
        `the owner unbinds her in debt: the 400 the debt needs stays locked, counted once: -400 (${show(unbound)}; ${pledgeRows(riaCo)}; ${JSON.stringify(f7b)})`);
    assert(buyInProcess(riaCo, 1) === 0, 'a buy one Bean more moves nothing');
    const riaOwn = await call('GET', ria, `/api/ledger/balance/${ria.pk}`);
    assert(riaOwn.body?.floor === -600 && 600 + 400 <= 1000, `Ria's own line is 1,000 less the 400 still locked: -600 (${riaOwn.body?.floor})`);

    // ── 8. a stored row as origin/main wrote it ──────────────────────────────────────────────────
    console.log('── 8. a stored row from before ──');
    // origin/main has no backingFigureDrift: looked up by name so the rest of this suite still runs there, fail-first.
    const drift = (se as Record<string, unknown>).backingFigureDrift as undefined | (() => { enterprises: number; frozen: number });
    const driftBefore = drift?.() ?? { enterprises: NaN, frozen: NaN };
    const oli = makeMember('Oli');
    confirm(oli, ada);
    const oldCo = makeEnterprise('Old Co');
    // What bindApprovedKeeper wrote for a known 500 joining pledge: the figure 500 and one known row of 500. Old Co spent
    // 900 on it, as origin/main's floor (-1,000) let it: a legacy line stands in for that floor here, then goes.
    db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by, backing) VALUES (?, ?, 'keeper', ?, 500)").run(oldCo, oli.pk, ada.pk);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(oli.pk);
    db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at) VALUES (?, ?, ?, 500, ?)').run(`known:${crypto.randomUUID()}`, oli.pk, oldCo, ago(DAY));
    db.prepare('UPDATE members SET legacy_credit_floor = 900 WHERE public_key = ?').run(oldCo);
    assert(buyInProcess(oldCo, 900) === 900, 'Old Co owes 900 from before');
    db.prepare('UPDATE members SET legacy_credit_floor = NULL WHERE public_key = ?').run(oldCo);
    const f8 = await floors(oldCo);
    assert(allAt(f8, -500) && f8.balance === -900 && f8.frozen === true,
        `it reads its pledge, -500, owes the 900 still and is spend-frozen: nothing clawed back (${JSON.stringify(f8)})`);
    const oldSpend = await spendAs(oli, oldCo, 1);
    assert(refused(oldSpend) && getBalance(oldCo).balance === -900, `a 1-Bean spend is refused (${said(oldSpend)})`);
    const driftAfter = drift?.() ?? { enterprises: NaN, frozen: NaN };
    assert(driftAfter.enterprises === driftBefore.enterprises + 1 && driftAfter.frozen === driftBefore.frozen + 1,
        `backingFigureDrift counts it: one more enterprise whose floor came down, and one more spend-frozen (${JSON.stringify(driftBefore)} → ${JSON.stringify(driftAfter)})`);
    assert(figure(oldCo, oli) === 500 && pledgeRows(oldCo).length === 1, 'and nothing was rewritten: the figure is 500, the pledge row is there');

    // ── 9. conservation ─────────────────────────────────────────────────────────────────────────
    console.log('── 9. conservation ──');
    const sum = (db.prepare("SELECT COALESCE(SUM(balance), 0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'").get() as { s: number }).s;
    assert(Math.abs(sum + getCommonsBalanceExact()) < 1e-6, `every balance and the commons still add up to zero (${sum + getCommonsBalanceExact()})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
