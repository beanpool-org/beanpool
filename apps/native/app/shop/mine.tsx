/**
 * Your shop (DESIGN-shops-and-tools-fable.md §8 "Your shop (owner)", §9.1, and Marty's additions of 19 Oct 2026; slice S4′
 * of DESIGN-tool-template-fable.md §6): `/shop/mine`, from Home's "Your shop and tools" and the Tools screen. A member's
 * shop is a front window on their own account: the Offers they put in it, under one name, and all its Beans are theirs.
 *
 * - None yet: what a shop is, and Open my shop (a PUT with nothing in it: named "<their name>'s shop" until they name it).
 * - Open: its title, kind and counts; its four fields (Name · Kind · About · How I deal), each tappable, in any order,
 *   none required; what is in it now, each opening its listing; "Add my live Offers"; the way to the tools.
 * - Close for now (optionally back on a day): its Offers come off the Market and wait; one tap reopens it. Close my shop:
 *   its Offers stay in the Market on their own (the default) or end. Neither while a deal on one of its things is open:
 *   the node's sentence is shown, with the way to the deals.
 * - No answer, and a node from before shops, are each said; nothing is offered that would fail.
 *
 * Not here: "Give the shop its own account" (slice S7, after the node's step S6), and an enterprise's shopfront.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t, tn, type ShopKind } from '@beanpool/core';
import { useTheme } from '../ThemeContext';
import { useIdentity } from '../IdentityContext';
import { HOME_TARGET_DP, homeStyles } from '../../components/home/HomeParts';
import { ToolButton, ToolButtons, ToolEmpty, ToolNote, ToolRow, ToolSection } from '../../tools/ui';
import {
    ShopAddOffersSheet, ShopCloseSheet, ShopKindSheet, ShopPauseSheet, ShopTextSheet, type ShopSheetRefusal, type ShopTextField,
} from '../../components/shop/ShopSheets';
import {
    addOffersToMyShop, changeMyShop, closeMyShop, offersToAdd, readMyLiveOffers, readMyShop, readShopListings, shopKindLabel, shopStateLine,
    shopTitle, type MyShop, type MyShopChanges, type MyShopRead, type ShopListing,
} from '../../utils/shop';

type Where = 'screen' | 'text' | 'kind' | 'pause' | 'close' | 'add';

/**
 * A refusal as the screen shows it: the node's own sentence when it answered, else ours. An answer without the node's
 * words (`unsaid`: a proxy's 502 page, an empty 500) is no answer: its message is "Request failed: <status>", in English.
 */
function refusalOf(e: unknown): ShopSheetRefusal {
    const err = e as { message?: unknown; status?: unknown; code?: unknown; unsaid?: unknown } | null;
    const answered = typeof err?.status === 'number' && err.unsaid !== true && typeof err.message === 'string' && err.message.trim().length > 0;
    return {
        message: answered ? String(err!.message) : t("Your community couldn't be reached. Try again."),
        code: typeof err?.code === 'string' ? err.code : undefined,
    };
}

/** What one of its Offers is doing now, in words. */
function listingState(l: ShopListing): string {
    if (l.status === 'paused') return t('Paused');
    if (l.status === 'pending') return l.lendable ? t('Out on loan') : t('In a deal');
    return l.lendable ? t('To borrow') : t('On the Market');
}
const LIVE = new Set(['active', 'pending', 'paused']);

export default function YourShopScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    const me = identity?.publicKey ?? '';
    const s = homeStyles(colors);
    const [read, setRead] = useState<MyShopRead | null>(null);
    /** Its Offers: undefined while read, null when they couldn't be. */
    const [listings, setListings] = useState<ShopListing[] | null | undefined>(undefined);
    const [editing, setEditing] = useState<ShopTextField | null>(null);
    const [sheet, setSheet] = useState<'kind' | 'pause' | 'close' | 'add' | null>(null);
    const [offers, setOffers] = useState<ShopListing[] | null | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<{ where: Where } & ShopSheetRefusal | null>(null);
    /** Just closed: how many of its Offers ended (null: they stay on their own). */
    const [closed, setClosed] = useState<{ ended: number | null } | null>(null);

    const loadListings = useCallback(async (shop: MyShop) => {
        if (me) setListings(await readShopListings(shop.id, me));
    }, [me]);
    /** Read again: on every return to the screen, keeping what it shows meanwhile; from Try again, showing it is reading. */
    const load = useCallback(async (afresh = false) => {
        if (afresh) setRead(null);
        const r = await readMyShop();
        setRead(r);
        if (r.state === 'open') await loadListings(r.shop);
    }, [loadListings]);
    useFocusEffect(useCallback(() => { void load(); }, [load]));

    const shop = read?.state === 'open' ? read.shop : null;
    const refusedAt = (where: Where) => (refusal?.where === where ? refusal : null);
    const openDeals = () => {
        setSheet(null);
        router.push({ pathname: '/(tabs)/market', params: { tab: 'deals' } });
    };

    /** One change, then the shop as the node answered it; false when it was refused (said where it was asked). */
    const change = async (changes: MyShopChanges, where: Where): Promise<boolean> => {
        setBusy(true);
        setRefusal(null);
        try {
            const done = await changeMyShop(changes);
            setRead({ state: 'open', shop: done.shop });
            setClosed(null);
            await loadListings(done.shop);
            return true;
        } catch (e) {
            setRefusal({ where, ...refusalOf(e) });
            return false;
        } finally {
            setBusy(false);
        }
    };

    const saveText = async (text: string | null) => {
        if (editing && await change({ [editing]: text }, 'text')) setEditing(null);
    };
    const pickKind = async (kind: ShopKind | null) => {
        if (await change({ kind }, 'kind')) setSheet(null);
    };
    const pause = async (backOn: string | null) => {
        if (await change(backOn ? { paused: true, backOn } : { paused: true }, 'pause')) setSheet(null);
    };
    const closeShop = async (endOffers: boolean) => {
        setBusy(true);
        setRefusal(null);
        try {
            const done = await closeMyShop(endOffers);
            setSheet(null);
            setRead({ state: 'none' });
            setListings(undefined);
            setClosed({ ended: endOffers ? done.ended : null });
        } catch (e) {
            setRefusal({ where: 'close', ...refusalOf(e) });
        } finally {
            setBusy(false);
        }
    };
    const openAdd = async () => {
        if (!shop) return;
        setRefusal(null);
        setOffers(undefined);
        setSheet('add');
        const mine = await readMyLiveOffers(me);
        setOffers(mine ? offersToAdd(mine, shop.id) : null);
    };
    const add = async (postIds: string[]) => {
        setBusy(true);
        setRefusal(null);
        try {
            await addOffersToMyShop(postIds);
            setSheet(null);
            const r = await readMyShop();
            setRead(r);
            if (r.state === 'open') await loadListings(r.shop);
        } catch (e) {
            setRefusal({ where: 'add', ...refusalOf(e) });
        } finally {
            setBusy(false);
        }
    };
    const back = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); };
    const closeSheet = () => { setSheet(null); setRefusal(null); };

    const notSet = t('Not written yet');
    const kindWords = shop?.kind ? shopKindLabel(shop.kind) : null;
    const shown = (listings ?? []).filter((l) => LIVE.has(l.status));

    return (
        <View style={[styles.page, { backgroundColor: colors.surface.page, paddingTop: insets.top }]} testID="shop-screen">
            <View style={[styles.header, { backgroundColor: colors.surface.card, borderBottomColor: colors.border.default }]}>
                <Pressable onPress={back} style={styles.back} accessibilityRole="button" accessibilityLabel={t('Back')} testID="shop-back">
                    <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.heading} />
                </Pressable>
                <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header" numberOfLines={2}>{t('Your shop')}</Text>
            </View>
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: 24 + insets.bottom }]} keyboardShouldPersistTaps="handled">
                {read === null ? (
                    <View style={styles.reading} testID="shop-reading"><ActivityIndicator color={colors.brand.primary} /></View>
                ) : null}

                {read?.state === 'offline' ? (
                    <ToolSection testID="shop-offline">
                        <ToolEmpty icon="📡" text={t("Your shop couldn't be read just now. Try again.")}
                            action={<ToolButton text={t('Try again')} onPress={() => { void load(true); }} testID="shop-retry" />} />
                    </ToolSection>
                ) : null}

                {read?.state === 'older' ? (
                    <ToolSection testID="shop-older">
                        <ToolEmpty icon="🏪" text={t("Your community's server doesn't have shops yet. They come with its next update.")} />
                    </ToolSection>
                ) : null}

                {read?.state === 'none' ? (
                    <ToolSection testID="shop-none">
                        {closed ? (
                            closed.ended === null
                                ? <ToolNote text={t('Your shop is closed. Its Offers stay in the Market on their own.')} testID="shop-closed-kept" />
                                : <ToolNote text={tn(closed.ended, 'Your shop is closed, and its {n} Offer has ended.', 'Your shop is closed, and its {n} Offers have ended.')} testID="shop-closed-ended" />
                        ) : null}
                        <ToolEmpty
                            icon="🏪"
                            text={t('Your shop is a front window on your own account: the Offers you put in it, under one name. Its Beans are yours.')}
                            action={<ToolButton primary text={busy ? t('Opening…') : t('Open my shop')} disabled={busy} onPress={() => { void change({}, 'screen'); }} testID="shop-open" />}
                        />
                        {refusedAt('screen') ? <Text style={[s.note, { color: colors.feedback.danger.fg }]} testID="shop-error">{refusal!.message}</Text> : null}
                    </ToolSection>
                ) : null}

                {shop ? (
                    <>
                        <ToolSection testID="shop-front">
                            <Text style={[styles.shopTitle, { color: colors.text.heading }]} numberOfLines={2} testID="shop-title">{shopTitle(shop)}</Text>
                            <Text style={[styles.line, { color: colors.text.body }]} testID="shop-kind-line">{kindWords ?? t('No kind chosen yet')}</Text>
                            <Text style={[styles.line, { color: colors.text.secondary }]} testID="shop-state">{shopStateLine(shop)}</Text>
                            {shop.blurb ? <Text style={[styles.blurb, { color: colors.text.body }]}>{shop.blurb}</Text> : null}
                        </ToolSection>

                        {shop.paused ? (
                            <ToolSection testID="shop-paused">
                                <ToolNote text={t('Your shop is closed for now. Its Offers are off the Market and wait for you.')} />
                                <ToolButtons>
                                    <ToolButton primary text={t('Reopen my shop')} disabled={busy} onPress={() => { void change({ paused: false }, 'screen'); }} testID="shop-reopen" />
                                </ToolButtons>
                                {refusedAt('screen') ? <Text style={[s.note, { color: colors.feedback.danger.fg }]} testID="shop-error">{refusal!.message}</Text> : null}
                            </ToolSection>
                        ) : null}

                        <ToolSection title={t('About your shop')} testID="shop-fields">
                            <ToolRow title={t('Name')} state={shop.name ?? t('Not named yet')} onPress={() => { setRefusal(null); setEditing('name'); }} testID="shop-field-name" />
                            <ToolRow title={t('Kind')} state={kindWords ?? t('Not chosen yet')} onPress={() => { setRefusal(null); setSheet('kind'); }} testID="shop-field-kind" />
                            <ToolRow title={t('About')} state={shop.blurb ?? notSet} onPress={() => { setRefusal(null); setEditing('blurb'); }} testID="shop-field-blurb" />
                            <ToolRow title={t('How I deal')} state={shop.howToDeal ?? notSet} onPress={() => { setRefusal(null); setEditing('howToDeal'); }} testID="shop-field-howToDeal" />
                        </ToolSection>

                        <ToolSection title={t('In your shop')} testID="shop-listings">
                            {listings === undefined ? <ToolNote text={t('Reading your Offers…')} /> : null}
                            {listings === null ? <ToolNote text={t("Your shop's Offers couldn't be read just now.")} testID="shop-listings-unread" /> : null}
                            {listings && shown.length === 0 ? (
                                <ToolNote text={t('Nothing in it yet. Put an Offer in from its edit screen, or add your live Offers here.')} testID="shop-listings-empty" />
                            ) : null}
                            {shown.map((l) => (
                                <ToolRow key={l.id} title={l.title} state={listingState(l)} onPress={() => router.push({ pathname: '/post/[id]', params: { id: l.id } })} testID={`shop-listing-${l.id}`} />
                            ))}
                            <ToolButtons>
                                <ToolButton text={t('Add my live Offers')} disabled={shop.paused || busy} onPress={() => { void openAdd(); }} testID="shop-add-offers" />
                            </ToolButtons>
                            {shop.paused ? <ToolNote text={t('Nothing goes in while it is closed for now.')} /> : null}
                        </ToolSection>

                        <ToolSection title={t('Tools')}>
                            <ToolRow icon="🧰" title={t('Tools')} state={t('Things you can do on your own')} onPress={() => router.push('/tools')} testID="shop-tools" />
                        </ToolSection>

                        <ToolSection testID="shop-ends">
                            <ToolButtons>
                                {!shop.paused ? <ToolButton text={t('Close for now')} onPress={() => { setRefusal(null); setSheet('pause'); }} testID="shop-pause" /> : null}
                                <ToolButton text={t('Close my shop')} onPress={() => { setRefusal(null); setSheet('close'); }} testID="shop-close" />
                            </ToolButtons>
                        </ToolSection>
                    </>
                ) : null}
            </ScrollView>

            <ShopTextSheet
                field={editing}
                value={shop && editing ? (editing === 'name' ? shop.name : editing === 'blurb' ? shop.blurb : shop.howToDeal) ?? '' : ''}
                defaultName={shopTitle({ name: null, ownerName: shop?.ownerName ?? identity?.callsign ?? '' })}
                busy={busy}
                refusal={refusedAt('text')}
                colors={colors}
                onSave={(text) => { void saveText(text); }}
                onClose={() => { setEditing(null); setRefusal(null); }}
            />
            <ShopKindSheet visible={sheet === 'kind'} kind={shop?.kind ?? null} busy={busy} refusal={refusedAt('kind')} colors={colors}
                onPick={(k) => { void pickKind(k); }} onClose={closeSheet} />
            <ShopPauseSheet visible={sheet === 'pause'} busy={busy} refusal={refusedAt('pause')} colors={colors}
                onPause={(day) => { void pause(day); }} onClose={closeSheet} onDeals={openDeals} />
            <ShopCloseSheet visible={sheet === 'close'} busy={busy} refusal={refusedAt('close')} colors={colors}
                onCloseShop={(end) => { void closeShop(end); }} onClose={closeSheet} onDeals={openDeals} />
            <ShopAddOffersSheet visible={sheet === 'add'} offers={offers} busy={busy} refusal={refusedAt('add')} colors={colors}
                onAdd={(ids) => { void add(ids); }} onClose={closeSheet} />
        </View>
    );
}

const styles = StyleSheet.create({
    page: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 4, borderBottomWidth: 1 },
    back: { width: HOME_TARGET_DP, height: HOME_TARGET_DP, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    title: { flex: 1, fontSize: 20, fontWeight: '800', paddingRight: 12 },
    scroll: { paddingTop: 12 },
    reading: { paddingVertical: 32, alignItems: 'center' },
    shopTitle: { fontSize: 20, fontWeight: '800', marginTop: 10 },
    line: { fontSize: 15, lineHeight: 21, marginTop: 4 },
    blurb: { fontSize: 15, lineHeight: 21, marginTop: 8, marginBottom: 4 },
});
