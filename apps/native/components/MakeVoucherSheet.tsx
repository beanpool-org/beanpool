/**
 * "+ Make someone a voucher" (invites-vouching I5, DESIGN-invites-vouching-review-fable.md §3 ask 1; Marty, 10 Nov 2026:
 * admins are vouchers only when an owner makes them one). Two sections and nobody else:
 *
 *   Admins · no names-list entry needed   every admin with no budget (an owner's to make: the node sends none to a
 *                                         committee admin), made with { memberPubkey }
 *   Confirmed on the names list           every confirmed member the node would make one, by entry id: the name opened
 *                                         from the list on this phone where it can (`names`), else the callsign
 *
 * Picking someone shows the budget stepper, prefilled with the community's default (100 to 2,000 in 100s), and one Make
 * button. Who is offered is the node's answer (GET /api/names/vouchers `candidates`), never decided here. The words are
 * core's (vouchers-block.ts), so the web says the same. No balance figure anywhere: a budget is not a balance.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    t, makeVoucherSheetTitle, makeVoucherAdminsHeading, makeVoucherConfirmedHeading, makeVoucherNobodyWords, voucherCandidateWords,
    makeVoucherBudgetWords, makeVoucherButtonWords, madeVoucherWords, VOUCH_PRESET_WORDS,
} from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';
import { makeNamesVoucher, makeAdminVoucher, type VoucherCandidate, type VoucherCandidates } from '../utils/names-list';
import type { BeanPoolIdentity } from '../utils/identity';
import { nearestBudgetLevel, budgetLevelUp, budgetLevelDown } from '../utils/voucher-rules';

export interface MakeVoucherSheetProps {
    anchorUrl: string;
    identity: BeanPoolIdentity;
    candidates: VoucherCandidates | null | undefined;
    /** The community's default budget (the block's settings.voucherBudget): where the stepper starts. */
    defaultBudget: number | null | undefined;
    /** Names opened from the names list on this phone, by entry id. */
    names?: ReadonlyMap<string, string>;
    onClose: () => void;
    /** A voucher was made: the caller reads the block again, so the person leaves the sheet's lists. */
    onMade: () => void;
}

export function MakeVoucherSheet({ anchorUrl, identity, candidates, defaultBudget, names, onClose, onMade }: MakeVoucherSheetProps) {
    const { colors } = useTheme();
    const [picked, setPicked] = useState<VoucherCandidate | null>(null);
    const [amount, setAmount] = useState(() => nearestBudgetLevel(defaultBudget));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const admins = candidates?.admins ?? [];
    const confirmed = candidates?.confirmed ?? [];
    const label = (c: VoucherCandidate) => voucherCandidateWords(c.callsign, c.entryId ? names?.get(c.entryId) : null);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: {
            flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10,
            borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.card,
        },
        backButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
        headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.text.heading, textAlign: 'center', paddingRight: 48 },
        scroll: { padding: 16, gap: 8, paddingBottom: 48 },
        sectionLine: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: colors.text.secondary, marginTop: 12, marginBottom: 2 },
        empty: { fontSize: 14, lineHeight: 20, color: colors.text.secondary, paddingVertical: 8 },
        row: {
            minHeight: 48, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1,
            borderColor: colors.border.default, backgroundColor: colors.surface.card, justifyContent: 'center',
        },
        rowActive: { borderColor: colors.brand.fill, backgroundColor: colors.surface.subtle },
        rowText: { fontSize: 15, lineHeight: 21, color: colors.text.body, fontWeight: '500' },
        box: { marginTop: 16, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, gap: 10 },
        stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
        stepperBtn: {
            minWidth: 48, minHeight: 48, borderRadius: 10, backgroundColor: colors.surface.subtle,
            borderWidth: 1, borderColor: colors.border.strong, alignItems: 'center', justifyContent: 'center',
        },
        stepperBtnText: { fontSize: 20, fontWeight: '700', color: colors.text.heading },
        stepperValue: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.text.heading, textAlign: 'center' },
        actionBtn: {
            minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
            alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand.fill,
        },
        actionBtnText: { fontSize: 15, fontWeight: '700', color: colors.text.inverse, textAlign: 'center' },
        disabled: { opacity: 0.5 },
        noticeBox: { padding: 12, borderRadius: 12, backgroundColor: colors.feedback.info.bg, borderWidth: 1, borderColor: colors.feedback.info.border },
        noticeText: { fontSize: 14, lineHeight: 20, color: colors.feedback.info.fg },
        errorBox: { padding: 12, borderRadius: 12, backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border },
        errorText: { fontSize: 14, lineHeight: 20, color: colors.feedback.danger.fg },
    }));

    const make = async () => {
        if (!picked || busy) return;
        setBusy(true);
        setError(null);
        setDone(null);
        try {
            const res = picked.entryId
                ? await makeNamesVoucher(anchorUrl, identity, picked.entryId, amount)
                : await makeAdminVoucher(anchorUrl, identity, picked.memberPubkey, amount);
            if (res.ok) {
                setDone(madeVoucherWords(label(picked), amount));
                setPicked(null);
                onMade();
            } else {
                setError(res.message);
            }
        } finally {
            setBusy(false);
        }
    };

    const row = (c: VoucherCandidate, testID: string) => {
        const words = label(c);
        const on = picked?.memberPubkey === c.memberPubkey;
        return (
            <Pressable
                key={c.memberPubkey}
                style={[styles.row, on && styles.rowActive]}
                onPress={() => { setPicked(on ? null : c); setDone(null); setError(null); }}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={words}
                testID={testID}
            >
                <Text style={styles.rowText} maxFontSizeMultiplier={1.3}>{words}</Text>
            </Pressable>
        );
    };

    const down = budgetLevelDown(amount);
    const up = budgetLevelUp(amount);
    return (
        <View style={styles.container} testID="make-voucher-sheet">
            <View style={styles.header}>
                <Pressable onPress={onClose} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.heading} />
                </Pressable>
                <Text style={styles.headerTitle} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{makeVoucherSheetTitle()}</Text>
            </View>
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                {done ? <View style={styles.noticeBox}><Text style={styles.noticeText}>{done}</Text></View> : null}
                {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}
                {admins.length === 0 && confirmed.length === 0 ? <Text style={styles.empty} testID="make-voucher-nobody">{makeVoucherNobodyWords(candidates)}</Text> : null}
                {admins.length > 0 ? <Text style={styles.sectionLine} accessibilityRole="header" maxFontSizeMultiplier={1.3} testID="make-voucher-admins">{makeVoucherAdminsHeading()}</Text> : null}
                {admins.map((c) => row(c, 'make-voucher-admin-row'))}
                {confirmed.length > 0 ? <Text style={styles.sectionLine} accessibilityRole="header" maxFontSizeMultiplier={1.3} testID="make-voucher-confirmed">{makeVoucherConfirmedHeading()}</Text> : null}
                {confirmed.map((c) => row(c, 'make-voucher-confirmed-row'))}
                {picked ? (
                    <View style={styles.box} testID="make-voucher-budget">
                        <View style={styles.stepperRow}>
                            <Pressable
                                style={[styles.stepperBtn, down === null && styles.disabled]}
                                onPress={() => down !== null && setAmount(down)}
                                disabled={down === null}
                                accessibilityRole="button"
                                accessibilityLabel={t(VOUCH_PRESET_WORDS.decreaseBudget)}
                            >
                                <Text style={styles.stepperBtnText}>−</Text>
                            </Pressable>
                            <Text style={styles.stepperValue} maxFontSizeMultiplier={1.3}>{makeVoucherBudgetWords(amount)}</Text>
                            <Pressable
                                style={[styles.stepperBtn, up === null && styles.disabled]}
                                onPress={() => up !== null && setAmount(up)}
                                disabled={up === null}
                                accessibilityRole="button"
                                accessibilityLabel={t(VOUCH_PRESET_WORDS.increaseBudget)}
                            >
                                <Text style={styles.stepperBtnText}>+</Text>
                            </Pressable>
                        </View>
                        <Pressable
                            style={[styles.actionBtn, busy && styles.disabled]}
                            onPress={() => { void make(); }}
                            disabled={busy}
                            accessibilityRole="button"
                            testID="make-voucher-go"
                        >
                            <Text style={styles.actionBtnText} maxFontSizeMultiplier={1.3}>{makeVoucherButtonWords(label(picked))}</Text>
                        </Pressable>
                    </View>
                ) : null}
            </ScrollView>
        </View>
    );
}
