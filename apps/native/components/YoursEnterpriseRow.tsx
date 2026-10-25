/**
 * One enterprise or project the member keeps, in the Yours block of Commons (DESIGN-commons-ux-fable.md §3.1, §4.1).
 *
 * Ordered lead first, then by name (yoursRows). A tap on the row opens the enterprise page (/treasury-detail);
 * a tap on the Manage pill opens its keepers' console (/treasury-manage).
 *
 * At 320 dp × 1.3:
 * - Avatar: 46 dp.
 * - Name: 15/800, allows wrapping to 2 lines.
 * - Pills row: status badges (PAUSED, WINDING UP, CLOSED, FUNDED), kind pill (Enterprise / Project), role pill (Lead keeper, Keeper, Leader, Collaborator).
 * - Line 2: 12/secondary — enterprise: "Balance {amount} 🫘 · {n} live offers"; project: "{raised} of {goal} 🫘 raised · {days}".
 * - Manage pill: keeps ≥44 dp touch target, under line 2 (so line 2 has the row's width at 320 dp × 1.3).
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { formatNumber, t, tn } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { MemberAvatar } from './MemberAvatar';
import { enterpriseCardStatus } from '../utils/enterprise-card';
import { ownerKindName, rowRoleWord, rowSpokenName, type YourChat } from '../utils/your-groups';
import type { TreasurySummary } from '../utils/db';

function getDaysRemaining(deadline: string | null | undefined): { text: string; expired: boolean } | null {
    if (!deadline) return null;
    const diff = new Date(deadline).getTime() - new Date().getTime();
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    if (days < 0) return { text: t('Expired'), expired: true };
    if (days === 0) return { text: t('Ends today'), expired: false };
    return { text: tn(days, '{n} days left', '{n} days left'), expired: false };
}

export interface YoursEnterpriseRowItem {
    chat: YourChat;
    summary?: TreasurySummary;
}

interface Props {
    item: YoursEnterpriseRowItem;
    onPress?: (chat: YourChat, summary?: TreasurySummary) => void;
    onManage?: (chat: YourChat, summary?: TreasurySummary) => void;
    flush?: boolean;
}

export function YoursEnterpriseRow({ item, onPress, onManage, flush }: Props) {
    const styles = useStyles(({ colors, theme }) => StyleSheet.create({
        row: {
            flexDirection: 'column',
            minHeight: 64,
            paddingVertical: 10,
            paddingHorizontal: 12,
            marginHorizontal: 16,
            marginVertical: 4,
            borderRadius: 14,
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        mainCol: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            width: '100%',
        },
        avatarCol: {
            width: 46,
            height: 46,
            borderRadius: 14,
            marginRight: 12,
            marginTop: 2,
            flexShrink: 0,
            overflow: 'hidden',
        },
        avatarPlaceholder: {
            width: 46,
            height: 46,
            borderRadius: 14,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            alignItems: 'center',
            justifyContent: 'center',
        },
        body: {
            flex: 1,
            minWidth: 0,
        },
        name: {
            fontSize: 15,
            fontWeight: '800',
            color: colors.text.heading,
            letterSpacing: -0.3,
        },
        badgeRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 6,
            marginTop: 4,
        },
        badge: {
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 6,
            alignSelf: 'flex-start',
            maxWidth: '100%',
        },
        badgePaused: {
            backgroundColor: colors.feedback.warning.bg,
            borderWidth: 1,
            borderColor: colors.feedback.warning.border,
        },
        badgePausedText: {
            fontSize: 10,
            fontWeight: '800',
            color: colors.feedback.warning.fg,
            letterSpacing: 0.5,
        },
        badgeWindingUp: {
            backgroundColor: colors.feedback.danger.bg,
            borderWidth: 1,
            borderColor: colors.feedback.danger.border,
        },
        badgeWindingUpText: {
            fontSize: 10,
            fontWeight: '800',
            color: colors.feedback.danger.fg,
            letterSpacing: 0.5,
        },
        badgeClosed: {
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        badgeClosedText: {
            fontSize: 10,
            fontWeight: '800',
            color: colors.text.secondary,
            letterSpacing: 0.5,
        },
        badgeFunded: {
            backgroundColor: colors.brand.fill,
        },
        badgeFundedText: {
            fontSize: 10,
            fontWeight: '800',
            color: colors.text.inverse,
            letterSpacing: 0.5,
        },
        badgeOngoing: {
            backgroundColor: colors.brand.tint,
        },
        badgeOngoingText: {
            fontSize: 10,
            fontWeight: '800',
            color: colors.brand.primary,
            letterSpacing: 0.5,
        },
        badgeProject: {
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.indigo100,
        },
        badgeProjectText: {
            fontSize: 10,
            fontWeight: '800',
            color: theme === 'dark' ? colors.brand.primary : palette.indigo600,
            letterSpacing: 0.5,
        },
        badgeRole: {
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        badgeRoleText: {
            fontSize: 10,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        metaLine: {
            fontSize: 12,
            color: colors.text.secondary,
            marginTop: 4,
            lineHeight: 17,
        },
        manageBtn: {
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 22,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            alignSelf: 'flex-end',
            marginTop: 6,
        },
        manageBtnText: {
            fontSize: 13,
            fontWeight: '700',
            color: colors.brand.primary,
        },
    }));

    const isProject = item.chat.lifecycle === 'bounded';
    const avatarUrl = item.chat.avatarUrl || item.summary?.avatar || item.summary?.avatarUrl;

    const summaryStatus = item.summary
        ? enterpriseCardStatus(item.summary)
        : null;
    const stateBadge = summaryStatus?.stateBadge ?? null;
    const isFunded = summaryStatus?.isFunded ?? false;

    const kindName = ownerKindName(item.chat.kind, item.chat.lifecycle);
    const roleWord = rowRoleWord(item.chat);

    // Line 2 wording
    let line2: string | null = null;
    if (item.summary) {
        if (isProject) {
            const raised = item.summary.currentAmount != null
                ? item.summary.currentAmount
                : Math.max(0, item.summary.balance ?? 0);
            const goal = item.summary.goalAmount ?? 0;
            const daysRemaining = getDaysRemaining(item.summary.deadlineAt);
            if (goal > 0) {
                line2 = daysRemaining
                    ? t('{raised} of {goal} 🫘 raised · {days}', {
                        raised: formatNumber(raised),
                        goal: formatNumber(goal),
                        days: daysRemaining.text,
                    })
                    : t('{raised} of {goal} 🫘 raised', {
                        raised: formatNumber(raised),
                        goal: formatNumber(goal),
                    });
            } else {
                line2 = t('Balance {amount} 🫘', { amount: formatNumber(item.summary.balance ?? 0) });
            }
        } else {
            const balance = item.summary.balance ?? 0;
            const liveOffers = item.summary.liveOffers ?? 0;
            const offersText = tn(liveOffers, '{n} live offer', '{n} live offers');
            line2 = t('Balance {amount} 🫘 · {offers}', {
                amount: formatNumber(balance),
                offers: offersText,
            });
        }
    }

    // Every badge drawn is spoken: a closed project that was funded says both.
    const spokenState = stateBadge === 'paused'
        ? t('paused')
        : stateBadge === 'winding_up'
            ? t('winding up')
            : stateBadge === 'closed'
                ? t('closed')
                : null;
    const spokenLabel = [rowSpokenName(item.chat), spokenState, isFunded ? t('funded') : null, line2].filter(Boolean).join('. ');

    const handleRowPress = () => {
        if (onPress) {
            onPress(item.chat, item.summary);
        } else {
            router.push({
                pathname: '/treasury-detail',
                params: {
                    publicKey: item.chat.id,
                    name: item.chat.name,
                    avatar: avatarUrl || '',
                },
            });
        }
    };

    const handleManagePress = () => {
        if (onManage) {
            onManage(item.chat, item.summary);
        } else {
            router.push({
                pathname: '/treasury-manage',
                params: {
                    publicKey: item.chat.id,
                    name: item.chat.name,
                },
            });
        }
    };

    return (
        <View style={[styles.row, flush && { marginHorizontal: 0 }]}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={spokenLabel}
                style={styles.mainCol}
                onPress={handleRowPress}
            >
                <View style={styles.avatarCol}>
                    {avatarUrl ? (
                        <MemberAvatar avatarUrl={avatarUrl} pubkey={item.chat.id} callsign={item.chat.name} size={46} />
                    ) : (
                        <View style={styles.avatarPlaceholder}>
                            <Text style={{ fontSize: 22 }}>{isProject ? '🎯' : '🥖'}</Text>
                        </View>
                    )}
                </View>

                <View style={styles.body}>
                    <Text style={styles.name} numberOfLines={2}>
                        {item.chat.name}
                    </Text>

                    <View style={styles.badgeRow}>
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
                        {isFunded && (
                            <View style={[styles.badge, styles.badgeFunded]}>
                                <Text style={styles.badgeFundedText}>{t('🎉 FUNDED')}</Text>
                            </View>
                        )}
                        <View style={[styles.badge, isProject ? styles.badgeProject : styles.badgeOngoing]}>
                            <Text style={[styles.badgeOngoingText, isProject && styles.badgeProjectText]}>
                                {kindName}
                            </Text>
                        </View>
                        {!!roleWord && (
                            <View style={[styles.badge, styles.badgeRole]}>
                                <Text style={styles.badgeRoleText}>{roleWord}</Text>
                            </View>
                        )}
                    </View>

                    {!!line2 && (
                        <Text style={styles.metaLine} numberOfLines={2}>
                            {line2}
                        </Text>
                    )}
                </View>
            </Pressable>

            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('Manage {name}', { name: item.chat.name })}
                style={styles.manageBtn}
                onPress={handleManagePress}
            >
                <Text style={styles.manageBtnText}>{t('Manage ›')}</Text>
            </Pressable>
        </View>
    );
}
