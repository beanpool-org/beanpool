/**
 * Debts and a second chance in the app (#1597 item 4; utils/names-debts.ts): each route the app calls, through the app's
 * real request helpers (node-post, crypto's buildSignedHeaders) with fetch stubbed. Each request's signature is checked
 * as the node's middleware checks it, over the exact body sent. Nothing contacts a node.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    const { randomUUID } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)), randomUUID };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { signedRequestBytes, signedRequestText, unboundRequestText, utf8Bytes } from '@beanpool/core';
import {
    beans, debtLine, debtsOfEntry, openDebtOf, openDebtForName, sameName, leftOf, parseBeans, debtCodeOk, DEBT_COPY, REPAYMENT_COPY, DEBT_UNREACHABLE,
    PAY_UNANSWERED, PAY_UNANSWERED_RETRY, PAY_REFUSED_UNSAID, SETTLE_UNANSWERED, coversLeft, oneAtATime, fetchNamesDebts, workOffDebt, settleDebt, fetchMyRepayment, payTheCommons,
    confirmCommonsPayment, unanswered, type NamesDebt,
} from '../names-debts';

const NODE = 'https://debts.example.test';
const noWait = { wait: async () => {} };
const seed = ed25519.utils.randomSecretKey();
const identity = {
    publicKey: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'),
    privateKey: Buffer.from(seed).toString('hex'),
    callsign: 'Ada',
} as any;

type Sent = { url: string; method: string; headers: Record<string, string>; body: string };
let sent: Sent[] = [];

function answerWith(status: number, body: unknown) {
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        sent.push({ url, method: init.method, headers: init.headers, body: init.body ?? '' });
        return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
    });
}

/** The node's check (apps/server/src/middleware): the signature over this method, path, time, nonce and body, by X-Public-Key. */
function signedByMember(s: Sent): boolean {
    const u = new URL(s.url);
    const f = { method: s.method, path: u.pathname, timestamp: s.headers['X-Timestamp'], nonce: s.headers['X-Nonce'], body: s.body };
    if (s.headers['X-Public-Key'] !== identity.publicKey) return false;
    const sig = Buffer.from(s.headers['X-Signature'], 'base64');
    const bound = s.headers['X-Signed-For'];
    const bytes = bound ? signedRequestBytes(signedRequestText({ ...f, host: bound })) : utf8Bytes(unboundRequestText(f));
    return ed25519.verify(sig, bytes, Buffer.from(identity.publicKey, 'hex'));
}

const DEBT: NamesDebt = {
    id: 'd'.repeat(32), entry_id: 'e1', amount: 300, reason: 'removed', removed_at: '2026-10-01T10:00:00.000Z', status: 'open',
    repaying_pubkey: null, repaid: 120.5, settled_how: null, settled_by: null, settled_at: null, settle_ref: null, note: null,
};

beforeEach(() => { sent = []; });

describe('an admin’s routes', () => {
    it('GET /api/names/debts: signed by the admin’s key, every record back', async () => {
        answerWith(200, { debts: [DEBT] });
        const r = await fetchNamesDebts(NODE, identity);
        expect(r).toEqual({ ok: true, value: [DEBT] });
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe(`${NODE}/api/names/debts`);
        expect(sent[0].method).toBe('GET');
        expect(signedByMember(sent[0])).toBe(true);
    });

    it('POST …/work-off: the member’s key in a signed body; the node’s status back', async () => {
        answerWith(201, { id: 'c1', status: 'awaiting_second' });
        const r = await workOffDebt(NODE, identity, DEBT.id, 'f'.repeat(64));
        expect(r).toEqual({ ok: true, value: { id: 'c1', status: 'awaiting_second' } });
        expect(sent[0].url).toBe(`${NODE}/api/names/debts/${DEBT.id}/work-off`);
        expect(JSON.parse(sent[0].body)).toEqual({ memberPubkey: 'f'.repeat(64) });
        expect(signedByMember(sent[0])).toBe(true);
        // The check is real: another body, or another key's name on it, fails it.
        expect(signedByMember({ ...sent[0], body: JSON.stringify({ memberPubkey: 'e'.repeat(64) }) })).toBe(false);
    });

    it('POST …/settle: the payment’s reference (trimmed) and a note; a refusal comes back in the node’s plain words', async () => {
        answerWith(409, { error: 'That payment wasn’t made for this debt. The member pays it from the debt, so it settles that debt alone.' });
        const r = await settleDebt(NODE, identity, DEBT.id, '  tx-1 ', ' paid in person ');
        expect(r).toEqual({ ok: false, status: 409, message: 'That payment wasn’t made for this debt. The member pays it from the debt, so it settles that debt alone.' });
        expect(sent[0].url).toBe(`${NODE}/api/names/debts/${DEBT.id}/settle`);
        expect(JSON.parse(sent[0].body)).toEqual({ transactionId: 'tx-1', note: 'paid in person' });
        expect(signedByMember(sent[0])).toBe(true);
    });

    it('no note: none is sent; no answer: nothing changed, said so', async () => {
        answerWith(200, { ...DEBT, status: 'settled' });
        await settleDebt(NODE, identity, DEBT.id, 'tx-2');
        expect(JSON.parse(sent[0].body)).toEqual({ transactionId: 'tx-2' });
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        expect(await fetchNamesDebts(NODE, identity)).toEqual({ ok: false, status: 0, message: DEBT_UNREACHABLE });
    });

    it('a payment whose answer was lost never says nothing was changed: it may have gone through, check the Ledger', async () => {
        expect(PAY_UNANSWERED).not.toContain('Nothing was changed');
        expect(PAY_UNANSWERED).toContain('may have gone through. Check your Ledger before you pay again.');
        (globalThis as any).fetch = vi.fn(async () => { throw new TypeError('Network request failed'); });
        expect(await payTheCommons(NODE, identity, confirmCommonsPayment(3), noWait)).toEqual({ ok: false, status: 0, message: PAY_UNANSWERED });
        // A 2xx without JSON, and a proxy's 502 page: the node may have paid.
        (globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON'); } }));
        const noJson = await payTheCommons(NODE, identity, confirmCommonsPayment(3, DEBT.id), noWait);
        expect(noJson).toEqual({ ok: false, status: 0, message: PAY_UNANSWERED });
        expect(unanswered(noJson)).toBe(true);
        (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('<html>'); } }));
        expect(await payTheCommons(NODE, identity, confirmCommonsPayment(3), noWait)).toEqual({ ok: false, status: 502, message: PAY_UNANSWERED });
        // A 5xx with the node's words in it: it may have paid before it failed, so not its words (as the web).
        answerWith(500, { error: 'Something went wrong on the server. Please try again.' });
        const fault = await payTheCommons(NODE, identity, confirmCommonsPayment(3), noWait);
        expect(fault).toEqual({ ok: false, status: 500, message: PAY_UNANSWERED });
        expect(unanswered(fault)).toBe(true);
        // The node's own refusal: known not paid, in its words.
        answerWith(409, { error: 'You hold 2 Beans: you can pay the Commons only what you hold.' });
        const refused = await payTheCommons(NODE, identity, confirmCommonsPayment(3), noWait);
        expect(refused).toEqual({ ok: false, status: 409, message: 'You hold 2 Beans: you can pay the Commons only what you hold.' });
        expect(unanswered(refused)).toBe(false);
        // A read without an answer still says nothing changed.
        (globalThis as any).fetch = vi.fn(async () => { throw new TypeError('Network request failed'); });
        expect(await fetchMyRepayment(NODE, identity)).toEqual({ ok: false, status: 0, message: DEBT_UNREACHABLE });
    });

    it('a 2xx without JSON is no answer: sent again with the same id, then kept for Try again; the node\'s answer after it is paid once', async () => {
        const p = confirmCommonsPayment(40, DEBT.id);
        const page = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
        let n = 0;
        (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
            sent.push({ url, method: init.method, headers: init.headers, body: init.body ?? '' });
            return (n++ === 0 ? page : { ok: true, status: 200, json: async () => ({ transactionId: 'tx-7', amount: 40, left: 40 }) }) as Response;
        });
        expect(await payTheCommons(NODE, identity, p, noWait)).toEqual({ ok: true, value: { transactionId: 'tx-7', amount: 40, left: 40 } });
        expect(sent.map((s) => JSON.parse(s.body))).toEqual([p.body, p.body]);
        // On every send: the cap (3 sends, one id), then PAY_UNANSWERED, held for Try again; Try again sends the same id.
        sent = [];
        (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
            sent.push({ url, method: init.method, headers: init.headers, body: init.body ?? '' });
            return page as unknown as Response;
        });
        const lost = await payTheCommons(NODE, identity, p, noWait);
        expect(lost).toEqual({ ok: false, status: 0, message: PAY_UNANSWERED });
        expect(unanswered(lost)).toBe(true);
        expect(sent.length).toBe(3);
        expect(new Set(sent.map((s) => JSON.parse(s.body).requestId))).toEqual(new Set([p.requestId]));
        // A JSON null is no answer either.
        answerWith(200, null);
        expect(await payTheCommons(NODE, identity, p, noWait)).toEqual({ ok: false, status: 0, message: PAY_UNANSWERED });
    });

    it('a proxy\'s 429 page (no JSON) refused the payment without saying why: nothing was paid, sent once, not held', async () => {
        expect(PAY_REFUSED_UNSAID).toBe('Your community’s server turned this payment away without saying why, so nothing was paid. Try again in a minute.');
        (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
            sent.push({ url, method: init.method, headers: init.headers, body: init.body ?? '' });
            return { ok: false, status: 429, json: async () => { throw new SyntaxError('<html>'); } } as unknown as Response;
        });
        const turned = await payTheCommons(NODE, identity, confirmCommonsPayment(3, DEBT.id), noWait);
        expect(turned).toEqual({ ok: false, status: 429, message: PAY_REFUSED_UNSAID });
        expect(unanswered(turned)).toBe(false);
        expect(sent.length).toBe(1);
        // The node's own 429, in its words, is shown as it is; a settle's wordless 4xx keeps its own words.
        answerWith(429, { error: 'Too many payments at once. Wait a minute.' });
        expect(await payTheCommons(NODE, identity, confirmCommonsPayment(3), noWait)).toEqual({ ok: false, status: 429, message: 'Too many payments at once. Wait a minute.' });
        answerWith(429, null);
        expect(await settleDebt(NODE, identity, DEBT.id, 'tx')).toEqual({ ok: false, status: 429, message: SETTLE_UNANSWERED });
    });

    it('a settle whose answer was lost may have settled it: open the entry again, never "Nothing was changed"', async () => {
        expect(SETTLE_UNANSWERED).not.toContain('Nothing was changed');
        expect(SETTLE_UNANSWERED).toContain('this debt may have been settled. Open the entry again');
        (globalThis as any).fetch = vi.fn(async () => { throw new TypeError('Network request failed'); });
        expect(await settleDebt(NODE, identity, DEBT.id, 'tx')).toEqual({ ok: false, status: 0, message: SETTLE_UNANSWERED });
        answerWith(504, null);
        expect(await settleDebt(NODE, identity, DEBT.id, 'tx')).toEqual({ ok: false, status: 504, message: SETTLE_UNANSWERED });
        answerWith(409, { error: 'That debt is settled already.' });
        expect(await settleDebt(NODE, identity, DEBT.id, 'tx')).toEqual({ ok: false, status: 409, message: 'That debt is settled already.' });
    });

    it('one id per confirmed payment: every send of it carries the same id, a proxy\'s 502/503/504/524 is sent again', async () => {
        const p = confirmCommonsPayment(40, DEBT.id);
        for (const status of [502, 503, 504, 524]) {
            sent = [];
            let n = 0;
            (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
                sent.push({ url, method: init.method, headers: init.headers, body: init.body ?? '' });
                return (n++ === 0 ? { ok: false, status, json: async () => { throw new SyntaxError('<html>'); } } : { ok: true, status: 200, json: async () => ({ transactionId: 'tx-5', amount: 40, left: 40 }) }) as Response;
            });
            expect(await payTheCommons(NODE, identity, p, noWait)).toEqual({ ok: true, value: { transactionId: 'tx-5', amount: 40, left: 40 } });
            expect(sent.map((s) => JSON.parse(s.body))).toEqual([p.body, p.body]);
            expect(JSON.parse(sent[0].body)).toEqual({ amount: 40, debtId: DEBT.id, requestId: p.requestId });
            expect(sent.every(signedByMember)).toBe(true);
        }
        // Retried by hand with the same payment: the same id again. A new confirm is a new id.
        answerWith(200, { transactionId: 'tx-5', amount: 40, left: 40 });
        await payTheCommons(NODE, identity, p, noWait);
        expect(JSON.parse(sent[0].body).requestId).toBe(p.requestId);
        expect(confirmCommonsPayment(40, DEBT.id).requestId).not.toBe(p.requestId);
        expect(PAY_UNANSWERED_RETRY).toContain('Tap Try again: the same payment is never paid twice.');
    });
});

describe('a member’s routes', () => {
    it('GET /api/commons/repayment: their own, signed; null when they owe nothing', async () => {
        answerWith(200, { repayment: { amount: 300, repaid: 120, left: 180 } });
        expect(await fetchMyRepayment(NODE, identity)).toEqual({ ok: true, value: { amount: 300, repaid: 120, left: 180 } });
        expect(sent[0].url).toBe(`${NODE}/api/commons/repayment`);
        expect(signedByMember(sent[0])).toBe(true);
        answerWith(200, { repayment: null });
        expect(await fetchMyRepayment(NODE, identity)).toEqual({ ok: true, value: null });
    });

    it('POST /api/commons/pay: the amount and the debt id (lower case, trimmed); the reference back', async () => {
        answerWith(200, { transactionId: 'tx-9', amount: 12.5 });
        const p = confirmCommonsPayment(12.5, ` ${'D'.repeat(32)} `);
        const r = await payTheCommons(NODE, identity, p, noWait);
        expect(r).toEqual({ ok: true, value: { transactionId: 'tx-9', amount: 12.5 } });
        expect(sent[0].url).toBe(`${NODE}/api/commons/pay`);
        expect(JSON.parse(sent[0].body)).toEqual({ amount: 12.5, debtId: 'd'.repeat(32), requestId: p.requestId });
        expect(signedByMember(sent[0])).toBe(true);
    });

    it('a payment for no debt sends no debtId; more than they hold is the node’s 409, in its words', async () => {
        answerWith(409, { error: 'You hold 5 Beans: you can pay the Commons only what you hold.' });
        const p = confirmCommonsPayment(6);
        const r = await payTheCommons(NODE, identity, p, noWait);
        expect(JSON.parse(sent[0].body)).toEqual({ amount: 6, requestId: p.requestId });
        expect(r).toEqual({ ok: false, status: 409, message: 'You hold 5 Beans: you can pay the Commons only what you hold.' });
    });
});

describe('words and checks', () => {
    it('Beans to the cent, never Ʀ', () => {
        expect(beans(300)).toBe('300 Beans');
        expect(beans(179.5)).toBe('179.50 Beans');
        expect(beans(0.1 + 0.2)).toBe('0.30 Beans');
        expect(leftOf(DEBT)).toBe(179.5);
        for (const s of [debtLine(DEBT, () => '@x'), DEBT_COPY.workOff('@b', 'Bea', DEBT), DEBT_COPY.forgive(DEBT), REPAYMENT_COPY.banner({ amount: 300, repaid: 120, left: 180 })]) {
            expect(s).not.toContain('Ʀ');
            expect(s).toMatch(/Beans/);
        }
    });

    it('an entry’s history: open with what is repaid and who works it off; settled; forgiven', () => {
        expect(debtLine({ ...DEBT, repaying_pubkey: 'p' }, () => '@bea')).toMatch(/^Removed on 1 Oct 2026 owing the Commons 300 Beans\. Open: 120\.50 Beans repaid, 179\.50 Beans left\. @bea is working it off\.$/);
        expect(debtLine({ ...DEBT, repaid: 0, reason: 'account_deleted' }, () => '')).toMatch(/^Deleted their account on .* Open\.$/);
        expect(debtLine({ ...DEBT, status: 'settled', settled_how: 'pay_back', settled_by: 'a', settled_at: '2026-10-03T00:00:00Z' }, () => '@ada')).toMatch(/Settled on 3 Oct 2026: paid back, with a payment counted by @ada\.$/);
        expect(debtLine({ ...DEBT, status: 'settled', settled_how: 'pay_back', settled_by: 'node', settled_at: '2026-10-03T00:00:00Z' }, () => '@node')).toMatch(/Settled on 3 Oct 2026: paid back\.$/);
        expect(debtLine({ ...DEBT, status: 'settled', settled_how: 'work_off', settled_at: '2026-10-03T00:00:00Z' }, () => '@ada')).toMatch(/Settled on 3 Oct 2026: worked off\.$/);
        expect(debtLine({ ...DEBT, repaid: 0, status: 'forgiven', settled_how: 'forgiven', settled_at: '2026-10-04T00:00:00Z', note: 'hardship' }, () => '')).toMatch(/Forgiven by the community on 4 Oct 2026\. Note: hardship$/);
        expect(debtLine({ ...DEBT, status: 'forgiven', settled_how: 'forgiven', settled_at: '2026-10-04T00:00:00Z' }, () => ''))
            .toMatch(/Forgiven by the community on 4 Oct 2026: 120\.50 Beans had been repaid, and the 179\.50 Beans left was forgiven\.$/);
        const other = { ...DEBT, id: 'o', entry_id: 'e2' };
        const settled = { ...DEBT, id: 's', status: 'settled' as const };
        expect(debtsOfEntry([DEBT, other, settled], 'e1').map((d) => d.id)).toEqual([DEBT.id, 's']);
        expect(openDebtOf([settled, other], 'e1')).toBeUndefined();
        expect(openDebtOf([settled, DEBT], 'e1')?.id).toBe(DEBT.id);
    });

    it('the matching-name warning: the same name, typed another way, on an entry with an open debt', () => {
        const entries = [{ id: 'e1', text: { name: 'Zoë  Smith' } }, { id: 'e2', text: { name: 'Zoe Jones' } }, { id: 'e3', text: null }];
        expect(sameName('zoe smith', 'Zoë  Smith ')).toBe(true);
        expect(sameName('', '')).toBe(false);
        expect(openDebtForName('ZOE SMITH', entries, [DEBT])).toEqual({ name: 'Zoë  Smith', debt: DEBT });
        // Its own entry, being changed, isn't a match; a settled debt isn't; another name isn't.
        expect(openDebtForName('Zoe Smith', entries, [DEBT], 'e1')).toBeNull();
        expect(openDebtForName('Zoe Smith', entries, [{ ...DEBT, status: 'settled' }])).toBeNull();
        expect(openDebtForName('Zoe Jones', entries, [DEBT])).toBeNull();
    });

    it('typed amounts to the cent and pay-back codes', () => {
        expect(parseBeans('12.5')).toBe(12.5);
        expect(parseBeans('12,50')).toBe(12.5);
        expect(parseBeans('0')).toBeNull();
        expect(parseBeans('1.234')).toBeNull();
        expect(parseBeans('-3')).toBeNull();
        expect(parseBeans('abc')).toBeNull();
        expect(debtCodeOk(` ${'A'.repeat(32)} `)).toBe(true);
        expect(debtCodeOk('a'.repeat(31))).toBe(false);
    });
});

describe('the names list screen (app/names-list.tsx): every debt control asks first, then calls its route', () => {
    const fsMod = require('node:fs') as typeof import('node:fs');
    const pathMod = require('node:path') as typeof import('node:path');
    const screen = fsMod.readFileSync(pathMod.join(__dirname, '..', '..', 'app', 'names-list.tsx'), 'utf8');
    it('work off, settle and forgive each sit inside an ask(…) with its own words', () => {
        expect(screen).toMatch(/ask\(DEBT_COPY\.workOffTitle[\s\S]{0,300}workOffDebt\(anchor, identity, debt\.id, member\.publicKey\)/);
        expect(screen).toMatch(/ask\(DEBT_COPY\.settleTitle[\s\S]{0,300}settleDebt\(anchor, identity, debt\.id, payRef, settleNote\)/);
        expect(screen).toMatch(/ask\(DEBT_COPY\.forgiveTitle[\s\S]{0,300}effect: 'forgive_debt', subject: debt\.id/);
    });
    it('a refusal is shown in the node’s words; an entry with an open debt offers settling, not inviting or confirming', () => {
        expect(screen.match(/if \(!done\.ok\) \{ setError\(done\.message\); return; \}/g)?.length).toBeGreaterThanOrEqual(3);
        expect(screen).toContain("!e.confirmation && e.text && !open ? btn('Invite this person'");
        expect(screen).toContain("!e.confirmation && e.text && !open ? btn('Confirm a member'");
        expect(screen).toContain("btn('Work it off'");
    });
    it('Save says first when the name matches an entry with an open debt', () => {
        expect(screen).toMatch(/const saveChecked = \(\) => \{[\s\S]{0,200}openDebtForName\(name, entries, debts, mode\.entry\?\.id\)/);
        expect(screen).toContain("btn('Save', saveChecked, 'primary')");
    });
});

describe('the member’s side: the Ledger’s repayment card and Pay the Commons', () => {
    const fsMod = require('node:fs') as typeof import('node:fs');
    const pathMod = require('node:path') as typeof import('node:path');
    const read = (...p: string[]) => fsMod.readFileSync(pathMod.join(__dirname, '..', '..', ...p), 'utf8');
    it('the Ledger shows the card; the card reads the member’s own repayment and links to Pay the Commons', () => {
        expect(read('app', '(tabs)', 'ledger.tsx')).toContain('<RepaymentCard />');
        const card = read('components', 'RepaymentCard.tsx');
        expect(card).toContain('fetchMyRepayment(node, identity)');
        expect(card).toContain("router.push(repayment?.debtId ? { pathname: '/pay-commons', params: { code: repayment.debtId } } : '/pay-commons')");
    });
    it('Pay the Commons checks the amount and code, asks first, then pays with the code as the debt id', () => {
        const pay = read('app', 'pay-commons.tsx');
        expect(pay).toMatch(/parseBeans\(amount\)[\s\S]{0,300}debtCodeOk\(debt\)[\s\S]{0,200}Alert\.alert\(REPAYMENT_COPY\.payTitle[\s\S]{0,300}send\(confirmCommonsPayment\(beans, debt \|\| undefined\)\)/);
        expect(pay).toContain('const r = await payTheCommons(node, identity, payment);');
        expect(pay).toContain('if (!r.ok) { setError(r.message); return; }');
    });
    it('a lost answer keeps the confirmed payment: Try again sends it with the same id, no new confirm; changing it drops it', () => {
        const pay = read('app', 'pay-commons.tsx');
        expect(pay).toContain('if (!r.ok && unanswered(r)) { setHeld(payment); setError(PAY_UNANSWERED_RETRY); return; }');
        expect(pay).toMatch(/const pay = \(\) => \{\s*if \(held\) \{ send\(held\); return; \}/);
        expect(pay).toContain('const edit = (set: (v: string) => void) => (v: string) => { set(v); setHeld(null); };');
        expect(pay).toContain('onChangeText={edit(setAmount)}');
        expect(pay).toContain('onChangeText={edit((v) => { codeTyped.current = true; setCode(v); })}');
        expect(pay).toContain("{held ? 'Try again' : REPAYMENT_COPY.payTitle}");
    });
    it('one payment at a time: the confirmed tap goes through oneAtATime, with nothing awaited before it', () => {
        const pay = read('app', 'pay-commons.tsx');
        expect(pay).toContain('const once = useRef(oneAtATime(setBusy)).current;');
        expect(pay).toMatch(/const send = \(payment: ConfirmedPayment<CommonsPayment>\) => once\(async \(\) => \{\s*setError\(null\);\s*const node = await anchorUrl\(\);/);
        expect(pay).toContain("{ text: 'Pay', onPress: () => send(confirmCommonsPayment(beans, debt || undefined)) }");
        expect(pay).not.toMatch(/setBusy\(true\)/);
    });
    it('the link’s amount is what was left when the admin shared it: prefilled, said so, in the confirm for that code only; the paid words use the node’s', () => {
        const pay = read('app', 'pay-commons.tsx');
        expect(pay).toContain("const linkLeft = linkCode && typeof params.amount === 'string' ? parseBeans(params.amount) : null;");
        expect(pay).toContain("useState(linkLeft !== null ? String(linkLeft) : '')");
        expect(pay).toContain('const shared = debt && debt.toLowerCase() === linkCode ? linkLeft : null;');
        expect(pay).toContain('REPAYMENT_COPY.payConfirm(beans, !!debt, shared, !debt && !!myDebt)');
        expect(pay).toContain('{REPAYMENT_COPY.linkLeft(linkLeft)}');
        expect(pay).toContain('REPAYMENT_COPY.paid(r.value.amount, r.value.transactionId, forDebt, r.value, !forDebt && !!myDebt)');
        expect(REPAYMENT_COPY.linkLeft(300)).toBe('What was left when the admin shared this: 300 Beans.');
    });
    it('working a debt off, Pay the Commons opens with their own code, from the banner or any other way in; a payment without it is said not to come off the debt, before and after (confirmation 4)', () => {
        const pay = read('app', 'pay-commons.tsx');
        expect(pay).toContain('const r = await fetchMyRepayment(node, identity);');
        expect(pay).toContain('if (mine.debtId && !codeTyped.current) setCode((c) => (c.trim() ? c : mine.debtId!));');
        expect(pay).toContain('onChangeText={edit((v) => { codeTyped.current = true; setCode(v); })}');
        expect(read('components', 'RepaymentCard.tsx')).toContain("router.push(repayment?.debtId ? { pathname: '/pay-commons', params: { code: repayment.debtId } } : '/pay-commons')");
        expect(REPAYMENT_COPY.banner({ amount: 200, repaid: 0, left: 200, debtId: DEBT.id })).toContain('pay some or all of it yourself under Pay the Commons, where your pay-back code is filled in: it comes off at once.');
        expect(REPAYMENT_COPY.payIntro).toContain('enter the pay-back code an admin gave you (working one off, yours is filled in)');
        expect(REPAYMENT_COPY.payConfirm(200, false, null, true)).toBe('Pay 200 Beans to the Commons? This won’t come off your debt: it has no pay-back code. To pay your debt, pay with '
            + 'your code (Pay the Commons fills it in), or ask an admin to count this payment toward it afterwards. Until an admin counts it, your debt is still being worked off: the next time you receive Beans, what is left on it is taken from what you hold above 0. This can’t be undone.');
        expect(REPAYMENT_COPY.paid(200, 'tx-9', false, { transactionId: 'tx-9', amount: 200 }, true)).toBe('Paid 200 Beans to the Commons. This did not come off your debt: it was paid '
            + 'without your pay-back code. To have it count, ask an admin to count it toward your debt with this reference: tx-9. Until an admin counts it, your debt is still being worked off: the next time you receive Beans, what is left on it is taken from what you hold above 0.');
        // With the code, or owing nothing, no such words.
        expect(REPAYMENT_COPY.payConfirm(200, true, null, false)).not.toContain('won’t come off');
        expect(REPAYMENT_COPY.paid(200, 'tx-9', false)).toBe('Paid 200 Beans to the Commons.');
    });
    it('the shared pay-back code opens Pay the Commons with it filled in', () => {
        expect(DEBT_COPY.shareCode(DEBT)).toContain(`beanpool://pay-commons?code=${DEBT.id}&amount=179.5 `);
        expect(DEBT_COPY.shareCode(DEBT)).toContain('(179.50 Beans), pay it with this code: each payment comes off the debt as you pay it, and when nothing is left it is settled.');
        expect(REPAYMENT_COPY.paid(80, 'tx-7', false)).toBe('Paid 80 Beans to the Commons.');
    });
    it('a payment for a debt comes off it at once: the words say what is left, or that it is settled, as the node answers', () => {
        expect(coversLeft(300, 300)).toBe(true);
        expect(coversLeft(150, 300)).toBe(false);
        expect(coversLeft(500, null)).toBe(false);
        expect(REPAYMENT_COPY.paid(150, 'tx-1', true, { left: 300, leftAfter: 150, settled: false })).toBe('Paid 150 Beans to the Commons. That came off your debt: 150 Beans left.');
        expect(REPAYMENT_COPY.paid(150, 'tx-1', true, { left: 150, leftAfter: 0, settled: true })).toBe('Paid 150 Beans to the Commons. Your debt is paid off and settled.');
        // A node that doesn't say: nothing promised, the reference given.
        expect(REPAYMENT_COPY.paid(150, 'tx-1', true)).toBe('Paid 150 Beans to the Commons. Reference: tx-1');
        expect(REPAYMENT_COPY.payConfirm(300, true, 300)).toBe('Pay 300 Beans to the Commons for your debt? 300 Beans was what was left when the admin shared this. '
            + 'It comes off your debt at once. If less is left now, your server refuses it and says how much, and nothing is paid. This can’t be undone.');
        expect(REPAYMENT_COPY.payConfirm(150, true)).toBe('Pay 150 Beans to the Commons for your debt? It comes off your debt at once. If less is left now, '
            + 'your server refuses it and says how much, and nothing is paid. This can’t be undone.');
        expect(REPAYMENT_COPY.payConfirm(5, false)).toBe('Pay 5 Beans to the Commons? This can’t be undone.');
        for (const words of [REPAYMENT_COPY.payIntro, REPAYMENT_COPY.payConfirm(150, true, 300), REPAYMENT_COPY.paid(150, 'tx-1', true, { leftAfter: 150 }), DEBT_COPY.shareCode(DEBT)]) {
            expect(words).not.toMatch(/to an admin|one payment|doesn’t count/);
        }
        expect(REPAYMENT_COPY.payIntro).toContain('what you pay comes off the debt at once, and when nothing is left it is settled.');
        expect(DEBT_COPY.settle(DEBT)).toContain('Only for a payment to the Commons the member made without the pay-back code.');
    });
    it('oneAtATime sets busy before anything is awaited, and a second tap while one is on its way sends nothing', async () => {
        const busy: boolean[] = [];
        const once = oneAtATime((b) => busy.push(b));
        let release!: () => void;
        const run = vi.fn(() => new Promise<void>((r) => { release = r; }));
        const first = once(run);
        expect(busy).toEqual([true]);
        await once(run);
        expect(run).toHaveBeenCalledTimes(1);
        release();
        await first;
        expect(busy).toEqual([true, false]);
        // A failed payment frees the next one.
        await once(async () => { throw new Error('x'); }).catch(() => {});
        const next = vi.fn(async () => {});
        await once(next);
        expect(next).toHaveBeenCalledTimes(1);
    });
});
