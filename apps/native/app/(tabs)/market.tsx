import React, { useState, useEffect, useRef, useReducer, useCallback } from 'react';
import { StyleSheet, View, Text, FlatList, Animated, Pressable, useWindowDimensions, Platform, Alert, TextInput, ScrollView, DeviceEventEmitter, ActivityIndicator, RefreshControl } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router';
import { setHelpContext } from '../../utils/tour-store';
import { getPosts, getMarketplaceTransactions, getBalance, fetchGroups, fetchMyEvents, isRouteMissing, type GroupItem } from '../../utils/db';
import { marketCardPicture } from '../../utils/market-card-picture';
import { getBlockedUsers, BLOCKLIST_UPDATED_EVENT } from '../../utils/blocklist';
import { refusalHere, type Refusal } from '../../utils/members-only-listings';
import { marketEmptyState, refusalLines } from '../../utils/market-empty-state';
import { noAreaLineHere } from '../../utils/nearby-area';
import { NoAreaLine } from '../../components/NoAreaLine';
import { pollsInformal, showcaseMode } from '../../utils/node-profile';
import { useGlobalGuestVisit } from '../../utils/use-global-guest-visit';
import { requestSync, isPillarSyncActive, syncLandedOnThisCopy, PILLAR_SYNC_ENDED } from '../../services/pillar-sync';
import { useIdentity } from '../IdentityContext';
import { RadiusPickerModal } from '../../components/RadiusPickerModal';
import { MyDealsSheet, usePendingDealsCount } from '../../components/MyDealsSheet';
import { PostAuthorTrust, isElder } from '../../components/PostAuthorTrust';
import { TrustPickerSheet, TRUST_FILTERS } from '../../components/TrustPickerSheet';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { ActivityWaterfall } from '../../components/ActivityWaterfall';
import { categoryEmoji, categoryLabel } from '../../constants/categories';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { PollCard } from '../../components/PollCard';
import { NewPollModal } from '../../components/NewPollModal';
import { EventCard, EVENT_ACCENT } from '../../components/EventCard';
import { CategoryTile } from '../../components/CategoryTile';
import { MarketCardPicture } from '../../components/MarketCardPicture';
import { NewEventModal } from '../../components/NewEventModal';
import { NewPostTypeSheet } from '../../components/NewPostTypeSheet';
import { OwnerWordsPrompt } from '../../components/OwnerWordsPrompt';
import { PageTitle, useTabRetapScrollTop } from '../../components/PageTitle';
import { useQuickReturn, QuickReturnBlock, ActiveFilterChip } from '../../components/QuickReturn';
import { composeTargetFor } from '../../utils/compose-options';
import { EVENT_TYPES_QUERY, type EventWindow } from '../../utils/events';
import { myEventAsPost, type MyEvent } from '../../utils/event-extras';
import { FilterChipRow, FilterChipBar } from '../../components/FilterChipRow';
import { FilterChipButton, FilterChipPanel } from '../../components/FilterChipPicker';
import { CATEGORY_FILTER_CHIPS, categoryChipLabel, categoryPanelReducer } from '../../utils/map-filters';
import {
    MARKET_TYPE_PILLS, marketFilterFromLink, marketSearchFromLink, marketSecondRow, feedPostVisible, marketFiltersActive, marketFilterSummary, marketFeedQuery, distanceChipLabel, trustChipLabel, beansChipLabel,
    type MarketTypeFilter, type MarketFilterState,
    marketSearchQuery, marketAnswerStands, marketSearchMatches, marketSearchToSave, saveSearchParam,
} from '../../utils/market-filters';
import { SaveSearchButton } from '../../components/SaveSearchButton';
import { localDaysAgo } from '../../utils/feed-sections';
import { useNodeProfile } from '../../utils/use-node-profile';
import { useReaderFeatures } from '../../utils/use-reader-features';
import { marketShowsBeans, marketExtras, marketSearchDistanceParams, marketFeedSections } from '../../utils/market-global';
import { readPhoneInterests, saveInterests } from '../../utils/home-store';
import { anchorUrl } from '../../utils/node-post';
import { ExampleListings } from '../../components/ExampleListings';
import { LookAroundCard } from '../../components/LookAroundCard';
import { openLookDoor } from '../../utils/look-door';
import { useLookingAround } from '../../utils/use-looking-around';
import { exampleListingsOn, showExampleListings } from '../../utils/example-listings';
import { MarketCircleLine } from '../../components/MarketCircleLine';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { listingChips, listingChipWords, listingFreeTags, readsOwnData, t, tn, upperCase, word, elsewhereFill, FILL_BELOW, postTagsOf, searchTagsFor, tagIndex, type WordKey } from '@beanpool/core';
import { ELSEWHERE_HEADING, fillWanted as marketFillWanted, readElsewhere, marketServerFilter, normalizeServerPosts } from '../../utils/market-fill';

/** The For You interests' categories. Labels are word() keys (the same as constants/categories.ts), shown through t(). */
export const MARKETPLACE_CATEGORIES: ReadonlyArray<{ id: string; emoji: string; label: WordKey }> = [
    { id: 'all', emoji: '🏷️', label: word('All Categories') },
    { id: 'food', emoji: '🥕', label: word('Food') },
    { id: 'services', emoji: '🤝', label: word('Services') },
    { id: 'labour', emoji: '👷', label: word('Labour') },
    { id: 'tools', emoji: '🛠️', label: word('Tools') },
    { id: 'goods', emoji: '📦', label: word('Goods') },
    { id: 'garden', emoji: '🌻', label: word('Garden') },
    { id: 'housing', emoji: '🏠', label: word('Housing') },
    { id: 'transport', emoji: '🚗', label: word('Transport') },
    { id: 'education', emoji: '📚', label: word('Education') },
    { id: 'arts', emoji: '🎨', label: word('Arts') },
    { id: 'health', emoji: '🌿', label: word('Health') },
    { id: 'care', emoji: '❤️', label: word('Care') },
    { id: 'animals', emoji: '🐾', label: word('Animals') },
    { id: 'tech', emoji: '💻', label: word('Tech') },
    { id: 'energy', emoji: '☀️', label: word('Energy') },
    { id: 'general', emoji: '🌱', label: word('General') },
];

// ⚡ Bolt: O(1) Map lookup for marketplace categories instead of repeated O(C) .find() scans
export const MARKETPLACE_CATEGORIES_BY_ID = new Map(MARKETPLACE_CATEGORIES.map(c => [c.id, c]));

const MIN_FEED_UNDER_PANEL = 48;

/** The headings the list view draws between its rows: word() keys, shown through t() (renderItem). */
const YOUR_EVENTS_HEADING = word('Your events');
const FOR_YOU_HEADING = word('★ For You Feed');

/** A listing's type badge, in the member's language (the listing branch only: polls and events have cards of their own). */
const typeBadge = (type: string): string => (type === 'offer' ? t('OFFER') : t('NEED'));

/** The unit after a listing's price: per hour, day, week or month, or none for a total. */
function priceUnit(priceType: string | null | undefined): string {
    if (priceType === 'hourly') return t('/Hr', undefined, 'price per hour');
    if (priceType === 'daily') return t('/Dy', undefined, 'price per day');
    if (priceType === 'weekly') return t('/Wk', undefined, 'price per week');
    if (priceType === 'monthly') return t('/Mo', undefined, 'price per month');
    return '';
}

/** The compact row's author line: whole sentences per variant, with the Elder mark and the member's own. */
function byLine(name: string, elder: boolean, own: boolean): string {
    if (elder && own) return t('by {name} ⛰️ 👤 (You)', { name });
    if (elder) return t('by {name} ⛰️', { name });
    if (own) return t('by {name} 👤 (You)', { name });
    return t('by {name}', { name });
}

/** How long the Market waits on a first sync (and on its one retry) before it says "Having trouble connecting". */
const FIRST_SYNC_WAIT_MS = 12_000;

export default function MarketScreen() {
    const { theme, colors } = useTheme();
    // At 320dp with large text the field has room for one word; the long placeholder wrapped or was cut.
    const { width: winW, fontScale } = useWindowDimensions();
    const searchPlaceholder = winW / Math.min(fontScale, 1.3) < 360 ? t('Search') : t('Search marketplace...');
    const { identity } = useIdentity();
    // The members-only page's way to the global community: in this app, as a guest first (utils/global-guest-visit.ts).
    const guestVisit = useGlobalGuestVisit();
    const lookingAround = useLookingAround();

    // What kind of community this is (utils/node-profile.ts): the phone's copy first, then the node's own answer.
    // On the worldwide community (Beans off) the Market shows no price and no "Beans only" filter, and orders listings
    // nearest first (utils/market-global.ts). Its "Find your community" card is on Home since H4 (the top of Home, pinned
    // for a member's first 30 days). Local communities are unchanged: a node that says nothing trades in Beans.
    const nodeProfile = useNodeProfile();
    const showsBeans = marketShowsBeans(nodeProfile?.features);
    // Each feature's mode for this reader, `undefined` until the phone's copy of the node's profile is read (a moment, no
    // network): nothing of a feature is read until its mode is known, and a preview reads none of the reader's own.
    const reader = useReaderFeatures();
    const modeOf = (f: 'beans' | 'escrow' | 'decisions') => (reader.known ? showcaseMode(f, reader.node, reader.reader) : undefined);
    // Where the node previews Decisions, a poll says what a local community's Decision does (design §1 row 7).
    const decisionsPreview = modeOf('decisions') === 'preview';
    // Deals are escrow: off where escrow is off, unless the node previews them; then Your deals is the member's own sheet
    // fed Example Valley (design §1 row 3, §4).
    const escrowMode = modeOf('escrow');
    const dealsPreview = escrowMode === 'preview';
    const showsDeals = escrowMode !== 'hidden';
    const beansMode = modeOf('beans');
    // The loads below run from listeners set up once: they read the mode as it is now, not as it was then.
    const escrowModeNow = useRef(escrowMode);
    escrowModeNow.current = escrowMode;
    // The phone's own-data rule (utils/reads-own.ts, core's readsOwnData): not until the mode is known, never in preview.
    const readsOwnDeals = () => readsOwnData(escrowModeNow.current);

    // Contributions-First quest card: shown until the member has listed their
    // first Offer (the gate that unlocks posting Needs / accepting Offers), so
    // the rule reads as a friendly next step here instead of being discovered
    // through a rejection modal mid-trade. Re-checked on every focus, so it
    // disappears the moment their first Offer is posted.
    const [showFirstOfferQuest, setShowFirstOfferQuest] = useState(false);
    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                if (!identity?.publicKey) return;
                // A Beans quest: not asked until Beans' mode is known, and never where they are previewed (getBalance
                // also asks the node for the reader's own balance).
                if (beansMode === undefined) return;
                if (beansMode === 'preview') { setShowFirstOfferQuest(false); return; }
                if (await AsyncStorage.getItem('beanpool_first_offer_quest_dismissed')) return;
                try {
                    const b: any = await getBalance(identity.publicKey);
                    if (!cancelled) setShowFirstOfferQuest(!!b?.isBlockedFromTrading);
                } catch {
                    // Unknown (offline / old node) — don't show the card on a guess.
                }
            })();
            return () => { cancelled = true; };
        }, [identity?.publicKey, beansMode])
    );
    const dismissFirstOfferQuest = () => {
        setShowFirstOfferQuest(false);
        AsyncStorage.setItem('beanpool_first_offer_quest_dismissed', 'true').catch(() => {});
    };
    const [filter, setFilter] = useState<MarketTypeFilter>('all');
    // The "?" names Polls' own guide page while they are what the Market shows (DESIGN-getting-started-fable.md §4).
    useFocusEffect(useCallback(() => {
        setHelpContext(filter === 'polls' ? 'polls' : null);
        return () => setHelpContext(null);
    }, [filter]));
    
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.page },
        listContent: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 100 },

        // Search row
        searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
        searchTarget: { flex: 1, minHeight: 48, justifyContent: 'center' },
        searchWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.card, borderRadius: 20, paddingHorizontal: 14, height: 40, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
        searchInput: { flex: 1, marginLeft: 8, paddingVertical: 0, fontSize: 14, color: colors.text.body, fontWeight: '500', includeFontPadding: false, textAlignVertical: 'center' },
        iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
        dealsIconBtn: {
            // Capped, so Your deals in a longer language never squeezes the search field to nothing: its words shrink instead.
            // Uses minHeight + paddingVertical so it grows at 1.3 font scale without clipping the label (~49 dp), while keeping 38 dp at 1.0.
            paddingHorizontal: 14, minHeight: 38, paddingVertical: 4, borderRadius: 19, maxWidth: 120,
            backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber50,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.amber300,
            justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1
        },
        dealsIconBadge: { position: 'absolute', top: -4, right: -4, backgroundColor: colors.feedback.danger.solid, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 8, minWidth: 14, alignItems: 'center' },

        // Deal badge (positioned on icon button)
        dealBadge: { position: 'absolute', top: -4, right: -4, backgroundColor: colors.feedback.danger.solid, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 8, minWidth: 16, alignItems: 'center' },
        dealBadgeText: { color: colors.text.inverse, fontSize: 9, fontWeight: '900' },

        // Horizontal filter chips
        chipScrollContainer: { flexGrow: 1, justifyContent: 'center', flexDirection: 'row', gap: 4, paddingHorizontal: 16, paddingVertical: 4 },
        foundingChip: {
            alignSelf: 'center', marginTop: 8, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, borderWidth: 1,
            borderColor: theme === 'dark' ? colors.trust.founding.border : 'rgba(34,197,94,0.4)',
            backgroundColor: colors.surface.card
        },
        foundingChipActive: {
            backgroundColor: theme === 'dark' ? colors.trust.founding.bg : palette.green100,
            borderColor: theme === 'dark' ? colors.trust.founding.border : palette.green500
        },
        foundingChipText: { fontSize: 12, fontWeight: '800', color: theme === 'dark' ? colors.trust.founding.fg : palette.green700 },
        foundingChipTextActive: { color: theme === 'dark' ? colors.trust.founding.fg : palette.green800 },
        chip: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 8,
            paddingHorizontal: 10,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.card,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.03,
            shadowRadius: 2,
            elevation: 1,
        },
        chipText: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
        chipTextActive: { color: colors.text.inverse },
        chipTextOnAccent: { color: colors.text.onAccent },
        chipAllActive: {
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.gray800,
            borderColor: theme === 'dark' ? colors.border.strong : palette.gray800
        },
        chipOfferActive: {
            backgroundColor: colors.market.offer.bg,
            borderColor: colors.market.offer.fg
        },
        chipNeedActive: {
            backgroundColor: colors.market.need.bg,
            borderColor: colors.market.need.fg
        },
        chipActive: {
            backgroundColor: colors.accent.fill,
            borderColor: colors.accent.primary
        },
        chipDistanceActive: {
            backgroundColor: colors.feedback.warning.bg,
            borderColor: colors.feedback.warning.border
        },
        chipDivider: { width: 1, height: 24, backgroundColor: colors.border.default, alignSelf: 'center' },

        // Cards
        card: {
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: colors.border.default,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.05,
            shadowRadius: 8,
            elevation: 2,
            overflow: 'hidden'
        },
        elderCard: {
            borderLeftWidth: 3,
            borderLeftColor: colors.trust.star,
            shadowColor: colors.trust.star,
            shadowOpacity: 0.15,
        },
        pulseCard: {
            borderWidth: 2,
            borderColor: palette.amber400,
            backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : '#fffbeb',
            shadowColor: palette.amber500,
            shadowOpacity: 0.25,
            shadowRadius: 10,
        },
        gridRow: { gap: 16 },
        gridCard: { flex: 1, marginBottom: 16 },
        gridImageWrapper: { position: 'relative', width: '100%', aspectRatio: 1 },
        gridImage: { width: '100%', height: '100%' },
        gridFallback: { backgroundColor: colors.surface.subtle, justifyContent: 'center', alignItems: 'center' },
        gridFallbackEmoji: { fontSize: 32, opacity: 0.3 },
        gridBadgeRow: { position: 'absolute', left: 8, right: 8, bottom: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 4 },
        gridBadge: { backgroundColor: colors.overlay.scrim, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: colors.overlay.scrimEdge, maxWidth: '100%' },
        gridPriceEnd: { marginLeft: 'auto' },
        gridPriceText: { color: colors.text.inverse, fontSize: 13, fontWeight: 'bold' },
        gridTypeBadge: { position: 'absolute', top: 8, left: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
        gridTextContent: { padding: 12 },
        gridCardTitle: { fontSize: 14, fontWeight: '700', color: colors.text.body, marginBottom: 4 },
        badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
        badgeOffer: { backgroundColor: colors.market.offer.bg, borderWidth: 0 },
        badgeNeed: { backgroundColor: colors.market.need.bg, borderWidth: 0 },
        badgeText: { fontSize: 11, fontWeight: '800', color: colors.market.offer.fg, letterSpacing: 0.5 },
        price: { fontSize: 16, fontWeight: '800', color: colors.text.body },
        fab: { position: 'absolute', bottom: 32, right: 24, backgroundColor: colors.action.fab, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 28, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 8, zIndex: 100 },
        compactRow: {
            flexDirection: 'row',
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            paddingVertical: 10,
            paddingHorizontal: 12,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: colors.border.default,
            alignItems: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.02,
            shadowRadius: 1,
            elevation: 1,
        },
        elderCompactRow: {
            borderLeftWidth: 3,
            borderLeftColor: colors.trust.star,
        },
        compactEmoji: {
            fontSize: 20,
        },
        compactTitle: {
            fontSize: 14,
            fontWeight: '800',
            color: colors.text.body,
        },
        compactAuthor: {
            fontSize: 11,
            color: colors.text.secondary,
            marginTop: 1,
        },
        compactPrice: {
            fontSize: 14,
            fontWeight: '900',
            color: colors.text.body,
        },
        compactBadge: {
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 8,
        },
        compactBadgeOffer: {
            backgroundColor: colors.market.offer.bg,
        },
        compactBadgeNeed: {
            backgroundColor: colors.market.need.bg,
        },
        compactBadgeText: {
            fontSize: 9,
            fontWeight: '800',
            letterSpacing: 0.5,
        },
        sectionHeader: {
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 4,
            marginBottom: 2,
            paddingHorizontal: 4,
        },
        sectionHeaderText: {
            fontSize: 11,
            fontWeight: '800',
            color: colors.text.muted,
            letterSpacing: 1,
            textTransform: 'uppercase',
        },
        sectionHeaderLine: {
            flex: 1,
            height: 1,
            backgroundColor: colors.border.default,
            marginLeft: 12,
        },
        freshBanner: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.orange50,
            borderRadius: 16,
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.orange100,
            marginHorizontal: 16,
            marginTop: 8,
            marginBottom: 8,
            shadowColor: theme === 'dark' ? '#000' : palette.orange500,
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: theme === 'dark' ? 0.2 : 0.05,
            shadowRadius: 4,
            elevation: 1,
        },
        freshBannerTitle: {
            fontSize: 13,
            fontWeight: '900',
            color: theme === 'dark' ? colors.feedback.warning.fg : palette.orange700,
        },
        freshBannerSub: {
            fontSize: 10,
            fontWeight: '500',
            color: theme === 'dark' ? colors.text.body : palette.orange800,
            opacity: 0.8,
            marginTop: 1,
        },
        liveBadge: {
            backgroundColor: theme === 'dark' ? colors.feedback.warning.border : palette.orange100,
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme === 'dark' ? colors.feedback.warning.fg : palette.orange200,
        },
        liveBadgeText: {
            fontSize: 9,
            fontWeight: '900',
            color: theme === 'dark' ? colors.feedback.warning.fg : colors.market.need.fg,
        },
        favPanel: {
            backgroundColor: colors.accent.tint,
            borderRadius: 16,
            padding: 16,
            borderWidth: 1,
            borderColor: colors.accent.border,
            marginHorizontal: 16,
            marginTop: 8,
            marginBottom: 8,
        },
        favPanelTitle: {
            fontSize: 11,
            fontWeight: '900',
            color: colors.accent.primary,
            letterSpacing: 1,
            marginBottom: 4,
        },
        favPanelSub: {
            fontSize: 11,
            color: colors.text.body, // on accent.tint: text.secondary is 4.22 there in dark
            marginBottom: 10,
        },
        favTagsContainer: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 6,
        },
        favTag: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.default,
            borderRadius: 16,
            paddingVertical: 6,
            paddingHorizontal: 10,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.02,
            shadowRadius: 1,
            elevation: 1,
        },
        favTagActive: {
            backgroundColor: colors.accent.fill,
            borderColor: colors.accent.primary,
        },
        favTagText: {
            fontSize: 11,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        favTagTextActive: {
            color: colors.text.onAccent,
        },
        favSummaryBanner: {
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.accent.tint,
            borderRadius: 16,
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderWidth: 1,
            borderColor: colors.accent.border,
            marginHorizontal: 16,
            marginTop: 4,
            marginBottom: 4,
        },
        favSummaryText: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.accent.primary,
            flex: 1,
        },
        favSummaryEditBadge: {
            // a card-coloured badge with the sage outline: accent.primary is 4.34 on accent.border in light
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.accent.border,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 8,
        },
        favSummaryEditBtn: {
            fontSize: 9,
            fontWeight: '900',
            color: colors.accent.primary,
        },
        filterRow: { marginBottom: 4, borderWidth: 1, borderColor: colors.border.default, borderRadius: 26, overflow: 'hidden' },
        filterGrow: { flexGrow: 1 },
        typePill: { paddingHorizontal: 8 },
    }));

    const [trustFilter, setTrustFilter] = useState<string>('all');
    const [beansOnly, setBeansOnly] = useState(false);  // #108: hide listings that also need cash
    const [showTrustPicker, setShowTrustPicker] = useState(false);
    const [viewMode, setViewMode] = useState<'list' | 'grid' | 'compact'>('list');
    const [favCategories, setFavCategories] = useState<string[]>([]);
    const [isCustomizerExpanded, setIsCustomizerExpanded] = useState(true);

    // "Your events" under ★ For You: the signer's own upcoming RSVPs (decision 1). Its own read, only while
    // that pill is chosen. Empty on anything that goes wrong — a node without the route answers 404, and a
    // community that does not have the feature should show no row rather than an error about it (decision 7).
    const [myEvents, setMyEvents] = useState<MyEvent[]>([]);
    const loadMyEvents = useCallback(async () => {
        if (!identity?.publicKey) return;
        try {
            setMyEvents(await fetchMyEvents());
        } catch (e) {
            setMyEvents([]);
            if (!isRouteMissing(e)) console.warn('[Market] Could not read your events:', e);
        }
    }, [identity?.publicKey]);
    useEffect(() => {
        if (filter !== 'for-you') return;
        loadMyEvents();
    }, [filter, loadMyEvents]);

    // Fresh listings banner dismissal. The banner is the list's first row, so it scrolls away with it.
    const [dismissedFreshCount, setDismissedFreshCount] = useState<number>(0);
    const listRef = useRef<FlatList>(null);

    const [refreshing, setRefreshing] = useState(false);

    const onRefresh = async () => {
        setRefreshing(true);
        try {
            await requestSync();
            await loadPosts();
        } catch (e) {
            console.error('Pull-to-refresh failed:', e);
        } finally {
            setRefreshing(false);
        }
    };

    // The stars are the account's interests too (design §4.3): Home's interests card may have changed them, so they are
    // read again each time the Market comes into view.
    const favLoaded = useRef(false);
    useFocusEffect(useCallback(() => {
        let live = true;
        readPhoneInterests().then(parsed => {
            if (!live) return;
            setFavCategories(prev => (prev.length === parsed.length && prev.every((c, i) => c === parsed[i]) ? prev : parsed));
            if (!favLoaded.current) {
                favLoaded.current = true;
                if (parsed.length > 0) setIsCustomizerExpanded(false);
            }
        });
        return () => { live = false; };
    }, []));

    useEffect(() => {
        // Load dismissed fresh postings count
        AsyncStorage.getItem('bp_dismissed_fresh_count').then(val => {
            if (val) {
                setDismissedFreshCount(parseInt(val, 10));
            }
        }).catch(() => {});
    }, []);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    // A `#tag` tapped: the Market with exactly that typed tag (DESIGN-tags-free-entry-fable.md §4). One filter by tag at a time.
    const [selectedFree, setSelectedFree] = useState<string | null>(null);
    const [blockedUsers, setBlockedUsers] = useState<string[]>([]);
    const [posts, setPosts] = useState<any[]>([]);
    // First-run loading: until posts load or a pillar sync completes THIS session, show a
    // loading state rather than the "no items" empty state (which reads as broken/empty).
    const [firstSyncDone, setFirstSyncDone] = useState(false);
    const [syncTimedOut, setSyncTimedOut] = useState(false);
    // The community refused this phone its listings: its key is no member there, and a local community's listings are
    // its members' (2026-09-28); or it is in a private preview, or this account there was closed (utils/members-only-
    // listings.ts). Read again on each focus and after each sync.
    const [refusal, setRefusal] = useState<Refusal | null>(null);
    useFocusEffect(useCallback(() => {
        let live = true;
        const read = () => { refusalHere().then(v => { if (live) setRefusal(v); }); };
        read();
        const refused = DeviceEventEmitter.addListener('members_only_listings', read);
        const ended = DeviceEventEmitter.addListener(PILLAR_SYNC_ENDED, read);
        return () => { live = false; refused.remove(); ended.remove(); };
    }, []));
    // A member with no area on a community that syncs listings by area (utils/nearby-area.ts): the node gives them the
    // newest listings worldwide, and one line above the feed says so, with the way to Settings → Your area. After each
    // sync, which is when the phone learns the area.
    const [noArea, setNoArea] = useState(false);
    useFocusEffect(useCallback(() => {
        let live = true;
        const read = () => { noAreaLineHere(identity?.publicKey).then(v => { if (live) setNoArea(v); }); };
        read();
        const ended = DeviceEventEmitter.addListener(PILLAR_SYNC_ENDED, read);
        return () => { live = false; ended.remove(); };
    }, [identity?.publicKey]));
    const [searchResults, setSearchResults] = useState<any[] | null>(null);
    // The words that answer was for (marketAnswerStands): null when a tag filter was on, as it asks for the words OR the tag.
    const [searchResultsWords, setSearchResultsWords] = useState<string | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /**
     * The category chip and its panel of tiles — the map's (utils/map-filters.ts), so picking a tile applies
     * it and closes the panel in one step. The panel opens under the filter bar and pushes the list down.
     */
    const [categoryPanel, dispatchCategoryPanel] = useReducer(categoryPanelReducer, { category: 'all', open: false });
    const categoryFilter = categoryPanel.category;
    const closeCategoryPanel = () => dispatchCategoryPanel({ kind: 'dismiss' });
    // Leaving the tab closes it, so coming back to the Market shows the feed, not the panel.
    useFocusEffect(useCallback(() => () => dispatchCategoryPanel({ kind: 'dismiss' }), []));
    const [eventWindow, setEventWindow] = useState<EventWindow>('all');
    const selectType = (t: MarketTypeFilter) => {
        setFilter(t);
        // Polls and Events have no category chip, so an open panel goes with it.
        const row = marketSecondRow(t);
        if (row.kind !== 'filters' || !row.category) closeCategoryPanel();
    };
    /**
     * The open panel pushes the list down. It may grow until MIN_FEED_UNDER_PANEL of the list is left under
     * it — one touch-height strip to tap to close, and a sight of the feed they will return to; past that its
     * tiles scroll inside it.
     */
    const [screenH, setScreenH] = useState(0);
    const [filterBlockY, setFilterBlockY] = useState(0);
    const [filterRowsBottom, setFilterRowsBottom] = useState(0);
    const searchInputRef = useRef<TextInput>(null);
    const [searchFocused, setSearchFocused] = useState(false);
    /**
     * The title and the controls (search, type pills, filter row, group pills) ride away as the feed scrolls
     * down and come back on any scroll up (components/QuickReturn). They stay while in use: the category
     * panel open, or the search field focused (typing narrows the list under the keyboard).
     */
    const qr = useQuickReturn({
        pinned: categoryPanel.open || searchFocused,
        resetKey: viewMode,
    });
    // Tapping Market again scrolls to the top, and brings the controls with it.
    useTabRetapScrollTop(listRef, qr.show);
    // Measured with the title showing: at worst that leaves the panel a title's height shorter than it could be.
    const rowsBottom = qr.titleHeight + filterBlockY + filterRowsBottom;
    const panelMaxHeight = screenH && filterRowsBottom ? Math.max(120, screenH - rowsBottom - 6 - MIN_FEED_UNDER_PANEL) : undefined;
    const [groupFilter, setGroupFilter] = useState('all');
    const [userGroups, setUserGroups] = useState<GroupItem[]>([]);
    // ⚡ Bolt: O(1) Map lookup for user groups by ID instead of O(G) .find() scans
    const userGroupsById = React.useMemo(() => new Map(userGroups.map(g => [g.id, g])), [userGroups]);
    const [radiusKm, setRadiusKm] = useState<number | null>(null);
    const [locationCenter, setLocationCenter] = useState<{lat: number, lng: number} | null>(null);
    const [showRadiusPicker, setShowRadiusPicker] = useState(false);
    
    // Deals Sheet
    const [showDealsSheet, setShowDealsSheet] = useState(false);
    const [dealsInitialTab, setDealsInitialTab] = useState<'active' | 'pending' | 'history'>('pending');
    const [showNewPollModal, setShowNewPollModal] = useState(false);
    const [showNewEventModal, setShowNewEventModal] = useState(false);
    // For the distance on event cards. Read only when location is already allowed; the feed never prompts.
    const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
    const [showNewPostTypePicker, setShowNewPostTypePicker] = useState(false);
    const [myTransactions, setMyTransactions] = useState<any[]>([]);

    // In preview the pill counts none of the reader's own deals, even one read before the switch that lands after it.
    const pendingCount = usePendingDealsCount(dealsPreview ? null : identity, myTransactions);
    // A card's chip on a listing the reader has a deal of their own on (deals S4, DESIGN-deals-fable §3.3): from the deals
    // the phone already holds, and only the reader's own, so a card never tells anyone else who traded.
    const dealChips = React.useMemo(() => (dealsPreview ? new Map() : listingChips(myTransactions, identity?.publicKey || '')), [dealsPreview, myTransactions, identity?.publicKey]);

    useEffect(() => {
        let cancelled = false;
        Location.getForegroundPermissionsAsync()
            .then(async ({ status }) => {
                if (status !== 'granted') return;
                const last = await Location.getLastKnownPositionAsync();
                if (!cancelled && last) setMyLocation({ lat: last.coords.latitude, lng: last.coords.longitude });
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        fetchGroups().then(groups => {
            const active = groups.filter(g => g.viewerStatus === 'active');
            setUserGroups(active);
        }).catch(console.error);
    }, [identity?.publicKey]);

    useEffect(() => {
        getBlockedUsers().then(setBlockedUsers);
        const sub = DeviceEventEmitter.addListener(BLOCKLIST_UPDATED_EVENT, (newList) => {
            setBlockedUsers(newList);
        });
        return () => sub.remove();
    }, []);

    // The feed reads the groups I am in from the cached memberships, which fetchGroups above refreshes: read it
    // again when they change, so it matches the group chips.
    const userGroupsKey = userGroups.map(g => g.id).join(',');
    useFocusEffect(
        React.useCallback(() => {
            loadPosts();
        }, [filter, groupFilter, identity?.publicKey, userGroupsKey, escrowMode])
    );

    const params = useLocalSearchParams<{ tab?: string, dealsTab?: string, filter?: string, q?: string, new?: string, tag?: string, free?: string }>();

    // A tag chip tapped on a post detail page opens the Market filtered by that tag (§4.4)
    useEffect(() => {
        if (params.tag) {
            setSelectedTag(params.tag);
            setSelectedFree(null);
            router.setParams({ tag: '' });
        }
    }, [params.tag]);
    useEffect(() => {
        if (params.free) {
            setSelectedFree(params.free);
            setSelectedTag(null);
            router.setParams({ free: '' });
        }
    }, [params.free]);

    // The Start something sheet opens the Market on its Poll or Event form (DESIGN-commons-ux §3.2).
    useEffect(() => {
        if (params.new === 'poll') {
            setShowNewPollModal(true);
            router.setParams({ new: '' });
        } else if (params.new === 'event') {
            setShowNewEventModal(true);
            router.setParams({ new: '' });
        }
    }, [params.new]);

    // A saved search's "See more" on Home opens the Market with its words in the search (CARD-FRAME §4).
    useEffect(() => {
        const q = marketSearchFromLink(params.q);
        if (q) {
            setSearchQuery(q);
            router.setParams({ q: '' });
        }
    }, [params.q]);

    // Home's "All events ›" opens the Market on its Events pill, and its Decide card's polls line on Polls.
    useEffect(() => {
        const pill = marketFilterFromLink(params.filter);
        if (pill) {
            selectType(pill);
            router.setParams({ filter: '' });
        }
    }, [params.filter]);

    useEffect(() => {
        if (params.tab === 'deals') {
            setShowDealsSheet(true);
            router.setParams({ tab: '' });
        }
        if (params.dealsTab) {
            setDealsInitialTab(params.dealsTab as any);
            setShowDealsSheet(true);
            router.setParams({ dealsTab: '' });
        }
    }, [params.tab, params.dealsTab]);

    useEffect(() => {
        // Data changed on SOME sync path (messages, balance, or marketplace) → refresh the
        // list. This does NOT mean the marketplace itself has finished loading: a fast
        // messages/balance sync fires this too (and does so even with zero messages), so
        // flipping the loading gate here was showing a false "No items found" before the
        // marketplace posts had actually landed.
        const sub = DeviceEventEmitter.addListener('sync_data_updated', () => {
            loadPosts();
        });
        // Only a COMPLETED pillar sync fetches and writes the marketplace posts, so this is
        // the signal that dismisses the spinner. If the market is genuinely empty the list
        // stays empty and now correctly shows "No items found"; if there are posts, the
        // fast-first-paint 'sync_data_updated' above will already have rendered them.
        const doneSub = DeviceEventEmitter.addListener('pillar_sync_done', () => {
            // Load the freshly-synced posts BEFORE flipping the gate, so the empty state can
            // never flash in the window between "sync completed" and "posts rendered". If the
            // market has posts they're in state before firstSyncDone turns true; only a truly
            // empty market then shows "No items found". Only dismiss the spinner if the load
            // actually succeeded — a transient failure (e.g. DB closing mid wipe/restore) keeps
            // the spinner so the 12s fallback retries instead of flashing "No items found".
            loadPosts().then((ok) => {
                if (ok) {
                    setSyncTimedOut(false);
                    setFirstSyncDone(true);
                }
            });
        });
        return () => { sub.remove(); doneSub.remove(); };
    }, [filter, identity?.publicKey]);

    // Arm a retry fallback so a flaky connection never leaves an infinite spinner.
    // We deliberately do NOT dismiss the spinner from a stored last-sync timestamp:
    // after a recovery/restore the local posts table can be empty while that cursor
    // still exists (clearDB drops the table but not the AsyncStorage cursor), which
    // showed a false "No items found". The spinner is dismissed only when posts
    // actually load (list becomes non-empty) or a pillar sync completes this session.
    //
    // "Having trouble connecting" is a verdict, so it waits for one: after 12s it shows only if no
    // sync is queued or running, or once a sync cycle actually ends in failure. A first sync that is
    // still downloading on a slow connection keeps the loader (it used to flash the banner, then
    // the listings arrived a moment later). A real failure — offline, node down, a request timing
    // out — still ends the cycle unsuccessfully and shows the banner.
    //
    // Never on one failed cycle, though. A first sync that failed early (a read that went unsigned because the key
    // couldn't be read yet at a cold start, and was refused; a cold radio's first request) got no second try before the
    // verdict, so the banner showed and Retry worked at once (Android 1.2.66, 18 Oct). Each wait asks for one sync more:
    // the first time a cycle fails before the first success, or the 12s pass with none running and none succeeded. The
    // banner shows only if that one fails too, or its own 12s pass with nothing running and no success.
    const syncWaitElapsedRef = useRef(false);
    const syncWaitRetriedRef = useRef(false);
    const firstSyncDoneRef = useRef(firstSyncDone);
    firstSyncDoneRef.current = firstSyncDone;
    const syncWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const armSyncWait = React.useCallback(() => {
        syncWaitElapsedRef.current = false;
        syncWaitRetriedRef.current = false;
        setSyncTimedOut(false);
        const waitOver = () => {
            syncWaitElapsedRef.current = true;
            if (firstSyncDoneRef.current || isPillarSyncActive()) return;
            if (syncWaitRetriedRef.current) {
                setSyncTimedOut(true);
                return;
            }
            syncWaitRetriedRef.current = true;
            requestSync();
            syncWaitTimerRef.current = setTimeout(waitOver, FIRST_SYNC_WAIT_MS);
        };
        if (syncWaitTimerRef.current) clearTimeout(syncWaitTimerRef.current);
        syncWaitTimerRef.current = setTimeout(waitOver, FIRST_SYNC_WAIT_MS);
    }, []);
    useEffect(() => {
        armSyncWait();
        // The boot sync may have ended before this screen was listening, its pillar_sync_done missed. Landed on this copy:
        // what it wrote is read, as pillar_sync_done would have, and nothing more is asked of the node (the healthy start,
        // which the phone's data pays for). Otherwise one sync of the Market's own, unless one is queued or running already.
        let live = true;
        syncLandedOnThisCopy().then((landed) => {
            if (!live || firstSyncDoneRef.current) return;
            if (!landed) {
                if (!isPillarSyncActive()) requestSync();
                return;
            }
            loadPosts().then((ok) => {
                if (ok && live) {
                    setSyncTimedOut(false);
                    setFirstSyncDone(true);
                }
            });
        });
        const endedSub = DeviceEventEmitter.addListener(PILLAR_SYNC_ENDED, (e?: { success?: boolean }) => {
            if (e?.success || firstSyncDoneRef.current) return;
            if (!syncWaitRetriedRef.current) {
                syncWaitRetriedRef.current = true;
                requestSync();
            } else if (syncWaitElapsedRef.current) {
                setSyncTimedOut(true);
            }
        });
        return () => {
            live = false;
            endedSub.remove();
            if (syncWaitTimerRef.current) clearTimeout(syncWaitTimerRef.current);
        };
    }, [armSyncWait]);

    // Debounced FTS5 server search
    useEffect(() => {
        let active = true;
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        
        const q = searchQuery.trim();
        if (!q && !selectedTag && !selectedFree) {
            setSearchResults(null);
            setIsSearching(false);
            return;
        }
        
        setIsSearching(true);
        searchTimerRef.current = setTimeout(async () => {
            try {
                const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                if (!anchorUrl) {
                    if (active) {
                        setSearchResults(null);
                        setIsSearching(false);
                    }
                    return;
                }
                // Events are opt-in on the list route; All and Events ask for them. The category only while its chip is on screen.
                const { type, cat } = marketServerFilter(filter, categoryFilter);
                
                // Expand synonyms so the server's FTS5 'OR' logic can find them
                const expandedQ = q ? marketSearchQuery(q) : '';
                const qParam = expandedQ ? `q=${encodeURIComponent(expandedQ)}` : '';

                // Resolve typed words through label index and send q AND tags (§4.7)
                const resolvedTags = q ? searchTagsFor(q) : [];
                const searchTagIds = [...new Set([...(selectedTag ? [selectedTag] : []), ...resolvedTags])].slice(0, 20);
                const tagsParam = searchTagIds.length > 0 ? `${qParam ? '&' : ''}tags=${encodeURIComponent(searchTagIds.join(','))}` : '';
                const freeParam = selectedFree ? `${qParam || tagsParam ? '&' : ''}free=${encodeURIComponent(selectedFree)}` : '';
                const queryPrefix = (qParam || tagsParam || freeParam) ? `?${qParam}${tagsParam}${freeParam}` : '?';

                // Nearest first where the node sorts by distance and the phone already knows where it is.
                const near = marketSearchDistanceParams(nodeProfile, myLocation);
                const res = await fetch(`${anchorUrl}/api/marketplace/posts${queryPrefix}${type}${cat}${near}&limit=50`);
                if (active) {
                    if (res.ok) {
                        const data = await res.json();
                        const parsed = normalizeServerPosts(data, anchorUrl);
                        setSearchResults(parsed);
                        setSearchResultsWords(selectedTag || selectedFree || !expandedQ ? null : q);
                    } else {
                        setSearchResults(null); // Fall back to local filtering
                    }
                }
            } catch {
                if (active) setSearchResults(null); // Fall back to local filtering
            } finally {
                if (active) setIsSearching(false);
            }
        }, 300);

        return () => {
            active = false;
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        };
    }, [searchQuery, selectedTag, selectedFree, filter, categoryFilter, nodeProfile, myLocation]);

    const loadPosts = async (): Promise<boolean> => {
        const queryFilter = marketFeedQuery(filter, groupFilter, identity?.publicKey);
        const runLoad = async () => {
            const data = await getPosts(queryFilter);
            setPosts(data);
            // The member's own deals: only where deals are live (or read-only) and known to be; an answer that lands
            // after a switch to preview is dropped.
            if (identity && readsOwnDeals()) {
                const txs = await getMarketplaceTransactions(identity.publicKey);
                if (!readsOwnDeals()) return;
                setMyTransactions(txs);
            } else {
                setMyTransactions([]);
            }
        };
        try {
            await runLoad();
            return true;
        } catch (e: any) {
            if (e?.message?.includes('closed') || String(e).includes('closed')) {
                // Database was closing or re-initializing during a wipe/restore transition.
                // Retry the WHOLE load (posts and transactions) once with a fresh connection —
                // reloading posts alone left myTransactions / the pending-deals badge stale.
                try {
                    await runLoad();
                    return true;
                } catch (retryErr) {
                    console.error('Failed to reload marketplace after DB reconnect', retryErr);
                    return false;
                }
            } else {
                console.error('Failed to query SQLite Posts', e);
                return false;
            }
        }
    };

    const loadBlockedUsers = async () => {
        const list = await getBlockedUsers();
        setBlockedUsers(list);
    };



    // Use server search results when available, otherwise filter locally
    const basePosts = searchResults !== null ? searchResults : posts;

    const filterState: MarketFilterState = {
        type: filter, category: categoryFilter, eventWindow, trust: trustFilter, beansOnly, radiusKm, center: locationCenter, groupId: groupFilter,
    };
    const secondRow = marketSecondRow(filter);
    // "Beans only" is not offered where there are no Beans.
    const rowExtras = secondRow.kind === 'filters' ? marketExtras(secondRow.extras, nodeProfile?.features) : [];
    // The second row's chips fill with the type's colour, as the map's category chip does.
    // Fill for the selected type pill, each carrying white text (docs/brand-colours.md: deep fills, 4.5:1 or more),
    // except For You's sage accent, which carries text.onAccent (charcoal on the light sage in dark).
    const typeColors: Record<MarketTypeFilter, string> = {
        all: theme === 'dark' ? palette.gray600 : palette.gray800,
        'for-you': colors.accent.fill,
        offers: colors.brand.fill,
        needs: colors.action.fab,
        events: EVENT_ACCENT,
        polls: '#7c3aed',
    };
    const filterColor = filter === 'offers' || filter === 'needs' ? typeColors[filter] : colors.brand.fill;
    const filterCtx = { blockedUsers, favCategories };
    // No answer has no words, whatever the last one was for: a failed read leaves the phone's copy, which the words must narrow.
    const answerStands = marketAnswerStands(searchQuery, searchResults !== null ? searchResultsWords : null);

    let filteredPosts = basePosts.filter(p => {
        // Type pills, the category chip, the date chips, Distance, Trust, Beans only, groups (utils/market-filters.ts)
        if (!feedPostVisible(p, filterState, filterCtx)) return false;

        // Goods search isolation: searching marketplace keywords must not return polls unless explicitly filtered
        if (searchQuery.trim() && p.type === 'poll' && filter !== 'polls') return false;

        // The node's answer stands for its words, as on the web. Synonym-aware local search for everything else: the phone's
        // copy, and an answer until the read for these words lands.
        if (searchQuery.trim() && !answerStands && !marketSearchMatches(p, searchQuery)) return false;

        // Tag filter (§4.4 post detail tap)
        if (selectedTag) {
            const pTags = postTagsOf(p.tags);
            if (!pTags.some(t => t === selectedTag || t.startsWith(selectedTag + '.'))) return false;
        }
        if (selectedFree && !listingFreeTags(p).includes(selectedFree)) return false;
        return true;
    });

    // Maintainer rule: Daily Pulse appears ONLY where marketplace has fewer than 2 listings (< 2).
    const realMemberListingsCount = posts.filter(p => {
        const isPulse = (p.author_callsign || p.authorCallsign) === 'Daily Pulse' && !p.origin_node && !p.originNode;
        return !isPulse && p.type !== 'poll' && p.type !== 'event' && p.status === 'active';
    }).length;
    if (realMemberListingsCount >= 2) {
        filteredPosts = filteredPosts.filter(p => !((p.author_callsign || p.authorCallsign) === 'Daily Pulse' && !p.origin_node && !p.originNode));
    }

    // Pin Daily Pulse to the top of the feed (local only)
    filteredPosts.sort((a, b) => {
        const isPulseA = (a.author_callsign || a.authorCallsign) === 'Daily Pulse' && !a.origin_node && !a.originNode;
        const isPulseB = (b.author_callsign || b.authorCallsign) === 'Daily Pulse' && !b.origin_node && !b.originNode;
        if (isPulseA && !isPulseB) return -1;
        if (!isPulseA && isPulseB) return 1;
        return 0;
    });

    // The fill (utils/market-fill.ts, core market-fill): fewer than FILL_BELOW shown near the member, under their filters, and the
    // newest from elsewhere come beneath, read as the search reads the node. The same filters apply to both parts.
    const fillNeeded = marketFillWanted({
        profile: nodeProfile, member: !!identity?.publicKey, ready: firstSyncDone && !refusal, noArea,
        // A tag filter reads as words do, nearest first from anywhere, so there is no elsewhere to fill from.
        searching: searchQuery.trim().length > 0 || !!selectedTag || !!selectedFree, filter, groupFiltered: groupFilter !== 'all', distancePicked: radiusKm != null,
        shownNear: filteredPosts,
    });
    const fillKey = `${filter}|${categoryFilter}`;
    const [elsewhere, setElsewhere] = useState<{ key: string; posts: any[] | null } | null>(null);
    // The fill's latest read: its filters, when it came back (0 until it has, and left 0 if it failed, so the next
    // change of `posts` tries again), and whether it is still out.
    const elsewhereReadRef = useRef<{ key: string; at: number; out: boolean } | null>(null);
    useEffect(() => {
        if (!fillNeeded) return;
        // `posts` is a fresh array on every sync tick the node pushes, so a change of it is not a reason to ask again on
        // its own: a minute per filter (the web's FILL_REREAD_MS), and never while a read for these filters is out. A
        // read already out is not cancelled by the next change either: with ticks quicker than the read, each one threw
        // its answer away and asked again, and a member with nothing near sat on the spinner. While a later read is out
        // the earlier answer stays on screen.
        const last = elsewhereReadRef.current;
        if (last && last.key === fillKey && (last.out || Date.now() - last.at < 60_000)) return;
        const read = { key: fillKey, at: 0, out: true };
        elsewhereReadRef.current = read;
        readElsewhere(filter, categoryFilter).then(rows => {
            read.out = false;
            // Only an answer is stamped: a read that failed (null) is stored, so the spinner ends, but is not a read.
            if (rows) read.at = Date.now();
            // Dropped only if the member has since moved to other filters, whose read has replaced this one.
            if (elsewhereReadRef.current === read) setElsewhere({ key: read.key, posts: rows });
        });
    }, [fillNeeded, fillKey, posts]);
    const elsewhereRead = fillNeeded && elsewhere?.key === fillKey ? elsewhere.posts : null;
    const fillPending = fillNeeded && elsewhere?.key !== fillKey;
    const isOwnPulse = (p: any) => (p.author_callsign || p.authorCallsign) === 'Daily Pulse' && !p.origin_node && !p.originNode;
    const fillRows: any[] = elsewhereRead
        ? elsewhereFill(filteredPosts, elsewhereRead.filter(p => feedPostVisible(p, filterState, filterCtx) && !isOwnPulse(p)))
        : [];

    const selectedTrustFilter = TRUST_FILTERS.find(f => f.id === trustFilter);
    const hasActiveFilters = marketFiltersActive(filterState) || searchQuery.trim().length > 0 || !!selectedTag || !!selectedFree;

    // A few example cards while the Market is nearly empty, where the node asks for them (utils/example-listings.ts):
    // never under a search or a filter, and never in listData, so nothing counts, opens or pins them. Above the
    // empty state's welcome, or after the real listings.
    const showExamples = showExampleListings({
        on: exampleListingsOn(nodeProfile?.features), narrowed: hasActiveFilters, loaded: firstSyncDone, realInView: fillPending ? FILL_BELOW : filteredPosts.length + fillRows.length,
    });

    // Listings posted today, by the local calendar day the TODAY heading uses; events are not listings.
    const freshTodayCount = posts.filter(post => {
        if (post.status !== 'active' || post.type === 'event') return false;
        const postTime = new Date(post.created_at || post.createdAt).getTime();
        return Number.isFinite(postTime) && localDaysAgo(postTime, Date.now()) === 0;
    }).length;

    // Display banner only if fresh postings count is greater than the dismissed count
    const shouldShowFreshBanner = freshTodayCount > 0 && freshTodayCount > dismissedFreshCount;

    const dismissFreshBanner = async () => {
        const { LayoutAnimation } = require('react-native');
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setDismissedFreshCount(freshTodayCount);
        try {
            await AsyncStorage.setItem('bp_dismissed_fresh_count', String(freshTodayCount));
        } catch (e) {}
    };

    // The block that rides over the top of the feed (components/QuickReturn): search row, type pills, filter row
    // and group pills. Everything else above the listings is the list's own header and scrolls with it.
    const controls = (
        <View style={{ paddingBottom: 2 }}>
            {/* Top row: Search + Your deals + View Toggle. The field is 40dp to look at, inside a 48dp target
                that focuses it; its text is capped at 1.3x so the placeholder is never cut top and bottom. */}
            <View style={[styles.searchRow, { paddingHorizontal: 16 }]}>
                <Pressable
                    style={styles.searchTarget}
                    onPress={() => searchInputRef.current?.focus()}
                    accessible={false}
                >
                <View style={styles.searchWrap}>
                    <Text style={{ opacity: 0.4, fontSize: 14 }} maxFontSizeMultiplier={1.3}>🔍</Text>
                    <TextInput
                        ref={searchInputRef}
                        style={styles.searchInput}
                        placeholder={searchPlaceholder}
                        placeholderTextColor={colors.text.muted}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        numberOfLines={1}
                        onFocus={() => setSearchFocused(true)}
                        onBlur={() => setSearchFocused(false)}
                        returnKeyType="search"
                        maxFontSizeMultiplier={1.3}
                        accessibilityLabel={t('Search marketplace')}
                    />
                </View>
                </Pressable>
                {showsDeals && <Pressable
                    onPress={() => setShowDealsSheet(true)}
                    style={styles.dealsIconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={pendingCount > 0 ? tn(pendingCount, 'Your deals, {n} pending', 'Your deals, {n} pending') : t('Your deals')}
                    accessibilityHint={t('Opens your active and pending deals sheet')}
                    hitSlop={{ top: 3, bottom: 3, left: 3, right: 3 }}
                    testID="market-deals-pill"
                >
                    <Text style={{ fontSize: 18, marginBottom: -2 }}>🤝</Text>
                    {/* Capped (dealsIconBtn maxWidth): a longer name in another language shrinks to fit, never squeezing the search. */}
                    <Text style={{ fontSize: 11, fontWeight: '800', color: colors.feedback.warning.fg }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{t('Your deals')}</Text>
                    {pendingCount > 0 && (
                        <View style={styles.dealsIconBadge}>
                            <Text style={{ color: colors.text.inverse, fontSize: 8, fontWeight: '900' }}>{pendingCount}</Text>
                        </View>
                    )}
                </Pressable>}
                <Pressable
                    onPress={() => setViewMode(v => v === 'list' ? 'grid' : (v === 'grid' ? 'compact' : 'list'))}
                    style={styles.iconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={viewMode === 'list' ? t('Grid view') : (viewMode === 'grid' ? t('Compact view') : t('List view'))}
                    hitSlop={{ top: 3, bottom: 3, left: 3, right: 3 }}
                    testID="market-view-mode-toggle"
                >
                    <MaterialCommunityIcons
                        name={viewMode === 'list' ? 'view-grid-outline' : (viewMode === 'grid' ? 'view-headline' : 'view-list-outline')} 
                        size={20} 
                        color={colors.text.secondary}
                    />
                </Pressable>
            </View>
            {(selectedTag || selectedFree) && (() => {
                const label = selectedFree ?? tagIndex().label(selectedTag ?? '');
                if (!label) return null;
                return (
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 4, paddingBottom: 2 }}>
                        <View style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            backgroundColor: colors.accent.tint,
                            borderColor: colors.accent.border,
                            borderWidth: 1,
                            borderRadius: 16,
                            paddingVertical: 3,
                            paddingLeft: 10,
                            paddingRight: 6,
                            minHeight: 28,
                        }}>
                            <Text style={{ fontSize: 13, color: colors.text.body, fontWeight: '500', marginRight: 4 }} maxFontSizeMultiplier={1.3}>
                                #{label}
                            </Text>
                            <Pressable
                                onPress={() => { setSelectedTag(null); setSelectedFree(null); }}
                                hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                                accessibilityRole="button"
                                accessibilityLabel={t('Clear tag filter')}
                                style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' }}
                            >
                                <Text style={{ fontSize: 12, color: colors.text.body, fontWeight: '700' }}>✕</Text>
                            </Pressable>
                        </View>
                    </View>
                );
            })()}

            {/* The map's filter shape (utils/market-filters.ts): the type row, and under it one row that stays in
                the same place and changes with the type — the category chip and the feed's own filters, or the
                event date chips under Events. The category panel opens under it, full width. */}
            <View style={{ paddingHorizontal: 16, marginTop: 0 }} onLayout={e => setFilterBlockY(e.nativeEvent.layout.y)}>
                <View onLayout={e => setFilterRowsBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
                <FilterChipRow
                    chips={MARKET_TYPE_PILLS}
                    selected={filter}
                    onSelect={selectType}
                    activeColor={typeColors[filter]}
                    activeTextColor={filter === 'for-you' ? colors.text.onAccent : undefined}
                    fill
                    // One line that scrolls sideways at 320dp + 1.3x text (wrapping cost a second 38dp line).
                    moreHint
                    // 8dp sides, not 12: the six pills fit one line on a normal phone (~338dp of 379).
                    chipStyle={styles.typePill}
                    style={styles.filterRow}
                    accessibilityLabel={t('Show', undefined, 'the row of the kinds of post the Market shows')}
                />

                {secondRow.kind === 'eventWindows' ? (
                    <FilterChipRow
                        key="eventWindows"
                        chips={secondRow.chips}
                        selected={eventWindow}
                        onSelect={setEventWindow}
                        activeColor={EVENT_ACCENT}
                        fill
                        moreHint
                        style={styles.filterRow}
                        accessibilityLabel={t('Filter events by date')}
                    />
                ) : (
                    <FilterChipBar key="filters" fill moreHint style={styles.filterRow} accessibilityLabel={t('Filters')}>
                        {secondRow.category && (
                            <FilterChipButton
                                variant="flat"
                                label={categoryChipLabel(categoryFilter, categoryPanel.open)}
                                active={categoryFilter !== 'all'}
                                activeColor={filterColor}
                                expanded={categoryPanel.open}
                                onPress={() => dispatchCategoryPanel({ kind: 'toggle' })}
                                accessibilityLabel={t('Filter by category')}
                                style={styles.filterGrow}
                            />
                        )}
                        {rowExtras.includes('distance') && (
                            <FilterChipButton
                                variant="flat"
                                label={distanceChipLabel(radiusKm)}
                                active={radiusKm !== null}
                                activeColor={filterColor}
                                onPress={() => { closeCategoryPanel(); setShowRadiusPicker(true); }}
                                accessibilityLabel={t('Filter by distance')}
                                style={styles.filterGrow}
                            />
                        )}
                        {rowExtras.includes('trust') && (
                            <FilterChipButton
                                variant="flat"
                                label={trustChipLabel(selectedTrustFilter)}
                                active={trustFilter !== 'all'}
                                activeColor={filterColor}
                                onPress={() => { closeCategoryPanel(); setShowTrustPicker(true); }}
                                accessibilityLabel={t('Filter by trust level')}
                                style={styles.filterGrow}
                            />
                        )}
                        {/* #108 Beans-only filter — a toggle, not a picker, so it needs no sheet. */}
                        {rowExtras.includes('beans') && (
                            <FilterChipButton
                                variant="flat"
                                label={beansChipLabel(beansOnly)}
                                active={beansOnly}
                                selected={beansOnly}
                                activeColor={filterColor}
                                onPress={() => { closeCategoryPanel(); setBeansOnly(!beansOnly); }}
                                accessibilityLabel={t('Show only listings that need no cash')}
                                style={styles.filterGrow}
                            />
                        )}
                    </FilterChipBar>
                )}
                </View>

                {/* Row 4: Group Filter Chips (Item 10) */}
                {userGroups.length > 0 && (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ gap: 8, paddingVertical: 6 }}
                    >
                        <Pressable
                            onPress={() => setGroupFilter('all')}
                            style={[styles.chip, groupFilter === 'all' && styles.chipActive]}
                            accessibilityRole="button"
                            accessibilityState={{ selected: groupFilter === 'all' }}
                            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                        >
                            <Text style={[styles.chipText, groupFilter === 'all' && styles.chipTextOnAccent]}>
                                {t('👥 All Groups & Public')}
                            </Text>
                        </Pressable>
                        {userGroups.map((g) => {
                            const isSelected = groupFilter === g.id;
                            return (
                                <Pressable
                                    key={g.id}
                                    onPress={() => setGroupFilter(isSelected ? 'all' : g.id)}
                                    style={[
                                        styles.chip,
                                        isSelected && { backgroundColor: colors.brand.fill, borderColor: colors.brand.primary }
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: isSelected }}
                                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                >
                                    <Text style={[styles.chipText, isSelected && styles.chipTextActive]}>
                                        👥 {g.name}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                )}
            </View>

        </View>
    );

    // The category tiles open over the feed from under the filter row, covering the group pills, so opening
    // them never moves the list.
    const categoryPanelOverlay = (
        <View style={{ position: 'absolute', left: 0, right: 0, top: rowsBottom, paddingHorizontal: 16 }}>
            {categoryPanel.open && secondRow.kind === 'filters' && secondRow.category && (
                <FilterChipPanel
                    chips={CATEGORY_FILTER_CHIPS}
                    selected={categoryFilter}
                    onSelect={(id) => dispatchCategoryPanel({ kind: 'pick', category: id })}
                    activeColor={filterColor}
                    panelMaxHeight={panelMaxHeight}
                    // The map's 8dp gutter, not the feed's 16: four tiles a row at 320dp + 1.3x, not three.
                    style={{ marginHorizontal: -8 }}
                />
            )}
        </View>
    );

    const filterSummary = marketFilterSummary(filterState, searchQuery, {
        trustLabel: id => {
            const trust = TRUST_FILTERS.find(f => f.id === id);
            return trust ? t(trust.label) : undefined;
        },
        groupName: id => userGroupsById.get(id)?.name,
    });
    // "Save this search to Home" (Marty, 7 Oct): a member's search, Offers and Needs only, handed to Home, which opens the
    // saved search's own sheet with it (or says why it can't: the same search there, five there, Home full).
    const toSave = identity && !refusal ? marketSearchToSave(filterState, searchQuery.trim() ? searchQuery : selectedFree ?? '', selectedTag || undefined) : null;
    const clearAllFilters = () => {
        setSearchQuery('');
        setSelectedTag(null);
        setSelectedFree(null);
        setFilter('all');
        dispatchCategoryPanel({ kind: 'pick', category: 'all' });
        setEventWindow('all');
        setRadiusKm(null);
        setLocationCenter(null);
        setTrustFilter('all');
        setBeansOnly(false);
        setGroupFilter('all');
    };
    const showControls = () => {
        qr.show();
        // A search is what the member most likely came back to change.
        if (searchQuery.trim()) searchInputRef.current?.focus();
    };

    // Out of the list's 16dp gutter: these rows bring their own 16dp margins, as they did above the list.
    const ListHeader = (
        <View style={{ marginHorizontal: -16 }}>
            {/* Looking around with no account (slice S12, utils/look-around.ts): nothing is kept until Join. */}
            {lookingAround && (
                <View style={{ marginHorizontal: 16 }}>
                    <LookAroundCard colors={colors} />
                </View>
            )}
            {toSave && (
                <View style={{ marginHorizontal: 16, marginBottom: 8 }}>
                    <SaveSearchButton
                        q={toSave.q}
                        colors={colors}
                        onPress={() => router.navigate({ pathname: '/(tabs)', params: { saveSearch: saveSearchParam(toSave) } })}
                    />
                </View>
            )}
            {noArea && (
                <View style={{ marginHorizontal: 16, marginBottom: 8 }}>
                    <NoAreaLine colors={colors} onPress={() => router.push('/your-area' as any)} />
                </View>
            )}
            {/* The worldwide community's way out to a local one (design §3.1) is a Home card since H4, and "Your account
                has one way back" lives on Home, the landing screen, since H2: neither is drawn here. */}
            {/* "Unlock trading" is a Beans rule; there is none where Beans are off. */}
            {showFirstOfferQuest && showsBeans && !categoryPanel.open && (
                <View style={{ marginHorizontal: 16, marginBottom: 8, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(245, 158, 11, 0.4)', backgroundColor: 'rgba(245, 158, 11, 0.10)', padding: 14 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                        <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text.heading, flex: 1 }}>
                            {identity?.callsign ? t('🫘 Welcome, {name}! One step to unlock trading', { name: identity.callsign }) : t('🫘 Welcome! One step to unlock trading')}
                        </Text>
                        <Pressable onPress={dismissFirstOfferQuest} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('Dismiss')}>
                            <Text style={{ fontSize: 15, color: colors.text.secondary, fontWeight: '700', paddingLeft: 8 }}>✕</Text>
                        </Pressable>
                    </View>
                    <Text style={{ fontSize: 13.5, color: colors.text.body, lineHeight: 19, marginTop: 4 }}>
                        {t('List one Offer — anything you can give: a skill, produce, tools, a lift. That unlocks accepting Offers and posting Needs.')}
                    </Text>
                    <Pressable
                        style={{ marginTop: 10, backgroundColor: colors.feedback.warning.solid, borderRadius: 10, paddingVertical: 10, alignItems: 'center' }}
                        onPress={() => router.push({ pathname: '/new-listing', params: { newPost: 'true' } })}
                        accessibilityRole="button"
                    >
                        <Text style={{ color: colors.text.onGold, fontSize: 14, fontWeight: '800' }}>{t('➕ Post your first Offer')}</Text>
                    </Pressable>
                </View>
            )}
            {/* Interests Tag Cloud when in For You mode */}
            {filter === 'for-you' && !categoryPanel.open && (
                isCustomizerExpanded ? (
                    <View style={styles.favPanel}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <Text style={styles.favPanelTitle}>{t('★ CUSTOMIZE INTERESTS')}</Text>
                            <Pressable
                                onPress={() => setIsCustomizerExpanded(false)}
                                style={{ backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.accent.border, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}
                                accessibilityRole="button"
                            >
                                <Text style={{ fontSize: 10, fontWeight: '800', color: colors.accent.primary }}>{t('✕ HIDE')}</Text>
                            </Pressable>
                        </View>
                        <Text style={styles.favPanelSub}>{t('Select categories to prioritize in your feed:')}</Text>
                        <View style={styles.favTagsContainer}>
                            {MARKETPLACE_CATEGORIES.filter(c => c.id !== 'all').map(cat => {
                                const isFav = favCategories.includes(cat.id);
                                return (
                                    <Pressable
                                        key={cat.id}
                                        onPress={async () => {
                                            const updated = isFav
                                                ? favCategories.filter(c => c !== cat.id)
                                                : [...favCategories, cat.id];
                                            setFavCategories(updated);
                                            // The phone's copy at once (For You works offline), then the account's, which
                                            // Home reads too (utils/home-store.ts, design §4.3).
                                            void saveInterests(await anchorUrl().catch(() => null), identity, updated);
                                        }}
                                        style={[styles.favTag, isFav && styles.favTagActive]}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: isFav }}
                                    >
                                        <Text style={[styles.favTagText, isFav && styles.favTagTextActive]}>
                                            {isFav ? t('{emoji} {label} ★', { emoji: cat.emoji, label: t(cat.label) }) : t('{emoji} {label}', { emoji: cat.emoji, label: t(cat.label) })}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>
                ) : (
                    <Pressable
                        onPress={() => setIsCustomizerExpanded(true)}
                        style={styles.favSummaryBanner}
                        accessibilityRole="button"
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                                <Text style={{ fontSize: 13, color: colors.accent.primary, fontWeight: 'bold' }}>★</Text>
                                <Text style={styles.favSummaryText} numberOfLines={1}>
                                    {favCategories.length > 0
                                        ? t('Prioritizing: {emojis}', { emojis: favCategories.map(id => MARKETPLACE_CATEGORIES_BY_ID.get(id)?.emoji || '').join(' ') })
                                        : t('Prioritizing: None selected yet')}
                                </Text>
                            </View>
                            <View style={styles.favSummaryEditBadge}>
                                <Text style={styles.favSummaryEditBtn}>{t('⚙️ CUSTOMIZE')}</Text>
                            </View>
                        </View>
                    </Pressable>
                )
            )}

            {/* Owners only, on its own cadence, always dismissible: "Check your 12 words" (sealed-keys.md §7). */}
            {!categoryPanel.open && <OwnerWordsPrompt />}
            {/* Freshness Social Proof Banner */}
            {shouldShowFreshBanner && !categoryPanel.open && (
                <Pressable
                    onPress={dismissFreshBanner}
                    style={({ pressed }) => [
                        styles.freshBanner,
                        pressed && { opacity: 0.7, transform: [{ scale: 0.98 }] }
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={tn(freshTodayCount, '{n} fresh listing posted today', '{n} fresh listings posted today')}
                    accessibilityHint={t('Dismisses this banner')}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 }}>
                        <Text style={{ fontSize: 20 }}>🔥</Text>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.freshBannerTitle}>
                                {tn(freshTodayCount, '{n} fresh listing posted today!', '{n} fresh listings posted today!')}
                            </Text>
                            <Text style={styles.freshBannerSub}>
                                {t('Tap to dismiss • Scroll down to explore')}
                            </Text>
                        </View>
                    </View>
                    <View style={styles.liveBadge}>
                        <Text style={styles.liveBadgeText}>{t('LIVE')}</Text>
                    </View>
                </Pressable>
            )}
        </View>
    );

    let listData: any[] = [];
    if (viewMode === 'grid') {
        listData = filteredPosts;
    } else {
        if (filter === 'for-you') {
            // What you said you would be at, above what you might like: it is the one part of For You you
            // have already committed to (decision 1). It stays even when nothing starred matched today.
            if (myEvents.length > 0) {
                listData.push({ isHeader: true, title: YOUR_EVENTS_HEADING, id: 'header-your-events' });
                listData.push(...myEvents.map(myEventAsPost));
            }
            if (filteredPosts.length > 0) {
                listData.push({ isHeader: true, title: FOR_YOU_HEADING, id: 'header-for-you' });
                listData.push(...filteredPosts);
            }
        } else {
            // Events under their own heading, soonest first; listings by the local day they were posted.
            // By the day posted, or nearest first where the node sorts by distance (utils/market-global.ts).
            for (const section of marketFeedSections(filteredPosts, nodeProfile, myLocation)) {
                listData.push({ isHeader: true, title: section.title, id: section.id });
                listData.push(...section.posts);
            }
        }
    }

    const renderItem = ({ item }: { item: any }) => {
        if (item.isHeader) {
            const heading: { title: WordKey } = item;
            return (
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>{upperCase(t(heading.title))}</Text>
                    <View style={styles.sectionHeaderLine} />
                </View>
            );
        }

        if (item.type === 'event') {
            return (
                <EventCard
                    post={item}
                    currentPubkey={identity?.publicKey}
                    myLocation={myLocation}
                    onRsvpChanged={() => { loadPosts(); if (filter === 'for-you') loadMyEvents(); }}
                />
            );
        }

        if (item.type === 'poll') {
            return (
                <PollCard
                    post={item}
                    currentPubkey={identity?.publicKey}
                    onVoteSuccess={() => loadPosts()}
                    informal={pollsInformal(nodeProfile)}
                    decisionsPreview={decisionsPreview}
                />
            );
        }

        // Its own first photo, else its enterprise's shop banner, else the CategoryTile (utils/market-card-picture.ts).
        const { cover: coverImage, picture } = marketCardPicture(item);

        const cardAuthor = item.author_callsign || item.author_pubkey?.slice(0, 6) || t('Unknown');
        const isPulse = (item.author_callsign || item.authorCallsign) === 'Daily Pulse';
        // Elder is a tier, and a tier is Beans: no Elder look where the community shows none (as the tier chip below).
        const elderCard = !isPulse && showsBeans && isElder(item.author_energy_cycled);
        const isOwn = !isPulse && !!(identity?.publicKey && item.author_pubkey === identity.publicKey);
        const dealChip = isPulse ? undefined : dealChips.get(item.id);
        const isGroupScope = item.audience_scope === 'group' || item.audienceScope === 'group' || !!item.target_group_id || !!item.targetGroupId;
        const groupName = item.target_group_name || item.targetGroupName || t('Group');
        const groupScopeBadgeText = isGroupScope ? t('🔒 Only {group} can see this', { group: groupName }) : null;

        const priceLabel = priceUnit(item.price_type);

        const catEmoji = categoryEmoji(item.category);
        const catLabel = categoryLabel(item.category);

        if (viewMode === 'grid') {
            return (
                <Pressable
                    style={[
                        styles.card,
                        styles.gridCard,
                        elderCard && styles.elderCard,
                        isPulse && styles.pulseCard,
                    ]}
                    disabled={isPulse}
                    onPress={isPulse ? undefined : () => router.push(`/post/${item.id}`)}
                    accessibilityRole={isPulse ? undefined : "button"}
                >
                    <View style={styles.gridImageWrapper}>
                        <MarketCardPicture
                            postId={item.id}
                            cover={coverImage}
                            picture={picture}
                            category={item.category}
                            kind={isPulse ? 'pulse' : (item.type === 'event' ? 'event' : 'listing')}
                            size="grid"
                            accessibilityLabel={item.title}
                            imageStyle={styles.gridImage}
                        />
                        {/* One row along the photo's foot, the badges at its start and the price at its end. It wraps,
                            growing upwards: RECURRING and YOU in a longer language (or at 320dp and 1.3x) stack instead
                            of overlapping each other or the price, as fixed offsets did. */}
                        <View style={styles.gridBadgeRow} testID="grid-badge-row">
                        {isPulse && (
                            <View style={[
                                styles.gridBadge,
                                {
                                    backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : '#fef3c7',
                                    borderColor: theme === 'dark' ? colors.feedback.warning.border : '#f59e0b',
                                    borderWidth: 1,
                                }
                            ]}>
                                <Text style={[styles.gridPriceText, { color: colors.feedback.warning.fg, fontWeight: '900' }]}>{t('🗞️ PULSE')}</Text>
                            </View>
                        )}
                        {!isPulse && (() => {
                            if (item.status === 'pending') {
                                return (
                                    <View style={[styles.gridBadge, { backgroundColor: colors.feedback.warning.solid, borderColor: colors.feedback.warning.solid }]}>
                                        <Text style={[styles.gridPriceText, { color: colors.text.onGold, fontWeight: '900' }]}>{t('⏳ PENDING')}</Text>
                                    </View>
                                );
                            }
                            if (isOwn) {
                                return (
                                    <View style={[styles.gridBadge, { backgroundColor: '#2563eb' }]}>
                                        <Text style={styles.gridPriceText}>{t('👤 YOU')}</Text>
                                    </View>
                                );
                            }
                            if (item.repeatable) {
                                return (
                                    <View style={styles.gridBadge}>
                                        <Text style={styles.gridPriceText}>{t('↻ RECURRING')}</Text>
                                    </View>
                                );
                            }
                            return null;
                        })()}
                        {dealChip && (
                            <View testID="card-deal-chip" style={[styles.gridBadge, dealChip === 'in-trust'
                                ? { backgroundColor: colors.feedback.success.solid, borderColor: colors.feedback.success.solid }
                                : { backgroundColor: colors.feedback.warning.solid, borderColor: colors.feedback.warning.solid }]}>
                                <Text style={[styles.gridPriceText, { color: dealChip === 'in-trust' ? colors.text.onBrand : colors.text.onGold, fontWeight: '900' }]}>{listingChipWords(dealChip)}</Text>
                            </View>
                        )}
                        {!isPulse && showsBeans && (
                            <View style={[styles.gridBadge, styles.gridPriceEnd]}>
                                <CurrencyDisplay
                                    amount={`${item.credits !== undefined && item.credits !== null ? item.credits : '?'}${priceLabel || ''}`}
                                    style={styles.gridPriceText}
                                    asView={true}
                                />
                            </View>
                        )}
                        </View>
                        {!isPulse && (
                            <View style={[styles.gridTypeBadge, item.type === 'offer' ? styles.badgeOffer : styles.badgeNeed]}>
                                <Text style={[styles.badgeText, { color: item.type === 'offer' ? colors.market.offer.fg : colors.market.need.fg }]}>{typeBadge(item.type)}</Text>
                            </View>
                        )}
                    </View>
                    <View style={styles.gridTextContent}>
                        <Text style={styles.gridCardTitle} numberOfLines={2}>
                            {item.cash_also_needed === 1 ? '💸 ' : ''}{item.title}
                        </Text>
                        <PostAuthorTrust pubkey={item.author_pubkey} callsign={cardAuthor} energyCycled={item.author_energy_cycled} avatarUrl={item.author_avatar} mode="compact" isFounding={showsBeans && item.authorFoundingNeeded} showTier={showsBeans} />
                        {groupScopeBadgeText && (
                            <View style={{ marginTop: 4, alignSelf: 'flex-start', backgroundColor: colors.brand.tint, borderColor: colors.brand.primary, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                                <Text style={{ fontSize: 9, fontWeight: '800', color: colors.brand.primary }} numberOfLines={1}>
                                    {groupScopeBadgeText}
                                </Text>
                            </View>
                        )}
                    </View>
                </Pressable>
            );
        }

        // Compact View
        if (viewMode === 'compact') {
            return (
                <Pressable
                    disabled={isPulse}
                    accessibilityRole={isPulse ? undefined : "button"}
                    onPress={isPulse ? undefined : () => router.push(`/post/${item.id}`)}
                >
                    <View style={[styles.compactRow, elderCard && styles.elderCompactRow, isPulse && styles.pulseCard]}>
                        <View style={{ width: 32, height: 32, borderRadius: 8, overflow: 'hidden', marginRight: 10 }}>
                            <MarketCardPicture
                                postId={item.id}
                                cover={coverImage}
                                picture={picture}
                                category={item.category}
                                kind={isPulse ? 'pulse' : (item.type === 'event' ? 'event' : 'listing')}
                                size="thumb"
                                imageStyle={{ width: '100%', height: '100%' }}
                            />
                        </View>
                        <View style={{ flex: 1, marginRight: 8, justifyContent: 'center' }}>
                            <Text style={styles.compactTitle} numberOfLines={1}>
                                {item.cash_also_needed === 1 ? '💸 ' : ''}{item.title}
                            </Text>
                            <Text style={styles.compactAuthor} numberOfLines={1}>
                                {byLine(cardAuthor, elderCard, isOwn)}
                            </Text>
                            {groupScopeBadgeText && (
                                <View style={{ marginTop: 2, alignSelf: 'flex-start', backgroundColor: colors.brand.tint, borderColor: colors.brand.primary, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                                    <Text style={{ fontSize: 9, fontWeight: '800', color: colors.brand.primary }} numberOfLines={1}>
                                        {groupScopeBadgeText}
                                    </Text>
                                </View>
                            )}
                        </View>
                        <View style={{ alignItems: 'flex-end', justifyContent: 'center', gap: 4 }}>
                            {!isPulse && showsBeans && (
                                <CurrencyDisplay
                                    amount={`${item.credits !== undefined && item.credits !== null ? item.credits : '?'}${priceLabel || ''}`}
                                    style={styles.compactPrice}
                                    asView={true}
                                />
                            )}
                            <View style={[
                                styles.compactBadge, 
                                isPulse ? {
                                    backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : '#fef3c7',
                                    borderColor: theme === 'dark' ? colors.feedback.warning.border : '#f59e0b',
                                    borderWidth: 1,
                                } : (item.type === 'offer' ? styles.compactBadgeOffer : styles.compactBadgeNeed)
                            ]}>
                                <Text style={[
                                    styles.compactBadgeText, 
                                    {
                                        color: isPulse ? colors.feedback.warning.fg : (item.type === 'offer' ? colors.market.offer.fg : colors.market.need.fg),
                                        fontWeight: '800',
                                    }
                                ]}>
                                    {isPulse ? t('PULSE') : typeBadge(item.type)}
                                </Text>
                            </View>
                        </View>
                    </View>
                </Pressable>
            );
        }

        // List View
        return (
            <Pressable
                disabled={isPulse}
                accessibilityRole={isPulse ? undefined : "button"}
                onPress={isPulse ? undefined : () => router.push(`/post/${item.id}`)}
            >
                <View style={[styles.card, { flexDirection: 'row', padding: 0 }, elderCard && styles.elderCard, isPulse && styles.pulseCard]}>
                    {/* The slot is 80 dp wide and as tall as the text beside it (at least 80): stretched by the row. Never a
                        percentage height, which Yoga reads against the whole list and made a lone card fill the screen. */}
                    <MarketCardPicture
                        postId={item.id}
                        cover={coverImage}
                        picture={picture}
                        category={item.category}
                        kind={isPulse ? 'pulse' : (item.type === 'event' ? 'event' : 'listing')}
                        size="thumb"
                        imageStyle={{ width: 80, minHeight: 80, alignSelf: 'stretch', borderTopLeftRadius: 14, borderBottomLeftRadius: 14 }}
                        tileBox={{ width: 80, minHeight: 80, alignSelf: 'stretch', borderTopLeftRadius: 14, borderBottomLeftRadius: 14, overflow: 'hidden' }}
                    />
                    <View style={{ flex: 1, padding: 12, justifyContent: 'center' }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                                {!isPulse && (
                                    <View style={[styles.badge, item.type === 'offer' ? styles.badgeOffer : styles.badgeNeed, { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, margin: 0 }]}>
                                        <Text style={[styles.badgeText, { fontSize: 10, color: item.type === 'offer' ? colors.market.offer.fg : colors.market.need.fg }]}>{typeBadge(item.type)}</Text>
                                    </View>
                                )}
                                {isPulse && (
                                    <View style={{
                                        backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : '#fef3c7',
                                        paddingHorizontal: 6,
                                        paddingVertical: 2,
                                        borderRadius: 8,
                                        borderWidth: 1,
                                        borderColor: theme === 'dark' ? colors.feedback.warning.border : '#f59e0b'
                                    }}>
                                        <Text style={{
                                            fontSize: 10,
                                            fontWeight: '800',
                                            color: colors.feedback.warning.fg
                                        }}>{t('🗞️ DAILY PULSE')}</Text>
                                    </View>
                                )}
                                {isOwn && (
                                    <View style={{ backgroundColor: '#dbeafe', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 }}>
                                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#1e40af' }}>{t('👤 YOU')}</Text>
                                    </View>
                                )}
                                {dealChip && (
                                    <View testID="card-deal-chip" style={{ backgroundColor: dealChip === 'in-trust' ? colors.feedback.success.bg : colors.feedback.warning.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: dealChip === 'in-trust' ? colors.feedback.success.border : colors.feedback.warning.border }}>
                                        <Text style={{ fontSize: 10, fontWeight: '700', color: dealChip === 'in-trust' ? colors.feedback.success.fg : colors.feedback.warning.fg }}>{listingChipWords(dealChip)}</Text>
                                    </View>
                                )}
                                <Text style={{ fontSize: 11, fontWeight: '700', color: colors.text.secondary }}>
                                    {catEmoji} {catLabel}
                                </Text>
                                {!!item.repeatable && (
                                    <View style={{ backgroundColor: colors.surface.subtle, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.text.secondary }}>{t('↻ RECURRING')}</Text>
                                    </View>
                                )}
                                {/* #108: on the card, not just the detail view */}
                                {item.cash_also_needed === 1 && (
                                    <View style={{ backgroundColor: colors.feedback.warning.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: colors.feedback.warning.border }}>
                                        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.feedback.warning.fg }}>{t('💸 CASH TOO')}</Text>
                                    </View>
                                )}
                                {groupScopeBadgeText && (
                                    <View style={{ backgroundColor: colors.brand.tint, borderColor: colors.brand.primary, borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
                                        <Text style={{ fontSize: 10, fontWeight: '800', color: colors.brand.primary }}>
                                            {groupScopeBadgeText}
                                        </Text>
                                    </View>
                                )}
                            </View>
                            {!isPulse && showsBeans && (
                                <CurrencyDisplay
                                    amount={`${item.credits !== undefined && item.credits !== null ? item.credits : '?'}${priceLabel || ''}`}
                                    style={[styles.price, { fontSize: 16 }]}
                                    asView={true}
                                />
                            )}
                        </View>

                        <Text style={{ fontSize: 16, fontWeight: '900', color: colors.text.body, marginBottom: 4 }} numberOfLines={1}>
                            {item.title}
                        </Text>

                        <PostAuthorTrust pubkey={item.author_pubkey} callsign={cardAuthor} energyCycled={item.author_energy_cycled} avatarUrl={item.author_avatar} mode="full" isFounding={showsBeans && item.authorFoundingNeeded} showTier={showsBeans} />
                    </View>
                </View>
            </Pressable>
        );
    };

    // The fill beneath the nearby listings (see fillRows): in the list's footer so every view mode has it. A grid takes its cards
    // two to a row, as its FlatList does.
    const fillCards = viewMode === 'grid'
        ? Array.from({ length: Math.ceil(fillRows.length / 2) }, (_, i) => fillRows.slice(i * 2, i * 2 + 2)).map(pair => (
            <View key={pair[0].id} style={{ flexDirection: 'row', gap: 16 }}>
                {pair.map(item => <React.Fragment key={item.id}>{renderItem({ item })}</React.Fragment>)}
                {pair.length === 1 ? <View style={{ flex: 1 }} /> : null}
            </View>
        ))
        : fillRows.map(item => <View key={item.id}>{renderItem({ item })}</View>);
    const fillFooter = fillRows.length > 0 || (fillPending && filteredPosts.length === 0) ? (
        <View testID="market-fill" style={{ marginTop: filteredPosts.length > 0 ? 8 : 0 }}>
            {filteredPosts.length === 0 && (
                <Text testID="market-near-empty" style={{ fontSize: 14, fontWeight: '700', color: colors.text.secondary, marginBottom: 12, textAlign: 'center' }}>
                    {t('Nothing within 250 km yet.')}
                </Text>
            )}
            {filteredPosts.length === 0 && !!identity && <MarketCircleLine identity={identity} colors={colors} />}
            {fillRows.length === 0 ? (
                <ActivityIndicator size="small" color={colors.brand.primary} />
            ) : (
                <>
                    {renderItem({ item: { isHeader: true, title: ELSEWHERE_HEADING, id: 'header-elsewhere' } })}
                    {fillCards}
                </>
            )}
        </View>
    ) : null;

    // With no listing to show: a refusal is said as one, and "Having trouble connecting" only when no answer came.
    const emptyState = marketEmptyState({ refusal, hasActiveFilters, firstSyncDone, syncTimedOut });
    const refusedLines = emptyState.kind === 'refused' && emptyState.refusal.code !== 'members_only' ? refusalLines(emptyState.refusal) : null;

    return (
        <View style={styles.safeArea} onLayout={e => setScreenH(e.nativeEvent.layout.height)}>
            {/* The feed and, riding over its top, the controls. Clipped, so the block slides up under the tab bar. */}
            <View style={{ flex: 1, overflow: 'hidden' }}>
            <QuickReturnBlock qr={qr} title={<PageTitle title={t('Market')} testID="page-title-market" />} below={categoryPanelOverlay}>
                {controls}
            </QuickReturnBlock>
            <Animated.FlatList
                ref={listRef}
                key={viewMode}
                numColumns={viewMode === 'grid' ? 2 : 1}
                data={listData}
                keyExtractor={(item: any) => item.id}
                renderItem={renderItem}
                ListHeaderComponent={ListHeader}
                ListFooterComponent={fillFooter || (showExamples && filteredPosts.length > 0) ? (
                    <>
                        {fillFooter}
                        {showExamples && filteredPosts.length + fillRows.length > 0 ? <ExampleListings /> : null}
                    </>
                ) : null}
                contentContainerStyle={[styles.listContent, { paddingTop: qr.listInset }]}
                columnWrapperStyle={viewMode === 'grid' ? styles.gridRow : undefined}
                showsVerticalScrollIndicator={false}
                {...qr.listProps}
                keyboardShouldPersistTaps="handled"
                // Dragging the feed puts the keyboard away and blurs the search, which lets the controls go again.
                keyboardDismissMode="on-drag"
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        colors={[colors.brand.primary]}
                        tintColor={colors.brand.primary}
                        // Below the controls, not behind them.
                        progressViewOffset={qr.listInset}
                    />
                }
                ListEmptyComponent={
                    fillRows.length > 0 || (fillPending && filteredPosts.length === 0) ? null : emptyState.kind === 'refused' && emptyState.refusal.code === 'members_only' ? (
                        // Not a member of this community: its listings are its members'. Not "trouble connecting".
                        <View style={{ padding: 32, alignItems: 'center' }} testID="members-only-listings">
                            <Text style={{ fontSize: 40, opacity: 0.4, marginBottom: 12 }}>🔒</Text>
                            <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text.body, marginBottom: 8, textAlign: 'center' }}>
                                {t("This community's listings are for its members")}
                            </Text>
                            <Text style={{ fontSize: 14, color: colors.text.secondary, textAlign: 'center', marginBottom: 18 }}>
                                {t('To join, ask a member for an invite. Anyone can look around the global community, and ask a community near them to let them in from there.')}
                            </Text>
                            {/* Opens the global community here, as a guest, as a local community's web page opens its lobby; never
                                the browser, whose join would make this person a second account (DESIGN-global-entry §D). */}
                            <Pressable
                                accessibilityRole="button"
                                style={{ backgroundColor: colors.brand.fill, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12, maxWidth: '100%', opacity: guestVisit.visiting ? 0.5 : 1 }}
                                onPress={() => { void guestVisit.visit(); }}
                                disabled={guestVisit.visiting}
                                accessibilityState={{ disabled: guestVisit.visiting, busy: guestVisit.visiting }}
                                testID="members-only-look-around"
                            >
                                <Text style={{ fontWeight: '800', color: colors.text.inverse, fontSize: 14, textAlign: 'center' }}>{t('🌍 Look around the global community')}</Text>
                            </Pressable>
                        </View>
                    ) : refusedLines && emptyState.kind === 'refused' ? (
                        // A private preview's own sentence, or a closed account's: the community answered. Not "trouble connecting".
                        <View style={{ padding: 32, alignItems: 'center' }} testID={`refused-${emptyState.refusal.code}`}>
                            <Text style={{ fontSize: 40, opacity: 0.4, marginBottom: 12 }}>🔒</Text>
                            <Text style={{ fontSize: 17, fontWeight: '800', color: colors.text.body, marginBottom: 8, textAlign: 'center' }}>
                                {refusedLines.title}
                            </Text>
                            {refusedLines.body ? (
                                <Text style={{ fontSize: 14, color: colors.text.secondary, textAlign: 'center' }}>{refusedLines.body}</Text>
                            ) : null}
                        </View>
                    ) : emptyState.kind === 'loading' ? (
                        // First-run / initial sync — show a loader, not the empty state.
                        <View style={{ padding: 48, alignItems: 'center' }}>
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.body, marginTop: 16 }}>
                                {t('Loading the marketplace…')}
                            </Text>
                            <Text style={{ fontSize: 13, color: colors.text.secondary, marginTop: 4 }}>
                                {t('Syncing with your community')}
                            </Text>
                        </View>
                    ) : emptyState.kind === 'trouble_connecting' ? (
                        // First sync hasn't landed and no answer came — offline / node unreachable.
                        <View style={{ padding: 40, alignItems: 'center' }}>
                            <Text style={{ fontSize: 40, opacity: 0.3, marginBottom: 12 }}>📡</Text>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.body, marginBottom: 6 }}>
                                {t('Having trouble connecting')}
                            </Text>
                            <Text style={{ fontSize: 13, color: colors.text.secondary, textAlign: 'center', marginBottom: 16 }}>
                                {t("Couldn't reach your community node yet. Check your connection.")}
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                style={{ backgroundColor: colors.brand.fill, paddingHorizontal: 22, paddingVertical: 11, borderRadius: 12 }}
                                onPress={() => { armSyncWait(); requestSync(); }}
                            >
                                <Text style={{ fontWeight: '800', color: colors.text.inverse, fontSize: 14 }}>{t('Retry')}</Text>
                            </Pressable>
                        </View>
                    ) : emptyState.kind === 'feed' ? (
                        <View style={{ width: '100%' }}>
                            <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                                <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text.secondary, marginBottom: 12, textAlign: 'center' }}>
                                    {nodeProfile?.profile === 'global' ? t('Nothing within 250 km yet.') : t('Nothing here yet. Be the first:')}
                                </Text>
                                {nodeProfile?.profile === 'global' && !!identity && <MarketCircleLine identity={identity} colors={colors} />}
                                {nodeProfile?.profile === 'global' && (
                                    <Pressable
                                        accessibilityRole="button"
                                        style={{ minHeight: 48, justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 16, marginBottom: 16 }}
                                        onPress={() => {
                                            qr.show();
                                            searchInputRef.current?.focus();
                                        }}
                                        testID="market-see-elsewhere"
                                    >
                                        <Text style={{ fontSize: 14, fontWeight: '700', color: colors.brand.primary, textAlign: 'center' }}>
                                            {t('See what people post elsewhere ›')}
                                        </Text>
                                    </Pressable>
                                )}
                                <View testID="market-empty-tiles" style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                                    {(['food', 'services', 'tools', 'garden'] as const).map(cat => (
                                        <View key={cat} style={{ width: 56, height: 56, borderRadius: 14, overflow: 'hidden' }}>
                                            <CategoryTile category={cat} size="thumb" />
                                        </View>
                                    ))}
                                </View>
                                <Pressable
                                    accessibilityRole="button"
                                    style={{ backgroundColor: colors.action.fab || palette.gray900, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24, marginBottom: 10 }}
                                    onPress={() => setShowNewPostTypePicker(true)}
                                >
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                        <Text style={{ color: colors.text.inverse, fontSize: 16, fontWeight: '700' }}>+</Text>
                                        <Text style={{ fontWeight: '800', color: colors.text.inverse, fontSize: 14 }}>{t('ADD POST')}</Text>
                                    </View>
                                </Pressable>
                            </View>
                            {showExamples && <ExampleListings />}
                            <ActivityWaterfall onCreatePostPress={() => router.push({ pathname: '/new-listing', params: { newPost: 'true' } })}
                                viewerPubkey={identity?.publicKey}
                                onOpenPost={(postId) => router.push(`/post/${postId}`)}
                                onOpenProfile={(publicKey, callsign) => router.push({ pathname: '/public-profile', params: { publicKey: publicKey, callsign: callsign || '' } })}
                            />
                        </View>
                    ) : (
                    <View style={{ padding: 32, alignItems: 'center' }}>
                        <Text style={{ fontSize: 40, opacity: 0.3, marginBottom: 16 }}>🛒</Text>
                        <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text.body, marginBottom: 8 }}>
                            {t('No items found')}
                        </Text>
                        <Text style={{ fontSize: 14, color: colors.text.secondary, textAlign: 'center', marginBottom: 20 }}>
                            {t('Try adjusting your filters to see more results.')}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            style={{ backgroundColor: colors.surface.subtle, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, marginBottom: 12 }}
                            onPress={() => { setFilter('all'); dispatchCategoryPanel({ kind: 'pick', category: 'all' }); setEventWindow('all'); setRadiusKm(null); setLocationCenter(null); setTrustFilter('all'); setBeansOnly(false); setGroupFilter('all'); }}
                        >
                            <Text style={{ fontWeight: '700', color: theme === 'dark' ? colors.text.secondary : palette.gray600, fontSize: 14 }}>{t('Clear All Filters')}</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            style={{ backgroundColor: palette.gray900, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12 }}
                            onPress={() => router.push({ pathname: '/new-listing', params: { newPost: 'true' } })}
                        >
                            <Text style={{ fontWeight: '700', color: colors.text.inverse, fontSize: 14 }}>{t('+ Post a Deal')}</Text>
                        </Pressable>
                    </View>
                    )
                }
            />
            {/* While the category panel is open, a tap on the list closes it (and opens nothing), as a tap on
                the map does. */}
            {categoryPanel.open && (
                <Pressable
                    style={StyleSheet.absoluteFill}
                    accessibilityRole="button"
                    accessibilityLabel={t('Close categories')}
                    onPress={closeCategoryPanel}
                />
            )}
            {qr.hidden && filterSummary && (
                <ActiveFilterChip label={filterSummary} onPress={showControls} onClear={clearAllFilters} />
            )}
            </View>
            {/* Hidden while the panel is open, as the map's buttons are: it would cover the strip of feed left. A visitor with no
                account (slice S12): the door, where the key is made, in place of the chooser. */}
            {!categoryPanel.open && (
            <Pressable accessibilityRole="button" style={styles.fab} onPress={() => (identity ? setShowNewPostTypePicker(true) : openLookDoor())} testID="market-add-post">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: colors.text.inverse, fontSize: 20, fontWeight: '400', marginTop: -2 }}>+</Text>
                    <Text style={{ color: colors.text.inverse, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }}>{identity ? t('ADD POST') : t('Join to post')}</Text>
                </View>
            </Pressable>
            )}

            <RadiusPickerModal
                visible={showRadiusPicker}
                initialRadius={radiusKm}
                initialLat={locationCenter?.lat}
                initialLng={locationCenter?.lng}
                onApply={(r, lat, lng) => {
                    setRadiusKm(r);
                    setLocationCenter({ lat, lng });
                    setShowRadiusPicker(false);
                }}
                onReset={() => {
                    setRadiusKm(null);
                    setLocationCenter(null);
                    setShowRadiusPicker(false);
                }}
                onCancel={() => setShowRadiusPicker(false)}
            />

            <TrustPickerSheet
                visible={showTrustPicker}
                selected={trustFilter}
                onSelect={setTrustFilter}
                onClose={() => setShowTrustPicker(false)}
            />

            <MyDealsSheet
                visible={showDealsSheet && escrowMode !== undefined}
                identity={identity}
                onClose={() => setShowDealsSheet(false)}
                initialTab={dealsInitialTab}
                showsBeans={showsBeans || dealsPreview}
                preview={dealsPreview}
            />

            {/* The one way to post: the same chooser the map's + opens (components/NewPostTypeSheet). */}
            <NewPostTypeSheet
                visible={showNewPostTypePicker}
                onClose={() => setShowNewPostTypePicker(false)}
                onSelect={(type) => {
                    const target = composeTargetFor(type);
                    if (target === 'poll-modal') { setShowNewPollModal(true); return; }
                    if (target === 'event-modal') { setShowNewEventModal(true); return; }
                    // The offer/need form is its own screen (app/new-listing.tsx), so this hands the chosen type
                    // over in the link. It used to push a bare `newPost=true`, which dropped the choice and
                    // opened the form on Offer even when the member had picked Need.
                    router.push({ pathname: '/new-listing', params: { newPost: type } });
                }}
            />

            <NewPollModal
                visible={showNewPollModal}
                onClose={() => setShowNewPollModal(false)}
                onSuccess={() => loadPosts()}
            />

            <NewEventModal
                visible={showNewEventModal}
                onClose={() => setShowNewEventModal(false)}
                onSuccess={() => loadPosts()}
            />
        </View>
    );
}

