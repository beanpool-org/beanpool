/**
 * The rule on this phone (utils/known-rule.ts): what it asks of a node, for the join screen and the rules page. No
 * network: fetch is a stand-in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchKnownRule } from '../known-rule';

const NODE = 'https://mullum.example';
const RULE = { known: true, knownFloor: 1000, debtLinePct: 50, quietDays: 60, ruleFrom: '2026-11-16T04:00:00.000Z', debtLineFrom: null, quietDaysFrom: null };
let answers: { status: number; body: unknown } | 'throw';
const asked: string[] = [];

beforeEach(() => {
    asked.length = 0;
    answers = { status: 200, body: RULE };
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        asked.push(String(url));
        if (answers === 'throw') throw new TypeError('Network request failed');
        return new Response(JSON.stringify(answers.body), { status: answers.status });
    }) as typeof fetch;
});

describe('asking a node', () => {
    it('reads the rule from the public route, whichever way the address ends', async () => {
        expect((await fetchKnownRule(`${NODE}/`))?.debtLinePct).toBe(50);
        expect(asked).toEqual([`${NODE}/api/community/known-rule`]);
    });

    it('an older node\'s 404, a plain community and no answer are no rule, and none of them throws', async () => {
        answers = { status: 404, body: { error: 'Not found' } };
        expect(await fetchKnownRule(NODE)).toBeNull();
        answers = { status: 200, body: { known: false } };
        expect(await fetchKnownRule(NODE)).toBeNull();
        answers = 'throw';
        expect(await fetchKnownRule(NODE)).toBeNull();
    });

    it('a page that isn\'t JSON (a captive portal\'s 200) is no rule', async () => {
        globalThis.fetch = vi.fn(async () => new Response('<html>sign in</html>', { status: 200 })) as typeof fetch;
        expect(await fetchKnownRule(NODE)).toBeNull();
    });
});
