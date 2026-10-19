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

export function CirculationInfoModal({ isOpen, onClose }: Props) {
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
    }));

    const tabs: InfoModalTab[] = [
        {
            id: 'demurrage',
            label: t('What is the Circulation Fee?'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t('**Circulation Fee** is a small monthly reduction applied to positive credit balances. It acts as a circulation incentive to prevent hoarding and keep the economy active.'), styles.boldWhiteText)}
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('HOW IT WORKS')}</Text>
                        <Text style={styles.cardText}>
                            {t('On the last day of each month, a percentage of your balance is deducted based on progressive fee brackets. The larger your balance, the higher the rate applied to the top brackets.')}
                        </Text>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('WHERE DOES IT GO?')}</Text>
                        <Text style={styles.cardText}>
                            {richWords(t('100% of collected fees go directly into the **Community Commons**. These funds are then distributed to community-approved enterprises and projects through community Decisions.'), styles.boldWhiteText)}
                        </Text>
                    </View>

                    <View style={styles.infoBox}>
                        <MaterialCommunityIcons name="water" size={24} color={colors.text.link} style={styles.infoBoxIcon} />
                        <Text style={styles.infoBoxText}>
                            {t('Unlike interest which rewards hoarding, circulation fees reward spending. It encourages you to spend your credits on community services!')}
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'recovery',
            label: t('Debt Recovery'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t("If you have a **negative balance** (you've spent more than you've earned using your Floor Limit), your account goes into debt recovery mode."), styles.boldWhiteText)}
                    </Text>

                    <View style={styles.limitContainer}>
                        <Text style={styles.limitTitle}>{t('Negative Balances')}</Text>
                        <Text style={styles.limitText}>
                            {richWords(t('Negative balances are **exempt from circulation fees**. You will not be charged monthly fees on a negative balance.'), styles.boldWhiteText)}
                        </Text>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('CLEARING YOUR DEBT')}</Text>
                        <Text style={styles.cardText}>
                            {richWords(t('To return to a **positive balance**, you must offer goods or services to the community. When you earn credits, they will automatically pay down your **negative balance** until you reach **zero**.'), styles.boldWhiteText)}
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
            title={t('System Circulation')}
            icon={<MaterialCommunityIcons name="sync" size={24} color={colors.text.link} />}
            tabs={tabs}
        />
    );
}

