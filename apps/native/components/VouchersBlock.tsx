/**
 * The Vouchers block at the top of People → Invites (Marty's §11, DESIGN-invites-and-names-list-amend2-fable.md): one row
 * per voucher, "@jane · 550 of 1,000 left · 4 vouched · 1 below zero ›", a row opening that voucher's card, and a last row
 * "+ Make someone a voucher" opening the names list.
 *
 * Whether it shows is never decided here: People renders it only with the node's answer to GET /api/names/vouchers, which
 * the node gives only owners and credit-committee admins (a refusal leaves People with nothing to render).
 *
 * The rows are in the node's order (vouchersBlock(): by callsign). The names list's own order is by the names it opens with
 * its key, and this screen never opens them, so it shows callsigns in the order the node sends them.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { t, formatNumber } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import type { VoucherSummaryRow } from '../utils/names-list';

/** One row's words (§11), from the node's numbers: left of the level in hand, people vouched for, how many below zero now. */
export function voucherRowText(v: Pick<VoucherSummaryRow, 'callsign' | 'left' | 'level' | 'peopleVouched' | 'belowZero'>): string {
    return t('{name} · {left} of {budget} left · {vouched} vouched · {belowZero} below zero ›', {
        name: v.callsign ? `@${v.callsign}` : t('a voucher'),
        left: formatNumber(v.left),
        budget: formatNumber(v.level),
        vouched: formatNumber(v.peopleVouched),
        belowZero: formatNumber(v.belowZero),
    });
}

export interface VouchersBlockProps {
    vouchers: VoucherSummaryRow[];
    onOpen: (memberPubkey: string) => void;
    onMakeVoucher: () => void;
}

export function VouchersBlock({ vouchers, onOpen, onMakeVoucher }: VouchersBlockProps) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        block: {
            marginBottom: 24, padding: 16, borderRadius: 14, backgroundColor: colors.surface.card,
            borderWidth: 1, borderColor: colors.border.default,
        },
        heading: { fontSize: 20, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        desc: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginBottom: 8 },
        empty: { fontSize: 14, lineHeight: 20, color: colors.text.secondary, paddingVertical: 8 },
        row: {
            minHeight: 48, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default,
            justifyContent: 'center',
        },
        rowText: { fontSize: 14, lineHeight: 20, color: colors.text.body, fontWeight: '500' },
        addRow: { minHeight: 48, paddingTop: 14, justifyContent: 'center' },
        addText: { fontSize: 15, fontWeight: '700', color: colors.brand.primary },
    }));

    return (
        <View style={styles.block} testID="vouchers-block">
            <Text style={styles.heading} accessibilityRole="header">{t('Vouchers')}</Text>
            <Text style={styles.desc}>{t('Members with a budget to vouch for the people they invite.')}</Text>
            {vouchers.length === 0 ? <Text style={styles.empty}>{t('Nobody has a voucher budget.')}</Text> : null}
            {vouchers.map((v) => {
                const words = voucherRowText(v);
                return (
                    <Pressable
                        key={v.memberPubkey}
                        style={styles.row}
                        onPress={() => onOpen(v.memberPubkey)}
                        accessibilityRole="button"
                        accessibilityLabel={words}
                        testID="voucher-row"
                    >
                        <Text style={styles.rowText}>{words}</Text>
                    </Pressable>
                );
            })}
            <Pressable style={styles.addRow} onPress={onMakeVoucher} accessibilityRole="button" accessibilityLabel={t('+ Make someone a voucher')}>
                <Text style={styles.addText}>{t('+ Make someone a voucher')}</Text>
            </Pressable>
        </View>
    );
}
