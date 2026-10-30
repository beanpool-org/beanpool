import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Alert, BackHandler, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, ErrorBoundary, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme, useStyles } from './ThemeContext';
import { useNodeStatus } from './NodeStatusContext';
import { GoogleButton, AppleButton, FacebookButton } from '../components/SsoButton';
import { authenticateUser } from '../utils/LocalAuth';
import { checkGlobalDoor, wordsDoorOn, type GlobalDoorRefusal } from '../utils/node-profile';
import { rememberGlobalDoor } from '../utils/global-door-offer';
import {
    MAX_JOIN_NAME, checkNameAtDoor, doorWaysOut, joinedUnderNodeName, nextStepFor, signInAtDoor, submitJoin, submitWordsJoin,
    type DoorAnswer, type DoorPhase, type DoorSignIn, type DoorWay, type JoinKey,
} from '../utils/global-join';
import { useDoorWork } from '../utils/use-door-work';
import { DOOR_WORK_MESSAGES, solutionUnlessLeft } from '../utils/door-work';
import { DoorChoices, DoorWorkProgress } from '../components/WordsDoor';
import { startOneWayBack } from '../utils/one-way-back';
import { vaultCopyKnown } from '../utils/vault';
import { ACCOUNT_DOOR_MESSAGES, accountKeyForDoor, finishJoinFromAccount, rememberAccountClosed } from '../utils/global-join-existing';
import { commitOpenDoorKey, finishOpenDoorJoin, openDoorKeyForThisPhone, openDoorKeyIsNew, releaseOpenDoorKey } from '../utils/open-door-key';
import { doorJoinOut, getPendingOnboarding } from '../utils/onboarding-state';
import { StoredKeyUnreadableError } from '../utils/identity';
import { useIdentity } from './IdentityContext';
import { HOME_REDIRECT } from '../utils/join-another-community';
import { afterJoinRedirect } from '../utils/pair-device-target';
import { signInCopiesAt, type SignInCopies } from '../utils/vault-config';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';
import { FROM_LINK } from '../utils/global-link';
import { doorNodeFromParam, restoreAtDoorHref, takeDoorTap, type DoorNode } from '../utils/open-door';
import {
    doorAnswerWords, doorKeeperWords, doorNameCheckWords, doorRefusalWords, doorScreenWords, globalPlace, joinedGlobalBodyWords, joinedTitle,
    newPhoneDoorWords, phoneDoorLineWords, placeAt, type DoorPlace,
} from '../utils/open-door-words';
import { askCommunityName } from '../utils/community-name';
import { getSavedNodes } from '../utils/nodes';
import { plainOriginOf } from '../utils/node-url';
import { t, tn } from '@beanpool/core';

export { ErrorBoundary };

/**
 * The door of a community whose door is open, for an account this phone already has (utils/global-join-existing.ts;
 * DESIGN-global-entry-fable.md decision 6, slice P5). With no `node` it is the global community's, also opened by its
 * old name (app/join-global.tsx): reached from People → Invites as a guest of the global community, from the BeanPool
 * sheet and from Settings → Advanced. With `?node=<address>` it is that community's (utils/open-door.ts): the
 * not-recognised screen's Join on an open-door community it reached, ours or a self-hoster's, under its own name.
 * Sign in once, check the name, join, with the key on the phone; then the profile step for that community (its photo),
 * as after any second community. Nothing on the phone changes until the community has let the member in, and a
 * refusal leaves everything as it was.
 *
 * Another community's door also takes a phone with no account (DESIGN-account-without-global-fable.md §2.3, slice S2;
 * utils/open-door-key.ts): its link opens this screen on a new phone, and the join makes the account there, at the
 * community's own address. The key is made in memory and written only at Join, with the wizard's record; a refusal for good
 * takes it off again, a lost answer keeps it, and once in, the welcome screen's wizard shows the 12 words. The global
 * community's door with no account stays the first screen's ("Explore BeanPool worldwide"): this screen sends it there.
 */
export default function JoinOpenDoorScreen() {
    const { then: thenParam, from: fromParam, node: nodeParam } = useLocalSearchParams<{ then?: string; from?: string; node?: string }>();
    const door = doorNodeFromParam(nodeParam);
    // An address the screen refuses is never swapped for another community's door: the screen says so, and asks nothing.
    if (!door) return <RefusedDoor />;
    return <OpenDoor key={door.url} door={door} thenParam={thenParam} fromParam={fromParam} />;
}

function useDoorStyles() {
    return useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.onDark, letterSpacing: 0.5, textTransform: 'uppercase' },
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
        primary: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
        primaryText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
        secondaryText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        quiet: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
        quietText: { color: colors.text.secondary, fontSize: 15, fontWeight: '600', textAlign: 'center' },
        sso: { marginBottom: 10, width: '100%' },
        host: { fontSize: 13, color: colors.text.secondary, marginTop: -4, marginBottom: 12 },
    }));
}

/** The door's header: Back, and whose door it is. */
function DoorHeader({ title, onBack, backEnabled }: { title: string; onBack: () => void; backEnabled: boolean }) {
    const { colors } = useTheme();
    const styles = useDoorStyles();
    return (
        <View style={styles.header}>
            <Pressable onPress={onBack} disabled={!backEnabled} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.inverse} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">{title}</Text>
            <View style={{ width: 48 }} />
        </View>
    );
}

function backOrHome() {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
}

/** Out of the door with nowhere to go back to: home for an account, the first screen for a phone with none. */
function backOrStart(kind: 'existing' | 'new' | null) {
    if (router.canGoBack()) router.back();
    else router.replace(kind === 'new' ? '/welcome' : '/(tabs)');
}

/**
 * What the screen says for a join that threw: the phone's own sentence in the member's language where the door's table
 * has it (open-door-words.ts phoneDoorLineWords), else as it came; `fallback` when there is none.
 */
function errorWords(e: unknown, fallback: string): string {
    if (e instanceof StoredKeyUnreadableError) return t("BeanPool can't read the account on this phone. Restart and try again, or restore with your 12 words.");
    const message = (e as Error | null)?.message;
    return message ? phoneDoorLineWords(message) : fallback;
}

/** A door for an address the phone won't sign for or connect to (utils/open-door.ts doorNodeAt). Nothing was asked. */
function RefusedDoor() {
    const styles = useDoorStyles();
    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <DoorHeader title={t('Join a community')} onBack={backOrHome} backEnabled />
            <View style={styles.scroll}>
                <View style={styles.card}>
                    <Text style={styles.body} accessibilityLiveRegion="polite">
                        {t("BeanPool can't open this community's door: its address isn't a plain web address it can safely connect to. Nothing was sent. Check the address with whoever gave it to you.")}
                    </Text>
                    <Pressable style={styles.quiet} onPress={backOrHome} accessibilityRole="button" accessibilityLabel={t('Back')}>
                        <Text style={styles.quietText}>{t('← Back')}</Text>
                    </Pressable>
                </View>
            </View>
        </SafeAreaView>
    );
}

function OpenDoor({ door, thenParam, fromParam: fromRoute }: { door: DoorNode; thenParam?: string; fromParam?: string }) {
    const { colors } = useTheme();
    const { recheck } = useNodeStatus();
    const { identity, setIdentity } = useIdentity();
    const insets = useSafeAreaInsets();
    const styles = useDoorStyles();
    /** Every request this door makes goes to this address, and only to it. */
    const doorUrl = door.url;

    /**
     * Whose door it is, as the screen names it (utils/open-door-words.ts): the global community; or another community by
     * the phone's saved name for it, then by its own answer, else its host. Never a name a link carried.
     */
    const [place, setPlace] = useState<DoorPlace>(() => (door.global ? globalPlace(doorUrl) : placeAt(doorUrl)));
    /** Its name once known (its own answer, or the phone's saved one): what the saved list keeps for it after the join. */
    const [knownName, setKnownName] = useState<string | undefined>(undefined);
    useEffect(() => {
        if (door.global) return;
        let alive = true;
        (async () => {
            const saved = (await getSavedNodes().catch(() => [])).find(n => plainOriginOf(n.url) === doorUrl);
            if (alive && saved?.alias) { setPlace(placeAt(doorUrl, saved.alias)); setKnownName(saved.alias); }
            const own = await askCommunityName(doorUrl);
            if (alive && own) { setPlace(placeAt(doorUrl, own)); setKnownName(own); }
        })();
        return () => { alive = false; };
    }, [door.global, doorUrl]);
    const say = doorScreenWords(place);
    const sayNew = newPhoneDoorWords(place);

    const [phase, setPhase] = useState<DoorPhase>('checking');
    /** What the member reads on the `unavailable`, `restore` and `closed` screens. */
    const [message, setMessage] = useState<string | null>(null);
    /** The door's check refused: said by name at render, so a name that arrives later is the one read. */
    const [refusal, setRefusal] = useState<GlobalDoorRefusal | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [key, setKey] = useState<JoinKey | null>(null);
    /**
     * Whose key the door joins with, read from the phone as it opens: `existing`, the phone's own account (slice P5); `new`, a
     * key this door made, in memory until Join (a phone with no account: slice S2, utils/open-door-key.ts), or on the phone
     * with its record while a join it signed may have landed, or since taken over by an invite join whose redeem never
     * finished (its words never shown: open-door-key.ts openDoorKeyIsNew). Null until read.
     */
    const [keyKind, setKeyKind] = useState<'existing' | 'new' | null>(null);
    const keyRef = useRef<JoinKey | null>(null);
    keyRef.current = key;
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
    /** Where a copy made at this door goes (its community's rule, VR2), from the door check; this build's place until then. */
    const [doorCopies, setDoorCopies] = useState<SignInCopies>(() => signInCopiesAt());
    const [way, setWay] = useState<DoorWay>('sign-in');
    const doorWork = useDoorWork();
    /**
     * Another community's door that the member's Join in the app didn't open just now is taken as a link's: the router opens
     * this route in spellings no intercept can all know, and only that Join leaves the mark (utils/open-door.ts takeDoorTap).
     * Read once, as the door opens.
     */
    const [fromParam] = useState(() => (door.global || takeDoorTap(door.url) ? fromRoute : FROM_LINK));
    /**
     * A link opened this door (utils/global-link.ts, `from=link`): the 12-words work, which is signed by the key on this phone
     * and sent to the door's community, waits for the member's first tap here. A link only opens a screen.
     */
    const [heldForTap, setHeldForTap] = useState(fromParam === FROM_LINK);
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

    /**
     * The key this door joins with: the global community's door, the phone's account only (with none, the door is the first
     * screen's); another community's, the key rule at its address (utils/open-door-key.ts): the phone's account, else the key
     * this door made (`held`), else a new one in memory. Asked again at every try: the phone may hold a key since.
     */
    const keyForDoor = (held: JoinKey | null): Promise<JoinKey | null> => (door.global ? accountKeyForDoor() : openDoorKeyForThisPhone(doorUrl, held));
    /**
     * {@link keyForDoor} at a tap. The phone's account the door opened for, gone since (signed out while the screen was
     * open): null, and the screen says so, as before slice S2; never a new account made in its place.
     */
    const keyAtTap = async (): Promise<JoinKey | null> => {
        const joining = await keyForDoor(key);
        return joining && joining.createdHere && keyKind === 'existing' ? null : joining;
    };

    // Arriving: whose key joins. Nothing is written by reading it: a key the door makes is in memory until Join.
    useEffect(() => {
        let alive = true;
        (async () => {
            // A join wizard half done that is not this door's own join resumes on the first screen, and this door starts
            // nothing, as for its link (utils/open-door.ts doorLinkRoute).
            const record = await getPendingOnboarding();
            if (!alive) return;
            if (record && !(doorJoinOut(record) && record.anchorUrl === doorUrl)) { router.replace('/welcome'); return; }
            const joining = await keyForDoor(null);
            if (!alive) return;
            // The global community's door with no account on the phone is the first screen's ("Explore BeanPool worldwide"),
            // as before slice S2, when the root guard sent this screen there.
            if (!joining) { router.replace('/welcome'); return; }
            // A key whose 12 words this phone has never shown is the member's new account, whoever holds it now.
            const isNew = joining.createdHere || await openDoorKeyIsNew(doorUrl, joining.identity.publicKey);
            if (!alive) return;
            setKey(joining);
            setKeyKind(isNew ? 'new' : 'existing');
        })().catch(() => {});
        return () => { alive = false; };
        // Read once, as the door opens: the screen is keyed by its address.
    }, []);

    /**
     * Back. A key this door made comes off the phone as the member leaves, unless a join it signed may have landed
     * (utils/open-door-key.ts releaseOpenDoorKey): then it stays with its record, and the next launch comes back to this door.
     * The phone's own account is left exactly as it was.
     */
    function leave() {
        if (joinSendingRef.current) return;
        nameCheckRef.current?.abort();
        const made = key?.createdHere ? key : null;
        if (!made) { backOrStart(keyKind); return; }
        void releaseOpenDoorKey(doorUrl, made).catch(() => false).then((removed) => {
            // The app loaded that key at its start (a restart while the join was out): it holds no account now.
            if (removed && identity?.publicKey === made.identity.publicKey) setIdentity(null);
            backOrStart('new');
        });
    }
    const leaveRef = useRef(leave);
    leaveRef.current = leave;

    // Android's back button keeps to the same ways out as the screen's own, and a key this door made leaves by the same way
    // as the screen's Back, so it never stays behind by another.
    useFocusEffect(useCallback(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (joinSendingRef.current || !ways.back) return true;
            if (keyRef.current?.createdHere) { leaveRef.current(); return true; }
            return false;
        });
        return () => sub.remove();
    }, [ways.back]));

    // Arriving (or Try again): is it a community with the global profile and its door open? The same question for the
    // global community and for anyone's: checkGlobalDoor reads the community's own profile (node-profile.ts).
    useEffect(() => {
        if (phase !== 'checking') return;
        let cancelled = false;
        checkGlobalDoor(doorUrl)
            .then(check => {
                // The global community's answer is what the BeanPool sheet's row reads when the member goes back
                // (global-door-offer.ts). Another community's answer is never taken for the global community's.
                if (door.global) rememberGlobalDoor(check);
                if (cancelled) return;
                if (check.ok) {
                    // Where a copy made at this door goes, by its community's rule (vault rethink VR2).
                    setDoorCopies(signInCopiesAt(check.profile.recoveryCopies));
                    // Two ways in where the door has the 12-words one; the sign-in alone where it doesn't, as before.
                    const words = wordsDoorOn(check.profile.features);
                    setWordsDoor(words);
                    setPhase(words ? 'choose' : 'signIn');
                    return;
                }
                setRefusal(check.reason);
                setPhase('unavailable');
            })
            .catch(() => {
                if (door.global) rememberGlobalDoor(null);
                if (cancelled) return;
                setRefusal('unreachable');
                setPhase('unavailable');
            });
        return () => { cancelled = true; };
    }, [phase, doorUrl, door.global]);

    // The 12-words door's work starts as the door opens, signed by the key the join will be signed by (the phone's own, or
    // the one this door made, in memory), so it is done by Join. Opened by a link, the work waits for the member's first tap.
    const startWork = doorWork.start;
    useEffect(() => {
        if (phase !== 'choose' || !key) return;
        if (!heldForTap) startWork(doorUrl, key.identity, 'words');
    }, [phase, startWork, heldForTap, key]);

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

    /** "Join with this account" (the 12 words): the name next, while the work goes on. No sign-in, so no copy, and no lock. */
    function chooseWords() {
        // The first tap at a door a link opened: the work starts now (at Join otherwise, if the key wasn't read yet).
        if (heldForTap && key) startWork(doorUrl, key.identity, 'words');
        setHeldForTap(false);
        setError(null);
        setSignin(null);
        setWay('words');
        if (!name.trim() && key?.identity.callsign) setName(key.identity.callsign.slice(0, MAX_JOIN_NAME));
        setPhase('name');
    }

    /**
     * Step one: the sign-in, for the key the join will be signed by. The phone's own account first passes the phone's lock;
     * a key this door made has nothing behind it yet (as at the first screen's door, welcome.tsx handleGlobalSignIn).
     */
    async function handleSignIn(provider: SsoProvider) {
        setHeldForTap(false);
        setLoading(true);
        setError(null);
        try {
            const account = await keyAtTap();
            if (!account) {
                setError(phoneDoorLineWords(ACCOUNT_DOOR_MESSAGES.noAccount));
                return;
            }
            setKey(account);
            // The sign-in also links to the phone's account, so the phone's lock first, as Account Protection's connect asks
            // it. A check that doesn't pass starts nothing.
            if (!account.createdHere && !(await authenticateUser(t('Confirm authentication to link a sign-in to your account.')))) return;
            const result = await signInAtDoor(provider, doorUrl, account.identity);
            if (result.kind === 'answered') {
                // The door answered before any join (shut, a limit, or in already): never the join's own refusal.
                await afterAnswer(result.answer, account, name.trim() || account.identity.callsign, 'sign-in', 'signIn');
                return;
            }
            setSignin(result.signin);
            setWay('sign-in');
            // Signed in: the 12-words work stops (the phone's battery); "Choose another way" starts it again.
            doorWork.stop('words');
            // From the 30th join an hour from one network the sign-in door asks for work too: asked now, while the name
            // is typed (only at a door with the 12-words door; one from before it has none to give).
            if (wordsDoor) doorWork.start(doorUrl, account.identity, 'sign-in');
            if (!name.trim() && account.identity.callsign) setName(account.identity.callsign.slice(0, MAX_JOIN_NAME));
            setPhase('name');
        } catch (e) {
            // A cancel is not an error: the member thought better of it.
            const failure = e as { reason?: string } | null;
            setError(failure?.reason === 'cancelled' ? null : errorWords(e, t('Sign-in failed. Try again.')));
        } finally {
            setLoading(false);
        }
    }

    /**
     * Step two: the name, checked at the door, then the join, signed by the key the phone holds. A key this door made goes
     * onto the phone first, with the wizard's record (utils/open-door-key.ts commitOpenDoorKey): never before Join.
     */
    async function handleJoin() {
        if (!key || !signin) { setPhase('signIn'); return; }
        const typed = name.trim().slice(0, MAX_JOIN_NAME).trim();
        if (typed.length < 2) {
            setError(tn(2, 'Please choose a name of at least {n} characters.', 'Please choose a name of at least {n} characters.'));
            return;
        }
        setLoading(true);
        setError(null);
        nameCheckRef.current?.abort();
        const stop = new AbortController();
        nameCheckRef.current = stop;
        try {
            const check = await checkNameAtDoor(doorUrl, typed, key, { signal: stop.signal });
            if (check.kind === 'cancelled' || stop.signal.aborted) return;
            if (check.kind !== 'free') {
                setSuggestions(check.kind === 'taken' ? check.suggestions : []);
                setError(doorNameCheckWords(typed, check, place));
                return;
            }
            setSuggestions([]);
            joinSendingRef.current = true;
            setPhase('joining');
            const joining = key.createdHere ? await commitOpenDoorKey(doorUrl, key, typed) : key.identity;
            const answer = await submitJoin(doorUrl, joining, typed, signin, { onSignInAgain: (line) => setNotice(phoneDoorLineWords(line)), work: doorWork.runFor('sign-in') });
            setSignin(null);
            await afterAnswer(answer, key, typed, 'sign-in', 'join');
        } catch (e) {
            setSignin(null);
            setError(errorWords(e, t('Your join could not be completed. Please sign in and try again.')));
            setPhase(wordsDoor ? 'choose' : 'signIn');
        } finally {
            joinSendingRef.current = false;
            setNotice(null);
            if (nameCheckRef.current === stop) nameCheckRef.current = null;
            setLoading(false);
        }
    }

    /**
     * The 12-words way with the key the join will be signed by: the name, checked at the door; the work (done already at
     * ordinary levels; otherwise it finishes here, and Back still works); then the join, with no sign-in. For the phone's
     * own account nothing on the phone changes until the door has let the member in; a key this door made goes onto the
     * phone, with the wizard's record, just before the join is sent.
     */
    async function handleWordsJoin() {
        const typed = name.trim().slice(0, MAX_JOIN_NAME).trim();
        if (typed.length < 2) {
            setError(tn(2, 'Please choose a name of at least {n} characters.', 'Please choose a name of at least {n} characters.'));
            return;
        }
        setLoading(true);
        setError(null);
        nameCheckRef.current?.abort();
        const stop = new AbortController();
        nameCheckRef.current = stop;
        try {
            // Asked again: the phone may hold a key since this door made one. The work names the key, so a different one
            // starts its own.
            const account = await keyAtTap();
            if (!account) {
                setError(phoneDoorLineWords(ACCOUNT_DOOR_MESSAGES.noAccount));
                return;
            }
            setKey(account);
            const run = doorWork.start(doorUrl, account.identity, 'words');
            const check = await checkNameAtDoor(doorUrl, typed, account, { signal: stop.signal });
            if (check.kind === 'cancelled' || stop.signal.aborted) return;
            if (check.kind !== 'free') {
                setSuggestions(check.kind === 'taken' ? check.suggestions : []);
                setError(doorNameCheckWords(typed, check, place));
                return;
            }
            setSuggestions([]);
            setWorkWaiting(run.state().phase !== 'ready');
            // Stops waiting the moment the member leaves the step ("Choose another way", Back): PR #1452 review, finding 2.
            const ready = await solutionUnlessLeft(run, stop.signal);
            if (stop.signal.aborted || ready.kind === 'cancelled') return;
            setWorkWaiting(false);
            if (ready.kind === 'refused') {
                // Nothing was sent: a refusal before any join, like one at the sign-in. Every key and record stays.
                await afterAnswer(ready.answer, account, typed, 'words', 'signIn');
                return;
            }
            joinSendingRef.current = true;
            setPhase('joining');
            const joining = account.createdHere ? await commitOpenDoorKey(doorUrl, account, typed) : account.identity;
            const answer = await submitWordsJoin(doorUrl, joining, typed, run);
            await afterAnswer(answer, account, typed, 'words', 'join');
        } catch (e) {
            setError(errorWords(e, t('Your join could not be completed. Please try again.')));
            setPhase('name');
        } finally {
            joinSendingRef.current = false;
            setWorkWaiting(false);
            if (nameCheckRef.current === stop) nameCheckRef.current = null;
            setLoading(false);
        }
    }

    /**
     * Where each answer takes the member. `via` is what answered: the sign-in (the nonce, or the 12-words door's work before
     * any join) or the join itself. For the phone's own account a refusal changes nothing on the phone: there is nothing to
     * put back. A key this door made comes off again only on the join's own refusal for good, and only when no join it
     * signed can have landed (utils/open-door-key.ts releaseOpenDoorKey).
     */
    async function afterAnswer(answer: DoorAnswer, account: JoinKey, typed: string, joinedBy: DoorWay = 'sign-in', via: 'signIn' | 'join' = 'join') {
        // In with a key whose 12 words the member has never seen: one this door made, or one an invite join took over since
        // and never finished with (open-door-key.ts openDoorKeyIsNew). The wizard shows them; the account's finish would leave
        // the door's record at the door, and every launch would come back here (PR #2564 review).
        if (answer.kind === 'joined' && (account.createdHere || await openDoorKeyIsNew(doorUrl, account.identity.publicKey))) {
            await finishNewAccount(answer, account, typed, joinedBy);
            return;
        }
        if (answer.kind === 'joined') {
            let joined: Awaited<ReturnType<typeof finishJoinFromAccount>>;
            try {
                // In there, and only there: the phone switches to the community whose door this is.
                joined = await finishJoinFromAccount(answer, account, typed, {
                    stillWanted: () => !goneRef.current,
                    ...(door.global ? {} : { at: { url: doorUrl, name: knownName } }),
                });
                doorWork.stop();
                // In by 12 words: unless the key vault already keeps a copy of this key (a way back in every community),
                // the account has one way back here, and the card says so (utils/one-way-back.ts).
                if (joined && joinedBy === 'words' && !(await vaultCopyKnown(account.identity.publicKey))) {
                    await startOneWayBack(account.identity.publicKey, doorUrl);
                }
            } catch {
                // In, but the phone could not switch to it: nothing is lost, and the sheet opens it.
                setSignin(null);
                setRefusal(null);
                setMessage(say.notOpened);
                setPhase('closed');
                return;
            }
            if (!joined) return;
            // The phone is on that community now, as a member: the root layout's recognition is asked again, so the answer
            // of the community it left (a stranger, when the door was opened from the not-recognised screen) can't send the
            // member back there on the way to the profile step.
            await recheck().catch(() => 'unknown');
            Alert.alert(joinedTitle(place, joined.title), joinedGlobalBodyWords(joined.body), [{
                text: t('Next'),
                // As after any second community: the name and photo for this one, then home.
                // Started from the pairing screen's refusal (`then=pair-device`): back there to scan again, after the profile.
                onPress: () => router.replace({ pathname: '/profile-setup', params: { redirect: afterJoinRedirect(thenParam, HOME_REDIRECT), name: joined.name } }),
            }], { cancelable: false });
            return;
        }
        // The global community's mark that it closed this key (what the sheet's row and the link read); another community's
        // own door says so the next time it is asked.
        if (answer.kind === 'account_closed' && door.global) await rememberAccountClosed(account.identity.publicKey);
        const next = nextStepFor(answer);
        if (next === 'sign_in') {
            // This door takes no 12-words joins now: the sign-in buttons, with why.
            setWordsDoor(false);
            doorWork.stop('words');
            setError(doorAnswerWords(answer, place));
            setPhase('signIn');
            return;
        }
        if (next === 'retry') {
            setError(doorAnswerWords(answer, place));
            setPhase(joinedBy === 'words' ? 'name' : wordsDoor ? 'choose' : 'signIn');
            return;
        }
        // Refused for good. A refusal at the sign-in leaves every key and record alone: a shut door says so before it looks
        // for the member, so an earlier join whose answer was lost may still have landed.
        if (account.createdHere && via === 'join' && await releaseOpenDoorKey(doorUrl, account)) {
            // Off the phone: the next try makes a new one. The app loaded that key at its start (a restart while the join
            // was out): it holds no account now.
            setKey(null);
            if (identity?.publicKey === account.identity.publicKey) setIdentity(null);
        }
        setSignin(null);
        setRefusal(null);
        // Said as the screen speaks: to a new account (`keyKind`), the key an invite join took over included, whose restore
        // phase draws 🔑 Restore my account under this sentence (PR #2564 review).
        setMessage(keyKind === 'new' && answer.kind === 'already_joined' ? sayNew.alreadyJoined : doorAnswerWords(answer, place));
        setPhase(next === 'restore' ? 'restore' : answer.kind === 'door_closed' ? 'unavailable' : 'closed');
    }

    /**
     * In, with a key this door made (slice S2): the phone is this community's now, under the name the node kept, and the
     * wizard's record moves on to Your Photo at its address (utils/open-door-key.ts finishOpenDoorJoin). The welcome screen
     * resumes it: Your Photo, Safety Backup with the 12 words, How it Works, then Home. One welcome, never this screen under it.
     */
    async function finishNewAccount(answer: Extract<DoorAnswer, { kind: 'joined' }>, made: JoinKey, typed: string, joinedBy: DoorWay) {
        try {
            const named = await joinedUnderNodeName(doorUrl, answer, { ...made.identity, callsign: typed.trim() || made.identity.callsign });
            await finishOpenDoorJoin(doorUrl, named, { enrolment: answer.enrolment, way: joinedBy, communityName: knownName ?? null });
        } catch (e) {
            // The node has the key and the key is on the phone, with its record: only the wizard's next step couldn't be
            // written. Said, and Join again is answered as the join was (`already_member`).
            setError(errorWords(e, sayNew.notSaved));
            setPhase(joinedBy === 'words' ? 'name' : wordsDoor ? 'choose' : 'signIn');
            return;
        }
        doorWork.stop();
        if (router.canDismiss()) router.dismissAll();
        router.replace('/welcome');
    }

    const signedInWith = signin ? SSO_PROVIDER_NAMES[signin.provider] : null;
    const keeper = doorKeeperWords(place, doorCopies);

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <DoorHeader title={say.header} onBack={leave} backEnabled={ways.back} />

            <KeyboardAwareScrollView
                contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
                keyboardShouldPersistTaps="handled"
                bottomOffset={16}
            >
                <View style={styles.card}>
                    <Text style={styles.title} accessibilityRole="header">{say.title}</Text>
                    {/* Another community's door says where it is: the member sees the address they are joining at. */}
                    {!door.global && <Text style={styles.host}>{place.host}</Text>}

                    {phase === 'checking' && (
                        <View style={styles.busy} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={styles.busyText}>{say.connecting}</Text>
                        </View>
                    )}

                    {(phase === 'unavailable' || phase === 'closed') && (
                        <>
                            <Text style={styles.body} accessibilityLiveRegion="polite">{refusal ? doorRefusalWords(refusal, place) : message}</Text>
                            {phase === 'unavailable' && (
                                <Pressable style={styles.primary} onPress={() => { setError(null); setRefusal(null); setPhase('checking'); }} accessibilityRole="button">
                                    <Text style={styles.primaryText}>{t('Try again')}</Text>
                                </Pressable>
                            )}
                        </>
                    )}

                    {phase === 'restore' && (
                        <>
                            <Text style={styles.body} accessibilityLiveRegion="polite">{message}</Text>
                            {/* A phone with no account: this sign-in's account is somewhere else, so the first screen's restore
                                brings it here, as at the global community's door (welcome.tsx), with this community's address
                                filled in: the one under the title. */}
                            {keyKind === 'new' && (
                                <Pressable style={styles.primary} onPress={() => router.replace(restoreAtDoorHref(doorUrl))} accessibilityRole="button">
                                    <Text style={styles.primaryText}>{t('🔑 Restore my account')}</Text>
                                </Pressable>
                            )}
                            <Pressable style={keyKind === 'new' ? styles.secondary : styles.primary} onPress={signInAgain} accessibilityRole="button">
                                <Text style={keyKind === 'new' ? styles.secondaryText : styles.primaryText}>{t('Use a different sign-in')}</Text>
                            </Pressable>
                        </>
                    )}

                    {/* Two ways in, side by side, words first (two-doors design §2.6). Either way, the account on this phone: the
                        one it has, or, with none, the one this door makes at Join. */}
                    {phase === 'choose' && (
                        <>
                            <Text style={styles.body}>{keyKind === 'new' ? sayNew.intro : say.intro}</Text>
                            {loading && (
                                <View style={styles.busy} accessibilityLiveRegion="polite">
                                    <ActivityIndicator size="large" color={colors.brand.primary} />
                                </View>
                            )}
                            {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
                            {keyKind === null ? (
                                <View style={styles.busy}>
                                    <ActivityIndicator size="large" color={colors.brand.primary} />
                                </View>
                            ) : (
                                <DoorChoices
                                    colors={colors}
                                    onWords={chooseWords}
                                    onSignIn={handleSignIn}
                                    disabled={loading}
                                    busy={doorWork.busy}
                                    wordsProblem={doorWork.state('words')?.phase === 'failed' ? phoneDoorLineWords(DOOR_WORK_MESSAGES.solverUnavailable) : null}
                                    signInNote={keeper.choose}
                                    keepsNoCopies={doorCopies === 'none'}
                                    account={keyKind}
                                />
                            )}
                        </>
                    )}

                    {phase === 'signIn' && (
                        <>
                            <Text style={styles.body}>{keyKind === 'new' ? sayNew.introSignIn : say.intro}</Text>
                            <Text style={styles.small}>{keeper.signIn}</Text>
                            {loading && (
                                <View style={styles.busy} accessibilityLiveRegion="polite">
                                    <ActivityIndicator size="large" color={colors.brand.primary} />
                                </View>
                            )}
                            {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
                            {!loading && (
                                <>
                                    {Platform.OS === 'ios' && (
                                        <AppleButton title={t('Continue with {provider}', { provider: SSO_PROVIDER_NAMES.apple })} onPress={() => handleSignIn('apple')} style={styles.sso} />
                                    )}
                                    <GoogleButton title={t('Continue with {provider}', { provider: SSO_PROVIDER_NAMES.google })} onPress={() => handleSignIn('google')} style={styles.sso} />
                                    <FacebookButton title={t('Continue with {provider}', { provider: SSO_PROVIDER_NAMES.facebook })} onPress={() => handleSignIn('facebook')} style={styles.sso} />
                                    {wordsDoor && (
                                        <Pressable style={styles.quiet} onPress={() => { setError(null); setPhase('choose'); }} accessibilityRole="button">
                                            <Text style={styles.quietText}>{t('Choose another way')}</Text>
                                        </Pressable>
                                    )}
                                </>
                            )}
                        </>
                    )}

                    {phase === 'name' && (
                        <>
                            {way === 'words'
                                ? <Text style={styles.small}>{keyKind === 'new' ? sayNew.wordsName : t('🔑 With your 12 words: the ones this phone already has. No sign-in needed.')}</Text>
                                : signedInWith && <Text style={styles.small}>{t('✅ Signed in with {provider}', { provider: signedInWith })}</Text>}
                            <Text style={styles.label}>{say.nameLabel}</Text>
                            <TextInput
                                style={styles.input}
                                placeholder={t('Your name or nickname')}
                                placeholderTextColor={colors.text.muted}
                                value={name}
                                onChangeText={(value) => { setName(value); if (suggestions.length) setSuggestions([]); }}
                                maxLength={MAX_JOIN_NAME}
                                autoCapitalize="words"
                                editable={!loading}
                                accessibilityLabel={say.nameLabel}
                            />
                            <Text style={styles.helper}>{t('This is how people there see you. You can change it later.')}</Text>
                            {suggestions.length > 0 && (
                                <View style={styles.chips}>
                                    {suggestions.map(s => (
                                        <Pressable
                                            key={s}
                                            style={styles.chip}
                                            onPress={() => { setName(s); setSuggestions([]); setError(null); }}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('Use the name {name}', { name: s })}
                                        >
                                            <Text style={styles.chipText}>{s}</Text>
                                        </Pressable>
                                    ))}
                                </View>
                            )}
                            {error && <Text style={[styles.error, { marginTop: 12 }]} accessibilityLiveRegion="polite">{error}</Text>}
                            {way === 'words' && doorWork.busy && <Text style={styles.helper} accessibilityLiveRegion="polite">{doorWork.busy}</Text>}
                            {way === 'words' && workWaiting && <DoorWorkProgress state={doorWork.state('words')} colors={colors} />}
                            <Pressable style={styles.primary} onPress={way === 'words' ? handleWordsJoin : handleJoin} disabled={loading} accessibilityRole="button" accessibilityLabel={t('Join')}>
                                {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryText}>{t('Join →')}</Text>}
                            </Pressable>
                            <Pressable style={styles.secondary} onPress={signInAgain} disabled={!ways.otherSignIn} accessibilityRole="button">
                                <Text style={styles.secondaryText}>{wordsDoor ? t('Choose another way') : t('Use a different sign-in')}</Text>
                            </Pressable>
                        </>
                    )}

                    {phase === 'joining' && (
                        <View style={styles.busy} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={styles.busyText}>{notice ?? say.joining}</Text>
                        </View>
                    )}

                    {phase !== 'joining' && (
                        <Pressable style={styles.quiet} onPress={leave} disabled={!ways.back} accessibilityRole="button" accessibilityLabel={t('Back')}>
                            <Text style={styles.quietText}>{t('← Back')}</Text>
                        </Pressable>
                    )}
                </View>
            </KeyboardAwareScrollView>
        </SafeAreaView>
    );
}
