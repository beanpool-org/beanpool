import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Alert, BackHandler, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, ErrorBoundary, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme, useStyles } from './ThemeContext';
import { GoogleButton, AppleButton, FacebookButton } from '../components/SsoButton';
import { authenticateUser } from '../utils/LocalAuth';
import { GLOBAL_NODE_URL, GLOBAL_DOOR_MESSAGES, checkGlobalDoor, wordsDoorOn } from '../utils/node-profile';
import {
    MAX_JOIN_NAME, checkNameAtDoor, doorMessage, doorWaysOut, nameCheckMessage, nextStepFor, signInAtDoor, submitJoin, submitWordsJoin,
    type DoorAnswer, type DoorPhase, type DoorSignIn, type DoorWay, type JoinKey,
} from '../utils/global-join';
import { useDoorWork } from '../utils/use-door-work';
import { DOOR_WORK_MESSAGES, solutionUnlessLeft } from '../utils/door-work';
import { DoorChoices, DoorWorkProgress } from '../components/WordsDoor';
import { startOneWayBack } from '../utils/one-way-back';
import { vaultCopyKnown } from '../utils/vault';
import { ACCOUNT_DOOR_MESSAGES, accountDoorMessage, accountKeyForDoor, finishJoinFromAccount, rememberAccountClosed } from '../utils/global-join-existing';
import { HOME_REDIRECT } from '../utils/join-another-community';
import { signInCopiesAt } from '../utils/vault-config';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';

export { ErrorBoundary };

/**
 * The global community's door for an account this phone already has (utils/global-join-existing.ts): reached from
 * People → Invites as a guest of the global community, from the BeanPool sheet and from Settings → Advanced. Sign in
 * once, check the name, join, with the key on the phone; then the profile step for the global community (its photo),
 * as after any second community. Nothing on the phone changes until the global community has let the member in, and a
 * refusal leaves everything as it was.
 */
export default function JoinGlobalScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        scroll: { padding: 16 },
        card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 16 },
        title: { fontSize: 20, fontWeight: '800', color: colors.text.heading, marginBottom: 8 },
        body: { fontSize: 15, color: colors.text.body, lineHeight: 22, marginBottom: 12 },
        small: { fontSize: 13, color: colors.text.secondary, lineHeight: 19, marginBottom: 16 },
        label: { fontSize: 14, fontWeight: '700', color: colors.text.secondary, marginBottom: 6 },
        input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.app, color: colors.text.heading, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
        helper: { fontSize: 13, color: colors.text.secondary, marginTop: 6, lineHeight: 18 },
        error: { fontSize: 14, color: colors.feedback.danger.fg, marginTop: 4, marginBottom: 12, lineHeight: 20 },
        busy: { alignItems: 'center', marginVertical: 16 },
        busyText: { marginTop: 12, color: colors.text.secondary, fontSize: 14, textAlign: 'center' },
        chips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, marginBottom: 4 },
        chip: { minHeight: 40, justifyContent: 'center', backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8 },
        chipText: { color: colors.text.body, fontSize: 14, fontWeight: '600' },
        primary: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
        primaryText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
        secondaryText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        quiet: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
        quietText: { color: colors.text.secondary, fontSize: 15, fontWeight: '600', textAlign: 'center' },
        sso: { marginBottom: 10, width: '100%' },
    }));

    const [phase, setPhase] = useState<DoorPhase>('checking');
    /** What the member reads on the `unavailable`, `restore` and `closed` screens. */
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [key, setKey] = useState<JoinKey | null>(null);
    /** The sign-in the join will spend. Dropped once sent: a nonce is spent once. */
    const [signin, setSignin] = useState<DoorSignIn | null>(null);
    const [name, setName] = useState('');
    const [suggestions, setSuggestions] = useState<string[]>([]);
    /** Under the joining spinner while the door's sign-in is asked for once more (global-join.ts `submitJoin`). */
    const [notice, setNotice] = useState<string | null>(null);
    /**
     * The 12-words door (two-doors design §2): whether this door has it, the way chosen, and the work, started when the
     * door opens with the key on this phone. The same key either way: one identity per device.
     */
    const [wordsDoor, setWordsDoor] = useState(false);
    const [way, setWay] = useState<DoorWay>('sign-in');
    const doorWork = useDoorWork();
    /** Join tapped before the work was done: it finishes under "Setting up your account…", and Back still works. */
    const [workWaiting, setWorkWaiting] = useState(false);
    /** Stops the name step's check when the member leaves it. */
    const nameCheckRef = useRef<AbortController | null>(null);
    /** From the join's send until its answer: the screen is not left mid-join. */
    const joinSendingRef = useRef(false);
    /**
     * The screen has gone: a join that lands after this switches nothing and goes nowhere. The member is in, and the
     * door says so (`already_member`) the next time they come to it.
     */
    const goneRef = useRef(false);
    useEffect(() => () => { goneRef.current = true; nameCheckRef.current?.abort(); }, []);

    const ways = doorWaysOut(phase, loading);

    // Android's back button keeps to the same ways out as the screen's own.
    useFocusEffect(useCallback(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => joinSendingRef.current || !ways.back);
        return () => sub.remove();
    }, [ways.back]));

    // Arriving (or Try again): is it the global community, with its door open?
    useEffect(() => {
        if (phase !== 'checking') return;
        let cancelled = false;
        checkGlobalDoor()
            .then(check => {
                if (cancelled) return;
                if (check.ok) {
                    // Two ways in where the door has the 12-words one; the sign-in alone where it doesn't, as before.
                    const words = wordsDoorOn(check.profile.features);
                    setWordsDoor(words);
                    setPhase(words ? 'choose' : 'signIn');
                    return;
                }
                setMessage(GLOBAL_DOOR_MESSAGES[check.reason]);
                setPhase('unavailable');
            })
            .catch(() => {
                if (cancelled) return;
                setMessage(GLOBAL_DOOR_MESSAGES.unreachable);
                setPhase('unavailable');
            });
        return () => { cancelled = true; };
    }, [phase]);

    // The 12-words door's work starts as the door opens, signed by the key on this phone, so it is done by Join.
    const startWork = doorWork.start;
    useEffect(() => {
        if (phase !== 'choose') return;
        let cancelled = false;
        accountKeyForDoor().then(account => {
            if (cancelled || !account) return;
            setKey(account);
            startWork(GLOBAL_NODE_URL, account.identity, 'words');
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [phase, startWork]);

    function leave() {
        if (joinSendingRef.current) return;
        nameCheckRef.current?.abort();
        if (router.canGoBack()) router.back();
        else router.replace('/(tabs)');
    }

    /**
     * "Choose another way" (or "Use a different sign-in"): stops the name check and the wait for the 12-words work, so the
     * choices, Back and the hardware Back work at once (PR #1452 review, finding 2). The work keeps running in the hook.
     */
    function signInAgain() {
        if (joinSendingRef.current) return;
        nameCheckRef.current?.abort();
        setLoading(false);
        setWorkWaiting(false);
        setSignin(null);
        setSuggestions([]);
        setError(null);
        setPhase(wordsDoor ? 'choose' : 'signIn');
    }

    /** "Create an account with 12 secret words": the name next, while the work goes on. No sign-in, so no copy, and no lock. */
    function chooseWords() {
        setError(null);
        setSignin(null);
        setWay('words');
        if (!name.trim() && key?.identity.callsign) setName(key.identity.callsign.slice(0, MAX_JOIN_NAME));
        setPhase('name');
    }

    /** Step one: the phone's lock, then the sign-in, both for the key the phone holds. */
    async function handleSignIn(provider: SsoProvider) {
        setLoading(true);
        setError(null);
        try {
            const account = await accountKeyForDoor();
            if (!account) {
                setError(ACCOUNT_DOOR_MESSAGES.noAccount);
                return;
            }
            setKey(account);
            // The sign-in also links to this account, so the phone's lock first, as Account Protection's connect asks
            // it. A check that doesn't pass starts nothing.
            if (!(await authenticateUser('Confirm authentication to link a sign-in to your account.'))) return;
            const result = await signInAtDoor(provider, GLOBAL_NODE_URL, account.identity);
            if (result.kind === 'answered') {
                await afterAnswer(result.answer, account, name.trim() || account.identity.callsign);
                return;
            }
            setSignin(result.signin);
            setWay('sign-in');
            // Signed in: the 12-words work stops (the phone's battery); "Choose another way" starts it again.
            doorWork.stop('words');
            // From the 30th join an hour from one network the sign-in door asks for work too: asked now, while the name
            // is typed (only at a door with the 12-words door; one from before it has none to give).
            if (wordsDoor) doorWork.start(GLOBAL_NODE_URL, account.identity, 'sign-in');
            if (!name.trim() && account.identity.callsign) setName(account.identity.callsign.slice(0, MAX_JOIN_NAME));
            setPhase('name');
        } catch (e) {
            // A cancel is not an error: the member thought better of it.
            const failure = e as { reason?: string; message?: string } | null;
            setError(failure?.reason === 'cancelled' ? null : (failure?.message || 'Sign-in failed. Try again.'));
        } finally {
            setLoading(false);
        }
    }

    /** Step two: the name, checked at the door, then the join, signed by the key the phone holds. */
    async function handleJoin() {
        if (!key || !signin) { setPhase('signIn'); return; }
        const typed = name.trim().slice(0, MAX_JOIN_NAME).trim();
        if (typed.length < 2) {
            setError('Please choose a name of at least 2 characters.');
            return;
        }
        setLoading(true);
        setError(null);
        nameCheckRef.current?.abort();
        const stop = new AbortController();
        nameCheckRef.current = stop;
        try {
            const check = await checkNameAtDoor(GLOBAL_NODE_URL, typed, key, { signal: stop.signal });
            if (check.kind === 'cancelled' || stop.signal.aborted) return;
            if (check.kind !== 'free') {
                setSuggestions(check.kind === 'taken' ? check.suggestions : []);
                setError(nameCheckMessage(typed, check));
                return;
            }
            setSuggestions([]);
            joinSendingRef.current = true;
            setPhase('joining');
            const answer = await submitJoin(GLOBAL_NODE_URL, key.identity, typed, signin, { onSignInAgain: setNotice, work: doorWork.runFor('sign-in') });
            setSignin(null);
            await afterAnswer(answer, key, typed);
        } catch (e) {
            setSignin(null);
            setError((e as Error | null)?.message || 'Your join could not be completed. Please sign in and try again.');
            setPhase(wordsDoor ? 'choose' : 'signIn');
        } finally {
            joinSendingRef.current = false;
            setNotice(null);
            if (nameCheckRef.current === stop) nameCheckRef.current = null;
            setLoading(false);
        }
    }

    /**
     * The 12-words way with the key on this phone: the name, checked at the door; the work (done already at ordinary
     * levels; otherwise it finishes here, and Back still works); then the join, with no sign-in. Nothing on the phone
     * changes until the door has let the member in.
     */
    async function handleWordsJoin() {
        const typed = name.trim().slice(0, MAX_JOIN_NAME).trim();
        if (typed.length < 2) {
            setError('Please choose a name of at least 2 characters.');
            return;
        }
        setLoading(true);
        setError(null);
        nameCheckRef.current?.abort();
        const stop = new AbortController();
        nameCheckRef.current = stop;
        try {
            const account = await accountKeyForDoor();
            if (!account) {
                setError(ACCOUNT_DOOR_MESSAGES.noAccount);
                return;
            }
            setKey(account);
            const run = doorWork.start(GLOBAL_NODE_URL, account.identity, 'words');
            const check = await checkNameAtDoor(GLOBAL_NODE_URL, typed, account, { signal: stop.signal });
            if (check.kind === 'cancelled' || stop.signal.aborted) return;
            if (check.kind !== 'free') {
                setSuggestions(check.kind === 'taken' ? check.suggestions : []);
                setError(nameCheckMessage(typed, check));
                return;
            }
            setSuggestions([]);
            setWorkWaiting(run.state().phase !== 'ready');
            // Stops waiting the moment the member leaves the step ("Choose another way", Back): PR #1452 review, finding 2.
            const ready = await solutionUnlessLeft(run, stop.signal);
            if (stop.signal.aborted || ready.kind === 'cancelled') return;
            setWorkWaiting(false);
            if (ready.kind === 'refused') {
                await afterAnswer(ready.answer, account, typed, 'words');
                return;
            }
            joinSendingRef.current = true;
            setPhase('joining');
            const answer = await submitWordsJoin(GLOBAL_NODE_URL, account.identity, typed, run);
            await afterAnswer(answer, account, typed, 'words');
        } catch (e) {
            setError((e as Error | null)?.message || 'Your join could not be completed. Please try again.');
            setPhase('name');
        } finally {
            joinSendingRef.current = false;
            setWorkWaiting(false);
            if (nameCheckRef.current === stop) nameCheckRef.current = null;
            setLoading(false);
        }
    }

    /** Where each answer takes the member. A refusal changes nothing on the phone: there is nothing to put back. */
    async function afterAnswer(answer: DoorAnswer, account: JoinKey, typed: string, joinedBy: DoorWay = 'sign-in') {
        if (answer.kind === 'joined') {
            let joined: Awaited<ReturnType<typeof finishJoinFromAccount>>;
            try {
                joined = await finishJoinFromAccount(answer, account, typed, { stillWanted: () => !goneRef.current });
                doorWork.stop();
                // In by 12 words: unless the key vault already keeps a copy of this key (a way back in every community),
                // the account has one way back here, and the card says so (utils/one-way-back.ts).
                if (joined && joinedBy === 'words' && !(await vaultCopyKnown(account.identity.publicKey))) {
                    await startOneWayBack(account.identity.publicKey, GLOBAL_NODE_URL);
                }
            } catch {
                // In, but the phone could not switch to it: nothing is lost, and the sheet opens it.
                setSignin(null);
                setMessage('You joined the global community, but the app could not open it. Open it from Your communities in the BeanPool sheet (tap the bean).');
                setPhase('closed');
                return;
            }
            if (!joined) return;
            Alert.alert(joined.title, joined.body, [{
                text: 'Next',
                // As after any second community: the name and photo for this one, then home.
                onPress: () => router.replace({ pathname: '/profile-setup', params: { redirect: HOME_REDIRECT, name: joined.name } }),
            }], { cancelable: false });
            return;
        }
        if (answer.kind === 'account_closed') await rememberAccountClosed(account.identity.publicKey);
        const next = nextStepFor(answer);
        if (next === 'sign_in') {
            // This door takes no 12-words joins now: the sign-in buttons, with why.
            setWordsDoor(false);
            doorWork.stop('words');
            setError(doorMessage(answer));
            setPhase('signIn');
            return;
        }
        if (next === 'retry') {
            setError(accountDoorMessage(answer));
            setPhase(joinedBy === 'words' ? 'name' : wordsDoor ? 'choose' : 'signIn');
            return;
        }
        setSignin(null);
        setMessage(accountDoorMessage(answer));
        setPhase(next === 'restore' ? 'restore' : answer.kind === 'door_closed' ? 'unavailable' : 'closed');
    }

    const signedInWith = signin ? SSO_PROVIDER_NAMES[signin.provider] : null;
    const keeper = signInCopiesAt() === 'vault'
        ? 'BeanPool keeps a locked copy of your account for it, and BeanPool can open that copy.'
        : 'the global community keeps a locked copy of your account for it, and the people who run it can open that copy.';

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <View style={styles.header}>
                <Pressable onPress={leave} disabled={!ways.back} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">Global community</Text>
                <View style={{ width: 48 }} />
            </View>

            <KeyboardAwareScrollView
                contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
                keyboardShouldPersistTaps="handled"
                bottomOffset={16}
            >
                <View style={styles.card}>
                    <Text style={styles.title} accessibilityRole="header">🌍 Join the global community</Text>

                    {phase === 'checking' && (
                        <View style={styles.busy} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={styles.busyText}>Connecting to the global community…</Text>
                        </View>
                    )}

                    {(phase === 'unavailable' || phase === 'closed') && (
                        <>
                            <Text style={styles.body} accessibilityLiveRegion="polite">{message}</Text>
                            {phase === 'unavailable' && (
                                <Pressable style={styles.primary} onPress={() => { setError(null); setPhase('checking'); }} accessibilityRole="button">
                                    <Text style={styles.primaryText}>Try again</Text>
                                </Pressable>
                            )}
                        </>
                    )}

                    {phase === 'restore' && (
                        <>
                            <Text style={styles.body} accessibilityLiveRegion="polite">{message}</Text>
                            <Pressable style={styles.primary} onPress={signInAgain} accessibilityRole="button">
                                <Text style={styles.primaryText}>Use a different sign-in</Text>
                            </Pressable>
                        </>
                    )}

                    {/* Two ways in, side by side, words first (two-doors design §2.6). Either way, the account on this phone. */}
                    {phase === 'choose' && (
                        <>
                            <Text style={styles.body}>
                                Meet people from everywhere and find communities near you, as the account on this phone. Your key
                                and your 12 words stay the same, and nothing changes in your other communities.
                            </Text>
                            {loading && (
                                <View style={styles.busy} accessibilityLiveRegion="polite">
                                    <ActivityIndicator size="large" color={colors.brand.primary} />
                                </View>
                            )}
                            {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
                            <DoorChoices
                                colors={colors}
                                onWords={chooseWords}
                                onSignIn={handleSignIn}
                                disabled={loading}
                                busy={doorWork.busy}
                                wordsProblem={doorWork.state('words')?.phase === 'failed' ? DOOR_WORK_MESSAGES.solverUnavailable : null}
                                signInNote={`${keeper.charAt(0).toUpperCase()}${keeper.slice(1)} BeanPool never sees your password and never posts anything for you.`}
                            />
                        </>
                    )}

                    {phase === 'signIn' && (
                        <>
                            <Text style={styles.body}>
                                Meet people from everywhere and find communities near you, as the account on this phone. Your key
                                and your 12 words stay the same, and nothing changes in your other communities.
                            </Text>
                            <Text style={styles.small}>
                                To keep out fake accounts, sign in once with an account you already have. That sign-in also becomes
                                a way back into your account if you lose this phone: {keeper} BeanPool never sees your password and
                                never posts anything for you.
                            </Text>
                            {loading && (
                                <View style={styles.busy} accessibilityLiveRegion="polite">
                                    <ActivityIndicator size="large" color={colors.brand.primary} />
                                </View>
                            )}
                            {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
                            {!loading && (
                                <>
                                    {Platform.OS === 'ios' && (
                                        <AppleButton title="Continue with Apple" onPress={() => handleSignIn('apple')} style={styles.sso} />
                                    )}
                                    <GoogleButton title="Continue with Google" onPress={() => handleSignIn('google')} style={styles.sso} />
                                    <FacebookButton title="Continue with Facebook" onPress={() => handleSignIn('facebook')} style={styles.sso} />
                                    {wordsDoor && (
                                        <Pressable style={styles.quiet} onPress={() => { setError(null); setPhase('choose'); }} accessibilityRole="button">
                                            <Text style={styles.quietText}>Choose another way</Text>
                                        </Pressable>
                                    )}
                                </>
                            )}
                        </>
                    )}

                    {phase === 'name' && (
                        <>
                            {way === 'words'
                                ? <Text style={styles.small}>🔑 With your 12 words: the ones this phone already has. No sign-in needed.</Text>
                                : signedInWith && <Text style={styles.small}>✅ Signed in with {signedInWith}</Text>}
                            <Text style={styles.label}>Your name in the global community</Text>
                            <TextInput
                                style={styles.input}
                                placeholder="Your name or nickname"
                                placeholderTextColor={colors.text.muted}
                                value={name}
                                onChangeText={(t) => { setName(t); if (suggestions.length) setSuggestions([]); }}
                                maxLength={MAX_JOIN_NAME}
                                autoCapitalize="words"
                                editable={!loading}
                                accessibilityLabel="Your name in the global community"
                            />
                            <Text style={styles.helper}>This is how people there see you. You can change it later.</Text>
                            {suggestions.length > 0 && (
                                <View style={styles.chips}>
                                    {suggestions.map(s => (
                                        <Pressable
                                            key={s}
                                            style={styles.chip}
                                            onPress={() => { setName(s); setSuggestions([]); setError(null); }}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Use the name ${s}`}
                                        >
                                            <Text style={styles.chipText}>{s}</Text>
                                        </Pressable>
                                    ))}
                                </View>
                            )}
                            {error && <Text style={[styles.error, { marginTop: 12 }]} accessibilityLiveRegion="polite">{error}</Text>}
                            {way === 'words' && doorWork.busy && <Text style={styles.helper} accessibilityLiveRegion="polite">{doorWork.busy}</Text>}
                            {way === 'words' && workWaiting && <DoorWorkProgress state={doorWork.state('words')} colors={colors} />}
                            <Pressable style={styles.primary} onPress={way === 'words' ? handleWordsJoin : handleJoin} disabled={loading} accessibilityRole="button" accessibilityLabel="Join">
                                {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryText}>Join →</Text>}
                            </Pressable>
                            <Pressable style={styles.secondary} onPress={signInAgain} disabled={!ways.otherSignIn} accessibilityRole="button">
                                <Text style={styles.secondaryText}>{wordsDoor ? 'Choose another way' : 'Use a different sign-in'}</Text>
                            </Pressable>
                        </>
                    )}

                    {phase === 'joining' && (
                        <View style={styles.busy} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={styles.busyText}>{notice ?? 'Joining the global community…'}</Text>
                        </View>
                    )}

                    {phase !== 'joining' && (
                        <Pressable style={styles.quiet} onPress={leave} disabled={!ways.back} accessibilityRole="button" accessibilityLabel="Back">
                            <Text style={styles.quietText}>← Back</Text>
                        </Pressable>
                    )}
                </View>
            </KeyboardAwareScrollView>
        </SafeAreaView>
    );
}
