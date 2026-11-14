/**
 * The address card and its door (messages across communities X3: scratch/fable-design/DESIGN-cross-chat-voice-fable.md §3.5,
 * §3.6; DESIGN-reaching-across-fable.md §6 item 2, decided 1 Nov).
 *
 * **My card.** Showing it the first time opens the member's door, after one screen that says what that means: people in
 * other communities who have the card can send a message request. The card is `{key, home, name}` signed on this phone, as
 * a QR code and a link (core outside-chat.ts). The door can be closed again here (and in Settings → Privacy, which opens
 * this screen): a stranger's line is then dropped on the phone. Chats already accepted carry on.
 *
 * **Someone's card.** Scanned (the camera is asked for at the tap, never before) or pasted. A card its key did not sign is no
 * card. Then one line, sent as a message request: it waits behind their requests row until they accept.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ScrollView, Share, Switch } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { OUTSIDE_LINE_TEXT_MAX, addressCardFromText, addressCardLink, relayConversationId, t, type AddressCard } from '@beanpool/core';
import { Alert } from '../utils/keyboard-alert';
import { useTheme, useStyles } from './ThemeContext';
import { doorOpen, myAddressCard, myHome, sendFromBox, setDoor } from '../utils/outside-mail';
import { OUTSIDE_SEND_MS, outsideContext, outsideErrorWords, outsideMessagesHere } from '../utils/outside-chat-live';

export default function AddressCardScreen() {
    const params = useLocalSearchParams<{ mode?: string }>();
    const { colors } = useTheme();
    const [here, setHere] = useState<boolean | null>(null);
    const [mine, setMine] = useState<AddressCard | null>(null);
    const [open, setOpen] = useState<boolean | null>(null);
    const [pasted, setPasted] = useState('');
    const [theirs, setTheirs] = useState<AddressCard | null>(null);
    const [cardNote, setCardNote] = useState<string | null>(null);
    const [first, setFirst] = useState('');
    const [busy, setBusy] = useState(false);
    const [Scanner, setScanner] = useState<null | typeof import('../components/ScanCodeModal').default>(null);

    const load = useCallback(async () => {
        const ctx = await outsideContext();
        if (!ctx) { setHere(false); return; }
        const on = await outsideMessagesHere(ctx.nodeUrl);
        setHere(on);
        if (!on) return;
        setOpen(await doorOpen(ctx.store));
    }, []);
    useEffect(() => { void load(); }, [load]);

    /** Show my card: the first time, this is what opens the door. */
    const showMine = async () => {
        const ctx = await outsideContext();
        if (!ctx) return;
        try {
            const card = await myAddressCard(ctx);
            if (!card) { Alert.alert(t("This community's server knows none of its own names yet, so it can't send to another community.")); return; }
            await setDoor(ctx.store, true);
            setOpen(true);
            setMine(card);
        } catch (e) {
            Alert.alert(outsideErrorWords(e));
        }
    };

    const switchDoor = async (next: boolean) => {
        const ctx = await outsideContext();
        if (!ctx) return;
        await setDoor(ctx.store, next);
        setOpen(next);
        if (!next) setMine(null);
    };

    /** A scanned or pasted text: their card, or why not. */
    const readCard = async (text: string): Promise<boolean> => {
        const card = addressCardFromText(text);
        if (!card) { setCardNote(t("That isn't an address card, or it was changed after it was made.")); return false; }
        const ctx = await outsideContext();
        if (!ctx) return false;
        if (card.key === ctx.identity.publicKey) { setCardNote(t("That's your own card.")); return true; }
        if (card.home === await myHome(ctx).catch(() => null)) { setCardNote(t('{name} is in this community: write to them here.', { name: card.name })); return true; }
        setCardNote(null);
        setTheirs(card);
        return true;
    };

    const scan = async () => {
        const m = await import('../components/ScanCodeModal');
        setScanner(() => m.default);
    };

    const sendRequest = async () => {
        const words = first.trim();
        if (!theirs || !words || busy) return;
        setBusy(true);
        try {
            const ctx = await outsideContext();
            if (!ctx) return;
            const chatId = relayConversationId(ctx.identity.publicKey, theirs.key);
            await ctx.store.openChat(ctx.identity.publicKey, chatId, { key: theirs.key, home: theirs.home, name: theirs.name });
            // The words leave this box only once the line is kept (the chat then shows it, Sending… or Not delivered). A send
            // that fails before that stays here with its words, to send again.
            const { kept, error } = await sendFromBox(ctx, chatId, words, OUTSIDE_SEND_MS, () => setFirst((now) => (now.trim() === words ? '' : now)));
            if (error) Alert.alert(outsideErrorWords(error, kept));
            if (kept) router.replace(`/outside-chat/${chatId}`);
        } finally {
            setBusy(false);
        }
    };

    const styles = useStyles(({ colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
        title: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.text.body },
        body: { padding: 16, gap: 14, paddingBottom: 48 },
        card: { padding: 16, borderRadius: 14, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, gap: 10 },
        heading: { fontSize: 16, fontWeight: '700', color: colors.text.body },
        text: { fontSize: 14, lineHeight: 20, color: colors.text.secondary },
        strong: { fontSize: 15, lineHeight: 21, color: colors.text.body, fontWeight: '600' },
        qr: { alignSelf: 'center', borderRadius: 12, overflow: 'hidden' },
        link: { fontSize: 12, color: colors.text.secondary },
        btn: { minHeight: 44, borderRadius: 10, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
        btnText: { color: colors.text.inverse, fontWeight: '800', fontSize: 15 },
        plain: { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
        plainText: { color: colors.text.body, fontWeight: '700', fontSize: 15 },
        row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
        rowText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.text.body },
        input: { minHeight: 44, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.page, borderWidth: 1, borderColor: colors.border.default },
        note: { fontSize: 14, lineHeight: 20, color: colors.feedback.warning.fg },
    }));

    return (
        <SafeAreaView style={styles.safeArea} testID="address-card">
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <View style={styles.header}>
                    <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('Go back')}>
                        <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.body} />
                    </Pressable>
                    <Text style={styles.title} numberOfLines={2}>{t('People in other communities')}</Text>
                </View>
                <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                    {here === false ? (
                        <Text style={styles.text}>{t("This community doesn't take messages from other communities.")}</Text>
                    ) : here === null ? null : (
                        <>
                            {params.mode !== 'scan' && (
                                <View style={styles.card} testID="my-address-card">
                                    <Text style={styles.heading}>{t('My address card')}</Text>
                                    {mine ? (
                                        <>
                                            <View style={styles.qr} accessibilityLabel={t('Your address card as a QR code')}>
                                                {/* Its own white quiet zone, in both themes: a scanner needs dark modules on a light ground. */}
                                                <QRCode value={addressCardLink(mine)} size={220} quietZone={12} backgroundColor="#ffffff" color="#000000" />
                                            </View>
                                            <Text style={styles.strong}>{t('{name} · {community}', { name: mine.name, community: mine.home })}</Text>
                                            <Text style={styles.link} selectable numberOfLines={3}>{addressCardLink(mine)}</Text>
                                            <Pressable style={styles.plain} accessibilityRole="button" onPress={() => void Share.share({ message: addressCardLink(mine) })}>
                                                <Text style={styles.plainText}>{t('Share my card')}</Text>
                                            </Pressable>
                                        </>
                                    ) : (
                                        <>
                                            <Text style={styles.text}>
                                                {t('Anyone you show your card to can send you one message request from their own community. You choose whether to accept. Your community keeps no copy of these chats: they are kept on your phone only.')}
                                            </Text>
                                            <Pressable style={styles.btn} accessibilityRole="button" onPress={() => void showMine()} testID="show-my-card">
                                                <Text style={styles.btnText}>{t('Show my card')}</Text>
                                            </Pressable>
                                        </>
                                    )}
                                    {open !== null && (open || mine) && (
                                        <View style={styles.row}>
                                            <Text style={styles.rowText}>{t('People in other communities can send me a message request')}</Text>
                                            <Switch value={!!open} onValueChange={(v) => void switchDoor(v)} accessibilityLabel={t('People in other communities can send me a message request')} />
                                        </View>
                                    )}
                                </View>
                            )}
                            <View style={styles.card} testID="their-address-card">
                                <Text style={styles.heading}>{t("Someone else's card")}</Text>
                                {theirs ? (
                                    <>
                                        <Text style={styles.strong}>{theirs.name}</Text>
                                        <Text style={styles.text}>{t('{community} · name not confirmed here', { community: theirs.home })}</Text>
                                        <TextInput
                                            style={[styles.input, { minHeight: 88, textAlignVertical: 'top' }]}
                                            value={first}
                                            onChangeText={setFirst}
                                            placeholder={t('Your first message')}
                                            placeholderTextColor={colors.text.muted}
                                            accessibilityLabel={t('Your first message')}
                                            multiline
                                            maxLength={OUTSIDE_LINE_TEXT_MAX}
                                            testID="first-message"
                                        />
                                        <Pressable style={[styles.btn, (busy || !first.trim()) && { opacity: 0.6 }]} disabled={busy || !first.trim()} accessibilityRole="button" onPress={() => void sendRequest()} testID="send-request">
                                            <Text style={styles.btnText}>{t('Send a message request')}</Text>
                                        </Pressable>
                                    </>
                                ) : (
                                    <>
                                        <Text style={styles.text}>{t('Scan their card, or paste the link they sent you.')}</Text>
                                        <Pressable style={styles.btn} accessibilityRole="button" onPress={() => void scan()} testID="scan-card">
                                            <Text style={styles.btnText}>{t('Scan a card')}</Text>
                                        </Pressable>
                                        <TextInput
                                            style={styles.input}
                                            value={pasted}
                                            onChangeText={setPasted}
                                            placeholder={t('Paste a card link')}
                                            placeholderTextColor={colors.text.muted}
                                            accessibilityLabel={t('Paste a card link')}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            testID="paste-card"
                                        />
                                        <Pressable style={[styles.plain, !pasted.trim() && { opacity: 0.6 }]} disabled={!pasted.trim()} accessibilityRole="button" onPress={() => void readCard(pasted)} testID="read-card">
                                            <Text style={styles.plainText}>{t('Read the card')}</Text>
                                        </Pressable>
                                    </>
                                )}
                                {cardNote && <Text style={styles.note} accessibilityLiveRegion="polite">{cardNote}</Text>}
                            </View>
                        </>
                    )}
                </ScrollView>
            </KeyboardAvoidingView>
            {Scanner && (
                <Scanner
                    hint={t("Point the camera at their card's QR code.")}
                    deniedText={t('Ask them to send you the link, and paste it here.')}
                    onRead={(data) => {
                        if (!addressCardFromText(data)) return false;
                        void readCard(data);
                        setScanner(null);
                        return true;
                    }}
                    onClose={() => setScanner(null)}
                />
            )}
        </SafeAreaView>
    );
}
