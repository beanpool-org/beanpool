/**
 * One row of the thread: the bubble, the action buttons beside it and the emoji picker above it.
 *
 * The layout is the DM screen's — buttons on the inside of the bubble (left of my own, right of someone
 * else's), the picker overflowing the row by 45dp — and it is here so a group chat gets exactly the same
 * gestures rather than an approximation of them.
 */

import React from 'react';
import { View } from 'react-native';
import type { ChatMessage, MessageActions } from '../../utils/chat-actions';
import { ChatBubble, type ChatQuote } from './ChatBubble';
import { ChatEmojiPicker, ChatMessageActions } from './ChatMessageActions';
import type { ChatStyles } from './styles';

interface Props {
    item: ChatMessage;
    isMe: boolean;
    styles: ChatStyles;
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
    onPickEmoji: (emoji: string) => void;
    onPressUrl: (url: string) => void;
    authorLabel?: string | null;
    quote?: ChatQuote | null;
    attachment?: React.ReactNode;
    status?: React.ReactNode;
    footer?: React.ReactNode;
}

export function ChatMessageRow({
    item, isMe, styles, actions, showActions, showEmojiPicker, pickerPosition,
    onPressBubble, onReply, onToggleEmojiPicker, onEdit, onDelete, onRemove, onPickEmoji, onPressUrl,
    authorLabel, quote, attachment, status, footer,
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
                    authorLabel={authorLabel}
                    quote={quote}
                    onPress={onPressBubble}
                    onPressUrl={onPressUrl}
                    attachment={attachment}
                    status={status}
                    footer={footer}
                />
                {!isMe && actionBar}
            </View>
        </View>
    );
}
