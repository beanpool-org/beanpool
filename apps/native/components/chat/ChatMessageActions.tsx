/**
 * What tapping a bubble offers, and the seven-emoji row.
 *
 * The buttons a message actually gets come from utils/chat-actions, so a DM, a group chat, an enterprise
 * thread and an event chat all ask the same question and can never disagree about the answer.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../app/ThemeContext';
import { CHAT_REACTION_EMOJIS, type MessageActions } from '../../utils/chat-actions';
import type { ChatStyles } from './styles';

interface ActionsProps {
    actions: MessageActions;
    isMe: boolean;
    styles: ChatStyles;
    emojiPickerOpen: boolean;
    onReply: () => void;
    onToggleEmojiPicker: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onRemove: () => void;
}

export function ChatMessageActions({
    actions, isMe, styles, emojiPickerOpen, onReply, onToggleEmojiPicker, onEdit, onDelete, onRemove,
}: ActionsProps) {
    const { colors } = useTheme();
    return (
        <View style={[styles.actionButtonsContainer, isMe ? styles.actionButtonsMe : styles.actionButtonsOther]}>
            {actions.reply && (
                <Pressable accessibilityRole="button" accessibilityLabel="Reply" style={styles.circleActionButton} onPress={onReply}>
                    <MaterialCommunityIcons name="reply" size={16} color={colors.text.inverse} />
                </Pressable>
            )}
            {actions.react && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="React"
                    accessibilityState={{ expanded: emojiPickerOpen }}
                    style={[styles.circleActionButton, emojiPickerOpen ? styles.circleActionButtonActive : {}]}
                    onPress={onToggleEmojiPicker}
                >
                    <MaterialCommunityIcons name="emoticon-happy-outline" size={16} color={colors.text.inverse} />
                </Pressable>
            )}
            {actions.edit && (
                <Pressable accessibilityRole="button" accessibilityLabel="Edit message" style={styles.circleActionButton} onPress={onEdit}>
                    <MaterialCommunityIcons name="pencil" size={15} color={colors.text.inverse} />
                </Pressable>
            )}
            {actions.delete && (
                <Pressable accessibilityRole="button" accessibilityLabel="Delete message" style={styles.circleActionButton} onPress={onDelete}>
                    <MaterialCommunityIcons name="delete-outline" size={16} color={colors.text.inverse} />
                </Pressable>
            )}
            {actions.remove && (
                <Pressable accessibilityRole="button" accessibilityLabel="Remove this message" style={[styles.circleActionButton, styles.circleActionButtonDanger]} onPress={onRemove}>
                    <MaterialCommunityIcons name="close-octagon-outline" size={16} color={colors.text.inverse} />
                </Pressable>
            )}
        </View>
    );
}

interface PickerProps {
    isMe: boolean;
    styles: ChatStyles;
    /** Below the bubble when the bubble is near the top of the screen, above it otherwise. */
    position: 'top' | 'bottom';
    onPick: (emoji: string) => void;
}

export function ChatEmojiPicker({ isMe, styles, position, onPick }: PickerProps) {
    return (
        <View style={[
            styles.reactionPickerContainer,
            isMe ? styles.reactionPickerMe : styles.reactionPickerOther,
            position === 'bottom' ? { top: undefined, bottom: -45 } : { bottom: undefined, top: -45 },
        ]}>
            {CHAT_REACTION_EMOJIS.map(emoji => (
                <Pressable
                    key={emoji}
                    accessibilityRole="button"
                    accessibilityLabel={`React with ${emoji}`}
                    style={styles.reactionEmojiButton}
                    onPress={() => onPick(emoji)}
                >
                    <Text style={styles.reactionEmojiText}>{emoji}</Text>
                </Pressable>
            ))}
        </View>
    );
}
