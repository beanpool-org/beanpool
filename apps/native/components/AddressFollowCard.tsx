/**
 * Home's "This community is also at beans.example.org. Use that address from now on?" (utils/address-follow.ts;
 * scratch/global-node/DESIGN-https-anywhere-fable.md §3, D4): shown only when the phone's community says it lives
 * somewhere else now and the phone has checked, with the community's node key, that it is the same community. Never a
 * move on its own: "Use the new address" moves the phone (the BeanPool sheet's switch, then Welcome for the community
 * as it does), "Not now" asks again in 7 days. Asked each time Home comes into view, and again after any switch.
 *
 * One column at 320 dp and 1.3× text: the sentence wraps (the address is never cut), the two 48 dp buttons stack.
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { t } from '@beanpool/core';
import { type AppColors } from '../constants/colors';
import { acceptAddressFollow, addressFollowOffer, snoozeAddressFollow, type AddressFollowOffer, type FollowResult } from '../utils/address-follow';
import { onCommunitySwitched } from '../utils/community-switch';

export function AddressFollowCard({ colors }: { colors: AppColors }) {
    const [offer, setOffer] = useState<AddressFollowOffer | null>(null);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);

    useFocusEffect(
        useCallback(() => {
            let live = true;
            const check = () => {
                addressFollowOffer().then(o => { if (live) setOffer(o); }).catch(() => {});
            };
            check();
            const off = onCommunitySwitched(() => { if (live) setOffer(null); check(); });
            return () => { live = false; off(); };
        }, []),
    );

    if (!offer) return null;

    const moveToNew = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        let result: FollowResult;
        try {
            result = await acceptAddressFollow(offer);
        } catch (e) {
            // Only the switch itself throws (its database or address): said as the BeanPool sheet's switch says it.
            busyRef.current = false;
            setBusy(false);
            Alert.alert(t("Couldn't switch community"), (e instanceof Error && e.message) || t('Please try again.'));
            return;
        }
        if (result === 'moved') {
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
        setOffer(null);
        snoozeAddressFollow(offer).catch(() => {});
    };

    return (
        <View style={[styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]} testID="address-follow-card">
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">
                {t('This community is also at {host}. Use that address from now on?', { host: offer.host })}
            </Text>
            <Text style={[styles.body, { color: colors.text.body }]}>
                {t('BeanPool checked with its server that it is the same community.')}
            </Text>
            <Pressable
                onPress={() => { moveToNew().catch(() => {}); }}
                disabled={busy}
                style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }, busy && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityState={{ busy, disabled: busy }}
                testID="address-follow-use"
            >
                <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{busy ? t('Moving…') : t('Use the new address')}</Text>
            </Pressable>
            <Pressable onPress={notNow} disabled={busy} style={styles.secondaryBtn} accessibilityRole="button" testID="address-follow-later">
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
