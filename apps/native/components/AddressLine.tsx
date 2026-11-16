/**
 * Home's one line after the phone followed its community to another of its addresses by itself (utils/address-verify.ts;
 * scratch/fable-design/DESIGN-several-addresses-fable.md §8, slice S4; Marty 16 Nov: one line on Home, no card, no tap).
 * Shown once: the line is taken off the community's record as Home reads it, and stays while Home is in view and the
 * community in use is the one it was taken for. A switch to any other community (or address) clears it at once, as the
 * copies card beside it does: Home shows only the community in use (PR #3236 review).
 *
 * It also keeps the verification going while Home is in view: once a minute (address-verify.ts asks the network at most
 * hourly while the address in use answers, once a minute while it doesn't), after any switch, and when the app comes back
 * to the front from the background, which counts as an app open (the 2 Nov card's timings).
 *
 * At 320 dp and 1.3× text the sentence wraps inside Home's 16 dp gutter; the addresses are never cut. A community whose name
 * the phone never kept is named by the address the member knew it by (the line's `from`).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text } from 'react-native';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t } from '@beanpool/core';
import { type AppColors } from '../constants/colors';
import { takeAddressLine, verifyAddressInUse } from '../utils/address-verify';
import type { AddressLineKind } from '../utils/address-decide';
import { onCommunitySwitched } from '../utils/community-switch';
import { communityName } from '../utils/community-name';
import { getSavedNodes } from '../utils/nodes';

/** How often Home asks again while it stays in view. */
export const ADDRESS_RECHECK_MS = 60 * 1000;

const hostOf = (origin: string) => origin.replace(/^https?:\/\//, '');

/** The sentence for a line (§8). */
export function addressLineWords(line: { kind: AddressLineKind; from: string; to: string }, community: string): string {
    if (line.kind === 'left') {
        return t('{old} no longer answers as {community}. This phone now uses {address}.', { old: hostOf(line.from), community, address: hostOf(line.to) });
    }
    if (line.kind === 'not-answering') {
        return t("{old} isn't answering. This phone uses {address} for now.", { old: hostOf(line.from), address: hostOf(line.to) });
    }
    return t('{community} now lives at {address}. This phone uses it from now on. Nothing else changed.', { community, address: hostOf(line.to) });
}

export function AddressLine({ colors }: { colors: AppColors }) {
    // The words, with the address in use they were taken for.
    const [shown, setShown] = useState<{ anchor: string; words: string } | null>(null);
    const lookRef = useRef<((atOpen?: boolean) => void) | null>(null);

    useFocusEffect(
        useCallback(() => {
            let live = true;
            // The words go when the phone is no longer where they were taken for (a switch, or a focus after one elsewhere).
            const inUse = async () => {
                const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
                if (live) setShown((s) => (s && s.anchor !== anchor ? null : s));
                return anchor;
            };
            const look = (atOpen = false) => {
                inUse()
                    .then(() => verifyAddressInUse({ atOpen }))
                    .then(inUse)
                    .then(async (anchor) => {
                        const line = await takeAddressLine(anchor);
                        if (!live || !line || !anchor) return;
                        // The community's name as this phone kept it, else the address the member knew it by: never the
                        // new address, which would read "{address} now lives at {address}".
                        const row = (await getSavedNodes().catch(() => [])).find((n) => n.url === line.to);
                        if (live) setShown({ anchor, words: addressLineWords(line, communityName({ alias: row?.alias ?? null, url: line.from })) });
                    })
                    .catch(() => {});
            };
            lookRef.current = look;
            look();
            const timer = setInterval(() => look(), ADDRESS_RECHECK_MS);
            // A switch clears the line at once; the look after it shows the new one when the switch was the phone's own follow.
            const off = onCommunitySwitched(() => { if (live) setShown(null); look(); });
            return () => { live = false; lookRef.current = null; clearInterval(timer); off(); };
        }, []),
    );

    // Back in front from the background is the app opened again (only from the background: a prompt over the app is not).
    useEffect(() => {
        let away = AppState.currentState === 'background';
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'background') { away = true; return; }
            if (next !== 'active' || !away) return;
            away = false;
            if (lookRef.current) lookRef.current(true);
            else verifyAddressInUse({ atOpen: true }).catch(() => {});
        });
        return () => sub.remove();
    }, []);

    if (!shown) return null;
    return (
        <Text style={[styles.line, { color: colors.text.body }]} accessibilityLiveRegion="polite" testID="address-line">
            {shown.words}
        </Text>
    );
}

const styles = StyleSheet.create({
    // Home's side gutter (the page title's inset, the offline note's margin).
    line: { fontSize: 15, lineHeight: 21, marginHorizontal: 16, marginBottom: 12 },
});
