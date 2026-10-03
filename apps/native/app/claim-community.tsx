/**
 * "Claim ‹community›": become the first owner of a community server that has none yet, with the one-time code its first
 * boot wrote on the server. Opened only for a node that answered GET /api/local/claim `unclaimed: true`: from the
 * `beanpool://claim?node=…[&id=…][&code=…]` link (the terminal QR `beanpool claim` prints, the manager's unclaimed card)
 * or from Find a community's address check. utils/node-claim.ts has the steps and the reasons; the code never leaves
 * the phone.
 *
 * One column at 320dp and 1.3× font, 48dp targets, as settings-signin.tsx. The full address is shown wrapped, never
 * truncated: it is the one thing a phishing server cannot make look right.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Alert, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
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
import { requireDeviceUnlock, NO_DEVICE_LOCK_MESSAGE } from '../utils/node-admin';
import {
    claimCodeDigits, claimCodeFromDigits, claimCodeFromScan, claimCommunity, claimNodeOrigin, claimOutcomeMessage,
    claimSuccessActions, ownerCheckViaRole, readClaimStatus, readNodeHasAddress, type ClaimStatus,
} from '../utils/node-claim';

export { ErrorBoundary };

type Phase = 'form' | 'unlocking' | 'checking' | 'done';

export default function ClaimCommunityScreen() {
    const params = useLocalSearchParams<{ node?: string; refused?: string; id?: string; code?: string }>();
    const { identity } = useIdentity();
    const manage = useManageNode();

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        scroll: { padding: 16 },
        title: { fontSize: 22, fontWeight: '800', color: colors.text.heading, lineHeight: 28 },
        address: { fontSize: 15, color: colors.text.secondary, marginTop: 4, lineHeight: 21, fontFamily: 'monospace' },
        lead: { fontSize: 15, color: colors.text.body, lineHeight: 21, marginTop: 12 },
        label: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, marginTop: 16, marginBottom: 4 },
        codeRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.app, paddingHorizontal: 12 },
        codePrefix: { fontSize: 16, color: colors.text.secondary, fontFamily: 'monospace' },
        codeInput: { flex: 1, minWidth: 0, minHeight: 48, fontSize: 16, color: colors.text.heading, fontFamily: 'monospace', paddingVertical: 8 },
        input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.app, color: colors.text.heading, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
        primary: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
        primaryText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
        secondaryText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
        error: { fontSize: 15, color: colors.feedback.danger.fg, marginTop: 12, lineHeight: 21 },
        note: { fontSize: 15, color: colors.text.body, marginTop: 12, lineHeight: 21 },
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
        params.refused === '1' ? "The link named an address BeanPool won't use. Type the server's address instead." : null,
    );
    const [status, setStatus] = useState<ClaimStatus | null>(null);
    const [isMember, setIsMember] = useState<boolean | null>(null);

    const loadStatus = useCallback(async (o: string) => {
        setStatus(null);
        const s = await readClaimStatus(o);
        setStatus(s);
    }, []);

    useEffect(() => { if (origin) loadStatus(origin); }, [origin, loadStatus]);

    useEffect(() => {
        if (!origin || !identity) return;
        let alive = true;
        fetchMembership(origin, { publicKey: identity.publicKey, privateKey: identity.privateKey })
            .then(async r => (r.ok ? (await r.json())?.isMember === true : false))
            .catch(() => false)
            .then(m => { if (alive) setIsMember(m); });
        return () => { alive = false; };
    }, [origin, identity]);

    const checkAddress = () => {
        const o = claimNodeOrigin(addressInput);
        if (!o) { setAddressError("That doesn't look like a server address BeanPool can use. Check it on the server."); return; }
        setAddressError(null);
        setOrigin(o);
    };

    // ── The code and the callsign ───────────────────────────────────────────────────────────────────────
    const linkCode = typeof params.code === 'string' ? params.code : '';
    const linkId = typeof params.id === 'string' ? params.id : '';
    const [digits, setDigits] = useState(() => (linkCode ? claimCodeDigits(linkCode) : ''));
    const [callsign, setCallsign] = useState('');
    const [phase, setPhase] = useState<Phase>('form');
    const [error, setError] = useState<string | null>(null);
    const [scanning, setScanning] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    const scanLock = useRef(false);

    // A link made for an older code: its code is no good here.
    const staleLink = status?.kind === 'unclaimed' && !!linkId && linkId !== status.codeId;
    useEffect(() => { if (staleLink && linkCode) setDigits(''); }, [staleLink, linkCode]);

    const name = (status && 'communityName' in status && status.communityName) || 'this community';

    const paste = async () => {
        const text = (await Clipboard.getStringAsync().catch(() => '')) || '';
        const fromLink = origin ? claimCodeFromScan(text, origin) : null;
        setDigits(claimCodeDigits(fromLink ?? text));
    };

    const openScanner = async () => {
        if (!permission?.granted) {
            const p = await requestPermission();
            if (!p.granted) { Alert.alert('Camera is off', 'Allow the camera for BeanPool in your phone settings, or type the code.'); return; }
        }
        scanLock.current = false;
        setScanning(true);
    };

    const onScanned = ({ data }: BarcodeScanningResult) => {
        if (scanLock.current || !origin) return;
        const code = claimCodeFromScan(data, origin);
        if (!code) return;
        scanLock.current = true;
        setDigits(claimCodeDigits(code));
        setScanning(false);
    };

    // ── The claim ───────────────────────────────────────────────────────────────────────────────────────
    const code = claimCodeFromDigits(digits);
    const needsCallsign = isMember === false;
    const callsignOk = !needsCallsign || callsign.trim().length >= 2;
    const canClaim = phase === 'form' && status?.kind === 'unclaimed' && !!code && callsignOk && !!identity && isMember !== null;

    const [isAnchor, setIsAnchor] = useState(false);
    const [hasAddress, setHasAddress] = useState<boolean | null>(null);
    const [switching, setSwitching] = useState(false);

    const afterOwner = async (o: string) => {
        const anchor = await getAnchorUrl().catch(() => null);
        setIsAnchor(!!anchor && plainOriginOf(anchor.replace(/\/+$/, '')) === o);
        setHasAddress(await readNodeHasAddress(o));
        setPhase('done');
    };

    const claim = async () => {
        if (!canClaim || !origin || !identity || status?.kind !== 'unclaimed' || !code) return;
        setError(null);
        setPhase('unlocking');
        const unlock = await requireDeviceUnlock(name);
        if (unlock === 'no-device-lock') {
            setPhase('form');
            Alert.alert('Set a screen lock first', NO_DEVICE_LOCK_MESSAGE);
            return;
        }
        if (unlock !== 'ok') { setPhase('form'); return; }
        setPhase('checking');
        const out = await claimCommunity({
            origin, identity, code, codeId: status.codeId, salt: status.salt,
            callsign: needsCallsign ? callsign : '', isOwner: ownerCheckViaRole,
        });
        if (out.kind === 'owner') { await afterOwner(origin); return; }
        setPhase('form');
        setError(claimOutcomeMessage(out, name));
        if (out.kind === 'code-changed') { setDigits(''); loadStatus(origin); }
        if (out.kind === 'already-claimed') loadStatus(origin);
    };

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
            Alert.alert(`Couldn't switch to ${name}`, e?.message || 'Try again.');
        } finally {
            setSwitching(false);
        }
    };

    // ── Screens ─────────────────────────────────────────────────────────────────────────────────────────
    const header = (
        <View style={styles.header}>
            <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
                <MaterialCommunityIcons name="arrow-left" size={24} color={placeholder} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>Claim a community</Text>
            <View style={styles.backButton} />
        </View>
    );

    let body: React.ReactNode;
    if (!identity) {
        body = <Text style={styles.note}>This phone has no BeanPool account yet. Set one up first, then open the claim link again.</Text>;
    } else if (!origin) {
        body = (
            <>
                <Text style={styles.title}>Claim a community</Text>
                <Text style={styles.lead}>The address of the server you installed, as you reach it from this phone.</Text>
                <Text style={styles.label}>Server address</Text>
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
                    accessibilityLabel="Server address"
                />
                {addressError ? <Text style={styles.error}>{addressError}</Text> : null}
                <Pressable style={styles.primary} onPress={checkAddress} accessibilityRole="button">
                    <Text style={styles.primaryText}>Check this server</Text>
                </Pressable>
            </>
        );
    } else if (phase === 'done') {
        const actions = claimSuccessActions({ isAnchor, hasAddress });
        body = (
            <>
                <Text style={styles.title}>You own {name}</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                <Text style={styles.lead}>This phone's screen lock is how you manage it; keep it on. Add a second owner soon.</Text>
                {actions.includes('set-address') || actions.includes('open-settings') ? (
                    <Pressable style={styles.primary} onPress={() => manage.start(name)} disabled={manage.busy} accessibilityRole="button">
                        <Text style={styles.primaryText}>{manage.busy ? 'Opening…' : actions.includes('set-address') ? 'Set the address' : 'Open Settings'}</Text>
                    </Pressable>
                ) : null}
                {actions.includes('make-mine') ? (
                    <>
                        <Text style={styles.note}>This phone belongs to another community. To manage {name} from here, make it this phone's community.</Text>
                        <Pressable style={styles.primary} onPress={makeMine} disabled={switching} accessibilityRole="button">
                            <Text style={styles.primaryText}>{switching ? 'Switching…' : `Make ${name} my community`}</Text>
                        </Pressable>
                        <View style={styles.actions}>
                            <Pressable style={styles.secondary} onPress={() => router.replace('/(tabs)')} accessibilityRole="button">
                                <Text style={styles.secondaryText}>Not now</Text>
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
                <Text style={styles.note}>Asking the server…</Text>
            </View>
        );
    } else if (status.kind === 'claimed') {
        body = (
            <>
                <Text style={styles.title}>{name === 'this community' ? 'This community' : name} already has an owner</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                <Text style={styles.note}>Only a server with no owner yet can be claimed. Ask its owner to make you one.</Text>
            </>
        );
    } else if (status.kind !== 'unclaimed') {
        body = (
            <>
                <Text style={styles.title}>Claim a community</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                <Text style={styles.error}>
                    {status.kind === 'no-code' ? 'This server has no claim code. Restart it to make one.'
                        : status.kind === 'busy' ? `The server is busy. Try again${status.retryAfter ? ` in ${status.retryAfter} seconds` : ' in a moment'}.`
                            : status.message}
                </Text>
                <View style={styles.actions}>
                    <Pressable style={styles.secondary} onPress={() => loadStatus(origin)} accessibilityRole="button">
                        <Text style={styles.secondaryText}>Try again</Text>
                    </Pressable>
                    <Pressable style={styles.secondary} onPress={() => { setOrigin(null); setStatus(null); }} accessibilityRole="button">
                        <Text style={styles.secondaryText}>Another address</Text>
                    </Pressable>
                </View>
            </>
        );
    } else {
        const busy = phase !== 'form';
        body = (
            <>
                <Text style={styles.title}>Claim {name}</Text>
                <Text style={styles.address} selectable>{origin}</Text>
                <Text style={styles.lead}>This community has no owner yet. Its one-time code is on its server.</Text>
                {staleLink ? <Text style={styles.note}>The server made a new code since this link. Read the code on the server again.</Text> : null}

                <Text style={styles.label}>Claim code</Text>
                <View style={styles.codeRow}>
                    <Text style={styles.codePrefix}>claim-</Text>
                    <TextInput
                        style={styles.codeInput}
                        value={digits}
                        onChangeText={t => setDigits(claimCodeDigits(t))}
                        placeholder="a1b2-c3d4-e5f6-7890"
                        placeholderTextColor={placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                        maxLength={19}
                        editable={!busy}
                        accessibilityLabel="Claim code"
                    />
                </View>
                <View style={styles.actions}>
                    <Pressable style={styles.secondary} onPress={paste} disabled={busy} accessibilityRole="button">
                        <MaterialCommunityIcons name="content-paste" size={20} color={placeholder} />
                        <Text style={styles.secondaryText}>Paste</Text>
                    </Pressable>
                    <Pressable style={styles.secondary} onPress={openScanner} disabled={busy} accessibilityRole="button">
                        <MaterialCommunityIcons name="qrcode-scan" size={20} color={placeholder} />
                        <Text style={styles.secondaryText}>Scan the code</Text>
                    </Pressable>
                </View>

                {needsCallsign ? (
                    <>
                        <Text style={styles.label}>Your name here</Text>
                        <TextInput
                            style={styles.input}
                            value={callsign}
                            onChangeText={t => setCallsign(t.slice(0, 20))}
                            placeholder="Your callsign"
                            placeholderTextColor={placeholder}
                            autoCorrect={false}
                            editable={!busy}
                            accessibilityLabel="Your callsign"
                        />
                    </>
                ) : null}

                {error ? <Text style={styles.error} selectable>{error}</Text> : null}

                {phase === 'checking' ? (
                    <View style={styles.busyRow}>
                        <ActivityIndicator />
                        <Text style={styles.note}>Checking the code…</Text>
                    </View>
                ) : (
                    <Pressable
                        style={[styles.primary, !canClaim && { opacity: 0.5 }]}
                        onPress={claim}
                        disabled={!canClaim}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canClaim }}
                    >
                        <Text style={styles.primaryText}>Claim and become owner</Text>
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
                    <Text style={styles.scanHint}>Point the camera at the claim QR on the server's screen.</Text>
                    <Pressable style={styles.scanClose} onPress={() => setScanning(false)} accessibilityRole="button" accessibilityLabel="Close the camera">
                        <MaterialCommunityIcons name="close" size={24} color="#fff" />
                    </Pressable>
                </View>
            </Modal>
        </SafeAreaView>
    );
}
