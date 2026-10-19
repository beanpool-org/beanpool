import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { CurrencyDisplay } from '../CurrencyDisplay';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useStyles, useTheme } from '../../app/ThemeContext';
import { t } from '@beanpool/core';
import { richWords } from './rich-words';

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
            borderRadius: 14,
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
            borderRadius: 14,
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
            label: t('Your Balance'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {t('Your balance represents your current available trading power within the BeanPool network.')}
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('HOW TO EARN')}</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem>{t('Sell goods or services to the community')}</ListItem>
                            <ListItem>{t('Complete community bounties')}</ListItem>
                            <ListItem>{t('Receive peer-to-peer transfers')}</ListItem>
                        </View>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('HOW TO SPEND')}</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem>{t('Purchase goods from the Market')}</ListItem>
                            <ListItem>{t('Pay for community services')}</ListItem>
                            <ListItem>{t('Transfer to other members')}</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <MaterialCommunityIcons name="lightbulb-on" size={24} color={colors.feedback.warning.fg} style={styles.infoBoxIcon} />
                        <Text style={styles.infoBoxText}>
                            {t('Credits in BeanPool are backed by real community trust and exchange, not fiat currency.')}
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'floor',
            label: t('Floor Balance'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t('Every member has access to a **Floor Balance** (credit line) earned through completed trades and community vouches. This allows you to trade even if you temporarily have zero credits.'), styles.boldWhiteText)}
                    </Text>

                    <View style={styles.limitContainer}>
                        <Text style={styles.limitTitle}>{t('Negative Balances')}</Text>
                        <Text style={styles.limitText}>
                            {richWords(t('If you spend past zero, your balance becomes **negative** down to your **earned credit floor**. When you earn credits again, they will first pay off this negative balance.'), styles.boldWhiteText)}
                        </Text>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('WHY A FLOOR?')}</Text>
                        <Text style={styles.cardText}>
                            {richWords(t("Traditional systems stop you from trading when you're broke. A **mutual credit system** like BeanPool allows the community to **extend trust** so trade can continue flowing."), styles.boldWhiteText)}
                        </Text>
                    </View>

                    <View style={styles.warningBox}>
                        <MaterialCommunityIcons name="alert" size={24} color={colors.feedback.warning.fg} style={styles.warningIcon} />
                        <Text style={styles.warningText}>
                            {richWords(t('When you reach your credit floor, **further spending is paused** until you earn credits back by trading on the Marketplace.'), styles.boldWhiteText)}
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
            title={t('Available Balance')}
            icon={<MaterialCommunityIcons name="wallet" size={24} color={colors.brand.primary} />}
            tabs={tabs}
            testID="bean-sheet"
        />
    );
}

