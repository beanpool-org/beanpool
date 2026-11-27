// @vitest-environment jsdom
/**
 * Whether the community answers, for People → Invites (utils/use-community-online.ts). Marty, 28 Nov 2026 (phone 1.4.8): the
 * voucher box stayed greyed with "Needs a connection…" while the bean menu said "Connected", until the app was restarted. The
 * screen asked once, with 2 s, and never again. Here: one failed ask then a good one says online, never offline between; it
 * says offline only after three failed tries; 8 s to answer, not 2; asked again when the screen is shown again and when the
 * app comes back to the front, and every 30 s while offline; nothing asked while left or in the background; a round out when
 * the screen was left writes nothing. Fake timers; AppState and the tab's focus are switches the test turns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const app = vi.hoisted(() => ({ state: 'active', listeners: new Set<(s: string) => void>() }));
vi.mock('react-native', () => ({
    AppState: {
        get currentState() { return app.state; },
        addEventListener: (_type: string, cb: (s: string) => void) => {
            app.listeners.add(cb);
            return { remove() { app.listeners.delete(cb); } };
        },
    },
}));
// Focus as the navigator gives it: `nav.blur()` leaves the tab (each focus effect's clean-up runs), `nav.focus()` comes back.
const nav = vi.hoisted(() => {
    const listeners = new Set<(on: boolean) => void>();
    const nav = { on: true, listeners, blur: () => { nav.on = false; for (const l of listeners) l(false); }, focus: () => { nav.on = true; for (const l of listeners) l(true); } };
    return nav;
});
vi.mock('expo-router', async () => {
    const { useEffect, useState } = await import('react');
    return {
        useFocusEffect: (cb: () => void | (() => void)) => {
            const [on, setOn] = useState(nav.on);
            useEffect(() => { nav.listeners.add(setOn); return () => { nav.listeners.delete(setOn); }; }, []);
            useEffect(() => (on ? cb() : undefined), [cb, on]);
        },
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async (k: string) => store.map.get(k) ?? null },
}));

import { askCommunityOnline, healthAnswers, ONLINE_AGAIN_MS, ONLINE_RETRY_MS, ONLINE_TIMEOUT_MS, useCommunityOnline } from '../use-community-online';

const ANCHOR = 'https://riverside.example';

/** How the community answers its health, ask by ask: 'ok', 'down' (no network), 'slow' (answers only when aborted). */
type Answer = 'ok' | 'down' | 'slow';
let answers: Answer[] = [];
let otherwise: Answer = 'ok';
let asked: string[] = [];

function go(state: 'active' | 'background' | 'inactive') {
    app.state = state;
    act(() => { for (const cb of [...app.listeners]) cb(state); });
}
async function pass(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

let root: Root | null = null;
let online: boolean | null = null;
function Probe(props: { shown: boolean }) {
    online = useCommunityOnline(props.shown);
    return null;
}
function mount(shown = true) {
    root = createRoot(document.createElement('div'));
    act(() => { root!.render(createElement(Probe, { shown }) as any); });
    return (next: boolean) => act(() => { root!.render(createElement(Probe, { shown: next }) as any); });
}

beforeEach(() => {
    vi.useFakeTimers();
    app.state = 'active';
    app.listeners.clear();
    nav.on = true;
    nav.listeners.clear();
    store.map = new Map([['beanpool_anchor_url', ANCHOR]]);
    answers = [];
    otherwise = 'ok';
    asked = [];
    online = null;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        asked.push(String(url));
        const a = answers.shift() ?? otherwise;
        if (a === 'ok') return new Response('{"ok":true}', { status: 200 });
        if (a === 'down') throw new TypeError('Network request failed');
        return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
    }) as typeof fetch;
});
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
});

describe('the schedule', () => {
    it('8 s to answer, as the header\'s ping; two more tries, after 1 s and then 3 s; 30 s between rounds while offline', () => {
        expect(ONLINE_TIMEOUT_MS).toBe(8000);
        expect(ONLINE_RETRY_MS).toEqual([1000, 3000]);
        expect(ONLINE_AGAIN_MS).toBe(30_000);
    });
});

describe('one round', () => {
    const gone = () => false;
    const sleep = async () => {};
    it('true at the first answer; false only when every try failed; one ask per try', async () => {
        for (const [tries, expected, calls] of [
            [[true], true, 1],
            [[false, true], true, 2],
            [[false, false, true], true, 3],
            [[false, false, false], false, 3],
        ] as const) {
            const left = [...tries];
            const ask = vi.fn(async () => left.shift() ?? false);
            expect(await askCommunityOnline({ ask, anchor: async () => ANCHOR, gone, sleep }), JSON.stringify(tries)).toBe(expected);
            expect(ask).toHaveBeenCalledTimes(calls);
        }
    });
    it('no community on the phone: false, nothing asked', async () => {
        const ask = vi.fn(async () => true);
        expect(await askCommunityOnline({ ask, anchor: async () => null, gone, sleep })).toBe(false);
        expect(ask).not.toHaveBeenCalled();
    });
    it('gone on the way: null, and no try after it', async () => {
        let left = false;
        const ask = vi.fn(async () => { left = true; return false; });
        expect(await askCommunityOnline({ ask, anchor: async () => ANCHOR, gone: () => left, sleep })).toBeNull();
        expect(ask).toHaveBeenCalledTimes(1);
    });
    it('health: a 2xx is an answer; an error status, no network or no answer within the time is none', async () => {
        answers = ['ok'];
        expect(await healthAnswers(ANCHOR)).toBe(true);
        expect(asked).toEqual([`${ANCHOR}/api/community/health`]);
        globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
        expect(await healthAnswers(ANCHOR)).toBe(false);
        globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
        expect(await healthAnswers(ANCHOR)).toBe(false);
    });
});

describe('on the Invites screen', () => {
    it('one failed ask then a good one: online, and never offline in between', async () => {
        answers = ['down', 'ok'];
        mount();
        await pass(0);
        expect(asked).toHaveLength(1);
        expect(online).toBe(true);
        await pass(1000);
        expect(asked).toHaveLength(2);
        expect(online).toBe(true);
        await pass(60_000);
        expect(asked, 'online: no more asks while shown').toHaveLength(2);
    });

    it('offline only once three tries failed (at 0, 1 s and 4 s)', async () => {
        otherwise = 'down';
        mount();
        await pass(3999);
        expect(asked).toHaveLength(2);
        expect(online).toBe(true);
        await pass(1);
        expect(asked).toHaveLength(3);
        expect(online).toBe(false);
    });

    it('a slow answer has 8 s, not 2: still online and one ask at 2 s', async () => {
        answers = ['slow', 'ok'];
        mount();
        await pass(2000);
        expect(asked).toHaveLength(1);
        expect(online).toBe(true);
        await pass(6000); // the first ask is let go at 8 s; the second try 1 s later answers
        expect(asked).toHaveLength(1);
        await pass(1000);
        expect(asked).toHaveLength(2);
        expect(online).toBe(true);
    });

    it('offline, then the community answers: online again on the next round, 30 s on, without leaving the screen', async () => {
        answers = ['down', 'down', 'down'];
        mount();
        await pass(4000);
        expect(online).toBe(false);
        await pass(ONLINE_AGAIN_MS - 1);
        expect(asked).toHaveLength(3);
        await pass(1);
        expect(asked).toHaveLength(4);
        expect(online).toBe(true);
    });

    it('shown again (the tab focused) asks at once: offline turns online', async () => {
        answers = ['down', 'down', 'down'];
        mount();
        await pass(4000);
        expect(online).toBe(false);
        act(() => nav.blur());
        await pass(10 * ONLINE_AGAIN_MS);
        expect(asked, 'left: nothing asked').toHaveLength(3);
        act(() => nav.focus());
        await pass(0);
        expect(asked).toHaveLength(4);
        expect(online).toBe(true);
    });

    it('back in front asks at once; the background asks nothing', async () => {
        answers = ['down', 'down', 'down'];
        mount();
        await pass(4000);
        expect(online).toBe(false);
        go('background');
        await pass(10 * ONLINE_AGAIN_MS);
        expect(asked, 'background: nothing asked').toHaveLength(3);
        go('active');
        await pass(0);
        expect(asked).toHaveLength(4);
        expect(online).toBe(true);
    });

    it('online and back in front: asked again, so a community gone since says so (after its three tries)', async () => {
        mount();
        await pass(0);
        expect(online).toBe(true);
        otherwise = 'down';
        go('background');
        go('active');
        await pass(4000);
        expect(asked).toHaveLength(4);
        expect(online).toBe(false);
    });

    it('another view (not Invites) asks nothing; turning to Invites asks at once', async () => {
        const show = mount(false);
        await pass(60_000);
        expect(asked).toHaveLength(0);
        go('background');
        go('active');
        await pass(0);
        expect(asked, 'back in front, but not on Invites').toHaveLength(0);
        show(true);
        await pass(0);
        expect(asked).toHaveLength(1);
    });

    it('a round still out when the screen was left writes nothing, and tries no more', async () => {
        otherwise = 'down';
        mount();
        await pass(1000);
        expect(asked).toHaveLength(2);
        act(() => nav.blur());
        await pass(60_000);
        expect(asked).toHaveLength(2);
        expect(online, 'never said offline for a round it left').toBe(true);
    });

    it('opened while the app is in the background: nothing until it comes to the front', async () => {
        app.state = 'background';
        mount();
        await pass(60_000);
        expect(asked).toHaveLength(0);
        go('active');
        await pass(0);
        expect(asked).toHaveLength(1);
    });

    it('no community on the phone: offline at once', async () => {
        store.map = new Map();
        mount();
        await pass(0);
        expect(asked).toHaveLength(0);
        expect(online).toBe(false);
    });
});

describe('People → Invites reads it, and asks no health of its own', () => {
    const people = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/people.tsx'), 'utf-8')
        .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    it('online is the hook\'s, for Invites; no one-shot fetch, no state of its own', () => {
        expect(people).toContain("const isOnline = useCommunityOnline(view === 'invites');");
        expect(people).not.toContain('/api/community/health');
        expect(people).not.toMatch(/setIsOnline|checkOnlineStatus/);
    });
    it('the voucher box and Generate\'s words follow it', () => {
        expect(people).toContain('online: isOnline,');
        expect(people).toContain("isOnline ? t('✨ Generate Ticket') : t('✨ Generate Offline Ticket')");
    });
});
