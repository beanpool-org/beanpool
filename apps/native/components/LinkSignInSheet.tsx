import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, ScrollView } from 'react-native';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { GoogleButton, AppleButton, FacebookButton } from './SsoButton';
import { SsoSignInError, returnToApp } from '../utils/sso-signin';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';
import { authenticateUser } from '../utils/LocalAuth';
import { doorCopiesAt, linkedAtVault, linkSignIn, LINK_MESSAGES, type LinkAnswer, type LinkRefusal } from '../utils/join-link';
import { finishOneWayBack } from '../utils/one-way-back';
import { signInCopiesAt, type SignInCopies } from '../utils/vault-config';
import type { BeanPoolIdentity } from '../utils/identity';
import { welcomeLineWords } from './welcome/welcome-lines';
import { t, word, type WordKey } from '@beanpool/core';

/**
 * "Add a sign-in as a second way back" (two-doors design §2.5), for a member who joined the global community with 12
 * words: Safety Backup, Settings and the "one way back" card open it. One sign-in, two jobs (utils/join-link.ts): it
 * becomes a way back, and the new-account limits become the usual ones. Every refusal is a sentence; a refusal
 * changes nothing. A sheet the member closes before the provider is done links nothing. Where the door's community keeps
 * no copies (its rule, vault rethink VR2), only the second job is done, and the sheet says so. The card opens it for
 * another community's open door too, joined the same way: there the sentences that name the community say its name
 * (`community`).
 *
 * No KeyboardProvider here (memory `keyboard-avoidance-pattern`): there is no text field.
 *
 * utils/join-link.ts signs the link and stays off the words layer (core recovery-path-files' rule), so its sentences are
 * translated here: a refusal by its exact English (LINK_REFUSAL_WORDS), the added notice as linkedNotice writes it
 * (utils/__tests__/key-components-words-render.test.ts holds both to join-link.ts). A refusal with a time in it is shown
 * as it came. An error a sign-in throws is read through welcome's table, as the enrol sheet reads it (welcome-lines.ts):
 * the sign-in files' own sentences in the member's language, a provider's own words as they came.
 */

/** join-link.ts LINK_MESSAGES, with `{when}` as `sentence()` writes it when there is no time: "later". */
const LINK_REFUSAL_WORDS: Readonly<Record<LinkRefusal, WordKey>> = {
    already_joined: word("This {provider} account is already the sign-in of another BeanPool account in the global community, so it can't be added to yours. Nothing was changed. You can try a different sign-in."),
    removed: word("The BeanPool account this {provider} account joined with was removed from the global community, so it can't be added to yours. Nothing was changed."),
    not_words_member: word('Your account joined the global community another way, so there is no sign-in to add here. Nothing was changed.'),
    already_linked: word('Your account in the global community already has a sign-in. Nothing was changed.'),
    not_a_member: word("Your account isn't active in the global community right now (it may be suspended), so a sign-in can't be added. Nothing was changed."),
    account_closed: word("This account's place in the global community was closed, so a sign-in can't be added to it. Nothing was changed."),
    key_invalidated: word("This phone's key was replaced by a new one, so a sign-in can't be added with it. Nothing was changed. Use the device or the 12 words that hold the new key."),
    door_closed: word("The global community isn't adding sign-ins right now. Nothing was changed. Please try again later."),
    door_key_missing: word("The global community can't check sign-ins right now, so nothing was added. Please try again later."),
    rate_limited: word('There were too many tries in a short time, so nothing was added. Please try again later.'),
    sign_in_again: word('Your sign-in could not be used, so nothing was added. Please sign in again.'),
    sign_in_unavailable: word('{provider} sign-in could not be checked right now, so nothing was added. Please try again in a minute.'),
    unsupported: word("The global community doesn't take {provider} sign-in. You can try a different one."),
    try_again: word('Your sign-in could not be added, and nothing was changed. Please try again in a minute.'),
    unreachable: word("Can't reach the global community right now, so nothing was added. Check your connection and try again."),
};

/** A refusal in the member's language when it reads exactly as join-link.ts wrote it; one with a time in it, as it came. */
export function linkRefusalWords(answer: Extract<LinkAnswer, { kind: 'refused' }>, provider: SsoProvider): string {
    const name = SSO_PROVIDER_NAMES[provider];
    const english = LINK_MESSAGES[answer.reason].replace('{provider}', name).replace('{when}', 'later');
    return answer.message === english ? t(LINK_REFUSAL_WORDS[answer.reason], { provider: name }) : answer.message;
}

/** join-link.ts linkedNotice, in the member's language; `community` as linkedNotice takes it (another community's name). */
export function linkedNoticeWords(answer: Extract<LinkAnswer, { kind: 'linked' }>, community?: string): string {
    const provider = SSO_PROVIDER_NAMES[answer.provider];
    if (!answer.enrolment) {
        // The door's community keeps no copies (its rule, vault rethink VR2): none was made, by design.
        if (answer.noCopies) {
            return community
                ? t("Your {provider} sign-in is added: your account now has the usual new-account limits. {community} keeps no copies of members' accounts, so your 12 words are still your way back.", { provider, community })
                : t("Your {provider} sign-in is added: your account now has the usual new-account limits. The global community keeps no copies of members' accounts, so your 12 words are still your way back.", { provider });
        }
        return t("Your {provider} sign-in is added: your account now has the usual new-account limits. It couldn't keep a copy of your account right now, so for getting back in, your 12 words are still the way: Account Protection in Settings can link it again.", { provider });
    }
    if (linkedAtVault(answer)) {
        return t('Your {provider} sign-in is added: your account now has the usual new-account limits. If you lose this phone, sign in with {provider} to get back in.', { provider });
    }
    return community
        ? t('Your {provider} sign-in is added: your account now has the usual new-account limits. If you lose this phone, sign in with {provider} to get back into {community}.', { provider, community })
        : t('Your {provider} sign-in is added: your account now has the usual new-account limits. If you lose this phone, sign in with {provider} to get back into the global community.', { provider });
}

/** The line join-link.ts sends while it checks a sign-in a second way. */
function signInAgainWords(line: string): string {
    return line === 'Checking your sign-in another way…' ? t('Checking your sign-in another way…') : line;
}

export function LinkSignInSheet({
    visible,
    onClose,
    onLinked,
    identity,
    url,
    community,
    askPhoneLock = true,
    colors = lightColors,
}: {
    visible: boolean;
    onClose: () => void;
    /** Added (or the node says this account already has one): the card is done. */
    onLinked: (answer: Extract<LinkAnswer, { kind: 'linked' }> | null) => void;
    identity: BeanPoolIdentity | null;
    /** The address of the community whose door the member joined by: the global community's, unless `community` names another. */
    url: string;
    /**
     * That community's name, where it isn't the global community (a door anyone can join, joined with 12 words:
     * components/OneWayBackCard.tsx, from its record), for the sentences that name it. Absent: the global community.
     */
    community?: string;
    /** The phone's lock first (Settings); false only for a key the join has just made (Safety Backup). */
    askPhoneLock?: boolean;
    colors?: AppColors;
}): React.JSX.Element {
    const [step, setStep] = useState<'choose' | 'working' | 'saving' | 'done' | 'error'>('choose');
    const [provider, setProvider] = useState<SsoProvider | null>(null);
    const [message, setMessage] = useState('');
    const [notice, setNotice] = useState<string | null>(null);
    const [linked, setLinked] = useState<Extract<LinkAnswer, { kind: 'linked' }> | null>(null);
    /** Where a copy made at this door goes, as join-link.ts decides it: this build's place until the door's rule is read. */
    const [copiesAt, setCopiesAt] = useState<SignInCopies>(() => signInCopiesAt());
    const abortRef = useRef<AbortController | null>(null);
    const s = styles(colors);

    useEffect(() => {
        if (visible) {
            setStep('choose');
            setMessage('');
            setNotice(null);
            setLinked(null);
        }
    }, [visible]);
    // The door's rule as the door check kept it (vault rethink VR2): where its community keeps no copies, a sign-in here
    // only lifts the limits, and the sheet says so rather than promise a way back.
    useEffect(() => {
        if (!visible) return;
        let live = true;
        doorCopiesAt(url).then((at) => { if (live) setCopiesAt(at); }).catch(() => {});
        return () => { live = false; };
    }, [visible, url]);
    useEffect(() => () => abortRef.current?.abort(), []);

    const close = () => {
        abortRef.current?.abort();
        // At "✅ Sign-in added", Android's Back is the Done button's path: the screen behind learns of the sign-in, or
        // Safety Backup keeps offering it (PR #1452 review, finding 5).
        if (step === 'done' && linked) onLinked(linked);
        onClose();
    };

    async function add(chosen: SsoProvider) {
        if (!identity) return;
        setProvider(chosen);
        setStep('working');
        setMessage('');
        abortRef.current?.abort();
        const abort = new AbortController();
        abortRef.current = abort;
        try {
            const answer = await linkSignIn({
                url,
                identity,
                provider: chosen,
                phoneLock: askPhoneLock ? () => authenticateUser(t('Confirm authentication to add a sign-in to your account.')) : null,
                onSignedIn: async () => {
                    setStep('saving');
                    await returnToApp();
                },
                onSignInAgain: (line) => setNotice(signInAgainWords(line)),
                signal: abort.signal,
            });
            if (answer.kind === 'linked') {
                await finishOneWayBack(identity.publicKey, 'linked');
                setLinked(answer);
                setStep('done');
                return;
            }
            // The node says this account has a sign-in already: nothing more to add, and the card has no reason to stay.
            if (answer.reason === 'already_linked') {
                await finishOneWayBack(identity.publicKey, 'linked');
                onLinked(null);
            }
            setMessage(linkRefusalWords(answer, chosen));
            setStep('error');
        } catch (e) {
            if (e instanceof SsoSignInError && e.reason === 'cancelled') {
                setStep('choose');
                return;
            }
            setMessage((e as Error)?.message ? welcomeLineWords((e as Error).message) : t('Your sign-in could not be added, and nothing was changed. Please try again.'));
            setStep('error');
        } finally {
            setNotice(null);
        }
    }

    const name = provider ? SSO_PROVIDER_NAMES[provider] : '';
    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={step === 'saving' ? () => {} : close}>
            <View style={s.overlay}>
                <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheet}>
                    {step === 'choose' && (
                        <>
                            <Text style={s.title} accessibilityRole="header">{copiesAt === 'none' ? t('Add a sign-in') : t('Add a sign-in as a second way back')}</Text>
                            <Text style={s.body}>
                                {copiesAt !== 'none'
                                    ? t('Sign in once with an account you already have. If you lose this phone, it gets you back into your account, and it lifts the limits on new 12-words accounts. BeanPool never sees your password and never posts anything for you.')
                                    : community
                                        ? t("Sign in once with an account you already have. {community} keeps no copies of members' accounts, so a sign-in only lifts the limits on new 12-words accounts: your 12 words are your way back. BeanPool never sees your password and never posts anything for you.", { community })
                                        : t("Sign in once with an account you already have. The global community keeps no copies of members' accounts, so a sign-in only lifts the limits on new 12-words accounts: your 12 words are your way back. BeanPool never sees your password and never posts anything for you.")}
                            </Text>
                            {Platform.OS === 'ios' && (
                                <AppleButton title={t('Continue with {provider}', { provider: SSO_PROVIDER_NAMES.apple })} onPress={() => add('apple')} style={s.sso} />
                            )}
                            <GoogleButton title={t('Continue with {provider}', { provider: SSO_PROVIDER_NAMES.google })} onPress={() => add('google')} style={s.sso} />
                            <FacebookButton title={t('Continue with {provider}', { provider: SSO_PROVIDER_NAMES.facebook })} onPress={() => add('facebook')} style={s.sso} />
                            <TouchableOpacity style={s.secondary} onPress={close} accessibilityRole="button">
                                <Text style={s.secondaryText}>{t('Not now')}</Text>
                            </TouchableOpacity>
                        </>
                    )}
                    {(step === 'working' || step === 'saving') && (
                        <View style={s.center} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={s.busyText}>{notice ?? (step === 'saving' ? t('Adding your {provider} sign-in…', { provider: name }) : t('Connecting with {provider}…', { provider: name }))}</Text>
                            {step === 'working' && (
                                <TouchableOpacity style={[s.secondary, { alignSelf: 'stretch' }]} onPress={close} accessibilityRole="button">
                                    <Text style={s.secondaryText}>{t('Cancel')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                    {step === 'done' && linked && (
                        <>
                            <Text style={s.title} accessibilityRole="header">{t('✅ Sign-in added')}</Text>
                            <Text style={s.body}>{linkedNoticeWords(linked, community)}</Text>
                            <TouchableOpacity style={s.primary} onPress={() => { onLinked(linked); onClose(); }} accessibilityRole="button">
                                <Text style={s.primaryText}>{t('Done')}</Text>
                            </TouchableOpacity>
                        </>
                    )}
                    {step === 'error' && (
                        <>
                            <Text style={s.title} accessibilityRole="header">{t('Not added')}</Text>
                            <Text style={s.body} accessibilityRole="alert">{message}</Text>
                            <TouchableOpacity style={s.primary} onPress={() => setStep('choose')} accessibilityRole="button">
                                <Text style={s.primaryText}>{t('Try again')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={s.secondary} onPress={close} accessibilityRole="button">
                                <Text style={s.secondaryText}>{t('Close')}</Text>
                            </TouchableOpacity>
                        </>
                    )}
                </ScrollView>
            </View>
        </Modal>
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
        overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay.scrim },
        // Bounded and scrollable, so Cancel is reachable on a 320dp screen at 1.3x text (as SsoEnrolSheet).
        sheetScroll: { maxHeight: '90%', flexGrow: 0 },
        sheet: {
            backgroundColor: colors.surface.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24,
            paddingBottom: Platform.OS === 'android' ? 48 : 40,
        },
        title: { fontSize: 20, fontWeight: 'bold', color: colors.text.heading, marginBottom: 12 },
        body: { fontSize: 15, color: colors.text.body, lineHeight: 22, marginBottom: 20 },
        sso: { marginBottom: 10, width: '100%' },
        center: { alignItems: 'center', justifyContent: 'center', minHeight: 180 },
        busyText: { fontSize: 15, color: colors.text.secondary, marginTop: 14, textAlign: 'center' },
        primary: { backgroundColor: colors.brand.fill, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 8 },
        primaryText: { color: colors.text.inverse, fontSize: 16, fontWeight: 'bold' },
        secondary: { minHeight: 48, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
        secondaryText: { color: colors.text.secondary, fontSize: 16 },
    });
}
