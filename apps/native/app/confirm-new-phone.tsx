/**
 * "Confirm a member's new phone" (path B, scratch/global-node/DESIGN-group-history-after-rekey-fable.md §4;
 * utils/group-history-unlock.ts): scan the code on the member's new phone, in person. This phone checks it against its own
 * memory of the member's old key, says what confirming does (the one human limit included), and on "Confirm" hands the
 * new phone the keys of the earlier messages this phone holds whose record names that old key.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Linking, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router, ErrorBoundary } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeContext';
import { checkScannedNewPhone, confirmScannedNewPhone } from '../utils/db';
import { yourGroupsStore } from '../components/useYourGroups';
import { NEW_PHONE_CONFIRM_ACTION, type NewPhoneCheck } from '../utils/group-history-unlock';
import { keyLineWords, newPhoneConfirmWords, newPhoneEndWords, newPhoneProgressWords } from '../components/key-lines';
import { t } from '@beanpool/core';

export { ErrorBoundary };

type Step = { kind: 'scan' } | { kind: 'checking' } | { kind: 'refused'; text: string } | { kind: 'confirm'; check: Extract<NewPhoneCheck, { ok: true }> }
    | { kind: 'handing'; check: Extract<NewPhoneCheck, { ok: true }>; handed: number; planned: number | null } | { kind: 'done'; text: string; ok: boolean };


export default function ConfirmNewPhoneScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [permission, requestPermission] = useCameraPermissions();
    const [step, setStep] = useState<Step>({ kind: 'scan' });

    const onScanned = async (r: BarcodeScanningResult) => {
        if (step.kind !== 'scan') return;
        setStep({ kind: 'checking' });
        try {
            const groups = (yourGroupsStore.getState().items ?? []).filter((g) => g.kind === 'group').map((g) => ({ id: g.id, name: g.name }));
            const check = await checkScannedNewPhone(String(r.data ?? ''), groups);
            setStep(check.ok ? { kind: 'confirm', check } : { kind: 'refused', text: keyLineWords(check.text) });
        } catch (e: any) {
            setStep({ kind: 'refused', text: e?.message ? keyLineWords(e.message) : t('Something went wrong. Try again in a moment.') });
        }
    };

    const confirm = async (check: Extract<NewPhoneCheck, { ok: true }>) => {
        setStep({ kind: 'handing', check, handed: 0, planned: null });
        try {
            const r = await confirmScannedNewPhone(check, (n, m) => setStep({ kind: 'handing', check, handed: n, planned: m }));
            setStep({ kind: 'done', ...newPhoneEndWords(check.name, r) });
        } catch (e: any) {
            setStep({ kind: 'refused', text: e?.message ? keyLineWords(e.message) : t('Something went wrong. Try again in a moment.') });
        }
    };

    if (step.kind === 'scan' || step.kind === 'checking') {
        if (!permission) return <View style={[styles.center, { backgroundColor: '#000' }]}><ActivityIndicator /></View>;
        if (!permission.granted) {
            return (
                <View style={[styles.center, { backgroundColor: colors.surface.app, paddingTop: insets.top + 16 }]}>
                    <Text style={[styles.title, { color: colors.text.heading }]}>{keyLineWords(NEW_PHONE_CONFIRM_ACTION)}</Text>
                    <Text style={[styles.body, { color: colors.text.secondary }]}>{t("BeanPool scans the code on the member's new phone.")}</Text>
                    <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }]} accessibilityRole="button"
                        onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}>
                        <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{permission.canAskAgain ? t('Allow the camera') : t('Open phone settings')}</Text>
                    </Pressable>
                </View>
            );
        }
        return (
            <View style={{ flex: 1, backgroundColor: '#000' }}>
                <CameraView style={StyleSheet.absoluteFillObject} barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={step.kind === 'scan' ? onScanned : undefined} />
                <View style={[styles.instructions, { bottom: insets.bottom + 24 }]}>
                    {step.kind === 'checking' ? <ActivityIndicator color="#fff" />
                        : <Text style={styles.instructionText}>{t("Point the camera at the code on the member's new phone. Do this only in person.")}</Text>}
                </View>
                <Pressable style={[styles.closeBtn, { top: insets.top + 8 }]} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('Close')}>
                    <Text style={styles.closeText}>✕</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.app }} contentContainerStyle={[styles.page, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}>
            <Text style={[styles.title, { color: colors.text.heading }]}>{keyLineWords(NEW_PHONE_CONFIRM_ACTION)}</Text>
            {step.kind === 'refused' && (
                <>
                    <Text style={[styles.body, { color: colors.feedback.danger.fg }]} accessibilityRole="alert">{step.text}</Text>
                    <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }]} onPress={() => setStep({ kind: 'scan' })} accessibilityRole="button">
                        <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{t('Scan again')}</Text>
                    </Pressable>
                </>
            )}
            {step.kind === 'confirm' && (
                <>
                    <Text style={[styles.body, { color: colors.text.body }]}>{newPhoneConfirmWords(step.check.name, step.check.groups.map((g) => g.name))}</Text>
                    <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }]} onPress={() => confirm(step.check)} accessibilityRole="button">
                        <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{t('Confirm')}</Text>
                    </Pressable>
                </>
            )}
            {step.kind === 'handing' && (step.planned === null ? <ActivityIndicator /> : (
                <Text style={[styles.body, { color: colors.text.secondary }]} accessibilityLiveRegion="polite">{newPhoneProgressWords(step.handed, step.planned)}</Text>
            ))}
            {step.kind === 'done' && <Text style={[styles.body, { color: step.ok ? colors.text.body : colors.feedback.danger.fg }]} accessibilityLiveRegion="polite">{step.text}</Text>}
            <Pressable style={styles.secondaryBtn} onPress={() => router.back()} accessibilityRole="button">
                <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>{step.kind === 'done' ? t('Done') : t('Cancel')}</Text>
            </Pressable>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 12 },
    page: { paddingHorizontal: 16, gap: 12 },
    title: { fontSize: 19, fontWeight: '800' },
    body: { fontSize: 15, lineHeight: 21 },
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, alignSelf: 'stretch' },
    primaryText: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    secondaryText: { fontSize: 15, fontWeight: '700' },
    instructions: { position: 'absolute', left: 16, right: 16, backgroundColor: 'rgba(24,24,27,0.88)', borderRadius: 16, padding: 16, minHeight: 48, justifyContent: 'center' },
    instructionText: { color: '#fff', fontSize: 15, lineHeight: 21, textAlign: 'center' },
    closeBtn: { position: 'absolute', left: 16, width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
    closeText: { color: '#fff', fontSize: 20, fontWeight: '700' },
});
