import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CurrencyDisplay } from './CurrencyDisplay';
import { InfoModal, InfoModalTab } from './InfoModal';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { palette } from '../constants/colors';
import { useStyles, useTheme } from '../app/ThemeContext';
import { formatNumber, t, tn } from '@beanpool/core';
import { Sentence } from './Sentence';

const BRACKETS = [
    { min: 0, max: 200, rate: 0.0, color: palette.green500 },
    { min: 200, max: 500, rate: 1.0, color: palette.lime500 },
    { min: 500, max: 1000, rate: 1.5, color: palette.yellow500 },
    { min: 1000, max: 2000, rate: 2.0, color: palette.orange500 },
    { min: 2000, max: Infinity, rate: 2.5, color: palette.red500 },
];

/** The worked example's sums, numbers in the language's way: "200 × 0% = 0.0 + 300 × 1.0% = 3.0 + 100 × 1.5% = 1.5". */
function exampleWorking(): string {
    return ([[200, 0, 0], [300, 1, 3], [100, 1.5, 1.5]] as const)
        .map(([amount, rate, fee]) => `${formatNumber(amount)} × ${formatNumber(rate, rate === 0 ? 0 : 1)}% = ${formatNumber(fee, 1)}`)
        .join(' + ');
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    commonsBalance?: number;
    initialTab?: 'flow' | 'brackets' | 'qv';
}

export function CommonsInfoModal({ isOpen, onClose, commonsBalance, initialTab }: Props) {
    const { colors } = useTheme();
    const flowSteps = [
        { icon: <MaterialCommunityIcons name="handshake" size={24} color={colors.brand.primary} />, label: t('My Trade'), desc: t('Credits transacted through community exchange') },
        { icon: <MaterialCommunityIcons name="percent" size={24} color={colors.brand.primary} />, label: t('Transaction Fee'), desc: t('Flat 1.5% fee on completed marketplace trades (direct member transfers are free)') },
        { icon: <MaterialCommunityIcons name="leaf" size={24} color={colors.brand.primary} />, label: t('Circulation Fee'), desc: t('Progressive monthly contribution from positive balances') },
        { icon: <MaterialCommunityIcons name="bank" size={24} color={palette.amber300} />, label: t('Commons Pool'), desc: t('Community fund growing from all community and circulation fee contributions') },
        { icon: <MaterialCommunityIcons name="vote" size={24} color={palette.blue500} />, label: t('Decisions & Polls'), desc: t('Binding Decisions and feed Polls (1m1v for roles/polls; QV for pool grants)') },
        { icon: <MaterialCommunityIcons name="rocket-launch" size={24} color={colors.accent.primary} />, label: t('Enterprises & Grants'), desc: t('Passed initiatives funded automatically from the Commons Pool') },
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
            color: colors.feedback.danger.fg,
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
            label: t('How It Works'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {t('The Community Commons is a self-sustaining fund that redistributes value back to the community through democratically-voted projects.')}
                    </Text>

                    {commonsBalance !== undefined && (
                        <View style={styles.balanceContainer}>
                            <Text style={styles.balanceLabel}>{t('CURRENT COMMONS BALANCE')}</Text>
                            <CurrencyDisplay amount={formatNumber(commonsBalance, 2)} style={styles.balanceAmount} />
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
                        <Text style={styles.solvencyTitle}>{t('SOLVENCY & ACCOUNT PRUNING')}</Text>
                        <Text style={[styles.descriptionText, { marginBottom: 16 }]}>
                            {t('As a zero-sum mutual credit network, pruning inactive accounts requires balancing the ledger:')}
                        </Text>
                        <View style={styles.solvencyRow}>
                            <MaterialCommunityIcons name="shield-alert" size={20} color={colors.feedback.danger.fg} style={styles.solvencyIcon} />
                            <Text style={styles.solvencyText}>
                                <Sentence
                                    text={t('{label} If an inactive account is pruned with a negative balance, the Commons Pool pays off their outstanding debt to maintain zero-sum equilibrium.')}
                                    parts={{ label: <Text style={styles.boldWhiteText}>{t('Bad Debt Payouts:')}</Text> }}
                                />
                            </Text>
                        </View>
                        <View style={[styles.solvencyRow, { marginBottom: 0 }]}>
                            <MaterialCommunityIcons name="shield-check" size={20} color={colors.brand.primary} style={styles.solvencyIcon} />
                            <Text style={styles.solvencyText}>
                                <Sentence
                                    text={t('{label} If an inactive account is pruned with a positive balance, the community reclaims the surplus, transferring it into the Commons Pool to recycle the dormant value.')}
                                    parts={{ label: <Text style={styles.boldWhiteText}>{t('Surplus Reclaims:')}</Text> }}
                                />
                            </Text>
                        </View>
                    </View>
                </View>
            )
        },
        {
            id: 'brackets',
            label: t('Circulation Fees'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        <Sentence
                            text={t("Circulation Fee is a {contribution} from positive balances. Like progressive fee brackets, only the portion of your balance within each tier is charged at that tier's rate.")}
                            parts={{ contribution: <Text style={styles.boldWhiteText}>{t('progressive monthly contribution')}</Text> }}
                        />
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
                                        <Text style={[styles.bracketRate, { color: b.color }]}>{t('{rate}%', { rate: b.rate })}</Text>
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
                        <Text style={styles.exampleLabel}>{t('EXAMPLE')}</Text>
                        <Text style={styles.exampleText}>
                            <Sentence
                                text={t('A balance of {amount} {currency} pays:')}
                                parts={{ amount: <Text style={styles.boldWhiteText}>{formatNumber(600)}</Text>, currency: <CurrencyDisplay hideAmount={true} style={{ fontSize: 14, marginLeft: 2 }} /> }}
                            />{'\n'}
                            <Sentence
                                text={t('{working} = {total} {currency}/month', { working: exampleWorking() })}
                                parts={{ total: <Text style={styles.exampleResult}>{formatNumber(4.5, 1)}</Text>, currency: <CurrencyDisplay hideAmount={true} style={{ fontSize: 14, marginLeft: 2 }} /> }}
                            />
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'qv',
            label: t('Voting'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        <Sentence
                            text={t('{qv} ensures fair allocation — many small voices outweigh a few large ones.')}
                            parts={{ qv: <Text style={styles.boldWhiteText}>{t('Quadratic Voting')}</Text> }}
                        />
                    </Text>

                    <View style={styles.formulaContainer}>
                        <Text style={styles.formulaLabel}>{t('FORMULA')}</Text>
                        <Text style={styles.formulaText}>{t('Cost = Votes²')}</Text>
                    </View>

                    <View style={styles.qvTable}>
                        {[1, 2, 3, 5, 10].map(n => (
                            <View key={n} style={styles.qvRow2}>
                                <Text style={styles.qvRowVotes}>{tn(n, '{n} vote', '{n} votes')}</Text>
                                {/* English writes one form for both, as it always has. */}
                                <Text style={styles.qvRowCost}>{tn(n * n, '{n} credits', '{n} credits')}</Text>
                            </View>
                        ))}
                    </View>

                    <View style={styles.creditsInfoSection}>
                        <Text style={styles.creditsInfoLabel}>{t('HOW CREDITS ARE EARNED')}</Text>
                        <Text style={styles.descriptionText}>
                            <Sentence
                                text={t('Voice credits come from your {trades} — the beans you have traded with other members, counted up to a cap per trading partner. You get the full amount again on every Decision about community money; they are never used up. Voting on community money opens after your first completed trade.')}
                                parts={{ trades: <Text style={styles.boldWhiteText}>{t('completed trades')}</Text> }}
                            />
                        </Text>
                    </View>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>{t('PROCESS')}</Text>
                        {/* One step a line, each whole in the member's language. */}
                        <Text style={styles.processText}>{t('1. Members with a completed trade or earned standing, and node admins, can open a binding Decision')}</Text>
                        <Text style={styles.processText}>{t('2. Voting opens at once and runs for 7 days; members who joined before it opened can vote')}</Text>
                        <Text style={styles.processText}>{t('3. Ballots are secret — everyone sees the totals and their own vote')}</Text>
                        <Text style={styles.processText}>{t('4. Votes on community money cost voice credits; other Decisions are one member, one vote')}</Text>
                        <Text style={styles.processText}>{t('5. At close, passed Decisions execute automatically — the node transfers approved funds to the enterprise account.')}</Text>
                    </View>
                </View>
            )
        }
    ];

    return (
        <InfoModal
            isOpen={isOpen}
            onClose={onClose}
            title={t('Community Commons')}
            icon={<MaterialCommunityIcons name="bank" size={24} color={palette.amber300} />}
            tabs={tabs}
            defaultTab={initialTab}
        />
    );
}

