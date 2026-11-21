// @vitest-environment jsdom
/**
 * Slice N2a, fix round of #3332's deciding review (MyDealsSheet.tsx:398): the named line belongs to ONE visit. A place can
 * stay mounted while hidden (Market keeps Your deals mounted and only flips `visible`; a stack screen stays mounted under
 * the next one), so "hidden, then shown again" must draw no line: leaving is the no for that kind, and a line from an
 * earlier day can never stand beside that day's other soft ask.
 *
 * Two parts. (1) useNotifyLine itself, rendered for real (components/NotifyLine.tsx, react-native drawn as DOM): a sheet's
 * `visible` and a screen's focus (useScreenShowing, through expo-router's useFocusEffect as react-navigation runs it).
 * (2) The class: every place in the app that draws a named line, each with how it is hidden and the render row in its own
 * harness that proves "hidden then shown again: no line". A new place with no row fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light', colors: lightColors }) };
});
/** The screen in front or covered by another; useFocusEffect as react-navigation runs it: on focus, its cleanup on blur. */
const focus = vi.hoisted(() => ({ inFront: true, listeners: new Set<() => void>() }));
vi.mock('expo-router', async () => {
    const { useEffect: effect, useSyncExternalStore } = await import('react');
    const subscribe = (l: () => void) => { focus.listeners.add(l); return () => { focus.listeners.delete(l); }; };
    return {
        useFocusEffect: (cb: () => void | (() => void)) => {
            const inFront = useSyncExternalStore(subscribe, () => focus.inFront);
            effect(() => (inFront ? cb() : undefined), [cb, inFront]);
        },
    };
});
/** Core's rule (utils/notification-permission.ts offerNamedLine): its answer, each kind it was asked, and an answer held back. */
const rule = vi.hoisted(() => ({ answer: true, asked: [] as string[], hold: null as null | Promise<void>, turnOns: 0 }));
vi.mock('../notification-permission', () => ({
    offerNamedLine: vi.fn(async (kind: string) => { rule.asked.push(kind); if (rule.hold) await rule.hold; return rule.answer; }),
    turnOnNotifications: vi.fn(async () => { rule.turnOns++; return 'granted'; }),
}));

import { useNotifyLine, useScreenShowing, type NotifyLineOffer } from '../../components/NotifyLine';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    focus.inFront = true;
    Object.assign(rule, { answer: true, asked: [], hold: null, turnOns: 0 });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const anyLine = () => byTestId('notify-line') ?? byTestId('notify-line-done');

/** A place that draws a named line: a sheet (`showing` given, as its `visible`) or a stack screen (its focus). */
const place = { offer: null as null | ((o: NotifyLineOffer) => Promise<boolean>) };
function Place({ showing }: { showing?: boolean }) {
    const inFront = useScreenShowing();
    const notify = useNotifyLine('a'.repeat(64), showing ?? inFront);
    useEffect(() => { place.offer = notify.offer; });
    return createElement('div', null, notify.view);
}
async function draw(showing?: boolean): Promise<void> {
    await act(async () => { root.render(createElement(Place, { showing }) as any); });
    await settle();
}
async function moment(o: NotifyLineOffer = { kind: 'answer', name: 'Asha' }): Promise<boolean> {
    let ok = false;
    await act(async () => { ok = await place.offer!(o); });
    await settle();
    return ok;
}
async function setFocus(inFront: boolean): Promise<void> {
    await act(async () => { focus.inFront = inFront; focus.listeners.forEach((l) => l()); });
    await settle();
}

describe('the named line is for one visit (useNotifyLine)', () => {
    it("a sheet's visible: shown, closed, opened again on the same mount: no line, and the rule was asked once", async () => {
        await draw(true);
        expect(await moment()).toBe(true);
        expect(byTestId('notify-line')?.textContent).toContain('Hear when Asha answers.');
        await draw(false);
        expect(anyLine()).toBeNull();
        await draw(true);
        expect(anyLine()).toBeNull();
        // Another moment on the same mount, the next visit: nothing asked, nothing drawn (the kind was spent by leaving).
        expect(await moment()).toBe(false);
        expect(anyLine()).toBeNull();
        expect(rule.asked).toEqual(['answer']);
    });

    it("a screen's focus (useScreenShowing): shown, another screen opened over it, back: no line", async () => {
        await draw();
        expect(await moment()).toBe(true);
        expect(byTestId('notify-line')).not.toBeNull();
        await setFocus(false);
        expect(anyLine()).toBeNull();
        await setFocus(true);
        expect(anyLine()).toBeNull();
        expect(rule.asked).toEqual(['answer']);
    });

    it("Tell me answered (\"You'll hear when Asha answers.\"), then closed and opened: that line is gone too", async () => {
        await draw(true);
        await moment();
        await act(async () => { byTestId('notify-line-tell-me')!.click(); });
        await settle();
        expect(byTestId('notify-line-done')?.textContent).toContain("You'll hear when Asha answers.");
        await draw(false);
        await draw(true);
        expect(anyLine()).toBeNull();
        expect(rule.turnOns).toBe(1);
    });

    it("the rule's yes lands after the place was hidden, even once it is shown again: nothing drawn", async () => {
        let release!: () => void;
        rule.hold = new Promise<void>((r) => { release = r; });
        await draw(true);
        let answered: Promise<boolean> = Promise.resolve(false);
        await act(async () => { answered = place.offer!({ kind: 'listing' }); });
        await draw(false);
        await draw(true);
        await act(async () => { release(); await answered; });
        await settle();
        expect(rule.asked).toEqual(['listing']);
        expect(anyLine()).toBeNull();
    });

    it('a moment while hidden: the rule is not asked and nothing is drawn, then or on the next visit', async () => {
        await draw();
        await setFocus(false);
        expect(await moment()).toBe(false);
        await setFocus(true);
        expect(rule.asked).toEqual([]);
        expect(anyLine()).toBeNull();
    });

    it("the rule's no in one visit spends nothing: a later moment, on a later visit, may still show its line", async () => {
        rule.answer = false;
        await draw(true);
        expect(await moment({ kind: 'listing' })).toBe(false);
        await draw(false);
        rule.answer = true;
        await draw(true);
        expect(await moment({ kind: 'listing' })).toBe(true);
        expect(byTestId('notify-line')?.textContent).toContain('Hear when someone answers.');
        expect(rule.asked).toEqual(['listing', 'listing']);
    });
});

// ---- The class: every place that draws a named line, how it is hidden while mounted, and its render row ----------------
const APP = join(__dirname, '..', '..');
const TESTS = join(APP, 'utils', '__tests__');
/**
 * `prop` (slice N2b): a component drawn inside one screen, told by that screen whether it is in front. `from` is the screen,
 * which must hold `const <name> = useScreenShowing();` and hand that name to the component's `showing`.
 */
type PlaceRow = { hiddenBy: 'focus' | 'visible' | 'prop'; from?: string; test: string; row: string };
const PLACES: Record<string, PlaceRow> = {
    'components/EventDetail.tsx': {
        hiddenBy: 'prop',
        from: 'app/post/[id].tsx',
        test: 'notify-n2b-event-render.test.ts',
        row: 'a page covered by another screen loses its line for good (leaving is the no)',
    },
    'components/home/HomeCardBodies.tsx': {
        hiddenBy: 'prop',
        from: 'app/(tabs)/index.tsx',
        test: 'notify-n2b-interests-render.test.ts',
        row: 'Home covered by a screen opened from it, then shown again: the line is gone, and the next star brings none',
    },
    'app/forum/[id].tsx': {
        hiddenBy: 'focus',
        test: 'forum-render.test.ts',
        row: 'a screen opened over the topic and back: the follow line is gone, and the bell asks nothing more',
    },
    'components/MyDealsSheet.tsx': {
        hiddenBy: 'visible',
        test: 'my-deals-listing-line-render.test.ts',
        row: "Market's way: one sheet, closed and opened again (only visible flips): no line, and the rule was asked once",
    },
    'app/chat/[id].tsx': {
        hiddenBy: 'focus',
        test: 'notify-named-lines-chat-render.test.ts',
        row: 'a screen opened over the chat and back: the line is gone, and none comes on their next line',
    },
    'app/community-card.tsx': {
        hiddenBy: 'focus',
        test: 'community-card-knock-render.test.ts',
        row: 'asked from the card, then a screen opened over it and back: the named line is gone',
    },
    'app/find-community.tsx': {
        hiddenBy: 'focus',
        test: 'find-community-no-account-render.test.ts',
        row: 'asked here, then a screen opened over Find a community and back: the named line is gone',
    },
};

function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) sources(full, out);
        else if (/\.(tsx?|jsx?)$/.test(name)) out.push(full);
    }
    return out;
}
/** Each useNotifyLine( call in a file, as the text of its arguments. */
function callsIn(text: string): string[] {
    const found: string[] = [];
    for (let at = text.indexOf('useNotifyLine('); at >= 0; at = text.indexOf('useNotifyLine(', at + 1)) {
        if (/function\s+$/.test(text.slice(Math.max(0, at - 12), at))) continue;
        let depth = 0;
        let i = at + 'useNotifyLine'.length;
        for (; i < text.length; i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')' && --depth === 0) break;
        }
        found.push(text.slice(at + 'useNotifyLine('.length, i));
    }
    return found;
}

describe('every place that draws a named line is hidden then shown again with no line (the class)', () => {
    const callers = [...sources(join(APP, 'app')), ...sources(join(APP, 'components'))]
        .filter((f) => !f.endsWith(join('components', 'NotifyLine.tsx')))
        .filter((f) => callsIn(readFileSync(f, 'utf8')).length > 0)
        .map((f) => relative(APP, f).split('\\').join('/'))
        .sort();

    it('the table names every place, and no place it names has gone', () => {
        expect(callers).toEqual(Object.keys(PLACES).sort());
    });

    for (const [file, p] of Object.entries(PLACES)) {
        it(`${file}: hidden by its ${p.hiddenBy === 'focus' ? 'focus (useScreenShowing)' : p.hiddenBy === 'prop' ? `screen's focus (${p.from})` : 'visible'}, and its row in ${p.test}`, () => {
            const text = readFileSync(join(APP, file), 'utf8');
            const calls = callsIn(text);
            expect(calls).toHaveLength(1);
            const args = calls[0].split(',').map((a) => a.trim()).filter(Boolean);
            // Says whether it is on screen now: never left out, never a plain true.
            expect(args).toHaveLength(2);
            expect(args[1]).not.toBe('true');
            if (p.hiddenBy === 'focus') {
                const name = args[1];
                expect(text).toMatch(new RegExp(`const ${name} = useScreenShowing\\(\\);`));
            } else if (p.hiddenBy === 'prop') {
                // The component takes `showing` and hands it on; its screen holds the focus and passes it, never a plain true.
                expect(args[1]).toBe('showing');
                const screen = readFileSync(join(APP, p.from!), 'utf8');
                const held = /const (\w+) = useScreenShowing\(\);/.exec(screen);
                expect(held, `${p.from} holds useScreenShowing`).toBeTruthy();
                expect(screen).toContain(`showing={${held![1]}}`);
            } else {
                expect(args[1]).toMatch(/\bvisible\b/);
            }
            expect(readFileSync(join(TESTS, p.test), 'utf8')).toContain(p.row);
        });
    }
});
