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

import { getMyRepayment, payTheCommons, beans, parseBeans, debtCodeOk, REPAYMENT_WORDS } from './debts';

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
        fetchMock.mockResolvedValue(reply(200, { transactionId: 'tx-9', amount: 80 }));
        expect(await payTheCommons(80, ` ${'AB'.repeat(16)} `)).toEqual({ transactionId: 'tx-9', amount: 80 });
        const s = sent();
        expect(s.url).toMatch(/\/api\/commons\/pay$/);
        expect(JSON.parse(s.body)).toEqual({ amount: 80, debtId: 'ab'.repeat(16) });
        expect(signedByMember(s, '/api/commons/pay')).toBe(true);
        // The check is real: another body fails it.
        expect(signedByMember({ ...s, body: JSON.stringify({ amount: 8000 }) }, '/api/commons/pay')).toBe(false);
    });

    it('no code: no debtId; more than they hold: the node’s 409 in its own words', async () => {
        fetchMock.mockResolvedValue(reply(409, { error: 'You hold 5 Beans: you can pay the Commons only what you hold.' }));
        await expect(payTheCommons(6)).rejects.toThrow('You hold 5 Beans: you can pay the Commons only what you hold.');
        expect(JSON.parse(sent().body)).toEqual({ amount: 6 });
    });
});

describe('words', () => {
    it('Beans to the cent, never Ʀ; typed amounts and codes', () => {
        expect(beans(179.5)).toBe('179.50 Beans');
        expect(beans(300)).toBe('300 Beans');
        expect(REPAYMENT_WORDS.banner({ amount: 300, repaid: 120.5, left: 179.5 })).toMatch(/^You’re working off a debt to the Commons: 179\.50 Beans left of 300 Beans\./);
        expect(REPAYMENT_WORDS.paid(80, 'tx-7', true)).not.toContain('Ʀ');
        expect(parseBeans('12,5')).toBe(12.5);
        expect(parseBeans('1.001')).toBeNull();
        expect(parseBeans('0')).toBeNull();
        expect(debtCodeOk('f'.repeat(32))).toBe(true);
        expect(debtCodeOk('g'.repeat(32))).toBe(false);
    });
});
