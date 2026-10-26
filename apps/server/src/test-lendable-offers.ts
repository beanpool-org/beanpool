/**
 * Lendable Offers on the server (slice S3: scratch/tools/DESIGN-tool-library-fable.md §2.3-2.6 and §5 slice 2's tests;
 * DESIGN-shops-and-tools-fable.md §0 row 9 and §12 S3). Every request is signed and goes through the real HTTPS server and
 * its signature middleware; the ledger's conservation check runs after each money step.
 *
 *   1. The fields: a lendable Offer and its terms are stored and answered; a replacement value is words only (a JSON number
 *      is refused, never stored as '412345678.0'), at most 40 characters, kept as written and never read as a number; the
 *      longest loan is a whole number of days from 1 to 365; only an Offer is lent, priced as one fee, per day or per week;
 *      a lendable Offer is repeatable too; a listing that isn't lent keeps no terms.
 *   2. `lendable=1` lists lendable Offers only, and with `author=` one member's.
 *   3. A Free loan: asked for, agreed, returned. No Beans move, the deal is completed, a rating is allowed, and the Offer is
 *      back on the board. While it is out it is off the board (pending) and due back on the hand-over plus its days, for
 *      every reader; a second request and a one-step accept are refused in the loan's words.
 *   4. A fee per day × days, with 1.5% to the Commons; a fee per day for the days the borrower confirms; one fee pays what
 *      it holds whatever days are confirmed.
 *   5. Two borrowers ask for one lendable: the lender's yes to one closes the other's request and tells them it's out; a
 *      waiting borrower who tries to take it in one step changes nothing; two yeses at once lend it once.
 *   6. A loan longer than the lender's longest, or shorter than a day, is refused.
 *   7. A cancel, by either side, puts it back; so does each ruling (release, refund, split); a pruned lender's stays down.
 *   8. The terms hold while it is asked for or out; they change once it's back; lending turned off is a one-off Offer.
 *   9. Repeatable and one-off Offers are as they were.
 *  10. An app that predates lending: a normal Offer, borrowed with no days, edited without the lend fields; and its deal
 *      heal (apps/native utils/db.ts) keeps a returned loan on its board.
 *  11. The loan's nudge words, and the other deals' unchanged.
 *  12. The visitor's shape: the terms, never when it's due back.
 *  13. A lendable out on loan is still one of its lender's live Offers (the offer covenant): a lender whose only Offer is
 *      out keeps their credit line and can spend within it; a one-off Offer taken by its deal stops counting, as before.
 *  14. Ask first (Marty, 2026-10-21): a one-step accept of a lendable Offer, Free or priced, from any app or the API, is
 *      refused in plain words with a code before anything is held, and the Offer stays on the board; the ask still works.
 *      A member the lender has blocked asks as anyone does: their request waits, the lender is not pushed, and nothing they
 *      are sent says "blocked". An ordinary Offer, one-off or repeatable, is still taken in one step.
 *  15. A standby copy carries the four columns, by plain assignment.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-lendable-offers.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'Lendable-Offers-Pw-5521!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initAdminPassword } from './config/local-config.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { db } from './db/db.js';
import { wrapCreatePost, TEST_PHOTOS } from './post-test-helper.js';
import {
    initStateEngine, transfer, createPost: rawCreatePost, runLedgerAudit, getCommonsBalanceExact, registerPushToken, getBalance, hasLiveOffer,
    runMarketplaceHygiene, adminPruneUser, exportSyncState, importRemoteState, setNodeRole, signSyncPayload, getPosts,
} from './state-engine.js';
const createPost = wrapCreatePost(rawCreatePost);
import { startHttpsServer } from './https-server.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { LEND_ASK_FIRST_CODE, LEND_ASK_FIRST_ERROR, LOAN_OUT_ERROR, LOAN_TOO_SHORT_ERROR, loanTooLongError } from './engine/escrow.js';
import { LEND_OFFERS_ONLY, LEND_PRICE_TYPE_REFUSED, LEND_TERMS_FROZEN, PRICE_FROZEN_ERROR } from './engine/posts.js';
import {
    LENDABLE_NOT_A_FLAG, LEND_MAX_DAYS_REFUSED, REPLACEMENT_VALUE_NOT_WORDS, REPLACEMENT_VALUE_TOO_LONG,
} from './engine/post-fields.js';
import { guestPost, setMemberPhoto, withoutTradeParty } from '@beanpool/engine';

// Expo is answered here, so who is told what is read from the notices this server keeps; nothing else off it is reached.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://exp.host')) {
        const msgs = JSON.parse(String(init?.body ?? '[]'));
        return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (!url.startsWith('https://localhost')) throw new Error(`test-lendable-offers: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const EPOCH_NOW = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
const DAY_MS = 24 * 60 * 60 * 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
let BASE = '';

type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}

/**
 * A member who can sign, trade (a photo, a name, an Offer listed), pay, and be told (a phone registered). `oddJobs: false`
 * lists no Offer: the member lists their own.
 */
function makeMember(callsign: string, beans: number, oddJobs = true): Id {
    const id = keypair(callsign);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pk, callsign);
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, EPOCH_NOW);
    if (beans > 0) transfer('genesis', id.pk, beans, `seed ${callsign}`, 'direct', true);
    if (oddJobs) createPost('offer', 'general', `${callsign} odd jobs`, 'Help around the place', 5, 'fixed', id.pk, undefined, undefined, undefined, true);
    registerPushToken(id.pk, `ExponentPushToken[lend-${callsign}-${id.pk.slice(0, 6)}]`, 'android');
    return id;
}

async function signed(urlPath: string, id: Id, body: unknown) {
    const raw = JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${urlPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${urlPath}\n${ts}\n${nonce}\n${raw}`), id.privateKey).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: raw,
    });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

async function signedGet(urlPath: string, id: Id) {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${urlPath}`, {
        headers: {
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`GET\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n`), id.privateKey).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
    });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

let ADMIN: Record<string, string> = {};
async function adminPost(urlPath: string, body: unknown) {
    const res = await fetch(`${BASE}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ADMIN }, body: JSON.stringify(body) });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

/** A balance as the ledger holds it (getBalance answers it rounded to the cent, for showing). */
const bal = (pk: string): number => r4((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: number }).balance);
const commons = (): number => r4(getCommonsBalanceExact());
const brief = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}`;
type PostRow = {
    status: string; active: number; lendable: number; repeatable: number; lend_max_days: number | null; lend_terms: string | null;
    replacement_value: string | null; typeof_value: string | null; accepted_by: string | null; accepted_at: string | null;
    pending_transaction_id: string | null; price_type: string; credits: number;
};
const postRow = (id: string) => db.prepare(`SELECT status, active, lendable, repeatable, lend_max_days, lend_terms, replacement_value,
    typeof(replacement_value) AS typeof_value, accepted_by, accepted_at, pending_transaction_id, price_type, credits FROM posts WHERE id = ?`).get(id) as PostRow;
const txRow = (id: string) => db.prepare('SELECT status, credits, hours FROM marketplace_transactions WHERE id = ?').get(id) as { status: string; credits: number; hours: number | null };
const postsTitled = (title: string): number => (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE title = ?').get(title) as { n: number }).n;
const backOnBoard = (id: string): boolean => {
    const p = postRow(id);
    return p.status === 'active' && p.active === 1 && p.accepted_by === null && p.pending_transaction_id === null;
};

/** The conservation check after a money step: no drift, nothing stranded, every balance a finite number. */
function ledgerAddsUp(step: string): void {
    const a = runLedgerAudit();
    assert(a.ok && Math.abs(a.drift) < 0.0001 && a.strandedEscrows === 0 && a.badBalances === 0,
        `the ledger adds up after ${step} (drift ${a.drift}, stranded ${a.strandedEscrows}, not a number ${a.badBalances})`);
}

/** Where the notices this server keeps end now (pushMark), to read only the ones after it (toldSince). */
const pushMark = (): number => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM push_notices').get() as { m: number }).m;
/** The notices this server kept for `to` after `mark`, oldest first: what the member's phone is told. */
function toldSince(to: Id, mark: number): Array<{ title: string; body: string }> {
    return db.prepare('SELECT title, body FROM push_notices WHERE recipient = ? AND rowid > ? ORDER BY rowid').all(to.pk, mark) as any[];
}
const OUT_ON_LOAN = (title: string) => (n: { title: string; body: string }) => n.title === '📦 Out on loan' && n.body === `"${title}" is out on loan now. Ask again when it's back.`;
async function settle(): Promise<void> { await new Promise(r => setTimeout(r, 150)); }

async function main(): Promise<void> {
    console.log('Lendable Offers (S3)\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    ADMIN = ownerTokenHeaders('admin');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const dave = makeMember('Dave', 100);    // lends
    const alice = makeMember('Alice', 100);
    const bob = makeMember('Bob', 100);
    const cy = makeMember('Cy', 100);
    const eve = makeMember('Eve', 50);       // lends, and is pruned
    ledgerAddsUp('the members are seeded');

    const offer = (who: Id, body: Record<string, unknown>) => signed('/api/marketplace/posts', who, {
        type: 'offer', category: 'tools', description: '', credits: 0, authorPublicKey: who.pk, photos: TEST_PHOTOS, ...body,
    });
    const edit = (who: Id, id: string, body: Record<string, unknown>) => signed('/api/marketplace/posts/update', who, { id, authorPublicKey: who.pk, ...body });
    const ask = (who: Id, postId: string, hours?: number) => signed('/api/marketplace/posts/request', who, { postId, buyerPublicKey: who.pk, ...(hours !== undefined ? { hours } : {}) });
    const take = (who: Id, postId: string, hours?: number) => signed('/api/marketplace/posts/accept', who, { postId, buyerPublicKey: who.pk, ...(hours !== undefined ? { hours } : {}) });
    const agree = (who: Id, transactionId: string) => signed('/api/marketplace/transactions/approve', who, { transactionId, authorPublicKey: who.pk });
    const returned = (who: Id, transactionId: string, finalHours?: number) => signed('/api/marketplace/transactions/complete', who, { transactionId, confirmerPublicKey: who.pk, ...(finalHours !== undefined ? { finalHours } : {}) });
    const callOff = (who: Id, transactionId: string) => signed('/api/marketplace/transactions/cancel', who, { transactionId, cancellerPublicKey: who.pk });
    const byId = async (reader: Id, id: string) => ((await signedGet(`/api/marketplace/posts?id=${id}`, reader)).body ?? [])[0];
    /** A loan asked for and agreed: the deal's id. */
    const lend = async (lender: Id, borrower: Id, postId: string, hours?: number): Promise<string> => {
        const asked = await ask(borrower, postId, hours);
        const agreed = await agree(lender, asked.body?.transaction?.id);
        if (asked.status !== 200 || agreed.status !== 200) throw new Error(`lend: ${brief(asked)} / ${brief(agreed)}`);
        return asked.body.transaction.id as string;
    };

    // ── 1. The fields ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 1. The fields');
    const made = await offer(dave, { title: 'Cordless drill', lendable: true, lendMaxDays: 7, lendTerms: '  Clean it. Back within a week. ', replacementValue: '$120' });
    const drill = made.body?.post?.id as string;
    assert(made.status === 200 && made.body.post.lendable === true && made.body.post.repeatable === true && made.body.post.lendMaxDays === 7
        && made.body.post.lendTerms === 'Clean it. Back within a week.' && made.body.post.replacementValue === '$120',
        `a lendable Offer is made with its terms, and is repeatable too (${brief(made)})`);
    const d0 = postRow(drill);
    assert(d0.lendable === 1 && d0.repeatable === 1 && d0.lend_max_days === 7 && d0.lend_terms === 'Clean it. Back within a week.'
        && d0.replacement_value === '$120' && d0.typeof_value === 'text' && d0.price_type === 'fixed' && d0.credits === 0,
        `it is stored as such: Free, one fee, the terms trimmed, the value as words (${JSON.stringify(d0)})`);

    const numbered = await offer(dave, { title: 'Numbered drill', lendable: true, replacementValue: 412345678 });
    assert(numbered.status === 400 && numbered.body?.error === REPLACEMENT_VALUE_NOT_WORDS && postsTitled('Numbered drill') === 0,
        `a replacement value sent as a JSON number is refused and nothing is stored (${brief(numbered)})`);
    const numberedOff = await offer(dave, { title: 'Numbered saw', lendable: false, replacementValue: 120 });
    assert(numberedOff.status === 400 && numberedOff.body?.error === REPLACEMENT_VALUE_NOT_WORDS && postsTitled('Numbered saw') === 0,
        `even on a listing that isn't lent (${brief(numberedOff)})`);
    for (const v of [true, ['$120'], { amount: 120 }]) {
        const r = await offer(dave, { title: 'Odd value', lendable: true, replacementValue: v });
        assert(r.status === 400 && r.body?.error === REPLACEMENT_VALUE_NOT_WORDS, `a replacement value of ${JSON.stringify(v)} is refused (${brief(r)})`);
    }
    const forty = 'R$ 300 or one just like it, same make ok';
    const fortyOne = `${forty}!`;
    const long = await offer(dave, { title: 'Long value', lendable: true, replacementValue: fortyOne });
    assert(forty.length === 40 && long.status === 400 && long.body?.error === REPLACEMENT_VALUE_TOO_LONG && postsTitled('Long value') === 0,
        `41 characters is refused (${brief(long)})`);
    const fits = await offer(dave, { title: 'Pressure washer', lendable: true, replacementValue: forty });
    const like = await offer(dave, { title: 'Hedge trimmer', lendable: true, replacementValue: 'like for like' });
    const price = await offer(dave, { title: 'Ladder', lendable: true, replacementValue: '120', credits: 10 });
    assert(fits.status === 200 && postRow(fits.body.post.id).replacement_value === forty
        && like.status === 200 && postRow(like.body.post.id).replacement_value === 'like for like'
        && price.status === 200 && postRow(price.body.post.id).replacement_value === '120' && postRow(price.body.post.id).typeof_value === 'text'
        && price.body.post.replacementValue === '120',
        'forty characters fits; every value is kept as written, "120" too, as text and never as a number');
    const ladder = price.body.post.id as string;

    for (const days of ['7', 0, 366, 7.5, -1]) {
        const r = await offer(dave, { title: 'Bad days', lendable: true, lendMaxDays: days });
        assert(r.status === 400 && r.body?.error === LEND_MAX_DAYS_REFUSED, `a longest loan of ${JSON.stringify(days)} is refused (${brief(r)})`);
    }
    const noMax = await offer(dave, { title: 'Wheelbarrow', lendable: true, lendMaxDays: null });
    assert(noMax.status === 200 && postRow(noMax.body.post.id).lend_max_days === null && !('lendMaxDays' in noMax.body.post), 'no longest loan is none');
    const wheelbarrow = noMax.body.post.id as string;
    for (const flag of ['true', 1]) {
        const r = await offer(dave, { title: 'Bad flag', lendable: flag });
        assert(r.status === 400 && r.body?.error === LENDABLE_NOT_A_FLAG && postsTitled('Bad flag') === 0, `lendable ${JSON.stringify(flag)} is refused (${brief(r)})`);
    }
    const need = await signed('/api/marketplace/posts', dave, { type: 'need', category: 'tools', title: 'Need a drill', description: 'Anyone?', credits: 0, authorPublicKey: dave.pk, photos: TEST_PHOTOS, lendable: true });
    assert(need.status === 400 && need.body?.error === LEND_OFFERS_ONLY && postsTitled('Need a drill') === 0, `a Need can't be lent (${brief(need)})`);
    // An event is built from the whole body (routes/event-post.ts), so it gets the same refusals, not its lend fields dropped.
    const event = (title: string, body: Record<string, unknown>) => signed('/api/marketplace/posts', dave, {
        type: 'event', title, description: 'Bring gloves', authorPublicKey: dave.pk, lat: -33.8688, lng: 151.2093, photos: TEST_PHOTOS,
        eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), eventPlaceName: 'The hall', ...body,
    });
    const eventLent = await event('Tool swap', { lendable: true });
    assert(eventLent.status === 400 && eventLent.body?.error === LEND_OFFERS_ONLY && postsTitled('Tool swap') === 0, `an event can't be lent (${brief(eventLent)})`);
    const eventNumbered = await event('Repair cafe', { replacementValue: 123 });
    assert(eventNumbered.status === 400 && eventNumbered.body?.error === REPLACEMENT_VALUE_NOT_WORDS && postsTitled('Repair cafe') === 0,
        `an event sent a replacement value as a number is refused too (${brief(eventNumbered)})`);
    const eventPlain = await event('Working bee', {});
    assert(eventPlain.status === 200 && postRow(eventPlain.body.post.id).lendable === 0 && !('lendable' in eventPlain.body.post),
        `the same event with no lend fields is made, and isn't lent (${brief(eventPlain)})`);
    for (const pt of ['hourly', 'monthly']) {
        const r = await offer(dave, { title: `Lent ${pt}`, lendable: true, credits: 2, priceType: pt });
        assert(r.status === 400 && r.body?.error === LEND_PRICE_TYPE_REFUSED && postsTitled(`Lent ${pt}`) === 0, `a loan priced ${pt} is refused (${brief(r)})`);
    }
    const trailerMade = await offer(dave, { title: 'Bike trailer', lendable: true, credits: 5, priceType: 'daily', lendMaxDays: 7 });
    const weeklyMade = await offer(dave, { title: 'Camping tent', lendable: true, credits: 7, priceType: 'weekly', lendMaxDays: 7 });
    const trailer = trailerMade.body?.post?.id as string;
    const tent = weeklyMade.body?.post?.id as string;
    assert(trailerMade.status === 200 && postRow(trailer).price_type === 'daily' && weeklyMade.status === 200 && postRow(tent).price_type === 'weekly',
        `a loan's fee may be per day or per week (${brief(trailerMade)} / ${brief(weeklyMade)})`);
    const plainMade = await offer(dave, { title: 'Firewood', credits: 3, replacementValue: '$5', lendTerms: 'Dry', lendMaxDays: 3 });
    const firewood = plainMade.body?.post?.id as string;
    const pw = postRow(firewood);
    assert(plainMade.status === 200 && pw.lendable === 0 && pw.repeatable === 0 && pw.lend_max_days === null && pw.lend_terms === null && pw.replacement_value === null
        && !('lendable' in plainMade.body.post) && !('replacementValue' in plainMade.body.post),
        'a listing that isn\'t lent keeps no terms, and reads as it always did');
    const plainHourly = await offer(dave, { title: 'Garden help', credits: 3, priceType: 'daily' });
    assert(plainHourly.status === 200 && postRow(plainHourly.body.post.id).price_type === 'fixed',
        'a listing that isn\'t lent is still made one fee or by the hour, as before');

    // ── 2. lendable=1 ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. lendable=1');
    const lendList = await signedGet('/api/marketplace/posts?lendable=1', alice);
    const lendIds = new Set<string>((lendList.body ?? []).map((p: any) => p.id));
    assert(lendList.status === 200 && lendIds.has(drill) && lendIds.has(trailer) && !lendIds.has(firewood)
        && (lendList.body as any[]).every(p => p.lendable === true && p.type === 'offer'),
        `lendable=1 lists lendable Offers only (${lendList.status}, ${lendIds.size})`);
    const eveLends = await offer(eve, { title: 'Eve\'s ladder', lendable: true, credits: 2 });
    const eveLadder = eveLends.body?.post?.id as string;
    const shop = await signedGet(`/api/marketplace/posts?author=${dave.pk}&lendable=1`, alice);
    assert(shop.status === 200 && (shop.body as any[]).length > 0 && (shop.body as any[]).every(p => p.authorPublicKey === dave.pk && p.lendable === true)
        && !(shop.body as any[]).some(p => p.id === eveLadder || p.id === firewood),
        'with author=, one member\'s lendable Offers: their shop');
    const all = await signedGet('/api/marketplace/posts', alice);
    assert(all.status === 200 && (all.body as any[]).some(p => p.id === firewood) && (all.body as any[]).some(p => p.id === drill),
        'without it, the board is every listing as before');

    // ── 3. A Free loan ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 3. A Free loan');
    const before3 = { dave: bal(dave.pk), alice: bal(alice.pk), commons: commons() };
    const asked = await ask(alice, drill, 3);
    assert(asked.status === 200 && asked.body.transaction.credits === 0 && txRow(asked.body.transaction.id).hours === 3,
        `Alice asks to borrow the drill for 3 days: a deal of 0 Beans that keeps its days (${brief(asked)})`);
    const freeTx = asked.body.transaction.id as string;
    const agreed = await agree(dave, freeTx);
    const out = postRow(drill);
    assert(agreed.status === 200 && out.status === 'pending' && out.accepted_by === alice.pk && out.pending_transaction_id === freeTx,
        `Dave says yes: the drill is out (${brief(agreed)})`);
    const seen = await byId(cy, drill);
    const dueBack = new Date(Date.parse(out.accepted_at!) + 3 * DAY_MS).toISOString();
    assert(seen?.status === 'pending' && seen.lendBackAround === dueBack && !('acceptedBy' in seen) && !('pendingTransactionId' in seen),
        `anyone sees it off the board, due back ${dueBack}, and not who has it (${JSON.stringify({ status: seen?.status, back: seen?.lendBackAround })})`);
    assert(seen?.status !== 'active', 'the phone\'s Market, which shows listings that are active, leaves it off while it is out');
    const second = await ask(bob, drill, 2);
    const oneStep = await take(bob, drill, 2);
    assert(second.status === 409 && second.body?.error === LOAN_OUT_ERROR && oneStep.status === 409 && oneStep.body?.error === LOAN_OUT_ERROR,
        `a second request and a one-step accept while it is out are told it's out (${brief(second)} / ${brief(oneStep)})`);
    const done = await returned(alice, freeTx);
    assert(done.status === 200 && txRow(freeTx).status === 'completed' && backOnBoard(drill),
        `Alice returns it: the deal is completed and the drill is back on the board (${brief(done)})`);
    assert(bal(dave.pk) === before3.dave && bal(alice.pk) === before3.alice && commons() === before3.commons, 'no Beans moved for a Free loan');
    ledgerAddsUp('a Free loan');
    const rated = await signed('/api/ratings', alice, { raterPubkey: alice.pk, targetPubkey: dave.pk, stars: 5, comment: 'Thanks!', transactionId: freeTx });
    assert(rated.status === 200, `a rating is allowed on the completed Free loan (${brief(rated)})`);
    const back = await byId(cy, drill);
    assert(back?.status === 'active' && !('lendBackAround' in back), 'back, it is due back no more');
    const again = await ask(bob, drill, 2);
    assert(again.status === 200, `and can be asked for again (${brief(again)})`);
    const bobDrill = again.body.transaction.id as string;
    await signed('/api/marketplace/transactions/cancel-request', bob, { transactionId: bobDrill, buyerPublicKey: bob.pk });

    // ── 4. Fees ──────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 4. Fees');
    let b4 = { dave: bal(dave.pk), bob: bal(bob.pk), commons: commons() };
    const perDay = await ask(bob, trailer, 3);
    assert(perDay.status === 200 && perDay.body.transaction.credits === 15 && txRow(perDay.body.transaction.id).hours === 3,
        `5 Beans a day × 3 days is 15 Beans (${brief(perDay)})`);
    const perDayTx = perDay.body.transaction.id as string;
    await agree(dave, perDayTx);
    assert(bal(bob.pk) === r4(b4.bob - 15) && postRow(trailer).status === 'pending', 'agreed: the 15 Beans are held and the trailer is out');
    ledgerAddsUp('a fee held');
    const paid = await returned(bob, perDayTx);
    assert(paid.status === 200 && bal(bob.pk) === r4(b4.bob - 15) && bal(dave.pk) === r4(b4.dave + 15 - 0.225) && commons() === r4(b4.commons + 0.225)
        && backOnBoard(trailer),
        `returned: Dave is paid 15 Beans less 1.5% (0.225) to the Commons, and the trailer is back (Bob ${r4(bal(bob.pk) - b4.bob)}, Dave ${r4(bal(dave.pk) - b4.dave)}, Commons ${r4(commons() - b4.commons)}, ${postRow(trailer).status})`);
    ledgerAddsUp('a fee per day paid');
    b4 = { dave: bal(dave.pk), bob: bal(bob.pk), commons: commons() };
    const early = await lend(dave, bob, trailer, 3);
    const earlyDone = await returned(bob, early, 2);
    assert(earlyDone.status === 200 && txRow(early).credits === 10 && bal(bob.pk) === r4(b4.bob - 10) && bal(dave.pk) === r4(b4.dave + 10 - 0.15)
        && backOnBoard(trailer),
        `a fee per day is paid for the days the borrower confirms: back after 2 of 3, 10 Beans (${brief(earlyDone)})`);
    ledgerAddsUp('a fee per day for fewer days');
    b4 = { dave: bal(dave.pk), bob: bal(bob.pk), commons: commons() };
    const oneFee = await lend(dave, cy, ladder, 3);
    assert(txRow(oneFee).credits === 10 && txRow(oneFee).hours === 3, 'one fee of 10 Beans for a 3-day loan holds 10 and keeps the days');
    const cyBefore = bal(cy.pk) + 10;
    const oneFeeDone = await returned(cy, oneFee, 0.5);
    assert(oneFeeDone.status === 200 && txRow(oneFee).credits === 10 && bal(cy.pk) === r4(cyBefore - 10) && bal(dave.pk) === r4(b4.dave + 10 - 0.15)
        && commons() === r4(b4.commons + 0.15) && backOnBoard(ladder),
        `one fee pays what it holds whatever days are confirmed (half a day confirmed, still 10 Beans) (${brief(oneFeeDone)})`);
    ledgerAddsUp('one fee paid');

    // ── 5. Two borrowers race ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 5. Two borrowers race');
    const askA = await ask(alice, wheelbarrow, 2);
    const askB = await ask(bob, wheelbarrow, 2);
    const t5 = pushMark();
    const yesA = await agree(dave, askA.body.transaction.id);
    await settle();
    const told = toldSince(bob, t5);
    assert(yesA.status === 200 && txRow(askB.body.transaction.id).status === 'rejected' && told.filter(OUT_ON_LOAN('Wheelbarrow')).length === 1
        && !toldSince(alice, t5).some(OUT_ON_LOAN('Wheelbarrow')),
        `Dave lends it to Alice: Bob's waiting request is closed and he is told it's out, Alice isn't (${JSON.stringify(told)})`);
    const yesB = await agree(dave, askB.body.transaction.id);
    assert(yesB.status === 400 && postRow(wheelbarrow).accepted_by === alice.pk, `Bob's closed request can't be agreed after (${brief(yesB)})`);
    await returned(alice, askA.body.transaction.id);
    assert(backOnBoard(wheelbarrow), 'back');
    const waitC = await ask(cy, wheelbarrow, 2);
    const waitB = await ask(bob, wheelbarrow, 2);
    const t5b = pushMark();
    const bobTakes = await take(bob, wheelbarrow, 2);
    await settle();
    assert(bobTakes.status === 409 && bobTakes.body?.code === LEND_ASK_FIRST_CODE && backOnBoard(wheelbarrow)
        && txRow(waitC.body.transaction.id).status === 'requested' && txRow(waitB.body.transaction.id).status === 'requested'
        && !toldSince(cy, t5b).some(OUT_ON_LOAN('Wheelbarrow')) && !toldSince(dave, t5b).some(n => n.title === '🛒 Offer Accepted'),
        `Bob, who is waiting, tries to take it in one step: refused, and nothing changes: both requests wait, nobody is told (${brief(bobTakes)})`);
    const yesBob = await agree(dave, waitB.body.transaction.id);
    await settle();
    assert(yesBob.status === 200 && txRow(waitB.body.transaction.id).status === 'pending' && txRow(waitC.body.transaction.id).status === 'rejected'
        && toldSince(cy, t5b).filter(OUT_ON_LOAN('Wheelbarrow')).length === 1 && !toldSince(bob, t5b).some(OUT_ON_LOAN('Wheelbarrow')),
        `Dave says yes to Bob: Cy, who was waiting, is told it's out; Bob, whose request it is, isn't (${brief(yesBob)})`);
    await returned(bob, waitB.body.transaction.id);
    assert(backOnBoard(wheelbarrow), 'back again');
    const r5 = { bob: bal(bob.pk), cy: bal(cy.pk) };
    const raceB = await ask(bob, ladder, 2);
    const raceC = await ask(cy, ladder, 2);
    const raced = await Promise.all([agree(dave, raceB.body.transaction.id), agree(dave, raceC.body.transaction.id)]);
    const winners = raced.filter(r => r.status === 200);
    const losers = raced.filter(r => r.status !== 200);
    const winner = winners[0]?.body?.transaction?.buyerPublicKey as string | undefined;
    const loserAsk = winner === bob.pk ? raceC : raceB;
    const openDeals = (db.prepare("SELECT COUNT(*) AS n FROM marketplace_transactions WHERE post_id = ? AND status = 'pending'").get(ladder) as { n: number }).n;
    assert(raceB.status === 200 && raceC.status === 200 && winners.length === 1 && losers.length === 1 && losers[0].status === 400
        && txRow(loserAsk.body.transaction.id).status === 'rejected' && openDeals === 1 && postRow(ladder).accepted_by === winner,
        `Dave says yes to Bob and Cy at once: one gets the ladder, the other's request was closed by the first yes (${raced.map(brief).join(' / ')})`);
    const loserPk = winner === bob.pk ? cy.pk : bob.pk;
    assert(bal(winner!) === r4((winner === bob.pk ? r5.bob : r5.cy) - 10) && bal(loserPk) === (loserPk === bob.pk ? r5.bob : r5.cy),
        'only the winner\'s 10 Beans are held');
    ledgerAddsUp('a race for one lendable');
    await callOff(winner === bob.pk ? bob : cy, winners[0].body.transaction.id);
    assert(backOnBoard(ladder), 'called off, it is back');

    // ── 6. Days ──────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 6. Days');
    const tooLong = await ask(alice, drill, 8);
    const tooLongTake = await take(alice, drill, 8);
    const tooShort = await ask(alice, trailer, 0.5);
    const weeks = await ask(alice, tent, 2);
    const oneWeek = await ask(alice, tent, 1);
    const noDays = await ask(cy, drill);
    assert(tooLong.status === 400 && tooLong.body?.error === loanTooLongError(7),
        `8 days of a drill lent for up to 7 is refused when asked for (${brief(tooLong)})`);
    assert(tooLongTake.status === 409 && tooLongTake.body?.code === LEND_ASK_FIRST_CODE,
        `taken in one step, it is refused before its days are read: a loan is asked for (${brief(tooLongTake)})`);
    assert(tooShort.status === 400 && tooShort.body?.error === LOAN_TOO_SHORT_ERROR, `half a day is refused (${brief(tooShort)})`);
    assert(weeks.status === 400 && weeks.body?.error === loanTooLongError(7) && oneWeek.status === 200 && oneWeek.body.transaction.credits === 7,
        `2 weeks of a tent lent for up to 7 days is refused; 1 week is 7 Beans (${brief(weeks)} / ${brief(oneWeek)})`);
    assert(noDays.status === 200 && txRow(noDays.body.transaction.id).hours === null,
        'one fee asked for with no days (an app that predates lending) is a loan with no due date');
    await signed('/api/marketplace/transactions/cancel-request', alice, { transactionId: oneWeek.body.transaction.id, buyerPublicKey: alice.pk });
    await signed('/api/marketplace/transactions/cancel-request', cy, { transactionId: noDays.body.transaction.id, buyerPublicKey: cy.pk });

    // ── 7. Cancel, rulings, prune ────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 7. Cancel, rulings, prune');
    for (const [who, label] of [[alice, 'the borrower'], [dave, 'the lender']] as const) {
        const before = bal(alice.pk);
        const tx = await lend(dave, alice, trailer, 2);
        const off = await callOff(who, tx);
        assert(off.status === 200 && txRow(tx).status === 'cancelled' && bal(alice.pk) === before && backOnBoard(trailer),
            `called off by ${label}: the 10 Beans go back and the trailer is back on the board (${brief(off)})`);
        ledgerAddsUp(`a loan called off by ${label}`);
    }
    for (const action of ['release_to_seller', 'refund_to_buyer', 'split'] as const) {
        const tx = await lend(dave, bob, trailer, 2);
        const ruled = await adminPost(`/api/local/admin/disputes/${tx}/resolve`, { action, reason: 'not back' });
        assert(ruled.status === 200 && backOnBoard(trailer), `an admin's ruling (${action}) puts it back on the board (${brief(ruled)})`);
        ledgerAddsUp(`a ruling (${action})`);
    }
    // The lendable flag alone decides it, not the repeatable one beside it: a row lent but not repeatable (written by hand,
    // as round 1's design would have stored it) takes one deal at a time and comes back after a return and each ruling.
    db.prepare('UPDATE posts SET repeatable = 0 WHERE id = ?').run(trailer);
    const r7a = await ask(alice, trailer, 2);
    const r7b = await ask(cy, trailer, 2);
    await agree(dave, r7a.body.transaction.id);
    assert(postRow(trailer).status === 'pending' && txRow(r7b.body.transaction.id).status === 'rejected', 'lent and not repeatable: one at a time');
    await returned(alice, r7a.body.transaction.id);
    assert(backOnBoard(trailer), 'lent and not repeatable: back after the return');
    for (const action of ['release_to_seller', 'split'] as const) {
        const tx = await lend(dave, bob, trailer, 2);
        const ruled = await adminPost(`/api/local/admin/disputes/${tx}/resolve`, { action });
        assert(ruled.status === 200 && backOnBoard(trailer), `lent and not repeatable: back after a ruling (${action}) (${brief(ruled)})`);
    }
    ledgerAddsUp('a lent row that is not repeatable');
    db.prepare('UPDATE posts SET repeatable = 1 WHERE id = ?').run(trailer);

    const eveOut1 = await lend(eve, alice, eveLadder, 2);
    adminPruneUser(eve.pk, 'owner:password');
    assert(postRow(eveLadder).status === 'cancelled' && postRow(eveLadder).active === 0, 'Eve is pruned: her lent ladder is taken down under the loan');
    const off1 = await callOff(alice, eveOut1);
    assert(off1.status === 200 && postRow(eveLadder).status === 'cancelled' && postRow(eveLadder).active === 0,
        `the loan called off afterwards leaves a pruned lender's listing down (${brief(off1)})`);
    ledgerAddsUp('a pruned lender\'s loan called off');

    // ── 8. The terms hold while it is out ────────────────────────────────────────────────────────────────────────────
    console.log('\n— 8. The terms hold while it is out');
    const held = await lend(dave, cy, drill, 2);
    for (const change of [{ replacementValue: '$150' }, { lendMaxDays: 14 }, { lendTerms: 'Return it oiled' }, { lendable: false }]) {
        const r = await edit(dave, drill, change);
        // 400, as the edit route answers a price held by an open deal.
        assert(r.status === 400 && r.body?.error === LEND_TERMS_FROZEN, `while it is out, ${JSON.stringify(change)} is refused (${brief(r)})`);
    }
    const priceHeld = await edit(dave, drill, { credits: 4 });
    const sameBack = await edit(dave, drill, { title: 'Cordless drill (18V)', replacementValue: '$120', lendMaxDays: 7, lendable: true });
    assert(priceHeld.status === 400 && priceHeld.body?.error === PRICE_FROZEN_ERROR && sameBack.status === 200 && postRow(drill).replacement_value === '$120',
        `its price holds as before; the same terms sent back, with a new title, go through (${brief(priceHeld)} / ${brief(sameBack)})`);
    await returned(cy, held);
    const changed = await edit(dave, drill, { replacementValue: 'like for like', lendMaxDays: null, lendTerms: '' });
    const c8 = postRow(drill);
    assert(changed.status === 200 && c8.replacement_value === 'like for like' && c8.lend_max_days === null && c8.lend_terms === null && c8.lendable === 1,
        `back, its terms change; a term sent empty or null is cleared (${brief(changed)})`);
    const asNumber = await edit(dave, drill, { replacementValue: 150 });
    assert(asNumber.status === 400 && asNumber.body?.error === REPLACEMENT_VALUE_NOT_WORDS && postRow(drill).replacement_value === 'like for like',
        `an edit's replacement value as a number is refused too (${brief(asNumber)})`);
    const hourly = await edit(dave, drill, { priceType: 'hourly' });
    assert(hourly.status === 400 && hourly.body?.error === LEND_PRICE_TYPE_REFUSED, `a lendable Offer can't be priced by the hour (${brief(hourly)})`);
    const stop = await edit(dave, drill, { lendable: false });
    const s8 = postRow(drill);
    assert(stop.status === 200 && s8.lendable === 0 && s8.repeatable === 0 && s8.replacement_value === null && !('lendable' in stop.body.post),
        `lending turned off: a one-off Offer with no terms (${brief(stop)})`);
    const restart = await edit(dave, drill, { lendable: true, replacementValue: '$120', lendMaxDays: 7 });
    assert(restart.status === 200 && postRow(drill).lendable === 1 && postRow(drill).repeatable === 1 && postRow(drill).replacement_value === '$120',
        `and on again (${brief(restart)})`);
    const needMade = await signed('/api/marketplace/posts', dave, { type: 'need', category: 'tools', title: 'Need a hand', description: 'Moving day', credits: 2, authorPublicKey: dave.pk, photos: TEST_PHOTOS });
    const needLend = await edit(dave, needMade.body?.post?.id, { lendable: true });
    assert(needMade.status === 200 && needLend.status === 400 && needLend.body?.error === LEND_OFFERS_ONLY, `a Need can't be made lendable by an edit (${brief(needLend)})`);

    // ── 9. Repeatable and one-off Offers are as they were ────────────────────────────────────────────────────────────
    console.log('\n— 9. Repeatable and one-off Offers');
    const jobs = (db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND title = 'Alice odd jobs'").get(alice.pk) as { id: string }).id;
    const j1 = await ask(bob, jobs);
    const j2 = await ask(cy, jobs);
    const y1 = await agree(alice, j1.body.transaction.id);
    const y2 = await agree(alice, j2.body.transaction.id);
    assert(y1.status === 200 && y2.status === 200 && postRow(jobs).status === 'active' && postRow(jobs).lendable === 0,
        'a repeatable Offer takes two deals at once and stays on the board');
    await returned(bob, j1.body.transaction.id);
    await returned(cy, j2.body.transaction.id);
    assert(postRow(jobs).status === 'active', 'and stays there after both');
    const w1 = await ask(bob, firewood);
    await agree(dave, w1.body.transaction.id);
    assert(postRow(firewood).status === 'pending', 'a one-off Offer is taken by its deal');
    await returned(bob, w1.body.transaction.id);
    const w2 = await ask(cy, firewood);
    assert(postRow(firewood).status === 'completed' && w2.status === 400 && /not active/.test(w2.body?.error ?? ''),
        `and done after it, as before (${brief(w2)})`);
    ledgerAddsUp('repeatable and one-off deals');

    // ── 10. An app that predates lending ─────────────────────────────────────────────────────────────────────────────
    console.log('\n— 10. An app that predates lending');
    const shape = await byId(alice, wheelbarrow);
    assert(shape?.type === 'offer' && shape.status === 'active' && shape.repeatable === true && shape.priceType === 'fixed' && typeof shape.credits === 'number',
        'it reads as an ordinary Offer, one that comes back after each deal (RECURRING)');
    const oldAsk = await ask(cy, wheelbarrow);
    const oldTx = oldAsk.body?.transaction?.id as string;
    const oldYes = await agree(dave, oldTx);
    const outOld = await byId(dave, wheelbarrow);
    assert(oldAsk.status === 200 && oldYes.status === 200 && outOld?.status === 'pending' && !('lendBackAround' in outOld),
        'borrowed with no days, it is out with no due date');
    const oldEdit = await edit(dave, wheelbarrow, { type: 'offer', category: 'tools', title: 'Wheelbarrow', description: 'Steel', credits: 0, price_type: 'fixed', repeatable: false });
    assert(oldEdit.status === 200 && postRow(wheelbarrow).lendable === 1 && postRow(wheelbarrow).repeatable === 1,
        `an edit without the lend fields leaves it lent, whatever it says of repeatable (${brief(oldEdit)})`);
    await returned(cy, oldTx);
    // The phone's deal heal, as every app in the store has it (apps/native utils/db.ts, applying a completed deal after the
    // listings): a listing that isn't repeatable is written completed, one that is goes back to active.
    const healed = (p: { repeatable?: boolean }) => (p.repeatable ? 'active' : 'completed');
    const afterReturn = await byId(cy, wheelbarrow);
    const oneOff = await byId(cy, firewood);
    assert(afterReturn?.status === 'active' && healed(afterReturn) === 'active' && healed(oneOff) === 'completed',
        'its deal heal keeps a returned loan on its board, and a one-off Offer done, as before');
    ledgerAddsUp('an old app\'s loan');

    // ── 11. The nudge ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 11. The nudge');
    const lingerFree = await lend(dave, alice, drill, 7);
    const lingerFee = await lend(dave, bob, trailer, 7);
    const lingerSale = await ask(cy, (db.prepare("SELECT id FROM posts WHERE title = 'Bob odd jobs'").get() as { id: string }).id);
    await agree(bob, lingerSale.body.transaction.id);
    db.prepare("UPDATE marketplace_transactions SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days') WHERE id IN (?, ?, ?)")
        .run(lingerFree, lingerFee, lingerSale.body.transaction.id);
    const t11 = pushMark();
    runMarketplaceHygiene();
    await settle();
    const toAlice = toldSince(alice, t11).filter(n => n.title.startsWith('⏳'));
    const toBob = toldSince(bob, t11).filter(n => n.title.startsWith('⏳'));
    const toCy = toldSince(cy, t11).filter(n => n.title.startsWith('⏳'));
    assert(toAlice.length === 1 && toAlice[0].title === '⏳ Is it back?'
        && toAlice[0].body === 'Is Dave\'s "Cordless drill (18V)" back? Once it is, confirm the return to finish the loan.',
        `a loan asks the borrower whether it's back (${JSON.stringify(toAlice)})`);
    assert(toBob.length === 1 && toBob[0].body === 'Is Dave\'s "Bike trailer" back? Once it is, confirm the return to finish the loan and release the Beans held for it.',
        `with a fee held, it says the Beans go when they confirm (${JSON.stringify(toBob)})`);
    assert(toCy.length === 1 && toCy[0].title === '⏳ Deal Awaiting Completion' && /has been in escrow for over 7 days/.test(toCy[0].body),
        `any other deal is nudged as before (${JSON.stringify(toCy)})`);
    await returned(alice, lingerFree);
    await returned(bob, lingerFee);
    await returned(cy, lingerSale.body.transaction.id);
    ledgerAddsUp('the nudged deals');

    // ── 12. The visitor's shape ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 12. The visitor\'s shape');
    const outAgain = await lend(dave, cy, drill, 2);
    const member = getPosts({ id: drill, includeAllScopes: true })[0]!;
    const visitor = guestPost(member);
    const other = withoutTradeParty(member);
    assert(member.lendBackAround && visitor.lendable === true && visitor.replacementValue === '$120' && visitor.lendMaxDays === 7
        && !('lendBackAround' in visitor) && !('acceptedAt' in visitor) && other.lendBackAround === member.lendBackAround,
        'a visitor reads the terms and that it is out, never when it is due back; a member who isn\'t a party reads the date');
    await returned(cy, outAgain);

    // ── 13. The offer covenant ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 13. The offer covenant');
    const fen = makeMember('Fen', 0, false);
    db.prepare('UPDATE members SET earned_credit = 100 WHERE public_key = ?').run(fen.pk); // a granted line of 100, metered by the offer bands
    const fenLadder = (await offer(fen, { title: 'Step ladder', lendable: true })).body?.post?.id as string;
    const listed = getBalance(fen.pk);
    assert(postRow(fenLadder)?.lendable === 1 && listed.liveOffers === 1 && listed.usableFloor === -100 && hasLiveOffer(fen.pk),
        `Fen's only Offer is a Free ladder to lend: one live Offer, a credit line of 100 (${JSON.stringify({ live: listed.liveOffers, usable: listed.usableFloor })})`);
    const fenLoan = await lend(fen, cy, fenLadder);
    const lent = getBalance(fen.pk);
    assert(postRow(fenLadder).status === 'pending' && postRow(fenLadder).accepted_by === cy.pk && lent.liveOffers === 1 && lent.usableFloor === -100 && hasLiveOffer(fen.pk),
        `Cy borrows the ladder (asked, and Fen says yes): it is out, and still Fen's live Offer, so Fen keeps the line (${JSON.stringify({ live: lent.liveOffers, usable: lent.usableFloor })})`);
    const hedge = (await offer(alice, { title: 'Hedge trimming', credits: 5 })).body?.post?.id as string;
    const spent = await take(fen, hedge);
    assert(spent.status === 200 && bal(fen.pk) === -5,
        `while it is out, Fen spends within the line: 5 Beans held for Alice's hedge trimming (${brief(spent)}; balance ${bal(fen.pk)})`);
    ledgerAddsUp('a lender spending on credit while their only Offer is out');
    const fenBack = await returned(cy, fenLoan);
    assert(fenBack.status === 200 && backOnBoard(fenLadder) && getBalance(fen.pk).liveOffers === 1,
        `Cy returns it: back on the board, still one live Offer (${brief(fenBack)})`);
    await callOff(fen, spent.body?.transaction?.id);
    const bobLive = getBalance(bob.pk).liveOffers;
    const bike = (await offer(bob, { title: 'Old bike', credits: 2 })).body?.post?.id as string;
    const bikeListed = getBalance(bob.pk).liveOffers;
    const bikeTaken = await take(cy, bike);
    assert(bikeListed === bobLive + 1 && bikeTaken.status === 200 && postRow(bike).status === 'pending' && getBalance(bob.pk).liveOffers === bobLive,
        `a one-off Offer taken by its deal stops counting, as before (${bobLive} → ${bikeListed} → ${getBalance(bob.pk).liveOffers}; ${brief(bikeTaken)})`);
    await callOff(cy, bikeTaken.body?.transaction?.id);
    ledgerAddsUp('the offer covenant');

    // ── 14. Ask first ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 14. Ask first');
    const gil = makeMember('Gil', 100);      // lends
    const hal = makeMember('Hal', 100);
    const ivy = makeMember('Ivy', 100);      // blocked by Gil
    const saw = (await offer(gil, { title: 'Hand saw', lendable: true })).body?.post?.id as string;
    const poleSaw = (await offer(gil, { title: 'Pole saw', lendable: true, credits: 8 })).body?.post?.id as string;
    const mower = (await offer(gil, { title: 'Lawn mower', lendable: true, credits: 6, priceType: 'daily', lendMaxDays: 5 })).body?.post?.id as string;
    const dealsOn = (postId: string): number => (db.prepare('SELECT COUNT(*) AS n FROM marketplace_transactions WHERE post_id = ?').get(postId) as { n: number }).n;
    const escrows = (): number => (db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE public_key LIKE 'escrow_%'").get() as { n: number }).n;
    const askFirst = (r: { status: number; body: any }) => r.status === 409 && r.body?.error === LEND_ASK_FIRST_ERROR && r.body?.code === LEND_ASK_FIRST_CODE;
    assert(!!saw && !!poleSaw && !!mower && backOnBoard(saw) && backOnBoard(poleSaw) && backOnBoard(mower), 'Gil lends a Free saw, a pole saw for 8 Beans and a mower at 6 Beans a day');

    const e14 = escrows();
    const b14 = { gil: bal(gil.pk), hal: bal(hal.pk), cy: bal(cy.pk), commons: commons() };
    const t14 = pushMark();
    const freeTake = await take(hal, saw, 2);
    const freeNoDays = await take(hal, saw);
    await settle();
    assert(askFirst(freeTake) && askFirst(freeNoDays),
        `Hal takes the Free saw in one step, with days or without (an app that predates lending): refused, in plain words with a code (${brief(freeTake)} / ${brief(freeNoDays)})`);
    assert(backOnBoard(saw) && dealsOn(saw) === 0 && escrows() === e14 && toldSince(gil, t14).length === 0,
        'nothing is held, no deal is opened, the saw is still on the board, and Gil is not pushed');
    const pricedTake = await take(hal, mower, 2);
    const oneFeeTake = await take(hal, poleSaw);
    const bothAtOnce = await Promise.all([take(hal, poleSaw), take(cy, poleSaw)]);
    assert(askFirst(pricedTake) && askFirst(oneFeeTake) && bothAtOnce.every(askFirst),
        `a priced one is refused too, per day or one fee, and two takes at once are both refused (${[pricedTake, oneFeeTake, ...bothAtOnce].map(brief).join(' / ')})`);
    assert(bal(hal.pk) === b14.hal && bal(cy.pk) === b14.cy && bal(gil.pk) === b14.gil && commons() === b14.commons
        && dealsOn(mower) === 0 && dealsOn(poleSaw) === 0 && escrows() === e14 && backOnBoard(mower) && backOnBoard(poleSaw),
        'no balance moves, no deal or escrow is opened, and both are still on the board');
    ledgerAddsUp('one-step accepts of lendable Offers refused');

    const t14b = pushMark();
    const asked14 = await ask(hal, mower, 2);
    await settle();
    assert(asked14.status === 200 && asked14.body.transaction.status === 'requested' && asked14.body.transaction.credits === 12 && bal(hal.pk) === b14.hal
        && toldSince(gil, t14b).filter(n => n.title === '📩 New Request').length === 1,
        `Hal asks to borrow the mower for 2 days: a request for 12 Beans, nothing held yet, and Gil is pushed (${brief(asked14)})`);
    const yes14 = await agree(gil, asked14.body.transaction.id);
    assert(yes14.status === 200 && postRow(mower).status === 'pending' && postRow(mower).accepted_by === hal.pk && bal(hal.pk) === r4(b14.hal - 12),
        `Gil says yes: the mower is out to Hal, and his 12 Beans are held (${brief(yes14)})`);
    const back14 = await returned(hal, asked14.body.transaction.id);
    assert(back14.status === 200 && backOnBoard(mower) && bal(gil.pk) === r4(b14.gil + 12 - 0.18) && commons() === r4(b14.commons + 0.18),
        `returned: Gil is paid 12 Beans less 1.5% to the Commons, and the mower is back on the board (${brief(back14)})`);
    ledgerAddsUp('a loan asked for and agreed');

    const blocks = await signed('/api/blocks', gil, { targetPubkey: ivy.pk });
    assert(blocks.status === 200, `Gil blocks Ivy (${brief(blocks)})`);
    const b14i = bal(ivy.pk);
    const t14c = pushMark();
    const ivyTakes = await take(ivy, saw, 2);
    const ivyAsks = await ask(ivy, saw, 2);
    await settle();
    assert(askFirst(ivyTakes), `Ivy, whom Gil has blocked, taking the saw in one step is told what anyone is (${brief(ivyTakes)})`);
    assert(ivyAsks.status === 200 && ivyAsks.body.transaction.status === 'requested' && txRow(ivyAsks.body.transaction.id).status === 'requested'
        && bal(ivy.pk) === b14i && backOnBoard(saw),
        `her request is taken as anyone's, and waits: nothing held, the saw still on the board (${brief(ivyAsks)})`);
    assert(toldSince(gil, t14c).length === 0, `Gil is not pushed about it (${JSON.stringify(toldSince(gil, t14c))})`);
    const ivyDeals = await signedGet(`/api/marketplace/transactions?publicKey=${ivy.pk}`, ivy);
    const ivyRow = (Array.isArray(ivyDeals.body) ? ivyDeals.body : []).find((t: any) => t.id === ivyAsks.body.transaction.id);
    const ivyWords = JSON.stringify([ivyTakes.body, ivyAsks.body, ivyDeals.body, toldSince(ivy, t14c)]);
    assert(ivyRow?.status === 'requested' && !/block/i.test(ivyWords),
        `in her deals it waits as a request, and nothing she is answered or sent says she is blocked (${ivyRow?.status})`);
    await signed('/api/marketplace/transactions/cancel-request', ivy, { transactionId: ivyAsks.body.transaction.id, buyerPublicKey: ivy.pk });

    const bread = (await offer(gil, { title: 'Sourdough loaf', credits: 4 })).body?.post?.id as string;
    const gilJobs = (db.prepare("SELECT id FROM posts WHERE author_pubkey = ? AND title = 'Gil odd jobs'").get(gil.pk) as { id: string }).id;
    const hb = bal(hal.pk);
    const breadTaken = await take(hal, bread);
    assert(breadTaken.status === 200 && breadTaken.body.transaction.status === 'pending' && bal(hal.pk) === r4(hb - 4) && postRow(bread).status === 'pending',
        `an ordinary one-off Offer is still taken in one step: 4 Beans held, the loaf off the board (${brief(breadTaken)})`);
    const jobsTaken = await take(hal, gilJobs);
    assert(jobsTaken.status === 200 && jobsTaken.body.transaction.status === 'pending' && postRow(gilJobs).status === 'active' && postRow(gilJobs).repeatable === 1,
        `and a repeatable one, which stays on the board (${brief(jobsTaken)})`);
    await callOff(hal, breadTaken.body.transaction.id);
    await callOff(hal, jobsTaken.body.transaction.id);
    assert(bal(hal.pk) === hb && postRow(bread).status === 'active', 'both called off, Hal\'s Beans are back and the loaf is back on the board');
    ledgerAddsUp('ordinary one-step accepts');

    // ── 15. A standby copy ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 15. A standby copy');
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4043/p2p/${nodeId}`);
    const payload = await exportSyncState(nodeId);
    const sent = (payload.posts ?? []).find(p => p.id === drill) as any;
    const sentPlain = (payload.posts ?? []).find(p => p.id === firewood) as any;
    assert(sent?.lendable === true && sent.lendMaxDays === 7 && sent.replacementValue === '$120' && sent.repeatable === true && !('lendable' in (sentPlain ?? {})),
        'the copy carries a lendable Offer and its terms, and nothing for a listing that isn\'t lent');
    db.prepare("UPDATE posts SET lendable = 0, lend_max_days = NULL, lend_terms = 'stale', replacement_value = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(drill);
    setNodeRole('backup');
    await importRemoteState(payload as any);
    const copied = postRow(drill);
    assert(copied.lendable === 1 && copied.lend_max_days === 7 && copied.lend_terms === null && copied.replacement_value === '$120' && copied.repeatable === 1,
        `the standby's row comes back as the main server holds it (${JSON.stringify(copied)})`);
    const { signature: _s, publicKey: _p, ...unsigned } = payload as any;
    const stopped = { ...sent, updatedAt: new Date(Date.now() + 1000).toISOString(), repeatable: false };
    delete stopped.lendable; delete stopped.lendMaxDays; delete stopped.replacementValue; delete stopped.lendTerms;
    await importRemoteState(await signSyncPayload({ ...unsigned, posts: [stopped] } as any) as any);
    const cleared = postRow(drill);
    assert(cleared.lendable === 0 && cleared.lend_max_days === null && cleared.replacement_value === null,
        `a copy that no longer says it is lent clears it here too (${JSON.stringify(cleared)})`);
    setNodeRole('primary');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
