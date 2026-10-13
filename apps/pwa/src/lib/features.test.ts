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
        expect(await readerFeaturesOnce()).toBeNull();
        expect(calls).toEqual([]);
        expect(modeFor('beans', NODE, null)).toBe('preview');
    });

    it('a member reads /me once per page load, a GET, and the answer decides the mode', async () => {
        identity.current = { publicKey: 'aa'.repeat(32), privateKey: 'bb'.repeat(32) };
        const first = await readerFeaturesOnce();
        const second = await readerFeaturesOnce();
        expect(calls).toEqual([{ path: '/api/community/me', method: 'GET' }]);
        expect(second).toBe(first);
        expect(modeFor('beans', NODE, first)).toBe('preview');
    });

    it('Beans on for this reader: their Ledger is live, Decisions stay in preview, an unverified reader reads read-only', async () => {
        identity.current = { publicKey: 'cc'.repeat(32), privateKey: 'dd'.repeat(32) };
        // The node has Beans on (under BeanID's verified mode) and this reader's own set says on: live for them.
        const nodeOn = { ...NODE, features: { ...NODE.features, beans: true } } as unknown as CommunityInfo;
        meAnswer = () => new Response(JSON.stringify({ features: { ...NODE.features, beans: true } }), { status: 200 });
        const reader = await readerFeaturesOnce();
        expect(modeFor('beans', nodeOn, reader)).toBe('live');
        expect(modeFor('decisions', nodeOn, reader)).toBe('preview');
        // The same node, a reader not yet verified: real data, no writes.
        expect(modeFor('beans', nodeOn, NODE.features as Record<string, unknown>)).toBe('read-only');
    });

    it('Beans off on the node, on for this verified reader: the reader\'s set alone makes their Ledger live', async () => {
        identity.current = { publicKey: '33'.repeat(32), privateKey: '44'.repeat(32) };
        meAnswer = () => new Response(JSON.stringify({ features: { ...NODE.features, beans: true } }), { status: 200 });
        const reader = await readerFeaturesOnce();
        expect(modeFor('beans', NODE, reader)).toBe('live');
        expect(modeFor('decisions', NODE, reader)).toBe('preview');
        // Signed out on the same node: the node's set, so the preview.
        expect(modeFor('beans', NODE, null)).toBe('preview');
    });

    it('a failed read is not kept: the node\'s set stands, and the next caller asks again', async () => {
        identity.current = { publicKey: 'ee'.repeat(32), privateKey: 'ff'.repeat(32) };
        meAnswer = () => new Response(JSON.stringify({ error: 'down' }), { status: 503 });
        expect(await readerFeaturesOnce()).toBeNull();
        meAnswer = () => new Response(JSON.stringify({ features: { beans: false, showcase: true } }), { status: 200 });
        expect(await readerFeaturesOnce()).toEqual({ beans: false, showcase: true });
        expect(calls.length).toBe(2);
    });

    it('a node from before W1 sends no features: null, so the node\'s set stands', async () => {
        identity.current = { publicKey: '11'.repeat(32), privateKey: '22'.repeat(32) };
        meAnswer = () => new Response(JSON.stringify({ publicKey: 'x', probation: {} }), { status: 200 });
        expect(await readerFeaturesOnce()).toBeNull();
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
