/**
 * "An admin gave me a re-key code" (#1768; design DESIGN-rekey-redeem-fable.md §5): a member who lost their phone takes
 * over their account on this one. They scan the QR on the admin's screen, or type the code and their community; the
 * phone asks and shows two digits; the admin types them on the dashboard, and the node binds the phone showing them.
 *
 * Reached from Restore your account (welcome.tsx), from a `https://<node>/?rekey=RK-…` link (_layout.tsx), and on the next
 * launch while an ask is waiting (welcome.tsx resumes it). The flow itself is utils/rekey-redeem.ts, where it is tested:
 * the key is written down before anything is sent, the phone's own account is never written over, and every step can be
 * taken again. Holds at 320 dp and 1.3× text: every row wraps, nothing has a fixed width.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Alert, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStyles, useTheme } from './ThemeContext';
import { useIdentity } from './IdentityContext';
import { communitySwitched } from '../utils/community-switch';
import { assertPlainNodeAddress } from '../utils/node-url';
import { draftIdentity, getMnemonic, importIdentity, loadIdentity, type BeanPoolIdentity } from '../utils/identity';
import { buildSignedHeaders } from '../utils/crypto';
import { signReEnrollStatement } from '../utils/member-statements';
import { rekeySlotStore } from '../utils/rekey-slot-store';
import { attestJustCompletedRekey } from '../utils/key-succession';
import {
    abandonRekey, askRekey, beginRekey, cleanRekeyCode, endsRekey, finishRekey, parseRekeyLink, pollRekey, rekeyCommunityUrl, resumeRekey,
    REKEY_POLL_MS, REKEY_TEXT, RekeyHeldError, type RekeyAnswer, type RekeyDeps, type RekeySlot,
} from '../utils/rekey-redeem';

type Phase = 'form' | 'asking' | 'waiting' | 'words' | 'linkAgain' | 'ended';

const deps: RekeyDeps = {
    slot: rekeySlotStore,
    loadIdentity,
    draftIdentity: () => draftIdentity(''),
    importIdentity,
    signStatement: signReEnrollStatement,
    signedHeaders: buildSignedHeaders,
    fetch: (input, init) => fetch(input, init),
};

/** Time left on the code, in words. */
function timeLeft(expiresAt: string, now: number): string {
    const ms = new Date(expiresAt).getTime() - now;
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'The code has expired.';
    const min = Math.max(1, Math.floor(ms / 60000));
    return min >= 60 ? `The code works for ${Math.floor(min / 60)} h ${min % 60} min more.` : `The code works for ${min} min more.`;
}

/** The phone already had an account: it moves onto this community too, as joining another community does. */
async function moveOntoCommunity(url: string, name: string): Promise<void> {
    assertPlainNodeAddress(url);
    const db = await import('../utils/db');
    const nodes = await import('../utils/nodes');
    await db.closeDB();
    await AsyncStorage.setItem('beanpool_anchor_url', url);
    await db.initDB();
    communitySwitched();
    await nodes.addSavedNode(url, name || undefined).catch(() => {});
}

/** A community address as the admin would know it: "mullum.example.org". */
function hostOf(community: string | undefined): string {
    if (!community) return '';
    try { return new URL(community).host; } catch { return community; }
}

export default function RekeyCodeScreen() {
    const params = useLocalSearchParams<{ link?: string }>();
    const { setIdentity } = useIdentity();
    const { colors } = useTheme();
    const styles = useStyles(({ theme, colors: c }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: c.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: c.border.default, backgroundColor: theme === 'dark' ? c.surface.card : c.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: c.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase', paddingVertical: 4 },
        scroll: { padding: 16 },
        title: { fontSize: 22, fontWeight: '800', color: c.text.heading, lineHeight: 28 },
        lead: { fontSize: 15, color: c.text.body, lineHeight: 21, marginTop: 12 },
        label: { fontSize: 13, fontWeight: '700', color: c.text.secondary, marginTop: 16, marginBottom: 4 },
        input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: c.border.strong, backgroundColor: c.surface.app, color: c.text.heading, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
        codeInput: { fontFamily: 'monospace', letterSpacing: 1 },
        primary: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: c.brand.primary, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
        primaryText: { color: c.text.inverse, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: c.border.strong, backgroundColor: c.surface.card, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginTop: 12 },
        secondaryText: { color: c.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
        error: { fontSize: 15, color: c.feedback.danger.fg, marginTop: 12, lineHeight: 21 },
        note: { fontSize: 15, color: c.text.body, marginTop: 12, lineHeight: 21 },
        numberCard: { marginTop: 16, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: c.border.strong, backgroundColor: c.surface.card, alignItems: 'center' },
        numberLabel: { fontSize: 15, color: c.text.body, textAlign: 'center', lineHeight: 21 },
        number: { fontSize: 56, fontWeight: '900', color: c.text.heading, letterSpacing: 6, marginVertical: 8, fontFamily: 'monospace' },
        busyRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 16 },
        words: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
        word: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.app },
        wordText: { fontSize: 15, color: c.text.heading, fontFamily: 'monospace' },
        tickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, minHeight: 48 },
        tickText: { flex: 1, fontSize: 15, color: c.text.body, lineHeight: 21 },
        scanWrap: { flex: 1, backgroundColor: '#000' },
        scanClose: { position: 'absolute', top: 48, right: 16, width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
        scanHint: { position: 'absolute', left: 16, right: 16, bottom: 48, color: '#fff', fontSize: 15, lineHeight: 21, textAlign: 'center' },
    }));

    const fromLink = useMemo(() => (typeof params.link === 'string' ? parseRekeyLink(params.link) : null), [params.link]);
    const [community, setCommunity] = useState(fromLink?.community ?? '');
    const [code, setCode] = useState(fromLink?.code ?? '');
    const [phase, setPhase] = useState<Phase>('form');
    const [error, setError] = useState<string | null>(null);
    /**
     * An earlier ask showed a number and its node can't be reached (or it was bound, and this phone holds another account
     * since): the form offers to forget it (#1783 review C1). Never while its node still waits for the number (D1).
     */
    const [heldHost, setHeldHost] = useState<string | null>(null);
    const [slot, setSlot] = useState<RekeySlot | null>(null);
    const [match, setMatch] = useState<string | null>(null);
    const [expiresAt, setExpiresAt] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const [newWords, setNewWords] = useState<string[] | null>(null);
    // The node removed sign-in copies of the old key in the move: only then is the member asked to link one again.
    const [linkSignInAgain, setLinkSignInAgain] = useState(false);
    const [wroteThemDown, setWroteThemDown] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    const scanLock = useRef(false);
    const finishing = useRef(false);

    /** The member is bound: save, move onto the community, then the words (a new key) or the sign-in nudge. */
    const onBound = useCallback(async (s: RekeySlot, answer: { callsign: string; communityName: string; linkSignInAgain: boolean }) => {
        if (finishing.current) return;
        finishing.current = true;
        setLinkSignInAgain(answer.linkSignInAgain);
        try {
            const done = await finishRekey(s, answer, deps);
            if (done.newWords) {
                assertPlainNodeAddress(s.community);
                await AsyncStorage.setItem('beanpool_anchor_url', s.community);
                communitySwitched();
            } else {
                await moveOntoCommunity(s.community, answer.communityName);
            }
            setIdentity(done.identity as BeanPoolIdentity);
            // This key confirms the old one was this member's, so their old group lines keep their name (line-display
            // design §5). The member just did the re-key here, so nothing is asked; a failure is asked about at the next
            // sign-in instead (app/_layout.tsx).
            attestJustCompletedRekey(s.community, done.identity as BeanPoolIdentity).catch(() => {});
            if (done.newWords) {
                setNewWords(await getMnemonic(done.identity));
                setPhase('words');
            } else {
                setPhase('linkAgain');
            }
        } catch (e) {
            finishing.current = false;
            setError(e instanceof Error ? e.message : REKEY_TEXT.changedAccount);
            setPhase('ended');
        }
    }, [setIdentity]);

    /** One answer from the node, read into the screen. */
    const apply = useCallback(async (s: RekeySlot, answer: RekeyAnswer) => {
        if (answer.state === 'waiting') {
            setMatch(answer.match);
            setExpiresAt(answer.expiresAt);
            setError(null);
            setPhase('waiting');
        } else if (answer.state === 'bound') {
            await onBound(s, answer);
        } else if (answer.state === 'unreachable') {
            setError(REKEY_TEXT.unreachable);
        } else {
            if (endsRekey(answer)) await abandonRekey(deps);
            setError(answer.state === 'declined' ? REKEY_TEXT.declined : answer.state === 'gone' ? REKEY_TEXT.gone : answer.message);
            setPhase(endsRekey(answer) ? 'ended' : 'form');
        }
    }, [onBound]);

    // An ask left waiting (the app was closed): asked once more, with the same key. Once per visit to the screen: the
    // record is kept after Not now, so a second run would put the number back after the member left it.
    const resumed = useRef(false);
    useEffect(() => {
        if (fromLink || resumed.current) return;
        resumed.current = true;
        let alive = true;
        (async () => {
            const r = await resumeRekey(deps);
            if (!alive || !r) return;
            setSlot(r.slot);
            setCommunity(r.slot.community);
            setCode(r.slot.code);
            await apply(r.slot, r.answer);
        })();
        return () => { alive = false; };
    }, [fromLink, apply]);

    // While the number shows: ask every few seconds whether the admin bound this phone.
    useEffect(() => {
        if (phase !== 'waiting' || !slot) return;
        const id = setInterval(async () => {
            setNow(Date.now());
            const answer = await pollRekey(slot, deps);
            if (answer.state !== 'unreachable' && answer.state !== 'waiting') await apply(slot, answer);
        }, REKEY_POLL_MS);
        return () => clearInterval(id);
    }, [phase, slot, apply]);

    const ask = async () => {
        setError(null);
        setHeldHost(null);
        const url = rekeyCommunityUrl(community);
        if (!url) { setError('Type your community’s name or address, as your admin gave it.'); return; }
        setPhase('asking');
        try {
            const s = await beginRekey(url, code, deps);
            // An earlier ask its node bound comes back instead, to be finished (#1783 review D1): the form says which.
            if (s.community !== url || s.code !== cleanRekeyCode(code)) { setCommunity(s.community); setCode(s.code); }
            setSlot(s);
            await apply(s, await askRekey(s, deps));
        } catch (e) {
            setError(e instanceof Error ? e.message : REKEY_TEXT.unreachable);
            if (e instanceof RekeyHeldError && e.canForget) setHeldHost(e.host);
            setPhase('form');
        }
        setPhase((p) => (p === 'asking' ? 'form' : p));
    };

    // The way out when an earlier ask can't be checked: its record and key go, after one warning.
    const forgetHeld = () => {
        if (!heldHost) return;
        Alert.alert(`Forget the re-key at ${heldHost}?`, `If an admin at ${heldHost} has typed the number this phone showed, or types it later, your account there moves to a key this phone will no longer have. Only a new code from them gets you back in.`, [
            { text: 'Keep it', style: 'cancel' },
            { text: 'Forget it', style: 'destructive', onPress: async () => { await abandonRekey(deps); setHeldHost(null); setError(null); } },
        ]);
    };

    // Not now only leaves the number: the record and its key stay, since the admin may still type this number (#1783 review
    // N2). Continue with the same code shows the same number, and the next launch asks after it.
    const stop = () => {
        setPhase('form');
    };

    const openScanner = async () => {
        if (!permission?.granted) {
            const p = await requestPermission();
            if (!p.granted) { Alert.alert('Camera is off', 'Allow the camera for BeanPool in your phone settings, or type the code.'); return; }
        }
        scanLock.current = false;
        setScanning(true);
    };

    const onScanned = (result: BarcodeScanningResult) => {
        if (scanLock.current) return;
        const read = parseRekeyLink(result.data);
        if (!read) return;
        scanLock.current = true;
        setScanning(false);
        if (read.community) setCommunity(read.community);
        setCode(read.code);
        setError(null);
    };

    const header = (
        <View style={styles.header}>
            <Pressable style={styles.backButton} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
                <MaterialCommunityIcons name="arrow-left" size={24} color={colors.brand.primary} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={2}>Re-key code</Text>
            <View style={{ width: 48 }} />
        </View>
    );

    let body: React.ReactNode;
    if (phase === 'waiting' && match) {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">Show this number to your admin</Text>
                <View style={styles.numberCard}>
                    <Text style={styles.number} accessibilityLabel={`Number ${match.split('').join(' ')}`}>{match}</Text>
                    {/* The community this number came from, so the admin can check it is theirs: a mistyped or look-alike
                        address could relay someone else's number here (#1783 review N9). */}
                    <Text style={styles.numberLabel} testID="rekey-number-host">from {hostOf(slot?.community)}</Text>
                    <Text style={styles.numberLabel}>
                        They type it on their screen. Check the address above is your community's. Your old phone stops working for good.
                    </Text>
                </View>
                <View style={styles.busyRow}>
                    <ActivityIndicator color={colors.brand.primary} />
                    <Text style={[styles.note, { marginTop: 0, flex: 1 }]}>Waiting for your admin…</Text>
                </View>
                {expiresAt ? <Text style={styles.note}>{timeLeft(expiresAt, now)}</Text> : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Pressable style={styles.secondary} onPress={stop} accessibilityRole="button">
                    <Text style={styles.secondaryText}>Not now</Text>
                </Pressable>
            </View>
        );
    } else if (phase === 'words' && newWords) {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">You’re in</Text>
                <Text style={styles.lead}>These are the 12 words of your NEW key. Your old words no longer work. Write them down and keep them safe: they bring your account back if you lose this phone.</Text>
                <View style={styles.words}>
                    {newWords.map((w, i) => (
                        <View key={i} style={styles.word}><Text style={styles.wordText}>{i + 1}. {w}</Text></View>
                    ))}
                </View>
                <Pressable style={styles.tickRow} onPress={() => setWroteThemDown(v => !v)} accessibilityRole="checkbox" accessibilityState={{ checked: wroteThemDown }}>
                    <MaterialCommunityIcons name={wroteThemDown ? 'checkbox-marked' : 'checkbox-blank-outline'} size={28} color={colors.brand.primary} />
                    <Text style={styles.tickText}>I’ve written my 12 words down</Text>
                </Pressable>
                <Pressable style={styles.primary} onPress={() => setPhase('linkAgain')} accessibilityRole="button">
                    <Text style={styles.primaryText}>Continue</Text>
                </Pressable>
            </View>
        );
    } else if (phase === 'linkAgain' && !linkSignInAgain) {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">You’re in</Text>
                <Text style={styles.lead}>This phone now holds your account: your Beans, your name and your history.</Text>
                <Pressable style={styles.primary} onPress={() => router.replace('/(tabs)')} accessibilityRole="button">
                    <Text style={styles.primaryText}>Done</Text>
                </Pressable>
            </View>
        );
    } else if (phase === 'linkAgain') {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">Link your sign-in again</Text>
                <Text style={styles.lead}>A sign-in you had linked protected your old key, so it was removed. Link it again from this phone, so you can get back in if you lose it.</Text>
                <Pressable style={styles.primary} onPress={() => router.replace({ pathname: '/(tabs)/settings', params: { section: 'protection' } })} accessibilityRole="button">
                    <Text style={styles.primaryText}>Link my sign-in</Text>
                </Pressable>
                <Pressable style={styles.secondary} onPress={() => router.replace('/(tabs)')} accessibilityRole="button">
                    <Text style={styles.secondaryText}>Later</Text>
                </Pressable>
            </View>
        );
    } else {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">🪪 An admin gave me a re-key code</Text>
                <Text style={styles.lead}>Lost your phone and your 12 words? An admin of your community checked it’s you and made a code. This phone takes over your account: your Beans, your name and your history.</Text>
                <Pressable style={styles.secondary} onPress={openScanner} accessibilityRole="button">
                    <MaterialCommunityIcons name="qrcode-scan" size={22} color={colors.text.body} />
                    <Text style={styles.secondaryText}>Scan the code on the admin’s screen</Text>
                </Pressable>
                <Text style={styles.label}>Your community</Text>
                <TextInput
                    style={styles.input}
                    value={community}
                    onChangeText={setCommunity}
                    placeholder="Its name or address"
                    placeholderTextColor={colors.text.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    accessibilityLabel="Your community's name or address"
                />
                <Text style={styles.label}>The code</Text>
                <TextInput
                    style={[styles.input, styles.codeInput]}
                    value={code}
                    onChangeText={setCode}
                    placeholder="RK-XXXX-XXXX"
                    placeholderTextColor={colors.text.muted}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    accessibilityLabel="The re-key code"
                />
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Pressable
                    style={styles.primary}
                    onPress={ask}
                    disabled={phase === 'asking'}
                    accessibilityRole="button"
                    accessibilityLabel={phase === 'asking' ? 'Submitting re-key code...' : phase === 'ended' ? 'Try again' : 'Continue'}
                    accessibilityHint="Submits code to community node to re-enroll this device"
                    accessibilityState={{ disabled: phase === 'asking', busy: phase === 'asking' }}
                >
                    {phase === 'asking' ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryText}>{phase === 'ended' ? 'Try again' : 'Continue'}</Text>}
                </Pressable>
                {heldHost ? (
                    <Pressable style={styles.secondary} onPress={forgetHeld} accessibilityRole="button">
                        <Text style={styles.secondaryText}>Forget the re-key at {heldHost}</Text>
                    </Pressable>
                ) : null}
            </View>
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
                    <Text style={styles.scanHint}>Point the camera at the QR code on your admin’s screen.</Text>
                    <Pressable style={styles.scanClose} onPress={() => setScanning(false)} accessibilityRole="button" accessibilityLabel="Close the camera">
                        <MaterialCommunityIcons name="close" size={24} color="#fff" />
                    </Pressable>
                </View>
            </Modal>
        </SafeAreaView>
    );
}
