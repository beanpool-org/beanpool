// @vitest-environment jsdom
/**
 * "About this listing" drawn on the phone (components/chat/ChatAbout.tsx; core chat-about.ts): the chip above the composer and the
 * card at the top of a bubble, rendered for real (react-native drawn as DOM, numberOfLines kept as data-lines, as
 * key-changed-320.test.ts does), in light and in dark from the chat's own colour tokens, at 320 dp with the phone's text at 1.3x:
 * nothing is cut to one line, the card and the ✕ are at least 44 dp, and a long title wraps inside the bubble.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, numberOfLines, style, onPress, accessibilityLabel, accessibilityRole, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const flat = Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
        if (typeof flat.minHeight === 'number') attrs['data-min-height'] = String(flat.minHeight);
        if (typeof flat.minWidth === 'number') attrs['data-min-width'] = String(flat.minWidth);
        if (typeof flat.color === 'string') attrs['data-ink'] = flat.color;
        if (typeof flat.backgroundColor === 'string') attrs['data-ground'] = flat.backgroundColor;
        if (['height', 'maxHeight'].some((k) => typeof flat[k] === 'number')) attrs['data-fixed'] = 'height';
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress(); };
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' }, StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
        View: el('div'), Text: el('span'), Pressable: el('div'), TextInput: el('textarea'), ActivityIndicator: el('span'),
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const theme = vi.hoisted(() => ({ colors: null as any }));
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => ({ colors: theme.colors }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }));

import { aboutOfPost, chatAboutDrafts } from '@beanpool/core';
import { ChatAboutBanner, ChatAboutCard } from '../../components/chat/ChatAbout';
import { ChatBubble } from '../../components/chat/ChatBubble';
import { makeChatStyles } from '../../components/chat/styles';
import { lightColors, darkColors } from '../../constants/colors';

const EGGS = { id: 'post-eggs-1', type: 'offer', title: 'Fresh eggs', credits: 6, price_type: 'fixed' };
const about = { postId: 'post-eggs-1', title: 'Fresh eggs', kind: 'offer' as const };
const LONG = 'Pottery course for beginners: wheel, glazing and two firings, all materials and a cup of tea included';

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; chatAboutDrafts.clear(); });
beforeEach(() => chatAboutDrafts.clear());

function draw(node: any): HTMLElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
    return host;
}
const stylesFor = (mode: 'light' | 'dark') => makeChatStyles({ theme: mode, colors: mode === 'light' ? lightColors : darkColors } as any) as any;

describe.each([['light' as const], ['dark' as const]])('the card in a bubble (%s, 320 dp, text 1.3x)', (mode) => {
    const styles = stylesFor(mode);
    beforeEach(() => { theme.colors = mode === 'light' ? lightColors : darkColors; });

    it('shows the listing\'s own kind, title and price, and a tap opens the listing', () => {
        const opened: string[] = [];
        const dom = draw(createElement(ChatAboutCard, { styles, about, live: { ...EGGS, title: 'Fresh eggs, a dozen', credits: 8, priceType: 'fixed' }, isMe: false, onOpen: (id: string) => opened.push(id) }));
        const card = dom.querySelector('[data-testid="chat-about-card"]') as HTMLElement;
        expect(card.textContent).toBe('OfferFresh eggs, a dozen8 Beans');
        expect(card.getAttribute('aria-label')).toBe('Open this listing: Fresh eggs, a dozen');
        act(() => { card.click(); });
        expect(opened).toEqual(['post-eggs-1']);
    });

    it('holds at the floor: at least 44 dp to hit, no line limit anywhere, a long title wraps whole', () => {
        const dom = draw(createElement(ChatAboutCard, { styles, about: { ...about, title: LONG }, live: undefined, isMe: true, onOpen: () => {} }));
        const card = dom.querySelector('[data-testid="chat-about-card"]') as HTMLElement;
        expect(Number(card.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(44);
        expect(dom.querySelectorAll('[data-lines]').length).toBe(0);
        expect(dom.querySelector('[data-fixed]')).toBeNull();
        expect(card.textContent).toContain(LONG);
    });

    it('takes its colours from the chat tokens: ink and ground differ, in my bubble and in theirs', () => {
        for (const isMe of [true, false]) {
            const dom = draw(createElement(ChatAboutCard, { styles, about, live: undefined, isMe, onOpen: () => {} }));
            const card = dom.querySelector('[data-testid="chat-about-card"]') as HTMLElement;
            expect(card.getAttribute('data-ground')).toBe(isMe ? styles.quoteMe.backgroundColor : styles.quoteOther.backgroundColor);
            const title = Array.from(dom.querySelectorAll('span')).find((s) => s.textContent === 'Fresh eggs')!;
            expect(title.getAttribute('data-ink')).toBe(isMe ? styles.quoteAuthorMe.color : styles.quoteAuthorOther.color);
            expect(title.getAttribute('data-ink')).not.toBe(card.getAttribute('data-ground'));
            act(() => root!.unmount()); host!.remove(); root = null; host = null;
        }
    });

    it('says "This listing is no longer up." for one this reader can\'t see, with no title, and opens nothing', () => {
        const opened: string[] = [];
        const dom = draw(createElement(ChatAboutCard, { styles, about, live: null, isMe: false, onOpen: (id: string) => opened.push(id) }));
        const gone = dom.querySelector('[data-testid="chat-about-gone"]') as HTMLElement;
        expect(gone.textContent).toBe('This listing is no longer up.');
        expect(dom.textContent).not.toContain('Fresh eggs');
        expect(dom.querySelector('[data-testid="chat-about-card"]')).toBeNull();
        act(() => { gone.click(); });
        expect(opened).toEqual([]);
    });

    it('sits at the top of the bubble, above the words', () => {
        const item = { id: 'm1', senderId: 'peer', text: 'Is this still available?', type: 'text', timestamp: '12:14' } as any;
        const dom = draw(createElement(ChatBubble, {
            item, isMe: false, styles, kind: 'dm',
            about: createElement(ChatAboutCard, { styles, about, live: undefined, isMe: false, onOpen: () => {} }),
        } as any));
        const html = dom.innerHTML;
        expect(html.indexOf('Fresh eggs')).toBeGreaterThan(-1);
        expect(html.indexOf('Fresh eggs')).toBeLessThan(html.indexOf('Is this still available?'));
    });
});

describe.each([['light' as const], ['dark' as const]])('the chip above the composer (%s, 320 dp, text 1.3x)', (mode) => {
    const styles = stylesFor(mode);
    beforeEach(() => { theme.colors = mode === 'light' ? lightColors : darkColors; });

    it('is not there until a listing is waiting', () => {
        const dom = draw(createElement(ChatAboutBanner, { styles, conversationId: 'c1' }));
        expect(dom.querySelector('[data-testid="chat-about-chip"]')).toBeNull();
    });

    it('reads "About: title · price", wraps whole, and the ✕ is at least 44 dp', () => {
        chatAboutDrafts.set('c1', aboutOfPost({ ...EGGS, title: LONG }));
        const dom = draw(createElement(ChatAboutBanner, { styles, conversationId: 'c1' }));
        const chip = dom.querySelector('[data-testid="chat-about-chip"]') as HTMLElement;
        expect(chip.textContent).toBe(`About: ${LONG.slice(0, 120)} · 6 Beans`);
        expect(dom.querySelectorAll('[data-lines]').length).toBe(0);
        const drop = dom.querySelector('[data-testid="chat-about-chip-drop"]') as HTMLElement;
        expect(drop.getAttribute('aria-label')).toBe('Leave this listing out of your message');
        expect(Number(drop.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(44);
        expect(Number(drop.getAttribute('data-min-width'))).toBeGreaterThanOrEqual(44);
    });

    it('goes with the ✕, and stays while the screen is redrawn (typing)', () => {
        chatAboutDrafts.set('c1', aboutOfPost(EGGS));
        const dom = draw(createElement(ChatAboutBanner, { styles, conversationId: 'c1' }));
        act(() => root!.render(createElement(ChatAboutBanner, { styles, conversationId: 'c1' })));
        expect(dom.querySelector('[data-testid="chat-about-chip"]')).not.toBeNull();
        act(() => { (dom.querySelector('[data-testid="chat-about-chip-drop"]') as HTMLElement).click(); });
        expect(dom.querySelector('[data-testid="chat-about-chip"]')).toBeNull();
        expect(chatAboutDrafts.get('c1')).toBeNull();
    });

    it('is one chat\'s: another conversation shows none', () => {
        chatAboutDrafts.set('c1', aboutOfPost(EGGS));
        const dom = draw(createElement(ChatAboutBanner, { styles, conversationId: 'c2' }));
        expect(dom.querySelector('[data-testid="chat-about-chip"]')).toBeNull();
    });
});
