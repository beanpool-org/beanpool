// @vitest-environment jsdom
/**
 * Settings → Chat memory (DESIGN-dm-peer-key-pin §3.4 amendment 6 §3, slice 2): the member's reset of one
 * community's DM pins, drawn at the floor, 320 dp wide with the phone's text at 1.3× (memory product-audience-small-screens),
 * in light and in dark, its colours from the colour library's roles only. The real ChatMemoryCard is rendered as DOM
 * (react-native drawn as elements, numberOfLines and fixed heights kept as data, as key-changed-320.test.ts does); the
 * widths are a model of the card's own numbers with a generous glyph width (0.62 em). The row in Settings is read from
 * settings.tsx. The two composer lines amendment 6 adds are key-changed-320.test.ts's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, numberOfLines, style, onPress, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const flat = Object.assign({}, ...[style].flat(3).filter((x) => x && typeof x === 'object'));
        if (typeof flat.fontSize === 'number') attrs['data-font'] = String(flat.fontSize);
        if (['height', 'maxHeight'].some((k) => typeof flat[k] === 'number')) attrs['data-fixed'] = 'height';
        if (flat.flexDirection === 'row') attrs['data-row'] = '1';
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' }, StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
        View: el('div'), Text: el('span'), Pressable: el('button'),
    };
});
const theme = vi.hoisted(() => ({ colors: null as any }));
vi.mock('../../app/ThemeContext', () => ({ useStyles: (f: any) => f({ colors: theme.colors }) }));

import { ChatMemoryCard } from '../../components/ChatMemoryCard';
import { CHAT_MEMORY_COPY, CHAT_MEMORY_FAILED_LINE, chatMemoryConfirmTitle, chatMemoryDoneLine, chatMemoryStyleSpec } from '../chat-memory';
import { lightColors, darkColors } from '../../constants/colors';

const SCREEN = 320;
const FONT_SCALE = 1.3;
const GLYPH_EM = 0.62;
const widthOf = (text: string, fontSize: number) => text.length * GLYPH_EM * fontSize * FONT_SCALE;
const longestWord = (text: string) => text.split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), '');
/** Settings' content padding (20) and its card's (20), each side. */
const CARD_INNER = SCREEN - 2 * 20 - 2 * 20;

function luminance(hex: string): number {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`not a solid colour: ${hex}`);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const libraryColours = (o: unknown, out = new Set<string>()): Set<string> => {
    if (typeof o === 'string') out.add(o.toLowerCase());
    else if (o && typeof o === 'object') for (const v of Object.values(o)) libraryColours(v, out);
    return out;
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

const COMMUNITIES = [
    { url: 'https://mullum.beanpool.org', name: 'Mullumbimby' },
    { url: 'https://castlemaine.beanpool.org', name: 'Castlemaine Community Garden & Food Swap' },
];

function render(onReset = vi.fn(async () => 'set-aside')) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(ChatMemoryCard, { communities: COMMUNITIES, onReset }) as any));
    return { page: host, onReset };
}
const spans = (page: HTMLElement) => Array.from(page.querySelectorAll('span'));
const span = (page: HTMLElement, text: string) => spans(page).find((s) => s.textContent === text);
const button = (page: HTMLElement, label: string, nth = 0) => Array.from(page.querySelectorAll('button')).filter((b) => b.textContent === label)[nth] as HTMLButtonElement;

/** Every line of text whole: no line limit on it, no fixed height on it or anything around it. */
function whole(page: HTMLElement, text: string) {
    const s = span(page, text);
    expect(s, text).toBeTruthy();
    expect(s!.getAttribute('data-lines'), text).toBeNull();
    for (let el: Element | null = s!; el && el !== page; el = el.parentElement) expect(el.getAttribute('data-fixed'), text).toBeNull();
    return s!;
}

describe('Settings → Chat memory at 320dp with 1.3× text (amendment 6 §3)', () => {
    it('the confirmation is the design\'s sentence, word for word; the row is in Settings\' Account group and opens the card with the reset', () => {
        expect(CHAT_MEMORY_COPY.confirm).toBe("A chat that was paused because its key changed may open with the new key. A private chat that had disappeared from Talk may come back as a group chat the community can read. Check the key code, or who's in a chat, before you send.");
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/settings.tsx'), 'utf-8');
        const group = src.indexOf('<Text style={styles.sectionHeader}>ACCOUNT & IDENTITY</Text>');
        const row = src.indexOf('<Text style={styles.menuText}>{t(CHAT_MEMORY_COPY.row)}</Text>');
        const nextGroup = src.indexOf('<Text style={styles.sectionHeader}>', group + 1);
        expect(group).toBeGreaterThan(0);
        expect(row).toBeGreaterThan(group);
        expect(row).toBeLessThan(nextGroup);
        expect(src).toMatch(/onPress=\{\(\) => setMode\('chatMemory'\)\}/);
        expect(src).toMatch(/\{mode === 'chatMemory' && \([\s\S]*?<ChatMemoryCard[\s\S]*?onReset=\{resetDmChatMemory\}/);
        expect(CHAT_MEMORY_COPY.row).toBe('Chat memory');
        // §3.4 amendment 7 §1 and §5: true as written once the reset judges before it trusts, each pinned word for word.
        expect(CHAT_MEMORY_COPY.rowSub).toBe('Who your chats are with, and which are private.');
        expect(CHAT_MEMORY_COPY.body).toBe("This phone remembers who each of your chats in a community is with, and which chats there are private, so the community can't quietly swap the person behind a chat or turn a private chat into a group one. If this phone can't read that memory, chats in that community can't send. Resetting it re-checks every chat there from the start.");
        expect(chatMemoryDoneLine('Castlemaine')).toBe('Reset. Every chat in Castlemaine is checked again from the start.');
    });

    it.each([['light', lightColors], ['dark', darkColors]] as const)('%s: every line whole, buttons full width and stacked, the reset asked first in place and then done', async (_name, colors) => {
        theme.colors = colors;
        const { page, onReset } = render();
        whole(page, CHAT_MEMORY_COPY.body);
        for (const c of COMMUNITIES) whole(page, c.name);
        expect(Array.from(page.querySelectorAll('[data-row]'))).toEqual([]);   // nothing shares a row at 320 dp
        // The reset asks first, in place, with the sentence; nothing is reset until the second tap.
        act(() => button(page, CHAT_MEMORY_COPY.reset, 1).click());
        whole(page, chatMemoryConfirmTitle(COMMUNITIES[1].name));
        whole(page, CHAT_MEMORY_COPY.confirm);
        expect(onReset).not.toHaveBeenCalled();
        act(() => button(page, CHAT_MEMORY_COPY.cancel).click());
        expect(span(page, CHAT_MEMORY_COPY.confirm)).toBeUndefined();
        act(() => button(page, CHAT_MEMORY_COPY.reset, 1).click());
        await act(async () => { button(page, CHAT_MEMORY_COPY.reset, 1).click(); });
        expect(onReset).toHaveBeenCalledWith(COMMUNITIES[1].url);
        whole(page, chatMemoryDoneLine(COMMUNITIES[1].name));
        expect(span(page, CHAT_MEMORY_COPY.confirm)).toBeUndefined();
    });

    it('a reset that fails says so under that community, whole, and nothing claims it was done', async () => {
        theme.colors = lightColors;
        const { page, onReset } = render(vi.fn(async () => { throw new Error('storage unavailable'); }));
        act(() => button(page, CHAT_MEMORY_COPY.reset, 0).click());
        await act(async () => { button(page, CHAT_MEMORY_COPY.reset, 0).click(); });
        expect(onReset).toHaveBeenCalledWith(COMMUNITIES[0].url);
        whole(page, CHAT_MEMORY_FAILED_LINE);
        expect(span(page, chatMemoryDoneLine(COMMUNITIES[0].name))).toBeUndefined();
    });

    it('at 320 dp and 1.3×: the longest word of each line fits its column whole (a long community name included), every button label fits on one line, and every tap target is at least 48 dp', () => {
        const s = chatMemoryStyleSpec(lightColors);
        const row = CARD_INNER - 2 * (s.row.padding + s.row.borderWidth);
        const confirm = row - 2 * (s.confirmBox.padding + s.confirmBox.borderWidth);
        expect([CARD_INNER, row, confirm]).toEqual([240, 214, 188]);
        expect(widthOf(longestWord(CHAT_MEMORY_COPY.body), s.body.fontSize)).toBeLessThanOrEqual(CARD_INNER);
        expect(widthOf(longestWord(COMMUNITIES[1].name), s.name.fontSize)).toBeLessThanOrEqual(row);
        for (const text of [CHAT_MEMORY_COPY.confirm, chatMemoryConfirmTitle(COMMUNITIES[1].name)]) expect(widthOf(longestWord(text), s.confirmTitle.fontSize)).toBeLessThanOrEqual(confirm);
        expect(widthOf(longestWord(chatMemoryDoneLine(COMMUNITIES[1].name)), s.doneLine.fontSize)).toBeLessThanOrEqual(row);
        expect(widthOf(CHAT_MEMORY_COPY.reset, s.resetText.fontSize)).toBeLessThanOrEqual(row - 2 * (s.resetBtn.paddingHorizontal + s.resetBtn.borderWidth));
        expect(widthOf(CHAT_MEMORY_COPY.reset, s.confirmBtnText.fontSize)).toBeLessThanOrEqual(confirm - 2 * (s.confirmBtn.paddingHorizontal + s.confirmBtn.borderWidth));
        expect(widthOf(CHAT_MEMORY_COPY.cancel, s.cancelText.fontSize)).toBeLessThanOrEqual(confirm - 2 * (s.cancelBtn.paddingHorizontal + s.cancelBtn.borderWidth));
        for (const b of [s.resetBtn, s.confirmBtn, s.cancelBtn]) expect(b.minHeight).toBeGreaterThanOrEqual(48);
    });

    it.each([['light', lightColors], ['dark', darkColors]] as const)('%s: every colour is one of the library\'s roles, and every text reads at 4.5:1 or more on what it sits on', (_name, colors) => {
        const s = chatMemoryStyleSpec(colors as any) as Record<string, Record<string, unknown>>;
        const library = libraryColours(colors);
        for (const [k, v] of Object.entries(s)) for (const prop of ['color', 'backgroundColor', 'borderColor']) {
            if (typeof v[prop] === 'string') expect(library.has(String(v[prop]).toLowerCase()), `${k}.${prop}`).toBe(true);
        }
        const card = colors.surface.card;
        const pairs: Array<[string, string, string]> = [
            ['body', s.body.color as string, card], ['name', s.name.color as string, card],
            ['reset', s.resetText.color as string, s.resetBtn.backgroundColor as string],
            ['confirm title', s.confirmTitle.color as string, s.confirmBox.backgroundColor as string],
            ['confirm', s.confirmText.color as string, s.confirmBox.backgroundColor as string],
            ['the reset itself', s.confirmBtnText.color as string, s.confirmBtn.backgroundColor as string],
            ['cancel', s.cancelText.color as string, s.cancelBtn.backgroundColor as string],
            ['done', s.doneLine.color as string, card], ['failed', s.failedLine.color as string, card],
        ];
        for (const [what, fg, bg] of pairs) expect(contrast(fg, bg), `${what}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
});

// Pre-build phone check (16 Oct, emulator-5554): Settings → Chat memory said "No communities on this phone yet." on a
// phone holding two, so the reset that DM_PIN_STORE_UNREAD_TEXT sends the member to wasn't there. The card is drawn
// from `savedNodes`, and Settings read that list only when Advanced opened (`if (mode === 'advanced')`), so the list was
// empty unless Advanced had been opened first in the same visit. The screen can't be rendered here (vitest.config.ts):
// its wiring is read from its source, as settings-words-put-away.test.ts does.
describe('Settings → Chat memory lists the communities on this phone on a first visit', () => {
    /** Code only: what a comment says is not what the screen does. */
    const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const settings = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/settings.tsx'), 'utf-8'));

    it('opening Chat memory reads the saved communities itself, whether or not Advanced was opened', () => {
        const s = settings();
        const at = s.search(/React\.useEffect\(\(\) => \{\s*if \(mode !== 'chatMemory'\) return;/);
        expect(at, 'an effect that runs when Chat memory opens').toBeGreaterThan(-1);
        const body = s.slice(at, s.indexOf('}, [mode]);', at));
        expect(body).toContain('getSavedNodes()');
        expect(body).toMatch(/setSavedNodes\(/);
    });

    it('the card is still drawn from that one list', () => {
        expect(settings()).toMatch(/<ChatMemoryCard\s+communities=\{savedNodes\.map\(/);
    });
});
