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
                        Your <Text style={styles.boldWhiteText}>Trust</Text> grows with the <Text style={styles.boldWhiteText}>real value you trade</Text> with the community — not how many trades or handshakes you rack up.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>1. VALUE YOU'VE TRADED</Text>
                        <Text style={styles.cardText}>
                            Your score is a <Text style={styles.boldWhiteText}>smooth, saturating curve</Text> over the qualified value you cycle through trades — proportional at first, then leveling off near the top so no one runs away.
                        </Text>
                        <Text style={[styles.cardText, { marginTop: 8 }]}>
                            💡 <Text style={styles.boldWhiteText}>Diversity counts:</Text> value with any one partner is capped, so trading with <Text style={styles.boldWhiteText}>many</Text> people builds trust far faster than repeat trades with a single partner.
                        </Text>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>2. REPUTATION MULTIPLIER</Text>
                        <Text style={[styles.cardText, { marginBottom: 8 }]}>
                            Ratings left by counterparties scale your score:
                        </Text>
                        <ListItem><Text style={styles.boldWhiteText}>5.0 stars</Text> = <Text style={styles.boldWhiteText}>100%</Text> of score</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>4.0 stars</Text> = <Text style={styles.boldWhiteText}>90%</Text> of score</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>3.0 stars</Text> = <Text style={styles.boldWhiteText}>80%</Text> of score</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>1.0 star</Text> = <Text style={styles.boldWhiteText}>60%</Text> of score</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>No reviews</Text> = <Text style={styles.boldWhiteText}>100%</Text> of score</ListItem>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>3. MILESTONES</Text>
                        <Text style={[styles.cardText, { marginBottom: 8 }]}>
                            As your trust grows you pass milestone badges — they mark your progress, they don't set your credit floor:
                        </Text>
                        <ListItem>🌱 <Text style={styles.boldWhiteText}>Newcomer</Text> → 🏠 <Text style={styles.boldWhiteText}>Resident</Text> → 🏛️ <Text style={styles.boldWhiteText}>Steward</Text> → ⛰️ <Text style={styles.boldWhiteText}>Elder</Text></ListItem>
                        <ListItem>New members show a <Text style={styles.boldWhiteText}>🔑 Founding</Text> badge until their first trade.</ListItem>
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
                        Tiers are <Text style={styles.boldWhiteText}>recognition milestones</Text> — they mark how far your trust has grown. The one reward that deepens with them is your <Text style={styles.boldWhiteText}>credit floor</Text> (how far below zero you can spend). Your floor slides continuously with the value you trade; the tiers are just the signposts along the way.
                    </Text>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.brand.primary }]}>
                        <Text style={styles.tierTitle}>🔑 Founding Status (before 1st trade)</Text>
                        <ListItem>A starting state that lasts until you complete your <Text style={styles.boldWhiteText}>very first trade</Text></ListItem>
                        <ListItem>Shows as <Text style={styles.boldWhiteText}>🔑 FOUNDING</Text> so members know to help you get started</ListItem>
                        <ListItem>Your credit floor stays at <Text style={styles.boldWhiteText}>0</Text> until that first trade — no overdraft yet</ListItem>
                        <ListItem>Graduates to <Text style={styles.boldWhiteText}>Newcomer</Text> automatically once you trade</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.newcomer.fg }]}>
                        <Text style={styles.tierTitle}>🌱 Newcomer</Text>
                        <ListItem>Credit floor opens to <Text style={styles.boldWhiteText}>-80B</Text> after your 1st trade</ListItem>
                        <ListItem>Browse & trade the marketplace, receive credits</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>Sending credits</Text> unlocks the moment you complete that first trade</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.resident.fg }]}>
                        <Text style={styles.tierTitle}>🏠 Resident</Text>
                        <ListItem>Credit floor deepens toward <Text style={styles.boldWhiteText}>-200B</Text> as you trade more value</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.steward.fg }]}>
                        <Text style={styles.tierTitle}>🏛️ Steward</Text>
                        <ListItem>Credit floor deepens toward <Text style={styles.boldWhiteText}>-600B</Text></ListItem>
                        <ListItem>Trusted-trader recognition across the community</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.elder.fg }]}>
                        <Text style={styles.tierTitle}>⛰️ Elder</Text>
                        <ListItem>Credit floor deepens toward <Text style={styles.boldWhiteText}>-1400B</Text> (max <Text style={styles.boldWhiteText}>-2000B</Text>)</ListItem>
                        <ListItem>Recognised as a long-standing, high-trust member</ListItem>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>OPEN TO EVERYONE — NO TIER REQUIRED</Text>
                        <ListItem><Text style={styles.boldWhiteText}>Inviting new members</Text> — share BeanPool freely from day one.</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>A governance voice</Text> — voting power scales with the value you trade, so anyone who trades has a say.</ListItem>
                        <ListItem><Text style={styles.boldWhiteText}>No daily spending limits</Text> — your credit floor is the only guardrail.</ListItem>
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

