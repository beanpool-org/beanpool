import React, { useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, ActivityIndicator, TextInput, Modal } from 'react-native';
import { KeyboardAwareScrollView, KeyboardController } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useFocusEffect, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import {
    getTreasuryDetail, getBalance, treasurySweep, treasuryApprove, treasuryComplete, treasuryReject,
    deleteCrowdfundProjectApi, approveKeeperRequest, declineKeeperRequest, proposeEnterpriseSuccession,
    voteEnterpriseSuccession, removeEnterpriseKeeper, objectToKeeperChange, stepDownAsKeeper,
    getEnterpriseThread, removeEnterpriseThreadMessage,
    pauseEnterprise, resumeEnterprise, initiateWindUp, cancelWindUp, finaliseWindUp,
} from '../utils/db';
import {
    seasonControls, anySeasonControl, pauseConfirmText, RESUME_CONFIRM_TEXT, windUpConfirmText,
    windUpDeficitText, cancelWindUpConfirmText, finaliseWindUpConfirmText, postingBlockedText,
} from '../utils/enterprise-season';
import {
    timeLeftText, keeperChangeTitle, keeperChangeBody, canObjectToChange, canRemoveKeeper, canStepDown,
    stepDownConfirmText, removeKeeperConfirmText, applicantBackingText, successionTallyText,
    successionDeadlineText, myChoice, successionHeading, successionExplainer, type KeeperChangeLite,
} from '../utils/keeper-governance';
import { formatDate, formatNumber, inCapitalsOf, keeperWords, t, tn, isSampleId, parseAmount, amountRefusalWords, isAmbiguousAmount, ANY_DECIMALS } from '@beanpool/core';
import { loadIdentity } from '../utils/identity';
import { MemberAvatar } from '../components/MemberAvatar';
import { EnterpriseDecisions } from '../components/EnterpriseDecisions';
import { Sentence } from '../components/Sentence';
import { ManageFace, ManageFeatured } from '../components/shopfront/Manage';
import { LocalCommunityMark } from '../components/showcase/LocalCommunityMark';
import { useTheme, useStyles } from './ThemeContext';
import { signedRequestWords } from '../components/signed-request-lines';
import { useReaderFeatures } from '../utils/use-reader-features';
import { showcaseMode } from '../utils/node-profile';
import { readEnterpriseOffers, type ShopListing } from '../utils/shop';
import { shopCategoryOf } from '../utils/shopfront';
import { leadsIt, mayManage, notKeeperLine } from '../utils/enterprise-manage';
import { decodeThreadMessage, removedLine } from '../utils/enterprise-thread';

type LifecycleAction = 'pause' | 'resume' | 'windUp' | 'cancelWindUp' | 'finaliseWindUp';

/** Sentences marked in utils/enterprise-season.ts, translated here where they are shown. */
const SEASON_LINES = { resume: RESUME_CONFIRM_TEXT };

/**
 * An enterprise's (or a project's) Manage console, its keepers' (slice S7 of
 * scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3, §6; Marty's answers of 23 Oct 2026):
 * `/treasury-manage?publicKey=…`, from Manage in its page's header. Every keeper action its page had is here, and the page
 * keeps none (app/treasury-detail.tsx): what needs them (requests to keep it, keeper changes in their objection window,
 * succession while the lead is quiet), its shopfront (its face with one Save, Featured, its Offers into its shop),
 * the operator controls (post its Offer or Need, bids on its Needs, its deals, sweep to the Commons, cancel an
 * initiative), the keepers' votes, removing a keeper and stepping down, the season and the wind-up, and removing a
 * message from its discussion. Each still shows only what the node lets this member do.
 *
 * Opened by someone who keeps none of it: a sentence, nothing offered, and under it the votes still on their roll (a keeper
 * removed while a vote is open), which the node answers no one else. Example Valley's (a sample id), or an enterprise
 * where this reader's community has none: nothing asked of the node. Not here: its banner (no photo kept for a shop yet)
 * and its tool shelves (a tool opens as the member only).
 */
export default function TreasuryManageScreen() {
    const params = useLocalSearchParams<{ publicKey?: string | string[]; id?: string | string[]; name?: string | string[] }>();
    const rawKey = params.publicKey || params.id;
    const treasuryKey = typeof rawKey === 'string' ? rawKey : Array.isArray(rawKey) ? rawKey[0] : undefined;
    const nameParam = typeof params.name === 'string' ? params.name : Array.isArray(params.name) ? params.name[0] : undefined;

    const isEffectivePreview = isSampleId(treasuryKey);
    const reader = useReaderFeatures();
    const enterprisesPreview = showcaseMode('enterprises', reader.node, reader.reader) === 'preview';
    const elsewhere = !isEffectivePreview && enterprisesPreview;

    const { theme, colors } = useTheme();

    const [detail, setDetail] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [isKeeperOfThis, setIsKeeperOfThis] = useState(false);
    const [identity, setIdentity] = useState<any>(null);
    // Its Offers as its keeper reads them, for Featured: undefined until read, null when they couldn't be.
    const [offers, setOffers] = useState<ShopListing[] | null | undefined>(undefined);
    // Bumped on each focus, so the Decisions block reads its votes again (a tap on a Needs-you vote line lands here).
    const [decisionsRefresh, setDecisionsRefresh] = useState(0);
    const [sweepAmount, setSweepAmount] = useState('');
    const [sweeping, setSweeping] = useState(false);
    const [actionState, setActionState] = useState<{ id: string; type: 'approve' | 'reject' | 'complete' } | null>(null);
    const [hourlyDealPrompt, setHourlyDealPrompt] = useState<any | null>(null);
    const [hourlyDealHours, setHourlyDealHours] = useState('');
    const [cancelling, setCancelling] = useState(false);
    const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);

    // Keeper changes (3-day objection window) and stepping down
    const [processingChangeId, setProcessingChangeId] = useState<string | null>(null);
    const [steppingDown, setSteppingDown] = useState(false);

    // Lead Succession State
    const [submittingSuccession, setSubmittingSuccession] = useState(false);
    const [showCandidatePicker, setShowCandidatePicker] = useState(false);

    // Its discussion, for removing a message
    const [threadMessages, setThreadMessages] = useState<any[]>([]);
    const [threadRemovingId, setThreadRemovingId] = useState<string | null>(null);

    // Enterprise Season & Wind-up (docs/the-commons.md §2.2). One confirmation open at a time; each says
    // what will happen in plain words before the confirming tap.
    const [confirmingLifecycle, setConfirmingLifecycle] = useState<LifecycleAction | null>(null);
    const [lifecycleBusy, setLifecycleBusy] = useState(false);
    const loadRequest = useRef(0);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        fill: { flex: 1 },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.app },
        backButton: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.3 },
        scroll: { paddingTop: 16, paddingBottom: 60 },
        // The moved cards keep the page's 16 dp sides; the shopfront's own sections are cards with Home's gutter.
        pad: { paddingHorizontal: 16 },

        // Pending Requests Review (for Lead / Sole / Admin)
        requestsCard: { backgroundColor: colors.feedback.warning.bg, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.feedback.warning.border, marginBottom: 16 },
        requestsTitle: { fontSize: 12, fontWeight: '800', color: colors.feedback.warning.fg, letterSpacing: 0.5, marginBottom: 10 },
        // Name and pledge stacked above a full-width button row: side by side, the two buttons left the name
        // ~65dp at 320dp + 1.3x font, breaking it mid-word and wrapping the pledge onto three lines.
        requestRow: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default },
        requestInfo: { marginBottom: 10 },
        requestCallsign: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        requestBacking: { fontSize: 12, color: colors.brand.primary, fontWeight: '600', marginTop: 2 },
        requestStanding: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },
        requestStandingShort: { color: colors.feedback.warning.fg, fontWeight: '600' },
        requestBtnRow: { flexDirection: 'row', gap: 8 },
        // 8 dp at the sides, not 12: a longer language's Approve / Decline then fits its half at 320dp + 1.3x as it shrinks.
        approveBtn: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand.fill, paddingHorizontal: 8, borderRadius: 8 },
        approveBtnText: { color: colors.text.inverse, fontWeight: '700', fontSize: 13 },
        declineBtn: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.subtle, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border.default },
        declineBtnText: { color: colors.text.secondary, fontWeight: '600', fontSize: 13 },

        // Lead Succession
        successionCard: { backgroundColor: colors.feedback.warning.bg, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.feedback.warning.border, marginBottom: 16 },
        successionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
        successionTitle: { flex: 1, fontSize: 13, fontWeight: '800', color: colors.feedback.warning.fg },
        successionText: { fontSize: 12, color: colors.text.body, lineHeight: 18, marginBottom: 12 },
        successionVoteBox: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default, marginBottom: 8 },
        successionCandidateText: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        successionVotesText: { fontSize: 12, color: colors.text.secondary, marginTop: 2, marginBottom: 8 },
        votedBadge: { fontSize: 12, fontWeight: '700', color: colors.brand.primary, marginTop: 4 },
        proposeBtn: { backgroundColor: colors.brand.fill, minHeight: 48, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center' },
        proposeBtnText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13, textAlign: 'center' },
        changeBody: { fontSize: 12, color: colors.text.body, lineHeight: 18, marginTop: 4 },
        keeperActionBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle },
        keeperActionText: { color: colors.text.secondary, fontWeight: '700', fontSize: 13, textAlign: 'center' },
        candidateOption: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border.default, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
        candidateOptionText: { fontSize: 15, fontWeight: '600', color: colors.text.heading },

        opPanel: { backgroundColor: colors.brand.tint, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.brand.primary, marginBottom: 16 },
        opTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
        opTitle: { fontSize: 13, fontWeight: '800', color: colors.brand.primary, letterSpacing: 0.3 },
        opBtnRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
        opBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.brand.fill, minHeight: 48, paddingVertical: 12, borderRadius: 12 },
        opBtnText: { color: colors.text.inverse, fontWeight: '800', fontSize: 13 },
        opBtnDisabled: { opacity: 0.45 },
        opNotice: { fontSize: 12, fontWeight: '600', color: colors.feedback.warning.fg, backgroundColor: colors.feedback.warning.bg, borderRadius: 8, padding: 8, marginTop: -4, marginBottom: 12, textAlign: 'center', overflow: 'hidden' },
        // Field above button, each full width: side by side at 320dp the field was ~100dp and cut its
        // placeholder to "Sweep s".
        sweepRow: { gap: 8 },
        sweepInput: { height: 48, backgroundColor: colors.surface.card, borderRadius: 12, paddingHorizontal: 14, fontSize: 16, fontWeight: '700', color: colors.text.body, borderWidth: 1, borderColor: colors.border.strong },
        sweepBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.brand.primary, paddingHorizontal: 14, height: 48, borderRadius: 12, justifyContent: 'center' },
        sweepBtnDisabled: { opacity: 0.4 },
        sweepBtnText: { color: colors.brand.primary, fontWeight: '800', fontSize: 13 },
        opHint: { fontSize: 12, color: colors.brand.primary, marginTop: 10, lineHeight: 17 },

        threadCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        threadTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        threadSubtitle: { fontSize: 12, color: colors.text.secondary, marginTop: 2, marginBottom: 8 },
        threadMsgRow: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        threadMsgContent: { flex: 1, minWidth: 0 },
        threadMsgMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
        threadMsgAuthor: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '700', color: colors.text.heading },
        threadMsgTime: { flexShrink: 0, fontSize: 10, color: colors.text.muted },
        threadMsgText: { fontSize: 13, color: colors.text.body, lineHeight: 18 },
        threadMsgRemoved: { fontSize: 13, fontStyle: 'italic', color: colors.text.muted },
        // A real 48x48dp target (was ~22x23). hitSlop cannot stand in: Android drops touches outside the parent row.
        threadRemoveBtn: { width: 48, height: 48, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },

        // Season & lifecycle keeper controls
        seasonCard: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: colors.border.default, marginBottom: 16 },
        seasonTitle: { flex: 1, fontSize: 13, fontWeight: '800', color: colors.text.heading, letterSpacing: 0.3 },
        seasonBtn: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: 1, marginTop: 8 },
        seasonBtnText: { flexShrink: 1, fontSize: 14, fontWeight: '800', textAlign: 'center' },
        confirmCard: { borderRadius: 12, padding: 12, borderWidth: 2, gap: 8, marginTop: 4 },
        confirmTitle: { fontSize: 14, fontWeight: '800' },
        confirmText: { fontSize: 13, lineHeight: 19, fontWeight: '600' },
        confirmBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
        confirmBtnText: { fontSize: 14, fontWeight: '800', textAlign: 'center', color: colors.text.inverse },
        confirmCancelBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, paddingHorizontal: 12 },
        confirmCancelText: { fontSize: 14, fontWeight: '700', color: colors.text.body, textAlign: 'center' },

        emptyNote: { fontSize: 13, color: colors.text.muted, fontStyle: 'italic', paddingVertical: 12, textAlign: 'center' },
        centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
        // The sentence centred as centerFill has it; a vote under it takes the console's 16 dp sides and scrolls.
        notKeeper: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 24 },
        retryBtn: { minHeight: 48, paddingHorizontal: 20, borderRadius: 12, borderWidth: 1, borderColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center' },
        retryText: { fontSize: 14, fontWeight: '700', color: colors.brand.primary },
    }));

    const loadThread = useCallback(async () => {
        if (!treasuryKey || isEffectivePreview || !reader.known || elsewhere) return;
        try {
            const res = await getEnterpriseThread(treasuryKey);
            if (res) setThreadMessages(res.messages || []);
        } catch {
            // ignore
        }
    }, [treasuryKey, isEffectivePreview, elsewhere, reader.known]);

    const loadOffers = useCallback(async () => {
        if (!treasuryKey || isEffectivePreview || !reader.known || elsewhere) return;
        setOffers(await readEnterpriseOffers(treasuryKey));
    }, [treasuryKey, isEffectivePreview, elsewhere, reader.known]);

    const load = useCallback(() => {
        let active = true;
        // Example Valley's, or one where this reader's community has none: nothing to ask, nothing to manage.
        if (isEffectivePreview || elsewhere) {
            setLoading(false);
            return () => { active = false; };
        }
        if (!reader.known) return () => { active = false; };
        const request = ++loadRequest.current;
        setLoading(true);
        (async () => {
            try {
                const [d, id] = await Promise.all([
                    treasuryKey ? getTreasuryDetail(treasuryKey) : Promise.resolve(null),
                    loadIdentity()
                ]);
                // Whether this member keeps it, asked before anything is drawn: never a moment of "only its keepers".
                let keeper = false;
                if (d && id?.publicKey && treasuryKey) {
                    const b: any = await getBalance(id.publicKey).catch(() => ({}));
                    const mine: string[] = Array.isArray(b?.keeperOf) ? b.keeperOf : [];
                    const inKeepers = Array.isArray(d?.keepers) && d.keepers.some((k: any) => !k.suspended && (k.publicKey || k.pubkey || k.memberPubkey) === id.publicKey);
                    keeper = mine.includes(treasuryKey) || inKeepers;
                }
                if (!active || request !== loadRequest.current) return;
                setIdentity(id);
                if (d) {
                    setDetail(d);
                    setIsKeeperOfThis(keeper);
                }
            } catch {
                // handle error
            } finally {
                if (active && request === loadRequest.current) setLoading(false);
            }
        })();
        loadThread();
        loadOffers();
        return () => { active = false; };
    }, [treasuryKey, isEffectivePreview, elsewhere, reader.known, loadThread, loadOffers]);

    useFocusEffect(load);
    useFocusEffect(useCallback(() => { setDecisionsRefresh(n => n + 1); }, []));

    const handleRemoveThreadMessage = async (messageId: string) => {
        // The trash button keeps the keyboard up (keyboardShouldPersistTaps); an Alert over it leaves phantom padding.
        await KeyboardController.dismiss();
        Alert.alert(
            t('Remove Message'),
            t('Are you sure you want to remove this message? It will show as "{removed}".', { removed: removedLine(keeperWords(detail?.lifecycle).kind === 'project') }),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Remove'),
                    style: 'destructive',
                    onPress: async () => {
                        if (!treasuryKey) return;
                        setThreadRemovingId(messageId);
                        try {
                            await removeEnterpriseThreadMessage(treasuryKey, messageId);
                            await loadThread();
                        } catch (e: any) {
                            Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Could not remove message'));
                        } finally {
                            setThreadRemovingId(null);
                        }
                    }
                }
            ]
        );
    };

    const runLifecycleAction = async (action: LifecycleAction) => {
        if (!treasuryKey || lifecycleBusy) return;
        setLifecycleBusy(true);
        const project = keeperWords(detail?.lifecycle).kind === 'project';
        let title = '';
        let message = '';
        try {
            if (action === 'pause') {
                await pauseEnterprise(treasuryKey);
                title = t('Paused for the season ❄️');
                message = project ? t('Project paused for the season. Credit held at snapshot.') : t('Enterprise paused for the season. Credit held at snapshot.');
            } else if (action === 'resume') {
                await resumeEnterprise(treasuryKey);
                title = project ? t('Project resumed ▶️') : t('Enterprise resumed ▶️');
                message = project ? t('Project resumed! Active listings are now buyable again.') : t('Enterprise resumed! Active listings are now buyable again.');
            } else if (action === 'windUp') {
                await initiateWindUp(treasuryKey);
                title = t('Wind-up started');
                message = t('Wind-up initiated. 7-day grace period has begun.');
            } else if (action === 'cancelWindUp') {
                await cancelWindUp(treasuryKey);
                title = t('Wind-up stopped');
                message = project ? t('Wind-up cancelled. Project restored to active status.') : t('Wind-up cancelled. Enterprise restored to active status.');
            } else {
                const res = await finaliseWindUp(treasuryKey);
                const amount = res?.sweptAmount ?? 0;
                title = t('Wind-up finalised 🏁');
                message = project
                    ? t('Wind-up finalised. Swept {amount} 🫘 to Commons and released collaborators.', { amount })
                    : t('Wind-up finalised. Swept {amount} 🫘 to Commons and released keepers.', { amount });
            }
            setConfirmingLifecycle(null);
        } catch (e: any) {
            const fallback = {
                pause: project ? t('Failed to pause project') : t('Failed to pause enterprise'),
                resume: project ? t('Failed to resume project') : t('Failed to resume enterprise'),
                windUp: t('Failed to initiate wind-up'),
                cancelWindUp: t('Failed to cancel wind-up'),
                finaliseWindUp: t('Failed to finalise wind-up'),
            }[action];
            title = t('Could not complete that');
            message = e?.message ? signedRequestWords(e.message) : fallback;
        } finally {
            setLifecycleBusy(false);
        }
        // An Alert over an open keyboard leaves phantom keyboard padding behind.
        await KeyboardController.dismiss();
        Alert.alert(title, message);
        load();
    };

    const balance = detail?.balance ?? 0;
    // The name its members gave it, as written; the words only when there is none.
    const name = detail?.name || nameParam || t('Community Enterprise');

    const controls = seasonControls(detail, identity?.publicKey);
    const postingBlocked = postingBlockedText(detail);

    const isLeadOrSoleKeeperOrAdmin = !!detail?.isLeadOrSoleKeeperOrAdmin;
    const keeperRequests: any[] = detail?.keeperRequests || [];
    const leadInactivity = detail?.leadInactivity || null;
    const successionInfo = detail?.succession || null;
    const activeProposal = successionInfo?.proposals?.find((p: any) => p.status === 'active') || null;
    const keeperList: any[] = (detail?.keepers || []).map((k: any) => ({ ...k, publicKey: k.publicKey || k.pubkey || k.memberPubkey }));
    const keeperChanges: KeeperChangeLite[] = detail?.keeperChanges || [];
    const myPubkey: string | null = identity?.publicKey ?? null;
    const iAmLead = keeperList.some(k => k.publicKey === myPubkey && k.role === 'lead');
    /**
     * A project has a leader and collaborators; an enterprise a lead keeper and keepers (pick 8). Each sentence is written
     * whole for each kind (`project`), never with kw's words glued in, so a language can inflect them.
     */
    const kw = keeperWords(detail?.lifecycle);
    const project = kw.kind === 'project';
    const removableKeepers = keeperList.filter(k => canRemoveKeeper(k, myPubkey, iAmLead, keeperChanges));
    const mayStepDown = canStepDown(myPubkey, keeperList);
    const isEligibleSuccessor = isKeeperOfThis && !!identity?.publicKey && !!leadInactivity?.leadPubkey && identity.publicKey !== leadInactivity.leadPubkey;
    const shopId: string | null = detail?.shop && typeof detail.shop.id === 'string' ? detail.shop.id : null;
    // Its new Offers start in its shop's category (Marty, 25 Oct 2026); the keeper can change it on the form.
    const shopCategory = shopCategoryOf(detail?.shop);

    const handleSweep = async () => {
        if (!treasuryKey || sweeping) return;
        // The language's decimal mark (core parseAmount): fr "12,5" is 12.5, never refused as not a number; "1.000", which
        // could be a thousand, is refused in words that say so. The node's cents rule decides the decimals, as before.
        const read = parseAmount(sweepAmount, undefined, ANY_DECIMALS);
        if (!read.ok && isAmbiguousAmount(read.refusal)) { Alert.alert(t('Enter an amount'), amountRefusalWords(read.refusal)); return; }
        const amt = read.ok ? read.value : NaN;
        if (isNaN(amt) || amt <= 0) { Alert.alert(t('Enter an amount'), t('Type a positive number of Beans to sweep into the Commons.')); return; }
        if (amt > balance) {
            Alert.alert(t('Not enough surplus'), project
                ? t('This project only holds {amount} 🫘.', { amount: balance })
                : t('This enterprise only holds {amount} 🫘.', { amount: balance }));
            return;
        }
        setSweeping(true);
        try {
            await treasurySweep(treasuryKey, amt);
            Alert.alert(t('Swept to the Commons 🌱'), t('{amount} 🫘 moved from {name} into the shared Commons pool.', { amount: amt, name }));
            setSweepAmount('');
            load();
        } catch (e: any) {
            Alert.alert(t('Sweep failed'), e.message ? signedRequestWords(e.message) : t('Could not sweep to the Commons.'));
        } finally {
            setSweeping(false);
        }
    };

    const handleApproveRequest = async (requestId: string) => {
        if (!treasuryKey || processingRequestId) return;
        setProcessingRequestId(requestId);
        try {
            const res: any = await approveKeeperRequest(treasuryKey, requestId);
            if (res?.applied === false) {
                Alert.alert(t('Approved 🌱'), project
                    ? t('They become a collaborator in 3 days, unless another collaborator objects first.')
                    : t('They become a keeper in 3 days, unless another keeper objects first.'));
            } else {
                Alert.alert(t('Request Approved 🌱'), project ? t('Member is now a collaborator of this project.') : t('Member is now a keeper of this enterprise.'));
            }
            load();
        } catch (e: any) {
            Alert.alert(t('Approval Failed'), e.message ? signedRequestWords(e.message) : (project ? t('Could not approve collaborator request.') : t('Could not approve keeper request.')));
        } finally {
            setProcessingRequestId(null);
        }
    };

    const handleDeclineRequest = async (requestId: string) => {
        if (!treasuryKey || processingRequestId) return;
        setProcessingRequestId(requestId);
        try {
            await declineKeeperRequest(treasuryKey, requestId);
            Alert.alert(t('Request Declined'), project ? t('Collaborator request has been declined.') : t('Keeper request has been declined.'));
            load();
        } catch (e: any) {
            Alert.alert(t('Decline Failed'), e.message ? signedRequestWords(e.message) : (project ? t('Could not decline collaborator request.') : t('Could not decline keeper request.')));
        } finally {
            setProcessingRequestId(null);
        }
    };

    const handleProposeSuccession = async (candidatePubkey: string) => {
        if (!treasuryKey || submittingSuccession) return;
        setSubmittingSuccession(true);
        try {
            const res: any = await proposeEnterpriseSuccession(treasuryKey, candidatePubkey);
            const leadMoved = res?.executed ?? res?.leadMoved ?? false;
            const votesCount = res?.proposal?.votesCount ?? res?.votesCount ?? 1;
            const votesRequired = res?.proposal?.requiredVotes ?? res?.votesRequired ?? 2;
            if (leadMoved) {
                Alert.alert(t('Succession Passed 🌱'), project ? t('Leader role has been transferred.') : t('Lead keeper role has been transferred.'));
            } else {
                Alert.alert(t('Succession Proposed 🌱'), tn(votesRequired, 'Proposal submitted ({count} of {n} votes recorded).', 'Proposal submitted ({count} of {n} votes recorded).', { count: votesCount }));
            }
            setShowCandidatePicker(false);
            load();
        } catch (e: any) {
            Alert.alert(t('Proposal Failed'), e.message ? signedRequestWords(e.message) : t('Could not propose lead succession.'));
        } finally {
            setSubmittingSuccession(false);
        }
    };

    const handleObjectToChange = async (changeId: string) => {
        if (!treasuryKey || processingChangeId) return;
        setProcessingChangeId(changeId);
        try {
            await objectToKeeperChange(treasuryKey, changeId);
            Alert.alert(t('Objection recorded'), t('The change is cancelled.'));
            load();
        } catch (e: any) {
            Alert.alert(t('Could not object'), e.message ? signedRequestWords(e.message) : t('Please try again.'));
        } finally {
            setProcessingChangeId(null);
        }
    };

    const handleRemoveKeeper = (k: any) => {
        if (!treasuryKey || processingChangeId) return;
        Alert.alert(t('Remove {name}?', { name: k.callsign }), removeKeeperConfirmText(k, kw), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t('Remove'), style: 'destructive', onPress: async () => {
                    setProcessingChangeId(k.publicKey);
                    try {
                        await removeEnterpriseKeeper(treasuryKey, k.publicKey);
                        load();
                    } catch (e: any) {
                        Alert.alert(t('Could not remove'), e.message ? signedRequestWords(e.message) : t('Please try again.'));
                    } finally {
                        setProcessingChangeId(null);
                    }
                },
            },
        ]);
    };

    const handleStepDown = () => {
        if (!treasuryKey || !myPubkey || steppingDown) return;
        Alert.alert(project ? t('Step down as a collaborator?') : t('Step down as a keeper?'), stepDownConfirmText(myPubkey, keeperList, kw), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t('Step down'), style: 'destructive', onPress: async () => {
                    setSteppingDown(true);
                    try {
                        await stepDownAsKeeper(treasuryKey);
                        load();
                    } catch (e: any) {
                        // The server says plainly what must happen first (e.g. the debt your pledge covers).
                        Alert.alert(t('Not yet'), e.message ? signedRequestWords(e.message) : t('Could not step down.'));
                    } finally {
                        setSteppingDown(false);
                    }
                },
            },
        ]);
    };

    const handleVoteSuccession = async (proposalId: string, choice: 'yes' | 'no') => {
        if (!treasuryKey || submittingSuccession) return;
        setSubmittingSuccession(true);
        try {
            const res: any = await voteEnterpriseSuccession(treasuryKey, proposalId, choice);
            const leadMoved = res?.executed ?? res?.leadMoved ?? false;
            const votesCount = res?.proposal?.votesCount ?? res?.votesCount ?? 1;
            const votesRequired = res?.proposal?.requiredVotes ?? res?.votesRequired ?? 2;
            if (leadMoved) {
                Alert.alert(t('Succession Passed 🌱'), project
                    ? t('Your vote was recorded and the leader role has been transferred!')
                    : t('Your vote was recorded and the lead keeper role has been transferred!'));
            } else if (res?.proposal?.closedReason === 'rejected') {
                Alert.alert(t('Vote Registered'), project
                    ? t('Not enough collaborators can now say yes, so the leader stays.')
                    : t('Not enough keepers can now say yes, so the lead stays.'));
            } else {
                Alert.alert(t('Vote Registered 🌱'), t('Vote recorded ({count} yes of {needed} needed).', { count: votesCount, needed: votesRequired }));
            }
            load();
        } catch (e: any) {
            Alert.alert(t('Vote Failed'), e.message ? signedRequestWords(e.message) : t('Could not vote on succession.'));
        } finally {
            setSubmittingSuccession(false);
        }
    };

    const handleCancelInitiative = () => {
        if (!treasuryKey || cancelling) return;
        Alert.alert(
            t('Cancel Initiative & Refund Backers?'),
            t('This will close the initiative and immediately refund all escrowed pledges back to their backers.'),
            [
                { text: t('Keep Initiative'), style: 'cancel' },
                {
                    text: t('Cancel & Refund'),
                    style: 'destructive',
                    onPress: async () => {
                        setCancelling(true);
                        try {
                            await deleteCrowdfundProjectApi(treasuryKey);
                            Alert.alert(t('Initiative Cancelled 🌱'), t('Pledges have been refunded to backers.'));
                            // Its page and this console are both of what is gone: back past the page too.
                            router.back();
                            if (router.canGoBack()) router.back();
                        } catch (e: any) {
                            Alert.alert(t('Cancellation Failed'), e.message ? signedRequestWords(e.message) : t('Could not cancel initiative.'));
                        } finally {
                            setCancelling(false);
                        }
                    }
                }
            ]
        );
    };

    const handleApproveBid = async (txId: string) => {
        if (!treasuryKey) return;
        setActionState({ id: txId, type: 'approve' });
        try {
            await treasuryApprove(treasuryKey, txId);
            Alert.alert(t('Bid Approved ✅'), t('Funds locked in trust successfully.'));
            load();
        } catch (e: any) {
            Alert.alert(t('Approve Failed'), e.message ? signedRequestWords(e.message) : t('Could not approve bid.'));
        } finally {
            setActionState(null);
        }
    };

    const handleRejectBid = (txId: string) => {
        if (!treasuryKey) return;
        Alert.alert(
            t('Decline Bid?'),
            t('Are you sure you want to decline this request? The member will be notified.'),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Decline'),
                    style: 'destructive',
                    onPress: async () => {
                        setActionState({ id: txId, type: 'reject' });
                        try {
                            await treasuryReject(treasuryKey, txId);
                            Alert.alert(t('Bid Declined'), t('The request has been declined.'));
                            load();
                        } catch (e: any) {
                            Alert.alert(t('Decline Failed'), e.message ? signedRequestWords(e.message) : t('Could not decline bid.'));
                        } finally {
                            setActionState(null);
                        }
                    }
                }
            ]
        );
    };

    const handleCompleteDeal = (d: any) => {
        if (!treasuryKey) return;
        if (d.price_type && d.price_type !== 'fixed') {
            // In the language's way ("2,5"), so it reads back as the same hours.
            setHourlyDealHours(d.hours ? formatNumber(d.hours) : '1');
            setHourlyDealPrompt(d);
            return;
        }
        Alert.alert(
            t('Release Payment?'),
            d.peer_callsign
                ? t('Are you sure you want to release {amount} 🫘 to {name}? This cannot be undone.', { amount: d.credits, name: d.peer_callsign })
                : t('Are you sure you want to release {amount} 🫘 to the member? This cannot be undone.', { amount: d.credits }),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Release Payment'),
                    onPress: async () => {
                        setActionState({ id: d.id, type: 'complete' });
                        try {
                            await treasuryComplete(treasuryKey, d.id);
                            Alert.alert(t('Payment Released ✅'), t('The beans have been paid to the member.'));
                            load();
                        } catch (e: any) {
                            Alert.alert(t('Release Failed'), e.message ? signedRequestWords(e.message) : t('Could not release payment.'));
                        } finally {
                            setActionState(null);
                        }
                    }
                }
            ]
        );
    };

    /** "19 Oct, 9:05": core's date and time, in the member's language (never the device's toLocaleString). */
    const formatTime = (when: any) => {
        try {
            const d = new Date(typeof when === 'number' ? when : String(when));
            if (isNaN(d.getTime())) return '';
            return t('{date}, {time}', { date: formatDate(d, 'day-month'), time: formatDate(d, 'time') });
        } catch { return ''; }
    };

    const pendingBids: any[] = detail?.pendingBids || [];
    const activeDeals: any[] = detail?.activeDeals || [];

    const body = () => {
        if (loading && !detail) return <View style={styles.centerFill}><ActivityIndicator color={colors.brand.primary} /></View>;
        if (elsewhere) {
            return (
                <View style={styles.centerFill} testID="enterprise-elsewhere">
                    <LocalCommunityMark variant="line" feature="enterprises" text={t('🏘️ Enterprises live in a local community ›')} />
                </View>
            );
        }
        if (isEffectivePreview) {
            return <View style={styles.centerFill}><Text style={styles.emptyNote} testID="manage-not-keeper">{notKeeperLine(false)}</Text></View>;
        }
        if (!detail) {
            return (
                <View style={styles.centerFill} testID="manage-offline">
                    <Text style={styles.emptyNote}>{t("Couldn't load this group. Check your connection.")}</Text>
                    <Pressable style={styles.retryBtn} onPress={load} accessibilityRole="button" testID="manage-retry">
                        <Text style={styles.retryText}>{t('Try again')}</Text>
                    </Pressable>
                </View>
            );
        }
        if (!mayManage(detail, isKeeperOfThis)) {
            // A keeper removed while a vote is open stays on its roll and votes here, where Needs you and the vote's push
            // land (PR #2405 review 4356209582). The block draws nothing for anyone else: the node answers them a 404.
            return (
                <ScrollView contentContainerStyle={styles.notKeeper}>
                    <Text style={styles.emptyNote} testID="manage-not-keeper">{notKeeperLine(project)}</Text>
                    {treasuryKey && (
                        <EnterpriseDecisions
                            treasuryKey={treasuryKey} myPubkey={myPubkey} keepers={keeperList} balance={balance}
                            earnedSurplus={typeof detail?.earnedSurplus === 'number' ? detail.earnedSurplus : null}
                            lifecycle={detail?.lifecycle} refreshKey={decisionsRefresh}
                        />
                    )}
                </ScrollView>
            );
        }
        return (
            <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" bottomOffset={48}>
                <View style={styles.pad}>
                    {/* Pending Keeper Requests (for Lead / Sole Keeper / Admin) */}
                    {isLeadOrSoleKeeperOrAdmin && keeperRequests.length > 0 && (
                        <View style={styles.requestsCard}>
                            <Text style={styles.requestsTitle}>
                                {inCapitalsOf(project
                                    ? t('PENDING COLLABORATOR REQUESTS ({n})', { n: keeperRequests.length })
                                    : t('PENDING KEEPER REQUESTS ({n})', { n: keeperRequests.length }))}
                            </Text>
                            {keeperRequests.map((req: any) => (
                                <View key={req.id} style={styles.requestRow}>
                                    <View style={styles.requestInfo}>
                                        <Text style={styles.requestCallsign} numberOfLines={2}>{req.callsign || req.applicantCallsign || req.memberCallsign || t('Member')}</Text>
                                        <Text style={styles.requestBacking} numberOfLines={1}>
                                            {t('Backing pledge: {amount} 🫘', { amount: req.pledgedBacking })}
                                        </Text>
                                        {applicantBackingText(req.canBackPledge) ? (
                                            <Text style={[styles.requestStanding, req.canBackPledge === false && styles.requestStandingShort]}>
                                                {applicantBackingText(req.canBackPledge)}
                                            </Text>
                                        ) : null}
                                    </View>
                                    {req.pendingChange ? (
                                        <Text style={styles.requestBacking}>
                                            {t('Approved. Joins when the objection window ends ({time}).', { time: timeLeftText(req.pendingChange.appliesAt) })}
                                        </Text>
                                    ) : (
                                    <View style={styles.requestBtnRow}>
                                        <Pressable
                                            style={[styles.approveBtn, processingRequestId === req.id && { opacity: 0.6 }]}
                                            disabled={processingRequestId === req.id}
                                            onPress={() => handleApproveRequest(req.id)}
                                            accessibilityRole="button"
                                            accessibilityLabel={project ? t('Approve collaborator request') : t('Approve keeper request')}
                                        >
                                            {processingRequestId === req.id ? (
                                                <ActivityIndicator size="small" color={colors.text.inverse} />
                                            ) : (
                                                <Text style={styles.approveBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Approve')}</Text>
                                            )}
                                        </Pressable>
                                        <Pressable
                                            style={[styles.declineBtn, processingRequestId === req.id && { opacity: 0.6 }]}
                                            disabled={processingRequestId === req.id}
                                            onPress={() => handleDeclineRequest(req.id)}
                                            accessibilityRole="button"
                                            accessibilityLabel={project ? t('Decline collaborator request') : t('Decline keeper request')}
                                        >
                                            <Text style={styles.declineBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Decline')}</Text>
                                        </Pressable>
                                    </View>
                                    )}
                                </View>
                            ))}
                        </View>
                    )}

                    {/* Keeper changes waiting out the other keepers' 3-day objection window (answers A, M) */}
                    {keeperChanges.length > 0 && (
                        <View style={styles.requestsCard}>
                            <Text style={styles.requestsTitle}>
                                {inCapitalsOf(project
                                    ? t('COLLABORATOR CHANGES WAITING ({n})', { n: keeperChanges.length })
                                    : t('KEEPER CHANGES WAITING ({n})', { n: keeperChanges.length }))}
                            </Text>
                            {keeperChanges.map((c) => (
                                <View key={c.id} style={styles.requestRow}>
                                    <View style={styles.requestInfo}>
                                        <Text style={styles.requestCallsign}>{keeperChangeTitle(c, kw)}</Text>
                                        <Text style={styles.changeBody}>{keeperChangeBody(c, kw)}</Text>
                                        <Text style={styles.requestBacking}>{t('⏳ Objection window: {time}', { time: timeLeftText(c.appliesAt) })}</Text>
                                    </View>
                                    {canObjectToChange(c, myPubkey, keeperList) && (
                                        <Pressable
                                            style={[styles.declineBtn, processingChangeId === c.id && { opacity: 0.6 }]}
                                            disabled={processingChangeId === c.id}
                                            onPress={() => handleObjectToChange(c.id)}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('Object: {change}', { change: keeperChangeTitle(c, kw) })}
                                        >
                                            {processingChangeId === c.id ? (
                                                <ActivityIndicator size="small" color={colors.text.secondary} />
                                            ) : (
                                                <Text style={styles.declineBtnText}>{t('Object', undefined, 'button: object to a change')}</Text>
                                            )}
                                        </Pressable>
                                    )}
                                </View>
                            ))}
                        </View>
                    )}

                    {/* Lead Succession Panel (when lead has no activity for 30+ days) */}
                    {Boolean(leadInactivity?.isEligible ?? leadInactivity?.isEligibleForSuccession) && (
                        <View style={styles.successionCard}>
                            <View style={styles.successionHeader}>
                                <MaterialCommunityIcons name="alert-circle" size={18} color={colors.feedback.warning.fg} />
                                <Text style={styles.successionTitle}>{successionHeading(leadInactivity, kw)}</Text>
                            </View>
                            <Text style={styles.successionText}>{successionExplainer(leadInactivity, kw)}</Text>

                            {activeProposal ? (
                                <View style={styles.successionVoteBox}>
                                    <Text style={styles.successionCandidateText}>
                                        {project
                                            ? t('Succession Proposal: Elect {name} as leader', { name: activeProposal.candidateCallsign })
                                            : t('Succession Proposal: Elect {name} as lead keeper', { name: activeProposal.candidateCallsign })}
                                    </Text>
                                    <Text style={styles.successionVotesText}>{successionTallyText(activeProposal, kw)}</Text>
                                    {successionDeadlineText(activeProposal) && (
                                        <Text style={styles.successionVotesText}>⏳ {successionDeadlineText(activeProposal)}</Text>
                                    )}
                                    {isEligibleSuccessor && (
                                        myChoice(activeProposal, myPubkey) ? (
                                            <Text style={styles.votedBadge}>
                                                {myChoice(activeProposal, myPubkey) === 'no'
                                                    ? t('✓ You voted no. Votes cannot be changed.')
                                                    : t('✓ You voted yes. Votes cannot be changed.')}
                                            </Text>
                                        ) : (
                                            <View style={styles.requestBtnRow}>
                                                <Pressable
                                                    style={[styles.approveBtn, submittingSuccession && { opacity: 0.6 }]}
                                                    disabled={submittingSuccession}
                                                    onPress={() => handleVoteSuccession(activeProposal.id, 'yes')}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={project
                                                        ? t('Yes, make {name} leader', { name: activeProposal.candidateCallsign })
                                                        : t('Yes, make {name} lead keeper', { name: activeProposal.candidateCallsign })}
                                                >
                                                    {submittingSuccession ? (
                                                        <ActivityIndicator size="small" color={colors.text.inverse} />
                                                    ) : (
                                                        <Text style={styles.approveBtnText}>{t('Yes')}</Text>
                                                    )}
                                                </Pressable>
                                                <Pressable
                                                    style={[styles.declineBtn, submittingSuccession && { opacity: 0.6 }]}
                                                    disabled={submittingSuccession}
                                                    onPress={() => handleVoteSuccession(activeProposal.id, 'no')}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={project
                                                        ? t('No, do not make {name} leader', { name: activeProposal.candidateCallsign })
                                                        : t('No, do not make {name} lead keeper', { name: activeProposal.candidateCallsign })}
                                                >
                                                    <Text style={styles.declineBtnText}>{t('No')}</Text>
                                                </Pressable>
                                            </View>
                                        )
                                    )}
                                </View>
                            ) : isEligibleSuccessor ? (
                                <Pressable
                                    style={[styles.proposeBtn, submittingSuccession && { opacity: 0.6 }]}
                                    disabled={submittingSuccession}
                                    onPress={() => setShowCandidatePicker(true)}
                                    accessibilityRole="button"
                                    accessibilityLabel={project ? t('Propose Active Collaborator as Leader') : t('Propose Active Keeper as Lead')}
                                >
                                    <Text style={styles.proposeBtnText}>{project ? t('Propose Active Collaborator as Leader') : t('Propose Active Keeper as Lead')}</Text>
                                </Pressable>
                            ) : null}
                        </View>
                    )}
                </View>

                {/* Its shopfront: its face with one Save, and Featured (round 3 §3, §4). Featured and its shop are its keepers'
                    only (routes/shops.ts): a node admin who keeps none of it gets the face the profile route takes. */}
                {treasuryKey && (
                    <>
                        <ManageFace treasury={treasuryKey} detail={detail} lead={leadsIt(detail)} keeper={isKeeperOfThis} project={project} logoUrl={detail?.avatar} onSaved={load} />
                        {isKeeperOfThis && <ManageFeatured treasury={treasuryKey} shopId={shopId} offers={offers} onOffers={setOffers} onShopChanged={load} />}
                    </>
                )}

                <View style={[styles.pad, { marginTop: 6 }]}>
                    {/* Operator controls */}
                    {isKeeperOfThis && (
                        <View style={styles.opPanel}>
                            <View style={styles.opTitleRow}>
                                <MaterialCommunityIcons name="shield-account" size={16} color={colors.brand.primary} />
                                <Text style={[styles.opTitle, { flex: 1 }]}>{t('OPERATOR CONTROLS')}</Text>
                            </View>
                            <View style={styles.opBtnRow}>
                                <Pressable
                                    style={[styles.opBtn, !!postingBlocked && styles.opBtnDisabled]}
                                    accessibilityRole="button"
                                    disabled={!!postingBlocked}
                                    accessibilityState={{ disabled: !!postingBlocked }}
                                    onPress={() => router.push({ pathname: '/treasury-post', params: { treasury: treasuryKey, mode: 'offer', name, ...(shopCategory ? { category: shopCategory } : {}) } })}
                                >
                                    <MaterialCommunityIcons name="tag-plus" size={16} color={colors.text.inverse} />
                                    <Text style={[styles.opBtnText, { flexShrink: 1, textAlign: 'center' }]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.8}>{t('Post Offer')}</Text>
                                </Pressable>
                                <Pressable
                                    style={[styles.opBtn, !!postingBlocked && styles.opBtnDisabled]}
                                    accessibilityRole="button"
                                    disabled={!!postingBlocked}
                                    accessibilityState={{ disabled: !!postingBlocked }}
                                    onPress={() => router.push({ pathname: '/treasury-post', params: { treasury: treasuryKey, mode: 'need', name } })}
                                >
                                    <MaterialCommunityIcons name="hand-extended" size={16} color={colors.text.inverse} />
                                    <Text style={[styles.opBtnText, { flexShrink: 1, textAlign: 'center' }]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.8}>{t('Post Need')}</Text>
                                </Pressable>
                            </View>
                            {!!postingBlocked && <Text style={styles.opNotice}>{postingBlocked}</Text>}
                            <View style={styles.sweepRow}>
                                <TextInput
                                    style={styles.sweepInput}
                                    placeholder={t('Sweep surplus…')}
                                    placeholderTextColor={colors.text.muted}
                                    keyboardType="numeric"
                                    value={sweepAmount}
                                    onChangeText={setSweepAmount}
                                    accessibilityLabel={t('Amount to sweep to the Commons')}
                                />
                                <Pressable
                                    style={[styles.sweepBtn, (sweeping || balance <= 0) && styles.sweepBtnDisabled]}
                                    disabled={sweeping || balance <= 0}
                                    onPress={handleSweep}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Sweep to the Commons')}
                                >
                                    {sweeping ? <ActivityIndicator color={colors.brand.primary} /> : (
                                        <>
                                            <MaterialCommunityIcons name="bank-transfer-out" size={16} color={colors.brand.primary} />
                                            <Text style={[styles.sweepBtnText, { flexShrink: 1 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('To Commons')}</Text>
                                        </>
                                    )}
                                </Pressable>
                            </View>

                            {pendingBids.length > 0 && (
                                <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: colors.brand.primary, paddingTop: 12 }}>
                                    <Text style={[styles.opTitle, { marginBottom: 8 }]}>{t('PENDING BIDS ON NEEDS ({n})', { n: pendingBids.length })}</Text>
                                    {pendingBids.map((b) => (
                                        <View key={b.id} style={{ backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text.heading }}>{b.post_title}</Text>
                                            <Text style={{ fontSize: 12, color: colors.text.secondary, marginTop: 2 }}>
                                                <Sentence
                                                    text={t('Bid by {name} · {amount} 🫘', { amount: b.credits })}
                                                    parts={{ name: <Text style={{ fontWeight: '700', color: colors.text.body }}>{b.peer_callsign || t('Member')}</Text> }}
                                                />
                                            </Text>
                                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                                                <Pressable
                                                    style={[styles.opBtn, { minHeight: 48, paddingVertical: 8, paddingHorizontal: 10, justifyContent: 'center', minWidth: 120 }]}
                                                    disabled={actionState?.id === b.id}
                                                    onPress={() => handleApproveBid(b.id)}
                                                    accessibilityRole="button"
                                                >
                                                    {actionState?.id === b.id && actionState?.type === 'approve' ? (
                                                        <ActivityIndicator size="small" color={colors.text.inverse} />
                                                    ) : (
                                                        <Text style={[styles.opBtnText, { flexShrink: 1, textAlign: 'center' }]}>{t('Approve Bid ({amount} 🫘)', { amount: b.credits })}</Text>
                                                    )}
                                                </Pressable>
                                                <Pressable
                                                    style={[styles.sweepBtn, { minHeight: 48, height: 48, paddingHorizontal: 16 }]}
                                                    disabled={actionState?.id === b.id}
                                                    onPress={() => handleRejectBid(b.id)}
                                                    accessibilityRole="button"
                                                >
                                                    {actionState?.id === b.id && actionState?.type === 'reject' ? (
                                                        <ActivityIndicator size="small" color={colors.feedback.warning.fg} />
                                                    ) : (
                                                        <Text style={[styles.sweepBtnText, { color: colors.feedback.warning.fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Decline')}</Text>
                                                    )}
                                                </Pressable>
                                            </View>
                                        </View>
                                    ))}
                                </View>
                            )}

                            {activeDeals.length > 0 && (
                                <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: colors.brand.primary, paddingTop: 12 }}>
                                    <Text style={[styles.opTitle, { marginBottom: 8 }]}>{t('ACTIVE DEALS ({n})', { n: activeDeals.length })}</Text>
                                    {activeDeals.map((d) => (
                                        <View key={d.id} style={{ backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text.heading }}>{d.post_title}</Text>
                                            <Text style={{ fontSize: 12, color: colors.text.secondary, marginTop: 2 }}>
                                                <Sentence
                                                    text={d.action_required === 'fulfill'
                                                        ? t('Customer: {name} · {amount} 🫘 in escrow', { amount: d.credits })
                                                        : t('Worker: {name} · {amount} 🫘 in escrow', { amount: d.credits })}
                                                    parts={{ name: <Text style={{ fontWeight: '700', color: colors.text.body }}>{d.peer_callsign || t('Member')}</Text> }}
                                                />
                                            </Text>
                                            <View style={{ marginTop: 10 }}>
                                                {d.action_required === 'fulfill' ? (
                                                    <Pressable
                                                        style={[styles.sweepBtn, { minHeight: 48, height: undefined, paddingVertical: 8 }]}
                                                        onPress={() => router.push({ pathname: '/post/[id]', params: { id: d.post_id, txId: d.id } })}
                                                        accessibilityRole="button"
                                                    >
                                                        <Text style={[styles.sweepBtnText, { color: colors.text.secondary, flexShrink: 1, textAlign: 'center' }]} numberOfLines={2}>
                                                            {t('Fulfill Deal · Awaiting Customer Release')}
                                                        </Text>
                                                    </Pressable>
                                                ) : (
                                                    <Pressable
                                                        style={[styles.opBtn, { backgroundColor: colors.feedback.success.solid, minHeight: 48, paddingVertical: 8 }]}
                                                        disabled={actionState?.id === d.id}
                                                        onPress={() => handleCompleteDeal(d)}
                                                        accessibilityRole="button"
                                                    >
                                                        {actionState?.id === d.id && actionState?.type === 'complete' ? (
                                                            <ActivityIndicator size="small" color={colors.text.inverse} />
                                                        ) : (
                                                            <Text style={[styles.opBtnText, { flexShrink: 1, textAlign: 'center' }]}>{t('Release Payment ({amount} 🫘)', { amount: d.credits })}</Text>
                                                        )}
                                                    </Pressable>
                                                )}
                                            </View>
                                        </View>
                                    ))}
                                </View>
                            )}

                            <Text style={styles.opHint}>
                                {project
                                    ? t("Post the project's recurring Offer (what it sells) and its Needs (tenders it pays for). Surplus can be swept into the shared Commons pool.")
                                    : t("Post the enterprise's recurring Offer (what it sells) and its Needs (tenders it pays for). Surplus can be swept into the shared Commons pool.")}
                            </Text>

                            {/* Its leader's alone, as the node takes it (apps/server db.ts leadsProject): to any other collaborator it was a door the node refused. */}
                            {iAmLead && detail?.lifecycle === 'bounded' && detail?.status !== 'funded' && (
                                <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: colors.border.default, paddingTop: 12 }}>
                                    <Pressable
                                        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.feedback.danger.solid }}
                                        onPress={handleCancelInitiative}
                                        disabled={cancelling}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('Cancel initiative and refund escrow')}
                                    >
                                        {cancelling ? (
                                            <ActivityIndicator size="small" color={colors.feedback.danger.fg} />
                                        ) : (
                                            <>
                                                <MaterialCommunityIcons name="cancel" size={16} color={colors.feedback.danger.fg} />
                                                <Text style={{ flexShrink: 1, textAlign: 'center', fontSize: 13, fontWeight: '700', color: colors.feedback.danger.fg }}>
                                                    {t('Cancel Initiative & Refund Escrow')}
                                                </Text>
                                            </>
                                        )}
                                    </Pressable>
                                </View>
                            )}
                        </View>
                    )}

                    {/* The keepers' votes (DESIGN-group-decisions S2): drawn only for those the node answers */}
                    {treasuryKey && (
                        <EnterpriseDecisions
                            treasuryKey={treasuryKey} myPubkey={myPubkey} keepers={keeperList} balance={balance}
                            earnedSurplus={typeof detail?.earnedSurplus === 'number' ? detail.earnedSurplus : null}
                            lifecycle={detail?.lifecycle} refreshKey={decisionsRefresh}
                        />
                    )}

                    {/* Its keepers: the lead removes one (3-day objection window), any keeper steps down */}
                    {(removableKeepers.length > 0 || mayStepDown) && (
                        // 12 dp above: the Decisions block over it has a top margin only, and would touch it.
                        <View style={[styles.seasonCard, { marginTop: 12 }]} testID="manage-keepers">
                            <View style={[styles.opTitleRow, { marginBottom: 4 }]}>
                                <MaterialCommunityIcons name="account-group" size={16} color={colors.brand.primary} />
                                <Text style={styles.seasonTitle}>{inCapitalsOf(project ? t('Its collaborators') : t('Its keepers'))}</Text>
                            </View>
                            {removableKeepers.map((k: any) => (
                                <Pressable
                                    key={`rm-${k.publicKey}`}
                                    style={[styles.keeperActionBtn, processingChangeId === k.publicKey && { opacity: 0.6 }]}
                                    disabled={processingChangeId === k.publicKey}
                                    onPress={() => handleRemoveKeeper(k)}
                                    accessibilityRole="button"
                                    accessibilityLabel={project
                                        ? t('Remove {name} as a collaborator', { name: k.callsign })
                                        : t('Remove {name} as a keeper', { name: k.callsign })}
                                >
                                    <Text style={styles.keeperActionText}>{t('Remove {name}', { name: k.callsign })}</Text>
                                </Pressable>
                            ))}
                            {mayStepDown && (
                                <Pressable
                                    style={[styles.keeperActionBtn, steppingDown && { opacity: 0.6 }]}
                                    disabled={steppingDown}
                                    onPress={handleStepDown}
                                    accessibilityRole="button"
                                    accessibilityLabel={project ? t('Step down as a collaborator') : t('Step down as a keeper')}
                                >
                                    {steppingDown ? (
                                        <ActivityIndicator size="small" color={colors.text.secondary} />
                                    ) : (
                                        <Text style={styles.keeperActionText}>{project ? t('Step down as a collaborator') : t('Step down as a keeper')}</Text>
                                    )}
                                </Pressable>
                            )}
                        </View>
                    )}

                    {/* Season & lifecycle controls — only what the server lets THIS member do (utils/enterprise-season.ts) */}
                    {anySeasonControl(controls) && (() => {
                        const danger = colors.feedback.danger;
                        const warning = colors.feedback.warning;
                        const success = colors.feedback.success;
                        const deficit = windUpDeficitText(detail);
                        // A confirmation stays open only while its action is still allowed — a reload can change that.
                        const allowed: Record<LifecycleAction, boolean> = {
                            pause: controls.pause, resume: controls.resume, windUp: controls.startWindUp,
                            cancelWindUp: controls.cancelWindUp, finaliseWindUp: controls.finaliseWindUp,
                        };
                        const open = confirmingLifecycle && allowed[confirmingLifecycle] ? confirmingLifecycle : null;
                        const confirmation = open === 'pause' ? {
                            icon: '❄️', title: t('Confirm Pause for Season'), text: pauseConfirmText(detail), tone: warning,
                            confirm: t('Confirm Season Pause'), busy: t('Pausing…'), cancel: t('Cancel'), blocked: null as string | null,
                        } : open === 'resume' ? {
                            icon: '▶️', title: project ? t('Confirm Resume Project') : t('Confirm Resume Enterprise'), text: t(SEASON_LINES.resume), tone: success,
                            confirm: t('Confirm Resume'), busy: t('Resuming…'), cancel: t('Cancel'), blocked: null,
                        } : open === 'windUp' ? {
                            icon: '⚠️', title: project ? t('Start Project Wind-Up') : t('Start Enterprise Wind-Up'), text: windUpConfirmText(detail, name), tone: danger,
                            confirm: t('Confirm Start Wind-Up'), busy: t('Starting Wind-Up…'), cancel: t('Cancel'), blocked: deficit,
                        } : open === 'cancelWindUp' ? {
                            icon: '🛑', title: project ? t('Stop Project Wind-Up') : t('Stop Enterprise Wind-Up'), text: cancelWindUpConfirmText(name, detail?.lifecycle), tone: success,
                            confirm: t('Confirm Stop Wind-Up'), busy: t('Stopping Wind-Up…'), cancel: t('Keep Winding Up'), blocked: null,
                        } : open === 'finaliseWindUp' ? {
                            icon: '🏁', title: project ? t('Finalise Project Wind-Up') : t('Finalise Enterprise Wind-Up'), text: finaliseWindUpConfirmText(detail, name), tone: danger,
                            confirm: t('Finalise Wind-Up'), busy: t('Finalising…'), cancel: t('Cancel'), blocked: null,
                        } : null;

                        const actionButton = (action: LifecycleAction, icon: any, label: string, tone: { fg: string; bg: string; border: string }) => (
                            <Pressable
                                key={action}
                                style={[styles.seasonBtn, { backgroundColor: tone.bg, borderColor: tone.border }]}
                                onPress={() => setConfirmingLifecycle(action)}
                                accessibilityRole="button"
                                accessibilityLabel={label}
                            >
                                <MaterialCommunityIcons name={icon} size={18} color={tone.fg} />
                                <Text style={[styles.seasonBtnText, { color: tone.fg }]}>{label}</Text>
                            </Pressable>
                        );

                        return (
                            <View style={styles.seasonCard}>
                                <View style={styles.opTitleRow}>
                                    <MaterialCommunityIcons name="sprout" size={16} color={colors.brand.primary} />
                                    <Text style={styles.seasonTitle}>{t('SEASON & LIFECYCLE CONTROLS')}</Text>
                                </View>

                                {confirmation ? (
                                    <View style={[styles.confirmCard, { backgroundColor: confirmation.tone.bg, borderColor: confirmation.tone.solid }]}>
                                        <Text style={[styles.confirmTitle, { color: confirmation.tone.fg }]}>{confirmation.icon} {confirmation.title}</Text>
                                        <Text style={[styles.confirmText, { color: confirmation.tone.fg }]}>{confirmation.text}</Text>
                                        {!!confirmation.blocked && (
                                            <Text style={[styles.confirmText, { color: warning.fg }]}>⚠️ {confirmation.blocked}</Text>
                                        )}
                                        <Pressable
                                            style={[styles.confirmBtn, { backgroundColor: confirmation.tone.solid }, (lifecycleBusy || !!confirmation.blocked) && { opacity: 0.5 }]}
                                            disabled={lifecycleBusy || !!confirmation.blocked}
                                            onPress={() => open && runLifecycleAction(open)}
                                            accessibilityRole="button"
                                            accessibilityLabel={confirmation.confirm}
                                            accessibilityHint={confirmation.text}
                                            accessibilityState={{ disabled: lifecycleBusy || !!confirmation.blocked, busy: lifecycleBusy }}
                                        >
                                            <Text style={styles.confirmBtnText}>{lifecycleBusy ? confirmation.busy : confirmation.confirm}</Text>
                                        </Pressable>
                                        <Pressable
                                            style={[styles.confirmCancelBtn, lifecycleBusy && { opacity: 0.5 }]}
                                            disabled={lifecycleBusy}
                                            onPress={() => setConfirmingLifecycle(null)}
                                            accessibilityRole="button"
                                        >
                                            <Text style={styles.confirmCancelText}>{confirmation.cancel}</Text>
                                        </Pressable>
                                    </View>
                                ) : (
                                    <View>
                                        {controls.resume && actionButton('resume', 'play', project ? t('Resume Project') : t('Resume Enterprise'), success)}
                                        {controls.pause && actionButton('pause', 'snowflake', t('Pause for Season'), warning)}
                                        {controls.cancelWindUp && actionButton('cancelWindUp', 'stop-circle-outline', t('Stop Wind-Up'), success)}
                                        {controls.finaliseWindUp && actionButton('finaliseWindUp', 'flag-checkered', t('Finalise Wind-Up'), danger)}
                                        {controls.startWindUp && actionButton('windUp', 'alert-outline', t('Start Wind-Up'), danger)}
                                    </View>
                                )}
                            </View>
                        );
                    })()}

                    {/* Its discussion: a keeper removes a message (it shows as removed), as on its page before */}
                    {isKeeperOfThis && threadMessages.length > 0 && (
                        <View style={styles.threadCard} testID="manage-discussion">
                            <Text style={styles.threadTitle} accessibilityRole="header">{t('Discussion')}</Text>
                            <Text style={styles.threadSubtitle}>{t('Remove a message that breaks the community\'s rules. It shows as "{removed}".', { removed: removedLine(project) })}</Text>
                            {threadMessages.map((m: any, idx: number) => {
                                const isRemoved = m.type === 'removed';
                                // A member's name as written, or the start of their key; the word only when there is neither.
                                const authorName = m.authorCallsign || (m.authorPubkey ? m.authorPubkey.slice(0, 8) : t('Member'));
                                return (
                                    <View key={m.id} style={[styles.threadMsgRow, idx === threadMessages.length - 1 && { borderBottomWidth: 0 }]}>
                                        <MemberAvatar avatarUrl={m.authorAvatar} pubkey={m.authorPubkey} callsign={authorName} size={32} />
                                        <View style={styles.threadMsgContent}>
                                            <View style={styles.threadMsgMeta}>
                                                <Text style={styles.threadMsgAuthor} numberOfLines={1}>{authorName}</Text>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                                                    <Text style={styles.threadMsgTime} numberOfLines={1}>{formatTime(m.timestamp)}</Text>
                                                    {!isRemoved && (
                                                        <Pressable
                                                            style={styles.threadRemoveBtn}
                                                            onPress={() => handleRemoveThreadMessage(m.id)}
                                                            disabled={threadRemovingId === m.id}
                                                            accessibilityRole="button"
                                                            accessibilityLabel={t('Remove message from {name}', { name: authorName })}
                                                            accessibilityState={{ disabled: threadRemovingId === m.id, busy: threadRemovingId === m.id }}
                                                        >
                                                            {threadRemovingId === m.id ? (
                                                                <ActivityIndicator size="small" color={colors.feedback.danger.fg} />
                                                            ) : (
                                                                <MaterialCommunityIcons name="trash-can-outline" size={18} color={colors.feedback.danger.fg} />
                                                            )}
                                                        </Pressable>
                                                    )}
                                                </View>
                                            </View>
                                            <Text style={isRemoved ? styles.threadMsgRemoved : styles.threadMsgText}>
                                                {decodeThreadMessage(m.ciphertext, m.type, project)}
                                            </Text>
                                        </View>
                                    </View>
                                );
                            })}
                        </View>
                    )}
                </View>
            </KeyboardAwareScrollView>
        );
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <View style={styles.fill} testID="manage-screen">
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Go back')}>
                    <MaterialCommunityIcons name="chevron-left" size={30} color={colors.text.heading} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={2} accessibilityRole="header">{t('Manage {name}', { name })}</Text>
            </View>

            {body()}
            </View>

            {hourlyDealPrompt && (
                <Modal visible transparent animationType="fade" onRequestClose={() => setHourlyDealPrompt(null)}>
                    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                        <View style={{ backgroundColor: colors.surface.card, borderRadius: 16, padding: 20, width: '100%', maxWidth: 400, borderWidth: 1, borderColor: colors.border.default }}>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 6 }}>
                                {t('Confirm Hours Worked')}
                            </Text>
                            <Text style={{ fontSize: 13, color: colors.text.secondary, marginBottom: 14 }}>
                                {t('Enter actual hours worked for "{title}":', { title: hourlyDealPrompt.post_title })}
                            </Text>
                            <TextInput
                                style={{ height: 48, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 10, paddingHorizontal: 12, fontSize: 15, color: colors.text.body, marginBottom: 16 }}
                                value={hourlyDealHours}
                                onChangeText={setHourlyDealHours}
                                keyboardType="numeric"
                                placeholder={t('e.g. {amount}', { amount: 2.5 })}
                                placeholderTextColor={colors.text.muted}
                                accessibilityLabel={t('Confirm Hours Worked')}
                                autoFocus
                            />
                            <View style={{ flexDirection: 'row', gap: 10 }}>
                                <Pressable
                                    style={{ flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 8 }}
                                    onPress={() => setHourlyDealPrompt(null)}
                                    accessibilityRole="button"
                                >
                                    <Text style={{ color: colors.text.body, fontWeight: '700', textAlign: 'center' }}>{t('Cancel')}</Text>
                                </Pressable>
                                <Pressable
                                    style={{ flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 10, backgroundColor: colors.feedback.success.solid, paddingHorizontal: 8 }}
                                    accessibilityRole="button"
                                    onPress={async () => {
                                        // A decimal comma as the example shows it in comma languages ("ex. 2,5"), and as a comma
                                        // phone's decimal pad types it: the one reading of a typed number (core parseAmount). Any
                                        // decimals, as before; "1.000" in a comma language could be a thousand, so it is refused.
                                        const read = parseAmount(hourlyDealHours, undefined, ANY_DECIMALS);
                                        if (!read.ok && isAmbiguousAmount(read.refusal)) {
                                            Alert.alert(t('Invalid Hours'), amountRefusalWords(read.refusal));
                                            return;
                                        }
                                        const parsed = read.ok ? read.value : NaN;
                                        if (isNaN(parsed) || parsed <= 0) {
                                            Alert.alert(t('Invalid Hours'), t('Please enter a valid positive number of hours.'));
                                            return;
                                        }
                                        const deal = hourlyDealPrompt;
                                        setHourlyDealPrompt(null);
                                        if (!treasuryKey) return;
                                        setActionState({ id: deal.id, type: 'complete' });
                                        try {
                                            await treasuryComplete(treasuryKey, deal.id, parsed);
                                            Alert.alert(t('Payment Released ✅'), t('The beans have been paid to the member.'));
                                            load();
                                        } catch (e: any) {
                                            Alert.alert(t('Release Failed'), e.message ? signedRequestWords(e.message) : t('Could not release payment.'));
                                        } finally {
                                            setActionState(null);
                                        }
                                    }}
                                >
                                    <Text style={{ color: colors.text.inverse, fontWeight: '800', textAlign: 'center' }}>{t('Release Payment')}</Text>
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </Modal>
            )}

            {showCandidatePicker && (
                <Modal visible transparent animationType="fade" onRequestClose={() => setShowCandidatePicker(false)}>
                    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
                        <View style={{ backgroundColor: colors.surface.card, borderRadius: 16, padding: 20, width: '100%', maxWidth: 400, borderWidth: 1, borderColor: colors.border.default }}>
                            <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 6 }}>
                                {project ? t('Propose Leader') : t('Propose Lead Keeper')}
                            </Text>
                            <Text style={{ fontSize: 13, color: colors.text.secondary, marginBottom: 14 }}>
                                {project
                                    ? t('Select an active collaborator to move the leader role to:')
                                    : t('Select an active keeper to move the lead role to:')}
                            </Text>
                            <ScrollView style={{ maxHeight: 240, marginBottom: 16 }}>
                                {(detail?.keepers || [])
                                    .filter((k: any) => !k.suspended && (k.publicKey || k.pubkey || k.memberPubkey) !== leadInactivity?.leadPubkey)
                                    .map((k: any) => {
                                        const pk = k.publicKey || k.pubkey || k.memberPubkey;
                                        return (
                                            <Pressable
                                                key={pk}
                                                style={styles.candidateOption}
                                                onPress={() => handleProposeSuccession(pk)}
                                                accessibilityRole="button"
                                                accessibilityLabel={project
                                                    ? t('Propose {name} as leader', { name: k.callsign })
                                                    : t('Propose {name} as lead keeper', { name: k.callsign })}
                                            >
                                                <Text style={[styles.candidateOptionText, { flex: 1, minWidth: 0 }]}>
                                                    {pk === identity?.publicKey ? t('{name} (yourself)', { name: k.callsign }) : k.callsign}
                                                </Text>
                                                <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.secondary} />
                                            </Pressable>
                                        );
                                    })}
                            </ScrollView>
                            <Pressable
                                style={{ minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.border.default }}
                                onPress={() => setShowCandidatePicker(false)}
                                accessibilityRole="button"
                            >
                                <Text style={{ color: colors.text.body, fontWeight: '700' }}>{t('Cancel')}</Text>
                            </Pressable>
                        </View>
                    </View>
                </Modal>
            )}
        </SafeAreaView>
    );
}
