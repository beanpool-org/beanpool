import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { StatusBar } from 'expo-status-bar';
import { useRouter, ErrorBoundary } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { t } from '@beanpool/core';

export { ErrorBoundary };
import { useIdentity } from './IdentityContext';
import { useNodeStatus } from './NodeStatusContext';
import { normalizeNodeUrl, looksLikeNodeAddress, assertPlainNodeAddress } from '../utils/node-url';
import { getSavedNodes, type SavedNode } from '../utils/nodes';
import { SavedNodePicker } from '../components/SavedNodePicker';
import { hasMnemonic } from '../utils/identity';
import { readWordsBehindLock } from '../utils/words-behind-lock';
import { usePutAwayAfterLeave } from '../utils/words-put-away';
import { authenticateUser } from '../utils/LocalAuth';
import { deleteAccountFromThisPhone } from '../utils/account-leaves-phone';
import {
    NO_OTHER_COMMUNITY_LINE, SIGN_OUT_FROM_SETTINGS_LINE, deletePlanFailedLine, otherCommunitiesKeeping, stillKeptLine,
    type KeptCommunity,
} from '../utils/delete-here';
import { requestSync } from '../services/pillar-sync';
import { askBeforeSwitch } from '../utils/reconnect';
import { CLOSED_ACCOUNT_DELETE, mismatchPlan, inviteFromText } from '../utils/mismatch-plan';
import { GLOBAL_NODE_URL, checkGlobalDoor, fetchNodeProfile, getCachedNodeProfile, wordsDoorOn, type NodeProfile } from '../utils/node-profile';
import { isGlobalCommunity } from '../utils/global-join-existing';
import { doorStateFromCheck, type GlobalDoorState } from '../utils/global-entry';
import { useGlobalEntry } from '../utils/use-global-entry';
import { communityName } from '../utils/community-name';
import { joinAnotherCommunity, joinedNudge, PROTECT_REDIRECT, HOME_REDIRECT } from '../utils/join-another-community';
import { NoWordsNotice } from '../components/NoWordsNotice';
import { NoScreenCapture, NoScreenLockNote } from '../components/WordsOnScreen';
import { noWordsBeforeWipe } from '../utils/no-words-copy';
import { palette, type AppColors } from '../constants/colors';
import { useOnboardingColors } from './ThemeContext';

/**
 * Shown when the active community is reachable but definitively does NOT recognise this identity as a member, or has
 * closed its account there. We keep the identity (the keys and 12-word phrase are valid). Routed to from the root layout
 * when NodeStatus recognition is 'stranger' or 'closed'.
 *
 * The screen asks the community it reached what it is (its profile) and draws one of four pages (utils/mismatch-plan.ts,
 * DESIGN-global-entry-fable.md §C): an open door (the global community: being a stranger is normal before joining, so
 * the first action is Join with this account), an invite door (a wrong address, or not joined yet: the saved
 * communities, another address, an invite), a private preview (its sentence and an owner's invite), or a closed account.
 *
 * Reconnect and the saved-community picker ask the community first (utils/reconnect.ts) and move the phone only for a
 * member, or a guest visit it chose. A refusal writes nothing: the page is drawn for THAT community with the phone still
 * on the one it came from (decision 4, Damo's case).
 */
export default function NodeMismatchScreen() {
    const { colors, dark } = useOnboardingColors();
    const styles = useMemo(() => makeStyles(colors, dark), [colors, dark]);
    const router = useRouter();
    const { identity, setIdentity } = useIdentity();
    const { nodeUrl, recognition, recheck } = useNodeStatus();
    const [input, setInput] = useState(nodeUrl || '');
    const [loading, setLoading] = useState(false);
    // The delete asks each community to stop the push alerts first, which can take a few seconds (UNREGISTER_TIMEOUT_MS):
    // nothing else on the screen may start meanwhile.
    const [deleting, setDeleting] = useState(false);
    const [checking, setChecking] = useState(false);
    const [joiningInvite, setJoiningInvite] = useState(false);
    const busy = loading || deleting || checking || joiningInvite;
    const [error, setError] = useState<string | null>(null);

    // nodeUrl can resolve after first render; prefill once it's known.
    useEffect(() => { if (nodeUrl && !input) setInput(nodeUrl); }, [nodeUrl]);

    // The communities this device already knows about. Landing here almost always means
    // the member is anchored to the wrong one of these, so offering the list is a far
    // better first move than asking them to retype an address — and it is the difference
    // between one tap and reaching for the destructive option.
    // Words are revealed in-place before the wipe is offered. The previous dialog
    // asserted that the 12-word phrase would restore the account, which is only true if
    // the member was ever shown it and wrote it down — so show it instead of claiming it.
    const [words, setWords] = useState<string[] | null>(null);
    const [showWipe, setShowWipe] = useState(false);
    // The words drawn before the delete go with its panel, as its Cancel takes them, when the member comes back to the app
    // after 15 seconds or more away, App Lock on or off: the next tap asks the phone's lock again.
    const putWipeWordsAway = useCallback(() => { setShowWipe(false); setWords(null); }, []);
    usePutAwayAfterLeave(words !== null, putWipeWordsAway);
    const lockBusyRef = useRef(false);
    // The delete takes the key off this phone only when no saved community keeps it (delete-here.ts): asked at each
    // tap, before the lock (`checking`). One that does is where the member is sent instead, and nothing is removed.
    const [keptBy, setKeptBy] = useState<KeptCommunity[] | null>(null);

    const [savedNodes, setSavedNodes] = useState<SavedNode[]>([]);
    useEffect(() => {
        getSavedNodes().then(setSavedNodes).catch(() => {});
    }, [nodeUrl]);
    const otherNodes = useMemo(() => savedNodes.filter((n) => n.url !== nodeUrl), [savedNodes, nodeUrl]);

    // What the community in use is: this phone's copy at once, then the community's own answer (§C.1).
    const [here, setHere] = useState<{ profile: NodeProfile | null; reachable: boolean }>({ profile: null, reachable: false });
    useEffect(() => {
        if (!nodeUrl) return;
        let alive = true;
        getCachedNodeProfile(nodeUrl)
            .then((p) => { if (alive && p) setHere((h) => (h.reachable ? h : { profile: p, reachable: false })); })
            .catch(() => {});
        fetchNodeProfile(nodeUrl)
            .then((p) => { if (alive && p) setHere({ profile: p, reachable: true }); })
            .catch(() => {});
        return () => { alive = false; };
    }, [nodeUrl]);

    // The community the page is about: the one in use, or one that a Reconnect (or a saved pick) asked and that said no.
    // The phone is still on the one in use then: nothing was written.
    const [asked, setAsked] = useState<{ url: string; answer: 'stranger' | 'closed'; profile: NodeProfile | null; reachable: boolean } | null>(null);
    const pageUrl = asked?.url ?? nodeUrl;
    const pageIsGlobal = isGlobalCommunity(pageUrl);
    const plan = mismatchPlan({
        recognition: asked ? asked.answer : recognition === 'closed' ? 'closed' : 'stranger',
        profile: asked ? asked.profile : here.profile,
        reachable: asked ? asked.reachable : here.reachable,
        // The door screen (join-global.tsx) is the global community's alone until slice P5.
        doorScreenTakes: pageIsGlobal,
    });
    const nameOf = (url: string | null) => {
        const saved = savedNodes.find((n) => n.url === url);
        return communityName({ url, alias: saved?.alias });
    };
    const pageName = pageIsGlobal ? t('the global community') : nameOf(pageUrl);

    // The address field is folded on the open page, where a stranger has every reason to be, and on the closed page, whose
    // answer is about the account, not the address (§C.1, §C.3).
    const [addressUnfolded, setAddressUnfolded] = useState(false);
    const addressShown = plan.page === 'invite' || plan.page === 'preview' || addressUnfolded;

    // The global community, offered on the other pages as the sheet will offer it (§B), state-labelled. Not on a page about
    // the global community itself. Its door is asked fresh here: this screen may be drawn with no network, and a failure
    // must read as "can't reach it", never vanish (no-domain-lock-in: everything else on the screen works without it).
    const offerGlobalRow = plan.page !== 'open' && !pageIsGlobal && !otherNodes.some((n) => isGlobalCommunity(n.url));
    const [globalDoor, setGlobalDoor] = useState<{ state: GlobalDoorState; wordsDoor: boolean }>({ state: 'unknown', wordsDoor: false });
    const askGlobalDoor = useCallback(() => {
        setGlobalDoor((d) => ({ ...d, state: 'unknown' }));
        checkGlobalDoor(GLOBAL_NODE_URL)
            .then((c) => setGlobalDoor({ state: doorStateFromCheck(c), wordsDoor: c.ok && wordsDoorOn(c.profile.features) }))
            .catch(() => setGlobalDoor({ state: 'unreachable', wordsDoor: false }));
    }, []);
    useEffect(() => { if (offerGlobalRow && identity) askGlobalDoor(); }, [offerGlobalRow, !!identity, askGlobalDoor]);
    const globalEntry = useGlobalEntry(offerGlobalRow, globalDoor.state);

    async function handleReconnect() {
        const url = normalizeNodeUrl(input);
        if (!url || !looksLikeNodeAddress(url)) {
            setError(t("That address doesn't look right. Use something like node.yourcommunity.org"));
            return;
        }
        await switchToNode(url);
    }

    async function switchToNode(url: string) {
        if (!identity?.privateKey) return;
        setLoading(true);
        setError(null);
        try {
            // Only a plain host[:port] becomes the phone's community (utils/node-url.ts); refused before anything moves.
            assertPlainNodeAddress(url);
            // Asked first (utils/reconnect.ts): the phone moves only for a member, or a guest visit it chose. Any other
            // answer writes nothing (decision 4): not the community in use, not its database, not the saved list.
            const answer = await askBeforeSwitch(url, { publicKey: identity.publicKey, privateKey: identity.privateKey });
            if (answer.kind === 'member' || answer.kind === 'guest') {
                await recheck();
                requestSync().catch(() => {});
                router.replace('/(tabs)');
            } else if (answer.kind === 'unreachable') {
                setError(t("Couldn't reach that community. Check the address and your connection, then try again."));
            } else if (url === nodeUrl) {
                setAsked(null);
                setHere({ profile: answer.profile, reachable: answer.reachable });
            } else {
                setAsked({ url, answer: answer.kind, profile: answer.profile, reachable: answer.reachable });
                setAddressUnfolded(false);
            }
        } catch (e: any) {
            setError(e?.message || t('Could not switch to that community.'));
        } finally {
            setLoading(false);
        }
    }

    // An invite (§C.1, the invite and preview pages): for the community a link names, else the one the page is about. The
    // join path every second community takes (join-another-community.ts): the phone moves there, redeems, and goes back
    // to the community it came from if the redeem fails.
    const [inviteText, setInviteText] = useState('');
    async function pasteInvite() {
        try {
            const pasted = ((await Clipboard.getStringAsync()) ?? '').trim();
            if (pasted) setInviteText(pasted);
        } catch {
            // Nothing pasted: the field takes typing too.
        }
    }
    async function joinWithInvite() {
        if (!identity) return;
        setError(null);
        let invite: { targetUrl: string; code: string } | null;
        try {
            invite = inviteFromText(inviteText, pageUrl);
        } catch (e: any) {
            setError(e?.message || t("That invite doesn't look right."));
            return;
        }
        if (!invite) return;
        setJoiningInvite(true);
        try {
            const joined = await joinAnotherCommunity({
                targetUrl: invite.targetUrl, code: invite.code, identity, returnUrl: nodeUrl,
                knownName: invite.targetUrl === pageUrl && !pageIsGlobal ? pageName : null,
            });
            await recheck().catch(() => 'unknown');
            setInviteText('');
            const nudge = joinedNudge(joined.name);
            Alert.alert(nudge.title, nudge.body, [
                { text: nudge.later, onPress: () => router.replace({ pathname: '/profile-setup', params: { redirect: HOME_REDIRECT } }) },
                // Only where each community keeps its own sign-in copy (a build without a key vault).
                ...(nudge.protect
                    ? [{ text: nudge.protect, onPress: () => router.replace({ pathname: '/profile-setup', params: { redirect: PROTECT_REDIRECT } }) }]
                    : []),
            ], { cancelable: false });
        } catch (e: any) {
            // The community's own words; the phone is back where it was (join-another-community.ts).
            setError(e?.message || t('Your join could not be completed. Please try again.'));
        } finally {
            setJoiningInvite(false);
        }
    }

    async function handleStartWipe() {
        if (lockBusyRef.current) return;
        lockBusyRef.current = true;
        try {
            // Another saved community that says the key is a member, or can't be asked, still needs it: the screen
            // offers to switch there instead, and takes nothing off the phone.
            setError(null);
            setChecking(true);
            let keeping: KeptCommunity[];
            try {
                keeping = identity?.publicKey ? await otherCommunitiesKeeping(nodeUrl, identity.publicKey) : [];
            } catch (e) {
                setError(deletePlanFailedLine(e instanceof Error ? e.message : String(e)));
                return;
            } finally {
                setChecking(false);
            }
            if (keeping.length > 0) {
                setKeptBy(keeping);
                return;
            }
            setKeptBy(null);
            // The phone's lock first, with the words or without, as Settings' Sign Out asks it before the same removal: a
            // check that does not pass opens nothing and reads nothing. An account with no words is the one that can't
            // come back, so it asks too (PR #1205 review 4112404471). With words, this is also the check before they show.
            if (hasMnemonic(identity)) {
                const w = await readWordsBehindLock(identity, 'Confirm authentication to delete this account from this phone.');
                if (!w) return;
                setWords(w);
            } else {
                if (!(await authenticateUser('Confirm authentication to delete this account from this phone.'))) return;
                setWords(null);
            }
            setShowWipe(true);
        } finally {
            lockBusyRef.current = false;
        }
    }

    function handleConfirmWipe() {
        const hasWords = hasMnemonic(identity);
        Alert.alert(
            'Delete this account from this phone?',
            hasWords
                ? "Only do this if you have written your 12 words down. They are the only way back in, " +
                  "apart from a sign-in account linked on a community that holds a recovery piece for you.\n\n" +
                  `${NO_OTHER_COMMUNITY_LINE}`
                : `${noWordsBeforeWipe()}\n\n${NO_OTHER_COMMUNITY_LINE}\n\n` +
                  "Switching communities is almost certainly what you want instead.",
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        setDeleting(true);
                        try {
                            // Its push alerts stop first, signed by its key while the phone still holds it.
                            await deleteAccountFromThisPhone(identity);
                            setIdentity(null);
                        } catch (e: any) {
                            Alert.alert('Delete Failed', e?.message || 'The account could not be deleted from this phone.');
                        } finally {
                            setDeleting(false);
                        }
                    },
                },
            ]
        );
    }

    // The page's words (§E). A page about a community the phone isn't on says so: nothing was changed.
    const title = plan.page === 'open' ? t("You're not a member here yet")
        : plan.page === 'closed' ? t('Your account in {name} was closed', { name: pageName })
        : t("This community doesn't recognise you");
    const body = plan.page === 'open'
        ? t('{name} lets anyone join. Your account is fine: join with it, or go back to one of your communities.', { name: pageIsGlobal ? t('The global community') : nameOf(pageUrl) })
        : plan.page === 'closed' ? t('You deleted it, or the community removed it. Your other communities are not affected.')
        : plan.page === 'preview' ? t('This community is in a private preview. Ask its owner for an invite.')
        : asked ? t("Your account is fine, but that community doesn't have you as a member. This usually means the address is wrong, or you haven't joined it yet.")
        : t("Your account is fine, but the community you're connected to doesn't have you as a member. This usually means the address is wrong, or you haven't joined it yet.");
    const emoji = plan.page === 'open' ? '🌍' : plan.page === 'closed' ? '🔒' : '🧭';

    // The global community's row (§B.3's words), on the invite, preview and closed pages.
    const globalLine: Record<string, string | null> = {
        join: globalDoor.wordsDoor ? t('Join with this account: 12 words or a sign-in') : t('Join with this account: a sign-in'),
        checking: t('Checking…'),
        unreachable: t("Can't reach it right now. Tap to try again."),
        closed: t('Not taking new members right now.'),
        preview: t('This community is in a private preview. Ask its owner for an invite.'),
        closedAccount: t('Your account there was closed.'),
        member: GLOBAL_NODE_URL.replace(/^https?:\/\//, ''),
        noAccount: null,
    };
    const globalTap = globalEntry === 'join' ? () => router.push('/join-global')
        : globalEntry === 'unreachable' ? askGlobalDoor
        : globalEntry === 'member' ? () => switchToNode(GLOBAL_NODE_URL)
        : undefined;

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style={dark ? 'light' : 'dark'} />
            <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
                <ScrollView contentContainerStyle={styles.scroll}>
                    <View style={styles.card}>
                        <Text style={styles.emoji}>{emoji}</Text>
                        <Text style={styles.title} accessibilityRole="header">{title}</Text>
                        <Text style={styles.body}>{body}</Text>

                        {pageUrl ? (
                            <View style={styles.currentBox}>
                                <Text style={styles.currentLabel}>{asked ? t('You asked about') : t('Currently connected to')}</Text>
                                <Text style={styles.currentUrl}>{pageUrl}</Text>
                                {asked && nodeUrl ? (
                                    <Text style={[styles.currentLabel, { marginTop: 6, marginBottom: 0 }]}>
                                        {t('Your phone is still on {community}. Nothing was changed.', { community: nameOf(nodeUrl) })}
                                    </Text>
                                ) : null}
                            </View>
                        ) : null}

                        {plan.page === 'open' && (
                            <Pressable
                                style={styles.primaryBtn}
                                onPress={() => router.push('/join-global')}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityLabel={t('Join with this account')}
                            >
                                <Text style={styles.primaryBtnText}>{t('Join with this account')}</Text>
                            </Pressable>
                        )}

                        <SavedNodePicker
                            nodes={otherNodes}
                            onPick={switchToNode}
                            disabled={busy}
                            label={t('Switch to one of your communities')}
                            actionLabel={t('Switch to')}
                            hint={addressShown ? t('Or enter a different address below.') : undefined}
                        />

                        {!addressShown ? (
                            <Pressable style={styles.linkBtn} onPress={() => setAddressUnfolded(true)} disabled={busy} accessibilityRole="button">
                                <Text style={styles.linkBtnText}>{t('Not this community? Enter another address')}</Text>
                            </Pressable>
                        ) : (
                            <>
                                <Text style={styles.inputLabel}>{t('Community address')}</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder="e.g. node.yourcommunity.org"
                                    placeholderTextColor={colors.text.muted}
                                    value={input}
                                    onChangeText={(v) => { setInput(v); setError(null); }}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="url"
                                    accessibilityLabel={t('Community address')}
                                />
                                <Text style={styles.hint}>{t('Not sure? Ask whoever invited you for the exact address.')}</Text>
                                <Pressable
                                    style={plan.page === 'open' ? styles.outlineBtn : styles.primaryBtn}
                                    onPress={handleReconnect}
                                    disabled={busy}
                                    accessibilityRole="button"
                                >
                                    {loading
                                        ? <ActivityIndicator color={plan.page === 'open' ? colors.text.secondary : colors.text.inverse} />
                                        : <Text style={plan.page === 'open' ? styles.outlineBtnText : styles.primaryBtnText}>{t('Reconnect')}</Text>}
                                </Pressable>
                            </>
                        )}

                        {(plan.page === 'invite' || plan.page === 'preview') && (
                            <View style={styles.inviteBox}>
                                <Text style={styles.inputLabel}>
                                    {plan.page === 'preview' ? t('Got an invite from its owner or an admin?') : t('Have an invite?')}
                                </Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder={t('Invite code or link')}
                                    placeholderTextColor={colors.text.muted}
                                    value={inviteText}
                                    onChangeText={(v) => { setInviteText(v); setError(null); }}
                                    autoCapitalize="characters"
                                    autoCorrect={false}
                                    accessibilityLabel={t('Invite code or link')}
                                />
                                <View style={styles.inviteActions}>
                                    <Pressable style={styles.outlineBtnSmall} onPress={pasteInvite} disabled={busy} accessibilityRole="button">
                                        <Text style={styles.outlineBtnText}>{t('Paste an invite')}</Text>
                                    </Pressable>
                                    <Pressable
                                        style={[styles.outlineBtnSmall, !inviteText.trim() && { opacity: 0.5 }]}
                                        onPress={joinWithInvite}
                                        disabled={busy || !inviteText.trim()}
                                        accessibilityRole="button"
                                    >
                                        {joiningInvite
                                            ? <ActivityIndicator color={colors.text.secondary} />
                                            : <Text style={styles.outlineBtnText}>{t('Join with this invite')}</Text>}
                                    </Pressable>
                                </View>
                            </View>
                        )}

                        {offerGlobalRow && globalLine[globalEntry] ? (
                            <Pressable
                                style={styles.globalRow}
                                onPress={globalTap}
                                disabled={busy || !globalTap}
                                accessibilityRole="button"
                                accessibilityLabel={t('Global community, {state}', { state: globalLine[globalEntry] ?? '' })}
                            >
                                <Text style={styles.globalIcon}>🌍</Text>
                                <View style={styles.globalText}>
                                    <Text style={styles.globalTitle}>{t('Global community')}</Text>
                                    <Text style={styles.globalSub} numberOfLines={2}>{globalLine[globalEntry]}</Text>
                                </View>
                                {globalTap ? <Text style={styles.globalChevron}>›</Text> : null}
                            </Pressable>
                        ) : null}

                        {error && <Text style={styles.error}>{error}</Text>}

                        {/* The community in use closed the account: its Delete account is the one request it still takes
                            from this key, and the only way to erase the profile a removal keeps (Settings deletes at the
                            community the phone is on, so not for one a Reconnect asked). */}
                        {plan.page === 'closed' && !asked && (
                            <View style={styles.closedDeleteBox}>
                                <Text style={styles.hint}>
                                    {t('If {name} removed you, it still keeps your profile, so a vote could bring you back. Deleting your account there erases it.', { name: pageName })}
                                </Text>
                                <Pressable
                                    style={styles.outlineBtn}
                                    onPress={() => router.push(CLOSED_ACCOUNT_DELETE)}
                                    disabled={busy}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.outlineBtnText}>{t('Delete my account at {name}', { name: pageName })}</Text>
                                </Pressable>
                            </View>
                        )}

                        {keptBy && keptBy.length > 0 && !showWipe && (
                            <View style={styles.keptBox} accessibilityLiveRegion="polite">
                                <Text style={styles.keptText}>🔑 {stillKeptLine(keptBy)}</Text>
                                <SavedNodePicker
                                    nodes={keptBy.map((c) => ({ url: c.url, alias: c.name }))}
                                    onPick={switchToNode}
                                    disabled={busy}
                                    label={keptBy.length === 1 ? 'Your community' : 'Your communities'}
                                    actionLabel="Switch to"
                                    hint={SIGN_OUT_FROM_SETTINGS_LINE}
                                />
                                <Pressable style={styles.secondaryBtn} onPress={() => setKeptBy(null)} disabled={busy} accessibilityRole="button">
                                    <Text style={styles.cancelWipeText}>Close</Text>
                                </Pressable>
                            </View>
                        )}

                        {!showWipe ? (
                            !keptBy?.length && (
                                <Pressable style={styles.secondaryBtn} onPress={handleStartWipe} disabled={busy} accessibilityRole="button">
                                    {checking
                                        ? <ActivityIndicator color={colors.text.secondary} />
                                        : <Text style={styles.secondaryBtnText}>Delete this account from this phone</Text>}
                                </Pressable>
                            )
                        ) : (
                            <View style={styles.wipeWrap}>
                                {words ? (
                                    <>
                                        <Text style={styles.wipeTitle}>Write these 12 words down first</Text>
                                        <Text style={styles.wipeBody}>
                                            They are the only way back into this account, apart from a linked
                                            sign-in on a community that holds a recovery piece for you.
                                        </Text>
                                        <View style={styles.wordsBox}>
                                            <NoScreenCapture>
                                            {words.map((w, i) => (
                                                <Text key={`${w}-${i}`} style={styles.word}>{i + 1}. {w}</Text>
                                            ))}
                                            </NoScreenCapture>
                                        </View>
                                        <NoScreenLockNote style={[styles.wipeBody, { marginTop: 8 }]} />
                                    </>
                                ) : (
                                    <>
                                        {/* No way on to Account Protection from here: this community doesn't know the member. */}
                                        <NoWordsNotice kind="before-wipe" />
                                        <Text style={[styles.wipeBody, { marginTop: 10 }]}>
                                            Switching communities above is almost certainly what you want instead.
                                        </Text>
                                    </>
                                )}
                                <Pressable style={styles.secondaryBtn} onPress={handleConfirmWipe} disabled={busy} accessibilityRole="button">
                                    {deleting
                                        ? <ActivityIndicator color={colors.text.secondary} />
                                        : <Text style={styles.secondaryBtnText}>{words ? "I've saved them — delete the account" : 'Delete the account anyway'}</Text>}
                                </Pressable>
                                <Pressable style={styles.secondaryBtn} onPress={() => { setShowWipe(false); setWords(null); }} disabled={busy} accessibilityRole="button">
                                    <Text style={styles.cancelWipeText}>Cancel</Text>
                                </Pressable>
                            </View>
                        )}
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

function makeStyles(colors: AppColors, dark: boolean) {
    return StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        wipeWrap: { marginTop: 4 },
        keptBox: {
            marginTop: 4, padding: 12, borderRadius: 12, borderWidth: 1,
            backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border,
        },
        keptText: { color: colors.text.body, fontSize: 14, lineHeight: 20, marginBottom: 12 },
        wipeTitle: { color: colors.text.heading, fontSize: 15, fontWeight: '700', marginBottom: 6 },
        wipeBody: { color: colors.text.secondary, fontSize: 13, lineHeight: 19, marginBottom: 10 },
        wordsBox: {
            flexDirection: 'row', flexWrap: 'wrap', gap: 6,
            backgroundColor: colors.surface.app, borderRadius: 12, padding: 12,
            borderWidth: 1, borderColor: colors.border.default, marginBottom: 12,
        },
        word: { color: colors.text.heading, fontSize: 13, fontWeight: '600', width: '45%' },
        cancelWipeText: { color: colors.text.secondary, fontSize: 14, textAlign: 'center', fontWeight: '600' },
        scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
        card: { backgroundColor: colors.surface.card, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default },
        emoji: { fontSize: 40, marginBottom: 8 },
        title: { fontSize: 22, fontWeight: 'bold', color: colors.text.heading, marginBottom: 10 },
        body: { fontSize: 15, color: dark ? colors.text.secondary : palette.gray600, lineHeight: 22, marginBottom: 20 },
        currentBox: { backgroundColor: colors.surface.subtle, borderRadius: 12, padding: 12, marginBottom: 20 },
        currentLabel: { fontSize: 12, color: colors.text.secondary, marginBottom: 2 },
        currentUrl: { fontSize: 15, color: colors.text.heading, fontWeight: '600' },
        inputLabel: { fontSize: 14, color: dark ? colors.text.body : palette.gray700, fontWeight: '600', marginBottom: 6 },
        input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 14, color: colors.text.heading, fontSize: 16, marginBottom: 8 },
        hint: { fontSize: 13, color: colors.text.secondary, lineHeight: 18, marginBottom: 16 },
        error: { color: colors.feedback.danger.fg, fontSize: 14, marginBottom: 16, lineHeight: 20 },
        primaryBtn: { backgroundColor: palette.blue600, borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 12 },
        primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: '600' },
        secondaryBtn: { padding: 14, alignItems: 'center' },
        secondaryBtnText: { color: colors.text.secondary, fontSize: 15, fontWeight: '500' },
        // The outlined buttons and the global row wrap their text at 320 dp and 1.3× font: no fixed heights, flex rows
        // that shrink their text, at least 48 dp to tap.
        outlineBtn: {
            borderRadius: 12, padding: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 12,
            borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card,
        },
        outlineBtnSmall: {
            flexGrow: 1, flexBasis: 120, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 12, minHeight: 48,
            alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card,
        },
        outlineBtnText: { color: colors.text.heading, fontSize: 15, fontWeight: '600', textAlign: 'center' },
        linkBtn: { minHeight: 48, justifyContent: 'center', paddingVertical: 10, marginBottom: 8 },
        linkBtnText: { color: dark ? colors.text.body : palette.blue600, fontSize: 15, fontWeight: '600' },
        inviteBox: { marginTop: 8, marginBottom: 8 },
        closedDeleteBox: { marginTop: 8 },
        inviteActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
        globalRow: {
            flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 12, paddingHorizontal: 14,
            marginTop: 8, marginBottom: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app,
        },
        globalIcon: { fontSize: 22 },
        globalText: { flex: 1, minWidth: 0 },
        globalTitle: { color: colors.text.heading, fontSize: 15, fontWeight: '700' },
        globalSub: { color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginTop: 2 },
        globalChevron: { color: colors.text.muted, fontSize: 22, fontWeight: '300' },
    });
}
