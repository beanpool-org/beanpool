/**
 * "About this listing" in a chat (@beanpool/core chat-about.ts; Marty, 9 Nov): the chip above the composer after Message
 * on a listing, and the small card at the top of the bubble that carried it. The web draws the same two things
 * (apps/pwa/src/components/ChatAbout.tsx) from the same words.
 *
 * Presentational: the screen looks the listing up (utils/about-listings.ts) and hands the answer in, so a bubble stays free
 * of the database. The card is drawn with the reply quote's own styles, so it keeps its colours in light and dark, and its
 * text wraps at 320 dp with 1.3x text.
 */
import React, { useSyncExternalStore } from 'react';
import { View, Text, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    CHAT_ABOUT_WORDS, chatAboutCard, chatAboutChipWords, chatAboutDrafts, chatAboutOpenWords, t,
    type AboutPostLike, type ChatAbout, type ChatAboutChip,
} from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import type { ChatStyles } from './styles';

/** The chip waiting for the next message in this conversation, or null. */
export function useChatAboutDraft(conversationId: string | null | undefined): ChatAboutChip | null {
    return useSyncExternalStore(
        chatAboutDrafts.subscribe,
        () => chatAboutDrafts.get(conversationId),
        () => null,
    );
}

/** Above the composer: "About: Fresh eggs · 6 Beans", with a ✕ that leaves it out. Stays until sent or dropped. */
export function ChatAboutBanner({ styles, conversationId }: { styles: ChatStyles; conversationId: string }) {
    const { colors } = useTheme();
    const chip = useChatAboutDraft(conversationId);
    if (!chip) return null;
    return (
        <View style={styles.replyPreviewContainer} testID="chat-about-chip">
            <View style={styles.replyPreviewBar}>
                <View style={{ flex: 1, borderLeftWidth: 3, borderLeftColor: colors.accent.primary, paddingLeft: 8 }}>
                    <Text style={styles.replyPreviewText}>{chatAboutChipWords(chip)}</Text>
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t(CHAT_ABOUT_WORDS.drop)}
                    onPress={() => chatAboutDrafts.drop(conversationId)}
                    style={styles.replyPreviewClose}
                    testID="chat-about-chip-drop"
                >
                    <MaterialCommunityIcons name="close" size={20} color={colors.text.secondary} />
                </Pressable>
            </View>
        </View>
    );
}

interface CardProps {
    styles: ChatStyles;
    about: ChatAbout;
    /** The listing as this reader can read it: found, null (gone or hidden from them) or undefined (still being looked up). */
    live: AboutPostLike | null | undefined;
    isMe: boolean;
    onOpen: (postId: string) => void;
}

/** The card at the top of a bubble. A tap opens the listing; one this reader can't see says so and opens nothing. */
export function ChatAboutCard({ styles, about, live, isMe, onOpen }: CardProps) {
    const card = chatAboutCard(about, live);
    const box = [styles.quoteContainer, isMe ? styles.quoteMe : styles.quoteOther];
    const ink = isMe ? styles.quoteTextMe : styles.quoteTextOther;
    if (card.gone) {
        return (
            <View style={box} testID="chat-about-gone">
                <Text style={[styles.quoteText, ink, { fontStyle: 'italic' }]}>{card.goneWords}</Text>
            </View>
        );
    }
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityHint={chatAboutOpenWords(card.title)}
            onPress={() => onOpen(card.postId)}
            style={[...box, { minHeight: 44 }]}
            testID="chat-about-card"
        >
            <Text style={[styles.quoteText, ink, { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' }]}>{card.kindWords}</Text>
            <Text style={[styles.quoteAuthor, isMe ? styles.quoteAuthorMe : styles.quoteAuthorOther]}>{card.title}</Text>
            {card.price ? <Text style={[styles.quoteText, ink]}>{card.price}</Text> : null}
        </Pressable>
    );
}
