/**
 * "Check your 12 words" — owners only (sealed-keys.md §7, slice 7). Logic: utils/owner-words.ts.
 *
 * The owner types their 12 words; the phone derives the key and compares it with this account, all on the device.
 * The words are held only in this screen's reducer state and cleared the moment the check answers, when the app goes
 * to the background, and when the screen closes. They are never sent and never stored: the input turns off
 * autocorrect, suggestions and autofill so the keyboard does not learn them either.
 *
 * On a match the node is told the fact and the date, signed. On a miss: "These aren't the words for this account."
 * No hint which word. Nothing is blocked either way, and Back is always there.
 *
 * On a phone with no copy of the words, a match also offers "Save them on this phone": the add form's own save
 * (identity.ts addMnemonicToIdentity), which checks them again with the same check. Until the member saves, types
 * again or leaves, the words that matched are held in the reducer (out of the box), and cleared with everything else.
 *
 * Keyboard: the root KeyboardProvider only (no nested provider); same shape as the "Suggest a change" screen, which was
 * measured at 320dp + 1.3×.
 */
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, AppState, Platform } from 'react-native';
import { KeyboardAwareScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { hasMnemonic } from '../utils/identity';
import {
    OWNER_WORDS_COPY as COPY, OWNER_WORDS_INITIAL, checkMyWords, forgetOwnerWordsStatus, ownerWordsFindThem,
    ownerWordsReducer, saveCheckedWords, sendOwnerWordsAttestation, shouldOfferSaveWords, typedWordCount,
} from '../utils/owner-words';
import { ownerWordsStyleSpec } from '../utils/owner-words-style';

export { ErrorBoundary };

export default function OwnerWordsCheckScreen() {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const styles = useStyles(({ colors }) => StyleSheet.create(ownerWordsStyleSpec(colors)));
    const { identity, setIdentity } = useIdentity();
    const [state, dispatch] = useReducer(ownerWordsReducer, OWNER_WORDS_INITIAL);
    const [footerHeight, setFooterHeight] = useState(0);
    const busyRef = useRef(false);
    const savingRef = useRef(false);

    // Clear the words when the app leaves the foreground (the app switcher takes a picture of the screen),
    // and when this screen closes.
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next !== 'active') dispatch({ type: 'clear' });
        });
        return () => { sub.remove(); dispatch({ type: 'clear' }); };
    }, []);

    const count = typedWordCount(state.typed);

    const handleCheck = async () => {
        if (busyRef.current || !identity) return;
        busyRef.current = true;
        dispatch({ type: 'checking' });
        const typed = state.typed;
        const result = await checkMyWords(typed, identity);
        dispatch({ type: 'answered', result, countSeen: typedWordCount(typed), offerSave: shouldOfferSaveWords(identity) });
        busyRef.current = false;
        if (result.matches) {
            const url = await getAnchorUrl();
            const at = url ? await sendOwnerWordsAttestation(url, identity) : null;
            forgetOwnerWordsStatus();
            dispatch({ type: 'recorded', at });
        }
    };

    // "Save them on this phone": the add form's save, so it checks them again and never replaces words.
    const handleSave = async () => {
        const words = state.unsaved;
        if (!words || savingRef.current) return;
        savingRef.current = true;
        dispatch({ type: 'saving' });
        let ok = false;
        try {
            const result = await saveCheckedWords(words);
            if (result.ok) {
                setIdentity(result.identity);
                ok = true;
            }
        } catch { /* ok stays false: the failure line says where to add them instead */ }
        dispatch({ type: 'saveAnswered', ok });
        savingRef.current = false;
    };

    const matchText = state.record === 'saved' ? COPY.matchSaved : state.record === 'failed' ? COPY.matchNotSaved : COPY.match;
    const saveText = state.save === 'saved' ? COPY.saved : state.save === 'failed' ? COPY.saveFailed : COPY.saveOffer;

    return (
        <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.heading} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={2}>{COPY.title}</Text>
            </View>

            <View style={{ flex: 1 }}>
                <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" bottomOffset={footerHeight + 16}>
                    <Text style={styles.body}>{COPY.why}</Text>
                    <Text style={styles.label}>YOUR 12 WORDS, IN ORDER</Text>
                    <TextInput
                        accessibilityLabel="Your 12 words, in order, with spaces between them"
                        style={styles.input}
                        value={state.typed}
                        onChangeText={(text) => dispatch({ type: 'typed', text })}
                        placeholder="word word word …"
                        placeholderTextColor={colors.text.muted}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                        autoComplete="off"
                        importantForAutofill="no"
                        textContentType="none"
                        // Android keyboards learn words from ordinary text fields; this one they must not.
                        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
                        editable={!state.busy}
                    />
                    <Text style={styles.hint}>{count} of 12 words · {COPY.stays}</Text>

                    {state.outcome === 'match' ? (
                        <View style={styles.matchBox} accessibilityLiveRegion="polite">
                            <Text style={styles.matchText}>{state.record === 'sending' ? COPY.match : matchText}</Text>
                        </View>
                    ) : null}
                    {state.outcome === 'match' && state.save !== 'none' ? (
                        <View style={styles.saveBox} accessibilityLiveRegion="polite">
                            <Text style={styles.saveText}>{saveText}</Text>
                            {state.save === 'offered' || state.save === 'saving' ? (
                                <Pressable
                                    style={[styles.checkBtn, state.save === 'saving' && styles.checkBtnDisabled]}
                                    onPress={handleSave}
                                    disabled={state.save === 'saving'}
                                    accessibilityRole="button"
                                    accessibilityState={{ busy: state.save === 'saving', disabled: state.save === 'saving' }}
                                >
                                    {state.save === 'saving'
                                        ? <ActivityIndicator color={colors.text.inverse} accessibilityLabel={COPY.saving} />
                                        : <Text style={styles.checkBtnText}>{COPY.saveButton}</Text>}
                                </Pressable>
                            ) : null}
                        </View>
                    ) : null}
                    {state.outcome === 'mismatch' ? (
                        <View style={styles.mismatchBox} accessibilityLiveRegion="polite">
                            <Text style={styles.mismatchText}>{COPY.mismatch}</Text>
                        </View>
                    ) : null}
                    {state.outcome === 'count' ? (
                        <View style={styles.mismatchBox} accessibilityLiveRegion="polite">
                            <Text style={styles.mismatchText}>{COPY.count(state.countSeen)}</Text>
                        </View>
                    ) : null}

                    <Text style={styles.hint}>{ownerWordsFindThem(hasMnemonic(identity))}</Text>
                </KeyboardAwareScrollView>

                <KeyboardStickyView onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}>
                    <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                        {state.outcome === 'match' ? (
                            <Pressable style={styles.checkBtn} onPress={() => router.back()} accessibilityRole="button">
                                <Text style={styles.checkBtnText}>Done</Text>
                            </Pressable>
                        ) : (
                            <Pressable
                                style={[styles.checkBtn, (state.busy || count === 0) && styles.checkBtnDisabled]}
                                onPress={handleCheck}
                                disabled={state.busy || count === 0}
                                accessibilityRole="button"
                                accessibilityState={{ busy: state.busy, disabled: state.busy || count === 0 }}
                            >
                                {state.busy
                                    ? <ActivityIndicator color={colors.text.inverse} />
                                    : <Text style={styles.checkBtnText}>Check my words</Text>}
                            </Pressable>
                        )}
                    </View>
                </KeyboardStickyView>
            </View>
        </SafeAreaView>
    );
}
