import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { CurrencyDisplay } from '../CurrencyDisplay';
import { useStyles } from '../../app/ThemeContext';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

export function CrowdfundInfoModal({ isOpen, onClose }: Props) {
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
            fontSize: 24,
            marginRight: 12,
        },
        infoBoxText: {
            flex: 1,
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 20,
        },
        processContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
            borderLeftWidth: 4,
            borderLeftColor: colors.brand.primary,
            marginBottom: 24,
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
        warningBox: {
            flexDirection: 'row',
            backgroundColor: colors.feedback.warning.bg,
            padding: 16,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.feedback.warning.border,
            alignItems: 'center',
            marginTop: 8,
        },
        warningIcon: {
            fontSize: 24,
            marginRight: 12,
        },
        warningText: {
            flex: 1,
            color: colors.feedback.warning.fg,
            fontSize: 14,
            lineHeight: 20,
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
            width: 16,
            textAlign: 'right',
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
            id: 'voting',
            label: '🗳️ Voting',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        <Text style={styles.boldWhiteText}>Enterprises & Projects</Text> are community initiatives that create shared local value. When they need capital, they can request grants funded by the <Text style={styles.boldWhiteText}>Community Commons Pool</Text>.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>HOW IT WORKS</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem prefix="1.">Members propose pool grants for community enterprises and projects.</ListItem>
                            <ListItem prefix="2.">You cast votes using <Text style={styles.boldWhiteText}>voice credits</Text> derived from your earned trade standing.</ListItem>
                            <ListItem prefix="3.">When a Decision passes, the Commons pool automatically funds the enterprise.</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>💡</Text>
                        <Text style={styles.infoBoxText}>
                            Liquid beans never buy votes! Your voting voice comes strictly from completed trades you've settled with neighbours, and voting does not spend your spendable balance.
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'quadratic',
            label: '📈 Quadratic Costs',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        Decisions that spend pool money use <Text style={styles.boldWhiteText}>Quadratic Voting</Text>. Casting N votes costs N² voice credits from your earned trade standing.
                    </Text>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>VOICE CREDIT COSTS</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem><Text style={styles.boldWhiteText}>1 vote:</Text> <Text style={styles.boldWhiteText}>1</Text> voice credit</ListItem>
                            <ListItem><Text style={styles.boldWhiteText}>2 votes:</Text> <Text style={styles.boldWhiteText}>4</Text> voice credits</ListItem>
                            <ListItem><Text style={styles.boldWhiteText}>3 votes:</Text> <Text style={styles.boldWhiteText}>9</Text> voice credits</ListItem>
                            <ListItem><Text style={styles.boldWhiteText}>4 votes:</Text> <Text style={styles.boldWhiteText}>16</Text> voice credits</ListItem>
                        </View>
                    </View>

                    <View style={styles.warningBox}>
                        <Text style={styles.warningIcon}>⚖️</Text>
                        <Text style={styles.warningText}>
                            Quadratic counting ensures that broad community consensus always outweighs concentrated votes from a single high-volume trader.
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
            title="Enterprises & Projects"
            icon="🏗️"
            tabs={tabs}
        />
    );
}

