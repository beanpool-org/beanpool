// @vitest-environment jsdom
/**
 * Phone chats: press and hold a message, then Copy (Marty, 9 Nov: "I can't select and copy text from previous messages").
 *
 * 1. The rule (chat-actions canCopyMessage / messageActions): words of any line the member can read, in every kind of chat
 *    (an event chat's ordinary member too); never a system line, a deleted or removed line, a line shown as nobody's, a photo
 *    with no caption.
 * 2. Press and hold opens what a tap opens, never closes it; Copy puts the line's words on the clipboard and says "Copied".
 * 3. A screen reader gets a "Copy message" action on the bubble itself.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { createElement, useState } from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
vi.mock('expo-clipboard', () => clipboard);

const announce = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => {
    const el = (tag: string) => function MockHost({ children, onPress, onLongPress, accessibilityLabel, accessibilityActions, onAccessibilityAction, accessibilityRole, accessibilityState, accessibilityHint, style, ...rest }: any) {
        // React Native gives a touch to ONE responder: a Text or Pressable with its own press handler keeps a hold to itself
        // (a link, the Copy button), and the DOM's bubbling must not hand it on to the bubble.
        const isResponder = !!(onPress || onLongPress);
        return createElement(tag, {
            onClick: onPress,
            // A long press has no DOM event of its own: the context menu stands in for it.
            onContextMenu: isResponder ? (e: any) => { e.preventDefault(); e.stopPropagation(); onLongPress?.(e); } : undefined,
            'aria-label': accessibilityLabel,
            role: accessibilityRole === 'button' ? undefined : accessibilityRole,
            ref: (node: any) => { if (node) { node.__actions = accessibilityActions; node.__onAction = onAccessibilityAction; } },
            ...rest,
        }, children);
    };
    return {
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        StyleSheet: { create: (s: any) => s },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        AccessibilityInfo: { announceForAccessibility: announce },
    };
});

vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({
        colors: {
            text: { inverse: '#ffffff', onAccent: '#ffffff', muted: '#647664', body: '#1d231d' },
            accent: { fill: '#647664' },
            surface: { subtle: '#eef1ee' },
            feedback: { danger: { solid: '#c2583b' } },
        },
    }),
}));

import { ChatMessageRow } from '../../components/chat/ChatMessageRow';
import { COPIED_SHOWN_MS } from '../../components/chat/useCopyMessage';
import { canCopyMessage, hasAnyAction, messageActions, type ChatMessage, type ChatKind, type ChatViewer } from '../chat-actions';

const styles: any = new Proxy({}, { get: () => ({}) });
const ME = 'my-pubkey';
const THEM = 'their-pubkey';

function line(over: Partial<ChatMessage> = {}): ChatMessage {
    return { id: 'm1', senderId: THEM, text: 'Bring the ladder\nand a thermos', rawTimestamp: new Date().toISOString(), timestamp: '14:00', ...over };
}

function viewer(kind: ChatKind, over: Partial<ChatViewer> = {}): ChatViewer {
    return { kind, myPubkey: ME, canPost: true, ...over };
}

describe('canCopyMessage: which lines offer Copy', () => {
    it('is true for the words of a line, in every kind of chat', () => {
        for (const kind of ['dm', 'group', 'enterprise', 'event'] as ChatKind[]) {
            expect(canCopyMessage(line()), kind).toBe(true);
            expect(messageActions(line(), viewer(kind)).copy, kind).toBe(true);
        }
    });

    it('is true for an event chat member who is not the host, who had no action at all before', () => {
        const actions = messageActions(line(), viewer('event', { canPost: true, isModerator: false }));
        expect(actions.reply).toBe(false);
        expect(actions.remove).toBe(false);
        expect(actions.copy).toBe(true);
        expect(hasAnyAction(actions)).toBe(true);
    });

    it('is true in a read-only chat: copying sends nothing to anyone', () => {
        const actions = messageActions(line(), viewer('group', { canPost: false }));
        expect(actions.copy).toBe(true);
    });

    it('is false for a deleted line, a removed line, a system line, a line shown as nobody\'s, and a photo with no caption', () => {
        expect(canCopyMessage(line({ type: 'removed', text: 'This message was deleted' }))).toBe(false);
        expect(canCopyMessage(line({ metadata: { removed: true }, text: 'Removed by a convenor' }))).toBe(false);
        expect(canCopyMessage(line({ type: 'system', text: 'Ana joined' }))).toBe(false);
        expect(canCopyMessage(line({ senderId: 'SYSTEM', text: 'x' }))).toBe(false);
        expect(canCopyMessage(line({ unattributed: true, text: 'Could not be opened' }))).toBe(false);
        expect(canCopyMessage(line({ type: 'image', text: '' }))).toBe(false);
        expect(canCopyMessage(line({ text: '   ' }))).toBe(false);
    });

    it('is true for a photo with a caption: the caption', () => {
        expect(canCopyMessage(line({ type: 'image', text: 'The back gate' }))).toBe(true);
    });
});

/** A row the way a screen holds it: tapping or holding the bubble opens its bar. */
function Row({ item, kind = 'dm', onPressUrl }: { item: ChatMessage; kind?: ChatKind; onPressUrl?: (url: string) => void }) {
    const [open, setOpen] = useState(false);
    const actions = messageActions(item, viewer(kind));
    return createElement(ChatMessageRow, {
        item, isMe: item.senderId === ME, styles, kind, actions,
        showActions: open, showEmojiPicker: false, pickerPosition: 'top',
        onPressBubble: () => { if (hasAnyAction(actions)) setOpen((v) => !v); },
        onReply: () => {}, onToggleEmojiPicker: () => {}, onEdit: () => {}, onDelete: () => {}, onRemove: () => {}, onPickEmoji: () => {},
        onPressUrl,
    } as any);
}

const bubbleOf = (container: HTMLElement) => container.querySelector('button') as HTMLButtonElement;

describe('Press and hold a message, then Copy', () => {
    beforeEach(() => { clipboard.setStringAsync.mockClear(); announce.mockClear(); });
    afterEach(() => { cleanup(); vi.useRealTimers(); });

    it('a long press opens the bar with Copy; Copy writes the line\'s words and says Copied', async () => {
        const { container } = render(createElement(Row, { item: line() }));
        expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();

        fireEvent.contextMenu(bubbleOf(container));
        const copy = screen.getByRole('button', { name: 'Copy message' });
        expect(copy.textContent).toContain('Copy message');

        await act(async () => { fireEvent.click(copy); });
        expect(clipboard.setStringAsync).toHaveBeenCalledTimes(1);
        expect(clipboard.setStringAsync).toHaveBeenCalledWith('Bring the ladder\nand a thermos');
        // The button's name is the words it shows (WCAG 2.5.3), "Copied" included.
        expect(screen.getByRole('button', { name: 'Copied' }).textContent).toContain('Copied');
        expect(announce).toHaveBeenCalledWith('Copied');
    });

    it('goes back to "Copy message" after a moment', async () => {
        vi.useFakeTimers();
        const { container } = render(createElement(Row, { item: line() }));
        fireEvent.contextMenu(bubbleOf(container));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy message' })); });
        expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
        await act(async () => { vi.advanceTimersByTime(COPIED_SHOWN_MS + 50); });
        expect(screen.getByRole('button', { name: 'Copy message' }).textContent).toContain('Copy message');
    });

    it('a hold that lands on a link opens the bar too, so a link someone sent can be copied', async () => {
        const url = 'https://example.org/working-bee';
        const { container } = render(createElement(Row, { item: line({ text: `Plans are at ${url}` }), onPressUrl: () => {} }));
        const link = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === url) as HTMLElement;
        expect(link).toBeTruthy();
        fireEvent.contextMenu(link);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy message' })); });
        expect(clipboard.setStringAsync).toHaveBeenCalledWith(`Plans are at ${url}`);
    });

    it('a second hold does not close the bar', () => {
        const { container } = render(createElement(Row, { item: line() }));
        fireEvent.contextMenu(bubbleOf(container));
        fireEvent.contextMenu(bubbleOf(container));
        expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
    });

    it('says so when the clipboard refuses, and puts nothing else on it', async () => {
        clipboard.setStringAsync.mockRejectedValueOnce(new Error('no clipboard'));
        const { container } = render(createElement(Row, { item: line() }));
        fireEvent.contextMenu(bubbleOf(container));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy message' })); });
        expect(screen.getByRole('button', { name: 'Could not copy' }).textContent).toContain('Could not copy');
        expect(announce).toHaveBeenCalledWith('Could not copy');
    });

    it("copies the member's own line too, and an event chat member's, and a group chat's", async () => {
        for (const [kind, item] of [['dm', line({ senderId: ME, text: 'Mine' })], ['event', line({ text: 'Event words' })], ['group', line({ text: 'Group words' })]] as const) {
            clipboard.setStringAsync.mockClear();
            const { container, unmount } = render(createElement(Row, { item, kind }));
            fireEvent.contextMenu(bubbleOf(container));
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy message' })); });
            expect(clipboard.setStringAsync, kind).toHaveBeenCalledWith(item.text);
            unmount();
        }
    });

    it('a deleted line offers nothing to hold: no Copy, nothing on the clipboard', () => {
        const { container } = render(createElement(Row, { item: line({ type: 'removed', text: 'This message was deleted' }) }));
        fireEvent.contextMenu(bubbleOf(container));
        expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
        expect(clipboard.setStringAsync).not.toHaveBeenCalled();
    });

    it('gives a screen reader a "Copy message" action on the bubble, which copies without opening the bar', async () => {
        const { container } = render(createElement(Row, { item: line() }));
        const bubble = bubbleOf(container) as any;
        expect(bubble.__actions).toEqual([{ name: 'copyMessage', label: 'Copy message' }]);
        await act(async () => { bubble.__onAction({ nativeEvent: { actionName: 'copyMessage' } }); });
        await waitFor(() => expect(clipboard.setStringAsync).toHaveBeenCalledWith('Bring the ladder\nand a thermos'));
        expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
    });

    it('gives a deleted line no such action', () => {
        const { container } = render(createElement(Row, { item: line({ type: 'removed', text: 'This message was deleted' }) }));
        expect((bubbleOf(container) as any).__actions).toBeUndefined();
    });
});

// Keeps the React import used under the automatic JSX runtime.
void React;
