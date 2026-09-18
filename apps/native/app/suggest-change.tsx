import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Platform } from 'react-native';
import { KeyboardAwareScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import {
    FEEDBACK_KINDS, FEEDBACK_NOTICE, FEEDBACK_THANKS, FEEDBACK_TEXT_MAX, FEEDBACK_COMMUNITY_MAX,
    feedbackCharCount, feedbackTextProblem, submitFeedback, type FeedbackKind,
} from '@beanpool/core';
import appConfig from '../app.json';
import { deviceLang } from '../utils/feedback-context';
import { useTheme, useStyles } from './ThemeContext';

export { ErrorBoundary };

// "Suggest a change to BeanPool" — goes to the PROJECT (beanpool.org), never to this member's node.
// The community field starts empty on purpose: the member decides whether to say where they are.
// Keyboard: the root KeyboardProvider only (no nested provider); the scroll view keeps the focused
// field above the keyboard and the footer, which rides the keyboard in a KeyboardStickyView — the
// same shape as treasury-post.tsx, measured there at 320dp + 1.3x. Success and failure are shown
// inline, not in an Alert, so nothing opens over a raised keyboard.
export default function SuggestChangeScreen() {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'flex-start' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        scroll: { padding: 20 },
        infoBox: { flexDirection: 'row', backgroundColor: colors.brand.tint, padding: 14, borderRadius: 12, marginBottom: 22, borderWidth: 1, borderColor: colors.brand.primary },
        infoText: { flex: 1, fontSize: 14, color: colors.text.body, lineHeight: 20 },
        field: { marginBottom: 22 },
        label: { fontSize: 11, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginBottom: 8 },
        hint: { fontSize: 12, color: colors.text.secondary, marginTop: 6 },
        chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        chip: { minHeight: 48, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 24, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card },
        chipOn: { borderColor: colors.brand.primary, backgroundColor: colors.brand.tint },
        chipText: { fontSize: 15, fontWeight: '600', color: colors.text.body },
        chipTextOn: { color: colors.brand.dark },
        input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 16, fontSize: 16, color: colors.text.body },
        textarea: { minHeight: 150, paddingTop: 16, textAlignVertical: 'top' },
        counter: { fontSize: 12, color: colors.text.secondary, marginTop: 6, textAlign: 'right' },
        counterOver: { color: colors.feedback.danger.solid, fontWeight: '700' },
        error: { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12 },
        errorText: { color: colors.feedback.danger.fg, fontSize: 14, fontWeight: '600' },
        footer: { paddingHorizontal: 20, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border.default, backgroundColor: colors.surface.app },
        submitBtn: { minHeight: 52, paddingVertical: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand.primary },
        submitBtnDisabled: { opacity: 0.5 },
        submitBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: 'bold', letterSpacing: 1 },
        done: { flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center', gap: 16 },
        doneText: { fontSize: 17, color: colors.text.heading, textAlign: 'center', lineHeight: 24 },
    }));

    const [kind, setKind] = useState<FeedbackKind>('idea');
    const [text, setText] = useState('');
    const [community, setCommunity] = useState(''); // EMPTY by design — never prefilled from the node
    const [footerHeight, setFooterHeight] = useState(0);
    const [sending, setSending] = useState(false);
    const sendingRef = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    const count = feedbackCharCount(text);
    const over = count > FEEDBACK_TEXT_MAX;

    const handleSend = async () => {
        if (sendingRef.current) return;
        const problem = feedbackTextProblem(text);
        if (problem) { setError(problem); return; }
        sendingRef.current = true;
        setSending(true);
        setError(null);
        const result = await submitFeedback({
            text,
            kind,
            source: 'member-app',
            appVersion: appConfig.expo.version,
            platform: Platform.OS,
            lang: deviceLang(),
            community,
        });
        sendingRef.current = false;
        setSending(false);
        // On failure the text, kind and community all stay exactly as typed.
        if (result.ok) setSent(true);
        else setError(result.error);
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Close">
                    <MaterialCommunityIcons name="close" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1}>Suggest a change</Text>
                <View style={{ width: 48 }} />
            </View>

            {sent ? (
                <View style={[styles.done, { paddingBottom: Math.max(insets.bottom, 24) }]}>
                    <MaterialCommunityIcons name="check-circle-outline" size={56} color={colors.brand.primary} />
                    <Text style={styles.doneText}>{FEEDBACK_THANKS}</Text>
                    <Pressable style={[styles.submitBtn, { alignSelf: 'stretch' }]} onPress={() => router.back()} accessibilityRole="button">
                        <Text style={styles.submitBtnText}>DONE</Text>
                    </Pressable>
                </View>
            ) : (
                <View style={{ flex: 1 }}>
                    <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" bottomOffset={footerHeight + 16}>
                        <View style={styles.infoBox}>
                            <MaterialCommunityIcons name="information-outline" size={20} color={colors.brand.primary} style={{ marginRight: 10 }} />
                            <Text style={styles.infoText}>{FEEDBACK_NOTICE}</Text>
                        </View>

                        <View style={styles.field}>
                            <Text style={styles.label}>WHAT KIND?</Text>
                            <View style={styles.chipRow} accessibilityRole="radiogroup">
                                {FEEDBACK_KINDS.map((k) => {
                                    const on = kind === k.id;
                                    return (
                                        <Pressable
                                            key={k.id}
                                            style={[styles.chip, on && styles.chipOn]}
                                            onPress={() => setKind(k.id)}
                                            accessibilityRole="radio"
                                            accessibilityState={{ selected: on }}
                                        >
                                            <Text style={[styles.chipText, on && styles.chipTextOn]}>{k.label}</Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        </View>

                        <View style={styles.field}>
                            <Text style={styles.label}>YOUR SUGGESTION</Text>
                            <TextInput
                                accessibilityLabel="Your suggestion"
                                style={[styles.input, styles.textarea]}
                                placeholder="What would make BeanPool better for your community? Any language is fine."
                                placeholderTextColor={colors.text.muted}
                                value={text}
                                onChangeText={(v) => { setText(v); if (error) setError(null); }}
                                multiline
                            />
                            <Text style={[styles.counter, over && styles.counterOver]}>{count} / {FEEDBACK_TEXT_MAX}</Text>
                        </View>

                        <View style={styles.field}>
                            <Text style={styles.label}>YOUR COMMUNITY (OPTIONAL)</Text>
                            <TextInput
                                accessibilityLabel="Your community, optional"
                                style={styles.input}
                                placeholder="Leave blank if you'd rather not say"
                                placeholderTextColor={colors.text.muted}
                                value={community}
                                onChangeText={setCommunity}
                                maxLength={FEEDBACK_COMMUNITY_MAX}
                            />
                            <Text style={styles.hint}>Helps us see how many places ask for the same thing.</Text>
                        </View>
                    </KeyboardAwareScrollView>

                    <KeyboardStickyView onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}>
                        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                            {error ? (
                                <View style={styles.error} accessibilityLiveRegion="polite">
                                    <Text style={styles.errorText}>{error}</Text>
                                </View>
                            ) : null}
                            <Pressable
                                style={[styles.submitBtn, (sending || over) && styles.submitBtnDisabled]}
                                onPress={handleSend}
                                disabled={sending || over}
                                accessibilityRole="button"
                                accessibilityLabel="Send suggestion"
                            >
                                {sending ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.submitBtnText}>SEND</Text>}
                            </Pressable>
                        </View>
                    </KeyboardStickyView>
                </View>
            )}
        </SafeAreaView>
    );
}
