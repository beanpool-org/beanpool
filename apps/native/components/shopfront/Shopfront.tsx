/**
 * The shopfront's parts (slice S5 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3, §6, on round 2's
 * shop page, DESIGN-shops-and-tools-fable.md §8): built once, and drawn by both pages that are one shopfront, a member's
 * shop (app/shop/[id].tsx) and an enterprise's page (app/treasury-detail.tsx). Their words and reads are utils/shopfront.ts.
 *
 * At 320 dp and 1.3× text every part is one column and wraps rather than clips; every colour is a central token, light
 * and dark; every word goes through t(). Pictures are the node's own (the logo is the avatar, the banner the shop's one
 * photo, the tiles the listings' own), never a new copy, never enlarged past the node's 800 px (memory: photos stay 800px).
 *
 * Not here: the keepers' console (Manage, S7) and the web (S8).
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { formatCount, listPhotoUrl, t, type ShopCategory } from '@beanpool/core';
import { useStyles, useTheme } from '../../app/ThemeContext';
import type { AppColors } from '../../constants/colors';
import { MemberAvatar } from '../MemberAvatar';
import { Sentence } from '../Sentence';
import { categoryEmoji, categoryLabel, normalizeCategory } from '../../constants/categories';
import { shopCategoryLabel } from '../../utils/shop';
import { anchorUrl } from '../../utils/node-post';
import {
    keeperBadgeLine, listingPriceLine, listingStateLine, type ShopfrontKeeper, type ShopfrontListing, type ShopSection,
} from '../../utils/shopfront';

/** The touch floor every control here keeps. */
const TARGET_DP = 48;
/** How many rows a section shows before "Show all". */
const SECTION_ROWS = 5;

const makeStyles = ({ colors }: { colors: AppColors }) => StyleSheet.create({
    block: { marginBottom: 16 },
    heading: { fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 8 },
    body: { fontSize: 15, lineHeight: 22, color: colors.text.body },
    muted: { fontSize: 13, lineHeight: 19, color: colors.text.secondary },
    more: { minHeight: TARGET_DP, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: 12 },
    moreText: { fontSize: 14, fontWeight: '700', color: colors.brand.primary },

    // 3:1 across the page, the shape its keeper chose the strip in (core BANNER_PICTURE), so what they chose is what shows.
    banner: { width: '100%', aspectRatio: 3, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.brand.tint, borderWidth: 1, borderColor: colors.border.default, alignItems: 'center', justifyContent: 'center' },
    bannerImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    bannerEmoji: { fontSize: 44 },
    logo: { marginTop: -32, marginLeft: 12, alignSelf: 'flex-start', borderRadius: 36, borderWidth: 4, borderColor: colors.surface.app, backgroundColor: colors.surface.app },
    name: { fontSize: 22, lineHeight: 28, fontWeight: '800', color: colors.text.heading, marginTop: 8 },
    line: { fontSize: 14, lineHeight: 20, color: colors.text.secondary, marginTop: 2 },

    keeperRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: TARGET_DP, paddingVertical: 6 },
    keeperText: { flex: 1, minWidth: 0 },
    keeperName: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
    keeperRole: { fontSize: 14, fontWeight: '600', color: colors.text.secondary },
    keeperBadges: { fontSize: 13, lineHeight: 19, color: colors.text.secondary, marginTop: 1 },
    suspended: { fontSize: 13, fontWeight: '700', color: colors.feedback.warning.fg, marginTop: 1 },

    quietBox: { backgroundColor: colors.surface.subtle, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default },

    tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
    tile: { borderRadius: 12, overflow: 'hidden', backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
    tilePhoto: { width: '100%', aspectRatio: 1, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center' },
    tileEmoji: { fontSize: 36 },
    tileText: { padding: 8, gap: 2 },
    tileTitle: { fontSize: 14, lineHeight: 19, fontWeight: '700', color: colors.text.heading },
    price: { fontSize: 13, fontWeight: '800', color: colors.brand.primary },

    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.accent.tint, borderWidth: 1, borderColor: colors.accent.border },
    chipText: { fontSize: 13, fontWeight: '600', color: colors.accent.primary },

    section: { marginBottom: 12 },
    sectionTitle: { fontSize: 14, fontWeight: '800', color: colors.text.heading, marginBottom: 4 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border.default },
    pausedRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border.default },
    // Only the picture fades: the ⏸ PAUSED badge says it, and faded words read under AA in dark.
    pausedThumb: { opacity: 0.75 },
    badgesRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
    typeBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
    badgeOffer: { backgroundColor: colors.market.offer.bg },
    badgeNeed: { backgroundColor: colors.market.need.bg },
    typeBadgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
    badgeOfferText: { color: colors.market.offer.fg },
    badgeNeedText: { color: colors.market.need.fg },
    pausedBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border },
    pausedBadgeText: { fontSize: 10, fontWeight: '800', color: colors.feedback.warning.fg, letterSpacing: 0.3 },
    thumb: { width: 48, height: 48, borderRadius: 8, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    thumbEmoji: { fontSize: 22 },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.text.heading },

    button: { minHeight: TARGET_DP, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand.fill },
    buttonText: { fontSize: 15, fontWeight: '800', color: colors.text.onBrand, textAlign: 'center' },

    money: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.border.default },
    moneyLine: { fontSize: 16, lineHeight: 22, fontWeight: '800', color: colors.text.heading },
    moneyToggle: { minHeight: TARGET_DP, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: 12 },
});

/** "More" / "Less" under a text that runs past its lines. */
function MoreLess({ open, onPress, testID }: { open: boolean; onPress: () => void; testID?: string }) {
    const s = useStyles(makeStyles);
    return (
        <Pressable onPress={onPress} style={s.more} accessibilityRole="button" accessibilityState={{ expanded: open }} testID={testID}>
            <Text style={s.moreText}>{open ? t('Less', undefined, 'show less of a text') : t('More', undefined, 'show the rest of a text')}</Text>
        </Pressable>
    );
}

/**
 * A picture's address to draw: one of the node's own (`/api/…`, as a shop's banner comes) on the phone's community, once
 * its address is known; any other as it is (a photo just picked is a data URL). Null for none, and while it is read.
 */
export function useNodeUri(url: string | null | undefined): string | null {
    const relative = typeof url === 'string' && url.startsWith('/');
    const [anchor, setAnchor] = useState<string | null>(null);
    useEffect(() => {
        if (!relative) return;
        let live = true;
        void anchorUrl().then((a) => { if (live) setAnchor(a); }).catch(() => {});
        return () => { live = false; };
    }, [relative]);
    if (!url) return null;
    if (!relative) return url;
    return anchor ? `${anchor.replace(/\/+$/, '')}${url}` : null;
}

/**
 * The top of the shopfront: the banner (the shop's one photo, 3:1 as its keeper chose it, or a quiet block with its category's
 * emoji, as its listings show it, when it has none or the photo won't load), the logo over its foot (the avatar the
 * account already has), the name, and the lines under it: its category and since when, and any other.
 */
export function ShopfrontHeader({ name, ownerKey, logoUrl, category, fallbackEmoji, bannerPhoto, lines, testID }: {
    name: string;
    ownerKey: string;
    logoUrl: string | null | undefined;
    category: ShopCategory | null;
    /** The banner's emoji when the shop has no category. */
    fallbackEmoji: string;
    /** Its shop's photo as the node gives it (its `photoUrl`, keyed), or none. */
    bannerPhoto?: string | null;
    /** The lines under the name, in order; an empty one is left out. */
    lines: Array<string | null | undefined>;
    testID?: string;
}) {
    const s = useStyles(makeStyles);
    const photo = useNodeUri(bannerPhoto);
    const [failed, setFailed] = useState<string | null>(null);
    return (
        <View style={s.block} testID={testID ?? 'shopfront-header'}>
            <View style={s.banner} testID="shopfront-banner" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {photo && photo !== failed ? (
                    <Image source={{ uri: photo }} style={s.bannerImage} contentFit="cover" cachePolicy="memory-disk" onError={() => setFailed(photo)} />
                ) : (
                    <Text style={s.bannerEmoji}>{category ? categoryEmoji(category) : fallbackEmoji}</Text>
                )}
            </View>
            <View style={s.logo} testID="shopfront-logo">
                <MemberAvatar avatarUrl={logoUrl} pubkey={ownerKey} callsign={name} size={64} />
            </View>
            <Text style={s.name} accessibilityRole="header" testID="shopfront-name">{name}</Text>
            {lines.filter((l): l is string => !!l).map((l, i) => (
                <Text key={i} style={s.line} testID={`shopfront-line-${i}`}>{l}</Text>
            ))}
        </View>
    );
}

/** Its category and since when, in one line: "💻 Tech · since Sep 2026". */
export function categorySinceLine(category: ShopCategory | null, since: string | null): string | null {
    const parts = [category ? shopCategoryLabel(category) : null, since].filter((p): p is string => !!p);
    return parts.length ? parts.join(' · ') : null;
}

/** A keeper's part, in their kind's words: a project's leader and collaborators, an enterprise's lead keeper and keepers. */
export function keeperRoleWord(project: boolean, isLead: boolean): string {
    if (project) return isLead ? t('Leader', undefined, 'project role') : t('Collaborator', undefined, 'project role');
    return isLead ? t('Lead keeper', undefined, 'enterprise role') : t('Keeper', undefined, 'enterprise role');
}

/** What a screen reader says for a suspended keeper's row. */
function suspendedKeeperLabel(name: string, project: boolean, isLead: boolean): string {
    if (project) return isLead ? t('{name}, leader, suspended', { name }) : t('{name}, collaborator, suspended', { name });
    return isLead ? t('{name}, lead keeper, suspended', { name }) : t('{name}, keeper, suspended', { name });
}

/**
 * Who keeps it, each a row: their picture, name and part, and under it their badges (tier, stars, trades) when the node
 * gave them; said once that the badges are recognition and gate nothing (memory: tiers are merit badges). A tap opens
 * the keeper's own profile.
 */
export function ShopfrontKeepers({ keepers, project, navigable = true, children }: { keepers: ShopfrontKeeper[]; project: boolean; navigable?: boolean; children?: React.ReactNode }) {
    const s = useStyles(makeStyles);
    const anyBadges = keepers.some((k) => keeperBadgeLine(k) !== null);
    if (keepers.length === 0) return null;
    return (
        <View style={s.block} testID="shopfront-keepers">
            <Text style={s.heading} accessibilityRole="header">{project ? t('Run by', undefined, "a project's people") : t('Kept by', undefined, "an enterprise's keepers")}</Text>
            {keepers.map((k) => {
                const role = keeperRoleWord(project, k.isLead);
                const badges = keeperBadgeLine(k);
                const label = [k.suspended ? suspendedKeeperLabel(k.callsign, project, k.isLead) : t('{name}, {role}', { name: k.callsign, role }), badges].filter(Boolean).join('. ');
                const Row = navigable ? Pressable : View;
                return (
                    <Row
                        key={k.publicKey}
                        style={s.keeperRow}
                        {...(navigable ? {
                            onPress: () => router.push({ pathname: '/public-profile', params: { publicKey: k.publicKey, callsign: k.callsign } }),
                            accessibilityRole: 'button' as const,
                        } : { accessible: true })}
                        accessibilityLabel={label}
                        testID={`shopfront-keeper-${k.publicKey}`}
                    >
                        <MemberAvatar avatarUrl={k.avatarUrl} pubkey={k.publicKey} callsign={k.callsign} size={32} />
                        <View style={s.keeperText}>
                            <Text style={s.keeperRole}>
                                <Sentence text={t('{name} · {role}', { role }, "a keeper's name and their part")} parts={{ name: <Text style={s.keeperName}>{k.callsign}</Text> }} />
                            </Text>
                            {k.suspended ? <Text style={s.suspended}>{t('Suspended')}</Text> : null}
                            {badges ? <Text style={s.keeperBadges} testID={`shopfront-badges-${k.publicKey}`}>{badges}</Text> : null}
                        </View>
                    </Row>
                );
            })}
            {anyBadges ? <Text style={s.muted} testID="shopfront-badges-note">{t('Badges show what each person has done here. They gate nothing.')}</Text> : null}
            {children}
        </View>
    );
}

/** A heading and a text in the owner's words, four lines until "More" (About, what it is for); in a quiet box when `boxed`. */
export function ShopfrontText({ title, text, boxed, lines = 4, testID }: { title: string; text: string; boxed?: boolean; lines?: number; testID: string }) {
    const s = useStyles(makeStyles);
    const [open, setOpen] = useState(false);
    const long = text.length > 180 || text.split('\n').length > lines;
    const body = <Text style={s.body} numberOfLines={open || !long ? undefined : lines}>{text}</Text>;
    return (
        <View style={s.block} testID={testID}>
            <Text style={s.heading} accessibilityRole="header">{title}</Text>
            {boxed ? <View style={s.quietBox}>{body}</View> : body}
            {long ? <MoreLess open={open} onPress={() => setOpen(!open)} testID={`${testID}-more`} /> : null}
        </View>
    );
}

/** Opens a listing's own screen: what a tile or a row does unless the page says otherwise (a preview opens nothing). */
export function openListing(id: string): void {
    router.push({ pathname: '/post/[id]', params: { id } });
}

/** A listing's picture: its own photo (the node's small copy), or its category's emoji on a quiet ground. */
function ListingPicture({ l, style, emojiStyle }: { l: ShopfrontListing; style: object; emojiStyle: object }) {
    return (
        <View style={style}>
            {l.photo ? (
                <Image source={{ uri: listPhotoUrl(l.photo) }} style={{ width: '100%', height: '100%' }} contentFit="cover" cachePolicy="memory-disk" accessibilityIgnoresInvertColors />
            ) : (
                <Text style={emojiStyle}>{categoryEmoji(l.category)}</Text>
            )}
        </View>
    );
}

/** Featured: up to six tiles, two a row, each its photo, title and price; a tap opens the listing. */
export function ShopfrontFeatured({ listings, showsBeans, onOpen = openListing }: { listings: ShopfrontListing[]; showsBeans: boolean; onOpen?: (id: string) => void }) {
    const s = useStyles(makeStyles);
    const [width, setWidth] = useState(0);
    if (listings.length === 0) return null;
    // Two a row with a 16 dp gap: 136 dp each in the 288 dp a 320 dp screen leaves.
    const tile = width > 0 ? Math.floor((width - 16) / 2) : 136;
    return (
        <View style={s.block} testID="shopfront-featured">
            <Text style={s.heading} accessibilityRole="header">{t('Featured', undefined, "a shop's chosen Offers")}</Text>
            <View style={s.tiles} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
                {listings.map((l) => {
                    const price = listingPriceLine(l, showsBeans);
                    return (
                        <Pressable
                            key={l.id}
                            style={[s.tile, { width: tile }]}
                            onPress={() => onOpen(l.id)}
                            accessibilityRole="button"
                            accessibilityLabel={price ? t('{title}, {price}', { title: l.title, price }) : l.title}
                            testID={`shopfront-featured-${l.id}`}
                        >
                            <ListingPicture l={l} style={s.tilePhoto} emojiStyle={s.tileEmoji} />
                            <View style={s.tileText}>
                                <Text style={s.tileTitle} numberOfLines={2}>{l.title}</Text>
                                {price ? <Text style={s.price}>{price}</Text> : null}
                            </View>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

/**
 * "What we do together": the categories of its keepers' live Offers and its own, as chips (round 3 §0 row 8), each once:
 * an older listing's id (tools_hardware) and today's (tools) are one category.
 */
export function ShopfrontTogether({ categories }: { categories: string[] }) {
    const s = useStyles(makeStyles);
    const ids = [...new Set(categories.map((c) => normalizeCategory(c)))];
    if (ids.length === 0) return null;
    return (
        <View style={s.block} testID="shopfront-together">
            <Text style={s.heading} accessibilityRole="header">{t('What we do together')}</Text>
            <View style={s.chips}>
                {ids.map((c) => (
                    <View key={c} style={s.chip}>
                        <Text style={s.chipText}>{t('{emoji} {category}', { emoji: categoryEmoji(c), category: categoryLabel(c) }, 'a category, after its emoji')}</Text>
                    </View>
                ))}
            </View>
        </View>
    );
}

/** Its sections, each a heading and its rows (picture, title, price or state); past five, "Show all". */
export function ShopfrontSections({ sections, showsBeans, empty, onOpen = openListing }: { sections: ShopSection[]; showsBeans: boolean; empty: string; onOpen?: (id: string) => void }) {
    const s = useStyles(makeStyles);
    const [open, setOpen] = useState<Record<string, boolean>>({});
    return (
        <View style={s.block} testID="shopfront-sections">
            {sections.length === 0 ? <Text style={s.muted} testID="shopfront-sections-empty">{empty}</Text> : null}
            {sections.map((section) => {
                const all = open[section.id] === true;
                const shown = all ? section.listings : section.listings.slice(0, SECTION_ROWS);
                const hidden = section.listings.length - shown.length;
                return (
                    <View key={section.id} style={s.section} testID={`shopfront-section-${section.id}`}>
                        <Text style={s.sectionTitle} accessibilityRole="header">{section.title}</Text>
                        {shown.map((l) => {
                            const lines = [listingPriceLine(l, showsBeans), listingStateLine(l)].filter((x): x is string => !!x);
                            return (
                                <Pressable
                                    key={l.id}
                                    style={s.row}
                                    onPress={() => onOpen(l.id)}
                                    accessibilityRole="button"
                                    accessibilityLabel={[l.title, ...lines].join(', ')}
                                    testID={`shopfront-row-${l.id}`}
                                >
                                    <ListingPicture l={l} style={s.thumb} emojiStyle={s.thumbEmoji} />
                                    <View style={s.rowText}>
                                        <Text style={s.rowTitle} numberOfLines={2}>{l.title}</Text>
                                        {lines.length ? <Text style={s.muted}>{lines.join(' · ')}</Text> : null}
                                    </View>
                                </Pressable>
                            );
                        })}
                        {hidden > 0 ? (
                            <Pressable onPress={() => setOpen({ ...open, [section.id]: true })} style={s.more} accessibilityRole="button" testID={`shopfront-section-${section.id}-all`}>
                                <Text style={s.moreText}>{t('Show all {n}', { n: formatCount(section.listings.length) }, 'the rest of a shop section')}</Text>
                            </Pressable>
                        ) : null}
                    </View>
                );
            })}
        </View>
    );
}

/** A keeper's view of the enterprise's paused listings: title, type, photo or category emoji fallback, words 'Paused'. */
export function ShopfrontPaused({ listings, onOpen = openListing }: { listings: ShopfrontListing[]; onOpen?: (id: string) => void }) {
    const s = useStyles(makeStyles);
    if (listings.length === 0) return null;
    return (
        <View style={s.block} testID="shopfront-paused">
            <View style={s.section}>
                <Text style={s.sectionTitle} accessibilityRole="header">{t('Paused')}</Text>
                {listings.map((l) => (
                    <Pressable
                        key={l.id}
                        style={s.pausedRow}
                        onPress={() => onOpen(l.id)}
                        accessibilityRole="button"
                        accessibilityLabel={l.title}
                        testID={`shopfront-row-${l.id}`}
                    >
                        <ListingPicture l={l} style={[s.thumb, s.pausedThumb]} emojiStyle={s.thumbEmoji} />
                        <View style={s.rowText}>
                            <Text style={s.rowTitle} numberOfLines={2}>{l.title}</Text>
                            <View style={s.badgesRow}>
                                <View style={[s.typeBadge, l.type === 'offer' ? s.badgeOffer : s.badgeNeed]}>
                                    <Text style={[s.typeBadgeText, l.type === 'offer' ? s.badgeOfferText : s.badgeNeedText]}>
                                        {l.type === 'offer' ? t('OFFER') : t('NEED')}
                                    </Text>
                                </View>
                                <View style={s.pausedBadge}>
                                    <Text style={s.pausedBadgeText}>{t('⏸ PAUSED')}</Text>
                                </View>
                            </View>
                        </View>
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

/** The Message button: a DM to the lead keeper (or the shop's owner), named. */
export function ShopfrontMessage({ label, busy, onPress }: { label: string; busy: boolean; onPress: () => void }) {
    const s = useStyles(makeStyles);
    const { colors } = useTheme();
    return (
        <View style={s.block}>
            <Pressable
                style={[s.button, busy && { opacity: 0.6 }]}
                onPress={onPress}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ disabled: busy, busy }}
                testID="shopfront-message"
            >
                {busy ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={s.buttonText}>{label}</Text>}
            </Pressable>
        </View>
    );
}

/** The money in one line, and "Money and backing" opening today's figures, pledges and ledger under it (round 3 §0 row 9). */
export function ShopfrontMoney({ line, initiallyOpen = false, children }: { line: string; initiallyOpen?: boolean; children: React.ReactNode }) {
    const s = useStyles(makeStyles);
    const [open, setOpen] = useState(initiallyOpen);
    return (
        <View style={s.block} testID="shopfront-money">
            <View style={s.money}>
                <Text style={s.moneyLine} testID="shopfront-money-line">{line}</Text>
                <Pressable onPress={() => setOpen(!open)} style={s.moneyToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="shopfront-money-toggle">
                    <Text style={s.moreText}>{open ? t('Hide money and backing') : t('Money and backing ›')}</Text>
                </Pressable>
            </View>
            {open ? <View style={{ marginTop: 12 }} testID="shopfront-money-open">{children}</View> : null}
        </View>
    );
}

/** What a visitor is told where their page ends. */
export function ShopfrontVisitorNote({ text }: { text: string }) {
    const s = useStyles(makeStyles);
    return (
        <View style={[s.block, s.quietBox]} testID="shopfront-visitor">
            <Text style={s.muted}>{text}</Text>
        </View>
    );
}
