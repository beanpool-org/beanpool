import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Alert, Image, FlatList, BackHandler, Platform, AppState } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { hapticTick } from '../utils/haptics';
import { createIdentity, createIdentityFromMnemonic, loadIdentity, getMnemonic, hasMnemonic, BeanPoolIdentity } from '../utils/identity';
import { importIdentity } from '../utils/identity';
import { useIdentity } from './IdentityContext';
import { useNodeStatus } from './NodeStatusContext';
import {
    getPendingOnboarding, setPendingOnboarding, updatePendingOnboarding, clearPendingOnboarding,
} from '../utils/onboarding-state';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useGlobalSearchParams, router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as ImagePicker from 'expo-image-picker';
import { BUNDLED_AVATARS, BundledAvatar, resolveBundledAvatar } from '../utils/bundled-avatars';
import { AvatarPickerSheet } from '../components/AvatarPickerSheet';
import { KeeperProtectionPanel } from '../components/KeeperProtectionPanel';
import { SsoEnrolSheet } from '../components/SsoEnrolSheet';
import { FriendPickerSheet } from '../components/FriendPickerSheet';
import { GoogleButton, AppleButton, FacebookButton, GitHubButton, GoogleLogo, AppleLogo, FacebookLogo, GitHubLogo } from '../components/SsoButton';
import { enrolKeepers, type KeeperEnrolmentResult } from '../utils/keeper-enrolment';
import { protectionFrom } from '../utils/protection-state';
import { updateMemberProfile, fetchNodeCallsign, recordOnboardingEvent } from '../utils/db';
import { buildSignedHeaders, mnemonicToKeypair, validateMnemonic } from '../utils/crypto';
import { colors, palette } from '../constants/colors';
import { recoverAccountWithSso } from '../utils/sso-recovery';
import { type SsoProvider } from '../utils/sso-signin';


import { extractNodeOrigin, normaliseInviteCode } from '../utils/invite-parser';
import { normalizeNodeUrl, looksLikeNodeAddress, shouldBlockCleartextNodeUrl } from '../utils/node-url';
import { checkCallsignAvailable, suggestCallsigns } from '../utils/callsign-suggest';

// Some devices (custom ROMs, emulators) have no https handler — swallow the
// rejection rather than crash with an unhandled promise warning.
const openLink = (url: string) => Linking.openURL(url).catch((err) => console.warn('Failed to open URL', err));

// Friendly Step-1 rejection copy for a dud invite. Reasons come from
// /api/invite/check; anything unrecognised falls back to the generic line.
function inviteProblemMessage(reason?: string): string {
    switch (reason) {
        case 'used':
            return 'This invite has already been used — each one works exactly once. Ask whoever invited you to send a fresh one (it only takes them a minute).';
        case 'expired':
            return 'This invite has expired — invites last 30 days. Ask whoever invited you to send a fresh one (it only takes them a minute).';
        case 'unknown_inviter':
            return "This community doesn't know the person who made this invite. Double-check you're joining the right community, or ask for a fresh invite.";
        default:
            return "That invite wasn't recognised by your community. Double-check the code, or ask whoever invited you for a fresh one.";
    }
}

export default function WelcomeScreen() {
    const params = useGlobalSearchParams();
    const incomingUrl = Linking.useURL();
    const { setIdentity } = useIdentity();
    const { recheck: recheckNodeStatus } = useNodeStatus();
    const [mode, setMode] = useState<'home' | 'member' | 'create' | 'recover' | 'ssoRecover' | 'profileSetup' | 'seedBackup' | 'onboardingGuide' | 'confirmReplace'>('home');
    const [callsign, setCallsign] = useState('');
    // Fun-name suggestions shown when the chosen first-join name is taken on the node.
    const [callsignSuggestions, setCallsignSuggestions] = useState<string[]>([]);
    const [recoveryWords, setRecoveryWords] = useState<string[]>(Array(12).fill(''));
    const [recoveryAnchorUrl, setRecoveryAnchorUrl] = useState('');
    const [createAnchorUrl, setCreateAnchorUrl] = useState('');
    const [ssoCallsign, setSsoCallsign] = useState('');
    const [ssoProgressMessage, setSsoProgressMessage] = useState<string | null>(null);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingIdentity, setPendingIdentity] = useState<BeanPoolIdentity | null>(null);
    const [seedConfirmed, setSeedConfirmed] = useState(false);
    const [inviteCode, setInviteCode] = useState('');
    const [pendingInviteCode, setPendingInviteCode] = useState('');
    // Whether this identity's invite has already been redeemed on the node. Set once Step 1
    // succeeds, and restored from the persisted wizard record so it survives the app being
    // killed mid-join.
    const [inviteRedeemed, setInviteRedeemed] = useState(false);
    const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);
    const [showSsoSheet, setShowSsoSheet] = useState(false);
    const [ssoProvider, setSsoProvider] = useState<SsoProvider>(Platform.OS === 'ios' ? 'apple' : 'google');
    const [showFriendSheet, setShowFriendSheet] = useState(false);
    const [enrolment, setEnrolment] = useState<KeeperEnrolmentResult | null>(null);
    const [inviterName, setInviterName] = useState<string | null>(null);
    const [inviteCommunityName, setInviteCommunityName] = useState<string | null>(null);
    const [clipboardMayHaveInvite, setClipboardMayHaveInvite] = useState(false);
    const [seedCopied, setSeedCopied] = useState(false);

    // --- Identity-overwrite guard (recovering a DIFFERENT account onto a phone
    // that already holds one). Rare, but destructive: the phone can only hold one
    // identity, so restoring a different one replaces — and can orphan — the
    // current account. We force an explicit typed confirmation and offer to back
    // up the outgoing account's 12 words first so it can always be retrieved. ---
    const [outgoingIdentity, setOutgoingIdentity] = useState<BeanPoolIdentity | null>(null);
    const [pendingRecovery, setPendingRecovery] = useState<{ words: string[]; anchorUrl: string } | null>(null);
    const [replaceConfirmText, setReplaceConfirmText] = useState('');
    const [showOutgoingSeed, setShowOutgoingSeed] = useState(false);
    const [outgoingSeedCopied, setOutgoingSeedCopied] = useState(false);

    // The words themselves, for the two screens that draw them.
    //
    // Held in state because reading them is asynchronous. It does not have to be today —
    // the accessor just returns the field — but it will be once the words live in an
    // encrypted vault behind a biometric prompt, and a render function cannot await. Doing
    // this now means Phase C changes one function instead of every screen that shows words.
    const [pendingWords, setPendingWords] = useState<string[] | null>(null);
    const [outgoingWords, setOutgoingWords] = useState<string[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        getMnemonic(pendingIdentity).then(w => { if (!cancelled) setPendingWords(w); });
        return () => { cancelled = true; };
    }, [pendingIdentity]);

    useEffect(() => {
        let cancelled = false;
        getMnemonic(outgoingIdentity).then(w => { if (!cancelled) setOutgoingWords(w); });
        return () => { cancelled = true; };
    }, [outgoingIdentity]);

    // Count step 3 being drawn — once per join, not once per render.
    //
    // The variant is the keeper-count state from the design doc, and in Phase A it is
    // always 'C': the user's twelve words and nothing else. It is sent anyway rather than
    // left blank, so the day states A and B become reachable the dashboard already has the
    // shape to compare them against, instead of a cliff where the old rows have no variant.
    const protectionShownRef = useRef(false);

    /** Whether a covered member has asked to see the words anyway. Never hides them once shown. */
    const [revealWords, setRevealWords] = useState(false);
    const protection = protectionFrom(enrolment);

    /**
     * Split the words and hand out the pieces, on the way into step 3.
     *
     * The design has this happening silently right after redemption so the screen can REPORT a
     * result rather than ask for one. It runs here, on entering the step, rather than inside
     * handleCompleteProfile: a member who quits mid-wizard and resumes lands straight on this
     * screen without passing through that handler, and enrolling on arrival covers both routes.
     *
     * Nothing waits for it. `protectionFrom(null)` is the words screen, which is true whatever
     * happens next — so a hung request or a dead node leaves a member reading their twelve
     * words, not staring at a spinner to find out whether they are safe.
     */
    useEffect(() => {
        if (mode !== 'seedBackup' || !pendingIdentity || enrolment) return;
        let cancelled = false;
        enrolKeepers(pendingIdentity)
            .then(r => { if (!cancelled) setEnrolment(r); })
            .catch(e => {
                // enrolKeepers is documented never to throw. Caught anyway, because the cost of
                // being wrong is an unhandled rejection in the middle of somebody joining.
                console.warn('[keepers] enrolment threw, which it should not:', e);
                // Recorded as a failed result rather than left null (CR). Null is the "still
                // working" state, so leaving it there means `protection_shown` never fires and
                // this member is missing from the funnel entirely — the screen itself was always
                // correct, since no result reads as the words screen either way.
                if (!cancelled) {
                    setEnrolment({
                        enrolled: [], generation: null, skipped: [], available: 0,
                        error: e instanceof Error ? e.message : String(e),
                    });
                }
            });
        return () => { cancelled = true; };
    }, [mode, pendingIdentity, enrolment]);

    // Count step 3 being drawn — once per join, not once per render, and only once the state it
    // reports is settled. Reporting before enrolment answers would record every member as 'C'.
    useEffect(() => {
        if (mode !== 'seedBackup' || protectionShownRef.current || !enrolment) return;
        protectionShownRef.current = true;
        recordOnboardingEvent(
            'protection_shown',
            protection.state === 'covered' ? 'A' : protection.state === 'almost' ? 'B' : 'C',
        );
    }, [mode, enrolment, protection.state]);

    // The web trampoline copies the invite link to the clipboard before sending
    // people to the app store, but nothing can read it for them automatically —
    // so offer a one-tap paste on the home and join screens. hasStringAsync only
    // reports presence; the clipboard is READ solely on the user's tap, and on
    // iOS 16+ that tap lands on the system paste button (UIPasteControl), which
    // never shows the "Allow Paste" popup. Re-check on foreground so copying an
    // invite in another app and switching back makes the offer appear.
    React.useEffect(() => {
        if (mode !== 'home' && mode !== 'create') return;
        const check = () => {
            Clipboard.hasStringAsync()
                .then(has => setClipboardMayHaveInvite(!!has))
                .catch(() => setClipboardMayHaveInvite(false));
        };
        check();
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') check();
        });
        return () => sub.remove();
    }, [mode]);

    // Shared sink for pasted invite content however it arrives: the iOS system
    // paste button hands us the text directly, the fallback buttons read the
    // clipboard programmatically.
    async function applyInviteContent(raw: string, source: 'home' | 'join') {
        const content = raw?.trim() || '';
        const looksLikeInvite = content.startsWith('BP-') || content.startsWith('INV-') ||
            (content.includes('http') && content.includes('invite='));
        if (looksLikeInvite) {
            await processFullUrl(content);
            return;
        }
        if (source === 'home') {
            Alert.alert(
                'No invite found',
                "Your clipboard doesn't have a BeanPool invite on it. No worries — you can paste or type the code on the next screen.",
                [{ text: 'OK', onPress: () => setMode('create') }]
            );
            return;
        }
        // Join screen: a short single-line paste may be a plain code in a format
        // we don't recognise (e.g. legacy 6-char codes) — drop it in the field
        // and let handleCreate normalise it. Anything bigger clearly isn't an
        // invite, so say so instead of dumping it into the field.
        if (content && content.length <= 100 && !content.includes('\n')) {
            setInviteCode(content);
        } else {
            Alert.alert(
                'No invite found',
                'Your clipboard has something else on it. You can type or paste your invite code below instead.'
            );
        }
    }

    async function handleCheckClipboardInvite() {
        try {
            const content = (await Clipboard.getStringAsync())?.trim() || '';
            await applyInviteContent(content, 'home');
        } catch {
            setMode('create');
        }
    }

    const processFullUrl = useCallback(async (fullUrl: string) => {
        // extractNodeOrigin copes with the URL being buried in a shared message
        // ("Join my BeanPool community node: https://…") — an anchored match doesn't.
        const origin = extractNodeOrigin(fullUrl);
        if (origin) {
            setCreateAnchorUrl(origin);
        }
        const inviteMatch = fullUrl.match(/[?&]invite=([^&]+)/);
        if (inviteMatch) {
            setInviteCode(decodeURIComponent(inviteMatch[1]));
        } else if (!fullUrl.startsWith('http') && (fullUrl.startsWith('BP-') || fullUrl.startsWith('INV-'))) {
            setInviteCode(fullUrl);
        }
        setMode('create');
    }, []);

    const handlePasteInvite = async () => {
        try {
            const content = (await Clipboard.getStringAsync())?.trim() || '';
            if (!content) {
                Alert.alert("Nothing to paste", "Your clipboard is empty.");
                return;
            }
            await applyInviteContent(content, 'join');
        } catch (e) {
            Alert.alert("Failed to read clipboard", "Please try pasting the link manually.");
        }
    };

    React.useEffect(() => {
        AsyncStorage.getItem('beanpool_anchor_url').then(val => {
            if (val) {
                setCreateAnchorUrl(val);
                setRecoveryAnchorUrl(val);
            }
        });
        
        let mounted = true;

        const checkAutoIntercept = async () => {
            // Priority 1: Raw Expo Linking Intent (bypasses router segment hydration issues)
            if (incomingUrl) {
                const parsed = Linking.parse(incomingUrl);
                if (parsed.queryParams?.invite) {
                    if (mounted) {
                        if (incomingUrl.startsWith('http')) {
                            // Universal link - process fully
                            await processFullUrl(incomingUrl);
                        } else {
                            // Deep link (beanpool://)
                            setInviteCode(parsed.queryParams.invite as string);
                            if (parsed.queryParams.server) {
                                setCreateAnchorUrl(parsed.queryParams.server as string);
                            }
                            setMode('create');
                        }
                    }
                    return;
                }
            }

            // Priority 2: Standard Router Params
            if (params?.invite) {
                if (mounted) {
                    setInviteCode(params.invite as string);
                    if (params?.server) {
                        setCreateAnchorUrl(params.server as string);
                        setRecoveryAnchorUrl(params.server as string);
                    }
                    setMode('create');
                }
                return;
            }

            // Priority 3 (Android, once ever): Play Install Referrer. An invite
            // link tapped WITHOUT the app installed detours via the Play Store;
            // the web trampoline packs invite+server into the store link's
            // `referrer` param, which Google hands us here on first launch — so
            // the invite survives the install with no clipboard or retyping.
            if (Platform.OS === 'android') {
                const alreadyChecked = await AsyncStorage.getItem('beanpool_install_referrer_checked');
                if (!alreadyChecked) {
                    try {
                        const Application = await import('expo-application');
                        const referrer = await Application.getInstallReferrerAsync();
                        await AsyncStorage.setItem('beanpool_install_referrer_checked', 'true');
                        const inviteMatch = referrer?.match(/(?:^|&)invite=([^&]+)/);
                        if (inviteMatch && mounted) {
                            setInviteCode(decodeURIComponent(inviteMatch[1]));
                            const serverMatch = referrer.match(/(?:^|&)server=([^&]+)/);
                            const server = serverMatch ? decodeURIComponent(serverMatch[1]) : '';
                            // Same trust rule as deep links: never accept a
                            // cleartext-public node origin from an outside source.
                            if (server && !shouldBlockCleartextNodeUrl(server)) {
                                setCreateAnchorUrl(server);
                            }
                            setMode('create');
                        }
                    } catch {
                        // No Play Services (emulator, de-Googled device) — the
                        // clipboard offer below is the fallback. Left unchecked
                        // so a transient failure can retry on the next visit.
                    }
                }
            }
        };

        checkAutoIntercept();

        return () => { mounted = false; };
    }, [params?.invite, params?.t, incomingUrl]);

    // Resume a join wizard that was interrupted after the keypair was created
    // (Step 1). A fresh incoming invite link outranks a stale half-done wizard,
    // UNLESS the incoming link is for the exact invite code already in progress.
    React.useEffect(() => {
        let mounted = true;
        (async () => {
            const pending = await getPendingOnboarding();
            if (!pending || !mounted) return;
            const incomingInvite = params?.invite || (incomingUrl && incomingUrl.includes('invite='));
            if (incomingInvite && pending.inviteCode !== params?.invite) return;
            const stored = await loadIdentity();
            if (!stored) {
                // Keypair never made it to storage — nothing to resume.
                await clearPendingOnboarding();
                return;
            }
            if (!mounted) return;
            setCallsign(pending.callsign || stored.callsign);
            setInviteCode(pending.inviteCode);
            setPendingInviteCode(pending.inviteCode);
            setInviteRedeemed(pending.redeemed === true);
            if (pending.anchorUrl) setCreateAnchorUrl(pending.anchorUrl);
            if (pending.avatar) setPendingAvatar(pending.avatar);
            if (pending.step !== 'create') setPendingIdentity(stored);
            setMode(pending.step);
        })();
        return () => { mounted = false; };
    }, [params?.invite, incomingUrl]);

    async function handleCreate() {
        if (!inviteCode.trim()) {
            setError('An invite code is required to join the network.');
            return;
        }
        if (callsign.trim().length < 2) {
            setError('Callsign must be at least 2 characters.');
            return;
        }
        const rawInvite = inviteCode.trim();
        const extractedOrigin = extractNodeOrigin(rawInvite);
        const nodeUrl = normalizeNodeUrl(extractedOrigin || createAnchorUrl.trim() || (__DEV__ ? 'https://127.0.0.1:8443' : ''));
        if (!nodeUrl) {
            setError('Enter your community node address — you need it to connect to your community.');
            return;
        }
        if (!looksLikeNodeAddress(nodeUrl)) {
            setError("That node address doesn't look right. Use something like node.yourcommunity.org");
            return;
        }
        if (shouldBlockCleartextNodeUrl(nodeUrl)) {
            setError('That node address is insecure (http on a public host). Ask your inviter for the https:// address.');
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const parsedCode = normaliseInviteCode(rawInvite);
            const { checkInvite, redeemInvite } = await import('../utils/db');
            const storedIdentity = await loadIdentity();

            const check = await checkInvite(parsedCode, nodeUrl);
            if (check && !check.valid) {
                // If invite is already used, check if stored identity is ALREADY a member on this node
                if (check.reason === 'used' && storedIdentity) {
                    try {
                        const res = await fetch(`${nodeUrl}/api/community/membership/${storedIdentity.publicKey}`);
                        if (res.ok) {
                            const data = await res.json();
                            if (data && data.isMember) {
                                await clearPendingOnboarding();
                                await recheckNodeStatus().catch(() => {});
                                setIdentity(storedIdentity);
                                return;
                            }
                        }
                    } catch {}
                }
                setError(inviteProblemMessage(check.reason));
                return;
            }
            setInviterName(check?.inviterCallsign || null);
            setInviteCommunityName(check?.communityName || null);

            // Per-node callsign uniqueness: check against the target node BEFORE we
            // create the identity or register, so a brand-new member picks a name
            // that's actually free here instead of being silently renamed on the
            // server. 'unknown' (node unreachable) falls through — the server still
            // auto-uniquifies as a backstop. Checked against nodeUrl explicitly since
            // it isn't the stored anchor yet.
            const availability = await checkCallsignAvailable(callsign.trim(), undefined, nodeUrl);
            if (availability === 'taken') {
                const sugg = await suggestCallsigns(callsign.trim(), undefined, 3, nodeUrl);
                setCallsignSuggestions(sugg);
                setError(`"${callsign.trim()}" is already taken in this community. Pick one of the suggestions below, or choose another name.`);
                setLoading(false);
                return;
            }
            setCallsignSuggestions([]);

            await AsyncStorage.setItem('beanpool_anchor_url', nodeUrl);

            const identity = storedIdentity
                ? { ...storedIdentity, callsign: callsign.trim() }
                : await createIdentity(callsign.trim());
            setPendingIdentity(identity);
            setPendingInviteCode(parsedCode);

            // Redeem invite on node IMMEDIATELY so member is registered right away
            try {
                await redeemInvite(parsedCode, identity.callsign, identity);
            } catch (redeemErr: any) {
                // If already redeemed (e.g. retry), check if registered
                if (!redeemErr?.message?.includes('already a member') && !redeemErr?.message?.includes('already been used')) {
                    throw redeemErr;
                }
            }

            // Redemption is done — either it just succeeded, or the node told us this
            // member was already registered. Both mean the final step has nothing left to do.
            setInviteRedeemed(true);

            // Record wizard state so an interrupted setup (avatar/seed) resumes
            await setPendingOnboarding({
                step: 'profileSetup',
                inviteCode: parsedCode,
                anchorUrl: nodeUrl,
                callsign: callsign.trim(),
                redeemed: true,
            });

            // Go to avatar selection (Step 2)
            setMode('profileSetup');
        } catch (err: any) {
            setError(`Failed to register identity: ${err?.message || err}`);
            console.error(err);
        } finally {
            setLoading(false);
        }
    }

    async function handleConfirmSeed() {
        if (!pendingIdentity) return;
        setLoading(true);
        setError(null);
        try {
            // Only if Step 1 never got to redeem. It normally did — redemption moved to
            // Step 1 so that a member exists on the node from the moment they pick a name —
            // and this call then re-sent the same code on every single join, which the
            // server answered with `alreadyMember`. Harmless to the member, but it doubled
            // the invite attempts in the onboarding funnel and spent a signed round trip at
            // the worst possible moment: the tap where someone is waiting to get in, often
            // on a poor connection.
            //
            // Kept rather than deleted for the one case that is real: the app being killed
            // mid-wizard and resumed from a record that predates this flag, where the final
            // step genuinely cannot assume the member exists.
            if (pendingInviteCode && !inviteRedeemed) {
                try {
                    const { redeemInvite } = await import('../utils/db');
                    await redeemInvite(pendingInviteCode, pendingIdentity.callsign, pendingIdentity);
                } catch {
                    /* already a member, or the code is spent — either way, carry on */
                }
            }

            // Sync avatar to node if set
            if (pendingAvatar) {
                try {
                    const url = await AsyncStorage.getItem('beanpool_anchor_url');
                    if (url) {
                        const payloadObj = {
                            publicKey: pendingIdentity.publicKey,
                            avatar: pendingAvatar,
                            callsign: pendingIdentity.callsign,
                        };
                        const bodyString = JSON.stringify(payloadObj);
                        const headers = await buildSignedHeaders('POST', '/api/profile/update', bodyString, pendingIdentity.privateKey, pendingIdentity.publicKey);
                        const res = await fetch(`${url}/api/profile/update`, {
                            method: 'POST',
                            headers,
                            body: bodyString,
                        });
                        if (res.ok) {
                            await AsyncStorage.removeItem('pending_profile_sync');
                        } else {
                            await AsyncStorage.setItem('pending_profile_sync', 'true');
                        }
                    }
                } catch (publishErr) {
                    console.warn('[Welcome] Post-registration profile publish failed (will heal on next sync):', publishErr);
                    await AsyncStorage.setItem('pending_profile_sync', 'true');
                }
            }

            await clearPendingOnboarding();
            await AsyncStorage.setItem('beanpool_identity_backed_up', 'true');

            // Refresh node recognition
            await recheckNodeStatus().catch(() => {});

            // Counted here, after the work above has actually landed, rather than on the
            // tap that started it. Recording on the tap booked a completion for anyone the
            // catch below then stranded with an error, and booked it again on every retry —
            // the same mistake `hasNoAvatarYet` exists to prevent for step 2, where asking
            // must happen before the write and counting after it.
            recordOnboardingEvent('guide_complete');

            // Final step — enter the app
            setIdentity(pendingIdentity);
        } catch (err: any) {
            setError(err.message || 'Failed to complete registration.');
        } finally {
            setLoading(false);
        }
    }

    // Validates the recovery form and either proceeds straight to recovery, or —
    // when this would REPLACE a different identity already on the phone — diverts
    // to the confirm-replace screen so the swap can never happen by accident.
    async function handleRecover() {
        const words = recoveryWords.map(w => w.toLowerCase().trim());
        const valid = words.filter(w => w.length > 0).length === 12;
        if (!valid) {
            setError('Please enter all 12 recovery words.');
            return;
        }
        if (!validateMnemonic(words)) {
            setError("One or more of those words isn't a valid recovery word. Check your spelling — they're all lowercase, single words.");
            return;
        }
        const rawAnchor = recoveryAnchorUrl.trim();
        if (!rawAnchor) {
            setError('Enter your community node address — you need it to reconnect to your community.');
            return;
        }
        const finalAnchorUrl = normalizeNodeUrl(rawAnchor);
        if (!looksLikeNodeAddress(finalAnchorUrl)) {
            setError("That node address doesn't look right. Use something like node.yourcommunity.org");
            return;
        }
        if (shouldBlockCleartextNodeUrl(finalAnchorUrl)) {
            setError('That node address is insecure (http on a public host). Ask whoever invited you for the https:// address.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            // Derive the incoming account's public key WITHOUT saving it, so we can
            // tell whether recovering would overwrite a DIFFERENT account already
            // stored on this phone.
            const { publicKeyHex } = await mnemonicToKeypair(words);
            const existing = await loadIdentity();
            if (existing && existing.publicKey !== publicKeyHex) {
                // A different account lives here — divert to the guarded screen.
                setPendingRecovery({ words, anchorUrl: finalAnchorUrl });
                setOutgoingIdentity(existing);
                setReplaceConfirmText('');
                setShowOutgoingSeed(false);
                setOutgoingSeedCopied(false);
                setLoading(false);
                setMode('confirmReplace');
                return;
            }
            // Fresh phone, or restoring the SAME account — no overwrite, proceed.
            await doRecover(words, finalAnchorUrl);
        } catch (err) {
            setError('Recovery failed. Check words and try again.');
            setLoading(false);
        }
    }

    // Performs the actual identity restore. Only called once we're certain the
    // user intends any overwrite (either no prior identity, the same identity, or
    // an explicit typed WIPE confirmation on the confirm-replace screen).
    //
    // The 12 words ARE the identity. The callsign and avatar are just node-held
    // profile data that travel with the key, so we pull the callsign from the node
    // rather than asking for it; the avatar (and everything else) then lands with
    // the normal members-directory sync. We never write a typed/placeholder name
    // back to the node. If the node can't be reached the account still restores —
    // it comes up nameless and adopts its real callsign on the first online sync.
    async function doRecover(words: string[], finalAnchorUrl: string) {
        setLoading(true);
        setError(null);
        try {
            await AsyncStorage.setItem('beanpool_anchor_url', finalAnchorUrl);

            const { publicKeyHex } = await mnemonicToKeypair(words);
            const callsign = (await fetchNodeCallsign(finalAnchorUrl, publicKeyHex)) || '';

            const identity = await createIdentityFromMnemonic(words, callsign);
            // Recovering an existing account supersedes any half-finished join
            // wizard on this device — drop the rescue record so the gatekeeper
            // doesn't bounce a recovered member back into onboarding.
            await clearPendingOnboarding();
            setIdentity(identity);
        } catch (err) {
            setError('Recovery failed. Check words and try again.');
        } finally {
            setLoading(false);
        }
    }

    async function handleSsoRecover(provider: SsoProvider) {
        const trimmedCallsign = ssoCallsign.trim();
        if (!trimmedCallsign) {
            setError('Please enter your callsign.');
            return;
        }
        const rawAnchor = recoveryAnchorUrl.trim();
        if (!rawAnchor) {
            setError('Please enter your community node address.');
            return;
        }
        const finalAnchorUrl = normalizeNodeUrl(rawAnchor);
        if (!looksLikeNodeAddress(finalAnchorUrl)) {
            setError("That node address doesn't look right. Use something like node.yourcommunity.org");
            return;
        }
        if (shouldBlockCleartextNodeUrl(finalAnchorUrl)) {
            setError('That node address is insecure (http on a public host). Use https:// instead.');
            return;
        }

        setLoading(true);
        setError(null);
        setSsoProgressMessage('Connecting to recovery session...');
        try {
            const result = await recoverAccountWithSso({
                callsign: trimmedCallsign,
                anchorUrl: finalAnchorUrl,
                provider,
                onProgress: (p) => setSsoProgressMessage(p.message),
                // GitHub's device flow cannot finish unless the member sees this. Copy it and open
                // GitHub for them — during recovery there is no sheet with a button, and the code
                // stays on screen behind the browser via the progress message above.
                onDeviceCode: (prompt) => {
                    Clipboard.setStringAsync(prompt.userCode.replace(/-/g, '')).catch(() => {});
                    WebBrowser.openBrowserAsync(prompt.verificationUri).catch(() => {});
                },
            });
            await clearPendingOnboarding();
            setIdentity(result.identity);
            setMode('home');
            router.replace('/');
        } catch (e: any) {
            if (e.reason === 'cancelled' || e.message === 'Sign-in was cancelled.') {
                setError(null);
            } else {
                setError(e.message || `Recovery failed: ${String(e)}`);
            }
        } finally {
            setLoading(false);
            setSsoProgressMessage(null);
        }
    }

    // --- Copy the OUTGOING account's seed to the clipboard (confirm-replace) ---
    async function handleCopyOutgoingSeed() {
        const words = await getMnemonic(outgoingIdentity);
        if (!words) return;
        await Clipboard.setStringAsync(words.join(' '));
        hapticTick();
        setOutgoingSeedCopied(true);
        setTimeout(() => setOutgoingSeedCopied(false), 2000);
    }

    // Confirm the overwrite: proceed with the pending recovery, then clear state.
    async function handleConfirmReplace() {
        if (!pendingRecovery) return;
        const { words, anchorUrl } = pendingRecovery;
        await doRecover(words, anchorUrl);
        setPendingRecovery(null);
        setOutgoingIdentity(null);
        setReplaceConfirmText('');
        setShowOutgoingSeed(false);
    }



    function goBack() {
        setMode('home');
        setError(null);
    }

    // --- Onboarding Progress Stepper ---
    function OnboardingStepper({ step }: { step: 1 | 2 | 3 | 4 }) {
        const steps = ['Your Name', 'Your Photo', 'Safety Backup', 'How it Works'];
        return (
            <View style={stepperStyles.container}>
                {steps.map((label, i) => {
                    const stepNum = i + 1;
                    const isActive = stepNum === step;
                    const isCompleted = stepNum < step;
                    return (
                        <React.Fragment key={i}>
                            {i > 0 && <View style={[stepperStyles.line, (isCompleted || isActive) && stepperStyles.lineActive]} />}
                            <View style={stepperStyles.stepItem}>
                                <View style={[stepperStyles.dot, isActive && stepperStyles.dotActive, isCompleted && stepperStyles.dotCompleted]}>
                                    {isCompleted && <Text style={stepperStyles.dotCheck}>✓</Text>}
                                </View>
                                <Text style={[stepperStyles.label, isActive && stepperStyles.labelActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{label}</Text>
                            </View>
                        </React.Fragment>
                    );
                })}
            </View>
        );
    }

    // --- Copy seed phrase to clipboard ---
    async function handleCopySeed() {
        const words = await getMnemonic(pendingIdentity);
        if (!words) return;
        await Clipboard.setStringAsync(words.join(' '));
        hapticTick();
        setSeedCopied(true);
        setTimeout(() => setSeedCopied(false), 2000);
    }

    // --- Back-button guard for seed phrase screen ---
    function handleSeedBackPress() {
        Alert.alert(
            'Have you saved your words?',
            'If you go back now, you\'ll need to start over.',
            [
                { text: 'Stay', style: 'cancel' },
                { text: 'Go Back', style: 'destructive', onPress: () => {
                    setPendingIdentity(null);
                    setPendingAvatar(null);
                    setSeedConfirmed(false);
                    setSeedCopied(false);
                    // Keeper state belongs to the identity being discarded (CR). Left behind, a
                    // member who backs out and starts again is shown the PREVIOUS identity's
                    // keepers — and the effect's `|| enrolment` guard means the new identity
                    // never enrols at all, so the screen would be describing an account that no
                    // longer exists.
                    setEnrolment(null);
                    setRevealWords(false);
                    protectionShownRef.current = false;
                    // Going back discards the identity, so what was redeemed no longer
                    // describes what is about to be submitted. Cleared in the persisted
                    // record too, or a kill-and-resume would restore the stale answer.
                    setInviteRedeemed(false);
                    updatePendingOnboarding({ step: 'create', avatar: null, redeemed: false }).catch(() => {});
                    setMode('create');
                    setError(null);
                }},
            ]
        );
    }

    // Android hardware back button handler for seed screen
    React.useEffect(() => {
        if (mode !== 'seedBackup') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            handleSeedBackPress();
            return true; // Prevent default back
        });
        return () => sub.remove();
    }, [mode]);

    // --- Profile image picker helpers for "Who Are You?" gate ---
    // Moved to AvatarPickerSheet component

    async function handleCompleteProfile() {
        if (!pendingIdentity || !pendingAvatar) return;
        setLoading(true);
        setError(null);
        try {
            // 1. Write avatar to local SQLite
            await updateMemberProfile(pendingIdentity.publicKey, {
                callsign: pendingIdentity.callsign,
                avatar_url: pendingAvatar,
            });

            // 2. Publish avatar to the node since member was registered in Step 1
            try {
                const url = await AsyncStorage.getItem('beanpool_anchor_url');
                if (url) {
                    const payloadObj = {
                        publicKey: pendingIdentity.publicKey,
                        avatar: pendingAvatar,
                        callsign: pendingIdentity.callsign,
                    };
                    const bodyString = JSON.stringify(payloadObj);
                    const headers = await buildSignedHeaders('POST', '/api/profile/update', bodyString, pendingIdentity.privateKey, pendingIdentity.publicKey);
                    const res = await fetch(`${url}/api/profile/update`, {
                        method: 'POST',
                        headers,
                        body: bodyString,
                    });
                    if (res.ok) {
                        await AsyncStorage.removeItem('pending_profile_sync');
                    } else {
                        await AsyncStorage.setItem('pending_profile_sync', 'true');
                    }
                }
            } catch {
                await AsyncStorage.setItem('pending_profile_sync', 'true');
            }

            await updatePendingOnboarding({ step: 'seedBackup', avatar: pendingAvatar });

            // 3. Profile done — go to seed phrase (Step 3)
            setMode('seedBackup');
        } catch (err: any) {
            setError(err.message || 'Failed to save profile.');
        } finally {
            setLoading(false);
        }
    }

    // --- STEP 2: PROFILE SETUP ("Choose your look") ---
    if (mode === 'profileSetup' && pendingIdentity) {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <ScrollView key={mode} contentContainerStyle={styles.scroll}>
                    <OnboardingStepper step={2} />
                    <View style={styles.card}>
                        {inviterName && (
                            <View style={styles.inviteVerifiedBox}>
                                <Text style={styles.inviteVerifiedText}>
                                    🎟️ Your invite from <Text style={{ fontWeight: 'bold' }}>{inviterName}</Text> checks out
                                    {inviteCommunityName ? <Text> — welcome to <Text style={{ fontWeight: 'bold' }}>{inviteCommunityName}</Text>!</Text> : <Text>!</Text>}
                                </Text>
                            </View>
                        )}
                        <Text style={styles.title}>📸 Choose your look</Text>
                        <Text style={styles.subtitle}>
                            Add a photo, or pick a fun avatar — whatever feels like you.
                        </Text>

                        {/* Preview circle */}
                        <View style={profileStyles.previewContainer}>
                            {pendingAvatar ? (
                                <Image
                                    source={pendingAvatar.startsWith('bundled://') ? resolveBundledAvatar(pendingAvatar)! : { uri: pendingAvatar }}
                                    style={profileStyles.previewImage}
                                    accessibilityLabel="Your selected profile picture"
                                />
                            ) : (
                                <View style={profileStyles.previewPlaceholder}>
                                    <Text style={profileStyles.previewPlaceholderText}>
                                        {pendingIdentity.callsign.charAt(0).toUpperCase()}
                                    </Text>
                                </View>
                            )}
                            <Text style={profileStyles.previewCallsign}>
                                {pendingIdentity.callsign}
                            </Text>
                        </View>

                        {/* Choose Photo Button */}
                        <Pressable
                            style={styles.secondaryBtn}
                            onPress={() => setShowAvatarPicker(true)}
                            disabled={loading}
                            accessibilityRole="button"
                        >
                            <Text style={styles.secondaryBtnText}>
                                {pendingAvatar ? 'Change Photo or Avatar' : 'Choose Photo or Avatar'}
                            </Text>
                        </Pressable>

                        {loading && (
                            <View style={{ alignItems: 'center', marginVertical: 12 }}>
                                <ActivityIndicator color={palette.blue600} />
                                <Text style={{ color: colors.text.secondary, fontSize: 12, marginTop: 4 }}>Processing image...</Text>
                            </View>
                        )}

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable
                            style={[styles.primaryBtn, !pendingAvatar && styles.disabledBtn]}
                            disabled={!pendingAvatar || loading}
                            onPress={handleCompleteProfile}
                            accessibilityRole="button"
                        >
                            {loading ? (
                                <ActivityIndicator color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.primaryBtnText}>Next →</Text>
                            )}
                        </Pressable>

                        <Pressable
                            style={styles.backBtn}
                            onPress={() => {
                                updatePendingOnboarding({ step: 'create', avatar: null, redeemed: false }).catch(() => {});
                                setMode('create'); setPendingIdentity(null); setPendingAvatar(null); setInviteRedeemed(false); setShowAvatarPicker(false); setError(null);
                            }}
                            disabled={loading}
                            accessibilityRole="button"
                            accessibilityLabel="Back"
                        >
                            <Text style={styles.backBtnText}>← Back</Text>
                        </Pressable>
                    </View>
                </ScrollView>
                
                <AvatarPickerSheet
                    visible={showAvatarPicker}
                    onClose={() => setShowAvatarPicker(false)}
                    onSelectImage={(uri) => setPendingAvatar(uri)}
                />
            </SafeAreaView>
        );
    }

    // --- STEP 3: SAFETY BACKUP (seed phrase — reframed) ---
    if (mode === 'seedBackup' && pendingIdentity) {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <ScrollView key={mode} contentContainerStyle={styles.scroll}>
                    <OnboardingStepper step={3} />
                    <View style={styles.card}>
                        <KeeperProtectionPanel
                            protection={protection}
                            onProtectSso={Platform.OS !== 'web' ? (prov) => {
                                if (prov) setSsoProvider(prov);
                                setShowSsoSheet(true);
                            } : undefined}
                            onProtectFriends={Platform.OS !== 'web' ? () => setShowFriendSheet(true) : undefined}
                        />

                        {Platform.OS === 'web' && (
                            <View style={{ backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border, borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                                <Text style={{ color: colors.text.body, fontSize: 14, lineHeight: 20 }}>
                                    The web version of BeanPool runs inside your hub's server, which means it can't safely manage recovery keys. Your 12 words are the only way back on the web.
                                </Text>
                                <Text style={{ color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginTop: 8 }}>
                                    For Apple sign-in or friend-based recovery, use the BeanPool app on your phone.
                                </Text>
                            </View>
                        )}

                        <SsoEnrolSheet
                            visible={showSsoSheet}
                            provider={ssoProvider}
                            identity={pendingIdentity}
                            onClose={() => setShowSsoSheet(false)}
                            onEnrolled={(result) => {
                                setEnrolment(result);
                                setShowSsoSheet(false);
                            }}
                        />
                        <FriendPickerSheet
                            visible={showFriendSheet}
                            onClose={() => setShowFriendSheet(false)}
                            onEnrolled={(result) => {
                                setEnrolment(result);
                                setShowFriendSheet(false);
                            }}
                        />

                        {/*
                          The words follow the panel rather than opening the screen.
                          
                          A covered member gets them offered, not pushed: keepers are convenience
                          layered on top and the words remain the floor under all of it, but
                          meeting somebody who is genuinely protected with a wall of twelve words
                          to copy down teaches them the panel above was noise. Everyone else sees
                          them expanded, because for them the words are the actual answer.
                        */}
                        {!protection.showWords && !revealWords ? (
                            <Pressable
                                style={[styles.secondaryBtn, { marginBottom: 4 }]}
                                onPress={() => setRevealWords(true)}
                                accessibilityRole="button"
                                accessibilityHint="Shows the twelve words that can restore your account"
                            >
                                <Text style={styles.secondaryBtnText}>Rather write down 12 words?</Text>
                            </Pressable>
                        ) : (
                        <>
                        <Text style={{ color: colors.text.secondary, fontSize: 13, marginBottom: 16, lineHeight: 18 }}>
                            💡 Take a screenshot or write them down somewhere safe.
                        </Text>
                        {/*
                          Says out loud that this screen is not the only chance. Without it,
                          removing the gate just leaves people guessing whether skipping
                          costs them something permanent — and the ones most likely to skip
                          are the ones with no pen to hand, not the ones who do not care.
                        */}
                        <Text style={{ color: colors.text.secondary, fontSize: 13, marginBottom: 16, lineHeight: 18 }}>
                            No pen handy? Carry on — you can come back to these any time under
                            Settings → Recovery Phrase.
                        </Text>
                        <View style={styles.seedGrid}>
                            {/*
                              The words arrive a tick after this screen mounts, since reading
                              them is asynchronous. Without this branch the grid drew empty for
                              that frame — a blank box where twelve words belong, on the one
                              screen where a user is being asked to write them down.

                              Each cell is one accessibility node. Left as two Texts, a screen
                              reader stops on "1." and then on "apple" as separate items, so
                              hearing the phrase in order means twenty-four stops and working
                              out for yourself which number went with which word.
                            */}
                            {pendingWords ? pendingWords.map((word, i) => (
                                <View
                                    key={i}
                                    style={styles.seedCell}
                                    accessible={true}
                                    accessibilityLabel={`Word ${i + 1}: ${word}`}
                                >
                                    <Text style={styles.seedIndex}>{i + 1}.</Text>
                                    <Text style={styles.seedWord} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{word}</Text>
                                </View>
                            )) : (
                                <ActivityIndicator color={palette.blue600} style={{ marginVertical: 24 }} />
                            )}
                        </View>

                        {/* Copy to clipboard */}
                        <Pressable
                            style={[styles.secondaryBtn, { marginBottom: 12 }]}
                            onPress={handleCopySeed}
                            accessibilityRole="button"
                        >
                            <Text style={styles.secondaryBtnText}>
                                {seedCopied ? '✅ Copied!' : '📋 Copy All Words'}
                            </Text>
                        </Pressable>

                        {/*
                          The tick is now a claim the user makes, not a toll they pay.
                          Nothing is disabled behind it.

                          It used to gate the only way forward, which made the last step of
                          joining a community a checkbox someone had to tick to get past —
                          so people ticked it without reading, and the screen taught them
                          that the words did not matter. Worse, anyone who genuinely could
                          not write them down right then was stuck at a dead end with an
                          account already created on the node. Leaving it optional means
                          ticking it can go back to meaning what it says.
                        */}
                        <Pressable
                            style={[styles.checkbox, seedConfirmed && styles.checkboxActive]}
                            onPress={() => setSeedConfirmed(!seedConfirmed)}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: seedConfirmed }}
                            // Without this the announcement is "white large square, I've saved
                            // these words, check box, unchecked" — the tick state read out
                            // twice, once as a described emoji. The role and state already
                            // carry it, so the label is just the sentence.
                            accessibilityLabel="I've saved these words"
                        >
                            <Text style={styles.checkboxText}>
                                {seedConfirmed ? '✅ ' : '⬜ '} I've saved these words
                            </Text>
                        </Pressable>
                        </>
                        )}

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable
                            style={[styles.primaryBtn, loading && styles.disabledBtn]}
                            disabled={loading}
                            onPress={() => {
                                recordOnboardingEvent('protection_choice', seedConfirmed ? 'words' : 'skip');
                                updatePendingOnboarding({ step: 'onboardingGuide' }).catch(() => {});
                                setMode('onboardingGuide');
                            }}
                            accessibilityRole="button"
                        >
                            <Text style={styles.primaryBtnText}>Next →</Text>
                        </Pressable>

                        <Pressable
                            style={styles.backBtn}
                            onPress={handleSeedBackPress}
                            disabled={loading}
                            accessibilityRole="button"
                            accessibilityLabel="Back"
                        >
                            <Text style={styles.backBtnText}>← Back</Text>
                        </Pressable>
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // --- STEP 4: ONBOARDING GUIDE (What is BeanPool & ledger rules) ---
    if (mode === 'onboardingGuide' && pendingIdentity) {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <ScrollView key={mode} contentContainerStyle={styles.scroll}>
                    <OnboardingStepper step={4} />
                    <View style={styles.card}>
                        <Text style={styles.title}>🫘 Welcome to BeanPool</Text>
                        <Text style={styles.subtitle}>
                            Let's look at how this community economy works.
                        </Text>

                        {/* Card 1: Energy Exchange */}
                        <View style={guideStyles.card}>
                            <Text style={guideStyles.cardTitle}>⚡ Energy Exchange Marketplace</Text>
                            <Text style={guideStyles.cardText}>
                                BeanPool runs on cooperation, not accumulation. The goal is to keep energy flowing.
                            </Text>
                            <View style={guideStyles.highlightBox}>
                                <Text style={guideStyles.highlightText}>
                                    🟢 <Text style={{ fontWeight: 'bold' }}>The best place to be is zero (0 Beans).</Text> This means you have given as much value to your community as you have received from it.
                                </Text>
                            </View>
                            <View style={[guideStyles.highlightBox, { backgroundColor: 'rgba(245, 158, 11, 0.12)', borderColor: 'rgba(245, 158, 11, 0.35)' }]}>
                                <Text style={[guideStyles.highlightText, { color: palette.amber700 || '#b45309' }]}>
                                    🫘 <Text style={{ fontWeight: 'bold' }}>Contributions First.</Text> To keep the credit pool healthy, list at least one Offer of what you can give back before you can post Needs or accept Offers.
                                </Text>
                            </View>
                        </View>

                        {/* Card 2: The Ledger Rules */}
                        <View style={guideStyles.card}>
                            <Text style={guideStyles.cardTitle}>🪙 The Mutual Credit Ledger</Text>
                            
                            <View style={guideStyles.bulletRow}>
                                <Text style={guideStyles.bulletEmoji}>🤝</Text>
                                <View style={guideStyles.bulletContent}>
                                    <Text style={guideStyles.bulletTitle}>Trust-Backed Credit</Text>
                                    <Text style={guideStyles.bulletText}>
                                        Everyone starts with a 0 Bean limit. Complete your first real marketplace trade and your community credit line opens — then it deepens steadily with the value you trade and the people you trade with, up to -2000 Beans. No interest, no bank fees.
                                    </Text>
                                </View>
                            </View>

                            <View style={guideStyles.bulletRow}>
                                <Text style={guideStyles.bulletEmoji}>🌾</Text>
                                <View style={guideStyles.bulletContent}>
                                    <Text style={guideStyles.bulletTitle}>Community Commons Pool</Text>
                                    <Text style={guideStyles.bulletText}>
                                        Positive balances above 200 Beans decay by 1.5% monthly (progressive circulation). This prevents hoarding and funds local community projects.
                                    </Text>
                                </View>
                            </View>

                            <View style={guideStyles.bulletRow}>
                                <Text style={guideStyles.bulletEmoji}>⏱️</Text>
                                <View style={guideStyles.bulletContent}>
                                    <Text style={guideStyles.bulletTitle}>Reference Rate</Text>
                                    <Text style={guideStyles.bulletText}>
                                        40 Beans represents roughly 1 hour of community service or time, helping you easily value what you offer or need.
                                    </Text>
                                </View>
                            </View>
                        </View>

                        {/* Card 3: Safe Handshake Held in Trust */}
                        <View style={guideStyles.card}>
                            <Text style={guideStyles.cardTitle}>🔒 Held in Trust</Text>
                            <Text style={guideStyles.cardText}>
                                To ensure fairness, when you accept an offer or request a job, your credits are safely held in a temporary Trust Wallet. They are only released to the provider once you confirm delivery.
                            </Text>
                        </View>

                        {/*
                          Card 4: how you get back in.
                          
                          The design doc's wording for this card describes Phase B — an
                          account split into pieces held by your phone, your hub and the
                          person who invited you, any three of which bring you back. None of
                          that machinery exists yet, so printing it here would tell a brand
                          new member they are protected by keepers they do not have. That is
                          precisely the false all-clear this redesign is meant to remove, so
                          the card says what is true today and gets the keeper wording in
                          Phase B, when the keepers are real.
                        */}
                        <View style={guideStyles.card}>
                            <Text style={guideStyles.cardTitle}>🔑 Getting Back In</Text>
                            {/* Spaced locally rather than by changing guideStyles.cardText,
                                which has no marginBottom because the other three cards end on
                                it. This is the only card where it is followed by bullets. */}
                            <Text style={[guideStyles.cardText, { marginBottom: 8 }]}>
                                Right now your 12 words are the only way back into your account. No
                                email, no password reset — nobody, including your hub, can restore it
                                for you.
                            </Text>
                            <Text style={guideStyles.bulletItem}>
                                📝 Find them any time under <Text style={{ fontWeight: 'bold' }}>Settings → Recovery Phrase</Text>.
                            </Text>
                            <Text style={guideStyles.bulletItem}>
                                🤝 Soon you'll be able to share the job with your hub and the person who
                                invited you, so losing your phone stops being a problem you carry alone.
                            </Text>
                        </View>

                        {/* Card 5: Where to Start */}
                        <View style={guideStyles.card}>
                            <Text style={guideStyles.cardTitle}>🚀 Where to Start?</Text>
                            <Text style={guideStyles.bulletItem}>📍 Explore the <Text style={{ fontWeight: 'bold' }}>Map</Text> to find offers (blue) and needs (orange) near you.</Text>
                            <Text style={guideStyles.bulletItem}>💬 Tap <Text style={{ fontWeight: 'bold' }}>Message</Text> on any post to chat securely (E2E encrypted) with neighbors.</Text>
                            <Text style={guideStyles.bulletItem}>➕ Click <Text style={{ fontWeight: 'bold' }}>Post</Text> to list what you need or what you can offer to the community.</Text>
                            <Text style={guideStyles.bulletItem}>💳 Use the <Text style={{ fontWeight: 'bold' }}>Ledger</Text> tab to send credits to neighbors instantly.</Text>
                        </View>

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable
                            style={[styles.primaryBtn, loading && styles.disabledBtn]}
                            disabled={loading}
                            onPress={handleConfirmSeed}
                            accessibilityRole="button"
                        >
                            {loading ? (
                                <ActivityIndicator color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.primaryBtnText}>Let's Begin! 🚀</Text>
                            )}
                        </Pressable>

                        <Pressable
                            style={styles.backBtn}
                            onPress={() => {
                                updatePendingOnboarding({ step: 'seedBackup' }).catch(() => {});
                                setMode('seedBackup');
                                setError(null);
                            }}
                            disabled={loading}
                            accessibilityRole="button"
                        >
                            <Text style={styles.backBtnText}>← Back to Backup</Text>
                        </Pressable>
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // --- CREATE NEW IDENTITY ---
    if (mode === 'create') {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <KeyboardAvoidingView
                    behavior="padding"
                    style={{ flex: 1 }}
                >
                    <ScrollView key={mode} contentContainerStyle={styles.scroll}>
                    <OnboardingStepper step={1} />
                    <View style={styles.card}>
                        <Text style={styles.title}>🎟️ Join BeanPool</Text>

                        {clipboardMayHaveInvite && !inviteCode && (
                            <View style={styles.pasteCard}>
                                <Text style={styles.pasteCardText}>Tap Paste to insert the code from your invite.</Text>
                                {Clipboard.isPasteButtonAvailable ? (
                                    <Clipboard.ClipboardPasteButton
                                        onPress={(data) => { if (data.type === 'text') applyInviteContent(data.text, 'join'); }}
                                        acceptedContentTypes={['plain-text', 'url']}
                                        displayMode="iconAndLabel"
                                        backgroundColor={palette.blue600}
                                        foregroundColor={colors.text.inverse}
                                        cornerStyle="capsule"
                                        style={styles.pasteCardSystemBtn}
                                    />
                                ) : (
                                    <Pressable style={styles.pasteCardBtn} onPress={handlePasteInvite} accessibilityRole="button">
                                        <Text style={styles.pasteCardBtnText}>📋 Paste</Text>
                                    </Pressable>
                                )}
                            </View>
                        )}

                        <TextInput
                            style={styles.input}
                            placeholder="Paste your invite link or code"
                            placeholderTextColor={colors.text.muted}
                            value={inviteCode}
                            onChangeText={setInviteCode}
                            autoCapitalize="none"
                            autoCorrect={false}
                            accessibilityLabel="Invite link or code"
                        />

                        {inviteCode && !inviteCode.startsWith('http') && (
                            <>
                                <TextInput
                                    style={styles.input}
                                    placeholder="Community Node URL (e.g. node.yourcommunity.org)"
                                    placeholderTextColor={colors.text.muted}
                                    value={createAnchorUrl}
                                    onChangeText={setCreateAnchorUrl}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="url"
                                    accessibilityLabel="Community Node URL"
                                />
                                <Text style={styles.fieldHint}>
                                    Required — the community node you're joining. Ask whoever invited you if you're unsure.
                                </Text>
                            </>
                        )}

                        <Text style={styles.callsignLabel}>What should we call you?</Text>
                        <TextInput
                            style={styles.callsignInput}
                            placeholder="Your name or nickname"
                            placeholderTextColor={colors.text.muted}
                            value={callsign}
                            onChangeText={(t) => { setCallsign(t); if (callsignSuggestions.length) setCallsignSuggestions([]); }}
                            maxLength={32}
                            autoFocus={true}
                            autoCapitalize="words"
                            accessibilityLabel="Your name or nickname"
                        />
                        <Text style={styles.callsignHelper}>
                            This is your display name — how the community sees you, e.g. Sarah. You can change it later.
                        </Text>
                        <Text style={styles.callsignTip}>
                            💡 Tip: adding your suburb helps locals find you!
                        </Text>

                        {callsignSuggestions.length > 0 && (
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 }}>
                                {callsignSuggestions.map((s) => (
                                    <Pressable
                                        key={s}
                                        style={{ backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8 }}
                                        onPress={() => { setCallsign(s); setCallsignSuggestions([]); setError(null); }}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Use the name ${s}`}
                                    >
                                        <Text style={{ color: colors.text.body, fontSize: 14, fontWeight: '600' }}>{s}</Text>
                                    </Pressable>
                                ))}
                            </View>
                        )}

                        {error && (
                            <View style={{ marginBottom: 12 }}>
                                <Text style={styles.error}>{error}</Text>
                                {(error.includes('already been used') || error.includes('already used')) && (
                                    <Pressable
                                        style={{ marginTop: 8, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: palette.blue50 || '#eff6ff', borderRadius: 8, borderWidth: 1, borderColor: palette.blue200 || '#bfdbfe', alignItems: 'center' }}
                                        onPress={() => {
                                            setError(null);
                                            setMode('recover');
                                        }}
                                        accessibilityRole="button"
                                    >
                                        <Text style={{ color: palette.blue600 || '#2563eb', fontWeight: 'bold', fontSize: 13 }}>
                                            🔑 Recover an existing account with seed phrase →
                                        </Text>
                                    </Pressable>
                                )}
                            </View>
                        )}

                        <Pressable style={styles.primaryBtn} onPress={handleCreate} disabled={loading} accessibilityRole="button">
                            {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Next →</Text>}
                        </Pressable>

                        {/* Restore Existing Identity CTA for returning members (#98) */}
                        <View style={styles.restorePromptBox}>
                            <Text style={styles.restorePromptLabel}>Already have an account or switching phones?</Text>
                            <Pressable
                                style={styles.restorePromptBtn}
                                onPress={() => { setMode('member'); setError(null); }}
                                accessibilityRole="button"
                                accessibilityLabel="Restore existing identity"
                            >
                                <Text style={styles.restorePromptBtnText}>🔑 Restore Existing Identity →</Text>
                            </Pressable>
                        </View>

                        <Pressable style={styles.backBtn} onPress={goBack} accessibilityRole="button" accessibilityLabel="Back to Home">
                            <Text style={styles.backBtnText}>← Back to Home</Text>
                        </Pressable>

                        <Text style={styles.tosText}>
                            By joining you agree to our{' '}
                            <Text style={styles.tosLink} onPress={() => openLink('https://beanpool.org/terms')}>Terms of Service & EULA</Text>
                            {' '}and{' '}
                            <Text style={styles.tosLink} onPress={() => openLink('https://beanpool.org/privacy')}>Privacy Policy</Text>.
                        </Text>
                    </View>
                </ScrollView>
                </KeyboardAvoidingView>
            </SafeAreaView>
        );
    }

    // --- MEMBER SUB-MENU (Transfer Link or 12 Words) ---
    if (mode === 'member') {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <ScrollView key={mode} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                    <View style={styles.card}>
                        <Text style={styles.title} accessibilityRole="header">🔑 Restore your account</Text>
                        <Text style={styles.subtitle}>
                            Your account isn't lost — bring it to this device with your social sign-in, 12 recovery words, or Guardians.
                        </Text>

                        <Pressable
                            style={styles.ssoRecoverBtn}
                            onPress={() => {
                                setMode('ssoRecover');
                                setError(null);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Recover with Social Sign-In"
                        >
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                                <Text style={styles.ssoRecoverBtnText}>🌐 Recover with Social</Text>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 2 }}>
                                    {Platform.OS === 'ios' && <AppleLogo size={16} color="#1D4ED8" />}
                                    <GoogleLogo size={16} />
                                    <FacebookLogo size={16} />
                                    <GitHubLogo size={16} color="#24292F" />
                                </View>
                            </View>
                        </Pressable>

                        <Pressable style={styles.recoverBtn} onPress={() => { setMode('recover'); setError(null); }} accessibilityRole="button">
                            <Text style={styles.recoverBtnText}>🔑 Recover with 12 Words</Text>
                        </Pressable>

                        <Pressable style={styles.socialRecoverBtn} onPress={() => { router.push('/recover-identity'); }} accessibilityRole="button">
                            <Text style={styles.socialRecoverBtnText}>🛡️ Recover via Guardians</Text>
                        </Pressable>

                        <Pressable style={styles.backBtn} onPress={goBack} accessibilityRole="button" accessibilityLabel="Back to Home">
                            <Text style={styles.backBtnText}>← Back to Home</Text>
                        </Pressable>
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }



    // --- RECOVER FROM 12 WORDS ---
    // --- IDENTITY-OVERWRITE GUARD: restoring a DIFFERENT account onto a phone
    // that already holds one. Blocking, plain-language, with a backup of the
    // outgoing account's words and a typed WIPE confirmation. ---
    if (mode === 'confirmReplace' && outgoingIdentity) {
        const outCallsign = outgoingIdentity.callsign?.trim() || 'your current account';
        const hasOutgoingSeed = hasMnemonic(outgoingIdentity);
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
                    <ScrollView key={mode} contentContainerStyle={styles.scroll}>
                        <View style={styles.card}>
                            <Text style={styles.title}>⚠️ Replace this phone's account?</Text>
                            <Text style={styles.subtitle}>
                                This phone is already set up as <Text style={styles.emphasis}>{outCallsign}</Text>. A phone can only hold one account at a time.
                            </Text>

                            <View style={styles.replaceWarnBox}>
                                <Text style={styles.replaceWarnText}>
                                    If you continue, <Text style={styles.emphasis}>{outCallsign}</Text> will be removed from this phone and replaced by the account you're restoring. Any community you joined as <Text style={styles.emphasis}>{outCallsign}</Text> will no longer open on this phone.
                                </Text>
                            </View>

                            {hasOutgoingSeed ? (
                                <>
                                    <Text style={styles.replaceBackupIntro}>
                                        The only way to get <Text style={styles.emphasis}>{outCallsign}</Text> back afterwards is with its own 12 recovery words. Save them now, before you continue:
                                    </Text>
                                    {!showOutgoingSeed ? (
                                        <Pressable
                                            style={styles.secondaryBtn}
                                            onPress={() => { hapticTick(); setShowOutgoingSeed(true); }}
                                            accessibilityRole="button"
                                        >
                                            <Text style={styles.secondaryBtnText}>🔑 Show {outCallsign}'s 12 words</Text>
                                        </Pressable>
                                    ) : (
                                        <>
                                            <View style={styles.seedGrid}>
                                                {outgoingWords?.map((word, i) => (
                                                    <View key={i} style={styles.seedCell}>
                                                        <Text style={styles.seedIndex}>{i + 1}.</Text>
                                                        <Text style={styles.seedWord} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{word}</Text>
                                                    </View>
                                                ))}
                                            </View>
                                            <Pressable
                                                style={[styles.secondaryBtn, { marginBottom: 8 }]}
                                                onPress={handleCopyOutgoingSeed}
                                                accessibilityRole="button"
                                            >
                                                <Text style={styles.secondaryBtnText}>{outgoingSeedCopied ? '✅ Copied!' : '📋 Copy All Words'}</Text>
                                            </Pressable>
                                            <Text style={styles.fieldHint}>
                                                Write these 12 words down somewhere safe — they bring {outCallsign} back on any phone.
                                            </Text>
                                        </>
                                    )}
                                </>
                            ) : (
                                <View style={styles.noSeedWarnBox}>
                                    <Text style={styles.noSeedWarnText}>
                                        ⚠️ {outCallsign}'s recovery words aren't stored on this phone, so we can't show them here. If you don't already have them written down somewhere, continuing may permanently lose access to {outCallsign}.
                                    </Text>
                                </View>
                            )}

                            <Text style={styles.wipeLabel}>TYPE 'WIPE' TO CONFIRM</Text>
                            <TextInput
                                style={styles.input}
                                value={replaceConfirmText}
                                onChangeText={setReplaceConfirmText}
                                placeholder="WIPE"
                                placeholderTextColor={colors.text.muted}
                                autoCapitalize="characters"
                                autoCorrect={false}
                                accessibilityLabel="Type WIPE to confirm replacing this phone's account"
                            />

                            {error && <Text style={styles.error}>{error}</Text>}

                            <Pressable
                                style={[styles.dangerBtn, (loading || replaceConfirmText !== 'WIPE') && styles.disabledBtn]}
                                disabled={loading || replaceConfirmText !== 'WIPE'}
                                onPress={handleConfirmReplace}
                                accessibilityRole="button"
                                accessibilityHint="Replaces the account currently stored on this phone"
                            >
                                {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.dangerBtnText}>Replace Account</Text>}
                            </Pressable>

                            <Pressable
                                style={styles.backBtn}
                                onPress={() => {
                                    setMode('recover');
                                    setPendingRecovery(null);
                                    setOutgoingIdentity(null);
                                    setReplaceConfirmText('');
                                    setShowOutgoingSeed(false);
                                    setError(null);
                                }}
                                disabled={loading}
                                accessibilityRole="button"
                                accessibilityLabel={`Keep ${outCallsign} and go back`}
                            >
                                <Text style={styles.backBtnText}>← Keep {outCallsign}, go back</Text>
                            </Pressable>
                        </View>
                    </ScrollView>
                </KeyboardAvoidingView>
            </SafeAreaView>
        );
    }

    if (mode === 'recover') {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <KeyboardAvoidingView
                    behavior="padding"
                    style={{ flex: 1 }}
                >
                    <ScrollView key={mode} contentContainerStyle={styles.scroll}>
                    <View style={styles.card}>
                        <Text style={styles.title}>🔑 Recover Identity</Text>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <Text style={[styles.subtitle, { flex: 1, marginBottom: 0 }]}>Enter your 12 recovery words.</Text>
                            <Pressable
                                style={styles.pasteBtn}
                                onPress={async () => {
                                    try {
                                        const text = await Clipboard.getStringAsync();
                                        const tokens = (text || '').trim().split(/\s+/).filter(Boolean);
                                        if (tokens.length === 0) return;
                                        const updated = Array(12).fill('');
                                        tokens.slice(0, 12).forEach((w, idx) => { updated[idx] = w.toLowerCase(); });
                                        setRecoveryWords(updated);
                                    } catch { /* clipboard unavailable — user can still type */ }
                                }}
                                accessibilityRole="button"
                                accessibilityLabel="Paste 12 recovery words"
                            >
                                <Text style={styles.pasteBtnText}>📋 Paste</Text>
                            </Pressable>
                        </View>

                        <View style={styles.recoveryGrid}>
                            {recoveryWords.map((word, i) => (
                                <TextInput
                                    key={i}
                                    accessibilityLabel={`Recovery word ${i + 1}`}
                                    style={styles.recoveryInput}
                                    value={word}
                                    onChangeText={(t) => {
                                        // Pasting the whole space-separated phrase into any box
                                        // fans it out across all 12; a single word fills its box.
                                        const tokens = t.trim().split(/\s+/).filter(Boolean);
                                        if (tokens.length > 1) {
                                            const updated = Array(12).fill('');
                                            tokens.slice(0, 12).forEach((w, idx) => { updated[idx] = w.toLowerCase(); });
                                            setRecoveryWords(updated);
                                        } else {
                                            const updated = [...recoveryWords];
                                            updated[i] = t.toLowerCase().trim();
                                            setRecoveryWords(updated);
                                        }
                                    }}
                                    placeholder={`${i + 1}`}
                                    placeholderTextColor={colors.text.muted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            ))}
                        </View>

                        <TextInput
                            accessibilityLabel="Community Node URL"
                            style={styles.input}
                            placeholder="Community Node URL (e.g. node.yourcommunity.org)"
                            placeholderTextColor={colors.text.muted}
                            value={recoveryAnchorUrl}
                            onChangeText={setRecoveryAnchorUrl}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                        />
                        <Text style={styles.fieldHint}>
                            Required — the community node that holds your account. Your name and picture come back automatically once you're in. Ask whoever invited you if you're unsure.
                        </Text>

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable style={styles.primaryBtn} onPress={handleRecover} disabled={loading} accessibilityRole="button">
                            {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Recover Identity</Text>}
                        </Pressable>

                        <Pressable style={styles.backBtn} onPress={() => { setMode('member'); setError(null); }} accessibilityRole="button" accessibilityLabel="Back to Restore Options">
                            <Text style={styles.backBtnText}>← Back to Restore Options</Text>
                        </Pressable>
                    </View>
                </ScrollView>
                </KeyboardAvoidingView>
            </SafeAreaView>
        );
    }

    if (mode === 'ssoRecover') {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <KeyboardAvoidingView
                    behavior="padding"
                    style={{ flex: 1 }}
                >
                    <ScrollView key={mode} contentContainerStyle={styles.scroll}>
                        <View style={styles.card}>
                            <Text style={styles.title} accessibilityRole="header">
                                🌐 Recover with Social Sign-In
                            </Text>
                            <Text style={styles.subtitle}>
                                Enter your callsign and node address to restore your account with any linked sign-in.
                            </Text>

                            <TextInput
                                accessibilityLabel="Callsign"
                                style={styles.input}
                                placeholder="Your Callsign (e.g. Monnunit)"
                                placeholderTextColor={colors.text.muted}
                                value={ssoCallsign}
                                onChangeText={setSsoCallsign}
                                autoCapitalize="none"
                                autoCorrect={false}
                                editable={!loading}
                            />

                            <TextInput
                                accessibilityLabel="Community Node URL"
                                style={styles.input}
                                placeholder="Community Node (e.g. test.beanpool.org)"
                                placeholderTextColor={colors.text.muted}
                                value={recoveryAnchorUrl}
                                onChangeText={setRecoveryAnchorUrl}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!loading}
                            />

                            {loading && (
                                <View style={{ alignItems: 'center', marginVertical: 16 }} accessibilityLiveRegion="polite">
                                    <ActivityIndicator size="large" color={palette.blue600} />
                                    <Text style={{ marginTop: 12, color: colors.text.secondary, fontSize: 14, textAlign: 'center' }}>
                                        {ssoProgressMessage || 'Verifying sign-in...'}
                                    </Text>
                                </View>
                            )}

                            {error && <Text style={styles.error}>{error}</Text>}

                            {!loading && (
                                <>
                                    {Platform.OS === 'ios' && (
                                        <AppleButton
                                            title="Recover with Apple"
                                            onPress={() => handleSsoRecover('apple')}
                                            style={{ marginBottom: 10, width: '100%' }}
                                        />
                                    )}
                                    <GoogleButton
                                        title="Recover with Google"
                                        onPress={() => handleSsoRecover('google')}
                                        style={{ marginBottom: 10, width: '100%' }}
                                    />
                                    <FacebookButton
                                        title="Recover with Facebook"
                                        onPress={() => handleSsoRecover('facebook')}
                                        style={{ marginBottom: 10, width: '100%' }}
                                    />
                                    <GitHubButton
                                        title="Recover with GitHub"
                                        onPress={() => handleSsoRecover('github')}
                                        style={{ marginBottom: 10, width: '100%' }}
                                    />
                                </>
                            )}

                            <Pressable
                                style={styles.backBtn}
                                onPress={() => { setMode('member'); setError(null); }}
                                disabled={loading}
                                accessibilityRole="button"
                                accessibilityLabel="Back to Restore Options"
                            >
                                <Text style={styles.backBtnText}>← Back to Restore Options</Text>
                            </Pressable>
                        </View>
                    </ScrollView>
                </KeyboardAvoidingView>
            </SafeAreaView>
        );
    }



    // --- MAIN WELCOME SCREEN (two choices like the PWA) ---
    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="dark" />
            <View style={{ flex: 1, justifyContent: 'center', padding: 24, alignItems: 'center' }}>
                <Text style={styles.headerTitle}>Welcome to BeanPool</Text>
                <Text style={styles.headerSubtitle}>
                    Trade skills, goods and favours with your local community — no bank, no fees. Your account lives safely on this device: no passwords, no emails, nothing to remember.
                </Text>

                {/* Nearly every first launch is a new user (or someone who
                    downloaded the app without realising it's invite-only), so
                    joining is THE primary action; restoring an account on a
                    new phone is the rare case and lives as a quiet link below. */}
                <Pressable style={styles.memberBtn} onPress={() => setMode('create')} accessibilityRole="button">
                    <Text style={styles.memberBtnText}>🎟️ I'm New Here</Text>
                </Pressable>

                <Text style={styles.inviteOnlyHint}>
                    BeanPool is invite-only — you join with an invite from a member.{'\n'}
                    No invite yet? Ask a friend on BeanPool, or find a community near you at{' '}
                    <Text style={styles.tosLink} onPress={() => openLink('https://beanpool.org')}>beanpool.org</Text>.
                </Text>

                {clipboardMayHaveInvite && (Clipboard.isPasteButtonAvailable ? (
                    <View style={styles.clipboardHintBox}>
                        <Text style={styles.clipboardHintText}>📋 Been sent an invite? Tap Paste to open it</Text>
                        <Clipboard.ClipboardPasteButton
                            onPress={(data) => { if (data.type === 'text') applyInviteContent(data.text, 'home'); }}
                            acceptedContentTypes={['plain-text', 'url']}
                            displayMode="iconAndLabel"
                            backgroundColor={palette.blue600}
                            foregroundColor={colors.text.inverse}
                            cornerStyle="capsule"
                            style={styles.homePasteSystemBtn}
                        />
                    </View>
                ) : (
                    <Pressable style={styles.clipboardHintBtn} onPress={handleCheckClipboardInvite} accessibilityRole="button">
                        <Text style={styles.clipboardHintText}>📋 Been sent an invite? Tap to check your clipboard</Text>
                    </Pressable>
                ))}

                <Pressable
                    style={styles.restoreSecondaryBtn}
                    onPress={() => setMode('member')}
                    accessibilityRole="button"
                    accessibilityLabel="Already a Member? Restore Account"
                >
                    <Text style={styles.restoreSecondaryBtnText}>🔑 Already a Member? Restore Account →</Text>
                </Pressable>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.app },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    headerTitle: { fontSize: 24, fontWeight: 'bold', color: colors.text.heading, textAlign: 'center', marginBottom: 8 },
    headerSubtitle: { fontSize: 16, color: colors.text.secondary, textAlign: 'center', marginBottom: 32, lineHeight: 24 },
    card: { width: '100%', backgroundColor: colors.surface.card, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
    inviteVerifiedBox: { backgroundColor: 'rgba(34, 197, 94, 0.10)', borderWidth: 1, borderColor: 'rgba(34, 197, 94, 0.35)', borderRadius: 12, padding: 12, marginBottom: 16 },
    inviteVerifiedText: { color: palette.green700 || '#15803d', fontSize: 14, lineHeight: 20 },
    clipboardHintBtn: { marginTop: 20, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, backgroundColor: 'rgba(59, 130, 246, 0.08)', borderWidth: 1, borderColor: 'rgba(59, 130, 246, 0.3)' },
    clipboardHintText: { color: palette.blue600, fontSize: 14, fontWeight: '600', textAlign: 'center' },
    clipboardHintBox: { marginTop: 20, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 16, backgroundColor: 'rgba(59, 130, 246, 0.08)', borderWidth: 1, borderColor: 'rgba(59, 130, 246, 0.3)', alignItems: 'center', width: '100%' },
    homePasteSystemBtn: { width: 170, height: 44, marginTop: 12 },
    tosText: { fontSize: 12, color: colors.text.secondary, textAlign: 'center', marginTop: 16, lineHeight: 17 },
    tosLink: { color: palette.blue600, textDecorationLine: 'underline' },
    inviteOnlyHint: { fontSize: 16, color: colors.text.secondary, textAlign: 'center', lineHeight: 22, marginTop: 4 },
    restoreSecondaryBtn: {
        marginTop: 20,
        paddingVertical: 14,
        paddingHorizontal: 20,
        borderRadius: 14,
        backgroundColor: colors.surface.card,
        borderWidth: 1,
        borderColor: colors.border.default,
        alignItems: 'center',
        width: '100%',
        minHeight: 48,
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.04,
        shadowRadius: 4,
        elevation: 1,
    },
    restoreSecondaryBtnText: {
        color: palette.blue600,
        fontSize: 15,
        fontWeight: '700',
    },
    restorePromptBox: {
        marginTop: 16,
        padding: 14,
        borderRadius: 14,
        backgroundColor: 'rgba(59, 130, 246, 0.08)',
        borderWidth: 1,
        borderColor: 'rgba(59, 130, 246, 0.25)',
        alignItems: 'center',
        width: '100%',
    },
    restorePromptLabel: {
        color: colors.text.secondary,
        fontSize: 13,
        marginBottom: 8,
        fontWeight: '500',
        textAlign: 'center',
    },
    restorePromptBtn: {
        width: '100%',
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: palette.blue600,
        backgroundColor: 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
    },
    restorePromptBtnText: {
        color: palette.blue600,
        fontSize: 14,
        fontWeight: '700',
    },
    title: { fontSize: 20, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 },
    subtitle: { fontSize: 14, color: colors.text.secondary, marginBottom: 24, lineHeight: 20 },
    input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 14, color: colors.text.heading, fontSize: 16, marginBottom: 16 },
    fieldHint: { fontSize: 13, color: colors.text.secondary, marginTop: -8, marginBottom: 16, lineHeight: 18 },
    pasteBtn: { backgroundColor: colors.surface.subtle, paddingHorizontal: 16, paddingVertical: 12, borderLeftWidth: 1, borderColor: colors.border.strong, justifyContent: 'center' },
    pasteBtnText: { color: palette.gray600, fontSize: 14, fontWeight: '600' },
    pasteCard: { backgroundColor: 'rgba(59, 130, 246, 0.08)', borderWidth: 1, borderColor: 'rgba(59, 130, 246, 0.3)', borderRadius: 12, padding: 14, marginBottom: 16, alignItems: 'center' },
    pasteCardText: { color: colors.text.body, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 12 },
    pasteCardSystemBtn: { width: 170, height: 44 },
    pasteCardBtn: { backgroundColor: palette.blue600, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 999, alignItems: 'center' },
    pasteCardBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: '700' },

    // Callsign (Step 1) — larger, labeled input
    callsignLabel: { fontSize: 18, fontWeight: '700', color: colors.text.body, marginBottom: 8, marginTop: 8 },
    callsignInput: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 16, color: colors.text.heading, fontSize: 16, marginBottom: 8 },
    callsignHelper: { fontSize: 13, color: colors.text.secondary, marginBottom: 4, lineHeight: 18 },
    callsignTip: { fontSize: 13, color: colors.text.muted, marginBottom: 20, fontStyle: 'italic' },

    // Main welcome buttons
    memberBtn: { backgroundColor: palette.blue600, padding: 18, borderRadius: 14, alignItems: 'center', width: '100%', marginBottom: 12, shadowColor: palette.blue600, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 14, elevation: 6 },
    memberBtnText: { color: colors.text.inverse, fontSize: 18, fontWeight: '700' },
    secondaryBtn: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border.strong, padding: 16, borderRadius: 14, alignItems: 'center', width: '100%' },
    secondaryBtnText: { color: palette.gray600, fontSize: 16, fontWeight: '600' },

    // Member sub-options
    ssoRecoverBtn: { width: '100%', padding: 16, borderRadius: 14, borderWidth: 1, borderColor: '#93C5FD', backgroundColor: '#EFF6FF', alignItems: 'center', marginBottom: 10 },
    ssoRecoverBtnText: { color: '#1D4ED8', fontSize: 16, fontWeight: '700' },
    recoverBtn: { width: '100%', padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.onboarding.recoverBorder, backgroundColor: colors.onboarding.recoverBg, alignItems: 'center', marginBottom: 10 },
    recoverBtnText: { color: palette.amber800, fontSize: 16, fontWeight: '700' },
    socialRecoverBtn: { width: '100%', padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.onboarding.socialRecoverBorder, backgroundColor: colors.onboarding.socialRecoverBg, alignItems: 'center', marginBottom: 10 },
    socialRecoverBtnText: { color: palette.emerald700, fontSize: 16, fontWeight: '700' },

    primaryBtn: { backgroundColor: palette.blue600, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 8 },
    primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: 'bold' },
    disabledBtn: { backgroundColor: palette.slate300 },
    // Identity-overwrite guard (confirm-replace screen)
    emphasis: { fontWeight: '700', color: colors.text.heading },
    replaceWarnBox: { backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border, borderRadius: 12, padding: 14, marginBottom: 16 },
    replaceWarnText: { color: colors.feedback.warning.fg, fontSize: 15, lineHeight: 22 },
    replaceBackupIntro: { color: colors.text.secondary, fontSize: 14, lineHeight: 20, marginBottom: 12 },
    noSeedWarnBox: { backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border, borderRadius: 12, padding: 14, marginBottom: 16 },
    noSeedWarnText: { color: colors.feedback.danger.fg, fontSize: 15, lineHeight: 22 },
    wipeLabel: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, letterSpacing: 1, marginTop: 8, marginBottom: 8 },
    dangerBtn: { backgroundColor: colors.feedback.danger.solid, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 8 },
    dangerBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: 'bold' },
    backBtn: { marginTop: 16, alignItems: 'center', padding: 10 },
    backBtnText: { color: colors.text.secondary, fontSize: 14 },
    error: { color: colors.feedback.danger.solid, fontSize: 14, marginBottom: 16, textAlign: 'center' },
    checkbox: { flexDirection: 'row', alignItems: 'center', marginVertical: 16, padding: 12, backgroundColor: colors.surface.subtle, borderRadius: 8 },
    checkboxActive: { backgroundColor: palette.blue100 },
    checkboxText: { color: colors.text.heading, fontSize: 14, fontWeight: '600' },
    seedGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
    seedCell: { width: '31%', backgroundColor: colors.surface.subtle, borderRadius: 8, padding: 8, marginBottom: 8, alignItems: 'center' },
    seedIndex: { color: colors.text.muted, fontSize: 10 },
    seedWord: { color: colors.text.heading, fontSize: 14, fontWeight: 'bold', minHeight: 20 },
    recoveryGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 },
    recoveryInput: { width: '31%', backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 8, padding: 8, color: colors.text.heading, fontSize: 12, marginBottom: 8, textAlign: 'center' }
});

// Styles for the "Who Are You?" profile setup gate
const profileStyles = StyleSheet.create({
    previewContainer: {
        alignItems: 'center',
        marginBottom: 24,
    },
    previewImage: {
        width: 96,
        height: 96,
        borderRadius: 48,
        borderWidth: 3,
        borderColor: palette.blue600,
        overflow: 'hidden',
    },
    previewPlaceholder: {
        width: 96,
        height: 96,
        borderRadius: 48,
        backgroundColor: colors.surface.subtle,
        borderWidth: 2,
        borderColor: colors.border.strong,
        borderStyle: 'dashed',
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewPlaceholderText: {
        fontSize: 36,
        fontWeight: '800',
        color: colors.text.muted,
    },
    previewCallsign: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.text.body,
        marginTop: 8,
    },
    trinityRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 10,
        marginBottom: 20,
    },
    trinityCard: {
        flex: 1,
        backgroundColor: colors.surface.app,
        borderWidth: 1,
        borderColor: colors.border.default,
        borderRadius: 14,
        paddingVertical: 16,
        alignItems: 'center',
        gap: 6,
    },
    trinityCardActive: {
        borderColor: palette.blue600,
        backgroundColor: colors.onboarding.trinityActiveBg,
    },
    trinityEmoji: {
        fontSize: 28,
    },
    trinityLabel: {
        fontSize: 13,
        fontWeight: '600',
        color: palette.gray600,
    },
    avatarGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 10,
        marginBottom: 20,
        paddingVertical: 12,
        paddingHorizontal: 4,
        backgroundColor: colors.surface.subtle,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border.default,
    },
    avatarGridItem: {
        width: 60,
        height: 60,
        borderRadius: 30,
        overflow: 'hidden',
        borderWidth: 2,
        borderColor: 'transparent',
    },
    avatarGridItemSelected: {
        borderColor: palette.blue600,
        shadowColor: palette.blue600,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.6,
        shadowRadius: 8,
        elevation: 6,
    },
    avatarGridImage: {
        width: '100%',
        height: '100%',
    },
});

// Styles for the onboarding progress stepper
const stepperStyles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
        paddingHorizontal: 8,
    },
    stepItem: {
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    dot: {
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: colors.border.strong,
        marginBottom: 6,
    },
    dotActive: {
        backgroundColor: palette.blue600,
        width: 14,
        height: 14,
        borderRadius: 7,
    },
    dotCompleted: {
        backgroundColor: palette.green500,
        width: 14,
        height: 14,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dotCheck: {
        color: colors.text.inverse,
        fontSize: 9,
        fontWeight: '800',
    },
    label: {
        fontSize: 11,
        color: colors.text.secondary,
        fontWeight: '500',
    },
    labelActive: {
        color: colors.text.heading,
        fontWeight: '700',
    },
    line: {
        width: 20,
        height: 2,
        backgroundColor: colors.border.strong,
        marginBottom: 18,
        marginHorizontal: 2,
    },
    lineActive: {
        backgroundColor: palette.green500,
    },
});

const guideStyles = StyleSheet.create({
    card: {
        backgroundColor: colors.surface.app,
        borderWidth: 1,
        borderColor: colors.border.default,
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.text.body,
        marginBottom: 8,
    },
    cardText: {
        fontSize: 14,
        color: palette.gray600,
        lineHeight: 20,
    },
    highlightBox: {
        backgroundColor: colors.onboarding.highlightBg,
        borderWidth: 1,
        borderColor: colors.onboarding.highlightBorder,
        borderRadius: 8,
        padding: 12,
        marginTop: 10,
    },
    highlightText: {
        fontSize: 13,
        color: palette.green800,
        lineHeight: 18,
    },
    bulletRow: {
        flexDirection: 'row',
        marginTop: 12,
        alignItems: 'flex-start',
    },
    bulletEmoji: {
        fontSize: 18,
        marginRight: 10,
        marginTop: 2,
    },
    bulletContent: {
        flex: 1,
    },
    bulletTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: palette.gray700,
        marginBottom: 2,
    },
    bulletText: {
        fontSize: 13,
        color: colors.text.secondary,
        lineHeight: 18,
    },
    bulletItem: {
        fontSize: 13,
        color: palette.gray600,
        lineHeight: 18,
        marginBottom: 8,
    }
});
