/**
 * One row of the Vouchers chip (DESIGN-credit-list-amend-fable.md §3.5), for owners and the credit committee:
 *
 *   Jane
 *   Voucher · 150 of 1,000 left   ! Running low
 *   Vouched 800 to 9 people · 50 held on invites
 *   2 of 9 below zero · written off 0
 *   Asked for more on 12 Nov
 *   [ Top up to 1,000 ]  [ Their card › ]
 *
 * Top up is ONE tap, no picker: the label says what it does, and the level is the node's offer in the row (`topUpTo_c`),
 * never worked out here. The tap is today's route and writer (POST /api/names/vouchers/:member/budget { level }); any other
 * level, a lower one, the history and Stop stay on Their card. A paused or frozen voucher has no button and the node's reason.
 */
import React, { useState, type ComponentType } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatDate, formatHundredths, t } from '@beanpool/core';
import { useStyles, useTheme } from '../app/ThemeContext';
import { setVoucherBudget } from '../utils/names-list';
import { marked, shortDay, voucherRowWords, type VoucherChipRow } from '../utils/credit-view';
import type { VoucherCardProps } from './VoucherCard';
import type { BeanPoolIdentity } from '../utils/identity';

export function CreditVoucherRow({ row, anchorUrl, identity, highlighted, onChanged }: {
    row: VoucherChipRow;
    anchorUrl: string;
    identity: BeanPoolIdentity;
    /** The bell's "A voucher asks for more" opened the chip on this voucher. */
    highlighted?: boolean;
    onChanged: () => void;
}) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        row: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.surface.subtle, backgroundColor: c.surface.card },
        name: { fontSize: 16, fontWeight: '700', color: c.text.heading },
        line: { fontSize: 13, lineHeight: 19, color: c.text.body, marginTop: 2 },
        flag: { fontWeight: '800', color: c.feedback.warning.fg },
        note: { fontSize: 13, lineHeight: 19, color: c.text.secondary, marginTop: 4 },
        done: { fontSize: 13, lineHeight: 19, fontWeight: '700', color: c.feedback.success.fg, marginTop: 6 },
        refusal: { fontSize: 13, lineHeight: 19, color: c.feedback.danger.fg, marginTop: 6 },
        buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
        primary: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: c.brand.fill, justifyContent: 'center' },
        primaryText: { color: c.text.inverse, fontSize: 15, fontWeight: '700' },
        secondary: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: c.border.strong, backgroundColor: c.surface.card, justifyContent: 'center' },
        secondaryText: { color: c.brand.primary, fontSize: 15, fontWeight: '700' },
    }));
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
    const [cardOpen, setCardOpen] = useState(false);
    // The card (and the names-list code behind it) is loaded when first wanted, as the profile's voucher button does.
    const [Card, setCard] = useState<ComponentType<VoucherCardProps> | null>(null);
    const words = voucherRowWords(row, shortDay(row.askedAt, (d) => formatDate(d, 'day-month')));

    const topUp = async () => {
        if (busy || row.topUpTo_c === null) return;
        setBusy(true); setSaid(null);
        // The node's level, exactly as the row offered it.
        const res = await setVoucherBudget(anchorUrl, identity, row.memberPubkey, row.topUpTo_c);
        if (res.ok) {
            setSaid({ ok: true, text: t('{name}’s budget is {level} now: {left} left to vouch with.', { name: row.callsign, level: formatHundredths(res.value.level), left: formatHundredths(res.value.left) }) });
            onChanged();
        } else {
            setSaid({ ok: false, text: res.message });
        }
        setBusy(false);
    };
    const openCard = async () => {
        if (!Card) {
            const loaded = await import('./VoucherCard');
            setCard(() => loaded.VoucherCard);
        }
        setCardOpen(true);
    };

    return (
        <View style={[styles.row, highlighted && { borderLeftWidth: 4, borderLeftColor: colors.brand.fill }]} testID={`credit-voucher-${row.callsign}`}>
            <Text style={styles.name} maxFontSizeMultiplier={1.3}>{row.callsign}</Text>
            <Text style={styles.line} maxFontSizeMultiplier={1.3}>
                {words.head}
                {words.flag ? <Text style={styles.flag}>{'   ' + marked('!', words.flag)}</Text> : null}
            </Text>
            <Text style={styles.line} maxFontSizeMultiplier={1.3}>{words.held ? `${words.vouched} · ${words.held}` : words.vouched}</Text>
            <Text style={styles.line} maxFontSizeMultiplier={1.3}>{words.health}</Text>
            {words.asked ? <Text style={styles.line} maxFontSizeMultiplier={1.3} testID="credit-voucher-asked">{words.asked}</Text> : null}
            {words.blocked ? <Text style={styles.note} maxFontSizeMultiplier={1.3} testID="credit-voucher-blocked">{words.blocked}</Text> : null}
            {said ? <Text style={said.ok ? styles.done : styles.refusal} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.3}>{said.text}</Text> : null}
            <View style={styles.buttons}>
                {words.topUp ? (
                    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => { void topUp(); }} style={[styles.primary, busy && { opacity: 0.6 }]} testID="credit-top-up">
                        <Text style={styles.primaryText} maxFontSizeMultiplier={1.3}>{words.topUp}</Text>
                    </Pressable>
                ) : null}
                {!row.noLimit ? (
                    <Pressable accessibilityRole="button" onPress={() => { void openCard(); }} style={styles.secondary} testID="credit-voucher-card">
                        <Text style={styles.secondaryText} maxFontSizeMultiplier={1.3}>{t('Their card ›')}</Text>
                    </Pressable>
                ) : null}
            </View>
            <Modal visible={cardOpen} animationType="slide" onRequestClose={() => setCardOpen(false)}>
                <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface.app }} edges={['top', 'left', 'right', 'bottom']}>
                    {cardOpen && Card ? <Card anchorUrl={anchorUrl} identity={identity} memberPubkey={row.memberPubkey} onClose={() => { setCardOpen(false); onChanged(); }} /> : null}
                </SafeAreaView>
            </Modal>
        </View>
    );
}
