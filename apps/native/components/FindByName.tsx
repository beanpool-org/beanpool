/**
 * Find by exact name on the phone (slice N1; the web's components/AddressCardPanel.tsx; the server's
 * apps/server/src/engine/find-by-name.ts), on the address card screen (app/address-card.tsx):
 *
 * **FindMeSwitch.** "People in other communities can find me by name", off until the member turns it on. On hands their
 * community their card, signed now, and opens this phone's door, so whoever finds them can send a request here. It is the
 * community's switch: the same on every phone and browser.
 *
 * **FindByNameStep.** Their community's address and their exact name: their card (handed to the screen, which goes on as for a
 * scanned card), or the one "nobody", or why it couldn't be asked, in core's words.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, TextInput, Switch, StyleSheet } from 'react-native';
import { FIND_WORDS, findRefusal, t, type AddressCard } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { OutsideMailError, findByName, findMeOn, setDoor, setFindMe } from '../utils/outside-mail';
import { outsideContext, outsideErrorWords } from '../utils/outside-chat-live';

const stylesFor = (colors: AppColors) => StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    rowText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.text.body },
    text: { fontSize: 14, lineHeight: 20, color: colors.text.secondary },
    heading: { fontSize: 15, fontWeight: '700', color: colors.text.body, marginTop: 6 },
    input: { minHeight: 44, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.page, borderWidth: 1, borderColor: colors.border.default },
    plain: { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    plainText: { color: colors.text.body, fontWeight: '700', fontSize: 15, textAlign: 'center' },
    note: { fontSize: 14, lineHeight: 20, color: colors.feedback.warning.fg },
});

export function FindMeSwitch({ colors, onDoorOpened }: { colors: AppColors; onDoorOpened?: () => void }) {
    const styles = stylesFor(colors);
    const [on, setOn] = useState<boolean | null>(null);
    const [note, setNote] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        void (async () => {
            const ctx = await outsideContext().catch(() => null);
            const now = ctx ? await findMeOn(ctx).catch(() => null) : null;
            if (alive) setOn(now);
        })();
        return () => { alive = false; };
    }, []);
    if (on === null) return null;
    const flip = async (next: boolean) => {
        const ctx = await outsideContext();
        if (!ctx) return;
        try {
            const now = await setFindMe(ctx, next);
            setOn(now);
            setNote(null);
            if (now) { await setDoor(ctx.store, true); onDoorOpened?.(); }
        } catch (e) {
            setNote(outsideErrorWords(e));
        }
    };
    return (
        <View testID="find-me">
            <View style={styles.row}>
                <Text style={styles.rowText}>{t(FIND_WORDS.meSwitch)}</Text>
                <Switch value={on} onValueChange={(v) => void flip(v)} accessibilityLabel={t(FIND_WORDS.meSwitch)} testID="find-me-switch" />
            </View>
            <Text style={styles.text}>{t(FIND_WORDS.meHelp)}</Text>
            {note && <Text style={styles.note} accessibilityLiveRegion="polite">{note}</Text>}
        </View>
    );
}

export function FindByNameStep({ colors, onCard }: { colors: AppColors; onCard: (card: AddressCard) => unknown }) {
    const styles = stylesFor(colors);
    const [home, setHome] = useState('');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const ready = !busy && !!home.trim() && !!name.trim();
    const find = async () => {
        const ctx = await outsideContext();
        if (!ctx || !ready) return;
        setBusy(true);
        try {
            const card = await findByName(ctx, home.trim(), name.trim());
            setNote(card ? null : t(FIND_WORDS.nobody));
            if (card) await onCard(card);
        } catch (e) {
            setNote(t(FIND_WORDS[findRefusal(e instanceof OutsideMailError ? e.code : undefined)]));
        } finally {
            setBusy(false);
        }
    };
    return (
        <View testID="find-by-name" style={{ gap: 10 }}>
            <Text style={styles.heading} accessibilityRole="header">{t('Someone in another community')}</Text>
            <Text style={styles.text}>{t('Pick their community, then type their exact name. Only people who said yes can be found.')}</Text>
            <TextInput style={styles.input} value={home} onChangeText={setHome} placeholder={t("Their community's address")} placeholderTextColor={colors.text.muted}
                accessibilityLabel={t("Their community's address")} autoCapitalize="none" autoCorrect={false} keyboardType="url" testID="find-home" />
            <TextInput style={styles.input} value={name} onChangeText={setName} placeholder={t('Their exact name')} placeholderTextColor={colors.text.muted}
                accessibilityLabel={t('Their exact name')} autoCorrect={false} maxLength={60} testID="find-name" />
            <Pressable style={[styles.plain, !ready && { opacity: 0.6 }]} disabled={!ready} accessibilityRole="button" onPress={() => void find()} testID="find-them">
                <Text style={styles.plainText}>{t('Find them')}</Text>
            </Pressable>
            {note && <Text style={styles.note} accessibilityLiveRegion="polite" testID="find-note">{note}</Text>}
        </View>
    );
}
