/**
 * A busy network on the phone (core busy-answer.ts): Cloudflare answers 429 in front of a node, with its own page (HTML, or
 * plain `error code: 1015`) and maybe a `Retry-After`. The phone says one sentence, never the page, never "node offline",
 * never signs the member out, and asks a READ again once (never a write: no double post, no double payment).
 *
 * The node's OWN 429s are JSON with a sentence ("You have made 1,000 changes today. You can carry on in about 6 hours.") and
 * are not busy: "try again in a moment" would be false.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// db.ts pulls in device modules at import time; stubbed at the boundary as language-to-node.test.ts does.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, url: string) => ({ 'X-Signed': `${method} ${url}` })),
}));

import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { fetchGroupSuccession, fetchMyEvents, redeemInvite, setEventDateCancelled, setEventReminder, signedGet, signedRequest } from '../db';
import { buildSignedHeaders } from '../crypto';
import { chatActionErrorMessage } from '../chat-actions';

const BUSY = 'Busy right now. Try again in a moment.';
const CF_HTML = '<!DOCTYPE html><html lang="en-US"><head><title>Access denied | global.beanpool.org used Cloudflare to restrict access</title></head>'
    + '<body><span class="cf-error-code">1015</span><h1>You are being rate limited</h1></body></html>';
const DAY_BUDGET = { error: 'You have made 1,000 changes today. You can carry on in about 6 hours.', code: 'day_budget' };

const fetchMock = vi.fn();

/** Cloudflare's answer: not JSON (`json()` throws as a body of HTML does), its page as text, and maybe a Retry-After. */
const cloudflare = (status: number, body: string = CF_HTML, retryAfter?: string) => {
    const make = (): any => ({
        ok: false, status, statusText: 'Too Many Requests',
        headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}),
        json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
        text: async () => body,
        clone: () => make(),
    });
    return make();
};
/** The same on a real fetch, where the body is spent once `json()` has tried it: `text()` then throws. */
const cloudflareSpent = (status: number, retryAfter?: string): any => ({
    ok: false, status, statusText: 'Too Many Requests',
    headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}),
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    text: async () => { throw new TypeError('Already read'); },
});
const nodeJson = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const make = (): any => ({
        ok: status >= 200 && status < 300, status, statusText: '', headers: new Headers(headers),
        json: async () => body, text: async () => JSON.stringify(body), clone: () => make(),
    });
    return make();
};

beforeEach(() => {
    fetchMock.mockReset();
    (buildSignedHeaders as any).mockClear();
    (globalThis as any).fetch = fetchMock;
});
afterEach(() => {
    vi.useRealTimers();
    setLanguage('en');
});

const thrown = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('did not throw'); };

describe('a write (signedRequest) met by a busy network', () => {
    it('says the one sentence, never the page: status 429, code busy, nodeAnswered false', async () => {
        fetchMock.mockResolvedValue(cloudflare(429, CF_HTML));
        const e = await thrown(signedRequest('/api/messages/send', { text: 'hi' }));
        expect(e.message).toBe(BUSY);
        expect(e.message).not.toMatch(/<|cloudflare|1015|rate limited|Too Many/i);
        expect(e).toMatchObject({ status: 429, code: 'busy', nodeAnswered: false });
    });

    it('is the same on a real fetch, where the body is spent once json() tried it', async () => {
        fetchMock.mockResolvedValue(cloudflareSpent(429, '3'));
        const e = await thrown(signedRequest('/api/messages/send', { text: 'hi' }));
        expect(e).toMatchObject({ message: BUSY, status: 429, code: 'busy', nodeAnswered: false });
    });

    it('is plain text `error code: 1015` too, and the chat\'s error line is the sentence (chat-actions), not the page', async () => {
        fetchMock.mockResolvedValue(cloudflare(429, 'error code: 1015'));
        const e = await thrown(signedRequest('/api/messages/send', { text: 'hi' }));
        expect(e.message).toBe(BUSY);
        expect(chatActionErrorMessage(e)).toBe(BUSY);
    });

    it('is said in the member\'s language through the words layer', async () => {
        setLanguage('xx');
        fetchMock.mockResolvedValue(cloudflare(429));
        const e = await thrown(signedRequest('/api/messages/send', { text: 'hi' }));
        expect(e.message).toBe(pseudoLocalise(BUSY));
        expect(e.message).not.toBe(BUSY);
    });

    it('is never sent again by itself, whatever Retry-After says (no double post, no double payment)', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue(cloudflare(429, CF_HTML, '1'));
        const e = await thrown(signedRequest('/api/ledger/transfer', { to: 'x', amount: 5 }));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(e.code).toBe('busy');
    });

    it('the node\'s own 429 (a day budget) is NOT busy: its sentence and code come through as they did', async () => {
        fetchMock.mockResolvedValue(nodeJson(429, DAY_BUDGET, { 'Retry-After': '21600' }));
        const e = await thrown(signedRequest('/api/marketplace/posts', { title: 'x' }));
        expect(e.message).toBe(DAY_BUDGET.error);
        expect(e).toMatchObject({ status: 429, code: 'day_budget', nodeAnswered: true });
    });

    it('a Cloudflare page on another status is never shown raw: the generic words stand', async () => {
        fetchMock.mockResolvedValue(cloudflare(502, CF_HTML.replace('1015', '502').replace('You are being rate limited', 'Bad gateway')));
        const e = await thrown(signedRequest('/api/messages/send', { text: 'hi' }));
        expect(e.message).toBe('Server returned 502');
        expect(e.code).toBeUndefined();
        expect(e.nodeAnswered).toBe(false);
        expect(chatActionErrorMessage(e)).toBe('Server returned 502');
    });
});

describe('a read (signedGet) met by a busy network', () => {
    it('asks again once after Retry-After, signed afresh, and hands back the answer', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(cloudflare(429, CF_HTML, '2'));
        fetchMock.mockResolvedValueOnce(nodeJson(200, { ok: true }));
        const p = signedGet('/api/enterprises');
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        const res = await p;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(res.ok).toBe(true);
        // A new signature for the new ask (each carries its own nonce).
        expect(buildSignedHeaders).toHaveBeenCalledTimes(2);
    });

    it('then stops: a second busy answer is handed back as it is, never a third ask', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(async () => cloudflare(429, CF_HTML, '1'));
        const p = signedGet('/api/enterprises');
        await vi.advanceTimersByTimeAsync(60_000);
        const res = await p;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(res.status).toBe(429);
        expect(res.ok).toBe(false);
    });

    it('waits 5 s when the answer named no wait, and never more than 30 s', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(cloudflare(429)).mockResolvedValueOnce(nodeJson(200, {}));
        const first = signedGet('/api/a');
        await vi.advanceTimersByTimeAsync(4999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await first;
        expect(fetchMock).toHaveBeenCalledTimes(2);

        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(cloudflare(429, CF_HTML, '3600')).mockResolvedValueOnce(nodeJson(200, {}));
        const second = signedGet('/api/b');
        await vi.advanceTimersByTimeAsync(29_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await second;
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not ask again for the node\'s own 429 (a day budget would only fail again, 30 s later) or for a 500', async () => {
        fetchMock.mockResolvedValue(nodeJson(429, DAY_BUDGET, { 'Retry-After': '21600' }));
        const res = await signedGet('/api/members/nearest');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual(DAY_BUDGET);

        fetchMock.mockReset();
        fetchMock.mockResolvedValue(cloudflare(500, '<html>oops</html>'));
        expect((await signedGet('/api/x')).status).toBe(500);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('gives up waiting when the caller aborts, and the retry\'s fetch is the abort', async () => {
        vi.useFakeTimers();
        const stop = new AbortController();
        fetchMock.mockResolvedValueOnce(cloudflare(429, CF_HTML, '30'));
        fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
            if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
            return nodeJson(200, {});
        });
        const p = thrown(signedGet('/api/x', { signal: stop.signal }));
        await vi.advanceTimersByTimeAsync(10);
        stop.abort();
        const e = await p;
        expect(e.name).toBe('AbortError');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('an invite redeemed against a busy network', () => {
    const ME = { publicKey: 'me-pub', privateKey: 'me-priv', callsign: 'Me' };

    it('a 429 is the busy sentence, not "Relay Node Offline" (Cloudflare\'s page has "cloudflare" and "<html" in it)', async () => {
        fetchMock.mockResolvedValue(cloudflare(429, CF_HTML, '4'));
        const e = await thrown(redeemInvite('ABC-123', 'Me', ME));
        expect(e.message).toBe(BUSY);
        expect(e.message).not.toMatch(/Relay Node Offline|unreachable|<|cloudflare/i);
        expect(e).toMatchObject({ status: 429, code: 'busy' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a 503 still reads as the node being unreachable, as before', async () => {
        fetchMock.mockResolvedValue(cloudflare(503, '<html>maintenance</html>'));
        const e = await thrown(redeemInvite('ABC-123', 'Me', ME));
        expect(e.message).toBe('Relay Node Offline: The selected community node is currently unreachable (HTTP 503).');
    });

    it('the node\'s own 429 keeps its own words', async () => {
        fetchMock.mockResolvedValue(nodeJson(429, { error: 'Too many attempts. Try again in 30s' }));
        const e = await thrown(redeemInvite('ABC-123', 'Me', ME));
        expect(e.message).toBe('Too many attempts. Try again in 30s');
    });
});

describe('direct reads and writes whose refusal text became the message (a proxy page is never shown)', () => {
    const noPage = (e: any) => expect(e.message).not.toMatch(/<|cloudflare|1015|rate limited|Too Many|\(429\)/i);

    it('a read through signedGet (my events, the lead vote) is asked once more, then says the sentence, not the page', async () => {
        vi.useFakeTimers();
        for (const read of [() => fetchMyEvents(), () => fetchGroupSuccession('g1')]) {
            fetchMock.mockReset();
            fetchMock.mockImplementation(async () => cloudflare(429, CF_HTML, '1'));
            const p = thrown(read());
            await vi.advanceTimersByTimeAsync(60_000);
            const e = await p;
            expect(e.message).toBe(BUSY);
            noPage(e);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        }
    });

    it('a write that fetches directly (a reminder, cancelling one date) says the sentence and is never sent again', async () => {
        vi.useFakeTimers();
        for (const write of [() => setEventReminder('p1', [60]), () => setEventDateCancelled('p1', '2026-12-01', true)]) {
            fetchMock.mockReset();
            fetchMock.mockResolvedValue(cloudflare(429, 'error code: 1015', '1'));
            const p = thrown(write());
            await vi.advanceTimersByTimeAsync(60_000);
            const e = await p;
            expect(e.message).toBe(BUSY);
            noPage(e);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        }
    });

    it('a Cloudflare page on another status keeps the sentence the function already had, not the page', async () => {
        fetchMock.mockResolvedValue(cloudflare(502, '<html><body>Bad gateway</body></html>'));
        expect((await thrown(setEventReminder('p1', null))).message).toBe('Could not save your reminder');
    });

    it('the node\'s own refusal text (plain, not a page) still comes through as it did', async () => {
        fetchMock.mockResolvedValue(cloudflare(403, 'Only people going can set a reminder.'));
        expect((await thrown(setEventReminder('p1', null))).message).toBe('Only people going can set a reminder.');
    });
});
