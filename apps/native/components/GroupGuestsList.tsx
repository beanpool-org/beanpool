/**
 * "Guests from other communities", under a group's members (slice G2: DESIGN-cross-chat-voice-fable.md §4.2). The guests in
 * the group's chat, each as core's guest line ("Dax · hillside.example · guest"), and for a convenor those asked and not
 * answered yet. A convenor adds someone by their address card (scanned or pasted): they are asked first, behind their own
 * "Message requests" row, and see only the chat. The community's server decides who sees what (GET /api/groups/:id/guests);
 * this draws what it is given, and nothing where guests are off.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, TextInput } from 'react-native';
import { GUEST_CHAT_WORDS, addressCardFromText, guestAccess, guestNameLine, t } from '@beanpool/core';
import { useStyles, useTheme } from '../app/ThemeContext';
import { MemberAvatar } from './MemberAvatar';
import { fetchGroupGuests, inviteGroupGuest, removeGroupGuest, type GroupGuest } from '../utils/guest-chat-live';
import { outsideErrorWords } from '../utils/outside-chat-live';
import { Alert } from '../utils/keyboard-alert';
import { twoParagraphs } from '../utils/alert-words';

const W = GUEST_CHAT_WORDS;

interface Props {
    groupId: string;
    isConvenor: boolean;
    /** Changes whenever the group's page has read itself again. */
    reloadKey?: number;
}

export function GroupGuestsList({ groupId, isConvenor, reloadKey = 0 }: Props) {
    const { colors } = useTheme();
    const [guests, setGuests] = useState<GroupGuest[]>([]);
    const [on, setOn] = useState(false);
    const [adding, setAdding] = useState(false);
    const [pasted, setPasted] = useState('');
    const [note, setNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [Scanner, setScanner] = useState<React.ComponentType<any> | null>(null);

    const load = useCallback(async () => {
        const next = await fetchGroupGuests(groupId).catch(() => null);
        if (!next) return;
        setGuests(next.guests);
        setOn(next.on);
    }, [groupId]);

    useEffect(() => { void load(); }, [load, reloadKey]);

    const add = async (text: string) => {
        const card = addressCardFromText(text);
        if (!card) { setNote(t(W.notACard)); return; }
        setBusy(true);
        try {
            await inviteGroupGuest(groupId, card);
            setPasted('');
            setAdding(false);
            setNote(t(W.guestAdded));
            await load();
        } catch (e) {
            setNote(outsideErrorWords(e, false));
        } finally {
            setBusy(false);
        }
    };

    /** A convenor's Remove (the host refuses anyone else), asked first: the host takes them out (an invitation withdrawn) and tells their community. */
    const remove = (g: GroupGuest) => {
        if (busy) return;
        const name = guestNameLine(g.name, g.home);
        // The guest line in the message: "Sol · riverside.example · guest" is longer than a title's two lines (walk 17 Nov).
        // The title is plain 'Remove', which every catalog has; core's catalogs give W.remove (the web's button) the same word.
        Alert.alert(t('Remove'), twoParagraphs(t(W.removeAsk, { name }), g.state === 'invited' ? t(W.removeWhatAsked) : t(W.removeWhatIn)), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t('Remove'), style: 'destructive',
                onPress: async () => {
                    setBusy(true);
                    setNote(null);
                    try {
                        await removeGroupGuest(groupId, g.key);
                        setNote(t(W.removedNote));
                        await load();
                    } catch (e) {
                        setNote(outsideErrorWords(e, false));
                    } finally {
                        setBusy(false);
                    }
                },
            },
        ]);
    };

    const styles = useStyles(({ colors }) => StyleSheet.create({
        title: { fontSize: 12, fontWeight: '800', color: colors.text.secondary, letterSpacing: 0.5, marginTop: 16, marginBottom: 6 },
        row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border.default },
        info: { flex: 1, minWidth: 0, marginLeft: 12 },
        name: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        line: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },
        addBtn: { minHeight: 48, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, marginTop: 8 },
        addText: { color: colors.text.body, fontWeight: '700', fontSize: 14, textAlign: 'center' },
        hint: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginTop: 8 },
        input: { minHeight: 44, maxHeight: 120, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text.body, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, marginTop: 8 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
        action: { flexGrow: 1, minWidth: 110, minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card },
        note: { fontSize: 13, lineHeight: 18, color: colors.text.body, marginTop: 8 },
        removeBtn: { minHeight: 44, minWidth: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, marginLeft: 8 },
    }));

    if (!on && guests.length === 0) return null;
    const mayInvite = isConvenor && on && guestAccess('convenor', 'invite') === 'shown';
    if (guests.length === 0 && !mayInvite) return null;

    return (
        <View testID="group-guests">
            <Text style={styles.title}>{t(W.guestsTitle)}</Text>
            {guests.map((g) => (
                <View key={g.key} style={styles.row} testID="group-guest-row">
                    <MemberAvatar avatarUrl={null} pubkey={g.key} callsign={g.name} size={36} />
                    <View style={styles.info}>
                        <Text style={styles.name}>{guestNameLine(g.name, g.home)}</Text>
                        <Text style={styles.line}>{g.state === 'in' ? t(W.guestIn) : t(W.guestAsked)}</Text>
                    </View>
                    {isConvenor && (g.state === 'in' || g.state === 'invited') && (
                        <Pressable style={[styles.removeBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => remove(g)} accessibilityRole="button"
                            accessibilityLabel={t(W.removeLabel, { name: guestNameLine(g.name, g.home) })} testID="group-guest-remove">
                            <Text style={styles.addText}>{t('Remove')}</Text>
                        </Pressable>
                    )}
                </View>
            ))}
            {mayInvite && !adding && (
                <Pressable style={styles.addBtn} accessibilityRole="button" testID="group-guest-add" onPress={() => { setAdding(true); setNote(null); }}>
                    <Text style={styles.addText}>{t(W.addGuest)}</Text>
                </Pressable>
            )}
            {mayInvite && adding && (
                <View testID="group-guest-add-form">
                    <Text style={styles.hint}>{t(W.addGuestHint)}</Text>
                    <TextInput style={styles.input} value={pasted} onChangeText={setPasted} multiline autoCapitalize="none" autoCorrect={false}
                        placeholder={t('Paste their card here')} placeholderTextColor={colors.text.muted} accessibilityLabel={t('Paste their card here')} testID="group-guest-card" />
                    <View style={styles.actions}>
                        <Pressable style={[styles.action, (!pasted.trim() || busy) && { opacity: 0.6 }]} disabled={!pasted.trim() || busy} accessibilityRole="button"
                            onPress={() => void add(pasted)} testID="group-guest-read">
                            <Text style={styles.addText}>{t(W.readCard)}</Text>
                        </Pressable>
                        <Pressable style={styles.action} accessibilityRole="button" disabled={busy} testID="group-guest-scan"
                            onPress={() => { void import('./ScanCodeModal').then((m) => setScanner(() => m.default)); }}>
                            <Text style={styles.addText}>{t('Scan their card')}</Text>
                        </Pressable>
                    </View>
                </View>
            )}
            {note && <Text style={styles.note} accessibilityLiveRegion="polite" testID="group-guest-note">{note}</Text>}
            {Scanner && (
                <Scanner
                    hint={t("Point the camera at their card's QR code.")}
                    deniedText={t('Ask them to send you the link, and paste it here.')}
                    onRead={(data: string) => {
                        if (!addressCardFromText(data)) return false;
                        setScanner(null);
                        void add(data);
                        return true;
                    }}
                    onClose={() => setScanner(null)}
                />
            )}
        </View>
    );
}
