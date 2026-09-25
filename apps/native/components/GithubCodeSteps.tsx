/**
 * What to do on GitHub, first thing in the code panel (utils/github-code-copy.ts says why each line is there):
 * the Account Protection sheet and the GitHub recovery screen both draw it above the code.
 *
 * Nothing is fixed-size: at 320dp and 1.3x font the box grows and every line wraps.
 */
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { colors as defaultColors, type AppColors } from '../constants/colors';
import { GITHUB_CODE_STEPS, githubComeBackStep } from '../utils/github-code-copy';

export function GithubCodeSteps({
    colors = defaultColors,
}: {
    /** The screen's theme, where it has one (welcome). */
    colors?: AppColors;
}): React.JSX.Element {
    const tone = colors.feedback.info;
    return (
        <View style={[githubCodeStepsStyles.box, { backgroundColor: tone.bg, borderColor: tone.border }]}>
            <Text style={[githubCodeStepsStyles.step, { color: colors.text.heading }]}>1. {GITHUB_CODE_STEPS.paste}</Text>
            <Text style={[githubCodeStepsStyles.why, { color: colors.text.body }]}>{GITHUB_CODE_STEPS.pasteWhy}</Text>
            <Text style={[githubCodeStepsStyles.step, githubCodeStepsStyles.second, { color: colors.text.heading }]}>
                2. {githubComeBackStep(Platform.OS)}
            </Text>
        </View>
    );
}

export const githubCodeStepsStyles = StyleSheet.create({
    box: { alignSelf: 'stretch', borderWidth: 2, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 16 },
    step: { fontSize: 16, lineHeight: 22, fontWeight: '700', textAlign: 'left' },
    why: { fontSize: 14, lineHeight: 20, marginTop: 4, textAlign: 'left' },
    second: { marginTop: 12 },
});
