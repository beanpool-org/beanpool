import React from 'react';
import { View, Text, Pressable, Platform, StyleSheet } from 'react-native';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { GoogleButton, AppleButton, FacebookButton } from './SsoButton';
import { DOOR_WORK_MESSAGES, type DoorWorkState } from '../utils/door-work';
import type { SsoProvider } from '../utils/sso-providers';

/**
 * The global community's door on a node with the 12-words door (two-doors design §2.6): two ways in, side by side,
 * each full width, stacked, words first. Neither is the lesser one (Marty: "we dont want to insist that people must
 * have a google or facebook or apple account"): each gets its own heading, its own button and its one honest line.
 * At 320dp with 1.3x text every line wraps; nothing is cut.
 */

export const DOOR_CHOICE_TEXT = {
    words: 'Create an account with 12 secret words',
    wordsLine: 'No Google, Apple or Facebook needed. Your 12 words are the only way back in.',
    signInHeading: 'Or sign in',
    signInLine: 'Also a way back if you lose your phone.',
} as const;

export function DoorChoices({
    onWords,
    onSignIn,
    disabled = false,
    busy = null,
    wordsProblem = null,
    signInNote,
    colors = lightColors,
}: {
    onWords: () => void;
    onSignIn: (provider: SsoProvider) => void;
    disabled?: boolean;
    /** From level 3: "Lots of people are joining right now…", with this phone's estimate (utils/door-work.ts). */
    busy?: string | null;
    /** The 12-words way can't finish on this phone right now (the solver can't run): said under its button. */
    wordsProblem?: string | null;
    /** What a sign-in also does here, said once under the buttons (where the copy goes, and what is never seen). */
    signInNote?: string;
    colors?: AppColors;
}): React.JSX.Element {
    const s = styles(colors);
    return (
        <View>
            <View style={s.block}>
                <Pressable
                    style={[s.wordsBtn, disabled && s.disabled]}
                    onPress={onWords}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={DOOR_CHOICE_TEXT.words}
                    accessibilityHint={DOOR_CHOICE_TEXT.wordsLine}
                >
                    <Text style={s.wordsIcon} accessible={false}>🔑</Text>
                    <Text style={s.wordsBtnText}>{DOOR_CHOICE_TEXT.words}</Text>
                </Pressable>
                <Text style={s.line}>{DOOR_CHOICE_TEXT.wordsLine}</Text>
                {busy ? <Text style={s.busy} accessibilityLiveRegion="polite">{busy}</Text> : null}
                {wordsProblem ? <Text style={s.problem} accessibilityLiveRegion="polite">{wordsProblem}</Text> : null}
            </View>

            <View style={[s.block, s.signInBlock]}>
                <Text style={s.heading} accessibilityRole="header">{DOOR_CHOICE_TEXT.signInHeading}</Text>
                {Platform.OS === 'ios' && (
                    <AppleButton title="Continue with Apple" onPress={() => onSignIn('apple')} disabled={disabled} style={s.sso} />
                )}
                <GoogleButton title="Continue with Google" onPress={() => onSignIn('google')} disabled={disabled} style={s.sso} />
                <FacebookButton title="Continue with Facebook" onPress={() => onSignIn('facebook')} disabled={disabled} style={s.sso} />
                <Text style={s.line}>{DOOR_CHOICE_TEXT.signInLine}</Text>
                {signInNote ? <Text style={s.small}>{signInNote}</Text> : null}
            </View>
        </View>
    );
}

/**
 * "Setting up your account…" with the 8-step bar: shown only when the member tapped Join before the work was done
 * (at ordinary levels it is done while they type their name, design §3.4).
 */
export function DoorWorkProgress({ state, colors = lightColors }: { state: DoorWorkState | null; colors?: AppColors }): React.JSX.Element {
    const s = styles(colors);
    const parts = state?.parts ?? 8;
    const done = state?.phase === 'ready' ? parts : state?.partsDone ?? 0;
    return (
        <View style={s.progress} accessibilityLiveRegion="polite">
            <Text style={s.progressText}>{DOOR_WORK_MESSAGES.settingUp}</Text>
            <View
                style={s.bar}
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={DOOR_WORK_MESSAGES.settingUp}
                accessibilityValue={{ min: 0, max: parts, now: done }}
            >
                {Array.from({ length: parts }, (_, i) => (
                    <View key={i} style={[s.step, i < done && s.stepDone, i === parts - 1 && { marginRight: 0 }]} />
                ))}
            </View>
        </View>
    );
}

/**
 * Safety Backup for a member who joined with 12 words (design §2.5), in this order: what the words are, then the
 * existing tickbox and the words, then one secondary action. Nothing here is a gate.
 */
export const WORDS_BACKUP_TEXT = {
    are: 'These 12 words ARE your account.',
    nobody: 'Nobody can reset them: not us, not this community.',
    gone: 'If you lose them and this phone, the account is gone for good.',
    addSignIn: 'Add a sign-in as a second way back',
} as const;

export function WordsBackupNote({ colors = lightColors }: { colors?: AppColors }): React.JSX.Element {
    const s = styles(colors);
    return (
        <View style={s.backup} accessible accessibilityLabel={`${WORDS_BACKUP_TEXT.are} ${WORDS_BACKUP_TEXT.nobody} ${WORDS_BACKUP_TEXT.gone}`}>
            <Text style={s.backupTitle}>🔑 {WORDS_BACKUP_TEXT.are}</Text>
            <Text style={s.backupBody}>{WORDS_BACKUP_TEXT.nobody} {WORDS_BACKUP_TEXT.gone}</Text>
        </View>
    );
}

const cache = new WeakMap<AppColors, ReturnType<typeof make>>();
function styles(colors: AppColors) {
    let s = cache.get(colors);
    if (!s) {
        s = make(colors);
        cache.set(colors, s);
    }
    return s;
}

function make(colors: AppColors) {
    return StyleSheet.create({
        block: { marginBottom: 8 },
        signInBlock: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border.default },
        heading: { fontSize: 16, fontWeight: '700', color: colors.text.heading, marginBottom: 10 },
        wordsBtn: {
            minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            backgroundColor: colors.brand.primary, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12,
        },
        wordsIcon: { fontSize: 18, marginRight: 10 },
        wordsBtnText: { flexShrink: 1, color: colors.text.inverse, fontSize: 16, fontWeight: '700', textAlign: 'center' },
        disabled: { opacity: 0.5 },
        line: { fontSize: 13, color: colors.text.secondary, lineHeight: 19, marginTop: 8 },
        small: { fontSize: 12, color: colors.text.secondary, lineHeight: 17, marginTop: 6 },
        busy: { fontSize: 13, color: colors.feedback.warning.fg, lineHeight: 19, marginTop: 8 },
        problem: { fontSize: 13, color: colors.feedback.danger.fg, lineHeight: 19, marginTop: 8 },
        sso: { marginBottom: 10, width: '100%' },
        progress: { alignItems: 'stretch', marginVertical: 12 },
        progressText: { fontSize: 14, color: colors.text.secondary, textAlign: 'center', marginBottom: 10 },
        bar: { flexDirection: 'row', height: 8 },
        step: { flex: 1, height: 8, borderRadius: 4, marginRight: 4, backgroundColor: colors.border.strong },
        stepDone: { backgroundColor: colors.brand.primary },
        backup: {
            backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border, borderWidth: 1,
            borderRadius: 12, padding: 14, marginBottom: 16,
        },
        backupTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        backupBody: { fontSize: 14, color: colors.text.body, lineHeight: 20 },
    });
}
