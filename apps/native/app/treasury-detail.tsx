import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, ActivityIndicator, TextInput } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useFocusEffect, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import {
    getTreasuryDetail, getBalance, createConversationApi, treasuryPledge, reportAbuse, requestToJoinEnterprise,
    getEnterpriseThread, postEnterpriseThreadMessage, getEnterpriseLedger, type EnterpriseLedgerResponse
} from '../utils/db';
import { changeEnterpriseShop } from '../utils/shop';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePictureCrop } from '../components/PictureCrop';
import { pickBannerPhoto } from '../utils/banner-photo';
import {
    seasonBanner, LEDGER_PERIODS, ledgerSince, ledgerLineLabels, signedBeans, plSummaryText, type LedgerPeriod
} from '../utils/enterprise-season';
import { approvedApplicantText } from '../utils/keeper-governance';
import { deadlineDaysRemaining, formatDate, formatNumber, groupKindLine, inCapitalsOf, isWholeCents, keeperWords, t, tn, isSampleId, parseAmount, amountRefusalWords, isAmbiguousAmount, ANY_DECIMALS } from '@beanpool/core';
import { loadIdentity } from '../utils/identity';
import { MemberAvatar } from '../components/MemberAvatar';
import { ReportReasonBox } from '../components/ReportReasonBox';
import { Sentence } from '../components/Sentence';
import { reportedAlertBody } from '../utils/reportReasons';
import { blockUser, isUserBlocked } from '../utils/blocklist';
import { pledgeClosedLine } from '../utils/enterprise-pledge';
import { useTheme, useStyles } from './ThemeContext';
import { signedRequestWords } from '../components/signed-request-lines';
import { sampleTreasuryDetail, sampleEnterpriseLedger } from '../components/showcase/sample-screens';
import { LocalCommunityMark, LocalCommunitySheet, ExampleHeader } from '../components/showcase/LocalCommunityMark';
import { useReaderFeatures } from '../utils/use-reader-features';
import { showcaseMode } from '../utils/node-profile';
import {
    ShopfrontFeatured, ShopfrontHeader, ShopfrontKeepers, ShopfrontMessage, ShopfrontMoney, ShopfrontSections, ShopfrontText,
    ShopfrontTogether, ShopfrontVisitorNote, categorySinceLine, openListing,
} from '../components/shopfront/Shopfront';
import {
    featuredOf, hasShopfront, leadKeeperOf, listingsFromDetailPosts, messageLabel, moneyLine, readKeepers, readOwnerListings,
    readsAsMember, shopCategoryOf, shopPhotoOf, shopSectionsOf, sinceLine, type ShopfrontListing,
} from '../utils/shopfront';
import { mayManage } from '../utils/enterprise-manage';
import { decodeThreadMessage } from '../utils/enterprise-thread';

// Ledger lines render in pages: an all-time ledger can run to hundreds of lines on a low-end phone.
const LEDGER_PAGE = 20;

// A community enterprise's detail screen. Everyone sees the transparency view (balance, credit line,
// purpose, goal progress if bounded, live listings, recent activity — the Commons is meant to be legible).
// Its keepers (and a node admin) get Manage in the header: every keeper action is in that console
// (app/treasury-manage.tsx, slice S7 of DESIGN-shops-round3-enterprise-shopfront-fable.md), and this page keeps
// no operator control.
export default function TreasuryDetailScreen() {
    const params = useLocalSearchParams<{ publicKey?: string | string[]; id?: string | string[]; name?: string | string[]; avatar?: string | string[] }>();
    const rawKey = params.publicKey || params.id;
    const treasuryKey = typeof rawKey === 'string' ? rawKey : Array.isArray(rawKey) ? rawKey[0] : undefined;
    const nameParam = typeof params.name === 'string' ? params.name : Array.isArray(params.name) ? params.name[0] : undefined;
    const avatarParam = typeof params.avatar === 'string' ? params.avatar : Array.isArray(params.avatar) ? params.avatar[0] : undefined;

    // Example Valley's enterprise or project (a sample id: the Commons preview's cards): drawn from the sample, every
    // control a marker, nothing asked of the node. Only a sample id: any other key is a real one, read as before.
    const isEffectivePreview = isSampleId(treasuryKey);
    // Enterprises in preview for this reader (the worldwide community): no real one exists here, so a real key (a stale
    // link) is not asked for and the page says why. Only preview: a local node with enterprises switched off, or a
    // reader who may only read them, asks as before (review of #2063, B5).
    const reader = useReaderFeatures();
    const enterprisesPreview = showcaseMode('enterprises', reader.node, reader.reader) === 'preview';
    const elsewhere = !isEffectivePreview && enterprisesPreview;

    const { theme, colors } = useTheme();

    const [detail, setDetail] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [isKeeperOfThis, setIsKeeperOfThis] = useState(false);
    const [pledgeAmount, setPledgeAmount] = useState('');
    const [pledgeMemo, setPledgeMemo] = useState('');
    const [pledging, setPledging] = useState(false);
    // Manage in a preview (Example Valley's): what a keeper would tap, saying why it lives in a local community.
    const [previewManage, setPreviewManage] = useState(false);
    const [showReportForm, setShowReportForm] = useState(false);
    // The "…" menu at the foot, with Block (DESIGN-shops-round3-enterprise-shopfront §0 row 11, §3): a member may hide an
    // enterprise they don't want to see. Not a header button, as it was on the member Trust Profile an enterprise used to
    // open; none for its keepers on their own enterprise's page.
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [blockedHere, setBlockedHere] = useState(false);
    const [blocking, setBlocking] = useState(false);
    const [identity, setIdentity] = useState<any>(null);
    // The shopfront's listings with their photos and stamps (S5): undefined until read, null when they couldn't be, and
    // asked only of a node with the shopfront and only for a member's page; else the detail's own text listings stand in.
    const [ownListings, setOwnListings] = useState<ShopfrontListing[] | null | undefined>(undefined);
    const [messagingLead, setMessagingLead] = useState(false);

    // Keeper Join Request State
    const [joinBackingPledge, setJoinBackingPledge] = useState('0');
    const [submittingJoin, setSubmittingJoin] = useState(false);

    // Enterprise Discussion Thread State
    const [threadMessages, setThreadMessages] = useState<any[]>([]);
    const [threadReadOnly, setThreadReadOnly] = useState(false);
    const [threadInput, setThreadInput] = useState('');
    const [threadPosting, setThreadPosting] = useState(false);

    // Income & Spend (P&L), public to every member
    const [ledger, setLedger] = useState<EnterpriseLedgerResponse | null>(null);
    const [ledgerLoading, setLedgerLoading] = useState(false);
    const [ledgerError, setLedgerError] = useState<string | null>(null);
    const [ledgerPeriod, setLedgerPeriod] = useState<LedgerPeriod>('all');
    const [ledgerShown, setLedgerShown] = useState(LEDGER_PAGE);
    const ledgerRequest = useRef(0);

    const [bannerDismissed, setBannerDismissed] = useState(false);
    const [pickingBanner, setPickingBanner] = useState(false);
    const cropper = usePictureCrop(colors);

    useEffect(() => {
        if (!treasuryKey) return;
        let live = true;
        setBannerDismissed(false);
        AsyncStorage.getItem(`bp_banner_prompt_dismissed_${treasuryKey}`)
            .then((val) => { if (live) setBannerDismissed(val === '1'); })
            .catch(() => {});
        return () => { live = false; };
    }, [treasuryKey]);

    const handleDismissBanner = () => {
        setBannerDismissed(true);
        if (treasuryKey) {
            AsyncStorage.setItem(`bp_banner_prompt_dismissed_${treasuryKey}`, '1').catch(() => {});
        }
    };

    const handlePickBanner = async () => {
        if (!treasuryKey || pickingBanner) return;
        setPickingBanner(true);
        let photo: string | null = null;
        try {
            photo = await pickBannerPhoto(cropper.crop);
        } catch {
            Alert.alert(t('Error'), t("That picture couldn't be read. Try another."));
            setPickingBanner(false);
            return;
        }
        if (photo) {
            try {
                await changeEnterpriseShop(treasuryKey, { photo });
                setDetail((d: any) => d ? { ...d, shop: { ...d.shop, photoUrl: photo } } : d);
                load();
            } catch (e: any) {
                Alert.alert(t('Error'), e?.message ? signedRequestWords(e.message) : t('Could not save banner photo.'));
            }
        }
        setPickingBanner(false);
    };

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.app },
        backButton: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.3 },
        // Manage: its keepers' console (S7). Its words never shrink; the title gives way to it.
        manageBtn: { flexShrink: 0, minHeight: 44, marginLeft: 8, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: colors.brand.primary, backgroundColor: colors.surface.card, flexDirection: 'row', alignItems: 'center', gap: 6 },
        manageText: { fontSize: 14, fontWeight: '800', color: colors.brand.primary },
        scroll: { padding: 16, paddingBottom: 60 },

        progressCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 10 },
        currentAmt: { fontSize: 20, fontWeight: '800', color: colors.text.body },
        progressLabel: { fontSize: 13, fontWeight: 'normal', color: colors.text.secondary },
        goalAmt: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
        deadlineBadge: { fontSize: 12, fontWeight: '700', color: colors.brand.primary, backgroundColor: colors.brand.tint, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' },
        deadlineExpired: { color: colors.feedback.danger.fg, backgroundColor: colors.surface.subtle },
        progressBarBg: { height: 8, backgroundColor: colors.surface.subtle, borderRadius: 4, overflow: 'hidden', marginBottom: 10 },
        progressBarFill: { height: '100%', borderRadius: 4 },
        escrowNotice: { fontSize: 12, color: colors.text.secondary, lineHeight: 17, marginBottom: 14 },
        pledgeBox: { backgroundColor: colors.surface.app, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default },
        pledgeClosedText: { fontSize: 14, fontWeight: '600', color: colors.text.body, lineHeight: 20 },
        pledgeInputRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
        pledgeAmountInput: { flex: 1, height: 44, backgroundColor: colors.surface.card, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, fontWeight: '700', color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        pledgeMemoInput: { flex: 2, height: 44, backgroundColor: colors.surface.card, borderRadius: 10, paddingHorizontal: 12, fontSize: 14, color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        pledgeButton: { backgroundColor: colors.brand.fill, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
        pledgeButtonText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13, letterSpacing: 0.5 },

        // Join Request Section
        joinCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        joinTitle: { fontSize: 13, fontWeight: '800', color: colors.text.heading, marginBottom: 4 },
        joinDesc: { fontSize: 12, color: colors.text.secondary, lineHeight: 18, marginBottom: 12 },
        joinInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
        joinInput: { width: 80, height: 44, backgroundColor: colors.surface.app, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, fontWeight: '700', color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        joinAvailableText: { fontSize: 12, fontWeight: '700', color: colors.text.secondary, flex: 1 },
        joinButton: { backgroundColor: colors.brand.fill, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
        joinButtonDisabled: { opacity: 0.5 },
        joinButtonText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13 },
        pendingRequestBanner: { backgroundColor: colors.brand.tint, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.brand.primary, marginBottom: 16 },
        pendingRequestTitle: { fontSize: 12, fontWeight: '800', color: colors.brand.primary, marginBottom: 2 },
        pendingRequestText: { fontSize: 12, color: colors.brand.primary },

        balanceCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 18, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        balanceLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', letterSpacing: 0.5 },
        balanceValue: { fontSize: 34, fontWeight: '900', letterSpacing: -1, marginTop: 4 },
        balancePos: { color: colors.brand.primary },
        balanceNeg: { color: colors.feedback.warning.fg },
        balanceMetaRow: { flexDirection: 'row', marginTop: 14, gap: 12 },
        metaBox: { flex: 1, backgroundColor: colors.surface.app, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: colors.border.default },
        metaLabel: { fontSize: 10, color: colors.text.secondary, fontWeight: '700', letterSpacing: 0.4 },
        metaValue: { fontSize: 16, fontWeight: '800', color: colors.text.heading, marginTop: 3 },

        sectionLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8, marginTop: 8 },

        flowRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        flowIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
        flowMemo: { fontSize: 13, color: colors.text.body, fontWeight: '500' },
        flowTime: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
        flowAmount: { fontSize: 15, fontWeight: '800' },

        threadCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default, marginTop: 20 },
        threadHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
        threadTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        threadSubtitle: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },
        threadReadOnlyBanner: { backgroundColor: colors.surface.subtle, padding: 10, borderRadius: 8, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default },
        threadReadOnlyText: { fontSize: 12, fontStyle: 'italic', color: colors.text.muted, textAlign: 'center' },
        threadMsgRow: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        threadMsgAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface.subtle },
        threadMsgContent: { flex: 1, minWidth: 0 },
        threadMsgMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
        threadMsgAuthor: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '700', color: colors.text.heading },
        threadMsgTime: { flexShrink: 0, fontSize: 10, color: colors.text.muted },
        threadMsgText: { fontSize: 13, color: colors.text.body, lineHeight: 18 },
        threadMsgRemoved: { fontSize: 13, fontStyle: 'italic', color: colors.text.muted },
        threadInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border.default },
        threadInput: { flex: 1, backgroundColor: colors.surface.app, height: 48, borderRadius: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border.default, color: colors.text.body, fontSize: 13 },
        threadSendBtn: { height: 48, flexShrink: 0, paddingHorizontal: 16, borderRadius: 8, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        threadSendBtnText: { color: colors.text.inverse, fontWeight: '700', fontSize: 13 },

        // Season state banners (every member)
        banner: { borderRadius: 16, padding: 14, borderWidth: 2, marginBottom: 16, gap: 6 },
        bannerPaused: { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.solid },
        bannerWindingUp: { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.solid },
        bannerCompleted: { backgroundColor: colors.surface.subtle, borderColor: colors.border.strong },
        bannerLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
        bannerLabel: { flex: 1, fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
        bannerHeadline: { fontSize: 15, fontWeight: '800', lineHeight: 20 },
        bannerBody: { fontSize: 12, lineHeight: 17 },
        bannerWarning: { fontSize: 12, fontWeight: '700', lineHeight: 17, paddingTop: 6, marginTop: 2, borderTopWidth: 1 },

        // Income & Spend (P&L)
        plCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        plTitle: { fontSize: 11, fontWeight: '800', color: colors.text.secondary, letterSpacing: 0.8 },
        plSubtitle: { fontSize: 12, color: colors.text.secondary, marginTop: 2, marginBottom: 10 },
        periodStrip: { flexDirection: 'row', backgroundColor: colors.surface.subtle, borderRadius: 12, padding: 3, marginBottom: 12 },
        periodTab: { flex: 1, minWidth: 0, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 9, paddingHorizontal: 2 },
        periodTabActive: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        periodTabText: { fontSize: 12, fontWeight: '700', color: colors.text.secondary },
        periodTabTextActive: { color: colors.text.heading, fontWeight: '800' },
        plSummaryRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
        plBox: { flex: 1, minWidth: 0, borderRadius: 12, padding: 10, borderWidth: 1 },
        plBoxLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
        plBoxValue: { fontSize: 16, fontWeight: '900', marginTop: 3 },
        plFeeNote: { fontSize: 12, color: colors.text.muted, marginBottom: 10 },
        ledgerRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border.default, gap: 2 },
        ledgerLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
        ledgerWhat: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '700', color: colors.text.heading },
        ledgerAmount: { flexShrink: 0, fontSize: 14, fontWeight: '800' },
        ledgerWith: { fontSize: 12, color: colors.text.secondary },
        ledgerFlow: { fontWeight: '800' },
        ledgerWhen: { flex: 1, minWidth: 0, fontSize: 11, color: colors.text.muted },
        ledgerRunning: { flexShrink: 0, fontSize: 11, fontWeight: '700', color: colors.text.body },
        ledgerFooter: { borderTopWidth: 1, borderTopColor: colors.border.default, paddingTop: 10, marginTop: 2, gap: 2 },
        ledgerFooterText: { fontSize: 12, color: colors.text.secondary },
        ledgerMoreBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, marginTop: 4, marginBottom: 8 },
        ledgerMoreText: { fontSize: 13, fontWeight: '700', color: colors.brand.primary },

        emptyNote: { fontSize: 13, color: colors.text.muted, fontStyle: 'italic', paddingVertical: 12 },
        centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },

        bannerPromptRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            marginTop: 10,
            marginBottom: 16,
            flexWrap: 'wrap',
        },
        addBannerBtn: {
            flex: 1,
            minWidth: 160,
            minHeight: 48,
            backgroundColor: colors.brand.fill,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 16,
        },
        addBannerBtnText: {
            color: colors.text.inverse,
            fontSize: 15,
            fontWeight: '700',
        },
        notNowBtn: {
            minHeight: 48,
            paddingHorizontal: 16,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: colors.border.default,
            backgroundColor: colors.surface.card,
        },
        notNowBtnText: {
            color: colors.text.secondary,
            fontSize: 14,
            fontWeight: '600',
        },
    }));

    const load = useCallback(() => {
        let active = true;
        setLoading(true);
        if (isEffectivePreview) {
            const d = sampleTreasuryDetail(treasuryKey);
            setDetail(d);
            setIsKeeperOfThis(false);
            setLoading(false);
            return () => { active = false; };
        }
        // Not until the phone has read its copy of the node's profile (a moment, no network): a preview asks nothing.
        if (!reader.known) return () => { active = false; };
        if (elsewhere) {
            setDetail(null);
            setLoading(false);
            return () => { active = false; };
        }
        (async () => {
            try {
                const [d, id] = await Promise.all([
                    treasuryKey ? getTreasuryDetail(treasuryKey) : Promise.resolve(null),
                    loadIdentity()
                ]);
                if (!active) return;
                if (d) setDetail(d);
                setIdentity(id);
                if (d && treasuryKey && hasShopfront(d) && readsAsMember(d)) {
                    void readOwnerListings(treasuryKey).then((rows) => { if (active) setOwnListings(rows); });
                }
                if (id?.publicKey && treasuryKey) {
                    const b: any = await getBalance(id.publicKey).catch(() => ({}));
                    if (!active) return;
                    const mine: string[] = Array.isArray(b?.keeperOf) ? b.keeperOf : [];
                    const inKeepers = Array.isArray(d?.keepers) && d.keepers.some((k: any) => !k.suspended && (k.publicKey || k.pubkey || k.memberPubkey) === id.publicKey);
                    setIsKeeperOfThis(mine.includes(treasuryKey) || inKeepers);
                } else {
                    setIsKeeperOfThis(false);
                }
            } catch {
                // handle error
            } finally {
                if (active) setLoading(false);
            }
        })();
        loadThread();
        return () => { active = false; };
    }, [treasuryKey, isEffectivePreview, elsewhere, reader.known]);

    useEffect(() => {
        if (!treasuryKey || isEffectivePreview) return;
        let live = true;
        isUserBlocked(treasuryKey).then(b => { if (live) setBlockedHere(b); }).catch(() => {});
        return () => { live = false; };
    }, [treasuryKey, isEffectivePreview]);

    const loadThread = useCallback(async () => {
        if (!treasuryKey || isEffectivePreview || !reader.known || elsewhere) return;
        try {
            const res = await getEnterpriseThread(treasuryKey);
            if (res) {
                setThreadMessages(res.messages || []);
                setThreadReadOnly(!!res.readOnly);
            }
        } catch {
            // ignore
        }
    }, [treasuryKey, isEffectivePreview, elsewhere, reader.known]);

    const handlePostThreadMessage = async () => {
        if (!treasuryKey || threadPosting || !threadInput.trim()) return;
        setThreadPosting(true);
        try {
            const res = await postEnterpriseThreadMessage(treasuryKey, threadInput.trim());
            if (res?.success) {
                setThreadInput('');
                await loadThread();
            } else {
                Alert.alert(t('Could not post'), (res as any)?.error || t('Failed to post message'));
            }
        } catch (e: any) {
            Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Could not post message'));
        } finally {
            setThreadPosting(false);
        }
    };

    useFocusEffect(load);

    const loadLedger = useCallback(async (period: LedgerPeriod) => {
        if (isEffectivePreview) {
            setLedgerLoading(true);
            setLedgerError(null);
            setLedger(sampleEnterpriseLedger(treasuryKey));
            setLedgerShown(LEDGER_PAGE);
            setLedgerLoading(false);
            return;
        }
        if (!treasuryKey || !reader.known || elsewhere) return;
        // Only the latest request may land: switching period quickly must not let a slower, older reply win.
        const request = ++ledgerRequest.current;
        setLedgerLoading(true);
        setLedgerError(null);
        try {
            const data = await getEnterpriseLedger(treasuryKey, { since: ledgerSince(period) });
            if (request !== ledgerRequest.current) return;
            setLedger(data);
            setLedgerShown(LEDGER_PAGE);
        } catch (e: any) {
            if (request !== ledgerRequest.current) return;
            setLedgerError(e?.message ? signedRequestWords(e.message) : t('Could not load the ledger'));
        } finally {
            if (request === ledgerRequest.current) setLedgerLoading(false);
        }
    }, [treasuryKey, isEffectivePreview, elsewhere, reader.known]);

    // On focus, and again whenever the period changes.
    useFocusEffect(useCallback(() => { loadLedger(ledgerPeriod); }, [loadLedger, ledgerPeriod]));

    const balance = detail?.balance ?? 0;
    // The name its members gave it, as written; the words only when there is none.
    const name = detail?.name || nameParam || t('Community Enterprise');
    const avatar = detail?.avatar || avatarParam;

    const mayBlock = !isEffectivePreview && !isKeeperOfThis && !!identity?.publicKey && !!treasuryKey;
    const handleBlockEnterprise = () => {
        if (!treasuryKey || blocking) return;
        Alert.alert(
            t('Block {name}?', { name }),
            t('This will instantly hide all posts, offers, and messages from {name}, and notify moderation.', { name }),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Block'),
                    style: 'destructive',
                    onPress: async () => {
                        setBlocking(true);
                        try {
                            // The reason goes to the node as written (moderators read it), not in the member's language.
                            if (!(await blockUser(treasuryKey, identity?.publicKey, 'Blocked from the enterprise page'))) throw new Error('not blocked');
                            setBlockedHere(true);
                            setShowMoreMenu(false);
                            Alert.alert(t('{name} has been blocked and removed from your feed.', { name }), undefined, [
                                { text: t('OK'), onPress: () => router.back() },
                            ]);
                        } catch {
                            Alert.alert(t('Error'), t('Failed to block user. Please try again.'));
                        } finally {
                            setBlocking(false);
                        }
                    },
                },
            ],
        );
    };

    const banner = seasonBanner(detail);

    const availableToBack = detail?.availableToBack ?? 0;
    const myPendingRequest = detail?.myPendingRequest || null;
    const keeperList: any[] = (detail?.keepers || []).map((k: any) => ({ ...k, publicKey: k.publicKey || k.pubkey || k.memberPubkey }));
    const myPubkey: string | null = identity?.publicKey ?? null;
    /**
     * A project has a leader and collaborators; an enterprise a lead keeper and keepers (pick 8). Each sentence is written
     * whole for each kind (`project`), never with kw's words glued in, so a language can inflect them.
     */
    const kw = keeperWords(detail?.lifecycle);
    const project = kw.kind === 'project';
    const hasBanner = !!shopPhotoOf(detail?.shop);
    const faceOpen = !['completed', 'disabled', 'suspended', 'pruned'].includes(detail?.status);
    const showAddBanner = !elsewhere && !isEffectivePreview && !project && isKeeperOfThis && !hasBanner && !bannerDismissed && faceOpen;
    // Manage, its keepers' console: a keeper of it, or whom the node says leads it or administers the node. In a preview,
    // what a keeper would see, saying why it lives in a local community.
    const showsManage = isEffectivePreview || (!!treasuryKey && !!detail && mayManage(detail, isKeeperOfThis));
    const openManage = () => {
        if (isEffectivePreview) { setPreviewManage(true); return; }
        router.push({ pathname: '/treasury-manage', params: { publicKey: treasuryKey!, name } });
    };

    // The shopfront (S5): who keeps it with their badges, whom Message writes to, whether this reader gets a member's page
    // (a preview shows everything), and its listings: with photos and stamps when read, else the detail's own text ones.
    const shopfrontKeepers = readKeepers(detail?.keepers);
    const leadKeeper = leadKeeperOf(shopfrontKeepers);
    const memberView = isEffectivePreview || readsAsMember(detail);
    const shopListings: ShopfrontListing[] = ownListings ?? listingsFromDetailPosts(detail?.posts);
    const openListingHere = (id: string) => { if (!isEffectivePreview) openListing(id); };
    const handleMessageLead = async () => {
        if (!leadKeeper || !myPubkey || messagingLead) return;
        setMessagingLead(true);
        try {
            if (await isUserBlocked(leadKeeper.publicKey)) {
                Alert.alert(t('You have blocked {name}', { name: leadKeeper.callsign }), t('Unblock them from their profile to write to them.'));
                return;
            }
            const conv = await createConversationApi('dm', [myPubkey, leadKeeper.publicKey], myPubkey);
            router.push(`/chat/${conv.id}`);
        } catch (e: any) {
            const said: string = e?.message ?? '';
            const offline = !said || /off-grid|network|fetch failed|failed to fetch|offline|timeout|abort/i.test(said);
            Alert.alert(t('Error'), offline ? t('Connect to your community to start a chat.') : signedRequestWords(said));
        } finally {
            setMessagingLead(false);
        }
    };

    const handleJoinRequest = async () => {
        if (!treasuryKey || submittingJoin) return;
        const available = detail?.availableToBack ?? 0;
        const amt = Number(joinBackingPledge);
        if (isNaN(amt) || amt < 0) {
            Alert.alert(t('Invalid Backing'), t('Please enter 0 or a positive number of standing beans.'));
            return;
        }
        if (amt > available) {
            Alert.alert(t('Exceeds Available Standing'), project
                ? tn(available, 'You have {n} Beans of standing available to back this project.', 'You have {n} Beans of standing available to back this project.')
                : tn(available, 'You have {n} Beans of standing available to back this enterprise.', 'You have {n} Beans of standing available to back this enterprise.'));
            return;
        }
        setSubmittingJoin(true);
        try {
            await requestToJoinEnterprise(treasuryKey, amt);
            Alert.alert(t('Request Submitted 🌱'), project
                ? t('Your request to join as a collaborator with {amount} 🫘 backing has been submitted for review.', { amount: amt })
                : t('Your request to join as a keeper with {amount} 🫘 backing has been submitted for review.', { amount: amt }));
            load();
        } catch (e: any) {
            Alert.alert(t('Request Failed'), e.message ? signedRequestWords(e.message) : (project ? t('Could not submit collaborator request.') : t('Could not submit keeper request.')));
        } finally {
            setSubmittingJoin(false);
        }
    };

    const handlePledge = async () => {
        if (!treasuryKey || pledging) return;
        // The language's decimal mark (core parseAmount): fr "12,5" is 12.5, never refused as not a number; "1.000", which
        // could be a thousand, is refused in words that say so. The cents guard below decides the decimals, as before.
        const read = parseAmount(pledgeAmount, undefined, ANY_DECIMALS);
        if (!read.ok && isAmbiguousAmount(read.refusal)) {
            Alert.alert(t('Invalid Amount'), amountRefusalWords(read.refusal));
            return;
        }
        const amt = read.ok ? read.value : NaN;
        if (isNaN(amt) || amt <= 0) {
            Alert.alert(t('Invalid Amount'), t('Please enter a positive number of Beans to pledge.'));
            return;
        }
        // To the cent, as the node takes it (core isWholeCents).
        if (!isWholeCents(amt)) {
            Alert.alert(t('Invalid amount'), t('The amount is a number of Beans above 0, to the cent.'));
            return;
        }
        setPledging(true);
        try {
            await treasuryPledge(treasuryKey, amt, pledgeMemo.trim() || undefined);
            Alert.alert(t('Pledge Successful! 🌱'), t('Thank you for pledging {amount} 🫘 to {name}.', { amount: amt, name }));
            setPledgeAmount('');
            setPledgeMemo('');
            load();
        } catch (e: any) {
            const message = e?.code === 'project_closed'
                ? t("This project's deadline has passed: it takes no more pledges.")
                : (e.message ? signedRequestWords(e.message) : t('Could not complete pledge.'));
            Alert.alert(t('Pledge Failed'), message);
        } finally {
            setPledging(false);
        }
    };

    /** The deadline badge's words, and whether it has passed (the badge's colour). */
    const getDaysRemaining = (deadline: string | null): { text: string; expired: boolean } | null => {
        if (!deadline) return null;
        const days = deadlineDaysRemaining(deadline);
        if (days < 0) return { text: t('Expired'), expired: true };
        if (days === 0) return { text: t('Ends today'), expired: false };
        // English has always said "days" for every count.
        return { text: tn(days, '{n} days left', '{n} days left'), expired: false };
    };

    /** "19 Oct, 9:05": core's date and time, in the member's language (never the device's toLocaleString). */
    const formatTime = (when: any) => {
        try {
            const d = new Date(typeof when === 'number' ? when : String(when));
            if (isNaN(d.getTime())) return '';
            return t('{date}, {time}', { date: formatDate(d, 'day-month'), time: formatDate(d, 'time') });
        } catch { return ''; }
    };

    const flow: any[] = detail?.flow || [];
    const deferredClaims: any[] = detail?.deferredClaims || [];
    const pendingClaims = deferredClaims.filter((c: any) => c.status === 'pending');
    const pendingClaimsTotal = pendingClaims.reduce((sum: number, c: any) => sum + (Number(c.amount) || 0), 0);

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Go back')}>
                    <MaterialCommunityIcons name="chevron-left" size={30} color={colors.text.heading} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1}>{name}</Text>
                {showsManage && (
                    <Pressable onPress={openManage} style={styles.manageBtn} accessibilityRole="button" testID="enterprise-manage">
                        <MaterialCommunityIcons name="cog-outline" size={18} color={colors.brand.primary} />
                        <Text style={styles.manageText} numberOfLines={1}>{t('Manage', undefined, "a button: its keepers' console")}</Text>
                    </Pressable>
                )}
            </View>
            {isEffectivePreview && <LocalCommunitySheet feature="enterprises" visible={previewManage} onClose={() => setPreviewManage(false)} />}

            {loading ? (
                <View style={styles.centerFill}><ActivityIndicator color={colors.brand.primary} /></View>
            ) : !detail && elsewhere ? (
                <View style={styles.centerFill} testID="enterprise-elsewhere">
                    <LocalCommunityMark variant="line" feature="enterprises" text={t('🏘️ Enterprises live in a local community ›')} />
                </View>
            ) : !detail ? (
                <View style={styles.centerFill}>
                    <Text style={styles.emptyNote}>{t("Couldn't load this group. Check your connection.")}</Text>
                </View>
            ) : (
                <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                    {/* No keyboardVerticalOffset: keyboard-controller measures this view's absolute frame, so the old
                        64 was added on top and left ~64dp of blank space above the keyboard. */}
                    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                        {isEffectivePreview && (
                            <View style={{ marginHorizontal: -16, marginTop: -16, marginBottom: 12 }}>
                                <LocalCommunityMark variant="strip" feature="enterprises" />
                                <ExampleHeader />
                            </View>
                        )}
                        {/* The shopfront (DESIGN-shops-round3-enterprise-shopfront-fable.md §3, S5): its banner (its shop's one photo, or a
                            quiet block in its category's emoji), its logo (its avatar), its name, its category and since when, and what kind of
                            group it is. */}
                        <ShopfrontHeader
                            name={name}
                            ownerKey={treasuryKey ?? ''}
                            logoUrl={avatar}
                            category={shopCategoryOf(detail?.shop)}
                            bannerPhoto={shopPhotoOf(detail?.shop)}
                            fallbackEmoji={detail?.lifecycle === 'bounded' ? '🌱' : '🏛️'}
                            lines={[categorySinceLine(shopCategoryOf(detail?.shop), sinceLine(detail?.since)), groupKindLine(detail?.lifecycle)]}
                        />

                        {showAddBanner && (
                            <View style={styles.bannerPromptRow}>
                                <Pressable
                                    onPress={handlePickBanner}
                                    style={[styles.addBannerBtn, pickingBanner && { opacity: 0.6 }]}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Add a banner photo')}
                                    disabled={pickingBanner}
                                >
                                    <Text style={styles.addBannerBtnText}>{t('Add a banner photo')}</Text>
                                </Pressable>
                                <Pressable
                                    onPress={handleDismissBanner}
                                    style={[styles.notNowBtn, pickingBanner && { opacity: 0.5 }]}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Not now')}
                                    disabled={pickingBanner}
                                >
                                    <Text style={styles.notNowBtnText}>{t('Not now')}</Text>
                                </Pressable>
                            </View>
                        )}

                        {/* State banner every member sees (docs/the-commons.md §2.2) */}
                        {banner && (() => {
                            const tone = banner.kind === 'paused'
                                ? { box: styles.bannerPaused, fg: colors.feedback.warning.fg, line: colors.feedback.warning.border }
                                : banner.kind === 'winding_up'
                                    ? { box: styles.bannerWindingUp, fg: colors.feedback.danger.fg, line: colors.feedback.danger.border }
                                    : { box: styles.bannerCompleted, fg: colors.text.heading, line: colors.border.strong };
                            const emoji = banner.kind === 'paused' ? '❄️' : banner.kind === 'winding_up' ? '⏳' : '🏁';
                            return (
                                <View
                                    style={[styles.banner, tone.box]}
                                    accessible
                                    accessibilityRole="alert"
                                    accessibilityLiveRegion="polite"
                                >
                                    <View style={styles.bannerLabelRow}>
                                        <Text style={{ fontSize: 16 }} accessibilityElementsHidden importantForAccessibility="no">{emoji}</Text>
                                        <Text style={[styles.bannerLabel, { color: tone.fg }]}>{inCapitalsOf(banner.label)}</Text>
                                    </View>
                                    <Text style={[styles.bannerHeadline, { color: tone.fg }]}>{banner.headline}</Text>
                                    <Text style={[styles.bannerBody, { color: tone.fg }]}>{banner.body}</Text>
                                    {banner.kind === 'paused' && !!banner.warning && (
                                        <Text style={[styles.bannerWarning, { color: tone.fg, borderTopColor: tone.line }]}>⚠️ {banner.warning}</Text>
                                    )}
                                    {banner.kind === 'winding_up' && !!banner.graceEndedNote && (
                                        <Text style={[styles.bannerWarning, { color: tone.fg, borderTopColor: tone.line }]}>{banner.graceEndedNote}</Text>
                                    )}
                                </View>
                            );
                        })()}

                        {/* What it is for, the Commons' statement of it (docs/the-commons.md §2.1) */}
                        {!!detail?.purpose && <ShopfrontText title={t('What it is for')} text={detail.purpose} lines={3} testID="shopfront-purpose" />}

                        {/* Who keeps it, each with their badges: recognition, which gates nothing (round 3 §0 row 6). Not a button in a preview. */}
                        <ShopfrontKeepers keepers={shopfrontKeepers} project={project} navigable={!isEffectivePreview} />

                        {/* Funding Progress (for Bounded Enterprises with a goal) */}
                        {detail?.goalAmount != null && detail.goalAmount > 0 && (() => {
                            const current = detail.currentAmount != null ? detail.currentAmount : Math.max(0, balance);
                            const goal = detail.goalAmount;
                            const progress = Math.min(100, (current / goal) * 100);
                            const isFunded = current >= goal || detail?.status === 'funded' || detail?.status === 'completed';
                            const daysRemaining = getDaysRemaining(detail.deadlineAt);
                            // The node takes a pledge only while the enterprise is active: otherwise a sentence, not a box.
                            const pledgesClosed = pledgeClosedLine(detail?.status, detail?.lifecycle, detail?.deadlineAt);
                            return (
                                <View style={styles.progressCard}>
                                    <View style={styles.progressHeader}>
                                        <View>
                                            <Text style={[styles.currentAmt, isFunded && { color: colors.brand.primary }]}>
                                                <Sentence
                                                    text={t('{amount} 🫘 {raised}', { amount: current })}
                                                    parts={{ raised: <Text style={styles.progressLabel}>{t('raised', undefined, 'pledges towards a goal')}</Text> }}
                                                />
                                            </Text>
                                            <Text style={styles.goalAmt}>{t('Goal: {amount} 🫘', { amount: goal })}</Text>
                                        </View>
                                        {daysRemaining && (
                                            <Text style={[styles.deadlineBadge, daysRemaining.expired && styles.deadlineExpired]}>
                                                ⏳ {daysRemaining.text}
                                            </Text>
                                        )}
                                    </View>
                                    <View style={styles.progressBarBg}>
                                        <View style={[styles.progressBarFill, { width: `${progress}%`, backgroundColor: isFunded ? colors.brand.fill : colors.accent.fill }]} />
                                    </View>
                                    <Text style={styles.escrowNotice}>
                                        {isFunded
                                            ? (project
                                                ? t("🎉 This project reached its funding goal! Pledged funds are held securely in the project's account.")
                                                : t("🎉 This enterprise reached its funding goal! Pledged funds are held securely in the enterprise's account."))
                                            : (project
                                                ? t("🔒 Pledges are held securely in the project's account, spendable only on transparent offers and needs that the whole community can see.")
                                                : t("🔒 Pledges are held securely in the enterprise's account, spendable only on transparent offers and needs that the whole community can see."))}
                                    </Text>

                                    {/* Inline Pledge Beans Input */}
                                    {/* In preview (Example Valley's): the marker, never the box. */}
                                    {isEffectivePreview ? (
                                        <View style={styles.pledgeBox} testID="pledge-preview">
                                            <Text style={[styles.sectionLabel, { marginBottom: 8 }]}>
                                                {inCapitalsOf(t('Back this initiative'))}
                                            </Text>
                                            <LocalCommunityMark variant="action" feature="enterprises" label={t('Pledge')} />
                                        </View>
                                    ) : (<>
                                    {pledgesClosed ? (
                                        <View style={styles.pledgeBox} testID="pledges-closed">
                                            <Text style={styles.pledgeClosedText}>{pledgesClosed}</Text>
                                        </View>
                                    ) : (
                                        <View style={styles.pledgeBox}>
                                        <View style={styles.pledgeInputRow}>
                                            <TextInput
                                                accessibilityLabel={t('Pledge amount')}
                                                style={styles.pledgeAmountInput}
                                                placeholder={t('Amount (🫘)')}
                                                placeholderTextColor={colors.text.muted}
                                                keyboardType="numeric"
                                                value={pledgeAmount}
                                                onChangeText={setPledgeAmount}
                                            />
                                            <TextInput
                                                accessibilityLabel={t('Pledge memo')}
                                                style={styles.pledgeMemoInput}
                                                placeholder={t('Memo (optional)')}
                                                placeholderTextColor={colors.text.muted}
                                                value={pledgeMemo}
                                                onChangeText={setPledgeMemo}
                                            />
                                        </View>
                                        <Pressable
                                            style={[styles.pledgeButton, (pledging || !pledgeAmount.trim()) && { opacity: 0.6 }]}
                                            disabled={pledging || !pledgeAmount.trim()}
                                            onPress={handlePledge}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('Pledge Beans')}
                                            accessibilityState={{ disabled: pledging || !pledgeAmount.trim(), busy: pledging }}
                                        >
                                            {pledging ? (
                                                <ActivityIndicator color={colors.text.inverse} />
                                            ) : (
                                                <Text style={styles.pledgeButtonText}>{t('PLEDGE BEANS 🌱')}</Text>
                                            )}
                                        </Pressable>
                                    </View>
                                    )}
                                    </>)}
                                </View>
                            );
                        })()}

                        {/* About, in its keepers' words (members.bio, round 3 §0 row 5) */}
                        {!!detail?.about && <ShopfrontText title={t('About')} text={detail.about} testID="shopfront-about" />}

                        {/* What it offers: Featured, what its keepers do together, its sections. A member's (round 3 §5): a visitor's page ends at How we deal. */}
                        {memberView && (
                            <>
                                <ShopfrontFeatured listings={featuredOf(shopListings)} showsBeans onOpen={openListingHere} />
                                <ShopfrontTogether categories={Array.isArray(detail?.offerCategories) ? detail.offerCategories : []} />
                                <ShopfrontSections sections={shopSectionsOf(shopListings)} showsBeans empty={t('No live listings yet.')} onOpen={openListingHere} />
                            </>
                        )}

                        {/* How we deal, its shop's words */}
                        {!!detail?.shop?.howToDeal && <ShopfrontText title={t('How we deal')} text={detail.shop.howToDeal} boxed testID="shopfront-how" />}

                        {!memberView && (
                            <ShopfrontVisitorNote text={t("Members of this community see what it offers, its keepers' badges and its accounts.")} />
                        )}

                        {/* Past here, a member's page only. */}
                        {memberView && (<>
                        {/* Message: a DM to the lead keeper, named (round 3 §0 row 10). Not to themselves, and none in a preview. */}
                        {!isEffectivePreview && leadKeeper && leadKeeper.publicKey !== myPubkey && !!myPubkey && (
                            <ShopfrontMessage label={messageLabel(leadKeeper.callsign, project ? 'project' : 'enterprise')} busy={messagingLead} onPress={handleMessageLead} />
                        )}

                        {/* Ask to Join as a Keeper (for non-keepers when enterprise is not completed) */}
                        {isEffectivePreview ? (
                            <View style={styles.joinCard}>
                                {/* In capitals in the words themselves: a translated sentence is never toUpperCase()d. */}
                                <Text style={styles.joinTitle}>{project ? t('🤝 ASK TO JOIN AS A COLLABORATOR') : t('🤝 ASK TO JOIN AS A KEEPER')}</Text>
                                <Text style={styles.joinDesc}>
                                    {project
                                        ? t('Help run this project. You can back it with your earned trading standing to expand its credit floor.')
                                        : t('Help run this enterprise. You can back it with your earned trading standing to expand its credit floor.')}
                                </Text>
                                <LocalCommunityMark variant="action" feature="enterprises" label={project ? t('Join as collaborator') : t('Join as keeper')} />
                            </View>
                        ) : identity && !isKeeperOfThis && detail?.status !== 'completed' && (
                            myPendingRequest ? (
                                <View style={styles.pendingRequestBanner}>
                                    <Text style={styles.pendingRequestTitle}>{project ? t('⏳ COLLABORATOR REQUEST PENDING') : t('⏳ KEEPER REQUEST PENDING')}</Text>
                                    <Text style={styles.pendingRequestText}>
                                        {myPendingRequest.pendingChange
                                            ? approvedApplicantText(myPendingRequest.pendingChange.appliesAt, undefined, kw)
                                            : project
                                                ? t('You asked to join this project with {amount} 🫘 of backing standing. Awaiting review by the leader.', { amount: myPendingRequest.pledgedBacking })
                                                : t('You asked to join this enterprise with {amount} 🫘 of backing standing. Awaiting review by the lead keeper.', { amount: myPendingRequest.pledgedBacking })}
                                    </Text>
                                </View>
                            ) : (
                                <View style={styles.joinCard}>
                                    <Text style={styles.joinTitle}>{project ? t('🤝 ASK TO JOIN AS A COLLABORATOR') : t('🤝 ASK TO JOIN AS A KEEPER')}</Text>
                                    <Text style={styles.joinDesc}>
                                        {project
                                            ? t('Help run this project. You can back it with your earned trading standing to expand its credit floor.')
                                            : t('Help run this enterprise. You can back it with your earned trading standing to expand its credit floor.')}
                                    </Text>

                                    <Text style={[styles.sectionLabel, { marginBottom: 6 }]}>
                                        {inCapitalsOf(project
                                            ? t('Back this project with your standing: 0 … {n}', { n: availableToBack })
                                            : t('Back this enterprise with your standing: 0 … {n}', { n: availableToBack }))}
                                    </Text>
                                    <View style={styles.joinInputRow}>
                                        <TextInput
                                            style={styles.joinInput}
                                            value={joinBackingPledge}
                                            onChangeText={(typed) => {
                                                // Whole Beans of standing, read as every typed amount is (core parseAmount).
                                                const read = parseAmount(typed, undefined, ANY_DECIMALS);
                                                const raw = Math.floor(read.ok ? read.value : 0);
                                                const clamped = Math.max(0, Math.min(availableToBack, raw));
                                                setJoinBackingPledge(isNaN(raw) ? '0' : String(clamped));
                                            }}
                                            keyboardType="numeric"
                                            accessibilityLabel={project
                                                ? t('Back this project with your standing: 0 to {n}', { n: availableToBack })
                                                : t('Back this enterprise with your standing: 0 to {n}', { n: availableToBack })}
                                        />
                                        <Text style={styles.joinAvailableText}>
                                            {t('/ {n} 🫘 available', { n: availableToBack })}
                                        </Text>
                                    </View>
                                    <Text style={{ fontSize: 11, color: colors.text.muted, marginBottom: 12 }}>
                                        {project
                                            ? t('A pledge of 0 is valid: someone who helps run it without pledging standing can still be a collaborator.')
                                            : t('A pledge of 0 is valid: someone who helps run it without pledging standing can still be a keeper.')}
                                    </Text>

                                    <Pressable
                                        style={[styles.joinButton, (submittingJoin || Number(joinBackingPledge) > availableToBack) && styles.joinButtonDisabled]}
                                        disabled={submittingJoin || Number(joinBackingPledge) > availableToBack}
                                        onPress={handleJoinRequest}
                                        accessibilityRole="button"
                                        accessibilityLabel={project ? t('Request to join as a collaborator') : t('Request to join as a keeper')}
                                    >
                                        {submittingJoin ? (
                                            <ActivityIndicator size="small" color={colors.text.inverse} />
                                        ) : (
                                            <Text style={styles.joinButtonText}>{project ? t('Request to join as a collaborator') : t('Request to join as a keeper')}</Text>
                                        )}
                                    </Pressable>
                                </View>
                            )
                        )}

                        {/* The money in one line, and today's figures and its ledger behind "Money and backing" (round 3 §0 row 9): public
                            to every member as the Commons design says. Open from the start in a preview, which shows everything. */}
                        <ShopfrontMoney line={moneyLine(balance, Number(detail.creditLine ?? 0))} initiallyOpen={isEffectivePreview}>
                            {/* Balance */}
                            <View style={styles.balanceCard}>
                                <Text style={styles.balanceLabel}>{inCapitalsOf(t('Balance'))}</Text>
                                <Text style={[styles.balanceValue, balance < 0 ? styles.balanceNeg : styles.balancePos]}>{formatNumber(balance)} 🫘</Text>
                                <View style={styles.balanceMetaRow}>
                                    <View style={styles.metaBox}>
                                        <Text style={styles.metaLabel}>{inCapitalsOf(t('Credit line'))}</Text>
                                        <Text style={styles.metaValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{formatNumber(Number(detail.creditLine ?? 0))} 🫘</Text>
                                    </View>
                                    <View style={styles.metaBox}>
                                        <Text style={styles.metaLabel}>{inCapitalsOf(t('Live offers'))}</Text>
                                        <Text style={styles.metaValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{formatNumber(Number(detail.liveOffers ?? 0))}</Text>
                                    </View>
                                </View>
                                <View style={styles.balanceMetaRow}>
                                    <View style={styles.metaBox}>
                                        <Text style={styles.metaLabel}>{inCapitalsOf(t('Earned surplus'))}</Text>
                                        <Text style={styles.metaValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{formatNumber(Number(detail.earnedSurplus ?? 0))} 🫘</Text>
                                    </View>
                                    <View style={styles.metaBox}>
                                        <Text style={styles.metaLabel}>{inCapitalsOf(t('Capital ceiling'))}</Text>
                                        <Text style={styles.metaValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{detail.workingCapitalCeiling != null ? `${formatNumber(Number(detail.workingCapitalCeiling))} 🫘` : t('Uncapped')}</Text>
                                    </View>
                                </View>
                                {balance < 0 && (
                                    <View
                                        accessible={true}
                                        accessibilityRole="alert"
                                        accessibilityLabel={project
                                            ? t('Warning: Operator eats last. This project is currently in deficit with {amount} beans. Credit buys inputs and supplies, but collaborators can only be paid from profit. Collaborators cannot be paid while the project is in deficit.', { amount: balance })
                                            : t('Warning: Operator eats last. This enterprise is currently in deficit with {amount} beans. Credit buys inputs and supplies, but keepers can only be paid from profit. Keepers cannot be paid while the enterprise is in deficit.', { amount: balance })}
                                        style={{ marginTop: 12, padding: 10, backgroundColor: colors.surface.app, borderRadius: 10, borderWidth: 1, borderColor: colors.feedback.warning.solid }}
                                    >
                                        <Text style={{ fontSize: 11, color: colors.feedback.warning.fg, fontWeight: '700', lineHeight: 16 }}>
                                            {project
                                                ? t('⚠️ OPERATOR EATS LAST: This project is currently in deficit ({amount} 🫘). Credit buys inputs and supplies, but collaborators can only be paid from profit. Collaborators cannot be paid while the project is in deficit.', { amount: balance })
                                                : t('⚠️ OPERATOR EATS LAST: This enterprise is currently in deficit ({amount} 🫘). Credit buys inputs and supplies, but keepers can only be paid from profit. Keepers cannot be paid while the enterprise is in deficit.', { amount: balance })}
                                        </Text>
                                    </View>
                                )}
                                {pendingClaims.length > 0 && (
                                    <View style={{ marginTop: 12, padding: 12, backgroundColor: colors.surface.app, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                            <Text style={{ flex: 1, minWidth: 0, fontSize: 11, color: colors.text.secondary, fontWeight: '700', letterSpacing: 0.4 }}>
                                                {inCapitalsOf(t('Pending Wage Claims ({n})', { n: pendingClaims.length }))}
                                            </Text>
                                            <Text style={{ flexShrink: 0, fontSize: 13, fontWeight: '800', color: colors.feedback.warning.fg }}>
                                                {formatNumber(pendingClaimsTotal)} 🫘
                                            </Text>
                                        </View>
                                        <Text style={{ fontSize: 11, color: colors.text.secondary, marginTop: 4, lineHeight: 15 }}>
                                            {project
                                                ? t('Deferred until the project earns sufficient trading profit. Paid automatically from future sales.')
                                                : t('Deferred until the enterprise earns sufficient trading profit. Paid automatically from future sales.')}
                                        </Text>
                                    </View>
                                )}
                            </View>

                            {/* What each keeper backs it with, as their chips said before the shopfront (#106). */}
                            {keeperList.some((k: any) => Number(k.backing) > 0) && (
                                <View style={styles.plCard} testID="enterprise-backing">
                                    <Text style={styles.plTitle}>{inCapitalsOf(project ? t('Backed by its collaborators') : t('Backed by its keepers'))}</Text>
                                    {keeperList.filter((k: any) => Number(k.backing) > 0).map((k: any) => (
                                        <Text key={k.publicKey} style={[styles.ledgerWith, { marginTop: 6 }]}>
                                            {t('{name} · {amount} 🫘', { name: k.callsign, amount: formatNumber(Number(k.backing)) }, "a keeper's backing")}
                                        </Text>
                                    ))}
                                </View>
                            )}

                            {/* Income & Spend (P&L) — transparent accounting, visible to every member */}
                            <View style={styles.plCard}>
                                <Text style={styles.plTitle}>{inCapitalsOf(t('📊 Income & Spend (P&L)'))}</Text>
                                <Text style={styles.plSubtitle}>{t('Transparent accounting · visible to every member')}</Text>

                                <View style={styles.periodStrip} accessibilityRole="tablist">
                                    {LEDGER_PERIODS.map((p) => {
                                        const selected = ledgerPeriod === p.key;
                                        return (
                                            <Pressable
                                                key={p.key}
                                                style={[styles.periodTab, p.key === 'all' && { flex: 1.6 }, selected && styles.periodTabActive]}
                                                onPress={() => setLedgerPeriod(p.key)}
                                                accessibilityRole="tab"
                                                accessibilityLabel={t(p.a11y)}
                                                accessibilityState={{ selected }}
                                            >
                                                <Text style={[styles.periodTabText, selected && styles.periodTabTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} maxFontSizeMultiplier={1.1}>
                                                    {t(p.label)}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>

                                {(() => {
                                    const pl = plSummaryText(ledger?.summary);
                                    return (
                                        <>
                                            <View style={styles.plSummaryRow}>
                                                <View style={[styles.plBox, { backgroundColor: colors.feedback.success.bg, borderColor: colors.feedback.success.border }]}>
                                                    <Text style={[styles.plBoxLabel, { color: colors.feedback.success.fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{inCapitalsOf(t('Came in'))}</Text>
                                                    <Text style={[styles.plBoxValue, { color: colors.feedback.success.fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                                                        {pl.cameIn}
                                                    </Text>
                                                </View>
                                                <View style={[styles.plBox, { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border }]}>
                                                    <Text style={[styles.plBoxLabel, { color: colors.feedback.warning.fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{inCapitalsOf(t('Went out'))}</Text>
                                                    <Text style={[styles.plBoxValue, { color: colors.feedback.warning.fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                                                        {pl.wentOut}
                                                    </Text>
                                                </View>
                                            </View>
                                            <View style={[styles.plBox, { flex: 0, marginBottom: pl.feeNote ? 6 : 10, backgroundColor: colors.surface.app, borderColor: colors.border.default }]}>
                                                <Text style={[styles.plBoxLabel, { color: colors.text.secondary }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{inCapitalsOf(t('Net change'))}</Text>
                                                <Text style={[styles.plBoxValue, { color: pl.netIsPositive ? colors.feedback.success.fg : colors.feedback.warning.fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                                                    {pl.net}
                                                </Text>
                                            </View>
                                            {pl.feeNote && (
                                                <Text style={styles.plFeeNote}>{pl.feeNote}</Text>
                                            )}
                                        </>
                                    );
                                })()}

                                {ledgerLoading ? (
                                    <Text style={styles.emptyNote}>{t('Loading ledger records…')}</Text>
                                ) : ledgerError ? (
                                    <View style={{ paddingVertical: 8 }}>
                                        <Text style={{ fontSize: 13, color: colors.feedback.danger.fg, textAlign: 'center' }}>{ledgerError}</Text>
                                        <Pressable style={styles.ledgerMoreBtn} onPress={() => loadLedger(ledgerPeriod)} accessibilityRole="button">
                                            <Text style={styles.ledgerMoreText}>{t('Try again')}</Text>
                                        </Pressable>
                                    </View>
                                ) : !ledger?.entries?.length ? (
                                    <Text style={styles.emptyNote}>{t('No transactions recorded for this period.')}</Text>
                                ) : (() => {
                                    // Newest first on a phone; the node sends them oldest first.
                                    const newestFirst = [...ledger.entries].reverse();
                                    const visible = newestFirst.slice(0, ledgerShown);
                                    const remaining = newestFirst.length - visible.length;
                                    return (
                                        <View>
                                            {visible.map((entry) => {
                                                const labels = ledgerLineLabels(entry);
                                                const income = entry.direction === 'income';
                                                const amountColor = income ? colors.feedback.success.fg : colors.feedback.warning.fg;
                                                const when = formatTime(entry.timestamp);
                                                return (
                                                    <View
                                                        key={entry.id}
                                                        style={styles.ledgerRow}
                                                        accessible
                                                        accessibilityLabel={tn(entry.runningBalance, '{flow}, {amount}, {what}, with {with}, {when}. Running balance {n} beans.', '{flow}, {amount}, {what}, with {with}, {when}. Running balance {n} beans.', {
                                                            flow: labels.flow, amount: signedBeans(entry.amount, entry.direction), what: labels.what, with: labels.with, when,
                                                            n: formatNumber(entry.runningBalance, 2),
                                                        })}
                                                    >
                                                        <View style={styles.ledgerLine}>
                                                            <Text style={styles.ledgerWhat} numberOfLines={2}>{labels.what}</Text>
                                                            <Text style={[styles.ledgerAmount, { color: amountColor }]} numberOfLines={1}>{signedBeans(entry.amount, entry.direction)}</Text>
                                                        </View>
                                                        <Text style={styles.ledgerWith} numberOfLines={1}>
                                                            <Sentence
                                                                text={t('{flow} · with {name}', { name: labels.with })}
                                                                parts={{ flow: <Text style={[styles.ledgerFlow, { color: amountColor }]}>{labels.flow}</Text> }}
                                                            />
                                                        </Text>
                                                        <View style={styles.ledgerLine}>
                                                            <Text style={styles.ledgerWhen} numberOfLines={1}>{when}</Text>
                                                            <Text style={styles.ledgerRunning} numberOfLines={1}>{t('Balance {amount} 🫘', { amount: formatNumber(entry.runningBalance, 2) })}</Text>
                                                        </View>
                                                    </View>
                                                );
                                            })}
                                            {remaining > 0 && (
                                                <Pressable style={styles.ledgerMoreBtn} onPress={() => setLedgerShown((n) => n + LEDGER_PAGE)} accessibilityRole="button">
                                                    <Text style={styles.ledgerMoreText}>{tn(remaining, 'Show {shown} more ({n} older)', 'Show {shown} more ({n} older)', { shown: Math.min(LEDGER_PAGE, remaining) })}</Text>
                                                </Pressable>
                                            )}
                                            <View style={styles.ledgerFooter}>
                                                <Text style={styles.ledgerFooterText}>
                                                    <Sentence
                                                        text={t('Starting balance: {amount}')}
                                                        parts={{ amount: <Text style={{ fontWeight: '800', color: colors.text.body }}>{formatNumber(ledger.summary.startingBalance, 2)} 🫘</Text> }}
                                                    />
                                                </Text>
                                                <Text style={styles.ledgerFooterText}>
                                                    <Sentence
                                                        text={t('Ending balance: {amount}')}
                                                        parts={{ amount: <Text style={{ fontWeight: '800', color: colors.text.body }}>{formatNumber(ledger.summary.endingBalance, 2)} 🫘</Text> }}
                                                    />
                                                </Text>
                                            </View>
                                        </View>
                                    );
                                })()}
                            </View>
                        </ShopfrontMoney>

                        {/* Recent activity */}
                        <Text style={styles.sectionLabel}>{inCapitalsOf(t('Recent activity'))}</Text>
                        {flow.length === 0 ? (
                            <Text style={styles.emptyNote}>{t('No transactions yet.')}</Text>
                        ) : flow.map((f, i) => (
                            <View key={i} style={[styles.flowRow, i === flow.length - 1 && { borderBottomWidth: 0 }]}>
                                <View style={[styles.flowIcon, { backgroundColor: f.incoming ? colors.brand.tint : colors.surface.subtle }]}>
                                    <MaterialCommunityIcons name={f.incoming ? 'arrow-down' : 'arrow-up'} size={16} color={f.incoming ? colors.brand.primary : colors.text.secondary} />
                                </View>
                                <View style={{ flex: 1, minWidth: 0 }}>
                                    <Text style={styles.flowMemo} numberOfLines={1}>{f.memo || (f.incoming ? t('Received', undefined, 'Beans came in') : t('Sent', undefined, 'Beans went out'))}</Text>
                                    <Text style={styles.flowTime}>{formatTime(f.timestamp)}</Text>
                                </View>
                                <Text style={[styles.flowAmount, { color: f.incoming ? colors.brand.primary : colors.feedback.warning.fg }]}>
                                    {f.incoming ? '+' : '−'}{formatNumber(Math.abs(f.amount))} 🫘
                                </Text>
                            </View>
                        ))}

                        {/* Enterprise Discussion Thread (Slice 6) */}
                        <View style={styles.threadCard}>
                            <View style={styles.threadHeader}>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.threadTitle}>{t('Discussion')}</Text>
                                    <Text style={styles.threadSubtitle}>{project ? t('Public coordination for this project') : t('Public coordination for this enterprise')}</Text>
                                </View>
                                <MaterialCommunityIcons name="forum-outline" size={22} color={colors.brand.primary} />
                            </View>

                            {threadReadOnly && (
                                <View style={styles.threadReadOnlyBanner}>
                                    <Text style={styles.threadReadOnlyText}>
                                        {project
                                            ? t('Project has wound up — discussion thread is read-only.')
                                            : t('Enterprise has wound up — discussion thread is read-only.')}
                                    </Text>
                                </View>
                            )}

                            {isEffectivePreview ? (
                                // Example Valley's: no thread to start here, so no "Start the conversation!" (review N4).
                                <View testID="thread-preview">
                                    <LocalCommunityMark variant="line" feature="enterprises" text={project
                                        ? t('🏘️ In a local community its collaborators and members talk it over here ›')
                                        : t('🏘️ In a local community its keepers and members talk it over here ›')} />
                                </View>
                            ) : threadMessages.length === 0 ? (
                                <Text style={styles.emptyNote}>{t('No messages yet. Start the conversation!')}</Text>
                            ) : (
                                threadMessages.map((m: any, idx: number) => {
                                    const isRemoved = m.type === 'removed';
                                    // A member's name as written, or the start of their key; the word only when there is neither.
                                    const authorName = m.authorCallsign || (m.authorPubkey ? m.authorPubkey.slice(0, 8) : t('Member'));
                                    const authorAvatar = m.authorAvatar;
                                    const textContent = decodeThreadMessage(m.ciphertext, m.type, project);
                                    return (
                                        <View key={m.id} style={[styles.threadMsgRow, idx === threadMessages.length - 1 && { borderBottomWidth: 0 }]}>
                                            <MemberAvatar
                                                avatarUrl={authorAvatar}
                                                pubkey={m.authorPubkey}
                                                callsign={authorName}
                                                size={32}
                                            />
                                            <View style={styles.threadMsgContent}>
                                                <View style={styles.threadMsgMeta}>
                                                    <Text style={styles.threadMsgAuthor} numberOfLines={1}>{authorName}</Text>
                                                    <Text style={styles.threadMsgTime} numberOfLines={1}>{formatTime(m.timestamp)}</Text>
                                                </View>
                                                <Text style={isRemoved ? styles.threadMsgRemoved : styles.threadMsgText}>
                                                    {textContent}
                                                </Text>
                                            </View>
                                        </View>
                                    );
                                })
                            )}

                            {!threadReadOnly && !isEffectivePreview && (
                                <View style={styles.threadInputRow}>
                                    <TextInput
                                        style={[styles.threadInput, threadPosting && { opacity: 0.6 }]}
                                        placeholder={project ? t('Message the project...') : t('Message the enterprise...')}
                                        placeholderTextColor={colors.text.muted}
                                        value={threadInput}
                                        onChangeText={setThreadInput}
                                        maxLength={2000}
                                        returnKeyType="send"
                                        onSubmitEditing={handlePostThreadMessage}
                                        editable={!threadPosting}
                                        accessibilityLabel={project ? t('Message the project') : t('Message the enterprise')}
                                    />
                                    <Pressable
                                        style={[
                                            styles.threadSendBtn,
                                            (!threadInput.trim() || threadPosting) && { opacity: 0.5 }
                                        ]}
                                        disabled={!threadInput.trim() || threadPosting}
                                        onPress={handlePostThreadMessage}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('Send message')}
                                    >
                                        {threadPosting ? (
                                            <ActivityIndicator size="small" color={colors.text.inverse} />
                                        ) : (
                                            <Text style={styles.threadSendBtnText} numberOfLines={1}>{t('Send')}</Text>
                                        )}
                                    </Pressable>
                                </View>
                            )}
                        </View>

                        {/* Report Enterprise Action, and the "…" menu with Block */}
                        {!isEffectivePreview && (
                            <View style={{ marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border.default, marginBottom: 20 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                    <Pressable style={{ flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }} onPress={() => setShowReportForm(!showReportForm)} accessibilityRole="button" accessibilityLabel={project ? t('Report Project') : t('Report Enterprise')}>
                                        <MaterialCommunityIcons name="shield-alert-outline" size={18} color={colors.feedback.danger.fg} />
                                        <Text style={{ flexShrink: 1, color: colors.feedback.danger.fg, fontSize: 14, fontWeight: '600' }}>{project ? t('Report Project') : t('Report Enterprise')}</Text>
                                    </Pressable>
                                    {mayBlock && (
                                        <Pressable
                                            style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 }}
                                            onPress={() => setShowMoreMenu(open => !open)}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('More options')}
                                            accessibilityState={{ expanded: showMoreMenu }}
                                        >
                                            <MaterialCommunityIcons name="dots-horizontal" size={22} color={colors.text.secondary} />
                                        </Pressable>
                                    )}
                                </View>
                                {mayBlock && showMoreMenu && (
                                    <View testID="enterprise-more-menu" style={{ marginTop: 8, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, overflow: 'hidden' }}>
                                        {blockedHere ? (
                                            <Text style={{ paddingHorizontal: 12, paddingVertical: 12, fontSize: 14, color: colors.text.secondary }}>{t('{name} is blocked', { name })}</Text>
                                        ) : (
                                            <Pressable
                                                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, opacity: blocking ? 0.6 : 1 }}
                                                onPress={handleBlockEnterprise}
                                                disabled={blocking}
                                                accessibilityRole="button"
                                                accessibilityLabel={t('Block {name}', { name })}
                                                accessibilityState={{ busy: blocking }}
                                            >
                                                <MaterialCommunityIcons name="block-helper" size={16} color={colors.feedback.danger.fg} />
                                                <Text style={{ flexShrink: 1, color: colors.feedback.danger.fg, fontSize: 14, fontWeight: '600' }}>{blocking ? t('Blocking…') : t('Block {name}', { name })}</Text>
                                            </Pressable>
                                        )}
                                    </View>
                                )}
                                {showReportForm && (
                                    // The same short reason list as a post (ReportReasonBox): "Child safety" is told to the owners at once.
                                    <ReportReasonBox
                                        onCancel={() => setShowReportForm(false)}
                                        onSubmit={async (reason) => {
                                            if (!identity?.publicKey || !treasuryKey) return;
                                            try {
                                                const sent = await reportAbuse(identity.publicKey, treasuryKey, reason, treasuryKey);
                                                setShowReportForm(false);
                                                // The thanks, and why the member's words were left out when they were (case 14).
                                                Alert.alert(t('Reported'), reportedAlertBody(sent?.wordsLeftOut, reason));
                                            } catch (e: any) {
                                                Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Could not submit report.'));
                                                throw e; // the box keeps the choice and the words
                                            }
                                        }}
                                    />
                                )}
                            </View>
                        )}
                        </>)}
                    </ScrollView>
                </KeyboardAvoidingView>
            )}

            {cropper.element}
        </SafeAreaView>
    );
}
