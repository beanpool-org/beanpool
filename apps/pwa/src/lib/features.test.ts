/**
 * The reader's own features (lib/features.ts; DESIGN-global-showcase-fable.md §4, pick 6): read from GET
 * /api/community/me only with a key, once per key, and they decide the mode, so BeanID turning Beans on for one member
 * makes that member's Ledger live with nothing else changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityInfo } from './api';

const identity = vi.hoisted(() => ({ current: null as { publicKey: string; privateKey: string } | null }));
vi.mock('./identity', () => ({ loadIdentity: async () => identity.current }));

import { START_COMMUNITY_URL_DEFAULT } from '@beanpool/core';
import { modeFor, readerFeaturesOnce, resetReaderFeaturesOnce, startCommunityUrl } from './features';

const NODE = {
    profile: 'global',
    features: { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true },
} as unknown as CommunityInfo;

let calls: { path: string; method: string }[] = [];
let meAnswer: () => Response;

beforeEach(() => {
    calls = [];
    identity.current = null;
    resetReaderFeaturesOnce();
    meAnswer = () => new Response(JSON.stringify({ publicKey: 'aa', features: { ...NODE.features } }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ path: new URL(url, 'http://x').pathname, method: (init?.method ?? 'GET').toUpperCase() });
        return meAnswer();
    }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the reader\'s features', () => {
    it('a visitor (no key) asks nothing and reads the node\'s set', async () => {
        expect(await readerFeaturesOnce(NODE)).toBeNull();
        expect(calls).toEqual([]);
        expect(modeFor('beans', NODE, null)).toBe('preview');
    });

    it('a member reads /me once per page load, a GET, and the answer decides the mode', async () => {
        identity.current = { publicKey: 'aa'.repeat(32), privateKey: 'bb'.repeat(32) };
        const first = await readerFeaturesOnce(NODE);
        const second = await readerFeaturesOnce(NODE);
        expect(calls).toEqual([{ path: '/api/community/me', method: 'GET' }]);
        expect(second).toBe(first);
        expect(modeFor('beans', NODE, first)).toBe('preview');
    });

    it('Beans on for this reader: their Ledger is live, Decisions stay in preview, an unverified reader reads read-only', async () => {
        identity.current = { publicKey: 'cc'.repeat(32), privateKey: 'dd'.repeat(32) };
        // The node has Beans on (under BeanID's verified mode) and this reader's own set says on: live for them.
        const nodeOn = { ...NODE, features: { ...NODE.features, beans: true } } as unknown as CommunityInfo;
        meAnswer = () => new Response(JSON.stringify({ features: { ...NODE.features, beans: true } }), { status: 200 });
        const reader = await readerFeaturesOnce(NODE);
        expect(modeFor('beans', nodeOn, reader)).toBe('live');
        expect(modeFor('decisions', nodeOn, reader)).toBe('preview');
        // The same node, a reader not yet verified: real data, no writes.
        expect(modeFor('beans', nodeOn, NODE.features as Record<string, unknown>)).toBe('read-only');
    });

    it('Beans off on the node, on for this verified reader: the reader\'s set alone makes their Ledger live', async () => {
        identity.current = { publicKey: '33'.repeat(32), privateKey: '44'.repeat(32) };
        meAnswer = () => new Response(JSON.stringify({ features: { ...NODE.features, beans: true } }), { status: 200 });
        const reader = await readerFeaturesOnce(NODE);
        expect(modeFor('beans', NODE, reader)).toBe('live');
        expect(modeFor('decisions', NODE, reader)).toBe('preview');
        // Signed out on the same node: the node's set, so the preview.
        expect(modeFor('beans', NODE, null)).toBe('preview');
    });

    it('a failed read is not kept: the node\'s set stands, and the next caller asks again', async () => {
        identity.current = { publicKey: 'ee'.repeat(32), privateKey: 'ff'.repeat(32) };
        meAnswer = () => new Response(JSON.stringify({ error: 'down' }), { status: 503 });
        expect(await readerFeaturesOnce(NODE)).toBeNull();
        meAnswer = () => { throw new TypeError('Failed to fetch'); };
        expect(await readerFeaturesOnce(NODE)).toBeNull();
        meAnswer = () => new Response(JSON.stringify({ features: { beans: false, showcase: true } }), { status: 200 });
        expect(await readerFeaturesOnce(NODE)).toEqual({ beans: false, showcase: true });
        expect(calls.length).toBe(3);
    });

    it('a 401 or 403 (a key that is not a member here) is kept as null for the page load: asked once', async () => {
        for (const status of [401, 403]) {
            resetReaderFeaturesOnce();
            calls = [];
            identity.current = { publicKey: String(status).repeat(22).slice(0, 64), privateKey: 'ab'.repeat(32) };
            meAnswer = () => new Response(JSON.stringify({ error: 'not a member' }), { status });
            expect(await readerFeaturesOnce(NODE)).toBeNull();
            expect(await readerFeaturesOnce(NODE)).toBeNull();
            expect(calls.length).toBe(1);
        }
    });

    it('a node with every feature on and no showcase (a local community, or one from before the switches) is never asked', async () => {
        identity.current = { publicKey: '55'.repeat(32), privateKey: '66'.repeat(32) };
        const local = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false } } as unknown as CommunityInfo;
        const old = { profile: 'local' } as unknown as CommunityInfo;
        expect(await readerFeaturesOnce(local)).toBeNull();
        expect(await readerFeaturesOnce(old)).toBeNull();
        expect(await readerFeaturesOnce(null)).toBeNull();
        expect(calls).toEqual([]);
        // One feature off, even with no showcase, or showcase on with all on: the reader's set can matter, so it is read.
        expect(await readerFeaturesOnce({ ...local, features: { ...local.features, decisions: false } } as unknown as CommunityInfo)).toEqual(NODE.features);
        expect(calls).toEqual([{ path: '/api/community/me', method: 'GET' }]);
    });

    it('a node from before W1 sends no features: null, so the node\'s set stands', async () => {
        identity.current = { publicKey: '11'.repeat(32), privateKey: '22'.repeat(32) };
        meAnswer = () => new Response(JSON.stringify({ publicKey: 'x', probation: {} }), { status: 200 });
        expect(await readerFeaturesOnce(NODE)).toBeNull();
    });
});

describe('where Start a community leads', () => {
    it('the node\'s https page; an http one, or none, leads to beanpool.org\'s', () => {
        const info = (startCommunityUrl: unknown) => ({ ...NODE, startCommunityUrl }) as unknown as CommunityInfo;
        expect(startCommunityUrl(info('https://start.example.org/how'))).toBe('https://start.example.org/how');
        expect(startCommunityUrl(info('http://start.example.org/how'))).toBe(START_COMMUNITY_URL_DEFAULT);
        expect(startCommunityUrl(info(undefined))).toBe(START_COMMUNITY_URL_DEFAULT);
        expect(startCommunityUrl(null)).toBe(START_COMMUNITY_URL_DEFAULT);
    });
});
