/**
 * What Scan from a browser draws (front doors S9; app/pair-in.tsx holds the steps and talks to the relay). Its own
 * component so the phone's render test and the 320 dp shots draw every step without the router or the account around it.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { t, word } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import type { PairInAccount, PairInQr } from '../utils/pair-in';

/** The screen's words: word() keys, t()'d where shown. */
export const PAIR_IN_WORDS = {
    title: word('Scan from a browser'),
    intro: word('On the computer or phone where you use BeanPool in the browser, open Settings, then "Put your account on your phone". Scan the code it shows.'),
    scan: word('Scan the code'),
    scanHint: word('Point the camera at the code in your browser.'),
    cameraOff: word('Turn on the camera for BeanPool in your phone settings, or restore with your 12 words.'),
    unreadable: word("This code can't be read. Make a new one in your browser and scan again."),
    linkAsk: word('Bring your account from the browser on {host}?'),
    continue: word('Continue'),
    typeDigits: word('Type these four digits in your browser:'),
    digitsWhy: word('This proves the account is coming to the phone in your hand. Nothing is sent until you do.'),
    waiting: word('Waiting for your browser…'),
    sending: word('Your browser is sending your account…'),
    confirm: word("This is {name}'s account on {host}. Bring it to this phone?"),
    confirmNoName: word('This is your account on {host}. Bring it to this phone?'),
    bring: word('Bring it to this phone'),
    cancel: word('Cancel'),
    taken: word('Another phone has already scanned this code, so nothing was sent. Make a new code in your browser.'),
    expired: word('This code has run out. Make a new one in your browser and scan again.'),
    burned: word('The digits were typed wrong three times, so nothing was sent. Make a new code in your browser.'),
    badAccount: word("Your browser's answer couldn't be read, so nothing was saved. Try again, or restore with your 12 words."),
    offline: word("Couldn't reach your community. Check your connection and try again."),
    hasAccount: word('This phone already has a BeanPool account, so nothing was changed.'),
    tryAgain: word('Scan again'),
} as const;

export type PairInStep =
    | { kind: 'start' }
    | { kind: 'ask'; qr: PairInQr }
    | { kind: 'working'; qr: PairInQr }
    | { kind: 'digits'; qr: PairInQr; code: string; sending: boolean }
    | { kind: 'confirm'; qr: PairInQr; account: PairInAccount }
    | { kind: 'restoring' }
    | { kind: 'refused'; text: string };

/** The community a code names, as the member reads it: its host. */
export const pairInHost = (qr: PairInQr) => qr.nodeUrl.replace(/^https:\/\//, '');

export function PairInView({ step, canRetry, onScan, onContinue, onBring, onAgain, onCancel }: {
    step: PairInStep;
    /** Scan again after a refusal: not on a phone that already has an account. */
    canRetry: boolean;
    onScan: () => void;
    onContinue: () => void;
    onBring: () => void;
    onAgain: () => void;
    onCancel: () => void;
}) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 16 },
        title: { fontSize: 22, fontWeight: '800', color: colors.text.heading, marginBottom: 8 },
        body: { fontSize: 15, color: colors.text.body, lineHeight: 21, marginTop: 8 },
        digits: { fontSize: 40, fontWeight: '800', letterSpacing: 8, color: colors.text.heading, textAlign: 'center', marginVertical: 16, fontVariant: ['tabular-nums'] },
        muted: { fontSize: 14, color: colors.text.secondary, lineHeight: 20, marginTop: 8 },
        refusal: { fontSize: 15, color: colors.feedback.warning.fg, lineHeight: 21, marginTop: 8 },
        actions: { gap: 10, marginTop: 16 },
        primary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        primaryText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: colors.text.body, fontSize: 16, fontWeight: '700', textAlign: 'center' },
    }));
    const host = pairInHost;
    return (
        <View style={styles.card}>
            <Text style={styles.title} accessibilityRole="header">{t(PAIR_IN_WORDS.title)}</Text>

            {step.kind === 'start' && (
                <>
                    <Text style={styles.body}>{t(PAIR_IN_WORDS.intro)}</Text>
                    <View style={styles.actions}>
                        <Pressable style={styles.primary} onPress={onScan} accessibilityRole="button">
                            <Text style={styles.primaryText}>{t(PAIR_IN_WORDS.scan)}</Text>
                        </Pressable>
                    </View>
                </>
            )}

            {step.kind === 'ask' && (
                <>
                    <Text style={styles.body}>{t(PAIR_IN_WORDS.linkAsk, { host: host(step.qr) })}</Text>
                    <View style={styles.actions}>
                        <Pressable style={styles.primary} onPress={onContinue} accessibilityRole="button">
                            <Text style={styles.primaryText}>{t(PAIR_IN_WORDS.continue)}</Text>
                        </Pressable>
                    </View>
                </>
            )}

            {(step.kind === 'working' || step.kind === 'restoring') && <ActivityIndicator style={{ marginTop: 16 }} />}

            {step.kind === 'digits' && (
                <>
                    <Text style={styles.body}>{t(PAIR_IN_WORDS.typeDigits)}</Text>
                    <Text style={styles.digits} accessibilityLabel={step.code.split('').join(' ')} selectable={false}>{step.code}</Text>
                    <Text style={styles.muted}>{t(PAIR_IN_WORDS.digitsWhy)}</Text>
                    <Text style={styles.muted}>{step.sending ? t(PAIR_IN_WORDS.sending) : t(PAIR_IN_WORDS.waiting)}</Text>
                </>
            )}

            {step.kind === 'confirm' && (
                <>
                    <Text style={styles.body}>
                        {step.account.callsign
                            ? t(PAIR_IN_WORDS.confirm, { name: step.account.callsign, host: host(step.qr) })
                            : t(PAIR_IN_WORDS.confirmNoName, { host: host(step.qr) })}
                    </Text>
                    <View style={styles.actions}>
                        <Pressable style={styles.primary} onPress={onBring} accessibilityRole="button">
                            <Text style={styles.primaryText}>{t(PAIR_IN_WORDS.bring)}</Text>
                        </Pressable>
                    </View>
                </>
            )}

            {step.kind === 'refused' && (
                <>
                    <Text style={styles.refusal} accessibilityRole="alert">{step.text}</Text>
                    {canRetry && (
                        <View style={styles.actions}>
                            <Pressable style={styles.primary} onPress={onAgain} accessibilityRole="button">
                                <Text style={styles.primaryText}>{t(PAIR_IN_WORDS.tryAgain)}</Text>
                            </Pressable>
                        </View>
                    )}
                </>
            )}

            {step.kind !== 'restoring' && (
                <View style={styles.actions}>
                    <Pressable style={styles.secondary} onPress={onCancel} accessibilityRole="button">
                        <Text style={styles.secondaryText}>{t(PAIR_IN_WORDS.cancel)}</Text>
                    </Pressable>
                </View>
            )}
        </View>
    );
}
