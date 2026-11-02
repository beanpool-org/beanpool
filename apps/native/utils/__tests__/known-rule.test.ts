/**
 * The rule on this phone (utils/known-rule.ts): what it asks of a node, what it keeps per account and community, and the
 * step-back. Which card is owed is core's (packages/beanpool-core known-rule.test.ts). No network: fetch and the store
 * are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.map.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.map.set(k, v); },
    },
}));
const signed = vi.hoisted(() => ({ gets: [] as string[], me: {} as unknown, status: 200, posts: [] as Array<{ method: string; path: string; body: unknown }>, answer: {} as unknown as (() => unknown) }));
vi.mock('../node-post', () => ({
    signedGet: async (url: string, path: string) => {
        signed.gets.push(`${url}${path}`);
        return new Response(JSON.stringify(signed.me), { status: signed.status });
    },
}));
vi.mock('../db', () => ({
    signedRequestWithMethod: async (method: string, path: string, body: unknown) => {
        signed.posts.push({ method, path, body });
        return signed.answer();
    },
}));

import { fetchKnownRule, forgetMemberRule, keepRuleSeen, memberRule, ruleSeenAt, stepBackFromConfirmed } from '../known-rule';

const NODE = 'https://mullum.example';
const IDENTITY = { publicKey: 'ab'.repeat(32), privateKey: 'priv' } as any;
const RULE = { known: true, knownFloor: 1000, debtLinePct: 50, quietDays: 60, ruleFrom: '2026-11-16T04:00:00.000Z', debtLineFrom: null, quietDaysFrom: null };
let answers: { status: number; body: unknown } | 'throw';
const asked: string[] = [];

beforeEach(() => {
    store.map.clear();
    forgetMemberRule();
    asked.length = 0;
    signed.gets = [];
    signed.posts = [];
    signed.status = 200;
    signed.me = { confirmed: true, confirmedAt: '2026-10-01T00:00:00.000Z' };
    signed.answer = () => ({ id: 'c1', status: 'revoked', owing: false });
    answers = { status: 200, body: RULE };
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        asked.push(String(url));
        if (answers === 'throw') throw new TypeError('Network request failed');
        return new Response(JSON.stringify(answers.body), { status: answers.status });
    }) as typeof fetch;
});

describe('asking a node', () => {
    it('reads the rule from the public route, and an older node\'s 404 is no rule', async () => {
        expect((await fetchKnownRule(`${NODE}/`))?.debtLinePct).toBe(50);
        expect(asked).toEqual([`${NODE}/api/community/known-rule`]);
        answers = { status: 404, body: { error: 'Not found' } };
        expect(await fetchKnownRule(NODE)).toBeNull();
        answers = 'throw';
        expect(await fetchKnownRule(NODE)).toBeNull();
    });

    it('a plain community or an older node is never asked anything signed', async () => {
        answers = { status: 200, body: { known: false } };
        expect(await memberRule(NODE, IDENTITY)).toBeNull();
        forgetMemberRule();
        answers = { status: 404, body: {} };
        expect(await memberRule(NODE, IDENTITY)).toBeNull();
        expect(signed.gets).toEqual([]);
    });

    it('a node that has the rule but doesn\'t state the member says nothing', async () => {
        signed.me = { publicKey: 'k' };
        expect(await memberRule(NODE, IDENTITY)).toBeNull();
        forgetMemberRule();
        signed.status = 403;
        expect(await memberRule(NODE, IDENTITY)).toBeNull();
    });

    it('holds the answer ten minutes per community and account, so a Home focus costs nothing', async () => {
        const now = Date.UTC(2026, 10, 2);
        expect((await memberRule(NODE, IDENTITY, now))?.me.confirmed).toBe(true);
        await memberRule(NODE, IDENTITY, now + 9 * 60_000);
        expect(asked.length).toBe(1);
        expect(signed.gets.length).toBe(1);
        await memberRule(NODE, IDENTITY, now + 11 * 60_000);
        expect(asked.length).toBe(2);
        await memberRule('https://other.example', IDENTITY, now + 11 * 60_000);
        expect(asked.length).toBe(3);
        await memberRule('https://other.example', { ...IDENTITY, publicKey: 'cd'.repeat(32) }, now + 11 * 60_000);
        expect(asked.length).toBe(4);
    });
});

describe('what an account has seen', () => {
    it('is kept per account and per community, whichever way the address is written', async () => {
        const seen = { confirmedAt: '2026-10-01T00:00:00.000Z', ruleKey: '||' };
        await keepRuleSeen(IDENTITY.publicKey, `${NODE}/`, seen);
        expect(await ruleSeenAt(IDENTITY.publicKey, NODE.toUpperCase())).toEqual(seen);
        expect(await ruleSeenAt(IDENTITY.publicKey, 'https://other.example')).toBeNull();
        expect(await ruleSeenAt('cd'.repeat(32), NODE)).toBeNull();
    });

    it('a broken store reads as nothing seen, so the card shows rather than the phone failing', async () => {
        store.map.set(`beanpool_rule_seen:${IDENTITY.publicKey}`, 'not json');
        expect(await ruleSeenAt(IDENTITY.publicKey, NODE)).toBeNull();
        await keepRuleSeen(IDENTITY.publicKey, NODE, { confirmedAt: 'x', ruleKey: null });
        expect((await ruleSeenAt(IDENTITY.publicKey, NODE))?.confirmedAt).toBe('x');
    });
});

describe('stepping back', () => {
    it('posts the member\'s own step-back, an empty object naming nobody, and lets go of the held answer', async () => {
        await memberRule(NODE, IDENTITY);
        expect(await stepBackFromConfirmed()).toEqual({ ok: true, owing: false });
        expect(signed.posts).toEqual([{ method: 'POST', path: '/api/names/step-back', body: {} }]);
        await memberRule(NODE, IDENTITY);
        expect(signed.gets.length).toBe(2);
    });

    it('a refusal is no success, and the phone asks again in case it was out of date', async () => {
        signed.answer = () => { throw new Error("You aren't confirmed."); };
        await memberRule(NODE, IDENTITY);
        expect(await stepBackFromConfirmed()).toEqual({ ok: false, error: "You aren't confirmed." });
        await memberRule(NODE, IDENTITY);
        expect(signed.gets.length).toBe(2);
    });
});
