import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { CurrencyDisplay } from '../CurrencyDisplay';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useStyles, useTheme } from '../../app/ThemeContext';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

export function BalanceInfoModal({ isOpen, onClose }: Props) {
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
        limitContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 12,
            borderLeftWidth: 4,
            borderLeftColor: colors.brand.primary,
            marginBottom: 24,
        },
        limitTitle: {
            color: colors.text.heading,
            fontSize: 16,
            fontWeight: 'bold',
            marginBottom: 8,
        },
        limitText: {
            color: colors.text.body,
            fontSize: 14,
            lineHeight: 22,
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
            id: 'balance',
            label: 'Your Balance',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        Your balance represents your current available trading power within the BeanPool network.
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>HOW TO EARN</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem>Sell goods or services to the community</ListItem>
                            <ListItem>Complete community bounties</ListItem>
                            <ListItem>Receive peer-to-peer transfers</ListItem>
                        </View>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>HOW TO SPEND</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem>Purchase goods from the Market</ListItem>
                            <ListItem>Pay for community services</ListItem>
                            <ListItem>Transfer to other members</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <MaterialCommunityIcons name="lightbulb-on" size={24} color={colors.feedback.warning.solid} style={styles.infoBoxIcon} />
                        <Text style={styles.infoBoxText}>
                            Credits in BeanPool are backed by real community trust and exchange, not fiat currency.
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'floor',
            label: 'Floor Balance',
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        Every member has access to a <Text style={styles.boldWhiteText}>Floor Balance</Text> (credit line) based on their community tier. This allows you to trade even if you temporarily have zero credits.
                    </Text>

                    <View style={styles.limitContainer}>
                        <Text style={styles.limitTitle}>Negative Balances</Text>
                        <Text style={styles.limitText}>
                            If you spend past zero, your balance becomes <Text style={styles.boldWhiteText}>negative</Text> up to your <Text style={styles.boldWhiteText}>tier limit</Text>. When you earn credits again, they will first pay off this negative balance.
                        </Text>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>WHY A FLOOR?</Text>
                        <Text style={styles.cardText}>
                            Traditional systems stop you from trading when you're broke. A <Text style={styles.boldWhiteText}>mutual credit system</Text> like BeanPool allows the community to <Text style={styles.boldWhiteText}>extend trust</Text> so trade can continue flowing.
                        </Text>
                    </View>

                    <View style={styles.warningBox}>
                        <MaterialCommunityIcons name="alert" size={24} color={colors.feedback.warning.solid} style={styles.warningIcon} />
                        <Text style={styles.warningText}>
                            Members who stay at their maximum floor balance for <Text style={styles.boldWhiteText}>over 3 months</Text> without active trading may face <Text style={styles.boldWhiteText}>account suspension</Text>.
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
            title="Available Balance"
            icon={<MaterialCommunityIcons name="wallet" size={24} color={colors.brand.primary} />}
            tabs={tabs}
        />
    );
}

