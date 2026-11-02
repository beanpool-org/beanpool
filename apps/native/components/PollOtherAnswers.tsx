/**
 * A poll's typed answers, for its maker and the owners (apps/server engine/poll-other.ts, which decides: this only asks). On an
 * anonymous poll still open the node sends none, and the panel says when they come. Each line is the words and nothing else:
 * no name, no time, in no order of arrival. The maker can report a line to the owners; an owner can remove it.
 */

import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { pollOtherLines, t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { getPollOtherAnswers, removePollOtherAnswer, reportPollOtherAnswer, type PollOtherRead } from '../utils/db';
import { signedRequestWords } from './signed-request-lines';

export function PollOtherAnswers({ postId }: { postId: string }) {
    const styles = useStyles(makeStyles);
    const [read, setRead] = useState<PollOtherRead | null>(null);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setError(null);
        try {
            setRead(await getPollOtherAnswers(postId));
        } catch (err: any) {
            setError(err?.message ? signedRequestWords(err.message) : pollOtherLines.wordsFailed());
        }
    };
    const act = async (run: () => Promise<unknown>) => {
        setError(null);
        try {
            await run();
            await load();
        } catch (err: any) {
            setError(err?.message ? signedRequestWords(err.message) : pollOtherLines.wordsFailed());
        }
    };
    const confirmRemove = (answerId: string) => {
        Alert.alert(pollOtherLines.remove(), pollOtherLines.removeConfirm(), [
            { text: t('Cancel'), style: 'cancel' },
            { text: pollOtherLines.remove(), style: 'destructive', onPress: () => { void act(() => removePollOtherAnswer(postId, answerId)); } },
        ]);
    };

    return (
        <View style={styles.wrap} testID="poll-other-answers">
            <Pressable
                onPress={() => { if (!open) void load(); setOpen(v => !v); }}
                style={styles.toggle}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={pollOtherLines.readWords()}
            >
                <Text style={styles.toggleText}>{pollOtherLines.readWords()}</Text>
            </Pressable>
            {open && (
                <View style={styles.panel}>
                    <Text style={styles.who}>{pollOtherLines.wordsWho()}</Text>
                    {error !== null && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
                    {read?.state === 'held' && <Text style={styles.note} testID="poll-other-held">{pollOtherLines.wordsHeld()}</Text>}
                    {read?.state === 'open' && read.answers.length === 0 && <Text style={styles.note}>{pollOtherLines.wordsNone()}</Text>}
                    {read?.answers.map(answer => (
                        <View key={answer.id} style={styles.line} testID="poll-other-line">
                            <Text style={styles.words}>{answer.words}</Text>
                            {read.canRemove ? (
                                <Pressable onPress={() => confirmRemove(answer.id)} style={styles.action} accessibilityRole="button" accessibilityLabel={pollOtherLines.remove()}>
                                    <Text style={styles.remove}>{pollOtherLines.remove()}</Text>
                                </Pressable>
                            ) : answer.reported ? (
                                <Text style={styles.reported}>{pollOtherLines.reported()}</Text>
                            ) : (
                                <Pressable onPress={() => { void act(() => reportPollOtherAnswer(postId, answer.id)); }} style={styles.action} accessibilityRole="button" accessibilityLabel={pollOtherLines.report()}>
                                    <Text style={styles.report}>{pollOtherLines.report()}</Text>
                                </Pressable>
                            )}
                        </View>
                    ))}
                </View>
            )}
        </View>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        wrap: { marginTop: 8 },
        toggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
        toggleText: { fontSize: 13, fontWeight: '700', color: theme === 'dark' ? palette.violet300 : palette.violet600 },
        panel: { borderTopWidth: 1, borderTopColor: theme === 'dark' ? palette.gray700 : palette.gray300, paddingTop: 8, gap: 6 },
        who: { fontSize: 12, color: colors.text.muted },
        note: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
        error: { fontSize: 13, color: colors.feedback.danger.fg },
        line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, backgroundColor: colors.surface.app },
        words: { flexGrow: 1, flexShrink: 1, flexBasis: '60%', fontSize: 14, color: colors.text.body },
        action: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6 },
        report: { fontSize: 12, fontWeight: '700', color: colors.text.secondary },
        reported: { fontSize: 12, fontWeight: '600', color: colors.text.muted },
        remove: { fontSize: 12, fontWeight: '700', color: colors.feedback.danger.fg },
    });
