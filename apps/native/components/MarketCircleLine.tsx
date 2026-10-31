import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { AppColors } from '../constants/colors';
import type { BeanPoolIdentity } from '../utils/identity';
import { fetchGlobalHome, type GlobalHome } from '../utils/community-directory';
import { PLACE_CIRCLE_WORDS, circleWaitingLine, t } from '@beanpool/core';

/** The Find card's read, once, for a screen the Find card isn't on: from the account's own area, signed when there is one. */
export function useFindCardRead(wanted: boolean, identity: BeanPoolIdentity | null): GlobalHome | null {
    const [home, setHome] = useState<GlobalHome | null>(null);
    useEffect(() => {
        if (!wanted) return;
        let alive = true;
        void fetchGlobalHome(null, identity).then(r => { if (alive && r.ok) setHome(r.value); });
        return () => { alive = false; };
    }, [wanted, identity?.publicKey]);
    return home;
}

/**
 * The empty Market's way to the people waiting near (Lounge L2, §3.2): "{n} people near you are waiting for a community
 * too · Meet them ›". Nothing at all below 3. Meet them opens their circle, or the screen where they can say they'd help.
 */
export function MarketCircleLine({ identity, colors }: { identity: BeanPoolIdentity | null; colors: AppColors }) {
    const home = useFindCardRead(true, identity);
    const line = circleWaitingLine(home?.demand);
    if (!line) return null;
    const circle = home?.circle;
    return (
        <View testID="market-circle-line" style={{ alignItems: 'center', marginBottom: 12, paddingHorizontal: 16 }}>
            <Text style={{ fontSize: 14, color: colors.text.secondary, textAlign: 'center' }}>{line}</Text>
            <Pressable accessibilityRole="button" style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16 }} testID="market-meet-them"
                onPress={() => router.push(circle ? `/group/${encodeURIComponent(circle.id)}` as any : '/find-community')}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: colors.brand.primary, textAlign: 'center' }}>{t(PLACE_CIRCLE_WORDS.meetThem)}</Text>
            </Pressable>
        </View>
    );
}
