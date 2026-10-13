/**
 * Ledger, Commons and My Deals in preview (scratch/global-node/DESIGN-global-showcase-fable.md §1 rows 3, 5, 6, W3): the
 * strip, the Example header, and Example Valley's frozen numbers (@beanpool/core SAMPLE_COMMUNITY). The explainers are
 * the member's own (the same info modals); every action that would move Beans, vote or pledge is the marker's `action`,
 * which opens the sheet and nothing else.
 *
 * Nothing here talks to a node: no import of utils/db, no fetch. utils/__tests__/showcase-preview-source.test.ts holds
 * that, and that no handler here reaches a transfer, a request, an accept, a vote or a pledge.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SAMPLE_COMMUNITY, LOCAL_COMMUNITY_LINES } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import type { AppColors } from '../../constants/colors';
import { LocalCommunityMark, ExampleHeader } from './LocalCommunityMark';
import { BalanceInfoModal } from '../info-content/BalanceInfoModal';
import { CommonsInfoModal } from '../CommonsInfoModal';

/** A Bean amount as a row shows it: signed, at most one decimal, and the word Beans (never Ʀ). */
export function beansText(amount: number, signed = false): string {
    const abs = Math.abs(amount);
    const n = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
    const sign = signed ? (amount < 0 ? '−' : '+') : amount < 0 ? '−' : '';
    return `${sign}${n} ${abs === 1 ? 'Bean' : 'Beans'}`;
}

const daysAgo = (d: number) => (d === 1 ? 'yesterday' : `${d} days ago`);

export function LedgerPreview() {
    const { colors } = useTheme();
    const s = previewStyles(colors);
    const [info, setInfo] = useState(false);
    const c = SAMPLE_COMMUNITY;
    return (
        <ScrollView contentContainerStyle={{ paddingBottom: 120 }} testID="ledger-preview">
            <LocalCommunityMark variant="strip" feature="beans" />
            <ExampleHeader />
            <View style={s.card}>
                <View style={s.row}>
                    <Text style={s.label}>Balance</Text>
                    <Pressable onPress={() => setInfo(true)} accessibilityRole="button" accessibilityLabel="About your balance" hitSlop={12} style={s.infoBtn}>
                        <Text style={s.infoText}>ⓘ</Text>
                    </Pressable>
                </View>
                <Text style={s.big}>{beansText(c.balance)}</Text>
                <Text style={s.body}>Room to spend: {beansText(c.roomToSpend)} (down to {beansText(c.floor)}), with {c.liveOffers} live Offer.</Text>
                <Text style={s.body}>Level {c.level} of {c.levels}: a badge for help given and received.</Text>
                <Text style={s.muted}>A rough guide here: about {c.beansPerHour} Beans an hour.</Text>
            </View>
            <View style={s.card}>
                <Text style={s.heading} accessibilityRole="header">Transactions</Text>
                {c.transactions.map(t => (
                    <View key={t.id} style={s.txRow}>
                        <View style={{ flex: 1 }}>
                            <Text style={s.body}>{t.what}</Text>
                            <Text style={s.muted}>{t.who} · {daysAgo(t.daysAgo)}</Text>
                        </View>
                        <Text style={[s.amount, { color: t.amount < 0 ? colors.text.body : colors.brand.dark }]}>{beansText(t.amount, true)}</Text>
                    </View>
                ))}
            </View>
            <View style={s.actions}>
                <LocalCommunityMark variant="action" feature="beans" label="Send Beans" />
                <LocalCommunityMark variant="action" feature="beans" label="Export" />
            </View>
            <BalanceInfoModal isOpen={info} onClose={() => setInfo(false)} />
        </ScrollView>
    );
}

export function DealsPreview() {
    const { colors } = useTheme();
    const s = previewStyles(colors);
    return (
        <View testID="deals-preview">
            <LocalCommunityMark variant="strip" feature="escrow" />
            <ExampleHeader />
            {SAMPLE_COMMUNITY.deals.map(d => (
                <View key={d.id} style={s.card}>
                    <Text style={s.body}>{d.what}</Text>
                    <Text style={s.muted}>{d.who} · {beansText(d.amount)} held safely · {daysAgo(d.daysAgo)}</Text>
                    {d.status === 'waiting-on-you'
                        ? <LocalCommunityMark variant="action" feature="escrow" label="Approve the finished work" />
                        : <Text style={s.muted}>Done: the Beans went to {d.who}.</Text>}
                </View>
            ))}
        </View>
    );
}

export function CommonsPreview() {
    const { colors } = useTheme();
    const s = previewStyles(colors);
    const [info, setInfo] = useState(false);
    const c = SAMPLE_COMMUNITY;
    const e = c.enterprises[0];
    const d = c.decisions[0];
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
            <View style={s.card}>
                <Text style={s.heading} accessibilityRole="header">Decide</Text>
                <Text style={s.body}>{d.question}</Text>
                <Text style={s.muted}>{beansText(d.fromPool)} from the pool · closes in {d.closesInDays} days · {d.votesFor} for, {d.votesAgainst} against</Text>
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
    infoBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
    infoText: { fontSize: 18, color: colors.text.secondary },
});
