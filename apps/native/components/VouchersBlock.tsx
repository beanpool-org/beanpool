/**
 * The Vouchers block at the top of People → Invites (Marty's §11, DESIGN-invites-and-names-list-amend2-fable.md; reshaped by
 * invites-vouching I4, DESIGN-invites-vouching-review-fable.md §3 asks 1, 4 and 5(b)):
 *
 *   Owners · no limit        one line, then "@Marty · 2 vouched ›" for each owner (they vouch by role, with no budget)
 *   @Rob · 400 left ›        every other voucher, in the node's order
 *   Waiting to join          "Dee Dee · waiting to join · budget 1,000 ›": an invite not used yet that promises a voucher
 *                            budget; the name is opened from the names list on this phone (`names`), by entry id
 *   + Make someone a voucher opening the names list
 *
 * Whether it shows is never decided here: People renders it only with the node's answer to GET /api/names/vouchers, which
 * the node gives only owners and credit-committee admins (a refusal leaves People with nothing to render). The words are
 * core's (vouchers-block.ts), so the web says the same. No balance figure anywhere.
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
    t, ownersHeading, waitingHeading, ownerRowWords, voucherRowWords, waitingRowWords, vouchersBlockSections, type WaitingVoucherRow,
} from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import type { VoucherSummaryRow } from '../utils/names-list';

/** One voucher's row, from the node's numbers: an owner's "@Marty · 2 vouched ›", anyone else's "@Rob · 400 left ›". */
export function voucherRowText(v: Pick<VoucherSummaryRow, 'callsign' | 'left' | 'peopleVouched' | 'noLimit'>): string {
    return v.noLimit ? ownerRowWords(v.callsign, v.peopleVouched) : voucherRowWords(v.callsign, v.left);
}

export interface VouchersBlockProps {
    vouchers: VoucherSummaryRow[];
    /** Invites not used yet that promise a voucher budget (GET /api/names/vouchers `waiting`). */
    waiting?: readonly WaitingVoucherRow[];
    /** Names opened from the names list on this phone, by entry id (empty until the list is open, or where this phone holds no key). */
    names?: ReadonlyMap<string, string>;
    /** The block has a waiting row: the caller opens the names list so their names can be shown (a logged read, as any open is). */
    onNeedNames?: (need: boolean) => void;
    onOpen: (memberPubkey: string) => void;
    onMakeVoucher: () => void;
    /** A waiting row opened: the names list. Without it, onMakeVoucher. */
    onOpenWaiting?: (entryId: string) => void;
}

export function VouchersBlock({ vouchers, waiting = [], names, onNeedNames, onOpen, onMakeVoucher, onOpenWaiting }: VouchersBlockProps) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        block: {
            marginBottom: 24, padding: 16, borderRadius: 14, backgroundColor: colors.surface.card,
            borderWidth: 1, borderColor: colors.border.default,
        },
        heading: { fontSize: 20, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        desc: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginBottom: 8 },
        empty: { fontSize: 14, lineHeight: 20, color: colors.text.secondary, paddingVertical: 8 },
        sectionLine: { fontSize: 13, lineHeight: 18, fontWeight: '700', color: colors.text.secondary, marginTop: 8, marginBottom: 2 },
        row: {
            minHeight: 48, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default,
            justifyContent: 'center',
        },
        rowText: { fontSize: 14, lineHeight: 20, color: colors.text.body, fontWeight: '500' },
        addRow: { minHeight: 48, paddingTop: 14, justifyContent: 'center' },
        addText: { fontSize: 15, fontWeight: '700', color: colors.brand.primary },
    }));
    const { owners, others } = vouchersBlockSections(vouchers);
    useEffect(() => { onNeedNames?.(waiting.length > 0); }, [waiting.length, onNeedNames]);

    const voucherRow = (v: VoucherSummaryRow) => {
        const words = voucherRowText(v);
        return (
            <Pressable
                key={v.memberPubkey}
                style={styles.row}
                onPress={() => onOpen(v.memberPubkey)}
                accessibilityRole="button"
                accessibilityLabel={words}
                testID={v.noLimit ? 'voucher-owner-row' : 'voucher-row'}
            >
                <Text style={styles.rowText} maxFontSizeMultiplier={1.3}>{words}</Text>
            </Pressable>
        );
    };

    return (
        <View style={styles.block} testID="vouchers-block">
            <Text style={styles.heading} accessibilityRole="header">{t('Vouchers')}</Text>
            <Text style={styles.desc}>{t('Members with a budget to vouch for the people they invite.')}</Text>
            {owners.length === 0 && others.length === 0 && waiting.length === 0 ? <Text style={styles.empty}>{t('Nobody has a voucher budget.')}</Text> : null}
            {owners.length > 0 ? <Text style={styles.sectionLine} maxFontSizeMultiplier={1.3} testID="vouchers-owners-line">{ownersHeading()}</Text> : null}
            {owners.map(voucherRow)}
            {others.map(voucherRow)}
            {waiting.length > 0 ? <Text style={styles.sectionLine} maxFontSizeMultiplier={1.3} accessibilityRole="header" testID="vouchers-waiting-heading">{waitingHeading()}</Text> : null}
            {waiting.map((w) => {
                const words = waitingRowWords(w, names?.get(w.entryId));
                return (
                    <Pressable
                        key={w.entryId}
                        style={styles.row}
                        onPress={() => (onOpenWaiting ?? onMakeVoucher)(w.entryId)}
                        accessibilityRole="button"
                        accessibilityLabel={words}
                        testID="voucher-waiting-row"
                    >
                        <Text style={styles.rowText} maxFontSizeMultiplier={1.3}>{words}</Text>
                    </Pressable>
                );
            })}
            <Pressable style={styles.addRow} onPress={onMakeVoucher} accessibilityRole="button" accessibilityLabel={t('+ Make someone a voucher')}>
                <Text style={styles.addText}>{t('+ Make someone a voucher')}</Text>
            </Pressable>
        </View>
    );
}
