/**
 * Settings → the consent a known community asks for (community modes slice 6; utils/known-consent.ts). Shown only in a
 * known community, until the member agrees to the text it says now; never blocks anything. "Not now" hides it until the
 * app opens Settings again.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { colors } from '../constants/colors';
import { signedGet, signedRequestWithMethod } from '../utils/db';
import { readKnownConsent, shouldOfferConsent, consentHeading, type KnownConsent } from '../utils/known-consent';

export function KnownConsentCard() {
    const [consent, setConsent] = useState<KnownConsent | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [hidden, setHidden] = useState(false);

    useEffect(() => {
        let mounted = true;
        (async () => {
            const res = await signedGet('/api/names/consent').catch(() => null);
            if (!res || !res.ok) return;
            const c = readKnownConsent(await res.json().catch(() => null));
            if (mounted) setConsent(c);
        })();
        return () => { mounted = false; };
    }, []);

    if (hidden || !consent || !shouldOfferConsent(consent)) return null;

    const agree = async () => {
        setBusy(true);
        setNote(null);
        try {
            const res = await signedRequestWithMethod('POST', '/api/names/consent', { version: consent.version });
            const body = await (res as Response).json().catch(() => null);
            const next = readKnownConsent(body);
            if ((res as Response).ok && next) setConsent(next);
            else setNote(typeof (body as { error?: unknown })?.error === 'string' ? (body as { error: string }).error : 'Not saved. Try again later.');
        } catch {
            setNote('Not saved: the community could not be reached.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={styles.card} accessibilityRole="summary" testID="known-consent-card">
            <Text style={styles.heading} accessibilityRole="header">{consentHeading(consent)}</Text>
            <Text style={styles.body}>{consent.text}</Text>
            <Text style={styles.body}>Agreeing is up to you. If you don&apos;t, nothing else changes: the admins just never see your balance.</Text>
            {note && <Text style={styles.body} accessibilityLiveRegion="polite">{note}</Text>}
            <View style={styles.row}>
                <Pressable style={[styles.button, styles.primary]} onPress={() => { void agree(); }} disabled={busy} accessibilityRole="button" accessibilityState={{ busy }}>
                    <Text style={styles.primaryText}>{busy ? 'Saving…' : 'I agree'}</Text>
                </Pressable>
                <Pressable style={styles.button} onPress={() => setHidden(true)} accessibilityRole="button">
                    <Text style={styles.secondaryText}>Not now</Text>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16, backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border },
    heading: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8 },
    body: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 8 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    button: { minHeight: 48, paddingHorizontal: 16, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
    primary: { backgroundColor: colors.feedback.info.border },
    primaryText: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
    secondaryText: { fontSize: 14, color: colors.text.body },
});
