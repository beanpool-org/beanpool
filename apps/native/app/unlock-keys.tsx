/**
 * "Take over or restore with this phone" (sealed-keys.md §5.2, §6.2; slice 6). An owner scans the QR on a standby's
 * Settings (or a server restoring a sealed backup), or opens the same thing as a `beanpool://unlock-keys?…` link, sees
 * which community, which server and what will happen, passes the phone's unlock, and the phone hands that server the
 * key to the community's locked keys — re-locked so only that server can read it. The phone never sees what is inside.
 * utils/takeover-unlock.ts has the steps and the reasons.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Modal, Linking, Alert, ScrollView } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useIdentity } from './IdentityContext';
import { useTheme } from './ThemeContext';
import { palette } from '../constants/colors';
import { NO_DEVICE_LOCK_MESSAGE } from '../utils/node-admin';
import {
    readUnlockScan, unlockTextFromParams, scanProblemMessage, lookupUnlock, approveUnlock, readLockPin,
    type UnlockLookup, type UnlockOutcome,
} from '../utils/takeover-unlock';
import { formatDate, t, type OwnerUnlockQr } from '@beanpool/core';
import { keyLineWords, openedFromLinkWords } from '../components/key-lines';

type Found = { qr: OwnerUnlockQr; look: Extract<UnlockLookup, { kind: 'ok' }> };

/** A day and a time in the member's language; null when the server sent none; a date it can't read, as it came. */
function day(iso: string | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : t('{date}, {time}', { date: formatDate(d, 'day-month-year'), time: formatDate(d, 'time') });
}

export default function UnlockKeysScreen() {
    const params = useLocalSearchParams<{
        community?: string | string[];
        u?: string | string[];
        s?: string | string[];
        k?: string | string[];
        e?: string | string[];
        h?: string | string[];
        p?: string | string[];
    }>();
    const communityName = (typeof params.community === 'string' && params.community.trim()) || 'your community';
    /** The community's name as the link gave it, for the sheet's words (approveUnlock keeps `communityName`). */
    const namedCommunity = (typeof params.community === 'string' && params.community.trim()) || null;
    const { identity, isLoading } = useIdentity();
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [permission, requestPermission] = useCameraPermissions();

    const [checking, setChecking] = useState(false);
    const [found, setFound] = useState<Found | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<'takeover' | 'restore' | null>(null);
    const locked = useRef(false); // one scan at a time: the camera reports the same code many times a second
    const fromLink = unlockTextFromParams(params);

    const resumeScanning = () => {
        setFound(null);
        setChecking(false);
        setTimeout(() => { locked.current = false; }, 600);
    };

    const problem = (title: string, message: string) => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert(title, message, [{ text: t('OK'), onPress: fromLink ? () => router.back() : resumeScanning }], { cancelable: false });
    };

    const read = async (text: string) => {
        if (locked.current || found || done) return;
        locked.current = true;
        setChecking(true);
        const scan = readUnlockScan(text);
        if (scan.kind !== 'ok') {
            const m = scanProblemMessage(scan);
            problem(keyLineWords(m.title), keyLineWords(m.message));
            return;
        }
        if (!identity?.privateKey) {
            problem(t('No account on this phone'), t('Sign in to your community on this phone first: the lock opens with your account.'));
            return;
        }
        const pin = await readLockPin(AsyncStorage, identity.publicKey);
        const look = await lookupUnlock(scan.qr, identity, pin);
        if (look.kind !== 'ok') {
            problem(look.kind === 'gone' ? t('That code has run out') : look.kind === 'refused' ? t("This phone won't open it") : t("Couldn't check the code"), keyLineWords(look.message));
            return;
        }
        Haptics.selectionAsync().catch(() => {});
        setChecking(false);
        setFound({ qr: scan.qr, look });
    };

    // Opened as a link: read it straight away, no camera — once the account has loaded (a cold start opens the link first).
    useEffect(() => {
        if (fromLink && !isLoading) void read(fromLink);
    }, [fromLink, isLoading]);

    const onScanned = ({ data }: BarcodeScanningResult) => { void read(data); };

    const handle = (out: UnlockOutcome) => {
        switch (out.kind) {
            case 'unlocked':
                setDone(out.purpose);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                return;
            case 'no-device-lock':
                Alert.alert(t('Set a screen lock first'), keyLineWords(NO_DEVICE_LOCK_MESSAGE));
                return;
            case 'unlock-failed':
                return; // They cancelled, or the phone said no. The sheet stays for another try.
            case 'refused':
            case 'error':
                Alert.alert(t("Couldn't unlock"), keyLineWords(out.message), [{ text: t('OK'), onPress: fromLink ? () => router.back() : resumeScanning }]);
                return;
        }
    };

    const approve = async () => {
        if (!found || !identity || busy) return;
        setBusy(true);
        try {
            handle(await approveUnlock({ qr: found.qr, check: found.look.check, identity, communityName }));
        } finally {
            setBusy(false);
        }
    };

    const close = (
        <Pressable
            onPress={() => router.back()}
            style={[styles.closeBtn, { top: insets.top + 8 }]}
            accessibilityRole="button"
            accessibilityLabel={t('Close')}
            hitSlop={8}
        >
            <Text style={styles.closeText}>✕</Text>
        </Pressable>
    );

    const sheet = (
        <Modal visible={!!found} transparent animationType="slide" onRequestClose={busy ? () => {} : () => (fromLink ? router.back() : resumeScanning())}>
            <View style={styles.sheetBackdrop}>
                <ScrollView
                    style={[styles.sheet, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]}
                    contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 20 }}
                >
                    {done && found ? (
                        <View style={{ alignItems: 'center' }} accessibilityLiveRegion="polite">
                            <Text style={{ fontSize: 40, marginBottom: 8 }} accessibilityElementsHidden>✅</Text>
                            <Text style={[styles.title, { color: colors.text.heading }]}>{t('Unlocked')}</Text>
                            <Text style={[styles.body, { color: colors.text.secondary }]}>
                                {done === 'takeover'
                                    ? t("Now finish on {host}'s screen: it shows what will happen, then “Take over now”.", { host: found.look.host })
                                    : t('{host} is restoring the backup and will restart by itself.', { host: found.look.host })}
                            </Text>
                            <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }]} onPress={() => router.back()} accessibilityRole="button">
                                <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{t('Done')}</Text>
                            </Pressable>
                        </View>
                    ) : found ? (
                        <UnlockDetails found={found} communityName={namedCommunity} callsign={identity?.callsign} busy={busy} fromLink={!!fromLink}
                            onApprove={approve} onCancel={() => (fromLink ? router.back() : resumeScanning())} />
                    ) : null}
                </ScrollView>
            </View>
        </Modal>
    );

    if (fromLink) {
        return (
            <View style={[styles.center, { backgroundColor: colors.surface.app, paddingTop: insets.top + 56 }]}>
                {close}
                {checking && <ActivityIndicator size="large" color={colors.brand.primary} />}
                {sheet}
            </View>
        );
    }

    if (!permission) {
        return <View style={[styles.center, { backgroundColor: '#000' }]}><ActivityIndicator size="large" color={colors.brand.primary} /></View>;
    }

    if (!permission.granted) {
        return (
            <View style={[styles.center, { backgroundColor: colors.surface.app, paddingTop: insets.top + 56 }]}>
                {close}
                <Text style={[styles.title, { color: colors.text.heading }]}>{t('📷 Camera needed')}</Text>
                <Text style={[styles.body, { color: colors.text.secondary }]}>
                    {t("To take over or restore with this phone, BeanPool scans the code on the server's Settings page.")}
                </Text>
                <Pressable
                    style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }]}
                    onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
                    accessibilityRole="button"
                >
                    <Text style={[styles.primaryText, { color: colors.text.inverse }]}>
                        {permission.canAskAgain ? t('Allow the camera') : t('Open phone settings')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: '#000' }}>
            <CameraView
                style={StyleSheet.absoluteFillObject}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={found || done || checking ? undefined : onScanned}
            />
            <View style={styles.overlay} pointerEvents="none">
                <View style={styles.reticle} />
            </View>
            {close}
            <View style={[styles.instructions, { bottom: insets.bottom + 24 }]}>
                {checking
                    ? <ActivityIndicator color="#fff" />
                    : (
                        <Text style={styles.instructionText}>
                            {t("On the standby's Settings choose “Take over with an owner's phone”, or restore a backup with a phone. Then point the camera at the code.")}
                        </Text>
                    )}
            </View>
            {sheet}
        </View>
    );
}

function UnlockDetails({ found, communityName, callsign, busy, fromLink, onApprove, onCancel }: {
    found: Found; communityName: string | null; callsign?: string; busy: boolean; fromLink: boolean; onApprove: () => void; onCancel: () => void;
}) {
    const { colors } = useTheme();
    const { look } = found;
    const takeover = look.described.purpose === 'takeover';
    // The community as the sheet names it: its name from the link, else "your community", else another one by its id.
    const named = communityName;
    const otherId = look.check.header.communityId.slice(0, 8);
    const host = look.host;
    const title = look.sameCommunity
        ? (named
            ? (takeover ? t('Take over {name} on {host}?', { name: named, host }) : t('Restore {name} on {host}?', { name: named, host }))
            : (takeover ? t('Take over your community on {host}?', { host }) : t('Restore your community on {host}?', { host })))
        : (takeover ? t('Take over community {id} on {host}?', { id: otherId, host }) : t('Restore community {id} on {host}?', { id: otherId, host }));
    const communityLine = look.sameCommunity
        ? (named ? t('Community: {name}', { name: named }) : t('Community: your community'))
        : t('Community: community {id}', { id: otherId });
    const backupLocked = day(look.described.restore?.backup?.createdAt ?? look.check.header.createdAt);
    const keysLocked = day(look.check.header.createdAt);
    const mainAnswers = look.described.takeover?.mainServerAnswers === true;
    const otherSigner = look.check.signer === 'other' || look.described.restore?.databaseOnly === true;
    return (
        <>
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">
                {title}
            </Text>
            <Text style={[styles.body, { color: colors.text.secondary }]}>
                {takeover
                    ? t("Do this only if your main server is really down. That server then becomes your community's main server, with the same identity, owners and web address.")
                    : backupLocked
                        ? t("That server restores the backup locked {date} and becomes your community's server.", { date: backupLocked })
                        : t("That server restores the backup locked an unknown date and becomes your community's server.")}
            </Text>
            {fromLink && (
                <View style={[styles.warnBox, { borderColor: colors.feedback.danger.solid }]} accessibilityRole="alert">
                    <Text style={[styles.infoLine, { color: colors.feedback.danger.fg, fontWeight: '700' }]}>
                        {openedFromLinkWords(takeover ? 'takeover' : 'restore', look.host)}
                    </Text>
                </View>
            )}
            {takeover && mainAnswers && (
                <View style={[styles.warnBox, { borderColor: colors.feedback.danger.solid }]} accessibilityRole="alert">
                    <Text style={[styles.infoLine, { color: colors.feedback.danger.fg, fontWeight: '700' }]}>
                        {t('Your main server still answers. Two servers with one identity will compete. Take over only if it is really gone, and never start it again.')}
                    </Text>
                </View>
            )}
            {otherSigner && (
                <View style={[styles.warnBox, { borderColor: colors.feedback.danger.solid }]} accessibilityRole="alert">
                    <Text style={[styles.infoLine, { color: colors.text.body }]}>
                        {t("This backup was locked by another machine, not your community's server. Only its database comes back, never keys or passwords from inside it.")}
                    </Text>
                </View>
            )}
            <View style={[styles.infoBox, { borderColor: colors.border.default }]}>
                <Text style={[styles.infoLine, { color: colors.text.body }]}>{communityLine}</Text>
                <Text style={[styles.infoLine, { color: colors.text.body }]}>{t('Server: {host}', { host })}</Text>
                <Text style={[styles.infoLine, { color: colors.text.body }]}>{keysLocked ? t('Keys locked: {date}', { date: keysLocked }) : t('Keys locked: an unknown date')}</Text>
                <Text style={[styles.infoLine, { color: colors.text.body }]}>{callsign ? t('As: {name}', { name: callsign }) : t('As: you')}</Text>
            </View>
            <Text style={[styles.small, { color: colors.text.secondary }]}>
                {t('Your phone opens its own key to the locked keys and hands it to that server, locked so only that server can read it. Your phone never sees what is inside.')}
            </Text>
            <Pressable
                style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }, busy && { opacity: 0.7 }]}
                onPress={onApprove}
                disabled={busy}
                accessibilityRole="button"
                accessibilityHint={t("Asks for your phone's unlock, then opens the keys for that server")}
                accessibilityState={{ busy, disabled: busy }}
            >
                {busy
                    ? <ActivityIndicator color={colors.text.inverse} />
                    : <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{takeover ? t('Unlock for the take-over') : t('Unlock the backup')}</Text>}
            </Pressable>
            <Pressable style={styles.secondaryBtn} onPress={onCancel} disabled={busy} accessibilityRole="button">
                <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>{t('Not now')}</Text>
            </Pressable>
        </>
    );
}

const styles = StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    closeBtn: {
        position: 'absolute', left: 16, width: 48, height: 48, borderRadius: 24,
        backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', zIndex: 10,
    },
    closeText: { color: '#fff', fontSize: 20, fontWeight: '700' },
    overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
    reticle: { width: '70%', maxWidth: 260, aspectRatio: 1, borderRadius: 24, borderWidth: 3, borderColor: palette.emerald400 },
    instructions: {
        position: 'absolute', left: 16, right: 16, backgroundColor: 'rgba(24,24,27,0.88)',
        borderRadius: 16, padding: 16, minHeight: 48, justifyContent: 'center',
    },
    instructionText: { color: '#fff', fontSize: 15, lineHeight: 21, textAlign: 'center' },
    sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
    sheet: { maxHeight: '90%', borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, flexGrow: 0 },
    title: { fontSize: 19, fontWeight: '800', marginBottom: 8, textAlign: 'center' },
    body: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginBottom: 12 },
    small: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginBottom: 8 },
    infoBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginVertical: 12, gap: 4 },
    warnBox: { borderWidth: 2, borderRadius: 12, padding: 12, marginVertical: 6 },
    infoLine: { fontSize: 14, lineHeight: 20 },
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, marginTop: 8, alignSelf: 'stretch' },
    primaryText: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, marginTop: 4 },
    secondaryText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
