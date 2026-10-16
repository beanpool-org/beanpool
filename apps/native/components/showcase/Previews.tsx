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
import { SAMPLE_COMMUNITY, LOCAL_COMMUNITY_LINES } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import type { AppColors } from '../../constants/colors';
import { LocalCommunityMark, ExampleHeader } from './LocalCommunityMark';
import { CommonsInfoModal } from '../CommonsInfoModal';
import { EnterpriseCard } from '../EnterpriseCard';
import { sampleEnterprises } from './sample-screens';

/** A Bean amount as a row shows it: signed, at most one decimal, and the word Beans (never Ʀ). */
export function beansText(amount: number, signed = false): string {
    const abs = Math.abs(amount);
    const n = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
    const sign = signed ? (amount < 0 ? '−' : '+') : amount < 0 ? '−' : '';
    return `${sign}${n} ${abs === 1 ? 'Bean' : 'Beans'}`;
}

/**
 * The Commons in preview: the pool, Example Valley's enterprise and project as the Commons list's own cards
 * (EnterpriseCard) fed the sample, each marked and here only, under the strip and the Example header (the list below
 * stays the node's own: review of #2063, B2); a tap opens the real enterprise page, which draws a sample id from the
 * sample. Then the Decision.
 */
export function CommonsPreview() {
    const { colors } = useTheme();
    const s = previewStyles(colors);
    const [info, setInfo] = useState(false);
    const c = SAMPLE_COMMUNITY;
    const d = c.decisions[0];
    const [bakery, project] = sampleEnterprises();
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
            <View style={s.sampleCard} testID="sample-enterprise">
                <EnterpriseCard item={bakery} sample />
                <View style={s.cardActions}>
                    <LocalCommunityMark variant="action" feature="enterprises" label="Pledge" />
                    <LocalCommunityMark variant="action" feature="enterprises" label="Pause" />
                </View>
            </View>
            <View style={s.sampleCard} testID="sample-project">
                <EnterpriseCard item={project} sample />
            </View>
            <View style={s.card}>
                <Text style={s.heading} accessibilityRole="header">Decide</Text>
                <Text style={s.body}>{d.question}</Text>
                <Text style={s.muted}>{beansText(d.fromPool)} from the pool · closes in {d.closesInDays} days · {d.yesWeight} for, {d.noWeight} against</Text>
                <LocalCommunityMark variant="action" feature="decisions" label="Vote" />
            </View>
            <View style={{ marginHorizontal: 16 }}>
                <LocalCommunityMark variant="line" feature="decisions" text={LOCAL_COMMUNITY_LINES.poll} />
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
    /** A Commons list card in the preview: the list's own 16 dp sides (the preview undoes them). */
    sampleCard: { marginHorizontal: 16 },
    cardActions: { gap: 8, marginTop: -4, marginBottom: 16 },
    infoBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
    infoText: { fontSize: 18, color: colors.text.secondary },
});
