// @vitest-environment jsdom
/**
 * The phone asks its community again by itself while a request waits (Damo, 9 Nov 2026: the yes showed only after a manual
 * refresh). The schedule is @beanpool/core's (knock-status-watch.ts); this is the phone's half: the app in the background or
 * the screen covered by another one asks nothing; coming back to the front reads at once. Fake timers; React Native's
 * AppState is a switch the test turns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { KnockWatchTick } from '@beanpool/core';

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

import { useKnockStatusWatch } from '../use-knock-status-watch';

const OPEN: KnockWatchTick = { kind: 'open' };

function go(state: 'active' | 'background' | 'inactive') {
    app.state = state;
    act(() => { for (const cb of [...app.listeners]) cb(state); });
}
async function pass(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

let root: Root | null = null;
let read: ReturnType<typeof vi.fn>;
let api: { readNow: () => Promise<void>; restart: () => void } | null = null;

function Probe(props: { enabled?: boolean; shown?: boolean; restartKey?: string }) {
    api = useKnockStatusWatch(() => read(), props.enabled ?? true, props.restartKey ?? '', props.shown ?? true);
    return null;
}
function mount(props: Parameters<typeof Probe>[0] = {}) {
    const host = document.createElement('div');
    root = createRoot(host);
    act(() => { root!.render(createElement(Probe, props) as any); });
    return (next: Parameters<typeof Probe>[0]) => act(() => { root!.render(createElement(Probe, next) as any); });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    app.state = 'active';
    app.listeners.clear();
    read = vi.fn(async () => OPEN);
    api = null;
});
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('on the phone', () => {
    it('reads at once and then every 20 s while the app is in front', async () => {
        mount();
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
        await pass(20_000);
        expect(read).toHaveBeenCalledTimes(2);
        await pass(20_000);
        expect(read).toHaveBeenCalledTimes(3);
    });

    it('the app in the background asks nothing, and coming back to the front reads at once', async () => {
        mount();
        await pass(0);
        read.mockClear();
        go('background');
        await pass(30 * 60_000);
        expect(read).not.toHaveBeenCalled();
        go('active');
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('"inactive" (the app switcher, a call) is not in front either', async () => {
        mount();
        await pass(0);
        read.mockClear();
        go('inactive');
        await pass(5 * 60_000);
        expect(read).not.toHaveBeenCalled();
    });

    it('a screen another one covers asks nothing, and reads at once when it is shown again', async () => {
        const update = mount({ shown: true });
        await pass(0);
        read.mockClear();
        update({ shown: false });
        await pass(30 * 60_000);
        expect(read).not.toHaveBeenCalled();
        update({ shown: true });
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a screen covered AND the app in the background: back in front reads only when both are true', async () => {
        const update = mount({ shown: false });
        await pass(0);
        expect(read).not.toHaveBeenCalled();
        go('background');
        go('active');
        await pass(0);
        expect(read).not.toHaveBeenCalled(); // still covered
        update({ shown: true });
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('started while the app is in the background: nothing until it is in front', async () => {
        app.state = 'background';
        mount();
        await pass(60_000);
        expect(read).not.toHaveBeenCalled();
        go('active');
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('nothing to wait for: nothing asked; and it stops listening when the screen goes', async () => {
        mount({ enabled: false });
        await pass(60_000);
        expect(read).not.toHaveBeenCalled();
        expect(app.listeners.size).toBe(0);
        act(() => root?.unmount());
        root = null;
        expect(app.listeners.size).toBe(0);
    });

    it('a screen that goes away asks nothing more and leaves no listener', async () => {
        mount();
        await pass(0);
        expect(app.listeners.size).toBe(1);
        act(() => root?.unmount());
        root = null;
        read.mockClear();
        await pass(10 * 60_000);
        expect(read).not.toHaveBeenCalled();
        expect(app.listeners.size).toBe(0);
    });

    it('a new set of requests (the key) begins the schedule again, with a read at once', async () => {
        const update = mount({ restartKey: 'a' });
        await pass(10_000);
        read.mockClear();
        update({ restartKey: 'a b' });
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('Check again reads at once; restart() begins again', async () => {
        mount();
        await pass(5_000);
        read.mockClear();
        await act(async () => { void api!.readNow(); });
        expect(read).toHaveBeenCalledTimes(1);
        read.mockClear();
        act(() => api!.restart());
        await pass(0);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('a stopped answer (settled) is not asked again until the set of requests changes', async () => {
        read.mockResolvedValue({ kind: 'settled' });
        const update = mount({ restartKey: 'a' });
        await pass(0);
        await pass(30 * 60_000);
        expect(read).toHaveBeenCalledTimes(1);
        update({ restartKey: 'a b' });
        await pass(0);
        expect(read).toHaveBeenCalledTimes(2);
    });
});

describe('where React Native has no AppState (older test doubles)', () => {
    it('still watches: a missing AppState reads as always in front', async () => {
        vi.resetModules();
        vi.doMock('react-native', () => ({}));
        const { useKnockStatusWatch: fresh } = await import('../use-knock-status-watch');
        const reads = vi.fn(async () => OPEN);
        function Bare() { fresh(() => reads()); return null; }
        const host = document.createElement('div');
        const bare = createRoot(host);
        act(() => { bare.render(createElement(Bare) as any); });
        await pass(0);
        expect(reads).toHaveBeenCalledTimes(1);
        act(() => bare.unmount());
        vi.doUnmock('react-native');
    });
});
