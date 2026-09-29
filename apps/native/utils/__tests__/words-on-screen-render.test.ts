// @vitest-environment jsdom
/**
 * The block comes before the words and goes after them (components/WordsOnScreen.tsx `NoScreenCapture`,
 * utils/words-on-screen.ts): rendered for real here, with React Native's Text and the navigation's focus stood in for.
 *
 * - Not even the first frame of the words is drawn before the library has answered the block, so a recording, cast or
 *   screen share already running when the member taps Show gets nothing (PR #1284 review 4124177329).
 * - The block is let go only once the words have left the tree: put away, or another screen come in front.
 * - Never a gate: a build without the module, a library that refuses, or one that never answers still shows them.
 *
 * The one file here that renders: jsdom and react-dom stand in for the phone, which says nothing about the frames a
 * phone draws, only about the order React is asked to draw in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

/** The navigation's focus for the screen under test: another screen comes in front, and goes. */
const nav = vi.hoisted(() => {
    let focused = true;
    const listeners = new Set<() => void>();
    return {
        get focused() { return focused; },
        set(next: boolean) { focused = next; listeners.forEach((l) => l()); },
        subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
        reset() { focused = true; listeners.clear(); },
    };
});
vi.mock('expo-router', () => ({
    useIsFocused: () => useSyncExternalStore(nav.subscribe, () => nav.focused),
    /** As expo-router runs it: after the render that mounted it, while focused; cleaned up on blur and unmount. */
    useFocusEffect: (effect: () => void | (() => void)) => {
        const focused = useSyncExternalStore(nav.subscribe, () => nav.focused);
        useEffect(() => (focused ? effect() : undefined), [focused, effect]);
    },
}));
vi.mock('../words-clipboard', () => ({ COPY_CLEARS_LINE: 'The copy clears from your clipboard after a minute.' }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(async () => 3),
}));

type Api = { preventScreenCaptureAsync: (key?: string) => Promise<void>; allowScreenCaptureAsync: (key?: string) => Promise<void> };
const capture = vi.hoisted(() => ({ api: null as Api | null }));
vi.mock('../screen-capture-module', () => ({ loadScreenCapture: () => capture.api }));

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

/** What the library was asked, and what was on the page at that moment. */
const asked: { call: 'prevent' | 'allow'; wordsOnPage: boolean }[] = [];
let answerPrevent: () => void = () => {};
let refusePrevent: () => void = () => {};

let container: HTMLDivElement;
let root: Root;
const wordsOnPage = () => container.textContent?.includes('accident') ?? false;

/** The library as a phone has it: its answer to the block comes when the test says. */
function libraryThatAnswersLater(): Api {
    return {
        preventScreenCaptureAsync: vi.fn(() => {
            asked.push({ call: 'prevent', wordsOnPage: wordsOnPage() });
            return new Promise<void>((resolve, reject) => {
                answerPrevent = resolve;
                refusePrevent = () => reject(new Error('UnavailabilityError'));
            });
        }),
        allowScreenCaptureAsync: vi.fn(async () => { asked.push({ call: 'allow', wordsOnPage: wordsOnPage() }); }),
    };
}

async function draw(node: ReactNode): Promise<void> {
    // react-dom's types carry their own copy of @types/react; the element is the same.
    await act(async () => { root.render(node as Parameters<Root['render']>[0]); });
}

/** A screen as the words screens draw it: a heading, and the words inside the block. */
async function screenWithWords(show = true): Promise<void> {
    const { NoScreenCapture } = await import('../../components/WordsOnScreen');
    await draw(createElement('div', null,
        createElement('h1', null, 'Your 12 words'),
        show ? createElement(NoScreenCapture, { children: createElement('p', null, WORDS) }) : null,
    ));
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    nav.reset();
    asked.length = 0;
    capture.api = libraryThatAnswersLater();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
});

describe('the block comes before the words', () => {
    it('the words are not drawn until the library has answered the block, then they are', async () => {
        await screenWithWords();
        expect(asked).toEqual([{ call: 'prevent', wordsOnPage: false }]);
        expect(container.textContent).toContain('Your 12 words');
        expect(wordsOnPage()).toBe(false);

        await act(async () => { answerPrevent(); });
        expect(wordsOnPage()).toBe(true);
        expect(asked.filter((a) => a.call === 'allow')).toEqual([]);
    });

    it('never a gate: a build without the module shows the words', async () => {
        capture.api = null;
        await screenWithWords();
        expect(wordsOnPage()).toBe(true);
    });

    it('never a gate: a library that refuses the block (the web, an older build) shows the words', async () => {
        await screenWithWords();
        expect(wordsOnPage()).toBe(false);
        await act(async () => { refusePrevent(); });
        expect(wordsOnPage()).toBe(true);
    });

    it('never a gate: a library that never answers is given a moment, then the words show anyway', async () => {
        vi.useFakeTimers();
        const { ANSWER_WAIT_MS } = await import('../words-on-screen');
        await screenWithWords();
        await act(async () => { await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1); });
        expect(wordsOnPage()).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(wordsOnPage()).toBe(true);
    });
});

describe('the block goes after the words', () => {
    it('put away (Hide, Cancel, the step moves on): let go only once the words have left the page', async () => {
        await screenWithWords();
        await act(async () => { answerPrevent(); });
        expect(wordsOnPage()).toBe(true);

        await screenWithWords(false);
        expect(wordsOnPage()).toBe(false);
        expect(asked).toEqual([
            { call: 'prevent', wordsOnPage: false },
            { call: 'allow', wordsOnPage: false },
        ]);
    });

    it('put away before the library answered: the words never show, and the block is still let go', async () => {
        await screenWithWords();
        await screenWithWords(false);
        await act(async () => { answerPrevent(); });
        expect(wordsOnPage()).toBe(false);
        expect(asked.map((a) => a.call)).toEqual(['prevent', 'allow']);
    });

    it('another screen in front: the words leave first, then the block goes; back again, they wait for the block', async () => {
        await screenWithWords();
        await act(async () => { answerPrevent(); });
        expect(wordsOnPage()).toBe(true);

        await act(async () => { nav.set(false); });
        expect(wordsOnPage()).toBe(false);
        expect(asked).toEqual([
            { call: 'prevent', wordsOnPage: false },
            { call: 'allow', wordsOnPage: false },
        ]);

        await act(async () => { nav.set(true); });
        expect(asked[2]).toEqual({ call: 'prevent', wordsOnPage: false });
        expect(wordsOnPage()).toBe(false);
        await act(async () => { answerPrevent(); });
        expect(wordsOnPage()).toBe(true);
    });

    it('a screen that opens behind another draws no words and holds no block until it is in front', async () => {
        nav.set(false);
        await screenWithWords();
        expect(asked).toEqual([]);
        expect(wordsOnPage()).toBe(false);
    });

    it('the whole screen closes: let go once, after the words have gone', async () => {
        await screenWithWords();
        await act(async () => { answerPrevent(); });
        await act(async () => { root.render(null); });
        expect(asked.map((a) => a.call)).toEqual(['prevent', 'allow']);
        expect(asked[1].wordsOnPage).toBe(false);
    });
});

describe('a Safety Backup grid waits with its spinner', () => {
    it('draws the fallback until the block has answered, then the words in its place', async () => {
        const { NoScreenCapture } = await import('../../components/WordsOnScreen');
        await draw(createElement(NoScreenCapture, { fallback: createElement('i', null, 'loading'), children: createElement('p', null, WORDS) }));
        expect(container.textContent).toBe('loading');
        await act(async () => { answerPrevent(); });
        expect(container.textContent).toBe(WORDS);
    });
});
