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
import type { MessageActions } from '../chat-actions';

describe('ChatMessageActions render', () => {
    afterEach(() => {
        cleanup();
    });

    const dummyStyles: any = {
        actionButtonsContainer: {},
        actionButtonsMe: {},
        actionButtonsOther: {},
        circleActionButton: {},
        circleActionButtonActive: {},
        circleActionButtonDanger: {},
        editClosedText: {},
    };

    it('shows the explanation sentence when edit is closed, instead of the pencil', () => {
        const actions: MessageActions & { editClosed?: boolean } = {
            reply: true,
            react: true,
            edit: false,
            delete: true,
            remove: false,
            editClosed: true,
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

        expect(screen.getByText('You can edit a message for 15 minutes after sending it.')).toBeTruthy();
        expect(screen.queryByLabelText('Edit message')).toBeNull();
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
