/**
 * Settings → the consent a known community asks for (community modes slice 6; utils/known-consent.ts). Offered only in a
 * known community, until the member agrees to the text it says now; never blocks anything. "Not now" hides the offer
 * until the app opens Settings again. Once agreed it stays: what they agreed to, when, and "Withdraw", as easy as
 * agreeing (GDPR Art. 7(3)).
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { colors } from '../constants/colors';
import { signedGet, signedRequestWithMethod } from '../utils/db';
import { readKnownConsent, saveKnownConsent, shouldOfferConsent, showsConsentCard, canWithdrawConsent, consentHeading, type KnownConsent } from '../utils/known-consent';

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

    if (!consent || !showsConsentCard(consent)) return null;
    const offer = shouldOfferConsent(consent);
    const agreed = canWithdrawConsent(consent);
    if (hidden && !agreed) return null;

    const send = async (body: Record<string, unknown>, done: string) => {
        setBusy(true);
        setNote(null);
        try {
            const saved = await saveKnownConsent(() => signedRequestWithMethod('POST', '/api/names/consent', body));
            if ('consent' in saved) { setConsent(saved.consent); setNote(done); }
            else setNote(saved.error);
        } finally {
            setBusy(false);
        }
    };
    const agree = () => send({ version: consent.version }, 'Saved. You can take it back here at any time.');
    const withdraw = () => send({ withdraw: true }, 'Withdrawn. From now on the admins don\'t see your balance.');
    const agreedOn = consent.consentedAt ? new Date(consent.consentedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;

    return (
        <View style={styles.card} accessibilityRole="summary" testID="known-consent-card">
            <Text style={styles.heading} accessibilityRole="header">{offer ? consentHeading(consent) : 'What you agreed the admins can see'}</Text>
            <Text style={styles.body}>{consent.text}</Text>
            {agreed && <Text style={styles.body}>You agreed{agreedOn ? ` on ${agreedOn}` : ''}{offer ? ' to the earlier text' : ''}. You can take it back at any time: from that moment the admins don&apos;t see your balance.</Text>}
            {!agreed && <Text style={styles.body}>Agreeing is up to you. If you don&apos;t, nothing else changes: the admins just never see your balance. You can take it back at any time, here in Settings.</Text>}
            {note && <Text style={styles.body} accessibilityLiveRegion="polite">{note}</Text>}
            <View style={styles.row}>
                {offer && (
                    <Pressable style={[styles.button, styles.primary]} onPress={() => { void agree(); }} disabled={busy} accessibilityRole="button" accessibilityState={{ busy }}>
                        <Text style={styles.primaryText}>{busy ? 'Saving…' : 'I agree'}</Text>
                    </Pressable>
                )}
                {agreed && (
                    <Pressable style={styles.button} onPress={() => { void withdraw(); }} disabled={busy} accessibilityRole="button" accessibilityState={{ busy }} testID="known-consent-withdraw">
                        <Text style={styles.secondaryText}>{busy ? 'Saving…' : 'Withdraw'}</Text>
                    </Pressable>
                )}
                {offer && !agreed && (
                    <Pressable style={styles.button} onPress={() => setHidden(true)} accessibilityRole="button">
                        <Text style={styles.secondaryText}>Not now</Text>
                    </Pressable>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16, backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border },
    heading: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8 },
    body: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 8 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    button: { minHeight: 48, paddingHorizontal: 16, borderRadius: 12, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: colors.feedback.info.border },
    primary: { backgroundColor: colors.feedback.info.border },
    primaryText: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
    secondaryText: { fontSize: 14, color: colors.text.body },
});
