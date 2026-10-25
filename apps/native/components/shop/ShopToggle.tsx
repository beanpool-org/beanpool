/**
 * "Put this in your shop" (DESIGN-shops-and-tools-fable.md §9.1 and Marty's additions of 19 Oct 2026; slice S4′): one
 * checkbox row, the same on the List sheet (tools/list-sheet.tsx, on by default) and on an Offer's edit screen
 * (app/post/[id].tsx, where the listing is now, as the node says). Its words say where the Offer goes: the shop's title,
 * or "Your shop opens with it." when the member has none yet, which is what happens (the composer, or the edit, opens it
 * first). While the shop is closed for now nothing goes in, so the row is not offered and a sentence says why; an Offer
 * already in it can still be taken out. With no shop to read (no answer, a node from before shops) nothing is drawn and
 * nothing is promised.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { t, type ShopCategory } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HOME_TARGET_DP, homeStyles } from '../home/HomeParts';
import { changeMyShop, shopTitle, type MyShopRead } from '../../utils/shop';
import { SHOP_COMPOSER_WAIT_MS } from '../../utils/shop-choice';

/**
 * Where an Offer could go: the member's shop (open, or closed for now, with its category: a new Offer put in it with none of
 * its own starts there), none yet, or nothing to offer.
 */
export type ShopToggleState =
    | { kind: 'open'; shopId: string; title: string; inShop: boolean; category?: ShopCategory | null }
    | { kind: 'paused'; shopId: string; title: string; inShop: boolean; category?: ShopCategory | null }
    | { kind: 'none' }
    | { kind: 'hidden' };

/** The toggle's state from the member's shop as read (utils/shop.ts readMyShop); `inShop`: the listing is in it now. */
export function shopToggleState(read: MyShopRead | null, opts: { inShop?: boolean } = {}): ShopToggleState {
    if (!read) return { kind: 'hidden' };
    if (read.state === 'none') return { kind: 'none' };
    if (read.state !== 'open') return { kind: 'hidden' };
    const base = { shopId: read.shop.id, title: shopTitle(read.shop), inShop: !!opts.inShop, category: read.shop.category };
    return read.shop.paused ? { kind: 'paused', ...base } : { kind: 'open', ...base };
}

/** Whether something can go in: a shop that is open, or none yet (it opens with it). */
export const shopTakesOffers = (state: ShopToggleState): boolean => state.kind === 'open' || state.kind === 'none';

/**
 * What an Offer's edit sends as its shop (utils/db.ts updatePost `shopId`): undefined when the toggle is where it
 * started, null to take it out, the shop's id to put it in; with none yet, the shop is opened first, waiting no longer
 * than the composer does for the same ({@link SHOP_COMPOSER_WAIT_MS}): Save waits on it, and on a line that never
 * answers it says the community couldn't be reached, with the edit kept. Closed for now, or nothing read: nothing goes in.
 */
export async function shopIdForEdit(state: ShopToggleState, startedOn: boolean, on: boolean): Promise<string | null | undefined> {
    if (on === startedOn) return undefined;
    if (!on) return null;
    if (state.kind === 'open') return state.shopId;
    if (state.kind === 'none') return (await changeMyShop({}, { timeoutMs: SHOP_COMPOSER_WAIT_MS })).shop.id;
    return undefined;
}

export function ShopToggle({ state, on, onChange, colors, testID }: {
    state: ShopToggleState;
    on: boolean;
    onChange: (on: boolean) => void;
    colors: AppColors;
    testID: string;
}) {
    const s = homeStyles(colors);
    if (state.kind === 'hidden') return null;
    if (state.kind === 'paused' && !state.inShop) {
        return <Text style={s.note} testID={`${testID}-paused`}>{t('Your shop is closed for now, so this stays out of it.')}</Text>;
    }
    const where = state.kind === 'none' ? t('Your shop opens with it.') : state.title;
    return (
        <View style={toggle.wrap}>
            <Pressable
                onPress={() => onChange(!on)}
                style={({ pressed }) => [toggle.row, { borderColor: colors.border.default, backgroundColor: pressed ? colors.surface.subtle : colors.surface.app }]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={t('Put this in your shop: {where}', { where })}
                testID={testID}
            >
                <View style={[toggle.box, { borderColor: on ? colors.brand.primary : colors.border.strong, backgroundColor: on ? colors.brand.fill : colors.surface.card }]}>
                    {on ? <Text style={[toggle.tick, { color: colors.text.onBrand }]} importantForAccessibility="no">✓</Text> : null}
                </View>
                <View style={toggle.text}>
                    <Text style={[toggle.title, { color: colors.text.heading }]}>{t('Put this in your shop')}</Text>
                    <Text style={[toggle.where, { color: colors.text.secondary }]} numberOfLines={2} testID={state.kind === 'none' ? `${testID}-opens` : undefined}>{where}</Text>
                </View>
            </Pressable>
            {state.kind === 'paused' ? <Text style={s.note} testID={`${testID}-closed`}>{t('Your shop is closed for now. Taken out, this stays out.')}</Text> : null}
        </View>
    );
}

const toggle = StyleSheet.create({
    wrap: { marginTop: 12 },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: HOME_TARGET_DP, padding: 12, borderRadius: 12, borderWidth: 1, gap: 12 },
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    tick: { fontSize: 15, fontWeight: '800' },
    text: { flex: 1, minWidth: 0 },
    title: { fontSize: 15, fontWeight: '700' },
    where: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
