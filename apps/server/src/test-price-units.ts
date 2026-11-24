/**
 * Exhaustive table test over ALL listing price units (old and new):
 *   PRICE_UNITS × (Offer, Need) × (create, edit) × (deal amount computed + release + ledger conservation)
 * plus standing-deal refusal for `yearly` & `per_kg`, unknown-unit refusal, and `features.priceUnitsKgYear`.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-price-units)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { db } from './db/db.js';
import { wrapCreatePost, TEST_PHOTOS } from './post-test-helper.js';
import {
    initStateEngine, transfer, createPost as rawCreatePost, runLedgerAudit, getCommonsBalanceExact,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { setMemberPhoto } from '@beanpool/engine';
import {
    PRICE_UNITS, dealAmountFor, priceUnitDealKind, standingAuthorisationText, standingUnitOf, type PriceUnit,
} from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://exp.host')) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (!url.startsWith('https://localhost')) throw new Error(`test-price-units: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const hc = (beans: number) => Math.round(beans * 100);
const EPOCH_NOW = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
let BASE = '';
type Id = { pk: string; privateKey: crypto.KeyObject };

function makeMember(callsign: string, beans: number): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const id = { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pk, callsign);
    setMemberPhoto(db, id.pk, 'data:image/png;base64,iVBORw0KGgo=');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, EPOCH_NOW);
    if (beans > 0) transfer('genesis', id.pk, hc(beans), `seed ${callsign}`, 'direct', true);
    createPost('offer', 'general', `${callsign} odd jobs`, 'Help around the place', hc(5), 'fixed', id.pk, undefined, undefined, undefined, true);
    return id;
}

async function call(method: 'GET' | 'POST', urlPath: string, id: Id, body?: unknown) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const hasBody = method === 'POST';
    const res = await fetch(`${BASE}${urlPath}`, {
        method,
        headers: {
            ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
            'X-Public-Key': id.pk,
            'X-Signature': signRequest(id.privateKey, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, ...(hasBody ? { body: raw } : {}) }),
            [SIGNED_FOR_HEADER]: signedForHost(),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        ...(hasBody ? { body: raw } : {}),
    });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const post = (who: Id, urlPath: string, body: unknown) => call('POST', urlPath, who, body);
const brief = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 220)}`;
const txRow = (id: string) => db.prepare('SELECT status, amount_c, hours FROM marketplace_transactions WHERE id = ?').get(id) as { status: string; amount_c: number; hours: number | null };

function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as { t: number }).t;
    return accounts + getCommonsBalanceExact();
}

function createBody(kind: 'offer' | 'need', unit: PriceUnit, author: Id, price_c: number) {
    return {
        type: kind,
        category: 'food',
        title: `${kind} ${unit}`,
        description: `Listing priced ${unit}`,
        price_c,
        priceType: unit,
        authorPublicKey: author.pk,
        photos: TEST_PHOTOS,
        ...(unit === 'each' ? { unitsLeft: 10 } : {}),
    };
}

async function main() {
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const alice = makeMember('Alice', 5000);
    const bob = makeMember('Bob', 5000);

    // 1. Features flag held off on /api/community/info until both stores carry the mobile build (PRICE_UNITS_KG_YEAR_BUILT)
    const infoRes = await fetch(`${BASE}/api/community/info`);
    const info = await infoRes.json() as any;
    assert(infoRes.status === 200 && typeof info?.features === 'object' && !('priceUnitsKgYear' in info.features),
        `GET /api/community/info holds features.priceUnitsKgYear off until mobile builds ship (red if PRICE_UNITS_KG_YEAR_BUILT is true) (${JSON.stringify(info?.features?.priceUnitsKgYear)})`);

    // 2. Exhaustive table: ALL units × (Offer, Need) × (create, edit, deal amount, release)
    const unitPrice = hc(10); // 10 Beans
    const bookedQty = 2;
    const confirmedQty = 1.5;

    for (const unit of PRICE_UNITS) {
        const dealKind = priceUnitDealKind(unit);
        for (const kind of ['offer', 'need'] as const) {
            const label = `${kind}/${unit}`;
            const createRes = await post(alice, '/api/marketplace/posts', createBody(kind, unit, alice, unitPrice));

            if (unit === 'each' && kind === 'need') {
                assert(createRes.status === 400, `${label} create refused (Need cannot be priced each; got ${brief(createRes)})`);
                const needFixed = await post(alice, '/api/marketplace/posts', createBody('need', 'fixed', alice, unitPrice));
                const editEach = await post(alice, '/api/marketplace/posts/update', {
                    id: needFixed.body?.post?.id, authorPublicKey: alice.pk, priceType: 'each', unitsLeft: 5,
                });
                assert(editEach.status === 400, `${label} edit refused (Need cannot be edited into each; got ${brief(editEach)})`);
                continue;
            }

            assert(createRes.status === 200 && createRes.body?.post?.priceType === unit,
                `${label} create accepted and stored priceType=${unit} (${brief(createRes)})`);

            // Edit check: start as fixed, edit into `unit`, verify stored
            const baseRes = await post(alice, '/api/marketplace/posts', createBody(kind, 'fixed', alice, unitPrice));
            const baseId = baseRes.body?.post?.id;
            const editRes = await post(alice, '/api/marketplace/posts/update', {
                id: baseId,
                authorPublicKey: alice.pk,
                priceType: unit,
                ...(unit === 'each' ? { unitsLeft: 8 } : {}),
            });
            assert(editRes.status === 200 && editRes.body?.post?.priceType === unit,
                `${label} edit fixed -> ${unit} accepted (${brief(editRes)})`);

            // Deal amount computation + release check on the created post
            const postId = createRes.body?.post?.id as string;

            if (dealKind === 'fixed') {
                // Both `fixed` and `per_kg`: deal amount = posted price_c, no hours required, never re-rated at release
                if (kind === 'offer') {
                    if (unit === 'per_kg') {
                        const badHours = await post(bob, '/api/marketplace/posts/accept', { postId, buyerPublicKey: bob.pk, hours: 3 });
                        assert(badHours.status === 400, `${label} offer accept with hours refused 400 so old clients cannot silently under-hold (${brief(badHours)})`);
                    }
                    const acc = await post(bob, '/api/marketplace/posts/accept', { postId, buyerPublicKey: bob.pk });
                    const txId = acc.body?.transaction?.id as string;
                    assert(acc.status === 200 && txRow(txId).amount_c === unitPrice,
                        `${label} offer accept holds exact posted price_c=${unitPrice} (${brief(acc)})`);
                    const rel = await post(bob, '/api/marketplace/transactions/complete', { transactionId: txId, confirmerPublicKey: bob.pk });
                    assert(rel.status === 200 && txRow(txId).status === 'completed' && txRow(txId).amount_c === unitPrice,
                        `${label} offer release settles exact posted price_c=${unitPrice} (${brief(rel)})`);
                } else {
                    if (unit === 'per_kg') {
                        const badHours = await post(bob, '/api/marketplace/posts/request', { postId, buyerPublicKey: bob.pk, hours: 3 });
                        assert(badHours.status === 400, `${label} need request with hours refused 400 so old clients cannot silently under-hold (${brief(badHours)})`);
                    }
                    const req = await post(bob, '/api/marketplace/posts/request', { postId, buyerPublicKey: bob.pk });
                    const txId = req.body?.transaction?.id as string;
                    assert(req.status === 200 && txRow(txId).amount_c === unitPrice,
                        `${label} need request computes exact posted price_c=${unitPrice} (${brief(req)})`);
                    const app = await post(alice, '/api/marketplace/transactions/approve', { transactionId: txId, authorPublicKey: alice.pk });
                    assert(app.status === 200 && txRow(txId).amount_c === unitPrice,
                        `${label} need approve holds exact posted price_c=${unitPrice} (${brief(app)})`);
                    const rel = await post(alice, '/api/marketplace/transactions/complete', { transactionId: txId, confirmerPublicKey: alice.pk });
                    assert(rel.status === 200 && txRow(txId).status === 'completed' && txRow(txId).amount_c === unitPrice,
                        `${label} need release settles exact posted price_c=${unitPrice} (${brief(rel)})`);
                }
            } else if (dealKind === 'each') {
                const wantCount = 3;
                const wantTotal = wantCount * unitPrice;
                const acc = await post(bob, '/api/marketplace/posts/accept', {
                    postId,
                    buyerPublicKey: bob.pk,
                    hours: wantCount,
                    itemOption: 'each',
                    expect_c: wantTotal,
                });
                const txId = acc.body?.transaction?.id as string;
                assert(acc.status === 200 && txRow(txId).amount_c === wantTotal,
                    `${label} offer accept holds ${wantCount} × ${unitPrice} = ${wantTotal} (${brief(acc)})`);
                const rel = await post(bob, '/api/marketplace/transactions/complete', { transactionId: txId, confirmerPublicKey: bob.pk });
                assert(rel.status === 200 && txRow(txId).status === 'completed' && txRow(txId).amount_c === wantTotal,
                    `${label} offer release settles ${wantTotal} (${brief(rel)})`);
            } else if (dealKind === 'quantity') {
                const expectedBooked = dealAmountFor(unitPrice, bookedQty);
                const expectedConfirmed = dealAmountFor(unitPrice, confirmedQty);
                if (kind === 'offer') {
                    const noHours = await post(bob, '/api/marketplace/posts/accept', { postId, buyerPublicKey: bob.pk });
                    assert(noHours.status === 400, `${label} offer accept without quantity refused (${brief(noHours)})`);

                    const acc = await post(bob, '/api/marketplace/posts/accept', { postId, buyerPublicKey: bob.pk, hours: bookedQty });
                    const txId = acc.body?.transaction?.id as string;
                    assert(acc.status === 200 && txRow(txId).amount_c === expectedBooked,
                        `${label} offer accept holds price × ${bookedQty} = ${expectedBooked} (${brief(acc)})`);
                    const rel = await post(bob, '/api/marketplace/transactions/complete', { transactionId: txId, confirmerPublicKey: bob.pk, finalHours: confirmedQty });
                    assert(rel.status === 200 && txRow(txId).status === 'completed' && txRow(txId).amount_c === expectedConfirmed,
                        `${label} offer release re-rates to price × ${confirmedQty} = ${expectedConfirmed} (${brief(rel)})`);
                } else {
                    const noHours = await post(bob, '/api/marketplace/posts/request', { postId, buyerPublicKey: bob.pk });
                    assert(noHours.status === 400, `${label} need request without quantity refused (${brief(noHours)})`);

                    const req = await post(bob, '/api/marketplace/posts/request', { postId, buyerPublicKey: bob.pk, hours: bookedQty });
                    const txId = req.body?.transaction?.id as string;
                    assert(req.status === 200 && txRow(txId).amount_c === expectedBooked,
                        `${label} need request computes price × ${bookedQty} = ${expectedBooked} (${brief(req)})`);
                    const app = await post(alice, '/api/marketplace/transactions/approve', { transactionId: txId, authorPublicKey: alice.pk });
                    assert(app.status === 200 && txRow(txId).amount_c === expectedBooked,
                        `${label} need approve holds ${expectedBooked} (${brief(app)})`);
                    const rel = await post(alice, '/api/marketplace/transactions/complete', { transactionId: txId, confirmerPublicKey: alice.pk, finalHours: confirmedQty });
                    assert(rel.status === 200 && txRow(txId).status === 'completed' && txRow(txId).amount_c === expectedConfirmed,
                        `${label} need release re-rates to ${expectedConfirmed} (${brief(rel)})`);
                }
            }
        }
    }

    // 3. Standing deals refuse `yearly` and `per_kg` (period_unit CHECK is ('week','month'))
    assert(standingUnitOf('weekly') === 'week' && standingUnitOf('monthly') === 'month', 'standingUnitOf maps weekly/monthly');
    assert(standingUnitOf('yearly') === null && standingUnitOf('per_kg') === null, 'standingUnitOf refuses yearly and per_kg');
    for (const unit of ['yearly', 'per_kg'] as const) {
        const made = await post(alice, '/api/marketplace/posts', createBody('offer', unit, alice, unitPrice));
        const postId = made.body?.post?.id as string;
        const startsAt = new Date().toISOString();
        const payload = standingAuthorisationText({
            host: signedForHost(),
            standingId: crypto.randomUUID(),
            listingId: postId,
            payee: alice.pk,
            beansPerPeriod_c: unitPrice,
            unit: 'month',
            maxPeriods: 4,
            startsAt,
            nonce: crypto.randomBytes(12).toString('hex'),
        });
        const signature = crypto.sign(null, Buffer.concat([Buffer.from([0xff]), Buffer.from(payload, 'utf-8')]), bob.privateKey).toString('base64');
        const standingRes = await post(bob, '/api/marketplace/posts/accept', {
            postId,
            buyerPublicKey: bob.pk,
            standing: { authorisation: { payload, signature }, periods: 4, startsAt },
        });
        assert(standingRes.status === 400, `standing deal refused on ${unit} listing (${brief(standingRes)})`);
    }

    // 4. Unknown price unit refused on create and edit
    const badCreate = await post(alice, '/api/marketplace/posts', {
        ...createBody('offer', 'fixed', alice, unitPrice),
        priceType: 'per_litre',
    });
    assert(badCreate.status === 400, `unknown priceType 'per_litre' refused on create (${brief(badCreate)})`);
    const goodPost = await post(alice, '/api/marketplace/posts', createBody('offer', 'fixed', alice, unitPrice));
    const badEdit = await post(alice, '/api/marketplace/posts/update', {
        id: goodPost.body?.post?.id, authorPublicKey: alice.pk, priceType: 'per_litre',
    });
    assert(badEdit.status === 400, `unknown priceType 'per_litre' refused on edit (${brief(badEdit)})`);

    // 4b. Fail-safe allow-list at release: if a legacy/future row carries an unknown price_type with booked hours,
    // completePostTransaction holds the fixed amount and never fails open to re-rating.
    const hourlyForLegacy = await post(alice, '/api/marketplace/posts', createBody('offer', 'hourly', alice, unitPrice));
    const legacyPostId = hourlyForLegacy.body?.post?.id as string;
    const legacyAcc = await post(bob, '/api/marketplace/posts/accept', { postId: legacyPostId, buyerPublicKey: bob.pk, hours: bookedQty });
    const legacyTxId = legacyAcc.body?.transaction?.id as string;
    const legacyHeld = dealAmountFor(unitPrice, bookedQty);
    db.prepare(`UPDATE posts SET price_type = 'per_litre' WHERE id = ?`).run(legacyPostId);
    const legacyRel = await post(bob, '/api/marketplace/transactions/complete', {
        transactionId: legacyTxId, confirmerPublicKey: bob.pk, finalHours: confirmedQty,
    });
    assert(legacyRel.status === 200 && txRow(legacyTxId).status === 'completed' && txRow(legacyTxId).amount_c === legacyHeld,
        `unknown price_type at release holds exact amount_c=${legacyHeld} without failing open to re-rating (${brief(legacyRel)})`);

    // 5. Ledger conservation across all deals
    const a = runLedgerAudit();
    assert(a.ok && a.drift === 0 && a.strandedEscrows === 0 && a.badBalances === 0 && nodeTotal() === 0,
        `ledger conserved after all price unit deals (drift=${a.drift}, stranded=${a.strandedEscrows}, total=${nodeTotal()})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
