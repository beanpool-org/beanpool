/**
 * A payment to the Commons is safe to retry (engine/money-requests.ts; POST /api/commons/pay), over HTTPS, through the real
 * middleware:
 *
 *   1. the same request id twice: one payment, and the repeat gets the first answer, word for word
 *   2. the same id with a different amount, or for a debt where the first was for none: refused (409
 *      `request_id_reused`), nothing paid
 *   3. no id (an app from before this): paid each time it comes, as before
 *   4. two (and five) requests with one id at once: one payment, every answer the same
 *   5. two ids for the same amount: two payments (the member meant both); another member's same id is their own payment
 *   6. a refused payment (more than they hold) records nothing, so its retry with the same id is judged afresh and paid
 *   7. an id that isn't one (a number, too short, a space): refused (400) before anything moves
 *   8. the record is the payer's, written with the payment; a week-old one goes at the daily prune, a 6-day one stays
 *   9. the apps' held payment against the node's memory (core money-retry.ts): the apps send a lost payment again for
 *      MONEY_RESEND_HOURS from its first sending, strictly inside REQUEST_ID_KEPT_DAYS; at the last moment they may, the
 *      node still answers it with the first payment; past the node's days the same id would pay again, and the apps
 *      stopped sending it long before (both pay screens send a held payment only through core heldResend)
 *   Every step: conservation, the whole node sums to what it summed to before
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-commons-pay-idempotent-http.ts
 *
 * Runs to the end without engine/money-requests.ts (origin/main), so a fail-first run reports what fails, not a crash.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, transfer, seedGenesisMember, getCommonsBalanceExact } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONEY_RESEND_HOURS, firstSending, heldResend } from '@beanpool/core';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const hex = (n: number) => crypto.randomBytes(n).toString('hex');
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;
/**
 * The story's figures are Beans; the node's are whole hundredths (1 Bean = 100). `hc` turns a Beans figure into hundredths
 * for a request body or a check; `beansOf` turns one back for a message.
 */
const hc = (beans: number) => Math.round(beans * 100);
const beansOf = (hundredths: number) => hundredths / 100;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, beans = 0): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, hc(beans), `seed ${name}`, 'direct', true);
    return id;
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
}

/** A member's signed request (test-names-debts-http.ts call). */
async function call(method: string, id: Id, path: string, body?: unknown): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = hex(16);
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk,
        'X-Signature': signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString }),
        [SIGNED_FOR_HEADER]: signedForHost(),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}
const pay = (id: Id, body: Record<string, unknown>) => call('POST', id, '/api/commons/pay', body);

/**
 * The whole node as one number, whole hundredths (test-commons-conservation.ts nodeTotal): every account but the pot's
 * shadow, plus the pot. Exact: no rounding.
 */
const nodeTotal = () => (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t + getCommonsBalanceExact();
/** A member's stored balance, whole hundredths. */
const balanceRow = (who: Id) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(who.pk) as { balance_c: number } | undefined)?.balance_c ?? 0;
const paymentsBy = (who: Id) => (db.prepare(`SELECT COUNT(*) n FROM transactions WHERE from_pubkey = ? AND memo = 'Paid to the Commons'`).get(who.pk) as { n: number }).n;
/** The request's record, or null; undefined when there is no such table (origin/main). */
function recordOf(who: Id, requestId: string): any {
    try { return db.prepare('SELECT * FROM money_requests WHERE payer_pubkey = ? AND request_id = ?').get(who.pk, requestId) ?? null; } catch { return undefined; }
}
const uuid = () => crypto.randomUUID();

async function main(): Promise<void> {
    console.log('A payment to the Commons is safe to retry, over HTTPS\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const sam = makeMember('Sam', 100);
    const tia = makeMember('Tia', 20);
    const total = nodeTotal();
    const conserved = (when: string) => assert(nodeTotal() === total, `${when}: the node sums to what it did (${total}, now ${nodeTotal()} hundredths)`);

    // ── 1. The same id twice: one payment, the first answer back ──
    {
        const id = uuid();
        const before = balanceRow(sam), count = paymentsBy(sam);
        const first = await pay(sam, { amount_c: hc(10), requestId: id });
        assert(first.status === 200 && typeof first.body?.transactionId === 'string' && first.body?.amount_c === hc(10), `1. the first send pays (${show(first)})`);
        const again = await pay(sam, { amount_c: hc(10), requestId: id });
        assert(again.status === 200, `1. the repeat is answered 200 (${show(again)})`);
        assert(JSON.stringify(again.body) === JSON.stringify(first.body), `1. the repeat gets the first answer, word for word (${show(again)})`);
        assert(paymentsBy(sam) === count + 1, `1. one payment made, not two (${paymentsBy(sam) - count})`);
        assert(balanceRow(sam) === before - hc(10), `1. Sam paid 10 once (${beansOf(before)} → ${beansOf(balanceRow(sam))})`);
        const rec = recordOf(sam, id);
        assert(!!rec && rec.route === 'POST /api/commons/pay' && JSON.parse(rec.answer).transactionId === first.body?.transactionId,
            `8. the record is Sam's, with the first answer (${JSON.stringify(rec)?.slice(0, 160)})`);
        conserved('1');

        // ── 2. The same id for a different payment: refused, nothing paid ──
        const other = await pay(sam, { amount_c: hc(11), requestId: id });
        assert(other.status === 409 && other.body?.code === 'request_id_reused', `2. the same id with another amount is refused 409 (${show(other)})`);
        const forDebt = await pay(sam, { amount_c: hc(10), debtId: 'zz', requestId: id });
        assert(forDebt.status === 409 && forDebt.body?.code === 'request_id_reused', `2. the same id for a debt, the first for none: refused 409 (${show(forDebt)})`);
        assert(paymentsBy(sam) === count + 1 && balanceRow(sam) === before - hc(10), `2. nothing more paid (${paymentsBy(sam) - count} payment, ${beansOf(balanceRow(sam))})`);
        conserved('2');
    }

    // ── 3. No id: as before, paid each time ──
    {
        const before = balanceRow(sam), count = paymentsBy(sam);
        const a = await pay(sam, { amount_c: hc(3) });
        const b = await pay(sam, { amount_c: hc(3) });
        assert(a.status === 200 && b.status === 200 && a.body?.transactionId !== b.body?.transactionId, `3. two sends with no id: two payments (${show(a)} / ${show(b)})`);
        assert(paymentsBy(sam) === count + 2 && balanceRow(sam) === before - hc(6), `3. Sam paid 3 twice (${beansOf(before)} → ${beansOf(balanceRow(sam))})`);
        conserved('3');
    }

    // ── 4. Duplicates at once: one payment ──
    for (const n of [2, 5]) {
        const id = uuid();
        const before = balanceRow(sam), count = paymentsBy(sam);
        const answers = await Promise.all(Array.from({ length: n }, () => pay(sam, { amount_c: hc(2), requestId: id })));
        assert(answers.every((r) => r.status === 200), `4. ${n} at once: every one answered 200 (${answers.map(show).join(' | ').slice(0, 300)})`);
        assert(new Set(answers.map((r) => r.body?.transactionId)).size === 1, `4. ${n} at once: one transaction id in every answer`);
        assert(paymentsBy(sam) === count + 1 && balanceRow(sam) === before - hc(2), `4. ${n} at once: one payment (${paymentsBy(sam) - count}, ${beansOf(before)} → ${beansOf(balanceRow(sam))})`);
        conserved(`4 (${n})`);
    }

    // ── 5. Two ids, the same amount: two payments; another member's same id is theirs ──
    {
        const before = balanceRow(sam), count = paymentsBy(sam);
        const a = await pay(sam, { amount_c: hc(1), requestId: uuid() });
        const b = await pay(sam, { amount_c: hc(1), requestId: uuid() });
        assert(a.status === 200 && b.status === 200 && a.body?.transactionId !== b.body?.transactionId, `5. two ids: two payments (${show(a)} / ${show(b)})`);
        assert(paymentsBy(sam) === count + 2 && balanceRow(sam) === before - hc(2), `5. Sam paid 1 twice (${beansOf(before)} → ${beansOf(balanceRow(sam))})`);
        const shared = uuid();
        const s = await pay(sam, { amount_c: hc(1), requestId: shared });
        const t = await pay(tia, { amount_c: hc(1), requestId: shared });
        assert(s.status === 200 && t.status === 200 && s.body?.transactionId !== t.body?.transactionId, `5. Tia's send with Sam's id is her own payment (${show(s)} / ${show(t)})`);
        const tiaAgain = await pay(tia, { amount_c: hc(2), requestId: shared });
        assert(tiaAgain.status === 409, `5. and her id is hers: a different amount on it is refused (${show(tiaAgain)})`);
        conserved('5');
    }

    // ── 6. A refused payment records nothing; its retry is judged afresh ──
    {
        const id = uuid();
        const held = balanceRow(tia);
        const tooMuch = await pay(tia, { amount_c: hc(25), requestId: id });
        assert(tooMuch.status === 409 && /only what you hold/.test(tooMuch.body?.error ?? ''), `6. more than Tia holds: refused (${show(tooMuch)})`);
        assert(recordOf(tia, id) !== undefined && recordOf(tia, id) === null, `6. the refusal recorded no id (${JSON.stringify(recordOf(tia, id))})`);
        assert(balanceRow(tia) === held, `6. nothing moved (${beansOf(balanceRow(tia))})`);
        transfer('genesis', tia.pk, hc(10), 'top up Tia', 'direct', true);
        const retry = await pay(tia, { amount_c: hc(25), requestId: id });
        assert(retry.status === 200 && retry.body?.amount_c === hc(25), `6. topped up, the retry with the same id is paid (${show(retry)})`);
        const retryAgain = await pay(tia, { amount_c: hc(25), requestId: id });
        assert(retryAgain.status === 200 && retryAgain.body?.transactionId === retry.body?.transactionId && balanceRow(tia) === held + hc(10) - hc(25),
            `6. and once only (${show(retryAgain)}, Tia ${beansOf(balanceRow(tia))})`);
    }

    // ── 7. An id that isn't one: refused before anything moves ──
    {
        const before = balanceRow(sam), count = paymentsBy(sam);
        for (const bad of [12345678, 'short', 'has a space in it', 'x'.repeat(129)]) {
            const r = await pay(sam, { amount_c: hc(1), requestId: bad });
            assert(r.status === 400, `7. requestId ${JSON.stringify(bad).slice(0, 20)}: refused 400 (${show(r)})`);
        }
        assert(paymentsBy(sam) === count && balanceRow(sam) === before, `7. nothing paid (${paymentsBy(sam) - count})`);
        conserved('7');
    }

    // ── 8. A week-old id goes at the daily prune; a 6-day one stays ──
    {
        const mod = await import('./engine/money-requests.js').catch(() => null);
        const oldId = uuid(), youngId = uuid();
        await pay(sam, { amount_c: hc(1), requestId: oldId });
        await pay(sam, { amount_c: hc(1), requestId: youngId });
        try {
            db.prepare('UPDATE money_requests SET created_at = ? WHERE request_id = ?').run(ago(8 * DAY), oldId);
            db.prepare('UPDATE money_requests SET created_at = ? WHERE request_id = ?').run(ago(6 * DAY), youngId);
        } catch { /* no table (origin/main) */ }
        const pruned = mod ? (mod as any).pruneMoneyRequests() : -1;
        assert(pruned === 1 && recordOf(sam, oldId) === null && !!recordOf(sam, youngId), `8. the prune takes the 8-day id alone (${pruned})`);
        const young = await pay(sam, { amount_c: hc(1), requestId: youngId });
        assert(young.status === 200 && young.body?.transactionId === JSON.parse(recordOf(sam, youngId)?.answer ?? '{}').transactionId, `8. the 6-day id still answers its first answer (${show(young)})`);
        conserved('8');
    }

    // ── 9. The apps' held payment against the node's memory (core money-retry.ts; the class PR #3393 named open) ──
    // The node forgets an id REQUEST_ID_KEPT_DAYS after it paid (the prune above). Both pay screens hold a lost payment for
    // Try again, and send it again only through core heldResend: for MONEY_RESEND_HOURS from its first sending. Red if either
    // moves so an app could send an id the node may have forgotten: a second payment to the Commons, under "never paid twice".
    {
        const mod = await import('./engine/money-requests.js').catch(() => null);
        const keptDays = (mod as any)?.REQUEST_ID_KEPT_DAYS as number | undefined;
        const H = 3_600_000;
        const resendMs = MONEY_RESEND_HOURS * H;
        assert(typeof keptDays === 'number' && resendMs > 0 && resendMs + DAY <= keptDays * DAY,
            `9. the apps send a held payment again for ${MONEY_RESEND_HOURS} h, strictly inside the ${keptDays} days the node keeps its id, with a day to spare`);
        // Through the door and the node's own prune: at the last moment the apps may send it, the node answers the first payment.
        const id = uuid();
        const first = await pay(sam, { amount_c: hc(2), requestId: id });
        const count = paymentsBy(sam);
        const age = (ms: number) => { try { db.prepare('UPDATE money_requests SET created_at = ? WHERE request_id = ?').run(ago(ms), id); } catch { /* no table */ } };
        age(resendMs);
        (mod as any)?.pruneMoneyRequests?.();
        const atLastResend = await pay(sam, { amount_c: hc(2), requestId: id });
        assert(first.status === 200 && atLastResend.status === 200 && JSON.stringify(atLastResend.body) === JSON.stringify(first.body) && paymentsBy(sam) === count,
            `9. at ${MONEY_RESEND_HOURS} h the node still answers a resend with the first payment, and pays nothing (${show(atLastResend)})`);
        // Past the node's days the prune forgets it, and the same id would be a new payment: the apps never send it by then.
        age((keptDays ?? 7) * DAY + 60_000);
        (mod as any)?.pruneMoneyRequests?.();
        const t0 = Date.now() - ((keptDays ?? 7) * DAY + 60_000);
        const held = firstSending({ requestId: id }, t0);
        assert(recordOf(sam, id) === null && heldResend(held, Date.now()) === null && heldResend(held, t0 + resendMs - 1) === held && heldResend(held, t0 + resendMs) === null,
            `9. after ${keptDays} days the node has forgotten the id, and the apps have not sent it since ${MONEY_RESEND_HOURS} h`);
        // Both pay screens hold their payment as core's HeldPayment and send it again only through heldResend.
        const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
        const has = (rel: string, marker: string) => { try { return fs.readFileSync(path.join(repo, rel), 'utf-8').includes(marker); } catch { return false; } };
        const stores: Array<[string, string]> = [
            ['apps/native/app/pay-commons.tsx', 'useState<HeldPayment<ConfirmedPayment<CommonsPayment>> | null>(null)'],
            ['apps/native/app/pay-commons.tsx', 'const again = heldResend(held, Date.now());'],
            ['apps/pwa/src/components/RepaymentCard.tsx', 'useState<HeldPayment<ConfirmedPayment<CommonsPayment>> | null>(null)'],
            ['apps/pwa/src/components/RepaymentCard.tsx', 'let going = heldResend(held, Date.now());'],
        ];
        const missing = stores.filter(([rel, marker]) => !has(rel, marker)).map(([rel, marker]) => `${rel}: ${marker}`);
        assert(missing.length === 0, `9. both pay screens send a held payment again only through core heldResend (${missing.join('; ') || 'both found'})`);
        conserved('9');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
