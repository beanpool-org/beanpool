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
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { signedRequestBytes, signedRequestText, unboundRequestText, utf8Bytes } from '@beanpool/core';
import {
    beans, debtLine, debtsOfEntry, openDebtOf, openDebtForName, sameName, leftOf, parseBeans, debtCodeOk, DEBT_COPY, REPAYMENT_COPY, DEBT_UNREACHABLE,
    fetchNamesDebts, workOffDebt, settleDebt, fetchMyRepayment, payTheCommons, type NamesDebt,
} from '../names-debts';

const NODE = 'https://debts.example.test';
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
        const r = await payTheCommons(NODE, identity, 12.5, ` ${'D'.repeat(32)} `);
        expect(r).toEqual({ ok: true, value: { transactionId: 'tx-9', amount: 12.5 } });
        expect(sent[0].url).toBe(`${NODE}/api/commons/pay`);
        expect(JSON.parse(sent[0].body)).toEqual({ amount: 12.5, debtId: 'd'.repeat(32) });
        expect(signedByMember(sent[0])).toBe(true);
    });

    it('a payment for no debt sends no debtId; more than they hold is the node’s 409, in its words', async () => {
        answerWith(409, { error: 'You hold 5 Beans: you can pay the Commons only what you hold.' });
        const r = await payTheCommons(NODE, identity, 6);
        expect(JSON.parse(sent[0].body)).toEqual({ amount: 6 });
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
        expect(debtLine({ ...DEBT, status: 'settled', settled_how: 'pay_back', settled_by: 'a', settled_at: '2026-10-03T00:00:00Z' }, () => '@ada')).toMatch(/Settled on 3 Oct 2026: paid back, checked by @ada\.$/);
        expect(debtLine({ ...DEBT, status: 'settled', settled_how: 'work_off', settled_at: '2026-10-03T00:00:00Z' }, () => '@ada')).toMatch(/Settled on 3 Oct 2026: worked off\.$/);
        expect(debtLine({ ...DEBT, status: 'forgiven', settled_how: 'forgiven', settled_at: '2026-10-04T00:00:00Z', note: 'hardship' }, () => '')).toMatch(/Forgiven by the community on 4 Oct 2026\. Note: hardship$/);
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
        expect(card).toContain("router.push('/pay-commons')");
    });
    it('Pay the Commons checks the amount and code, asks first, then pays with the code as the debt id', () => {
        const pay = read('app', 'pay-commons.tsx');
        expect(pay).toMatch(/parseBeans\(amount\)[\s\S]{0,300}debtCodeOk\(debt\)[\s\S]{0,200}Alert\.alert\(REPAYMENT_COPY\.payTitle[\s\S]{0,500}payTheCommons\(node, identity, beans, debt \|\| undefined\)/);
        expect(pay).toContain('if (!r.ok) { setError(r.message); return; }');
    });
    it('the shared pay-back code opens Pay the Commons with it filled in', () => {
        expect(DEBT_COPY.shareCode(DEBT)).toContain(`beanpool://pay-commons?code=${DEBT.id}`);
        expect(REPAYMENT_COPY.paid(80, 'tx-7', true)).toBe('Paid 80 Beans to the Commons. Give this reference to an admin, who settles your debt with it: tx-7');
        expect(REPAYMENT_COPY.paid(80, 'tx-7', false)).toBe('Paid 80 Beans to the Commons.');
    });
});
