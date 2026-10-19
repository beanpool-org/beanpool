import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { palette } from '../../constants/colors';
import { useStyles, useTheme } from '../../app/ThemeContext';
import { formatCount, formatNumber, t } from '@beanpool/core';
import { richWords } from './rich-words';

/** The rough guide: Beans of value traded → the floor it gives (the curve's figures). */
const ROUGH_GUIDE: ReadonlyArray<readonly [traded: number, floor: number]> = [[500, -174], [2000, -548], [10000, -1280]];

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

export function SliderInfoModal({ isOpen, onClose }: Props) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        tabContent: {
            paddingBottom: 40,
        },
        descriptionText: {
            color: colors.text.secondary,
            fontSize: 15,
            lineHeight: 24,
            marginBottom: 24,
        },
        boldWhiteText: {
            color: colors.text.heading,
            fontWeight: 'bold',
        },
        cardContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            borderLeftWidth: 4,
            borderLeftColor: colors.brand.primary,
            marginBottom: 16,
        },
        cardLabel: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: 'bold',
            letterSpacing: 1,
            marginBottom: 8,
        },
        cardText: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 24,
        },
        spectrumCard: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            borderLeftWidth: 4,
            borderLeftColor: colors.brand.primary,
            marginBottom: 16,
        },
        zoneRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 14,
            gap: 12,
        },
        zoneIndicator: {
            width: 16,
            height: 16,
            borderRadius: 8,
        },
        zoneTextContainer: {
            flex: 1,
        },
        zoneTitle: {
            color: colors.text.heading,
            fontSize: 14,
            fontWeight: 'bold',
            marginBottom: 2,
        },
        zoneDesc: {
            color: colors.text.secondary,
            fontSize: 12,
            lineHeight: 16,
        },
        sweetSpotCard: {
            backgroundColor: colors.brand.tint,
            borderRadius: 16,
            padding: 20,
            alignItems: 'center',
            marginBottom: 24,
            borderWidth: 1,
            borderColor: colors.brand.dark,
        },
        centerIcon: {
            marginBottom: 12,
        },
        sweetSpotTitle: {
            color: colors.text.heading,
            fontSize: 18,
            fontWeight: 'bold',
            marginBottom: 8,
            textAlign: 'center',
        },
        sweetSpotText: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 20,
            textAlign: 'center',
        },
        infoBox: {
            flexDirection: 'row',
            backgroundColor: colors.brand.tint,
            padding: 16,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.brand.dark,
            alignItems: 'center',
            marginTop: 8,
        },
        infoBoxIcon: {
            marginRight: 12,
        },
        infoBoxText: {
            flex: 1,
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 20,
        },
        limitRow: {
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 12,
            gap: 12,
        },
        limitEmoji: {
            fontSize: 24,
            width: 32,
            textAlign: 'center',
        },
        limitDetails: {
            flex: 1,
        },
        limitTier: {
            color: colors.text.heading,
            fontSize: 14,
            fontWeight: 'bold',
        },
        limitValue: {
            color: colors.text.secondary,
            fontSize: 12,
        },
        // A longer language's words wrap on their own side of the row, never past the edge.
        bracketRow: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
            gap: 8,
        },
        bracketRange: {
            color: colors.text.heading,
            fontSize: 14,
            fontWeight: 'bold',
            flexShrink: 1,
        },
        bracketRate: {
            fontSize: 14,
            fontWeight: 'bold',
            flexShrink: 1,
            textAlign: 'right',
        },
        exampleCard: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            borderLeftWidth: 4,
            borderLeftColor: colors.brand.primary,
        },
        exampleLabel: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: 'bold',
            letterSpacing: 1,
            marginBottom: 8,
        },
        exampleText: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 22,
        },
        listItemRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            marginBottom: 6,
        },
        listItemPrefix: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 22,
            marginRight: 8,
            width: 12,
            textAlign: 'center',
        },
        listItemText: {
            flex: 1,
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 22,
        }
    }));

    const ListItem = ({ prefix = "•", children }: { prefix?: string; children: React.ReactNode }) => (
        <View style={styles.listItemRow}>
            <Text style={styles.listItemPrefix}>{prefix}</Text>
            <Text style={styles.listItemText}>{children}</Text>
        </View>
    );

    const bold = styles.boldWhiteText;
    // The idle-balance tiers: from and to (null: and above), the monthly rate, and its colour. The first is fee-free.
    const brackets: ReadonlyArray<{ low: number; high: number | null; rate: number; color: string }> = [
        { low: 0, high: 200, rate: 0, color: colors.feedback.success.fg },
        { low: 200, high: 500, rate: 1, color: palette.lime500 },
        { low: 500, high: 1000, rate: 1.5, color: palette.yellow500 },
        { low: 1000, high: 2000, rate: 2, color: colors.market.need.fg },
        { low: 2000, high: null, rate: 2.5, color: colors.feedback.danger.fg },
    ];

    const tabs: InfoModalTab[] = [
        {
            id: 'slider',
            label: t('Credit Slider'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {t('The balance slider is a continuous, color-coded spectrum showing your current financial state relative to your credit limits and idle balance tiers.')}
                    </Text>

                    <View style={styles.sweetSpotCard}>
                        <MaterialCommunityIcons name="scale-balance" size={32} color={colors.brand.primary} style={styles.centerIcon} />
                        <Text style={styles.sweetSpotTitle}>{t('Zero is the Sweet Spot')}</Text>
                        <Text style={styles.sweetSpotText}>
                            {t('Having a balance of zero means you have given exactly as much value to the community as you have received from it. You are in perfect reciprocity.')}
                        </Text>
                    </View>

                    <View style={styles.spectrumCard}>
                        <Text style={styles.cardLabel}>{t('SPECTRUM COLOR ZONES')}</Text>

                        <View style={styles.zoneRow}>
                            <View style={[styles.zoneIndicator, { backgroundColor: colors.feedback.danger.solid }]} />
                            <View style={styles.zoneTextContainer}>
                                <Text style={styles.zoneTitle}>{t('Red Zone (Extremes)')}</Text>
                                <Text style={styles.zoneDesc}>{richWords(t('Max overdraft reached (left) or highest recirculation tier (**2.5%** at **+2000B**, right).'), bold)}</Text>
                            </View>
                        </View>

                        <View style={styles.zoneRow}>
                            <View style={[styles.zoneIndicator, { backgroundColor: colors.action.fab }]} />
                            <View style={styles.zoneTextContainer}>
                                <Text style={styles.zoneTitle}>{t('Orange & Yellow (Warning)')}</Text>
                                <Text style={styles.zoneDesc}>{richWords(t('Approaching overdraft limits, or entering higher recirculation tiers (**1.5% to 2.0%**).'), bold)}</Text>
                            </View>
                        </View>

                        <View style={styles.zoneRow}>
                            <View style={[styles.zoneIndicator, { backgroundColor: palette.green500 }]} />
                            <View style={styles.zoneTextContainer}>
                                <Text style={styles.zoneTitle}>{t('Green Zone (Optimal)')}</Text>
                                <Text style={styles.zoneDesc}>{richWords(t('Healthy balance near zero (down to **-80B** and up to **+200B** fee-free zone).'), bold)}</Text>
                            </View>
                        </View>
                    </View>
                </View>
            )
        },
        {
            id: 'floors',
            label: t('Overdraft Floors'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t("The negative (left) side of the slider shows your **Overdraft Floor** — how far below zero you can spend, so you can buy before you've sold. It isn't fixed: **it grows as you trade real value** with the community."), bold)}
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('HOW YOUR FLOOR GROWS')}</Text>
                        <ListItem prefix="1.">{t('Credit begins at 0 and opens as you complete trades (or receive an explicit vouch of 25, 50, or 100B).')}</ListItem>
                        <ListItem prefix="2.">{richWords(t('It deepens **smoothly** the more genuine value you trade — no fixed steps.'), bold)}</ListItem>
                        <ListItem prefix="3.">{richWords(t('**Diverse** trade (many partners) counts for more than repeat trade with one person.'), bold)}</ListItem>
                        <ListItem prefix="4.">{richWords(t("It's capped at **-2,000B** — the deepest the system allows."), bold)}</ListItem>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('ROUGH GUIDE (VALUE TRADED → FLOOR)')}</Text>

                        {ROUGH_GUIDE.map(([traded, floor]) => (
                            <View key={traded} style={styles.bracketRow}>
                                <Text style={styles.bracketRange}>{t('~{amount}B traded', { amount: formatCount(traded) })}</Text>
                                <Text style={[styles.bracketRate, { color: colors.text.body }]}>{t('≈ {amount}B', { amount: formatCount(floor) })}</Text>
                            </View>
                        ))}

                        <Text style={[styles.zoneDesc, { marginTop: 10 }]}>
                            {t("Your tier badge (🌱 → 🏠 → 🏛️ → ⛰️) is a milestone you pass as your floor deepens — it marks your progress, it doesn't set the limit.")}
                        </Text>
                    </View>

                    <View style={styles.infoBox}>
                        <MaterialCommunityIcons name="information" size={24} color={colors.accent.primary} style={styles.infoBoxIcon} />
                        <Text style={styles.infoBoxText}>
                            {t('Your negative balance is backed by community trust. When you earn credits from new trades, they automatically pay off this debt back toward zero.')}
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'brackets',
            label: t('Idle Balance Tiers'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t('The positive (right) side of the slider shows your **Idle Balance Tiers**. To keep credits circulating and prevent hoarding, balances above **200B** gradually contribute a small monthly percentage back to the community.'), bold)}
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('IDLE BALANCE RECIRCULATION TIERS')}</Text>

                        {brackets.map((b) => (
                            <View key={b.low} style={styles.bracketRow}>
                                <Text style={styles.bracketRange}>
                                    {b.high === null
                                        ? t('{amount}B+', { amount: formatNumber(b.low) })
                                        : t('{low} – {high}B', { low: formatNumber(b.low), high: formatNumber(b.high) })}
                                </Text>
                                <Text style={[styles.bracketRate, { color: b.color }]}>
                                    {b.rate === 0
                                        ? t('{rate}% (Fee-Free Zone)', { rate: formatNumber(b.rate, 1) })
                                        : t('{rate}%', { rate: formatNumber(b.rate, 1) })}
                                </Text>
                            </View>
                        ))}
                    </View>

                    <View style={[styles.infoBox, { marginBottom: 16, marginTop: 0 }]}>
                        <MaterialCommunityIcons name="hand-heart" size={24} color={colors.accent.primary} style={styles.infoBoxIcon} />
                        <Text style={styles.infoBoxText}>
                            {richWords(t('**Where do recirculated beans go?** 100% of collected funds return directly to the **Community Commons** to fund local initiatives — zero corporate profit.'), bold)}
                        </Text>
                    </View>

                    <View style={styles.exampleCard}>
                        <Text style={styles.exampleLabel}>{t('MONTHLY SUMMARY EXAMPLE')}</Text>
                        <Text style={[styles.exampleText, { marginBottom: 8 }]}>
                            {richWords(t('For a balance of **600B**:'), bold)}
                        </Text>
                        <ListItem>{richWords(t('First **200B** is **100% Fee-Free (0B)**'), bold)}</ListItem>
                        <ListItem>{richWords(t('Recirculated amount above 200B: **4.5B / month**'), bold)}</ListItem>
                        <ListItem>{richWords(t('**Effective rate: ~0.75% per month**'), bold)}</ListItem>
                    </View>
                </View>
            )
        }
    ];

    return (
        <InfoModal
            isOpen={isOpen}
            onClose={onClose}
            title={t('Credit Slider Info')}
            icon={<MaterialCommunityIcons name="chart-gantt" size={24} color={colors.brand.primary} />}
            tabs={tabs}
        />
    );
}

