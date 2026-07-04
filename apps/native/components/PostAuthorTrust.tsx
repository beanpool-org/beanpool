import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { getMemberRatings } from '../utils/db';
import { router } from 'expo-router';
import { MemberAvatar } from './MemberAvatar';
import { colors, palette } from '../constants/colors';

/**
 * Trust Tier Thresholds (based on Energy Cycled)
 * Energy = total outbound transaction volume
 */
// Colors come from the shared trust tokens (constants/colors.ts) so the gold
// tier ramp stays identical across cards, the Ledger, and the Trust modal.
const TRUST_TIERS = [
    { min: 1320, emoji: '⛰️', label: 'Elder',    color: colors.trust.elder.fg,    bgColor: colors.trust.elder.bg,    borderColor: colors.trust.elder.border },
    { min: 520,  emoji: '🏛️', label: 'Steward',  color: colors.trust.steward.fg,  bgColor: colors.trust.steward.bg,  borderColor: colors.trust.steward.border },
    { min: 120,  emoji: '🏠', label: 'Resident', color: colors.trust.resident.fg, bgColor: colors.trust.resident.bg, borderColor: colors.trust.resident.border },
    { min: 0,    emoji: '🌱', label: 'Newcomer', color: colors.trust.newcomer.fg, bgColor: colors.trust.newcomer.bg, borderColor: colors.trust.newcomer.border },
] as const;

export function getTrustTier(energyCycled: number = 0) {
    for (const tier of TRUST_TIERS) {
        if (energyCycled >= tier.min) return tier;
    }
    return TRUST_TIERS[TRUST_TIERS.length - 1];
}

export function isElder(energyCycled: number = 0): boolean {
    return energyCycled >= 1320;
}

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

    useEffect(() => {
        if (!pubkey) return;
        getMemberRatings(pubkey)
            .then(r => setRatingInfo({ average: r.average, count: r.count }))
            .catch(() => {});
    }, [pubkey]);

    const handlePress = () => {
        if (navigable && pubkey) {
            router.push({ pathname: '/public-profile', params: { publicKey: pubkey, callsign } });
        }
    };

    const Wrapper = navigable ? Pressable : View;

    if (mode === 'compact') {
        return (
            <Wrapper {...(navigable ? { onPress: handlePress, accessibilityRole: 'button' as const } : {})} style={styles.compactContainer}>
                {/* Avatar */}
                <MemberAvatar avatarUrl={avatarUrl} pubkey={pubkey} callsign={callsign} size={18} />
                {/* Tier badge */}
                <View style={[styles.tierBadgeCompact, { backgroundColor: tier.bgColor, borderColor: tier.borderColor }]}>
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
        <Wrapper {...(navigable ? { onPress: handlePress, accessibilityRole: 'button' as const } : {})} style={styles.fullContainer}>
            {/* Avatar */}
            <MemberAvatar avatarUrl={avatarUrl} pubkey={pubkey} callsign={callsign} size={24} />
            {/* Tier badge with label */}
            <View style={[styles.tierBadgeFull, { backgroundColor: tier.bgColor, borderColor: tier.borderColor }]}>
                <Text style={styles.tierEmojiFull}>{tier.emoji}</Text>
                <Text style={[styles.tierLabelFull, { color: tier.color }]}>{tier.label}</Text>
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

const styles = StyleSheet.create({
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
        color: colors.text.secondary,
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
        color: palette.gray600,
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
