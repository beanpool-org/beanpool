/**
 * The screens' node profile (utils/use-node-profile.ts) belongs to the community the phone is on now, never the one
 * before. The tabs stay mounted when the phone changes community (Settings → add or switch a community, a deep-link
 * switch, joining another one), so the hook's state outlives the switch: with the global community (Beans off) and
 * a local one (Beans on) side by side, holding the old answer shows one community's features on the other (#1232).
 *
 * The real hook runs here with React's state and expo-router's focus effect stood in for by a small harness:
 * `focus()` runs the screen's focus effect and returns its cleanup (the screen leaving view), `profile()` renders
 * the hook again and returns what the screen would read. The profile code underneath is the real one, over an
 * in-memory AsyncStorage and a fetch stub; nothing here contacts a node.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const harness = vi.hoisted(() => ({
    slots: [] as unknown[],
    at: 0,
    effect: null as null | (() => void | (() => void)),
}));

vi.mock('react', () => {
    const useState = (initial: unknown) => {
        const i = harness.at++;
        if (!(i in harness.slots)) harness.slots[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        const set = (next: unknown) => {
            harness.slots[i] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(harness.slots[i]) : next;
        };
        return [harness.slots[i], set];
    };
    const useCallback = (fn: unknown) => fn;
    return { default: { useState, useCallback }, useState, useCallback };
});

vi.mock('expo-router', () => ({
    useFocusEffect: (effect: () => void | (() => void)) => { harness.effect = effect; },
}));

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => store.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNodeProfile } from '../use-node-profile';
import type { NodeProfile } from '../node-profile';

const A = 'https://global.beanpool.org';
const B = 'https://mullum.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const CACHE = 'beanpool_node_profiles';

const GLOBAL_FEATURES = { beans: false, escrow: false, openJoin: true, distanceSearch: true };
const LOCAL_FEATURES = { beans: true, escrow: true, openJoin: false, distanceSearch: false };

/** The screen renders: the hook runs again and the screen reads what it returns. */
function profile(): NodeProfile | null {
    harness.at = 0;
    return useNodeProfile();
}

/** The screen comes into view. Returns what runs when it leaves view. */
function focus(): () => void {
    profile();
    const cleanup = harness.effect!();
    return typeof cleanup === 'function' ? cleanup : () => {};
}

/** Let every pending read and answer land. */
async function settle() {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

function onAnchor(url: string | null) {
    if (url) store.set(ANCHOR, url);
    else store.delete(ANCHOR);
}

/** The phone's copy of a node's profile, heard `ageMs` ago (fresh under an hour, so no request is made). */
function cache(url: string, body: { profile: 'local' | 'global'; features: Record<string, boolean> }, ageMs = 0) {
    const all = JSON.parse(store.get(CACHE) ?? '{}');
    all[url.toLowerCase()] = { ...body, checkedAt: new Date(Date.now() - ageMs).toISOString() };
    store.set(CACHE, JSON.stringify(all));
}

const STALE = 2 * 60 * 60 * 1000;

type Answer = { status: number; body?: unknown } | 'offline';
/** Each node's info request is held until the test answers it. */
const pending = new Map<string, Array<(a: Answer) => void>>();
const fetchStub = vi.fn((input: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
    const url = String(input);
    const answer = (a: Answer) => {
        if (a === 'offline') { reject(new TypeError(`Network request failed: ${url}`)); return; }
        resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body } as unknown as Response);
    };
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    pending.set(url, [...(pending.get(url) ?? []), answer]);
}));
function answer(node: string, a: Answer) {
    const url = `${node}/api/community/info`;
    const waiting = pending.get(url) ?? [];
    pending.delete(url);
    for (const w of waiting) w(a);
}
const asked = (node: string) => fetchStub.mock.calls.filter(c => String(c[0]) === `${node}/api/community/info`).length;

beforeEach(() => {
    store.clear();
    pending.clear();
    fetchStub.mockClear();
    harness.slots = [];
    harness.at = 0;
    harness.effect = null;
    vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
    // Nothing is left waiting on a timer once a test ends.
    for (const node of [A, B]) answer(node, 'offline');
    vi.unstubAllGlobals();
});

describe('the phone changes community while the tabs stay mounted', () => {
    it('drops the old community\'s profile when the new one has no copy and cannot be reached', async () => {
        onAnchor(A);
        cache(A, { profile: 'global', features: GLOBAL_FEATURES });
        const leave = focus();
        await settle();
        expect(profile()?.profile).toBe('global');
        expect(profile()?.features.beans).toBe(false);
        leave();

        onAnchor(B);
        focus();
        await settle();
        // B's answer is still out: the screen already reads "unknown" (a local community, Beans on), not A's.
        expect(asked(B)).toBe(1);
        expect(profile()).toBeNull();

        answer(B, 'offline');
        await settle();
        expect(profile()).toBeNull();
    });

    it('drops it too when the new community answers with an error', async () => {
        onAnchor(A);
        cache(A, { profile: 'global', features: GLOBAL_FEATURES });
        const leave = focus();
        await settle();
        expect(profile()?.profile).toBe('global');
        leave();

        onAnchor(B);
        focus();
        await settle();
        answer(B, { status: 503, body: {} });
        await settle();
        expect(profile()).toBeNull();
    });

    it('shows the new community\'s copy when the phone has one', async () => {
        onAnchor(A);
        cache(A, { profile: 'global', features: GLOBAL_FEATURES });
        cache(B, { profile: 'local', features: LOCAL_FEATURES });
        const leave = focus();
        await settle();
        expect(profile()?.profile).toBe('global');
        leave();

        onAnchor(B);
        focus();
        await settle();
        expect(profile()?.profile).toBe('local');
        expect(profile()?.features.beans).toBe(true);
        expect(asked(B)).toBe(0);
    });

    it('shows the new community\'s own answer once it lands', async () => {
        onAnchor(A);
        cache(A, { profile: 'global', features: GLOBAL_FEATURES });
        const leave = focus();
        await settle();
        expect(profile()?.profile).toBe('global');
        leave();

        onAnchor(B);
        focus();
        await settle();
        answer(B, { status: 200, body: { profile: 'local', features: LOCAL_FEATURES } });
        await settle();
        expect(profile()?.profile).toBe('local');
        expect(profile()?.features.beans).toBe(true);
    });

    it('ignores an answer from the old community that lands after the switch', async () => {
        onAnchor(A);
        cache(A, { profile: 'global', features: GLOBAL_FEATURES }, STALE);
        const leave = focus();
        await settle();
        expect(asked(A)).toBe(1);
        leave();

        onAnchor(B);
        cache(B, { profile: 'local', features: LOCAL_FEATURES });
        focus();
        await settle();
        expect(profile()?.profile).toBe('local');

        answer(A, { status: 200, body: { profile: 'global', features: GLOBAL_FEATURES } });
        await settle();
        expect(profile()?.profile).toBe('local');
        expect(profile()?.features.beans).toBe(true);
    });

    it('ignores the old community\'s answer even when the new one has no copy and no answer yet', async () => {
        onAnchor(A);
        const leave = focus();
        await settle();
        expect(asked(A)).toBe(1);
        leave();

        onAnchor(B);
        focus();
        await settle();
        answer(A, { status: 200, body: { profile: 'global', features: GLOBAL_FEATURES } });
        await settle();
        expect(profile()).toBeNull();
    });

    it('reads "unknown" once the phone has no community at all', async () => {
        onAnchor(A);
        cache(A, { profile: 'global', features: GLOBAL_FEATURES });
        const leave = focus();
        await settle();
        expect(profile()?.profile).toBe('global');
        leave();

        onAnchor(null);
        focus();
        await settle();
        expect(profile()).toBeNull();
        expect(fetchStub).not.toHaveBeenCalled();
    });
});

describe('the phone stays on the same community (as before)', () => {
    it('shows the phone\'s copy, then the node\'s fresh answer when the copy is stale', async () => {
        onAnchor(B);
        cache(B, { profile: 'local', features: LOCAL_FEATURES }, STALE);
        focus();
        await settle();
        expect(profile()?.features.beans).toBe(true);
        expect(asked(B)).toBe(1);

        answer(B, { status: 200, body: { profile: 'local', features: { ...LOCAL_FEATURES, escrow: false } } });
        await settle();
        expect(profile()?.features.escrow).toBe(false);
    });

    it('asks the node nothing when the copy is fresh', async () => {
        onAnchor(B);
        cache(B, { profile: 'local', features: LOCAL_FEATURES });
        focus();
        await settle();
        expect(profile()?.profile).toBe('local');
        expect(fetchStub).not.toHaveBeenCalled();
    });

    it('keeps showing what it had while a later visit reads again, and keeps it if the node cannot be reached', async () => {
        onAnchor(A);
        cache(A, { profile: 'global', features: GLOBAL_FEATURES }, STALE);
        const leave = focus();
        await settle();
        answer(A, { status: 200, body: { profile: 'global', features: GLOBAL_FEATURES } });
        await settle();
        leave();

        // An hour and more later, the copy is stale again and the node is down.
        cache(A, { profile: 'global', features: GLOBAL_FEATURES }, STALE);
        focus();
        expect(profile()?.profile).toBe('global');
        await settle();
        expect(profile()?.profile).toBe('global');
        answer(A, 'offline');
        await settle();
        expect(profile()?.profile).toBe('global');
        expect(profile()?.features.beans).toBe(false);
    });

    it('is null until something is known, and stays null when nothing can be', async () => {
        onAnchor(B);
        expect(profile()).toBeNull();
        focus();
        await settle();
        expect(profile()).toBeNull();
        answer(B, 'offline');
        await settle();
        expect(profile()).toBeNull();
    });

    it('keeps what it has when the phone\'s storage cannot be read', async () => {
        onAnchor(A);
        cache(A, { profile: 'global', features: GLOBAL_FEATURES });
        const leave = focus();
        await settle();
        expect(profile()?.profile).toBe('global');
        leave();

        vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('storage unavailable'));
        focus();
        await settle();
        expect(profile()?.profile).toBe('global');
    });

    it('ignores an answer that lands after the screen left view', async () => {
        onAnchor(B);
        const leave = focus();
        await settle();
        leave();
        answer(B, { status: 200, body: { profile: 'global', features: GLOBAL_FEATURES } });
        await settle();
        expect(profile()).toBeNull();
    });
});
