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
process.env.ADMIN_PASSWORD = 'PayIdem123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, transfer, seedGenesisMember, getCommonsBalanceExact } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

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
const r2 = (n: number) => Math.round(n * 100) / 100;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, beans = 0): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, beans, `seed ${name}`, 'direct', true);
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
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}
const pay = (id: Id, body: Record<string, unknown>) => call('POST', id, '/api/commons/pay', body);

/** The whole node as one number (test-commons-conservation.ts nodeTotal): every account but the pot's shadow, plus the pot. */
const nodeTotal = () => r2((db.prepare(`SELECT COALESCE(SUM(balance), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t + getCommonsBalanceExact());
const balanceRow = (who: Id) => r2((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(who.pk) as { balance: number } | undefined)?.balance ?? 0);
const paymentsBy = (who: Id) => (db.prepare(`SELECT COUNT(*) n FROM transactions WHERE from_pubkey = ? AND memo = 'Paid to the Commons'`).get(who.pk) as { n: number }).n;
/** The request's record, or null; undefined when there is no such table (origin/main). */
function recordOf(who: Id, requestId: string): any {
    try { return db.prepare('SELECT * FROM money_requests WHERE payer_pubkey = ? AND request_id = ?').get(who.pk, requestId) ?? null; } catch { return undefined; }
}
const uuid = () => crypto.randomUUID();

async function main(): Promise<void> {
    console.log('A payment to the Commons is safe to retry, over HTTPS\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const sam = makeMember('Sam', 100);
    const tia = makeMember('Tia', 20);
    const total = nodeTotal();
    const conserved = (when: string) => assert(nodeTotal() === total, `${when}: the node sums to what it did (${total}, now ${nodeTotal()})`);

    // ── 1. The same id twice: one payment, the first answer back ──
    {
        const id = uuid();
        const before = balanceRow(sam), count = paymentsBy(sam);
        const first = await pay(sam, { amount: 10, requestId: id });
        assert(first.status === 200 && typeof first.body?.transactionId === 'string' && first.body?.amount === 10, `1. the first send pays (${show(first)})`);
        const again = await pay(sam, { amount: 10, requestId: id });
        assert(again.status === 200, `1. the repeat is answered 200 (${show(again)})`);
        assert(JSON.stringify(again.body) === JSON.stringify(first.body), `1. the repeat gets the first answer, word for word (${show(again)})`);
        assert(paymentsBy(sam) === count + 1, `1. one payment made, not two (${paymentsBy(sam) - count})`);
        assert(balanceRow(sam) === r2(before - 10), `1. Sam paid 10 once (${before} → ${balanceRow(sam)})`);
        const rec = recordOf(sam, id);
        assert(!!rec && rec.route === 'POST /api/commons/pay' && JSON.parse(rec.answer).transactionId === first.body?.transactionId,
            `8. the record is Sam's, with the first answer (${JSON.stringify(rec)?.slice(0, 160)})`);
        conserved('1');

        // ── 2. The same id for a different payment: refused, nothing paid ──
        const other = await pay(sam, { amount: 11, requestId: id });
        assert(other.status === 409 && other.body?.code === 'request_id_reused', `2. the same id with another amount is refused 409 (${show(other)})`);
        const forDebt = await pay(sam, { amount: 10, debtId: 'zz', requestId: id });
        assert(forDebt.status === 409 && forDebt.body?.code === 'request_id_reused', `2. the same id for a debt, the first for none: refused 409 (${show(forDebt)})`);
        assert(paymentsBy(sam) === count + 1 && balanceRow(sam) === r2(before - 10), `2. nothing more paid (${paymentsBy(sam) - count} payment, ${balanceRow(sam)})`);
        conserved('2');
    }

    // ── 3. No id: as before, paid each time ──
    {
        const before = balanceRow(sam), count = paymentsBy(sam);
        const a = await pay(sam, { amount: 3 });
        const b = await pay(sam, { amount: 3 });
        assert(a.status === 200 && b.status === 200 && a.body?.transactionId !== b.body?.transactionId, `3. two sends with no id: two payments (${show(a)} / ${show(b)})`);
        assert(paymentsBy(sam) === count + 2 && balanceRow(sam) === r2(before - 6), `3. Sam paid 3 twice (${before} → ${balanceRow(sam)})`);
        conserved('3');
    }

    // ── 4. Duplicates at once: one payment ──
    for (const n of [2, 5]) {
        const id = uuid();
        const before = balanceRow(sam), count = paymentsBy(sam);
        const answers = await Promise.all(Array.from({ length: n }, () => pay(sam, { amount: 2, requestId: id })));
        assert(answers.every((r) => r.status === 200), `4. ${n} at once: every one answered 200 (${answers.map(show).join(' | ').slice(0, 300)})`);
        assert(new Set(answers.map((r) => r.body?.transactionId)).size === 1, `4. ${n} at once: one transaction id in every answer`);
        assert(paymentsBy(sam) === count + 1 && balanceRow(sam) === r2(before - 2), `4. ${n} at once: one payment (${paymentsBy(sam) - count}, ${before} → ${balanceRow(sam)})`);
        conserved(`4 (${n})`);
    }

    // ── 5. Two ids, the same amount: two payments; another member's same id is theirs ──
    {
        const before = balanceRow(sam), count = paymentsBy(sam);
        const a = await pay(sam, { amount: 1, requestId: uuid() });
        const b = await pay(sam, { amount: 1, requestId: uuid() });
        assert(a.status === 200 && b.status === 200 && a.body?.transactionId !== b.body?.transactionId, `5. two ids: two payments (${show(a)} / ${show(b)})`);
        assert(paymentsBy(sam) === count + 2 && balanceRow(sam) === r2(before - 2), `5. Sam paid 1 twice (${before} → ${balanceRow(sam)})`);
        const shared = uuid();
        const s = await pay(sam, { amount: 1, requestId: shared });
        const t = await pay(tia, { amount: 1, requestId: shared });
        assert(s.status === 200 && t.status === 200 && s.body?.transactionId !== t.body?.transactionId, `5. Tia's send with Sam's id is her own payment (${show(s)} / ${show(t)})`);
        const tiaAgain = await pay(tia, { amount: 2, requestId: shared });
        assert(tiaAgain.status === 409, `5. and her id is hers: a different amount on it is refused (${show(tiaAgain)})`);
        conserved('5');
    }

    // ── 6. A refused payment records nothing; its retry is judged afresh ──
    {
        const id = uuid();
        const held = balanceRow(tia);
        const tooMuch = await pay(tia, { amount: 25, requestId: id });
        assert(tooMuch.status === 409 && /only what you hold/.test(tooMuch.body?.error ?? ''), `6. more than Tia holds: refused (${show(tooMuch)})`);
        assert(recordOf(tia, id) !== undefined && recordOf(tia, id) === null, `6. the refusal recorded no id (${JSON.stringify(recordOf(tia, id))})`);
        assert(balanceRow(tia) === held, `6. nothing moved (${balanceRow(tia)})`);
        transfer('genesis', tia.pk, 10, 'top up Tia', 'direct', true);
        const retry = await pay(tia, { amount: 25, requestId: id });
        assert(retry.status === 200 && retry.body?.amount === 25, `6. topped up, the retry with the same id is paid (${show(retry)})`);
        const retryAgain = await pay(tia, { amount: 25, requestId: id });
        assert(retryAgain.status === 200 && retryAgain.body?.transactionId === retry.body?.transactionId && balanceRow(tia) === r2(held + 10 - 25),
            `6. and once only (${show(retryAgain)}, Tia ${balanceRow(tia)})`);
    }

    // ── 7. An id that isn't one: refused before anything moves ──
    {
        const before = balanceRow(sam), count = paymentsBy(sam);
        for (const bad of [12345678, 'short', 'has a space in it', 'x'.repeat(129)]) {
            const r = await pay(sam, { amount: 1, requestId: bad });
            assert(r.status === 400, `7. requestId ${JSON.stringify(bad).slice(0, 20)}: refused 400 (${show(r)})`);
        }
        assert(paymentsBy(sam) === count && balanceRow(sam) === before, `7. nothing paid (${paymentsBy(sam) - count})`);
        conserved('7');
    }

    // ── 8. A week-old id goes at the daily prune; a 6-day one stays ──
    {
        const mod = await import('./engine/money-requests.js').catch(() => null);
        const oldId = uuid(), youngId = uuid();
        await pay(sam, { amount: 1, requestId: oldId });
        await pay(sam, { amount: 1, requestId: youngId });
        try {
            db.prepare('UPDATE money_requests SET created_at = ? WHERE request_id = ?').run(ago(8 * DAY), oldId);
            db.prepare('UPDATE money_requests SET created_at = ? WHERE request_id = ?').run(ago(6 * DAY), youngId);
        } catch { /* no table (origin/main) */ }
        const pruned = mod ? (mod as any).pruneMoneyRequests() : -1;
        assert(pruned === 1 && recordOf(sam, oldId) === null && !!recordOf(sam, youngId), `8. the prune takes the 8-day id alone (${pruned})`);
        const young = await pay(sam, { amount: 1, requestId: youngId });
        assert(young.status === 200 && young.body?.transactionId === JSON.parse(recordOf(sam, youngId)?.answer ?? '{}').transactionId, `8. the 6-day id still answers its first answer (${show(young)})`);
        conserved('8');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
