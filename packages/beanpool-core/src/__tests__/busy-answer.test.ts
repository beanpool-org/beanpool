/**
 * "Busy right now" (busy-answer.ts): the one rule both apps use for a 429 from the network in front of a node.
 * Cloudflare's 429 is an HTML page or `error code: 1015`, never the node's JSON; the node's OWN 429s (a day budget, chat
 * too fast) are JSON with a sentence and are not "busy".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BUSY_CODE, BUSY_RETRY_DEFAULT_MS, BUSY_RETRY_MAX_MS, BUSY_RETRY_MIN_MS, busyError, busyWords, isBusyAnswer, isBusyError,
    isBusyStatus, isCloudflareRateLimitBody, isNodeAnswerBody, isProxyPage, refusalTextOf, retryAfterMs, waitBeforeRetry,
} from '../busy-answer';
import { pseudoLocalise, setLanguage } from '../words';

afterEach(() => setLanguage('en'));

const CF_HTML = '<!DOCTYPE html><html lang="en-US"><head><title>Access denied | global.beanpool.org used Cloudflare to restrict access</title></head>'
    + '<body><span class="cf-error-code">1015</span><h1>You are being rate limited</h1></body></html>';

describe('isBusyStatus', () => {
    it('is 429 and nothing else', () => {
        expect(isBusyStatus(429)).toBe(true);
        for (const s of [200, 400, 403, 404, 500, 502, 503, 530, undefined, null, '429', NaN]) expect(isBusyStatus(s), String(s)).toBe(false);
    });
});

describe("Cloudflare's rate-limit answer", () => {
    it('is told by its 1015 code in plain text or in its page, at any status', () => {
        expect(isCloudflareRateLimitBody('error code: 1015')).toBe(true);
        expect(isCloudflareRateLimitBody('Error code:1015\n')).toBe(true);
        expect(isCloudflareRateLimitBody(CF_HTML)).toBe(true);
        expect(isCloudflareRateLimitBody('<h1>Error 1015</h1>')).toBe(true);
    });
    it('is not a node\'s sentence, another Cloudflare code or a non-string', () => {
        for (const b of ['', 'error code: 1020', 'error code: 502', '{"error":"x"}', 'Bad Gateway', undefined, null, 1015, {}]) expect(isCloudflareRateLimitBody(b), String(b)).toBe(false);
    });
});

describe('isProxyPage', () => {
    it('is HTML, Cloudflare by name, or a bare `error code: N`', () => {
        for (const b of [CF_HTML, '<html><body>502</body></html>', '<!doctype html>', 'Attention Required! | Cloudflare', 'error code: 1015', 'error code: 502']) expect(isProxyPage(b), b).toBe(true);
    });
    it('is not a node\'s plain sentence, JSON or empty', () => {
        for (const b of ['Too many attempts. Try again in 30s', '{"error":"no"}', '', '   ', undefined, null]) expect(isProxyPage(b), String(b)).toBe(false);
    });
});

describe("the node's own answer", () => {
    it('is a JSON object with a sentence in `error`', () => {
        expect(isNodeAnswerBody({ error: 'You have made 100 changes today.', code: 'day_budget' })).toBe(true);
        for (const b of [{}, { error: '' }, { error: '  ' }, { error: 5 }, { message: 'x' }, [], null, undefined, 'x']) expect(isNodeAnswerBody(b), JSON.stringify(b)).toBe(false);
    });
});

describe('isBusyAnswer', () => {
    it('a 429 with Cloudflare\'s page, its plain text, an empty body or no body is busy', () => {
        expect(isBusyAnswer(429, CF_HTML)).toBe(true);
        expect(isBusyAnswer(429, 'error code: 1015')).toBe(true);
        expect(isBusyAnswer(429, '')).toBe(true);
        expect(isBusyAnswer(429)).toBe(true);
        expect(isBusyAnswer(429, '{}')).toBe(true);
        expect(isBusyAnswer(429, {})).toBe(true);
    });
    it('a 1015 body is busy whatever the status said', () => {
        expect(isBusyAnswer(403, 'error code: 1015')).toBe(true);
        expect(isBusyAnswer(200, CF_HTML)).toBe(true);
    });
    it("the node's own 429 (a sentence in `error`, as text or already parsed) is NOT busy: its words are true", () => {
        const dayBudget = { error: 'You have made 1,000 changes today. You can carry on in about 6 hours.', code: 'day_budget' };
        expect(isBusyAnswer(429, dayBudget)).toBe(false);
        expect(isBusyAnswer(429, JSON.stringify(dayBudget))).toBe(false);
        expect(isBusyAnswer(429, { error: "You're sending messages too fast. Try again in 20s", code: 'chat_rate' })).toBe(false);
    });
    it('another status with an ordinary body is not busy', () => {
        expect(isBusyAnswer(500, '<html>oops</html>')).toBe(false);
        expect(isBusyAnswer(502, 'Bad Gateway')).toBe(false);
        expect(isBusyAnswer(403, { error: 'no' })).toBe(false);
        expect(isBusyAnswer(404)).toBe(false);
    });
});

describe('retryAfterMs', () => {
    const NOW = Date.parse('2026-11-07T02:00:00Z');
    it('reads whole seconds, clamped to 1-30 s', () => {
        expect(retryAfterMs('7')).toBe(7000);
        expect(retryAfterMs(' 12 ')).toBe(12000);
        expect(retryAfterMs('1.5')).toBe(1500);
        expect(retryAfterMs('0')).toBe(BUSY_RETRY_MIN_MS);
        expect(retryAfterMs('30')).toBe(30000);
        expect(retryAfterMs('3600')).toBe(BUSY_RETRY_MAX_MS);
    });
    it('reads an HTTP date against now, clamped the same way', () => {
        expect(retryAfterMs('Sat, 07 Nov 2026 02:00:10 GMT', NOW)).toBe(10000);
        expect(retryAfterMs('Sat, 07 Nov 2026 02:00:00 GMT', NOW)).toBe(BUSY_RETRY_MIN_MS);
        expect(retryAfterMs('Fri, 06 Nov 2026 02:00:00 GMT', NOW)).toBe(BUSY_RETRY_MIN_MS);
        expect(retryAfterMs('Sat, 07 Nov 2026 04:00:00 GMT', NOW)).toBe(BUSY_RETRY_MAX_MS);
    });
    it('is 5 s when the header is absent, empty or unreadable', () => {
        for (const h of [undefined, null, '', '   ', 'soon', '-3', 'NaN']) expect(retryAfterMs(h as any, NOW), String(h)).toBe(BUSY_RETRY_DEFAULT_MS);
        expect(BUSY_RETRY_DEFAULT_MS).toBe(5000);
    });
});

describe('busyError', () => {
    it('is the sentence with status 429, code busy, nodeAnswered false and the wait', () => {
        const e = busyError('9');
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toBe('Busy right now. Try again in a moment.');
        expect(e).toMatchObject({ status: 429, code: BUSY_CODE, nodeAnswered: false, retryAfterMs: 9000 });
        expect(isBusyError(e)).toBe(true);
        expect(busyError().retryAfterMs).toBe(BUSY_RETRY_DEFAULT_MS);
    });
    it('is not in the HTML or the status text', () => {
        expect(busyError('1').message).not.toMatch(/<|cloudflare|1015|Too Many/i);
    });
    it('isBusyError is false for any other error', () => {
        for (const e of [new Error('x'), null, undefined, 'busy', { code: 'day_budget' }, { status: 429 }]) expect(isBusyError(e), String(e)).toBe(false);
    });
    it('says it in the member\'s language through the words layer', () => {
        expect(busyWords()).toBe('Busy right now. Try again in a moment.');
        setLanguage('xx');
        expect(busyWords()).toBe(pseudoLocalise('Busy right now. Try again in a moment.'));
        expect(busyError().message).toBe(pseudoLocalise('Busy right now. Try again in a moment.'));
    });
});

describe('refusalTextOf', () => {
    it('is the busy sentence for a busy answer, the fallback for a proxy page, and the text for a node\'s plain words', () => {
        expect(refusalTextOf(429, CF_HTML, 'Server returned 429')).toBe('Busy right now. Try again in a moment.');
        expect(refusalTextOf(429, 'error code: 1015', 'x')).toBe('Busy right now. Try again in a moment.');
        expect(refusalTextOf(502, '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', 'Server returned 502')).toBe('Server returned 502');
        expect(refusalTextOf(500, '', 'Server returned 500')).toBe('Server returned 500');
        expect(refusalTextOf(400, 'Name is taken', 'Server returned 400')).toBe('Name is taken');
    });
});

describe('waitBeforeRetry', () => {
    afterEach(() => vi.useRealTimers());
    it('waits the time asked, no less', async () => {
        vi.useFakeTimers();
        let done = false;
        void waitBeforeRetry(5000).then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(4999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
    });
    it('stops at once when the caller gives up, and at once if it already had', async () => {
        vi.useFakeTimers();
        const stop = new AbortController();
        let done = false;
        void waitBeforeRetry(30_000, stop.signal).then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(10);
        expect(done).toBe(false);
        stop.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(done).toBe(true);
        const gone = new AbortController();
        gone.abort();
        await expect(waitBeforeRetry(30_000, gone.signal)).resolves.toBeUndefined();
    });
});
