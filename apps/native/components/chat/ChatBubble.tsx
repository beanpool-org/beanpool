/**
 * One message bubble, for every kind of chat.
 *
 * Lifted out of app/chat/[id].tsx unchanged in behaviour: the quoted reply, tappable links, the reaction
 * badge, "edited · 12:14", and whatever the screen hands it as a status (the DM's ✓/✓✓, a clock, or
 * "! not delivered"). A DM adds a photo through `attachment`; a group chat adds the author's name through
 * `authorLabel`. A deleted or removed message renders as a tombstone with nothing to tap.
 *
 * Words that run past twelve lines fold with a "…more" button (ChatFold.tsx; the rule is core's chat-fold.ts). A folded
 * message moves its time and status out of the words, to the line with the button, or the clamp would cut them off.
 */

import React from 'react';
import { View, Text, Pressable } from 'react-native';
import type { ChatMessage, ChatKind, ChatRemovedRun } from '../../utils/chat-actions';
import { isTombstone, messageTime, tombstoneWords, reactionSummary, removedRunLineText } from '../../utils/chat-actions';
import { splitTextWithLinks } from '../../utils/chat-links';
import { chatLineWords } from '../../utils/chat-line-words';
import { CHAT_FOLD_LINES, t, tn } from '@beanpool/core';
import { useChatFold } from './ChatFold';
import type { ChatStyles } from './styles';

export interface ChatQuote {
    author: string;
    text: string;
    /** The quoted line's own mark (utils/chat-actions.ts dmQuoteFor), shown with it. */
    note?: string | null;
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
    /** The member is editing this message: it shows whole, never folded. */
    editing?: boolean;
}

function renderTextWithLinks(text: string, linkStyle: any, onPressUrl: (url: string) => void) {
    if (!text) return text;
    return splitTextWithLinks(text).map((run, i) =>
        run.isUrl
            ? <Text key={i} style={linkStyle} onPress={() => onPressUrl(run.text)}>{run.text}</Text>
            : run.text,
    );
}

export function ChatBubble({ item, isMe, styles, kind, authorLabel, quote, onPress, onPressUrl, attachment, status, footer, editing }: Props) {
    const removed = isTombstone(item);
    const fold = useChatFold(item.id, item.text ?? '', !removed && !editing);
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
            {/* Its own line, free to wrap: the name's one line may be cut, the mark never is. */}
            {!!authorLabel && !removed && !!item.authorHint && (
                <Text style={styles.messageAuthorHint}>{chatLineWords(item.authorHint)}</Text>
            )}

            {!!quote && !removed && (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('Replying to {name}. Show the message.', { name: quote.author })}
                    onPress={quote.onPress}
                    style={[styles.quoteContainer, isMe ? styles.quoteMe : styles.quoteOther]}
                >
                    <Text style={[styles.quoteAuthor, isMe ? styles.quoteAuthorMe : styles.quoteAuthorOther]}>{quote.author}</Text>
                    <Text style={[styles.quoteText, isMe ? styles.quoteTextMe : styles.quoteTextOther]} numberOfLines={1}>{quote.text}</Text>
                    {quote.note ? (
                        <Text style={[styles.quoteText, isMe ? styles.quoteTextMe : styles.quoteTextOther, { fontStyle: 'italic', fontSize: 11 }]}>⚠️ {quote.note}</Text>
                    ) : null}
                </Pressable>
            )}

            {!removed && attachment}

            {removed ? (
                <Text style={[styles.messageText, textStyle, styles.messageRemoved]}>
                    {tombstoneWords(item, kind)}
                    {'  '}
                    <Text style={[styles.messageTime, timeStyle, { fontSize: 10 }]}>{messageTime(item)}</Text>
                </Text>
            ) : (!!item.text || !attachment) ? (
                fold.long ? (
                    <>
                        <Text style={[styles.messageText, textStyle, attachment ? { marginTop: 6 } : null]} numberOfLines={fold.open ? undefined : CHAT_FOLD_LINES}>
                            {renderTextWithLinks(item.text, isMe ? styles.linkMe : styles.linkOther, onPressUrl)}
                        </Text>
                        <View style={styles.foldRow}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={fold.open ? t('Show less') : t('Show the whole message')}
                                accessibilityState={{ expanded: fold.open }}
                                onPress={fold.toggle}
                                style={styles.foldButton}
                            >
                                <Text style={[styles.foldText, isMe ? styles.foldTextMe : styles.foldTextOther]}>
                                    {fold.open ? t('less', undefined, 'folds a long message again') : t('…more', undefined, 'shows the rest of a long message')}
                                </Text>
                            </Pressable>
                            <Text style={[styles.messageTime, timeStyle, styles.foldTime, { fontSize: 10 }]}>
                                {item.edited ? t('edited · {time}', { time: messageTime(item) }) : messageTime(item)}
                                {status}
                            </Text>
                        </View>
                    </>
                ) : (
                    <Text style={[styles.messageText, textStyle, attachment ? { marginTop: 6 } : null]} {...fold.measure}>
                        {renderTextWithLinks(item.text, isMe ? styles.linkMe : styles.linkOther, onPressUrl)}
                        {'  '}
                        <Text style={[styles.messageTime, timeStyle, { fontSize: 10 }]}>
                            {item.edited ? t('edited · {time}', { time: messageTime(item) }) : messageTime(item)}
                        </Text>
                        {status}
                    </Text>
                )
            ) : null}

            {!removed && footer}

            {total > 0 && (
                <View style={[
                    styles.reactionBadgeContainer,
                    isMe ? styles.reactionBadgeMe : styles.reactionBadgeOther,
                    total === 1 ? { width: 28, paddingHorizontal: 0, justifyContent: 'center' } : {},
                ]}>
                    <Text
                        accessibilityLabel={tn(total, '{n} reaction: {emojis}', '{n} reactions: {emojis}', { emojis: emojis.join(' ') })}
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

/**
 * Two or more removed lines in a row, as one line ("11 messages removed by a convenor"): a removed line's own look, in
 * the middle, because the run may hold anyone's lines and names nobody. Nothing to tap, like a single removed line.
 */
export function ChatRemovedRunLine({ run, styles }: { run: ChatRemovedRun; styles: ChatStyles }) {
    return (
        <View accessibilityRole="text" style={[styles.messageBubble, styles.messageOther, { alignSelf: 'center' }]}>
            <Text style={[styles.messageText, styles.messageTextOther, styles.messageRemoved]}>
                {removedRunLineText(run)}
                {'  '}
                <Text style={[styles.messageTime, styles.messageTimeOther, { fontSize: 10 }]}>{run.timestamp}</Text>
            </Text>
        </View>
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
