import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { InfoModal, InfoModalTab } from '../InfoModal';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { palette } from '../../constants/colors';
import { useStyles, useTheme } from '../../app/ThemeContext';
import { PROTOCOL_CONSTANTS, TIER_LEVELS, formatNumber, t, tn } from '@beanpool/core';
import { TIER_WORDS } from '../../utils/trust-tier';
import { richWords } from './rich-words';

// Where each tier starts, as a floor (the node's own table — never a copy).
const [NEWCOMER, RESIDENT, STEWARD, ELDER] = TIER_LEVELS;
const floorOf = (credit: number) => formatNumber(PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - credit);
/** What the counterparties' ratings scale the score to: stars → share (the reputation multiplier). */
const RATING_SHARES: ReadonlyArray<readonly [stars: number, share: number]> = [[5, 100], [4, 90], [3, 80], [1, 60]];

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
        tierContainer: {
            backgroundColor: colors.surface.subtle,
            padding: 16,
            borderRadius: 14,
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

    const bold = styles.boldWhiteText;
    /** A tier's heading: its emoji and its name in the member's language. */
    const tierHeading = (tier: typeof NEWCOMER) => t('{emoji} {label}', { emoji: tier.emoji, label: t(TIER_WORDS[tier.name]) });
    /** "Reached when your credit floor reaches -200B (up to -599B)": where a tier starts, and where the next one does. */
    const reachedUpTo = (tier: typeof NEWCOMER, next: typeof NEWCOMER) => richWords(t('Reached when your credit floor reaches **{floor}B** (up to {upTo}B)', { floor: floorOf(tier.minCredit), upTo: floorOf(next.minCredit - 1) }), bold);

    const tabs: InfoModalTab[] = [
        {
            id: 'levels',
            label: t('Trust Formula'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t('Your **Trust** grows with the **real value you trade** with the community — not how many trades or handshakes you rack up.'), bold)}
                    </Text>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t("1. VALUE YOU'VE TRADED")}</Text>
                        <Text style={styles.cardText}>
                            {richWords(t('Your score is a **smooth, saturating curve** over the qualified value you cycle through trades — proportional at first, then leveling off near the top so no one runs away.'), bold)}
                        </Text>
                        <Text style={[styles.cardText, { marginTop: 8 }]}>
                            {richWords(t('💡 **Diversity counts:** value with any one partner is capped, so trading with **many** people builds trust far faster than repeat trades with a single partner.'), bold)}
                        </Text>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('2. REPUTATION MULTIPLIER')}</Text>
                        <Text style={[styles.cardText, { marginBottom: 8 }]}>
                            {t('Ratings left by counterparties scale your score:')}
                        </Text>
                        {RATING_SHARES.map(([stars, share]) => (
                            <ListItem key={stars}>{richWords(tn(stars, '**{n} star** = **{share}%** of score', '**{n} stars** = **{share}%** of score', { n: formatNumber(stars, 1), share }), bold)}</ListItem>
                        ))}
                        <ListItem>{richWords(t('**No reviews** = **{share}%** of score', { share: 100 }), bold)}</ListItem>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('3. MILESTONES')}</Text>
                        <Text style={[styles.cardText, { marginBottom: 8 }]}>
                            {t("As your trust grows you pass milestone badges — they mark your progress, they don't set your credit floor:")}
                        </Text>
                        <ListItem>{richWords(t('🌱 **{newcomer}** → 🏠 **{resident}** → 🏛️ **{steward}** → ⛰️ **{elder}**', {
                            newcomer: t(TIER_WORDS.Newcomer), resident: t(TIER_WORDS.Resident), steward: t(TIER_WORDS.Steward), elder: t(TIER_WORDS.Elder),
                        }), bold)}</ListItem>
                        <ListItem>{richWords(t('New members show a **🔑 Founding** badge until their first trade.'), bold)}</ListItem>
                    </View>
                </View>
            )
        },
        {
            id: 'perks',
            label: t('Tiers & Perks'),
            content: (
                <View style={styles.tabContent}>
                    <Text style={styles.descriptionText}>
                        {richWords(t('Tiers are **recognition milestones** — they mark how far your trust has grown. The one reward that deepens with them is your **credit floor** (how far below zero you can spend). Your floor slides continuously with the value you trade; the tiers are just the signposts along the way.'), bold)}
                    </Text>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.brand.primary }]}>
                        <Text style={styles.tierTitle}>{t('🔑 Founding Status (before 1st trade)')}</Text>
                        <ListItem>{richWords(t('A starting state that lasts until you complete your **very first trade**'), bold)}</ListItem>
                        <ListItem>{richWords(t('Shows as **🔑 FOUNDING** so members know to help you get started'), bold)}</ListItem>
                        <ListItem>{richWords(t('Your credit floor stays at **{floor}** until that first trade — no overdraft yet', { floor: 0 }), bold)}</ListItem>
                        <ListItem>{richWords(t('Graduates to **{tier}** automatically once you trade', { tier: t(TIER_WORDS.Newcomer) }), bold)}</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.newcomer.fg }]}>
                        <Text style={styles.tierTitle}>{tierHeading(NEWCOMER)}</Text>
                        <ListItem>{t('Credit floor opens after your 1st completed trade (or via a starter vouch of 25, 50, or 100B)')}</ListItem>
                        <ListItem>{t('Browse & trade the marketplace, receive credits')}</ListItem>
                        <ListItem>{richWords(t('**Sending credits** unlocks the moment you complete that first trade'), bold)}</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.resident.fg }]}>
                        <Text style={styles.tierTitle}>{tierHeading(RESIDENT)}</Text>
                        <ListItem>{reachedUpTo(RESIDENT, STEWARD)}</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.steward.fg }]}>
                        <Text style={styles.tierTitle}>{tierHeading(STEWARD)}</Text>
                        <ListItem>{reachedUpTo(STEWARD, ELDER)}</ListItem>
                        <ListItem>{t('Trusted-trader recognition across the community')}</ListItem>
                    </View>

                    <View style={[styles.tierContainer, { borderLeftColor: colors.trust.elder.fg }]}>
                        <Text style={styles.tierTitle}>{tierHeading(ELDER)}</Text>
                        <ListItem>{richWords(t('Reached when your credit floor reaches **{floor}B** (max **{max}B**)', { floor: floorOf(ELDER.minCredit), max: floorOf(PROTOCOL_CONSTANTS.CREDIT_FLOOR_CAP) }), bold)}</ListItem>
                        <ListItem>{t('Recognised as a long-standing, high-trust member')}</ListItem>
                    </View>

                    <View style={styles.cardContainer}>
                        <Text style={styles.cardLabel}>{t('OPEN TO EVERYONE — NO TIER REQUIRED')}</Text>
                        <ListItem>{richWords(t('**Inviting new members** — share BeanPool freely from day one.'), bold)}</ListItem>
                        <ListItem>{richWords(t('**A governance voice** — 1 member 1 vote on community polls and roles, plus quadratic voting on pool spending based on earned trade standing.'), bold)}</ListItem>
                        <ListItem>{richWords(t('**No daily spending limits** — your credit floor is the only guardrail.'), bold)}</ListItem>
                    </View>
                </View>
            )
        }
    ];

    return (
        <InfoModal
            isOpen={isOpen}
            onClose={onClose}
            title={t('Trust & Reputation')}
            icon={<MaterialCommunityIcons name="shield-star" size={24} color={colors.brand.primary} />}
            tabs={tabs}
            defaultTab={initialTab}
        />
    );
}

