/**
 * Commons in preview (scratch/global-node/DESIGN-global-showcase-fable.md §1 rows 5, 6, W3; the Ledger and My Deals are the
 * member's own screens fed the sample, app/(tabs)/ledger.tsx, components/MyDealsSheet.tsx + sample-screens.ts): the
 * strip, the Example header, and Example Valley's frozen numbers (@beanpool/core SAMPLE_COMMUNITY). The explainers are
 * the member's own (the same info modals); every action that would move Beans, vote or pledge is the marker's `action`,
 * which opens the sheet and nothing else.
 *
 * Nothing here talks to a node: no import of utils/db, no fetch. utils/__tests__/showcase-preview-source.test.ts holds
 * that, and that no handler here reaches a transfer, a request, an accept, a vote or a pledge.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { SAMPLE_COMMUNITY } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import type { AppColors } from '../../constants/colors';
import { LocalCommunityMark, ExampleHeader } from './LocalCommunityMark';
import { CommonsInfoModal } from '../CommonsInfoModal';

/** A Bean amount as a row shows it: signed, at most one decimal, and the word Beans (never Ʀ). */
export function beansText(amount: number, signed = false): string {
    const abs = Math.abs(amount);
    const n = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
    const sign = signed ? (amount < 0 ? '−' : '+') : amount < 0 ? '−' : '';
    return `${sign}${n} ${abs === 1 ? 'Bean' : 'Beans'}`;
}

export function CommonsPreview() {
    const { colors } = useTheme();
    const s = previewStyles(colors);
    const [info, setInfo] = useState(false);
    const c = SAMPLE_COMMUNITY;
    const e = c.enterprises[0];
    return (
        <View testID="commons-preview">
            <LocalCommunityMark variant="strip" feature="enterprises" />
            <ExampleHeader text="Example Valley" />
            <View style={s.card}>
                <View style={s.row}>
                    <Text style={s.label}>Commons pool</Text>
                    <Pressable onPress={() => setInfo(true)} accessibilityRole="button" accessibilityLabel="About the Commons" hitSlop={12} style={s.infoBtn}>
                        <Text style={s.infoText}>ⓘ</Text>
                    </Pressable>
                </View>
                <Text style={s.big}>{beansText(c.pool)}</Text>
            </View>
            <View style={s.card}>
                <Text style={s.heading} accessibilityRole="header">{e.name}</Text>
                <Text style={s.body}>{e.what}</Text>
                <Text style={s.muted}>{e.keepers} keepers · this season {beansText(e.season, true)}</Text>
                <View style={s.actions}>
                    <LocalCommunityMark variant="action" feature="enterprises" label="Pledge" />
                    <LocalCommunityMark variant="action" feature="enterprises" label="Pause" />
                </View>
            </View>
            <CommonsInfoModal isOpen={info} onClose={() => setInfo(false)} />
        </View>
    );
}

export const previewStyles = (colors: AppColors) => StyleSheet.create({
    card: { backgroundColor: colors.surface.card, borderColor: colors.border.default, borderWidth: 1, borderRadius: 14, padding: 14,
        marginHorizontal: 16, marginBottom: 12, gap: 6 },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    label: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
    big: { fontSize: 28, fontWeight: '900', color: colors.text.heading },
    heading: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
    body: { fontSize: 15, lineHeight: 21, color: colors.text.body },
    muted: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
    amount: { fontSize: 15, fontWeight: '800', flexShrink: 0 },
    txRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
    actions: { gap: 8, marginHorizontal: 16, marginBottom: 12 },
    infoBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
    infoText: { fontSize: 18, color: colors.text.secondary },
});
