// @vitest-environment jsdom
/**
 * How often the phone asks `GET /api/community/me` for the reader's own features (useReaderFeatures). Six screens read it
 * on every focus (Ledger, Commons, Market, People, the listing and the public profile), so the answer is kept: an hour for
 * any 200 (with `features` or, from an older node, without), ten minutes for a refusal or no answer, and one ask in flight
 * per node and account. Review of #1852, finding 1: an older node or a 403 used to get a signed ask on every focus.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return { useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]) };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async (k: string) => store.map.get(k) ?? null, setItem: async (k: string, v: string) => { store.map.set(k, v); }, removeItem: async () => {} },
}));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'pk-1', privateKey: 'sk-1', callsign: 'A' } }) }));
const net = vi.hoisted(() => ({
    asks: 0,
    answer: (async () => new Response('{}')) as () => Promise<Response>,
}));
vi.mock('../node-post', () => ({ signedGet: async () => { net.asks++; return net.answer(); } }));
import { useReaderFeatures, type ReaderFeatures } from '../use-reader-features';

let seen: ReaderFeatures | null = null;
function Probe() { seen = useReaderFeatures(); return null; }
const settle = async () => { for (let j = 0; j < 6; j++) await act(async () => {}); };
async function mount() {
    const r = createRoot(document.createElement('div'));
    await act(async () => { r.render(createElement(Probe)); });
    return r;
}
/** n focuses: each mounts the hook, lets its ask settle, and leaves (one screen after another). */
async function focusTimes(n: number) {
    for (let i = 0; i < n; i++) {
        const r = await mount();
        await settle();
        act(() => r.unmount());
    }
}
const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
// Every test reads a node of its own, so no answer kept by one test is seen by the next.
let k = 0;
let now = Date.UTC(2026, 9, 13, 9);
beforeEach(() => {
    k++;
    store.map.clear();
    const url = `https://node${k}.example`;
    store.map.set('beanpool_anchor_url', url);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [url]: { profile: 'local', features: { beans: true }, checkedAt: new Date(now).toISOString() } }));
    net.asks = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the reader ask: ten focuses, one ask', () => {
    it('a node from W1 on (features on /me)', async () => {
        net.answer = ok({ features: { beans: true, escrow: true } });
        await focusTimes(10);
        expect(net.asks).toBe(1);
    });

    it('an older node (a 200 with no features)', async () => {
        net.answer = ok({ profile: {}, probation: null });
        await focusTimes(10);
        expect(net.asks).toBe(1);
        expect(seen?.reader).toBeNull();
    });

    it('a node that refuses (403: a visitor or guest)', async () => {
        net.answer = async () => new Response('{"error":"not a member"}', { status: 403 });
        await focusTimes(10);
        expect(net.asks).toBe(1);
    });

    it('a node that cannot be reached', async () => {
        net.answer = async () => { throw new TypeError('Network request failed'); };
        await focusTimes(10);
        expect(net.asks).toBe(1);
    });

    it('six screens in view at once share one ask in flight', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        net.answer = async () => { await gate; return new Response(JSON.stringify({ features: { beans: false } }), { status: 200 }); };
        const roots = [];
        for (let i = 0; i < 6; i++) roots.push(await mount());
        await settle();
        release();
        await settle();
        expect(net.asks).toBe(1);
        expect(seen?.reader?.beans).toBe(false);
        for (const r of roots) act(() => r.unmount());
    });
});

describe('the reader ask: asked again once the answer is old', () => {
    it('an older node is asked again after an hour, not before', async () => {
        net.answer = ok({ profile: {} });
        await focusTimes(1);
        now += 59 * 60 * 1000;
        await focusTimes(1);
        expect(net.asks).toBe(1);
        now += 2 * 60 * 1000;
        await focusTimes(1);
        expect(net.asks).toBe(2);
    });

    it('a refusal is asked again after ten minutes, not before', async () => {
        net.answer = async () => new Response('{}', { status: 403 });
        await focusTimes(1);
        now += 9 * 60 * 1000;
        await focusTimes(1);
        expect(net.asks).toBe(1);
        now += 2 * 60 * 1000;
        await focusTimes(1);
        expect(net.asks).toBe(2);
    });

    it('a member the node answers after a refusal gets their own set', async () => {
        net.answer = async () => new Response('{}', { status: 403 });
        await focusTimes(1);
        expect(seen?.reader).toBeNull();
        net.answer = ok({ features: { beans: true, escrow: true } });
        now += 11 * 60 * 1000;
        await focusTimes(1);
        expect(seen?.reader?.beans).toBe(true);
    });
});
