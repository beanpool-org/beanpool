// @vitest-environment jsdom
/**
 * useAfterDismiss (utils/screen-presented.ts): what a chooser holds back on iOS until its Modal has gone (round 2 of #2984).
 * A value is held; the Modal's `onDismiss` (`release`) runs it once; a floor timer runs it if that event never comes; leaving the
 * screen drops it. The screens that use it are held to this in map-words-render.test.ts and market-words-render.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AFTER_DISMISS_FALLBACK_MS, useAfterDismiss } from '../screen-presented';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useAfterDismiss<string>>;
const ran: string[] = [];

function Probe({ ms }: { ms?: number }) {
    hook = useAfterDismiss<string>((v) => { ran.push(v); }, ms);
    return null;
}
const mount = (ms?: number) => act(() => { root.render(createElement(Probe, { ms }) as any); });

beforeEach(() => {
    vi.useFakeTimers();
    ran.length = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { vi.useRealTimers(); act(() => root.unmount()); host.remove(); });

describe('useAfterDismiss', () => {
    it('runs nothing until the Modal has been dismissed, then runs the held value once', () => {
        mount();
        act(() => hook.hold('poll'));
        vi.advanceTimersByTime(AFTER_DISMISS_FALLBACK_MS - 1);
        expect(ran, 'still waiting for onDismiss').toEqual([]);
        act(() => hook.release());
        expect(ran).toEqual(['poll']);
        act(() => hook.release());
        vi.advanceTimersByTime(AFTER_DISMISS_FALLBACK_MS * 2);
        expect(ran, 'once: a second dismissal, or the floor timer, runs nothing more').toEqual(['poll']);
    });

    it('a dismissal with nothing held (the member cancelled) runs nothing', () => {
        mount();
        act(() => hook.release());
        vi.advanceTimersByTime(AFTER_DISMISS_FALLBACK_MS * 2);
        expect(ran).toEqual([]);
    });

    it('a dismissal event that never comes does not drop the value: it runs after the floor', () => {
        mount();
        act(() => hook.hold('event'));
        vi.advanceTimersByTime(AFTER_DISMISS_FALLBACK_MS);
        expect(ran).toEqual(['event']);
        act(() => hook.release());
        expect(ran, 'and a late onDismiss runs nothing again').toEqual(['event']);
    });

    it('the floor is the one given', () => {
        mount(200);
        act(() => hook.hold('poll'));
        vi.advanceTimersByTime(199);
        expect(ran).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(ran).toEqual(['poll']);
    });

    it('a second hold replaces the first: one pick at a time', () => {
        mount();
        act(() => hook.hold('poll'));
        act(() => hook.hold('event'));
        act(() => hook.release());
        expect(ran).toEqual(['event']);
    });

    it('leaving the screen drops what is held: nothing runs on an unmounted screen', () => {
        mount();
        act(() => hook.hold('poll'));
        act(() => root.unmount());
        vi.advanceTimersByTime(AFTER_DISMISS_FALLBACK_MS * 2);
        expect(ran).toEqual([]);
        root = createRoot(host);
    });

    it('runs with the latest `run` (a screen that re-rendered while the Modal closed)', () => {
        const later: string[] = [];
        function Latest({ tag }: { tag: string }) {
            hook = useAfterDismiss<string>((v) => { later.push(`${tag}:${v}`); });
            return null;
        }
        act(() => root.render(createElement(Latest, { tag: 'a' }) as any));
        act(() => hook.hold('poll'));
        act(() => root.render(createElement(Latest, { tag: 'b' }) as any));
        act(() => hook.release());
        expect(later).toEqual(['b:poll']);
    });
});
