import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { getMemberRatings } from '../utils/db';
import { router } from 'expo-router';
import { MemberAvatar } from './MemberAvatar';
import { useStyles, useTheme, type ThemeContextType } from '../app/ThemeContext';
import { getTrustTier } from '../utils/trust-tier';
import { isHiddenAuthor } from '../utils/posts-view';

// Re-exported for the screens that import them from here (Market feed Elder cards).
export { getTrustTier, isElder } from '../utils/trust-tier';

interface PostAuthorTrustProps {
    pubkey: string;
    callsign: string;
    energyCycled?: number;
    avatarUrl?: string | null;
    /** 'compact' = grid cards, 'full' = list cards */
    mode?: 'compact' | 'full';
    /** Whether to show navigation to public profile */
    navigable?: boolean;
    /** Whether author needs a founding trade (no prior trades completed) */
    isFounding?: boolean;
}

/**
 * Hybrid Trust Display: Tier Badge + Star Rating / Founding Trade indicator
 * Tier badge always shows. Star rating shows when count > 0; otherwise founding badge shows if isFounding is true.
 */
export function PostAuthorTrust({ pubkey, callsign, energyCycled = 0, avatarUrl, mode = 'full', navigable = true, isFounding = false }: PostAuthorTrustProps) {
    const [ratingInfo, setRatingInfo] = useState<{ average: number; count: number } | null>(null);
    const tier = getTrustTier(energyCycled);
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const tierColors = colors.trust[tier.token];

    // A visitors' view hides who posted (utils/posts-view.ts): nothing to rate, nobody to open.
    const canOpen = navigable && !isHiddenAuthor(pubkey);

    useEffect(() => {
        if (isHiddenAuthor(pubkey)) return;
        getMemberRatings(pubkey)
            .then(r => setRatingInfo({ average: r.average, count: r.count }))
            .catch(() => {});
    }, [pubkey]);

    const handlePress = () => {
        if (canOpen) {
            router.push({ pathname: '/public-profile', params: { publicKey: pubkey, callsign } });
        }
    };

    const Wrapper = canOpen ? Pressable : View;

    if (mode === 'compact') {
        return (
            <Wrapper {...(canOpen ? { onPress: handlePress, accessibilityRole: 'button' as const, accessibilityLabel: `View ${callsign}'s profile` } : {})} style={styles.compactContainer}>
                {/* Avatar */}
                <MemberAvatar avatarUrl={avatarUrl} pubkey={pubkey} callsign={callsign} size={18} />
                {/* Tier badge */}
                <View style={[styles.tierBadgeCompact, { backgroundColor: tierColors.bg, borderColor: tierColors.border }]}>
                    <Text style={styles.tierEmojiCompact}>{tier.emoji}</Text>
                </View>
                {/* Callsign */}
                <Text style={styles.compactCallsign} numberOfLines={1}>{callsign}</Text>
                {/* Stars / Founding key indicator */}
                {ratingInfo && ratingInfo.count > 0 ? (
                    <Text style={styles.compactStars}>
                        {'★'.repeat(Math.min(Math.round(ratingInfo.average), 5))}
                    </Text>
                ) : (
                    isFounding && (
                        <Text style={{ fontSize: 10, fontWeight: '800', color: colors.trust.founding.fg, marginLeft: 2 }}>🔑</Text>
                    )
                )}
            </Wrapper>
        );
    }

    // Full mode (list cards)
    return (
        <Wrapper {...(canOpen ? { onPress: handlePress, accessibilityRole: 'button' as const, accessibilityLabel: `View ${callsign}'s profile` } : {})} style={styles.fullContainer}>
            {/* Avatar */}
            <MemberAvatar avatarUrl={avatarUrl} pubkey={pubkey} callsign={callsign} size={24} />
            {/* Tier badge with label */}
            <View style={[styles.tierBadgeFull, { backgroundColor: tierColors.bg, borderColor: tierColors.border }]}>
                <Text style={styles.tierEmojiFull}>{tier.emoji}</Text>
                <Text style={[styles.tierLabelFull, { color: tierColors.fg }]}>{tier.label}</Text>
            </View>
            {/* Callsign */}
            <Text style={styles.fullCallsign} numberOfLines={1}>
                {callsign}
            </Text>
            {/* Star rating / Founding key badge */}
            {ratingInfo && ratingInfo.count > 0 ? (
                <View style={styles.starsContainer}>
                    <Text style={styles.fullStars}>
                        {'★'.repeat(Math.min(Math.round(ratingInfo.average), 5))}
                        {'☆'.repeat(Math.max(0, 5 - Math.round(ratingInfo.average)))}
                    </Text>
                    <Text style={styles.ratingCount}>({ratingInfo.count})</Text>
                </View>
            ) : (
                isFounding && (
                    <View style={{ backgroundColor: colors.trust.founding.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: colors.trust.founding.border, marginLeft: 4 }}>
                        <Text style={{ fontSize: 10, fontWeight: '800', color: colors.trust.founding.fg }}>🔑 FOUNDING</Text>
                    </View>
                )
            )}
        </Wrapper>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    // Compact mode (grid cards)
    compactContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: 2,
    },
    tierBadgeCompact: {
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    tierEmojiCompact: {
        fontSize: 10,
    },
    compactCallsign: {
        fontSize: 12,
        color: colors.market.author,
        fontWeight: '500',
        flex: 1,
    },
    compactStars: {
        fontSize: 9,
        color: colors.trust.star,
        letterSpacing: -1,
    },

    // Full mode (list cards)
    fullContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    tierBadgeFull: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 8,
        borderWidth: 1,
    },
    tierEmojiFull: {
        fontSize: 11,
    },
    tierLabelFull: {
        fontSize: 10,
        fontWeight: '800',
        letterSpacing: 0.3,
    },
    fullCallsign: {
        fontSize: 13,
        color: colors.market.author,
        fontWeight: '600',
        flexShrink: 1,
    },
    starsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    fullStars: {
        fontSize: 11,
        color: colors.trust.star,
        letterSpacing: -1,
    },
    ratingCount: {
        fontSize: 10,
        color: colors.text.muted,
        fontWeight: '600',
    },
});
