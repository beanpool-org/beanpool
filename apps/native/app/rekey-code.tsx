/**
 * "An admin gave me a re-key code" (#1768; design DESIGN-rekey-redeem-fable.md §5): a member who lost their phone takes
 * over their account on this one. They scan the QR on the admin's screen, or type the code and their community; the
 * phone asks and shows two digits; the admin types them on the dashboard, and the node binds the phone showing them.
 *
 * Reached from Restore your account (welcome.tsx), from a `https://<node>/?rekey=RK-…` link (_layout.tsx), and on the next
 * launch while an ask is waiting (welcome.tsx resumes it). The flow itself is utils/rekey-redeem.ts, where it is tested:
 * the key is written down before anything is sent, the phone's own account is never written over, and every step can be
 * taken again. Holds at 320 dp and 1.3× text: every row wraps, nothing has a fixed width.
 *
 * "My community can bring me back" (Restore your account's third row; vault rethink VR3, VR4) is this screen too, with a
 * BB- code. Where the member's copy is shared with BeanPool's key vault, the admin's number gets the phone its community's half
 * and voucher, and the screen waits out the vault's day (utils/community-recovery.ts): the wait survives the app closing,
 * and outlives the code.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Alert, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';

export { ErrorBoundary };
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStyles, useTheme } from './ThemeContext';
import { useIdentity } from './IdentityContext';
import { communitySwitched } from '../utils/community-switch';
import { assertPlainNodeAddress } from '../utils/node-url';
import { draftIdentity, getMnemonic, importIdentity, loadIdentity, StoredKeyUnreadableError, type BeanPoolIdentity } from '../utils/identity';
import { forgetTheLook } from '../utils/look-around';
import { useWords } from '../components/LanguageProvider';
import { keyLineWords } from '../components/key-lines';
import { upperCase } from '@beanpool/core';
import { buildSignedHeaders } from '../utils/crypto';
import { signReEnrollStatement } from '../utils/member-statements';
import { rekeySlotStore } from '../utils/rekey-slot-store';
import { holdEndsWords } from '../components/RecoveryAlertBanner';
import { VAULT_WORDS } from '../utils/vault-words';
import {
    advanceCommunityRestore, clearPendingCommunityRestore, COMMUNITY_RESTORE_POLL_MS, loadPendingCommunityRestore, takeSharedRelease,
    type PendingCommunityRestore,
} from '../utils/community-recovery';
import { attestJustCompletedRekey } from '../utils/key-succession';
import {
    abandonRekey, askRekey, beginRekey, cleanRekeyCode, endsRekey, finishRekey, isBringBackCode, openBringBack, parseRekeyLink, pollRekey,
    rekeyCommunityUrl, resumeRekey, REKEY_POLL_MS, REKEY_TEXT, RekeyHeldError, type RekeyAnswer, type RekeyDeps, type RekeySlot,
} from '../utils/rekey-redeem';

type Phase = 'form' | 'asking' | 'waiting' | 'holding' | 'words' | 'linkAgain' | 'broughtBack' | 'ended';

const deps: RekeyDeps = {
    slot: rekeySlotStore,
    loadIdentity,
    draftIdentity: () => draftIdentity(''),
    importIdentity,
    forgetLook: forgetTheLook,
    signStatement: signReEnrollStatement,
    signedHeaders: buildSignedHeaders,
    fetch: (input, init) => fetch(input, init),
};


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
    const params = useLocalSearchParams<{ link?: string; bringBack?: string }>();
    const { setIdentity } = useIdentity();
    const { t, lang } = useWords();
    /** Time left on the code, in words. */
    const timeLeft = (expiresAt: string, now: number): string => {
        const ms = new Date(expiresAt).getTime() - now;
        if (!Number.isFinite(ms)) return '';
        if (ms <= 0) return t('The code has expired.');
        const min = Math.max(1, Math.floor(ms / 60000));
        return min >= 60
            ? t('The code works for {h} h {min} min more.', { h: Math.floor(min / 60), min: min % 60 })
            : t('The code works for {min} min more.', { min });
    };
    const { colors } = useTheme();
    const styles = useStyles(({ theme, colors: c }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: c.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: c.border.default, backgroundColor: theme === 'dark' ? c.surface.card : c.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        // In capitals by the language's rule (upperCase below), never a textTransform.
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: c.brand.onDark, letterSpacing: 0.5, paddingVertical: 4 },
        scroll: { padding: 16 },
        title: { fontSize: 22, fontWeight: '800', color: c.text.heading, lineHeight: 28 },
        lead: { fontSize: 15, color: c.text.body, lineHeight: 21, marginTop: 12 },
        label: { fontSize: 13, fontWeight: '700', color: c.text.secondary, marginTop: 16, marginBottom: 4 },
        input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: c.border.strong, backgroundColor: c.surface.app, color: c.text.heading, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
        codeInput: { fontFamily: 'monospace', letterSpacing: 1 },
        primary: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, backgroundColor: c.brand.fill, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
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
    /** A bring-back (vault rethink VR3) gave the 12 words back with the account. */
    const [wordsCameBack, setWordsCameBack] = useState(false);
    /** A shared bring-back waiting at the key vault (vault rethink VR4), when it goes through, and what the vault last said. */
    const [holding, setHolding] = useState<PendingCommunityRestore | null>(null);
    const [holdUntil, setHoldUntil] = useState<number | null>(null);
    const [holdNote, setHoldNote] = useState<string | null>(null);
    const stepping = useRef(false);
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
            // An account on the phone that can't be read, or one that was not there a moment ago: never replaced (identity.ts).
            setError(e instanceof StoredKeyUnreadableError
                ? t("BeanPool can't read the account on this phone. Restart and try again, or restore with your 12 words.")
                : keyLineWords(e instanceof Error ? e.message : REKEY_TEXT.changedAccount));
            setPhase('ended');
        }
    }, [setIdentity, t]);

    /**
     * "Replace this phone's account?" (restore-account.ts clearToRestore): only when this phone holds another account,
     * which a bring-back replaces. The member's yes goes on; Keep it, or closing the question, keeps everything.
     */
    const confirmReplace = useCallback((outgoing: BeanPoolIdentity) => new Promise<boolean>((resolve) => {
        Alert.alert(
            t('Replace this phone’s account?'),
            t('This phone holds another BeanPool account ({name}). Bringing yours back replaces it, and that account comes back only with its own 12 words: Settings shows them, if you need them first.', { name: outgoing.callsign || '…' }),
            [
                { text: t('Keep it'), style: 'cancel', onPress: () => resolve(false) },
                { text: t('Replace'), style: 'destructive', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
        );
    }), [t]);

    /**
     * A bring-back that is here (vault rethink VR3, VR4): the member's SAME key, saved through the restore gate (never over
     * another account without asking), on that community. `open` gives the account; `forget` drops this flow's record once
     * it is saved.
     */
    const saveBroughtBack = useCallback(async (
        where: { community: string; communityName: string; callsign: string },
        open: () => Promise<{ publicKey: string; privateKey: string; mnemonic?: string[] }>,
        forget: () => Promise<void>,
    ) => {
        // Loaded when a bring-back is released, as this screen loads the phone's database and saved communities.
        const restore = await import('../utils/restore-account');
        try {
            const back = await open();
            const cleared = await restore.clearToRestore({
                publicKey: back.publicKey,
                privateKey: back.privateKey,
                callsign: where.callsign,
                createdAt: new Date().toISOString(),
                ...(back.mnemonic ? { mnemonic: back.mnemonic } : {}),
            }, confirmReplace);
            await restore.saveRestoredAccount(cleared, where.community);
            // The record and the key it asked with go: the account is the member's own key now.
            await forget();
            const nodes = await import('../utils/nodes');
            await nodes.addSavedNode(where.community, where.communityName || undefined).catch(() => {});
            setIdentity(cleared.identity);
            setWordsCameBack(!!cleared.identity.mnemonic?.length);
            setPhase('broughtBack');
        } catch (e) {
            finishing.current = false;
            if (e instanceof restore.RestoreStopped) {
                // The phone's account was kept: the release stays collectable while the code's day lasts.
                setError(t('The account on this phone was kept. Nothing changed.'));
                setPhase('ended');
                return;
            }
            // A replace this phone couldn't save has already taken the old account off it (its app storage and saved
            // communities, and its key unless even that failed): the app must not go on as it, as welcome.tsx's restores don't.
            if (e instanceof restore.ReplaceNotSaved) setIdentity(null);
            setError(e instanceof StoredKeyUnreadableError
                ? t("BeanPool can't read the account on this phone. Restart and try again, or restore with your 12 words.")
                : keyLineWords(e instanceof Error ? e.message : REKEY_TEXT.changedAccount));
            setPhase('ended');
        }
    }, [setIdentity, confirmReplace, t]);

    /** A bring-back the admin confirmed, of a whole copy (vault rethink VR3): it opens here and now. */
    const onBroughtBack = useCallback(async (s: RekeySlot, answer: Extract<RekeyAnswer, { state: 'released' }>) => {
        if (finishing.current) return;
        finishing.current = true;
        await saveBroughtBack({ community: s.community, communityName: answer.communityName, callsign: answer.callsign },
            () => openBringBack(s, answer, deps), () => abandonRekey(deps));
    }, [saveBroughtBack]);

    /** One step on with the vault's hold (utils/community-recovery.ts), the same however often it is asked. */
    const stepHold = useCallback(async (p: PendingCommunityRestore) => {
        if (stepping.current || finishing.current) return;
        stepping.current = true;
        try {
            const step = await advanceCommunityRestore(p);
            if (step.status === 'held') {
                setHolding(step.pending);
                setHoldUntil(step.until);
                setHoldNote(null);
            } else if (step.status === 'waiting') {
                setHolding(step.pending);
                setHoldNote(keyLineWords(step.message));
            } else if (step.status === 'stopped') {
                setHolding(null);
                setError(t(VAULT_WORDS.stopped));
                setPhase('ended');
            } else if (step.status === 'ended') {
                setHolding(null);
                setError(keyLineWords(step.message));
                setPhase('ended');
            } else {
                finishing.current = true;
                await saveBroughtBack({ community: step.pending.community, communityName: step.pending.communityName, callsign: step.pending.callsign },
                    async () => step.back, clearPendingCommunityRestore);
            }
        } finally {
            stepping.current = false;
        }
    }, [saveBroughtBack, t]);

    /** The community's half and voucher, written down first: from here the wait is the key vault's. */
    const onSharedRelease = useCallback(async (s: RekeySlot, answer: Extract<RekeyAnswer, { state: 'released' }>) => {
        try {
            const pending = await takeSharedRelease(s, answer, deps);
            setHolding(pending);
            setPhase('holding');
        } catch (e) {
            setError(keyLineWords(e instanceof Error ? e.message : REKEY_TEXT.changedAccount));
            setPhase('ended');
        }
    }, []);

    /** One answer from the node, read into the screen. */
    const apply = useCallback(async (s: RekeySlot, answer: RekeyAnswer) => {
        if (answer.state === 'waiting') {
            setMatch(answer.match);
            setExpiresAt(answer.expiresAt);
            setError(null);
            setPhase('waiting');
        } else if (answer.state === 'bound') {
            await onBound(s, answer);
        } else if (answer.state === 'released') {
            await (answer.voucher ? onSharedRelease(s, answer) : onBroughtBack(s, answer));
        } else if (answer.state === 'unreachable') {
            // A bring-back has other ways on (design §4.4); a re-key's code still works until it expires.
            setError(isBringBackCode(s.code)
                ? t("Your community's server isn't answering. Another community you turned this on in can bring you back, or use your 12 words.")
                : keyLineWords(REKEY_TEXT.unreachable));
        } else {
            if (endsRekey(answer)) await abandonRekey(deps);
            setError(keyLineWords(answer.state === 'declined' ? REKEY_TEXT.declined : answer.state === 'gone' ? REKEY_TEXT.gone : answer.message));
            setPhase(endsRekey(answer) ? 'ended' : 'form');
        }
    }, [onBound, onBroughtBack, onSharedRelease, t]);

    // An ask left waiting (the app was closed): asked once more, with the same key. Once per visit to the screen: the
    // record is kept after Not now, so a second run would put the number back after the member left it.
    const resumed = useRef(false);
    useEffect(() => {
        if (fromLink || resumed.current) return;
        resumed.current = true;
        let alive = true;
        (async () => {
            // A shared bring-back's wait outlives the code it came from: the vault, not the community, is asked now.
            const waiting = await loadPendingCommunityRestore();
            if (!alive) return;
            if (waiting) {
                setCommunity(waiting.community);
                setHolding(waiting);
                setHoldUntil(waiting.until);
                setPhase('holding');
                return;
            }
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

    // While the vault holds it: at once, then every minute, for the day it takes or less.
    const holdingFor = holding?.publicKey ?? null;
    const holdingNow = useRef<PendingCommunityRestore | null>(null);
    holdingNow.current = holding;
    useEffect(() => {
        if (phase !== 'holding' || !holdingFor) return;
        const go = () => {
            setNow(Date.now());
            if (holdingNow.current) void stepHold(holdingNow.current);
        };
        go();
        const id = setInterval(go, COMMUNITY_RESTORE_POLL_MS);
        return () => clearInterval(id);
    }, [phase, holdingFor, stepHold]);

    const ask = async () => {
        setError(null);
        setHeldHost(null);
        const url = rekeyCommunityUrl(community);
        if (!url) { setError(t('Type your community’s name or address, as your admin gave it.')); return; }
        setPhase('asking');
        try {
            const s = await beginRekey(url, code, deps);
            // An earlier ask its node bound comes back instead, to be finished (#1783 review D1): the form says which.
            if (s.community !== url || s.code !== cleanRekeyCode(code)) { setCommunity(s.community); setCode(s.code); }
            setSlot(s);
            await apply(s, await askRekey(s, deps));
        } catch (e) {
            setError(keyLineWords(e instanceof Error ? e.message : REKEY_TEXT.unreachable));
            if (e instanceof RekeyHeldError && e.canForget) setHeldHost(e.host);
            setPhase('form');
        }
        setPhase((p) => (p === 'asking' ? 'form' : p));
    };

    // The way out when an earlier ask can't be checked: its record and key go, after one warning.
    const forgetHeld = () => {
        if (!heldHost) return;
        Alert.alert(t('Forget the re-key at {host}?', { host: heldHost }), t('If an admin at {host} has typed the number this phone showed, or types it later, your account there moves to a key this phone will no longer have. Only a new code from them gets you back in.', { host: heldHost }), [
            { text: t('Keep it'), style: 'cancel' },
            { text: t('Forget it'), style: 'destructive', onPress: async () => { await abandonRekey(deps); setHeldHost(null); setError(null); } },
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
            if (!p.granted) { Alert.alert(t('Camera is off'), t('Allow the camera for BeanPool in your phone settings, or type the code.')); return; }
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

    // Came here from "My community can bring me back", or holds such a code: the same form, in that row's words.
    const bringingBack = params.bringBack === '1' || isBringBackCode(code) || phase === 'holding';
    const header = (
        <View style={styles.header}>
            <Pressable style={styles.backButton} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('Back')}>
                <MaterialCommunityIcons name="arrow-left" size={24} color={colors.brand.primary} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={2}>{upperCase(bringingBack ? t('Ways back') : t('Re-key code'), lang)}</Text>
            <View style={{ width: 48 }} />
        </View>
    );

    let body: React.ReactNode;
    if (phase === 'waiting' && match) {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">{t('Show this number to your admin')}</Text>
                <View style={styles.numberCard}>
                    <Text style={styles.number} accessibilityLabel={t('Number {digits}', { digits: match.split('').join(' ') })}>{match}</Text>
                    {/* The community this number came from, so the admin can check it is theirs: a mistyped or look-alike
                        address could relay someone else's number here (#1783 review N9). */}
                    <Text style={styles.numberLabel} testID="rekey-number-host">{t('from {host}', { host: hostOf(slot?.community) })}</Text>
                    <Text style={styles.numberLabel}>
                        {slot && isBringBackCode(slot.code)
                            ? t("They type it on their screen. Check the address above is your community's. Your account comes back on this phone, the same key.")
                            : t("They type it on their screen. Check the address above is your community's. Your old phone stops working for good.")}
                    </Text>
                </View>
                <View style={styles.busyRow}>
                    <ActivityIndicator color={colors.brand.primary} />
                    <Text style={[styles.note, { marginTop: 0, flex: 1 }]}>{t('Waiting for your admin…')}</Text>
                </View>
                {expiresAt ? <Text style={styles.note}>{timeLeft(expiresAt, now)}</Text> : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Pressable style={styles.secondary} onPress={stop} accessibilityRole="button">
                    <Text style={styles.secondaryText}>{t('Not now')}</Text>
                </Pressable>
            </View>
        );
    } else if (phase === 'holding') {
        body = (
            <View testID="rekey-holding">
                <Text style={styles.title} accessibilityRole="header">{t('Your account is on its way back')}</Text>
                <Text style={styles.lead}>{t("BeanPool's key vault holds it for a day, so your other phones can stop it if this isn't you. If another phone of yours says it's you, it comes sooner.")}</Text>
                <View style={styles.busyRow}>
                    <ActivityIndicator color={colors.brand.primary} />
                    <Text style={[styles.note, { marginTop: 0, flex: 1 }]} accessibilityLiveRegion="polite">
                        {holdUntil !== null ? t('It comes through {when}.', { when: holdEndsWords(holdUntil, now) }) : t("Asking BeanPool's key vault...")}
                    </Text>
                </View>
                {holdNote ? <Text style={styles.note} accessibilityLiveRegion="polite">{holdNote}</Text> : null}
                <Text style={styles.note}>{t('You can close the app: it picks up where it left off.')}</Text>
            </View>
        );
    } else if (phase === 'words' && newWords) {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">{t('You’re in')}</Text>
                <Text style={styles.lead}>{t('These are the 12 words of your NEW key. Your old words no longer work. Write them down and keep them safe: they bring your account back if you lose this phone.')}</Text>
                <View style={styles.words}>
                    {newWords.map((w, i) => (
                        <View key={i} style={styles.word}><Text style={styles.wordText}>{i + 1}. {w}</Text></View>
                    ))}
                </View>
                <Pressable style={styles.tickRow} onPress={() => setWroteThemDown(v => !v)} accessibilityRole="checkbox" accessibilityState={{ checked: wroteThemDown }}>
                    <MaterialCommunityIcons name={wroteThemDown ? 'checkbox-marked' : 'checkbox-blank-outline'} size={28} color={colors.brand.primary} />
                    <Text style={styles.tickText}>{t('I’ve written my 12 words down')}</Text>
                </Pressable>
                <Pressable style={styles.primary} onPress={() => setPhase('linkAgain')} accessibilityRole="button">
                    <Text style={styles.primaryText}>{t('Continue')}</Text>
                </Pressable>
            </View>
        );
    } else if (phase === 'broughtBack') {
        body = (
            <View testID="rekey-brought-back">
                <Text style={styles.title} accessibilityRole="header">{t('Welcome back')}</Text>
                <Text style={styles.lead}>{t('This phone holds your account again: the same key, your Beans, your name, your chats and every community.')}</Text>
                <Text style={styles.note}>
                    {wordsCameBack
                        ? t('Your 12 words came back with it. Settings shows them: check you have them written down.')
                        : t('Your 12 words weren’t in the copy. Settings shows you how to keep them safe.')}
                </Text>
                <Pressable style={styles.primary} onPress={() => router.replace('/(tabs)')} accessibilityRole="button">
                    <Text style={styles.primaryText}>{t('Done')}</Text>
                </Pressable>
            </View>
        );
    } else if (phase === 'linkAgain' && !linkSignInAgain) {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">{t('You’re in')}</Text>
                <Text style={styles.lead}>{t('This phone now holds your account: your Beans, your name and your history.')}</Text>
                <Pressable style={styles.primary} onPress={() => router.replace('/(tabs)')} accessibilityRole="button">
                    <Text style={styles.primaryText}>{t('Done')}</Text>
                </Pressable>
            </View>
        );
    } else if (phase === 'linkAgain') {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">{t('Link your sign-in again')}</Text>
                <Text style={styles.lead}>{t('A sign-in you had linked protected your old key, so it was removed. Link it again from this phone, so you can get back in if you lose it.')}</Text>
                <Pressable style={styles.primary} onPress={() => router.replace({ pathname: '/(tabs)/settings', params: { section: 'protection' } })} accessibilityRole="button">
                    <Text style={styles.primaryText}>{t('Link my sign-in')}</Text>
                </Pressable>
                <Pressable style={styles.secondary} onPress={() => router.replace('/(tabs)')} accessibilityRole="button">
                    <Text style={styles.secondaryText}>{t('Later')}</Text>
                </Pressable>
            </View>
        );
    } else {
        body = (
            <View>
                <Text style={styles.title} accessibilityRole="header">{bringingBack ? t('🤝 My community can bring me back') : t('🪪 An admin gave me a re-key code')}</Text>
                <Text style={styles.lead}>
                    {bringingBack
                        ? t('Lost your phone and your 12 words? Go and see an admin of your community with this phone. They check it’s you and make a code. Your account comes back: the same key, your Beans, your chats and every community.')
                        : t('Lost your phone and your 12 words? An admin of your community checked it’s you and made a code. This phone takes over your account: your Beans, your name and your history.')}
                </Text>
                <Pressable style={styles.secondary} onPress={openScanner} accessibilityRole="button">
                    <MaterialCommunityIcons name="qrcode-scan" size={22} color={colors.text.body} />
                    <Text style={styles.secondaryText}>{t('Scan the code on the admin’s screen')}</Text>
                </Pressable>
                <Text style={styles.label}>{t('Your community')}</Text>
                <TextInput
                    style={styles.input}
                    value={community}
                    onChangeText={setCommunity}
                    placeholder={t('Its name or address')}
                    placeholderTextColor={colors.text.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    accessibilityLabel={t("Your community's name or address")}
                />
                <Text style={styles.label}>{t('The code')}</Text>
                <TextInput
                    style={[styles.input, styles.codeInput]}
                    value={code}
                    onChangeText={setCode}
                    placeholder={bringingBack ? 'BB-XXXX-XXXX' : 'RK-XXXX-XXXX'}
                    placeholderTextColor={colors.text.muted}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    accessibilityLabel={t('The re-key code')}
                />
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Pressable
                    style={styles.primary}
                    onPress={ask}
                    disabled={phase === 'asking'}
                    accessibilityRole="button"
                    accessibilityLabel={phase === 'asking' ? t('Submitting re-key code...') : phase === 'ended' ? t('Try again') : t('Continue')}
                    accessibilityHint={t('Submits code to community node to re-enroll this device')}
                    accessibilityState={{ disabled: phase === 'asking', busy: phase === 'asking' }}
                >
                    {phase === 'asking' ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryText}>{phase === 'ended' ? t('Try again') : t('Continue')}</Text>}
                </Pressable>
                {heldHost ? (
                    <Pressable style={styles.secondary} onPress={forgetHeld} accessibilityRole="button">
                        <Text style={styles.secondaryText}>{t('Forget the re-key at {host}', { host: heldHost })}</Text>
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
                    <Text style={styles.scanHint}>{t('Point the camera at the QR code on your admin’s screen.')}</Text>
                    <Pressable style={styles.scanClose} onPress={() => setScanning(false)} accessibilityRole="button" accessibilityLabel={t('Close the camera')}>
                        <MaterialCommunityIcons name="close" size={24} color="#fff" />
                    </Pressable>
                </View>
            </Modal>
        </SafeAreaView>
    );
}
