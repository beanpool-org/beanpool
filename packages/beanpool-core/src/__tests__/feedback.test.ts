import { describe, it, expect, vi } from 'vitest';
import {
    FEEDBACK_ENDPOINT, FEEDBACK_NOTICE, buildFeedbackBody, feedbackTextProblem, submitFeedback, type FeedbackInput,
} from '../feedback.js';

const input = (over: Partial<FeedbackInput> = {}): FeedbackInput => ({
    text: '  Please let us list firewood by the load.  ',
    kind: 'idea',
    source: 'member-app',
    appVersion: '1.2.37',
    platform: 'android',
    lang: 'es-AR',
    community: '',
    ...over,
});

const reply = (status: number, body?: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => { if (body === undefined) throw new Error('not json'); return body; },
});

describe('feedback client', () => {
    it('reports to the project endpoint on beanpool.org, whatever node the app is on', () => {
        expect(FEEDBACK_ENDPOINT).toBe('https://beanpool.org/api/feedback');
        expect(FEEDBACK_NOTICE).toContain('not to your community');
        expect(FEEDBACK_NOTICE).toContain("Don't include personal details");
    });

    it('builds the body the Worker expects: trimmed text, empty honeypot, no empty community', () => {
        expect(buildFeedbackBody(input())).toEqual({
            text: 'Please let us list firewood by the load.',
            kind: 'idea', source: 'member-app', website: '',
            appVersion: '1.2.37', platform: 'android', lang: 'es-AR',
        });
        expect(buildFeedbackBody(input({ community: '  Mullum  ' })).community).toBe('Mullum');
    });

    it('checks length in characters after trim', () => {
        expect(feedbackTextProblem('   short   ')).toMatch(/at least 10/);
        expect(feedbackTextProblem('0123456789')).toBeNull();
        expect(feedbackTextProblem('🌱'.repeat(2000))).toBeNull();
        expect(feedbackTextProblem('🌱'.repeat(2001))).toMatch(/under 2000/);
    });

    it('does not send an invalid suggestion', async () => {
        const fetch = vi.fn();
        const r = await submitFeedback(input({ text: 'hi' }), { fetch });
        expect(r).toEqual({ ok: false, error: expect.stringMatching(/at least/) });
        expect(fetch).not.toHaveBeenCalled();
        const c = await submitFeedback(input({ community: 'c'.repeat(81) }), { fetch });
        expect(c.ok).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('POSTs JSON to the endpoint and reports success', async () => {
        const fetch = vi.fn().mockResolvedValue(reply(201, { ok: true }));
        expect(await submitFeedback(input(), { fetch })).toEqual({ ok: true });
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe(FEEDBACK_ENDPOINT);
        expect(init.method).toBe('POST');
        expect(init.headers['content-type']).toBe('application/json');
        expect(JSON.parse(init.body).website).toBe('');
    });

    it('a 2xx that is not our Worker\'s {ok:true} is NOT success — no false "thank you" (#919 review)', async () => {
        const page = vi.fn().mockResolvedValue(reply(200));                 // e.g. a static page answering the POST
        const r1 = await submitFeedback(input(), { fetch: page });
        expect(r1.ok).toBe(false);
        expect(!r1.ok && r1.error).toMatch(/still here/);
        const other = vi.fn().mockResolvedValue(reply(200, { hello: 'x' })); // JSON, but not ours
        expect((await submitFeedback(input(), { fetch: other })).ok).toBe(false);
    });

    it('passes the server message through (e.g. the friendly 429)', async () => {
        const fetch = vi.fn().mockResolvedValue(reply(429, { ok: false, error: 'Please try again a bit later.' }));
        expect(await submitFeedback(input(), { fetch })).toEqual({ ok: false, error: 'Please try again a bit later.' });
    });

    it('never throws: network failure and non-JSON errors become a message that says the text is kept', async () => {
        const down = vi.fn().mockRejectedValue(new TypeError('Network request failed'));
        const r1 = await submitFeedback(input(), { fetch: down });
        expect(r1.ok).toBe(false);
        expect(!r1.ok && r1.error).toMatch(/still here/);

        const html = vi.fn().mockResolvedValue(reply(502));
        const r2 = await submitFeedback(input(), { fetch: html });
        expect(!r2.ok && r2.error).toMatch(/still here/);
    });

    it('gives up after the timeout instead of hanging the form', async () => {
        const hang = vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise<never>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }));
        const r = await submitFeedback(input(), { fetch: hang, timeoutMs: 20 });
        expect(r.ok).toBe(false);
    });
});
