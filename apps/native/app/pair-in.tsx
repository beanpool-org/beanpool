/**
 * Already a member → Scan from this browser (front doors S9): the account a member's browser holds comes to this phone,
 * which has none, without typing the 12 words. utils/pair-in.ts says what is checked; apps/server pairing-relay.ts how
 * the relay holds it.
 *
 * The order: scan the browser's code (or open its link and tap Continue) → this phone offers a fresh key and SHOWS four
 * digits → the member types them in the browser → the browser seals the account to this phone's key → the phone opens
 * it with the QR's key, checks that its 12 words make the key it names, shows whose account it is and from which
 * community → at the member's tap, restores it from the words (restoreFromWords, which never replaces another account).
 * The phone's private half of the offer key lives in a ref for this screen only and is dropped when it closes.
 *
 * Then (doors-s9-fix1) the phone tells the relay, with its own secret, whether it SAVED the account: 'saved' once
 * restoreFromWords has finished, else 'not saved' (the seal didn't read, the save failed, or the member left). Only
 * 'saved' lets the browser offer to remove the account there. Leaving while the save runs sends nothing then: the
 * save's own end sends the real word (doors-s9-fix2), and one tap on Bring starts one save. One offer per scan (two
 * taps on Continue send one), and the four digits go when the session ends by the relay's clock, network or not.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, ErrorBoundary, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { createPairInKey, openPairingPayloadOnPhone, t } from '@beanpool/core';
import { useStyles, useTheme } from './ThemeContext';
import { useIdentity } from './IdentityContext';
import ScanCodeModal from '../components/ScanCodeModal';
import { PairInView, PAIR_IN_WORDS, type PairInStep } from '../components/PairInView';
import {
    isUnreadablePairInQr, pairInDigitsEndAt, pairInLinkFromRoute, pairInUrls, parsePairInQr, readPairInAccount, type PairInAccount, type PairInQr,
} from '../utils/pair-in';
import { restoreFromWords, RestoreStopped } from '../utils/restore-account';
import { fetchNodeCallsign } from '../utils/db';

export { ErrorBoundary };
export { PAIR_IN_WORDS };

const POLL_MS = 1_500;
const FETCH_MS = 15_000;

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_MS);
    try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
        clearTimeout(timer);
    }
}

export default function PairInScreen() {
    const params = useLocalSearchParams<{ qr?: string }>();
    const { identity, setIdentity } = useIdentity();
    const { theme } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        scroll: { padding: 16 },
    }));

    // A phone with an account never takes another here (restoreFromWords would refuse it too).
    const [step, setStep] = useState<PairInStep>(() => identity ? { kind: 'refused', text: t(PAIR_IN_WORDS.hasAccount) } : { kind: 'start' });
    const [scanning, setScanning] = useState(false);
    const phoneKey = useRef<{ privateKeyHex: string; publicKeyHex: string } | null>(null);
    const session = useRef<{ qr: PairInQr; secret: string; endsAt: number } | null>(null);
    const alive = useRef(true);
    /** An offer is out or made: no second one (two taps on Continue before the screen redraws) until Scan again. */
    const offering = useRef(false);
    /** Collected: the browser waits to hear, once, whether this phone saved the account. */
    const toTell = useRef<{ qr: PairInQr; secret: string } | null>(null);
    /** restoreFromWords is running: only its end knows whether the account was saved, so it alone tells the browser. */
    const restoring = useRef(false);

    const tellBrowser = useCallback((saved: boolean) => {
        const r = toTell.current;
        toTell.current = null;
        if (r) void postJson(pairInUrls(r.qr).saved, { sessionId: r.qr.sessionId, phoneSecret: r.secret, saved }).catch(() => {});
    }, []);

    const cancelRelay = useCallback(() => {
        // Leaving after the collect, before a save: nothing was saved here, and the browser keeps the account. Leaving
        // while the save runs (Android back, an iOS swipe) says nothing: bring() tells the browser the outcome when it ends.
        if (!restoring.current) tellBrowser(false);
        const s = session.current;
        session.current = null;
        phoneKey.current = null;
        if (s) void postJson(pairInUrls(s.qr).cancel, { sessionId: s.qr.sessionId }).catch(() => {});
    }, [tellBrowser]);

    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; cancelRelay(); };
    }, [cancelRelay]);

    // A link from the camera app: read it as a scan would, then ask before anything is sent.
    useEffect(() => {
        if (identity || !params.qr) return;
        const link = pairInLinkFromRoute(params.qr);
        const qr = parsePairInQr(link);
        offering.current = false;
        setStep(qr ? { kind: 'ask', qr } : { kind: 'refused', text: t(PAIR_IN_WORDS.unreadable) });
    }, [params.qr]);

    const offer = useCallback(async (qr: PairInQr) => {
        if (offering.current) return;
        offering.current = true;
        setStep({ kind: 'working', qr });
        const key = createPairInKey();
        phoneKey.current = key;
        let res: { status: number; body: any };
        try {
            res = await postJson(pairInUrls(qr).offer, { sessionId: qr.sessionId, phonePubHex: key.publicKeyHex });
        } catch {
            if (alive.current) setStep({ kind: 'refused', text: t(PAIR_IN_WORDS.offline) });
            return;
        }
        if (!alive.current) return;
        if (res.status !== 200 || !/^\d{4}$/.test(String(res.body?.confirmCode)) || typeof res.body?.phoneSecret !== 'string') {
            phoneKey.current = null;
            const text = res.status === 409 ? t(PAIR_IN_WORDS.taken) : res.status === 410 ? t(PAIR_IN_WORDS.expired) : t(PAIR_IN_WORDS.unreadable);
            setStep({ kind: 'refused', text });
            return;
        }
        session.current = { qr, secret: res.body.phoneSecret, endsAt: pairInDigitsEndAt(res.body, Date.now()) };
        setStep({ kind: 'digits', qr, code: res.body.confirmCode, sending: false });
    }, []);

    // While the digits show: ask the relay every 1.5 s, until the sealed account comes, or the session ends.
    const waitingFor = step.kind === 'digits' ? step.qr.sessionId : null;
    useEffect(() => {
        if (!waitingFor) return;
        let stop = false;
        // The session's end: past it nothing can come, so the digits go then, even with no network to say so.
        const until = setTimeout(() => {
            if (stop || !alive.current) return;
            stop = true;
            cancelRelay();
            setStep({ kind: 'refused', text: t(PAIR_IN_WORDS.expired) });
        }, Math.max(0, (session.current?.endsAt ?? Date.now()) - Date.now()));
        const tick = async () => {
            const s = session.current;
            const key = phoneKey.current;
            if (stop || !s || !key) return;
            let res: { status: number; body: any } | null = null;
            try {
                res = await postJson(pairInUrls(s.qr).collect, { sessionId: s.qr.sessionId, phoneSecret: s.secret });
            } catch { /* a dropped poll: the next one asks again */ }
            if (stop || !alive.current) return;
            const status = res?.body?.status;
            if (status === 'sent') {
                stop = true;
                clearTimeout(until);
                toTell.current = { qr: s.qr, secret: s.secret };
                let account: PairInAccount | null = null;
                try {
                    account = readPairInAccount(openPairingPayloadOnPhone(res!.body.ciphertextHex, res!.body.nonceHex, s.qr.browserPubHex, key.privateKeyHex, s.qr.sessionId));
                } catch { account = null; }
                phoneKey.current = null;
                if (!account) tellBrowser(false);
                setStep(account ? { kind: 'confirm', qr: s.qr, account } : { kind: 'refused', text: t(PAIR_IN_WORDS.badAccount) });
                return;
            }
            if (status === 'burned' || status === 'expired' || res?.status === 410 || res?.status === 403) {
                stop = true;
                session.current = null;
                phoneKey.current = null;
                setStep({ kind: 'refused', text: status === 'burned' ? t(PAIR_IN_WORDS.burned) : t(PAIR_IN_WORDS.expired) });
                return;
            }
            if (status === 'released') setStep((prev) => (prev.kind === 'digits' && !prev.sending ? { ...prev, sending: true } : prev));
            timer = setTimeout(tick, POLL_MS);
        };
        let timer: ReturnType<typeof setTimeout> = setTimeout(tick, POLL_MS);
        return () => { stop = true; clearTimeout(timer); clearTimeout(until); };
    }, [waitingFor]);

    const bring = useCallback(async (qr: PairInQr, account: PairInAccount) => {
        // One save at a time: a second tap before the screen redraws starts nothing.
        if (restoring.current) return;
        restoring.current = true;
        setStep({ kind: 'restoring' });
        session.current = null;
        try {
            // The same gate as the 12-word restore: the key is made from the words, never taken from the relay, and no
            // other account on this phone is replaced (no confirmReplace: it refuses instead). That the words make the key
            // the browser named was checked before the member's tap (readPairInAccount), never after this saves.
            const restored = await restoreFromWords(account.words, qr.nodeUrl, {
                nameOnNode: (publicKey, privateKey) => fetchNodeCallsign(qr.nodeUrl, publicKey, privateKey),
            });
            restoring.current = false;
            // Saved: only now may the browser offer to remove the account there.
            tellBrowser(true);
            setIdentity(restored);
            router.replace('/');
        } catch (err) {
            restoring.current = false;
            tellBrowser(false);
            if (!alive.current) return;
            setStep({ kind: 'refused', text: err instanceof RestoreStopped ? t(PAIR_IN_WORDS.hasAccount) : t(PAIR_IN_WORDS.badAccount) });
        }
    }, [setIdentity, tellBrowser]);

    const onScan = (data: string): boolean => {
        const qr = parsePairInQr(data);
        if (qr) {
            setScanning(false);
            void offer(qr);
            return true;
        }
        if (isUnreadablePairInQr(data)) {
            setScanning(false);
            setStep({ kind: 'refused', text: t(PAIR_IN_WORDS.unreadable) });
            return true;
        }
        return false;
    };

    const leave = () => {
        cancelRelay();
        if (router.canGoBack()) router.back();
        else router.replace('/welcome');
    };
    const again = () => { cancelRelay(); offering.current = false; setStep({ kind: 'start' }); };

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                <PairInView
                    step={step}
                    canRetry={!identity}
                    onScan={() => setScanning(true)}
                    onContinue={() => { if (step.kind === 'ask') void offer(step.qr); }}
                    onBring={() => { if (step.kind === 'confirm') void bring(step.qr, step.account); }}
                    onAgain={again}
                    onCancel={leave}
                />
            </ScrollView>
            {scanning && (
                <ScanCodeModal hint={t(PAIR_IN_WORDS.scanHint)} deniedText={t(PAIR_IN_WORDS.cameraOff)} onRead={onScan} onClose={() => setScanning(false)} />
            )}
        </SafeAreaView>
    );
}
