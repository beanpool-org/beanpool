/**
 * "Step back from being confirmed?" (scratch/fable-design/DESIGN-balance-rule-fable.md §1, §2): the one way out of the
 * rule, from Home's card and from Settings. Asks once, says what stepping back does, and tells the truth about the answer:
 * done (and whether they still owe past the ordinary line), or the node's refusal with the sheet still open. Nothing
 * typed here, so no keyboard handling in this Modal.
 */
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { KNOWN_RULE_WORDS, steppedBackLine, t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { stepBackFromConfirmed } from '../utils/known-rule';

export function StepBackSheet({ visible, onClose, onSteppedBack }: {
    visible: boolean;
    onClose: () => void;
    /** Once the member has read that it's done and closed the sheet. */
    onSteppedBack: () => void;
}) {
    const styles = useStyles(makeStyles);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    const close = () => {
        const finished = done !== null;
        setError(null);
        setDone(null);
        if (finished) onSteppedBack(); else onClose();
    };
    const stepBack = async () => {
        setBusy(true);
        setError(null);
        try {
            const answer = await stepBackFromConfirmed();
            if (answer.ok) setDone(steppedBackLine(answer.owing));
            else setError(answer.error);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={busy ? undefined : close}>
            <Pressable style={styles.scrim} onPress={busy ? undefined : close} accessibilityLabel={t('Close')} />
            <View style={styles.sheet} testID="step-back-sheet">
                <ScrollView contentContainerStyle={styles.content}>
                    {done ? (
                        <>
                            <Text style={styles.body} accessibilityLiveRegion="polite" testID="step-back-done">{done}</Text>
                            <Pressable style={styles.primary} onPress={close} accessibilityRole="button" testID="step-back-close">
                                <Text style={styles.primaryText}>{t(KNOWN_RULE_WORDS.ok)}</Text>
                            </Pressable>
                        </>
                    ) : (
                        <>
                            <Text style={styles.title} accessibilityRole="header">{t(KNOWN_RULE_WORDS.sheetTitle)}</Text>
                            <Text style={styles.body}>{t(KNOWN_RULE_WORDS.sheetBody)}</Text>
                            {error && <Text style={styles.error} accessibilityLiveRegion="polite" testID="step-back-error">{error}</Text>}
                            <Pressable
                                style={styles.primary}
                                onPress={() => { void stepBack(); }}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityState={{ busy }}
                                testID="step-back-confirm"
                            >
                                <Text style={styles.primaryText}>{busy ? t(KNOWN_RULE_WORDS.steppingBack) : t(KNOWN_RULE_WORDS.stepBack)}</Text>
                            </Pressable>
                            <Pressable style={styles.secondary} onPress={close} disabled={busy} accessibilityRole="button" testID="step-back-keep">
                                <Text style={styles.secondaryText}>{t(KNOWN_RULE_WORDS.keepIt)}</Text>
                            </Pressable>
                        </>
                    )}
                </ScrollView>
            </View>
        </Modal>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    scrim: { flex: 1, backgroundColor: colors.overlay.imageViewerCloseBg },
    sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%', paddingBottom: 24 },
    content: { padding: 20, gap: 12 },
    title: { fontSize: 18, lineHeight: 24, fontWeight: '800', color: colors.text.heading },
    body: { fontSize: 15, lineHeight: 22, color: colors.text.body },
    error: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: colors.feedback.danger.fg },
    primary: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: colors.brand.fill },
    primaryText: { fontSize: 15, fontWeight: '800', textAlign: 'center', color: colors.text.inverse },
    secondary: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
    secondaryText: { fontSize: 15, fontWeight: '700', textAlign: 'center', color: colors.text.link },
});
