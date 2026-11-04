/**
 * Home's "byron.beanpool.org isn't answering. Your community also answers at mullum.beanpool.org. Use that for now?"
 * (utils/address-fallback.ts; scratch/fable-design/DESIGN-dns-robustness-fable.md §3.2, slice S3): shown only when the
 * phone's address has not answered for about five minutes of tries (or not at all at the app's open), the follow card has
 * no move to show, and another address the community published has proved, by the community's own signed statement, to
 * be the same community. Never a move on its own: "Use that address
 * for now" moves the phone (the follow card's move, then Welcome for the community as the BeanPool sheet's switch does),
 * "Not now" hides it for 24 hours for that pair. Asked each time Home comes into view, once a minute while it stays
 * there (the tries are counted in utils/address-fallback.ts, which asks the network far less often), after any switch,
 * and when the app comes back to the front from the background: that look is at app open again, so a connection error
 * then brings the card at once (addressFallbackAppOpened; design §3.2).
 *
 * One column at 320 dp and 1.3× text: the sentence wraps (the addresses are never cut), the two 48 dp buttons stack.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, AppState } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { t } from '@beanpool/core';
import { settingsLineWords } from './settings/settings-lines';
import { type AppColors } from '../constants/colors';
import {
    acceptAddressFallback, addressFallbackAppOpened, addressFallbackOffer, snoozeAddressFallback, type AddressFallbackOffer,
} from '../utils/address-fallback';
import type { FollowResult } from '../utils/address-follow';
import { onCommunitySwitched } from '../utils/community-switch';

/** How often Home asks again while it stays in view. */
export const FALLBACK_RECHECK_MS = 60 * 1000;

export function AddressFallbackCard({ colors }: { colors: AppColors }) {
    const [offer, setOffer] = useState<AddressFallbackOffer | null>(null);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    /** The ask while Home is in view, else null. */
    const checkRef = useRef<(() => void) | null>(null);
    /**
     * Bumped by each look, by "Not now" and by the move: a look's answer shows only if nothing bumped it since the look
     * began, so one still on its way never puts back what the member just declined, or what a later look found (review of
     * 533de50e; the follow card's `latest`).
     */
    const latestRef = useRef(0);

    useFocusEffect(
        useCallback(() => {
            let live = true;
            const check = () => {
                if (busyRef.current) return;
                const mine = ++latestRef.current;
                addressFallbackOffer().then(o => { if (live && mine === latestRef.current && !busyRef.current) setOffer(o); }).catch(() => {});
            };
            checkRef.current = check;
            check();
            const timer = setInterval(check, FALLBACK_RECHECK_MS);
            const off = onCommunitySwitched(() => { if (live) setOffer(null); check(); });
            return () => { live = false; checkRef.current = null; clearInterval(timer); off(); };
        }, []),
    );

    // Back in front from the background is the app opened again (only from the background: a prompt over the app is not).
    // Marked while Home is anywhere in the tabs, so the first look at Home after it is at app open; asked at once if in view.
    useEffect(() => {
        let away = AppState.currentState === 'background';
        const sub = AppState.addEventListener('change', next => {
            if (next === 'background') { away = true; return; }
            if (next !== 'active' || !away) return;
            away = false;
            addressFallbackAppOpened();
            checkRef.current?.();
        });
        return () => sub.remove();
    }, []);

    if (!offer) return null;

    const moveThere = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        latestRef.current++;
        setBusy(true);
        let result: FollowResult;
        try {
            result = await acceptAddressFallback(offer);
        } catch (e) {
            // Only the switch itself throws (its database or address): said as the BeanPool sheet's switch says it.
            busyRef.current = false;
            setBusy(false);
            Alert.alert(t("Couldn't switch community"), (e instanceof Error && e.message) ? settingsLineWords(e.message) : t('Please try again.'));
            return;
        }
        if (result === 'moved' || result === 'moved-kept-both') {
            // As the BeanPool sheet's switch: back to the bottom of the stack, then through Welcome for the community.
            if (router.canDismiss()) router.dismissAll();
            router.replace('/welcome');
            return;
        }
        busyRef.current = false;
        setBusy(false);
        if (result === 'gone') { setOffer(null); return; }
        if (result === 'not-same') {
            setOffer(null);
            Alert.alert(t('This phone stays where it is'), t('{host} now answers as a different community, so this phone keeps the address it has.', { host: offer.host }));
            return;
        }
        Alert.alert(t("Couldn't check {host}", { host: offer.host }), t('Nothing has changed. Try again in a little while.'));
    };

    const notNow = () => {
        latestRef.current++;
        setOffer(null);
        snoozeAddressFallback(offer).catch(() => {});
    };

    return (
        <View style={[styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]} testID="address-fallback-card">
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">
                {t("{from} isn't answering. Your community also answers at {host}. Use that for now?", { from: offer.fromHost, host: offer.host })}
            </Text>
            <Text style={[styles.body, { color: colors.text.body }]}>
                {t('BeanPool checked with its server that it is the same community.')}
            </Text>
            <Pressable
                onPress={() => { moveThere().catch(() => {}); }}
                disabled={busy}
                style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }, busy && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityState={{ busy, disabled: busy }}
                testID="address-fallback-use"
            >
                <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{busy ? t('Moving…') : t('Use that address for now')}</Text>
            </Pressable>
            <Pressable onPress={notNow} disabled={busy} style={styles.secondaryBtn} accessibilityRole="button" testID="address-fallback-later">
                <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>{t('Not now')}</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10, marginBottom: 12 },
    title: { fontSize: 17, lineHeight: 23, fontWeight: '800' },
    body: { fontSize: 15, lineHeight: 21 },
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 },
    primaryText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    secondaryText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
