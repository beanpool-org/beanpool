/**
 * "About this listing" in a chat (@beanpool/core chat-about.ts; Marty, 9 Nov): the chip above the composer after Message
 * on a listing, and the small card at the top of the bubble that carried it. The web draws the same two things
 * (apps/pwa/src/components/ChatAbout.tsx) from the same words.
 *
 * Presentational: the screen looks the listing up (utils/about-listings.ts) and hands the answer in, so a bubble stays free
 * of the database. The card is drawn from the reply quote's own colour tokens (chat/styles.ts quote*, replyPreview*) in a
 * table of its own below, so it keeps its colours in light and dark, its text wraps at 320 dp with 1.3x text, and the
 * contrast check (utils/button-contrast.ts) reads every colour pair it draws: a table handed in as a prop is not readable.
 */
import React, { useMemo, useSyncExternalStore } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    CHAT_ABOUT_WORDS, chatAboutCard, chatAboutChipWords, chatAboutDrafts, chatAboutOpenWords, t,
    type AboutPostLike, type ChatAbout, type ChatAboutChip,
} from '@beanpool/core';
import { useTheme, type ThemeContextType } from '../../app/ThemeContext';

/**
 * The chip and the card, from the colour tokens the reply quote and the reply preview use (chat/styles.ts), so the card sits in a
 * bubble as a quote does: my bubble's quote ground and ink on mine, the other's on theirs.
 */
const makeAboutStyles = (colors: ThemeContextType['colors']) => StyleSheet.create({
    chipBox: { backgroundColor: colors.surface.app, borderTopWidth: 1, borderTopColor: colors.border.default, paddingHorizontal: 16, paddingVertical: 10 },
    chipBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    chipEdge: { flex: 1, borderLeftWidth: 3, borderLeftColor: colors.accent.primary, paddingLeft: 8 },
    chipText: { fontSize: 14, color: colors.text.secondary },
    chipClose: { padding: 4, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },

    cardMe: { padding: 8, borderRadius: 8, marginBottom: 6, borderLeftWidth: 3, maxWidth: '100%', minHeight: 44, backgroundColor: colors.chat.quoteMeBg, borderLeftColor: colors.chat.messageTextMe },
    cardOther: { padding: 8, borderRadius: 8, marginBottom: 6, borderLeftWidth: 3, maxWidth: '100%', minHeight: 44, backgroundColor: colors.chat.quoteOtherBg, borderLeftColor: colors.accent.primary },
    goneMe: { padding: 8, borderRadius: 8, marginBottom: 6, borderLeftWidth: 3, maxWidth: '100%', backgroundColor: colors.chat.quoteMeBg, borderLeftColor: colors.chat.messageTextMe },
    goneOther: { padding: 8, borderRadius: 8, marginBottom: 6, borderLeftWidth: 3, maxWidth: '100%', backgroundColor: colors.chat.quoteOtherBg, borderLeftColor: colors.accent.primary },
    goneTextMe: { fontSize: 13, fontStyle: 'italic', color: colors.chat.quoteTextMe },
    goneTextOther: { fontSize: 13, fontStyle: 'italic', color: colors.text.secondary },
    kindMe: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', color: colors.chat.quoteTextMe },
    kindOther: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', color: colors.text.secondary },
    titleMe: { fontSize: 11, fontWeight: '700', marginBottom: 2, color: colors.chat.messageTextMe, opacity: 0.9 },
    titleOther: { fontSize: 11, fontWeight: '700', marginBottom: 2, color: colors.accent.primary },
    priceMe: { fontSize: 13, color: colors.chat.quoteTextMe },
    priceOther: { fontSize: 13, color: colors.text.secondary },
});

/** The chip waiting for the next message in this conversation, or null. */
export function useChatAboutDraft(conversationId: string | null | undefined): ChatAboutChip | null {
    return useSyncExternalStore(
        chatAboutDrafts.subscribe,
        () => chatAboutDrafts.get(conversationId),
        () => null,
    );
}

/** Above the composer: "About: Fresh eggs · 6 Beans", with a ✕ that leaves it out. Stays until sent or dropped. */
export function ChatAboutBanner({ conversationId }: { conversationId: string }) {
    const { colors } = useTheme();
    const styles = useMemo(() => makeAboutStyles(colors), [colors]);
    const chip = useChatAboutDraft(conversationId);
    if (!chip) return null;
    return (
        <View style={styles.chipBox} testID="chat-about-chip">
            <View style={styles.chipBar}>
                <View style={styles.chipEdge}>
                    <Text style={styles.chipText}>{chatAboutChipWords(chip)}</Text>
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t(CHAT_ABOUT_WORDS.drop)}
                    onPress={() => chatAboutDrafts.drop(conversationId)}
                    style={styles.chipClose}
                    testID="chat-about-chip-drop"
                >
                    <MaterialCommunityIcons name="close" size={20} color={colors.text.secondary} />
                </Pressable>
            </View>
        </View>
    );
}

interface CardProps {
    about: ChatAbout;
    /** The listing as this reader can read it: found, null (gone or hidden from them) or undefined (still being looked up). */
    live: AboutPostLike | null | undefined;
    isMe: boolean;
    onOpen: (postId: string) => void;
}

/** The card at the top of a bubble. A tap opens the listing; one this reader can't see says so and opens nothing. */
export function ChatAboutCard({ about, live, isMe, onOpen }: CardProps) {
    const { colors } = useTheme();
    const styles = useMemo(() => makeAboutStyles(colors), [colors]);
    const card = chatAboutCard(about, live);
    if (card.gone) {
        return (
            <View style={isMe ? styles.goneMe : styles.goneOther} testID="chat-about-gone">
                <Text style={isMe ? styles.goneTextMe : styles.goneTextOther}>{card.goneWords}</Text>
            </View>
        );
    }
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityHint={chatAboutOpenWords(card.title)}
            onPress={() => onOpen(card.postId)}
            style={isMe ? styles.cardMe : styles.cardOther}
            testID="chat-about-card"
        >
            <Text style={isMe ? styles.kindMe : styles.kindOther}>{card.kindWords}</Text>
            <Text style={isMe ? styles.titleMe : styles.titleOther}>{card.title}</Text>
            {card.price ? <Text style={isMe ? styles.priceMe : styles.priceOther}>{card.price}</Text> : null}
        </Pressable>
    );
}
