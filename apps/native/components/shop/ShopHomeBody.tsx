/**
 * Home's "Your shop and tools" (DESIGN-shops-and-tools-fable.md §8; slice S4′; type `shop`, built by the node from the
 * member's own shop, apps/server routes/home-answer.ts shopCard): two lines, each one target into its screen. Before a
 * shop: Open your shop, and the tools. With one: its title as the member wrote it (or "<their name>'s shop") over its
 * counts or "Closed for now", and the tools.
 */
import React from 'react';
import { router } from 'expo-router';
import { t } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HomeRow } from '../home/HomeParts';
import { shopStateLine, shopTitle, type ShopHomeCard } from '../../utils/shop';

export function ShopHomeBody({ card, colors }: { card: ShopHomeCard; colors: AppColors }) {
    const tools = (
        <HomeRow
            colors={colors}
            text={t('Tools')}
            sub={t('Things you can do on your own')}
            a11y={t('Tools: things you can do on your own.')}
            onPress={() => router.push('/tools')}
            testID="home-shop-tools"
        />
    );
    if (!card.shop) {
        return (
            <>
                <HomeRow
                    colors={colors}
                    text={t('Open your shop')}
                    sub={t('A front window on your own account, for the Offers you choose.')}
                    a11y={t('Open your shop: a front window on your own account, for the Offers you choose.')}
                    strong
                    onPress={() => router.push('/shop/mine')}
                    testID="home-shop-open"
                />
                {tools}
            </>
        );
    }
    const title = shopTitle(card.shop);
    const state = shopStateLine(card.shop);
    return (
        <>
            <HomeRow
                colors={colors}
                text={title}
                sub={state}
                strong
                a11y={t('{shop}: {state}. Opens your shop.', { shop: title, state })}
                onPress={() => router.push('/shop/mine')}
                testID="home-shop-line"
            />
            {tools}
        </>
    );
}
