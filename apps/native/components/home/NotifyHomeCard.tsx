/**
 * Home's card while something of the member's is live (DESIGN-notify-and-backup-asks-fable-amend2.md §12.3 slice N3; the
 * first design §4.3, amend1 §4.3): "You have 1 offer up. This phone won't tell you when someone answers." [Turn on], with ×
 * on its sky band, "NOTIFICATIONS". An event they marked: "You're going to Saturday market. This phone won't remind you."
 *
 * It sits in the once card's slot (components/home/NotifyAskCard.tsx), at the top of Home above the cards, and is never drawn
 * with the once card or the way-back card: Home decides it only once both are known not up, and core's rule (`notifyAsks`
 * `home`) says whether it may show at all: a phone that has to ask and still can, not within 7 days of a "Later", never
 * after the phone's no. Turn on is the phone's own pop-up through the one door; × puts it away for 30 days (for good at the
 * third). In Arrange it stays where it is, quiet, as the once card does, so the cards under it keep their places.
 *
 * Nothing here asks the phone: the card draws and hands its two taps to Home. Turn on is a full-width row that wraps its
 * words at 320 dp with 1.3x text, at least 48 dp, as is the ×; the floating "+ ADD POST" steps aside for them. Colours from
 * the central tokens only.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import type { NotifyHomeWords } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { FabAware, HOME_TARGET_DP, HomeCard } from './HomeParts';

export function NotifyHomeCard({ words, colors, busy, onTurnOn, onAway, quiet }: {
    words: NotifyHomeWords;
    colors: AppColors;
    /** The answer is being kept (the phone's pop-up is up): both wait. */
    busy: boolean;
    onTurnOn: () => void;
    onAway: () => void;
    /** In Arrange: the card stays where it is, the same height, its inside quiet until Done. */
    quiet?: boolean;
}) {
    const away = (
        <Pressable
            onPress={onAway}
            disabled={busy || quiet}
            style={styles.away}
            accessibilityRole="button"
            accessibilityLabel={words.away}
            hitSlop={8}
            testID="notify-home-away"
        >
            <Text style={[styles.awayText, { color: colors.text.secondary }]}>✕</Text>
        </Pressable>
    );
    return (
        <HomeCard id="notify-home" caption={words.band} colors={colors} hue="sky" testID="home-notify-live" quiet={quiet} right={away}>
            <Text style={[styles.fact, { color: colors.text.heading }]} testID="notify-home-fact">{words.fact}</Text>
            <Text style={[styles.wont, { color: colors.text.body }]} testID="notify-home-wont">{words.wont}</Text>
            <FabAware id="notify-home:buttons">
                <Pressable
                    style={[styles.turnOn, { backgroundColor: colors.action.cta }, busy && styles.waiting]}
                    onPress={onTurnOn}
                    disabled={busy}
                    accessibilityRole="button"
                    testID="notify-home-turn-on"
                >
                    {busy ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={[styles.turnOnText, { color: colors.text.onBrand }]}>{words.turnOn}</Text>}
                </Pressable>
            </FabAware>
        </HomeCard>
    );
}

// The card's own styles, without colour (each colour is a token, set where it is drawn). Named `styles`, so the contrast
// scanner (utils/button-contrast.ts) follows it and measures Turn on's words on its fill.
const styles = StyleSheet.create({
    fact: { fontSize: 15, fontWeight: '700', lineHeight: 21, marginTop: 4, marginBottom: 4 },
    wont: { fontSize: 14, lineHeight: 20, marginBottom: 10 },
    // A full row; the label wraps, never cut off.
    turnOn: { minHeight: HOME_TARGET_DP, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    turnOnText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
    waiting: { opacity: 0.4 },
    // The ×: a full 48 dp target on the band.
    away: { minWidth: HOME_TARGET_DP, minHeight: HOME_TARGET_DP, alignItems: 'center', justifyContent: 'center' },
    awayText: { fontSize: 18, fontWeight: '700' },
});

/** The same table, read by the card's render test. */
export const notifyHomeCardStyles = styles;
