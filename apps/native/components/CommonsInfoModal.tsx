import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CurrencyDisplay } from './CurrencyDisplay';
import { InfoModal, InfoModalTab } from './InfoModal';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { palette } from '../constants/colors';
import { useStyles, useTheme } from '../app/ThemeContext';

const BRACKETS = [
    { min: 0, max: 200, rate: 0.0, color: palette.green500 },
    { min: 200, max: 500, rate: 1.0, color: palette.lime500 },
    { min: 500, max: 1000, rate: 1.5, color: palette.yellow500 },
    { min: 1000, max: 2000, rate: 2.0, color: palette.orange500 },
    { min: 2000, max: Infinity, rate: 2.5, color: palette.red500 },
];

interface Props {
    isOpen: boolean;
    onClose: () => void;
    commonsBalance?: number;
    initialTab?: 'flow' | 'brackets' | 'qv';
}

export function CommonsInfoModal({ isOpen, onClose, commonsBalance, initialTab }: Props) {
    const { colors } = useTheme();
    const flowSteps = [
        { icon: <MaterialCommunityIcons name="handshake" size={24} color={colors.brand.primary} />, label: 'My Trade', desc: 'Credits transacted through community exchange' },
        { icon: <MaterialCommunityIcons name="percent" size={24} color={colors.brand.primary} />, label: 'Transaction Fee', desc: 'Flat 1.5% fee on completed marketplace trades (direct member transfers are free)' },
        { icon: <MaterialCommunityIcons name="leaf" size={24} color={colors.brand.primary} />, label: 'Circulation Fee', desc: 'Progressive monthly contribution from positive balances' },
        { icon: <MaterialCommunityIcons name="bank" size={24} color={palette.amber300} />, label: 'Commons Pool', desc: 'Community fund growing from all community and circulation fee contributions' },
        { icon: <MaterialCommunityIcons name="vote" size={24} color={palette.blue500} />, label: 'My Vote', desc: 'Quadratic Voting: N votes costs N² credits' },
        { icon: <MaterialCommunityIcons name="rocket-launch" size={24} color={colors.accent.primary} />, label: 'Community Project', desc: 'Winning projects funded from the Commons Pool' },
    ];

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
        balanceContainer: {
            backgroundColor: colors.brand.tint,
            borderRadius: 16,
            padding: 20,
            alignItems: 'center',
            marginBottom: 32,
            borderWidth: 1,
            borderColor: colors.brand.dark,
        },
        balanceLabel: {
            color: colors.brand.primary,
            fontSize: 12,
            fontWeight: 'bold',
            letterSpacing: 1,
            marginBottom: 8,
        },
        balanceAmount: {
            color: colors.text.heading,
            fontSize: 36,
            fontWeight: 'bold',
        },
        flowContainer: {
            marginLeft: 8,
        },
        flowStep: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
        },
        flowStepIcon: {
            marginRight: 16,
        },
        flowStepTextContainer: {
            flex: 1,
        },
        flowStepLabel: {
            color: colors.text.heading,
            fontSize: 16,
            fontWeight: 'bold',
            marginBottom: 4,
        },
        flowStepDesc: {
            color: colors.text.secondary,
            fontSize: 13,
            lineHeight: 18,
        },
        flowConnector: {
            alignItems: 'center',
            paddingVertical: 8,
            marginLeft: 28,
            alignSelf: 'flex-start',
        },
        bracketsContainer: {
            marginBottom: 24,
        },
        bracketRow: {
            marginBottom: 16,
        },
        bracketHeader: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
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
        bracketBarBg: {
            height: 8,
            backgroundColor: colors.border.default,
            borderRadius: 4,
            overflow: 'hidden',
        },
        bracketBarFill: {
            height: '100%',
            borderRadius: 4,
        },
        exampleContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border.default,
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
        exampleResult: {
            color: colors.brand.primary,
            fontWeight: 'bold',
        },
        formulaContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            alignItems: 'center',
            marginBottom: 24,
        },
        formulaLabel: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: 'bold',
            letterSpacing: 1,
            marginBottom: 8,
        },
        formulaText: {
            color: colors.text.link,
            fontSize: 24,
            fontWeight: 'bold',
            fontFamily: 'Courier',
        },
        qvTable: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 14,
            padding: 16,
            marginBottom: 32,
        },
        qvRow2: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        qvRowVotes: {
            color: colors.text.heading,
            fontSize: 16,
            fontWeight: '500',
        },
        qvRowCost: {
            color: colors.feedback.danger.solid,
            fontSize: 16,
            fontWeight: 'bold',
        },
        creditsInfoSection: {
            marginBottom: 24,
        },
        creditsInfoLabel: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: 'bold',
            letterSpacing: 1,
            marginBottom: 12,
        },
        processContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            borderLeftWidth: 4,
            borderLeftColor: colors.text.link,
        },
        processLabel: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: 'bold',
            letterSpacing: 1,
            marginBottom: 8,
        },
        processText: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 24,
        },
        solvencyContainer: {
            marginTop: 28,
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        solvencyTitle: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: 'bold',
            letterSpacing: 1,
            marginBottom: 12,
        },
        solvencyRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            marginBottom: 12,
            gap: 8,
        },
        solvencyIcon: {
            marginTop: 2,
        },
        solvencyText: {
            flex: 1,
            color: colors.text.body,
            fontSize: 13,
            lineHeight: 18,
        },
    }));

    const tabs: InfoModalTab[] = [
        {
            id: 'flow',
            label: 'How It Works',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        The Community Commons is a self-sustaining fund that redistributes value back to the community through democratically-voted projects.
                    </Text>

                    {commonsBalance !== undefined && (
                        <View style={styles.balanceContainer}>
                            <Text style={styles.balanceLabel}>CURRENT COMMONS BALANCE</Text>
                            <CurrencyDisplay amount={commonsBalance.toFixed(2)} style={styles.balanceAmount} />
                        </View>
                    )}

                    <View style={styles.flowContainer}>
                        {flowSteps.map((step, i) => (
                            <View key={i}>
                                <View style={styles.flowStep}>
                                    <View style={styles.flowStepIcon}>{step.icon}</View>
                                    <View style={styles.flowStepTextContainer}>
                                        <Text style={styles.flowStepLabel}>{step.label}</Text>
                                        <Text style={styles.flowStepDesc}>{step.desc}</Text>
                                    </View>
                                </View>
                                {i < flowSteps.length - 1 && (
                                    <View style={styles.flowConnector}>
                                        <MaterialCommunityIcons name="arrow-down" size={24} color={colors.text.secondary} />
                                    </View>
                                )}
                            </View>
                        ))}
                    </View>

                    <View style={styles.solvencyContainer}>
                        <Text style={styles.solvencyTitle}>SOLVENCY & ACCOUNT PRUNING</Text>
                        <Text style={[styles.descriptionText, { marginBottom: 16 }]}>
                            As a zero-sum mutual credit network, pruning inactive accounts requires balancing the ledger:
                        </Text>
                        <View style={styles.solvencyRow}>
                            <MaterialCommunityIcons name="shield-alert" size={20} color={colors.feedback.danger.solid} style={styles.solvencyIcon} />
                            <Text style={styles.solvencyText}>
                                <Text style={styles.boldWhiteText}>Bad Debt Payouts:</Text> If an inactive account is pruned with a negative balance, the Commons Pool pays off their outstanding debt to maintain zero-sum equilibrium.
                            </Text>
                        </View>
                        <View style={[styles.solvencyRow, { marginBottom: 0 }]}>
                            <MaterialCommunityIcons name="shield-check" size={20} color={colors.brand.primary} style={styles.solvencyIcon} />
                            <Text style={styles.solvencyText}>
                                <Text style={styles.boldWhiteText}>Surplus Reclaims:</Text> If an inactive account is pruned with a positive balance, the community reclaims the surplus, transferring it into the Commons Pool to recycle the dormant value.
                            </Text>
                        </View>
                    </View>
                </View>
            )
        },
        {
            id: 'brackets',
            label: 'Circulation Fees',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        Circulation Fee is a <Text style={styles.boldWhiteText}>progressive monthly contribution</Text> from positive balances.
                        Like progressive fee brackets, only the portion of your balance within each tier is charged at that tier's rate.
                    </Text>

                    <View style={styles.bracketsContainer}>
                        {BRACKETS.map((b, i) => {
                            const range = b.max === Infinity ? `${b.min}+` : `${b.min}–${b.max}`;
                            const width = b.max === Infinity ? 100 : (b.rate / 2.5) * 100;
                            return (
                                <View key={i} style={styles.bracketRow}>
                                    <View style={styles.bracketHeader}>
                                        <Text style={styles.bracketRange}>{range}</Text>
                                        <CurrencyDisplay hideAmount={true} style={{ fontSize: 14, marginLeft: 2 }} />
                                        <Text style={[styles.bracketRate, { color: b.color }]}>{b.rate}%</Text>
                                    </View>
                                    <View style={styles.bracketBarBg}>
                                        <View style={[
                                            styles.bracketBarFill,
                                            { width: `${width}%`, backgroundColor: b.color }
                                        ]} />
                                    </View>
                                </View>
                            );
                        })}
                    </View>

                    <View style={styles.exampleContainer}>
                        <Text style={styles.exampleLabel}>EXAMPLE</Text>
                        <Text style={styles.exampleText}>
                            A balance of <Text style={styles.boldWhiteText}>600 </Text><CurrencyDisplay hideAmount={true} style={{ fontSize: 14, marginLeft: 2 }} /> pays:{'\n'}
                            200 × 0% = 0.0 + 300 × 1.0% = 3.0 + 100 × 1.5% = 1.5 = <Text style={styles.exampleResult}>4.5 </Text><CurrencyDisplay hideAmount={true} style={{ fontSize: 14, marginLeft: 2 }} />/month
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'qv',
            label: 'Voting',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        <Text style={styles.boldWhiteText}>Quadratic Voting</Text> ensures fair allocation — many small voices outweigh a few large ones.
                    </Text>

                    <View style={styles.formulaContainer}>
                        <Text style={styles.formulaLabel}>FORMULA</Text>
                        <Text style={styles.formulaText}>Cost = Votes²</Text>
                    </View>

                    <View style={styles.qvTable}>
                        {[1, 2, 3, 5, 10].map(n => (
                            <View key={n} style={styles.qvRow2}>
                                <Text style={styles.qvRowVotes}>{n} vote{n > 1 ? 's' : ''}</Text>
                                <Text style={styles.qvRowCost}>{n * n} credits</Text>
                            </View>
                        ))}
                    </View>

                    <View style={styles.creditsInfoSection}>
                        <Text style={styles.creditsInfoLabel}>HOW CREDITS ARE EARNED</Text>
                        <Text style={styles.descriptionText}>
                            Your governance credits are earned through <Text style={styles.boldWhiteText}>community participation</Text> — the total beans you've transacted (energy cycled).
                            The more you trade and contribute, the more voice you earn in shaping community projects.
                        </Text>
                    </View>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>PROCESS</Text>
                        <Text style={styles.processText}>
                            1. Members propose projects{'\n'}
                            2. Admin opens a voting round with a close date{'\n'}
                            3. Members allocate votes to projects{'\n'}
                            4. At round end, the top-voted project is paid its requested amount from the Commons Pool. Any leftover stays in the pool for future rounds.
                        </Text>
                    </View>
                </View>
            )
        }
    ];

    return (
        <InfoModal
            isOpen={isOpen}
            onClose={onClose}
            title="Community Commons"
            icon={<MaterialCommunityIcons name="bank" size={24} color={palette.amber300} />}
            tabs={tabs}
            defaultTab={initialTab}
        />
    );
}

