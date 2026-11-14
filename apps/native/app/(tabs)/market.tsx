import React, { useState, useEffect, useRef, useReducer, useCallback, useMemo } from 'react';
import { StyleSheet, View, Text, FlatList, Animated, Pressable, useWindowDimensions, Platform, TextInput, ScrollView, DeviceEventEmitter, ActivityIndicator, RefreshControl, LayoutAnimation, AppState } from 'react-native';
import { fabClearanceDp } from '../../utils/fab-band';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { keyboardAwareList } from '../../components/keyboardAwareList';
import * as SecureStore from 'expo-secure-store';
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router';
import { setHelpContext } from '../../utils/tour-store';
import { getPosts, getNearbyKeptPostIds, getMarketplaceTransactions, getBalance, fetchGroups, fetchMyEvents, isRouteMissing, type GroupItem } from '../../utils/db';
import { marketCardPicture } from '../../utils/market-card-picture';
import { getBlockedUsers, BLOCKLIST_UPDATED_EVENT } from '../../utils/blocklist';
import { refusalHere, type Refusal } from '../../utils/members-only-listings';
import { marketEmptyState, refusalLines } from '../../utils/market-empty-state';
import { noAreaLineHere, memberAreaHere, type NearbyArea } from '../../utils/nearby-area';
import { NoAreaLine } from '../../components/NoAreaLine';
import { pollsInformal, showcaseMode } from '../../utils/node-profile';
import { useGlobalGuestVisit } from '../../utils/use-global-guest-visit';
import { requestSync, isPillarSyncActive, syncLandedOnThisCopy, PILLAR_SYNC_ENDED } from '../../services/pillar-sync';
import { useIdentity } from '../IdentityContext';
import { RadiusPickerModal } from '../../components/RadiusPickerModal';
import { MyDealsSheet, usePendingDealsCount } from '../../components/MyDealsSheet';
import { PostAuthorTrust, isElder } from '../../components/PostAuthorTrust';
import { ListingCopyLine } from '../../components/ListingCopyLine';
import { TrustPickerSheet, TRUST_FILTERS } from '../../components/TrustPickerSheet';
import { ListingPrice } from '../../components/ListingPrice';
import { ListingEachLine } from '../../components/ListingEachLine';
import { ActivityWaterfall } from '../../components/ActivityWaterfall';
import { categoryEmoji, categoryLabel } from '../../constants/categories';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { PollCard } from '../../components/PollCard';
import { PollGridTile } from '../../components/PollGridTile';
import { NewPollModal } from '../../components/NewPollModal';
import { EventCard, EVENT_ACCENT } from '../../components/EventCard';
import { CategoryTile } from '../../components/CategoryTile';
import { MARKET_GRID_CROP, MarketCardPicture } from '../../components/MarketCardPicture';
import { CardChip, gridTextBlock, useCardShell } from '../../components/market-card-shell';
import { gridRows, type GridRow } from '../../utils/market-grid-rows';
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
import { localDaysAgo, sectionsOfOrdered } from '../../utils/feed-sections';
import { useNodeProfile } from '../../utils/use-node-profile';
import { useReaderFeatures } from '../../utils/use-reader-features';
import { marketShowsBeans, marketExtras, marketSearchDistanceParams, marketStream, nearbyCircle, newestWithinLine, distancesFrom } from '../../utils/market-global';
import { formatDistance } from '../../utils/events';
import { readPhoneInterests, saveInterests } from '../../utils/home-store';
import { anchorUrl } from '../../utils/node-post';
import { ExampleListings } from '../../components/ExampleListings';
import { LookAroundCard } from '../../components/LookAroundCard';
import { openLookDoor } from '../../utils/look-door';
import { useLookingAround } from '../../utils/use-looking-around';
import { exampleListingsOn, showExampleListings } from '../../utils/example-listings';
import { MarketCircleLine } from '../../components/MarketCircleLine';
import { MarketLearnLine } from '../../components/learn/MarketLearnLine';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { copyPriceLine, eventCopyOf, listingChips, listingChipWords, listingFreeTags, readsOwnData, t, tn, upperCase, word, elsewhereFill, FILL_BELOW, postTagsOf, searchTagsFor, tagIndex, freshBanner, recordFreshBannerDismissal, MARKET_SEEN_KEY, NEW_SINCE_LINE, newestListed, newSinceIndex, parseSeenListed, type WordKey } from '@beanpool/core';
// A price for each one: the card's pieces (slice P2).
import { perItemCard } from '@beanpool/core';
import { ELSEWHERE_HEADING, fillWanted as marketFillWanted, readElsewhere, marketServerFilter, normalizeServerPosts } from '../../utils/market-fill';
import { isPostPinned, anyLivePin, marketPins } from '../../utils/pins';

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
/** The "New since you last looked" line's words (core's key, shown through t()). */
const NEW_SINCE_WORDS = { line: NEW_SINCE_LINE };
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
    
    // The style box (components/market-card-shell.ts): the list card's shell, its picture slot and its chips, shared with EventCard;
    // and the grid tile's four-row text block at this phone's font scale.
    const shell = useCardShell();
    const gridBlock = useMemo(() => gridTextBlock(fontScale), [fontScale]);
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

        // Cards: the shell is the style box's (shell.card); these are the variants the screen lays over it.
        elderCard: {
            borderLeftWidth: 3,
            borderLeftColor: colors.trust.star,
            shadowColor: colors.trust.star,
            shadowOpacity: 0.15,
        },
        // The grid tile's photo, its type chip and its foot row of pills are the style box's (shell.gridImageWrapper and the
        // rest, components/market-card-shell.ts), shared with the event tile (EventCard, slice P3').
        price: { fontSize: 16, fontWeight: '800', color: colors.text.body },
        // The Pulse's door (DESIGN-pulse-home-fable.md §3.1, P2): the blue of the Pulse card's band on Home, so the Pulse has one
        // colour everywhere and is never mistaken for the amber Your deals beside the search. 44 dp, no badge, no count.
        pulseDoor: { minHeight: 44, flexShrink: 1, maxWidth: '45%', marginLeft: 8, paddingHorizontal: 12, borderRadius: 22, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.card.blue.tint },
        pulseDoorText: { fontSize: 14, fontWeight: '800', color: colors.card.blue.ink },
        fab: { position: 'absolute', bottom: 32, right: 24, backgroundColor: colors.action.fab, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 28, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 8, zIndex: 100 },
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
        calendarButton: { minWidth: 44, minHeight: 44, paddingHorizontal: 10, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    }));

    const [trustFilter, setTrustFilter] = useState<string>('all');
    const [beansOnly, setBeansOnly] = useState(false);  // #108: hide listings that also need cash
    const [showTrustPicker, setShowTrustPicker] = useState(false);
    const [viewMode, setViewMode] = useState<'list' | 'grid' | 'compact'>('list');
    const [favCategories, setFavCategories] = useState<string[]>([]);
    const [isCustomizerExpanded, setIsCustomizerExpanded] = useState(true);
    // The clock of the Market's order (a live pin ends by it, an event comes back by it): every draw reads the time itself, and the
    // order is worked out again when this changes or the minute does.
    const [nowTick, setNowTick] = useState(Date.now());

    // "Your events" under ★ For You: the signer's own upcoming RSVPs (decision 1). Its own read, only while
    // that pill is chosen. Empty on anything that goes wrong — a node without the route answers 404, and a
    // community that does not have the feature should show no row rather than an error about it (decision 7).
    // Read on choosing the pill AND each time the Market comes back into view on it: the event's page is the only place to
    // answer (the card has no buttons; EventDetail is the one caller of rsvpEvent), and that page is a sheet (post/[id]) over
    // the Market, which stays mounted under it. The page emits nothing when an answer changes; closing the sheet focuses the
    // Market again, as does coming back from any other tab, so the rows never keep a mark the member has just changed there
    // beside a For You copy of the same event that shows the new one (the deciding review of #2874). A read that lands after
    // the Market has lost focus or left the pill is dropped: the next visit reads again.
    const [myEvents, setMyEvents] = useState<MyEvent[]>([]);
    useFocusEffect(useCallback(() => {
        if (filter !== 'for-you' || !identity?.publicKey) return;
        let live = true;
        fetchMyEvents()
            .then(rows => { if (live) setMyEvents(rows); })
            .catch(e => {
                if (live) setMyEvents([]);
                if (!isRouteMissing(e)) console.warn('[Market] Could not read your events:', e);
            });
        return () => { live = false; };
    }, [filter, identity?.publicKey]));

    // Fresh listings banner dismissal. The banner is the list's first row, so it scrolls away with it.
    const [dismissedFresh, setDismissedFresh] = useState<string | null>(null);
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
        // Load dismissed fresh postings state
        AsyncStorage.getItem('bp_dismissed_fresh_count').then(val => {
            if (val) {
                setDismissedFresh(val);
            }
        }).catch(() => {});
    }, []);

    // "New since you last looked" (DESIGN-market-order-fable.md §2.9): one stamp on this phone, beside the fresh banner's: the
    // newest listed time that was on screen, with no search or filter, when the Market was last left. It is read as the Market
    // comes into view and written as it goes out of view, so the line is where the member stopped, whatever came in since.
    const [seenListed, setSeenListed] = useState<number | null>(null);
    const newestOnScreen = useRef<number | null>(null);
    useFocusEffect(useCallback(() => {
        let live = true;
        AsyncStorage.getItem(MARKET_SEEN_KEY).then(val => { if (live) setSeenListed(parseSeenListed(val)); }).catch(() => {});
        const save = () => {
            const newest = newestOnScreen.current;
            if (newest !== null) AsyncStorage.setItem(MARKET_SEEN_KEY, String(newest)).catch(() => {});
        };
        // Leaving by Home or by swiping the app away never blurs the screen, so the stamp is also written as the app goes to
        // the background (or inactive), as the web writes on pagehide; else a member who closes the app from the Market
        // keeps an old stamp and the seen posts pile up above the line.
        const appState = AppState.addEventListener('change', (state) => { if (state === 'background' || state === 'inactive') save(); });
        return () => {
            live = false;
            appState.remove();
            setSeenListed(null);
            save();
        };
    }, []));
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    // A `#tag` tapped: the Market with exactly that typed tag (DESIGN-tags-free-entry-fable.md §4). One filter by tag at a time.
    const [selectedFree, setSelectedFree] = useState<string | null>(null);
    const [blockedUsers, setBlockedUsers] = useState<string[]>([]);
    const [posts, setPosts] = useState<any[]>([]);
    // The posts tied to the member on this phone (a deal, a chat, an answer): the Market's circle never cuts them, as the copy keeps them.
    // Null until read: the circle waits for it, so a tie is never cut for a moment.
    const [keptIds, setKeptIds] = useState<ReadonlySet<string> | null>(null);
    // The clock that ends a pin on screen by the time, without a sync. It runs only while a pin is live in the list: a
    // Market with none (most of them) wakes nothing every 30 seconds. A pin that arrives with a sync changes `posts`.
    const hasLivePin = anyLivePin(posts);
    useEffect(() => {
        if (!hasLivePin) return;
        setNowTick(Date.now());
        const timer = setInterval(() => setNowTick(Date.now()), 30000);
        return () => clearInterval(timer);
    }, [hasLivePin]);
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
    // The member's own area on such a community (utils/nearby-area.ts memberAreaHere): the Market's circle and each card's distance.
    const [memberArea, setMemberArea] = useState<NearbyArea | null>(null);
    useFocusEffect(useCallback(() => {
        let live = true;
        const read = () => {
            noAreaLineHere(identity?.publicKey).then(v => { if (live) setNoArea(v); });
            memberAreaHere(identity?.publicKey).then(v => { if (live) setMemberArea(prev => (prev && v && prev.lat === v.lat && prev.lng === v.lng) || (!prev && !v) ? prev : v); });
        };
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
    // "Post your first Offer", the activity list's create and the empty feed's "+ Post a Deal" open this screen's own chooser (the
    // one the + and ADD POST open), not a chooser on the listing screen. That screen is a full-window transparentModal that
    // drew nothing until its chooser opened, and on iOS a chooser asked for while it was still being presented was refused:
    // the empty screen stayed on top and took every tap and scroll (Rob, 9 Nov). Each pick below opens the same form as before.
    const openNewPostChooser = () => setShowNewPostTypePicker(true);
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
            // The ties the circle never cuts. Not waited for: the list and the deals below never depend on it, and a read that
            // fails leaves the circle off (nothing cut), never an empty Market.
            getNearbyKeptPostIds(identity?.publicKey).then(setKeptIds, () => {});
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

    // The Market's list: what passes the filters, the live pins taken out (utils/pins.ts marketPins), and the rest in the Market's order
    // (core market-order via utils/market-global.ts marketStream). Worked out again only when an input changes: the posts, the
    // filters, the search, the circle, the pin clock (nowTick) or the minute, not on every draw, because at eight thousand posts
    // a sort per draw is felt.
    const nowMinute = Math.floor(Date.now() / 60_000);
    const market = useMemo(() => {
        const nowMs = Date.now();
        const state: MarketFilterState = {
            type: filter, category: categoryFilter, eventWindow, trust: trustFilter, beansOnly, radiusKm, center: locationCenter, groupId: groupFilter,
        };
        const ctx = { blockedUsers, favCategories, nowMs };
        const passing = basePosts.filter(p => {
            // Type pills, the category chip, the date chips, Distance, Trust, Beans only, groups (utils/market-filters.ts)
            if (!feedPostVisible(p, state, ctx)) return false;

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

        // Pins on the Market (DESIGN-pinning-fable.md §0.2, §2.2, §2.9):
        // Up to 3 live pins matching current filters, newest pin first.
        // Absent under search, tag, or distance narrowing.
        const searching = Boolean(
            (searchQuery && searchQuery.trim().length > 0) || isSearching || searchResults !== null || selectedTag !== null || selectedFree !== null,
        );
        const narrowed = searching || radiusKm !== null;

        // The rule is utils/pins.ts marketPins, which a test holds: the screen only says what passes the member's filters.
        const pinsRead = marketPins<any>({
            basePosts, filtered: passing, narrowed, now: nowMs,
            visible: p => feedPostVisible(p, state, ctx),
        });
        // The worldwide community: the same order, cut to the circle round the member's area. Not under Events, a search or a
        // Distance, which have their own say.
        const circle = !narrowed && filter !== 'events' && keptIds ? nearbyCircle(nodeProfile, memberArea) : null;
        const stream = marketStream(pinsRead.rest, nowMs, {
            eventsOnly: filter === 'events', narrowedBySearch: searching, circle, ownKey: identity?.publicKey, keptIds,
        });
        const distances = circle ? distancesFrom([...pinsRead.pinned, ...stream], circle.area) : null;
        // What the fill, the empty state and the example listings weigh is what is drawn: inside the circle a cut post counts for
        // nothing, and the fill may bring it back under Newest from elsewhere.
        const drawn = circle ? [...stream, ...pinsRead.pinned] : pinsRead.allMatching;
        return { pinned: pinsRead.pinned, stream, allMatching: drawn, realMatchingCount: drawn.length, circle, distances };
    }, [basePosts, filter, categoryFilter, eventWindow, trustFilter, beansOnly, radiusKm, locationCenter, groupFilter, blockedUsers, favCategories,
        searchQuery, answerStands, selectedTag, selectedFree, isSearching, searchResults, nodeProfile, memberArea, identity?.publicKey, keptIds, nowTick, nowMinute]);
    const pinnedPosts = market.pinned;
    const filteredPosts = market.stream;
    const allMatchingPosts = market.allMatching;
    const realMatchingCount = market.realMatchingCount;

    // The fill (utils/market-fill.ts, core market-fill): fewer than FILL_BELOW shown near the member, under their filters, and the
    // newest from elsewhere come beneath, read as the search reads the node. The same filters apply to both parts.
    const fillNeeded = marketFillWanted({
        profile: nodeProfile, member: !!identity?.publicKey, ready: firstSyncDone && !refusal, noArea,
        // A tag filter reads as words do, nearest first from anywhere, so there is no elsewhere to fill from.
        searching: searchQuery.trim().length > 0 || !!selectedTag || !!selectedFree, filter, groupFiltered: groupFilter !== 'all', distancePicked: radiusKm != null,
        shownNear: allMatchingPosts,
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
    const fillRows: any[] = elsewhereRead
        ? elsewhereFill(allMatchingPosts, elsewhereRead.filter(p => feedPostVisible(p, filterState, filterCtx)))
        : [];

    const selectedTrustFilter = TRUST_FILTERS.find(f => f.id === trustFilter);
    const hasActiveFilters = marketFiltersActive(filterState) || searchQuery.trim().length > 0 || !!selectedTag || !!selectedFree;
    // What the stamp is taken from, and where the line may show: the whole Market, under no search and no filter.
    const seenEligible = !hasActiveFilters && !isSearching && searchResults === null;
    const newestListedOnScreen = useMemo(
        () => (seenEligible ? newestListed(filteredPosts, Date.now()) : null),
        [seenEligible, filteredPosts, nowMinute],
    );
    useEffect(() => { if (newestListedOnScreen !== null) newestOnScreen.current = newestListedOnScreen; }, [newestListedOnScreen]);

    // A few example cards while the Market is nearly empty, where the node asks for them (utils/example-listings.ts):
    // never under a search or a filter, and never in listData, so nothing counts, opens or pins them. Above the
    // empty state's welcome, or after the real listings.
    const showExamples = showExampleListings({
        on: exampleListingsOn(nodeProfile?.features), narrowed: hasActiveFilters, loaded: firstSyncDone, realInView: fillPending ? FILL_BELOW : realMatchingCount + fillRows.length,
    });

    // Listings posted today, by the local calendar day the TODAY heading uses; events are not listings.
    // Own posts left out: "fresh" is news to you (parity with web).
    const freshTodayCount = posts.filter(post => {
        if (post.status !== 'active' || post.type === 'event') return false;
        if (identity?.publicKey && (post.author_pubkey === identity.publicKey || post.authorPublicKey === identity.publicKey)) return false;
        const postTime = new Date(post.created_at || post.createdAt).getTime();
        return Number.isFinite(postTime) && localDaysAgo(postTime, Date.now()) === 0;
    }).length;

    // Display banner according to core freshBanner helper (dismissal lasts the day, more listings bring it back)
    const shouldShowFreshBanner = freshBanner.shouldShow(dismissedFresh, freshTodayCount);

    const dismissFreshBanner = async () => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        const stored = recordFreshBannerDismissal(freshTodayCount);
        setDismissedFresh(stored);
        try {
            await AsyncStorage.setItem('bp_dismissed_fresh_count', stored);
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
                        trailing={
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Calendar')}
                                testID="market-calendar-button"
                                style={styles.calendarButton}
                                onPress={() => router.push('/calendar')}
                            >
                                <MaterialCommunityIcons name="calendar-month" size={20} color={colors.text.secondary} />
                            </Pressable>
                        }
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
            {/* Learn's one line (Local knowledge, DESIGN-local-knowledge-fable.md amended §3.9): while words are typed and Learn
                has a match. It is a door to Learn, never a listing: no knowledge is among the Market's rows, counts or pills. */}
            <MarketLearnLine words={searchQuery} />
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
                        onPress={() => openNewPostChooser()}
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
        // The grid has no headings: the pins (three at most, newest pin first) are its first cells, each with its 📌 PINNED pill on
        // the photo, and the stream carries on in the same row, so no cell is left empty (DESIGN-market-grid-sizes-fable.md §2.1,
        // Marty 4 Nov). marketPins already took them out of the stream, so none is drawn twice. List and compact keep the block.
        // The list's items are the grid's rows (utils/market-grid-rows.ts, slice PG2): two tiles that share one height, or a poll
        // the list's whole width.
        listData = gridRows([...pinnedPosts, ...filteredPosts]);
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
            if (filter === 'events') {
                // The Events pill is a date list: soonest first, under no heading.
                listData.push(...filteredPosts);
            } else {
                // Newest listed first under Today / Yesterday / This Week / Older Listings, by the local day each was listed.
                // "New since you last looked": one line above the first post listed at or before this phone's stamp. Where that post
                // starts a day, the line is above its heading.
                const nowForList = Date.now();
                const sections = sectionsOfOrdered(filteredPosts, nowForList);
                const lineAt = seenEligible ? newSinceIndex(sections.flatMap(s => s.posts), seenListed, nowForList) : -1;
                const newLine = { isNewSince: true, id: 'new-since-line' };
                let flat = 0;
                for (const section of sections) {
                    if (lineAt === flat) listData.push(newLine);
                    listData.push({ isHeader: true, title: section.title, id: section.id });
                    section.posts.forEach((post, i) => {
                        if (i > 0 && lineAt === flat + i) listData.push(newLine);
                        listData.push(post);
                    });
                    flat += section.posts.length;
                }
            }
        }
    }

    // How far from the member's area, on each card of the worldwide community's circle (market.distances; none elsewhere).
    const distanceWords = (item: any) => {
        const km = market.distances?.get(String(item.id));
        return km == null ? null : formatDistance(km);
    };
    const distanceLine = (item: any) => {
        const words = distanceWords(item);
        return words ? (
            <Text testID="card-distance" numberOfLines={1} style={{ fontSize: 12, fontWeight: '600', color: colors.text.secondary, marginTop: 2 }}>{t('📍 {distance}', { distance: words })}</Text>
        ) : null;
    };

    const renderItem = ({ item }: { item: any }) => {
        if (item.isGridRow) {
            // A row of the grid (utils/market-grid-rows.ts): a poll on its own, both cells wide at a tile row's height, a summary
            // voted in place when the whole poll is in front of the member, else one press that opens the poll's page
            // (components/PollGridTile, Marty 5 Nov 2026; Marty and Damo 6 Nov); or two cells that the row stretches to one
            // height, each tile filling its cell, so the pair is one height whatever each holds. A last odd tile keeps its half:
            // an empty cell beside it holds the width.
            const row: GridRow<any> = item;
            if ('poll' in row) {
                const poll = row.poll;
                return (
                    <PollGridTile
                        post={poll}
                        fontScale={fontScale}
                        informal={pollsInformal(nodeProfile)}
                        onOpen={() => router.push(`/post/${poll.id}`)}
                        currentPubkey={identity?.publicKey}
                        onVoteSuccess={() => loadPosts()}
                    />
                );
            }
            return (
                <View style={shell.gridRow} testID="market-grid-row">
                    {row.pair.map(cell => <View key={cell.id} style={shell.gridCell}>{renderItem({ item: cell })}</View>)}
                    {row.pair.length === 1 ? <View style={shell.gridCell} /> : null}
                </View>
            );
        }
        if (item.isNewSince) {
            return (
                <View style={styles.sectionHeader} testID="new-since-line">
                    <Text style={styles.sectionHeaderText}>{upperCase(t(NEW_SINCE_WORDS.line))}</Text>
                    <View style={styles.sectionHeaderLine} />
                </View>
            );
        }
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
            const eventWhere = { post: item, currentPubkey: identity?.publicKey, myLocation: market.circle ? market.circle.area : myLocation };
            // In the grid an event is a tile like the listing beside it (slice P3'): its text block is the listing tiles' own,
            // built at this phone's font scale, so its four rows are theirs at every width and text size.
            return viewMode === 'grid'
                ? <EventCard {...eventWhere} viewMode="grid" fontScale={fontScale} />
                : <EventCard {...eventWhere} viewMode={viewMode} />;
        }

        if (item.type === 'poll') {
            return (
                <PollCard
                    post={item}
                    viewMode={viewMode}
                    onOpen={() => router.push(`/post/${item.id}`)}
                    currentPubkey={identity?.publicKey}
                    onVoteSuccess={() => loadPosts()}
                    informal={pollsInformal(nodeProfile)}
                    decisionsPreview={decisionsPreview}
                    pinsOn={Boolean(nodeProfile?.features?.pins)}
                />
            );
        }

        // Its own first photo, else its enterprise's shop banner, else the CategoryTile (utils/market-card-picture.ts).
        const { cover: coverImage, picture } = marketCardPicture(item);

        const cardAuthor = item.author_callsign || item.author_pubkey?.slice(0, 6) || t('Unknown');
        // Elder is a tier, and a tier is Beans: no Elder look where the community shows none (as the tier chip below).
        const elderCard = showsBeans && isElder(item.author_energy_cycled);
        const isOwn = !!(identity?.publicKey && item.author_pubkey === identity.publicKey);
        const dealChip = dealChips.get(item.id);
        const isGroupScope = item.audience_scope === 'group' || item.audienceScope === 'group' || !!item.target_group_id || !!item.targetGroupId;
        const groupName = item.target_group_name || item.targetGroupName || t('Group');
        const groupScopeBadgeText = isGroupScope ? t('🔒 Only {group} can see this', { group: groupName }) : null;

        const priceLabel = priceUnit(item.price_type);
        // A member's copy on the global community: where it is from and its price there, in words, where its author would be.
        const copy = eventCopyOf(item);
        // An Offer priced for each one (core per-item.ts, DESIGN-per-item-price-fable.md §2.1): "300 🫘 each" where the price stands and
        // how many are left (and the price for all of them while it is on offer) in its own phrases. Where the price is not shown (a
        // copy, Beans off) there is no count either; any other listing is drawn as it always was.
        const eachCard = showsBeans && !copy ? perItemCard(item) : null;

        const catEmoji = categoryEmoji(item.category);
        const catLabel = categoryLabel(item.category);

        // The whole card is one button that opens the listing (Marty, 4 Nov): the author's chip inside is display only, and
        // the card reads out as the listing (its title and that it is a listing), never as its owner.
        const openLabel = t('Open listing: {title}', { title: item.title });

        if (viewMode === 'grid') {
            const gridDistance = distanceWords(item);
            return (
                <Pressable
                    style={[
                        shell.card,
                        shell.gridTile,
                        elderCard && styles.elderCard,
                    ]}
                    onPress={() => router.push(`/post/${item.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={openLabel}
                    testID={`market-card-${item.id}`}
                >
                    <View style={shell.gridImageWrapper}>
                        <MarketCardPicture
                            postId={item.id}
                            cover={coverImage}
                            picture={picture}
                            category={item.category}
                            kind={item.type === 'event' ? 'event' : 'listing'}
                            size="grid"
                            contentPosition={MARKET_GRID_CROP}
                            accessibilityLabel={item.title}
                            imageStyle={shell.gridImage}
                        />
                        {/* One row along the photo's foot, the badges at its start and the price at its end. It wraps,
                            growing upwards: RECURRING and YOU in a longer language (or at 320dp and 1.3x) stack instead
                            of overlapping each other or the price, as fixed offsets did. */}
                        <View style={shell.gridBadgeRow} testID="grid-badge-row">
                        {(() => {
                            if (item.status === 'pending') {
                                return (
                                    <View style={[shell.gridBadge, { backgroundColor: colors.feedback.warning.solid, borderColor: colors.feedback.warning.solid }]}>
                                        <Text style={[shell.gridPriceText, { color: colors.text.onGold, fontWeight: '900' }]}>{t('⏳ PENDING')}</Text>
                                    </View>
                                );
                            }
                            if (isOwn) {
                                return (
                                    <View style={[shell.gridBadge, { backgroundColor: '#2563eb' }]}>
                                        <Text style={shell.gridPriceText}>{t('👤 YOU')}</Text>
                                    </View>
                                );
                            }
                            return null;
                        })()}
                        {isPostPinned(item, Date.now()) && (
                            <View style={shell.gridBadge} testID="pinned-chip">
                                <Text style={shell.gridPinText}>{t('📌 PINNED')}</Text>
                            </View>
                        )}
                        {dealChip && (
                            <View testID="card-deal-chip" style={[shell.gridBadge, dealChip === 'in-trust'
                                ? { backgroundColor: colors.feedback.success.solid, borderColor: colors.feedback.success.solid }
                                : { backgroundColor: colors.feedback.warning.solid, borderColor: colors.feedback.warning.solid }]}>
                                <Text style={[shell.gridPriceText, { color: dealChip === 'in-trust' ? colors.text.onBrand : colors.text.onGold, fontWeight: '900' }]}>{listingChipWords(dealChip)}</Text>
                            </View>
                        )}
                        {showsBeans && !copy && (
                            <View style={[shell.gridBadge, shell.gridPriceEnd]}>
                                <ListingPrice price_c={item.price_c} type={item.type} unit={priceLabel || ''} style={shell.gridPriceText} listing={item} showAll />
                            </View>
                        )}
                        </View>
                        <View style={shell.gridTypeSlot}>
                            <CardChip shell={shell} role={item.type === 'offer' ? 'offer' : 'need'} label={typeBadge(item.type)} testID="grid-type-chip" />
                        </View>
                    </View>
                    {/* The text block is always four rows, whatever the tile holds (DESIGN-market-grid-sizes-fable.md §2.2): the
                        title's two, the author (or a copy's line), and one last line that is cut, never wrapped: the distance,
                        then one chip at most, the group's lock before RECURRING (a deal is on the photo). What a tile has no
                        room for is on the page it opens. */}
                    <View style={gridBlock.block} testID="grid-text-block">
                        <View style={gridBlock.titleBox}>
                            <Text style={shell.gridTitle} numberOfLines={2}>
                                {item.cash_also_needed === 1 ? '💸 ' : ''}{item.title}
                            </Text>
                        </View>
                        <View style={gridBlock.row}>
                            {copy
                                ? <Text style={shell.gridLine} numberOfLines={1} testID="listing-copy-line">{copyPriceLine(copy)}</Text>
                                : <PostAuthorTrust pubkey={item.author_pubkey} callsign={cardAuthor} energyCycled={item.author_energy_cycled} avatarUrl={item.author_avatar} mode="compact" isFounding={showsBeans && item.authorFoundingNeeded} showTier={showsBeans} navigable={false} />}
                        </View>
                        <View style={gridBlock.lastRow} testID="grid-last-row">
                            {gridDistance ? (
                                <Text testID="card-distance" style={[shell.gridLine, gridBlock.lastRowPiece]} numberOfLines={1}>{t('📍 {distance}', { distance: gridDistance })}</Text>
                            ) : null}
                            {groupScopeBadgeText ? (
                                <View style={gridBlock.lastRowPiece}><CardChip shell={shell} role="quiet" label={groupScopeBadgeText} testID="card-group-chip" /></View>
                            ) : eachCard ? (
                                <View style={gridBlock.lastRowPiece}><CardChip shell={shell} role={eachCard.stockOut ? 'warn' : 'quiet'} label={eachCard.chip} testID="card-stock-chip" /></View>
                            ) : !!item.repeatable && !isOwn && item.status !== 'pending' ? (
                                <View style={gridBlock.lastRowPiece}><CardChip shell={shell} role="quiet" label={t('↻ RECURRING')} /></View>
                            ) : null}
                        </View>
                    </View>
                </Pressable>
            );
        }

        // Compact View
        if (viewMode === 'compact') {
            return (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={openLabel}
                    testID={`market-card-${item.id}`}
                    onPress={() => router.push(`/post/${item.id}`)}
                >
                    {/* The box's compact row (shell.compactRow, slice C1), the one an event and a poll are drawn on too. */}
                    <View style={[shell.compactRow, elderCard && styles.elderCompactRow]}>
                        <View style={shell.compactPicture}>
                            <MarketCardPicture
                                postId={item.id}
                                cover={coverImage}
                                picture={picture}
                                category={item.category}
                                kind={item.type === 'event' ? 'event' : 'listing'}
                                size="thumb"
                                imageStyle={shell.compactImage}
                            />
                        </View>
                        <View style={shell.compactText}>
                            <Text style={styles.compactTitle} numberOfLines={1}>
                                {item.cash_also_needed === 1 ? '💸 ' : ''}{item.title}
                            </Text>
                            <Text style={styles.compactAuthor} numberOfLines={copy ? 3 : 1}>
                                {copy ? copyPriceLine(copy) : byLine(cardAuthor, elderCard, isOwn)}
                            </Text>
                            {distanceLine(item)}
                            {eachCard && <Text style={styles.compactAuthor} numberOfLines={1} testID="card-stock">{eachCard.stock}</Text>}
                            {groupScopeBadgeText && (
                                <View style={{ marginTop: 2, alignSelf: 'flex-start', backgroundColor: colors.brand.tint, borderColor: colors.brand.primary, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                                    <Text style={{ fontSize: 9, fontWeight: '800', color: colors.brand.primary }} numberOfLines={1}>
                                        {groupScopeBadgeText}
                                    </Text>
                                </View>
                            )}
                        </View>
                        <View style={shell.compactEnd}>
                            {showsBeans && !copy && (
                                <ListingPrice price_c={item.price_c} type={item.type} unit={priceLabel || ''} style={shell.compactPrice} listing={item} showAll />
                            )}
                            {/* The one chip (10/800, 6 x 2, corners 6): OFFER / NEED in their pairs. */}
                            <CardChip
                                shell={shell}
                                role={item.type === 'offer' ? 'offer' : 'need'}
                                label={typeBadge(item.type)}
                                testID="compact-type-chip"
                            />
                        </View>
                    </View>
                </Pressable>
            );
        }

        // List View
        return (
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={openLabel}
                testID={`market-card-${item.id}`}
                onPress={() => router.push(`/post/${item.id}`)}
            >
                <View style={[shell.card, shell.list, elderCard && styles.elderCard]}>
                    {/* The slot is 80 dp wide and as tall as the text beside it (at least 80): stretched by the row. Never a
                        percentage height, which Yoga reads against the whole list and made a lone card fill the screen. The
                        shell, the slot and the chips are the style box's (components/market-card-shell.ts), as the event's are. */}
                    <MarketCardPicture
                        postId={item.id}
                        cover={coverImage}
                        picture={picture}
                        category={item.category}
                        kind={item.type === 'event' ? 'event' : 'listing'}
                        size="thumb"
                        imageStyle={shell.listPhoto}
                        tileBox={shell.listPhotoBox}
                    />
                    <View style={shell.listText}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                            <View style={[shell.chipRow, { flex: 1 }]}>
                                <CardChip shell={shell} role={item.type === 'offer' ? 'offer' : 'need'} label={typeBadge(item.type)} />
                                {isOwn && <CardChip shell={shell} role="info" label={t('👤 YOU')} />}
                                {isPostPinned(item, Date.now()) && <CardChip shell={shell} role="pinned" label={t('📌 PINNED')} testID="pinned-chip" />}
                                {dealChip && <CardChip shell={shell} role={dealChip === 'in-trust' ? 'ok' : 'warn'} label={listingChipWords(dealChip)} testID="card-deal-chip" />}
                                <CardChip shell={shell} role="quiet" label={catEmoji + ' ' + catLabel} />
                                {!!item.repeatable && <CardChip shell={shell} role="quiet" label={t('↻ RECURRING')} />}
                                {/* #108: on the card, not just the detail view */}
                                {item.cash_also_needed === 1 && <CardChip shell={shell} role="warn" label={t('💸 CASH TOO')} />}
                                {groupScopeBadgeText && <CardChip shell={shell} role="quiet" label={groupScopeBadgeText} testID="card-group-chip" wrap />}
                            </View>
                            {showsBeans && !copy && (
                                <ListingPrice price_c={item.price_c} type={item.type} unit={priceLabel || ''} style={[styles.price, { fontSize: 16 }]} listing={item} />
                            )}
                        </View>

                        <Text style={{ fontSize: 16, fontWeight: '900', color: colors.text.body, marginBottom: 4 }} numberOfLines={1}>
                            {item.title}
                        </Text>
                        {eachCard && <View style={{ marginBottom: 4 }}><ListingEachLine listing={item} /></View>}

                        {copy ? <ListingCopyLine copy={copy} /> : <PostAuthorTrust pubkey={item.author_pubkey} callsign={cardAuthor} energyCycled={item.author_energy_cycled} avatarUrl={item.author_avatar} mode="full" isFounding={showsBeans && item.authorFoundingNeeded} showTier={showsBeans} navigable={false} />}
                        {distanceLine(item)}
                    </View>
                </View>
            </Pressable>
        );
    };

    // The worldwide community's one line above the list, under the Pinned block (in the grid the pins are the list's first cells, so
    // it is above them): the list is the newest, inside the circle round the member's area.
    const newestLine = market.circle && filteredPosts.length > 0 ? (
        <View style={{ marginHorizontal: 16, marginBottom: 8 }}>
            <Text testID="market-newest-within" numberOfLines={2}style={{ fontSize: 13, fontWeight: '600', color: colors.text.secondary }}>
                {newestWithinLine(market.circle)}
            </Text>
        </View>
    ) : null;

    // The fill beneath the nearby listings (see fillRows): in the list's footer so every view mode has it. A grid takes its cards
    // in the grid's own rows, as its FlatList does (utils/market-grid-rows.ts).
    const fillCards = viewMode === 'grid'
        ? gridRows(fillRows).map(row => <React.Fragment key={row.id}>{renderItem({ item: row })}</React.Fragment>)
        : fillRows.map(item => <View key={item.id}>{renderItem({ item })}</View>);

    // Pinned posts block (DESIGN-pinning-fable.md §0.2, §2.2, §2.9). It sits inside the list's own 16 dp of padding and takes
    // the spacing of the stream's own rows: no margin of its own at the sides or the top, and each card keeps only the bottom
    // margin its style gives it (8 dp in the list and compact views), so a pinned card is the same width, at the same left edge,
    // as every other card (tester Byron, 4 Nov). The grid draws no block: its pins are listData's first cells (see listData), so
    // only the list and compact views have a Pinned heading.
    const pinnedCards = (viewMode !== 'grid' && pinnedPosts.length > 0 && !categoryPanel.open) ? (
        <View style={{ marginBottom: 8 }} testID="market-pinned-block">
            <View style={styles.sectionHeader} testID="pinned-section-header">
                <Text style={styles.sectionHeaderText}>{upperCase(t('Pinned'))}</Text>
                <View style={styles.sectionHeaderLine} />
            </View>
            <View>
                {pinnedPosts.map(item => (
                    <View key={item.id}>
                        {renderItem({ item })}
                    </View>
                ))}
            </View>
        </View>
    ) : null;
    const fillFooter = fillRows.length > 0 || (fillPending && realMatchingCount === 0) ? (
        <View testID="market-fill" style={{ marginTop: realMatchingCount > 0 ? 8 : 0 }}>
            {realMatchingCount === 0 && (
                <Text testID="market-near-empty" style={{ fontSize: 14, fontWeight: '700', color: colors.text.secondary, marginBottom: 12, textAlign: 'center' }}>
                    {t('Nothing within 250 km yet.')}
                </Text>
            )}
            {realMatchingCount === 0 && !!identity && <MarketCircleLine identity={identity} colors={colors} />}
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
            {/* The Pulse's door rides on the title's line, in a slot that is empty otherwise (DESIGN-pulse-home-fable.md §3.1,
                Marty's pick 1 of 14 Nov 2026). The Market's own feed, its pills and its filters are not touched. Members only,
                as reading the Pulse is: a visitor looking in has no door. */}
            <QuickReturnBlock qr={qr} title={<PageTitle title={t('Market')} testID="page-title-market" right={identity ? (
                <Pressable
                    testID="market-pulse-door"
                    accessibilityRole="button"
                    accessibilityLabel={t('Open the Pulse')}
                    onPress={() => router.push('/pulse')}
                    style={styles.pulseDoor}
                >
                    <Text style={styles.pulseDoorText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} maxFontSizeMultiplier={1.3}>
                        {t('📡 Pulse ›')}
                    </Text>
                </Pressable>
            ) : undefined} />} below={categoryPanelOverlay}>
                {controls}
            </QuickReturnBlock>
            <Animated.FlatList
                ref={listRef}
                key={viewMode}
                data={listData}
                keyExtractor={(item: any) => item.id}
                renderItem={renderItem}
                // A poll card's "Other" line is typed mid-feed: the library's scroll view keeps it above the keyboard.
                renderScrollComponent={keyboardAwareList}
                ListHeaderComponent={<>{ListHeader}{pinnedCards}{newestLine}</>}
                ListFooterComponent={fillFooter || (showExamples && realMatchingCount > 0) ? (
                    <>
                        {fillFooter}
                        {showExamples && realMatchingCount + fillRows.length > 0 ? <ExampleListings /> : null}
                    </>
                ) : null}
                contentContainerStyle={[styles.listContent, { paddingTop: qr.listInset, paddingBottom: fabClearanceDp(fontScale) }]}
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
                    pinnedPosts.length > 0 || fillRows.length > 0 || (fillPending && realMatchingCount === 0) ? null : emptyState.kind === 'refused' && emptyState.refusal.code === 'members_only' ? (
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
                            <ActivityWaterfall onCreatePostPress={openNewPostChooser}
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
                            onPress={() => openNewPostChooser()}
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
                    if (target === 'knowledge-screen') { router.push('/learn/new'); return; }
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

