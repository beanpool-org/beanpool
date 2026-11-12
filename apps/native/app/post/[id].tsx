import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Image, Pressable, ScrollView, TextInput, Keyboard, ActivityIndicator, DeviceEventEmitter, useWindowDimensions } from 'react-native';
import { Alert } from '../../utils/keyboard-alert';
import { KeyboardAvoidingView, KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useKeepCaretVisible } from '../../components/useKeepCaretVisible';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import { Picker } from '@react-native-picker/picker';
import * as Crypto from 'expo-crypto';
import { 
    getPost, updatePost, deletePost, pausePost, resumePost,
    requestMarketplacePost, approveMarketplaceRequest, rejectMarketplaceRequest, cancelMarketplaceRequest,
    acceptMarketplacePost, completeMarketplaceTransaction, cancelMarketplaceTransaction,
    submitRating, reportAbuse, getDb, getMemberRatings, createConversationApi, insertMessage, getUnreadCountForPost, getBalance, refreshBalanceFromServer,
    treasuryApprove, treasuryComplete, treasuryReject, getMarketplaceTransactions, getDealsFor,
    fetchGroupDetails, deleteGroupPostApi, unpinPostOnNode, signStandingStart, stopStandingDeal,
} from '../../utils/db';
import { StandingPanel, StandingTakeUp, type StandingChoice } from '../../components/StandingDeal';
import { standingOfRow } from '../../utils/standing-row';
import { isPostPinned, pinnedDetailLine, showPinMenu, pinFailureText } from '../../utils/pins';
import { usePinRole } from '../../utils/use-pin-role';
import { PinSheet } from '../../components/PinSheet';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useIdentity } from '../IdentityContext';
import { loadIdentity } from '../../utils/identity';
import { getProfileStatus, acceptNeedsProfileLine } from '../../utils/profile-status';
import { ReviewModal } from '../../components/ReviewModal';
import { MyDealsSheet } from '../../components/MyDealsSheet';
import { askForPostPhoto } from '../../utils/post-photo';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { BeansText } from '../../components/BeansText';
import { AuthorCard } from '../../components/AuthorCard';
import { PhotoCarousel } from '../../components/PhotoCarousel';
import { ChatPhotoViewer } from '../../components/chat/ChatPhoto';
import { CategoryTile } from '../../components/CategoryTile';
import { CardChip, useCardShell } from '../../components/market-card-shell';
import { POST_CATEGORIES, categoryEmoji, categoryLabel } from '../../constants/categories';
import { hapticSuccess, hapticWarning, hapticTick } from '../../utils/haptics';
import { blockUser } from '../../utils/blocklist';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { EventDetail } from '../../components/EventDetail';
import { ListingCopyDetail } from '../../components/ListingCopy';
import { ShowOnGlobalHostRow, listingForCopy } from '../../components/ShowOnGlobalRow';
import { isHiddenAuthor } from '../../utils/posts-view';
import { shownPostAfterReload } from '../../utils/shown-post';
import { useNodeProfile } from '../../utils/use-node-profile';
import { SharePostButtons } from '../../components/SharePost';
import { useReaderFeatures } from '../../utils/use-reader-features';
import { readsOwn } from '../../utils/reads-own';
import { pollsInformal, showcaseMode } from '../../utils/node-profile';
import { PollCard } from '../../components/PollCard';
import { LocalCommunityMark } from '../../components/showcase/LocalCommunityMark';
import { eventCopyOf, LOCAL_COMMUNITY_LINES, LOCAL_COMMUNITY_EMOJI, placeShownRoughly, PLACE_WORDS, formatDate, formatNumber, t, tn, parseAmount, amountRefusalWords, ANY_DECIMALS, dealQuantityUnit, type DealQuantityUnit, listingDeals, listingDealLines, dealSideOf, dealMoves, releaseLine, type DealMoves, type DealRow, editedTagsOver, FREE_TAGS_MAX, listingFreeTags, postTagsOf, storedFreeTags, storedPostTags, MARKET_CARD_SHELL as SHELL, MARKET_CARD_TYPE, NEED_ANSWER_WORDS, needAnswerLine, freePriceWords, freePriceLabel, perItemCard, upperCase, standingFieldsFor, standingRoomOf, standingUnitForListing, aboutOfPost, chatAboutDrafts, feeOf, formatHundredths, isHundredths, parseHundredths } from '@beanpool/core';
import { dealAmountOrNull, priceAsTyped } from '../../utils/listing-money';
import { TagPicker } from '../../components/TagPicker';
import { PostTagChips } from '../../components/PostTagChips';
import { Sentence } from '../../components/Sentence';
import { hostLetsInDefault } from '../../utils/events';
import { marketShowsBeans, NO_BEANS_TERMS, NO_BEANS_EDIT_NOTE, noBeansTermsNote } from '../../utils/market-global';
import { ShopToggle, shopIdForEdit, shopToggleState, type ShopToggleState } from '../../components/shop/ShopToggle';
import { readListingShopId, readMyShop } from '../../utils/shop';
import { isDmNotLocked, dmNotLockedLine } from '../../utils/dm-lock';
import { REPORT_REASONS, CHILD_SAFETY_REASON, CHILD_SAFETY_HINT, reportedAlertBody } from '../../utils/reportReasons';
import { changedElsewhere } from '../../utils/changed-elsewhere';
import { requestSync } from '../../services/pillar-sync';
import { signedRequestWords } from '../../components/signed-request-lines';
import { openLookDoor } from '../../utils/look-door';
import { KnowledgeDetail, KnowledgeMissing } from '../../components/learn/KnowledgeDetail';
import { useKnowledgePage } from '../../components/learn/useKnowledgePage';

// Turn a server trade-gate rejection into a friendly title + message. The covenant / contribution
// / holiday gates carry a stable "PREFIX: <human text>" so we can give them a helpful heading. The headings and the
// phone's own sentences are in the member's language; the node's own sentence is shown as it sent it (slice S4).
function explainTradeError(e: any): { title: string; message: string } {
    const raw = String(e?.message || e || t('Something went wrong'));
    // Offer covenant, banded (Trust Model v3): "FLOOR_LOCKED:live:need:unlockedAt:wouldReach: <sentence>".
    // The trailing sentence already has the exact numbers — surface it verbatim.
    if (raw.startsWith('FLOOR_LOCKED')) {
        return { title: t('🎣 Post an Offer to go deeper'), message: raw.replace(/^FLOOR_LOCKED(:\d+){4}:\s*/, '') };
    }
    if (raw.startsWith('COVENANT_REQUIRED')) {
        return { title: t('🎣 Post an Offer first'), message: t('To spend on community credit (take your balance negative) you need at least one active Offer posted — a line in the water so others can trade with you in return. Post an Offer, then try again.') };
    }
    if (raw.startsWith('CONTRIBUTION_REQUIRED')) {
        return { title: t('List an Offer first'), message: t('List at least one Offer of your own before you can request or accept from others.') };
    }
    if (raw.startsWith('HOLIDAY_MODE')) {
        return { title: t('🌴 Holiday mode is on'), message: t('Turn off holiday mode in Settings before trading.') };
    }
    return { title: t('Error'), message: signedRequestWords(raw.replace(/^[A-Z_]+:\s*/, '')) };
}

/** A request's estimated length, in the listing price's own unit ("for {n} days" or "for {n} weeks" for a loan). */
function requestQuantityWords(unit: DealQuantityUnit | null, isLoan: boolean, n: number): string {
    if (isLoan) {
        if (unit === 'week') return tn(n, 'for {n} week', 'for {n} weeks');
        return tn(n, 'for {n} day', 'for {n} days');
    }
    if (unit === 'day') return tn(n, '{n} day', '{n} days');
    if (unit === 'week') return tn(n, '{n} week', '{n} weeks');
    if (unit === 'month') return tn(n, '{n} month', '{n} months');
    if (unit === 'hour') return tn(n, '{n} hours estimated', '{n} hours estimated');
    return '';
}

/**
 * The commitment sentence for an Offer, in the price's own unit. Never a loan's: nothing is held while a loan is asked for.
 * `amount_c`: what the deal holds, whole hundredths of a Bean, written by formatHundredths.
 */
function committedOfferWords(unit: DealQuantityUnit | null, hours: number, amount_c: number): string {
    const credits = formatHundredths(amount_c);
    if (unit === 'day') {
        return tn(
            hours,
            'You have committed {credits} credits ({n} day) to a Trust Wallet for this offer.',
            'You have committed {credits} credits ({n} days) to a Trust Wallet for this offer.',
            { credits }
        );
    }
    if (unit === 'week') {
        return tn(
            hours,
            'You have committed {credits} credits ({n} week) to a Trust Wallet for this offer.',
            'You have committed {credits} credits ({n} weeks) to a Trust Wallet for this offer.',
            { credits }
        );
    }
    if (unit === 'month') {
        return tn(
            hours,
            'You have committed {credits} credits ({n} month) to a Trust Wallet for this offer.',
            'You have committed {credits} credits ({n} months) to a Trust Wallet for this offer.',
            { credits }
        );
    }
    if (unit === 'hour') {
        return t('You have committed {credits} credits ({hours} hours) to a Trust Wallet for this offer.', { credits, hours });
    }
    return t('You have committed {credits} credits to a Trust Wallet for this offer.', { credits });
}

/**
 * The commitment sentence for a Need: in the price's own unit (a Need is never a loan). `amount_c`: what the deal holds,
 * whole hundredths; the net is what reaches the helper, the amount less the Commons fee as the node takes it (core feeOf).
 */
function requestedNeedWords(unit: DealQuantityUnit | null, hours: number, amount_c: number): string {
    const credits = formatHundredths(amount_c);
    const net = netWords(amount_c);
    if (unit === 'day') {
        return tn(
            hours,
            'You have requested to earn {credits} credits ({n} day) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            'You have requested to earn {credits} credits ({n} days) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            { credits, net }
        );
    }
    if (unit === 'week') {
        return tn(
            hours,
            'You have requested to earn {credits} credits ({n} week) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            'You have requested to earn {credits} credits ({n} weeks) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            { credits, net }
        );
    }
    if (unit === 'month') {
        return tn(
            hours,
            'You have requested to earn {credits} credits ({n} month) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            'You have requested to earn {credits} credits ({n} months) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.',
            { credits, net }
        );
    }
    if (unit === 'hour') {
        return t('You have requested to earn {credits} credits ({hours} hours) ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.', { credits, hours, net });
    }
    return t('You have requested to earn {credits} credits ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.', { credits, net });
}

/** What reaches the payee of a deal holding `amount_c`: the amount less the Commons fee, truncated once (core feeOf). */
function netWords(amount_c: unknown): string {
    return isHundredths(amount_c) && amount_c >= 0 ? formatHundredths(amount_c - feeOf(amount_c)) : formatHundredths(null);
}

/** Lines kept as word() elsewhere (utils/market-global.ts, core), shown here in the member's language. */
const LINES = { noBeansEditNote: NO_BEANS_EDIT_NOTE, childSafety: CHILD_SAFETY_REASON, childSafetyHint: CHILD_SAFETY_HINT };

/** The unit after a price: per hour, day, week or month, or none for a total. */
function priceUnitWords(priceType: string | null | undefined): string {
    if (priceType === 'hourly') return t('/ Hr', undefined, 'price per hour');
    if (priceType === 'daily') return t('/ Dy', undefined, 'price per day');
    if (priceType === 'weekly') return t('/ Wk', undefined, 'price per week');
    if (priceType === 'monthly') return t('/ Mo', undefined, 'price per month');
    return '';
}

/** The label over the time a payer confirms at Release, for a deal priced by the hour, day, week or month. */
function confirmWorkedLabel(priceType: string | null | undefined): string {
    if (priceType === 'hourly') return t('CONFIRM ACTUAL HOURS WORKED');
    if (priceType === 'daily') return t('CONFIRM ACTUAL DAYS WORKED');
    if (priceType === 'weekly') return t('CONFIRM ACTUAL WEEKS WORKED');
    if (priceType === 'monthly') return t('CONFIRM ACTUAL MONTHS WORKED');
    return t('CONFIRM ACTUAL UNITS WORKED');
}

function PostDetailModal() {
    const insets = useSafeAreaInsets();
    const { theme, colors } = useTheme();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: colors.surface.app },
        errorText: { color: colors.text.secondary, fontSize: 16, textAlign: 'center', marginBottom: 24, lineHeight: 24 },
        closeBtn: { backgroundColor: colors.action.cta, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12 },
        closeBtnText: { color: colors.text.inverse, fontWeight: 'bold' },

        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle },
        // Grows for a longer word than Back (up to 120, then the word shrinks), so it is never cut at 320dp and 1.3x.
        backButton: { flexDirection: 'row', minWidth: 68, maxWidth: 120, minHeight: 48, alignItems: 'center' },
        backText: { color: colors.text.body, fontSize: 24, marginTop: -2 },
        headerTitle: { fontSize: 18, fontWeight: 'bold', color: colors.text.body, letterSpacing: 1, textTransform: 'uppercase' },

        // The page's column: 16 a side, as the event page's (DESIGN-detail-pages-fable.md §2.1); no block carries its own.
        scroll: { padding: 16, paddingBottom: 60 },

        // The rhythm (§2.3, as DESIGN-detail-pages-frame-fable.md §3 amends it): 8 between lines inside a part, 12 from the title
        // to the terms box and from the box to the action, 16 from the action to the photo and from the photo to the quiet row,
        // 16 between parts. Radii, chips, boxes and button heights from the style box (components/market-card-shell.ts).
        // 1. The chips, wrapping, never shrunk; the time at the right, never pushed off.
        chipLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
        chipLineChips: { flex: 1, minWidth: 0 },
        timeAgo: { color: colors.text.muted, fontSize: 12, fontWeight: '600', flexShrink: 0 },

        // 4. The title: 22/800 in the heading's ink.
        postTitle: { color: colors.text.heading, fontSize: 22, fontWeight: '800', lineHeight: 28, marginBottom: 12 },
        // 10. The description: 15 on 22 in the body's ink.
        description: { color: colors.text.body, fontSize: MARKET_CARD_TYPE.page.descriptionSize, lineHeight: MARKET_CARD_TYPE.page.descriptionLine, marginBottom: 16 },

        // 8. The photo: 4:3 of the column, under the column's corners; the tile 3:1 without one. 16 under the action (its
        // last part's own gap is the take-up's 0, so the frame keeps 16 of its own above), 16 over the quiet row.
        photoFrame: {
            width: '100%', aspectRatio: SHELL.photo.grid.aspectWidth / SHELL.photo.grid.aspectHeight,
            borderRadius: SHELL.radius, overflow: 'hidden', backgroundColor: colors.surface.subtle, marginTop: 16, marginBottom: 16,
        },
        tileBanner: { width: '100%', aspectRatio: 3, borderRadius: SHELL.radius, overflow: 'hidden', marginTop: 16, marginBottom: 16 },

        // 6. The terms box: the page box, the label over the value, left-aligned. The value 18/800; a price 28/800, its unit 15/500.
        termsBox: { marginBottom: 12 },
        termsLabel: { marginBottom: 8 },
        termsValue: { color: colors.text.heading, fontSize: MARKET_CARD_TYPE.page.termsValue.size, fontWeight: '800' },
        termsNote: { color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginTop: 4 },
        termsMore: { minHeight: MARKET_CARD_TYPE.page.buttonHeight, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: 12 },
        termsMoreText: { fontSize: 14, fontWeight: '700', color: colors.text.link },
        priceRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
        priceValue: { color: colors.text.heading, fontSize: MARKET_CARD_TYPE.page.pagePrice.size, fontWeight: '800' },
        priceUnit: { fontSize: 15, fontWeight: '500', color: colors.text.secondary, marginLeft: 2 },

        // 9. The quiet row: Message and Share, each sized to its words and growing to share the line; wrapping by whole buttons.
        quietRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', marginBottom: 16 },
        quietItem: { flexGrow: 1, flexBasis: 'auto', flexShrink: 0, maxWidth: '100%' },
        quietButton: { borderWidth: 1.5, borderColor: colors.border.strong, backgroundColor: colors.surface.card, paddingHorizontal: 12 },
        quietButtonText: { color: colors.text.body },

        // The author card's own styles live in components/AuthorCard.tsx.
        roughPlace: { color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginTop: -8, marginBottom: 16 },

        // Own Post Actions
        ownPostActions: { gap: 10 },
        editPostBtn: { backgroundColor: colors.action.cta, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
        editPostBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800' },
        deletePostBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 2, borderColor: colors.feedback.danger.border },
        deletePostBtnText: { color: colors.feedback.danger.fg, fontSize: 14, fontWeight: '700' },
        pauseOfferBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 2, borderColor: colors.feedback.warning.border },
        pauseOfferBtnText: { color: colors.feedback.warning.fg, fontSize: 14, fontWeight: '700' },

        // Other's Post Actions
        otherPostActions: { gap: 10 },
        // A Message button (the quiet row's, a deal's): the neutral outline, 48 tall, corners 12, the body's words 15/700 (§2.2).
        messageBtn: {
            backgroundColor: colors.surface.card, minHeight: MARKET_CARD_TYPE.page.buttonHeight, borderRadius: MARKET_CARD_TYPE.page.buttonRadius,
            paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.border.strong,
        },
        messageInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', maxWidth: '100%' },
        messageBtnText: { color: colors.text.body, fontSize: MARKET_CARD_TYPE.page.button.size, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
        // The commit (Accept / Fulfill / Borrow, Release): the filled page button, 48 tall, corners 12, 15/700 (§2.2).
        acceptBtn: {
            minHeight: MARKET_CARD_TYPE.page.buttonHeight, borderRadius: MARKET_CARD_TYPE.page.buttonRadius,
            paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', justifyContent: 'center',
        },
        acceptBtnOffer: { backgroundColor: colors.brand.fill },
        acceptBtnNeed: { backgroundColor: colors.action.fab },
        acceptBtnText: { color: colors.text.inverse, fontSize: MARKET_CARD_TYPE.page.button.size, fontWeight: '700', textAlign: 'center' },

        // Edit Section
        editSection: { backgroundColor: colors.surface.card, borderRadius: SHELL.radius, borderWidth: 1, borderColor: colors.border.default, padding: 16 },
        editSectionTitle: { color: colors.text.body, fontSize: 18, fontWeight: '800', marginBottom: 16 },
        editTypeRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
        editTypeBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app, alignItems: 'center' },
        editTypeBtnOffer: { backgroundColor: colors.brand.fill, borderColor: colors.brand.primary },
        editTypeBtnNeed: { backgroundColor: colors.action.fab, borderColor: palette.orange600 },
        editTypeBtnText: { fontSize: 14, fontWeight: '800', color: colors.text.muted },
        editTypeBtnTextActive: { color: colors.text.inverse },
        editPickerWrap: { backgroundColor: colors.surface.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 10, overflow: 'hidden' },
        editPicker: { color: colors.text.body, height: 50 },
        editInput: { backgroundColor: colors.surface.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 14, paddingVertical: 12, color: colors.text.body, fontSize: 15, marginBottom: 10 },
        editPhotoLabel: { color: colors.text.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
        requiredStar: { color: colors.feedback.danger.fg },
        editPhotosRow: { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
        editPhotoThumb: { width: 60, height: 60, borderRadius: 12, overflow: 'hidden', position: 'relative' },
        editPhotoImg: { width: 60, height: 60, borderRadius: 12 },
        editPhotoRemove: { position: 'absolute', top: -2, right: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.feedback.danger.solid, justifyContent: 'center', alignItems: 'center' },
        editPhotoRemoveText: { color: colors.text.inverse, fontSize: 10, fontWeight: '800' },
        editPhotoAdd: { width: 60, height: 60, borderRadius: 12, borderWidth: 2, borderStyle: 'dashed', borderColor: colors.border.strong, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.app },
        editPhotoAddIcon: { color: colors.text.muted, fontSize: 26 },
        editBtnRow: { flexDirection: 'row', gap: 10 },
        editCancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center' },
        editCancelBtnText: { color: colors.text.secondary, fontSize: 15, fontWeight: '700' },
        editSaveBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: colors.action.cta, alignItems: 'center' },
        editSaveBtnDisabled: { backgroundColor: colors.border.strong },
        editSaveBtnText: { color: colors.text.inverse, fontSize: 15, fontWeight: '800' },

        // Transaction Logic Components
        // The deal boxes on the style box's numbers (§2.2): its corners, border, ground, padding and the one card shadow.
        confirmBox: {
            backgroundColor: colors.surface.card, borderRadius: SHELL.radius, padding: SHELL.textPadding, marginTop: 8, borderWidth: SHELL.borderWidth,
            borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: SHELL.shadow.offsetY },
            shadowOpacity: SHELL.shadow.opacity, shadowRadius: SHELL.shadow.blur, elevation: SHELL.shadow.elevation,
        },
        confirmBoxTitle: { color: colors.text.body, fontSize: 15, fontWeight: '800', textAlign: 'center', marginBottom: 12 },
        needAnswerLine: { color: colors.text.body, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 16 },
        confirmBoxLabel: { color: colors.text.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 6 },
        confirmBoxInput: { backgroundColor: colors.surface.app, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 16, paddingVertical: 14, color: colors.text.body, fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
        cancelActionBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        cancelActionBtnText: { color: colors.text.secondary, fontSize: 14, fontWeight: '700' },
        confirmActionBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
        confirmActionBtnGreen: { backgroundColor: colors.brand.fill },
        confirmActionBtnText: { color: colors.text.inverse, fontSize: 14, fontWeight: '800' },
        cancelTxBtn: { marginTop: 12, borderWidth: 1, borderColor: colors.feedback.danger.border, backgroundColor: colors.surface.card, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
        cancelTxBtnText: { color: colors.feedback.danger.fg, fontSize: 14, fontWeight: '700' },
        requestsContainer: {
            marginTop: 16,
            backgroundColor: colors.surface.card,
            borderRadius: SHELL.radius,
            padding: SHELL.textPadding,
            borderWidth: SHELL.borderWidth,
            borderColor: colors.border.default,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: SHELL.shadow.offsetY },
            shadowOpacity: SHELL.shadow.opacity,
            shadowRadius: SHELL.shadow.blur,
            elevation: SHELL.shadow.elevation,
        },
        requestsTitle: {
            color: colors.text.body,
            fontSize: 16,
            fontWeight: 'bold',
            marginBottom: 12
        },
        requestCard: {
            flexDirection: 'column',
            backgroundColor: colors.surface.app,
            borderWidth: SHELL.borderWidth,
            borderColor: colors.border.default,
            borderRadius: SHELL.radius,
            padding: SHELL.textPadding,
            marginBottom: 8
        },
        requestName: {
            color: colors.text.body,
            fontWeight: '600',
            fontSize: 14,
            marginBottom: 4
        },
        requestAmt: {
            color: colors.brand.primary,
            fontSize: 12,
            fontWeight: '700'
        },
        approveBtn: {
            backgroundColor: colors.brand.fill,
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderRadius: 10
        },
        approveBtnText: {
            color: colors.text.inverse,
            fontSize: 13,
            fontWeight: 'bold'
        },
        rejectBtn: {
            backgroundColor: colors.surface.card,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.feedback.danger.border
        },
        rejectBtnText: {
            color: colors.feedback.danger.fg,
            fontSize: 13,
            fontWeight: 'bold'
        },
        reqMessageBtn: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
            borderColor: colors.border.strong,
            borderRadius: 16,
            paddingHorizontal: 12,
            paddingVertical: 6,
        },
        reqMessageBtnText: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: '700',
        },
        modalOverlay: {
            flex: 1,
            backgroundColor: colors.overlay.imageViewerCloseBg,
            justifyContent: 'center',
            padding: 20,
        },
        modalContent: {
            backgroundColor: colors.surface.card,
            borderRadius: 20,
            padding: 24,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 10 },
            shadowOpacity: 0.15,
            shadowRadius: 20,
            elevation: 10,
        },
        modalTitle: {
            fontSize: 20,
            fontWeight: '900',
            color: colors.text.body,
            marginBottom: 8,
            textAlign: 'center',
        },
        modalSubtext: {
            fontSize: 14,
            color: colors.text.secondary,
            marginBottom: 20,
            textAlign: 'center',
        },
        unreadBadge: {
            backgroundColor: colors.feedback.danger.solid,
            borderRadius: 12,
            paddingHorizontal: 8,
            paddingVertical: 2,
            marginLeft: 8,
            justifyContent: 'center',
            alignItems: 'center',
        },
        unreadBadgeText: {
            color: colors.text.inverse,
            fontSize: 12,
            fontWeight: 'bold',
        },
        unreadBadgeSmall: {
            backgroundColor: colors.feedback.danger.solid,
            borderRadius: 10,
            width: 18,
            height: 18,
            position: 'absolute',
            top: -6,
            right: -6,
            justifyContent: 'center',
            alignItems: 'center',
        },
        unreadBadgeTextSmall: {
            color: colors.text.inverse,
            fontSize: 10,
            fontWeight: 'bold',
        },
        pulseInspirationBox: {
            backgroundColor: colors.feedback.warning.bg,
            borderRadius: 16,
            padding: 20,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: colors.feedback.warning.border,
            marginVertical: 16,
        },
        pulseIcon: {
            fontSize: 36,
            marginBottom: 8,
        },
        pulseInspirationTitle: {
            fontSize: 18,
            fontWeight: '800',
            color: colors.text.heading,
            marginBottom: 6,
            textAlign: 'center',
        },
        pulseInspirationText: {
            fontSize: 14,
            color: colors.text.secondary,
            lineHeight: 20,
            textAlign: 'center',
            marginBottom: 16,
        },
        pulsePostOfferBtn: {
            backgroundColor: palette.amber700,
            paddingVertical: 12,
            paddingHorizontal: 20,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 4,
            elevation: 2,
        },
        pulsePostOfferBtnText: {
            color: '#ffffff',
            fontWeight: '800',
            fontSize: 15,
        },
        pulseFooterText: {
            fontSize: 11,
            color: colors.text.muted,
            marginTop: 12,
            fontStyle: 'italic',
            textAlign: 'center',
        },
    }));

    const { id, txId } = useLocalSearchParams<{ id?: string | string[]; txId?: string | string[] }>();
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    useEffect(() => {
        const showSub = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates.height));
        const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
        return () => { showSub.remove(); hideSub.remove(); };
    }, []);
    const { identity } = useIdentity();
    const [activeTx, setActiveTx] = useState<any>(null);
    // The deal a door named (an alert's txId) when its Beans are not held: its status, and its standing deal's phase on the
    // phone's copy (a short one's row is the period last settled, but the deal runs on). Said in one line when it is over,
    // never the live deal (core listingDealLines.finished).
    const [pinnedOver, setPinnedOver] = useState<Parameters<typeof listingDealLines.finished>[0] | null>(null);
    const [post, setPost] = useState<any>(null);
    // True only once the post is confirmed absent (local miss + the server-side
    // check has had time to land). Until then a local miss renders as loading,
    // not "Post not found".
    const [postMissing, setPostMissing] = useState(false);
    const notFoundTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // The id whose last read found no row on the phone, and the id the node said it holds no such listing for (utils/db.ts
    // post_not_on_node): together, the shown listing goes (utils/shown-post.ts).
    const readNoRow = React.useRef<string | null>(null);
    const goneOnNode = React.useRef<string | null>(null);
    const [editMode, setEditMode] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [toggling, setToggling] = useState(false);

    // Edit form state
    const [editType, setEditType] = useState<'offer' | 'need'>('offer');
    const [editCategory, setEditCategory] = useState('general');
    const [editTags, setEditTags] = useState<string[]>([]);
    // The tags the form opened with, moved on by a reload's (below): what the save compares with, never a `post` that changed
    // under the form, which would read the form's list as the member taking the tags off.
    const editTagsFrom = useRef<string[]>([]);
    const [editFreeTags, setEditFreeTags] = useState<string[]>([]);
    const editFreeTagsFrom = useRef<string[]>([]);
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editCredits, setEditCredits] = useState('');
    const [editPriceType, setEditPriceType] = useState<string>('fixed');
    const [editRepeatable, setEditRepeatable] = useState(false);
    const [editPhotos, setEditPhotos] = useState<string[]>([]);
    // "Put this in your shop" (slice S4′): where the listing is now, as the node says, and where the edit puts it.
    const [editShop, setEditShop] = useState<ShopToggleState>({ kind: 'hidden' });
    const [editInShop, setEditInShop] = useState(false);

    // On a community with Beans off (the worldwide one) a post has no price and nothing to accept through escrow:
    // its terms are in the description, and the member messages the poster (utils/market-global.ts).
    // The reader's own features (design §4); where the node previews what it has off, the price slot carries the
    // marker's line and the deal action keeps its place as the marker's action (DESIGN-global-showcase-fable §1 rows 2, 4).
    const nodeProfile = useNodeProfile();
    const reader = useReaderFeatures();
    const showsBeans = marketShowsBeans(reader.effective ?? nodeProfile?.features);
    const escrowOn = (reader.effective ?? nodeProfile?.features)?.escrow !== false;
    const beansPreview = showcaseMode('beans', reader.node, reader.reader) === 'preview';
    const escrowPreview = showcaseMode('escrow', reader.node, reader.reader) === 'preview';

    // Transactions / Reporting state
    const [accepting, setAccepting] = useState(false);
    const [showAcceptConfirm, setShowAcceptConfirm] = useState(false);
    // Keeps the field being typed in (the edit form, the rating comment, the reply box) above the keyboard.
    const { scrollRef: scrollViewRef, scrollProps: keepCaretVisible } = useKeepCaretVisible();
    // The style box (components/market-card-shell.ts): the card's chips, the page's boxes and buttons, as the event page draws them.
    const shell = useCardShell();
    // The photo frame is 4:3 of the column (the screen less the page's 16 a side); the carousel needs the number.
    const { width: screenWidth, fontScale } = useWindowDimensions();
    const photoHeight = Math.round((screenWidth - 32) * SHELL.photo.grid.aspectHeight / SHELL.photo.grid.aspectWidth);
    // The photo a tap opened whole (the frame crops to 4:3): its own URL, the same ~800 px photo, in the chat's full-screen viewer.
    const [viewerUri, setViewerUri] = useState<string | null>(null);
    // The note under IN RETURN, once the member has asked for the whole of it ("More").
    const [termsNoteOpen, setTermsNoteOpen] = useState(false);
    // Where the take-up sits in the page, for the scroll that brings its confirmation into view.
    const takeUpTop = useRef(0);
    // Contribution-first gate: accepting an Offer requires having listed one.
    const [blockedFromTrading, setBlockedFromTrading] = useState(false);
    const [spendRoom, setSpendRoom] = useState<number | null>(null);
    const [showContributionRequired, setShowContributionRequired] = useState(false);
    const [acceptHours, setAcceptHours] = useState('1');
    // The request on a standing Need whose author is agreeing to pay for it (DESIGN-standing-deals-fable §4): its payer screen shows.
    const [approvingStanding, setApprovingStanding] = useState<string | null>(null);
    const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
    const [completeHours, setCompleteHours] = useState('');
    const [showRatingForm, setShowRatingForm] = useState(false);
    const [myRating, setMyRating] = useState(0);
    const [ratingComment, setRatingComment] = useState('');
    const [submittingRating, setSubmittingRating] = useState(false);
    const [hasExistingRating, setHasExistingRating] = useState(false);
    const [showReportForm, setShowReportForm] = useState(false);
    const [reportReason, setReportReason] = useState('');
    const [reportDetails, setReportDetails] = useState('');
    const [submittingReport, setSubmittingReport] = useState(false);
    const [isBlocking, setIsBlocking] = useState(false);
    const [promptReviewForTx, setPromptReviewForTx] = useState<{ txId: string; targetPubkey: string; targetCallsign: string } | null>(null);
    const [showDealsSheet, setShowDealsSheet] = useState(false);
    const [showPinSheet, setShowPinSheet] = useState(false);
    const [unpinning, setUnpinning] = useState(false);
    // The "···" is for an owner or admin (Pin, Take the pin off) and for a pinned post's author (Take the pin off).
    const pinsOn = Boolean(nodeProfile?.features?.pins);
    const pinRole = usePinRole(pinsOn, identity?.publicKey);

    const handlePostOptions = () => {
        const pinned = isPostPinned(post);
        if (pinned) {
            Alert.alert(t('Post options'), undefined, [
                {
                    text: t('Take the pin off'),
                    style: 'destructive',
                    onPress: async () => {
                        if (unpinning) return;
                        setUnpinning(true);
                        try {
                            await unpinPostOnNode(post.id);
                            const updated = await getPost(post.id);
                            if (updated) setPost(updated);
                        } catch (e: any) {
                            Alert.alert(t('Error'), pinFailureText(e, t('Failed to unpin post')));
                        } finally {
                            setUnpinning(false);
                        }
                    },
                },
                { text: t('Cancel'), style: 'cancel' },
            ]);
        } else {
            Alert.alert(t('Post options'), undefined, [
                {
                    text: t('Pin to the top…'),
                    onPress: () => setShowPinSheet(true),
                },
                { text: t('Cancel'), style: 'cancel' },
            ]);
        }
    };

    // Request Rejection Modal State
    const [rejectModalTxId, setRejectModalTxId] = useState<string | null>(null);
    const [rejectMessage, setRejectMessage] = useState('');

    const [localRequests, setRequests] = useState<any[]>([]);
    // Every deal on this listing the reader stands on (deals S4): their own, and for a keeper the enterprise's, which the
    // phone's sync never holds (utils/db.ts getDealsFor reads them from the node).
    const [listingTxs, setListingTxs] = useState<DealRow[]>([]);
    const [keptRequests, setKeptRequests] = useState<any[]>([]);
    const requests = keptRequests.length > 0 ? [...localRequests, ...keptRequests.filter(k => !localRequests.some(r => r.id === k.id))] : localRequests;
    // The row whose Release is being confirmed, on a listing with several deals under way (its own people's rows).
    const [releaseRowId, setReleaseRowId] = useState<string | null>(null);
    // Messages unread from the other side of each of those deals, by deal.
    const [rowUnread, setRowUnread] = useState<Record<string, number>>({});

    const [authorAvgRating, setAuthorAvgRating] = useState<number | null>(null);
    const [authorRatingCount, setAuthorRatingCount] = useState<number>(0);

    const [targetPeerAvgRating, setTargetPeerAvgRating] = useState<number | null>(null);
    const [targetPeerRatingCount, setTargetPeerRatingCount] = useState<number>(0);

    const [unreadCount, setUnreadCount] = useState<number>(0);
    const [reqUnreadCounts, setReqUnreadCounts] = useState<Record<string, number>>({});
    const [operatedTreasuries, setOperatedTreasuries] = useState<string[]>([]);
    const [isConvenor, setIsConvenor] = useState(false);
    const [deletingAsConvenor, setDeletingAsConvenor] = useState(false);

    // A reload while the form is open can bring the listing's real tags (a copy from before the tags column, read again a
    // moment after it opened): the picker shows them, the member's own changes on top.
    useEffect(() => {
        if (!editMode) return;
        const now = postTagsOf(post?.tags);
        const from = editTagsFrom.current;
        if (storedPostTags(now) === storedPostTags(from)) return;
        editTagsFrom.current = now;
        setEditTags((edited) => editedTagsOver(from, edited, now));
    }, [post?.tags, editMode]);
    // The same for the tags its author typed: an edit that never touched them keeps them.
    useEffect(() => {
        if (!editMode) return;
        const now = listingFreeTags(post);
        const from = editFreeTagsFrom.current;
        if (storedFreeTags(now) === storedFreeTags(from)) return;
        editFreeTagsFrom.current = now;
        setEditFreeTags((edited) => editedTagsOver(from, edited, now, FREE_TAGS_MAX));
    }, [post?.free_tags, post?.freeTags, editMode]);

    useFocusEffect(
        useCallback(() => {
            if (id) { 
                const singleId = Array.isArray(id) ? id[0] : id;
                const singleTxId = Array.isArray(txId) ? txId[0] : txId;
                const reload = async () => {
                    getPost(singleId).then(p => {
                        // A read with no row keeps the listing shown: its by-id refetch replaces it (utils/shown-post.ts),
                        // unless the node has answered that it holds no such listing.
                        setPost((prev: any) => shownPostAfterReload(prev, p, singleId, goneOnNode.current === singleId));
                        readNoRow.current = p ? null : singleId;
                        if (p) {
                            goneOnNode.current = null;
                            if (notFoundTimer.current) { clearTimeout(notFoundTimer.current); notFoundTimer.current = null; }
                            setPostMissing(false);
                            const targetGroupId = p.target_group_id || p.targetGroupId;
                            if (targetGroupId) {
                                fetchGroupDetails(targetGroupId).then(res => {
                                    setIsConvenor(res?.group?.viewerRole === 'convenor');
                                }).catch(() => setIsConvenor(false));
                            } else {
                                setIsConvenor(false);
                            }
                        } else if (!notFoundTimer.current) {
                            // Local miss: getPost kicked off a server upsert that emits
                            // sync_data_updated (→ reload) if the post exists. Declare
                            // "not found" only after that check has had time to land.
                            notFoundTimer.current = setTimeout(() => setPostMissing(true), 10000);
                        }
                    });
                    
                    let activeIdentity = identity;
                    if (!activeIdentity) {
                        try {
                            const idData = await loadIdentity();
                            if (idData) activeIdentity = idData;
                        } catch (e) {
                            console.warn('[Post Detail] Failed to preload identity from Secure Store:', e);
                        }
                    }

                    const database = await getDb();
                    // The listing's deals by the one rule (core listingDeals): the reader's own, and an enterprise's for its keeper.
                    if (activeIdentity) {
                        const reader = activeIdentity.publicKey;
                        (async () => {
                            const own = (await getMarketplaceTransactions(reader).catch(() => [])).filter(tx => tx.postId === singleId);
                            const listed = await getPost(singleId);
                            let kept: DealRow[] = [];
                            let keeps: string[] = [];
                            if (listed?.author_pubkey && listed.author_pubkey !== reader && await readsOwn('enterprises', reader) && await readsOwn('escrow', reader)) {
                                const b = await getBalance(reader).catch(() => null);
                                if (Array.isArray((b as any)?.keeperOf) && (b as any).keeperOf.includes(listed.author_pubkey)) {
                                    keeps = (b as any).keeperOf;
                                    kept = (await getDealsFor(listed.author_pubkey)).filter(tx => tx.postId === singleId);
                                }
                            }
                            setListingTxs([...own, ...kept] as DealRow[]);
                            // Each deal held on it: what its other side has written unread, for the Message button on its row.
                            const unread: Record<string, number> = {};
                            for (const tx of [...own, ...kept] as DealRow[]) {
                                const side = tx.status === 'pending' && tx.id && !(tx.id in unread) ? dealSideOf(tx, reader, keeps) : null;
                                if (!side) continue;
                                const other = tx.buyerPublicKey === side ? tx.sellerPublicKey : tx.buyerPublicKey;
                                unread[tx.id!] = await getUnreadCountForPost(singleId, reader, other).catch(() => 0);
                            }
                            setRowUnread(unread);
                            // Its requests, in the shape the phone's own rows have, for the keepers who answer them.
                            setKeptRequests(kept.filter(tx => tx.status === 'requested').map((tx: any) => ({
                                id: tx.id, post_id: tx.postId, status: tx.status, buyer_pubkey: tx.buyerPublicKey, seller_pubkey: tx.sellerPublicKey,
                                buyer_callsign: tx.buyerCallsign, seller_callsign: tx.sellerCallsign, amount_c: tx.amount_c, hours: tx.hours ?? null,
                                created_at: tx.createdAt, avgRating: 0, count: 0,
                                resolvedReqPubkey: listed?.type === 'need' ? tx.sellerPublicKey : tx.buyerPublicKey,
                            })));
                        })().catch(() => {});
                    }
                    const updateActiveTx = async (tx: any) => {
                        setActiveTx(tx);
                        // Ensure unread badge instantly updates when sync_data_updated triggers reload
                        if (tx && activeIdentity?.publicKey) {
                            const postRow = await getPost(singleId);
                            const isPayerLocal = tx.buyer_pubkey === activeIdentity.publicKey;
                            const isOwn = activeIdentity.publicKey === postRow?.author_pubkey;
                            const tPubkey = isPayerLocal ? tx.seller_pubkey : tx.buyer_pubkey;
                            
                            getUnreadCountForPost(singleId, activeIdentity.publicKey, tPubkey)
                                .then(setUnreadCount)
                                .catch(console.error);
                        }
                    };

                    // The deal a door named stands as the live one only while its Beans are held, as on the web (MarketplacePage
                    // pinnedTx). One that is over (an alert for a request declined, a deal cancelled, released or settled) never
                    // does: it hid Accept, Ask to borrow and I can do this from one the node lets take the listing up again.
                    // Nor does a request (Your deals, Home): it hid the asker's own box and Withdraw. The listing's own read below
                    // gives what the reader has on it now, and the page says what became of a deal that is over.
                    const pinned: any = singleTxId ? await database.getFirstAsync(`
                        SELECT t.*, m.callsign as buyer_callsign, m.avatar_url as buyer_avatar, s.callsign as seller_callsign, s.avatar_url as seller_avatar
                        FROM marketplace_transactions t
                        LEFT JOIN members m ON t.buyer_pubkey = m.public_key
                        LEFT JOIN members s ON t.seller_pubkey = s.public_key
                        WHERE t.id = ? AND t.post_id = ?
                    `, [singleTxId, singleId]).catch(() => null) : null;   // a deal shows only on ITS listing (a hand-made link pairs any)
                    const pinHeld = pinned?.status === 'pending';
                    setPinnedOver(pinned && !pinHeld ? { status: String(pinned.status), ...standingOfRow(pinned) } : null);
                    if (pinHeld) {
                        updateActiveTx(pinned);
                    } else if (activeIdentity) {
                        const currentPost = await getPost(singleId);
                        let isKeeper = false;
                        try {
                            // Which enterprises the reader keeps: never asked where enterprises are in preview
                            // (utils/reads-own.ts; the global node, where there are none).
                            const b = await readsOwn('enterprises', activeIdentity.publicKey) ? await getBalance(activeIdentity.publicKey) : null;
                            const mine: string[] = Array.isArray((b as any)?.keeperOf) ? (b as any).keeperOf : [];
                            if (currentPost?.author_pubkey && mine.includes(currentPost.author_pubkey)) {
                                isKeeper = true;
                            }
                        } catch {}

                        if (isKeeper || currentPost?.author_pubkey === activeIdentity.publicKey) {
                            database.getFirstAsync(`
                                SELECT t.*, m.callsign as buyer_callsign, m.avatar_url as buyer_avatar, s.callsign as seller_callsign, s.avatar_url as seller_avatar 
                                FROM marketplace_transactions t 
                                LEFT JOIN members m ON t.buyer_pubkey = m.public_key 
                                LEFT JOIN members s ON t.seller_pubkey = s.public_key 
                                WHERE t.post_id=? AND t.status='pending' ORDER BY t.created_at DESC LIMIT 1
                            `, [singleId]).then(updateActiveTx);
                        } else {
                            database.getFirstAsync(`
                                SELECT t.*, m.callsign as buyer_callsign, m.avatar_url as buyer_avatar, s.callsign as seller_callsign, s.avatar_url as seller_avatar 
                                FROM marketplace_transactions t 
                                LEFT JOIN members m ON t.buyer_pubkey = m.public_key 
                                LEFT JOIN members s ON t.seller_pubkey = s.public_key 
                                WHERE t.post_id=? AND t.status='pending' AND (t.buyer_pubkey=? OR t.seller_pubkey=?) ORDER BY t.created_at DESC LIMIT 1
                            `, [singleId, activeIdentity.publicKey, activeIdentity.publicKey]).then(updateActiveTx);
                        }
                    }

                    database.getAllAsync(`
                        SELECT t.*, m.callsign as buyer_callsign, m.avatar_url as buyer_avatar, s.callsign as seller_callsign, s.avatar_url as seller_avatar 
                        FROM marketplace_transactions t 
                        LEFT JOIN members m ON t.buyer_pubkey = m.public_key LEFT JOIN members s ON t.seller_pubkey = s.public_key 
                        WHERE t.post_id=? AND t.status='requested'
                    `, [singleId])
                        .then(async (res: any[]) => {
                            const currentPost = await getPost(singleId);
                            const postType = currentPost?.type || 'offer';
                            // Some older local rows might have null seller_pubkey even for needs. Fallback to buyer_pubkey.
                            const resolved = res.map(req => ({
                                req,
                                reqPubkey: (postType === 'need' && req.seller_pubkey) ? req.seller_pubkey : req.buyer_pubkey,
                            }));
                            // ⚡ One grouped read of the locally-synced ratings table instead of a
                            // per-request getMemberRatings() network call (that was an N+1 that
                            // stampeded the node + DB lock on every sync tick).
                            const ratingByPubkey = new Map<string, { average: number; count: number }>();
                            const distinctPubkeys = [...new Set(resolved.map(r => r.reqPubkey).filter(Boolean))];
                            if (distinctPubkeys.length > 0) {
                                const placeholders = distinctPubkeys.map(() => '?').join(',');
                                const ratingRows = await database.getAllAsync<any>(
                                    `SELECT target_pubkey, COUNT(*) as count, AVG(stars) as average FROM ratings WHERE target_pubkey IN (${placeholders}) GROUP BY target_pubkey`,
                                    distinctPubkeys
                                );
                                for (const rr of ratingRows) ratingByPubkey.set(rr.target_pubkey, { average: rr.average || 0, count: rr.count || 0 });
                            }
                            const enriched = resolved.map(({ req, reqPubkey }) => {
                                const r = ratingByPubkey.get(reqPubkey) || { average: 0, count: 0 };
                                return { ...req, avgRating: r.average, count: r.count, resolvedReqPubkey: reqPubkey };
                            });
                            setRequests(enriched);
                            
                            // Fetch unread counts for requests
                            if (activeIdentity) {
                                const counts: Record<string, number> = {};
                                for (const req of enriched) {
                                    if (req.resolvedReqPubkey) {
                                        counts[req.id] = await getUnreadCountForPost(singleId, activeIdentity.publicKey, req.resolvedReqPubkey);
                                    }
                                }
                                setReqUnreadCounts(counts);
                            }
                        });
                };
                reload();

                const sub = DeviceEventEmitter.addListener('sync_data_updated', reload);
                // The by-id read found no such listing on the node (utils/db.ts). With no row on the phone either, the
                // shown listing goes, and the not-found timer's text shows; a row the phone holds stays until the sync drops it.
                const goneSub = DeviceEventEmitter.addListener('post_not_on_node', (goneId: unknown) => {
                    if (goneId !== singleId) return;
                    goneOnNode.current = singleId;
                    if (readNoRow.current === singleId) setPost((prev: any) => shownPostAfterReload(prev, null, singleId, true));
                });
                return () => {
                    sub.remove();
                    goneSub.remove();
                    if (notFoundTimer.current) { clearTimeout(notFoundTimer.current); notFoundTimer.current = null; }
                };
            }
        }, [id, txId, identity])
    );

    useEffect(() => {
        if (post?.author_pubkey) {
            getMemberRatings(post.author_pubkey).then(res => {
                setAuthorAvgRating(res.average);
                setAuthorRatingCount(res.count);
            }).catch(console.error);
        }
    }, [post?.author_pubkey]);

    useEffect(() => {
        if (!post) return;
        const isOwn = identity?.publicKey === post?.author_pubkey;
        const isPayerLocal = activeTx ? activeTx.buyer_pubkey === identity?.publicKey : ((post?.type === 'offer' && !isOwn) || (post?.type === 'need' && isOwn));
        const tPubkey = activeTx ? (isPayerLocal ? activeTx.seller_pubkey : activeTx.buyer_pubkey) : (isOwn ? post?.accepted_by : post?.author_pubkey);

        if (tPubkey) {
            getMemberRatings(tPubkey).then(res => {
                setTargetPeerAvgRating(res.average);
                setTargetPeerRatingCount(res.count);
            }).catch(console.error);
        }
    }, [post, activeTx, identity?.publicKey]);

    useEffect(() => {
        const targetPeer = activeTx 
            ? (activeTx.buyer_pubkey === identity?.publicKey ? activeTx.seller_pubkey : activeTx.buyer_pubkey)
            : (identity?.publicKey === post?.author_pubkey ? post?.accepted_by : post?.author_pubkey);
            
        if (identity?.publicKey && post?.id && targetPeer) {
            getUnreadCountForPost(post.id, identity.publicKey, targetPeer)
                .then(setUnreadCount)
                .catch(console.error);
        }
    }, [identity?.publicKey, post?.id, activeTx]);

    useEffect(() => {
        const txToRate = activeTx?.id || post?.pending_transaction_id;
        if (txToRate && identity?.publicKey) {
            (async () => {
                try {
                    const db = await getDb();
                    const existing = await db.getFirstAsync<any>(
                        "SELECT stars, comment FROM ratings WHERE transaction_id=? AND rater_pubkey=?",
                        [txToRate, identity.publicKey]
                    );
                    if (existing) {
                        setMyRating(existing.stars);
                        setRatingComment(existing.comment || '');
                        setHasExistingRating(true);
                    } else {
                        setMyRating(0);
                        setRatingComment('');
                        setHasExistingRating(false);
                    }
                } catch (e) {
                    console.error("[PostDetails] Failed to load existing rating:", e);
                }
            })();
        }
    }, [activeTx?.id, post?.pending_transaction_id, identity?.publicKey]);

    // Track whether the viewer still needs to list an Offer (Gate 1) and enterprises they operate.
    useEffect(() => {
        if (!identity?.publicKey) return;
        let cancelled = false;
        const key = identity.publicKey;
        // Gate 1 is a Beans rule and keeperOf an enterprises one: where both are in preview (the global node) the
        // reader's balance is never asked (utils/reads-own.ts).
        Promise.all([readsOwn('beans', key), readsOwn('enterprises', key)])
            .then(([beans, enterprises]) => (beans || enterprises ? getBalance(key) : null))
            .then(b => {
                if (!cancelled && b) {
                    setBlockedFromTrading(!!(b as any).isBlockedFromTrading);
                    const mine: string[] = Array.isArray((b as any).keeperOf) ? (b as any).keeperOf : [];
                    setOperatedTreasuries(mine);
                }
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [identity?.publicKey]);

    // What a standing take-up can pay now (core standingRoomOf), read only from the node's own balance read: the phone's
    // cached getBalance reads floor 0 when its copy is missing or stale, and would disable Agree on a guess. Unknown until
    // that read lands, and when it fails: Agree stays and the node checks (DESIGN-standing-deals-upfront-fable §3).
    const takesStanding = !!post && !!standingUnitForListing(post.price_type, post.price_c);
    useEffect(() => {
        setSpendRoom(null);
        if (!identity?.publicKey || !takesStanding) return;
        let cancelled = false;
        const key = identity.publicKey;
        readsOwn('beans', key)
            .then(beans => (beans ? refreshBalanceFromServer(key) : null))
            .then(fresh => { if (!cancelled) setSpendRoom(standingRoomOf(fresh)); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [identity?.publicKey, takesStanding]);

    if (!post) {
        if (!postMissing) {
            return (
                <View style={[styles.errorContainer, { paddingTop: insets.top }]}>
                    <ActivityIndicator size="large" />
                </View>
            );
        }
        return (
            <View style={[styles.errorContainer, { paddingTop: insets.top }]}>
                <Text style={styles.errorText}>{t('Post not found. It may have been expired by the Network.')}</Text>
                <Pressable accessibilityRole="button" onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); }} style={styles.closeBtn}>
                    <Text style={styles.closeBtnText}>{t('Return to Market')}</Text>
                </Pressable>
            </View>
        );
    }

    // Events have their own screen: no price, no escrow, RSVP instead of accept (docs/events-on-the-map.md §3).
    if (post.type === 'event') {
        return <EventDetail post={post} openMembership={hostLetsInDefault(nodeProfile?.features)} onLocalCommunity={nodeProfile?.profile === 'local'} pinsOn={pinsOn} />;
    }
    // A poll's page (slice C1, DESIGN-card-style-box-fable.md §2): the Market's compact row opens it. The page is the poll's
    // own card, as the web's is (MarketplacePage setSelectedPost), under this screen's Back: its answers, its Close Poll and its
    // ··· are here, and its author's name opens their profile (a profile from inside the item, Marty 4 Nov).
    if (post.type === 'poll') {
        const leave = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); };
        return (
            <View style={[styles.container, { paddingTop: insets.top }]} testID="poll-page">
                <View style={styles.header}>
                    <Pressable accessibilityRole="button" onPress={leave} style={styles.backButton}>
                        <Text style={styles.backText}>←</Text>
                        <Text style={{ color: colors.text.body, fontSize: 16, fontWeight: 'bold', marginLeft: 4, flexShrink: 1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Back')}</Text>
                    </Pressable>
                    <Text style={[styles.headerTitle, { flex: 1, textAlign: 'center' }]} numberOfLines={1}>{t('Poll')}</Text>
                    <View style={{ width: 68 }} />
                </View>
                <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
                    <PollCard
                        post={post}
                        currentPubkey={identity?.publicKey}
                        onVoteSuccess={() => { void getPost(post.id).then(p => { if (p) setPost(p); }); }}
                        informal={pollsInformal(nodeProfile)}
                        decisionsPreview={showcaseMode('decisions', reader.node, reader.reader) === 'preview'}
                        pinsOn={pinsOn}
                        onOpenProfile={(who) => router.push({ pathname: '/public-profile', params: { publicKey: who.publicKey, callsign: who.callsign } })}
                    />
                </ScrollView>
            </View>
        );
    }
    // A member's copy on the global community has its own screen, so nothing of a deal or a person can be drawn on one: no
    // price card, no author, no Message, no Accept (@beanpool/core eventCopyOf). The node refuses them all the same.
    if (eventCopyOf(post)) return <ListingCopyDetail post={post} />;

    const isOperatorOfAuthor = !!(post.author_pubkey && operatedTreasuries.includes(post.author_pubkey));
    const isOwnPost = identity?.publicKey === post.author_pubkey || isOperatorOfAuthor;
    const isPulsePost = (post.author_callsign || post.authorCallsign) === 'Daily Pulse';
    
    // --- Escrow Roles ---
    const isAcceptedByMe = activeTx 
        ? (activeTx.buyer_pubkey === identity?.publicKey || activeTx.seller_pubkey === identity?.publicKey) && !isOwnPost
        : (identity?.publicKey === post.accepted_by);
    const isPayer = activeTx
        ? (activeTx.buyer_pubkey === identity?.publicKey || (isOperatorOfAuthor && activeTx.buyer_pubkey === post.author_pubkey))
        : ((post.type === 'offer' && isAcceptedByMe) || (post.type === 'need' && isOwnPost));
    const isPayee = activeTx
        ? (activeTx.seller_pubkey === identity?.publicKey || (isOperatorOfAuthor && activeTx.seller_pubkey === post.author_pubkey))
        : ((post.type === 'offer' && isOwnPost) || (post.type === 'need' && isAcceptedByMe));
    const targetPeerCallsign = activeTx 
        ? (isPayer ? activeTx.seller_callsign || t('Peer') : activeTx.buyer_callsign || t('Peer'))
        : (isOwnPost ? (post.accepted_by_callsign || t('Peer')) : (post.author_callsign || post.author_pubkey?.slice(0, 6) || t('Unknown')));
    const targetPeerPubkey = activeTx
        ? (isPayer ? activeTx.seller_pubkey : activeTx.buyer_pubkey)
        : (isOwnPost ? post.accepted_by : post.author_pubkey);
    const targetPeerAvatar = activeTx 
        ? (isPayer ? activeTx.seller_avatar : activeTx.buyer_avatar)
        : (isOwnPost ? post.accepted_by_avatar : post.author_avatar);

    const isOffer = post.type === 'offer';
    // A lendable Offer is asked for, never taken in one step: the lender says yes first (the node refuses a one-step accept).
    const isLoan = isOffer && Boolean(post.lendable);
    const emoji = categoryEmoji(post.category);
    const cardAuthor = post.author_callsign || post.author_pubkey?.slice(0, 6) || t('Unknown');
    // A listing priced at 0 reads Free (core listing-price.ts, as on every card): a Need says "Free help wanted", and its label is
    // "Price", not "Willing to pay" over a figure that pays nothing. The words are the figure: no Beans icon, no unit.
    // `price_c`: whole hundredths of a Bean, or null when the phone holds no figure for it ("—", never Free).
    const freeWords = freePriceWords(post.price_c, post.type, 'box');
    const freeLabel = freePriceLabel(post.price_c, post.type);
    // An Offer priced for each one: the price box's three lines (core per-item.ts); null for any other listing.
    const eachBox = isOffer ? perItemCard(post) : null;
    const eachPrice = eachBox?.price ? <BeansText text={eachBox.price} style={styles.priceValue} accessibilityLabel={eachBox.label} testID="price-each" /> : null;
    const priceLabel = freeLabel ? upperCase(freeLabel) : isOffer ? t('ASKING PRICE') : t('WILLING TO PAY');
    // "I can do this" on a Need (cold start N4): the plain sentence under it, with the deal's own total (a price by the hour, day,
    // week or month is the price times the quantity typed) and the name the Need shows. No usable quantity yet: no sentence, and
    // never an amount that isn't one. The 1.5% fee is on the deal itself (the request card and the Payee's line), not here.
    // A standing deal (DESIGN-standing-deals-fable §2.2, §4; Marty, 9 Nov: the price unit decides it): a listing priced per
    // week or per month is taken up as one, its payer signing the authorisation. A standing Need's helper offers one period.
    // A free one (0 Beans: nothing to hold each period) stays a one-off deal, by core's one rule, as on the web.
    const standingUnit = standingUnitForListing(post.price_type, post.price_c);
    const standingOffer = !!standingUnit && post.type === 'offer' && !post.lendable;
    const standingNeed = !!standingUnit && post.type === 'need';
    const needQuantity = post.price_type !== 'fixed' ? parseAmount(standingNeed ? '1' : acceptHours, undefined, ANY_DECIMALS) : null;
    // A quantity of 0 is no usable quantity (as the web's acceptHoursValue > 0): it would read "for free" on a priced Need.
    // In whole hundredths: the price times the quantity as the node holds it (core dealAmountFor). A price the phone holds
    // no figure for gives no sentence, never "for free".
    const needTotal = !isHundredths(post.price_c) ? null
        : needQuantity === null ? post.price_c
        : needQuantity.ok && needQuantity.value > 0 ? dealAmountOrNull(post.price_c, needQuantity.value) : null;
    const needAnswerWords = !isOffer && needTotal !== null ? needAnswerLine(needTotal, post.author_callsign) : null;
    // Every deal on it the reader stands on (DESIGN-deals-fable §3.2, slice S4), by core's one rule, as on the web: its own
    // people (its author, or a keeper of the enterprise that wrote it) see a row for each deal under way, the one a door
    // named first; anyone else sees their own deal, or nothing of anyone else's.
    const me = identity?.publicKey || '';
    const deals = listingDeals(listingTxs, { id: post.id, authorPublicKey: post.author_pubkey, type: post.type, status: post.status }, me, operatedTreasuries);
    const pinnedTxId = Array.isArray(txId) ? txId[0] : txId;
    const ownRows = deals.own ? [...deals.held].sort((a, b) => Number(b.tx.id === pinnedTxId) - Number(a.tx.id === pinnedTxId)) : [];
    // The reader's own request, by core's one rule (dealMoves), as on the web: theirs to withdraw, a keeper's too (the node
    // lets a keeper ask for their enterprise's lendable Offer or offer to help with its Need), and never on its own people's
    // list to approve or deny as the enterprise. Every other request stays on that list, as it always did (an older row on
    // the phone can lack a side).
    const requestMoves = (r: any) => dealMoves({
        id: r.id, postId: post.id, status: r.status, buyerPublicKey: r.buyer_pubkey, sellerPublicKey: r.seller_pubkey,
        postAuthorPublicKey: post.author_pubkey, postType: post.type,
    }, me, operatedTreasuries);
    const toAnswer = requests.filter(r => !requestMoves(r)?.withdraw);
    const afterDealStep = () => { DeviceEventEmitter.emit('sync_data_updated'); };
    // A standing deal running on it shows its panel: nothing of it is held, so it is never a deal to release.
    const standingRunning = deals.standing.length > 0;
    const standingStep = async (step: () => Promise<unknown>) => {
        setAccepting(true);
        try {
            await step();
            requestSync().catch(console.error);
            afterDealStep();
        } catch (e: any) { hapticWarning(); Alert.alert(t('Error'), signedRequestWords(e.message)); } finally { setAccepting(false); }
    };
    // Agree (§2.2, §6): the payer's phone signs the authorisation (core builds the text and its bytes) and sends it with the
    // accept (an Offer) or the approval (a Need's author, paying the helper the request names).
    const takeUpStanding = async (choice: StandingChoice, payee: string, approveTxId?: string) => {
        if (!identity || !standingUnit || accepting) return;
        setAccepting(true);
        try {
            const standing = await signStandingStart(standingFieldsFor({
                // The listing's price exactly, whole hundredths: the node compares the signed figure with it and refuses a mismatch.
                listingId: post.id, payee, beansPerPeriod_c: post.price_c, unit: standingUnit, maxPeriods: choice.periods, startsAt: choice.startsAt,
            }));
            if (approveTxId) await approveMarketplaceRequest(approveTxId, identity.publicKey, standing);
            else await acceptMarketplacePost(post.id, identity.publicKey, undefined, standing);
            hapticSuccess();
            setShowAcceptConfirm(false);
            setApprovingStanding(null);
            if (approveTxId) setRequests(prev => prev.filter(r => r.id !== approveTxId));
            requestSync().catch(console.error);
            afterDealStep();
            // Then the chat with the one paid, as the phone's accept and approval of a one-off deal open it.
            try {
                const conv = await createConversationApi('dm', [payee, identity.publicKey], identity.publicKey, undefined, post.id);
                if (conv) router.replace(`/chat/${conv.id}`);
            } catch (chatError) {
                console.error('Failed to start chat after a standing deal began', chatError);
            }
        } catch (e: any) {
            hapticWarning();
            if (changedElsewhere(e, 'deal_open')) {
                Alert.alert(t('Already under way'), t('You already have a deal under way on this. Finish or cancel it first.'));
                requestSync().catch(console.error);
                setShowAcceptConfirm(false);
            } else {
                const x = explainTradeError(e);
                Alert.alert(x.title, x.message);
            }
        } finally { setAccepting(false); }
    };
    // Release where the reader pays, as themselves or, a keeper, at the enterprise's own door (routes/treasury.ts).
    const releaseRow = async (m: DealMoves) => {
        if (!identity) return;
        const hoursRead = post.price_type !== 'fixed' ? parseAmount(completeHours, undefined, ANY_DECIMALS) : null;
        if (hoursRead && !hoursRead.ok) { Alert.alert(t('Error'), amountRefusalWords(hoursRead.refusal)); return; }
        const finalHours = hoursRead?.ok ? hoursRead.value : undefined;
        setAccepting(true);
        try {
            if (m.asKeeper) await treasuryComplete(m.actingAs, m.tx.id!, finalHours);
            else await completeMarketplaceTransaction(m.tx.id!, me, finalHours);
            setShowCompleteConfirm(false);
            setReleaseRowId(null);
            hapticSuccess();
            afterDealStep();
            // The reader's own trade is theirs to rate, as the panel it replaces asked and the web asks; a keeper's is the
            // enterprise's. Release is the payer's, so the one to rate is the deal's seller.
            if (!m.asKeeper) setPromptReviewForTx({ txId: m.tx.id!, targetPubkey: m.tx.sellerPublicKey, targetCallsign: m.tx.sellerCallsign || t('Peer') });
        } catch (e: any) { hapticWarning(); Alert.alert(t('Error'), signedRequestWords(e.message)); } finally { setAccepting(false); }
    };
    const cancelRow = (m: DealMoves) => {
        Alert.alert(t('Cancel Transaction'), t('Return post to the market?'), [
            { text: t('No'), style: 'cancel' },
            { text: t('Yes, Cancel'), style: 'destructive', onPress: async () => {
                setAccepting(true);
                try {
                    await cancelMarketplaceTransaction(m.tx.id!, me);
                    afterDealStep();
                } catch (e: any) {
                    // Cancelled or released already, by its other side or another device: said so, as the panel says it, and
                    // the row taken off at once, not left to fail the same way. Not re-read from the phone's copy, which still
                    // holds it until the sync asked for here lands (and reloads the page).
                    if (changedElsewhere(e, 'transaction_gone')) {
                        Alert.alert(t('Already Updated'), t('This transaction was already cancelled or completed on another device. Your feed will automatically refresh.'));
                        setListingTxs(prev => prev.filter(tx => tx.id !== m.tx.id));
                        requestSync().catch(console.error);
                    } else {
                        Alert.alert(t('Error'), signedRequestWords(e.message));
                    }
                } finally { setAccepting(false); }
            } },
        ]);
    };
    // A deal's other side, from its row: the Message the panel it replaced had (a recurring listing has one for each).
    const messageRow = async (peer: string) => {
        if (!identity) return;
        try {
            const conv = await createConversationApi('dm', [peer, identity.publicKey], identity.publicKey, undefined, post.id);
            if (conv) { chatAboutDrafts.set(conv.id, aboutOfPost(post)); router.push(`/chat/${conv.id}`); }
        } catch (e: any) {
            Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Failed to start chat.'));
        }
    };
    // The time a payer confirms at Release, in the listing's unit and with what changing it does: the panel's and each
    // row's, one field (a bare number left a daily rate's payer guessing whether "8" was hours or days).
    const renderWorkedField = () => (
        <View style={{ marginBottom: 16 }}>
            <Text style={styles.confirmBoxLabel}>{confirmWorkedLabel(post.price_type)}</Text>
            <TextInput accessibilityLabel={t('Actual time worked')} style={styles.confirmBoxInput} value={completeHours} onChangeText={setCompleteHours} keyboardType="numeric" placeholder={t('e.g. {amount}', { amount: 2.5 })} placeholderTextColor={colors.text.muted} />
            <Text style={{ color: colors.text.secondary, fontSize: 12, textAlign: 'center', marginTop: 4, paddingHorizontal: 12 }}>
                {t('Adjust the final time up or down if the scope changed. The final credits released will be calculated automatically.')}
            </Text>
        </View>
    );
    // What Release moves on a deal, at its own rate for the time typed, and to whom (core releaseLine, as the web's panel and
    // rows say it): a Need's author who changes 3 days to 5 sees the 100 Beans that will go, not the 60 held.
    const renderReleaseLine = (deal: { amount_c?: number | null; hours?: number | null }, payee: string, testID: string) => (
        <Text testID={testID} style={{ color: colors.brand.primary, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 12 }}>
            {releaseLine(deal, { priceType: post.price_type, lendable: post.lendable },
                post.price_type !== 'fixed' ? parseAmount(completeHours, undefined, ANY_DECIMALS) : null, payee)}
        </Text>
    );
    const renderOwnDeal = (m: DealMoves) => {
        const tx = m.tx;
        const payer = tx.buyerPublicKey === m.actingAs;
        const otherName = (payer ? tx.sellerCallsign : tx.buyerCallsign) || t('Peer');
        const otherKey = payer ? tx.sellerPublicKey : tx.buyerPublicKey;
        const unread = rowUnread[tx.id!] ?? 0;
        const confirming = showCompleteConfirm && releaseRowId === tx.id;
        const since = tx.createdAt ? formatDate(new Date(tx.createdAt), 'day-month') : '';
        return (
            <View key={tx.id} testID={`deal-row-${tx.id}`} style={{ borderWidth: 1, borderColor: tx.id === pinnedTxId ? colors.brand.primary : colors.border.default, borderRadius: SHELL.radius, padding: SHELL.textPadding, gap: 8, marginBottom: 8 }}>
                <Text style={{ color: colors.text.heading, fontSize: 14, fontWeight: '700' }}>
                    {listingDealLines.heldRow(otherName, (tx as any).amount_c ?? 0, since)}
                </Text>
                {!m.release && (
                    <Text style={{ color: colors.feedback.warning.fg, fontSize: 13, fontWeight: '700' }}>
                        {t('⏳ Pending Release by {name}', { name: otherName })}
                    </Text>
                )}
                {m.release && (confirming ? (
                    <View style={styles.confirmBox}>
                        {post.price_type !== 'fixed' && renderWorkedField()}
                        {renderReleaseLine({ amount_c: (tx as any).amount_c ?? null, hours: (tx as any).hours ?? null }, otherName, `release-line-${tx.id}`)}
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            <Pressable accessibilityRole="button" style={styles.cancelActionBtn} onPress={() => { setShowCompleteConfirm(false); setReleaseRowId(null); }} disabled={accepting}>
                                <Text style={styles.cancelActionBtnText} numberOfLines={1}>{t('Cancel')}</Text>
                            </Pressable>
                            <Pressable accessibilityRole="button" style={[styles.confirmActionBtn, styles.confirmActionBtnGreen]} disabled={accepting || (post.price_type !== 'fixed' && !completeHours)} onPress={() => releaseRow(m)}>
                                <Text style={styles.confirmActionBtnText}>{accepting ? t('Processing...') : t('Release Beans')}</Text>
                            </Pressable>
                        </View>
                    </View>
                ) : (
                    <Pressable accessibilityRole="button" style={[styles.acceptBtn, styles.acceptBtnOffer]} onPress={() => { setReleaseRowId(tx.id!); setShowCompleteConfirm(true); if (post.price_type !== 'fixed') setCompleteHours((tx as any).hours ? formatNumber((tx as any).hours) : '1'); }}>
                        <Text style={styles.acceptBtnText}>{t('✅ Release Beans')}</Text>
                    </Pressable>
                ))}
                {m.cancelHold && (
                    <Pressable accessibilityRole="button" accessibilityHint={t('Cancels the transaction and returns the post to the market')} style={styles.cancelTxBtn} disabled={accepting} onPress={() => cancelRow(m)}>
                        <Text style={styles.cancelTxBtnText}>{t('❌ Cancel Trust Hold')}</Text>
                    </Pressable>
                )}
                {!!otherKey && otherKey !== me && (
                    <Pressable accessibilityRole="button" style={styles.messageBtn} onPress={() => messageRow(otherKey)}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                            <Text style={styles.messageBtnText}>{t('💬 Message {name}', { name: otherName })}</Text>
                            {unread > 0 && (
                                <View style={styles.unreadBadge}>
                                    <Text style={styles.unreadBadgeText}>{unread}</Text>
                                </View>
                            )}
                        </View>
                    </Pressable>
                )}
            </View>
        );
    };

    let photos: string[] = [];
    if (post.photos) {
        try {
            const parsed = Array.isArray(post.photos) ? post.photos : JSON.parse(post.photos);
            photos = parsed.filter((p: any) => typeof p === 'string' && p.length > 0);
        } catch {}
    }

    const startEdit = () => {
        setEditType(post.type);
        setEditCategory(post.category);
        editTagsFrom.current = postTagsOf(post.tags);
        setEditTags(editTagsFrom.current);
        editFreeTagsFrom.current = listingFreeTags(post);
        setEditFreeTags(editFreeTagsFrom.current);
        setEditTitle(post.title);
        setEditDescription(post.description || '');
        // In the language's way ("12,50"), so it reads back as the same price (core parseHundredths).
        setEditCredits(priceAsTyped(post.price_c));
        setEditPriceType(post.price_type || 'fixed');
        setEditRepeatable(!!post.repeatable);
        setEditPhotos(photos);
        setEditMode(true);
        // A member's own Offer for everyone here can go in their shop: the toggle starts where the node says it is now, and
        // shows nothing while that can't be read (an enterprise's shop is a later slice).
        setEditShop({ kind: 'hidden' });
        setEditInShop(false);
        const scope = post.audience_scope ?? post.audienceScope ?? 'public';
        if (post.type === 'offer' && post.author_pubkey === identity?.publicKey && scope === 'public' && !post.origin_node
            && !(post.target_group_id ?? post.targetGroupId) && !(post.target_pubkey ?? post.targetPubkey)) {
            void Promise.all([readMyShop(), readListingShopId(post.id)]).then(([mine, inShopId]) => {
                if (inShopId === undefined) return;
                const inShop = mine.state === 'open' && inShopId === mine.shop.id;
                setEditShop(shopToggleState(mine, { inShop }));
                setEditInShop(inShop);
            });
        }
    };

    const handleSave = async () => {
        if (!editTitle.trim()) { Alert.alert(t('Error'), t('Title is required')); return; }
        if (photos.length > 0 && editPhotos.length === 0) { Alert.alert(t('Error'), t('Add a photo first')); return; }
        // The price in the language's decimal mark, as whole hundredths (core parseHundredths): fr "12,5" is 1250, never saved
        // as 0, and never past two decimals (the one rule everywhere). An empty box is 0, as before.
        const price = showsBeans ? parseHundredths(editCredits) : null;
        if (price && !price.ok && price.refusal !== 'empty') { Alert.alert(t('Error'), amountRefusalWords(price.refusal)); return; }
        setSaving(true);
        try {
            // Its shop: in, out (a Need never stays in one), or left as it is; a shop the member has none of yet is opened first.
            const startedIn = (editShop.kind === 'open' || editShop.kind === 'paused') && editShop.inShop;
            const shopId = await shopIdForEdit(editShop, startedIn, editType === 'offer' && editInShop);
            const tagsChanged = storedPostTags(editTags) !== storedPostTags(editTagsFrom.current);
            const freeTagsChanged = storedFreeTags(editFreeTags) !== storedFreeTags(editFreeTagsFrom.current);
            await updatePost(post.id, {
                type: editType,
                category: editCategory,
                ...(tagsChanged ? { tags: editTags } : {}),
                ...(freeTagsChanged ? { freeTags: editFreeTags } : {}),
                title: editTitle.trim(),
                description: editDescription.trim(),
                price_c: price?.ok ? price.value : 0,
                price_type: editPriceType,
                repeatable: editRepeatable,
                photos: editPhotos.length > 0 ? JSON.stringify(editPhotos) : null,
                ...(shopId !== undefined ? { shopId } : {}),
            });
            // Refresh the post
            const updated = await getPost(post.id);
            setPost(updated);
            setEditMode(false);
        } catch (e: any) {
            // The node's own words when it gave any: a price held by an open deal says so, and how to change it.
            Alert.alert(t('Error'), e?.message ? signedRequestWords(String(e.message)) : t('Failed to save changes'));
        }
        setSaving(false);
    };

    const handleToggleActive = async () => {
        if (!post || toggling) return;
        const willPause = post.status === 'active';
        setToggling(true);
        try {
            if (willPause) await pausePost(post.id);
            else await resumePost(post.id);
            setPost({ ...post, status: willPause ? 'paused' : 'active' });
        } catch (e: any) {
            Alert.alert(t('Error'), e?.message ? signedRequestWords(String(e.message)) : t('Failed to update offer'));
        } finally {
            setToggling(false);
        }
    };

    const handleDelete = () => {
        Alert.alert(t('Delete Post'), t('Are you sure you want to delete this post?'), [
            { text: t('Cancel'), style: 'cancel' },
            { text: t('Delete'), style: 'destructive', onPress: async () => {
                setDeleting(true);
                try {
                    await deletePost(post.id);
                    if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                } catch (e) {
                    Alert.alert(t('Error'), t('Failed to delete post'));
                    setDeleting(false);
                }
            }},
        ]);
    };

    const myRequest = requests.find(r => requestMoves(r)?.withdraw);

    const handleApprove = async (transactionId: string) => {
        if (!identity) return;
        setAccepting(true);
        try {
            if (isOperatorOfAuthor) {
                await treasuryApprove(post.author_pubkey, transactionId);
            } else {
                await approveMarketplaceRequest(transactionId, identity.publicKey);
            }
            const updated = await getPost(post.id);
            setPost(updated);
            hapticSuccess();
            Alert.alert(t('Approved'), t('Funds locked in trust successfully.'));
            
            // Route to chat with requester
            const req = requests.find(r => r.id === transactionId);
            const peerPubkey = req ? (post.type === 'need' ? req.seller_pubkey : req.buyer_pubkey) : null;
            if (peerPubkey) {
                try {
                    const conv = await createConversationApi('dm', [peerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                    if (conv) router.replace(`/chat/${conv.id}`);
                } catch (e) {
                    // Chat failed, fallback is normal UI refresh
                    console.error('Failed to create chat on approve', e);
                }
            }
        } catch (e: any) { hapticWarning(); Alert.alert(t('Error'), signedRequestWords(e.message)); }
        setAccepting(false);
    };

    const handleReject = (transactionId: string) => {
        setRejectMessage('');
        setRejectModalTxId(transactionId);
    };
    
    const confirmReject = async () => {
        if (!identity || !rejectModalTxId) return;
        setAccepting(true);
        try {
            const req = requests.find(r => r.id === rejectModalTxId);
            const peerPubkey = req ? (post.type === 'need' ? req.seller_pubkey : req.buyer_pubkey) : null;
            
            if (isOperatorOfAuthor) {
                await treasuryReject(post.author_pubkey, rejectModalTxId);
            } else {
                await rejectMarketplaceRequest(rejectModalTxId, identity.publicKey);
            }
            
            // The optional message goes as a message in the DM, locked like any other. It used to ride as the new
            // conversation's name, where the node could read it (and was dropped when the two already had a chat).
            if (rejectMessage.trim() && peerPubkey) {
                const words = rejectMessage.trim();
                let convId: string | null = null;
                try {
                    const conv = await createConversationApi('dm', [peerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                    convId = conv?.id ?? null;
                    if (!convId) throw new Error(t('The chat could not be opened.'));
                    await insertMessage(convId, identity.publicKey, words);
                } catch (e: any) {
                    // The offer is declined either way. The words are not lost: the chat opens with them in the box.
                    console.error('Failed to send the decline message', e);
                    if (convId) {
                        Alert.alert(t('Offer declined'), isDmNotLocked(e)
                            ? dmNotLockedLine(null)
                            : t("Your message wasn't sent. It's in the chat, ready to send again."));
                        router.push({ pathname: '/chat/[id]', params: { id: convId, prefill: words } });
                    } else {
                        Alert.alert(t('Offer declined'), e?.message
                            ? t("Your message wasn't sent: {reason}", { reason: signedRequestWords(e.message) })
                            : t("Your message wasn't sent: the chat could not be opened"));
                    }
                }
            }
            
            // From both lists: a keeper's requests are the enterprise's, read for it from the node (keptRequests).
            setRequests(prev => prev.filter(r => r.id !== rejectModalTxId));
            setKeptRequests(prev => prev.filter(r => r.id !== rejectModalTxId));
            setRejectModalTxId(null);
            hapticSuccess();
        } catch (e: any) { Alert.alert(t('Error'), signedRequestWords(e.message)); }
        setAccepting(false);
    };

    const handleWithdraw = async () => {
        if (!identity || !myRequest) return;
        setAccepting(true);
        try {
            await cancelMarketplaceRequest(myRequest.id, identity.publicKey);
            setRequests(prev => prev.filter(r => r.id !== myRequest.id));
            setKeptRequests(prev => prev.filter(r => r.id !== myRequest.id));
        } catch (e: any) { Alert.alert(t('Error'), signedRequestWords(e.message)); }
        setAccepting(false);
    };

    // The reader's own request waiting (one who asked, a keeper on their enterprise's listing too): whom it waits on, what it
    // commits, and Withdraw, theirs.
    const renderMyRequest = (req: any) => (
        <View style={styles.confirmBox}>
            <Text style={[styles.confirmBoxTitle, { color: colors.brand.primary }]}>{isLoan ? t('Asked to borrow') : t('Deal Established')}</Text>
            {(isLoan || !isOffer) && (
                <Text style={{ color: colors.text.heading, fontSize: 14, fontWeight: '700', textAlign: 'center', marginBottom: 6 }}>
                    {isLoan ? listingDealLines.askedToBorrow(cardAuthor) : listingDealLines.offeredToHelp(cardAuthor)}
                </Text>
            )}
            <Text style={{ color: theme === 'dark' ? colors.text.secondary : palette.gray600, fontSize: 13, textAlign: 'center', marginBottom: 12 }}>
                {isLoan ? (
                    t('Nothing is held until the lender says yes.')
                ) : isOffer ? (
                    req.hours
                        ? committedOfferWords(dealQuantityUnit(post.price_type), req.hours, req.amount_c)
                        : t('You have committed {credits} credits to a Trust Wallet for this offer.', { credits: formatHundredths(req.amount_c) })
                ) : (
                    <Sentence
                        text={req.hours
                            ? requestedNeedWords(dealQuantityUnit(post.price_type, post.lendable), req.hours, req.amount_c)
                            : t('You have requested to earn {credits} credits ({net} net after 1.5% transaction fee) {owned} for fulfilling this need.', { credits: formatHundredths(req.amount_c), net: netWords(req.amount_c) })}
                        parts={{ owned: <Text style={{ color: colors.brand.primary, fontWeight: 'bold' }}>{t('(100% community owned)')}</Text> }}
                    />
                )}
            </Text>
            <Pressable accessibilityRole="button" style={[styles.cancelActionBtn, { width: '100%' }]} onPress={handleWithdraw} disabled={accepting}>
                <Text style={styles.cancelActionBtnText}>{accepting ? t('Withdrawing...') : t('Withdraw Request')}</Text>
            </Pressable>
        </View>
    );

    const pickEditPhoto = () => {
        if (editPhotos.length >= 5) return;
        askForPostPhoto((photo) => {
            setEditPhotos(prev => (prev.length < 5 ? [...prev, photo] : prev));
        });
    };

    const goBack = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); };

    // The peer's part of the page, as one condition (it was one block): the rating with the action, Message in the quiet row,
    // the convenor's box and Report at the foot. Message is not drawn where the deal's own box has it (a deal pending to them).
    const peerActions = !!identity && ((!isOwnPost && !isPulsePost) || post.status === 'pending' || post.status === 'completed' || !!activeTx);
    const peerMessage = peerActions && !!targetPeerPubkey && !((post.status === 'pending' || activeTx?.status === 'pending') && (isPayer || isPayee));
    // The take-up on the first screen (DESIGN-detail-pages-frame-fable.md §2): the note under IN RETURN runs to seven or eight
    // lines at 320 dp and 1.3x (the worldwide community's, which says what a local community does), so it clamps to three with
    // "More", the frame's first fallback (§1.7). Only where it would run to six lines or more: below that, three lines and a 48 dp
    // More are no shorter than the note. The lines are estimated as the page's own tests lay text out, half the font size a
    // character across the box's inner width.
    const termsNote = noBeansTermsNote(beansPreview);
    const termsNoteLines = Math.ceil(termsNote.length / Math.max(1, (screenWidth - 32 - 2 * (SHELL.textPadding + SHELL.borderWidth)) / (13 * (fontScale || 1) * 0.5)));
    const termsNoteClamped = !termsNoteOpen && termsNoteLines >= 6;

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Header */}
            <View style={styles.header}>
                <Pressable accessibilityRole="button" onPress={goBack} style={styles.backButton}>
                    <Text style={styles.backText}>←</Text>
                    <Text style={{ color: colors.text.body, fontSize: 16, fontWeight: 'bold', marginLeft: 4, flexShrink: 1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Back')}</Text>
                </Pressable>
                <Text style={[styles.headerTitle, { flex: 1, textAlign: 'center' }]} numberOfLines={1}>{isOffer ? t('Offer') : t('Need')}</Text>
                <View style={{ width: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
                    {showPinMenu({ pinsOn, role: pinRole, pinned: isPostPinned(post), isAuthor: isOwnPost }) && (
                        <Pressable
                            testID="post-menu-btn"
                            accessibilityRole="button"
                            accessibilityLabel={t('Post options')}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{ width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}
                            onPress={handlePostOptions}
                        >
                            <Text style={{ fontSize: 22, color: colors.text.body, fontWeight: '900' }}>···</Text>
                        </Pressable>
                    )}
                </View>
            </View>

            {/* No keyboardVerticalOffset: this screen draws its own header (no navigation header), and keyboard-controller
                already measures this view's frame, so an offset only adds that many dp of blank space above the keyboard. */}
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
            <ScrollView ref={scrollViewRef} {...keepCaretVisible} contentContainerStyle={[styles.scroll, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 60 : 60 }]} keyboardShouldPersistTaps="handled">
                {/*
                  * The page's parts in DESIGN-detail-pages-fable.md §2.1's order, as DESIGN-detail-pages-frame-fable.md §1.7 and §3 amend it,
                  * the event page's (components/EventDetail.tsx): the chips, the title, the terms box, the whole action area, the photo, the
                  * quiet row, the description, the person, the rest, Report. The action is on the first screen: at 320 x 569 and 1.3x text
                  * the take-up's top is at or above 500 dp and its bottom on the screen (post-listing-states-render.test.ts, the stop).
                  * Only where each part is drawn changed: the deal logic, its states and their words are as they were.
                  */}
                {/* 1. The chip row and the time: the list card's own chips, in its order (components/market-card-shell.ts), "3d ago" at the right. */}
                <View style={styles.chipLine} testID="post-chip-row">
                    <View style={[shell.chipRow, styles.chipLineChips]}>
                        {isPulsePost ? (
                            <CardChip shell={shell} role="warn" label={t('🗞️ DAILY PULSE')} testID="post-type-chip" />
                        ) : (
                            <CardChip shell={shell} role={isOffer ? 'offer' : 'need'} label={isOffer ? t('OFFER') : t('NEED')} testID="post-type-chip" />
                        )}
                        {isPostPinned(post) && <CardChip shell={shell} role="pinned" label={t('📌 PINNED')} testID="pinned-chip" />}
                        {!isPulsePost && <CardChip shell={shell} role="quiet" label={emoji + ' ' + categoryLabel(post.category)} testID="post-category-chip" />}
                        {!!post.repeatable && <CardChip shell={shell} role="quiet" label={t('↻ RECURRING')} testID="post-recurring-chip" />}
                        {post.cash_also_needed === 1 && <CardChip shell={shell} role="warn" label={t('💸 CASH TOO')} />}
                        {post.status === 'paused' && <CardChip shell={shell} role="warn" label={t('⏸ PAUSED')} />}
                    </View>
                    <Text style={styles.timeAgo} numberOfLines={1}>{getTimeAgo(post.created_at)}</Text>
                </View>
                {isPostPinned(post) && (
                    <View style={{ marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }} testID="pinned-detail-line">
                        <Text style={{ fontSize: 13, color: colors.text.secondary, fontWeight: '600', flex: 1 }} numberOfLines={2}>
                            {pinnedDetailLine(post)}
                        </Text>
                        {isOwnPost && (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Take the pin off')}
                                testID="author-unpin-btn"
                                onPress={async () => {
                                    if (unpinning) return;
                                    setUnpinning(true);
                                    try {
                                        await unpinPostOnNode(post.id);
                                        const updated = await getPost(post.id);
                                        if (updated) setPost(updated);
                                    } catch (e: any) {
                                        Alert.alert(t('Error'), pinFailureText(e, t('Failed to unpin post')));
                                    } finally {
                                        setUnpinning(false);
                                    }
                                }}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                            >
                                <Text style={{ fontSize: 12, fontWeight: '700', color: colors.feedback.danger.fg }}>{t('Take the pin off')}</Text>
                            </Pressable>
                        )}
                    </View>
                )}
                {/* #108: the detail view is where the terms get discussed, so say what the flag means
                    rather than just badging it. No amount — that's agreed in chat. */}
                {post.cash_also_needed === 1 && (
                    <View style={{ backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 10 }}>
                        <Text style={{ color: colors.feedback.warning.fg, fontSize: 12, lineHeight: 17 }}>
                            <Sentence
                                text={t('💸 {cash} for fuel or materials, at cost. Time and tools are beans. Agree the details in chat — the app never handles the money.')}
                                parts={{ cash: <Text style={{ fontWeight: '700' }}>{t('Cash also needed')}</Text> }}
                            />
                        </Text>
                    </View>
                )}

                {/* Audience Scope Banner (Item 10) */}
                {(post.audience_scope === 'group' || post.audienceScope === 'group' || !!post.target_group_id || !!post.targetGroupId) && (
                    <View style={{ backgroundColor: colors.brand.tint, borderColor: colors.brand.primary, borderWidth: 1.5, borderRadius: 12, padding: 12, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <MaterialCommunityIcons name="lock" size={18} color={colors.brand.primary} />
                        <Text style={{ fontSize: 13, fontWeight: '800', color: colors.brand.primary, flex: 1 }}>
                            {post.target_group_name || post.targetGroupName
                                ? t('Only {group} can see this', { group: post.target_group_name || post.targetGroupName })
                                : t('Only group members can see this')}
                        </Text>
                    </View>
                )}

                {/* 4. The loud line: the title. */}
                <Text style={styles.postTitle} testID="post-title">{post.title}</Text>

                {/*
                  * 6. The terms box (§2.2): the label in small capitals, the value under it, left-aligned, on the style box's page box. Where
                  * there are no Beans, what the poster would like in return is in the description. The words are one element to a screen
                  * reader; the marker's line sits beside them, in the box but outside that group, so VoiceOver reads it and reaches it as a
                  * button (review of #1852, finding 8).
                  */}
                {!isPulsePost && !showsBeans && (
                    <View style={[shell.pageBox, styles.termsBox]} testID="no-beans-terms">
                        <View accessible accessibilityLabel={t('{terms}. {note}', { terms: t(NO_BEANS_TERMS.value), note: noBeansTermsNote(beansPreview) })}>
                            <Text style={[shell.boxLabel, styles.termsLabel]}>{t(NO_BEANS_TERMS.label)}</Text>
                            <Text style={styles.termsValue}>{t(NO_BEANS_TERMS.value)}</Text>
                            <Text style={styles.termsNote} testID="no-beans-terms-note" numberOfLines={termsNoteClamped ? 3 : undefined}>{termsNote}</Text>
                        </View>
                        {/* The rest of the note: the words above are read whole to a screen reader; this shows them whole. */}
                        {termsNoteClamped && (
                            <Pressable onPress={() => setTermsNoteOpen(true)} style={styles.termsMore} accessibilityRole="button" accessibilityState={{ expanded: false }} testID="no-beans-terms-more">
                                <Text style={styles.termsMoreText}>{t('More', undefined, 'show the rest of a text')}</Text>
                            </Pressable>
                        )}
                        {beansPreview && <LocalCommunityMark variant="line" feature="beans" text={t(LOCAL_COMMUNITY_LINES.price)} />}
                    </View>
                )}
                {!isPulsePost && showsBeans && (
                    <View style={[shell.pageBox, styles.termsBox]} testID="price-terms">
                        <Text style={[shell.boxLabel, styles.termsLabel]}>{priceLabel}</Text>
                        <View style={styles.priceRow}>
                            {freeWords ? <Text style={styles.priceValue} testID="price-free">{freeWords}</Text> : eachPrice ?? <>
                            <CurrencyDisplay amount={formatHundredths(post.price_c)} style={styles.priceValue} asView={true} />
                            {/* The unit, a space after the amount: " / Hr". */}
                            <Text style={styles.priceUnit}>{priceUnitWords(post.price_type) ? ` ${priceUnitWords(post.price_type)}` : ''}</Text>
                            </>}
                        </View>
                        {/* An Offer priced for each one (DESIGN-per-item-price-fable.md §2.2): how many are left, then the price for all of
                            them while it is on offer, each its own line. */}
                        {!!eachBox && <Text style={styles.termsNote} testID="price-each-stock">{eachBox.stock}</Text>}
                        {!!eachBox?.boxLot && <Text style={styles.termsNote} testID="price-each-lot">{eachBox.boxLot}</Text>}
                    </View>
                )}

                {/*
                  * 7. The action, the whole area as one block, right under the terms box (§2.4; DESIGN-detail-pages-frame-fable.md §1.7):
                  * the deal an alert named, a deal under way, the author's own tools, the take-up and its confirmation, the requests, and
                  * the rating once a deal is done. Each part is drawn as it was, only here, above the photo.
                  */}
                {/* The deal an alert named, when it is over: what became of it, above the listing as it stands for the reader now.
                    Not once the reader has taken the listing up again (a deal of their own held or asked for: no take-up left,
                    and not its own people): that deal's box is the page, as on the web. */}
                {!!pinnedOver && !!listingDealLines.finished(pinnedOver) && (deals.own || deals.canTakeUp) && (
                    <Text testID="pinned-deal-over" style={{ color: colors.text.secondary, fontSize: 14, fontWeight: '600', textAlign: 'center', marginTop: 12 }}>
                        {listingDealLines.finished(pinnedOver)}
                    </Text>
                )}

                {/* A standing deal running on it, one panel for each the reader stands on (design §3): Stop and Message. */}
                {deals.standing.map(m => {
                    const other = m.tx.buyerPublicKey === m.actingAs ? m.tx.sellerPublicKey : m.tx.buyerPublicKey;
                    const otherName = (m.tx.buyerPublicKey === m.actingAs ? m.tx.sellerCallsign : m.tx.buyerCallsign) || t('Peer');
                    return (
                        <StandingPanel key={m.tx.id} tx={m.tx as any} actingAs={m.actingAs} busy={accepting}
                            onStop={() => standingStep(() => stopStandingDeal(m.tx.standingId!))}
                            onMessage={m.asKeeper ? undefined : () => messageRow(other)}
                            messageLabel={t('Message {name}', { name: otherName })} />
                    );
                })}

                {/* 1. Pending Escrow State (Applies to both Payer and Payee) */}
                {ownRows.length === 0 && !standingRunning && (post.status === 'pending' || activeTx?.status === 'pending') && (isPayer || isPayee) && (
                    <View style={styles.ownPostActions}>
                        {isPayer ? (
                            <>
                                {/* The taker's line (design §3.2): never the author's (on a Need the author pays), and only with the
                                    deal's own date, never the post's while the deals are still loading. */}
                                {!isOwnPost && !!(activeTx?.created_at || activeTx?.createdAt) && (
                                    <Text style={{ color: colors.brand.primary, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4 }}>
                                        {t('✅ You took this up on {date} · {n} Beans held in trust', {
                                            date: formatDate(new Date(activeTx.created_at || activeTx.createdAt), 'day-month'),
                                            n: formatHundredths(activeTx.amount_c ?? post.price_c),
                                        })}
                                    </Text>
                                )}
                                <Text style={{ color: colors.text.secondary, fontSize: 11, textAlign: 'center', marginBottom: post.type === 'offer' && !!post.repeatable ? 4 : 12, paddingHorizontal: 16 }}>
                                    {t("Release the Beans when it's done.")}
                                </Text>
                                {post.type === 'offer' && !!post.repeatable && (
                                    <Text style={{ color: colors.text.secondary, fontSize: 11, textAlign: 'center', marginBottom: 12, paddingHorizontal: 16 }}>
                                        {t('You can take it up again once this one is done.')}
                                    </Text>
                                )}
                                
                                {showCompleteConfirm ? (
                                    <View style={styles.confirmBox}>
                                        <Text style={styles.confirmBoxTitle}>{t('Finalize Transaction')}</Text>
                                        {post.price_type !== 'fixed' && renderWorkedField()}
                                        {/* The deal's own rate; the listing's price while the deal is still loading. */}
                                        {renderReleaseLine(activeTx ?? { amount_c: post.price_c, hours: 1 }, targetPeerCallsign, 'release-line-panel')}
                                        <View style={{ flexDirection: 'row', gap: 10 }}>
                                            <Pressable accessibilityRole="button" style={styles.cancelActionBtn} onPress={() => setShowCompleteConfirm(false)} disabled={accepting}>
                                                <Text style={styles.cancelActionBtnText} numberOfLines={1}>{t('Cancel')}</Text>
                                            </Pressable>
                                            <Pressable accessibilityRole="button" style={[styles.confirmActionBtn, styles.confirmActionBtnGreen]} disabled={accepting || (post.price_type !== 'fixed' && !completeHours)} onPress={async () => {
                                                const txToComplete = activeTx?.id || post.pending_transaction_id;
                                                if (!txToComplete) {
                                                    Alert.alert(t('Loading'), t('Trust transaction details are still loading. Please wait a moment and try again.'));
                                                    return;
                                                }
                                                if (!identity) return;
                                                // Hours in the language's decimal mark (core parseAmount): fr "2,5" is 2.5, never sent as no hours.
                                                const hoursRead = post.price_type !== 'fixed' ? parseAmount(completeHours, undefined, ANY_DECIMALS) : null;
                                                if (hoursRead && !hoursRead.ok) { Alert.alert(t('Error'), amountRefusalWords(hoursRead.refusal)); return; }
                                                const finalHours = hoursRead?.ok ? hoursRead.value : undefined;
                                                setAccepting(true);
                                                try {
                                                    if (isOperatorOfAuthor) {
                                                        await treasuryComplete(post.author_pubkey, txToComplete, finalHours);
                                                    } else {
                                                        await completeMarketplaceTransaction(txToComplete, identity.publicKey, finalHours);
                                                    }
                                                    setShowCompleteConfirm(false);
                                                    
                                                    const targetPubkey = isPayer ? (activeTx?.seller_pubkey || post.accepted_by) : (activeTx?.buyer_pubkey || post.author_pubkey);
                                                    setPromptReviewForTx({ 
                                                        txId: txToComplete, 
                                                        targetPubkey, 
                                                        targetCallsign: targetPeerCallsign 
                                                    });
                                                    hapticSuccess();
                                                } catch(e: any) { hapticWarning(); Alert.alert(t('Error'), signedRequestWords(e.message)); } finally { setAccepting(false); }
                                            }}>
                                                <Text style={styles.confirmActionBtnText}>{accepting ? t('Processing...') : t('Release Beans')}</Text>
                                            </Pressable>
                                        </View>
                                    </View>
                                ) : (
                                    <Pressable accessibilityRole="button" style={[styles.acceptBtn, styles.acceptBtnOffer]} onPress={() => { setShowCompleteConfirm(true); if(post.price_type !== 'fixed' && !completeHours) setCompleteHours(activeTx?.hours ? formatNumber(activeTx.hours) : '1'); }}>
                                        <Text style={styles.acceptBtnText}>{t('✅ Release Beans')}</Text>
                                    </Pressable>
                                )}
                            </>
                        ) : (
                            <>
                                {/* The helper's line (design §3.2): the Beans are held for them, with the deal's own amount (none on a free Need). */}
                                {!isOwnPost && !!activeTx && (
                                    <Text style={{ color: colors.brand.primary, fontSize: 13, fontWeight: '700', textAlign: 'center', marginTop: 8 }}>
                                        {listingDealLines.helping(activeTx.amount_c ?? 0)}
                                    </Text>
                                )}
                                <Text style={{ color: colors.feedback.warning.fg, fontSize: 13, fontWeight: '700', textAlign: 'center', marginTop: 8, marginBottom: 8 }}>
                                    {t('⏳ Pending Release by {name}', { name: targetPeerCallsign })}
                                </Text>
                                <View style={{ paddingHorizontal: 16, marginBottom: 16, gap: 8 }}>
                                    <Text style={{ color: colors.text.body, fontSize: 14, textAlign: 'center', fontWeight: '600', lineHeight: 20 }}>
                                        <Sentence
                                            text={t('You are the Payee. Fulfill the terms exactly as agreed, then ask the Payer to release your credits. You will receive the net amount minus 1.5% transaction fee {owned} (retained to balance the pool).')}
                                            parts={{ owned: <Text style={{ color: colors.brand.primary, fontWeight: 'bold' }}>{t('(100% community owned)')}</Text> }}
                                        />
                                    </Text>
                                    <View style={{ backgroundColor: colors.feedback.danger.bg, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.feedback.danger.border }}>
                                        <Text style={{ color: colors.feedback.danger.fg, fontSize: 13, textAlign: 'center', fontWeight: '700' }}>
                                            {t('Note: If this post is still visible here, you have not yet received your credits.')}
                                        </Text>
                                    </View>
                                </View>
                            </>
                        )}
                        
                        {/* Escrow Communication and Cancellation Actions */}
                        <View style={{ marginTop: 16, borderTopWidth: 1, borderTopColor: colors.border.default, paddingTop: 16, gap: 12 }}>
                            {targetPeerPubkey && (
                                <Pressable accessibilityRole="button" style={styles.messageBtn} onPress={async () => {
                                    if (!identity) return;
                                    try {
                                        const conv = await createConversationApi('dm', [targetPeerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                                        if (conv) { chatAboutDrafts.set(conv.id, aboutOfPost(post)); router.push(`/chat/${conv.id}`); }
                                    } catch (e: any) {
                                        Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Failed to start chat.'));
                                    }
                                }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                                        <Text style={styles.messageBtnText}>{t('💬 Message {name}', { name: targetPeerCallsign })}</Text>
                                        {unreadCount > 0 && (
                                            <View style={styles.unreadBadge}>
                                                <Text style={styles.unreadBadgeText}>{unreadCount}</Text>
                                            </View>
                                        )}
                                    </View>
                                </Pressable>
                            )}

                            {/* Never for a keeper: the node has no door for one to cancel the enterprise's hold (routes/treasury.ts). */}
                            {!isOperatorOfAuthor && (
                            <Pressable accessibilityRole="button" accessibilityHint={t('Cancels the transaction and returns the post to the market')} style={styles.cancelTxBtn} disabled={accepting} onPress={() => {
                                const txToCancel = activeTx?.id || post.pending_transaction_id;
                                if (!txToCancel) {
                                    Alert.alert(t('Loading'), t('Trust transaction details are still loading. Please wait a moment and try again.'));
                                    return;
                                }
                                Alert.alert(t('Cancel Transaction'), t('Return post to the market?'), [
                                    { text: t('No'), style: 'cancel' },
                                    { text: t('Yes, Cancel'), style: 'destructive', onPress: async () => {
                                        if(!identity) return;
                                        setAccepting(true);
                                        try {
                                            await cancelMarketplaceTransaction(txToCancel, identity.publicKey);
                                            if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                                        } catch(e:any) { 
                                            if (changedElsewhere(e, 'transaction_gone')) {
                                                Alert.alert(t('Already Updated'), t('This transaction was already cancelled or completed on another device. Your feed will automatically refresh.'));
                                                requestSync().catch(console.error);
                                                if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                                            } else {
                                                Alert.alert(t('Error'), signedRequestWords(e.message));
                                            }
                                        } finally { setAccepting(false); }
                                    }}
                                ]);
                            }}>
                                <Text style={styles.cancelTxBtnText}>{t('❌ Cancel Trust Hold')}</Text>
                            </Pressable>
                            )}

                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('All your deals')}
                                onPress={() => {
                                    setShowDealsSheet(true);
                                }}
                                style={{ alignItems: 'center', justifyContent: 'center', marginTop: 8, minHeight: 48 }}
                            >
                                <Text style={{ color: colors.text.secondary, fontSize: 13, fontWeight: '500' }}>
                                    {t('All your deals ›')}
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                )}

                {/* 1b. Deals under way, for the listing's own people: a row for each (a recurring listing can have several) */}
                {ownRows.length > 0 && (
                    <View style={styles.ownPostActions} testID="deals-under-way">
                        <Text style={{ color: colors.text.heading, fontSize: 14, fontWeight: '800', textAlign: 'center', marginBottom: 4 }}>
                            {listingDealLines.underWay(ownRows.length)}
                        </Text>
                        {isOperatorOfAuthor && (
                            <Text style={{ color: colors.text.secondary, fontSize: 12, textAlign: 'center', marginBottom: 4 }}>
                                {listingDealLines.actingFor(post.author_callsign || cardAuthor)}
                            </Text>
                        )}
                        {ownRows.map(renderOwnDeal)}
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('All your deals')}
                            onPress={() => setShowDealsSheet(true)}
                            style={{ alignItems: 'center', justifyContent: 'center', marginTop: 4, minHeight: 48 }}
                        >
                            <Text style={{ color: colors.text.secondary, fontSize: 13, fontWeight: '500' }}>
                                {t('All your deals ›')}
                            </Text>
                        </Pressable>
                    </View>
                )}

                {/* 2. Own Completed Posts (Badge) */}
                {isOwnPost && (post.status === 'completed' || activeTx?.status === 'completed') && (
                    <View style={styles.confirmBox}>
                        <Text style={[styles.confirmBoxTitle, { color: colors.brand.primary }]}>{t('✅ Deal Completed')}</Text>
                        <Text style={{ color: theme === 'dark' ? colors.text.secondary : palette.gray600, fontSize: 13, textAlign: 'center', marginBottom: 12 }}>
                            {t('This deal has concluded successfully and credits have been processed on the Ledger.')}
                        </Text>
                    </View>
                )}

                {/* 3. Own Active Posts (Edit / Delete) */}
                {isOwnPost && post.status === 'active' && (!activeTx || activeTx.status !== 'pending') && (
                    editMode ? (
                        <View style={styles.editSection}>
                            <Text style={styles.editSectionTitle}>{t('✏️ Edit Post')}</Text>

                            {/* Type Toggle */}
                            <View style={styles.editTypeRow}>
                                <Pressable accessibilityRole="button" accessibilityState={{ selected: editType === 'offer' }} style={[styles.editTypeBtn, editType === 'offer' && styles.editTypeBtnOffer]} onPress={() => setEditType('offer')}>
                                    <Text style={[styles.editTypeBtnText, editType === 'offer' && styles.editTypeBtnTextActive]}>{t('🟢 Offer')}</Text>
                                </Pressable>
                                <Pressable accessibilityRole="button" accessibilityState={{ selected: editType === 'need' }} style={[styles.editTypeBtn, editType === 'need' && styles.editTypeBtnNeed]} onPress={() => setEditType('need')}>
                                    <Text style={[styles.editTypeBtnText, editType === 'need' && styles.editTypeBtnTextActive]}>{t('🟠 Need')}</Text>
                                </Pressable>
                            </View>

                            {/* Category */}
                            <View style={styles.editPickerWrap}>
                                <Picker selectedValue={editCategory} onValueChange={v => setEditCategory(v)} style={styles.editPicker} dropdownIconColor={colors.text.secondary}>
                                    {POST_CATEGORIES.map(c => <Picker.Item key={c.id} label={t('{emoji} {label}', { emoji: c.emoji, label: t(c.label) })} value={c.id} />)}
                                </Picker>
                            </View>

                            {/* Tags */}
                            <TagPicker
                                value={editTags}
                                onChange={setEditTags}
                                freeTags={editFreeTags}
                                onFreeTagsChange={setEditFreeTags}
                                category={editCategory}
                                title={editTitle}
                                description={editDescription}
                            />

                            {/* Title */}
                            <TextInput accessibilityLabel={t('Title')} style={styles.editInput} value={editTitle} onChangeText={setEditTitle} placeholder={t('Title')} placeholderTextColor={colors.text.muted} />

                            {/* Description */}
                            <TextInput accessibilityLabel={t('Description')} style={[styles.editInput, { minHeight: 80 }]} value={editDescription} onChangeText={setEditDescription} placeholder={t('Description')} placeholderTextColor={colors.text.muted} multiline textAlignVertical="top" />

                            {/* Credits + Price Type; where there are no Beans, a note instead */}
                            {!showsBeans ? (
                                <View style={{ marginBottom: 10 }}>
                                    <Text style={{ color: colors.text.secondary, fontSize: 13, lineHeight: 18 }}>{t(LINES.noBeansEditNote)}</Text>
                                    {beansPreview && <LocalCommunityMark variant="line" feature="beans" text={t(LOCAL_COMMUNITY_LINES.price)} />}
                                </View>
                            ) : (
                            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
                                <TextInput accessibilityLabel={t('Credits')} style={[styles.editInput, { flex: 1, marginBottom: 0 }]} value={editCredits} onChangeText={setEditCredits} placeholder={t('Credits (B)')} placeholderTextColor={colors.text.muted} keyboardType="numeric" />
                                <Pressable accessibilityRole="button" onPress={() => {
                                    const types = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'];
                                    setEditPriceType(types[(types.indexOf(editPriceType) + 1) % types.length]);
                                }} style={{ backgroundColor: colors.surface.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 16, justifyContent: 'center' }}>
                                    <Text style={{ color: colors.text.body, fontSize: 13, fontWeight: '700' }}>{priceUnitWords(editPriceType) || t('Total', undefined, 'a price for the whole job')}</Text>
                                </Pressable>
                            </View>
                            )}

                            {/* Repeatable Toggle */}
                            <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ selected: editRepeatable }}
                                onPress={() => setEditRepeatable(!editRepeatable)}
                                style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.app, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 15 }}
                            >
                                <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: editRepeatable ? palette.orange500 : colors.border.strong, backgroundColor: editRepeatable ? colors.action.fab : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                    {editRepeatable && <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 14 }}>✓</Text>}
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={{ color: colors.text.heading, fontSize: 14, fontWeight: '700' }}>{t('Recurring Need / Offer')}</Text>
                                    <Text style={{ color: colors.text.secondary, fontSize: 12, marginTop: 2 }}>{t('Post remains active after completion.')}</Text>
                                </View>
                            </Pressable>

                            {/* Put this in your shop (slice S4′): an Offer only */}
                            {editType === 'offer' ? (
                                <View style={{ marginBottom: 15 }}>
                                    <ShopToggle state={editShop} on={editInShop} onChange={setEditInShop} colors={colors} testID="edit-post-shop" />
                                </View>
                            ) : null}

                            {/* Photos */}
                            <Text style={styles.editPhotoLabel}>
                                {t('PHOTOS ({n}/{max})', { n: editPhotos.length, max: 5 })}
                                {photos.length > 0 ? <Text style={styles.requiredStar}> *</Text> : null}
                            </Text>
                            <View style={styles.editPhotosRow}>
                                {editPhotos.map((uri, i) => (
                                    uri && typeof uri === 'string' && uri.trim() !== '' && uri !== 'null' && uri !== 'undefined' ? (
                                        <View key={i} style={styles.editPhotoThumb}>
                                            <Image accessibilityLabel={t('Post photo')} source={{ uri }} style={styles.editPhotoImg} />
                                            <Pressable accessibilityRole="button" accessibilityLabel={t('Remove photo')} accessibilityHint={t('Removes this photo from the post')} style={styles.editPhotoRemove} onPress={() => setEditPhotos(prev => prev.filter((_, j) => j !== i))}>
                                                <Text style={styles.editPhotoRemoveText}>✕</Text>
                                            </Pressable>
                                        </View>
                                    ) : null
                                ))}
                                {editPhotos.length < 5 && (
                                    <Pressable accessibilityRole="button" accessibilityLabel={t('Add photo')} style={styles.editPhotoAdd} onPress={pickEditPhoto}>
                                        <Text style={styles.editPhotoAddIcon}>+</Text>
                                    </Pressable>
                                )}
                            </View>

                            {/* Save / Cancel */}
                            <View style={styles.editBtnRow}>
                                <Pressable accessibilityRole="button" style={styles.editCancelBtn} onPress={() => setEditMode(false)}>
                                    <Text style={styles.editCancelBtnText}>{t('Cancel')}</Text>
                                </Pressable>
                                <Pressable accessibilityRole="button" style={[styles.editSaveBtn, (saving || !editTitle.trim() || (photos.length > 0 && editPhotos.length === 0)) && styles.editSaveBtnDisabled]} onPress={handleSave} disabled={saving || !editTitle.trim() || (photos.length > 0 && editPhotos.length === 0)}>
                                    <Text style={styles.editSaveBtnText}>{saving ? t('Saving...') : t('💾 Save')}</Text>
                                </Pressable>
                            </View>
                        </View>
                    ) : (
                        <View style={styles.ownPostActions}>
                            {post.type === 'offer' && (
                                <Pressable accessibilityRole="button" accessibilityHint={t('Hides this Offer from the marketplace')} style={styles.pauseOfferBtn} onPress={handleToggleActive} disabled={toggling}>
                                    <Text style={styles.pauseOfferBtnText}>{toggling ? t('Pausing…') : t('⏸️ Pause Offer')}</Text>
                                </Pressable>
                            )}
                            <Pressable accessibilityRole="button" style={styles.editPostBtn} onPress={startEdit}>
                                <Text style={styles.editPostBtnText}>{t('✏️ Edit Post')}</Text>
                            </Pressable>
                            <Pressable accessibilityRole="button" accessibilityHint={t('Permanently deletes this post')} style={styles.deletePostBtn} onPress={handleDelete} disabled={deleting}>
                                <Text style={styles.deletePostBtnText}>{deleting ? t('Deleting...') : t('🗑️ Delete Post')}</Text>
                            </Pressable>
                        </View>
                    )
                )}

                {/* 3b. Own Paused Offers — re-activate or delete (the active section above is gated on status==='active') */}
                {isOwnPost && post.status === 'paused' && (
                    <View style={styles.ownPostActions}>
                        <View style={styles.confirmBox}>
                            <Text style={[styles.confirmBoxTitle, { color: colors.feedback.warning.fg }]}>{t('⏸️ Offer paused')}</Text>
                            <Text style={{ color: theme === 'dark' ? colors.text.secondary : palette.gray600, fontSize: 13, textAlign: 'center' }}>
                                {t("This offer is hidden from the marketplace and isn't counting toward your credit line. Re-activate it to make it live again.")}
                            </Text>
                        </View>
                        <Pressable accessibilityRole="button" style={[styles.editPostBtn, { backgroundColor: colors.brand.fill }]} onPress={handleToggleActive} disabled={toggling}>
                            <Text style={styles.editPostBtnText}>{toggling ? t('Activating…') : t('▶️ Activate Offer')}</Text>
                        </Pressable>
                        <Pressable accessibilityRole="button" accessibilityHint={t('Permanently deletes this post')} style={styles.deletePostBtn} onPress={handleDelete} disabled={deleting}>
                            <Text style={styles.deletePostBtnText}>{deleting ? t('Deleting...') : t('🗑️ Delete Post')}</Text>
                        </Pressable>
                    </View>
                )}

                {/* Where deals are previewed, the deal action keeps its place as the marker's action: it opens the sheet. */}
                {!isPulsePost && !isOwnPost && post.status === 'active' && escrowPreview && (
                    <View style={styles.otherPostActions}>
                        <LocalCommunityMark variant="action" feature="escrow" label={t(LOCAL_COMMUNITY_LINES.dealAction).replace(LOCAL_COMMUNITY_EMOJI, '').trim()} />
                    </View>
                )}

                {/* A one-off listing in someone else's deal (reached by a link); a recurring one the reader has finished (§3.2) */}
                {deals.takenByOther && (
                    <Text testID="taken-by-other" style={{ color: colors.text.secondary, fontSize: 14, textAlign: 'center', marginTop: 12 }}>
                        {listingDealLines.takenByOther()}
                    </Text>
                )}
                {deals.lastDone && post.status === 'active' && (
                    <View testID="had-before" style={{ alignItems: 'center', marginTop: 12, gap: 4 }}>
                        <Text style={{ color: colors.text.secondary, fontSize: 13, textAlign: 'center' }}>
                            {listingDealLines.hadBefore(formatDate(new Date(deals.lastDone.tx.completedAt || deals.lastDone.tx.createdAt || Date.now()), 'day-month'))}
                        </Text>
                        {deals.lastDone.step.state === 'done-to-review' && !deals.lastDone.asKeeper && (
                            <Pressable accessibilityRole="button" style={{ paddingVertical: 6, paddingHorizontal: 12 }} onPress={() => {
                                const done = deals.lastDone!.tx;
                                const iPaid = done.buyerPublicKey === me;
                                setPromptReviewForTx({
                                    txId: done.id!,
                                    targetPubkey: iPaid ? done.sellerPublicKey : done.buyerPublicKey,
                                    targetCallsign: (iPaid ? done.sellerCallsign : done.buyerCallsign) || t('Peer'),
                                });
                            }}>
                                <Text style={{ color: colors.brand.primary, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' }}>{listingDealLines.review()}</Text>
                            </Pressable>
                        )}
                    </View>
                )}

                {/* 3. Unaccepted Posts Displayed to Browsers */}
                {isPulsePost ? (
                    <View style={styles.pulseInspirationBox}>
                        <Text style={styles.pulseIcon} aria-hidden={true} accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants">🗞️</Text>
                        <Text style={styles.pulseInspirationTitle}>{t('Feeling Inspired?')}</Text>
                        <Text style={styles.pulseInspirationText}>
                            {t('The best way to participate in BeanPool is by offering your skills, surplus produce, or lending tools to your neighbors.')}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('Post your own offer')}
                            style={styles.pulsePostOfferBtn}
                            onPress={() => {
                                router.push({ pathname: '/new-listing', params: { newPost: 'true' } });
                            }}
                        >
                            <Text style={styles.pulsePostOfferBtnText}>
                                <Text aria-hidden={true} accessibilityElementsHidden={true}>💡 </Text>{t('Post Your Own Offer →')}
                            </Text>
                        </Pressable>
                        <Text style={styles.pulseFooterText}>
                            {t('Daily Pulse — a daily thought for the post-extraction economy')}
                        </Text>
                    </View>
                ) : !isOwnPost && post.status === 'active' && !isAcceptedByMe && escrowOn && (myRequest || deals.canTakeUp) && (
                    // Accept only where core's canTakeUp says (as the web): not while the reader's own deal on it is open,
                    // a standing one short or between its periods included (its row is no held one, so isAcceptedByMe misses it).
                    <View style={styles.otherPostActions} testID="post-take-up-area" onLayout={(e) => { takeUpTop.current = e.nativeEvent.layout.y; }}>
                        {myRequest ? renderMyRequest(myRequest) : showAcceptConfirm && standingOffer && standingUnit ? (
                            // A listing priced per week or per month (§2.2): the take-up screen, signed, in place of the hours.
                            <StandingTakeUp unit={standingUnit} beans_c={post.price_c} title={post.title} payeeName={post.author_callsign || t('Peer')}
                                room={spendRoom}
                                busy={accepting} onCancel={() => setShowAcceptConfirm(false)}
                                onAgree={(choice) => takeUpStanding(choice, post.author_pubkey)} />
                        ) : showAcceptConfirm ? (
                            <View style={styles.confirmBox}>
                                <Text style={styles.confirmBoxTitle}>{isLoan ? t('Ask to borrow this?') : isOffer ? t('Accept this Offer?') : t(NEED_ANSWER_WORDS.title)}</Text>

                                {isOffer ? (
                                <View style={{ backgroundColor: colors.feedback.warning.bg, padding: 12, borderRadius: 8, borderColor: colors.feedback.warning.border, borderWidth: 1, marginBottom: 16 }}>
                                    <Text style={{ color: theme === 'dark' ? colors.feedback.warning.fg : palette.orange700, fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>{t('🔒 Trust Wallet Protocol')}</Text>
                                    <Text style={{ color: theme === 'dark' ? colors.text.secondary : palette.gray600, fontSize: 12, lineHeight: 18 }}>
                                        <Sentence
                                            text={isLoan
                                                ? (post.price_c
                                                    ? t('Nothing is held until the lender says yes. Then the fee goes into a temporary Trust Wallet, and once it is back the lender receives it net of 1.5% transaction fee {owned} to fund the Commons Pool.')
                                                    : t('Free to borrow. Nothing is held: the lender says yes first.'))
                                                : post.price_type === 'fixed'
                                                    ? t('By proceeding, you commit {credits} credits to a temporary Trust Wallet. Upon completion, the provider receives the credits net of 1.5% transaction fee {owned} to fund the Commons Pool.', { credits: formatHundredths(post.price_c) })
                                                    : t('By proceeding, you commit your authorized credits to a temporary Trust Wallet. Upon completion, the provider receives the credits net of 1.5% transaction fee {owned} to fund the Commons Pool.')}
                                            parts={{ owned: <Text style={{ color: colors.brand.primary, fontWeight: 'bold' }}>{t('(100% community owned)')}</Text> }}
                                        />
                                    </Text>
                                </View>
                                ) : needAnswerWords !== null && (
                                    // A Need says the plain thing (cold start N4): what they'd be paid and who has to agree. The 1.5% fee is on the
                                    // deal itself, the request card and the Payee's line, not here.
                                    <Text testID="need-answer-line" style={styles.needAnswerLine}>{needAnswerWords}</Text>
                                )}
                                {/* A standing Need asks for no time: the helper offers one period, and its author agrees to the run (§4). */}
                                {post.price_type !== 'fixed' && !standingNeed && (
                                    <View style={{ marginBottom: 12 }}>
                                        <Text style={styles.confirmBoxLabel}>{t('TRUST COMMITMENT (HOURS)')}</Text>
                                        <TextInput accessibilityLabel={t('Trust commitment in hours')} style={styles.confirmBoxInput} value={acceptHours} onChangeText={setAcceptHours} placeholder={t('Hours')} placeholderTextColor={colors.text.muted} keyboardType="numeric" editable={post.price_type !== 'fixed'} />
                                        <Text style={{ color: colors.text.muted, fontSize: 10, textAlign: 'center', marginTop: 4 }}>{t('Credits will be required upon approval.')}</Text>
                                    </View>
                                )}
                                <View style={{ flexDirection: 'row', gap: 10 }}>
                                    <Pressable accessibilityRole="button" style={styles.cancelActionBtn} onPress={() => setShowAcceptConfirm(false)} disabled={accepting}>
                                        <Text style={styles.cancelActionBtnText}>{t('Cancel')}</Text>
                                    </Pressable>
                                    <Pressable accessibilityRole="button" style={[styles.confirmActionBtn, styles.confirmActionBtnGreen]} disabled={accepting || (post.price_type !== 'fixed' && !(needQuantity?.ok && needQuantity.value > 0))} onPress={async () => {
                                        if (accepting) return;
                                        if (!identity || !post.id) return;
                                        // Hours in the language's decimal mark (core parseAmount): fr "2,5" is 2.5, never sent as no hours.
                                        const hoursRead = post.price_type !== 'fixed' ? needQuantity : null;
                                        if (hoursRead && !hoursRead.ok) { Alert.alert(t('Error'), amountRefusalWords(hoursRead.refusal)); return; }
                                        setAccepting(true);
                                        try {
                                            const estimatedHrs = hoursRead?.ok ? hoursRead.value : undefined;
                                            if (isOffer && !isLoan) {
                                                await acceptMarketplacePost(post.id, identity.publicKey, estimatedHrs);
                                            } else {
                                                const asked = await requestMarketplacePost(post.id, identity.publicKey, estimatedHrs);
                                                // Optimistically add to local state: on a loan the one asking is the buyer, on a Need the seller.
                                                // By the node's id for it, so Withdraw works before the next read replaces it.
                                                setRequests(prev => [...prev, {
                                                    id: asked?.transaction?.id ?? Crypto.randomUUID(), post_id: post.id,
                                                    buyer_pubkey: isLoan ? identity.publicKey : post.author_pubkey,
                                                    seller_pubkey: isLoan ? post.author_pubkey : identity.publicKey,
                                                    // What the deal holds, whole hundredths (core dealAmountFor), as the node holds it.
                                                    amount_c: post.price_type === 'fixed' ? post.price_c : (dealAmountOrNull(post.price_c, estimatedHrs ?? 0) ?? 0),
                                                    hours: post.price_type === 'fixed' ? null : estimatedHrs, status: 'requested'
                                                }]);
                                            }
                                            setShowAcceptConfirm(false);
                                            
                                            // Navigation Flow Improvement: Directly create conversation and jump to chat
                                            try {
                                                const conv = await createConversationApi('dm', [post.author_pubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                                                if (conv) {
                                                    router.replace(`/chat/${conv.id}`);
                                                    return;
                                                }
                                            } catch (chatError) {
                                                console.error("Failed to start chat during post acceptance", chatError);
                                            }
                                            
                                            // Fallback if chat fails
                                            router.replace({ pathname: '/(tabs)/market', params: { tab: 'deals', dealsTab: 'pending' } });
                                        } catch (e: any) {
                                            if (changedElsewhere(e, 'post_gone')) {
                                                Alert.alert(t('Already Updated'), t('This post was already accepted or modified elsewhere. Refreshing your screen...'));
                                                requestSync().catch(console.error);
                                                setShowAcceptConfirm(false);
                                            } else if (changedElsewhere(e, 'deal_open')) {
                                                // The member's deal on this listing is under way already (made on another device, or before
                                                // this screen knew): said, and the listing refreshed, which then shows that deal where Accept was.
                                                Alert.alert(t('Already under way'), t('You already have a deal under way on this. Finish or cancel it first.'));
                                                requestSync().catch(console.error);
                                                setShowAcceptConfirm(false);
                                            } else {
                                                const x = explainTradeError(e);
                                                Alert.alert(x.title, x.message);
                                            }
                                        } finally {
                                            setAccepting(false); 
                                        }
                                    }}>
                                        <Text style={styles.confirmActionBtnText}>{accepting ? t('Processing...') : t('Confirm')}</Text>
                                    </Pressable>
                                </View>
                            </View>
                        ) : (
                            <Pressable accessibilityRole="button" testID="post-take-up" style={[styles.acceptBtn, isOffer ? styles.acceptBtnOffer : styles.acceptBtnNeed, (accepting || post.status === 'pending') && { opacity: 0.6 }]} disabled={accepting || post.status === 'pending'} onPress={async () => {
                                // A name AND a photo are required before you can accept or fulfil — routed to the setup wizard.
                                const status = await getProfileStatus(identity);
                                if (!status.complete) {
                                    Alert.alert(
                                        t('Finish your profile first'),
                                        acceptNeedsProfileLine(status),
                                        [
                                            { text: t('Not now'), style: 'cancel' },
                                            { text: t('Set up profile'), onPress: () => router.push('/profile-setup') },
                                        ]
                                    );
                                    return;
                                }
                                // Accepting an Offer extracts value → gated. Fulfilling a Need is a contribution → allowed.
                                if (isOffer && blockedFromTrading) { setShowContributionRequired(true); } else {
                                    setShowAcceptConfirm(true);
                                    // The confirmation opens where the button is, near the top now: scroll it up to the screen's top so
                                    // its Confirm is in view (to the page's end, as when it was the last thing here, would scroll it away).
                                    setTimeout(() => scrollViewRef.current?.scrollTo({ y: Math.max(0, takeUpTop.current - 16), animated: true }), 350);
                                }
                            }}>
                                <Text style={styles.acceptBtnText}>
                                    {accepting ? t('Processing...') : (post.status === 'pending' ? t('⏳ Pending Confirmation') : (isLoan ? t('📦 Ask to borrow') : isOffer ? t('🤝 Accept Offer') : t(NEED_ANSWER_WORDS.button)))}
                                </Text>
                            </Pressable>
                        )}
                    </View>
                )}

                {/* A keeper's own request on their enterprise's listing (the node lets them ask): theirs to withdraw, as anyone's,
                    never on its people's list to answer. An author never has one. */}
                {isOwnPost && !!myRequest && post.status === 'active' && escrowOn && (
                    <View style={styles.otherPostActions}>{renderMyRequest(myRequest)}</View>
                )}

                {/* 3.5 Author Requests Display */}
                {isOwnPost && post.status === 'active' && toAnswer.length > 0 && (
                    <View style={styles.requestsContainer}>
                        <Text style={styles.requestsTitle}>{t('✋ Fulfillment Requests ({n})', { n: toAnswer.length })}</Text>
                        {toAnswer.map(req => {
                            const reqPubkey = req.resolvedReqPubkey || ((post.type === 'need' && req.seller_pubkey) ? req.seller_pubkey : req.buyer_pubkey);
                            // Fallback gracefully if pubkey is somehow still empty
                            const safePubkeyStr = reqPubkey ? reqPubkey.slice(0, 8) : t('Unknown');
                            
                            let reqCallsign = safePubkeyStr;
                            if (post.type === 'need' && req.seller_pubkey) {
                                reqCallsign = req.seller_callsign || safePubkeyStr;
                            } else {
                                reqCallsign = req.buyer_callsign || safePubkeyStr;
                            }
                            
                            return (
                                <View key={req.id} style={styles.requestCard}>
                                    <View style={{ flex: 1, marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                        <View style={{ flex: 1, paddingRight: 8 }}>
                                            <Pressable accessibilityRole="button" onPress={() => {
                                                if (reqPubkey) router.push({ pathname: '/public-profile', params: { publicKey: reqPubkey, callsign: reqCallsign } });
                                            }}>
                                                <Text style={[styles.requestName, { textDecorationLine: 'underline', color: colors.feedback.warning.fg }]} numberOfLines={1}>
                                                    🤝 {reqCallsign}
                                                </Text>
                                            </Pressable>
                                            <Text style={{ fontSize: 12, color: colors.feedback.warning.fg, marginTop: 2, fontWeight: '600' }}>
                                                {req.count > 0
                                                    ? tn(req.count, '★ {average} ({n} reviews)', '★ {average} ({n} reviews)', { average: formatNumber(req.avgRating, 1) })
                                                    : t('☆☆☆☆☆ No ratings yet')}
                                            </Text>
                                            <Text style={styles.requestAmt}>{req.hours ? requestQuantityWords(dealQuantityUnit(post.price_type, post.lendable), Boolean(post.lendable), req.hours) : t('Offered to fulfill')}</Text>
                                        </View>
                                        <Pressable
                                            accessibilityRole="button"
                                            style={styles.reqMessageBtn}
                                            onPress={async () => {
                                                if (!identity || !reqPubkey) return;
                                                try {
                                                    const conv = await createConversationApi('dm', [reqPubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                                                    if (conv) { chatAboutDrafts.set(conv.id, aboutOfPost(post)); router.push(`/chat/${conv.id}`); }
                                                } catch (e: any) { Alert.alert(t('Error'), signedRequestWords(e.message)); }
                                            }}
                                        >
                                            <Text style={styles.reqMessageBtnText}>{t('💬 Message')}</Text>
                                            {(reqUnreadCounts[req.id] || 0) > 0 && (
                                                <View style={styles.unreadBadgeSmall}>
                                                    <Text style={styles.unreadBadgeTextSmall}>{reqUnreadCounts[req.id]}</Text>
                                                </View>
                                            )}
                                        </Pressable>
                                    </View>
                                    <View style={{flexDirection: 'row', gap: 8}}>
                                        <Pressable accessibilityRole="button" style={[styles.rejectBtn, accepting && {opacity: 0.5}, { flex: 1, alignItems: 'center' }]} disabled={accepting} onPress={() => handleReject(req.id)}>
                                            <Text style={styles.rejectBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Deny')}</Text>
                                        </Pressable>
                                        <Pressable accessibilityRole="button" style={[styles.approveBtn, accepting && {opacity: 0.5}, { flex: 2, alignItems: 'center' }]} disabled={accepting}
                                            onPress={() => (standingNeed && !isOperatorOfAuthor ? setApprovingStanding(req.id) : handleApprove(req.id))}>
                                            <Text style={styles.approveBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Approve & Commit')}</Text>
                                        </Pressable>
                                    </View>
                                    {/* A standing Need: its author pays, and agrees to the run on the payer's screen first (§4). */}
                                    {approvingStanding === req.id && standingUnit && (
                                        <StandingTakeUp unit={standingUnit} beans_c={post.price_c} title={post.title} payeeName={reqCallsign}
                                            room={post.author_pubkey === identity?.publicKey ? spendRoom : null}
                                            busy={accepting} onCancel={() => setApprovingStanding(null)}
                                            onAgree={(choice) => takeUpStanding(choice, req.seller_pubkey, req.id)} />
                                    )}
                                </View>
                            );
                        })}
                    </View>
                )}

                {/* A visitor with no account, looking around (slice S12, utils/look-around.ts): nothing here can be signed, so
                    the one action is the door, where the key is made. */}
                {!identity && !isPulsePost && (
                    <View style={[styles.otherPostActions, { marginTop: 10 }]}>
                        <Pressable accessibilityRole="button" style={styles.messageBtn} onPress={openLookDoor} testID="post-join-to-message">
                            <Text style={styles.messageBtnText}>{t('Join to message')}</Text>
                        </Pressable>
                    </View>
                )}

                {peerActions && (
                    <View style={styles.otherPostActions}>
                        {identity && (post.status === 'completed' || activeTx?.status === 'completed') && (activeTx?.id || post.pending_transaction_id) && targetPeerPubkey && (
                            <View style={{ marginTop: 16 }}>
                                <Pressable accessibilityRole="button" style={[styles.messageBtn, { borderColor: hasExistingRating ? colors.brand.primary : colors.feedback.warning.border, backgroundColor: hasExistingRating ? colors.feedback.success.bg : colors.feedback.warning.bg }]} onPress={() => setShowRatingForm(!showRatingForm)}>
                                    <Text style={[styles.messageBtnText, { color: hasExistingRating ? colors.brand.primary : colors.feedback.warning.fg }]}>
                                        {hasExistingRating ? t('★ Edit rating for {name}', { name: targetPeerCallsign }) : t('★ Rate {name}', { name: targetPeerCallsign })}
                                    </Text>
                                </Pressable>
                                {showRatingForm && (
                                    <View style={[styles.confirmBox, { marginTop: 8 }]}>
                                        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
                                            {[1,2,3,4,5].map(star => (
                                                <Pressable key={star} accessibilityRole="button" accessibilityLabel={tn(star, 'Rate {n} star', 'Rate {n} stars')} accessibilityState={{ selected: star <= myRating }} onPress={() => { setMyRating(star); hapticTick(); }}>
                                                    <Text style={{ fontSize: 32, color: star <= myRating ? colors.trust.star : colors.border.strong }}>{star <= myRating ? '★' : '☆'}</Text>
                                                </Pressable>
                                            ))}
                                        </View>
                                        <TextInput accessibilityLabel={t('Rating comment')} style={[styles.editInput, { minHeight: 60, marginBottom: 12 }]} value={ratingComment} onChangeText={setRatingComment} placeholder={t('Leave an optional comment...')} placeholderTextColor={colors.text.muted} multiline />
                                        <Pressable accessibilityRole="button" style={[styles.confirmActionBtn, { backgroundColor: myRating >= 1 ? (hasExistingRating ? colors.brand.fill : colors.feedback.warning.solid) : colors.border.default }]} disabled={myRating < 1 || submittingRating} onPress={async () => {
                                            const txToRate = activeTx?.id || post.pending_transaction_id;
                                            if(!identity || !txToRate) return;
                                            try {
                                                setSubmittingRating(true);
                                                await submitRating(identity.publicKey, targetPeerPubkey, myRating, ratingComment, txToRate);
                                                setShowRatingForm(false);
                                                setHasExistingRating(true);
                                                hapticSuccess();
                                                Alert.alert(t('Success'), hasExistingRating ? t('Rating updated!') : t('Rating submitted!'));
                                            } catch(e:any) { hapticWarning(); Alert.alert(t('Error'), signedRequestWords(e.message)); } finally { setSubmittingRating(false); }
                                        }}>
                                            <Text style={[styles.confirmActionBtnText, myRating >= 1 && !hasExistingRating && { color: colors.text.onGold }]}>
                                                {submittingRating ? t('Submitting...') : hasExistingRating ? t('Update Rating') : t('Submit Rating')}
                                            </Text>
                                        </Pressable>
                                    </View>
                                )}
                            </View>
                        )}
                    </View>
                )}

                {/*
                  * 8. The photo, under the action (DESIGN-detail-pages-frame-fable.md §1.7, §3): 4:3, the column's width, under the
                  * column's corners (the grid tile's frame, so the page shows the picture the member tapped), as the event page has it. No
                  * photo: the category tile, 3:1, inside the column. 16 over the quiet row.
                  */}
                {photos.length > 0 ? (
                    <View style={styles.photoFrame} testID="post-photo-frame">
                        <PhotoCarousel photos={photos} height={photoHeight} borderRadius={SHELL.radius} onOpen={(_i, uri) => setViewerUri(uri)} />
                    </View>
                ) : (
                    <View style={styles.tileBanner} testID="post-tile-banner">
                        <CategoryTile
                            category={post.category}
                            kind={isPulsePost ? 'pulse' : (post.type === 'event' ? 'event' : 'listing')}
                            size="banner"
                        />
                    </View>
                )}

                {/* 9. The quiet row: Message {name} (its unread on it) and Share, in the neutral outline, wrapping by whole buttons, never cut. */}
                <View style={styles.quietRow} testID="post-quiet-row">
                    {peerMessage && (
                        <Pressable accessibilityRole="button" style={[styles.messageBtn, styles.quietItem]} testID="post-message" onPress={async () => {
                            if (!identity) return;
                            try {
                                const conv = await createConversationApi('dm', [targetPeerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);
                                if (conv) { chatAboutDrafts.set(conv.id, aboutOfPost(post)); router.push(`/chat/${conv.id}`); }
                            } catch (e: any) {
                                Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Failed to start chat.'));
                            }
                        }}>
                            <View style={styles.messageInner}>
                                <Text style={styles.messageBtnText}>{!isOwnPost ? t('💬 Message {name}', { name: targetPeerCallsign }) : t('💬 Message')}</Text>
                                {unreadCount > 0 && (
                                    <View style={styles.unreadBadge}>
                                        <Text style={styles.unreadBadgeText}>{unreadCount}</Text>
                                    </View>
                                )}
                            </View>
                        </Pressable>
                    )}
                    {/* Share with members, and outside the community where it allows it (front doors S6): the one button and its sheet. */}
                    <SharePostButtons post={post} style={styles.quietItem} buttonStyle={[shell.pageButton, styles.quietButton]} textStyle={[shell.pageButtonText, styles.quietButtonText]} />
                </View>

                {/* 10. The description and the tags, after the action and the photo (DESIGN-detail-pages-fable.md question 1). */}
                <Text style={styles.description} testID="post-description">{post.description || t('No description provided.')}</Text>
                <PostTagChips tags={post.tags} freeTags={listingFreeTags(post)} />

                {/* 11. The person: the Author / Counterparty Card, components/AuthorCard.tsx, the one box an event's "HOSTED BY" is too. */}
                {isOwnPost && targetPeerPubkey ? (
                    <AuthorCard
                        label={isOffer ? t('ACCEPTED BY') : t('PROVIDER')}
                        pubkey={targetPeerPubkey}
                        callsign={targetPeerCallsign}
                        avatarUrl={targetPeerAvatar}
                        rating={{ average: targetPeerAvgRating, count: targetPeerRatingCount }}
                        onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: targetPeerPubkey, callsign: targetPeerCallsign } })}
                    />
                ) : (
                    <AuthorCard
                        label={t('POSTED BY')}
                        pubkey={post.author_pubkey}
                        callsign={cardAuthor}
                        avatarUrl={post.author_avatar}
                        rating={{ average: authorAvgRating, count: authorRatingCount }}
                        // A visitors' view hides who posted (utils/posts-view.ts): there is no profile to open.
                        disabled={isHiddenAuthor(post.author_pubkey)}
                        onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: post.author_pubkey, callsign: cardAuthor } })}
                    />
                )}
                {/* Where anyone can join, another member reads this place to about 1 km (DESIGN-global-member-privacy-fable.md §4):
                    said here, so a pin on the map is never taken for the door. A keeper reads their enterprise's exactly. */}
                {placeShownRoughly({ authorPublicKey: post.author_pubkey, type: post.type, lat: post.lat, lng: post.lng }, identity?.publicKey, hostLetsInDefault(nodeProfile?.features))
                    && !isOperatorOfAuthor && (
                    <Text style={styles.roughPlace} testID="rough-place-line">{t(PLACE_WORDS.roughPlace, { name: cardAuthor })}</Text>
                )}

                {/* 12. Show it on the global community (the author's). */}
                {!isOperatorOfAuthor && (
                    <ShowOnGlobalHostRow
                        event={listingForCopy(post, photos)}
                        enabled={nodeProfile?.profile === 'local' && identity?.publicKey === post.author_pubkey && (post.audience_scope ?? 'public') === 'public' && !post.origin_node
                            && typeof post.lat === 'number' && typeof post.lng === 'number' && ['active', 'paused', 'pending'].includes(post.status)}
                        listing
                    />
                )}

                {/* 12, 13. The rest and Report, at the foot: the convenor's moderation, Report and Block, the reason box. */}
                {peerActions && (
                    <View style={styles.otherPostActions}>
                        {/* Convenor Post Moderation (Item 10) */}
                        {!isOwnPost && isConvenor && Boolean(post.target_group_id || post.targetGroupId) && (
                            <View style={{ marginTop: 14, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.brand.primary, backgroundColor: colors.brand.tint }}>
                                <Text style={{ fontSize: 13, fontWeight: '800', color: colors.brand.primary, marginBottom: 8 }}>
                                    {t('🛡️ Convenor Moderation ({group})', { group: post.target_group_name || post.targetGroupName || t('Group') })}
                                </Text>
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityHint={t('Deletes this post as convenor')}
                                    disabled={deletingAsConvenor}
                                    style={[styles.deletePostBtn, { backgroundColor: colors.surface.card }]}
                                    onPress={() => {
                                        const groupTitle = post.target_group_name || post.targetGroupName;
                                        Alert.alert(
                                            t('Delete Group Post?'),
                                            groupTitle
                                                ? t('Delete this post as Convenor of {group}? This action cannot be undone.', { group: groupTitle })
                                                : t('Delete this post as Convenor of the group? This action cannot be undone.'),
                                            [
                                                { text: t('Cancel'), style: 'cancel' },
                                                {
                                                    text: t('Delete Post'),
                                                    style: 'destructive',
                                                    onPress: async () => {
                                                        try {
                                                            setDeletingAsConvenor(true);
                                                            const gId = (post.target_group_id || post.targetGroupId)!;
                                                            await deleteGroupPostApi(gId, post.id);
                                                            Alert.alert(t('Post Deleted'), t('The post has been removed from the group.'), [
                                                                { text: t('OK'), onPress: () => router.back() }
                                                            ]);
                                                        } catch (e: any) {
                                                            Alert.alert(t('Error'), e?.message ? signedRequestWords(e.message) : t('Failed to delete post'));
                                                        } finally {
                                                            setDeletingAsConvenor(false);
                                                        }
                                                    }
                                                }
                                            ]
                                        );
                                    }}
                                >
                                    <Text style={styles.deletePostBtnText}>
                                        {deletingAsConvenor ? t('Deleting...') : t('🗑️ Delete Group Post (Convenor)')}
                                    </Text>
                                </Pressable>
                            </View>
                        )}

                        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 16, marginTop: 12 }}>
                            <Pressable 
                                accessibilityRole="button"
                                accessibilityLabel={t('Report Post')}
                                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                                style={{ minHeight: 48, justifyContent: 'center' }}
                                onPress={() => {
                                    const next = !showReportForm;
                                    setShowReportForm(next);
                                    if (next) {
                                        setTimeout(() => {
                                            scrollViewRef.current?.scrollToEnd({ animated: true });
                                        }, 150);
                                    }
                                }}
                            >
                                <Text style={{ color: colors.feedback.danger.fg, fontSize: 13, fontWeight: '700' }}>{t('🚩 Report Post')}</Text>
                            </Pressable>
                            <Text style={{ color: colors.text.muted }}>•</Text>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={post?.author_callsign ? t('Block user {name}', { name: post.author_callsign }) : t('Block user')}
                                accessibilityState={{ busy: isBlocking }}
                                hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                                disabled={isBlocking}
                                style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingVertical: 4 }}
                                onPress={() => {
                                    if (!post?.author_pubkey || isBlocking) return;
                                    const authorName = post.author_callsign;
                                    Alert.alert(
                                        authorName ? t('Block {name}?', { name: authorName }) : t('Block this user?'),
                                        authorName
                                            ? t('This will instantly hide all posts from {name} and notify moderation.', { name: authorName })
                                            : t('This will instantly hide all posts from this user and notify moderation.'),
                                        [
                                            { text: t('Cancel'), style: 'cancel' },
                                            {
                                                text: t('Block User'),
                                                style: 'destructive',
                                                onPress: async () => {
                                                    try {
                                                        setIsBlocking(true);
                                                        await blockUser(post.author_pubkey, identity?.publicKey, 'Abusive content reported via Post', post.id);
                                                        Alert.alert(t('User Blocked'), authorName
                                                            ? t('{name} has been blocked and removed from your feed.', { name: authorName })
                                                            : t('This user has been blocked and removed from your feed.'), [
                                                            { text: t('OK'), onPress: () => router.back() }
                                                        ]);
                                                    } catch (e) {
                                                        Alert.alert(t('Error'), t('Failed to block user. Please try again.'));
                                                    } finally {
                                                        setIsBlocking(false);
                                                    }
                                                }
                                            }
                                        ]
                                    );
                                }}
                            >
                                {isBlocking ? (
                                    <ActivityIndicator size="small" color={colors.feedback.danger.fg} style={{ marginRight: 4 }} />
                                ) : null}
                                <Text style={{ color: colors.feedback.danger.fg, fontSize: 13, fontWeight: '700', opacity: isBlocking ? 0.6 : 1 }}>
                                    {isBlocking ? t('Blocking…') : (<><Text aria-hidden={true} importantForAccessibility="no">🚫 </Text>{t('Block User')}</>)}
                                </Text>
                            </Pressable>
                        </View>
                        {showReportForm && (
                            <View style={[styles.confirmBox, { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border }]}>
                                <Text style={styles.confirmBoxLabel}>{t('SELECT REPORT REASON')}</Text>
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                                    {REPORT_REASONS.map((r, i) => {
                                        // The reason goes to the node as it is written (English: the server reads Child safety); shown translated.
                                        const isSelected = reportReason === r;
                                        return (
                                            <Pressable
                                                key={r}
                                                accessibilityRole="button"
                                                accessibilityState={{ selected: isSelected }}
                                                style={{
                                                    paddingHorizontal: 14,
                                                    paddingVertical: 8,
                                                    borderRadius: 20,
                                                    backgroundColor: isSelected ? colors.feedback.danger.solid : colors.surface.card,
                                                    borderWidth: 1,
                                                    borderColor: isSelected ? colors.feedback.danger.solid : colors.border.default,
                                                }}
                                                onPress={() => {
                                                    setReportReason(r);
                                                    hapticTick();
                                                }}
                                            >
                                                <Text style={{ fontSize: 13, fontWeight: '700', color: isSelected ? colors.text.inverse : colors.text.body }}>
                                                    {isSelected ? t('✓ {reason}', { reason: t(REPORT_REASONS[i]) }) : t(REPORT_REASONS[i])}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                                <Text style={{ fontSize: 13, color: colors.text.body, marginBottom: 12 }}>
                                    <Sentence text={t('{reason}: {hint}', { hint: t(LINES.childSafetyHint) })} parts={{ reason: <Text style={{ fontWeight: '700' }}>{t(LINES.childSafety)}</Text> }} />
                                </Text>

                                <TextInput
                                    style={[styles.editInput, { minHeight: 48, marginBottom: 12, backgroundColor: colors.surface.card }]}
                                    value={reportDetails}
                                    onChangeText={setReportDetails}
                                    placeholder={t('Optional details or comments...')}
                                    placeholderTextColor={colors.text.muted}
                                    multiline
                                />

                                <Pressable
                                    accessibilityRole="button"
                                    style={[styles.confirmActionBtn, { backgroundColor: reportReason ? colors.feedback.danger.solid : colors.border.default }]}
                                    disabled={!reportReason || submittingReport}
                                    onPress={async () => {
                                        if (!identity || !post.id) return;
                                        try {
                                            setSubmittingReport(true);
                                            const finalReason = reportDetails ? `${reportReason}: ${reportDetails}` : reportReason;
                                            const sent = await reportAbuse(identity.publicKey, post.author_pubkey, finalReason, post.id);
                                            setShowReportForm(false);
                                            setReportDetails('');
                                            setReportReason('');
                                            // The thanks, and why the member's words were left out when they were (case 14).
                                            Alert.alert(t('Reported'), reportedAlertBody(sent?.wordsLeftOut, finalReason));
                                        } catch (e: any) {
                                            Alert.alert(t('Error'), signedRequestWords(e.message));
                                        } finally {
                                            setSubmittingReport(false);
                                        }
                                    }}
                                >
                                    <Text style={styles.confirmActionBtnText}>{submittingReport ? t('Sending...') : t('Submit Report')}</Text>
                                </Pressable>
                            </View>
                        )}
                    </View>
                )}
            </ScrollView>
            </KeyboardAvoidingView>
            {promptReviewForTx && (
                <ReviewModal 
                    visible={!!promptReviewForTx}
                    txId={promptReviewForTx.txId}
                    targetPubkey={promptReviewForTx.targetPubkey}
                    targetCallsign={promptReviewForTx.targetCallsign}
                    onClose={() => {
                        setPromptReviewForTx(null);
                        if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                    }}
                    onSuccess={() => {
                        setPromptReviewForTx(null);
                        if (router.canGoBack()) router.back(); else router.replace('/(tabs)');
                    }}
                />
            )}
            {showDealsSheet && (
                <MyDealsSheet
                    visible={showDealsSheet}
                    identity={identity}
                    onClose={() => setShowDealsSheet(false)}
                    initialTab="pending"
                />
            )}
            
            {/* Reject Request Modal */}
            {rejectModalTxId && (
                <View style={StyleSheet.absoluteFill}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} style={styles.modalOverlay} onPress={() => setRejectModalTxId(null)}>
                        {/* A scroll view, not a second KeyboardAvoidingView stacked on the page's own: it scrolls the message box above
                            the keyboard, and flexGrow 0 keeps the card centred (and no taller than the overlay) when there is no keyboard. */}
                        <KeyboardAwareScrollView style={{ width: '100%', flexGrow: 0 }} keyboardShouldPersistTaps="handled" bottomOffset={24}>
                            <Pressable style={styles.modalContent} onPress={e => e.stopPropagation()}>
                                <Text style={styles.modalTitle}>{t('Decline Offer')}</Text>
                                <Text style={styles.modalSubtext}>{t('Are you sure you want to decline this offer?')}</Text>
                                <TextInput
                                    accessibilityLabel={t('Decline message')}
                                    style={[styles.editInput, { minHeight: 80, marginBottom: 16 }]}
                                    value={rejectMessage}
                                    onChangeText={setRejectMessage}
                                    placeholder={t('Add a brief message (optional)...')}
                                    placeholderTextColor={colors.text.muted}
                                    multiline
                                    textAlignVertical="top"
                                />
                                <View style={{ flexDirection: 'row', gap: 12 }}>
                                    <Pressable accessibilityRole="button" style={[styles.editCancelBtn, { flex: 1 }]} onPress={() => setRejectModalTxId(null)}>
                                        <Text style={styles.editCancelBtnText}>{t('Cancel')}</Text>
                                    </Pressable>
                                    <Pressable accessibilityRole="button" style={[styles.deletePostBtn, { flex: 1, marginVertical: 0 }]} disabled={accepting} onPress={confirmReject}>
                                        <Text style={styles.deletePostBtnText}>{accepting ? '...' : t('Decline')}</Text>
                                    </Pressable>
                                </View>
                            </Pressable>
                        </KeyboardAwareScrollView>
                    </Pressable>
                </View>
            )}

            {/* Contribution-first gate: blocks accepting an Offer until the member lists one. */}
            {showContributionRequired && (
                <View style={StyleSheet.absoluteFill}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} style={styles.modalOverlay} onPress={() => setShowContributionRequired(false)}>
                        <Pressable style={styles.modalContent} onPress={e => e.stopPropagation()}>
                            <Text style={[styles.modalTitle, { textAlign: 'center' }]}>{t('🔒 Contribution Required')}</Text>
                            <Text style={[styles.modalSubtext, { textAlign: 'center' }]}>
                                {t('To accept Offers or post Needs, first list at least one Offer detailing what you can contribute to the community.')}
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                style={{ marginTop: 8, paddingVertical: 14, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center' }}
                                onPress={() => { setShowContributionRequired(false); router.push({ pathname: '/new-listing', params: { newPost: 'true' } }); }}
                            >
                                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>{t('➕ Create an Offer')}</Text>
                            </Pressable>
                            {/* flex: 0 — editCancelBtn is flex: 1 for the row layouts; in this column it squashed the
                                button to ~30dp and hid the label. */}
                            <Pressable accessibilityRole="button" style={[styles.editCancelBtn, { flex: 0, marginTop: 10, minHeight: 48 }]} onPress={() => setShowContributionRequired(false)}>
                                <Text style={styles.editCancelBtnText}>{t('Not now')}</Text>
                            </Pressable>
                        </Pressable>
                    </Pressable>
                </View>
            )}
            {/* The photo whole, over the page, until tapped or closed. Drawn only while open: it is a Modal, and most visits never open it. */}
            {!!viewerUri && <ChatPhotoViewer uri={viewerUri} onClose={() => setViewerUri(null)} />}
            {showPinSheet && (
                <PinSheet
                    visible
                    postId={post.id}
                    onClose={() => setShowPinSheet(false)}
                    onPinned={async () => {
                        const updated = await getPost(post.id);
                        if (updated) setPost(updated);
                    }}
                />
            )}
        </View>
    );
}

/**
 * The route for a post. A page of Local knowledge opens here too (DESIGN-local-knowledge-fable.md amended §2.11): a Learn row,
 * a bell line and a shared link land on one place. A route that says it is a page (`kind=knowledge`, as Learn's rows do) is
 * never drawn as a listing; one that doesn't (a pasted link) draws the listing at once, and the page instead if the phone's
 * copy turns out to hold one by that id. A page that leaves while open (a take-down) turns into "This page isn't in Learn any
 * more", never the listing screen. The listing screen above is as it was.
 */
export default function PostRoute() {
    const { id, kind } = useLocalSearchParams<{ id?: string | string[]; kind?: string | string[] }>();
    const pageId = Array.isArray(id) ? id[0] : id;
    const asked = (Array.isArray(kind) ? kind[0] : kind) === 'knowledge';
    const { page, settled, isPage } = useKnowledgePage(pageId, asked);
    if (page) return <KnowledgeDetail page={page} />;
    if (!isPage) return <PostDetailModal />;
    return <KnowledgeMissing settled={settled} />;
}

function getTimeAgo(dateStr: string): string {
    try {
        const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
        if (secs < 60) return t('just now');
        const mins = Math.floor(secs / 60);
        if (mins < 60) return t('{n}m ago', { n: mins });
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return t('{n}h ago', { n: hrs });
        const days = Math.floor(hrs / 24);
        return t('{n}d ago', { n: days });
    } catch { return ''; }
}


