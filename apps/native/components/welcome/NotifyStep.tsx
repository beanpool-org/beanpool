/**
 * The join's last screen: the one soft ask for notifications (DESIGN-notify-and-backup-asks-fable-amend2.md §4, slice N1j;
 * Marty, 21 Nov 2026: "it is that important to get notifications that we should do a soft ask (which opens the hard ask) in
 * the onboard"). After the way back and straight before Home (a claim: before the owner's card), only on a phone that has to
 * ask and still can (core's `notifyJoinStep`: never Android 8 to 12, which allows them without asking).
 *
 * "Hear from {community}", the reason only BeanPool has ("never emails or texts you … the only way it can reach you"), what
 * arrives and "Never ads." (core's `notifyJoinWords`). Two buttons, both in the fixed foot so neither scrolls away at 320 dp
 * with 1.3x text: "Turn on notifications", with "Your phone will ask you to confirm." under it, brings the phone's own pop-up
 * (only that tap does); "Later" goes on, records no "no", and is not final. Quiet, not hidden: plain words in the heading ink
 * with a full 48 dp target, where the way back's button sat, so a double tap never lands on "Turn on notifications".
 *
 * The bell band goes on a small screen (Marty's walk: at 320 dp with 1.3x text the words and both buttons fit one screen
 * then). Colours from the central tokens only: the brand fill under the band's bell (text.onBrand), the call to action's
 * terracotta under white words for the main button, as the front door's.
 *
 * Nothing here asks the phone or waits on the network: the screen draws and hands its two taps to the welcome screen
 * (utils/notify-join-step.ts), which leaves for Home (or the owner's card) whatever the answer.
 *
 * The join ends from here (welcome.tsx `handleConfirmSeed`). Where that fails, the answer is already kept: the screen says
 * what went wrong in the words the way back and the owner's card show, and its one button tries the end again.
 */
import React from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { NotifyJoinWords } from '@beanpool/core';
import { useOnboardingColors } from '../../app/ThemeContext';
import { StepBar } from './StepDots';
import { StepFooter } from './StepFooter';
import type { OnboardingFlow } from '../../utils/onboarding-state';

/**
 * Below this many dp of height for each 1x of text (the window's height over its text scale), the bell band goes: a 320 x 569
 * phone at 1.3x has 437, a 360 x 640 phone at 1x has 640. The words still scroll and the buttons stay in the foot either way.
 */
export const NOTIFY_BAND_MIN_HEIGHT = 560;

/** Whether the bell band is drawn, from the window: a small screen or large text drops it. */
export function notifyBandFits(win: { height: number; fontScale?: number }): boolean {
    const scale = win.fontScale && win.fontScale > 0 ? win.fontScale : 1;
    return win.height / scale >= NOTIFY_BAND_MIN_HEIGHT;
}

export function NotifyStep({ words, flow, wayBack, busy, onBack, onTurnOn, onLater, failed }: {
    words: NotifyJoinWords;
    flow: OnboardingFlow;
    /** False where the join skipped the way back (utils/join-steps.ts `wayBackSkipped`): one dot fewer. */
    wayBack: boolean;
    /** The answer is being kept (welcome.tsx's `loading`): both buttons wait. */
    busy: boolean;
    onBack?: () => void;
    onTurnOn: () => void;
    onLater: () => void;
    /** The join's end failed after the answer was kept: what went wrong, and the button that tries the end again. */
    failed?: { message: string; retry: string; onRetry: () => void } | null;
}) {
    const { colors, dark } = useOnboardingColors();
    const win = useWindowDimensions();
    const band = notifyBandFits(win);
    return (
        <SafeAreaView style={[styles.container, { backgroundColor: colors.surface.page }]}>
            <StatusBar style={dark ? 'light' : 'dark'} />
            <ScrollView contentContainerStyle={styles.scroll}>
                <StepBar step="notify" flow={flow} wayBack={wayBack} notify busy={busy} onBack={onBack} />
                <View style={[styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]}>
                    {band ? (
                        <View style={[styles.band, { backgroundColor: colors.brand.fill }]} testID="notify-step-band" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                            <MaterialCommunityIcons name="bell-ring" size={44} color={colors.text.onBrand} />
                        </View>
                    ) : null}
                    <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header" testID="notify-step-title">{words.title}</Text>
                    <Text style={[styles.body, { color: colors.text.body }]}>{words.never}</Text>
                    <Text style={[styles.body, styles.strong, { color: colors.text.heading }]}>{words.only}</Text>
                    <Text style={[styles.arrives, { color: colors.text.secondary }]} testID="notify-step-arrives">{words.arrives} {words.ads}</Text>
                </View>
            </ScrollView>
            <StepFooter testID="step-footer-notify">
                {failed ? (
                    <>
                        <Text style={[styles.error, { color: colors.feedback.danger.fg }]} accessibilityRole="alert" testID="notify-step-error">{failed.message}</Text>
                        <Pressable
                            style={[styles.turnOn, { backgroundColor: colors.action.cta }, busy && styles.waiting]}
                            onPress={failed.onRetry}
                            disabled={busy}
                            accessibilityRole="button"
                            testID="notify-step-retry"
                        >
                            {busy ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={[styles.turnOnText, { color: colors.text.onBrand }]}>{failed.retry}</Text>}
                        </Pressable>
                    </>
                ) : (
                    <>
                        <Pressable
                            style={[styles.turnOn, { backgroundColor: colors.action.cta }, busy && styles.waiting]}
                            onPress={onTurnOn}
                            disabled={busy}
                            accessibilityRole="button"
                            testID="notify-step-turn-on"
                        >
                            {busy ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={[styles.turnOnText, { color: colors.text.onBrand }]}>{words.turnOn}</Text>}
                        </Pressable>
                        <Text style={[styles.confirm, { color: colors.text.secondary }]}>{words.confirm}</Text>
                        <Pressable style={[styles.later, busy && styles.waiting]} onPress={onLater} disabled={busy} accessibilityRole="button" testID="notify-step-later">
                            <Text style={[styles.laterText, { color: colors.text.heading }]}>{words.later}</Text>
                        </Pressable>
                    </>
                )}
            </StepFooter>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    card: { width: '100%', padding: 24, borderRadius: 16, borderWidth: 1 },
    band: { height: 96, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
    title: { fontSize: 22, fontWeight: '800', lineHeight: 28, marginBottom: 12 },
    body: { fontSize: 16, lineHeight: 22, marginBottom: 8 },
    strong: { fontWeight: '700' },
    arrives: { fontSize: 15, lineHeight: 21, marginTop: 4 },
    // 52 dp at least; the label wraps, never cut off.
    turnOn: { minHeight: 52, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
    turnOnText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
    confirm: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 8 },
    // A full 48 dp target: quiet words, never hidden.
    later: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
    laterText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
    waiting: { opacity: 0.4 },
    error: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 12 },
});
