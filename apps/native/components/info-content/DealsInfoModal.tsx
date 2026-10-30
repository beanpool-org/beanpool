import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { CurrencyDisplay } from '../CurrencyDisplay';
import { useStyles } from '../../app/ThemeContext';
import { t } from '@beanpool/core';
import { richWords } from './rich-words';

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
            id: 'escrow',
            label: t('🤝 Held in Trust'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t('BeanPool uses a **Trust Wallet** system to protect both buyers and sellers during a transaction.'), styles.boldWhiteText)}
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('HOW DEALS WORK')}</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem prefix="1.">{t('Buyer accepts an offer or Seller accepts a need.')}</ListItem>
                            {/* {currency} is the community's currency mark, drawn where the sentence puts it. */}
                            <ListItem prefix="2.">{richWords(t("The {currency} credits are **locked in a Trust Wallet** (they leave the buyer's account but aren't given to the seller yet)."), styles.boldWhiteText, { currency: <CurrencyDisplay hideAmount={true} /> })}</ListItem>
                            <ListItem prefix="3.">{t('Both parties meet to exchange the goods/services.')}</ListItem>
                            <ListItem prefix="4.">{richWords(t('The Buyer **releases the funds** held in trust to complete the deal.'), styles.boldWhiteText)}</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>💡</Text>
                        <Text style={styles.infoBoxText}>
                            {t("If goods aren't delivered, the buyer can cancel the hold directly. For contested trades stuck over 7 days, administrators can arbitrate with full provenance.")}
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'disputes',
            label: t('⚖️ Disputes'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {t('When a trade cannot be agreed upon, community administrators provide transparent dispute arbitration for deals held in trust and stalled over 7 days.')}
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('THREE ARBITRATION OUTCOMES')}</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem prefix="1.">{richWords(t('**Release to Seller:** Disburses the Beans held in trust to the seller (with standard community fee).'), styles.boldWhiteText)}</ListItem>
                            <ListItem prefix="2.">{richWords(t('**Refund to Buyer:** Returns 100% of the Beans held in trust back to the buyer (fee-exempt).'), styles.boldWhiteText)}</ListItem>
                            <ListItem prefix="3.">{richWords(t('**Split 50/50:** Returns half to the buyer and releases half to the seller.'), styles.boldWhiteText)}</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>🛡️</Text>
                        <Text style={styles.infoBoxText}>
                            {/* auth_signer is the record's field name, the same in every language. */}
                            {richWords(t("**Never a Quiet Admin Override:** Every arbitration carries the acting admin's cryptographic identity (**{field}**), writes a visible public record on both parties' transaction and activity views, notifies both members, and strictly preserves ledger conservation.", { field: 'auth_signer' }), styles.boldWhiteText)}
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'reviews',
            label: t('⭐ Reviews'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t('After a deal is completed, both the buyer and seller should leave a **Review** for each other.'), styles.boldWhiteText)}
                    </Text>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>{t('TRUST SCORE')}</Text>
                        <Text style={styles.processText}>
                            {richWords(t('Your reviews directly impact your **Trust Score**, which is visible on your public profile. Building a high trust score makes it easier to find trading partners!'), styles.boldWhiteText)}
                        </Text>
                    </View>

                    <View style={styles.warningBox}>
                        <Text style={styles.warningIcon}>⚠️</Text>
                        <Text style={styles.warningText}>
                            {t('Repeated bad reviews lower your standing with trading partners. Unresolved disputes over Beans held in trust for more than 7 days are arbitrated by administrators via public, signed resolutions (release, refund, or split).')}
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
            title={t('Your deals & Trust Hold')}
            icon="🤝"
            tabs={tabs}
        />
    );
}

