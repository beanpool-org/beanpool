/**
 * One message bubble, for every kind of chat.
 *
 * Lifted out of app/chat/[id].tsx unchanged in behaviour: the quoted reply, tappable links, the reaction
 * badge, "edited · 12:14", and whatever the screen hands it as a status (the DM's ✓/✓✓, a clock, or
 * "! not delivered"). A DM adds a photo through `attachment`; a group chat adds the author's name through
 * `authorLabel`. A deleted or removed message renders as a tombstone with nothing to tap.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import type { ChatMessage, ChatKind } from '../../utils/chat-actions';
import { isTombstone, tombstoneText, reactionSummary } from '../../utils/chat-actions';
import { splitTextWithLinks } from '../../utils/chat-links';
import type { ChatStyles } from './styles';

export interface ChatQuote {
    author: string;
    text: string;
    onPress?: () => void;
}

interface Props {
    item: ChatMessage;
    isMe: boolean;
    styles: ChatStyles;
    /** Which chat this is. A tombstone's words depend on it — see tombstoneText. */
    kind: ChatKind;
    /** Who said it, above the words. Only set where the chat shows names — see showsAuthorName. */
    authorLabel?: string | null;
    quote?: ChatQuote | null;
    onPress?: (event: any) => void;
    onPressUrl: (url: string) => void;
    /** A DM photo, drawn above the words. */
    attachment?: React.ReactNode;
    /** Trailing the time, inline: ticks, a clock, or "! not delivered". */
    status?: React.ReactNode;
    /** Under the bubble when there are no words to trail (a photo on its own). */
    footer?: React.ReactNode;
}

function renderTextWithLinks(text: string, linkStyle: any, onPressUrl: (url: string) => void) {
    if (!text) return text;
    return splitTextWithLinks(text).map((run, i) =>
        run.isUrl
            ? <Text key={i} style={linkStyle} onPress={() => onPressUrl(run.text)}>{run.text}</Text>
            : run.text,
    );
}

export function ChatBubble({ item, isMe, styles, kind, authorLabel, quote, onPress, onPressUrl, attachment, status, footer }: Props) {
    const removed = isTombstone(item);
    const { emojis, total } = removed ? { emojis: [] as string[], total: 0 } : reactionSummary(item.metadata);
    const textStyle = isMe ? styles.messageTextMe : styles.messageTextOther;
    const timeStyle = isMe ? styles.messageTimeMe : styles.messageTimeOther;

    return (
        <Pressable
            accessibilityRole={removed ? 'text' : 'button'}
            onPress={removed ? undefined : onPress}
            disabled={removed}
            style={[
                styles.messageBubble,
                isMe ? styles.messageMe : styles.messageOther,
                { position: 'relative', zIndex: 1 },
                total > 0 ? { paddingBottom: 24 } : null,
            ]}
        >
            {!!authorLabel && !removed && (
                <Text style={styles.messageAuthor} numberOfLines={1}>{authorLabel}</Text>
            )}

            {!!quote && !removed && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Replying to ${quote.author}. Show the message.`}
                    onPress={quote.onPress}
                    style={[styles.quoteContainer, isMe ? styles.quoteMe : styles.quoteOther]}
                >
                    <Text style={[styles.quoteAuthor, isMe ? styles.quoteAuthorMe : styles.quoteAuthorOther]}>{quote.author}</Text>
                    <Text style={[styles.quoteText, isMe ? styles.quoteTextMe : styles.quoteTextOther]} numberOfLines={1}>{quote.text}</Text>
                </Pressable>
            )}

            {!removed && attachment}

            {removed ? (
                <Text style={[styles.messageText, textStyle, styles.messageRemoved]}>
                    {tombstoneText(item, kind)}
                    {'  '}
                    <Text style={[styles.messageTime, timeStyle, { fontSize: 10 }]}>{item.timestamp}</Text>
                </Text>
            ) : (!!item.text || !attachment) ? (
                <Text style={[styles.messageText, textStyle, attachment ? { marginTop: 6 } : null]}>
                    {renderTextWithLinks(item.text, isMe ? styles.linkMe : styles.linkOther, onPressUrl)}
                    {'  '}
                    <Text style={[styles.messageTime, timeStyle, { fontSize: 10 }]}>
                        {item.edited ? 'edited · ' : ''}{item.timestamp}
                    </Text>
                    {status}
                </Text>
            ) : null}

            {!removed && footer}

            {total > 0 && (
                <View style={[
                    styles.reactionBadgeContainer,
                    isMe ? styles.reactionBadgeMe : styles.reactionBadgeOther,
                    total === 1 ? { width: 28, paddingHorizontal: 0, justifyContent: 'center' } : {},
                ]}>
                    <Text
                        accessibilityLabel={`${total} ${total === 1 ? 'reaction' : 'reactions'}: ${emojis.join(' ')}`}
                        style={[
                            styles.reactionBadgeText,
                            total === 1 ? { fontSize: 14, lineHeight: 14, marginTop: 1.5, marginLeft: 3.5 } : { marginTop: -1 },
                        ]}
                    >
                        {emojis.join(' ')} {total > 1 ? total : ''}
                    </Text>
                </View>
            )}
        </Pressable>
    );
}

/** The WhatsApp-style day pill between two calendar days. */
export function ChatDaySeparator({ label, styles }: { label: string; styles: ChatStyles }) {
    return (
        <View style={styles.daySeparatorRow}>
            <View style={styles.daySeparatorPill}>
                <Text style={styles.daySeparatorText}>{label}</Text>
            </View>
        </View>
    );
}
