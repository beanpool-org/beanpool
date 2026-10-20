/**
 * The report box for the event screen and an enterprise or project: the shared reasons as chips (utils/reportReasons.ts,
 * the same list as the post screen and the Pulse card), the line that says what Child safety is for, and a few
 * optional words. "Child safety" goes to the server as picked, so the owners and admins are told at once.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { useTheme } from '../app/ThemeContext';
import { hapticTick } from '../utils/haptics';
import { t } from '@beanpool/core';
import { Sentence } from './Sentence';
import { CHILD_SAFETY_HINT, CHILD_SAFETY_REASON, REPORT_REASONS, reportReasonWithWords } from '../utils/reportReasons';

/** Marked in utils/reportReasons.ts, translated here where they are shown (each reason still SENT as written). */
const LINES = { childSafety: CHILD_SAFETY_REASON, childSafetyHint: CHILD_SAFETY_HINT };

export function ReportReasonBox({ onSubmit, onCancel }: {
    /**
     * Sends the report with the reason as it goes to the server. The caller says why a send failed and then throws, so
     * the box keeps the member's choice and words for another try (review of #1912, finding 3: a weak connection wiped them).
     */
    onSubmit: (reason: string) => Promise<void>;
    onCancel?: () => void;
}) {
    const { colors } = useTheme();
    const [reason, setReason] = useState('');
    const [words, setWords] = useState('');
    const [sending, setSending] = useState(false);

    const submit = async () => {
        if (!reason || sending) return;
        setSending(true);
        try {
            await onSubmit(reportReasonWithWords(reason, words));
            setReason('');
            setWords('');
        } catch {
            // The caller has said why; the choice and the words stay.
        } finally {
            setSending(false);
        }
    };

    return (
        <View style={{ marginTop: 12, backgroundColor: colors.feedback.danger.bg, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.danger.border }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: colors.feedback.danger.fg, marginBottom: 8, letterSpacing: 0.5 }}>{t('WHY ARE YOU REPORTING IT?')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                {REPORT_REASONS.map((r, i) => {
                    const isSelected = reason === r;
                    return (
                        <Pressable
                            key={r}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isSelected }}
                            style={{
                                minHeight: 40,
                                justifyContent: 'center',
                                paddingHorizontal: 14,
                                paddingVertical: 8,
                                borderRadius: 20,
                                backgroundColor: isSelected ? colors.feedback.danger.solid : colors.surface.card,
                                borderWidth: 1,
                                borderColor: isSelected ? colors.feedback.danger.solid : colors.border.default,
                                maxWidth: '100%',
                            }}
                            onPress={() => { setReason(r); hapticTick(); }}
                        >
                            <Text style={{ fontSize: 13, fontWeight: '700', color: isSelected ? colors.text.inverse : colors.text.body }}>
                                {isSelected ? t('✓ {reason}', { reason: t(REPORT_REASONS[i]) }) : t(REPORT_REASONS[i])}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
            <Text style={{ fontSize: 13, color: colors.text.body, marginBottom: 12 }}>
                <Sentence text={t('{reason}: {hint}', { hint: t(LINES.childSafetyHint) })} parts={{ reason: <Text style={{ fontWeight: '700' }}>{t(LINES.childSafety)}</Text> }} />
            </Text>
            <TextInput
                accessibilityLabel={t('Add a few words (optional)')}
                style={{ backgroundColor: colors.surface.card, minHeight: 48, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: colors.border.default, marginBottom: 10, color: colors.text.body }}
                placeholder={t('Add a few words (optional)')}
                placeholderTextColor={colors.text.muted}
                value={words}
                onChangeText={setWords}
                multiline
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {onCancel && (
                    <Pressable
                        accessibilityRole="button"
                        onPress={onCancel}
                        style={{ flexGrow: 1, minHeight: 48, borderRadius: 8, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card }}
                    >
                        <Text style={{ color: colors.text.body, fontWeight: '700' }}>{t('Cancel')}</Text>
                    </Pressable>
                )}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={sending ? t('Submitting report...') : t('Submit report')}
                    accessibilityState={{ disabled: !reason || sending, busy: sending }}
                    disabled={!reason || sending}
                    onPress={submit}
                    style={{ flexGrow: 1, minHeight: 48, borderRadius: 8, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, backgroundColor: reason ? colors.feedback.danger.solid : colors.border.default }}
                >
                    {sending
                        ? <ActivityIndicator size="small" color={colors.text.inverse} />
                        : <Text style={{ color: reason ? colors.text.inverse : colors.text.muted, fontWeight: '700' }}>{t('Submit report')}</Text>}
                </Pressable>
            </View>
        </View>
    );
}
