/**
 * "Credit risk: low ›" with its reasons under it (DESIGN-credit-list-fable.md §3.3, §3.4), for the sheet and the profile
 * card. The word and its shape (○ ✓ ! ✕, never colour alone) are core's; each reason is core's `riskReasonSentence` over the
 * node's figures, drawn through {@link riskReasonLines}: never composed here from a reason's values. A reason that wraps
 * is never cut with "…".
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t, type RiskLevel } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { marked, riskReasonLines, type CreditRiskAnswer } from '../utils/credit-view';

/** The level's ink from the central tokens: success, caution, danger, and plain for "not known yet". */
export function useRiskInk() {
    return useStyles(({ colors }) => ({
        not_known: colors.text.secondary,
        low: colors.feedback.success.fg,
        medium: colors.feedback.warning.fg,
        high: colors.feedback.danger.fg,
    } as Record<RiskLevel, string>));
}

export function RiskLine({ risk, word, shape, testID }: { risk: CreditRiskAnswer; word: string; shape: string; testID?: string }) {
    const [open, setOpen] = useState(false);
    const ink = useRiskInk();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        head: { minHeight: 48, justifyContent: 'center', paddingVertical: 4 },
        word: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
        reason: { fontSize: 13, lineHeight: 19, color: colors.text.body, marginBottom: 4 },
        reasons: { paddingBottom: 6 },
    }));
    const lines = riskReasonLines(risk);
    return (
        <View testID={testID}>
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={word}
                accessibilityHint={open ? t('Hide why') : t('Show why')}
                onPress={() => setOpen((o) => !o)}
                style={styles.head}
                disabled={lines.length === 0}
            >
                <Text style={[styles.word, { color: ink[risk.level] }]} maxFontSizeMultiplier={1.3}>{marked(shape, word) + (lines.length ? (open ? ' ⌃' : ' ›') : '')}</Text>
            </Pressable>
            {open && (
                <View style={styles.reasons}>
                    {lines.map((line, i) => <Text key={i} style={styles.reason} maxFontSizeMultiplier={1.3}>{line}</Text>)}
                </View>
            )}
        </View>
    );
}
