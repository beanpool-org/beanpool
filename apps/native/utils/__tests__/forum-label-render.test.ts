// @vitest-environment jsdom
/**
 * The phone's "Beside my name on the worldwide forum" row (slice F10 apps; components/forum/ForumLabelRow.tsx,
 * utils/forum-label.ts), rendered for real over a stand-in for the forum's answers, in the light and dark looks.
 *
 * - Nothing is drawn until the forum has said what is chosen now (never a guessed choice).
 * - The choices: Don't show · each of the member's other communities on this phone · I'm waiting to join one. One tap
 *   applies; the chosen one is ticked; "Others see: Ana · Hillside" says what the forum now draws (core forumWriterLine).
 * - A community chosen elsewhere (the web) that this phone doesn't keep is still shown, chosen.
 * - A community whose record has no server key yet, once picked, is the one ticked on this visit and every later one (the
 *   stand-in keeps the pick as utils/forum-label.ts does; forum-label-kept.test.ts runs the real one).
 * - A note that ran out: the ticked chip can be chosen again, which asks a fresh note ("Choose it again to renew it").
 * - A refusal is said in its own words and changes nothing; why a chosen community isn't shown is said in the design's words.
 * - Colours from the theme's tokens, both looks; every choice is at least 48 dp tall.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { button: 'button', alert: 'alert', radio: 'radio', radiogroup: 'radiogroup' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityRole, accessibilityState, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState && 'checked' in accessibilityState) attrs['aria-checked'] = String(!!accessibilityState.checked);
        if (props['aria-hidden']) attrs['aria-hidden'] = 'true';
        const flat = Object.assign({}, ...[props.style].flat(3).filter((x) => x && typeof x === 'object'));
        if (flat.backgroundColor) attrs['data-bg'] = flat.backgroundColor;
        if (flat.color) attrs['data-color'] = flat.color;
        if (typeof flat.minHeight === 'number') attrs['data-min-height'] = String(flat.minHeight);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
    };
});
const look = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const now = () => (look.dark ? { theme: 'dark', colors: darkColors } : { theme: 'light', colors: lightColors });
    return { useTheme: () => now(), useStyles: (make: (t: unknown) => unknown) => make(now()) };
});
const forum = vi.hoisted(() => ({
    state: null as unknown,
    mine: [] as Array<{ address: string; name: string; key: string | null }>,
    chosen: [] as unknown[],
    answer: null as null | ((choice: any) => any),
    /** What utils/forum-label.ts keeps of the community picked: its address and the forum's key for it. */
    kept: null as null | { address: string; key: string },
}));
vi.mock('../forum-label', () => ({
    readForumLabel: vi.fn(async () => forum.state),
    // As the phone's own: a record with no server key carries the forum's key when it is the one picked here.
    otherCommunities: vi.fn(async () => forum.mine.map((c) => (!c.key && forum.kept?.address === c.address ? { ...c, key: forum.kept.key } : c))),
    setForumLabel: vi.fn(async (choice: any) => {
        forum.chosen.push(choice);
        const done = forum.answer!(choice);
        if (done.ok) {
            // The forum holds it now, and the phone keeps what was picked.
            forum.state = done.state;
            forum.kept = choice.show === 'community' && done.state.community ? { address: choice.address, key: done.state.community.key } : null;
        }
        return done;
    }),
}));

import { ForumLabelRow } from '../../components/forum/ForumLabelRow';
import { lightColors, darkColors } from '../../constants/colors';

const HILLSIDE = '12D3KooWHi11sideKey111111111111111111111111111111';
const none = { show: 'none', community: null, lapsesAt: null, label: null, why: null };
const atHillside = { show: 'community', community: { key: HILLSIDE, name: 'Hillside' }, lapsesAt: '2026-12-17T00:00:00.000Z', label: { kind: 'community', community: 'Hillside' }, why: null };

let root: Root | null = null;
let host: HTMLDivElement;

async function draw(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(ForumLabelRow, { myName: 'Ana' }) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const radios = () => Array.from(host.querySelectorAll('[role="radio"]')) as HTMLElement[];
const chosenText = () => radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);
async function tap(el: Element | undefined): Promise<void> {
    await act(async () => { (el as HTMLElement).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
    forum.state = none;
    forum.mine = [{ address: 'https://hillside.example', name: 'Hillside', key: HILLSIDE }, { address: 'https://lakeside.example', name: 'Lakeside', key: null }];
    forum.chosen = [];
    forum.kept = null;
    forum.answer = (choice) => (choice.show === 'community' ? { ok: true, state: atHillside } : { ok: true, state: { ...none, show: choice.show, label: choice.show === 'waiting' ? { kind: 'waiting' } : null } });
});
function undraw(): void {
    act(() => root?.unmount());
    root = null;
    host?.remove();
}
afterEach(undraw);

describe.each([['light', false, lightColors], ['dark', true, darkColors]] as const)('the row in the %s look', (_name, dark, colors) => {
    beforeEach(() => { look.dark = dark; });

    it('the choices, Don\'t show chosen; one tap on a community asks it and ticks it, with what others see', async () => {
        await draw();
        expect(host.textContent).toContain('Beside my name on the worldwide forum');
        expect(radios().map((r) => r.textContent)).toEqual(['✓Don’t show', 'Hillside', 'Lakeside', 'I’m waiting to join one']);
        expect(chosenText()).toEqual(['✓Don’t show']);
        for (const r of radios()) expect(Number(r.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(48);
        expect(host.querySelector('[data-testid="forum-label-shown"]')).toBeNull();

        await tap(radios()[1]);
        expect(forum.chosen).toEqual([{ show: 'community', address: 'https://hillside.example' }]);
        expect(chosenText()).toEqual(['✓Hillside']);
        expect(host.querySelector('[data-testid="forum-label-shown"]')?.textContent).toBe('Others see: Ana · Hillside');
        // The chosen chip is the accent fill with its own ink, from the tokens.
        const on = radios()[1];
        expect(on.getAttribute('data-bg')).toBe(colors.accent.fill);
        expect(on.querySelector('span:last-child')?.getAttribute('data-color')).toBe(colors.text.onAccent);
    });

    it('waiting: posted with no community; the line reads "Ana · waiting to join"', async () => {
        await draw();
        await tap(radios()[3]);
        expect(forum.chosen).toEqual([{ show: 'waiting' }]);
        expect(host.querySelector('[data-testid="forum-label-shown"]')?.textContent).toBe('Others see: Ana · waiting to join');
    });

    it('a refusal is said in its own words, and the choice stays as it was', async () => {
        forum.answer = () => ({ ok: false, error: 'Your community isn’t listed publicly, so its name can’t be shown.' });
        await draw();
        await tap(radios()[2]);
        expect(host.querySelector('[role="alert"]')?.textContent).toBe('Your community isn’t listed publicly, so its name can’t be shown.');
        expect(chosenText()).toEqual(['✓Don’t show']);
    });
});

describe('what the forum already holds', () => {
    beforeEach(() => { look.dark = false; });

    it('nothing is drawn until the forum answers (or when it can\'t)', async () => {
        forum.state = null;
        await draw();
        expect(host.querySelector('[data-testid="settings-forum-label"]')).toBeNull();
    });

    it('a community chosen on the web that this phone doesn\'t keep is shown, chosen; tapping it asks nothing', async () => {
        forum.state = atHillside;
        forum.mine = [{ address: 'https://lakeside.example', name: 'Lakeside', key: null }];
        await draw();
        expect(radios().map((r) => r.textContent)).toEqual(['Don’t show', 'Lakeside', '✓Hillside', 'I’m waiting to join one']);
        await tap(radios()[2]);
        expect(forum.chosen).toEqual([]);
    });

    it('a community whose server key this phone doesn\'t know yet: picked, it is the one ticked, never drawn twice, on this visit and the next', async () => {
        forum.mine = [{ address: 'https://hillside.example', name: 'Hillside', key: null }];
        await draw();
        await tap(radios()[1]);
        expect(forum.chosen).toEqual([{ show: 'community', address: 'https://hillside.example' }]);
        expect(radios().map((r) => r.textContent)).toEqual(['Don’t show', '✓Hillside', 'I’m waiting to join one']);
        // Settings closed and opened again: a new row, nothing of the last one's state.
        undraw();
        await draw();
        expect(radios().map((r) => r.textContent)).toEqual(['Don’t show', '✓Hillside', 'I’m waiting to join one']);
        expect(host.querySelector('[data-testid="forum-label-shown"]')?.textContent).toBe('Others see: Ana · Hillside');
    });

    it('a note that ran out: chosen still, the design\'s words, no line', async () => {
        forum.state = { ...atHillside, label: null, why: 'expired' };
        await draw();
        expect(chosenText()).toEqual(['✓Hillside']);
        expect(host.textContent).toContain('Your community’s note has run out, so its name isn’t shown. Choose it again to renew it.');
        expect(host.querySelector('[data-testid="forum-label-shown"]')).toBeNull();
    });

    it('a note that ran out: the ticked community, tapped, asks a fresh one, and the line is back', async () => {
        forum.state = { ...atHillside, label: null, why: 'expired' };
        await draw();
        await tap(radios()[1]);
        expect(forum.chosen).toEqual([{ show: 'community', address: 'https://hillside.example' }]);
        expect(chosenText()).toEqual(['✓Hillside']);
        expect(host.textContent).not.toContain('Choose it again to renew it.');
        expect(host.querySelector('[data-testid="forum-label-shown"]')?.textContent).toBe('Others see: Ana · Hillside');
    });

    it('a ticked community whose note is current asks nothing when tapped', async () => {
        forum.state = atHillside;
        await draw();
        await tap(radios()[1]);
        expect(forum.chosen).toEqual([]);
    });

    it('no other community on this phone: says so, with Don\'t show and waiting still there', async () => {
        forum.mine = [];
        await draw();
        expect(radios().map((r) => r.textContent)).toEqual(['✓Don’t show', 'I’m waiting to join one']);
        expect(host.textContent).toContain('No other community on this phone. Join one, and its name can be shown here.');
    });
});
