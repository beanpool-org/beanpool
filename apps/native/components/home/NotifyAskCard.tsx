/**
 * Home's once card (DESIGN-notify-and-backup-asks-fable-amend2.md §7, slice N1h; Marty, 21 Nov 2026, question 4: "yes, once"):
 * the join's soft ask for a member already in, who will never pass the join's screen (his friend among them), and for a
 * restore on a new phone. The same words as the join's last screen, with "a neighbour" for the name (core's
 * `notifyOnceWords`), under a sky band, "NOTIFICATIONS", at the top of Home (mockup state 5).
 *
 * Whether it shows is Home's (utils/notification-permission.ts `offerOnceCard`, core's rule): once per phone, only where the
 * phone has to ask and still can (never Android 8 to 12, never after the phone's no), never with the way-back card on the
 * same landing. "Turn on notifications", with "Your phone will ask you to confirm." under it, is the only way to the phone's
 * own pop-up; "Later" puts the card away and is not a no. Untouched for 7 days it folds into First steps' line.
 *
 * Nothing here asks the phone: the card draws and hands its two taps to Home. Both buttons are full-width rows that wrap
 * their words at 320 dp with 1.3x text, each at least 48 dp, and the floating "+ ADD POST" steps aside for them. Colours
 * from the central tokens only: the call to action's terracotta under the words on the brand, as on the join's screen.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import type { NotifyJoinWords } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { FabAware, HOME_TARGET_DP, HomeCard } from './HomeParts';

export function NotifyAskCard({ words, colors, busy, onTurnOn, onLater }: {
    words: NotifyJoinWords & { band: string };
    colors: AppColors;
    /** The answer is being kept (the phone's pop-up is up): both buttons wait. */
    busy: boolean;
    onTurnOn: () => void;
    onLater: () => void;
}) {
    const s = notifyAskCardStyles;
    return (
        <HomeCard id="notify-once" caption={words.band} colors={colors} hue="sky" testID="home-notify-once">
            <Text style={[s.title, { color: colors.text.heading }]} accessibilityRole="header" testID="notify-once-title">{words.title}</Text>
            <Text style={[s.body, { color: colors.text.body }]}>
                {words.never} <Text style={[s.strong, { color: colors.text.heading }]}>{words.only}</Text>
            </Text>
            <Text style={[s.arrives, { color: colors.text.secondary }]} testID="notify-once-arrives">{words.arrives} {words.ads}</Text>
            <FabAware id="notify-once:buttons">
                <Pressable
                    style={[s.turnOn, { backgroundColor: colors.action.cta }, busy && s.waiting]}
                    onPress={onTurnOn}
                    disabled={busy}
                    accessibilityRole="button"
                    testID="notify-once-turn-on"
                >
                    {busy ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={[s.turnOnText, { color: colors.text.onBrand }]}>{words.turnOn}</Text>}
                </Pressable>
                <Text style={[s.confirm, { color: colors.text.secondary }]}>{words.confirm}</Text>
                <Pressable style={[s.later, busy && s.waiting]} onPress={onLater} disabled={busy} accessibilityRole="button" testID="notify-once-later">
                    <Text style={[s.laterText, { color: colors.text.heading }]}>{words.later}</Text>
                </Pressable>
            </FabAware>
        </HomeCard>
    );
}

/** The card's own styles, without colour (each colour is a token, set where it is drawn): read by home-layout-320.test.ts. */
export const notifyAskCardStyles = StyleSheet.create({
    title: { fontSize: 16, fontWeight: '800', lineHeight: 22, marginTop: 4, marginBottom: 6 },
    body: { fontSize: 14, lineHeight: 20, marginBottom: 6 },
    strong: { fontWeight: '700' },
    arrives: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
    // A full row; the label wraps, never cut off.
    turnOn: { minHeight: HOME_TARGET_DP, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    turnOnText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
    confirm: { fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 6 },
    // A full 48 dp target: quiet words, never hidden.
    later: { minHeight: HOME_TARGET_DP, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
    laterText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
    waiting: { opacity: 0.4 },
});
