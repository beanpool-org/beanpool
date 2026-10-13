// @vitest-environment jsdom
/**
 * "(key changed)" is never cut at the floor: 320dp wide with the phone's text at 1.3× (memory product-audience-small-
 * screens; review of #1826, NB9). It used to ride at the end of the name's one line (the chat bubble's author, the
 * roster's callsign, both numberOfLines={1}), where the reviewer's replica measured it cut for every name on a convenor's
 * roster and from seven-letter names in a bubble. In the bubble it has its own line under the name, with no line limit.
 * On the roster it has its own line under the member's whole line, indented to the name: inside the name's column, the
 * lead's three buttons left 66px and "changed)" broke mid-word (review of #1826, confirmation 1, NB4).
 *
 * The bubble is rendered here (react-native drawn as DOM, numberOfLines kept as data-lines, as home-screen-render.test.ts
 * does); the roster row is read from GroupDetailModal's source. The widths are a model of the components' own numbers
 * (each button its 48dp and 6dp margin), with a generous glyph width (0.62em, a bold Latin face), as
 * sso-button-layout.test.ts does.
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
        const { children, numberOfLines, style } = props;
        const attrs: Record<string, unknown> = {};
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const flat = Object.assign({}, ...[style].flat(3).filter((x) => x && typeof x === 'object'));
        if (typeof flat.fontSize === 'number') attrs['data-font'] = String(flat.fontSize);
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return { Platform: { OS: 'android' }, StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 }, View: el('div'), Text: el('span'), Pressable: el('div') };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }));

import { ChatBubble } from '../../components/chat/ChatBubble';
import { makeChatStyles } from '../../components/chat/styles';
import { lightColors } from '../../constants/colors';
import { KEY_CHANGED_HINT, markKeyChanged } from '../name-key-memory';

const SCREEN = 320;
const FONT_SCALE = 1.3;
const GLYPH_EM = 0.62;
const widthOf = (text: string, fontSize: number) => text.length * GLYPH_EM * fontSize * FONT_SCALE;
const longestWord = (text: string) => text.split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), '');
const styles = makeChatStyles({ theme: 'light', colors: lightColors } as any) as any;
const pct = (v: unknown) => (typeof v === 'string' && v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : 1);

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

function renderBubble(name: string): HTMLElement {
    const [item] = markKeyChanged([{ id: 'm1', senderId: 'a'.repeat(64), text: 'ok', authorName: name, integrityNote: null, outgoing: false } as any], new Set(['a'.repeat(64)]));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(ChatBubble, { item, isMe: false, styles, kind: 'group', authorLabel: item.authorName, onPressUrl: () => {} }) as any));
    return host;
}

describe('"(key changed)" at 320dp with 1.3× text', () => {
    it('the bubble: the name keeps its one line, and the mark is its own line with no limit', () => {
        for (const name of ['Ana', 'Bronwyn', 'Alexandra Papadopoulou']) {
            const page = renderBubble(name);
            const spans = Array.from(page.querySelectorAll('span'));
            const author = spans.find((s) => s.textContent === name);
            const mark = spans.find((s) => s.textContent === KEY_CHANGED_HINT);
            expect(author?.getAttribute('data-lines')).toBe('1');
            expect(mark, `the mark is drawn for ${name}`).toBeTruthy();
            expect(mark!.getAttribute('data-lines')).toBeNull();
            expect(mark!.contains(author!) || author!.contains(mark!)).toBe(false);
            expect(spans.filter((s) => s.getAttribute('data-lines') === '1').some((s) => s.textContent?.includes(KEY_CHANGED_HINT))).toBe(false);
            act(() => root?.unmount()); host?.remove(); root = null; host = null;
        }
    });

    it('the bubble: at its widest the mark fits on one line, and it could wrap word by word in any narrower one', () => {
        // Chat list padding, the row's maxWidth, the bubble's maxWidth and padding (styles.ts, ChatMessageRow.tsx).
        const rowSource = fs.readFileSync(path.resolve(__dirname, '../../components/chat/ChatMessageRow.tsx'), 'utf-8');
        expect(rowSource).toMatch(/flexDirection: 'row', alignItems: 'center', maxWidth: '85%'/);
        const bubble = (SCREEN - 2 * styles.listContent.padding) * 0.85 * pct(styles.messageBubble.maxWidth) - 2 * styles.messageBubble.paddingHorizontal;
        expect(Math.round(bubble)).toBe(176); // the reviewer's replica measured 176px
        const font = styles.messageAuthorHint.fontSize;
        expect(widthOf(KEY_CHANGED_HINT, font)).toBeLessThanOrEqual(bubble);
        expect(widthOf(longestWord(KEY_CHANGED_HINT), font)).toBeLessThanOrEqual(bubble / 2);
    });

    it('the roster: the mark is its own line under the member\'s, outside the name\'s column, and one line whatever buttons the viewer has', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../components/GroupDetailModal.tsx'), 'utf-8');
        const style = (name: string) => src.match(new RegExp(`\\n        ${name}: \\{([\\s\\S]*?)\\n        \\}`))![1];
        const num = (block: string, prop: string) => Number(new RegExp(`${prop}: (\\d+)`).exec(block)?.[1]);
        const callsign = src.match(/<Text style=\{styles\.memberCallsign\} numberOfLines=\{1\}>([\s\S]*?)<\/Text>/);
        expect(callsign).toBeTruthy();
        expect(callsign![1]).not.toContain('KEY_CHANGED_HINT');
        const mark = src.indexOf('<Text style={styles.memberKeyChanged}>{KEY_CHANGED_HINT}</Text>');
        expect(mark).toBeGreaterThan(0);
        // After the whole line (avatar, name's column, buttons), inside the row: not in the name's column.
        const line = src.indexOf('<View style={styles.memberLine}>');
        const buttons = src.indexOf('handleRemoveMember(m.memberPubkey');
        expect(line).toBeGreaterThan(0);
        expect(mark).toBeGreaterThan(buttons);
        expect(src.slice(line, mark)).toContain('<View style={styles.memberInfo}>');
        expect(style('memberRow')).not.toMatch(/flexDirection/);
        expect(style('memberLine')).toMatch(/flexDirection: 'row'/);
        // Indented to the name: the avatar's 36 and the name column's margin.
        expect(src).toMatch(/<MemberAvatar [^>]*size=\{36\} \/>/);
        expect(num(style('memberKeyChanged'), 'marginLeft')).toBe(36 + num(style('memberInfo'), 'marginLeft'));
        const font = num(style('memberKeyChanged'), 'fontSize');
        // The sheet's padding 20 each side, then the indent: the mark's own width, the same with 0, 2 or 3 buttons.
        const markWidth = SCREEN - 2 * 20 - num(style('memberKeyChanged'), 'marginLeft');
        expect(markWidth).toBe(232);
        expect(widthOf(KEY_CHANGED_HINT, font)).toBeLessThanOrEqual(markWidth);
        // Why it left the name's column: each button is 48dp plus its 6dp margin (manageBtn), so a convenor's row (Role,
        // ✕) left 120px and the lead's view of another convenor (hand over, Role, ✕) 66px, where "changed)" broke
        // mid-word at 1.3× (the reviewer's Chromium replica measured the same 120 and 66).
        const btn = num(style('manageBtn'), 'minWidth') + num(style('manageBtn'), 'marginLeft');
        expect(btn).toBe(54);
        const column = (n: number) => SCREEN - 2 * 20 - 36 - num(style('memberInfo'), 'marginLeft') - num(style('memberInfo'), 'marginRight') - n * btn;
        expect([column(2), column(3)]).toEqual([120, 66]);
        expect(widthOf(longestWord(KEY_CHANGED_HINT), font)).toBeGreaterThan(column(3));
    });
});
