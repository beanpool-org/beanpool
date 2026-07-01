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
            borderRadius: 12,
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
            borderRadius: 12,
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
                        <Text style={styles.boldWhiteText}>Crowdfund Projects</Text> are initiatives proposed by the community to improve the local area. Instead of members paying for them directly, they are funded by the <Text style={styles.boldWhiteText}>Community Commons Fund</Text>.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>HOW IT WORKS</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem prefix="1.">Members propose public goods projects.</ListItem>
                            <ListItem prefix="2.">You use your personal credits to <Text style={styles.boldWhiteText}>vote</Text> on projects you support.</ListItem>
                            <ListItem prefix="3.">Your votes signal the network to direct funds from the Commons Fund to those projects.</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>💡</Text>
                        <Text style={styles.infoBoxText}>
                            You are NOT spending your own credits to fund the project directly! You are using a small amount of your credits to "buy" votes, which directs a much larger pool of Commons funds.
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
                        BeanPool uses <Text style={styles.boldWhiteText}>Quadratic Voting</Text>. This means you can vote multiple times for the same project, but each additional vote costs more.
                    </Text>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>VOTING COSTS</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem><Text style={styles.boldWhiteText}>1st vote:</Text> <Text style={styles.boldWhiteText}>1</Text> <CurrencyDisplay hideAmount={true} /></ListItem>
                            <ListItem><Text style={styles.boldWhiteText}>2nd vote:</Text> <Text style={styles.boldWhiteText}>4</Text> <CurrencyDisplay hideAmount={true} /></ListItem>
                            <ListItem><Text style={styles.boldWhiteText}>3rd vote:</Text> <Text style={styles.boldWhiteText}>9</Text> <CurrencyDisplay hideAmount={true} /></ListItem>
                            <ListItem><Text style={styles.boldWhiteText}>4th vote:</Text> <Text style={styles.boldWhiteText}>16</Text> <CurrencyDisplay hideAmount={true} /></ListItem>
                        </View>
                    </View>

                    <View style={styles.warningBox}>
                        <Text style={styles.warningIcon}>⚖️</Text>
                        <Text style={styles.warningText}>
                            This system prevents a few wealthy members from dominating the vote. It strongly favors projects that have broad support from many different people!
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
            title="Crowdfund Projects"
            icon="🏗️"
            tabs={tabs}
        />
    );
}

