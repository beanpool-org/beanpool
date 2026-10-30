// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('react-native', () => {
    const el = (tag: string) => function MockHost({ children, onPress, accessibilityLabel, style, ...rest }: any) {
        return createElement(tag, {
            onClick: onPress,
            'aria-label': accessibilityLabel,
            ...rest,
        }, children);
    };
    return {
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        StyleSheet: { create: (s: any) => s },
        // The bubble measures a long message against the window (components/chat/ChatFold.tsx).
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({
        colors: {
            text: { inverse: '#ffffff', onAccent: '#ffffff', muted: '#647664' },
            accent: { fill: '#647664' },
            surface: { subtle: '#eef1ee' },
            feedback: { danger: { solid: '#c2583b' } },
        },
    }),
}));

import { ChatMessageActions } from '../../components/chat/ChatMessageActions';
import { ChatMessageRow } from '../../components/chat/ChatMessageRow';
import type { MessageActions, ChatMessage } from '../chat-actions';

const SCREEN_WIDTH = 320;
const FONT_SCALE = 1.3;
const ROW_MAX_WIDTH = 245; // 85% of (320 - 32 list padding) ≈ 245 dp
const BUTTON_SIZE = 32;
const BUTTON_GAP = 6;
const GLYPH_EM = 0.52;

function measureActionRow(container: HTMLElement) {
    const actionRow = (container.querySelector('[aria-label="Delete message"]')?.parentElement ?? container.firstElementChild) as HTMLElement;
    const buttons = actionRow.querySelectorAll('button');
    const textNodes = Array.from(actionRow.childNodes).filter((n) => n.nodeName === 'SPAN' || n.nodeName === 'DIV' || n.nodeType === 3);

    let textWidth = 0;
    for (const node of textNodes) {
        const text = node.textContent ?? '';
        if (text) {
            textWidth += text.length * 11 * FONT_SCALE * GLYPH_EM;
        }
    }
    const numItems = buttons.length + (textNodes.length > 0 ? textNodes.length : 0);
    const gaps = Math.max(0, numItems - 1) * BUTTON_GAP;
    const totalWidth = (buttons.length * BUTTON_SIZE) + textWidth + gaps;

    const deleteBtn = container.querySelector('[aria-label="Delete message"]');
    let deleteOffset = 16;
    if (deleteBtn && actionRow.contains(deleteBtn)) {
        for (const child of Array.from(actionRow.children)) {
            if (child === deleteBtn) break;
            if (child.tagName === 'BUTTON') {
                deleteOffset += BUTTON_SIZE + BUTTON_GAP;
            } else {
                deleteOffset += (child.textContent?.length ?? 0) * 11 * FONT_SCALE * GLYPH_EM + BUTTON_GAP;
            }
        }
    }
    return {
        actionRow,
        totalWidth,
        deleteOffset,
        hasTextInRow: textNodes.some((n) => (n.textContent ?? '').length > 0),
    };
}

describe('ChatMessageActions render', () => {
    afterEach(() => {
        cleanup();
    });

    const dummyStyles: any = {
        messageRowContainer: {},
        messageRowMe: {},
        messageRowOther: {},
        actionButtonsContainer: { flexDirection: 'row', gap: 6, alignItems: 'center' },
        actionButtonsMe: {},
        actionButtonsOther: {},
        circleActionButton: { width: 32, height: 32 },
        circleActionButtonActive: {},
        circleActionButtonDanger: {},
        editClosedBacking: {},
        editClosedText: { fontSize: 11, lineHeight: 14, flexShrink: 1 },
        bubbleContainer: {},
        bubbleMe: {},
        bubbleOther: {},
        bubbleText: {},
        bubbleTextMe: {},
        bubbleTextOther: {},
        timestamp: {},
        timestampMe: {},
        timestampOther: {},
        statusTicks: {},
        reactionBadge: {},
        reactionText: {},
    };

    it('at 320 dp with 1.3x font and editClosed: action row width <= row, Delete reachable, sentence on its own line', () => {
        const actions: MessageActions & { editClosed?: boolean } = {
            reply: true,
            react: true,
            edit: false,
            delete: true,
            remove: false,
            editClosed: true,
        };

        const item: ChatMessage = {
            id: 'm1',
            senderId: 'my-pubkey',
            text: 'ok',
            rawTimestamp: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
            timestamp: '14:00',
        };

        const { container } = render(
            createElement(ChatMessageRow, {
                item,
                isMe: true,
                styles: dummyStyles,
                kind: 'dm',
                actions: actions as any,
                showActions: true,
                showEmojiPicker: false,
                pickerPosition: 'top',
                onPressBubble: vi.fn(),
                onReply: vi.fn(),
                onToggleEmojiPicker: vi.fn(),
                onEdit: vi.fn(),
                onDelete: vi.fn(),
                onRemove: vi.fn(),
                onPickEmoji: vi.fn(),
                onPressUrl: vi.fn(),
            })
        );

        const measured = measureActionRow(container);

        // 1. Action row width <= row maxWidth (245 dp)
        expect(measured.totalWidth).toBeLessThanOrEqual(ROW_MAX_WIDTH);

        // 2. Delete button is reachable within screen width (320 dp)
        expect(measured.deleteOffset + BUTTON_SIZE).toBeLessThanOrEqual(SCREEN_WIDTH);

        // 3. Sentence sits on its own line under the action row (not inside actionButtonsContainer)
        expect(measured.hasTextInRow).toBe(false);
        const sentence = screen.getByText('You can edit a message for 15 minutes after sending it.');
        expect(measured.actionRow.contains(sentence)).toBe(false);

        // 4. Edit button (pencil) is omitted
        expect(screen.queryByLabelText('Edit message')).toBeNull();

        // 5. The sentence wraps within the row's width (longest word fits row width)
        const words = sentence.textContent!.split(/\s+/);
        const longestWordWidth = Math.max(...words.map((w) => w.length)) * 11 * FONT_SCALE * 0.62;
        expect(longestWordWidth).toBeLessThan(ROW_MAX_WIDTH);
    });

    it('shows the pencil and no explanation when edit is allowed', () => {
        const actions: MessageActions & { editClosed?: boolean } = {
            reply: true,
            react: true,
            edit: true,
            delete: true,
            remove: false,
            editClosed: false,
        };

        render(
            createElement(ChatMessageActions, {
                actions: actions as any,
                isMe: true,
                styles: dummyStyles,
                emojiPickerOpen: false,
                onReply: vi.fn(),
                onToggleEmojiPicker: vi.fn(),
                onEdit: vi.fn(),
                onDelete: vi.fn(),
                onRemove: vi.fn(),
            })
        );

        expect(screen.getByLabelText('Edit message')).toBeTruthy();
        expect(screen.queryByText('You can edit a message for 15 minutes after sending it.')).toBeNull();
    });
});
