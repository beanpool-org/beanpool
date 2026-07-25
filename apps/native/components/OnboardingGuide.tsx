import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, palette } from '../constants/colors';

/**
 * The "how BeanPool works" guide cards. Shared so the first-run onboarding
 * wizard (welcome.tsx) and the re-runnable profile setup (profile-setup.tsx)
 * show identical content — edit the explanation once, in here.
 */
export function OnboardingGuide() {
    return (
        <View>
            {/* Card 1: Energy Exchange */}
            <View style={guideStyles.card}>
                <Text style={guideStyles.cardTitle}>⚡ Energy Exchange Marketplace</Text>
                <Text style={guideStyles.cardText}>
                    BeanPool runs on cooperation, not accumulation. The goal is to keep energy flowing.
                </Text>
                <View style={guideStyles.highlightBox}>
                    <Text style={guideStyles.highlightText}>
                        🟢 <Text style={{ fontWeight: 'bold' }}>The best place to be is zero (0 Beans).</Text> This means you have given as much value to your community as you have received from it.
                    </Text>
                </View>
                <View style={[guideStyles.highlightBox, { backgroundColor: 'rgba(245, 158, 11, 0.12)', borderColor: 'rgba(245, 158, 11, 0.35)' }]}>
                    <Text style={[guideStyles.highlightText, { color: palette.amber700 || '#b45309' }]}>
                        🫘 <Text style={{ fontWeight: 'bold' }}>Contributions First.</Text> To keep the credit pool healthy, list at least one Offer of what you can give back before you can post Needs or accept Offers.
                    </Text>
                </View>
            </View>

            {/* Card 2: The Ledger Rules */}
            <View style={guideStyles.card}>
                <Text style={guideStyles.cardTitle}>🪙 The Mutual Credit Ledger</Text>

                <View style={guideStyles.bulletRow}>
                    <Text style={guideStyles.bulletEmoji}>🤝</Text>
                    <View style={guideStyles.bulletContent}>
                        <Text style={guideStyles.bulletTitle}>Trust-Backed Credit</Text>
                        <Text style={guideStyles.bulletText}>
                            Everyone starts with a 0 Bean limit. Complete your first real marketplace trade and your community credit line opens — then it deepens steadily with the value you trade and the people you trade with, up to -2000 Beans. No interest, no bank fees.
                        </Text>
                    </View>
                </View>

                <View style={guideStyles.bulletRow}>
                    <Text style={guideStyles.bulletEmoji}>🌾</Text>
                    <View style={guideStyles.bulletContent}>
                        <Text style={guideStyles.bulletTitle}>Community Commons Pool</Text>
                        <Text style={guideStyles.bulletText}>
                            Positive balances above 200 Beans decay by 1.5% monthly (progressive circulation). This prevents hoarding and funds local community projects.
                        </Text>
                    </View>
                </View>

                <View style={guideStyles.bulletRow}>
                    <Text style={guideStyles.bulletEmoji}>⏱️</Text>
                    <View style={guideStyles.bulletContent}>
                        <Text style={guideStyles.bulletTitle}>Reference Rate</Text>
                        <Text style={guideStyles.bulletText}>
                            40 Beans represents roughly 1 hour of community service or time, helping you easily value what you offer or need.
                        </Text>
                    </View>
                </View>
            </View>

            {/* Card 3: Safe Handshake Held in Trust */}
            <View style={guideStyles.card}>
                <Text style={guideStyles.cardTitle}>🔒 Held in Trust</Text>
                <Text style={guideStyles.cardText}>
                    To ensure fairness, when you accept an offer or request a job, your credits are safely held in a temporary Trust Wallet. They are only released to the provider once you confirm delivery.
                </Text>
            </View>

            {/* Card 4: Where to Start */}
            <View style={guideStyles.card}>
                <Text style={guideStyles.cardTitle}>🚀 Where to Start?</Text>
                <Text style={guideStyles.bulletItem}>📍 Explore the <Text style={{ fontWeight: 'bold' }}>Map</Text> to find offers (blue) and needs (orange) near you.</Text>
                <Text style={guideStyles.bulletItem}>💬 Tap <Text style={{ fontWeight: 'bold' }}>Message</Text> on any post to chat securely (E2E encrypted) with neighbors.</Text>
                <Text style={guideStyles.bulletItem}>➕ Click <Text style={{ fontWeight: 'bold' }}>Post</Text> to list what you need or what you can offer to the community.</Text>
                <Text style={guideStyles.bulletItem}>💳 Use the <Text style={{ fontWeight: 'bold' }}>Ledger</Text> tab to send credits to neighbors instantly.</Text>
            </View>
        </View>
    );
}

const guideStyles = StyleSheet.create({
    card: {
        backgroundColor: colors.surface.app,
        borderWidth: 1,
        borderColor: colors.border.default,
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.text.body,
        marginBottom: 8,
    },
    cardText: {
        fontSize: 14,
        color: palette.gray600,
        lineHeight: 20,
    },
    highlightBox: {
        backgroundColor: colors.onboarding.highlightBg,
        borderWidth: 1,
        borderColor: colors.onboarding.highlightBorder,
        borderRadius: 8,
        padding: 12,
        marginTop: 10,
    },
    highlightText: {
        fontSize: 13,
        color: palette.green800,
        lineHeight: 18,
    },
    bulletRow: {
        flexDirection: 'row',
        marginTop: 12,
        alignItems: 'flex-start',
    },
    bulletEmoji: {
        fontSize: 18,
        marginRight: 10,
        marginTop: 2,
    },
    bulletContent: {
        flex: 1,
    },
    bulletTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: palette.gray700,
        marginBottom: 2,
    },
    bulletText: {
        fontSize: 13,
        color: colors.text.secondary,
        lineHeight: 18,
    },
    bulletItem: {
        fontSize: 13,
        color: palette.gray600,
        lineHeight: 18,
        marginBottom: 8,
    },
});

export default OnboardingGuide;
