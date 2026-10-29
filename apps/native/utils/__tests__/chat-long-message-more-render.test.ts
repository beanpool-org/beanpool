// @vitest-environment jsdom
/**
 * A long message folds with "…more", in a one-to-one chat and in a group (components/chat/ChatBubble.tsx, ChatFold.tsx),
 * rendered for real: react-dom in jsdom with React Native's host components as plain tags.
 *
 * The stand-in for the phone's text layout is the part that matters, so it is a model of what the platform does: a Text
 * with an onTextLayout reports its lines after it is drawn, at 32 characters a line at 320 dp, and a Text with numberOfLines
 * reports (and draws) no more than that many. `LAYOUT_REPORTS` flips the other behaviour a platform has been seen to have,
 * reporting every line it has however many it drew. The fold must hold either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const layout = vi.hoisted(() => ({ width: 320, reports: 'drawn' as 'drawn' | 'all' }));

vi.mock('react-native', () => {
    /** Lines the text comes to: each paragraph wraps every (width / 10) characters. */
    const linesOf = (text: string) => text.split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.length / Math.floor(layout.width / 10))), 0);
    function MockText({ children, onPress, numberOfLines, onTextLayout, style: _style, accessibilityRole: _role, ...rest }: any) {
        const ref = useRef<HTMLSpanElement>(null);
        useEffect(() => {
            if (!onTextLayout || !ref.current) return;
            const all = linesOf(ref.current.textContent ?? '');
            const drawn = layout.reports === 'all' ? all : Math.min(all, numberOfLines ?? all);
            onTextLayout({ nativeEvent: { lines: Array.from({ length: drawn }, () => ({})) } });
        });
        return createElement('span', { ref, onClick: onPress, 'data-lines': numberOfLines, ...rest }, children);
    }
    const host = (tag: string) => function MockHost({ children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, style: _style, ...rest }: any) {
        return createElement(tag, {
            onClick: disabled ? undefined : onPress,
            'aria-label': accessibilityLabel,
            'aria-expanded': accessibilityState?.expanded,
            role: accessibilityRole === 'button' ? 'button' : undefined,
            ...rest,
        }, children);
    };
    return {
        View: host('div'),
        Text: MockText,
        Pressable: host('button'),
        StyleSheet: { create: (s: any) => s },
        useWindowDimensions: () => ({ width: layout.width, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => ({ colors: { text: { body: '#222' } } }) }));

import { ChatMessageRow } from '../../components/chat/ChatMessageRow';
import { ChatFoldProvider } from '../../components/chat/ChatFold';
import type { ChatKind, ChatMessage, MessageActions } from '../chat-actions';

const fortyLines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long note`).join('\n');
const threeLines = 'First line\nSecond line\nThird line';
const aLongParagraph = 'word '.repeat(80).trim(); // 399 characters: 13 lines at 32 a line, 4 at 100.

const noActions = {} as MessageActions;
const message = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, senderId: 'peer', text, type: 'text', timestamp: '12:14', ...extra });

function row(item: ChatMessage, kind: ChatKind, extra: Record<string, unknown> = {}) {
    return createElement(ChatMessageRow, {
        key: item.id, item, kind, isMe: false, styles: {} as any, actions: noActions, showActions: false, showEmojiPicker: false, pickerPosition: 'top',
        onPressBubble: () => { }, onReply: () => { }, onToggleEmojiPicker: () => { }, onEdit: () => { }, onDelete: () => { }, onRemove: () => { },
        onPickEmoji: () => { }, onPressUrl: () => { },
        authorLabel: kind === 'dm' ? null : 'Sam',
        ...extra,
    });
}
const inList = (...rows: ReturnType<typeof row>[]) => createElement(ChatFoldProvider, null, ...rows);

/** The bubble's words: the Text that carries the message (the one with numberOfLines while it is measured or folded). */
const words = (container: HTMLElement, startsWith: string) =>
    Array.from(container.querySelectorAll('span')).find((s) => (s.textContent ?? '').startsWith(startsWith)) as HTMLElement;

describe.each([['dm' as ChatKind], ['group' as ChatKind]])('a long message folds with …more (%s)', (kind) => {
    beforeEach(() => { layout.width = 320; layout.reports = 'drawn'; });
    afterEach(cleanup);

    it('a 40-line message folds to twelve lines under …more, opens in place, and folds again', () => {
        const { container } = render(inList(row(message('m1', fortyLines), kind)));

        const more = screen.getByRole('button', { name: 'Show the whole message' });
        expect(more.textContent).toBe('…more');
        expect(more.getAttribute('aria-expanded')).toBe('false');
        expect(words(container, 'Line 1 of').getAttribute('data-lines')).toBe('12');

        fireEvent.click(more);
        const less = screen.getByRole('button', { name: 'Show less' });
        expect(less.textContent).toBe('less');
        expect(less.getAttribute('aria-expanded')).toBe('true');
        expect(words(container, 'Line 1 of').getAttribute('data-lines')).toBeNull();
        // The whole message is in the tree, folded or not: a screen reader reaches all of it.
        expect(container.textContent).toContain('Line 40 of a long note');

        fireEvent.click(less);
        expect(screen.getByRole('button', { name: 'Show the whole message' }).textContent).toBe('…more');
        expect(words(container, 'Line 1 of').getAttribute('data-lines')).toBe('12');
        expect(container.textContent).toContain('Line 40 of a long note');
    });

    it('a 3-line message never shows the control, and is drawn as it always was', () => {
        const { container } = render(inList(row(message('m2', threeLines), kind)));
        expect(screen.queryByRole('button', { name: /whole message|Show less/ })).toBeNull();
        const text = words(container, 'First line');
        expect(text.getAttribute('data-lines')).toBeNull();
        // Its time still trails the words in the same Text.
        expect(text.textContent).toBe('First line\nSecond line\nThird line  12:14');
    });

    it('a message of exactly twelve lines stays whole', () => {
        const twelve = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n');
        const { container } = render(inList(row(message('m3', twelve), kind)));
        expect(screen.queryByRole('button', { name: 'Show the whole message' })).toBeNull();
        expect(words(container, 'Line 1').getAttribute('data-lines')).toBeNull();
    });

    it('folds a long message of one paragraph by where the lines really break, and again when the width changes', () => {
        const { rerender, container } = render(inList(row(message('m4', aLongParagraph), kind)));
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy();

        // A wide window: the same words come to four lines, so nothing folds.
        layout.width = 1000;
        rerender(inList(row(message('m4', aLongParagraph), kind)));
        expect(screen.queryByRole('button', { name: 'Show the whole message' })).toBeNull();
        expect(words(container, 'word word').getAttribute('data-lines')).toBeNull();

        layout.width = 320;
        rerender(inList(row(message('m4', aLongParagraph), kind)));
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
    });

    it('folds the same when the platform reports every line it has, not only the ones it drew', () => {
        layout.reports = 'all';
        render(inList(row(message('m5', fortyLines), kind)));
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Show the whole message' }));
        expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    });

    it('keeps its time and status on the line with the button, where the clamp cannot cut them off', () => {
        const status = createElement('span', { 'data-testid': 'status' }, ' ✓✓');
        render(inList(row(message('m6', fortyLines), kind, { status }), row(message('m7', threeLines), kind, { status })));
        const more = screen.getByRole('button', { name: 'Show the whole message' });
        const footer = more.parentElement as HTMLElement;
        expect(footer.textContent).toContain('12:14');
        expect(footer.querySelector('[data-testid="status"]')).toBeTruthy();
        expect(screen.getAllByTestId('status')).toHaveLength(2);
    });

    it('opening one message leaves the others folded, and the open one stays open for the life of the list', () => {
        const a = row(message('a', fortyLines), kind);
        const b = row(message('b', fortyLines.replace(/Line/g, 'Item')), kind);
        const { rerender } = render(inList(a, b));
        fireEvent.click(screen.getAllByRole('button', { name: 'Show the whole message' })[0]);
        expect(screen.getAllByRole('button', { name: 'Show less' })).toHaveLength(1);
        expect(screen.getAllByRole('button', { name: 'Show the whole message' })).toHaveLength(1);

        // The list scrolls it away and back (its row unmounts, then mounts): it is still open.
        rerender(inList(b));
        rerender(inList(a, b));
        expect(screen.getAllByRole('button', { name: 'Show less' })).toHaveLength(1);
    });

    it('never folds a message the member is editing, and folds it again after', () => {
        const { rerender, container } = render(inList(row(message('e', fortyLines), kind, { isMe: true, editing: true })));
        expect(screen.queryByRole('button', { name: /whole message|Show less/ })).toBeNull();
        expect(words(container, 'Line 1 of').getAttribute('data-lines')).toBeNull();
        rerender(inList(row(message('e', fortyLines), kind, { isMe: true, editing: false })));
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
    });

    it('a removed message is never folded', () => {
        render(inList(row(message('r', fortyLines, { type: 'removed' }), kind)));
        expect(screen.queryByRole('button', { name: /whole message|Show less/ })).toBeNull();
    });
});

describe('a bubble outside a list keeps its own open state', () => {
    beforeEach(() => { layout.width = 320; layout.reports = 'drawn'; });
    afterEach(cleanup);

    it('opens and folds without the provider', () => {
        render(row(message('solo', fortyLines), 'dm'));
        act(() => { fireEvent.click(screen.getByRole('button', { name: 'Show the whole message' })); });
        expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    });
});
