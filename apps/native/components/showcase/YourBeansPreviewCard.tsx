/**
 * Home's Your Beans card where Beans are previewed (scratch/global-node/DESIGN-global-showcase-fable.md §1 row 1): the
 * marker's pill on the caption, one sentence, and "See an example ledger ›", which opens the Ledger (Example Valley's in
 * preview). No API: nothing here is read from or written to a node.
 */
import React from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { LOCAL_COMMUNITY_LINES } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HomeCard, HomeRow, homeStyles } from '../home/HomeParts';
import { LocalCommunityMark } from './LocalCommunityMark';

export function YourBeansPreviewCard({ colors }: { colors: AppColors }) {
    const s = homeStyles(colors);
    return (
        <HomeCard id="beans-preview" caption="Your Beans" colors={colors} testID="home-card-beans-preview"
            right={<LocalCommunityMark variant="pill" feature="beans" />}>
            <Text style={s.note}>{LOCAL_COMMUNITY_LINES.yourBeansCard}</Text>
            <HomeRow colors={colors} text={LOCAL_COMMUNITY_LINES.yourBeansLink} a11y="See an example ledger"
                onPress={() => router.navigate('/(tabs)/ledger')} testID="home-beans-preview-ledger" />
        </HomeCard>
    );
}
