/**
 * A group's chat hosted by another community, as a guest reads it (slice G2: DESIGN-cross-chat-voice-fable.md §4.2). Kept on
 * this phone only (utils/guest-chat-live.ts), and the chat says so above its first line. An invitation shows who invited,
 * the group and its community, with Accept and Decline; nothing of the group's reaches the phone before Accept. In the chat
 * a guest reads and writes, and sees the names in it, nothing else of the group (core guestAccess). A closed chat (removed,
 * left, declined, the group closed) keeps what was here and says why, with no box to write in.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, FlatList, DeviceEventEmitter } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    GUEST_CHAT_WORDS, GUEST_LINE_TEXT_MAX, guestAccess, guestChatAuthorName, guestNameLine, guestViewerOf, t, type GuestChat, type GuestLine,
} from '@beanpool/core';
import { Alert } from '../../utils/keyboard-alert';
import { useTheme, useStyles } from '../ThemeContext';
import { outsideErrorWords } from '../../utils/outside-chat-live';
import { GUEST_CHATS_UPDATED, answerInvitation, leaveGuestChatNow, loadGuestChats, sendGuestLineNow, syncGuestMailNow } from '../../utils/guest-chat-live';
import { guestClosedWords, guestLineStateWords } from '../../utils/guest-chat-words';
import { loadIdentity } from '../../utils/identity';

const W = GUEST_CHAT_WORDS;
/** How often an open chat asks for what waits, while it is on screen. */
const POLL_MS = 15_000;

export default function GuestChatScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const { colors } = useTheme();
    const [me, setMe] = useState<string | null>(null);
    const [chat, setChat] = useState<GuestChat | null | undefined>(undefined);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const listRef = useRef<FlatList<GuestLine>>(null);

    const load = useCallback(async () => {
        const identity = await loadIdentity().catch(() => null);
        setMe(identity?.publicKey ?? null);
        const chats = await loadGuestChats();
        setChat(id ? chats[String(id)] ?? null : null);
    }, [id]);

    useEffect(() => {
        void load();
        const sub = DeviceEventEmitter.addListener(GUEST_CHATS_UPDATED, load);
        return () => sub.remove();
    }, [load]);

    useFocusEffect(useCallback(() => {
        void syncGuestMailNow().then(load);
        const timer = setInterval(() => { void syncGuestMailNow().then(load); }, POLL_MS);
        return () => clearInterval(timer);
    }, [load]));

    const send = async () => {
        const words = text.trim();
        if (!words || busy || !chat) return;
        setBusy(true);
        try {
            const kept = await sendGuestLineNow(chat.id, words);
            // The box empties once the line is kept here (shown at once); words typed meanwhile stay.
            if (kept) setText((now) => (now.trim() === words ? '' : now));
        } catch (e) {
            Alert.alert(outsideErrorWords(e));
        } finally {
            setBusy(false);
            void load();
        }
    };

    const answer = async (yes: boolean) => {
        if (!chat || busy) return;
        setBusy(true);
        try {
            await answerInvitation(chat.id, yes ? 'yes' : 'no');
            if (!yes) { router.back(); return; }
            void syncGuestMailNow().then(load);
        } catch (e) {
            Alert.alert(outsideErrorWords(e, false));
        } finally {
            setBusy(false);
            void load();
        }
    };

    /** Leave, asked first: the chat closes here at once (core leaveGuestChat), and my leave goes. */
    const leave = () => {
        if (!chat || busy) return;
        Alert.alert(t(W.leaveAsk), t(W.leaveWhat), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t(W.leaveYes), style: 'destructive',
                onPress: async () => {
                    setBusy(true);
                    try {
                        await leaveGuestChatNow(chat.id);
                    } catch (e) {
                        Alert.alert(outsideErrorWords(e, false));
                    } finally {
                        setBusy(false);
                        void load();
                    }
                },
            },
        ]);
    };

    const styles = useStyles(({ colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.page },
        container: { flex: 1 },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border.default, gap: 4 },
        backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
        headerText: { flex: 1 },
        name: { fontSize: 17, fontWeight: '700', color: colors.text.body },
        from: { fontSize: 13, color: colors.text.secondary },
        banner: { margin: 12, padding: 12, borderRadius: 12, backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default, gap: 6 },
        bannerText: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
        bannerStrong: { fontSize: 13, lineHeight: 18, color: colors.text.body, fontWeight: '600' },
        list: { paddingHorizontal: 12, paddingBottom: 12 },
        author: { fontSize: 12, fontWeight: '700', color: colors.text.secondary, marginTop: 6, marginLeft: 4 },
        bubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 3 },
        mine: { alignSelf: 'flex-end', backgroundColor: colors.accent.fill },
        theirs: { alignSelf: 'flex-start', backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        mineText: { fontSize: 15, lineHeight: 21, color: colors.text.onAccent },
        theirsText: { fontSize: 15, lineHeight: 21, color: colors.text.body },
        tick: { fontSize: 12, marginTop: 2, alignSelf: 'flex-end', color: colors.text.onAccent, opacity: 0.85 },
        card: { margin: 12, padding: 14, borderRadius: 14, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, gap: 10 },
        cardText: { fontSize: 14, lineHeight: 20, color: colors.text.body },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        accept: { flex: 1, minWidth: 90, minHeight: 44, borderRadius: 10, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
        acceptText: { color: colors.text.inverse, fontWeight: '800', fontSize: 14 },
        plain: { flex: 1, minWidth: 80, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
        plainText: { color: colors.text.body, fontWeight: '700', fontSize: 14 },
        composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8, borderTopWidth: 1, borderTopColor: colors.border.default },
        input: { flex: 1, minHeight: 44, maxHeight: 140, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent.fill },
        note: { padding: 16, fontSize: 14, lineHeight: 20, color: colors.text.secondary, textAlign: 'center' },
        leaveBtn: { minHeight: 44, minWidth: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
        leaveText: { color: colors.text.body, fontWeight: '700', fontSize: 14 },
    }));

    if (chat === undefined) return <SafeAreaView style={styles.safeArea} />;
    const viewer = chat ? guestViewerOf(chat) : null;
    const canWrite = !!chat && chat.state === 'in' && viewer !== null && guestAccess(viewer, 'chat') === 'shown';
    // Leave while joining or in; once out there is nothing to leave.
    const canLeave = !!chat && (chat.state === 'in' || chat.state === 'joining');
    const closed = chat ? guestClosedWords(chat) : null;
    const names = chat?.roster && viewer !== null && guestAccess(viewer, 'roster') === 'shown'
        ? [...chat.roster.members.map((m) => m.name), ...chat.roster.guests.map((g) => guestNameLine(g.name, g.home))].join(', ')
        : null;

    return (
        <SafeAreaView style={styles.safeArea} testID="guest-chat">
            <KeyboardAvoidingView style={styles.container} behavior="padding">
                <View style={styles.header}>
                    <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('Go back')}>
                        <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.body} />
                    </Pressable>
                    <View style={styles.headerText}>
                        <Text style={styles.name} numberOfLines={1}>{chat?.name || t('Group chat')}</Text>
                        {/* The whole community, never cut: a long one wraps. */}
                        {chat && <Text style={styles.from} testID="guest-chat-from">{chat.host}</Text>}
                        {/* The names in the chat, as a guest may see them (core guestAccess 'roster'): members, then guests. */}
                        {names && <Text style={styles.from} testID="guest-chat-names">{names}</Text>}
                    </View>
                    {/* Leave, while joining or in: asked first. Always in view, whatever the chat has scrolled to. */}
                    {canLeave && (
                        <Pressable style={[styles.leaveBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={leave} accessibilityRole="button"
                            accessibilityLabel={t(W.leave)} testID="guest-chat-leave">
                            <Text style={styles.leaveText}>{t(W.leaveYes)}</Text>
                        </Pressable>
                    )}
                </View>
                {!chat ? (
                    <Text style={styles.note}>{t('This chat is not on this phone.')}</Text>
                ) : chat.state === 'invited' ? (
                    <View style={styles.card} testID="guest-invitation">
                        <Text style={styles.cardText}>
                            {t(W.invitedYou, { name: chat.invitedBy?.name || t('Someone'), group: chat.name, community: chat.host })}
                        </Text>
                        <Text style={styles.bannerText}>{t(W.youAreGuest)}</Text>
                        <View style={styles.actions}>
                            <Pressable style={[styles.accept, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => void answer(true)} accessibilityRole="button" testID="guest-invitation-accept">
                                <Text style={styles.acceptText}>{t('Accept', undefined, 'button: accept a message request')}</Text>
                            </Pressable>
                            <Pressable style={[styles.plain, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => void answer(false)} accessibilityRole="button" testID="guest-invitation-decline">
                                <Text style={styles.plainText}>{t('Decline', undefined, 'button: decline a message request')}</Text>
                            </Pressable>
                        </View>
                    </View>
                ) : (
                    <FlatList
                        ref={listRef}
                        data={chat.lines}
                        keyExtractor={(l) => l.id}
                        contentContainerStyle={styles.list}
                        keyboardShouldPersistTaps="handled"
                        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
                        ListHeaderComponent={(
                            <View style={styles.banner} testID="guest-chat-banner">
                                <Text style={styles.bannerStrong}>{t(W.youAreGuest)}</Text>
                                <Text style={styles.bannerText}>{t(W.keptHere)}</Text>
                                <Text style={styles.bannerText}>{t(W.newDevice)}</Text>
                                {chat.state === 'joining' && <Text style={styles.bannerStrong} testID="guest-chat-joining">{t(W.joining)}</Text>}
                                {closed && <Text style={styles.bannerStrong} testID="guest-chat-closed">{closed}</Text>}
                            </View>
                        )}
                        renderItem={({ item, index }) => {
                            if (item.author !== me) {
                                const prev = chat.lines[index - 1];
                                const who = guestChatAuthorName(chat, item.author);
                                return (
                                    <View>
                                        {prev?.author !== item.author && <Text style={styles.author} testID="guest-line-author">{who}</Text>}
                                        <View style={[styles.bubble, styles.theirs]} accessibilityLabel={t('{who}: {text}', { who, text: item.text })} testID="guest-line-theirs">
                                            <Text style={styles.theirsText} selectable>{item.text}</Text>
                                        </View>
                                    </View>
                                );
                            }
                            const tick = guestLineStateWords(item.state);
                            const why = item.state === 'failed' ? item.note : null;
                            return (
                                <View style={[styles.bubble, styles.mine]} accessibilityLabel={[item.text, tick, why].filter(Boolean).join('. ')} testID="guest-line-mine">
                                    <Text style={styles.mineText} selectable>{item.text}</Text>
                                    {tick && <Text style={styles.tick} testID="guest-line-state">{tick}</Text>}
                                    {why && <Text style={styles.tick}>{why}</Text>}
                                </View>
                            );
                        }}
                    />
                )}
                {canWrite && (
                    <View style={styles.composer}>
                        <TextInput
                            style={styles.input}
                            value={text}
                            onChangeText={setText}
                            placeholder={t('Message')}
                            placeholderTextColor={colors.text.muted}
                            accessibilityLabel={t('Message {name}', { name: chat!.name })}
                            multiline
                            maxLength={GUEST_LINE_TEXT_MAX}
                            testID="guest-chat-input"
                        />
                        <Pressable style={[styles.sendBtn, (busy || !text.trim()) && { opacity: 0.6 }]} onPress={() => void send()} disabled={busy || !text.trim()}
                            accessibilityRole="button" accessibilityLabel={t('Send')} testID="guest-chat-send">
                            <MaterialCommunityIcons name="send" size={20} color={colors.text.onAccent} />
                        </Pressable>
                    </View>
                )}
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}
