/**
 * AuthorCard: the box that names the person behind an item on its own screen. A listing's "POSTED BY" and an event's
 * "HOSTED BY" are this one box (Marty, 4 Nov 2026, on the event page: "hosted by is so small and in plain text - consider
 * looking at the offer card and styling it like that one"): a rounded card, the label in small capitals, the person's face,
 * their name with the handshake, and their ratings line ("★★★★★ (4.8) • 6 Reviews", or "☆☆☆☆☆ No ratings yet").
 *
 * The whole card is one button: a tap opens the person's profile. The caller passes the label (already through t(), so the
 * words tooling sees each key where it is used) and what the tap does; a card with no `onPress`, or `disabled` (a
 * visitors' view hides who posted, utils/posts-view.ts), shows the person and opens nothing.
 *
 * `useMemberRating` is for a screen that does not already hold the person's ratings (the event page); the listing's own
 * screen reads them with the rest of its page and passes them in.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { t, tn, formatNumber } from '@beanpool/core';
import { MemberAvatar } from './MemberAvatar';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useCardShell } from './market-card-shell';
import { getMemberRatings } from '../utils/db';
import { isHiddenAuthor } from '../utils/posts-view';

export interface AuthorRating {
    /** Null until the node has answered, and for a person with no ratings. */
    average: number | null;
    count: number;
}

interface AuthorCardProps {
    /** "POSTED BY", "HOSTED BY": the caller's own t(), so each key is read where it is drawn. */
    label: string;
    pubkey: string;
    callsign: string;
    avatarUrl?: string | null;
    rating: AuthorRating;
    /** What a tap does (open the person's profile). With none, or with `disabled`, the card opens nothing. */
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
    /** The screen's own margins, where they differ from the box's place in a 16 dp column (none above, 16 under it). */
    style?: StyleProp<ViewStyle>;
}

const NO_RATING: AuthorRating = { average: null, count: 0 };

const renderBeans = (rating: number): string => {
    const r = Math.round(rating) || 0;
    return '★'.repeat(Math.min(r, 5)) + '☆'.repeat(Math.max(0, 5 - r));
};

const reviewsLine = (average: number, count: number) =>
    tn(count, '({average}) • {n} Reviews', '({average}) • {n} Reviews', { average: formatNumber(average, 1) });

/**
 * A person's ratings for a screen that shows them as a card. A visitors' view that hides who posted asks nothing. The card is
 * an extra on its screen: a rating that cannot be read leaves it saying "No ratings yet", never an error.
 */
export function useMemberRating(pubkey: string | null | undefined): AuthorRating {
    const [rating, setRating] = useState<AuthorRating>(NO_RATING);
    useEffect(() => {
        // A screen handed another person starts from nothing: never the last person's stars on this one, nor while theirs load.
        setRating(NO_RATING);
        if (!pubkey || isHiddenAuthor(pubkey)) return;
        let live = true;
        try {
            getMemberRatings(pubkey)
                .then(r => { if (live) setRating({ average: r.average, count: r.count }); })
                .catch(() => {});
        } catch { /* an unreadable rating is "No ratings yet" */ }
        return () => { live = false; };
    }, [pubkey]);
    return rating;
}

export function AuthorCard({ label, pubkey, callsign, avatarUrl, rating, onPress, disabled, testID, accessibilityLabel, style }: AuthorCardProps) {
    const styles = useStyles(makeStyles);
    // The page box of the style box (components/market-card-shell.ts): the card's corners, border, ground, shadow and padding.
    const shell = useCardShell();
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            testID={testID}
            style={[shell.pageBox, styles.card, style]}
            disabled={disabled || !onPress}
            onPress={onPress}
        >
            <Text style={[shell.boxLabel, styles.label]}>{label}</Text>
            <View style={styles.row}>
                <View style={styles.avatar}>
                    <MemberAvatar avatarUrl={avatarUrl} pubkey={pubkey} callsign={callsign} size={48} borderRadius={24} />
                </View>
                <View style={styles.info}>
                    <Text style={styles.name}>🤝 {callsign}</Text>
                    <Text style={styles.rating}>
                        {rating.average !== null && rating.count > 0 ? (
                            <>
                                <Text style={styles.stars}>{renderBeans(rating.average)}</Text>
                                <Text> {reviewsLine(rating.average, rating.count)}</Text>
                            </>
                        ) : (
                            <Text>{t('☆☆☆☆☆ No ratings yet')}</Text>
                        )}
                    </Text>
                </View>
            </View>
        </Pressable>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) => StyleSheet.create({
    // Both pages pad their column 16 a side (DESIGN-detail-pages-fable.md §2.1): the box sits in it, 16 above the next part.
    card: { marginBottom: 16 },
    label: { marginBottom: 8 },
    row: { flexDirection: 'row', alignItems: 'center' },
    avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme === 'dark' ? 'rgba(217,119,87,0.2)' : 'rgba(217,119,87,0.1)', justifyContent: 'center', alignItems: 'center' },
    // Shrinks so a long name wraps beside the face at 320 dp and 1.3× text, never past the card.
    info: { marginLeft: 12, flexShrink: 1 },
    name: { color: colors.text.body, fontSize: 16, fontWeight: '700' },
    rating: { color: colors.text.secondary, fontSize: 12, marginTop: 2 },
    stars: { color: colors.trust.star, letterSpacing: -1 },
});
