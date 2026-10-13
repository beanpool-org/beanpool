/**
 * Home's Your Beans card where Beans are previewed (scratch/global-node/DESIGN-global-showcase-fable.md §1 row 1): the
 * marker's pill on the caption, one sentence, and "See an example ledger ›", which opens the Ledger (Example Valley's in
 * preview). No API: nothing here is read from or written to a node.
 *
 * Hideable on its own (§1 row 1: "hideable, default-on for new members like steps"): "Hide this card" puts it away on
 * this phone for this community, as the strip's ✕ remembers its fold, and First steps stays. The Ledger tab still shows
 * the example.
 */
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LOCAL_COMMUNITY_LINES } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HomeButton, HomeCard, HomeRow, homeStyles } from '../home/HomeParts';
import { LocalCommunityMark } from './LocalCommunityMark';

/** The card put away: per community, on this device only (a per-viewer convenience). */
export const beansCardKey = (nodeUrl: string) => `beanpool_showcase_card:${nodeUrl.trim().replace(/\/+$/, '').toLowerCase()}:beans`;

export function YourBeansPreviewCard({ colors }: { colors: AppColors }) {
    const s = homeStyles(colors);
    const [hidden, setHidden] = useState(false);
    const [key, setKey] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
            if (!url || cancelled) return;
            const k = beansCardKey(url);
            setKey(k);
            const v = await AsyncStorage.getItem(k).catch(() => null);
            if (!cancelled && v === '1') setHidden(true);
        })();
        return () => { cancelled = true; };
    }, []);
    if (hidden) return null;
    const hide = () => {
        setHidden(true);
        if (key) AsyncStorage.setItem(key, '1').catch(() => {});
    };
    return (
        <HomeCard id="beans-preview" caption="Your Beans" colors={colors} testID="home-card-beans-preview"
            right={<LocalCommunityMark variant="pill" feature="beans" />}>
            <Text style={s.note}>{LOCAL_COMMUNITY_LINES.yourBeansCard}</Text>
            <HomeRow colors={colors} text={LOCAL_COMMUNITY_LINES.yourBeansLink} a11y="See an example ledger"
                onPress={() => router.navigate('/(tabs)/ledger')} testID="home-beans-preview-ledger" />
            <HomeButton colors={colors} text="Hide this card" a11y="Hide the Your Beans card" onPress={hide} testID="home-beans-preview-hide" />
        </HomeCard>
    );
}
