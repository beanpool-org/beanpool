/**
 * "Claim ‹community›": become the first owner of a community server that has none yet, with the one-time code its first
 * boot wrote on the server. Opened only for a node that answered GET /api/local/claim `unclaimed: true`: from the
 * `beanpool://claim?node=…[&id=…][&code=…]` link (the terminal QR `beanpool claim` prints, the manager's unclaimed card),
 * from Find a community's address check, or with no server yet from "Set up a new community server" (Find a community,
 * Start a community: components/SetUpServerRow.tsx) and the first screen's "Installed BeanPool on a server? Claim it",
 * where Scan the code reads the server's QR before its address is known. utils/node-claim.ts has the steps and the
 * reasons; the code never leaves the phone.
 *
 * On a phone with no account the claim makes it (DESIGN-account-without-global-fable.md §2.2): a self-hosted community's
 * first owner needs nothing of ours. The name is typed here, and at the tap, after the phone's unlock, a key is made for
 * this phone and written to it just before the claim goes (utils/claim-key.ts); then the join wizard's photo, 12 words and
 * How it Works, and the owner's card last (app/welcome.tsx). A phone with an account claims with it, exactly as before.
 *
 * One column at 320dp and 1.3× font, 48dp targets, as settings-signin.tsx. The full address is shown wrapped, never
 * truncated: it is the one thing a phishing server cannot make look right.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Alert, Modal, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t, tn, upperCase } from '@beanpool/core';
import { claimOutcomeWords, keyLineWords } from '../components/key-lines';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStyles, useTheme } from './ThemeContext';
import { useIdentity } from './IdentityContext';
import { useManageNode } from '../components/useManageNode';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { communitySwitched } from '../utils/community-switch';
import { fetchMembership } from '../utils/membership-probe';
import { assertPlainNodeAddress, plainOriginOf } from '../utils/node-url';
import { hasDeviceLock, requireDeviceUnlock, NO_DEVICE_LOCK_MESSAGE } from '../utils/node-admin';
import {
    claimCodeDigits, claimCodeFromDigits, claimCodeFromScan, claimNodeOrigin,
    claimSuccessActions, ownerCheckViaRole, readClaimStatus, readNodeAddresses, type ClaimOutcome, type ClaimStatus,
} from '../utils/node-claim';
import { CLAIM_CODE_PLACEHOLDER, claimLinkFromScan, parseClaimLink } from '../utils/claim-link';
import {
    checkOwnClaim, claimKeyForThisPhone, claimKeyState, claimWithKey, finishClaim, releaseClaimKey, type ClaimKeyState,
} from '../utils/claim-key';
import type { JoinKey } from '../utils/door-key';
import type { BeanPoolIdentity } from '../utils/identity';
import { numberNudge, numberOnlyAddress } from '../utils/address-follow';

export { ErrorBoundary };

type Phase = 'form' | 'unlocking' | 'checking' | 'claiming' | 'done';

export default function ClaimCommunityScreen() {
    const params = useLocalSearchParams<{ node?: string; refused?: string; id?: string; code?: string }>();
    const { identity } = useIdentity();

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        // In capitals by the language's rule (upperCase below), never a textTransform.
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, paddingVertical: 4 },
        scroll: { padding: 16 },
        title: { fontSize: 22, fontWeight: '800', color: colors.text.heading, lineHeight: 28 },
        address: { fontSize: 15, color: colors.text.secondary, marginTop: 4, lineHeight: 21, fontFamily: 'monospace' },
        lead: { fontSize: 15, color: colors.text.body, lineHeight: 21, marginTop: 12 },
        label: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, marginTop: 16, marginBottom: 4 },
        // The code box: `claim-` on its own line, the 19 characters under it, so the whole code shows at once, the way
        // the server prints it. At 320dp and 1.3× font: 288dp of content (320 − 2×16), minus 2 of border and 2×12 of
        // padding = 262dp for the input; 19 monospace characters at 16×1.3 = 20.8dp (≈0.6em, 12.5dp each) take 237dp.
        codeBox: { borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.app, paddingHorizontal: 12, paddingTop: 8 },
        codePrefix: { fontSize: 16, color: colors.text.secondary, fontFamily: 'monospace' },
        codeInput: { minHeight: 48, fontSize: 16, color: colors.text.heading, fontFamily: 'monospace', paddingVertical: 8, paddingHorizontal: 0 },
        // Straight on the doodle pattern: body ink at 14, not the labels' grey at 13, which the pattern's strokes ran
        // through in light at 320dp and 1.3× (emulator, 18 Oct).
        hint: { fontSize: 14, color: colors.text.body, marginTop: 6, lineHeight: 20 },
        input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.app, color: colors.text.heading, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
        primary: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
        primaryText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
        secondaryText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
        error: { fontSize: 15, color: colors.feedback.danger.fg, marginTop: 12, lineHeight: 21 },
        note: { fontSize: 15, color: colors.text.body, marginTop: 12, lineHeight: 21 },
        // A card on the page for what the member must know before going on: a claim not confirmed yet, no screen lock.
        // Body ink on the card, as every card reads in light and dark.
        card: { marginTop: 16, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card },
        cardTitle: { fontSize: 15, fontWeight: '700', color: colors.text.heading, lineHeight: 21 },
        cardText: { fontSize: 15, color: colors.text.body, marginTop: 4, lineHeight: 21 },
        busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
        scanWrap: { flex: 1, backgroundColor: '#000' },
        scanClose: { position: 'absolute', top: 48, right: 16, width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
        scanHint: { position: 'absolute', left: 16, right: 16, bottom: 48, color: '#fff', fontSize: 15, lineHeight: 21, textAlign: 'center' },
    }));
    const { colors } = useTheme();
    const placeholder = colors.text.muted;

    // ── Which node ──────────────────────────────────────────────────────────────────────────────────────
    const linkNode = typeof params.node === 'string' ? claimNodeOrigin(params.node) : null;
    const [origin, setOrigin] = useState<string | null>(linkNode);
    const [addressInput, setAddressInput] = useState('');
    const [addressError, setAddressError] = useState<string | null>(
        params.refused === '1' ? t("The link named an address BeanPool won't use. Type the server's address instead.") : null,
    );
    const [status, setStatus] = useState<ClaimStatus | null>(null);
    const [isMember, setIsMember] = useState<boolean | null>(null);

    const loadStatus = useCallback(async (o: string) => {
        setStatus(null);
        const s = await readClaimStatus(o);
        setStatus(s);
    }, []);

    useEffect(() => { if (origin) loadStatus(origin); }, [origin, loadStatus]);

    // ── Which key ───────────────────────────────────────────────────────────────────────────────────────
    // Read from the phone (utils/claim-key.ts claimKeyState): the app's identity is set only once the join wizard ends.
    const [phoneKey, setPhoneKey] = useState<ClaimKeyState | null>(null);
    const refreshPhoneKey = useCallback(async (o: string | null) => { setPhoneKey(await claimKeyState(o)); }, []);
    useEffect(() => { void refreshPhoneKey(origin); }, [origin, identity, refreshPhoneKey]);
    /** The phone's own account, which claims as it always has. */
    const account = phoneKey?.kind === 'account' ? phoneKey.identity : null;
    /** The claim's own key, on the phone from an earlier tap (a refusal, or a restart while its answer was out). */
    const ownKey = phoneKey?.kind === 'claims' ? phoneKey.key : null;
    /** No account on the phone, or the claim's own: the claim makes the account, with the name typed here. */
    const makesAccount = phoneKey !== null && phoneKey.kind !== 'account';
    /** A key made at a tap that never reached the phone (the claim stopped before it was written): used again next tap. */
    const heldKey = useRef<JoinKey | null>(null);
    const manage = useManageNode(account);

    useEffect(() => {
        if (!origin || !account) { setIsMember(null); return; }
        let alive = true;
        fetchMembership(origin, { publicKey: account.publicKey, privateKey: account.privateKey })
            .then(async r => (r.ok ? (await r.json())?.isMember === true : false))
            .catch(() => false)
            .then(m => { if (alive) setIsMember(m); });
        return () => { alive = false; };
    }, [origin, account]);

    // An owner's phone needs a screen lock (DESIGN §3.8): said before the name is typed, never only after the tap.
    const [lockSet, setLockSet] = useState<boolean | null>(null);
    useEffect(() => {
        if (!makesAccount) return;
        let alive = true;
        hasDeviceLock().then(l => { if (alive) setLockSet(l); });
        return () => { alive = false; };
    }, [makesAccount]);

    const checkAddress = () => {
        const o = claimNodeOrigin(addressInput);
        if (!o) { setAddressError(t("That doesn't look like a server address BeanPool can use. Check it on the server.")); return; }
        setAddressError(null);
        setOrigin(o);
    };

    // ── The code and the callsign ───────────────────────────────────────────────────────────────────────
    const [link, setLink] = useState(() => ({
        code: typeof params.code === 'string' ? params.code : '',
        id: typeof params.id === 'string' ? params.id : '',
    }));
    const { code: linkCode, id: linkId } = link;
    // A QR with the code but no address (the server had none yet): the code is kept for the server typed next.
    const [scanNote, setScanNote] = useState<string | null>(null);
    const [digits, setDigits] = useState(() => (linkCode ? claimCodeDigits(linkCode) : ''));
    const [callsign, setCallsign] = useState('');
    const [phase, setPhase] = useState<Phase>('form');
    const [error, setError] = useState<string | null>(null);
    /** The claim's answer never came, or the node's owner check didn't answer: it may have landed (DESIGN §2.2 check-again). */
    const [unconfirmed, setUnconfirmed] = useState(false);
    /** Another key owns the community, and the key the claim made came off the phone again: nothing was made here. */
    const [released, setReleased] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    const scanLock = useRef(false);

    // The name kept with the claim's own key, after a restart: the member typed it before.
    useEffect(() => {
        if (phoneKey?.kind === 'claims') setCallsign(c => c || phoneKey.callsign);
    }, [phoneKey]);

    // A link made for an older code: its code is no good here. Keyed on the link itself, so a scan that brings the same
    // older code again is emptied again.
    const staleLink = status?.kind === 'unclaimed' && !!linkId && linkId !== status.codeId;
    useEffect(() => { if (staleLink && link.code) setDigits(''); }, [staleLink, link]);

    // The server's name, cleaned (claim-link.ts cleanClaimName), or the address's host when nothing was left of it.
    const name = (status && 'communityName' in status && status.communityName) || 'this community';
    /** The server's name for the screen's words, or null where the server gave none (the claim keeps `name`). */
    const named = (status && 'communityName' in status && status.communityName) || null;
    /** The name kept for the owner's card at the wizard's end, whatever the status says by then. */
    const namedAtClaim = useRef<string | null>(null);
    if (named) namedAtClaim.current = named;

    const paste = async () => {
        const text = (await Clipboard.getStringAsync().catch(() => '')) || '';
        const fromLink = origin ? claimCodeFromScan(text, origin) : null;
        setDigits(claimCodeDigits(fromLink ?? text));
    };

    const openScanner = async () => {
        if (!permission?.granted) {
            const p = await requestPermission();
            if (!p.granted) {
                // With no server yet the step has no code box: the address is what can be typed instead.
                Alert.alert(t('Camera is off'), origin
                    ? t('Allow the camera for BeanPool in your phone settings, or type the code.')
                    : t("Allow the camera for BeanPool in your phone settings, or type the server's address."));
                return;
            }
        }
        scanLock.current = false;
        setScanning(true);
    };

    const onScanned = ({ data }: BarcodeScanningResult) => {
        if (scanLock.current) return;
        if (!origin) {
            // No server yet: its QR names it, as the `beanpool://claim` link does when the phone's camera opens it.
            const scanned = claimLinkFromScan(data);
            if (!scanned) return;
            scanLock.current = true;
            setScanning(false);
            // The box always holds this scan's code, or nothing: an address-only QR (the settings page's) never inherits
            // the code an earlier scan or link put there, which the stale check cannot see once `link` has no code.
            setLink({ code: scanned.code ?? '', id: scanned.codeId ?? '' });
            setDigits(scanned.code ? claimCodeDigits(scanned.code) : '');
            if (scanned.node) {
                setAddressError(null);
                setScanNote(null);
                setOrigin(scanned.node);
                return;
            }
            setAddressError(scanned.nodeRefused ? t("The QR code named an address BeanPool won't use. Type the server's address instead.") : null);
            setScanNote(scanned.code ? t("The code is filled in. Now type the server's address.") : null);
            return;
        }
        const code = claimCodeFromScan(data, origin);
        if (!code) return;
        scanLock.current = true;
        // What was just read is the link now: the server's current QR ends "made a new code", an older one is caught
        // again. A bare code carries no id, so nothing is left to call stale.
        setLink({ code, id: parseClaimLink(data)?.codeId ?? '' });
        setDigits(claimCodeDigits(code));
        setScanning(false);
    };

    // ── The claim ───────────────────────────────────────────────────────────────────────────────────────
    const code = claimCodeFromDigits(digits);
    const needsCallsign = makesAccount || isMember === false;
    const callsignOk = !needsCallsign || callsign.trim().length >= 2;
    // The phone's account claims once the node said whether it is a member there; a new account needs only its name.
    const keyReady = makesAccount || (!!account && isMember !== null);
    const canClaim = phase === 'form' && status?.kind === 'unclaimed' && !!code && callsignOk && keyReady;
    const busy = phase === 'unlocking' || phase === 'checking' || phase === 'claiming';

    const [isAnchor, setIsAnchor] = useState(false);
    const [hasAddress, setHasAddress] = useState<boolean | null>(null);
    // Claimed at the server's public number, with no name yet: the owner is told what that means for members (D3).
    const [numberOnly, setNumberOnly] = useState<string | null>(null);
    const [switching, setSwitching] = useState(false);

    const afterOwner = async (o: string) => {
        const anchor = await getAnchorUrl().catch(() => null);
        setIsAnchor(!!anchor && plainOriginOf(anchor.replace(/\/+$/, '')) === o);
        const addresses = await readNodeAddresses(o);
        setHasAddress(addresses ? addresses.length > 0 : null);
        setNumberOnly(numberOnlyAddress(o, addresses));
        setPhase('done');
    };

    /** Where a claim's answer takes the member (DESIGN §2.2 "The answers"). */
    const afterClaim = async (o: string, out: ClaimOutcome, claimedBy: BeanPoolIdentity, madeHere: boolean, cameOff: boolean) => {
        if (out.kind === 'owner') {
            if (!madeHere) { await afterOwner(o); return; }
            // The account the claim made: the join wizard's photo, 12 words, How it Works and the owner's card, from the
            // record finishClaim writes (app/welcome.tsx resumes it). One welcome, never this screen under it.
            heldKey.current = null;
            await finishClaim(o, claimedBy, namedAtClaim.current, out.callsign);
            if (router.canDismiss()) router.dismissAll();
            router.replace('/welcome');
            return;
        }
        setPhase('form');
        if (cameOff) {
            heldKey.current = null;
            setReleased(true);
        }
        // The claim's own key, with no answer: kept, and the member can ask again (Check again).
        const notYet = makesAccount && !cameOff && out.kind === 'check-again';
        setUnconfirmed(notYet);
        setError(notYet || cameOff ? null : claimOutcomeWords(out, name));
        await refreshPhoneKey(o);
        if (out.kind === 'code-changed') { setDigits(''); loadStatus(o); }
        if (out.kind === 'already-claimed') loadStatus(o);
    };

    const claim = async () => {
        if (!canClaim || !origin || status?.kind !== 'unclaimed' || !code) return;
        const o = origin;
        setError(null);
        setPhase('unlocking');
        // The phone's lock asks in the member's language, the same English node-admin.ts writes when given none. With
        // no screen lock nothing is made: the lock is the owner's factor (D2).
        const unlock = await requireDeviceUnlock(name, t("Confirm it's you to manage {name}", { name }));
        if (unlock === 'no-device-lock') {
            setPhase('form');
            Alert.alert(t('Set a screen lock first'), makesAccount
                ? t("An owner's phone needs a screen lock. Set one in your phone's settings, then try again.")
                : keyLineWords(NO_DEVICE_LOCK_MESSAGE));
            return;
        }
        if (unlock !== 'ok') { setPhase('form'); return; }
        setPhase('checking');
        // The key (DESIGN §2.2 step 2): the phone's own when it has one, never a second; else the claim's own; else a new
        // one, in memory until the claim is about to go (utils/claim-key.ts).
        const key = await claimKeyForThisPhone(o, ownKey ?? heldKey.current);
        if (key.createdHere) heldKey.current = key;
        const result = await claimWithKey({
            origin: o, key, code, codeId: status.codeId, salt: status.salt,
            callsign: key.createdHere || makesAccount ? callsign.trim() : needsCallsign ? callsign : '',
            isOwner: ownerCheckViaRole,
            onSending: () => setPhase('claiming'),
        });
        await afterClaim(o, result.outcome, result.identity, result.madeHere, result.released);
    };

    /** Check again: did a claim by the claim's own key land? Asked of the node (utils/claim-key.ts checkOwnClaim). */
    const checkAgain = async () => {
        if (!origin || !ownKey || busy) return;
        const o = origin;
        setError(null);
        setPhase('checking');
        const { outcome, released: cameOff } = await checkOwnClaim(o, ownKey, ownerCheckViaRole);
        // A server that still has no owner: the claim never reached it, and the form is there to try again.
        if (outcome.kind === 'error') {
            setPhase('form');
            setUnconfirmed(false);
            setError(claimOutcomeWords(outcome, name));
            await loadStatus(o);
            return;
        }
        await afterClaim(o, outcome, ownKey.identity, true, cameOff);
    };

    // The claim's own key, back after a restart (welcome hands it here) to a server that has an owner now: whose? Asked
    // once, by itself; Check again asks again.
    const askedOnArrival = useRef(false);
    useEffect(() => {
        if (askedOnArrival.current || status?.kind !== 'claimed' || phoneKey?.kind !== 'claims' || phase !== 'form') return;
        askedOnArrival.current = true;
        void checkAgain();
    });

    const makeMine = async () => {
        if (!origin || switching) return;
        setSwitching(true);
        try {
            assertPlainNodeAddress(origin);
            // Each community has its own local database: swapped the way node-mismatch.tsx and Settings do.
            const { closeDB, initDB } = await import('../utils/db');
            await closeDB();
            await AsyncStorage.setItem('beanpool_anchor_url', origin);
            await initDB();
            communitySwitched();
            setIsAnchor(true);
        } catch (e: any) {
            Alert.alert(named ? t("Couldn't switch to {name}", { name: named }) : t("Couldn't switch to this community"), e?.message ? keyLineWords(e.message) : t('Try again.'));
        } finally {
            setSwitching(false);
        }
    };

    // ── Leaving ─────────────────────────────────────────────────────────────────────────────────────────
    // While the claim is out, nothing: its answer decides. Otherwise the claim's own key comes off the phone, with its
    // record, only when no claim it signed can have landed (utils/claim-key.ts releaseClaimKey): a key the node may hold
    // as owner stays, and the next launch comes back here with it. The phone's own account never comes off.
    const leave = () => {
        if (busy) return;
        void (async () => {
            const key = ownKey ?? heldKey.current;
            if (origin && key) await releaseClaimKey(origin, key);
            heldKey.current = null;
            if (router.canGoBack()) router.back();
            else router.replace(account ? '/(tabs)' : '/welcome');
        })();
    };
    // Android's back button too: the same way out, so a key the claim made never stays behind by another door.
    const leaveRef = useRef(leave);
    leaveRef.current = leave;
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => { leaveRef.current(); return true; });
        return () => sub.remove();
    }, []);

    // ── Screens ─────────────────────────────────────────────────────────────────────────────────────────
    const header = (
        <View style={styles.header}>
            <Pressable onPress={leave} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                <MaterialCommunityIcons name="arrow-left" size={24} color={placeholder} />
            </Pressable>
            {/* 208dp between the two 48dp slots; at 1.3× the words take two lines rather than an ellipsis. The community's
                name is never here: it is the body's title, which wraps. */}
            <Text style={styles.headerTitle} numberOfLines={2} accessibilityRole="header">{upperCase(t('Claim a community'))}</Text>
            <View style={styles.backButton} />
        </View>
    );

    // The claim's own key may be the node's owner already: said with Check again, wherever the screen is.
    const showUnconfirmed = unconfirmed || (phoneKey?.kind === 'claims' && phoneKey.joinsOut > 0 && status?.kind !== 'unclaimed' && !busy);
    const unconfirmedCard = showUnconfirmed ? (
        <View style={styles.card} testID="claim-unconfirmed" accessibilityLiveRegion="polite">
            <Text style={styles.cardTitle}>{t("We couldn't confirm the claim yet. It may have worked.")}</Text>
            <Text style={styles.cardText}>{t('Your account is kept on this phone until the server answers.')}</Text>
            <View style={styles.actions}>
                <Pressable style={styles.secondary} onPress={checkAgain} disabled={busy} accessibilityRole="button" testID="claim-check-again">
                    <Text style={styles.secondaryText}>{t('Check again')}</Text>
                </Pressable>
            </View>
        </View>
    ) : null;

    let body: React.ReactNode;
    if (!origin) {
        body = (
            <>
                <Text style={styles.title}>{t('Claim a community')}</Text>
                <Text style={styles.lead}>{t('Scan the QR code your server shows, or type its address.')}</Text>
                <View style={styles.actions}>
                    <Pressable style={styles.secondary} onPress={openScanner} accessibilityRole="button" testID="claim-scan-server">
                        <MaterialCommunityIcons name="qrcode-scan" size={20} color={placeholder} />
                        <Text style={styles.secondaryText}>{t('Scan the code')}</Text>
                    </Pressable>
                </View>
                {scanNote ? <Text style={styles.note} testID="claim-scan-note">{scanNote}</Text> : null}
                <Text style={styles.lead}>{t('The address of the server you installed, as you reach it from this phone.')}</Text>
                <Text style={styles.label}>{t('Server address')}</Text>
                <TextInput
                    style={styles.input}
                    value={addressInput}
                    onChangeText={setAddressInput}
                    placeholder="https://beans.example.org"
                    placeholderTextColor={placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    onSubmitEditing={checkAddress}
                    accessibilityLabel={t('Server address')}
                />
                {addressError ? <Text style={styles.error}>{addressError}</Text> : null}
                <Pressable style={styles.primary} onPress={checkAddress} accessibilityRole="button">
                    <Text style={styles.primaryText}>{t('Check this server')}</Text>
                </Pressable>
            </>
        );
    } else if (phase === 'done') {
        const actions = claimSuccessActions({ isAnchor, hasAddress });
        body = (
            <>
                <Text style={styles.title}>{named ? t('You own {name}', { name: named }) : t('You own this community')}</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                <Text style={styles.lead}>{t("This phone's screen lock is how you manage it; keep it on. Add a second owner soon.")}</Text>
                {numberOnly ? <Text style={styles.note} testID="claim-number-nudge">{numberNudge(numberOnly)}</Text> : null}
                {actions.includes('set-address') || actions.includes('open-settings') ? (
                    <Pressable style={styles.primary} onPress={() => manage.start(name)} disabled={manage.busy} accessibilityRole="button">
                        <Text style={styles.primaryText}>{manage.busy ? t('Opening…') : actions.includes('set-address') ? t('Set the address') : t('Open Settings')}</Text>
                    </Pressable>
                ) : null}
                {actions.includes('make-mine') ? (
                    <>
                        <Text style={styles.note}>
                            {named
                                ? t("This phone belongs to another community. To manage {name} from here, make it this phone's community.", { name: named })
                                : t("This phone belongs to another community. To manage this community from here, make it this phone's community.")}
                        </Text>
                        <Pressable style={styles.primary} onPress={makeMine} disabled={switching} accessibilityRole="button">
                            <Text style={styles.primaryText}>{switching ? t('Switching…') : named ? t('Make {name} my community', { name: named }) : t('Make this community my community')}</Text>
                        </Pressable>
                        <View style={styles.actions}>
                            <Pressable style={styles.secondary} onPress={() => router.replace('/(tabs)')} accessibilityRole="button">
                                <Text style={styles.secondaryText}>{t('Not now')}</Text>
                            </Pressable>
                        </View>
                    </>
                ) : null}
                {manage.dialog}
            </>
        );
    } else if (!status) {
        body = (
            <View style={styles.busyRow}>
                <ActivityIndicator />
                <Text style={styles.note}>{t('Asking the server…')}</Text>
            </View>
        );
    } else if (status.kind === 'claimed' && released) {
        // Another phone won the race (DESIGN §3.3): the key this claim made came off again. The phone is as it was.
        body = (
            <>
                <Text style={styles.title} testID="claim-someone-owns">{claimOutcomeWords({ kind: 'already-claimed' }, named ?? name)}</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                <Text style={styles.note}>{t('Nothing was made on this phone.')}</Text>
                <Pressable style={styles.primary} onPress={leave} accessibilityRole="button">
                    <Text style={styles.primaryText}>{t('Back')}</Text>
                </Pressable>
            </>
        );
    } else if (status.kind === 'claimed' && phoneKey?.kind === 'claims') {
        // The claim's own key, and the server has an owner now: whose is being asked (above), or couldn't be told.
        body = (
            <>
                <Text style={styles.title}>{named ? t('Claim {name}', { name: named }) : t('Claim this community')}</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                {busy ? (
                    <View style={styles.busyRow}>
                        <ActivityIndicator />
                        <Text style={styles.note}>{t('Asking the server…')}</Text>
                    </View>
                ) : unconfirmedCard}
                {error ? <Text style={styles.error} selectable>{error}</Text> : null}
            </>
        );
    } else if (status.kind === 'claimed') {
        body = (
            <>
                <Text style={styles.title}>{named ? t('{name} already has an owner', { name: named }) : t('This community already has an owner')}</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                <Text style={styles.note}>{t('Only a server with no owner yet can be claimed. Ask its owner to make you one.')}</Text>
            </>
        );
    } else if (status.kind !== 'unclaimed') {
        body = (
            <>
                <Text style={styles.title}>{t('Claim a community')}</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                {unconfirmedCard}
                <Text style={styles.error}>
                    {status.kind === 'no-code' ? t('This server has no claim code. Restart it to make one.')
                        : status.kind === 'busy'
                            // One English form for both, as the screen wrote it ("in 1 seconds"): the other languages get theirs.
                            ? (status.retryAfter ? tn(status.retryAfter, 'The server is busy. Try again in {n} seconds.', 'The server is busy. Try again in {n} seconds.') : t('The server is busy. Try again in a moment.'))
                            : keyLineWords(status.message)}
                </Text>
                <View style={styles.actions}>
                    <Pressable style={styles.secondary} onPress={() => loadStatus(origin)} accessibilityRole="button">
                        <Text style={styles.secondaryText}>{t('Try again')}</Text>
                    </Pressable>
                    <Pressable style={styles.secondary} onPress={() => { setOrigin(null); setStatus(null); }} accessibilityRole="button">
                        <Text style={styles.secondaryText}>{t('Another address')}</Text>
                    </Pressable>
                </View>
            </>
        );
    } else {
        body = (
            <>
                <Text style={styles.title}>{named ? t('Claim {name}', { name: named }) : t('Claim this community')}</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                <Text style={styles.lead}>{t('This community has no owner yet. Its one-time code is on its server.')}</Text>
                {makesAccount ? (
                    <>
                        {/* What the tap does, before anything is typed (DESIGN §4). Nothing is made by reading the screen. */}
                        <Text style={styles.lead} testID="claim-makes-account">
                            {named
                                ? t('Claiming makes your BeanPool account on this phone, and makes it the owner of {name}.', { name: named })
                                : t('Claiming makes your BeanPool account on this phone, and makes it the owner of this community.')}
                        </Text>
                        <Text style={styles.lead} testID="claim-only-yours">{t('Only claim a server you installed yourself.')}</Text>
                    </>
                ) : null}
                {unconfirmedCard}
                {staleLink ? <Text style={styles.note}>{t('The server made a new code since this link. Read the code on the server again.')}</Text> : null}

                <Text style={styles.label}>{t('Claim code')}</Text>
                <View style={styles.codeBox}>
                    <Text style={styles.codePrefix}>claim-</Text>
                    <TextInput
                        style={styles.codeInput}
                        value={digits}
                        onChangeText={text => setDigits(claimCodeDigits(text))}
                        placeholder={CLAIM_CODE_PLACEHOLDER}
                        placeholderTextColor={placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                        maxLength={19}
                        editable={!busy}
                        accessibilityLabel={t('Claim code')}
                    />
                </View>
                <Text style={styles.hint} testID="claim-code-hint">{t('The code is on your server: {command} shows it.', { command: 'beanpool claim' })}</Text>
                <View style={styles.actions}>
                    <Pressable style={styles.secondary} onPress={paste} disabled={busy} accessibilityRole="button">
                        <MaterialCommunityIcons name="content-paste" size={20} color={placeholder} />
                        <Text style={styles.secondaryText}>{t('Paste')}</Text>
                    </Pressable>
                    <Pressable style={styles.secondary} onPress={openScanner} disabled={busy} accessibilityRole="button">
                        <MaterialCommunityIcons name="qrcode-scan" size={20} color={placeholder} />
                        <Text style={styles.secondaryText}>{t('Scan the code')}</Text>
                    </Pressable>
                </View>

                {makesAccount && lockSet === false ? (
                    <View style={styles.card} testID="claim-no-lock">
                        <Text style={styles.cardTitle}>{t('Set a screen lock first')}</Text>
                        <Text style={styles.cardText}>{t("An owner's phone needs a screen lock. Set one in your phone's settings, then try again.")}</Text>
                    </View>
                ) : null}

                {needsCallsign ? (
                    <>
                        <Text style={styles.label}>{t('Your name here')}</Text>
                        <TextInput
                            style={styles.input}
                            value={callsign}
                            onChangeText={text => setCallsign(text.slice(0, 20))}
                            placeholder={t('Your callsign')}
                            placeholderTextColor={placeholder}
                            autoCorrect={false}
                            editable={!busy}
                            accessibilityLabel={t('Your callsign')}
                        />
                        {makesAccount ? (
                            <Text style={styles.hint} testID="claim-name-hint">
                                {named
                                    ? t('How people in {name} will see you. You can change it later.', { name: named })
                                    : t('How people in this community will see you. You can change it later.')}
                            </Text>
                        ) : null}
                    </>
                ) : null}

                {error ? <Text style={styles.error} selectable>{error}</Text> : null}

                {phase === 'checking' || phase === 'claiming' ? (
                    <View style={styles.busyRow}>
                        <ActivityIndicator />
                        <Text style={styles.note}>{phase === 'claiming' ? t('Claiming…') : t('Checking the code…')}</Text>
                    </View>
                ) : (
                    <Pressable
                        style={[styles.primary, !canClaim && { opacity: 0.5 }]}
                        onPress={claim}
                        disabled={!canClaim}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canClaim }}
                    >
                        <Text style={styles.primaryText}>{t('Claim and become owner')}</Text>
                    </Pressable>
                )}
            </>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            {header}
            <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                {body}
            </KeyboardAwareScrollView>
            <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
                <View style={styles.scanWrap}>
                    <CameraView style={StyleSheet.absoluteFillObject} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScanned} />
                    <Text style={styles.scanHint}>{t("Point the camera at the claim QR on the server's screen.")}</Text>
                    <Pressable style={styles.scanClose} onPress={() => setScanning(false)} accessibilityRole="button" accessibilityLabel={t('Close the camera')}>
                        <MaterialCommunityIcons name="close" size={24} color="#fff" />
                    </Pressable>
                </View>
            </Modal>
        </SafeAreaView>
    );
}
