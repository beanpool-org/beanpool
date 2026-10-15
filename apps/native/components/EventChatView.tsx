/**
 * EventChatView — the chat every event carries, on the phone (docs/events-on-the-map.md §2.2, §3, slice 4).
 *
 * Reached from the event detail ("Open event chat") and from the Inbox, where the chat sits under the
 * event's title because the conversation row carries it. Not the DM screen: an event chat is node-readable
 * `plaintext-v1`, its members follow the RSVPs, the host can remove a message, and it goes read-only when
 * the event ends — none of which the DM pipeline (E2E, edits, reactions, deals) knows about.
 *
 * Everything comes from one signed read of the node, on purpose. The private note is pinned above the list
 * and is never written to the phone's database, exactly as the event detail treats it.
 *
 * Chat parity (2026-09-23): the thread, the bubbles, the day pills and the message box are the shared ones
 * in components/chat, so an event chat reads like every other chat — inverted, with the newest message above
 * the keyboard. What a bubble OFFERS is still the node's rules: no edit, no reaction, no reply and no
 * author-delete in an event thread this round, and the host's Remove stays exactly the power it was.
 *
 * At 320dp and 1.3× text: the header truncates, the composer row keeps a send button that never shrinks,
 * and the notice wraps rather than pushing anything off-screen.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, Alert, Linking } from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useChatSoftInputMode } from './chat/useChatSoftInputMode';
import { useChatPoll } from './chat/useChatPoll';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { getEventChat, postEventChatMessage, removeEventChatMessage, markConversationRead } from '../utils/db';
import { hapticTick } from '../utils/haptics';
import { EVENT_ACCENT } from './EventCard';
import { ChatOwnerHeader } from './ChatOwnerHeader';
import { yourGroupsStore } from './useYourGroups';
import { decodeEventChatText, trimEventChatDraft, EVENT_CHAT_MESSAGE_MAX } from '../utils/events';
import {
    buildChatListItems, hasAnyAction, messageActions, normaliseThreadMessage, shouldFollowNewMessages,
    showsAuthorName, type ChatMessage, type ChatViewer,
} from '../utils/chat-actions';
import { normaliseTappedUrl } from '../utils/chat-links';
import { makeChatStyles } from './chat/styles';
import { ChatMessageList, scrollChatToBottom } from './chat/ChatMessageList';
import { ChatMessageRow } from './chat/ChatMessageRow';
import { ChatComposer, type ChatComposerHandle } from './chat/ChatComposer';

interface Props {
    /** The event's post id, which is also the chat's conversation id. */
    eventId: string;
}

export function EventChatView({ eventId }: Props) {
    const insets = useSafeAreaInsets();
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);
    const chat = useStyles(makeChatStyles);
    const { identity } = useIdentity();
    const keyboardVisible = useKeyboardState(s => s.isVisible);
    // The window's soft-input mode — the same hook the DM calls.
    useChatSoftInputMode();
    const me = identity?.publicKey;

    const [view, setView] = useState<any | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [activeMessageActionsId, setActiveMessageActionsId] = useState<string | null>(null);
    const listRef = useRef<FlatList>(null);
    const composerRef = useRef<ChatComposerHandle>(null);
    const atBottomRef = useRef(true);
    const messageCountRef = useRef(0);
    const linkPressedRef = useRef(false);

    const load = useCallback(async () => {
        try {
            const res = await getEventChat(eventId);
            const msgs: any[] = res?.messages || [];
            if (shouldFollowNewMessages({ grew: msgs.length > messageCountRef.current, isBackgroundPoll: true, atBottom: atBottomRef.current })) {
                setTimeout(() => scrollChatToBottom(listRef, true), 100);
            }
            messageCountRef.current = msgs.length;
            setView(res);
            setError(null);
            if (identity?.publicKey) markConversationRead(eventId, identity.publicKey).catch(() => { });
            // Talk → Groups lists this chat too: its count goes now, not at the next refresh.
            yourGroupsStore.markRead(eventId);
        } catch (e: any) {
            setError(e?.message || 'Could not open this event chat.');
        }
    }, [eventId, identity?.publicKey]);

    // Refreshes only while this screen is focused and the app is in the foreground, with one load the
    // moment either comes back — the DM screen's rule, shared (utils/chat-poll). The first load is the
    // poll's own immediate tick, so there is no separate mount load to fetch the same page twice.
    useChatPoll(load, 15000);

    const goBack = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats'); };

    const rawMessages: any[] = view?.messages || [];
    const messages: ChatMessage[] = useMemo(
        () => rawMessages.map(m => normaliseThreadMessage(m, decodeEventChatText, me, 'event')),
        [rawMessages, me],
    );
    const listItems = useMemo(() => buildChatListItems(messages), [messages]);
    const showAuthorById = useMemo(() => {
        const map = new Map<string, boolean>();
        messages.forEach((m, i) => map.set(m.id, showsAuthorName(m, messages[i - 1], { kind: 'event', myPubkey: me })));
        return map;
    }, [messages, me]);

    const canPost = !!view?.canPost && !!me;
    const viewer: ChatViewer = useMemo(() => ({
        kind: 'event',
        myPubkey: me ?? null,
        canPost,
        isModerator: !!view?.isHost,
    }), [me, canPost, view?.isHost]);

    const openUrl = useCallback((raw: string) => {
        linkPressedRef.current = true;
        setTimeout(() => { linkPressedRef.current = false; }, 350);
        const url = normaliseTappedUrl(raw);
        if (!url) return;
        Linking.openURL(url).catch(() => Alert.alert('Cannot open link', url));
    }, []);

    const send = async (raw: string) => {
        const text = trimEventChatDraft(raw);
        if (!text || sending) return;
        setSending(true);
        hapticTick();
        try {
            await postEventChatMessage(eventId, text);
            await load();
            scrollChatToBottom(listRef, true);
        } catch (e: any) {
            Alert.alert('Not sent', e?.message || 'Could not reach the node. Try again when you have signal.');
        } finally {
            setSending(false);
        }
    };

    const remove = (item: ChatMessage) => {
        setActiveMessageActionsId(null);
        const author = item.authorName || (item.senderId || '').slice(0, 8) || 'Member';
        Alert.alert('Remove this message?', 'It will read "removed by the host" to everyone in the chat.', [
            { text: 'Keep it', style: 'cancel' },
            {
                text: 'Remove', style: 'destructive', onPress: async () => {
                    try {
                        await removeEventChatMessage(eventId, item.id);
                        await load();
                    } catch (e: any) {
                        Alert.alert('Not removed', e?.message || `Could not remove ${author}'s message.`);
                    }
                },
            },
        ]);
    };

    // The one chat header (groups decision 9): "📅 Working bee · event"; tapping it opens the event, which is the
    // way back to it after it has left the feed (events round 2, A4).
    const header = (
        <>
        <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
        <ChatOwnerHeader
            kind="event"
            name={view?.title || 'Event chat'}
            detail={view?.readOnly ? 'ended' : null}
            onBack={goBack}
            onOpenOwner={() => router.push(`/post/${eventId}`)}
        />
        </>
    );

    if (error && !view) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                {header}
                <Text style={chat.errorText} accessibilityRole="alert">{error}</Text>
                <Pressable style={chat.retryBtn} accessibilityRole="button" onPress={() => { setError(null); load(); }}>
                    <Text style={chat.retryText}>Try again</Text>
                </Pressable>
            </View>
        );
    }

    if (!view) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                {header}
                <ActivityIndicator style={{ marginTop: 32 }} color={EVENT_ACCENT} />
            </View>
        );
    }

    const renderMessage = (item: ChatMessage) => {
        if (item.type === 'system' || item.senderId === 'SYSTEM') {
            return (
                <View style={styles.systemWrap}>
                    <Text style={styles.systemText}>{item.text}</Text>
                </View>
            );
        }
        const isMe = !!me && item.senderId === me;
        const actions = messageActions(item, viewer);
        return (
            <ChatMessageRow
                item={item}
                kind="event"
                isMe={isMe}
                styles={chat}
                actions={actions}
                showActions={activeMessageActionsId === item.id}
                showEmojiPicker={false}
                pickerPosition="top"
                onPressBubble={() => {
                    if (linkPressedRef.current) { linkPressedRef.current = false; return; }
                    // Only a host has anything to do with a message here: no empty bar for anybody else.
                    if (!hasAnyAction(actions)) return;
                    setActiveMessageActionsId(activeMessageActionsId === item.id ? null : item.id);
                }}
                onReply={() => { }}
                onToggleEmojiPicker={() => { }}
                onEdit={() => { }}
                onDelete={() => { }}
                onRemove={() => remove(item)}
                onPickEmoji={() => { }}
                onPressUrl={openUrl}
                authorLabel={showAuthorById.get(item.id) ? (item.authorName || (item.senderId || '').slice(0, 8)) : null}
            />
        );
    };

    return (
        <KeyboardAvoidingView
            style={[styles.container, { paddingTop: insets.top }]}
            behavior="padding"
        >
            {header}

            {!!view.privateNote && (
                <View style={styles.noteBox} accessibilityLabel="Note for people who are going">
                    <Text style={styles.noteLabel}>📌 NOTE FOR PEOPLE WHO ARE GOING</Text>
                    <Text style={styles.noteText} selectable>{view.privateNote}</Text>
                </View>
            )}

            {!!view.readOnly && (
                <Text style={styles.readOnly} numberOfLines={3}>{view.readOnlyReason}</Text>
            )}

            <ChatMessageList
                listRef={listRef}
                items={listItems}
                styles={chat}
                renderMessage={renderMessage}
                activeId={activeMessageActionsId}
                onAtBottomChange={atBottom => { atBottomRef.current = atBottom; }}
                onScrollBeginDrag={() => setActiveMessageActionsId(null)}
                ListEmptyComponent={
                    <Text style={chat.empty}>
                        {view.readOnly ? 'Nothing was said here.' : 'No messages yet. Say hello.'}
                    </Text>
                }
            />

            {canPost ? (
                <ChatComposer
                    ref={composerRef}
                    styles={chat}
                    onSend={send}
                    busy={sending}
                    maxLength={EVENT_CHAT_MESSAGE_MAX}
                    notice={view.notice}
                    placeholder="Message everyone going…"
                    accessibilityLabel="Message everyone going"
                    bottomPadding={keyboardVisible ? 8 : Math.max(insets.bottom, 12)}
                />
            ) : (
                <Text style={[chat.composerNotice, { paddingBottom: insets.bottom + 8 }]}>{view.notice}</Text>
            )}
        </KeyboardAvoidingView>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        noteBox: {
            marginHorizontal: 12, marginTop: 10, padding: 12, borderRadius: 12, borderWidth: 1,
            backgroundColor: theme === 'dark' ? 'rgba(124, 58, 237, 0.15)' : '#f5f3ff',
            borderColor: theme === 'dark' ? '#6d28d9' : '#ddd6fe',
        },
        noteLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: EVENT_ACCENT, marginBottom: 4 },
        noteText: { fontSize: 15, color: colors.text.body, lineHeight: 21 },
        readOnly: {
            marginHorizontal: 12, marginTop: 10, padding: 10, borderRadius: 10,
            backgroundColor: colors.surface.subtle, color: colors.text.secondary,
            fontSize: 13, fontStyle: 'italic', textAlign: 'center',
        },
        systemWrap: { alignItems: 'center', marginVertical: 6, paddingHorizontal: 16 },
        systemText: {
            fontSize: 12, color: colors.text.secondary, textAlign: 'center', overflow: 'hidden',
            backgroundColor: colors.surface.subtle, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
        },
    });
