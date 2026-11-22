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
 * In place (slice S6, DESIGN-no-switch-messaging-fable.md §6): an event of another community this phone holds as a member,
 * read and answered there without a switch. Every call below names that community (`at`), which holds its own copy open
 * while this is on screen (utils/db.ts enterChatInPlace), and its own server decides who reads it (the host, and the people
 * Going it lets in). The event's page (Going, Interested, who's going) is that community's: the header is no button there,
 * and the ⋮ menu, or a chat it doesn't open, offers "Open {community} ›".
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
import { View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, Linking, Platform } from 'react-native';
import { Alert } from '../utils/keyboard-alert';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView, KeyboardController, useKeyboardState } from 'react-native-keyboard-controller';
import { useChatSoftInputMode } from './chat/useChatSoftInputMode';
import { useChatPoll } from './chat/useChatPoll';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import {
    getEventChat, postEventChatMessage, removeEventChatMessage, reportEvent, markConversationRead, markThreadReadOnNode, muteChatApi,
    enterChatInPlace, leaveChatInPlace, whileChatInPlace,
} from '../utils/db';
import { heldGroups } from '../utils/held-groups';
import { openInCommunity } from '../utils/open-in-community';
import { useNodeStatus } from '../app/NodeStatusContext';
import { useAfterDismiss } from '../utils/screen-presented';
import { chatMuteFromRows, isMuted, muteMenuLabel, type YourChatMute } from '../utils/your-groups';
import { reportedAlertBody } from '../utils/reportReasons';
import { hapticSuccess, hapticTick, hapticWarning } from '../utils/haptics';
import { EVENT_ACCENT } from './EventCard';
import { ChatOwnerHeader } from './ChatOwnerHeader';
import { yourGroupsStore } from './useYourGroups';
import { decodeEventChatText, trimEventChatDraft, EVENT_CHAT_MESSAGE_MAX, eventChatWaitingText, eventChatSystemText, isWaitingForHost } from '../utils/events';
import {
    buildChatListItems, chatActionErrorMessage, hasAnyAction, messageActions, normaliseThreadMessage, shouldFollowNewMessages,
    showsAuthorName, type ChatMessage, type ChatViewer,
} from '../utils/chat-actions';
import { makeChatStyles } from './chat/styles';
import { ChatMessageList, scrollChatToBottom } from './chat/ChatMessageList';
import { ChatMessageRow } from './chat/ChatMessageRow';
import { ChatComposer, type ChatComposerHandle } from './chat/ChatComposer';
import { ChatMenuSheet, type ChatMenuItem } from './chat/ChatBanners';
import { ReportMessageSheet } from './ReportMessageSheet';
import { normaliseTappedUrl, t } from '@beanpool/core';
import { signedRequestWords } from './signed-request-lines';
import { useScreenKeyboardOffset } from './useScreenKeyboardOffset';

interface Props {
    /** The event's post id, which is also the chat's conversation id. */
    eventId: string;
    /** An event of another community this phone holds, open in place (slice S6): its saved address and name. */
    inPlace?: { community: string; name: string };
}

export function EventChatView({ eventId, inPlace }: Props) {
    // The community this chat lives in when it is not the one in use: undefined, the one in use, as before.
    const at = inPlace?.community;
    // Held in place from here, before any read below, until it is left: then nothing more is asked of that community.
    useFocusEffect(useCallback(() => {
        if (!at) return;
        enterChatInPlace(at);
        return () => { void leaveChatInPlace(at); };
    }, [at]));
    const { recheck } = useNodeStatus();
    const insets = useSafeAreaInsets();
    const { colors, theme } = useTheme();
    // The screen's top in the window, for the KeyboardAvoidingView (an iPhone sheet starts ~50 pt down: utils/screen-keyboard-offset).
    const screenKeyboard = useScreenKeyboardOffset();
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
    const [menuOpen, setMenuOpen] = useState(false);
    const [muteOpen, setMuteOpen] = useState(false);
    const [reporting, setReporting] = useState(false);
    // The ⋮ row that opens another Modal (Report event): on iOS it opens once the menu has gone (utils/screen-presented.ts).
    const afterMenu = useAfterDismiss<() => void>((open) => open());
    const closeMenuThen = (open: () => void) => {
        setMenuOpen(false);
        if (Platform.OS === 'ios') afterMenu.hold(open);
        else open();
    };
    // The list this chat's row is in: that community's own in place, never the community in use's.
    const row = useMemo(() => (at ? heldGroups.at(at) : yourGroupsStore), [at]);
    const [mute, setMute] = useState<YourChatMute | null>(() => chatMuteFromRows(at ? heldGroups.rowsOf(at) : yourGroupsStore.getState().items, eventId));
    // "Open {community} ›" is under way: a second tap has nothing more to do, and nothing failed.
    const moving = useRef(false);
    const readUpTo = useRef<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await getEventChat(eventId, undefined, undefined, at);
            const msgs: any[] = res?.messages || [];
            if (shouldFollowNewMessages({ grew: msgs.length > messageCountRef.current, isBackgroundPoll: true, atBottom: atBottomRef.current })) {
                setTimeout(() => scrollChatToBottom(listRef, true), 100);
            }
            messageCountRef.current = msgs.length;
            setView(res);
            setError(null);
            // Talk → Groups lists this chat too: its count goes now, not at the next refresh.
            row.markRead(eventId);
            const latest = msgs.length ? String(msgs[msgs.length - 1].id) : null;
            if (!identity?.publicKey) return;
            if (!at) markConversationRead(eventId, identity.publicKey, at).catch(() => { });
            // In place: marked on that community's own server, once for each newest line; offline, the next poll tries again.
            else if (latest && readUpTo.current !== latest) {
                readUpTo.current = latest;
                markThreadReadOnNode(eventId, identity.publicKey, at).then(() => row.markRead(eventId)).catch(() => { readUpTo.current = null; });
            }
        } catch (e: any) {
            // Going, and the host hasn't let them in: said as that, never as "only the host and people going".
            setError(isWaitingForHost(e) ? eventChatWaitingText() : (e?.message || t('Could not open this event chat.')));
        }
    }, [eventId, identity?.publicKey, at, row]);

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
        Linking.openURL(url).catch(() => Alert.alert(t('Cannot open link'), url));
    }, []);

    const send = async (raw: string) => {
        const text = trimEventChatDraft(raw);
        if (!text || sending) return;
        setSending(true);
        hapticTick();
        try {
            // Held until it settles: a line sent as the chat is left still goes to its own community, or says it didn't.
            await whileChatInPlace(at, () => postEventChatMessage(eventId, text, undefined, at));
            // On Talk → Groups at once: the event's chat goes to the top (utils/your-groups-store.ts noteSent).
            row.noteSent(eventId);
            await load();
            scrollChatToBottom(listRef, true);
        } catch (e: any) {
            Alert.alert(t('Not sent'), e?.message ? signedRequestWords(e.message) : t('Could not reach the node. Try again when you have signal.'));
        } finally {
            setSending(false);
        }
    };

    const remove = (item: ChatMessage) => {
        setActiveMessageActionsId(null);
        const author = item.authorName || (item.senderId || '').slice(0, 8);
        Alert.alert(t('Remove this message?'), t('It will read "removed by the host" to everyone in the chat.'), [
            { text: t('Keep it'), style: 'cancel' },
            {
                text: t('Remove'), style: 'destructive', onPress: async () => {
                    try {
                        await removeEventChatMessage(eventId, item.id, at);
                        await load();
                    } catch (e: any) {
                        Alert.alert(t('Not removed'), e?.message ? signedRequestWords(e.message) : (author ? t("Could not remove {name}'s message.", { name: author }) : t("Could not remove Member's message.")));
                    }
                },
            },
        ]);
    };

    const setMuteTo = async (duration: '8h' | '1w' | 'always' | 'off') => {
        setMuteOpen(false);
        try {
            const res = await muteChatApi(eventId, duration, at);
            const next = duration === 'off' ? null : (res?.mute ?? { conversationId: eventId, mutedUntil: null, always: duration === 'always' });
            setMute(next);
            row.setMute(eventId, next);
        } catch (e: any) {
            Alert.alert(t('Not changed'), e?.message ? signedRequestWords(e.message) : t('Could not reach the node.'));
        }
    };

    // The event page's Report, from its chat: to the moderators of the community the event is in.
    const submitReport = async (reason: string) => {
        const settled = () => Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
        try {
            const sent = await whileChatInPlace(at, () => reportEvent(eventId, reason, at));
            await settled();
            hapticSuccess();
            Alert.alert(t('Reported'), reportedAlertBody(sent?.wordsLeftOut, reason), [{ text: t('OK'), onPress: () => setReporting(false) }]);
        } catch (e: any) {
            hapticWarning();
            await settled();
            Alert.alert(t('Not sent'), chatActionErrorMessage({ status: e?.status ?? null, message: e?.message, nodeAnswered: e?.nodeAnswered }));
            throw e; // the box keeps the choice and the words
        }
    };

    // What isn't done in place (slice S6), the event's page above all: the phone moves to its community, through the one switch, and opens it there.
    const openThere = async () => {
        if (!inPlace || !me || moving.current) return;
        moving.current = true;
        try {
            const moved = await openInCommunity(inPlace.community, `/post/${eventId}`, me, recheck);
            if (moved !== 'switched') Alert.alert(inPlace.name, t('Something went wrong. Try again in a moment.'));
        } finally {
            moving.current = false;
        }
    };

    const openMenu = async () => {
        await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
        setMenuOpen(true);
    };
    const muted = isMuted(mute);
    const menuItems: ChatMenuItem[] = [
        { icon: muted ? 'bell-ring-outline' : 'bell-off-outline', label: muteMenuLabel(mute), hidden: !view, onPress: () => { setMenuOpen(false); if (muted) setMuteTo('off'); else setMuteOpen(true); } },
        // Their own event is not theirs to report; in use, the event's page has it.
        { icon: 'flag-outline', label: t('Report event'), hidden: !at || !view || !!view.isHost, onPress: () => closeMenuThen(() => setReporting(true)) },
        { icon: 'home-group', label: t('Open {community} ›', { community: inPlace?.name ?? '' }), hidden: !at, onPress: () => closeMenuThen(() => { void openThere(); }) },
    ];

    // The one chat header (groups decision 9): "📅 Working bee · event"; tapping it opens the event, which is the
    // way back to it after it has left the feed (events round 2, A4).
    const header = (
        <>
        <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
        <ChatOwnerHeader
            kind="event"
            name={view?.title || t('Event chat')}
            // In place: the community's name, as its row says it (an ended event's chat says so under this).
            detail={inPlace?.name ?? (view?.readOnly ? t('ended', undefined, 'event chat') : null)}
            onBack={goBack}
            // In place, the event's page is its community's: the ⋮ menu's Open {community} › goes there.
            onOpenOwner={at ? undefined : () => router.push(`/post/${eventId}`)}
            onMenu={view || at ? openMenu : undefined}
        />
        <ChatMenuSheet
            styles={chat}
            menuOpen={menuOpen}
            muteOpen={muteOpen}
            title={view?.title || t('Event chat')}
            items={menuItems}
            onClose={() => { setMenuOpen(false); setMuteOpen(false); }}
            onPickMute={setMuteTo}
            bottomInset={insets.bottom}
            onDismiss={afterMenu.release}
        />
        </>
    );

    if (error && !view) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                {header}
                <Text style={chat.errorText} accessibilityRole="alert">{signedRequestWords(error)}</Text>
                <Pressable style={chat.retryBtn} accessibilityRole="button" onPress={() => { setError(null); load(); }}>
                    <Text style={chat.retryText}>{t('Try again')}</Text>
                </Pressable>
                {/* Not theirs to read there (Interested, not let in yet, gone), or not reached: the event's page is where they change that. */}
                {inPlace ? (
                    <Pressable style={chat.retryBtn} accessibilityRole="button" testID="event-open-there" onPress={() => { void openThere(); }}>
                        <Text style={chat.retryText}>{t('Open {community} ›', { community: inPlace.name })}</Text>
                    </Pressable>
                ) : null}
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
                    <Text style={styles.systemText}>{eventChatSystemText(item.systemType, item.text)}</Text>
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
            keyboardVerticalOffset={screenKeyboard.keyboardVerticalOffset}
            onLayout={screenKeyboard.onScreenLayout}
        >
            {header}

            {!!view.privateNote && (
                <View style={styles.noteBox} accessibilityLabel={t('Note for people who are going')}>
                    {/* Its capitals are in the words, never made in code: a language writes its own. */}
                    <Text style={styles.noteLabel}>{t('📌 NOTE FOR PEOPLE WHO ARE GOING')}</Text>
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
                onCloseMenu={() => setActiveMessageActionsId(null)}
                ListEmptyComponent={
                    <Text style={chat.empty}>
                        {view.readOnly ? t('Nothing was said here.') : t('No messages yet. Say hello.')}
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
                    placeholder={t('Message everyone going…')}
                    accessibilityLabel={t('Message everyone going')}
                    bottomPadding={keyboardVisible ? 8 : Math.max(insets.bottom, 12)}
                />
            ) : (
                <Text style={[chat.composerNotice, { paddingBottom: insets.bottom + 8 }]}>{view.notice}</Text>
            )}

            {at ? (
                <ReportMessageSheet
                    isOpen={reporting}
                    photo={false}
                    title={t('Report event')}
                    note={t('The community’s moderators see this post and your reason.')}
                    onSubmit={submitReport}
                    onClose={() => setReporting(false)}
                />
            ) : null}
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
        noteLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: colors.event.ink, marginBottom: 4 }, // EVENT_ACCENT was 2.6:1 on the dark tint
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
