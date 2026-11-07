/**
 * A busy network on the web (core busy-answer.ts): Cloudflare answers 429 in front of a node, with its own page (HTML, or
 * plain `error code: 1015`) and maybe a `Retry-After`. lib/api.ts says the phone's one sentence (code `busy`, never "Too Many
 * Requests"), asks a READ again once, and never sends a write again by itself (no double post, no double payment).
 *
 * The node's OWN 429s are JSON with a sentence and are not busy. Nothing here contacts a node: fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { pseudoLocalise, setLanguage, toEd25519Pkcs8 } from '@beanpool/core';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const IDENTITY = { publicKey: PUB, privateKey: bytesToHex(toEd25519Pkcs8(SEED)), callsign: 'Ana', createdAt: '2026-10-05T00:00:00.000Z' };

const identityMock = vi.hoisted(() => ({ loadIdentity: vi.fn() }));
vi.mock('./identity', () => identityMock);

import { checkMembership, request } from './api';

const BUSY = 'Busy right now. Try again in a moment.';
const CF_HTML = '<!DOCTYPE html><html lang="en-US"><head><title>Access denied | global.beanpool.org used Cloudflare to restrict access</title></head>'
    + '<body><span class="cf-error-code">1015</span><h1>You are being rate limited</h1></body></html>';
const DAY_BUDGET = { error: 'You have made 1,000 changes today. You can carry on in about 6 hours.', code: 'day_budget' };

const fetchMock = vi.fn();

/** Cloudflare's answer: not JSON (`json()` throws as a body of HTML does), and maybe a Retry-After. */
const cloudflare = (status = 429, retryAfter?: string) => ({
    ok: false, status, statusText: 'Too Many Requests',
    headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}),
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    text: async () => CF_HTML,
});
const nodeJson = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300, status, statusText: status === 429 ? 'Too Many Requests' : 'OK',
    headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body),
});

beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    identityMock.loadIdentity.mockReset();
    identityMock.loadIdentity.mockResolvedValue(IDENTITY);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setLanguage('en');
});

const thrown = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('did not throw'); };

describe('a read met by a busy network', () => {
    it('is asked again once after Retry-After, signed afresh (a new nonce), and the answer comes back', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(cloudflare(429, '2'));
        fetchMock.mockResolvedValueOnce(nodeJson(200, { isMember: true }));
        const p = request<{ isMember: boolean }>('GET', '/api/community/membership/abc');
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await p).toEqual({ isMember: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const nonce = (i: number) => fetchMock.mock.calls[i][1].headers['X-Nonce'];
        expect(nonce(0)).toBeTruthy();
        expect(nonce(1)).not.toBe(nonce(0));
    });

    it('then stops: a second busy answer is thrown as the sentence, never a third ask', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(async () => cloudflare(429, '1'));
        const p = thrown(request('GET', '/api/enterprises'));
        await vi.advanceTimersByTimeAsync(120_000);
        const e = await p;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(e.message).toBe(BUSY);
        expect(e.message).not.toMatch(/Too Many|<|cloudflare|1015/i);
        expect(e).toMatchObject({ status: 429, code: 'busy', nodeAnswered: false });
        // No JSON came: a payment's words read that (lib/debts.ts), as they read a proxy's page before.
        expect(e.unsaid).toBe(true);
    });

    it('waits 5 s when the answer named no wait', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(cloudflare(429)).mockResolvedValueOnce(nodeJson(200, {}));
        const p = request('GET', '/api/x');
        await vi.advanceTimersByTimeAsync(4999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('is not asked again for the node\'s own 429 (it would only fail again) or for a 502', async () => {
        fetchMock.mockResolvedValue(nodeJson(429, DAY_BUDGET, { 'Retry-After': '21600' }));
        const e = await thrown(request('GET', '/api/members/nearest'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(e.message).toBe(DAY_BUDGET.error);
        expect(e).toMatchObject({ status: 429, code: 'day_budget' });

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(cloudflare(502));
        const gateway = await thrown(request('GET', '/api/x'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(gateway.status).toBe(502);
        expect(gateway.code).toBeUndefined();
    });
});

describe('a write met by a busy network', () => {
    it('is the sentence, status 429 and code busy, and is never sent again by itself', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue(cloudflare(429, '1'));
        const p = thrown(request('POST', '/api/marketplace/posts', { title: 'x' }));
        await vi.advanceTimersByTimeAsync(120_000);
        const e = await p;
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(e).toMatchObject({ message: BUSY, status: 429, code: 'busy', nodeAnswered: false });
    });

    it('a PUT and a DELETE are writes too', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue(cloudflare(429, '1'));
        const a = thrown(request('PUT', '/api/x', { a: 1 }));
        const b = thrown(request('DELETE', '/api/x'));
        await vi.advanceTimersByTimeAsync(120_000);
        await Promise.all([a, b]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('the node\'s own 429 keeps its words and code', async () => {
        fetchMock.mockResolvedValue(nodeJson(429, { error: "You're sending messages too fast. Try again in 20s", code: 'chat_rate' }));
        const e = await thrown(request('POST', '/api/messages/send', { text: 'hi' }));
        expect(e).toMatchObject({ message: "You're sending messages too fast. Try again in 20s", status: 429, code: 'chat_rate' });
    });

    it('is said in the member\'s language through the words layer', async () => {
        setLanguage('xx');
        fetchMock.mockResolvedValue(cloudflare(429));
        const e = await thrown(request('POST', '/api/x', { a: 1 }));
        expect(e.message).toBe(pseudoLocalise(BUSY));
    });
});

describe('the sync chip\'s membership probe', () => {
    it('is a read: a busy answer is asked again once, then reaches the chip as a 429 with the sentence', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(async () => cloudflare(429, '1'));
        const p = thrown(checkMembership('abc'));
        await vi.advanceTimersByTimeAsync(10_000);
        const e = await p;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(e).toMatchObject({ status: 429, message: BUSY });
    });
});
