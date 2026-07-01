import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { CurrencyDisplay } from '../CurrencyDisplay';
import { useStyles } from '../../app/ThemeContext';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

export function DealsInfoModal({ isOpen, onClose }: Props) {
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
            id: 'escrow',
            label: '🤝 Held in Trust',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        BeanPool uses a <Text style={styles.boldWhiteText}>Trust Wallet</Text> system to protect both buyers and sellers during a transaction.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>HOW DEALS WORK</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem prefix="1.">Buyer accepts an offer or Seller accepts a need.</ListItem>
                            <ListItem prefix="2.">The <CurrencyDisplay hideAmount={true} /> credits are <Text style={styles.boldWhiteText}>locked in a Trust Wallet</Text> (they leave the buyer's account but aren't given to the seller yet).</ListItem>
                            <ListItem prefix="3.">Both parties meet to exchange the goods/services.</ListItem>
                            <ListItem prefix="4.">The Buyer <Text style={styles.boldWhiteText}>releases the funds</Text> held in trust to complete the deal.</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>💡</Text>
                        <Text style={styles.infoBoxText}>
                            If there is a dispute and the goods aren't delivered, the buyer can cancel the trust hold to get their credits back, or involve a Guardian for arbitration.
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'reviews',
            label: '⭐ Reviews',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        After a deal is completed, both the buyer and seller should leave a <Text style={styles.boldWhiteText}>Review</Text> for each other.
                    </Text>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>TRUST SCORE</Text>
                        <Text style={styles.processText}>
                            Your reviews directly impact your <Text style={styles.boldWhiteText}>Trust Score</Text>, which is visible on your public profile. Building a high trust score makes it easier to find trading partners!
                        </Text>
                    </View>

                    <View style={styles.warningBox}>
                        <Text style={styles.warningIcon}>⚠️</Text>
                        <Text style={styles.warningText}>
                            Repeated bad reviews or failing to release funds held in trust will result in an automatic review by Network Guardians, which may lead to account suspension.
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
            title="My Deals & Trust Hold"
            icon="🤝"
            tabs={tabs}
        />
    );
}

