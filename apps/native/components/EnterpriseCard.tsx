/**
 * One enterprise or project on the Commons (app/(tabs)/projects.tsx's list), and Example Valley's in the Commons preview
 * (components/showcase/Previews.tsx CommonsPreview): the same card fed the sample, `sample` adding the 🏘️ Local
 * community pill. A tap opens the enterprise page, which draws a sample id from the sample (treasury-detail.tsx).
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { TreasurySummary } from '../utils/db';
import { MemberAvatar } from './MemberAvatar';
import { LocalCommunityMark } from './showcase/LocalCommunityMark';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { enterpriseCardStatus } from '../utils/enterprise-card';
import { t } from '@beanpool/core';

/** The Commons cards' styles, the enterprise card's and (in projects.tsx) the group card's, which shares most of them. */
export const commonsCardStyles = ({ theme, colors }: Pick<ThemeContextType, 'theme' | 'colors'>) => ({
    card: { backgroundColor: colors.surface.card, borderRadius: 16, marginBottom: 16, borderWidth: 1, borderColor: colors.border.default, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 3 },
    cardHeader: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingBottom: 8, gap: 12 },
    avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface.subtle },
    avatarPlaceholder: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border.default },
    cardTitleCol: { flex: 1, minWidth: 0 },
    // Badges sit on their own row under the name: beside it, a CONVENOR or ONGOING badge took
    // ~90dp of a ~200dp column and cut names to "Communi…" at 320dp.
    badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
    cardTitle: { fontSize: 17, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.3 },
    cardMeta: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },

    // Never wider than the column: on a large text setting a badge wraps at its space rather than clip ("🏛️ ENTERPRISE"
    // measured 126-137 dp of the 202 dp column at 320 dp x 1.3; at x 2 "⏳ WINDING UP" ran 4 dp past it).
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, alignSelf: 'flex-start', maxWidth: '100%' },
    badgePaused: { backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border },
    badgePausedText: { fontSize: 10, fontWeight: '800', color: colors.feedback.warning.fg, letterSpacing: 0.5 },
    badgeWindingUp: { backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border },
    badgeWindingUpText: { fontSize: 10, fontWeight: '800', color: colors.feedback.danger.fg, letterSpacing: 0.5 },
    badgeClosed: { backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default },
    badgeClosedText: { fontSize: 10, fontWeight: '800', color: colors.text.secondary, letterSpacing: 0.5 },
    badgeOngoing: { backgroundColor: colors.brand.tint },
    badgeOngoingText: { fontSize: 10, fontWeight: '800', color: colors.brand.primary, letterSpacing: 0.5 },
    badgeProject: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.indigo100 },
    badgeProjectText: { fontSize: 10, fontWeight: '800', color: theme === 'dark' ? colors.brand.primary : palette.indigo600, letterSpacing: 0.5 },
    badgeFunded: { backgroundColor: colors.brand.fill },
    badgeFundedText: { fontSize: 10, fontWeight: '800', color: colors.text.inverse, letterSpacing: 0.5 },

    cardBody: { paddingHorizontal: 14, paddingBottom: 14 },
    purposeText: { fontSize: 14, color: colors.text.body, lineHeight: 20, marginBottom: 12 },
    purposeTextPlaceholder: { fontStyle: 'italic', color: colors.text.muted },

    financeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface.app, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: colors.border.default },
    financeLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
    balanceText: { fontSize: 16, fontWeight: '900' },
    balancePos: { color: colors.brand.primary },
    balanceNeg: { color: colors.feedback.warning.fg },
    deficitWarning: { fontSize: 10, color: colors.feedback.warning.fg, fontWeight: '700', marginTop: 1 },

    progressSection: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border.default },
    progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 6 },
    currentText: { fontSize: 13, fontWeight: 'bold', color: colors.text.body },
    currentTextFunded: { color: colors.brand.primary },
    goalText: { fontSize: 12, color: colors.text.secondary, fontWeight: '500' },
    progressBarBg: { height: 7, width: '100%', backgroundColor: colors.surface.subtle, borderRadius: 4, overflow: 'hidden' },
    progressBarFill: { height: '100%', borderRadius: 4 },
    deadlineText: { fontSize: 11, fontWeight: '700', color: colors.brand.primary, marginTop: 4 },
    deadlineExpired: { color: colors.feedback.danger.fg },

    pledgeCardBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.brand.fill },
    pledgeCardBtnText: { color: colors.text.inverse, fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
} as const);

function getDaysRemaining(deadline: string | null | undefined) {
    if (!deadline) return null;
    const diff = new Date(deadline).getTime() - new Date().getTime();
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    if (days < 0) return 'Expired';
    if (days === 0) return 'Ends today';
    return `${days} days left`;
}

export function EnterpriseCard({ item, sample = false }: { item: TreasurySummary; sample?: boolean }) {
    const { colors } = useTheme();
    const styles = useStyles((t) => StyleSheet.create(commonsCardStyles(t)));
    const { stateBadge, kindBadge, showKindBadge, hasGoal, isFunded, takesPledges, currentRaised, meta } = enterpriseCardStatus(item);
    const goalAmount = item.goalAmount || 1;
    const progress = Math.min(100, (currentRaised / goalAmount) * 100);
    const daysRemaining = getDaysRemaining(item.deadlineAt);

    return (
        <Pressable
            accessibilityRole="button"
            style={styles.card}
            testID={sample ? 'sample-enterprise-card' : undefined}
            onPress={() => {
                router.push({
                    pathname: '/treasury-detail',
                    params: {
                        publicKey: item.publicKey,
                        name: item.name || item.callsign,
                        avatar: item.avatar || item.avatarUrl || ''
                    }
                });
            }}
        >
            <View style={styles.cardHeader}>
                {item.avatar ? (
                    // The node's URL for the photo, relative to it, or a shipped picture: MemberAvatar resolves both,
                    // which React Native's Image cannot.
                    <MemberAvatar avatarUrl={item.avatar} pubkey={item.publicKey} callsign={item.name || item.callsign || ''} size={44} />
                ) : (
                    <View style={[styles.avatar, styles.avatarPlaceholder]}>
                        <Text style={{ fontSize: 22 }}>{hasGoal ? '🌱' : '🏛️'}</Text>
                    </View>
                )}
                <View style={styles.cardTitleCol}>
                    <Text style={styles.cardTitle} numberOfLines={2}>{item.name || item.callsign}</Text>
                    <View style={styles.badgeRow}>
                        {sample && <LocalCommunityMark variant="pill" feature="enterprises" />}
                        {stateBadge === 'paused' && (
                            <View style={[styles.badge, styles.badgePaused]}>
                                <Text style={styles.badgePausedText}>{t('⏸️ PAUSED')}</Text>
                            </View>
                        )}
                        {stateBadge === 'winding_up' && (
                            <View style={[styles.badge, styles.badgeWindingUp]}>
                                <Text style={styles.badgeWindingUpText}>{t('⏳ WINDING UP')}</Text>
                            </View>
                        )}
                        {stateBadge === 'closed' && (
                            <View style={[styles.badge, styles.badgeClosed]}>
                                <Text style={styles.badgeClosedText}>{t('CLOSED')}</Text>
                            </View>
                        )}
                        {!showKindBadge ? null : kindBadge === 'funded' ? (
                            <View style={[styles.badge, styles.badgeFunded]}>
                                <Text style={styles.badgeFundedText}>{t('🎉 FUNDED')}</Text>
                            </View>
                        ) : kindBadge === 'project' ? (
                            <View style={[styles.badge, styles.badgeProject]}>
                                <Text style={styles.badgeProjectText}>{t('🌱 PROJECT')}</Text>
                            </View>
                        ) : (
                            <View style={[styles.badge, styles.badgeOngoing]}>
                                <Text style={styles.badgeOngoingText}>{t('🏛️ ENTERPRISE')}</Text>
                            </View>
                        )}
                    </View>
                    <Text style={styles.cardMeta} numberOfLines={2}>{meta}</Text>
                </View>
            </View>

            <View style={styles.cardBody}>
                {/* Purpose Statement (docs §4) */}
                <Text
                    style={[styles.purposeText, !item.purpose && styles.purposeTextPlaceholder]}
                    numberOfLines={2}
                >
                    {item.purpose || 'No stated purpose yet.'}
                </Text>

                {/* Financial summary row */}
                <View style={styles.financeRow}>
                    <View>
                        <Text style={styles.financeLabel}>{t('Enterprise Balance')}</Text>
                        {item.balance < 0 && (
                            <Text style={styles.deficitWarning}>{t('in deficit (keepers eat last)')}</Text>
                        )}
                    </View>
                    <Text style={[styles.balanceText, item.balance < 0 ? styles.balanceNeg : styles.balancePos]}>
                        {item.balance} 🫘
                    </Text>
                </View>

                {/* Funding progress if Bounded / Project */}
                {hasGoal && (
                    <View style={styles.progressSection}>
                        <View style={styles.progressHeader}>
                            <Text style={[styles.currentText, isFunded && styles.currentTextFunded]}>
                                {currentRaised} 🫘 <Text style={{ fontWeight: 'normal', color: colors.text.secondary }}>raised</Text>
                            </Text>
                            <Text style={styles.goalText}>Goal: {item.goalAmount} 🫘</Text>
                        </View>
                        <View style={styles.progressBarBg}>
                            <View
                                style={[
                                    styles.progressBarFill,
                                    { width: `${progress}%`, backgroundColor: isFunded ? colors.brand.fill : colors.accent.fill }
                                ]}
                            />
                        </View>
                        {daysRemaining && (
                            <Text style={[styles.deadlineText, daysRemaining === 'Expired' && styles.deadlineExpired]}>
                                ⏳ {daysRemaining}
                            </Text>
                        )}
                    </View>
                )}

                {/* Primary CTA if has goal, not funded, and the enterprise still takes pledges */}
                {takesPledges && (
                    <View style={styles.pledgeCardBtn} aria-hidden={true}>
                        <MaterialCommunityIcons name="sprout" size={16} color={colors.text.inverse} />
                        <Text style={styles.pledgeCardBtnText}>{t('Pledge Beans')}</Text>
                    </View>
                )}
            </View>
        </Pressable>
    );
}
