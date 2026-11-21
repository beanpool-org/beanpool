/**
 * The join's step bar (DESIGN-onboarding-home-landing-fable.md §3.1, slice S3): ‹ on the left where the step has a way back,
 * then one dot per step (utils/join-steps.ts), filled up to this one, no words. A screen reader hears "Step 2 of 3" once.
 *
 * Replaces the three labelled steps of old (Your Name, Your Photo, Safety Backup): at 320 dp and 1.3x text their labels took
 * two or three lines each, and a fourth step (the notifications screen, N1j) would not have fitted. Dots fit any number.
 *
 * Colours from the central tokens only: the brand ink (constants/colors.ts `brand.primary`, core's `ink.brand`) for the dots,
 * the heading ink for ‹.
 */
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../app/ThemeContext';
import { useWords } from '../LanguageProvider';
import { joinSteps, stepDot, type JoinStep } from '../../utils/join-steps';
import type { OnboardingFlow } from '../../utils/onboarding-state';

/**
 * A join screen's bar: its dot among the steps this join shows (utils/join-steps.ts), and ‹ where it has a way back.
 * Declared here, not inside the welcome screen's render: a component made anew on every render is a new type each time, so
 * React would remount ‹ on every keystroke or answer that lands, and a screen reader's focus on it would be lost.
 */
export function StepBar({ step, flow, busy, onBack, backLabel }: {
    step: JoinStep;
    flow: OnboardingFlow;
    /** The step's request is out: ‹ waits, faded (welcome.tsx's `loading`). */
    busy: boolean;
    onBack?: () => void;
    backLabel?: string;
}) {
    const dot = stepDot(joinSteps(flow), step);
    if (!dot && !onBack) return null;
    return <StepDots dot={dot} onBack={onBack} backLabel={backLabel} backDisabled={busy} />;
}

export function StepDots({ dot, onBack, backLabel, backDisabled, testID = 'step-dots' }: {
    /** Where this step sits (utils/join-steps.ts `stepDot`); null: ‹ alone, no dots. */
    dot: { at: number; of: number } | null;
    /** ‹: absent where the step has nothing to go back to (a join already in at the node). */
    onBack?: () => void;
    backLabel?: string;
    backDisabled?: boolean;
    testID?: string;
}) {
    const { colors } = useTheme();
    const { t } = useWords();
    const ink = colors.brand.primary;
    return (
        <View style={styles.row} testID={testID}>
            <View style={styles.side}>
                {onBack ? (
                    <Pressable
                        style={[styles.back, backDisabled && styles.backDisabled]}
                        onPress={onBack}
                        disabled={backDisabled}
                        accessibilityRole="button"
                        accessibilityLabel={backLabel ?? t('Back')}
                        hitSlop={4}
                        testID={`${testID}-back`}
                    >
                        <MaterialCommunityIcons name="chevron-left" size={28} color={colors.text.heading} />
                    </Pressable>
                ) : null}
            </View>
            {dot ? (
                // Read as words, "Step 2 of 3": a progress bar's role would add a percentage after them.
                <View
                    style={styles.dots}
                    accessible
                    accessibilityRole="text"
                    accessibilityLabel={t('Step {n} of {total}', { n: dot.at, total: dot.of })}
                    testID={`${testID}-steps`}
                >
                    {Array.from({ length: dot.of }, (_, i) => (
                        <View
                            key={i}
                            testID={i < dot.at ? `${testID}-on` : `${testID}-off`}
                            style={[styles.dot, { borderColor: ink }, i < dot.at && { backgroundColor: ink }]}
                        />
                    ))}
                </View>
            ) : <View style={styles.dots} />}
            {/* The same width as ‹'s side, so the dots sit in the middle of the screen. */}
            <View style={styles.side} />
        </View>
    );
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, minHeight: 48 },
    side: { width: 48 },
    // A 48 dp target, as every button on these steps.
    back: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
    backDisabled: { opacity: 0.4 },
    dots: { flex: 1, flexDirection: 'row', justifyContent: 'center', gap: 10 },
    dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
});
