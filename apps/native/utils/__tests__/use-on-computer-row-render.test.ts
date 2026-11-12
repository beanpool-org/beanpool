// @vitest-environment jsdom
/**
 * Settings' "Use BeanPool on a computer: open <address>" row (components/UseOnComputerRow.tsx; computer-line), rendered for
 * real in each of the phone's three looks (Classic is the code's `dark`, Light is `light`, Dark is `night`) at the floor's
 * window (320 x 569 dp, text at 1.3x): react-dom in jsdom, React Native's host components as plain tags carrying their
 * styles, as address-follow-card-render.test.ts does. settings-words-render.test.ts renders the whole Settings screen (who
 * sees the row, where it sits, what Copy and Share do, the pseudo-locale); this one is about how the row looks: the words
 * and the buttons in readable ink in every look, nothing fixed-width, and the long address allowed to wrap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BRAND_SETS, contrastRatio } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The platform tells a text it was laid out on more than one line through onTextLayout; the mock keeps the latest callback so a test can say so.
const layout = vi.hoisted(() => ({ last: null as null | ((e: unknown) => void) }));
vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, onLongPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, selectable, style, onTextLayout } = props;
        if (onTextLayout) layout.last = onTextLayout;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress) attrs.onClick = () => onPress();
        // A long press is a context-menu event here: one gesture, whichever element it lands on.
        if (onLongPress) attrs.onContextMenu = () => onLongPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (selectable) attrs['data-selectable'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        StyleSheet: { create: (s: unknown) => s },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        Share: { share: vi.fn(async () => ({})) },
        AccessibilityInfo: { announceForAccessibility: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({
    useFocusEffect: (effect: () => void | (() => void)) => { useEffect(() => effect(), [effect]); },
}));
const look = vi.hoisted(() => ({ colors: null as any, theme: 'dark' as string }));
// The row reads its own colours through useStyles (not Settings' table: the contrast check cannot read a table passed as a prop).
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ theme: look.theme, colors: look.colors }),
    useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: look.theme, colors: look.colors, patternEnabled: false }),
}));
// The fixture of the director's look: the phone is on mullum, the community's main name is byron (measured: GET
// /api/community/info on either host answers primaryAddress byron.beanpool.org, addresses [byron, mullum]). The phone keeps that
// answer. Round 4: the row names byron only when Link a device would take a code from it (the phone's own community or a saved one).
const phone = vi.hoisted(() => ({ anchor: 'https://mullum.beanpool.org/' }));
vi.mock('../node-post', () => ({ anchorUrl: async () => phone.anchor }));
const kept = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async (k: string) => kept.map.get(k) ?? null), setItem: vi.fn(async (k: string, v: string) => { kept.map.set(k, v); }) },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));

import { UseOnComputerRow } from '../../components/UseOnComputerRow';
import { communitySwitched } from '../community-switch';
import { COLOUR_SETS } from '../../constants/colors';

const LOOKS = [['Classic', 'dark'], ['Light', 'light'], ['Dark', 'night']] as const;

async function render(set: (typeof BRAND_SETS)[number]): Promise<HTMLElement> {
    look.colors = COLOUR_SETS[set];
    look.theme = set;
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(UseOnComputerRow) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => {});
    return host;
}
/** What this phone kept of what `url`'s community said of its names, and which communities it has saved. */
function phoneKeeps(url: string, names: { primaryAddress: string; addresses: string[] }, saved: string[] = []) {
    kept.map.clear();
    kept.map.set('beanpool_anchor_url', url);
    kept.map.set('beanpool_node_profiles', JSON.stringify({
        [url.replace(/\/$/, '')]: { profile: 'local', features: { beans: true }, checkedAt: new Date().toISOString(), ...names },
    }));
    if (saved.length) kept.map.set('beanpool_saved_nodes', JSON.stringify(saved.map((u) => ({ url: u }))));
    phone.anchor = url;
}
const BYRON_NAMES = { primaryAddress: 'byron.beanpool.org', addresses: ['byron.beanpool.org', 'mullum.beanpool.org'] };
const byId = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const styleOf = (node: Element) => JSON.parse(node.getAttribute('data-style') ?? '{}');

beforeEach(() => {
    document.body.innerHTML = '';
    // The director's look: a phone on mullum, a community whose main name is byron, byron not saved here: the row says mullum.
    phoneKeeps('https://mullum.beanpool.org/', BYRON_NAMES);
});

describe.each(LOOKS)('the row in %s (%s)', (_name, set) => {
    it('says the line with the address, in ink that reads on the card: the words, the address and both buttons', async () => {
        const host = await render(set);
        const c = COLOUR_SETS[set];
        const texts = Array.from(byId(host, 'settings-use-on-computer').querySelectorAll('span'));
        // The phone's own address (mullum): byron is the community's main name, but this phone would not take a Link a device code
        // from it. Without its https://; the address is one text, a nested piece to each dotted part.
        expect(texts.map((e) => e.textContent)).toEqual(['💻', 'Use BeanPool on a computer: open', 'mullum.beanpool.org', 'mullum.', 'beanpool.', 'org', 'Copy', 'Share']);
        // The sentence and the address, on the card (Settings' menu group): body ink.
        for (const e of texts.slice(1, 3)) {
            expect(styleOf(e).color, e.textContent!).toBe(c.text.body);
            expect(contrastRatio(styleOf(e).color, c.surface.card), e.textContent!).toBeGreaterThanOrEqual(4.5);
        }
        // Each button: its words on its own ground, and a border that is not the ground itself.
        for (const id of ['settings-use-on-computer-copy', 'settings-use-on-computer-share']) {
            const b = byId(host, id);
            const ground = styleOf(b).backgroundColor;
            expect(contrastRatio(styleOf(b.querySelector('span')!).color, ground), id).toBeGreaterThanOrEqual(4.5);
            expect(styleOf(b).borderColor, id).not.toBe(ground);
            expect(styleOf(b).borderWidth, id).toBeGreaterThanOrEqual(1);
        }
    });

    it('holds at 320 dp and 1.3x text: nothing fixed-width or cut to a line count, the whole address in one selectable text, two 48 dp buttons that wrap', async () => {
        const host = await render(set);
        const row = byId(host, 'settings-use-on-computer');
        // The text column: everything but the icon tile, whose 36 dp is Settings' own for every row.
        for (const node of [row.children[1], ...Array.from(row.children[1].querySelectorAll('*'))]) {
            const style = styleOf(node);
            expect(style.width, node.outerHTML.slice(0, 80)).toBeUndefined();
            expect(node.getAttribute('data-lines')).toBeNull();
        }
        // The address is its own block under the lead-in, ONE selectable text (a long press picks up the whole address) holding the
        // dotted pieces as nested text, no "https://" in it and no invisible character.
        const address = byId(host, 'settings-use-on-computer-address');
        expect(address.parentElement).toBe(row.children[1].firstElementChild);
        expect(address.getAttribute('data-selectable')).toBe('true');
        expect(address.textContent).toBe('mullum.beanpool.org');
        expect(address.textContent).toMatch(/^[a-z.]+$/);
        const pieces = Array.from(address.querySelectorAll('span'));
        expect(pieces.map((p) => p.textContent)).toEqual(['mullum.', 'beanpool.', 'org']);
        // The pieces are plain nested text in the address's own ink: not selectable on their own, not laid out on their own.
        for (const piece of pieces) {
            expect(piece.getAttribute('data-selectable'), piece.textContent!).toBeNull();
            expect(styleOf(piece), piece.textContent!).toEqual({});
        }
        // The only selectable text in the row is that one.
        expect(Array.from(row.querySelectorAll('[data-selectable]'))).toEqual([address]);
        expect(row.textContent).not.toContain('https://');
        for (const id of ['settings-use-on-computer-copy', 'settings-use-on-computer-share']) {
            expect(byId(host, id).getAttribute('data-role')).toBe('button');
            expect(styleOf(byId(host, id)).minHeight).toBeGreaterThanOrEqual(48);
        }
        expect(styleOf(byId(host, 'settings-use-on-computer-copy').parentElement!).flexWrap).toBe('wrap');
    });
});

// Round 4 (the deciding review of round 3, BLOCKING): the row and Link a device (the row under it) must never disagree. The row names the
// community's main address only where this phone would take a Link a device code from it, using the very function Link a device asks.
describe('which address the row shows follows what Link a device would take', () => {
    const MULLUM = 'https://mullum.beanpool.org';
    const BYRON = 'https://byron.beanpool.org';
    const addressOf = (host: HTMLElement) => byId(host, 'settings-use-on-computer-address').textContent;

    it('mullum anchor + byron primary, byron not saved: mullum', async () => {
        phoneKeeps(`${MULLUM}/`, BYRON_NAMES);
        expect(addressOf(await render('dark'))).toBe('mullum.beanpool.org');
    });

    it('byron anchor: byron', async () => {
        phoneKeeps(BYRON, BYRON_NAMES);
        expect(addressOf(await render('dark'))).toBe('byron.beanpool.org');
    });

    it('mullum anchor + byron primary, byron saved on this phone: byron', async () => {
        phoneKeeps(`${MULLUM}/`, BYRON_NAMES, [`${MULLUM}/`, `${BYRON}/`]);
        expect(addressOf(await render('dark'))).toBe('byron.beanpool.org');
    });

    it('the saved list that holds only other communities does not make byron welcome', async () => {
        phoneKeeps(`${MULLUM}/`, BYRON_NAMES, [`${MULLUM}/`, 'https://castlemaine.beanpool.org']);
        expect(addressOf(await render('dark'))).toBe('mullum.beanpool.org');
    });

});

// Round 4, finding 3: the address selects as ONE piece (one selectable text, the dotted parts nested in it). Measured in Chromium (probe
// run 13 Nov): a run of text, nested spans or not, has NO break opportunity after a dot, so a name too wide for the line is split at a
// letter. When the platform reports that it had to break the one text (onTextLayout: more than one line), the address is drawn as pieces
// in a wrapping row instead, which break only after a dot: a long name never splits mid-word, and Copy and Share are unchanged.
describe('the address: one selectable text, and pieces only when it did not fit one line', () => {
    const CASTLE = 'https://castlemaine.beanpool.org';
    const CASTLE_NAMES = { primaryAddress: 'castlemaine.beanpool.org', addresses: ['castlemaine.beanpool.org'] };
    const addressOf = (host: HTMLElement) => byId(host, 'settings-use-on-computer-address');
    const sayLines = async (n: number) => { await act(async () => { layout.last!({ nativeEvent: { lines: Array.from({ length: n }, () => ({})) } }); }); };

    beforeEach(() => { layout.last = null; });

    it('a long community name that fits its line: the whole address is one selectable text, a nested piece after each dot', async () => {
        phoneKeeps(CASTLE, CASTLE_NAMES);
        const host = await render('dark');
        expect(addressOf(host).getAttribute('data-selectable')).toBe('true');
        expect(addressOf(host).textContent).toBe('castlemaine.beanpool.org');
        expect(Array.from(addressOf(host).querySelectorAll('span')).map((p) => p.textContent)).toEqual(['castlemaine.', 'beanpool.', 'org']);
        // The platform says it is laid out on one line: nothing changes.
        await sayLines(1);
        expect(addressOf(host).getAttribute('data-selectable')).toBe('true');
        expect(addressOf(host).tagName).toBe('SPAN');
    });

    it('too wide for one line (the platform lays it out on two): pieces in a wrapping row, a break only after a dot, never inside a name', async () => {
        phoneKeeps(CASTLE, CASTLE_NAMES);
        const host = await render('dark');
        expect(layout.last, 'the one text asks to be told how it was laid out').toBeTruthy();
        await sayLines(2);
        const address = addressOf(host);
        expect(styleOf(address).flexDirection).toBe('row');
        expect(styleOf(address).flexWrap).toBe('wrap');
        expect(address.textContent).toBe('castlemaine.beanpool.org');
        const pieces = Array.from(address.querySelectorAll('span'));
        expect(pieces.map((p) => p.textContent)).toEqual(['castlemaine.', 'beanpool.', 'org']);
        // Each piece no wider than the column, so even a piece too wide for it is the only one that breaks.
        for (const p of pieces) expect(styleOf(p).maxWidth, p.textContent!).toBe('100%');
        expect(host.textContent).not.toContain('https://');
    });

    it('too wide for one line: no piece selects by itself; a long press on the address copies the WHOLE address', async () => {
        const { setStringAsync } = await import('expo-clipboard');
        vi.mocked(setStringAsync).mockClear();
        phoneKeeps(CASTLE, CASTLE_NAMES);
        const host = await render('dark');
        await sayLines(2);
        const address = addressOf(host);
        // Nothing in the row is selectable now: a long press that selected "castlemaine." alone is what this replaces.
        expect(Array.from(host.querySelectorAll('[data-selectable]'))).toEqual([]);
        expect(address.getAttribute('data-testid')).toBe('settings-use-on-computer-address');
        await act(async () => { address.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
        expect(setStringAsync).toHaveBeenCalledTimes(1);
        expect(setStringAsync).toHaveBeenCalledWith(CASTLE);
    });

    it('Copy and Share give the whole https:// address either way', async () => {
        const { setStringAsync } = await import('expo-clipboard');
        const { Share } = await import('react-native');
        for (const wide of [false, true]) {
            vi.mocked(setStringAsync).mockClear();
            vi.mocked(Share.share).mockClear();
            phoneKeeps(CASTLE, CASTLE_NAMES);
            const host = await render('dark');
            if (wide) await sayLines(2);
            await act(async () => { byId(host, 'settings-use-on-computer-copy').click(); });
            expect(setStringAsync, `wide ${wide}`).toHaveBeenCalledWith(CASTLE);
            await act(async () => { byId(host, 'settings-use-on-computer-share').click(); });
            expect(Share.share, `wide ${wide}`).toHaveBeenCalledWith({ message: `Use BeanPool on a computer: open ${CASTLE}` });
        }
    });

    it('another community\'s address starts as the one selectable text again', async () => {
        phoneKeeps(CASTLE, CASTLE_NAMES);
        const host = await render('dark');
        await sayLines(2);
        expect(addressOf(host).getAttribute('data-selectable')).toBeNull();
        expect(styleOf(addressOf(host)).flexWrap).toBe('wrap');
        phoneKeeps('https://byron.beanpool.org', BYRON_NAMES);
        await act(async () => { communitySwitched(); });
        await act(async () => {});
        expect(addressOf(host).textContent).toBe('byron.beanpool.org');
        expect(addressOf(host).tagName).toBe('SPAN');
        expect(addressOf(host).getAttribute('data-selectable')).toBe('true');
    });
});
