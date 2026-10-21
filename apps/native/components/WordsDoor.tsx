import React from 'react';
import { View, Text, Pressable, Platform, StyleSheet } from 'react-native';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { GoogleButton, AppleButton, FacebookButton } from './SsoButton';
import { DOOR_WORK_MESSAGES, type DoorWorkState } from '../utils/door-work';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';
import { t, word } from '@beanpool/core';

/**
 * The global community's door on a node with the 12-words door (two-doors design §2.6): two ways in, side by side,
 * each full width, stacked, words first. Neither is the lesser one (Marty: "we dont want to insist that people must
 * have a google or facebook or apple account"): each gets its own heading, its own button and its one honest line.
 * At 320dp with 1.3x text every line wraps; nothing is cut.
 */

export const DOOR_CHOICE_TEXT = {
    words: word('Create an account with 12 secret words'),
    wordsLine: word('No Google, Apple or Facebook needed. Your 12 words are the only way back in.'),
    signInHeading: word('Or sign in'),
    signInLine: word('Also a way back if you lose your phone.'),
    wordsExisting: word('Join with this account'),
    wordsLineExisting: word('Uses the key and 12 words already on this phone. No new account is made.'),
    signInHeadingExisting: word('Also add a sign-in'),
    signInLineExisting: word("A way back in if you lose this phone. It's linked to this same account."),
} as const;

export function DoorChoices({
    onWords,
    onSignIn,
    disabled = false,
    busy = null,
    wordsProblem = null,
    signInNote,
    colors = lightColors,
    account = 'new',
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
    account?: 'new' | 'existing';
}): React.JSX.Element {
    const s = styles(colors);
    const isExisting = account === 'existing';
    const wordsBtnText = isExisting ? t(DOOR_CHOICE_TEXT.wordsExisting) : t(DOOR_CHOICE_TEXT.words);
    const wordsLineText = isExisting ? t(DOOR_CHOICE_TEXT.wordsLineExisting) : t(DOOR_CHOICE_TEXT.wordsLine);
    const signInHeadingText = isExisting ? t(DOOR_CHOICE_TEXT.signInHeadingExisting) : t(DOOR_CHOICE_TEXT.signInHeading);
    const signInLineText = isExisting ? t(DOOR_CHOICE_TEXT.signInLineExisting) : t(DOOR_CHOICE_TEXT.signInLine);
    return (
        <View>
            <View style={s.block}>
                <Pressable
                    style={[s.wordsBtn, disabled && s.disabled]}
                    onPress={onWords}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={wordsBtnText}
                    accessibilityHint={wordsLineText}
                >
                    <Text style={s.wordsIcon} accessible={false}>🔑</Text>
                    <Text style={s.wordsBtnText}>{wordsBtnText}</Text>
                </Pressable>
                <Text style={s.line}>{wordsLineText}</Text>
                {busy ? <Text style={s.busy} accessibilityLiveRegion="polite">{busy}</Text> : null}
                {wordsProblem ? <Text style={s.problem} accessibilityLiveRegion="polite">{wordsProblem}</Text> : null}
            </View>

            <View style={[s.block, s.signInBlock]}>
                <Text style={s.heading} accessibilityRole="header">{signInHeadingText}</Text>
                {Platform.OS === 'ios' && (
                    <AppleButton title={t('Continue with {provider}', { provider: SSO_PROVIDER_NAMES.apple })} onPress={() => onSignIn('apple')} disabled={disabled} style={s.sso} />
                )}
                <GoogleButton title={t('Continue with {provider}', { provider: SSO_PROVIDER_NAMES.google })} onPress={() => onSignIn('google')} disabled={disabled} style={s.sso} />
                <FacebookButton title={t('Continue with {provider}', { provider: SSO_PROVIDER_NAMES.facebook })} onPress={() => onSignIn('facebook')} disabled={disabled} style={s.sso} />
                <Text style={s.line}>{signInLineText}</Text>
                {signInNote ? <Text style={s.small}>{signInNote}</Text> : null}
            </View>
        </View>
    );
}

/**
 * door-work.ts's "Setting up your account…" (it solves the join's work and stays off the words layer), translated here
 * when it reads exactly as that file writes it.
 */
export function settingUpWords(): string {
    return DOOR_WORK_MESSAGES.settingUp === 'Setting up your account…' ? t('Setting up your account…') : DOOR_WORK_MESSAGES.settingUp;
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
            <Text style={s.progressText}>{settingUpWords()}</Text>
            <View
                style={s.bar}
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={settingUpWords()}
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
 * existing tickbox and the words, then one secondary action. Nothing here is a gate. Whole sentences: the note's body
 * and what TalkBack reads for it are one string each.
 */
export const WORDS_BACKUP_TEXT = {
    title: word('🔑 These 12 words ARE your account.'),
    body: word('Nobody can reset them: not us, not this community. If you lose them and this phone, the account is gone for good.'),
    /** The note as TalkBack reads it: the title, without the key, and the body. */
    label: word('These 12 words ARE your account. Nobody can reset them: not us, not this community. If you lose them and this phone, the account is gone for good.'),
    addSignIn: word('Add a sign-in as a second way back'),
} as const;

export function WordsBackupNote({ colors = lightColors }: { colors?: AppColors }): React.JSX.Element {
    const s = styles(colors);
    return (
        <View style={s.backup} accessible accessibilityLabel={t(WORDS_BACKUP_TEXT.label)}>
            <Text style={s.backupTitle}>{t(WORDS_BACKUP_TEXT.title)}</Text>
            <Text style={s.backupBody}>{t(WORDS_BACKUP_TEXT.body)}</Text>
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
            backgroundColor: colors.brand.fill, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12,
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
        stepDone: { backgroundColor: colors.brand.fill },
        backup: {
            backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border, borderWidth: 1,
            borderRadius: 12, padding: 14, marginBottom: 16,
        },
        backupTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        backupBody: { fontSize: 14, color: colors.text.body, lineHeight: 20 },
    });
}
