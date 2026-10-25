/**
 * A shop's page (slice S5 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3 "The member's shop page",
 * on DESIGN-shops-and-tools-fable.md §8 "The shop page (visitor)"): `/shop/<id>`, a member's shop as any member here reads
 * it. The same shopfront as an enterprise's page (components/shopfront), minus keepers and money: the banner, the owner's
 * picture as its logo, its name, category and since when, the owner's trust line, About (its blurb), Featured, its sections,
 * How I deal, and Message, a DM to the owner.
 *
 * - An enterprise's shop is its page: this replaces itself with /treasury-detail, as the profile screen does for an
 *   enterprise's key (E1).
 * - A visitor's view of it (the node sends its category and counts only, round 2 §9.4) is the cut-off, said in a sentence.
 * - The owner's own: no Message; the way to change it is Your shop (/shop/mine).
 * - None, and no answer, are each said; Try again reads it again.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@beanpool/core';
import { useTheme } from '../ThemeContext';
import { useIdentity } from '../IdentityContext';
import { createConversationApi, getMemberProfile } from '../../utils/db';
import { isUserBlocked } from '../../utils/blocklist';
import { useReaderFeatures } from '../../utils/use-reader-features';
import { marketShowsBeans } from '../../utils/market-global';
import { HOME_TARGET_DP } from '../../components/home/HomeParts';
import { PostAuthorTrust } from '../../components/PostAuthorTrust';
import { ToolButton, ToolEmpty, ToolSection } from '../../tools/ui';
import {
    ShopfrontFeatured, ShopfrontHeader, ShopfrontMessage, ShopfrontSections, ShopfrontText, ShopfrontVisitorNote, categorySinceLine,
} from '../../components/shopfront/Shopfront';
import { shopStateLine, shopTitle } from '../../utils/shop';
import {
    featuredOf, messageLabel, readShopListingsForReader, readShopPage, shopSectionsOf, sinceLine, type ShopfrontListing, type ShopPageRead,
} from '../../utils/shopfront';

export default function ShopPageScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    const params = useLocalSearchParams<{ id?: string | string[] }>();
    const id = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? params.id[0] : '';
    const reader = useReaderFeatures();
    const showsBeans = marketShowsBeans(reader.effective);
    const [read, setRead] = useState<ShopPageRead | null>(null);
    /** Its Offers: undefined while read, null when they couldn't be. */
    const [listings, setListings] = useState<ShopfrontListing[] | null | undefined>(undefined);
    const [logo, setLogo] = useState<string | null>(null);
    const [messaging, setMessaging] = useState(false);

    const load = useCallback(async (afresh = false) => {
        if (!id) { setRead({ state: 'none' }); return; }
        if (afresh) setRead(null);
        const r = await readShopPage(id);
        if (r.state === 'enterprise') {
            router.replace({ pathname: '/treasury-detail', params: { publicKey: r.ownerPublicKey, name: r.name } });
            return;
        }
        setRead(r);
        if (r.state !== 'shop') return;
        // The owner's picture as the phone already holds it: no read of its own.
        getMemberProfile(r.shop.ownerPublicKey).then((m: { avatar_url?: unknown } | null) => setLogo(typeof m?.avatar_url === 'string' ? m.avatar_url : null)).catch(() => {});
        setListings(await readShopListingsForReader(r.shop.id));
    }, [id]);
    useFocusEffect(useCallback(() => { void load(); }, [load]));

    const shop = read?.state === 'shop' ? read.shop : null;
    const mine = !!shop && shop.ownerPublicKey === identity?.publicKey;
    const back = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/market'); };

    const message = async () => {
        if (!shop || !identity?.publicKey || messaging) return;
        setMessaging(true);
        try {
            if (await isUserBlocked(shop.ownerPublicKey)) {
                Alert.alert(t('You have blocked {name}', { name: shop.ownerName }), t('Unblock them from their profile to write to them.'));
                return;
            }
            const conv = await createConversationApi('dm', [identity.publicKey, shop.ownerPublicKey], identity.publicKey);
            router.push(`/chat/${conv.id}`);
        } catch (e) {
            const said = e instanceof Error ? e.message : '';
            const offline = !said || /off-grid|network|fetch failed|failed to fetch|offline|timeout|abort/i.test(said);
            Alert.alert(t('Error'), offline ? t('Connect to your community to start a chat.') : said);
        } finally {
            setMessaging(false);
        }
    };

    const title = shop ? shopTitle(shop) : t('Shop');
    const tier = (listings ?? []).find((l) => l.authorTierCredit !== null)?.authorTierCredit ?? null;

    return (
        <View style={[styles.page, { backgroundColor: colors.surface.page, paddingTop: insets.top }]} testID="shop-page">
            <View style={[styles.header, { backgroundColor: colors.surface.card, borderBottomColor: colors.border.default }]}>
                <Pressable onPress={back} style={styles.back} accessibilityRole="button" accessibilityLabel={t('Back')} testID="shop-page-back">
                    <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.heading} />
                </Pressable>
                <Text style={[styles.title, { color: colors.text.heading }]} numberOfLines={1}>{title}</Text>
            </View>
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: 24 + insets.bottom }]}>
                {read === null ? <View style={styles.reading} testID="shop-page-reading"><ActivityIndicator color={colors.brand.primary} /></View> : null}

                {read?.state === 'offline' ? (
                    <ToolSection testID="shop-page-offline">
                        <ToolEmpty icon="📡" text={t("This shop couldn't be read just now. Try again.")}
                            action={<ToolButton text={t('Try again')} onPress={() => { void load(true); }} testID="shop-page-retry" />} />
                    </ToolSection>
                ) : null}
                {read?.state === 'none' ? (
                    <ToolSection testID="shop-page-none">
                        <ToolEmpty icon="🏪" text={t('This shop is not here any more. Its owner may have closed it.')} />
                    </ToolSection>
                ) : null}
                {read?.state === 'visitor' ? (
                    <View style={styles.body}>
                        <ShopfrontVisitorNote text={t("Members of this community see a shop's name, its owner and what it offers.")} />
                    </View>
                ) : null}

                {shop ? (
                    <View style={styles.body}>
                        <ShopfrontHeader
                            name={title}
                            ownerKey={shop.ownerPublicKey}
                            logoUrl={logo}
                            category={shop.category}
                            bannerPhoto={shop.photoUrl}
                            fallbackEmoji="🏪"
                            lines={[categorySinceLine(shop.category, sinceLine(shop.openedAt)), shop.paused ? shopStateLine(shop) : null]}
                        />
                        {/* The owner's trust line, a 48 dp target to their profile (the line on its own is a card's 30 dp). */}
                        <Pressable
                            style={styles.trust}
                            onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: shop.ownerPublicKey, callsign: shop.ownerName } })}
                            accessibilityRole="button"
                            accessibilityLabel={t("View {name}'s profile", { name: shop.ownerName })}
                            testID="shop-page-owner"
                        >
                            <PostAuthorTrust pubkey={shop.ownerPublicKey} callsign={shop.ownerName} avatarUrl={logo} energyCycled={tier ?? 0} showTier={showsBeans && tier !== null} navigable={false} />
                        </Pressable>
                        {shop.blurb ? <ShopfrontText title={t('About')} text={shop.blurb} testID="shopfront-about" /> : null}
                        {listings ? <ShopfrontFeatured listings={featuredOf(listings)} showsBeans={showsBeans} /> : null}
                        {listings === undefined ? <Text style={[styles.note, { color: colors.text.secondary }]}>{t('Reading what is in it…')}</Text> : null}
                        {listings === null ? <Text style={[styles.note, { color: colors.text.secondary }]} testID="shop-page-listings-unread">{t("What is in this shop couldn't be read just now.")}</Text> : null}
                        {listings ? (
                            <ShopfrontSections
                                sections={shopSectionsOf(listings)}
                                showsBeans={showsBeans}
                                empty={shop.paused ? t('This shop is closed for now. Its Offers wait until it reopens.') : t('Nothing in this shop yet.')}
                            />
                        ) : null}
                        {shop.howToDeal ? <ShopfrontText title={t('How I deal')} text={shop.howToDeal} boxed testID="shopfront-how" /> : null}
                        {mine ? (
                            <View style={styles.mine} testID="shop-page-mine">
                                <Text style={[styles.note, { color: colors.text.secondary }]}>{t('This is your shop as members here see it.')}</Text>
                                <ToolButton text={t('Change your shop')} onPress={() => router.push('/shop/mine')} testID="shop-page-change" />
                            </View>
                        ) : (
                            <ShopfrontMessage label={messageLabel(shop.ownerName, 'shop')} busy={messaging} onPress={() => { void message(); }} />
                        )}
                    </View>
                ) : null}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    page: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 4, borderBottomWidth: 1 },
    back: { width: HOME_TARGET_DP, height: HOME_TARGET_DP, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    title: { flex: 1, fontSize: 18, fontWeight: '800', paddingRight: 12 },
    scroll: { paddingTop: 12 },
    body: { paddingHorizontal: 16 },
    reading: { paddingVertical: 32, alignItems: 'center' },
    trust: { minHeight: HOME_TARGET_DP, justifyContent: 'center', marginTop: -8, marginBottom: 8 },
    note: { fontSize: 14, lineHeight: 20, marginBottom: 12 },
    mine: { gap: 8, marginBottom: 16 },
});
