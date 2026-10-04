import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { signedRequestBytes, signedRequestText, toEd25519Pkcs8 } from '@beanpool/core';

/**
 * A member's side of Debts and a second chance on the web (#1597 item 4; lib/debts.ts): each route it calls, through
 * the app's real `request` with fetch stubbed, each request's signature checked as the node's middleware checks it
 * (format 2, bound to the page's host, over the exact body sent). Nothing contacts a node.
 */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const IDENTITY = { publicKey: PUB, privateKey: bytesToHex(toEd25519Pkcs8(SEED)), callsign: 'Ana', createdAt: '2026-10-05T00:00:00.000Z' };

const identityMock = vi.hoisted(() => ({ loadIdentity: vi.fn() }));
vi.mock('./identity', () => identityMock);

import { getMyRepayment, payTheCommons, confirmCommonsPayment, unansweredPayment, beans, parseBeans, debtCodeOk, payFailureWords, coversLeft, PAY_UNANSWERED, PAY_UNANSWERED_RETRY, PAY_REFUSED_UNSAID, REPAYMENT_WORDS } from './debts';

const noWait = { wait: async () => {} };

const fetchMock = vi.fn();
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() });
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const HERE = window.location.hostname.toLowerCase();

function sent() {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    return { url: url as string, method: init.method as string, headers: init.headers as Record<string, string>, body: (init.body as string | undefined) ?? '' };
}
function signedByMember(s: ReturnType<typeof sent>, path: string): boolean {
    const text = signedRequestText({ host: HERE, method: s.method, path, timestamp: s.headers['X-Timestamp'], nonce: s.headers['X-Nonce'], body: s.body });
    return s.headers['X-Public-Key'] === PUB && s.headers['X-Signed-For'] === HERE && ed25519.verify(b64(s.headers['X-Signature']), signedRequestBytes(text), hexToBytes(PUB));
}

beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    identityMock.loadIdentity.mockReset();
    identityMock.loadIdentity.mockResolvedValue(IDENTITY);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('GET /api/commons/repayment', () => {
    it('signed by the member; their own repayment back, or null', async () => {
        fetchMock.mockResolvedValue(reply(200, { repayment: { amount: 300, repaid: 120, left: 180 } }));
        expect(await getMyRepayment()).toEqual({ amount: 300, repaid: 120, left: 180 });
        const s = sent();
        expect(s.url).toMatch(/\/api\/commons\/repayment$/);
        expect(s.method).toBe('GET');
        expect(signedByMember(s, '/api/commons/repayment')).toBe(true);
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(reply(200, { repayment: null }));
        expect(await getMyRepayment()).toBeNull();
    });
});

describe('POST /api/commons/pay', () => {
    it('the amount and the pay-back code as debtId (lower case, trimmed), signed over that body; the reference back', async () => {
        fetchMock.mockResolvedValue(reply(200, { transactionId: 'tx-9', amount: 80, left: 80 }));
        const p = confirmCommonsPayment(80, ` ${'AB'.repeat(16)} `);
        expect(await payTheCommons(p, noWait)).toEqual({ transactionId: 'tx-9', amount: 80, left: 80 });
        const s = sent();
        expect(s.url).toMatch(/\/api\/commons\/pay$/);
        expect(JSON.parse(s.body)).toEqual({ amount: 80, debtId: 'ab'.repeat(16), requestId: p.requestId });
        expect(signedByMember(s, '/api/commons/pay')).toBe(true);
        // The check is real: another body fails it.
        expect(signedByMember({ ...s, body: JSON.stringify({ amount: 8000 }) }, '/api/commons/pay')).toBe(false);
    });

    it('no code: no debtId; more than they hold: the node’s 409 in its own words', async () => {
        fetchMock.mockResolvedValue(reply(409, { error: 'You hold 5 Beans: you can pay the Commons only what you hold.' }));
        const p = confirmCommonsPayment(6);
        await expect(payTheCommons(p, noWait)).rejects.toThrow('You hold 5 Beans: you can pay the Commons only what you hold.');
        expect(JSON.parse(sent().body)).toEqual({ amount: 6, requestId: p.requestId });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a lost answer never says nothing was paid: no answer, a 2xx without JSON, a server error may have paid; a refusal did not', async () => {
        expect(PAY_UNANSWERED).toBe('Your community’s server didn’t answer, so this payment may have gone through. Check your Ledger before you pay again.');
        const failure = async () => { try { await payTheCommons(confirmCommonsPayment(3), noWait); } catch (e) { return payFailureWords(e); } return 'paid'; };
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        expect(await failure()).toBe(PAY_UNANSWERED);
        fetchMock.mockResolvedValue({ ...reply(200, null), json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
        expect(await failure()).toBe(PAY_UNANSWERED);
        fetchMock.mockResolvedValue({ ...reply(502, null), statusText: 'Bad Gateway', json: async () => { throw new SyntaxError('<html>'); } });
        expect(await failure()).toBe(PAY_UNANSWERED);
        fetchMock.mockResolvedValue(reply(404, { error: 'There is no such debt record.' }));
        expect(await failure()).toBe('There is no such debt record.');
        fetchMock.mockResolvedValue(reply(500, { error: 'Something went wrong on the server. Please try again.' }));
        expect(await failure()).toBe(PAY_UNANSWERED);
        expect(payFailureWords(null)).toBe(PAY_UNANSWERED);
    });

    it('a proxy’s 4xx page (no JSON) is said in plain words, never its status text; nothing was paid, nothing held', async () => {
        fetchMock.mockResolvedValue({ ...reply(429, null), statusText: 'Too Many Requests', json: async () => { throw new SyntaxError('<html>'); } });
        let caught: unknown;
        await payTheCommons(confirmCommonsPayment(3), noWait).catch((e) => { caught = e; });
        expect(payFailureWords(caught)).toBe(PAY_REFUSED_UNSAID);
        expect(payFailureWords(caught)).not.toContain('Too Many Requests');
        expect(unansweredPayment(caught)).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('one id per confirmed payment: a proxy’s 502/503/504/524 or no answer is sent again with the same id; the last lost answer is kept for Try again', async () => {
        for (const status of [502, 503, 504, 524]) {
            fetchMock.mockReset();
            fetchMock.mockResolvedValueOnce({ ...reply(status, null), statusText: 'Gateway', json: async () => { throw new SyntaxError('<html>'); } });
            fetchMock.mockResolvedValueOnce(reply(200, { transactionId: 'tx-4', amount: 40, left: 40 }));
            const p = confirmCommonsPayment(40, 'ab'.repeat(16));
            expect(await payTheCommons(p, noWait)).toEqual({ transactionId: 'tx-4', amount: 40, left: 40 });
            const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
            expect(bodies).toEqual([p.body, p.body]);
            expect(bodies[0].requestId).toBe(p.requestId);
        }
        fetchMock.mockReset();
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        const p = confirmCommonsPayment(5);
        let caught: unknown;
        await payTheCommons(p, noWait).catch((e) => { caught = e; });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).requestId)).toEqual(Array(3).fill(p.requestId));
        expect(unansweredPayment(caught)).toBe(true);
        expect(PAY_UNANSWERED_RETRY).toContain('Press Try again: the same payment is never paid twice.');
        expect(confirmCommonsPayment(5).requestId).not.toBe(p.requestId);
    });
});

describe('words', () => {
    it('Beans to the cent, never Ʀ; typed amounts and codes', () => {
        expect(beans(179.5)).toBe('179.50 Beans');
        expect(beans(300)).toBe('300 Beans');
        expect(REPAYMENT_WORDS.banner({ amount: 300, repaid: 120.5, left: 179.5 })).toMatch(/^You’re working off a debt to the Commons: 179\.50 Beans left of 300 Beans\./);
        expect(REPAYMENT_WORDS.paid(80, 'tx-7', true)).not.toContain('Ʀ');
        expect(REPAYMENT_WORDS.paid(150, 'tx-7', true, 300)).not.toContain('Ʀ');
        expect(parseBeans('12,5')).toBe(12.5);
        expect(parseBeans('1.001')).toBeNull();
        expect(parseBeans('0')).toBeNull();
        expect(debtCodeOk('f'.repeat(32))).toBe(true);
        expect(debtCodeOk('g'.repeat(32))).toBe(false);
    });
});

describe('one payment of at least what is left settles a debt (the node’s settleByPayment): a settle is promised only then', () => {
    it('150 of 300 says it won’t settle; 300 of 300 promises it; not knowing what is left, nothing is promised', () => {
        expect(coversLeft(150, 300)).toBe(false);
        expect(coversLeft(300, 300)).toBe(true);
        expect(coversLeft(300, null)).toBe(false);
        expect(REPAYMENT_WORDS.paid(150, 'tx-1', true, 300)).toBe('Paid 150 Beans to the Commons. That is less than the 300 Beans left, so it won’t settle your debt: '
            + 'an admin can settle a debt only with one payment of at least what is left. Tell an admin, and give them this reference: tx-1');
        expect(REPAYMENT_WORDS.payConfirm(150, true, 300)).toContain('300 Beans was what was left when the admin shared this. This payment is less, so it won’t settle your debt');
        // The link's amount is never "what is left": a work-off may have lowered it, and the node refuses above what is left.
        for (const amount of [300, 150]) expect(REPAYMENT_WORDS.payConfirm(amount, true, 300)).not.toMatch(/covers|who settles|can settle your debt with it/);
        expect(REPAYMENT_WORDS.payConfirm(300, true, 300)).toContain('If some was worked off since, your server refuses a payment above what is left and says how much, and nothing is paid.');
        expect(REPAYMENT_WORDS.linkLeft(300)).toBe('What was left when the admin shared this: 300 Beans.');
        expect(REPAYMENT_WORDS.paid(300, 'tx-1', true, 300)).toBe('Paid 300 Beans to the Commons. Give this reference to an admin, who settles your debt with it: tx-1');
        expect(REPAYMENT_WORDS.paid(150, 'tx-1', true)).not.toContain('who settles your debt with it');
        expect(REPAYMENT_WORDS.payConfirm(150, true)).toContain('only if this one payment is at least what is left');
        expect(REPAYMENT_WORDS.payIntro).toContain('one payment of at least what is left');
    });
});
