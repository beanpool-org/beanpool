import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { useStyles } from '../../app/ThemeContext';
import { t } from '@beanpool/core';
import { TIER_WORDS } from '../../utils/trust-tier';
import { richWords } from './rich-words';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

export function InviteInfoModal({ isOpen, onClose }: Props) {
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
            id: 'invites',
            label: t('🎟️ Network Invites'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t('Every BeanPool community is invite-only: a member lets you in. To grow the community safely, we rely on a **Peer Vouching** system.'), styles.boldWhiteText)}
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('WHO CAN INVITE')}</Text>
                        <Text style={styles.cardText}>
                            {richWords(t('**Every member can invite, from day one.** Each invite is a single-use code that lasts **30 days** — generate as many as you need.'), styles.boldWhiteText)}
                        </Text>
                    </View>

                    <View style={styles.warningBox}>
                        <Text style={styles.warningIcon}>⚠️</Text>
                        <Text style={styles.warningText}>
                            {richWords(t("You are permanently linked as the inviter of everyone you bring in — the community's invite tree is **public**. Invite people you'd vouch for in real life."), styles.boldWhiteText)}
                        </Text>
                    </View>
                </View>
            )
        },
        {
            id: 'vouching',
            label: t('🤝 Vouching'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t('When you invite someone, you are **vouching** for them. This creates a web of trust across the network.'), styles.boldWhiteText)}
                    </Text>

                    <View style={styles.processContainer}>
                        <Text style={styles.processLabel}>{t('VOUCHING PROCESS')}</Text>
                        <View style={{ marginTop: 4 }}>
                            <ListItem prefix="1.">{richWords(t('Generate a **single-use invite link** (valid for **30 days**)'), styles.boldWhiteText)}</ListItem>
                            <ListItem prefix="2.">{t('Share it securely with someone you trust')}</ListItem>
                            <ListItem prefix="3.">{richWords(t('They create an account and join as a **{tier}**', { tier: t(TIER_WORDS.Newcomer) }), styles.boldWhiteText)}</ListItem>
                            <ListItem prefix="4.">{t('Your profile is permanently linked as their inviter')}</ListItem>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                        <Text style={styles.infoBoxIcon}>💡</Text>
                        <Text style={styles.infoBoxText}>
                            {t("Because of the vouching system, we don't need invasive KYC (Know Your Customer) checks. Trust is maintained peer-to-peer!")}
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
            title={t('Invites & Vouching')}
            icon="🎟️"
            tabs={tabs}
        />
    );
}

