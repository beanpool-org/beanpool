/**
 * New listing: the Offer and Need form, and the chooser that leads to it, on a screen of its own (MAP-FORM; Marty, 15 Oct:
 * "OK to take the listing form out of map.tsx if pins + clustering (99+ cluster icons) are untouched"). It was a sheet
 * inside app/(tabs)/map.tsx and it is the same sheet here, moved as it was: presented over the screen that opened it
 * (transparentModal, app/_layout.tsx), so it still rises over the map from the map's + and over the Market or Home from
 * theirs.
 *
 * `?newPost=` is the link the map read (utils/compose-options.ts parseNewPostParam): `true`, or nothing, opens the
 * chooser; a named type opens that form. Offer and Need open the sheet below; Poll and Event open their own modals, the
 * ones the Market and Home open. "Drop a pin" shows a map here to tap: the form's map was the Map tab itself.
 *
 * Leaving it (✕, the chooser closed, a poll or event done, "Not now", Back) takes the member back to where they were.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { StyleSheet, View, Text, Alert, ScrollView, TextInput, Pressable, Dimensions, Image as RNImage, Keyboard, Linking, Modal, FlatList } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import MapView, { Marker, Circle, PROVIDER_DEFAULT } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { StackActions, useRoute } from '@react-navigation/native';
import { formatNumber, t, upperCase } from '@beanpool/core';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { createPost, getBalance, getReachablePeers } from '../utils/db';
import { hasUsableAvatar as sharedHasUsableAvatar } from '../utils/profile-status';
import { askForPostPhoto } from '../utils/post-photo';
import { useIdentity } from './IdentityContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PricingInfoModal } from '../components/info-content/PricingInfoModal';
import { PricingGuideModal } from '../components/PricingGuideModal';
import { useTheme, useStyles } from './ThemeContext';
import { NewPollModal } from '../components/NewPollModal';
import { NewEventModal } from '../components/NewEventModal';
import { NewPostTypeSheet } from '../components/NewPostTypeSheet';
import { composeCarriesPin, composeTargetFor, parseNewPostParam, type ComposePostType, clearDraftToolMarker, decideDraftOpen } from '../utils/compose-options';
import { palette } from '../constants/colors';
import { HAS_MAPS_KEY } from '../utils/maps';
import { POST_CATEGORIES, categoryEmoji, categoryLabel, normalizeCategory } from '../constants/categories';
import { useNodeProfile } from '../utils/use-node-profile';
import { getCachedNodeProfile } from '../utils/node-profile';
import {
    marketShowsBeans, postFormCredits, postFormPriceType, postFormPriceMissing, postFormPriceInvalid, postFormSubmitLabel, postFormRules, composerNeedsProfilePhoto,
    NO_BEANS_EDIT_NOTE,
} from '../utils/market-global';

const CATEGORIES = POST_CATEGORIES;
/** A line kept as word() in utils/market-global.ts, shown here in the member's language. */
const LINES = { noBeansEditNote: NO_BEANS_EDIT_NOTE };

/** Where the pin map opens before the community's own centre arrives: the map tab's own starting place. */
const PIN_MAP_START = { latitude: -28.5398, longitude: 153.4996, latitudeDelta: 0.0922, longitudeDelta: 0.0421 };

export default function NewListingScreen() {
    const { theme, colors } = useTheme();

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        // Clear, like the map's own ground under the sheet: the screen that opened this one shows above the sheet.
        container: { flex: 1 },
        map: { width: '100%', height: '100%' },

        // Pin drop banner
        pinDropBanner: { position: 'absolute', top: 60, left: 20, right: 20, backgroundColor: colors.feedback.info.solid, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16, alignItems: 'center', zIndex: 200 },
        pinDropBannerText: { color: '#fff', fontWeight: '700', fontSize: 14 },

        // Full-Screen Sheet — LIGHT theme
        sheetWrapper: { position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: SCREEN_HEIGHT * 0.95, zIndex: 500 },
        // No `flex: 1` here. Both users of this style sit in a full-height, `justifyContent: 'flex-end'`
        // parent, where flex:1 makes a bottom sheet fill that whole parent instead of sizing to its
        // content — which is what put the sheet's top edge under the tab row and left a blank band above
        // its title. Each user caps its own height instead.
        sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 14, paddingBottom: 16 },
        /**
         * The New Post sheet. `95%` is of the area its holder gives it. On the map that started below the brand
         * header and the top tab row; on this screen (a modal over them) it is the window below the status bar:
         * the holder takes insets.top, so the sheet keeps no top inset of its own (on the sheet it was the blank strip).
         */
        composerSheet: { maxHeight: '95%', paddingTop: 8 },
        /** The grabber. The title sits directly under it. */
        sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border.strong, marginBottom: 10 },
        sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
        sheetTitle: { color: colors.text.heading, fontSize: 18, fontWeight: '800', letterSpacing: 0.5 },
        sheetClose: { color: colors.text.muted, fontSize: 24, fontWeight: '300', width: 32, height: 32, textAlign: 'center', lineHeight: 32 },

        // Toast
        toastBanner: { backgroundColor: colors.feedback.danger.solid, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14, marginBottom: 10, alignItems: 'center' },
        toastText: { color: '#fff', fontWeight: '700', fontSize: 13 },

        // Section labels
        sectionLabel: { color: colors.text.secondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2, marginTop: 2 },
        requiredStar: { color: colors.feedback.danger.fg, fontSize: 12 },
        sectionLabelHint: { color: colors.text.muted, fontSize: 11, fontWeight: '500', textTransform: 'none', letterSpacing: 0 },

        // Type toggle — colours match map pins (green offer / orange need)
        typeRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
        typeBtn: { flex: 1, paddingVertical: 8, borderRadius: 12, borderWidth: 2, borderColor: colors.border.default, backgroundColor: colors.surface.app, alignItems: 'center' },
        typeBtnOffer: { backgroundColor: colors.brand.fill, borderColor: colors.brand.fill },
        typeBtnNeed: { backgroundColor: colors.action.fab, borderColor: colors.action.fab },
        typeBtnText: { fontSize: 15, fontWeight: '800', color: colors.text.secondary },
        typeBtnTextActive: { color: '#fff' },

        // Category picker
        pickerWrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 40, backgroundColor: colors.surface.app, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 6, overflow: 'hidden' },
        pickerText: { flex: 1, color: colors.text.muted, fontSize: 14 },
        pickerTextActive: { color: colors.text.heading, fontWeight: '600' },
        pickerArrow: { color: colors.text.secondary, fontSize: 12 },
        picker: { color: colors.text.heading, height: 50 },

        // Category modal sheet
        categoryModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
        categorySheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: 480, paddingBottom: 32 },
        categorySheetHeader: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        categorySheetTitle: { color: colors.text.heading, fontSize: 16, fontWeight: '700', textAlign: 'center' },
        categoryRow: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: 'transparent' },
        categoryRowActive: { backgroundColor: theme === 'dark' ? 'rgba(16,185,129,0.15)' : 'rgba(16,185,129,0.08)' },
        categoryRowEmoji: { fontSize: 20, marginRight: 12 },
        categoryRowLabel: { color: colors.text.heading, fontSize: 15, fontWeight: '600' },
        categoryRowCheck: { marginLeft: 'auto', color: colors.brand.primary, fontWeight: '800' },

        // Title (full-width)
        titleInputFull: { backgroundColor: colors.surface.app, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 12, paddingVertical: 8, color: colors.text.heading, fontSize: 14, marginBottom: 6 },

        // Price label row + tip pill
        priceLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, marginTop: 2 },
        tipPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border },
        tipPillEmoji: { fontSize: 13 },
        tipPillText: { fontSize: 11, fontWeight: '800', color: colors.feedback.warning.fg, letterSpacing: 0.3 },
        pricingTipBanner: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 12,
            backgroundColor: theme === 'dark' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(16, 185, 129, 0.06)',
            borderWidth: 1,
            borderColor: theme === 'dark' ? 'rgba(16, 185, 129, 0.25)' : 'rgba(16, 185, 129, 0.18)',
            marginTop: 4,
            marginBottom: 12,
        },
        pricingTipBannerEmoji: {
            fontSize: 20,
            fontWeight: '900',
        },
        pricingTipBannerText: {
            fontSize: 12.5,
            fontWeight: '700',
            color: colors.brand.primary,
            flex: 1,
        },

        // Price input row
        priceInputRow: { flexDirection: 'row', gap: 8, marginBottom: 6, alignItems: 'center' },
        creditsInputCompact: { width: 80, backgroundColor: colors.surface.app, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 8, paddingVertical: 8, color: colors.text.heading, fontSize: 15, fontWeight: '800', textAlign: 'center' },

        // Legacy (unused but kept for safety)
        priceRowCompact: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingVertical: 2 },
        priceRow: { flexDirection: 'row', gap: 8, marginBottom: 4, alignItems: 'center' },
        creditsInputWide: { flex: 1, backgroundColor: colors.surface.app, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 14, paddingVertical: 12, color: colors.text.heading, fontSize: 16, fontWeight: '800' },

        priceTypeBtn: { width: 72, backgroundColor: colors.surface.app, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'center', alignItems: 'center' },
        priceTypeBtnText: { color: colors.text.secondary, fontSize: 13, fontWeight: '700' },
        freeChip: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, borderWidth: 2, borderColor: theme === 'dark' ? 'rgba(16,185,129,0.6)' : 'rgba(16,185,129,0.4)', backgroundColor: theme === 'dark' ? 'rgba(16,185,129,0.15)' : 'rgba(16,185,129,0.08)' },
        freeChipActive: { backgroundColor: colors.brand.fill, borderColor: colors.brand.fill },
        freeChipText: { color: colors.brand.primary, fontSize: 13, fontWeight: '800' },
        freeChipTextActive: { color: '#fff' },
        pricingGuideLink: { marginBottom: 12, paddingVertical: 4 },
        pricingGuideLinkText: { color: colors.text.muted, fontSize: 12, fontWeight: '600' },

        // Location (compact chips)
        locationRow: { flexDirection: 'row', gap: 8, marginBottom: 6, alignItems: 'center' },
        locationChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app },
        locationChipActive: { borderColor: colors.brand.primary, backgroundColor: theme === 'dark' ? 'rgba(16,185,129,0.15)' : 'rgba(16,185,129,0.1)' },
        locationChipIcon: { fontSize: 15 },
        locationChipLabel: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
        locationConfirmInline: { color: colors.brand.primary, fontSize: 13, fontWeight: '800' },

        // Repeatable
        repeatableRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2, marginBottom: 4 },
        checkbox: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: colors.border.strong, backgroundColor: 'transparent', justifyContent: 'center', alignItems: 'center' },
        checkboxActive: { backgroundColor: colors.brand.fill, borderColor: colors.brand.fill },
        checkboxTick: { color: '#fff', fontSize: 14, fontWeight: '800' },
        repeatableText: { flex: 1, color: colors.text.secondary, fontSize: 13, fontWeight: '500' },
        // #108
        checkboxCash: { backgroundColor: colors.feedback.warning.solid, borderColor: colors.feedback.warning.solid },
        cashNudge: { color: colors.feedback.warning.fg, backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12, lineHeight: 17, marginBottom: 6 },

        // #143 step 4 — Reach chooser
        reachSection: { marginTop: 8, marginBottom: 6 },
        reachLabel: { color: colors.text.secondary, fontSize: 13, fontWeight: '600', marginBottom: 6 },
        reachButtonRow: { flexDirection: 'row', gap: 8 },
        reachButton: {
            flex: 1, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 12, borderWidth: 1,
            borderColor: colors.border.default, backgroundColor: colors.surface.app,
            alignItems: 'center', justifyContent: 'center', minHeight: 44,
        },
        reachButtonActive: {
            backgroundColor: colors.brand.fill,
            borderColor: colors.brand.primary,
        },
        reachButtonText: { fontSize: 12, fontWeight: '600', color: colors.text.secondary },
        reachButtonTextActive: { color: '#fff', fontWeight: '700' },
        reachPeerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
        reachPeerChip: {
            paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1,
            borderColor: colors.border.default, backgroundColor: colors.surface.app, minHeight: 44,
        },
        reachPeerChipActive: {
            backgroundColor: colors.brand.fill,
            borderColor: colors.brand.primary,
        },
        reachPeerChipText: { fontSize: 12, fontWeight: '600', color: colors.text.secondary },
        reachPeerChipTextActive: { color: '#fff', fontWeight: '700' },
        reachPeerHint: { color: colors.text.muted, fontSize: 11, fontWeight: '500', fontStyle: 'italic', paddingVertical: 4 },

        // Description
        descriptionInput: { backgroundColor: colors.surface.app, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 10, paddingVertical: 6, color: colors.text.heading, fontSize: 14, minHeight: 60, marginBottom: 8 },

        // Photos
        photosRow: { flexDirection: 'row', gap: 10, marginBottom: 4, flexWrap: 'wrap', padding: 4, borderRadius: 14 },
        photoThumb: { width: 44, height: 44, borderRadius: 12, overflow: 'hidden', position: 'relative' },
        photoImg: { width: 44, height: 44, borderRadius: 12 },
        photoRemove: { position: 'absolute', top: -2, right: -2, width: 18, height: 18, borderRadius: 9, backgroundColor: '#ef4444', justifyContent: 'center', alignItems: 'center' },
        photoRemoveText: { color: '#fff', fontSize: 9, fontWeight: '800' },
        photoAdd: { width: 44, height: 44, borderRadius: 12, borderWidth: 2, borderStyle: 'dashed', borderColor: colors.border.strong, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.app },
        photoAddIcon: { fontSize: 20 },
        photoCount: { color: colors.text.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },

        // Submit
        submitBtn: { paddingVertical: 12, borderRadius: 14, alignItems: 'center', marginBottom: 8, marginTop: 4 },
        submitBtnOffer: { backgroundColor: colors.brand.fill },
        submitBtnNeed: { backgroundColor: colors.action.fab },
        submitBtnDisabled: { backgroundColor: colors.border.default },
        submitBtnText: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.5 },
        submitBtnTextDisabled: { color: colors.text.muted },
    }));

    const { identity } = useIdentity();
    const insets = useSafeAreaInsets();
    const params = useLocalSearchParams<{ newPost?: string }>();
    const navigation = useNavigation();
    const route = useRoute();
    /** The pin map, shown while "Drop a pin" is on. */
    const mapRef = useRef<any>(null);
    const [pinMapRegion, setPinMapRegion] = useState(PIN_MAP_START);
    const [nodeRadius, setNodeRadius] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);

    // New Post state
    const [showNewPost, setShowNewPost] = useState(false);
    // The one way to post: the + opens the same chooser as the Market tab, and Poll and Event open their
    // own modals from here rather than the offer/need sheet.
    const [showNewPostTypePicker, setShowNewPostTypePicker] = useState(false);
    const [showNewPollModal, setShowNewPollModal] = useState(false);
    const [showNewEventModal, setShowNewEventModal] = useState(false);
    /** A pin already dropped on the map, handed to the event form as its place. */
    const [eventInitialPin, setEventInitialPin] = useState<{ lat: number; lng: number } | null>(null);
    const [postType, setPostType] = useState<'offer' | 'need'>('offer');
    // Contribution-first gate: until the member has listed an Offer they can't post Needs.
    const [blockedFromTrading, setBlockedFromTrading] = useState(false);
    const [postCategory, setPostCategory] = useState('');
    const [postTitle, setPostTitle] = useState('');
    const [postDescription, setPostDescription] = useState('');
    const [postCredits, setPostCredits] = useState('');
    const [postPriceType, setPostPriceType] = useState<string>('fixed');
    // Where the community has Beans off (the global one), the form has no price and the preview no amount.
    const nodeFeatures = useNodeProfile()?.features;
    const showsBeans = marketShowsBeans(nodeFeatures);
    const [postRepeatable, setPostRepeatable] = useState(false);
    const [postCashAlsoNeeded, setPostCashAlsoNeeded] = useState(false);  // #108
    // #143 step 4 — per-listing reach. 'local' is the default and stays the default.
    const [postReach, setPostReach] = useState<'local' | 'peers' | 'everywhere'>('local');
    const [postReachPeers, setPostReachPeers] = useState<string[]>([]);
    const [reachablePeerList, setReachablePeerList] = useState<{ peerId: string; callsign: string | null }[]>([]);
    const [postPhotos, setPostPhotos] = useState<string[]>([]);
    const [postLat, setPostLat] = useState<number | null>(null);
    const [postLng, setPostLng] = useState<number | null>(null);
    const [pinDropMode, setPinDropMode] = useState(false);
    const [posting, setPosting] = useState(false);
    const [validationErrors, setValidationErrors] = useState<Set<string>>(new Set());
    const [validationToast, setValidationToast] = useState('');
    const [showCategoryModal, setShowCategoryModal] = useState(false);
    const [showPricingModal, setShowPricingModal] = useState(false);
    const [showPricingGuideModal, setShowPricingGuideModal] = useState(false);
    const [pricingModalTab, setPricingModalTab] = useState<'guide' | 'tax'>('guide');
    const scrollViewRef = useRef<ScrollView>(null);

    // #143 step 4 — which communities a listing could be aimed at. Fetched once; failure is silent and
    // leaves the list empty, which hides the reach chooser. That is the right failure: a member should not be
    // shown a partner they might not have, and 'local' is what they get, which is the safe answer anyway.
    useEffect(() => {
        let cancelled = false;
        getReachablePeers()
            .then(peers => { if (!cancelled) setReachablePeerList(peers); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    // Refresh contribution-first gate status whenever the new-post form opens.
    useEffect(() => {
        if (!showNewPost || !identity?.publicKey) return;
        let cancelled = false;
        getBalance(identity.publicKey)
            .then(b => {
                if (cancelled) return;
                const blocked = !!(b as any).isBlockedFromTrading;
                setBlockedFromTrading(blocked);
                if (blocked) setPostType('offer');
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [showNewPost, identity?.publicKey]);

    /**
     * Take THIS copy out of the stack, wherever it sits. The stack's POP honours its `source` only when the action's
     * `target` is the stack's own key: a bare `navigation.goBack()` carries a source and no target (react-navigation adds
     * only the source), so the stack ignores it and pops the screen on top, which is not always this one (a third tap's
     * copy, a tool opened over a covered chooser). So the target is named here. `router.back()` pops the top as well.
     * Does nothing once the route is gone (the look door's dismissAll has taken it).
     */
    const removeThisCopy = () => {
        const stack = navigation.getState();
        if (!stack?.routes.some((r) => r.key === route.key)) return;
        navigation.dispatch({ ...StackActions.pop(1), source: route.key, target: stack.key });
    };

    /**
     * Back to the screen that opened this one. Once only. While this screen is the one showing it goes back. A chooser
     * closed on its way to the look door (NewPostTypeSheet) must not take the member back from there, and a copy that
     * is covered (a second tap's copy on top of it, a screen opened over it) takes itself out of the stack instead:
     * left in, it would draw nothing and still take every tap, a transparent full-window screen over the opener.
     */
    const left = useRef(false);
    const leave = () => {
        if (left.current) return;
        left.current = true;
        if (!navigation.isFocused()) { removeThisCopy(); return; }
        if (router.canGoBack()) router.back();
        else router.replace('/(tabs)/map');
    };
    /** The chooser calls onClose before onSelect: a close with a choice behind it is not a leave. */
    const chooserLeave = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * The pin map opens on the community, as the map tab does (its fetchNodeLocation): the node's service area and its
     * circle. "Drop a pin" clears the pin first (enterPinDrop, as on the map), so there is no earlier pin to open on.
     */
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                if (!anchorUrl) return;
                const res = await fetch(`${anchorUrl}/api/node/config`);
                if (!res.ok) return;
                const config = await res.json();
                if (cancelled) return;
                if (config?.serviceRadius && typeof config.serviceRadius.lat === 'number' && typeof config.serviceRadius.lng === 'number') {
                    setNodeRadius(config.serviceRadius);
                    setPinMapRegion(r => ({ ...r, latitude: config.serviceRadius.lat, longitude: config.serviceRadius.lng }));
                }
            } catch { /* the pin map opens where it is */ }
        })();
        return () => { cancelled = true; };
    }, []);

    // --- New Post Functions ---
    const resetNewPost = () => {
        setPostType('offer'); setPostCategory(''); setPostTitle(''); setPostDescription('');
        setPostCredits(''); setPostPriceType('fixed'); setPostRepeatable(false); setPostPhotos([]);
        setPostLat(null); setPostLng(null); setPinDropMode(false); setValidationErrors(new Set());
        setValidationToast(''); setPostReach('local'); setPostReachPeers([]);
    };

    // ── Draft persistence + up-front profile-photo check ──
    // A post used to be lost if the user left the composer to fix something
    // (e.g. to add a required profile photo). The draft is now saved as they
    // type and restored next time they open the composer, scoped to the active
    // node so it never leaks between communities.
    const OFFER_DRAFT_KEY = 'beanpool_offer_draft';

    const draftHasContent = () =>
        !!(postTitle.trim() || postDescription.trim() || postCategory || postPhotos.length > 0 || postLat != null);

    const persistDraft = useCallback(async () => {
        try {
            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            const draft = {
                anchorUrl, postType, postCategory, postTitle, postDescription, postCredits,
                postPriceType, postRepeatable, postCashAlsoNeeded, postPhotos, postLat, postLng,
                postReach, postReachPeers, savedAt: Date.now(),
            };
            await AsyncStorage.setItem(OFFER_DRAFT_KEY, JSON.stringify(draft));
        } catch { /* draft is best-effort */ }
    }, [postType, postCategory, postTitle, postDescription, postCredits, postPriceType, postRepeatable, postCashAlsoNeeded, postPhotos, postLat, postLng, postReach, postReachPeers]);

    const clearDraft = async () => { try { await AsyncStorage.removeItem(OFFER_DRAFT_KEY); } catch {} };

    const restoreDraft = (d: any) => {
        setPostType(d.postType === 'need' ? 'need' : 'offer');
        setPostCategory(d.postCategory || '');
        setPostTitle(d.postTitle || '');
        setPostDescription(d.postDescription || '');
        setPostCredits(d.postCredits || '');
        setPostPriceType(d.postPriceType || 'fixed');
        setPostRepeatable(!!d.postRepeatable);
        setPostCashAlsoNeeded(!!d.postCashAlsoNeeded);
        setPostPhotos(Array.isArray(d.postPhotos) ? d.postPhotos : []);
        setPostLat(typeof d.postLat === 'number' ? d.postLat : null);
        setPostLng(typeof d.postLng === 'number' ? d.postLng : null);
        setPostReach(d.postReach === 'peers' || d.postReach === 'everywhere' ? d.postReach : 'local');
        setPostReachPeers(Array.isArray(d.postReachPeers) ? d.postReachPeers : []);
    };

    // Posting requires a profile photo in THIS community (Profile S2, Marty 29 Oct:
    // the photo of a listing is that community's). A photo chosen elsewhere does not count.
    const hasUsableAvatar = async (): Promise<boolean> => {
        return identity ? sharedHasUsableAvatar(identity.publicKey) : false;
    };

    // Open the composer, but check the profile photo UP FRONT (so nobody
    // composes a whole offer only to be blocked at the end) and offer to resume
    // an unfinished draft.
    const openComposer = async (type?: 'offer' | 'need') => {
        // A name AND a photo are required before you can post — checked up front
        // (not after a whole draft) and routed to the setup wizard to fix.
        const nameOk = (identity?.callsign?.trim().length ?? 0) >= 2;
        // Where Beans are off (the global node) no photo is asked for (postFormRules). Opened by a `?newPost=` link before
        // this screen has the node's profile, the phone's saved copy decides (composerNeedsProfilePhoto).
        const readCachedProfile = async () => getCachedNodeProfile(await AsyncStorage.getItem('beanpool_anchor_url'));
        const avatarOk = !(await composerNeedsProfilePhoto(nodeFeatures, readCachedProfile)) || await hasUsableAvatar();
        if (!nameOk || !avatarOk) {
            const need = (!nameOk && !avatarOk) ? t("Your community likes to know who they're dealing with, so you need a name and a photo before you can post. It only takes a moment.")
                : !nameOk ? t("Your community likes to know who they're dealing with, so you need a name before you can post. It only takes a moment.")
                : t("Your community likes to know who they're dealing with, so you need a photo before you can post. It only takes a moment.");
            Alert.alert(
                t('Finish your profile first'),
                need,
                [
                    // Nothing opens here then, so the member goes back to where they were, or on to the wizard.
                    { text: t('Not now'), style: 'cancel', onPress: leave },
                    { text: t('Set up profile'), onPress: () => { left.current = true; router.replace('/profile-setup'); } },
                ]
            );
            return;
        }
        try {
            const raw = await AsyncStorage.getItem(OFFER_DRAFT_KEY);
            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            if (raw) {
                const d = JSON.parse(raw);
                const decision = decideDraftOpen(d, anchorUrl);
                if (decision === 'open-tool') {
                    restoreDraft(d);
                    setShowNewPost(true);
                    try {
                        await AsyncStorage.setItem(OFFER_DRAFT_KEY, JSON.stringify(clearDraftToolMarker(d)));
                    } catch { /* clearing tool marker from storage is best-effort */ }
                    return;
                }
                if (decision === 'ask-unfinished') {
                    Alert.alert(t('Unfinished post'), t('You started a post earlier. Continue it, or start fresh?'), [
                        // Start fresh honours the type just chosen in the chooser; Continue keeps the
                        // draft's own type, because that is the post the member asked to go back to.
                        { text: t('Start fresh'), style: 'destructive', onPress: () => { clearDraft(); resetNewPost(); if (type) setPostType(type); setShowNewPost(true); } },
                        { text: t('Continue'), onPress: () => { restoreDraft(d); setShowNewPost(true); } },
                    ]);
                    return;
                }
            }
        } catch { /* fall through to a blank composer */ }
        if (type) setPostType(type);
        setShowNewPost(true);
    };

    /**
     * The pin the member has already dropped on the map, so it can carry into the next form they open.
     * Taken from the live composer state first, then from the saved draft — a pin dropped in a post that
     * was abandoned last session is still a place the member chose.
     */
    const resolveDroppedPin = async (): Promise<{ lat: number; lng: number } | null> => {
        if (postLat != null && postLng != null) return { lat: postLat, lng: postLng };
        try {
            const raw = await AsyncStorage.getItem(OFFER_DRAFT_KEY);
            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            if (!raw) return null;
            const d = JSON.parse(raw);
            if (d?.anchorUrl !== anchorUrl) return null;
            if (typeof d.postLat !== 'number' || typeof d.postLng !== 'number') return null;
            return { lat: d.postLat, lng: d.postLng };
        } catch {
            return null;
        }
    };

    /**
     * What the chooser's decision does — from the + or from a `?newPost=<type>` link. Offer and Need open
     * this screen's New Post sheet with the type preselected; Poll and Event open the very modals the
     * Market tab opens, so there is one form per type in the app rather than two.
     *
     * An already-dropped pin carries into Offer, Need and Event. A poll stays in the list and has no pin
     * (maintainer's decision, 2026-09-18), so it is offered here but inherits nothing.
     */
    const startCompose = async (type: ComposePostType) => {
        const target = composeTargetFor(type);
        if (target === 'poll-modal') {
            setShowNewPollModal(true);
            return;
        }
        if (target === 'event-modal') {
            setEventInitialPin(composeCarriesPin(type) ? await resolveDroppedPin() : null);
            setShowNewEventModal(true);
            return;
        }
        // Offer and Need share the sheet, and its pin is postLat/postLng — the pin already carries.
        await openComposer(type === 'need' ? 'need' : 'offer');
    };

    // Auto-save the draft as the user edits (only while the composer is open and
    // there's something worth keeping).
    useEffect(() => {
        if (!showNewPost || !draftHasContent()) return;
        persistDraft();
    }, [showNewPost, persistDraft]);

    const useMyLocation = async () => {
        const { status: initStatus, canAskAgain } = await Location.getForegroundPermissionsAsync();
        let status = initStatus;
        if (status !== 'granted') {
            if (canAskAgain) {
                const res = await Location.requestForegroundPermissionsAsync();
                status = res.status;
            } else {
                Alert.alert(t("Permission Denied"), t("Location permission was denied. Please enable it in your device settings to use your current location."), [
                    { text: t("Cancel"), style: "cancel" },
                    { text: t("Open Settings"), onPress: () => Linking.openSettings() }
                ]);
                return;
            }
        }
        if (status !== 'granted') return;
        try {
            const loc = await Location.getCurrentPositionAsync({});
            const lat = Math.round(loc.coords.latitude * 10000) / 10000;
            const lng = Math.round(loc.coords.longitude * 10000) / 10000;
            setPostLat(lat); setPostLng(lng); setPinDropMode(false);
            setValidationErrors(prev => { const n = new Set(prev); n.delete('location'); return n; });
            mapRef.current?.animateToRegion({ latitude: lat, longitude: lng, latitudeDelta: 0.02, longitudeDelta: 0.01 }, 500);
        } catch { Alert.alert(t("Error"), t("Could not get your location. Try 'Drop a pin' instead.")); }
    };

    const enterPinDrop = () => {
        Keyboard.dismiss();
        setPinDropMode(true); setPostLat(null); setPostLng(null);
        setValidationErrors(prev => { const n = new Set(prev); n.delete('location'); return n; });
    };

    const handleMapPress = (e: any) => {
        if (!pinDropMode) return;
        const { latitude, longitude } = e.nativeEvent.coordinate;
        const lat = Math.round(latitude * 10000) / 10000;
        const lng = Math.round(longitude * 10000) / 10000;
        setPostLat(lat); setPostLng(lng);
        setValidationErrors(prev => { const n = new Set(prev); n.delete('location'); return n; });
    };

    const pickPhoto = async () => {
        if (postPhotos.length >= 5) return;
        // The shared sheet: Camera, Gallery, and Browse files on Android, closed by Back (utils/post-photo).
        askForPostPhoto((photo) => setPostPhotos(prev => [...prev, photo]));
    };

    const showPricingGuide = () => {
        setPricingModalTab('guide');
        setShowPricingModal(true);
    };

    const showTaxGuide = () => {
        setPricingModalTab('tax');
        setShowPricingModal(true);
    };

    const handleSubmit = async () => {
        Keyboard.dismiss();
        
        const errors = new Set<string>();
        if (!postTitle.trim()) errors.add('title');
        if (postFormPriceInvalid(postCredits, nodeFeatures)) errors.add('credits');
        if (!postDescription.trim()) errors.add('description');
        if (postLat == null || postLng == null) errors.add('location');
        if (!postCategory) errors.add('category');
        if (photoRequired && postPhotos.length < 1) errors.add('photos');
        setValidationErrors(errors);
        if (errors.size > 0) {
            setValidationToast(t('⚠️ Please complete all required fields'));
            setTimeout(() => setValidationToast(''), 3000);
            return;
        }

        if (!identity) { Alert.alert(t("Auth"), t("You must be authenticated.")); return; }

        setPosting(true);
        try {
            await createPost({
                id: Crypto.randomUUID(),
                type: postType,
                category: postCategory,
                title: postTitle.trim(),
                description: postDescription.trim(),
                credits: postFormCredits(postCredits, nodeFeatures),
                price_type: postFormPriceType(postPriceType, nodeFeatures),
                repeatable: postRepeatable ? 1 : 0,
                cash_also_needed: postCashAlsoNeeded ? 1 : 0,
                author_pubkey: identity.publicKey,
                lat: postLat,
                lng: postLng,
                photos: postPhotos.length > 0 ? JSON.stringify(postPhotos) : null,
                created_at: new Date().toISOString(),
                // #143 step 4 — per-listing reach (fallback to 'local' if 'peers' selected without chosen targets)
                reach: (postReach === 'peers' && postReachPeers.length === 0) ? 'local' : postReach,
                ...(postReach === 'peers' && postReachPeers.length > 0 ? { reachPeers: postReachPeers } : {}),
            });
            clearDraft();
            setTimeout(() => {
                resetNewPost();
                setShowNewPost(false);
                setPosting(false);
                // On to the member's deals, where the map's sheet sent them (by `/`, which Home passed on to the
                // Market: map.tsx could not name the Market itself). This screen goes first, so Back from there is not
                // the form again; the map reads its pins afresh when it shows (its useFocusEffect).
                left.current = true;
                if (router.canDismiss()) router.dismissAll();
                router.push({ pathname: '/(tabs)/market', params: { tab: 'deals', dealsTab: 'active' } });
            }, 300);
        } catch (e: any) {
            console.error(e);
            Alert.alert(t("Error"), e.message || t("Could not publish post."));
            setPosting(false);
        }
    };

    const fieldBorder = (field: string) => validationErrors.has(field) ? { borderColor: colors.feedback.danger.fg, borderWidth: 2, shadowColor: colors.feedback.danger.fg, shadowOpacity: 0.3, shadowRadius: 6 } : {};

    const { needBlocked, photoRequired } = postFormRules(nodeFeatures, postType, blockedFromTrading);

    // Smart button label
    const submitLabel = postFormSubmitLabel({
        posting, needBlocked, postType, category: postCategory, hasLocation: postLat != null, photoCount: postPhotos.length, photoRequired,
        credits: postCredits, title: postTitle, description: postDescription,
    }, nodeFeatures);
    const submitDisabled = needBlocked || posting || postLat == null || !postTitle.trim() || !postDescription.trim() || postFormPriceMissing(postCredits, nodeFeatures) || !postCategory || (photoRequired && postPhotos.length < 1);

    // What the link asked for, once, as the screen opens (once even where effects run twice, so nothing is asked twice).
    // One listing screen at a time, for every door: a copy that opens straight over another (a second tap that came
    // before the first screen covered the window; expo-router's push always adds a route) goes at once and opens
    // nothing. The copy under it opened its chooser and stays the only one.
    const opened = useRef(false);
    useEffect(() => {
        if (opened.current) return;
        opened.current = true;
        const routes = navigation.getState()?.routes ?? [];
        const at = routes.findIndex((r) => r.key === route.key);
        if (at > 0 && routes[at - 1].name === route.name) { left.current = true; removeThisCopy(); return; }
        const wanted = parseNewPostParam(params.newPost) ?? 'chooser';
        if (wanted === 'chooser') setShowNewPostTypePicker(true);
        else startCompose(wanted);
    }, []);

    return (
        <View style={styles.container}>
            {/* The pin map: "Drop a pin" hides the form and shows the community's map to tap, with the pin as it lands. */}
            {pinDropMode && showNewPost && (HAS_MAPS_KEY ? (
                <MapView
                    ref={mapRef}
                    style={styles.map}
                    provider={PROVIDER_DEFAULT}
                    userInterfaceStyle={theme === 'dark' ? 'dark' : 'light'}
                    showsUserLocation={true}
                    showsMyLocationButton={false}
                    toolbarEnabled={false}
                    initialRegion={pinMapRegion}
                    onPress={handleMapPress}
                    onLongPress={handleMapPress}
                >
                    {nodeRadius && nodeRadius.radiusKm > 0 && (
                        <Circle
                            center={{ latitude: nodeRadius.lat, longitude: nodeRadius.lng }}
                            radius={nodeRadius.radiusKm * 1000}
                            strokeColor={palette.amber500}
                            fillColor="rgba(245, 158, 11, 0.06)"
                            strokeWidth={2}
                        />
                    )}
                    {postLat != null && postLng != null && (
                        <Marker coordinate={{ latitude: postLat, longitude: postLng }} pinColor={postType === 'offer' ? palette.emerald500 : palette.orange600} />
                    )}
                </MapView>
            ) : (
                <View style={[styles.map, { justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.subtle, padding: 24 }]}>
                    <Text style={{ marginTop: 12, color: colors.text.body, fontWeight: '700', textAlign: 'center' }}>{t('Google Maps is not configured')}</Text>
                    <Text style={{ marginTop: 4, color: colors.text.secondary, fontSize: 12, textAlign: 'center' }}>{t('API key is missing in build config.')}</Text>
                </View>
            ))}

            {/* Pin drop mode instruction */}
            {pinDropMode && showNewPost && postLat == null && (
                <View style={[styles.pinDropBanner, { top: insets.top + 16 }]}>
                    <Text style={styles.pinDropBannerText}>{t('📌 Tap the map to place your pin')}</Text>
                </View>
            )}

            {/* Dedicated Pin Drop Confirm/Cancel Footer */}
            {pinDropMode && showNewPost && (
                <SafeAreaView style={[styles.sheetWrapper, { bottom: 0, paddingBottom: 20 }]} pointerEvents="box-none">
                    <View style={[styles.sheet, { padding: 16, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: 120, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', elevation: 20 }]}>
                        <Pressable
                            accessibilityRole="button"
                            style={{ flex: 1, padding: 14, backgroundColor: colors.surface.subtle, borderRadius: 12, marginRight: 8, alignItems: 'center' }}
                            onPress={() => { setPinDropMode(false); setPostLat(null); setPostLng(null); }}
                        >
                            <Text style={{ color: colors.text.body, fontWeight: '700' }}>{t('Cancel')}</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            style={{ flex: 1, padding: 14, backgroundColor: postLat != null ? colors.brand.fill : (theme === 'dark' ? 'rgba(16,185,129,0.2)' : 'rgba(16,185,129,0.15)'), borderRadius: 12, marginLeft: 8, alignItems: 'center' }}
                            disabled={postLat == null}
                            onPress={() => setPinDropMode(false)}
                        >
                            <Text style={{ color: postLat != null ? '#fff' : colors.text.muted, fontWeight: '800' }}>{postLat != null ? t('Confirm Pin ✓') : t('Confirm Pin')}</Text>
                        </Pressable>
                    </View>
                </SafeAreaView>
            )}

            {/* New Post Full-Screen Overlay */}
            {showNewPost && !pinDropMode && (
                <KeyboardAvoidingView
                    style={[StyleSheet.absoluteFill, { zIndex: 500, justifyContent: 'flex-end', paddingTop: insets.top }]}
                    behavior="padding"
                >
                    <View style={[styles.sheet, styles.composerSheet]}>
                        <View style={styles.sheetHandle} />

                        {/* Validation Toast */}
                        {validationToast !== '' && (
                            <View style={styles.toastBanner}>
                                <Text style={styles.toastText}>{validationToast}</Text>
                            </View>
                        )}

                        {/* Header */}
                        <View style={styles.sheetHeader}>
                            <Text style={styles.sheetTitle}>{t('New Post')}</Text>
                            <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} onPress={() => { setShowNewPost(false); resetNewPost(); leave(); }} hitSlop={12}>
                                <Text style={styles.sheetClose}>✕</Text>
                            </Pressable>
                        </View>

                        {/* flexShrink so the form scrolls inside the sheet's 95% cap rather than the sheet
                            growing past it — the sheet sizes to content now that it is not flex:1. */}
                        <ScrollView ref={scrollViewRef} style={{ flexShrink: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: 40 }}>
                            {/* Type Toggle — colours match map pins */}
                            <View style={styles.typeRow}>
                                <Pressable accessibilityRole="button" accessibilityState={{ selected: postType === 'offer' }} style={[styles.typeBtn, postType === 'offer' && styles.typeBtnOffer]} onPress={() => setPostType('offer')}>
                                    <Text style={[styles.typeBtnText, postType === 'offer' && styles.typeBtnTextActive]}>{t('🟢 Offer')}</Text>
                                </Pressable>
                                <Pressable accessibilityRole="button" accessibilityState={{ selected: postType === 'need' }} style={[styles.typeBtn, postType === 'need' && styles.typeBtnNeed]} onPress={() => setPostType('need')}>
                                    <Text style={[styles.typeBtnText, postType === 'need' && styles.typeBtnTextActive]}>{t('🟠 Need')}</Text>
                                </Pressable>
                            </View>

                            {needBlocked && (
                                <View style={{ marginBottom: 14, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(245, 158, 11, 0.35)', backgroundColor: 'rgba(245, 158, 11, 0.12)' }}>
                                    <Text style={{ fontWeight: '800', color: palette.amber700 || '#b45309', marginBottom: 4 }}>{t('💡 Contributions First')}</Text>
                                    <Text style={{ fontSize: 13, lineHeight: 18, color: palette.amber700 || '#b45309' }}>
                                        {t('New members must list at least one Offer before posting Needs. Let the community know what you can give back — switch to 🟢 Offer above.')}
                                    </Text>
                                </View>
                            )}

                            {/* Title */}
                            <Text style={styles.sectionLabel}>{upperCase(t('Title'))} <Text style={styles.requiredStar}>*</Text></Text>
                            <TextInput
                                accessibilityLabel={t('Title')}
                                style={[styles.titleInputFull, fieldBorder('title')]}
                                placeholder={t('What do you need/offer?')}
                                placeholderTextColor={colors.text.muted}
                                value={postTitle}
                                onChangeText={v => { setPostTitle(v); setValidationErrors(prev => { const n = new Set(prev); n.delete('title'); return n; }); }}
                                maxLength={50}
                            />

                            {/* Category — unified modal picker, full-row tappable on both platforms */}
                            <Text style={styles.sectionLabel}>{upperCase(t('Category'))} <Text style={styles.requiredStar}>*</Text></Text>
                            <Pressable accessibilityRole="button" style={[styles.pickerWrap, fieldBorder('category')]} onPress={() => setShowCategoryModal(true)}>
                                <Text style={[styles.pickerText, postCategory && styles.pickerTextActive]}>
                                    {postCategory ? t('{emoji} {label}', { emoji: categoryEmoji(postCategory), label: categoryLabel(postCategory) }) : t('Select a category...')}
                                </Text>
                                <Text style={styles.pickerArrow}>▼</Text>
                            </Pressable>
                            <Modal visible={showCategoryModal} transparent animationType="slide">
                                <Pressable accessibilityRole="button" accessibilityLabel={t('Close category picker')} style={styles.categoryModalOverlay} onPress={() => setShowCategoryModal(false)}>
                                    <View style={styles.categorySheet}>
                                        <View style={styles.categorySheetHeader}>
                                            <Text style={styles.categorySheetTitle}>{t('Select Category')}</Text>
                                        </View>
                                        <FlatList
                                            data={CATEGORIES}
                                            keyExtractor={c => c.id}
                                            renderItem={({ item: c }) => (
                                                <Pressable
                                                    accessibilityRole="button"
                                                    accessibilityState={{ selected: postCategory === c.id }}
                                                    style={[styles.categoryRow, postCategory === c.id && styles.categoryRowActive]}
                                                    onPress={() => { setPostCategory(c.id); setShowCategoryModal(false); setValidationErrors(prev => { const n = new Set(prev); n.delete('category'); return n; }); }}
                                                >
                                                    <Text style={styles.categoryRowEmoji}>{c.emoji}</Text>
                                                    <Text style={styles.categoryRowLabel}>{t(c.label)}</Text>
                                                    {postCategory === c.id && <Text style={styles.categoryRowCheck}>✓</Text>}
                                                </Pressable>
                                            )}
                                        />
                                    </View>
                                </Pressable>
                            </Modal>

                            {/* Description */}
                            <Text style={styles.sectionLabel}>{upperCase(t('Description'))} <Text style={styles.requiredStar}>*</Text></Text>
                            <TextInput
                                accessibilityLabel={t('Description')}
                                style={[styles.descriptionInput, fieldBorder('description')]}
                                placeholder={t('Describe what you need/offer...')}
                                placeholderTextColor={colors.text.muted}
                                value={postDescription}
                                onChangeText={v => { setPostDescription(v); setValidationErrors(prev => { const n = new Set(prev); n.delete('description'); return n; }); }}
                                multiline
                                textAlignVertical="top"
                            />

                            {/* Photos */}
                            <Text style={styles.sectionLabel}>{upperCase(t('Photos'))}{photoRequired ? <>{' '}<Text style={styles.requiredStar}>*</Text>{' '}<Text style={styles.sectionLabelHint}>{t('(min 1)')}</Text></> : null}</Text>
                            <View style={[styles.photosRow, fieldBorder('photos')]}>
                                {postPhotos.map((uri, i) => (
                                    uri && typeof uri === 'string' && uri.trim() !== '' && uri !== 'null' && uri !== 'undefined' ? (
                                        <View key={i} style={styles.photoThumb}>
                                            <RNImage source={{ uri }} style={styles.photoImg} />
                                            <Pressable accessibilityRole="button" accessibilityLabel={t('Remove photo')} accessibilityHint={t('Removes this photo')} style={styles.photoRemove} onPress={() => setPostPhotos(prev => prev.filter((_, j) => j !== i))}>
                                                <Text style={styles.photoRemoveText}>✕</Text>
                                            </Pressable>
                                        </View>
                                    ) : null
                                ))}
                                {postPhotos.length < 5 && (
                                    <Pressable accessibilityRole="button" accessibilityLabel={t('Add photo')} style={styles.photoAdd} onPress={() => { pickPhoto(); setValidationErrors(prev => { const n = new Set(prev); n.delete('photos'); return n; }); }}>
                                        <Text style={styles.photoAddIcon}>📷</Text>
                                    </Pressable>
                                )}
                            </View>
                            <Text style={styles.photoCount}>{upperCase(photoRequired ? t('{n}/5 photos', { n: postPhotos.length }) : t('{n}/5 photos (optional)', { n: postPhotos.length }))}</Text>

                            {/* Location */}
                            <Text style={styles.sectionLabel}>{upperCase(t('Location'))} <Text style={styles.requiredStar}>*</Text></Text>
                            <View style={styles.locationRow}>
                                <Pressable
                                    accessibilityRole="button"
                                    style={[styles.locationChip, postLat != null && !pinDropMode && styles.locationChipActive, fieldBorder('location')]}
                                    onPress={useMyLocation}
                                >
                                    <Text style={styles.locationChipIcon}>📍</Text>
                                    <Text style={styles.locationChipLabel}>{t('My location')}</Text>
                                </Pressable>
                                <Pressable
                                    accessibilityRole="button"
                                    style={[styles.locationChip, fieldBorder('location')]}
                                    onPress={enterPinDrop}
                                >
                                    <Text style={styles.locationChipIcon}>📌</Text>
                                    <Text style={styles.locationChipLabel}>{t('Drop a pin')}</Text>
                                </Pressable>
                                {postLat != null && postLng != null && (
                                    <Text style={styles.locationConfirmInline}>{t('✓ Set')}</Text>
                                )}
                            </View>

                            {/* Where there are no Beans, a note instead of the price section below. */}
                            {!showsBeans && (
                                <Text style={{ color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginTop: 2, marginBottom: 10 }}>{t(LINES.noBeansEditNote)}</Text>
                            )}
                            {showsBeans && (<>
                            {/* Price */}
                            <Text style={styles.sectionLabel}>{upperCase(t('Price'))} <Text style={styles.requiredStar}>*</Text></Text>
                            <View style={styles.priceInputRow}>
                                <TextInput
                                    accessibilityLabel={t('Price')}
                                    style={[styles.creditsInputCompact, fieldBorder('credits')]}
                                    placeholder="0"
                                    placeholderTextColor={colors.text.muted}
                                    keyboardType="numeric"
                                    value={postCredits}
                                    onChangeText={v => { setPostCredits(v); setValidationErrors(prev => { const n = new Set(prev); n.delete('credits'); return n; }); }}
                                    maxLength={5}
                                />
                                <Pressable accessibilityRole="button" onPress={() => {
                                    const types = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'];
                                    setPostPriceType(types[(types.indexOf(postPriceType) + 1) % types.length]);
                                }} style={styles.priceTypeBtn}>
                                    <Text style={styles.priceTypeBtnText}>{
                                        { fixed: t('Total', undefined, 'price unit'), hourly: t('/ Hr', undefined, 'price per hour'), daily: t('/ Dy', undefined, 'price per day'), weekly: t('/ Wk', undefined, 'price per week'), monthly: t('/ Mo', undefined, 'price per month') }[postPriceType] || t('Total', undefined, 'price unit')
                                    }</Text>
                                </Pressable>
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: postCredits === '0' }}
                                    style={[styles.freeChip, postCredits === '0' && styles.freeChipActive]}
                                    onPress={() => { setPostCredits('0'); setValidationErrors(prev => { const n = new Set(prev); n.delete('credits'); return n; }); }}
                                >
                                    <Text style={[styles.freeChipText, postCredits === '0' && styles.freeChipTextActive]}>{t('FREE')}</Text>
                                </Pressable>
                            </View>

                            <Pressable accessibilityRole="button" onPress={showPricingGuide} hitSlop={8} style={styles.pricingTipBanner}>
                                <Text style={styles.pricingTipBannerEmoji}>❓</Text>
                                <Text style={styles.pricingTipBannerText}>{t('Not sure what to charge? View the Community Pricing Guide')}</Text>
                            </Pressable>

                            <Pressable
                                accessibilityRole="button"
                                onPress={showTaxGuide}
                                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12, marginTop: -4, paddingRight: 10 }}
                            >
                                <Text style={{ color: colors.text.secondary, fontSize: 13.5, lineHeight: 19 }}>
                                    {(() => {
                                        const parsed = parseFloat(postCredits);
                                        if (!isNaN(parsed) && parsed > 0) {
                                            const net = Math.round(parsed * 0.985 * 100) / 100;
                                            return postType === 'offer' ? t('1.5% fee: You will receive {amount} B.', { amount: formatNumber(net, 2) }) : t('1.5% fee: Fulfiller receives {amount} B.', { amount: formatNumber(net, 2) });
                                        }
                                        return t('1.5% transaction fee funds community projects & solvency.');
                                    })()}{' '}<Text style={{ color: colors.feedback.warning.fg, fontWeight: 'bold' }}>{t('Learn more ⓘ')}</Text>
                                    <Text style={{ color: colors.brand.primary, fontWeight: 'bold' }}> {t('(100% community owned)')}</Text>
                                </Text>
                            </Pressable>
                            </>)}

                            {/* Repeatable Toggle */}
                            <Pressable accessibilityRole="button" accessibilityState={{ selected: postRepeatable }} style={styles.repeatableRow} onPress={() => setPostRepeatable(!postRepeatable)}>
                                <View style={[styles.checkbox, postRepeatable && styles.checkboxActive]}>
                                    {postRepeatable && <Text style={styles.checkboxTick}>✓</Text>}
                                </View>
                                <Text style={styles.repeatableText}>{t('🔁 Repeatable — keep listing active for ongoing bookings')}</Text>
                            </Pressable>

                            {/* #108 Cash-also-needed toggle. The nudge appears on tick, where the
                                decision is being made. No amount field: the app can escrow beans, not
                                cash, so a figure would imply it settles money it never touches. */}
                            <Pressable accessibilityRole="button" accessibilityState={{ selected: postCashAlsoNeeded }} style={styles.repeatableRow} onPress={() => setPostCashAlsoNeeded(!postCashAlsoNeeded)}>
                                <View style={[styles.checkbox, postCashAlsoNeeded && styles.checkboxCash]}>
                                    {postCashAlsoNeeded && <Text style={[styles.checkboxTick, { color: colors.text.onGold }]}>✓</Text>}
                                </View>
                                <Text style={styles.repeatableText}>{t('💸 Cash also needed — for fuel or materials')}</Text>
                            </Pressable>
                            {postCashAlsoNeeded && (
                                <Text style={styles.cashNudge}>
                                    {t('Cash is for fuel and consumables you paid for — not your time, not your tools. At cost, no markup. Agree the details in chat; the app never handles the money.')}
                                </Text>
                            )}

                            {/* #143 step 4 — how far this listing travels. Shown ONLY when this community actually has
                                trading partners: a reach chooser on a node with no peers is a decision about nothing.
                                Default stays "Stays here", because a member who has never heard of federation has not
                                agreed to their listing appearing somewhere else. */}
                            {reachablePeerList.length > 0 && (
                                <View style={styles.reachSection}>
                                    <Text style={styles.reachLabel}>{t('Where does this travel?')}</Text>
                                    <View style={styles.reachButtonRow}>
                                        {([
                                            { value: 'local' as const, label: t('🏠 Stays here') },
                                            { value: 'peers' as const, label: t('🤝 Chosen') },
                                            { value: 'everywhere' as const, label: t('🌏 Everywhere') },
                                        ]).map(opt => (
                                            <Pressable
                                                key={opt.value}
                                                accessibilityRole="button"
                                                accessibilityState={{ selected: postReach === opt.value }}
                                                style={[
                                                    styles.reachButton,
                                                    postReach === opt.value && styles.reachButtonActive,
                                                ]}
                                                onPress={() => setPostReach(opt.value)}
                                            >
                                                <Text style={[
                                                    styles.reachButtonText,
                                                    postReach === opt.value && styles.reachButtonTextActive,
                                                ]}>{opt.label}</Text>
                                            </Pressable>
                                        ))}
                                    </View>
                                    {postReach === 'peers' && (
                                        <View style={styles.reachPeerRow}>
                                            {reachablePeerList.map((p, index) => {
                                                const on = postReachPeers.includes(p.peerId);
                                                const peerLabel = p.callsign || (p.peerId ? t('Peer {id}', { id: p.peerId.slice(-8) }) : t('Peer'));
                                                return (
                                                    <Pressable
                                                        key={p.peerId || index}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('Community {name}', { name: peerLabel })}
                                                        accessibilityState={{ selected: on }}
                                                        style={[
                                                            styles.reachPeerChip,
                                                            on && styles.reachPeerChipActive,
                                                        ]}
                                                        onPress={() => setPostReachPeers(prev =>
                                                            on ? prev.filter(x => x !== p.peerId) : [...prev, p.peerId])}
                                                    >
                                                        <Text style={[
                                                            styles.reachPeerChipText,
                                                            on && styles.reachPeerChipTextActive,
                                                        ]}>{on ? '✓ ' : ''}{peerLabel}</Text>
                                                    </Pressable>
                                                );
                                            })}
                                            {postReachPeers.length === 0 && (
                                                <Text style={styles.reachPeerHint}>{t('Tap a community to include it')}</Text>
                                            )}
                                        </View>
                                    )}
                                </View>
                            )}
                        </ScrollView>

                        {/* Sticky Submit */}
                        <Pressable
                            accessibilityRole="button"
                            style={[styles.submitBtn, submitDisabled ? styles.submitBtnDisabled : (postType === 'offer' ? styles.submitBtnOffer : styles.submitBtnNeed)]}
                            onPress={handleSubmit}
                            disabled={posting || needBlocked}
                        >
                            <Text style={[styles.submitBtnText, submitDisabled && styles.submitBtnTextDisabled]}>{submitLabel}</Text>
                        </Pressable>
                    </View>
                </KeyboardAvoidingView>
            )}

            <PricingInfoModal
                isOpen={showPricingModal}
                onClose={() => setShowPricingModal(false)}
                initialTab={pricingModalTab}
                onOpenFullCatalog={() => setShowPricingGuideModal(true)}
            />

            <PricingGuideModal
                isOpen={showPricingGuideModal}
                onClose={() => setShowPricingGuideModal(false)}
                onSelectOfferItem={(item, effectivePrice) => {
                    setPostType('offer');
                    setPostCategory(normalizeCategory(item.category));
                    setPostTitle(item.name);
                    setPostDescription(item.description);
                    setPostCredits(String(effectivePrice));
                    setShowNewPost(true);
                }}
            />

            {/* The one way to post: the same chooser the Market tab's + opens, with the same four
                options in the same order, each opening the same form. */}
            <NewPostTypeSheet
                visible={showNewPostTypePicker}
                onClose={() => { setShowNewPostTypePicker(false); chooserLeave.current = setTimeout(leave, 0); }}
                onSelect={(type) => { if (chooserLeave.current) clearTimeout(chooserLeave.current); startCompose(type); }}
            />

            <NewPollModal
                visible={showNewPollModal}
                onClose={() => { setShowNewPollModal(false); leave(); }}
            />

            <NewEventModal
                visible={showNewEventModal}
                initialPin={eventInitialPin}
                onClose={() => { setShowNewEventModal(false); setEventInitialPin(null); leave(); }}
            />
        </View>
    );
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
