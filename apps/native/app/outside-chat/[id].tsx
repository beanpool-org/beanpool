/**
 * A chat with someone in another community (messages across communities X3: scratch/fable-design/DESIGN-cross-chat-voice-
 * fable.md §3.4, §3.5; DESIGN-cross-community-chat-fable.md §2.4 "History and recovery"). Its lines are kept on this phone
 * only (utils/outside-chat-store.ts), and the chat says so above its first line. A chat this phone learned of from the outbox
 * after a restore from 12 words is empty, and says why. A request waiting for the member shows its one line with Accept,
 * Decline and Block, and nothing can be written to it until Accept. The other person's name is the one they gave inside the
 * sealed line or on their card, never checked by this community: shown "name not confirmed here", with their community.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, FlatList, DeviceEventEmitter } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { OUTSIDE_LINE_TEXT_MAX, t } from '@beanpool/core';
import { Alert } from '../../utils/keyboard-alert';
import { useTheme, useStyles } from '../ThemeContext';
import { blockUser } from '../../utils/blocklist';
import { sendFromBox } from '../../utils/outside-mail';
import { OUTSIDE_CHATS_UPDATED, OUTSIDE_SEND_MS, outsideContext, outsideErrorWords, syncOutsideMailNow } from '../../utils/outside-chat-live';
import type { OutsideChat, OutsideLine, OutsideLineState } from '../../utils/outside-chat-store';

/** How often an open chat asks for what waits, while it is on screen. */
const POLL_MS = 15_000;

/** A line of mine, as its tick reads. */
function outsideLineStateWords(state: OutsideLineState | null): string | null {
    switch (state) {
        case 'sending': return t('Sending…');
        case 'queued': return t('Waiting for their community');
        case 'sent': return t('Sent', undefined, 'a message');
        case 'delivered': return t('Delivered', undefined, 'a message');
        case 'failed': case 'expired': return t('Not delivered');
        default: return null;
    }
}

export default function OutsideChatScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const { colors } = useTheme();
    const [me, setMe] = useState<string | null>(null);
    const [chat, setChat] = useState<OutsideChat | null | undefined>(undefined);
    const [lines, setLines] = useState<OutsideLine[]>([]);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const listRef = useRef<FlatList<OutsideLine>>(null);

    const load = useCallback(async () => {
        const ctx = await outsideContext();
        if (!ctx || !id) { setChat(null); return; }
        setMe(ctx.identity.publicKey);
        const c = await ctx.store.chat(ctx.identity.publicKey, String(id)).catch(() => null);
        setChat(c);
        setLines(c ? await ctx.store.lines(c.id).catch(() => []) : []);
    }, [id]);

    useEffect(() => {
        void load();
        const sub = DeviceEventEmitter.addListener(OUTSIDE_CHATS_UPDATED, load);
        return () => sub.remove();
    }, [load]);

    useFocusEffect(useCallback(() => {
        void syncOutsideMailNow().then(load);
        const timer = setInterval(() => { void syncOutsideMailNow().then(load); }, POLL_MS);
        return () => clearInterval(timer);
    }, [load]));

    const send = async () => {
        const words = text.trim();
        if (!words || busy || !chat) return;
        setBusy(true);
        try {
            const ctx = await outsideContext();
            if (!ctx) return;
            // The box empties once the line is kept here (shown as Sending… or Not delivered), never before: a send that fails
            // before that leaves the words in the box. Its own deadline: a send my server never answers leaves the line
            // `sending` (it goes at the next round) and the composer free. Words typed while it ran are left as they are.
            const { kept, error } = await sendFromBox(ctx, chat.id, words, OUTSIDE_SEND_MS, () => setText((now) => (now.trim() === words ? '' : now)));
            if (error) Alert.alert(outsideErrorWords(error, kept));
            await load();
        } finally {
            setBusy(false);
        }
    };

    const decide = async (state: 'open' | 'declined') => {
        const ctx = await outsideContext();
        if (!ctx || !chat) return;
        await ctx.store.decide(ctx.identity.publicKey, chat.id, state);
        if (state === 'declined') { router.back(); return; }
        await load();
    };

    const block = () => {
        if (!chat) return;
        Alert.alert(t('Block {name}?', { name: chat.peerName ?? chat.peerHome }), t("They won't be told. Nothing more from them will reach you."), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t('Block'), style: 'destructive', onPress: async () => {
                    await blockUser(chat.peerKey);
                    const ctx = await outsideContext();
                    if (ctx) await ctx.store.decide(ctx.identity.publicKey, chat.id, 'declined');
                    router.back();
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
        bubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 4 },
        mine: { alignSelf: 'flex-end', backgroundColor: colors.accent.fill },
        theirs: { alignSelf: 'flex-start', backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        mineText: { fontSize: 15, lineHeight: 21, color: colors.text.onAccent },
        theirsText: { fontSize: 15, lineHeight: 21, color: colors.text.body },
        tick: { fontSize: 12, marginTop: 2, alignSelf: 'flex-end', color: colors.text.onAccent, opacity: 0.85 },
        request: { margin: 12, padding: 14, borderRadius: 14, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, gap: 10 },
        requestText: { fontSize: 14, lineHeight: 20, color: colors.text.body },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        accept: { flex: 1, minWidth: 90, minHeight: 44, borderRadius: 10, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
        acceptText: { color: colors.text.inverse, fontWeight: '800', fontSize: 14 },
        plain: { flex: 1, minWidth: 80, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
        plainText: { color: colors.text.body, fontWeight: '700', fontSize: 14 },
        danger: { color: colors.feedback.danger.fg, fontWeight: '700', fontSize: 14 },
        composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8, borderTopWidth: 1, borderTopColor: colors.border.default },
        input: { flex: 1, minHeight: 44, maxHeight: 140, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent.fill },
        empty: { padding: 24, fontSize: 14, color: colors.text.secondary, textAlign: 'center' },
    }));

    if (chat === undefined) return <SafeAreaView style={styles.safeArea} />;
    const name = chat?.peerName ?? t('Someone in another community');

    return (
        <SafeAreaView style={styles.safeArea} testID="outside-chat">
            <KeyboardAvoidingView style={styles.container} behavior="padding">
                <View style={styles.header}>
                    <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('Go back')}>
                        <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.body} />
                    </Pressable>
                    <View style={styles.headerText}>
                        <Text style={styles.name} numberOfLines={1}>{name}</Text>
                        {chat && (
                            <Text style={styles.from} numberOfLines={2}>
                                {chat.peerName ? t('{community} · name not confirmed here', { community: chat.peerHome }) : chat.peerHome}
                            </Text>
                        )}
                    </View>
                    {chat && chat.state !== 'request' && (
                        <Pressable style={styles.backBtn} onPress={block} accessibilityRole="button" accessibilityLabel={t('Block {name}', { name })}>
                            <MaterialCommunityIcons name="account-cancel-outline" size={22} color={colors.text.secondary} />
                        </Pressable>
                    )}
                </View>
                {!chat ? (
                    <Text style={styles.empty}>{t('This chat is not on this phone.')}</Text>
                ) : (
                    <FlatList
                        ref={listRef}
                        data={lines}
                        keyExtractor={(l) => l.id}
                        contentContainerStyle={styles.list}
                        keyboardShouldPersistTaps="handled"
                        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
                        ListHeaderComponent={(
                            <View style={styles.banner} testID="outside-chat-kept-here">
                                <Text style={styles.bannerStrong}>{t('Kept on this phone only. Your community keeps no copy.')}</Text>
                                {chat.restored && lines.length === 0 && (
                                    <Text style={styles.bannerText} testID="outside-chat-restored">
                                        {t("This phone was set up from your 12 words, so earlier messages in this chat aren't here. Messages with people in other communities are kept only on the phone that got them.")}
                                    </Text>
                                )}
                            </View>
                        )}
                        renderItem={({ item }) => {
                            if (item.author !== me) {
                                return (
                                    <View style={[styles.bubble, styles.theirs]} accessibilityLabel={item.text}>
                                        <Text style={styles.theirsText} selectable>{item.text}</Text>
                                    </View>
                                );
                            }
                            // Mine: its tick, and for a line my server refused, its words why.
                            const tick = outsideLineStateWords(item.state);
                            const why = item.state === 'failed' ? item.note : null;
                            const said = [item.text, tick, why].filter(Boolean).join('. ');
                            return (
                                <View style={[styles.bubble, styles.mine]} accessibilityLabel={said}>
                                    <Text style={styles.mineText} selectable>{item.text}</Text>
                                    {tick && <Text style={styles.tick} testID="outside-line-state">{tick}</Text>}
                                    {why && <Text style={styles.tick} testID="outside-line-why">{why}</Text>}
                                </View>
                            );
                        }}
                    />
                )}
                {chat?.state === 'request' ? (
                    <View style={styles.request} testID="outside-request">
                        <Text style={styles.requestText}>{t('{name} from {community} wants to message you. They will not know you saw this unless you accept.', { name, community: chat.peerHome })}</Text>
                        <View style={styles.actions}>
                            <Pressable style={styles.accept} onPress={() => void decide('open')} accessibilityRole="button" testID="outside-request-accept">
                                <Text style={styles.acceptText}>{t('Accept', undefined, 'button: accept a message request')}</Text>
                            </Pressable>
                            <Pressable style={styles.plain} onPress={() => void decide('declined')} accessibilityRole="button" testID="outside-request-decline">
                                <Text style={styles.plainText}>{t('Decline', undefined, 'button: decline a message request')}</Text>
                            </Pressable>
                            <Pressable style={styles.plain} onPress={block} accessibilityRole="button" testID="outside-request-block">
                                <Text style={styles.danger}>{t('Block')}</Text>
                            </Pressable>
                        </View>
                    </View>
                ) : chat?.state === 'open' ? (
                    <View style={styles.composer}>
                        <TextInput
                            style={styles.input}
                            value={text}
                            onChangeText={setText}
                            placeholder={t('Message')}
                            placeholderTextColor={colors.text.muted}
                            accessibilityLabel={t('Message {name}', { name })}
                            multiline
                            maxLength={OUTSIDE_LINE_TEXT_MAX}
                            testID="outside-chat-input"
                        />
                        <Pressable style={[styles.sendBtn, (busy || !text.trim()) && { opacity: 0.6 }]} onPress={() => void send()} disabled={busy || !text.trim()}
                            accessibilityRole="button" accessibilityLabel={t('Send')} testID="outside-chat-send">
                            <MaterialCommunityIcons name="send" size={20} color={colors.text.onAccent} />
                        </Pressable>
                    </View>
                ) : null}
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}
