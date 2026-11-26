/**
 * An enterprise takes up a member's Offer priced for each one, by one keeper's tap: POST /api/treasury/:treasury/take-up
 * (scratch/fable-design/DESIGN-stall-consignment-fable.md §5, §6 slice 1, §7; Marty, 26 Nov 2026). A stall that sold a
 * member's goods for cash has bought them with Beans: buyer the enterprise, seller the member, one fee. Every request is
 * signed and goes through the real HTTPS server and its signature middleware; after every money step the ledger audit is
 * clean and every account plus the Commons sums to 0, with ===. Each stall gets its room the real way: its keepers pledge
 * credit they earned in finished trades (POST /api/enterprise/:id/backing), and it keeps Offers of its own on the board.
 * Each check names the change that turns it red.
 *
 *   0. The switches: deals held in trust off, and Beans off, refuse the route before its handler (404 feature_off), and
 *      the features answer says enterpriseTakeUp only where enterprises, treasuries, escrow and Beans are all on.
 *   1. THE UNMEASURED PATH: a keeper takes up a NON-keeper's Offer, 3 of 5 at 20 Beans: the enterprise −60.00, the seller
 *      +59.10, the Commons +0.90, the count 2, the deal completed with buyer the enterprise, and the keeper on the rows.
 *   2. No double fee, conserved: odd prices, counts 1 and 3, the price for all; then the design's Saturday (§5.4).
 *   3. Two people: a keeper's own Offer (403 TWO_PERSON_RULE), a member who keeps nothing, a keeper of another enterprise.
 *   4. Rules 5 and 6: a keeper's Offer, with the enterprise at 0, with Beans that came as a gift, with earned surplus.
 *   5. Each-priced Offers only: refused before the engine (no deferred wage claim), and every other kind of listing.
 *   6. A body naming a key that is not the signer's: refused by the signature middleware.
 *   7. Room: at the usable floor, no Offer of its own, paused, winding up and wound up.
 *   8. The count: more than are left, a wrong total, a price changed under the keeper, bad counts, two keepers at once.
 *   9. Retry, by the state each window leaves: the same request twice (and on the last one), the same id for another
 *      count, a hold with no id written, a hold with its id written, a deal its seller cancelled.
 *  10. Held, not released: a real state where the release is refused after the hold stands, and what follows.
 *  11. No member's balance, floor, credit or allowance in any answer, push or kept notice; the enterprise's book read by
 *      another member names no seller.
 *  12. The gates: a standby, and the money limits.
 *  13. Trust unchanged: a sale to the enterprise counts as any finished deal, capped at 500 with it; a send adds nothing.
 *  14. Rule 7: Beans members send to an enterprise with a ceiling are never swept.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-enterprise-take-up)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { db } from './db/db.js';
import { wrapCreatePost } from './post-test-helper.js';
import {
    initStateEngine, transfer, createPost as rawCreatePost, runLedgerAudit, getCommonsBalanceExact, registerPushToken,
    createTreasury, adminAssignTreasuryOperator, acceptPost, getBalance, getMemberTrustProfile, pauseEnterprise, resumeEnterprise,
    initiateWindUp, finaliseWindUp, sweepEnterpriseCeiling, runWashTradingAnalysis, clearWashTradingCache, createGroup,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setNodeRole } from './config/node-role.js';
import { getNodeFeatures, setSwitchOverride } from './config/node-profile.js';
import { moneyRequestOf, recordAnswer } from './engine/money-requests.js';
import { TAKE_UP_ROUTE } from './routes/treasury.js';
import { setMemberPhoto } from '@beanpool/engine';
import { feeOf, itemTakeUpRefusalText, wordsFor, type ItemTakeUpRefusal } from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
// Expo is answered here, so who is told what is read from the notices this server keeps; nothing else off it is reached.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://exp.host')) {
        const msgs = JSON.parse(String(init?.body ?? '[]'));
        return new Response(JSON.stringify({ data: (Array.isArray(msgs) ? msgs : [msgs]).map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (!url.startsWith('https://localhost')) throw new Error(`test-enterprise-take-up: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const EN = wordsFor('en');
const says = (code: ItemTakeUpRefusal, count?: number) => itemTakeUpRefusalText({ code, count }, EN);
/** The story's figures are Beans; the node's are whole hundredths. */
const hc = (beans: number) => Math.round(beans * 100);
const DAY = 86_400_000;
const EPOCH_NOW = Math.floor(Date.now() / DAY);
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
let BASE = '';
type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}

/** A member a month in, with a photo, an Offer of their own (they may take one up) and a phone; `beans` from genesis. */
function makeMember(callsign: string, beans = 0): Id {
    const id = keypair(callsign);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, status, updated_at)
                VALUES (?, ?, ?, 'genesis', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pk, callsign, new Date(Date.now() - 30 * DAY).toISOString());
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, EPOCH_NOW);
    if (beans > 0) transfer('genesis', id.pk, hc(beans), `seed ${callsign}`, 'direct', true);
    createPost('offer', 'general', `${callsign}'s odd jobs`, 'Help around the place', hc(5), 'fixed', id.pk, undefined, undefined, undefined, true);
    registerPushToken(id.pk, `ExponentPushToken[takeup-${id.pk.slice(0, 10)}]`, 'android');
    return id;
}

/** A finished trade in a member's history (the send gate, and earned credit), as the trust suites write one: no Bean moves. */
function finishedTrade(buyer: string, seller: string, beans: number): void {
    const post = `takeup-done-${crypto.randomUUID()}`;
    db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, status) VALUES (?, 'offer', 'misc', 'done', 'done', ?, ?, 'completed')`)
        .run(post, hc(beans), seller);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status) VALUES (?, ?, ?, ?, ?, 'completed')`)
        .run(`takeup-mtx-${crypto.randomUUID()}`, post, buyer, seller, hc(beans));
}

/** Finished trades of 500 Beans with `n` different members: credit a keeper has earned, and may pledge. */
function earnByTrading(member: Id, n: number): number {
    for (let i = 0; i < n; i++) {
        const peer = keypair(`${member.callsign} peer ${i}`);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, status) VALUES (?, ?, ?, 'genesis', 'active')`)
            .run(peer.pk, peer.callsign, new Date(Date.now() - 30 * DAY).toISOString());
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, ?)').run(peer.pk, EPOCH_NOW);
        finishedTrade(member.pk, peer.pk, 500);
    }
    return getMemberTrustProfile(member.pk).earnedCredit;
}

async function call(method: 'GET' | 'POST', urlPath: string, id: Id, body?: unknown) {
    resetGatewayRateLimit();
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${urlPath}`, {
        method,
        headers: {
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
            'X-Public-Key': id.pk,
            'X-Signature': signRequest(id.privateKey, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, ...(method === 'POST' ? { body: raw } : {}) }),
            [SIGNED_FOR_HEADER]: signedForHost(),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        ...(method === 'POST' ? { body: raw } : {}),
    });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: json, text };
}
const post = (id: Id, urlPath: string, body: unknown) => call('POST', urlPath, id, body);
const brief = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}`;

const bal = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c ?? 0;
const commons = () => getCommonsBalanceExact();
type ListingRow = { status: string; units_left: number | null };
const listing = (id: string) => db.prepare('SELECT status, units_left FROM posts WHERE id = ?').get(id) as ListingRow;
type DealRow = { status: string; amount_c: number; hours: number | null; item_option: string | null; buyer_pubkey: string; seller_pubkey: string };
const deal = (id: string) => db.prepare('SELECT status, amount_c, hours, item_option, buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE id = ?').get(id) as DealRow;
const dealsOn = (postId: string) => (db.prepare('SELECT COUNT(*) AS n FROM marketplace_transactions WHERE post_id = ?').get(postId) as { n: number }).n;
const claims = (ent: string) => (db.prepare('SELECT COUNT(*) AS n FROM deferred_wage_claims WHERE enterprise_pubkey = ?').get(ent) as { n: number }).n;
const surplus = (ent: string) => Number((db.prepare('SELECT earned_surplus_c FROM members WHERE public_key = ?').get(ent) as { earned_surplus_c: number | null }).earned_surplus_c ?? 0);
function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as { t: number }).t;
    return accounts + getCommonsBalanceExact();
}
/** The conservation check after a money step: the audit clean, and every account plus the Commons summing to 0, exactly. */
function conserved(step: string): void {
    const a = runLedgerAudit();
    assert(a.ok && a.drift === 0 && a.strandedEscrows === 0 && a.badBalances === 0 && nodeTotal() === 0,
        `the Beans add up after ${step} (drift ${a.drift}, stranded ${a.strandedEscrows}, not a number ${a.badBalances}, total ${nodeTotal()})`);
}
/** All a refused take-up could change: every balance, every deal and its state, every count, every wage claim and request id. */
function moneyPrint(): string {
    return JSON.stringify([
        db.prepare('SELECT public_key, balance_c FROM accounts ORDER BY public_key').all(),
        db.prepare('SELECT id, status FROM marketplace_transactions ORDER BY id').all(),
        db.prepare('SELECT id, status, units_left FROM posts WHERE units_left IS NOT NULL ORDER BY id').all(),
        db.prepare('SELECT COUNT(*) AS n FROM deferred_wage_claims').get(),
        db.prepare('SELECT COUNT(*) AS n FROM money_requests').get(),
        db.prepare('SELECT public_key, earned_surplus_c FROM members WHERE is_treasury = 1 ORDER BY public_key').all(),
    ]);
}
const acts = (account: string, keeper: string) => db.prepare(`SELECT kind, COUNT(*) AS n FROM money_acts WHERE account = ? AND keeper = ? GROUP BY kind ORDER BY kind`)
    .all(account, keeper) as Array<{ kind: string; n: number }>;
const actsCount = (account: string, keeper: string, kind: string) => acts(account, keeper).find(a => a.kind === kind)?.n ?? 0;
const pushMark = (): number => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM push_notices').get() as { m: number }).m;
const pushesSince = (mark: number) => db.prepare('SELECT recipient, title, body, data FROM push_notices WHERE rowid > ? ORDER BY rowid').all(mark) as Array<Record<string, string>>;
const keptMark = (): number => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM moderation_notices').get() as { m: number }).m;
const keptSince = (mark: number) => db.prepare('SELECT * FROM moderation_notices WHERE rowid > ? ORDER BY rowid').all(mark) as Array<Record<string, unknown>>;

/** An Offer priced for each one, made by its author as the engine's create does (the listing is not what is tested here). */
function eachOffer(who: string, title: string, price: number, units: number, lot?: number): string {
    const p = createPost('offer', 'produce', title, `${title}, priced for each one`, hc(price), 'each', who, undefined, undefined, undefined, undefined, undefined, undefined,
        { unitsLeft: units, ...(lot !== undefined ? { lot: { price_c: hc(lot) } } : {}) });
    if (!p) throw new Error(`could not make ${title}`);
    return p.id;
}

async function main(): Promise<void> {
    console.log('An enterprise takes up a member\'s Offer priced for each one\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    /** A take-up as the apps will send it: the accept route's own body, no key in it. */
    const takeUp = (keeper: Id, ent: string, body: Record<string, unknown>) => post(keeper, `/api/treasury/${ent}/take-up`, body);
    const each = (postId: string, n: unknown, expect: number, extra: Record<string, unknown> = {}) => ({ postId, hours: n, itemOption: 'each', expect_c: hc(expect), ...extra });
    /** A take-up that must be refused: this status (and code), nothing held, no deal, the count as it was, no wage claim. */
    const refused = async (label: string, keeper: Id, ent: string, body: Record<string, unknown>, want: { status: number; code?: string; error?: string | RegExp; unitsLeft?: number }) => {
        const before = moneyPrint();
        const r = await takeUp(keeper, ent, body);
        const wordsOk = want.error === undefined ? true : typeof want.error === 'string' ? r.body?.error === want.error : want.error.test(String(r.body?.error ?? ''));
        assert(r.status === want.status && (want.code === undefined || r.body?.code === want.code) && wordsOk
            && (want.unitsLeft === undefined || r.body?.unitsLeft === want.unitsLeft) && moneyPrint() === before,
            `${label}: refused ${want.status}${want.code ? ` ${want.code}` : ''}, nothing held, the count as it was (${brief(r)})`);
        return r;
    };

    // ── 0. The switches, before any Bean moves (a money switch can be off only on a node whose ledger never moved) ─────
    console.log('— 0. The switches');
    const kim = makeMember('Kim');        // a keeper of every stall here
    const kay = makeMember('Kay');        // a second keeper
    const alice = makeMember('Alice');    // sells her produce through the stall; keeps nothing
    const { publicKey: riverside } = createTreasury('Riverside stall', AVATAR);
    adminAssignTreasuryOperator(riverside, kim.pk);
    adminAssignTreasuryOperator(riverside, kay.pk);
    const early = eachOffer(alice.pk, 'Quinces', 4, 5);
    assert(getNodeFeatures().enterpriseTakeUp === true, 'a local community with every switch on says enterpriseTakeUp');
    for (const off of ['escrow', 'beans'] as const) {
        setSwitchOverride(off, false);
        const before = moneyPrint();
        const actsBefore = (db.prepare('SELECT COUNT(*) AS n FROM money_acts').get() as { n: number }).n;
        const r = await takeUp(kim, riverside, each(early, 1, 4));
        // Red if the take-up path leaves the escrow group of routes/profile-feature-gate.ts (with Beans off, escrow is off too).
        assert(r.status === 404 && r.body?.code === 'feature_off' && r.body?.feature === 'escrow' && moneyPrint() === before
            && (db.prepare('SELECT COUNT(*) AS n FROM money_acts').get() as { n: number }).n === actsBefore,
            `with ${off === 'escrow' ? 'deals held in trust' : 'Beans'} off: refused before the handler, 404 feature_off, nothing written or counted (${brief(r)})`);
        assert(getNodeFeatures().enterpriseTakeUp === undefined, `and the features answer leaves enterpriseTakeUp out with ${off} off`);
        setSwitchOverride(off, true);
    }
    for (const off of ['enterprises', 'treasuries'] as const) {
        setSwitchOverride(off, false);
        assert(getNodeFeatures().enterpriseTakeUp === undefined, `the features answer leaves enterpriseTakeUp out with ${off} off`);
        setSwitchOverride(off, true);
    }
    assert(getNodeFeatures().enterpriseTakeUp === true, 'every switch back on: enterpriseTakeUp is said again');

    // The stalls' room, the real way: keepers pledge what they earned in finished trades; each stall keeps its own Offers.
    const kimEarned = earnByTrading(kim, 14);
    const kayEarned = earnByTrading(kay, 14);
    assert(kimEarned >= hc(1000) && kayEarned >= hc(1000), `Kim and Kay have each earned credit to pledge (${kimEarned}, ${kayEarned})`);
    const pledge = async (keeper: Id, ent: string, beans: number) => {
        const r = await post(keeper, `/api/enterprise/${ent}/backing`, { amount_c: hc(beans) });
        if (r.status !== 200) throw new Error(`${keeper.callsign} could not pledge ${beans} to ${ent.slice(0, 8)}: ${brief(r)}`);
    };
    const ownOffers = (ent: string, name: string, n: number, price = 10) => {
        for (let i = 0; i < n; i++) createPost('offer', 'produce', `${name} preserves ${i + 1}`, 'From the stall itself', hc(price), 'fixed', ent);
    };
    /** A stall: an ordinary enterprise, its keepers, its own Offers, its keepers' pledges. */
    const makeStall = async (name: string, keepers: Id[], pledges: Array<[Id, number]>, offers = 3, opts: Parameters<typeof createTreasury>[3] = {}) => {
        const { publicKey } = createTreasury(name, AVATAR, 0, opts);
        for (const k of keepers) adminAssignTreasuryOperator(publicKey, k.pk);
        ownOffers(publicKey, name, offers);
        for (const [k, beans] of pledges) await pledge(k, publicKey, beans);
        return publicKey;
    };
    ownOffers(riverside, 'Riverside stall', 3);
    await pledge(kim, riverside, 200);
    await pledge(kay, riverside, 200);
    assert(getBalance(riverside).usableFloor_c === -hc(400), `Riverside stall can go 400 Beans into the red: its keepers' pledges, under its three Offers' band (${getBalance(riverside).usableFloor_c})`);
    conserved('the stalls are set up');

    // ── 1. THE UNMEASURED PATH ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 1. A keeper takes up a member\'s Offer for the enterprise');
    const apples = eachOffer(alice.pk, 'Apples, crate', 20, 5);
    const c0 = commons(), a0 = bal(alice.pk);
    const first = await takeUp(kim, riverside, each(apples, 3, 60));
    const firstTx = first.body?.transaction?.id as string;
    const row = firstTx ? deal(firstTx) : null;
    // Red if the route is missing, or the engine cannot take up a non-keeper's Offer for an enterprise and release it.
    assert(first.status === 200 && first.body?.success === true && first.body?.released === true && first.body?.replay === undefined && first.body?.error === undefined,
        `Kim takes up 3 of Alice's 5 crates for Riverside stall: 200, released (${brief(first)})`);
    assert(bal(riverside) === -hc(60) && bal(alice.pk) - a0 === hc(59.10) && commons() - c0 === hc(0.90) && feeOf(hc(60)) === hc(0.90),
        `the stall is −60.00, Alice +59.10, the Commons +0.90: feeOf once on the whole (${bal(riverside)}, +${bal(alice.pk) - a0}, +${commons() - c0})`);
    assert(listing(apples).units_left === 2 && listing(apples).status === 'active', `the count is 2 and the listing stays up (${JSON.stringify(listing(apples))})`);
    assert(row?.status === 'completed' && row.buyer_pubkey === riverside && row.seller_pubkey === alice.pk && row.item_option === 'each' && row.hours === 3 && row.amount_c === hc(60),
        `the deal row: completed, buyer the stall, seller Alice, item_option each, hours 3, 60 Beans (${JSON.stringify(row)})`);
    const signed = db.prepare(`SELECT from_pubkey, to_pubkey, amount_c, auth_signer FROM transactions WHERE (from_pubkey = ? AND to_pubkey = ?) OR (from_pubkey = ? AND to_pubkey = ?)`)
        .all(riverside, `escrow_${firstTx}`, `escrow_${firstTx}`, alice.pk) as Array<{ auth_signer: string | null }>;
    // Red if the route drops authSigner: the hold and the release would carry no keeper.
    assert(signed.length === 2 && signed.every(r => r.auth_signer === kim.pk), `the hold and the release carry Kim as the auth signer (${JSON.stringify(signed)})`);
    conserved('the first take-up');

    // ── 2. No double fee, conserved ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. No double fee');
    const bea = makeMember('Bea');
    for (const price of [0.01, 0.66, 0.67, 12.35, 19.99]) {
        const lotPrice = price;   // the price for all three, an odd figure too
        const id = eachOffer(bea.pk, `Jam at ${price}`, price, 10);
        const lotId = eachOffer(bea.pk, `Jam, three at ${price}`, price, 3, lotPrice);
        for (const [label, body, total] of [
            [`1 at ${price}`, each(id, 1, price), hc(price)],
            [`3 at ${price}`, each(id, 3, price * 3), hc(price) * 3],
            [`all 3 for ${lotPrice}`, { postId: lotId, hours: 3, itemOption: 'lot', expect_c: hc(lotPrice) }, hc(lotPrice)],
        ] as const) {
            const s0 = bal(riverside), b0 = bal(bea.pk), k0 = commons();
            const r = await takeUp(kim, riverside, body as Record<string, unknown>);
            // Red if a take-up is charged twice (a fee on the hold and the release), or the enterprise pays more than the total.
            assert(r.status === 200 && r.body?.released === true && commons() - k0 === feeOf(total) && bal(bea.pk) - b0 === total - feeOf(total) && s0 - bal(riverside) === total,
                `${label}: the Commons +${feeOf(total)}, Bea +${total - feeOf(total)}, the stall −${total} (${brief(r)})`);
            conserved(`a take-up of ${label}`);
        }
    }

    // The design's Saturday (§5.4), with its own figures, on a stall that starts at 0.
    console.log('\n— 2b. The Saturday of the design');
    const marketLane = await makeStall('Market Lane stall', [kim, kay], [[kim, 150], [kay, 150]]);
    const dana = makeMember('Dana', 50);
    const erin = makeMember('Erin', 8);
    const bob = makeMember('Bob', 800);
    finishedTrade(dana.pk, erin.pk, 1);   // Erin and Bob have each finished a trade before: the send gate
    finishedTrade(dana.pk, bob.pk, 1);
    const crates = eachOffer(alice.pk, 'Apples, crate, Saturday', 20, 3);
    const start = { alice: bal(alice.pk), dana: bal(dana.pk), erin: bal(erin.pk), bob: bal(bob.pk), stall: bal(marketLane), commons: commons() };
    assert(start.stall === 0 && start.dana === hc(50) && start.erin === hc(8) && start.bob === hc(800), 'Saturday starts: the stall 0, Dana 50, Erin 8, Bob 800');
    const danaTakes = await post(dana, '/api/marketplace/posts/accept', { postId: crates, buyerPublicKey: dana.pk, hours: 1, itemOption: 'each', expect_c: hc(20) });
    const danaDone = await post(dana, '/api/marketplace/transactions/complete', { transactionId: danaTakes.body?.transaction?.id, confirmerPublicKey: dana.pk });
    assert(danaTakes.status === 200 && danaDone.status === 200 && bal(alice.pk) - start.alice === hc(19.70) && listing(crates).units_left === 2,
        `1. Dana takes 1 crate and releases: Alice +19.70, 2 left (${brief(danaDone)})`);
    conserved('step 1');
    const cash1 = await takeUp(kim, marketLane, each(crates, 1, 20));
    assert(cash1.status === 200 && cash1.body?.released === true && bal(marketLane) === -hc(20) && bal(alice.pk) - start.alice === hc(39.40) && listing(crates).units_left === 1,
        `2. a visitor pays cash, Kim taps: the stall −20.00, Alice +39.40, 1 left (${brief(cash1)})`);
    conserved('step 2');
    const cash2 = await takeUp(kim, marketLane, each(crates, 1, 20));
    assert(cash2.status === 200 && cash2.body?.released === true && bal(marketLane) === -hc(40) && bal(alice.pk) - start.alice === hc(59.10)
        && listing(crates).units_left === 0 && listing(crates).status === 'completed',
        `3a. Erin pays the rest in cash, Kim taps: the stall −40.00, Alice +59.10, sold out (${brief(cash2)} ${JSON.stringify(listing(crates))})`);
    conserved('step 3a');
    const commonsBeforeSends = commons();
    const erinSends = await post(erin, '/api/ledger/transfer', { to: marketLane, amount_c: hc(8), memo: 'for the apples' });
    assert(erinSends.status === 200 && bal(erin.pk) === 0 && bal(marketLane) === -hc(32) && commons() === commonsBeforeSends,
        `3b. Erin sends her 8 Beans to the stall: no fee, the stall −32.00 (${brief(erinSends)})`);
    conserved('step 3b');
    const bobSends = await post(bob, '/api/ledger/transfer', { to: marketLane, amount_c: hc(32), memo: 'cash from the tin' });
    assert(bobSends.status === 200 && bal(bob.pk) === hc(768) && bal(marketLane) === 0 && commons() === commonsBeforeSends,
        `4. Bob sends the stall 32 Beans for cash from the tin: no fee, the stall exactly 0 (${brief(bobSends)})`);
    assert(bal(alice.pk) - start.alice === hc(59.10) && commons() - start.commons === hc(0.90) && bal(marketLane) === 0
        && bal(dana.pk) - start.dana === -hc(20) && bal(erin.pk) - start.erin === -hc(8) && bal(bob.pk) - start.bob === -hc(32),
        'the Saturday ends: Alice +59.10, Dana −20, Erin −8, Bob −32, the stall 0, the Commons +0.90 (1.5% of 60, one fee per crate)');
    conserved('the Saturday');

    // ── 3. Two people ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 3. Two people');
    const honey = eachOffer(kim.pk, 'Kim\'s honey', 10, 5);
    const nell = makeMember('Nell', 20);     // keeps nothing
    const otto = makeMember('Otto');         // keeps another enterprise
    const { publicKey: hillside } = createTreasury('Hillside co-op', AVATAR);
    adminAssignTreasuryOperator(hillside, otto.pk);
    ownOffers(hillside, 'Hillside co-op', 1);
    // Red if the engine's two-person rule at the hold is skipped for a take-up (the route passes no authSigner).
    await refused('Kim takes up her own honey for Riverside stall', kim, riverside, each(honey, 1, 10), { status: 403, code: 'TWO_PERSON_RULE', error: /Another keeper of Riverside stall/ });
    await refused('Nell, who keeps nothing, takes up Alice\'s crates for Riverside stall', nell, riverside, each(apples, 1, 20), { status: 403, error: 'You are not a keeper of this enterprise' });
    await refused('Otto, a keeper of Hillside co-op, takes up Alice\'s crates for Riverside stall', otto, riverside, each(apples, 1, 20), { status: 403, error: 'You are not a keeper of this enterprise' });

    // ── 4. Rules 5 and 6 ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 4. Rules 5 and 6');
    const creekside = await makeStall('Creekside stall', [kim, kay], [[kim, 100]]);
    ownOffers(creekside, 'Creekside stall big', 1, 50);
    assert(bal(creekside) === 0 && getBalance(creekside).usableFloor_c === -hc(100), `Creekside stall is at 0 with room to spare (${getBalance(creekside).usableFloor_c})`);
    // Red if a take-up for an enterprise could pay its own keeper from its credit line (Rule 5), or recorded a wage claim.
    await refused('Kay takes up Kim\'s honey for Creekside stall at 0', kay, creekside, each(honey, 1, 10),
        { status: 403, error: 'Creekside stall is in deficit and cannot borrow to pay its keepers — credit buys inputs, but keepers can only be paid from profit.' });
    assert(claims(creekside) === 0, 'and no deferred wage claim is written');
    const gift = await post(bob, '/api/ledger/transfer', { to: creekside, amount_c: hc(30), memo: 'a gift' });
    assert(gift.status === 200 && bal(creekside) === hc(30) && surplus(creekside) === 0, `Bob gives Creekside stall 30 Beans: above 0, earned surplus 0 (${brief(gift)})`);
    conserved('the gift');
    // Red if Rule 6 is bypassed: a gift is not profit.
    await refused('Kay takes up Kim\'s honey with gifted Beans only', kay, creekside, each(honey, 1, 10), { status: 403, error: /insufficient earned surplus/ });
    assert(claims(creekside) === 0, 'and still no deferred wage claim');
    const big = (db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND title = 'Creekside stall big preserves 1'").get(creekside) as { id: string }).id;
    const bobBuys = await post(bob, '/api/marketplace/posts/accept', { postId: big, buyerPublicKey: bob.pk });
    const bobReleases = await post(bob, '/api/marketplace/transactions/complete', { transactionId: bobBuys.body?.transaction?.id, confirmerPublicKey: bob.pk });
    assert(bobReleases.status === 200 && surplus(creekside) === hc(50) && bal(creekside) === hc(30) + hc(50) - feeOf(hc(50)),
        `Bob buys Creekside stall's own preserves for 50: earned surplus 50 (${surplus(creekside)}, balance ${bal(creekside)})`);
    conserved('the stall\'s own sale');
    const kimBefore = bal(kim.pk);
    const paid = await takeUp(kay, creekside, each(honey, 1, 10));
    assert(paid.status === 200 && paid.body?.released === true && bal(kim.pk) - kimBefore === hc(10) - feeOf(hc(10)) && surplus(creekside) === hc(40) && claims(creekside) === 0,
        `with Beans above 0 and earned surplus to cover it: Kim is paid ${hc(10) - feeOf(hc(10))}, and earned surplus falls by 10 (${brief(paid)}, surplus ${surplus(creekside)})`);
    conserved('the keeper paid from profit');

    // ── 5. Each-priced Offers only ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 5. Each-priced Offers only');
    const ladder = createPost('offer', 'tools', 'Kim\'s ladder', 'A good ladder', hc(80), 'fixed', kim.pk)!.id;
    assert(bal(creekside) < hc(80), `Creekside stall can't pay Kim 80 for the ladder (${bal(creekside)})`);
    // Red if the route reaches the engine first: assertHoldFunded records a deferred wage claim for a one-off price.
    await refused('Kay takes up Kim\'s one-off ladder the stall can\'t pay for', kay, creekside, { postId: ladder, hours: 1, itemOption: 'each', expect_c: hc(80) },
        { status: 400, code: 'take_up_each_only', error: 'An enterprise can take up only an Offer priced for each one.' });
    assert(claims(creekside) === 0, 'and no deferred wage claim is written for it');
    const hourly = createPost('offer', 'garden', 'Alice\'s weeding', 'By the hour', hc(15), 'hourly', alice.pk)!.id;
    const need = createPost('need', 'garden', 'Alice needs mulch', 'Mulch wanted', hc(5), 'fixed', alice.pk)!.id;
    const eventAt = new Date(Date.now() + 3 * DAY);
    const event = createPost('event', 'community', 'Market morning', 'Come along', 0, 'fixed', alice.pk, -28.6, 153.6, undefined, false, undefined, false,
        { eventStartAt: eventAt.toISOString(), eventEndAt: new Date(eventAt.getTime() + 2 * 3600_000).toISOString(), eventPlaceName: 'Riverside hall' })!.id;
    const poll = createPost('poll', 'general', 'Which market day?', 'Pick one', 0, 'fixed', alice.pk, undefined, undefined, undefined, false, undefined, false,
        { pollOptions: [{ id: 'sat', text: 'Saturday' }, { id: 'sun', text: 'Sunday' }], durationDays: 7 })!.id;
    const knowledge = `takeup-knowledge-${crypto.randomUUID()}`;
    db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, price_type, author_pubkey, status, active) VALUES (?, 'knowledge', 'local', 'Where the river floods', 'A page', 0, 'fixed', ?, 'active', 1)`)
        .run(knowledge, alice.pk);
    const lendable = createPost('offer', 'tools', 'Alice\'s wheelbarrow', 'To borrow', hc(3), 'daily', alice.pk, undefined, undefined, undefined, false, undefined, false,
        { lendable: true, lendMaxDays: 3 })!.id;
    const copy = eachOffer(alice.pk, 'Pears, a copy', 2, 5);
    db.prepare("UPDATE posts SET shown_from_host = 'home.example' WHERE id = ?").run(copy);
    const group = createGroup({ name: 'Riverside growers', createdBy: alice.pk, category: 'social' });
    const groupPost = createPost('offer', 'produce', 'Figs for the group', 'Group only', hc(2), 'each', alice.pk, undefined, undefined, undefined, false, undefined, false,
        { unitsLeft: 5, audienceScope: 'group', targetGroupId: group.id })!.id;
    const directPost = createPost('offer', 'produce', 'Figs for Nell', 'For one person', hc(2), 'each', alice.pk, undefined, undefined, undefined, false, undefined, false,
        { unitsLeft: 5, audienceScope: 'direct', targetPubkey: nell.pk })!.id;
    const ownEach = eachOffer(riverside, 'Riverside stall chutney', 6, 5);
    const EACH_ONLY = { status: 400, code: 'take_up_each_only', error: 'An enterprise can take up only an Offer priced for each one.' };
    await refused('an hourly Offer', kim, riverside, each(hourly, 1, 15), EACH_ONLY);
    await refused('a Need', kim, riverside, each(need, 1, 5), EACH_ONLY);
    await refused('an event', kim, riverside, each(event, 1, 0), EACH_ONLY);
    await refused('a poll', kim, riverside, each(poll, 1, 0), EACH_ONLY);
    // A Local knowledge page is a page, never a listing: the listing read leaves it out, so it is an id nobody has here.
    await refused('a Local knowledge page', kim, riverside, each(knowledge, 1, 0), { status: 400, code: 'post_gone', error: 'Post not found or not active' });
    await refused('a lendable Offer', kim, riverside, each(lendable, 1, 3), EACH_ONLY);
    // A copy of another community's listing priced for each one reaches the engine, and meets the copy's own refusal.
    await refused('a member\'s copy', kim, riverside, each(copy, 1, 2), { status: 409, code: 'listing_copy' });
    // Red if each-only is asked before the sight rule: a group's or a direct post's id would be told it exists.
    await refused('a group\'s post the stall can\'t see', kim, riverside, each(groupPost, 1, 2), { status: 400, code: 'post_gone', error: 'Post not found or not active' });
    await refused('a direct post to someone else', kim, riverside, each(directPost, 1, 2), { status: 400, code: 'post_gone', error: 'Post not found or not active' });
    await refused('an id nobody has', kim, riverside, each('no-such-post', 1, 2), { status: 400, code: 'post_gone', error: 'Post not found or not active' });
    await refused('the stall\'s own Offer', kim, riverside, each(ownEach, 1, 6), { status: 400, error: 'Cannot accept your own post' });
    await refused('a body with standing', kim, riverside, each(apples, 1, 20, { standing: { periods: 4 } }), { status: 400, error: 'An enterprise can’t start a standing deal this way.' });
    await refused('a postId that is not text', kim, riverside, { postId: [apples], hours: 1, itemOption: 'each', expect_c: hc(20) }, { status: 400 });
    conserved('the refused listings');

    // ── 6. A key in the body that is not the signer's ──────────────────────────────────────────────────────────────
    console.log('\n— 6. Spoof');
    await refused('a body naming the stall as buyerPublicKey', kim, riverside, each(apples, 1, 20, { buyerPublicKey: riverside }), { status: 403, error: 'Signature validation failed' });
    await refused('a body naming another member as authorPublicKey', kim, riverside, each(apples, 1, 20, { authorPublicKey: alice.pk }), { status: 403, error: 'Signature validation failed' });

    // ── 7. Room ─────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 7. Room');
    const hilltop = await makeStall('Hilltop stall', [kim, kay], [[kay, 50]]);
    const plums = eachOffer(alice.pk, 'Plums, bag', 20, 10);
    const up2 = await takeUp(kim, hilltop, each(plums, 2, 40));
    assert(up2.status === 200 && up2.body?.released === true && bal(hilltop) === -hc(40), `Hilltop stall takes up 2 bags: −40 of its 50 (${brief(up2)})`);
    conserved('Hilltop stall near its floor');
    const atFloor = await refused('one more bag would pass Hilltop stall\'s floor', kim, hilltop, each(plums, 1, 20), { status: 400 });
    const memberNames = [alice, kim, kay, bob, dana, erin, nell].flatMap(m => [m.callsign, m.pk]);
    assert(!memberNames.some(n => atFloor.text.includes(n)), `the words name no member (${atFloor.body?.error})`);
    const orchard = await makeStall('Orchard stall', [kim, kay], [], 0);
    // Pledges without an Offer of its own: the pledge is refused or counts nothing; either way it has no room.
    await post(kay, `/api/enterprise/${orchard}/backing`, { amount_c: hc(50) });
    assert(getBalance(orchard).usableFloor_c === 0, `Orchard stall, with no Offer of its own, has no room (${getBalance(orchard).usableFloor_c})`);
    // The engine asks for an Offer of its own first (CONTRIBUTION_REQUIRED), before its room.
    await refused('Orchard stall, with no Offer of its own and no room, takes up a bag', kim, orchard, each(plums, 1, 20), { status: 400, error: /CONTRIBUTION_REQUIRED/ });
    pauseEnterprise(hilltop, kim.pk);
    await refused('a paused stall takes up a bag', kim, hilltop, each(plums, 1, 20), { status: 400, error: 'Enterprise is paused — cannot transact while paused' });
    resumeEnterprise(hilltop, kim.pk);
    const bridge = await makeStall('Bridge stall', [kim], [], 1);
    initiateWindUp(bridge, kim.pk);
    await refused('a stall winding up takes up a bag', kim, bridge, each(plums, 1, 20), { status: 400, error: /winding up/ });
    db.prepare('UPDATE members SET wind_up_initiated_at = ? WHERE public_key = ?').run(new Date(Date.now() - 8 * DAY).toISOString(), bridge);
    let finalised = '';
    try { finaliseWindUp(bridge, kim.pk); finalised = (db.prepare('SELECT status FROM members WHERE public_key = ?').get(bridge) as { status: string }).status; } catch (e: any) { finalised = `refused: ${e?.message}`; }
    assert(finalised === 'completed', `Bridge stall's wind-up is finalised after its grace (${finalised})`);
    // A wound-up enterprise has no keepers left (its wind-up unbinds them), so the keeper check refuses first.
    await refused('a stall wound up takes up a bag', kim, bridge, each(plums, 1, 20), { status: 403, error: 'You are not a keeper of this enterprise' });
    conserved('the room');

    // ── 8. The count ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 8. The count');
    const pears = eachOffer(alice.pk, 'Pears, bag', 5, 4);
    await refused('5 of 4', kim, riverside, each(pears, 5, 25), { status: 409, code: 'units_gone', unitsLeft: 4, error: says('units_gone', 4) });
    await refused('a total other than 2 × 5', kim, riverside, each(pears, 2, 9), { status: 409, code: 'price_changed', error: says('price_changed') });
    const repriced = await post(alice, '/api/marketplace/posts/update', { id: pears, authorPublicKey: alice.pk, price_c: hc(6) });
    assert(repriced.status === 200, `Alice changes the price to 6 while Kim's screen shows 5 (${brief(repriced)})`);
    await refused('the price changed under the keeper', kim, riverside, each(pears, 2, 10), { status: 409, code: 'price_changed', error: says('price_changed') });
    for (const bad of [2.5, 0, '3', 'abc']) {
        await refused(`a count of ${JSON.stringify(bad)}`, kim, riverside, { postId: pears, hours: bad, itemOption: 'each', expect_c: hc(6) }, { status: 400, code: 'count_refused', error: says('count_refused') });
    }
    const last = eachOffer(alice.pk, 'The last pumpkin', 9, 1);
    const [r1, r2] = await Promise.all([takeUp(kim, riverside, each(last, 1, 9)), takeUp(kay, riverside, each(last, 1, 9))]);
    const won = [r1, r2].filter(r => r.status === 200);
    const lost = [r1, r2].filter(r => r.status !== 200);
    // Red if the count and the hold are not one transaction (two deals for the last one).
    assert(won.length === 1 && won[0].body?.released === true && lost.length === 1 && lost[0].status >= 400 && lost[0].status < 500
        && dealsOn(last) === 1 && listing(last).units_left === 0,
        `two keepers take the last pumpkin at once: one deal, the other refused, the count 0, never below (${brief(r1)} | ${brief(r2)})`);
    conserved('the count');

    // ── 9. Retry ───────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 9. Retry');
    const beans = eachOffer(alice.pk, 'Broad beans, bunch', 2, 10);
    const once = each(beans, 3, 6, { requestId: 'take-up-retry-a-0001' });
    const ra1 = await takeUp(kim, riverside, once);
    const afterOne = moneyPrint();
    const ra2 = await takeUp(kim, riverside, once);
    // Red if a retry with the same request id buys again.
    assert(ra1.status === 200 && ra1.body?.released === true && ra2.status === 200 && ra2.body?.replay === true && ra2.body?.released === true
        && ra2.body?.transaction?.id === ra1.body?.transaction?.id && moneyPrint() === afterOne && dealsOn(beans) === 1 && listing(beans).units_left === 7,
        `(a) the same request twice: one sale, the second answers the first with replay: true, nothing more moved (${brief(ra2)})`);
    const lastBunch = eachOffer(alice.pk, 'The last bunch of herbs', 3, 1);
    const lastOnce = each(lastBunch, 1, 3, { requestId: 'take-up-retry-a-0002' });
    const rl1 = await takeUp(kim, riverside, lastOnce);
    const afterLast = moneyPrint();
    const rl2 = await takeUp(kim, riverside, lastOnce);
    // Red if the retry is answered after the listing is read: the last one sold leaves the listing sold out, and the retry
    // would be told "not found" for a sale that happened.
    assert(rl1.status === 200 && listing(lastBunch).status === 'completed' && rl2.status === 200 && rl2.body?.replay === true
        && rl2.body?.transaction?.id === rl1.body?.transaction?.id && moneyPrint() === afterLast,
        `(a) and on the last one, sold out: the retry gets the sale back, not "not found" (${brief(rl2)})`);
    await refused('(b) the same id with another count', kim, riverside, each(beans, 2, 4, { requestId: 'take-up-retry-a-0001' }), { status: 409, code: 'request_id_reused' });
    // (c) The node died between the hold and the id's write: a hold with no id, made by calling the engine as the route does.
    const heldC = acceptPost(beans, riverside, undefined, { authSigner: kim.pk, item: { n: 1, option: 'each', expect_c: hc(2) } });
    assert(deal(heldC.id).status === 'pending' && listing(beans).units_left === 6, '(c) a hold with no request id written: pending, the count moved once');
    const rc = await refused('(c) the retry meets the open deal', kim, riverside, each(beans, 1, 2, { requestId: 'take-up-retry-c-0001' }), { status: 409, code: 'deal_open' });
    assert(rc.body?.transactionId === heldC.id, `(c) and is told which deal is held (${rc.body?.transactionId})`);
    const releasedC = await post(kim, `/api/treasury/${riverside}/complete`, { transactionId: heldC.id });
    assert(releasedC.status === 200 && deal(heldC.id).status === 'completed' && listing(beans).units_left === 6 && dealsOn(beans) === 2,
        `(c) a keeper releases it from the enterprise's deals: one sale (${brief(releasedC)})`);
    conserved('(c)');
    // (d) The node died between the id's write and the release: a hold with its id recorded.
    const fieldsD = each(beans, 1, 2);
    const heldD = acceptPost(beans, riverside, undefined, { authSigner: kim.pk, item: { n: 1, option: 'each', expect_c: hc(2) } });
    recordAnswer(moneyRequestOf(riverside, TAKE_UP_ROUTE, 'take-up-retry-d-0001', fieldsD)!, { transactionId: heldD.id });
    const alicePre = bal(alice.pk);
    const rd = await takeUp(kim, riverside, { ...fieldsD, requestId: 'take-up-retry-d-0001' });
    assert(rd.status === 200 && rd.body?.released === true && rd.body?.replay === true && rd.body?.transaction?.id === heldD.id
        && deal(heldD.id).status === 'completed' && bal(alice.pk) - alicePre === hc(2) - feeOf(hc(2)) && dealsOn(beans) === 3 && listing(beans).units_left === 5,
        `(d) the retry releases the held deal: one sale, paid once (${brief(rd)})`);
    conserved('(d)');
    // (e) The seller cancelled the deal the id names.
    const fieldsE = each(beans, 1, 2);
    const heldE = acceptPost(beans, riverside, undefined, { authSigner: kim.pk, item: { n: 1, option: 'each', expect_c: hc(2) } });
    recordAnswer(moneyRequestOf(riverside, TAKE_UP_ROUTE, 'take-up-retry-e-0001', fieldsE)!, { transactionId: heldE.id });
    const cancelledE = await post(alice, '/api/marketplace/transactions/cancel', { transactionId: heldE.id, cancellerPublicKey: alice.pk });
    assert(cancelledE.status === 200 && deal(heldE.id).status === 'cancelled', `(e) Alice cancels that deal (${brief(cancelledE)})`);
    await refused('(e) the retry of a cancelled sale', kim, riverside, { ...fieldsE, requestId: 'take-up-retry-e-0001' },
        { status: 409, code: 'take_up_cancelled', error: 'That sale was cancelled, so nothing more was paid.' });
    conserved('the retries');

    // ── 10. Held, not released ─────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 10. Held, not released');
    // A real state: Kay's take-up of Kim's honey for Creekside stall was held and its id written, and the node stopped before
    // the release. Kim, who keeps Creekside stall too, retries it: the release is hers to make for her own honey, which the
    // engine refuses (the two-person rule at the release). The hold stands.
    const heldFields = each(honey, 1, 10);
    const held10 = acceptPost(honey, creekside, undefined, { authSigner: kay.pk, item: { n: 1, option: 'each', expect_c: hc(10) } });
    recordAnswer(moneyRequestOf(creekside, TAKE_UP_ROUTE, 'take-up-held-0001', heldFields)!, { transactionId: held10.id });
    const r10 = await takeUp(kim, creekside, { ...heldFields, requestId: 'take-up-held-0001' });
    // Red if the route answers a failed release as a success, or as a 4xx/5xx with Beans held.
    assert(r10.status === 200 && r10.body?.success === true && r10.body?.released === false && r10.body?.transaction?.status === 'pending'
        && /Another keeper of Creekside stall needs to complete this/.test(r10.body?.error ?? '') && deal(held10.id).status === 'pending',
        `the release refused after the hold: 200, released: false, in the member's words, the deal still held (${brief(r10)})`);
    const detail = await call('GET', `/api/treasury/${creekside}`, kay);
    assert(detail.status === 200 && (detail.body?.activeDeals ?? []).some((d: any) => d.id === held10.id),
        `the held deal is listed for the keepers (activeDeals) (${(detail.body?.activeDeals ?? []).map((d: any) => d.id).join(',')})`);
    const kayReleases = await post(kay, `/api/treasury/${creekside}/complete`, { transactionId: held10.id });
    assert(kayReleases.status === 200 && deal(held10.id).status === 'completed', `and Kay releases it (${brief(kayReleases)})`);
    conserved('a held take-up released by another keeper');
    const held11 = acceptPost(honey, creekside, undefined, { authSigner: kay.pk, item: { n: 1, option: 'each', expect_c: hc(10) } });
    recordAnswer(moneyRequestOf(creekside, TAKE_UP_ROUTE, 'take-up-held-0002', heldFields)!, { transactionId: held11.id });
    const r11 = await takeUp(kim, creekside, { ...heldFields, requestId: 'take-up-held-0002' });
    const surplusHeld = surplus(creekside);
    const kimCancels = await post(kim, '/api/marketplace/transactions/cancel', { transactionId: held11.id, cancellerPublicKey: kim.pk });
    assert(r11.status === 200 && r11.body?.released === false && kimCancels.status === 200 && deal(held11.id).status === 'cancelled' && surplus(creekside) === surplusHeld + hc(10),
        `a second one held, and the seller cancels it: the Beans and the earned surplus go back (${brief(kimCancels)})`);
    conserved('a held take-up cancelled by its seller');

    // ── 11. No balance exposure ────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 11. No balance exposure');
    const quillon = makeMember('Quillon', 123.45);
    const figs = eachOffer(quillon.pk, 'Figs, punnet', 7, 5);
    const figPicking = createPost('offer', 'garden', 'Fig picking', 'By the hour', hc(9), 'hourly', quillon.pk)!.id;
    const ownFigs = eachOffer(kim.pk, 'Kim\'s figs', 7, 5);
    const pushAt = pushMark();
    const keptAt = keptMark();
    const answers = [
        await takeUp(kim, riverside, each(figs, 1, 7)),
        await takeUp(kim, riverside, each(figs, 9, 63)),
        await takeUp(kim, riverside, each(figs, 1, 8)),
        await takeUp(kim, riverside, each(figs, 1.5, 7)),
        await takeUp(kim, riverside, each(figPicking, 1, 9)),
        await takeUp(kim, riverside, each(ownFigs, 1, 7)),
        await takeUp(nell, riverside, each(figs, 1, 7)),
        await takeUp(kim, orchard, each(figs, 1, 7)),
        await takeUp(kay, creekside, each(ownFigs, 1, 7)),
    ];
    const figures = [hc(123.45), hc(123.45) + hc(7) - feeOf(hc(7))].flatMap(c => [String(c), (c / 100).toFixed(2)]);
    assert(bal(quillon.pk) === hc(123.45) + hc(7) - feeOf(hc(7)), `Quillon holds a figure found nowhere else (${bal(quillon.pk)})`);
    const keysIn = (v: unknown): string[] => v && typeof v === 'object' ? Object.entries(v as object).flatMap(([k, x]) => [k, ...keysIn(x)]) : [];
    const MEMBER_MONEY_KEY = /balance|floor|credit|allowance/i;
    for (const [i, a] of answers.entries()) {
        const found = figures.filter(f => a.text.includes(f));
        const keys = keysIn(a.body).filter(k => MEMBER_MONEY_KEY.test(k));
        // Red if an answer of this route carries a member's balance, floor, credit line or allowance.
        assert(found.length === 0 && keys.length === 0, `answer ${i + 1} (${a.status} ${a.body?.code ?? (a.body?.released ? 'released' : '')}) carries no member's balance and no such key (${found.join(',')} ${keys.join(',')})`);
    }
    const told = JSON.stringify([pushesSince(pushAt), keptSince(keptAt)]);
    assert(!figures.some(f => told.includes(f)), `no push and no kept notice these caused carries Quillon's balance (${pushesSince(pushAt).length} pushes, ${keptSince(keptAt).length} kept)`);
    const book = await call('GET', `/api/treasury/${riverside}/ledger`, nell);
    const figEntry = (book.body?.entries ?? []).find((e: any) => e.counterpartyName === 'A deal');
    assert(book.status === 200 && !!figEntry && !book.text.includes(quillon.pk) && !book.text.includes(quillon.callsign) && !book.text.includes(alice.pk) && !book.text.includes('Alice'),
        `Nell reads Riverside stall's book: amounts and "A deal", never a seller's name or key (${book.status}, ${JSON.stringify(figEntry)?.slice(0, 160)})`);
    conserved('the answers');

    // ── 12. The gates ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 12. The gates');
    const leeks = eachOffer(alice.pk, 'Leeks, bunch', 1, 20);
    setNodeRole('backup');
    const standbyBefore = moneyPrint();
    const onStandby = await takeUp(kim, riverside, each(leeks, 1, 1));
    setNodeRole('primary');
    // Red if take-up leaves routes/standby-ledger-gate.ts.
    assert(onStandby.status === 409 && onStandby.body?.code === 'standby' && moneyPrint() === standbyBefore,
        `a standby answers 409 standby and writes nothing (${brief(onStandby)})`);
    const p0 = actsCount(riverside, kim.pk, 'payment'), q0 = actsCount(riverside, kim.pk, 'request');
    const counted = await takeUp(kim, riverside, each(leeks, 1, 1, { requestId: 'take-up-limits-0001' }));
    // Red if the take-up row leaves MONEY_ROUTES (nothing counted), or counts against Kim's own account instead.
    assert(counted.status === 200 && actsCount(riverside, kim.pk, 'payment') === p0 + 1 && actsCount(riverside, kim.pk, 'request') === q0 + 1
        && (db.prepare("SELECT COUNT(*) AS n FROM money_acts WHERE account = ? AND kind IN ('payment', 'request')").get(kim.pk) as { n: number }).n === 0,
        `a take-up counts one payment and one request against the stall and Kim's enterprise work (${JSON.stringify(acts(riverside, kim.pk))})`);
    await takeUp(kim, riverside, each(leeks, 99, 99));
    assert(actsCount(riverside, kim.pk, 'payment') === p0 + 1 && actsCount(riverside, kim.pk, 'request') === q0 + 1, 'a refused take-up counts nothing: both are taken back');
    const replayed = await takeUp(kim, riverside, each(leeks, 1, 1, { requestId: 'take-up-limits-0001' }));
    assert(replayed.status === 200 && replayed.body?.replay === true && actsCount(riverside, kim.pk, 'payment') === p0 + 1 && actsCount(riverside, kim.pk, 'request') === q0 + 1,
        'a replay counts nothing');
    conserved('the gates');

    // ── 13. Trust unchanged ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 13. Trust unchanged');
    const wide = await makeStall('Wide Creek stall', [kim, kay], [[kim, 300], [kay, 400]]);
    const tess = makeMember('Tess');
    const uma = makeMember('Uma');
    // A stall buys from many of the community's sellers. One that is new and has bought only from Tess would make the two
    // an insular pair of accounts, which the trust engine's cluster guard holds back for ANY counterparty (measured: Tess's
    // value 0), not for a take-up only. So, as any stall does, it buys from Alice first, and joins the community's trading.
    const wideFirst = await takeUp(kim, wide, each(eachOffer(alice.pk, 'Apples for Wide Creek', 20, 2), 1, 20));
    assert(wideFirst.status === 200 && wideFirst.body?.released === true, `Wide Creek stall buys a crate from Alice first (${brief(wideFirst)})`);
    const boxes = eachOffer(tess.pk, 'Seedling boxes', 100, 8);
    const umaBoxes = eachOffer(uma.pk, 'Uma\'s seedling boxes', 100, 3);
    const valueOf = (pk: string) => { clearWashTradingCache(); return getMemberTrustProfile(pk).qualifiedValue; };
    const umaSale = await post(bob, '/api/marketplace/posts/accept', { postId: umaBoxes, buyerPublicKey: bob.pk, hours: 3, itemOption: 'each', expect_c: hc(300) });
    await post(bob, '/api/marketplace/transactions/complete', { transactionId: umaSale.body?.transaction?.id, confirmerPublicKey: bob.pk });
    const tessSale = await takeUp(kim, wide, each(boxes, 3, 300));
    // Red if a take-up for an enterprise counts differently in the seller's trust from any finished deal of that amount.
    assert(tessSale.status === 200 && valueOf(tess.pk) === valueOf(uma.pk) && valueOf(tess.pk) === hc(300),
        `Tess sells 3 boxes to Wide Creek stall: her qualified trade value is what Uma's sale of 300 to Bob gives (${valueOf(tess.pk)}, ${valueOf(uma.pk)})`);
    const tessMore = await takeUp(kay, wide, each(boxes, 3, 300));
    assert(tessMore.status === 200 && valueOf(tess.pk) === hc(500), `3 more: capped at 500 with the stall (${valueOf(tess.pk)})`);
    const wideValue = valueOf(wide);
    const tessSends = await post(tess, '/api/ledger/transfer', { to: wide, amount_c: hc(20), memo: 'towards the till' });
    const pairs = [...runWashTradingAnalysis().flaggedPairs];
    assert(tessSends.status === 200 && valueOf(tess.pk) === hc(500) && valueOf(wide) === wideValue && !pairs.some(p => p.includes(tess.pk) && p.includes(wide)),
        `Tess sends the stall 20: it adds nothing to either, and selling to it and sending to it is no wash pair (${brief(tessSends)}, ${pairs.length} pairs)`);
    conserved('trust');

    // ── 14. Rule 7 ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 14. Rule 7');
    const capped = await makeStall('Ceiling stall', [kim], [], 1, { workingCapitalCeiling: hc(10) });
    const toCapped = await post(bob, '/api/ledger/transfer', { to: capped, amount_c: hc(32), memo: 'for cash from the tin' });
    const commonsPre = commons();
    const swept = sweepEnterpriseCeiling(capped);
    // Red if the ceiling sweep reads the balance instead of earned surplus: Beans members sent would go to the Commons.
    assert(toCapped.status === 200 && surplus(capped) === 0 && swept === 0 && bal(capped) === hc(32) && commons() === commonsPre,
        `Beans members send to a stall with a ceiling of 10 are never swept: earned surplus 0, the stall keeps 32 (${brief(toCapped)}, swept ${swept})`);
    conserved('Rule 7');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && process.exitCode !== 1 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
