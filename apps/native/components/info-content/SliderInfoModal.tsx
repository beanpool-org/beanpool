import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { palette } from '../../constants/colors';
import { useStyles, useTheme } from '../../app/ThemeContext';

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
            borderRadius: 12,
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
            borderRadius: 12,
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
            borderRadius: 12,
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
        bracketRow: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        bracketRange: {
            color: colors.text.heading,
            fontSize: 14,
            fontWeight: 'bold',
        },
        bracketRate: {
            fontSize: 14,
            fontWeight: 'bold',
        },
        exampleCard: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 12,
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

    const tabs: InfoModalTab[] = [
        {
            id: 'slider',
            label: 'Credit Slider',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        The balance slider is a continuous, color-coded spectrum showing your current financial state relative to your credit limits and holding fee brackets.
                    </Text>

                    <View style={styles.sweetSpotCard}>
                        <MaterialCommunityIcons name="scale-balance" size={32} color={colors.brand.primary} style={styles.centerIcon} />
                        <Text style={styles.sweetSpotTitle}>Zero is the Sweet Spot</Text>
                        <Text style={styles.sweetSpotText}>
                            Having a balance of zero means you have given exactly as much value to the community as you have received from it. You are in perfect reciprocity.
                        </Text>
                    </View>

                    <View style={styles.spectrumCard}>
                        <Text style={styles.cardLabel}>SPECTRUM COLOR ZONES</Text>
                        
                        <View style={styles.zoneRow}>
                            <View style={[styles.zoneIndicator, { backgroundColor: palette.red500 }]} />
                            <View style={styles.zoneTextContainer}>
                                <Text style={styles.zoneTitle}>Red Zone (Extremes)</Text>
                                <Text style={styles.zoneDesc}>Max overdraft reached (left) or high holding fee bracket (<Text style={styles.boldWhiteText}>2.5%</Text> at <Text style={styles.boldWhiteText}>+2000B</Text>, right).</Text>
                            </View>
                        </View>

                        <View style={styles.zoneRow}>
                            <View style={[styles.zoneIndicator, { backgroundColor: palette.orange500 }]} />
                            <View style={styles.zoneTextContainer}>
                                <Text style={styles.zoneTitle}>Orange & Yellow (Warning)</Text>
                                <Text style={styles.zoneDesc}>Approaching overdraft limits, or entering higher holding fee brackets (<Text style={styles.boldWhiteText}>1.5% to 2.0%</Text>).</Text>
                            </View>
                        </View>

                        <View style={styles.zoneRow}>
                            <View style={[styles.zoneIndicator, { backgroundColor: palette.green500 }]} />
                            <View style={styles.zoneTextContainer}>
                                <Text style={styles.zoneTitle}>Green Zone (Optimal)</Text>
                                <Text style={styles.zoneDesc}>Healthy balance near zero (down to <Text style={styles.boldWhiteText}>-80B</Text> and up to <Text style={styles.boldWhiteText}>+200B</Text> fee-free zone).</Text>
                            </View>
                        </View>
                    </View>
                </View>
            )
        },
        {
            id: 'floors',
            label: 'Overdraft Floors',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        The negative (left) side of the slider shows your <Text style={styles.boldWhiteText}>Overdraft Floor</Text> — how far below zero you can spend, so you can buy before you've sold. It isn't fixed: <Text style={styles.boldWhiteText}>it grows as you trade real value</Text> with the community.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>HOW YOUR FLOOR GROWS</Text>
                        <ListItem prefix="1.">Everyone starts at a small <Text style={styles.boldWhiteText}>-80B</Text> floor after their first trade.</ListItem>
                        <ListItem prefix="2.">It deepens <Text style={styles.boldWhiteText}>smoothly</Text> the more genuine value you trade — no fixed steps.</ListItem>
                        <ListItem prefix="3."><Text style={styles.boldWhiteText}>Diverse</Text> trade (many partners) counts for more than repeat trade with one person.</ListItem>
                        <ListItem prefix="4.">It's capped at <Text style={styles.boldWhiteText}>-2,000B</Text> — the deepest the system allows.</ListItem>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>ROUGH GUIDE (VALUE TRADED → FLOOR)</Text>

                        <View style={styles.bracketRow}>
                            <Text style={styles.bracketRange}>~500B traded</Text>
                            <Text style={[styles.bracketRate, { color: colors.text.body }]}>≈ -255B</Text>
                        </View>
                        <View style={styles.bracketRow}>
                            <Text style={styles.bracketRange}>~2,000B traded</Text>
                            <Text style={[styles.bracketRate, { color: colors.text.body }]}>≈ -630B</Text>
                        </View>
                        <View style={styles.bracketRow}>
                            <Text style={styles.bracketRange}>~10,000B traded</Text>
                            <Text style={[styles.bracketRate, { color: colors.text.body }]}>≈ -1,360B</Text>
                        </View>

                        <Text style={[styles.zoneDesc, { marginTop: 10 }]}>
                            Your tier badge (🌱 → 🏠 → 🏛️ → ⛰️) is a milestone you pass as your floor deepens — it marks your progress, it doesn't set the limit.
                        </Text>
                    </View>

                    <View style={styles.infoBox}>
                        <MaterialCommunityIcons name="information" size={24} color={colors.accent.primary} style={styles.infoBoxIcon} />
                        <Text style={styles.infoBoxText}>
                            Your negative balance is backed by community trust. When you earn credits from new trades, they automatically pay off this debt back toward zero.
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'brackets',
            label: 'Holding Fee Brackets',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        The positive (right) side of the slider shows your <Text style={styles.boldWhiteText}>Holding Fee Brackets</Text>. Progressive circulation fees apply monthly to positive balances to prevent hoarding.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>PROGRESSIVE MONTHLY CIRCULATION FEE</Text>
                        
                        <View style={styles.bracketRow}>
                            <Text style={styles.bracketRange}>0 – 200B</Text>
                            <Text style={[styles.bracketRate, { color: palette.green500 }]}>0.0% (Fee-Free)</Text>
                        </View>
                        
                        <View style={styles.bracketRow}>
                            <Text style={styles.bracketRange}>200 – 500B</Text>
                            <Text style={[styles.bracketRate, { color: palette.lime500 }]}>1.0%</Text>
                        </View>

                        <View style={styles.bracketRow}>
                            <Text style={styles.bracketRange}>500 – 1000B</Text>
                            <Text style={[styles.bracketRate, { color: palette.yellow500 }]}>1.5%</Text>
                        </View>

                        <View style={styles.bracketRow}>
                            <Text style={styles.bracketRange}>1000 – 2000B</Text>
                            <Text style={[styles.bracketRate, { color: palette.orange500 }]}>2.0%</Text>
                        </View>

                        <View style={styles.bracketRow}>
                            <Text style={styles.bracketRange}>2000B+</Text>
                            <Text style={[styles.bracketRate, { color: palette.red500 }]}>2.5%</Text>
                        </View>
                    </View>

                    <View style={styles.exampleCard}>
                        <Text style={styles.exampleLabel}>CALCULATION EXAMPLE</Text>
                        <Text style={[styles.exampleText, { marginBottom: 8 }]}>
                            A balance of <Text style={styles.boldWhiteText}>600B</Text> pays progressive monthly circulation fees of:
                        </Text>
                        <ListItem>First <Text style={styles.boldWhiteText}>200B</Text> × <Text style={styles.boldWhiteText}>0%</Text> = <Text style={styles.boldWhiteText}>0.0B</Text></ListItem>
                        <ListItem>Next <Text style={styles.boldWhiteText}>300B</Text> (200 to 500) × <Text style={styles.boldWhiteText}>1.0%</Text> = <Text style={styles.boldWhiteText}>3.0B</Text></ListItem>
                        <ListItem>Remaining <Text style={styles.boldWhiteText}>100B</Text> (500 to 600) × <Text style={styles.boldWhiteText}>1.5%</Text> = <Text style={styles.boldWhiteText}>1.5B</Text></ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>Total circulation fee = 4.5B / month</Text></ListItem>
                    </View>
                </View>
            )
        }
    ];

    return (
        <InfoModal
            isOpen={isOpen}
            onClose={onClose}
            title="Credit Slider Info"
            icon={<MaterialCommunityIcons name="chart-gantt" size={24} color={colors.brand.primary} />}
            tabs={tabs}
        />
    );
}

