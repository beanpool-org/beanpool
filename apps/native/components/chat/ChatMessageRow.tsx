/**
 * One row of the thread: the bubble, the action buttons beside it and the emoji picker above it.
 *
 * The layout is the DM screen's — buttons on the inside of the bubble (left of my own, right of someone
 * else's), the picker overflowing the row by 45dp — and it is here so a group chat gets exactly the same
 * gestures rather than an approximation of them.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import type { ChatMessage, MessageActions, ChatKind } from '../../utils/chat-actions';
import { ChatBubble, type ChatQuote } from './ChatBubble';
import { ChatEmojiPicker, ChatMessageActions } from './ChatMessageActions';
import type { ChatStyles } from './styles';

interface Props {
    item: ChatMessage;
    isMe: boolean;
    styles: ChatStyles;
    /** Which chat this is, for the bubble's tombstone wording. */
    kind: ChatKind;
    actions: MessageActions;
    showActions: boolean;
    showEmojiPicker: boolean;
    pickerPosition: 'top' | 'bottom';
    onPressBubble: (event: any) => void;
    onReply: () => void;
    onToggleEmojiPicker: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onRemove: () => void;
    /** Report this message (a locked group chat's line): only where actions.report offers it. */
    onReport?: () => void;
    onPickEmoji: (emoji: string) => void;
    onPressUrl: (url: string) => void;
    authorLabel?: string | null;
    quote?: ChatQuote | null;
    attachment?: React.ReactNode;
    status?: React.ReactNode;
    footer?: React.ReactNode;
    /** The member is editing this message: its bubble shows it whole. */
    editing?: boolean;
}

export function ChatMessageRow({
    item, isMe, styles, kind, actions, showActions, showEmojiPicker, pickerPosition,
    onPressBubble, onReply, onToggleEmojiPicker, onEdit, onDelete, onRemove, onReport, onPickEmoji, onPressUrl,
    authorLabel, quote, attachment, status, footer, editing,
}: Props) {
    const actionBar = showActions ? (
        <ChatMessageActions
            actions={actions}
            isMe={isMe}
            styles={styles}
            emojiPickerOpen={showEmojiPicker}
            onReply={onReply}
            onToggleEmojiPicker={onToggleEmojiPicker}
            onEdit={onEdit}
            onDelete={onDelete}
            onRemove={onRemove}
        />
    ) : null;
    const { colors } = useTheme();

    return (
        <View style={[styles.messageRowContainer, isMe ? styles.messageRowMe : styles.messageRowOther]}>
            {showEmojiPicker && (
                <ChatEmojiPicker isMe={isMe} styles={styles} position={pickerPosition} onPick={onPickEmoji} />
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', maxWidth: '85%' }}>
                {isMe && actionBar}
                <ChatBubble
                    item={item}
                    isMe={isMe}
                    styles={styles}
                    kind={kind}
                    authorLabel={authorLabel}
                    quote={quote}
                    onPress={onPressBubble}
                    onPressUrl={onPressUrl}
                    attachment={attachment}
                    status={status}
                    footer={footer}
                    editing={editing}
                />
                {!isMe && actionBar}
            </View>
            {showActions && actions.editClosed && (
                <View style={[styles.editClosedBacking, isMe && { alignSelf: 'flex-end' }]}>
                    <Text style={styles.editClosedText}>
                        {t('You can edit a message for 15 minutes after sending it.')}
                    </Text>
                </View>
            )}
            {/* Under the line, not a fourth round button: beside a wide bubble at 320dp those already reach the edge. */}
            {showActions && actions.report && onReport && (
                <Pressable accessibilityRole="button" accessibilityLabel={t('Report message')} onPress={onReport} style={[styles.reportLineButton, isMe && { alignSelf: 'flex-end' }]}>
                    <MaterialCommunityIcons name="flag-outline" size={18} color={colors.text.body} />
                    <Text style={styles.reportLineText}>{t('Report message')}</Text>
                </Pressable>
            )}
        </View>
    );
}
