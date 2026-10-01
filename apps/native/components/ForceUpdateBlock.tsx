import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, BackHandler, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { FullWindowOverlay } from 'react-native-screens';
import appConfig from '../app.json';
import { useIdentity } from '../app/IdentityContext';
import { useNodeStatus } from '../app/NodeStatusContext';
import { useTheme } from '../app/ThemeContext';
import { bootClockMs } from '../modules/boot-clock';
import { onCommunitySwitched } from '../utils/community-switch';
import { checkCommunityForUpdate, createForceUpdateGate, STORE_URLS } from '../utils/force-update';
import { hasMnemonic } from '../utils/identity';
import { authenticateUser, doorPrompts, isAppLockPromptOpen, whenAppLockPromptsClose } from '../utils/LocalAuth';
import { noWordsBeforeWipe } from '../utils/no-words-copy';
import {
    leaveFromUpdateBlock, otherCommunitiesOnPhone, planLeaveFromUpdateBlock, switchFromUpdateBlock, type BlockLeavePlan,
    type OtherCommunity,
} from '../utils/update-block-escape';
import { readWordsBehindLock } from '../utils/words-behind-lock';
import { copyWordsForAMinute } from '../utils/words-clipboard';
import { usePutAwayAfterLeave } from '../utils/words-put-away';
import { AddWordsForm } from './AddWordsForm';
import { AppLockSurface } from './AppLock';
import { CopyClearsNote, NoScreenCapture, NoScreenLockNote, WordsOutsideScreens } from './WordsOnScreen';

/**
 * The full-screen "Update required", mounted once at the root (app/_layout.tsx), outside the sign-in: it covers the
 * whole app, the lock screen included, and has no way past it into the community that set the floor but the store.
 * When it goes up, and when it never does, is utils/force-update.ts: only at a safe moment (a cold start, back after
 * five minutes away, or a switch of community), and only when the community says this build is below its floor and the
 * store has one that meets it.
 *
 * It holds that one community only, and its ways out depend on nothing that community answers
 * (utils/update-block-escape.ts): the other communities saved on the phone, one tap each; the member's 12 words, shown
 * (or added) here behind the phone's own lock; and leaving the community, done here on the phone. None of them goes
 * through a screen this covers, or reads the community's say on who is a member (#1415's re-review, BLOCKING).
 *
 * Above every screen and sheet, with a screen reader kept inside it. On Android a Modal, a window of its own; its back
 * button leaves the app rather than moving the screens hidden underneath. On iOS a FullWindowOverlay (react-native-screens),
 * a view added to the app's window above its screens: React Native's Modal is presented by the root view controller
 * (RCTModalHostViewComponentView presentViewController, RN 0.83), which cannot present while a sheet (post/[id],
 * propose-project, …) is already up, so a block raised after five minutes away with a sheet open would never have
 * appeared. App Lock's lock screen is drawn inside it on both (AppLockSurface; on Android through the Modal export,
 * components/AppLock.tsx), so the words shown here are never left above the lock.
 */

/** The phone's since-boot clock when it has one (counts while asleep); the wall clock otherwise, chosen once. */
const clock: () => number = bootClockMs() !== null ? () => bootClockMs() ?? Number.NaN : () => Date.now();

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function openStore() {
    const urls = Platform.OS === 'ios' ? STORE_URLS.ios : STORE_URLS.android;
    Linking.openURL(urls.app).catch(() => { Linking.openURL(urls.web).catch(() => {}); });
}

const WORDS_REASON = 'Confirm your security to view your recovery phrase.';
const LEAVE_REASON = 'Confirm authentication to leave this community on this phone.';
const LAST_LEAVE_REASON = 'Confirm authentication to take this account off this phone.';

/** What the block shows: its own screen, or one of the account's pages over it. */
type Page =
    | { kind: 'main' }
    | { kind: 'words'; words: string[] }
    | { kind: 'add-words' }
    | { kind: 'leave'; plan: BlockLeavePlan; words: string[] | null };

const reasonOf = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Please try again.');

/**
 * A page that draws the 12 words, or the boxes they are typed into: capture is blocked first, and only then is it drawn
 * (components/WordsOnScreen.tsx). On Android in a window opened after the block is in force, since a Modal takes the
 * no-capture flag from the app's window only as it opens (utils/words-on-screen.ts), and the block's own window opened
 * before it. On iOS in the block itself, which is in the app's window.
 */
function WordsWindow({ children, onClose, background }: { children: ReactNode; onClose: () => void; background: string }) {
    const page = <View style={[styles.fill, { backgroundColor: background }]} accessibilityViewIsModal>{children}</View>;
    return (
        <WordsOutsideScreens>
            <NoScreenCapture>
                {Platform.OS === 'android'
                    ? <Modal visible animationType="none" statusBarTranslucent onRequestClose={onClose}>{page}</Modal>
                    : page}
            </NoScreenCapture>
        </WordsOutsideScreens>
    );
}

export default function ForceUpdateBlock() {
    const { colors } = useTheme();
    const { identity, setIdentity } = useIdentity();
    const { recheck } = useNodeStatus();
    const [block, setBlock] = useState<{ version: string } | null>(null);
    const [others, setOthers] = useState<OtherCommunity[]>([]);
    const [switching, setSwitching] = useState<string | null>(null);
    const [switchError, setSwitchError] = useState<string | null>(null);
    const [page, setPage] = useState<Page>({ kind: 'main' });
    const [busy, setBusy] = useState(false);
    const [pageError, setPageError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [wordsAdded, setWordsAdded] = useState(false);
    /** Moves on whenever the words are put away, so a check still answering then shows nothing. */
    const turnRef = useRef(0);

    useEffect(() => {
        if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
        let mounted = true;
        const gate = createForceUpdateGate({
            now: clock,
            check: () => checkCommunityForUpdate({
                anchorUrl: () => AsyncStorage.getItem('beanpool_anchor_url'),
                fetchJson,
                localVersion: appConfig.expo.version,
                platform: Platform.OS,
            }),
            show: (next) => { if (mounted) setBlock(next); },
            // App Lock's own unlock prompt is not the member leaving (utils/force-update.ts).
            appLockPromptOpen: isAppLockPromptOpen,
            whenAppLockPromptsClose,
            // A door's prompt (the words, a payment) is the member leaving, even where it never changes AppState.
            doorPrompts,
        });
        void gate.start(AppState.currentState);
        const sub = AppState.addEventListener('change', (next) => { void gate.appStateChanged(next); });
        const stopSwitches = onCommunitySwitched(() => { void gate.communitySwitched(); });
        return () => {
            mounted = false;
            sub.remove();
            stopSwitches();
        };
    }, []);

    const toMain = useCallback(() => {
        turnRef.current += 1;
        setPage({ kind: 'main' });
        setPageError(null);
        setCopied(false);
        setWordsAdded(false);
    }, []);

    // The other communities on this phone, read from the phone each time the block goes up. Down: every page goes.
    useEffect(() => {
        if (!block) { toMain(); return; }
        let current = true;
        setSwitchError(null);
        otherCommunitiesOnPhone().then((list) => { if (current) setOthers(list); });
        return () => { current = false; };
    }, [block, toMain]);

    // Words on screen are put away when the member comes back after 15 seconds or more away, as everywhere else.
    const wordsShown = page.kind === 'words' || (page.kind === 'leave' && page.words !== null);
    usePutAwayAfterLeave(wordsShown, toMain);
    /** A page drawn in a WordsWindow: the words, or the boxes they are typed into. */
    const wordsPage = wordsShown || page.kind === 'add-words';

    const showing = !!block;

    useEffect(() => {
        if (!showing || Platform.OS !== 'android') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            BackHandler.exitApp();
            return true;
        });
        return () => sub.remove();
    }, [showing]);

    if (!block) return null;
    const store = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';

    const switchTo = async (c: OtherCommunity) => {
        if (switching || busy) return;
        setSwitching(c.url);
        setSwitchError(null);
        try {
            // Takes the block down and asks `c` at once (utils/community-switch.ts); then through Welcome, as the
            // BeanPool sheet switches, once `c` has said whether it knows this key (not the community left).
            await switchFromUpdateBlock(c.url);
            await recheck().catch(() => 'unknown');
            if (router.canDismiss()) router.dismissAll();
            router.replace('/welcome');
        } catch (e) {
            setSwitchError(`Couldn't switch to ${c.name}. ${reasonOf(e)}`);
        } finally {
            setSwitching(null);
        }
    };

    /** The 12 words, behind the phone's lock, read from this phone's key store: nothing is asked of any community. */
    const showWords = async () => {
        if (busy) return;
        setBusy(true);
        setPageError(null);
        const turn = ++turnRef.current;
        try {
            const words = await readWordsBehindLock(identity, WORDS_REASON);
            if (!words || turn !== turnRef.current) return;
            setPage({ kind: 'words', words });
            await AsyncStorage.setItem('beanpool_identity_backed_up', 'true').catch(() => {});
        } catch (e) {
            setPageError(`Couldn't read your 12 words. ${reasonOf(e)}`);
        } finally {
            setBusy(false);
        }
    };

    const copyWords = async (words: string[]) => {
        await copyWordsForAMinute(words.join(' ')).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    /** "Leave this community": what it will do, read from the phone alone. */
    const openLeave = async () => {
        if (busy) return;
        setPageError(null);
        try {
            setPage({ kind: 'leave', plan: await planLeaveFromUpdateBlock(), words: null });
        } catch (e) {
            setPageError(`Couldn't open Leave this community. ${reasonOf(e)}`);
        }
    };

    /** The last community, with words: they are shown first, behind the phone's lock, which is also the leave's check. */
    const showWordsBeforeLeaving = async (plan: BlockLeavePlan) => {
        if (busy) return;
        setBusy(true);
        setPageError(null);
        const turn = ++turnRef.current;
        try {
            const words = await readWordsBehindLock(identity, LAST_LEAVE_REASON);
            if (!words || turn !== turnRef.current) return;
            setPage({ kind: 'leave', plan, words });
        } catch (e) {
            setPageError(`Couldn't read your 12 words. ${reasonOf(e)}`);
        } finally {
            setBusy(false);
        }
    };

    /**
     * Leaves. `checked`: the phone's lock already passed on this page (the words shown before the last leave). With no
     * account on the phone there is nothing for the lock to protect, and nothing is asked.
     */
    const leave = async (plan: BlockLeavePlan, checked: boolean) => {
        if (busy) return;
        setBusy(true);
        setPageError(null);
        try {
            if (identity && !checked && !(await authenticateUser(plan.next ? LEAVE_REASON : LAST_LEAVE_REASON))) return;
            const left = await leaveFromUpdateBlock(identity ?? null, plan);
            if (left.kind === 'signed-out') {
                setIdentity(null);
                return;
            }
            // Down already (the switch, or no community at all); into the next community through Welcome, once it has said
            // whether it knows this key, or to Welcome for another invite.
            await recheck().catch(() => 'unknown');
            if (router.canDismiss()) router.dismissAll();
            router.replace('/welcome');
        } catch (e) {
            setPageError(`Couldn't leave ${plan.hereName}. ${reasonOf(e)}`);
        } finally {
            setBusy(false);
        }
    };

    const secondary = [styles.secondaryButton, { borderColor: colors.border.default, backgroundColor: colors.surface.app }];
    const card = [styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }];
    const errorLine = pageError && (
        <Text style={[styles.small, { color: colors.feedback.danger.solid, marginTop: 8 }]} accessibilityLiveRegion="polite">
            {pageError}
        </Text>
    );
    const backButton = (label = 'Back') => (
        <Pressable onPress={toMain} disabled={busy} accessibilityRole="button" style={secondary}>
            <Text style={[styles.secondaryText, { color: colors.text.heading }]}>{label}</Text>
        </Pressable>
    );
    // Only ever drawn inside a WordsWindow; held here too, so the words can never be drawn without the block.
    const wordGrid = (words: string[]) => (
        <View style={[styles.wordsBox, { backgroundColor: colors.surface.app, borderColor: colors.border.default }]}>
            <WordsOutsideScreens>
                <NoScreenCapture>
                {words.map((w, i) => (
                    <View key={`${w}-${i}`} style={styles.word} accessible accessibilityLabel={`Word ${i + 1}: ${w}`}>
                        <Text style={[styles.wordText, { color: colors.text.heading }]}>{i + 1}. {w}</Text>
                    </View>
                ))}
                </NoScreenCapture>
            </WordsOutsideScreens>
        </View>
    );
    const pageScroll = (children: ReactNode) => (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            <View style={card}>{children}</View>
        </ScrollView>
    );
    /**
     * The page with boxes to type in (Add my 12 words): it keeps the focused box and the rows below it above the keyboard,
     * as Settings does for the same form. A plain ScrollView can't on Android: the page is in an edge-to-edge Modal,
     * whose window the keyboard no longer shrinks from Android 11 on, and automaticallyAdjustKeyboardInsets is iOS only
     * (#1415's third deciding review). The app's one KeyboardProvider (app/_layout.tsx) already hears the keyboard in a
     * Modal's window: never a second one in here, which stops keyboard avoidance across the app
     * (react-native-keyboard-controller's ModalAttachedWatcher holds the dialog's one dismiss listener).
     */
    const typingPageScroll = (children: ReactNode) => (
        <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" bottomOffset={16}>
            <View style={card}>{children}</View>
        </KeyboardAwareScrollView>
    );

    let pageView: ReactNode = null;
    if (page.kind === 'words') {
        pageView = (
            <WordsWindow onClose={toMain} background={colors.surface.app}>
                {pageScroll(<>
                    <Text accessibilityRole="header" style={[styles.subtitle, { color: colors.text.heading }]}>Your 12 words</Text>
                    <Text style={[styles.small, { color: colors.feedback.danger.solid, fontWeight: '700' }]}>
                        Never share them with anyone. Write them down on paper and keep it somewhere safe.
                    </Text>
                    {wordGrid(page.words)}
                    <Pressable onPress={() => { void copyWords(page.words); }} accessibilityRole="button" style={secondary}>
                        <Text style={[styles.secondaryText, { color: colors.text.heading }]}>{copied ? 'Copied' : 'Copy words'}</Text>
                    </Pressable>
                    <CopyClearsNote style={[styles.small, { color: colors.text.secondary, marginTop: 8 }]} />
                    <NoScreenLockNote style={[styles.small, { color: colors.text.secondary, marginTop: 4 }]} />
                    {backButton('Hide them')}
                </>)}
            </WordsWindow>
        );
    } else if (page.kind === 'add-words') {
        pageView = (
            <WordsWindow onClose={toMain} background={colors.surface.app}>
                {typingPageScroll(wordsAdded ? (
                    <>
                        <Text style={[styles.body, { color: colors.feedback.success.fg }]} accessibilityLiveRegion="polite">
                            Your 12 words are on this phone again.
                        </Text>
                        {backButton()}
                    </>
                ) : (
                    <AddWordsForm
                        colors={colors}
                        onCancel={toMain}
                        onAdded={(updated) => { setIdentity(updated); setWordsAdded(true); }}
                    />
                ))}
            </WordsWindow>
        );
    } else if (page.kind === 'leave') {
        const { plan } = page;
        const leaveButton = (label: string, checked: boolean) => (
            <Pressable onPress={() => { void leave(plan, checked); }} disabled={busy} accessibilityRole="button" style={secondary}>
                <Text style={[styles.secondaryText, { color: colors.feedback.danger.solid }]}>{busy ? 'Leaving…' : label}</Text>
            </Pressable>
        );
        const body = !identity ? (
            <>
                <Text style={[styles.body, { color: colors.text.body }]}>
                    You haven't joined {plan.hereName} from this phone. Leaving forgets it here
                    {plan.next ? `, and the app opens ${plan.next.name}.` : ', so you can use another invite.'}
                </Text>
                {leaveButton(`Leave ${plan.hereName}`, false)}
            </>
        ) : plan.next ? (
            <>
                <Text style={[styles.body, { color: colors.text.body }]}>
                    This phone forgets {plan.hereName}: its copy on this phone goes, and the app opens {plan.next.name}.
                    Your account, your 12 words and your other communities stay on this phone.
                </Text>
                <Text style={[styles.small, { color: colors.text.secondary }]}>
                    Nothing is deleted at {plan.hereName}. You can come back with an invite or your 12 words.
                </Text>
                {leaveButton(`Leave ${plan.hereName}`, false)}
            </>
        ) : page.words ? (
            <>
                <Text style={[styles.subtitle, { color: colors.text.heading }]}>Write these 12 words down first</Text>
                <Text style={[styles.small, { color: colors.text.secondary }]}>
                    They are the only way back into this account, apart from a linked sign-in on a community that holds a
                    recovery piece for you.
                </Text>
                {wordGrid(page.words)}
                <NoScreenLockNote style={[styles.small, { color: colors.text.secondary, marginTop: 4 }]} />
                {leaveButton("I've written them down: leave", true)}
            </>
        ) : (
            <>
                <Text style={[styles.body, { color: colors.text.body }]}>
                    {plan.hereName} is the only community on this phone, so leaving it takes your account off this phone, as
                    Sign Out does. Nothing is deleted at {plan.hereName}.
                </Text>
                {hasMnemonic(identity) ? (
                    <Pressable onPress={() => { void showWordsBeforeLeaving(plan); }} disabled={busy} accessibilityRole="button" style={secondary}>
                        <Text style={[styles.secondaryText, { color: colors.text.heading }]}>Show my 12 words first</Text>
                    </Pressable>
                ) : (
                    <>
                        <Text style={[styles.small, { color: colors.feedback.danger.solid }]}>{noWordsBeforeWipe()}</Text>
                        {leaveButton('Take my account off this phone', false)}
                    </>
                )}
            </>
        );
        const content = pageScroll(<>
            <Text accessibilityRole="header" style={[styles.subtitle, { color: colors.text.heading }]}>Leave {plan.hereName}?</Text>
            {body}
            {errorLine}
            {backButton('Cancel')}
        </>);
        pageView = page.words
            ? <WordsWindow onClose={toMain} background={colors.surface.app}>{content}</WordsWindow>
            : content;
    }

    const main = (
        <ScrollView contentContainerStyle={styles.scroll}>
            <View style={card}>
                <Text style={styles.icon} accessibilityElementsHidden importantForAccessibility="no">⬆️</Text>
                <Text accessibilityRole="header" style={[styles.title, { color: colors.text.heading }]}>
                    Update required
                </Text>
                <Text style={[styles.body, { color: colors.text.body }]}>
                    Your community needs a newer BeanPool than the one on this phone ({appConfig.expo.version}).
                    Version {block.version} is waiting in {store}.
                </Text>
                <Text style={[styles.body, { color: colors.text.secondary }]}>
                    Updating keeps your account and everything on this phone.
                </Text>
                <Pressable
                    onPress={openStore}
                    accessibilityRole="button"
                    accessibilityLabel={`Update BeanPool in ${store}`}
                    style={({ pressed }) => [styles.button, { backgroundColor: pressed ? colors.brand.dark : colors.brand.primary }]}
                >
                    <Text style={[styles.buttonText, { color: colors.text.inverse }]}>Update</Text>
                </Pressable>
                <Text style={[styles.hint, { color: colors.text.secondary }]}>
                    Can't update? Ask the people who run your community.
                </Text>
            </View>

            {others.length > 0 && (
                <View style={[...card, styles.next]}>
                    <Text accessibilityRole="header" style={[styles.subtitle, { color: colors.text.heading }]}>
                        Use another community
                    </Text>
                    <Text style={[styles.small, { color: colors.text.secondary }]}>
                        This update is for this community only. Your other communities on this phone are still yours.
                    </Text>
                    {others.map((c) => (
                        <Pressable
                            key={c.url}
                            onPress={() => { void switchTo(c); }}
                            disabled={switching !== null}
                            accessibilityRole="button"
                            accessibilityLabel={`Use ${c.name}`}
                            accessibilityState={{ disabled: switching !== null, busy: switching === c.url }}
                            style={[...secondary, switching !== null && switching !== c.url && styles.dimmed]}
                        >
                            <Text style={[styles.secondaryText, { color: colors.text.heading }]}>
                                {switching === c.url ? `Opening ${c.name}…` : c.name}
                            </Text>
                        </Pressable>
                    ))}
                    {switchError && (
                        <Text style={[styles.small, { color: colors.feedback.danger.solid, marginTop: 8 }]} accessibilityLiveRegion="polite">
                            {switchError}
                        </Text>
                    )}
                </View>
            )}

            {!identity && (
                <View style={[...card, styles.next]}>
                    <Pressable onPress={() => { void openLeave(); }} disabled={busy} accessibilityRole="button" style={secondary}>
                        <Text style={[styles.secondaryText, { color: colors.feedback.danger.solid }]}>
                            Leave this community
                        </Text>
                    </Pressable>
                    {page.kind === 'main' && errorLine}
                </View>
            )}

            {identity && (
                <View style={[...card, styles.next]}>
                    <Text accessibilityRole="header" style={[styles.subtitle, { color: colors.text.heading }]}>
                        Your account
                    </Text>
                    <Text style={[styles.small, { color: colors.text.secondary }]}>
                        Your account is yours, not the community's. You can still see your 12 words, or leave this community.
                    </Text>
                    {hasMnemonic(identity) ? (
                        <Pressable onPress={() => { void showWords(); }} disabled={busy} accessibilityRole="button" style={secondary}>
                            <Text style={[styles.secondaryText, { color: colors.text.heading }]}>See my 12 words</Text>
                        </Pressable>
                    ) : (
                        <Pressable onPress={() => { setPageError(null); setPage({ kind: 'add-words' }); }} accessibilityRole="button" style={secondary}>
                            <Text style={[styles.secondaryText, { color: colors.text.heading }]}>Add my 12 words to this phone</Text>
                        </Pressable>
                    )}
                    <Pressable onPress={() => { void openLeave(); }} disabled={busy} accessibilityRole="button" style={secondary}>
                        <Text style={[styles.secondaryText, { color: colors.feedback.danger.solid }]}>
                            Leave this community
                        </Text>
                    </Pressable>
                    {page.kind === 'main' && errorLine}
                </View>
            )}
        </ScrollView>
    );

    const screen = (
        <View style={[styles.fill, { backgroundColor: colors.surface.app }]} accessibilityViewIsModal>
            {/* A page in a window of its own (Android, the words) leaves the block's screen under it; any other replaces it. */}
            {page.kind === 'main' || (Platform.OS === 'android' && wordsPage) ? main : null}
            {pageView}
        </View>
    );

    if (Platform.OS === 'ios') {
        // App Lock's lock screen inside it, as every pop-up has it (components/AppLock.tsx): on an iPhone this is above
        // the screens, and so above the lock screen they draw.
        return (
            <FullWindowOverlay unstable_accessibilityContainerViewIsModal>
                <AppLockSurface>{screen}</AppLockSurface>
            </FullWindowOverlay>
        );
    }
    return (
        <Modal visible animationType="fade" statusBarTranslucent onRequestClose={() => BackHandler.exitApp()}>
            {screen}
        </Modal>
    );
}

const styles = StyleSheet.create({
    fill: { ...StyleSheet.absoluteFillObject },
    scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
    card: { width: '100%', maxWidth: 360, borderRadius: 20, borderWidth: 1, paddingVertical: 28, paddingHorizontal: 20, alignItems: 'center' },
    icon: { fontSize: 40, marginBottom: 12 },
    title: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
    body: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 12 },
    button: { alignSelf: 'stretch', minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 16, marginTop: 8 },
    buttonText: { fontSize: 16, fontWeight: '700' },
    hint: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 16 },
    next: { marginTop: 16, alignItems: 'stretch' },
    subtitle: { fontSize: 17, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
    small: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 4 },
    secondaryButton: { alignSelf: 'stretch', minHeight: 48, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 12, marginTop: 10 },
    secondaryText: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
    dimmed: { opacity: 0.5 },
    wordsBox: { alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap', gap: 6, borderRadius: 12, borderWidth: 1, padding: 12, marginTop: 8 },
    word: { width: '45%', minHeight: 24, justifyContent: 'center' },
    wordText: { fontSize: 13, fontWeight: '600' },
});
