/**
 * Settings → the consent a known community asks for (community modes slice 6; utils/known-consent.ts). Offered only in a
 * known community, until the member agrees to the text it says now; never blocks anything. "Not now" hides the offer
 * until the app opens Settings again. Once agreed it stays: what they agreed to, when, and "Withdraw", as easy as
 * agreeing (GDPR Art. 7(3)).
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { signedGet, signedRequestWithMethod } from '../utils/db';
import { ConsentText } from './ConsentText';
import { readKnownConsent, saveKnownConsent, shouldOfferConsent, showsConsentCard, canWithdrawConsent, consentHeading, type KnownConsent } from '../utils/known-consent';
import { formatDate, t, word, type WordKey } from '@beanpool/core';

/**
 * utils/known-consent.ts's heading and refusals, and the card's own notes after Agree and Withdraw, by their English:
 * shown in the member's language where the card draws them. A community's own refusal is shown as it sent it.
 * utils/__tests__/settings-words-render.test.ts holds known-consent.ts's sentences to this table.
 */
export const CONSENT_LINES: Readonly<Record<string, WordKey>> = {
    'Your community changed what its admins can see': word('Your community changed what its admins can see'),
    "What this community's admins can see": word("What this community's admins can see"),
    'Not saved: the community could not be reached.': word('Not saved: the community could not be reached.'),
    'Not saved. Try again later.': word('Not saved. Try again later.'),
    'Saved. You can take it back here at any time.': word('Saved. You can take it back here at any time.'),
    "Withdrawn. From now on the admins don't see your balance.": word("Withdrawn. From now on the admins don't see your balance."),
};

/** One of the lines above in the member's language; anything else exactly as given. */
export function consentLineWords(english: string): string {
    return Object.prototype.hasOwnProperty.call(CONSENT_LINES, english) ? t(CONSENT_LINES[english]) : english;
}

/** "You agreed …": with or without the day, and whether to the earlier text; whole sentences per variant. */
function agreedWords(on: string | null, earlier: boolean): string {
    if (on) {
        return earlier
            ? t("You agreed on {date} to the earlier text. You can take it back at any time: from that moment the admins don't see your balance.", { date: on })
            : t("You agreed on {date}. You can take it back at any time: from that moment the admins don't see your balance.", { date: on });
    }
    return earlier
        ? t("You agreed to the earlier text. You can take it back at any time: from that moment the admins don't see your balance.")
        : t("You agreed. You can take it back at any time: from that moment the admins don't see your balance.");
}

export function KnownConsentCard() {
    const styles = useStyles(makeStyles);
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
    const agreedOn = consent.consentedAt && Number.isFinite(Date.parse(consent.consentedAt)) ? formatDate(new Date(consent.consentedAt), 'day-month-year') : null;

    return (
        <View style={styles.card} accessibilityRole="summary" testID="known-consent-card">
            <Text style={styles.heading} accessibilityRole="header">{offer ? consentLineWords(consentHeading(consent)) : t('What you agreed the admins can see')}</Text>
            <ConsentText text={consent.text} />
            {agreed && <Text style={styles.body}>{agreedWords(agreedOn, offer)}</Text>}
            {!agreed && <Text style={styles.body}>{t("Agreeing is up to you. If you don't, nothing else changes: the admins just never see your balance. You can take it back at any time, here in Settings.")}</Text>}
            {note && <Text style={styles.body} accessibilityLiveRegion="polite">{consentLineWords(note)}</Text>}
            <View style={styles.row}>
                {offer && (
                    <Pressable style={[styles.button, styles.primary]} onPress={() => { void agree(); }} disabled={busy} accessibilityRole="button" accessibilityState={{ busy }}>
                        <Text style={styles.primaryText}>{busy ? t('Saving…') : t('I agree')}</Text>
                    </Pressable>
                )}
                {agreed && (
                    <Pressable style={styles.button} onPress={() => { void withdraw(); }} disabled={busy} accessibilityRole="button" accessibilityState={{ busy }} testID="known-consent-withdraw">
                        <Text style={styles.secondaryText}>{busy ? t('Saving…') : t('Withdraw')}</Text>
                    </Pressable>
                )}
                {offer && !agreed && (
                    <Pressable style={styles.button} onPress={() => setHidden(true)} accessibilityRole="button">
                        <Text style={styles.secondaryText}>{t('Not now')}</Text>
                    </Pressable>
                )}
            </View>
        </View>
    );
}

// Themed: this card sits in Settings, and the light info-blue box glared on the dark page.
const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16, backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border },
    heading: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8 },
    body: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 8 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    button: { minHeight: 48, paddingHorizontal: 16, borderRadius: 12, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: colors.feedback.info.border },
    primary: { backgroundColor: colors.feedback.info.border },
    primaryText: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
    secondaryText: { fontSize: 14, color: colors.text.body },
});
