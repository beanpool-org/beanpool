import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { palette } from '../../constants/colors';
import { useStyles, useTheme } from '../../app/ThemeContext';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    initialTab?: 'levels' | 'perks';
}

export function TrustInfoModal({ isOpen, onClose, initialTab }: Props) {
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
        tierContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 12,
            borderLeftWidth: 4,
            marginBottom: 16,
        },
        tierTitle: {
            color: colors.text.heading,
            fontSize: 16,
            fontWeight: 'bold',
            marginBottom: 8,
        },
        tierText: {
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
            id: 'levels',
            label: 'Trust Formula',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        Your <Text style={styles.boldWhiteText}>Trust Points</Text> represent your contribution and reputation. They are calculated dynamically using trade activity, transaction volume, and reviews:
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>1. BASE SCORE</Text>
                        <View style={{ marginBottom: 8 }}>
                            <ListItem>completed trades (<Text style={styles.boldWhiteText}>+8 pts</Text> each)</ListItem>
                            <ListItem>unique partners (<Text style={styles.boldWhiteText}>+40 pts</Text> each)</ListItem>
                            <ListItem>days as active member (<Text style={styles.boldWhiteText}>+2 pts/day</Text>)</ListItem>
                        </View>
                        <Text style={styles.cardText}>
                            💡 <Text style={styles.boldWhiteText}>Tenure Gate:</Text> Points from days as active member can never exceed points from trades + unique partners. This prevents idle accounts from opening large credit lines.
                        </Text>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>2. VOLUME BONUS</Text>
                        <Text style={styles.cardText}>
                            You earn <Text style={styles.boldWhiteText}>+1 point</Text> for every <Text style={styles.boldWhiteText}>100B</Text> cycled through marketplace deals, capped at a maximum bonus of <Text style={styles.boldWhiteText}>+200 points</Text>.
                        </Text>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>3. REPUTATION MULTIPLIER</Text>
                        <Text style={[styles.cardText, { marginBottom: 8 }]}>
                            Ratings left by counterparties directly scale your final points:
                        </Text>
                        <ListItem><Text style={styles.boldWhiteText}>5.0 stars</Text> = <Text style={styles.boldWhiteText}>100%</Text> of score</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>4.0 stars</Text> = <Text style={styles.boldWhiteText}>90%</Text> of score</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>3.0 stars</Text> = <Text style={styles.boldWhiteText}>80%</Text> of score</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>1.0 star</Text> = <Text style={styles.boldWhiteText}>60%</Text> of score</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>No reviews</Text> = <Text style={styles.boldWhiteText}>100%</Text> of score</ListItem>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>4. PROGRESS SLIDER & MILESTONES</Text>
                        <Text style={[styles.cardText, { marginBottom: 8 }]}>
                            The progress bar shows your path towards becoming an <Text style={styles.boldWhiteText}>Elder (1,320 pts)</Text>:
                        </Text>
                        <ListItem>Milestones: 🌱 <Text style={styles.boldWhiteText}>Newcomer (0 pts)</Text> → 🏠 <Text style={styles.boldWhiteText}>Resident (120 pts)</Text> → 🏛️ <Text style={styles.boldWhiteText}>Steward (520 pts)</Text> → ⛰️ <Text style={styles.boldWhiteText}>Elder (1,320 pts)</Text></ListItem>
                        <ListItem>Standard Newcomers with no completed trades display a <Text style={styles.boldWhiteText}>🔑 Founding</Text> badge (a temporary status that graduates after your first trade).</ListItem>
                    </View>
                </View>
            )
        },
        {
            id: 'perks',
            label: 'Tiers & Perks',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        Your <Text style={styles.boldWhiteText}>Trust Tier</Text> determines your spending capabilities, overdraft limits, and network permissions.
                    </Text>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.brand.primary }]}>
                        <Text style={styles.tierTitle}>🔑 Founding Status (0 Trades)</Text>
                        <ListItem>A temporary level that only lasts until you complete your <Text style={styles.boldWhiteText}>very first trade</Text></ListItem>
                        <ListItem>Shows as <Text style={styles.boldWhiteText}>🔑 FOUNDING</Text> on profiles and listings</ListItem>
                        <ListItem>Alerts other members to prioritize helping you complete your first trade</ListItem>
                        <ListItem>Automatically graduates to <Text style={styles.boldWhiteText}>Newcomer</Text> once your first transaction is completed!</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.newcomer.fg }]}>
                        <Text style={styles.tierTitle}>🌱 Newcomer (0 - 119 pts)</Text>
                        <ListItem>Base overdraft floor: <Text style={styles.boldWhiteText}>-80B</Text> (unlocks after <Text style={styles.boldWhiteText}>1st trade</Text>)</ListItem>
                        <ListItem>Rolling <Text style={styles.boldWhiteText}>20B</Text> daily spending limit for safety</ListItem>
                        <ListItem>Can receive credits and view marketplace</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.resident.fg }]}>
                        <Text style={styles.tierTitle}>🏠 Resident (120 - 519 pts)</Text>
                        <ListItem>Overdraft floor deepens to <Text style={styles.boldWhiteText}>-200B</Text></ListItem>
                        <ListItem>Daily <Text style={styles.boldWhiteText}>spending limits removed</Text></ListItem>
                        <ListItem>Unlocks <Text style={styles.boldWhiteText}>P2P credit sending</Text></ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.steward.fg }]}>
                        <Text style={styles.tierTitle}>🏛️ Steward (520 - 1319 pts)</Text>
                        <ListItem>Overdraft floor deepens to <Text style={styles.boldWhiteText}>-600B</Text></ListItem>
                        <ListItem>Unlocks <Text style={styles.boldWhiteText}>member invitations</Text></ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.elder.fg }]}>
                        <Text style={styles.tierTitle}>⛰️ Elder (1320+ pts)</Text>
                        <ListItem>Overdraft floor deepens to <Text style={styles.boldWhiteText}>-1400B</Text></ListItem>
                        <ListItem>Premium <Text style={styles.boldWhiteText}>gold highlight border</Text> on listings</ListItem>
                        <ListItem>Unlocks <Text style={styles.boldWhiteText}>community governance voice</Text></ListItem>
                    </View>
                </View>
            )
        }
    ];

    return (
        <InfoModal
            isOpen={isOpen}
            onClose={onClose}
            title="Trust & Reputation"
            icon={<MaterialCommunityIcons name="shield-star" size={24} color={colors.brand.primary} />}
            tabs={tabs}
            defaultTab={initialTab}
        />
    );
}

