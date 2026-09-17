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
 * At 320dp and 1.3× text: the header truncates, the composer row keeps a 48dp send button that never
 * shrinks, and the notice wraps rather than pushing anything off-screen.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    View, Text, StyleSheet, Pressable, FlatList, TextInput, ActivityIndicator, Alert, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { getEventChat, postEventChatMessage, removeEventChatMessage, markConversationRead } from '../utils/db';
import { hapticTick } from '../utils/haptics';
import { EVENT_ACCENT } from './EventCard';
import { decodeEventChatText, trimEventChatDraft, EVENT_CHAT_MESSAGE_MAX } from '../utils/events';

interface Props {
    /** The event's post id, which is also the chat's conversation id. */
    eventId: string;
}

export function EventChatView({ eventId }: Props) {
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();

    const [view, setView] = useState<any | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [removingId, setRemovingId] = useState<string | null>(null);
    const draftRef = useRef('');
    const listRef = useRef<FlatList>(null);

    const load = useCallback(async () => {
        try {
            const res = await getEventChat(eventId);
            setView(res);
            setError(null);
            if (identity?.publicKey) markConversationRead(eventId, identity.publicKey).catch(() => { });
        } catch (e: any) {
            setError(e?.message || 'Could not open this event chat.');
        }
    }, [eventId, identity?.publicKey]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        const t = setInterval(load, 15000);
        return () => clearInterval(t);
    }, [load]);

    const goBack = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats'); };

    const send = async () => {
        const text = trimEventChatDraft(draftRef.current);
        if (!text || sending) return;
        setSending(true);
        hapticTick();
        try {
            await postEventChatMessage(eventId, text);
            draftRef.current = '';
            setDraft('');
            await load();
            listRef.current?.scrollToEnd({ animated: true });
        } catch (e: any) {
            Alert.alert('Not sent', e?.message || 'Could not reach the node. Try again when you have signal.');
        } finally {
            setSending(false);
        }
    };

    const remove = (messageId: string, author: string) => {
        Alert.alert('Remove this message?', `It will read "removed by the host" to everyone in the chat.`, [
            { text: 'Keep it', style: 'cancel' },
            {
                text: 'Remove', style: 'destructive', onPress: async () => {
                    setRemovingId(messageId);
                    try {
                        await removeEventChatMessage(eventId, messageId);
                        await load();
                    } catch (e: any) {
                        Alert.alert('Not removed', e?.message || `Could not remove ${author}'s message.`);
                    } finally {
                        setRemovingId(null);
                    }
                },
            },
        ]);
    };

    const header = (
        <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goBack} style={styles.backButton}>
                <Text style={styles.backText}>←</Text>
            </Pressable>
            <View style={styles.headerTitleWrap}>
                <Text style={styles.headerTitle} numberOfLines={1}>{view?.title || 'Event chat'}</Text>
                <Text style={styles.headerSub} numberOfLines={1}>Event chat</Text>
            </View>
            <View style={{ width: 44 }} />
        </View>
    );

    if (error && !view) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                {header}
                <Text style={styles.errorText} accessibilityRole="alert">{error}</Text>
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

    const canPost = !!view.canPost && !!identity?.publicKey;

    return (
        <KeyboardAvoidingView
            style={[styles.container, { paddingTop: insets.top }]}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={0}
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

            <FlatList
                ref={listRef}
                data={view.messages || []}
                keyExtractor={(m: any) => m.id}
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={
                    <Text style={styles.empty}>
                        {view.readOnly ? 'Nothing was said here.' : 'No messages yet. Say hello.'}
                    </Text>
                }
                renderItem={({ item }: { item: any }) => {
                    const removed = item.type === 'removed';
                    const author = item.authorCallsign || (item.authorPubkey || '').slice(0, 8) || 'Member';
                    const time = new Date(item.timestamp);
                    return (
                        <View style={styles.msgRow}>
                            <View style={styles.msgHeader}>
                                <Text style={styles.msgAuthor} numberOfLines={1}>{author}</Text>
                                <Text style={styles.msgTime} numberOfLines={1}>
                                    {isNaN(time.getTime()) ? '' : time.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                </Text>
                            </View>
                            <Text style={[styles.msgText, removed && styles.msgRemoved]} selectable={!removed}>
                                {decodeEventChatText(item.ciphertext, item.type)}
                            </Text>
                            {view.isHost && !removed && (
                                <Pressable
                                    onPress={() => remove(item.id, author)}
                                    disabled={removingId === item.id}
                                    style={styles.removeBtn}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Remove message from ${author}`}
                                >
                                    {removingId === item.id
                                        ? <ActivityIndicator size="small" color={colors.feedback.danger.solid} />
                                        : <Text style={styles.removeText}>Remove</Text>}
                                </Pressable>
                            )}
                        </View>
                    );
                }}
            />

            {canPost && (
                <View style={styles.composer}>
                    <TextInput
                        style={styles.input}
                        value={draft}
                        onChangeText={(t) => { draftRef.current = t; setDraft(t); }}
                        placeholder="Message everyone going…"
                        placeholderTextColor={colors.text.muted}
                        accessibilityLabel="Message everyone going"
                        multiline
                        maxLength={EVENT_CHAT_MESSAGE_MAX}
                    />
                    <Pressable
                        onPress={send}
                        disabled={sending || !draft.trim()}
                        style={[styles.sendBtn, (sending || !draft.trim()) && styles.sendBtnDisabled]}
                        accessibilityRole="button"
                        accessibilityLabel="Send"
                        accessibilityState={{ disabled: sending || !draft.trim(), busy: sending }}
                    >
                        {sending ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.sendText}>Send</Text>}
                    </Pressable>
                </View>
            )}

            <Text style={[styles.notice, { paddingBottom: insets.bottom + 8 }]}>{view.notice}</Text>
        </KeyboardAvoidingView>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: {
            flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6,
            borderBottomWidth: 1, borderBottomColor: colors.surface.subtle,
        },
        backButton: { width: 44, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
        backText: { color: colors.text.body, fontSize: 22 },
        headerTitleWrap: { flex: 1, minWidth: 0 },
        headerTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        headerSub: { fontSize: 11, fontWeight: '700', color: EVENT_ACCENT },
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
        listContent: { padding: 12, flexGrow: 1 },
        empty: { fontSize: 14, fontStyle: 'italic', color: colors.text.secondary, paddingVertical: 16 },
        msgRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        msgHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
        msgAuthor: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '800', color: colors.text.heading },
        msgTime: { flexShrink: 0, fontSize: 11, color: colors.text.muted },
        msgText: { marginTop: 3, fontSize: 15, lineHeight: 21, color: colors.text.body },
        msgRemoved: { fontStyle: 'italic', color: colors.text.muted },
        removeBtn: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' },
        removeText: { fontSize: 13, fontWeight: '700', color: colors.feedback.danger.solid },
        composer: {
            flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8,
            borderTopWidth: 1, borderTopColor: colors.border.default,
        },
        input: {
            flex: 1, minWidth: 0, minHeight: 48, maxHeight: 120, borderWidth: 1, borderColor: colors.border.default,
            borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
            color: colors.text.body, backgroundColor: colors.surface.card,
        },
        sendBtn: {
            flexShrink: 0, minHeight: 48, paddingHorizontal: 16, borderRadius: 12,
            alignItems: 'center', justifyContent: 'center', backgroundColor: EVENT_ACCENT,
        },
        sendBtnDisabled: { opacity: 0.5 },
        sendText: { color: '#fff', fontWeight: '800', fontSize: 15 },
        notice: { paddingHorizontal: 12, paddingTop: 8, fontSize: 11, color: colors.text.muted },
        errorText: { margin: 16, fontSize: 15, color: colors.text.body, lineHeight: 21 },
    });
