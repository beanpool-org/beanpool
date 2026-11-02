/**
 * Test Suite: a copy of an Offer is no Offer of the member's on the node that holds it (engine/event-copy.ts, @beanpool/engine
 * posts.ts OWN_OFFER_WHERE). Nobody can take a copy, so nothing is on offer there: it opens no credit line and passes no
 * Offer-first gate. Measured before the fix on a node with Beans on, a directory and an earned limit of 1,500: copies alone
 * took the usable floor 0 → −200 → −500 → −1000 → −1500, and a Need refused with no Offer passed with only copies (review of
 * #2718). Boots the real server on the global profile, turns Beans on, and goes through the real middleware over HTTPS, signed:
 *
 *   1. Beans off, as global runs: nothing of this reaches a member, and a copy is still their first post
 *   2. copies alone leave the floor where it was, band by band, beside a control with no post at all
 *   3. the Need refused with no Offer is refused the same with only copies
 *   4. every kind of copy: the host unlisted when it was written, a row that went after, one taken down, a paused one
 *   5. a real Offer beside copies counts once, and real Offers count as they always did: to the band, and listed once, ever
 *   6. escrow still refuses at both doors with only copies, in the same words as for no Offer at all
 *   7. the other two limits that read the count: a confirmed member's known grant and an enterprise's line
 *   8. a member already past the new line: spend-frozen, never debited, and back when Beans come in or a real Offer goes up
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-offer-copy-credit)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { localFetch } from './keepalive-test-fetch.js';
import { TEST_PHOTOS } from './post-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}
type Answer = { status: number; body: any; text: string };
async function call(method: 'GET' | 'POST', p: string, id: Id, payload?: unknown): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await localFetch(`${BASE}${p}`, {
        method,
        headers: { ...signedHeaders(method, p, body, id), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
}

const HOUR = 60 * 60 * 1000;
const PLACE = { lat: -28.7, lng: 153.5 };
const HOST = 'mullum.example.org';
const OTHER_HOST = 'byron.example.org';
const HOME_ID = '5b0d5a3e-5d6c-4f0a-9a57-222222222222';
const EARNED = 1500;
/** The usable floor the bands give an earned limit of 1,500: one Offer −200, two −500, three −1000, four and on −1500. */
const BAND_FLOORS = [-200, -500, -1000, -1500, -1500];

async function main() {
    console.log('A copy of an Offer is no Offer of the member\'s...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { writeDirectoryRows, normaliseRegistryRow } = await import('./engine/directory-cache.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    const setSwitch = (name: string, value: string) =>
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
    setSwitch('probation', 'false');

    const longAgo = new Date(Date.now() - 400 * 24 * HOUR).toISOString();
    const member = (name: string, earned = 0, joinedAt = longAgo): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury, earned_credit, updated_at)
                    VALUES (?, ?, 'active', ?, 'genesis', 'TEST', 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pubKeyHex, name, joinedAt, earned);
        setMemberPhoto(db, id.pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const row = (url: string, name: string) => normaliseRegistryRow({ node_id: url, shown_name: name, node_url: url, last_seen_at: new Date().toISOString(), accepting_knocks: true })!;
    const directory = (rows: ReturnType<typeof row>[]) => writeDirectoryRows(rows, new Date().toISOString());
    directory([row(`https://${HOST}`, 'Mullumbimby Commons'), row(`https://${OTHER_HOST}`, 'Byron Commons')]);

    const listing = (author: Id, type: 'offer' | 'need', title: string, extra: Record<string, unknown> = {}) => ({
        id: crypto.randomUUID(), type, category: 'food', title, description: 'Fresh this morning', authorPublicKey: author.pubKeyHex, ...PLACE, photos: TEST_PHOTOS, ...extra,
    });
    const copyFields = (host = HOST) => ({ shownFrom: { host, postId: HOME_ID }, shownPrice: { beans: 20, per: 'fixed' } });
    const post = (who: Id, type: 'offer' | 'need', title: string, extra: Record<string, unknown> = {}) => call('POST', '/api/marketplace/posts', who, listing(who, type, title, extra));
    /** A copy written through the real route, and held to be one: a setup that wrote a plain Offer would prove nothing here. */
    const postCopy = async (who: Id, title: string, host = HOST): Promise<string> => {
        const made = await post(who, 'offer', title, copyFields(host));
        const id = made.body?.post?.id;
        assert(made.status === 200 && made.body?.post?.shownCopy === true, `setup: "${title}" is a copy (${made.status} ${made.text.slice(0, 100)})`);
        return id;
    };
    const postReal = async (who: Id, title: string, credits = 0): Promise<string> => {
        const made = await post(who, 'offer', title, { credits });
        assert(made.status === 200 && !made.body?.post?.shownCopy, `setup: "${title}" is a plain Offer (${made.status} ${made.text.slice(0, 100)})`);
        return made.body?.post?.id;
    };
    const removePost = (who: Id, id: string) => call('POST', '/api/marketplace/posts/remove', who, { id, authorPublicKey: who.pubKeyHex });
    const stored = (id: string) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
    const bal = async (who: Id, of = who) => (await call('GET', `/api/ledger/balance/${of.pubKeyHex}`, who)).body;
    /** What the node says of a member's Offers, the part both apps read. */
    const offerFacts = async (who: Id) => {
        const b = await bal(who);
        return { usableFloor: b?.usableFloor, liveOffers: b?.liveOffers, hasListedOffer: b?.hasListedOffer, hasLiveOffer: b?.hasLiveOffer, isBlockedFromTrading: b?.isBlockedFromTrading };
    };
    const show = (v: unknown) => JSON.stringify(v);
    const same = (a: unknown, b: unknown) => show(a) === show(b);
    const NO_OFFER = { usableFloor: 0, liveOffers: 0, hasListedOffer: false, hasLiveOffer: false, isBlockedFromTrading: true };

    // ── 1. Beans off ── First: a node that has opened an escrow keeps its money on for good.
    console.log('── 1. Beans off, as global runs ──');
    const gita = member('GitaGlobal', EARNED);
    assert((await post(gita, 'need', 'A Need before anything')).status === 200, 'Beans off: a first post may be a Need, with no Offer at all');
    // Joined today: the steps card ends after 14 days on global (routes/home-answer.ts stepsCard).
    const fern = member('FernGlobal', EARNED, new Date().toISOString());
    await postCopy(fern, 'Their first post, a copy');
    assert((await post(fern, 'need', 'A Need beside a copy', copyFields())).status === 200, 'Beans off: a copy of a Need goes up too');
    assert((await post(fern, 'need', 'A plain Need beside a copy')).status === 200, 'Beans off: so does a plain Need');
    const fernSays = await bal(fern);
    assert(fernSays?.isBlockedFromTrading === false && fernSays?.frozen === false && fernSays?.balance === 0, `Beans off: nobody is blocked, frozen or moved (${show([fernSays?.isBlockedFromTrading, fernSays?.frozen, fernSays?.balance])})`);
    const fernHome = await call('GET', '/api/home?cards=steps', fern);
    assert(fernHome.status === 200 && fernHome.body?.cards?.steps?.firstPost === true, `Beans off: a copy still ticks "Post something", as it did: the member did post here (${fernHome.status})`);

    setSwitch('beans', 'true');
    setSwitch('escrow', 'true');

    // ── 2. Copies alone ──
    console.log('\n── 2. Copies alone leave the floor where it was ──');
    const control = member('ControlNoPosts', EARNED);
    const noOffer = await offerFacts(control);
    assert(same(noOffer, NO_OFFER), `the control, an earned limit of ${EARNED} and no post: floor 0, nothing listed, blocked (${show(noOffer)})`);
    const billboard = member('OnlyCopies', EARNED);
    for (const band of BAND_FLOORS.keys()) {
        await postCopy(billboard, `Copy ${band + 1}`);
        const facts = await offerFacts(billboard);
        assert(same(facts, noOffer), `${band + 1} ${band ? 'copies' : 'copy'} alone: the same answer as the control, not the ${BAND_FLOORS[band]} a real Offer would open (${show(facts)})`);
    }

    // ── 3. The Need gate ──
    console.log('\n── 3. The Need refused with no Offer ──');
    const refused = await post(control, 'need', 'The control asks');
    assert(refused.status === 400 && /^CONTRIBUTION_REQUIRED/.test(refused.body?.error ?? ''), `the control's Need is refused (${refused.status} ${refused.text.slice(0, 100)})`);
    const needWithCopies = await post(billboard, 'need', 'A Need beside only copies');
    assert(needWithCopies.status === refused.status && needWithCopies.body?.error === refused.body?.error, `with only copies, the same refusal (${needWithCopies.status} ${needWithCopies.text.slice(0, 100)})`);
    const copyOfNeed = await post(billboard, 'need', 'A copy of a Need beside only copies', copyFields());
    assert(copyOfNeed.status === refused.status && copyOfNeed.body?.error === refused.body?.error, `a copy of a Need too: it asks the same gate (${copyOfNeed.status} ${copyOfNeed.text.slice(0, 100)})`);

    // ── 4. Every kind of copy ──
    console.log('\n── 4. Every kind of copy ──');
    // `shown_from_host` is the host, or '' once no shown row stands behind it: a test of the column for a host would pass these.
    const unlisted = member('CopyOfUnlistedHost', EARNED);
    const unlistedCopy = await postCopy(unlisted, 'Its host was never shown', 'not-in-the-directory.example.org');
    assert(stored(unlistedCopy)?.shown_from_host === '', `setup: an unlisted host stores '' (${show(stored(unlistedCopy)?.shown_from_host)})`);
    assert(same(await offerFacts(unlisted), noOffer), 'a copy whose host was never shown is no Offer');
    const outlived = member('CopyOutlivedItsHost', EARNED);
    const outlivedCopy = await postCopy(outlived, 'Its host went', OTHER_HOST);
    directory([row(`https://${HOST}`, 'Mullumbimby Commons')]);
    const outlivedRead = (await call('GET', `/api/marketplace/posts?id=${outlivedCopy}`, outlived)).body?.[0];
    assert(outlivedRead?.shownCopy === true && !outlivedRead?.shownFrom && stored(outlivedCopy)?.shown_from_host === OTHER_HOST,
        `setup: a copy that outlived its row reads with no door and keeps its stored host (${show(stored(outlivedCopy)?.shown_from_host)})`);
    assert(same(await offerFacts(outlived), noOffer), 'a copy that outlived its community\'s row is no Offer');
    const takenDown = member('CopyTakenDown', EARNED);
    const takenDownCopy = await postCopy(takenDown, 'Taken down again');
    const removed = await removePost(takenDown, takenDownCopy);
    assert(removed.status === 200 && same(await offerFacts(takenDown), noOffer), `a copy taken down was never an Offer listed: "listed once, ever" doesn't reach it (${removed.status})`);
    const paused = member('CopyPaused', EARNED);
    const pausedCopy = await postCopy(paused, 'Paused');
    db.prepare(`UPDATE posts SET status = 'paused' WHERE id = ?`).run(pausedCopy);
    assert(same(await offerFacts(paused), noOffer), 'nor a paused one');
    const scrubbed = member('CopyScrubbed', EARNED);
    const scrubbedCopy = await postCopy(scrubbed, 'Scrubbed');
    db.prepare(`UPDATE posts SET shown_from_host = '', shown_from_post_id = NULL, shown_price = NULL WHERE id = ?`).run(scrubbedCopy);
    assert(same(await offerFacts(scrubbed), noOffer), 'nor one that kept nothing of where it came from (engine/post-scrub.ts)');

    // ── 5. A real Offer beside copies ──
    console.log('\n── 5. A real Offer counts, once ──');
    const plainMember = member('RealOffersOnly', EARNED);
    const beside = member('RealBesideCopies', EARNED);
    for (let i = 0; i < 3; i++) await postCopy(beside, `A copy beside ${i}`);
    const realIds: string[] = [];
    for (const band of [0, 1, 2]) {
        await postReal(plainMember, `Plain ${band}`);
        realIds.push(await postReal(beside, `Real ${band}`));
        const plainFacts = await offerFacts(plainMember);
        const besideFacts = await offerFacts(beside);
        assert(plainFacts.liveOffers === band + 1 && plainFacts.usableFloor === BAND_FLOORS[band] && plainFacts.hasListedOffer && plainFacts.hasLiveOffer && !plainFacts.isBlockedFromTrading,
            `${band + 1} real ${band ? 'Offers' : 'Offer'}: ${BAND_FLOORS[band]}, as ever (${show(plainFacts)})`);
        assert(same(besideFacts, plainFacts), `${band + 1} real ${band ? 'Offers' : 'Offer'} beside 3 copies: the same answer, each counted once (${show(besideFacts)})`);
    }
    assert((await post(beside, 'need', 'A Need beside a real Offer')).status === 200, 'a real Offer opens the Need, copies or none');
    for (const id of realIds) await removePost(beside, id);
    const offersGone = await offerFacts(beside);
    assert(offersGone.liveOffers === 0 && offersGone.usableFloor === 0 && offersGone.hasLiveOffer === false, `the real Offers gone, the copies hold no line (${show(offersGone)})`);
    assert(offersGone.hasListedOffer === true && offersGone.isBlockedFromTrading === false, `and a real Offer listed once, ever, still counts as listed (${show(offersGone)})`);
    assert((await post(beside, 'need', 'A Need after the Offers went')).status === 200, 'so its Need still goes up');

    // ── 6. Escrow's two doors ──
    console.log('\n── 6. Escrow refuses at both doors with only copies ──');
    const seller = member('SellerOfBread', EARNED);
    const forSale = await postReal(seller, 'Bread for Beans', 10);
    const deals = () => (db.prepare('SELECT COUNT(*) AS c FROM marketplace_transactions').get() as { c: number }).c;
    const doors = [['ask for it', '/api/marketplace/posts/request'], ['take it up', '/api/marketplace/posts/accept']] as const;
    const dealsBefore = deals();
    for (const [what, path] of doors) {
        const ask = (who: Id) => call('POST', path, who, { postId: forSale, buyerPublicKey: who.pubKeyHex });
        const none = await ask(control);
        assert(none.status === 400 && /^CONTRIBUTION_REQUIRED/.test(none.body?.error ?? ''), `the control can't ${what} with no Offer (${none.status} ${none.text.slice(0, 100)})`);
        const copies = await ask(billboard);
        assert(copies.status === none.status && copies.body?.error === none.body?.error, `with only copies, the same refusal at ${path} (${copies.status} ${copies.text.slice(0, 100)})`);
    }
    assert(deals() === dealsBefore, 'no deal opened');
    const opened = await call('POST', '/api/marketplace/posts/request', plainMember, { postId: forSale, buyerPublicKey: plainMember.pubKeyHex });
    assert(opened.status === 200 && deals() === dealsBefore + 1, `a real Offer opens that door, so it is the copy that shuts it, not the setup (${opened.status} ${opened.text.slice(0, 120)})`);

    // ── 7. The other limits that read the count ──
    console.log('\n── 7. A known grant and an enterprise\'s line ──');
    const confirmer = member('NamesListAdmin');
    const confirmed = member('ConfirmedMember');
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), confirmed.pubKeyHex, crypto.randomBytes(16).toString('hex'), confirmer.pubKeyHex);
    await postCopy(confirmed, 'A confirmed member\'s copy');
    const copyOnly = await bal(confirmed);
    assert(copyOnly?.knownGrant === 1000 && copyOnly?.usableFloor === 0 && copyOnly?.liveOffers === 0, `a confirmed member's known grant waits for a real Offer: a copy doesn't open it (${show([copyOnly?.knownGrant, copyOnly?.usableFloor, copyOnly?.liveOffers])})`);
    await postReal(confirmed, 'A confirmed member\'s Offer');
    const withOffer = await bal(confirmed);
    assert(withOffer?.usableFloor === -1000 && withOffer?.liveOffers === 1, `one real Offer opens all of it (${show([withOffer?.usableFloor, withOffer?.liveOffers])})`);

    // Signed by the enterprise's own key: a keeper's routes (routes/treasury.ts) take no `shownFrom`, so this is the one way in.
    const enterprise = member('CopyBakeryEnterprise');
    db.prepare('UPDATE members SET is_treasury = 1, legacy_credit_floor = ? WHERE public_key = ?').run(EARNED, enterprise.pubKeyHex);
    await postCopy(enterprise, 'An enterprise\'s copy');
    const copyLine = await bal(enterprise);
    assert(copyLine?.floor === -EARNED && copyLine?.usableFloor === 0 && copyLine?.liveOffers === 0, `an enterprise's line stays shut with only copies (${show([copyLine?.floor, copyLine?.usableFloor, copyLine?.liveOffers])})`);
    await postReal(enterprise, 'An enterprise\'s Offer');
    const realLine = await bal(enterprise);
    assert(realLine?.usableFloor === -200 && realLine?.liveOffers === 1, `a real Offer beside it counts once (${show([realLine?.usableFloor, realLine?.liveOffers])})`);

    // ── 8. Already past the new line ──
    console.log('\n── 8. Already spent against copies ──');
    // The state an earlier build could leave: Beans spent on a line only copies held. The Offer that opened the line here
    // becomes a copy by hand (a posts row, no balance touched), so what is left is exactly a spender with only copies.
    const spender = member('SpentAgainstCopies', EARNED);
    const opener = await postReal(spender, 'What opened the line');
    await postCopy(spender, 'A copy beside it');
    const seller2 = member('SellerOfEggs', EARNED);
    const eggs = await postReal(seller2, 'Eggs for Beans', 150);
    const spent = await call('POST', '/api/marketplace/posts/accept', spender, { postId: eggs, buyerPublicKey: spender.pubKeyHex });
    const spentBalance = (await bal(spender))?.balance;
    assert(spent.status === 200 && spentBalance < -100, `setup: the member spends into the line (${spent.status} ${spent.text.slice(0, 120)}, balance ${spentBalance})`);
    db.prepare('UPDATE posts SET shown_from_host = ? WHERE id = ?').run(HOST, opener);
    const frozenNow = await bal(spender);
    assert(frozenNow?.balance === spentBalance, `the line narrows and no Bean is taken back: ${spentBalance} before, ${frozenNow?.balance} after`);
    assert(frozenNow?.usableFloor === 0 && frozenNow?.liveOffers === 0 && frozenNow?.frozen === true, `they are spend-frozen, past a floor of 0 (${show([frozenNow?.usableFloor, frozenNow?.liveOffers, frozenNow?.frozen])})`);
    const ledgerAddsUp = (step: string) => {
        const a = se.runLedgerAudit();
        assert(a.ok && Math.abs(a.drift) < 0.0001 && a.strandedEscrows === 0 && a.badBalances === 0, `the ledger adds up ${step} (drift ${a.drift}, stranded ${a.strandedEscrows}, not a number ${a.badBalances})`);
    };
    ledgerAddsUp('with the member frozen');
    const more = member('MoreForSale', EARNED);
    const moreForSale = await postReal(more, 'More to buy', 5);
    const noMore = await call('POST', '/api/marketplace/posts/accept', spender, { postId: moreForSale, buyerPublicKey: spender.pubKeyHex });
    assert(noMore.status === 400 && /^CONTRIBUTION_REQUIRED/.test(noMore.body?.error ?? '') && (await bal(spender))?.balance === spentBalance, `spending more is refused, and refusing moves nothing (${noMore.status} ${noMore.text.slice(0, 100)})`);
    const dealId = spent.body?.transaction?.id ?? spent.body?.transactionId;
    const released = await call('POST', '/api/marketplace/transactions/complete', spender, { transactionId: dealId, confirmerPublicKey: spender.pubKeyHex });
    assert(released.status === 200, `the deal already held in trust still pays its seller: the Beans went when it was made (${released.status} ${released.text.slice(0, 120)})`);
    assert((await bal(spender))?.balance === spentBalance, 'and that takes nothing more from the buyer');
    se.transfer('genesis', spender.pubKeyHex, 100, 'Beans come in', 'direct', true);
    const climbing = await bal(spender);
    assert(climbing?.balance === Math.round((spentBalance + 100) * 100) / 100 && climbing?.frozen === true, `Beans still come in, and the member stays frozen below the floor (${climbing?.balance})`);
    await postReal(spender, 'A real Offer at last');
    const reopened = await bal(spender);
    assert(reopened?.usableFloor === -200 && reopened?.frozen === false, `a real Offer opens the line again and the freeze lifts (${show([reopened?.usableFloor, reopened?.frozen, reopened?.balance])})`);
    ledgerAddsUp('at the end');

    console.log(`\n${passed}/${run} checks passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
