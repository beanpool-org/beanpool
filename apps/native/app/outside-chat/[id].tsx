/**
 * A chat with someone in another community (messages across communities X3: scratch/fable-design/DESIGN-cross-chat-voice-
 * fable.md §3.4, §3.5; DESIGN-cross-community-chat-fable.md §2.4 "History and recovery"). Its lines are kept on this phone
 * only (utils/outside-chat-store.ts), and the chat says so above its first line. A chat this phone learned of from the outbox
 * after a restore from 12 words is empty, and says why. A request waiting for the member shows its one line with Accept,
 * Decline and Block, and nothing can be written to it until Accept. The other person's name is the one they gave inside the
 * sealed line or on their card, never checked by this community: shown "name not confirmed here", with their community.
 * In an open chat a tap on a line offers the chat's reactions and, on a line of mine, Edit message and Delete message (X6:
 * each a sealed item of its own, utils/outside-mail.ts sendOutsideChange). A tap on a line of theirs offers Report message in
 * every state of the chat, a request's included (design §3.5: Accept, Decline, Report): core outsideLineActions, the web's rule.
 *
 * `community` (slice S4, scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3): the chat is kept in the file of
 * another community this phone holds. It opens there with no switch: read, answered and fetched in that community's file
 * and through its server only (utils/outside-chat-live.ts outsideContext), its copy held open in place while this screen
 * is up (db.ts enterChatInPlace ... leaveChatInPlace). Without it, the community in use's, as before.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, FlatList, DeviceEventEmitter } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    ACROSS_FIRST_LINE_NOTE, OUTSIDE_LINE_TEXT_MAX, OUTSIDE_REACTIONS, OUTSIDE_WRITES_STAY_THERE, acrossFirstLineNoteUnder, outsideLineActions, outsideLineShown, outsideLineWords, t,
    type OutsideChange, type OutsideChangeKind,
} from '@beanpool/core';
import { Alert } from '../../utils/keyboard-alert';
import { useTheme, useStyles } from '../ThemeContext';
import { enterChatInPlace, leaveChatInPlace } from '../../utils/db';
import { OutsideMailError, heldReceiptsOn, outsideQuiet, reportOutsideLine, sendFromBox, sendOutsideChange, setOutsideQuiet } from '../../utils/outside-mail';
import { reportedAlertBody } from '../../utils/reportReasons';
import { ReportMessageSheet } from '../../components/ReportMessageSheet';
import { blockFromAcross, OUTSIDE_CHATS_UPDATED, OUTSIDE_SEND_MS, outsideContext, outsideErrorWords, syncOutsideMailNow } from '../../utils/outside-chat-live';
import type { OutsideChat, OutsideLine, OutsideLineState } from '../../utils/outside-chat-store';
import { useScreenKeyboardOffset } from '../../components/useScreenKeyboardOffset';
import { twoParagraphs } from '../../utils/alert-words';

/** Core's sentences, the web's too (@beanpool/core outside-devices.ts, message-path.ts). */
const LINES = { writesStayThere: OUTSIDE_WRITES_STAY_THERE, firstLineNote: ACROSS_FIRST_LINE_NOTE };

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
    const { id, community } = useLocalSearchParams<{ id: string; community?: string }>();
    // The community whose file carries this chat, when not the one in use (slice S4): every read, write and round names it.
    const where = typeof community === 'string' && community ? community : null;
    const { colors } = useTheme();
    // The screen's top in the window, for the KeyboardAvoidingView (an iPhone sheet starts ~50 pt down: utils/screen-keyboard-offset).
    const screenKeyboard = useScreenKeyboardOffset();
    const [me, setMe] = useState<string | null>(null);
    const [chat, setChat] = useState<OutsideChat | null | undefined>(undefined);
    const [lines, setLines] = useState<OutsideLine[]>([]);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    // A line of theirs being reported (X5): the sheet asks why; the server blocks them and tells their community.
    const [reporting, setReporting] = useState<OutsideLine | null>(null);
    const [picked, setPicked] = useState<string | null>(null);
    // Changes to lines (X6): each person's newest edit, reaction and delete, kept here; and a line of mine being edited.
    const [changes, setChanges] = useState<OutsideChange[]>([]);
    const [editing, setEditing] = useState<OutsideLine | null>(null);
    // What was typed in the box when an edit began: set aside, and back in the box after Save or Cancel, never lost.
    const [typedAside, setTypedAside] = useState('');
    // The across mute (slice S4): their lines ring nothing, as this phone keeps it and my server was told.
    const [quiet, setQuiet] = useState(false);
    const listRef = useRef<FlatList<OutsideLine>>(null);

    // Held open in place for as long as this screen is up, before its first read (slice S4); closed as it goes.
    useEffect(() => {
        if (!where) return;
        enterChatInPlace(where);
        return () => { void leaveChatInPlace(where); };
    }, [where]);

    const load = useCallback(async () => {
        const ctx = await outsideContext(where);
        if (!ctx || !id) { setChat(null); return; }
        setMe(ctx.identity.publicKey);
        const c = await ctx.store.chat(ctx.identity.publicKey, String(id)).catch(() => null);
        setChat(c);
        setLines(c ? await ctx.store.lines(c.id).catch(() => []) : []);
        setChanges(c ? await ctx.store.changes(c.id).catch(() => []) : []);
        setQuiet(c ? await outsideQuiet(ctx.store, ctx.identity.publicKey, c.peerKey).catch(() => false) : false);
        // Opened: a chat whose first line the member-here mark let in straight away lets its held receipts go (core
        // outsideHeldReceipts); a request opened still holds them ("They will not know you saw this unless you accept").
        if (c) await heldReceiptsOn(ctx, c.id, 'open').catch(() => null);
    }, [id, where]);

    useEffect(() => {
        void load();
        const sub = DeviceEventEmitter.addListener(OUTSIDE_CHATS_UPDATED, load);
        return () => sub.remove();
    }, [load]);

    useFocusEffect(useCallback(() => {
        void syncOutsideMailNow(undefined, where).then(load);
        const timer = setInterval(() => { void syncOutsideMailNow(undefined, where).then(load); }, POLL_MS);
        return () => clearInterval(timer);
    }, [load, where]));

    /** An edit, a reaction or a delete of a line, applied here at once and sent (X6); my server's words if it says no. */
    const change = async (c: { kind: OutsideChangeKind; lineId: string; text?: string; emoji?: string }): Promise<boolean> => {
        const ctx = await outsideContext(where);
        if (!ctx || !chat) return false;
        try {
            await sendOutsideChange(ctx, chat.id, c);
            return true;
        } catch (e) {
            Alert.alert(t('Not sent'), outsideErrorWords(e, !(e instanceof OutsideMailError)));
            return false;
        } finally {
            setPicked(null);
            await load();
        }
    };

    const removeForEveryone = (line: OutsideLine) => {
        Alert.alert(t('Delete for everyone?'), t('It will read "This message was deleted" for both of you.'), [
            { text: t('Cancel'), style: 'cancel' },
            { text: t('Delete'), style: 'destructive', onPress: () => void change({ kind: 'dm-delete', lineId: line.id }) },
        ]);
    };

    const startEditing = (line: OutsideLine, words: string) => {
        if (!editing) setTypedAside(text);
        setEditing(line);
        setText(words);
        setPicked(null);
    };
    const stopEditing = () => { setEditing(null); setText(typedAside); setTypedAside(''); };

    const send = async () => {
        const words = text.trim();
        if (!words || busy || !chat) return;
        setBusy(true);
        try {
            if (editing) {
                if (await change({ kind: 'dm-edit', lineId: editing.id, text: words })) stopEditing();
                return;
            }
            const ctx = await outsideContext(where);
            if (!ctx) return;
            // The box empties once the line is kept here, and the line shows at once (Sending…), never before: a send that fails
            // before that leaves the words in the box. Its own deadline: a send my server never answers leaves the line
            // `sending` (it goes at the next round) and the composer free. Words typed while it ran are left as they are.
            const { kept, error } = await sendFromBox(ctx, chat.id, words, OUTSIDE_SEND_MS, () => {
                setText((now) => (now.trim() === words ? '' : now));
                void load();
            });
            if (error) Alert.alert(t('Not sent'), outsideErrorWords(error, kept));
            await load();
        } finally {
            setBusy(false);
        }
    };

    const decide = async (state: 'open' | 'declined') => {
        const ctx = await outsideContext(where);
        if (!ctx || !chat) return;
        await ctx.store.decide(ctx.identity.publicKey, chat.id, state);
        await heldReceiptsOn(ctx, chat.id, state === 'open' ? 'accept' : 'decline').catch(() => null);
        if (state === 'declined') { router.back(); return; }
        await load();
    };

    /** Their lines ring nothing, or ring again: my server told first, then kept here (utils/outside-mail.ts setOutsideQuiet). */
    const toggleQuiet = async () => {
        const ctx = await outsideContext(where);
        if (!ctx || !chat) return;
        try {
            await setOutsideQuiet(ctx, chat.peerKey, !quiet);
            setQuiet(!quiet);
        } catch (e) {
            Alert.alert(t('Not sent'), e instanceof OutsideMailError && e.message && !/^HTTP \d+$/.test(e.message) ? e.message : t('That did not go through. Please try again.'));
        }
    };

    const block = () => {
        if (!chat) return;
        // The name in the message: a card's name or a community's address can be longer than a title's two lines.
        Alert.alert(t('Block this user?'), twoParagraphs(chat.peerName ?? chat.peerHome, t("They won't be told. Nothing more from them will reach you.")), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t('Block'), style: 'destructive', onPress: async () => {
                    // Blocked for the account, and told to the community that carries this chat, in place or not: its mailbox is
                    // the one that holds and rings their lines (#3310 r3 review F1).
                    await blockFromAcross(where, chat.peerKey);
                    const ctx = await outsideContext(where);
                    if (ctx) await heldReceiptsOn(ctx, chat.id, 'block').catch(() => null);
                    if (ctx) await ctx.store.decide(ctx.identity.publicKey, chat.id, 'declined');
                    router.back();
                },
            },
        ]);
    };

    // Report on a line from another community always blocks its sender (the sheet says so). The line goes to my community's
    // moderators with its sender's signatures; their community is told, never who reported. The sheet stays until OK.
    const submitReport = async (reason: string) => {
        const ctx = await outsideContext(where);
        if (!reporting || !chat || !ctx) return;
        try {
            await reportOutsideLine(ctx, reporting.id, reason);
            await blockFromAcross(where, chat.peerKey);
            await heldReceiptsOn(ctx, chat.id, 'block').catch(() => null);
            await ctx.store.decide(ctx.identity.publicKey, chat.id, 'declined');
            Alert.alert(t('Reported'), reportedAlertBody(undefined, reason), [{ text: t('OK'), onPress: () => { setReporting(null); router.back(); } }]);
        } catch (e) {
            Alert.alert(t('Not sent'), e instanceof OutsideMailError && e.message && !/^HTTP \d+$/.test(e.message) ? e.message : t('That did not go through. Please try again.'));
            throw e; // the sheet keeps the choice and the words
        }
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
        firstLineNote: { fontSize: 13, lineHeight: 18, marginTop: 4, alignSelf: 'flex-end', maxWidth: '85%', textAlign: 'right', color: colors.text.secondary },
        request: { margin: 12, padding: 14, borderRadius: 14, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, gap: 10 },
        requestText: { fontSize: 14, lineHeight: 20, color: colors.text.body },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        accept: { flex: 1, minWidth: 90, minHeight: 44, borderRadius: 10, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
        acceptText: { color: colors.text.inverse, fontWeight: '800', fontSize: 14 },
        plain: { flex: 1, minWidth: 80, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
        plainText: { color: colors.text.body, fontWeight: '700', fontSize: 14 },
        danger: { color: colors.feedback.danger.fg, fontWeight: '700', fontSize: 14 },
        reportLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 4, alignSelf: 'flex-start' },
        actionsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 4 },
        emojiBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
        emojiMine: { backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default },
        emoji: { fontSize: 20 },
        actionText: { color: colors.text.body, fontWeight: '700', fontSize: 14 },
        deletedText: { fontSize: 15, lineHeight: 21, fontStyle: 'italic', color: colors.text.secondary },
        reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: -2, marginBottom: 2 },
        reactionChip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        reactionCount: { fontSize: 12, color: colors.text.secondary },
        editingBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 8 },
        editingText: { flex: 1, fontSize: 13, color: colors.text.secondary },
        composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8, borderTopWidth: 1, borderTopColor: colors.border.default },
        input: { flex: 1, minHeight: 44, maxHeight: 140, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent.fill },
        empty: { padding: 24, fontSize: 14, color: colors.text.secondary, textAlign: 'center' },
    }));

    if (chat === undefined) return <SafeAreaView style={styles.safeArea} />;
    const name = chat?.peerName ?? t('Someone in another community');
    // The line the note goes under (core acrossFirstLineNoteUnder): my first, while no line of theirs is here.
    const noteUnder = chat && me ? acrossFirstLineNoteUnder(lines, me, chat.restored) : null;

    return (
        <SafeAreaView style={styles.safeArea} testID="outside-chat" onLayout={screenKeyboard.onScreenLayout}>
            <KeyboardAvoidingView style={styles.container} behavior="padding" keyboardVerticalOffset={screenKeyboard.keyboardVerticalOffset}>
                <View style={styles.header}>
                    <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('Go back')}>
                        <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.body} />
                    </Pressable>
                    <View style={styles.headerText}>
                        <Text style={styles.name} numberOfLines={1}>{name}</Text>
                        {chat && (
                            // The whole home, and "name not confirmed here" after it, never cut: no line limit (a limit cuts
                            // at the tail on Android, where the real domain and that warning are). A long home wraps.
                            <Text style={styles.from} testID="outside-chat-from">
                                {chat.peerName ? t('{community} · name not confirmed here', { community: chat.peerHome }) : chat.peerHome}
                            </Text>
                        )}
                    </View>
                    {chat && chat.state === 'open' && (
                        <Pressable style={styles.backBtn} onPress={() => void toggleQuiet()} accessibilityRole="button" testID="outside-chat-quiet"
                            accessibilityLabel={quiet ? t('Unmute') : t('Mute notifications')} accessibilityState={{ selected: quiet }}>
                            <MaterialCommunityIcons name={quiet ? 'bell-off-outline' : 'bell-outline'} size={22} color={colors.text.secondary} />
                        </Pressable>
                    )}
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
                                {/* Each device for itself (X2b): their lines reach every device; mine stay where I wrote them. */}
                                <Text style={styles.bannerText} testID="outside-chat-writes-stay">{t(LINES.writesStayThere)}</Text>
                                {chat.restored && lines.length === 0 && (
                                    <Text style={styles.bannerText} testID="outside-chat-restored">
                                        {t("This phone was set up from your 12 words, so earlier messages in this chat aren't here. Messages with people in other communities are kept only on the phone that got them.")}
                                    </Text>
                                )}
                            </View>
                        )}
                        renderItem={({ item }) => {
                            // The line with its changes applied (X6): its writer's newest edit, each person's newest reaction, or deleted.
                            const shown = outsideLineShown(item, changes, me ?? '');
                            // The same rule in one string (core outsideLineWords): what the Chats list shows of it, and a screen reader says.
                            const words = outsideLineWords(item, changes, me ?? '');
                            const mine = item.author === me;
                            // Only what changes the chat needs it open; Report message is on every line of theirs not deleted (core's rule).
                            const can = outsideLineActions(chat.state, { mine, deleted: shown.deleted });
                            const toggle = () => setPicked((p) => (p === item.id ? null : item.id));
                            const body = shown.deleted
                                ? <Text style={styles.deletedText} testID="outside-line-deleted">{t('This message was deleted')}</Text>
                                : <Text style={mine ? styles.mineText : styles.theirsText} selectable>{shown.text}</Text>;
                            const myReaction = shown.reactions.find((r) => r.mine)?.emoji ?? null;
                            const actions = picked === item.id && (can.react || can.edit || can.remove || can.report) && (
                                <View style={[styles.actionsRow, mine && { alignSelf: 'flex-end' }]} testID="outside-line-actions">
                                    {can.react && OUTSIDE_REACTIONS.map((emoji) => (
                                        <Pressable key={emoji} style={[styles.emojiBtn, myReaction === emoji && styles.emojiMine]} accessibilityRole="button"
                                            accessibilityLabel={t('React with {emoji}', { emoji })} accessibilityState={{ selected: myReaction === emoji }}
                                            onPress={() => void change({ kind: 'dm-reaction', lineId: item.id, emoji: myReaction === emoji ? '' : emoji })}>
                                            <Text style={styles.emoji}>{emoji}</Text>
                                        </Pressable>
                                    ))}
                                    {can.edit && (
                                        <Pressable style={styles.reportLine} accessibilityRole="button" testID="outside-line-edit"
                                            onPress={() => startEditing(item, shown.text)}>
                                            <MaterialCommunityIcons name="pencil-outline" size={16} color={colors.text.body} />
                                            <Text style={styles.actionText}>{t('Edit message')}</Text>
                                        </Pressable>
                                    )}
                                    {can.remove && (
                                        <Pressable style={styles.reportLine} accessibilityRole="button" testID="outside-line-delete" onPress={() => removeForEveryone(item)}>
                                            <MaterialCommunityIcons name="trash-can-outline" size={16} color={colors.feedback.danger.fg} />
                                            <Text style={styles.danger}>{t('Delete message')}</Text>
                                        </Pressable>
                                    )}
                                    {can.report && (
                                        <Pressable style={styles.reportLine} onPress={() => setReporting(item)} accessibilityRole="button" testID="outside-line-report">
                                            <MaterialCommunityIcons name="flag-outline" size={16} color={colors.feedback.danger.fg} />
                                            <Text style={styles.danger}>{t('Report message')}</Text>
                                        </Pressable>
                                    )}
                                </View>
                            );
                            const reactions = shown.reactions.length > 0 && (
                                <View style={[styles.reactions, mine && { alignSelf: 'flex-end' }]} testID="outside-line-reactions">
                                    {shown.reactions.map((r) => (
                                        <View key={r.emoji} style={[styles.reactionChip, r.mine && styles.emojiMine]}>
                                            <Text>{r.emoji}</Text>
                                            {r.count > 1 && <Text style={styles.reactionCount}>{r.count}</Text>}
                                        </View>
                                    ))}
                                </View>
                            );
                            const edited = shown.edited ? t('edited') : null;
                            if (!mine) {
                                // Tap a line of theirs for Report message under it (in any state), and its reactions in an open chat; the words stay selectable.
                                return (
                                    <View>
                                        <Pressable style={[styles.bubble, styles.theirs]} accessibilityLabel={[words, edited].filter(Boolean).join('. ')}
                                            testID="outside-line-theirs" onPress={toggle}>
                                            {body}
                                            {edited && <Text style={[styles.tick, { color: colors.text.secondary }]} testID="outside-line-edited">{edited}</Text>}
                                        </Pressable>
                                        {reactions}
                                        {actions}
                                    </View>
                                );
                            }
                            // Mine: its tick, and for a line my server refused, its words why; a deleted line has nothing left to deliver.
                            const tick = shown.deleted ? null : outsideLineStateWords(item.state);
                            const why = !shown.deleted && item.state === 'failed' ? item.note : null;
                            const said = [words, edited, tick, why].filter(Boolean).join('. ');
                            return (
                                <View>
                                    <Pressable style={[styles.bubble, styles.mine]} accessibilityLabel={said} testID="outside-line-mine" onPress={toggle}>
                                        {body}
                                        {edited && <Text style={styles.tick} testID="outside-line-edited">{edited}</Text>}
                                        {tick && <Text style={styles.tick} testID="outside-line-state">{tick}</Text>}
                                        {why && <Text style={styles.tick} testID="outside-line-why">{why}</Text>}
                                    </Pressable>
                                    {/* Under my first line while they have written nothing here (slice S5 part 2: core acrossFirstLineNoteUnder). */}
                                    {item.id === noteUnder && <Text style={styles.firstLineNote} testID="outside-first-line-note">{t(LINES.firstLineNote)}</Text>}
                                    {reactions}
                                    {actions}
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
                    <View>
                    {editing && (
                        <View style={styles.editingBar} testID="outside-chat-editing">
                            <MaterialCommunityIcons name="pencil-outline" size={16} color={colors.text.secondary} />
                            <Text style={styles.editingText} numberOfLines={1}>{t('Edit message')}</Text>
                            <Pressable style={styles.backBtn} onPress={stopEditing} accessibilityRole="button" accessibilityLabel={t('Cancel')} testID="outside-chat-edit-cancel">
                                <MaterialCommunityIcons name="close" size={20} color={colors.text.secondary} />
                            </Pressable>
                        </View>
                    )}
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
                            accessibilityRole="button" accessibilityLabel={editing ? t('Save') : t('Send')} testID="outside-chat-send">
                            <MaterialCommunityIcons name={editing ? 'check' : 'send'} size={20} color={colors.text.onAccent} />
                        </Pressable>
                    </View>
                    </View>
                ) : null}
            </KeyboardAvoidingView>
            <ReportMessageSheet isOpen={!!reporting} photo={false} blocks onSubmit={submitReport} onClose={() => setReporting(null)} />
        </SafeAreaView>
    );
}
