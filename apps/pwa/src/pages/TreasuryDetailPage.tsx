import { useState, useEffect, useCallback, useRef } from 'react';
import {
    getTreasury, getBalance, treasurySweep,
    treasuryApprove, treasuryReject, treasuryComplete,
    treasuryPostOffer, treasuryPostNeed, treasuryPledge,
    deleteCrowdfundProject,
    pauseEnterprise, resumeEnterprise, initiateWindUp, cancelWindUp, finaliseWindUp,
    getEnterpriseLedger, type EnterpriseLedgerResponse,
    requestToJoinEnterprise, approveKeeperRequest, declineKeeperRequest,
    proposeEnterpriseSuccession, voteEnterpriseSuccession,
    removeEnterpriseKeeper, objectToKeeperChange, stepDownAsKeeper,
    type KeeperRequestItem, type SuccessionProposalItem, type KeeperChangeItem,
    type BalanceInfo,
    getEnterpriseThread, postEnterpriseThreadMessage, removeEnterpriseThreadMessage,
    type EnterpriseThreadMessage
} from '../lib/api';
import { onSyncActivity } from '../lib/sync';
import {
    timeLeftText, keeperChangeTitle, keeperChangeBody, canObjectToChange, canRemoveKeeper, canStepDown,
    stepDownConfirmText, removeKeeperConfirmText, approvedApplicantText, applicantBackingText, successionTallyText,
    successionDeadlineText, myChoice, successionHeading, successionExplainer,
} from '../lib/keeper-governance';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';
import { blankedWithAccount } from '../lib/chat-tombstone';
import { MARKETPLACE_CATEGORIES } from '../lib/marketplace';
import { pledgeClosedLine } from '../lib/enterprise-pledge';
import {
    formatDate, formatNumber, groupKindLine, isSampleId, isWholeCents, keeperWords, t, tn, word, amountRefusalWords, ANY_DECIMALS,
    isAmbiguousAmount, parseAmount, upperCase, type WordKey,
} from '@beanpool/core';
import { ReportModal } from '../components/ReportModal';
import { isUserBlocked, blockUser, unblockUser, onBlocklistUpdated } from '../lib/blocklist';
import { EnterpriseDecisions } from '../components/EnterpriseDecisions';
import { EnterpriseLocationPicker } from '../components/EnterpriseLocationPicker';
import { Sentence } from '../components/Sentence';
import { sampleTreasuryDetail, sampleEnterpriseLedger, SampleHeader } from '../components/ShowcasePreviews';
import {
    ShopfrontFeatured, ShopfrontHeader, ShopfrontKeepers, ShopfrontMessage, ShopfrontMoney, ShopfrontSections, ShopfrontText, ShopfrontTogether,
    ShopfrontVisitorNote,
} from '../components/Shopfront';
import { EnterpriseFace, EnterpriseFeatured } from '../components/EnterpriseManage';
import {
    categorySinceLine, featuredOf, hasShopfront, leadKeeperOf, listingsFromDetailPosts, messageLabel, moneyLine, readKeepers, readOwnerListings,
    readsAsMember, shopCategoryOf, shopPhotoOf, shopSectionsOf, sinceLine, type ShopfrontListing,
} from '../lib/shopfront';
import { LocalCommunityStrip, LocalCommunityAction, LocalCommunityLine, type LocalCommunityWays } from '../components/LocalCommunityMark';

/*
 * The page's words (words sweep W2): a project says leader / collaborators and an enterprise lead keeper / keepers
 * (group decisions pick 8), each sentence written whole for each kind, never core's keeperWords glued into a sentence,
 * so a language can inflect them (the phone's app/treasury-detail.tsx, words S3h, has the same sentences where the
 * English is the same). What members wrote (the name, the purpose, listings, memos, messages, names) is shown as written;
 * the node's own error words are shown as it sent them (slice S4).
 */

/** What stands in for a message a keeper (a project's collaborator) removed: the same words the remove confirm quotes. */
function removedLine(project: boolean): string {
    return project ? t('removed by a collaborator') : t('removed by a keeper');
}

/** The P&L's periods (the phone's LEDGER_PERIODS labels): marked here, translated where shown. */
const LEDGER_PERIOD_WORDS: Readonly<Record<'all' | '30d' | '90d' | '365d', WordKey>> = {
    all: word('All time'),
    '30d': word('30d'),
    '90d': word('90d'),
    '365d': word('1y'),
};

/** "19 Oct, 9:05": core's date and time, in the member's language (never the browser's toLocaleString). */
function formatTimestamp(ts: any): string {
    try {
        const d = new Date(typeof ts === 'number' ? ts : String(ts));
        if (isNaN(d.getTime())) return '';
        return t('{date}, {time}', { date: formatDate(d, 'day-month'), time: formatDate(d, 'time') });
    } catch {
        return '';
    }
}

/** A removed line is a keeper's removal, or its author's own delete when they deleted their account (lib/chat-tombstone.ts). */
function decodeThreadText(ciphertext: string, type: string, metadata: string | undefined, project: boolean): string {
    if (type === 'removed') return blankedWithAccount(metadata) ? t('This message was deleted') : removedLine(project);
    try {
        const binString = atob(ciphertext);
        const bytes = Uint8Array.from(binString, (m) => m.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return ciphertext;
    }
}

/** A marker's own sheet or Start screen (LocalCommunityAction draws them in place): its Escape is its own. */
const MARKER_SHEET = '[data-testid="local-community-sheet"], [data-testid="start-community-screen"]';

interface Props extends LocalCommunityWays {
    identity: BeanPoolIdentity | null;
    pubkey: string;
    onBack: () => void;
    onNavigatePost?: (postId: string) => void;
    /**
     * False for a guest — a local key the node has no member for. Enterprise pins are public,
     * so a guest still gets the page; only the member actions (pledge, keeper request, posting)
     * and the viewer's own balance are skipped. Omitted means "a member if signed in".
     */
    isMember?: boolean;
    /** Opens a member's profile — a keeper row is tapped. */
    onOpenProfile?: (pubkey: string) => void;
    /** Opens a direct message with a member: Message the lead keeper (round 3 §0 row 10). Without it, no Message button. */
    onMessage?: (pubkey: string) => void;
    /**
     * Enterprises are a preview here for this reader (the worldwide community): no real one exists, so a real key (a
     * stale link, a notice) is not asked for and the page says why.
     */
    enterprisesPreview?: boolean;
    /** The tab to open on ('page' default, or 'manage' when opened from a Manage link). */
    initialTab?: 'page' | 'manage';
}

export function TreasuryDetailPage({ identity, pubkey, onBack, onNavigatePost, isMember, onOpenProfile, onMessage, enterprisesPreview, initialTab, ...ways }: Props) {
    // Example Valley's enterprise or project (a sample id: the Commons preview's cards): drawn from the sample, every
    // control a marker, nothing asked of the node. Only a sample id: any other key is a real one.
    const isEffectivePreview = isSampleId(pubkey);
    const elsewhere = !isEffectivePreview && !!enterprisesPreview;
    const viewerIsMember = !!identity && isMember !== false;
    const [detail, setDetail] = useState<any>(null);
    /** A project has a leader and collaborators; an enterprise a lead keeper and keepers (pick 8). */
    const kw = keeperWords(detail?.lifecycle);
    const project = kw.kind === 'project';
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isKeeperOfThis, setIsKeeperOfThis] = useState(false);
    // The page or its keepers' Manage tab (round 3 §3, S8). Each enterprise opens on its page unless initialTab asked.
    const [tab, setTab] = useState<'page' | 'manage'>(initialTab ?? 'page');
    // The shopfront's listings with their photos and stamps (S5, S8): undefined until read, null when they couldn't be, and
    // asked only of a node with the shopfront and only for a member's page; else the detail's own text listings stand in.
    const [ownListings, setOwnListings] = useState<ShopfrontListing[] | null | undefined>(undefined);
    // Another enterprise can open over this one (a keeper's profile, a link: App.tsx changes the key, not the page). It opens
    // on its page with none of the one before's listings, and a read for the one before that lands late is dropped.
    const shownPubkey = useRef(pubkey);
    shownPubkey.current = pubkey;
    useEffect(() => { setTab('page'); setOwnListings(undefined); }, [pubkey]);
    // Manage's Featured card shows these same listings, so an Offer posted, paused or resumed in Manage shows there as on the
    // page. The newest read stands (an older one that lands late is dropped), and one that fails keeps what was read before.
    // An Offer put on or off the shelf while a read is out keeps its new place over what that read says of it.
    const listingsTurn = useRef(0);
    const featuredMeanwhile = useRef(new Set<Map<string, string | null>>());
    const readListings = useCallback(async () => {
        const turn = ++listingsTurn.current;
        const meanwhile = new Map<string, string | null>();
        featuredMeanwhile.current.add(meanwhile);
        const read = await readOwnerListings(pubkey);
        featuredMeanwhile.current.delete(meanwhile);
        if (shownPubkey.current !== pubkey || turn !== listingsTurn.current) return;
        setOwnListings((was) => !read
            ? (Array.isArray(was) ? was : read)
            : read.map((l) => (meanwhile.has(l.id) ? { ...l, featuredAt: meanwhile.get(l.id) ?? null } : l)));
    }, [pubkey]);
    const featuredHere = (postId: string, featuredAt: string | null) => {
        if (shownPubkey.current !== pubkey) return;
        featuredMeanwhile.current.forEach((m) => m.set(postId, featuredAt));
        setOwnListings((was) => was && was.map((l) => (l.id === postId ? { ...l, featuredAt } : l)));
    };

    // Operator Action States
    const [sweepAmount, setSweepAmount] = useState('');
    const [sweeping, setSweeping] = useState(false);
    const [actionState, setActionState] = useState<{ id: string; type: 'approve' | 'reject' | 'complete' } | null>(null);
    // Where its words show: by the pledge, by the join card, or (unsaid) in Manage, where every other action now is.
    const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; message: string; at?: 'pledge' | 'join' } | null>(null);
    const feedbackAt = (at: 'pledge' | 'join' | 'manage') => !!actionFeedback && (actionFeedback.at ?? 'manage') === at;

    // Lifecycle Action States
    const [confirmingPause, setConfirmingPause] = useState(false);
    const [confirmingResume, setConfirmingResume] = useState(false);
    const [confirmingWindUp, setConfirmingWindUp] = useState(false);
    const [confirmingCancelWindUp, setConfirmingCancelWindUp] = useState(false);
    const [confirmingFinaliseWindUp, setConfirmingFinaliseWindUp] = useState(false);
    const [lifecycleActionLoading, setLifecycleActionLoading] = useState(false);

    // P&L Accountability Ledger State
    const [ledgerData, setLedgerData] = useState<EnterpriseLedgerResponse | null>(null);
    const [ledgerLoading, setLedgerLoading] = useState(false);
    const [ledgerError, setLedgerError] = useState<string | null>(null);
    const [ledgerPeriod, setLedgerPeriod] = useState<'all' | '30d' | '90d' | '365d'>('all');

    // Pledge States
    const [pledgeAmount, setPledgeAmount] = useState('');
    const [pledgeMemo, setPledgeMemo] = useState('');
    const [pledging, setPledging] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [showReportModal, setShowReportModal] = useState(false);
    // The "…" menu at the foot, with Block (DESIGN-shops-round3-enterprise-shopfront §0 row 11, §3): a member may hide an
    // enterprise they don't want to see. Not a header button, as it was on the member Trust Profile an enterprise used to
    // open; none for its keepers on their own enterprise's page.
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [isBlocked, setIsBlocked] = useState(() => isUserBlocked(pubkey));
    const [isBlocking, setIsBlocking] = useState(false);

    // Discussion Thread State
    const [threadMessages, setThreadMessages] = useState<EnterpriseThreadMessage[]>([]);
    const [threadReadOnly, setThreadReadOnly] = useState(false);
    const [threadInput, setThreadInput] = useState('');
    const [threadPosting, setThreadPosting] = useState(false);
    const [threadError, setThreadError] = useState<string | null>(null);
    const [threadRemovingId, setThreadRemovingId] = useState<string | null>(null);
    const [threadUnavailable, setThreadUnavailable] = useState(false);

    // Post Modal State
    const [postModalMode, setPostModalMode] = useState<'offer' | 'need' | null>(null);
    const [postTitle, setPostTitle] = useState('');
    const [postCategory, setPostCategory] = useState('food');
    const [postCredits, setPostCredits] = useState('');
    const [postPriceType, setPostPriceType] = useState('fixed');
    const [postDescription, setPostDescription] = useState('');
    const [postRepeatable, setPostRepeatable] = useState(true);
    const [posting, setPosting] = useState(false);
    const [postError, setPostError] = useState<string | null>(null);

    // Keeper Join Request State
    const [joinBackingPledge, setJoinBackingPledge] = useState<number>(0);
    const [submittingJoinRequest, setSubmittingJoinRequest] = useState(false);
    const [requestProcessingId, setRequestProcessingId] = useState<string | null>(null);

    // Keeper changes (3-day objection window) and stepping down
    const [changeProcessingId, setChangeProcessingId] = useState<string | null>(null);
    const [steppingDown, setSteppingDown] = useState(false);

    // Succession Proposal State
    const [selectedSuccessionCandidate, setSelectedSuccessionCandidate] = useState<string>('');
    const [submittingSuccession, setSubmittingSuccession] = useState(false);

    // Map Pin State
    const [showLocationPicker, setShowLocationPicker] = useState(false);

    const handleJoinRequest = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submittingJoinRequest) return;
        try {
            setSubmittingJoinRequest(true);
            setActionFeedback(null);
            await requestToJoinEnterprise(pubkey, Number(joinBackingPledge));
            const amount = formatNumber(joinBackingPledge);
            setActionFeedback({
                at: 'join',
                type: 'success',
                message: project
                    ? t('Join request submitted with {amount} 🫘 backing pledge. Awaiting leader review.', { amount })
                    : t('Join request submitted with {amount} 🫘 backing pledge. Awaiting lead keeper review.', { amount })
            });
            await load();
        } catch (err: any) {
            setActionFeedback({
                at: 'join',
                type: 'error',
                message: err.message || t('Failed to submit join request.')
            });
        } finally {
            setSubmittingJoinRequest(false);
        }
    };

    const handleApproveRequest = async (requestId: string) => {
        if (requestProcessingId) return;
        try {
            setRequestProcessingId(requestId);
            setActionFeedback(null);
            const res = await approveKeeperRequest(pubkey, requestId);
            const amount = formatNumber(res.backing ?? 0);
            setActionFeedback({
                type: 'success',
                message: res.applied === false
                    ? (project
                        ? t('Approved. They become a collaborator in 3 days, unless another collaborator objects first.')
                        : t('Approved. They become a keeper in 3 days, unless another keeper objects first.'))
                    : (project
                        ? t('Approved collaborator request with {amount} 🫘 backing.', { amount })
                        : t('Approved keeper request with {amount} 🫘 backing.', { amount }))
            });
            await load(true);
        } catch (err: any) {
            setActionFeedback({
                type: 'error',
                message: err.message || (project ? t('Failed to approve collaborator request.') : t('Failed to approve keeper request.'))
            });
        } finally {
            setRequestProcessingId(null);
        }
    };

    const handleDeclineRequest = async (requestId: string) => {
        if (requestProcessingId) return;
        try {
            setRequestProcessingId(requestId);
            setActionFeedback(null);
            await declineKeeperRequest(pubkey, requestId);
            setActionFeedback({
                type: 'success',
                message: project ? t('Declined collaborator request.') : t('Declined keeper request.')
            });
            await load(true);
        } catch (err: any) {
            setActionFeedback({
                type: 'error',
                message: err.message || (project ? t('Failed to decline collaborator request.') : t('Failed to decline keeper request.'))
            });
        } finally {
            setRequestProcessingId(null);
        }
    };

    const handleProposeSuccession = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submittingSuccession || !selectedSuccessionCandidate) return;
        try {
            setSubmittingSuccession(true);
            setActionFeedback(null);
            const res: any = await proposeEnterpriseSuccession(pubkey, selectedSuccessionCandidate);
            const passed = res.executed ?? res.leadMoved ?? false;
            if (passed) {
                setActionFeedback({
                    type: 'success',
                    message: project
                        ? t('Succession passed! The leader role moved to the candidate.')
                        : t('Succession passed! The lead keeper role moved to the candidate.')
                });
            } else {
                const count = res.proposal?.votesCount ?? res.votesCount ?? 1;
                const req = res.proposal?.requiredVotes ?? res.votesRequired ?? 2;
                // English says "votes" for every count; another language may not.
                setActionFeedback({
                    type: 'success',
                    message: project
                        ? tn(req, 'Succession proposal submitted ({count} of {n} votes). Awaiting other collaborators.', 'Succession proposal submitted ({count} of {n} votes). Awaiting other collaborators.', { count })
                        : tn(req, 'Succession proposal submitted ({count} of {n} votes). Awaiting other keepers.', 'Succession proposal submitted ({count} of {n} votes). Awaiting other keepers.', { count })
                });
            }
            setSelectedSuccessionCandidate('');
            await load(true);
        } catch (err: any) {
            setActionFeedback({
                type: 'error',
                message: err.message || (project ? t('Failed to propose a new leader.') : t('Failed to propose a new lead keeper.'))
            });
        } finally {
            setSubmittingSuccession(false);
        }
    };

    const handleObjectToChange = async (changeId: string) => {
        if (changeProcessingId) return;
        try {
            setChangeProcessingId(changeId);
            setActionFeedback(null);
            await objectToKeeperChange(pubkey, changeId);
            setActionFeedback({ type: 'success', message: t('Objection recorded. The change is cancelled.') });
            await load(true);
        } catch (err: any) {
            setActionFeedback({ type: 'error', message: err.message || t('Could not object.') });
        } finally {
            setChangeProcessingId(null);
        }
    };

    const handleRemoveKeeper = async (k: any) => {
        if (changeProcessingId) return;
        if (!window.confirm(t('Remove {name}? {what}', { name: k.callsign, what: removeKeeperConfirmText(k, kw) }))) return;
        try {
            setChangeProcessingId(k.publicKey);
            setActionFeedback(null);
            await removeEnterpriseKeeper(pubkey, k.publicKey);
            setActionFeedback({ type: 'success', message: removeKeeperConfirmText(k, kw) });
            await load(true);
        } catch (err: any) {
            setActionFeedback({ type: 'error', message: err.message || (project ? t('Could not remove the collaborator.') : t('Could not remove the keeper.')) });
        } finally {
            setChangeProcessingId(null);
        }
    };

    const handleStepDown = async () => {
        const me = identity?.publicKey;
        if (!me || steppingDown) return;
        const what = stepDownConfirmText(me, keeperList, kw);
        if (!window.confirm(project ? t('Step down as a collaborator? {what}', { what }) : t('Step down as a keeper? {what}', { what }))) return;
        try {
            setSteppingDown(true);
            setActionFeedback(null);
            await stepDownAsKeeper(pubkey);
            setActionFeedback({ type: 'success', message: project ? t('You have stepped down as a collaborator.') : t('You have stepped down as a keeper.') });
            await load(true);
        } catch (err: any) {
            // The server says plainly what must happen first (e.g. the debt your pledge covers).
            setActionFeedback({ type: 'error', message: err.message || t('Could not step down.') });
        } finally {
            setSteppingDown(false);
        }
    };

    const handleVoteSuccession = async (proposalId: string, choice: 'yes' | 'no') => {
        if (submittingSuccession) return;
        try {
            setSubmittingSuccession(true);
            setActionFeedback(null);
            const res: any = await voteEnterpriseSuccession(pubkey, proposalId, choice);
            const passed = res.executed ?? res.leadMoved ?? false;
            if (passed) {
                setActionFeedback({
                    type: 'success',
                    message: project
                        ? t('Succession vote registered and passed! The leader role has been transferred.')
                        : t('Succession vote registered and passed! The lead keeper role has been transferred.')
                });
            } else if (res.proposal?.closedReason === 'rejected') {
                setActionFeedback({
                    type: 'success',
                    message: project
                        ? t('Vote registered. Not enough collaborators can now say yes, so the leader stays.')
                        : t('Vote registered. Not enough keepers can now say yes, so the lead stays.'),
                });
            } else {
                const count = res.proposal?.votesCount ?? res.votesCount ?? 1;
                const req = res.proposal?.requiredVotes ?? res.votesRequired ?? 2;
                setActionFeedback({
                    type: 'success',
                    message: t('Succession vote registered ({count} yes of {needed} needed).', { count, needed: req })
                });
            }
            await load(true);
        } catch (err: any) {
            setActionFeedback({
                type: 'error',
                message: err.message || t('Failed to vote on succession.')
            });
        } finally {
            setSubmittingSuccession(false);
        }
    };


    const handlePledge = async (e: React.FormEvent) => {
        e.preventDefault();
        if (pledging) return;
        // The language's decimal mark (core parseAmount): fr "12,5" is 12.5; "1.000", which could be a thousand, is refused
        // in words that say so. The cents guard below decides the decimals, as before.
        const read = parseAmount(pledgeAmount, undefined, ANY_DECIMALS);
        if (!read.ok && isAmbiguousAmount(read.refusal)) {
            setActionFeedback({ at: 'pledge', type: 'error', message: amountRefusalWords(read.refusal) });
            return;
        }
        const amt = read.ok ? read.value : NaN;
        if (isNaN(amt) || amt <= 0) {
            setActionFeedback({ at: 'pledge', type: 'error', message: t('Please enter a positive amount of Beans to pledge.') });
            return;
        }
        // To the cent, as the node takes it (core isWholeCents).
        if (!isWholeCents(amt)) {
            setActionFeedback({ at: 'pledge', type: 'error', message: t('The amount is a number of Beans above 0, to the cent.') });
            return;
        }
        try {
            setPledging(true);
            setActionFeedback(null);
            await treasuryPledge(pubkey, amt, pledgeMemo.trim() || undefined);
            setPledgeAmount('');
            setPledgeMemo('');
            const amount = formatNumber(amt);
            setActionFeedback({
                at: 'pledge',
                type: 'success',
                message: detail?.name
                    ? t('Successfully pledged {amount} 🫘 to {name}!', { amount, name: detail.name })
                    : project ? t('Successfully pledged {amount} 🫘 to the project!', { amount }) : t('Successfully pledged {amount} 🫘 to the enterprise!', { amount }),
            });
            await load();
        } catch (err: any) {
            setActionFeedback({ at: 'pledge', type: 'error', message: err.message || t('Failed to complete pledge.') });
        } finally {
            setPledging(false);
        }
    };

    /** The deadline badge's words, and whether the deadline has passed (the badge's colour): never by comparing words. */
    const getDaysRemaining = (deadline: string | null | undefined): { text: string; expired: boolean } | null => {
        if (!deadline) return null;
        const diff = new Date(deadline).getTime() - new Date().getTime();
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        if (days < 0) return { text: t('Expired'), expired: true };
        if (days === 0) return { text: t('Ends today'), expired: false };
        // English says "days" for every count, as it always has here; another language may not.
        return { text: tn(days, '{n} days left', '{n} days left'), expired: false };
    };

    /**
     * Reads it again; `quiet` keeps the page drawn meanwhile (a Manage form keeps what it said, "Saved."). Every Manage
     * action reads it again quietly: "Loading…" in its place would unmount the face, and a keeper's unsaved words with it.
     */
    const load = useCallback(async (quiet = false) => {
        if (isEffectivePreview) {
            setLoading(true);
            setError(null);
            const d = sampleTreasuryDetail(pubkey);
            setDetail(d);
            setIsKeeperOfThis(false);
            setLoading(false);
            return;
        }
        if (elsewhere) {
            setDetail(null);
            setLoading(false);
            return;
        }
        // Still the enterprise on the page: another opened over it meanwhile leaves its answers unused.
        const current = () => shownPubkey.current === pubkey;
        try {
            if (!quiet) setLoading(true);
            setError(null);
            const d = await getTreasury(pubkey);
            if (!current()) return;
            setDetail(d);
            // Its listings with photos and the Featured stamp (S5): from a node with the shopfront, for a member's page only.
            if (hasShopfront(d) && readsAsMember(d)) void readListings();

            if (identity?.publicKey && viewerIsMember) {
                const inKeepers = Array.isArray(d?.keepers) && d.keepers.some((k: any) => !k.suspended && (k.publicKey || k.pubkey || k.memberPubkey) === identity.publicKey);
                // The viewer's balance only refines keeper status. The node answers "Member not
                // found" for a key it doesn't know, and that must never replace the enterprise.
                let mine: string[] = [];
                try {
                    const b: BalanceInfo = await getBalance(identity.publicKey);
                    mine = Array.isArray(b.keeperOf) ? b.keeperOf : [];
                } catch {
                    // fall back to the keeper list the enterprise itself returned
                }
                if (!current()) return;
                setIsKeeperOfThis(mine.includes(pubkey) || inKeepers);
            } else {
                setIsKeeperOfThis(false);
            }
        } catch (e: any) {
            // A quiet read again that fails leaves the page as it was.
            if (!quiet && current()) setError(e.message || t('Check your connection and try again.'));
        } finally {
            if (!quiet && current()) setLoading(false);
        }
    }, [pubkey, identity?.publicKey, viewerIsMember, isEffectivePreview, elsewhere, readListings]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        setIsBlocked(isUserBlocked(pubkey));
        return onBlocklistUpdated(() => setIsBlocked(isUserBlocked(pubkey)));
    }, [pubkey]);

    const loadLedger = useCallback(async (period: 'all' | '30d' | '90d' | '365d' = ledgerPeriod) => {
        if (isEffectivePreview) {
            setLedgerLoading(true);
            setLedgerError(null);
            setLedgerData(sampleEnterpriseLedger(pubkey));
            setLedgerLoading(false);
            return;
        }
        if (elsewhere) return;
        try {
            setLedgerLoading(true);
            setLedgerError(null);
            let since: string | undefined;
            if (period === '30d') {
                since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
            } else if (period === '90d') {
                since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
            } else if (period === '365d') {
                since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
            }
            const data = await getEnterpriseLedger(pubkey, { since });
            setLedgerData(data);
        } catch (e: any) {
            setLedgerError(e?.message || t('Could not load the ledger'));
        } finally {
            setLedgerLoading(false);
        }
    }, [pubkey, ledgerPeriod, isEffectivePreview, elsewhere]);

    useEffect(() => {
        loadLedger(ledgerPeriod);
    }, [loadLedger, ledgerPeriod]);

    const loadThread = useCallback(async () => {
        if (!pubkey || isEffectivePreview || elsewhere) return;
        try {
            const res = await getEnterpriseThread(pubkey);
            if (res) {
                setThreadMessages(res.messages || []);
                setThreadReadOnly(!!res.readOnly);
            }
            setThreadUnavailable(false);
        } catch {
            setThreadUnavailable(true);
        }
    }, [pubkey, isEffectivePreview, elsewhere]);

    useEffect(() => {
        loadThread();
        if (isEffectivePreview || elsewhere) return;
        const unsubscribe = onSyncActivity(() => {
            loadThread();
        });
        return () => unsubscribe();
    }, [loadThread, isEffectivePreview, elsewhere]);

    const handlePostThreadMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!pubkey || threadPosting || !threadInput.trim()) return;
        setThreadPosting(true);
        setThreadError(null);
        try {
            const res = await postEnterpriseThreadMessage(pubkey, threadInput.trim());
            if (res?.success) {
                setThreadInput('');
                await loadThread();
            }
        } catch (e: any) {
            setThreadError(e?.message || t('Could not post message'));
        } finally {
            setThreadPosting(false);
        }
    };

    const handleRemoveThreadMessage = async (messageId: string) => {
        if (!pubkey || threadRemovingId) return;
        if (!window.confirm(t('Are you sure you want to remove this message? It will show as "{removed}".', { removed: removedLine(project) }))) return;
        setThreadRemovingId(messageId);
        setThreadError(null);
        try {
            await removeEnterpriseThreadMessage(pubkey, messageId);
            await loadThread();
        } catch (e: any) {
            setThreadError(e?.message || t('Could not remove message'));
        } finally {
            setThreadRemovingId(null);
        }
    };

    const handlePause = async () => {
        try {
            setLifecycleActionLoading(true);
            setActionFeedback(null);
            await pauseEnterprise(pubkey);
            setConfirmingPause(false);
            setActionFeedback({
                type: 'success',
                message: project ? t('Project paused for the season. Credit held at snapshot.') : t('Enterprise paused for the season. Credit held at snapshot.'),
            });
            await load(true);
            await loadLedger(ledgerPeriod);
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e?.message || (project ? t('Failed to pause the project') : t('Failed to pause the enterprise')) });
        } finally {
            setLifecycleActionLoading(false);
        }
    };

    const handleResume = async () => {
        try {
            setLifecycleActionLoading(true);
            setActionFeedback(null);
            await resumeEnterprise(pubkey);
            setConfirmingResume(false);
            setActionFeedback({
                type: 'success',
                message: project ? t('Project resumed! Active listings are now buyable again.') : t('Enterprise resumed! Active listings are now buyable again.'),
            });
            await load(true);
            await loadLedger(ledgerPeriod);
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e?.message || (project ? t('Failed to resume the project') : t('Failed to resume the enterprise')) });
        } finally {
            setLifecycleActionLoading(false);
        }
    };

    const handleInitiateWindUp = async () => {
        try {
            setLifecycleActionLoading(true);
            setActionFeedback(null);
            await initiateWindUp(pubkey);
            setConfirmingWindUp(false);
            setActionFeedback({ type: 'success', message: t('Wind-up initiated. 7-day grace period has begun.') });
            await load(true);
            await loadLedger(ledgerPeriod);
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e?.message || t('Failed to initiate wind-up') });
        } finally {
            setLifecycleActionLoading(false);
        }
    };

    const handleCancelWindUp = async () => {
        try {
            setLifecycleActionLoading(true);
            setActionFeedback(null);
            await cancelWindUp(pubkey);
            setConfirmingCancelWindUp(false);
            setActionFeedback({
                type: 'success',
                message: project ? t('Wind-up cancelled. Project restored to active status.') : t('Wind-up cancelled. Enterprise restored to active status.'),
            });
            await load(true);
            await loadLedger(ledgerPeriod);
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e?.message || t('Failed to cancel wind-up') });
        } finally {
            setLifecycleActionLoading(false);
        }
    };

    const handleFinaliseWindUp = async () => {
        try {
            setLifecycleActionLoading(true);
            setActionFeedback(null);
            const res = await finaliseWindUp(pubkey);
            setConfirmingFinaliseWindUp(false);
            const amount = formatNumber(res.sweptAmount ?? 0);
            setActionFeedback({
                type: 'success',
                message: project
                    ? t('Wind-up finalised. Swept {amount} 🫘 to Commons and released collaborators.', { amount })
                    : t('Wind-up finalised. Swept {amount} 🫘 to Commons and released keepers.', { amount }),
            });
            await load(true);
            await loadLedger(ledgerPeriod);
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e?.message || t('Failed to finalise wind-up') });
        } finally {
            setLifecycleActionLoading(false);
        }
    };

    // Keyboard ESC listener to close modal or go back
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (document.querySelector(MARKER_SHEET)) return;
                if (postModalMode) {
                    setPostModalMode(null);
                } else {
                    onBack();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [postModalMode, onBack]);

    const handleSweep = async (e: React.FormEvent) => {
        e.preventDefault();
        // The language's decimal mark (core parseAmount), as the pledge reads it; the node's cents rule decides the decimals.
        const read = parseAmount(sweepAmount, undefined, ANY_DECIMALS);
        if (!read.ok && isAmbiguousAmount(read.refusal)) {
            setActionFeedback({ type: 'error', message: amountRefusalWords(read.refusal) });
            return;
        }
        const amt = read.ok ? read.value : NaN;
        const bal = detail?.balance ?? 0;
        if (isNaN(amt) || amt <= 0) {
            setActionFeedback({ type: 'error', message: t('Please enter a positive amount of Beans to sweep.') });
            return;
        }
        if (amt > bal) {
            setActionFeedback({ type: 'error', message: t('Cannot sweep more than current surplus ({amount} 🫘).', { amount: formatNumber(bal) }) });
            return;
        }

        try {
            setSweeping(true);
            setActionFeedback(null);
            await treasurySweep(pubkey, amt);
            setSweepAmount('');
            setActionFeedback({ type: 'success', message: t('Successfully swept {amount} 🫘 to the shared Commons pool.', { amount: formatNumber(amt) }) });
            await load(true);
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e.message || t('Failed to sweep surplus to the Commons.') });
        } finally {
            setSweeping(false);
        }
    };

    const handleApproveBid = async (txId: string) => {
        try {
            setActionState({ id: txId, type: 'approve' });
            setActionFeedback(null);
            await treasuryApprove(pubkey, txId);
            setActionFeedback({ type: 'success', message: t('Bid approved! Escrow funds locked in trust.') });
            await load(true);
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e.message || t('Failed to approve bid.') });
        } finally {
            setActionState(null);
        }
    };

    const handleRejectBid = async (txId: string) => {
        const confirmed = window.confirm(t('Are you sure you want to decline this request? The member will be notified.'));
        if (!confirmed) return;
        try {
            setActionState({ id: txId, type: 'reject' });
            setActionFeedback(null);
            await treasuryReject(pubkey, txId);
            setActionFeedback({ type: 'success', message: t('Bid declined.') });
            await load(true);
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e.message || t('Failed to decline bid.') });
        } finally {
            setActionState(null);
        }
    };

    const handleCompleteDeal = async (txId: string, postTitle?: string, credits?: number, priceType?: string, initialHours?: number) => {
        let finalHours: number | undefined;
        if (priceType && priceType !== 'fixed') {
            // The hours as typed, in the language's decimal mark (core parseAmount): fr "2,5" is 2.5, any decimals, as before.
            const question = postTitle ? t('Enter hours worked for "{title}":', { title: postTitle }) : t('Enter hours worked for "deal":');
            const input = window.prompt(question, initialHours ? formatNumber(initialHours) : '1');
            if (input === null) return;
            const read = parseAmount(input, undefined, ANY_DECIMALS);
            if (!read.ok && isAmbiguousAmount(read.refusal)) {
                alert(amountRefusalWords(read.refusal));
                return;
            }
            const parsed = read.ok ? read.value : NaN;
            if (isNaN(parsed) || parsed <= 0) {
                alert(t('Please enter a valid positive number of hours.'));
                return;
            }
            finalHours = parsed;
        } else {
            const amount = credits != null ? formatNumber(credits) : '';
            const confirmed = window.confirm(postTitle
                ? t('Release payment of {amount} 🫘 for "{title}"? This action cannot be reversed.', { amount, title: postTitle })
                : t('Release payment of {amount} 🫘 for "deal"? This action cannot be reversed.', { amount }));
            if (!confirmed) return;
        }
        try {
            setActionState({ id: txId, type: 'complete' });
            setActionFeedback(null);
            await treasuryComplete(pubkey, txId, finalHours);
            setActionFeedback({ type: 'success', message: t('Payment released! Worker has been paid.') });
            await load(true);
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e.message || t('Failed to release payment.') });
        } finally {
            setActionState(null);
        }
    };

    const handleCancelInitiative = async () => {
        if (!pubkey || cancelling) return;
        const confirmed = window.confirm(
            t('Cancel Initiative & Refund Backers?\n\nThis will close the initiative and immediately refund all escrowed pledges back to their backers.')
        );
        if (!confirmed) return;
        try {
            setCancelling(true);
            setActionFeedback(null);
            await deleteCrowdfundProject(pubkey, identity?.publicKey);
            alert(t('Initiative Cancelled 🌱\n\nPledges have been refunded to backers.'));
            onBack();
        } catch (e: any) {
            setActionFeedback({ type: 'error', message: e.message || t('Could not cancel initiative.') });
        } finally {
            setCancelling(false);
        }
    };

    const handleCreatePost = async (e: React.FormEvent) => {
        e.preventDefault();
        // The price in the language's decimal mark (core parseAmount): fr "12,5" is 12.5, any decimals, as before.
        const creditsRead = parseAmount(postCredits, undefined, ANY_DECIMALS);
        const creditsNum = creditsRead.ok ? creditsRead.value : NaN;
        if (!postTitle.trim()) {
            setPostError(t('Title is required'));
            return;
        }
        if (!creditsRead.ok && isAmbiguousAmount(creditsRead.refusal)) {
            setPostError(amountRefusalWords(creditsRead.refusal));
            return;
        }
        if (isNaN(creditsNum) || creditsNum <= 0) {
            setPostError(t('Please enter a valid credit amount'));
            return;
        }

        try {
            setPosting(true);
            setPostError(null);
            if (postModalMode === 'offer') {
                await treasuryPostOffer(pubkey, {
                    title: postTitle.trim(),
                    category: postCategory,
                    credits: creditsNum,
                    priceType: postPriceType,
                    description: postDescription.trim() || undefined,
                    repeatable: postRepeatable,
                });
            } else {
                await treasuryPostNeed(pubkey, {
                    title: postTitle.trim(),
                    category: postCategory,
                    credits: creditsNum,
                    priceType: postPriceType,
                    description: postDescription.trim() || undefined,
                });
            }
            setPostModalMode(null);
            setPostTitle('');
            setPostDescription('');
            setPostCredits('');
            const offer = postModalMode === 'offer';
            setActionFeedback({
                type: 'success',
                message: project
                    ? (offer ? t('Offer posted on behalf of the project.') : t('Need posted on behalf of the project.'))
                    : (offer ? t('Offer posted on behalf of the enterprise.') : t('Need posted on behalf of the enterprise.'))
            });
            await load(true);
        } catch (e: any) {
            setPostError(e.message || (postModalMode === 'offer' ? t('Failed to post offer.') : t('Failed to post need.')));
        } finally {
            setPosting(false);
        }
    };

    /** "17 December": core's long date in the member's language (en as toLocaleDateString('en-GB', { day, month: 'long' }) printed it). */
    const formatPauseDate = (iso: string | null | undefined): string => {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            return formatDate(d, 'day-month', { width: 'long' });
        } catch {
            return '';
        }
    };

    const balance = detail?.balance ?? 0;
    const name = detail?.name || t('Community Enterprise');

    const mayBlock = !isEffectivePreview && viewerIsMember && !isKeeperOfThis;
    const handleBlock = async () => {
        if (isBlocking || !identity) return;
        if (!window.confirm(t('Block {name}?\n\nThis will instantly hide all posts, offers, and messages from {name}, and notify moderation.', { name }))) return;
        try {
            setIsBlocking(true);
            // The reason goes to the node as written (moderators read it), not in the member's language.
            await blockUser(pubkey, identity.publicKey, 'Blocked from the enterprise page');
            setIsBlocked(true);
            setShowMoreMenu(false);
            alert(t('{name} has been blocked and removed from your feed.', { name }));
        } catch (e: any) {
            alert(e?.message || t('Failed to block user. Please try again.'));
        } finally {
            setIsBlocking(false);
        }
    };
    const handleUnblock = async () => {
        if (isBlocking) return;
        if (!window.confirm(t('Unblock {name}?', { name }))) return;
        try {
            setIsBlocking(true);
            await unblockUser(pubkey);
            setIsBlocked(false);
            setShowMoreMenu(false);
            alert(t('{name} has been unblocked.', { name }));
        } catch (e: any) {
            alert(e?.message || t('Failed to unblock. Please try again.'));
        } finally {
            setIsBlocking(false);
        }
    };
    // What the node's P&L summary counts as "came in" is gross; net change is net of the community fee.
    const ledgerFees = ledgerData?.summary
        ? Math.round((ledgerData.summary.totalIncome - ledgerData.summary.totalSpend - ledgerData.summary.netChange) * 100) / 100
        : 0;
    const pendingBids: any[] = detail?.pendingBids || [];
    const activeDeals: any[] = detail?.activeDeals || [];
    const flow: any[] = detail?.flow || [];
    const keepers: any[] = detail?.keepers || [];
    const deferredClaims: any[] = detail?.deferredClaims || [];
    const pendingClaims = deferredClaims.filter((c: any) => c.status === 'pending');
    const pendingClaimsTotal = pendingClaims.reduce((sum: number, c: any) => sum + (Number(c.amount) || 0), 0);

    const heldCredit = Math.abs(detail?.pausedFloorSnapshot ?? detail?.usableFloor ?? detail?.floor ?? detail?.creditLine ?? 0);
    const pauseExpiresAt = detail?.pauseExpiresAt || (detail?.pausedAt ? new Date(new Date(detail.pausedAt).getTime() + 90 * 24 * 60 * 60 * 1000).toISOString() : null);
    const pauseDateFormatted = formatPauseDate(pauseExpiresAt);

    const windUpGraceEndsAt = detail?.windUpGraceEndsAt || (detail?.windUpInitiatedAt ? new Date(new Date(detail.windUpInitiatedAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() : null);
    const windUpDaysLeft = windUpGraceEndsAt
        ? Math.max(0, Math.ceil((new Date(windUpGraceEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
        : 0;
    const windUpGraceEnded = windUpGraceEndsAt ? Date.now() >= new Date(windUpGraceEndsAt).getTime() : false;
    const initiatorKeeper = detail?.keepers?.find((k: any) => k.publicKey === detail?.windUpInitiatedBy);
    const initiatorName: string | null = initiatorKeeper?.callsign || (detail?.windUpInitiatedBy ? `${detail.windUpInitiatedBy.slice(0, 8)}…` : null);
    // Who started it, or the role in their place: each its own sentence (the phone's enterprise-season.ts).
    const windingUpLine = initiatorName
        ? tn(windUpDaysLeft, 'Winding up ({n} day left · started by {name})', 'Winding up ({n} days left · started by {name})', { name: initiatorName })
        : project
            ? tn(windUpDaysLeft, 'Winding up ({n} day left · started by a collaborator)', 'Winding up ({n} days left · started by a collaborator)')
            : tn(windUpDaysLeft, 'Winding up ({n} day left · started by a keeper)', 'Winding up ({n} days left · started by a keeper)');
    const keeperCount = detail?.keepers?.length || 1;

    const availableToBack = detail?.availableToBack ?? 0;
    const isLeadOrSoleKeeperOrAdmin = !!detail?.isLeadOrSoleKeeperOrAdmin;
    const keeperRequests: KeeperRequestItem[] = detail?.keeperRequests || [];
    const myPendingRequest: KeeperRequestItem | null = detail?.myPendingRequest || null;
    const leadInactivity = detail?.leadInactivity || null;
    const successionInfo = detail?.succession || null;
    const activeProposal: SuccessionProposalItem | null =
        successionInfo?.proposals?.find((p: any) => p.status === 'active') || null;
    const keeperList: any[] = keepers.map((k: any) => ({ ...k, publicKey: k.publicKey || k.pubkey || k.memberPubkey }));
    const keeperChanges: KeeperChangeItem[] = detail?.keeperChanges || [];
    const myPubkey: string | null = identity?.publicKey ?? null;
    const iAmLead = keeperList.some((k) => k.publicKey === myPubkey && k.role === 'lead');
    const removableKeepers = keeperList.filter((k) => canRemoveKeeper(k, myPubkey, iAmLead, keeperChanges));
    const isEligibleSuccessor = isKeeperOfThis && !!identity?.publicKey && !!leadInactivity?.leadPubkey && identity.publicKey !== leadInactivity.leadPubkey;

    // Map pin: only this enterprise's ACTIVE keepers, and never on a closed enterprise. The keepers list marks
    // suspended keepers; keeperOf also leaves them out now (it checks account status as well as the switch), so
    // this matches isKeeperOfThis for a current node and stays strict against an older one.
    const isActiveKeeperOfThis = !!identity?.publicKey && Array.isArray(detail?.keepers) && detail.keepers.some(
        (k: any) => !k.suspended && (k.publicKey || k.pubkey || k.memberPubkey) === identity.publicKey
    );
    const canSetMapPin = isActiveKeeperOfThis && !['completed', 'disabled', 'suspended', 'pruned'].includes(detail?.status);
    const hasMapPin = detail?.lat != null && detail?.lng != null;

    // The shopfront (round 3 §3, S8, the phone's S5): who keeps it with their badges, whom Message writes to, whether this
    // reader gets a member's page (a visitor's ends after How we deal), and its listings, with photos where the node sent them.
    const shopfrontKeepers = readKeepers(detail?.keepers);
    const leadKeeper = leadKeeperOf(shopfrontKeepers);
    const memberView = isEffectivePreview || readsAsMember(detail);
    const shopListings: ShopfrontListing[] = ownListings ?? listingsFromDetailPosts(detail?.posts);
    // What each of its listings says of it while it is paused, winding up or closed (the old listing rows' badge).
    const listingNote = detail?.status === 'completed'
        ? t('Closed', undefined, 'a listing')
        : detail?.status === 'winding_up' ? t('⏳ Winding up') : detail?.paused ? t('⏸️ Paused') : null;
    // Example Valley's listings open nothing: they are no listing here.
    const openListing = !isEffectivePreview && onNavigatePost ? onNavigatePost : undefined;
    // Manage: its keepers, a node admin whose keeper requests they are, and Example Valley's visitor (its controls as markers).
    const canManage = !elsewhere && (isKeeperOfThis || isLeadOrSoleKeeperOrAdmin || isEffectivePreview);
    // Its face and shelf change while it is open; a closed or wound-up one keeps them as they are (the node refuses).
    const faceOpen = !['completed', 'disabled', 'suspended', 'pruned'].includes(detail?.status);

    // An action's words, drawn where `feedbackAt` puts them.
    const feedbackAlert = actionFeedback && (
        <div className={`p-4 rounded-xl text-sm font-semibold flex items-center justify-between border ${
            actionFeedback.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                : 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 border-red-300 dark:border-red-800'
        }`}>
            <span>{actionFeedback.message}</span>
            <button
                onClick={() => setActionFeedback(null)}
                className="text-xs opacity-70 hover:opacity-100 font-bold ml-2"
            >
                {t('Dismiss')}
            </button>
        </div>
    );
    // A Manage action can end the reader's Manage (stepping down, a finalised wind-up): its words then top the page they are
    // left on, scrolled back up to them from where the action's button was.
    const manageWordsOnPage = feedbackAt('manage') && !canManage;
    const overlayRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (manageWordsOnPage) overlayRef.current?.scrollTo?.({ top: 0 });
    }, [manageWordsOnPage]);

    return (
        <div ref={overlayRef} className="page-overlay z-[110] overflow-y-auto animate-in slide-in-from-bottom-4 duration-300" data-testid="page-overlay">
            {/* z-[110]: above the mobile app header (App.tsx, zIndex 100). This page carries its own Back bar,
                and at z-50 that bar sat under the header where Back could not be tapped.
                .page-overlay (index.css) is the fixed layer itself: full bleed on a phone, starting past the
                w-64 sidebar on md+ so the sidebar stays clickable, and painting the wallpaper over its own
                opaque ground so the tab content behind it does not show through. */}
            {/* Header */}
            <div className="sticky top-0 bg-nature-100/90 dark:bg-black/90 backdrop-blur-md border-b border-nature-200 dark:border-nature-800 z-10">
                <div className="p-4 flex items-center justify-between gap-2">
                    <button
                        onClick={onBack}
                        className="shrink-0 min-h-[48px] text-nature-600 dark:text-nature-400 font-bold hover:text-nature-900 dark:hover:text-white transition-colors bg-transparent border-none cursor-pointer flex items-center gap-1.5"
                        aria-label={t('Go back')}
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                        {t('Back')}
                    </button>
                    {/* Up to two lines below sm, so a name like "Community Eggs" reads whole at 320px with 1.3x text; a
                        longer one ends in an ellipsis on the second line. Back never shrinks, so it stays on the row. */}
                    <div className="flex-1 min-w-0 font-extrabold text-nature-900 dark:text-white text-base sm:text-lg leading-tight line-clamp-2 break-words sm:line-clamp-none sm:truncate sm:flex-none sm:max-w-md">
                        {name}
                    </div>
                    <div className="hidden sm:block w-12 shrink-0" />
                </div>
                {/* Its keepers' Manage tab (round 3 §3, S8): the controls that were on its page, its face and its Featured shelf. Only
                    for its keepers, and a node admin whose keeper requests they are; nobody else sees a tab. */}
                {canManage && !!detail && (
                    <div role="tablist" aria-label={name} data-testid="enterprise-tabs" className="max-w-2xl mx-auto px-4 pb-3 grid grid-cols-2 gap-2">
                        {(['page', 'manage'] as const).map((which) => (
                            <button
                                key={which}
                                type="button"
                                role="tab"
                                id={`enterprise-tab-${which}`}
                                aria-selected={tab === which}
                                aria-controls={`enterprise-panel-${which}`}
                                onClick={() => setTab(which)}
                                className={`min-h-[44px] px-3 rounded-xl text-sm font-extrabold border transition-colors break-words ${tab === which
                                    ? 'bg-bp-commit-fill text-bp-commit-on border-transparent'
                                    : 'bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 border-nature-300 dark:border-nature-700 hover:bg-nature-50 dark:hover:bg-nature-800'}`}
                            >
                                {which === 'page' ? t('Page', undefined, "a tab: the enterprise's page as members see it") : t('Manage', undefined, "a tab: the keepers' controls")}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6 pb-24" style={{ paddingBottom: 'calc(var(--bottom-nav-offset) + 4rem)' }}>
                {loading ? (
                    <div className="py-20 text-center text-nature-500 font-medium">{t('Loading…')}</div>
                ) : error ? (
                    <div className="p-6 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 text-center">
                        <p className="font-bold mb-2">{t("Couldn't load this group")}</p>
                        <p className="text-sm">{error}</p>
                        <button
                            onClick={() => load()}
                            className="mt-4 px-4 py-2 bg-bp-danger-fill text-bp-danger-on font-bold rounded-xl text-sm"
                        >
                            {t('Retry')}
                        </button>
                    </div>
                ) : !detail && elsewhere ? (
                    <div className="py-20 text-center" data-testid="enterprise-elsewhere">
                        <LocalCommunityLine feature="enterprises" text={t('🏘️ Enterprises live in a local community ›')} {...ways} />
                    </div>
                ) : !detail ? (
                    <div className="py-20 text-center text-nature-500">{t('Group not found.')}</div>
                ) : (
                    <>
                        {isEffectivePreview && (
                            <div className="space-y-3">
                                <LocalCommunityStrip feature="enterprises" {...ways} />
                                <SampleHeader />
                            </div>
                        )}

                        {canManage && tab === 'manage' ? (
                            <div role="tabpanel" id="enterprise-panel-manage" aria-labelledby="enterprise-tab-manage" data-testid="manage-panel" className="space-y-6">
                                {feedbackAt('manage') && feedbackAlert}

                                {/* Pending Keeper Requests (for Lead Keeper / Sole Keeper / Admin) */}
                                {!isEffectivePreview && isLeadOrSoleKeeperOrAdmin && keeperRequests.length > 0 && (
                                    <div className="bg-amber-50/50 dark:bg-amber-950/20 border-2 border-amber-400/40 rounded-2xl p-5 space-y-4 shadow-sm">
                                        <div className="text-xs font-black uppercase tracking-wider text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                                            <span aria-hidden="true">📬</span>
                                            <span>{project
                                                ? t('Asking to join as collaborators ({n})', { n: keeperRequests.length })
                                                : t('Asking to join as keepers ({n})', { n: keeperRequests.length })}</span>
                                        </div>
                                        <div className="space-y-3">
                                            {keeperRequests.map((req) => (
                                                <div
                                                    key={req.id}
                                                    className="bg-white dark:bg-nature-900 border border-amber-200 dark:border-amber-800/60 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                                                >
                                                    <div className="flex items-center gap-2.5">
                                                        <span className="text-base" aria-hidden="true">👤</span>
                                                        <div>
                                                            <div className="text-xs font-bold text-nature-900 dark:text-white">
                                                                {req.callsign || `${req.memberPubkey.slice(0, 8)}…`}
                                                            </div>
                                                            <div className="text-[11px] text-nature-500 dark:text-nature-400">
                                                                <Sentence text={t('Backing pledge: {amount}')} parts={{ amount: <span className="font-bold text-emerald-600 dark:text-emerald-400">{formatNumber(req.pledgedBacking)} 🫘</span> }} />
                                                            </div>
                                                            {applicantBackingText(req.canBackPledge) && (
                                                                <div className={req.canBackPledge === false
                                                                    ? 'text-[11px] font-semibold text-amber-800 dark:text-amber-300'
                                                                    : 'text-[11px] text-nature-500 dark:text-nature-400'}>
                                                                    {applicantBackingText(req.canBackPledge)}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                    {req.pendingChange ? (
                                                        <div className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                                                            {t('Approved. Joins when the objection window ends ({time}).', { time: timeLeftText(req.pendingChange.appliesAt) })}
                                                        </div>
                                                    ) : (
                                                    <div className="flex items-center gap-2 self-end sm:self-auto">
                                                        <button
                                                            type="button"
                                                            disabled={requestProcessingId === req.id}
                                                            onClick={() => handleApproveRequest(req.id)}
                                                            aria-label={project ? t('Approve {name} as a collaborator', { name: req.callsign || `${req.memberPubkey.slice(0, 8)}…` }) : t('Approve {name} as a keeper', { name: req.callsign || `${req.memberPubkey.slice(0, 8)}…` })}
                                                            className="px-3 py-2 rounded-lg bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-xs font-bold shadow-xs transition-colors disabled:opacity-50 min-h-[36px]"
                                                        >
                                                            {requestProcessingId === req.id ? t('Approving…') : t('Approve')}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={requestProcessingId === req.id}
                                                            onClick={() => handleDeclineRequest(req.id)}
                                                            aria-label={project ? t('Decline {name} as a collaborator', { name: req.callsign || `${req.memberPubkey.slice(0, 8)}…` }) : t('Decline {name} as a keeper', { name: req.callsign || `${req.memberPubkey.slice(0, 8)}…` })}
                                                            className="px-3 py-2 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 text-xs font-semibold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors disabled:opacity-50 min-h-[36px]"
                                                        >
                                                            {t('Decline')}
                                                        </button>
                                                    </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Keeper changes waiting out the other keepers' 3-day objection window (answers A, M) */}
                                {!isEffectivePreview && keeperChanges.length > 0 && (
                                    <div className="bg-amber-50/50 dark:bg-amber-950/20 border-2 border-amber-400/40 rounded-2xl p-5 space-y-3 shadow-sm">
                                        <div className="text-xs font-black uppercase tracking-wider text-amber-800 dark:text-amber-300">
                                            {project
                                                ? t('Collaborator changes waiting ({n})', { n: keeperChanges.length })
                                                : t('Keeper changes waiting ({n})', { n: keeperChanges.length })}
                                        </div>
                                        {keeperChanges.map((c) => (
                                            <div key={c.id} className="bg-white dark:bg-nature-900 border border-amber-200 dark:border-amber-800/60 rounded-xl p-3 space-y-2">
                                                <div className="text-xs font-bold text-nature-900 dark:text-white">{keeperChangeTitle(c, kw)}</div>
                                                <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">{keeperChangeBody(c, kw)}</p>
                                                <div className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                                                    <span aria-hidden="true">⏳ </span>{t('Objection window: {time}', { time: timeLeftText(c.appliesAt) })}
                                                </div>
                                                {canObjectToChange(c, myPubkey, keeperList) && (
                                                    <button
                                                        type="button"
                                                        disabled={changeProcessingId === c.id}
                                                        onClick={() => handleObjectToChange(c.id)}
                                                        aria-label={t('Object: {change}', { change: keeperChangeTitle(c, kw) })}
                                                        className="w-full px-3 py-2 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-200 text-xs font-bold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors disabled:opacity-50 min-h-[48px]"
                                                    >
                                                        {changeProcessingId === c.id ? t('Objecting…') : t('Object', undefined, 'button: object to a change')}
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Operator Controls Panel */}
                                {(isKeeperOfThis || isEffectivePreview) && (
                                    <div className="bg-emerald-50/40 dark:bg-emerald-950/20 border-2 border-emerald-500/40 rounded-2xl p-5 space-y-5 shadow-sm">
                                        <div className="flex items-center gap-2">
                                            <span className="text-lg" aria-hidden="true">🛡️</span>
                                            <div className="text-xs font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
                                                {t('Operator Controls')}
                                            </div>
                                        </div>

                                        <div className={`grid ${isEffectivePreview ? 'grid-cols-1' : 'grid-cols-2'} gap-3`}>
                                            {isEffectivePreview ? (
                                                <>
                                                    <LocalCommunityAction feature="enterprises" label={t('Post Offer')} className="w-full" {...ways} />
                                                    <LocalCommunityAction feature="enterprises" label={t('Post Need')} className="w-full" {...ways} />
                                                </>
                                            ) : (
                                                <>
                                                    <button
                                                        type="button"
                                                        disabled={detail.paused || detail.status === 'winding_up' || detail.status === 'completed'}
                                                        onClick={() => {
                                                            setPostModalMode('offer');
                                                            // Its new Offer starts in its shop's category (Marty, 25 Oct 2026); the keeper can change it.
                                                            const shopCategory = shopCategoryOf(detail?.shop);
                                                            if (shopCategory) setPostCategory(shopCategory);
                                                            setPostRepeatable(true);
                                                            setPostError(null);
                                                        }}
                                                        className="py-3 px-4 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-sm shadow-sm transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                                    >
                                                        <span>🏷️</span> {t('Post Offer')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={detail.paused || detail.status === 'winding_up' || detail.status === 'completed'}
                                                        onClick={() => {
                                                            setPostModalMode('need');
                                                            setPostRepeatable(false);
                                                            setPostError(null);
                                                        }}
                                                        className="py-3 px-4 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-sm shadow-sm transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                                    >
                                                        <span>🤝</span> {t('Post Need')}
                                                    </button>
                                                </>
                                            )}
                                            {detail.paused && detail.status !== 'winding_up' && detail.status !== 'completed' && (
                                                <div className="col-span-2 text-center text-xs font-semibold text-amber-800 dark:text-amber-300 bg-amber-100/60 dark:bg-amber-950/40 p-2 rounded-lg">
                                                    {t('Paused for the season — posting new listings is disabled.')}
                                                </div>
                                            )}
                                            {detail.status === 'winding_up' && (
                                                <div className="col-span-2 text-center text-xs font-semibold text-rose-800 dark:text-rose-300 bg-rose-100/60 dark:bg-rose-950/40 p-2 rounded-lg">
                                                    {t('Winding up — posting new listings is disabled.')}
                                                </div>
                                            )}
                                            {detail.status === 'completed' && (
                                                <div className="col-span-2 text-center text-xs font-semibold text-stone-600 dark:text-stone-400 bg-stone-100 dark:bg-stone-800 p-2 rounded-lg">
                                                    {project ? t('Project closed permanently.') : t('Enterprise closed permanently.')}
                                                </div>
                                            )}
                                        </div>

                                        {/* Sweep Surplus */}
                                        {isEffectivePreview ? (
                                            <div className="pt-2">
                                                <LocalCommunityAction feature="enterprises" label={t('To Commons')} className="w-full" {...ways} />
                                            </div>
                                        ) : (
                                            <form onSubmit={handleSweep} className="flex flex-wrap gap-2 items-center pt-2">
                                                {/* Text, not type="number": a number box reads "12,5" by the browser's language, not the member's (#2202). */}
                                                <input
                                                    type="text"
                                                    inputMode="decimal"
                                                    placeholder={t('Sweep surplus…')}
                                                    value={sweepAmount}
                                                    onChange={(e) => setSweepAmount(e.target.value)}
                                                    className="flex-1 min-w-[8rem] bg-white dark:bg-nature-900 border border-nature-300 dark:border-nature-700 rounded-xl px-4 py-2.5 text-sm font-bold text-nature-900 dark:text-white placeholder-nature-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                                />
                                                <button
                                                    type="submit"
                                                    disabled={sweeping || balance <= 0 || !sweepAmount}
                                                    className="py-2.5 px-4 rounded-xl border border-emerald-600 dark:border-emerald-500 bg-white dark:bg-nature-900 text-emerald-700 dark:text-emerald-400 font-extrabold text-sm disabled:opacity-40 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors shrink-0"
                                                >
                                                    {sweeping ? t('Sweeping…') : t('To Commons 🌱')}
                                                </button>
                                            </form>
                                        )}

                                        {/* Map Pin (docs/the-commons.md §2.2) — public, so the picker leads with the warning */}
                                        {!isEffectivePreview && canSetMapPin && (
                                            <div data-testid="enterprise-map-pin-control" className="pt-4 border-t border-emerald-500/20 space-y-3">
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-black uppercase tracking-wider text-emerald-800 dark:text-emerald-400 flex items-center gap-1.5">
                                                            <span>📍</span>
                                                            <span>{t('Map Pin')}</span>
                                                        </div>
                                                        <div className="text-xs text-nature-600 dark:text-nature-400 mt-0.5 break-words">
                                                            {/* Coordinates keep their dot in every language: a comma decimal would run into the comma between them. */}
                                                            {hasMapPin
                                                                ? t('On the map at {lat}, {lng}', { lat: Number(detail.lat).toFixed(3), lng: Number(detail.lng).toFixed(3) })
                                                                : t('Not on the map')}
                                                        </div>
                                                    </div>
                                                    {!showLocationPicker && (
                                                        <button
                                                            type="button"
                                                            onClick={() => setShowLocationPicker(true)}
                                                            className="min-h-[44px] py-2 px-3 rounded-lg border border-emerald-600 dark:border-emerald-500 bg-white dark:bg-nature-900 text-emerald-700 dark:text-emerald-400 font-bold text-xs hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors"
                                                        >
                                                            {hasMapPin ? t('Move or clear map pin') : t('Set map pin')}
                                                        </button>
                                                    )}
                                                </div>
                                                {showLocationPicker && (
                                                    <EnterpriseLocationPicker
                                                        treasury={{ publicKey: pubkey, lat: detail.lat ?? null, lng: detail.lng ?? null }}
                                                        onLocationSaved={(lat, lng) => setDetail((d: any) => (d ? { ...d, lat, lng } : d))}
                                                        onClose={() => setShowLocationPicker(false)}
                                                    />
                                                )}
                                            </div>
                                        )}

                                        {/* Pending Bids on Needs */}
                                        {!isEffectivePreview && pendingBids.length > 0 && (
                                            <div className="pt-4 border-t border-emerald-500/20 space-y-3">
                                                <div className="text-xs font-black uppercase tracking-wider text-emerald-800 dark:text-emerald-400 flex items-center justify-between">
                                                    <span>{t('Pending Bids on Needs')}</span>
                                                    <span className="bg-bp-chip-ok-tint text-bp-chip-ok-ink px-2 py-0.5 rounded-full text-[11px]">
                                                        {pendingBids.length}
                                                    </span>
                                                </div>
                                                <div className="space-y-2">
                                                    {pendingBids.map((b) => (
                                                        <div
                                                            key={b.id}
                                                            className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3.5 space-y-2.5 shadow-sm"
                                                        >
                                                            <div className="flex flex-wrap justify-between items-start gap-x-2 gap-y-0.5">
                                                                <div className="font-bold text-sm text-nature-900 dark:text-white leading-snug">
                                                                    {b.post_title}
                                                                </div>
                                                                <span className="text-emerald-600 dark:text-emerald-400 font-black text-sm shrink-0">
                                                                    {formatNumber(b.credits)} 🫘
                                                                </span>
                                                            </div>
                                                            <div className="text-xs text-nature-500 dark:text-nature-400">
                                                                <Sentence text={t('Bidder: {name}')} parts={{ name: <strong className="text-nature-800 dark:text-nature-200">{b.peer_callsign || t('Member')}</strong> }} />
                                                            </div>
                                                            <div className="flex gap-2 pt-1">
                                                                <button
                                                                    type="button"
                                                                    disabled={actionState?.id === b.id}
                                                                    onClick={() => handleApproveBid(b.id)}
                                                                    className="flex-1 min-h-[44px] py-2 px-3 rounded-lg bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-xs shadow-sm transition-all disabled:opacity-50 flex items-center justify-center"
                                                                >
                                                                    {actionState?.id === b.id && actionState?.type === 'approve' ? t('Approving…') : t('Approve Bid ({amount} 🫘)', { amount: formatNumber(b.credits) })}
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    disabled={actionState?.id === b.id}
                                                                    onClick={() => handleRejectBid(b.id)}
                                                                    aria-label={t('Decline the bid on {title}', { title: b.post_title })}
                                                                    className="min-h-[44px] py-2 px-3 rounded-lg border border-red-300 dark:border-red-800/80 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-300 font-bold text-xs hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50 flex items-center justify-center"
                                                                >
                                                                    {actionState?.id === b.id && actionState?.type === 'reject' ? t('Declining…') : t('Decline')}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Active Deals */}
                                        {!isEffectivePreview && activeDeals.length > 0 && (
                                            <div className="pt-4 border-t border-emerald-500/20 space-y-3">
                                                <div className="text-xs font-black uppercase tracking-wider text-emerald-800 dark:text-emerald-400 flex items-center justify-between">
                                                    <span>{t('Active Deals')}</span>
                                                    <span className="bg-bp-chip-ok-tint text-bp-chip-ok-ink px-2 py-0.5 rounded-full text-[11px]">
                                                        {activeDeals.length}
                                                    </span>
                                                </div>
                                                <div className="space-y-2">
                                                    {activeDeals.map((d) => (
                                                        <div
                                                            key={d.id}
                                                            className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-3.5 space-y-2.5 shadow-sm"
                                                        >
                                                            <div className="flex flex-wrap justify-between items-start gap-x-2 gap-y-0.5">
                                                                <div className="font-bold text-sm text-nature-900 dark:text-white leading-snug">
                                                                    {d.post_title}
                                                                </div>
                                                                <span className="text-emerald-600 dark:text-emerald-400 font-black text-sm shrink-0">
                                                                    {t('{amount} 🫘 in escrow', { amount: formatNumber(d.credits) })}
                                                                </span>
                                                            </div>
                                                            <div className="text-xs text-nature-500 dark:text-nature-400">
                                                                <Sentence
                                                                    text={d.action_required === 'fulfill' ? t('Customer: {name}') : t('Worker: {name}')}
                                                                    parts={{ name: <strong className="text-nature-800 dark:text-nature-200">{d.peer_callsign || t('Member')}</strong> }}
                                                                />
                                                            </div>
                                                            <div className="pt-1">
                                                                {d.action_required === 'fulfill' ? (
                                                                    // A button, so a keyboard reaches it too (it was a clickable div).
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => onNavigatePost?.(d.post_id)}
                                                                        className="w-full min-h-[44px] py-2.5 px-4 rounded-lg border-none bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 font-bold text-xs text-center flex items-center justify-center cursor-pointer hover:bg-nature-200 dark:hover:bg-nature-700 dark:hover:text-nature-200 transition-colors"
                                                                    >
                                                                        {t('Fulfill Deal · Awaiting Customer Release')}
                                                                    </button>
                                                                ) : (
                                                                    <button
                                                                        type="button"
                                                                        disabled={actionState?.id === d.id}
                                                                        onClick={() => handleCompleteDeal(d.id, d.post_title, d.credits, d.price_type, d.hours)}
                                                                        className="w-full min-h-[44px] py-2.5 px-4 rounded-lg bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-extrabold text-xs shadow-sm transition-all disabled:opacity-50 flex items-center justify-center"
                                                                    >
                                                                        {actionState?.id === d.id && actionState?.type === 'complete' ? t('Releasing…') : t('Release Payment ({amount} 🫘)', { amount: formatNumber(d.credits) })}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Enterprise Season & Lifecycle (Keeper Controls) */}
                                        {detail.status !== 'completed' && (
                                            <div className="pt-4 border-t border-emerald-500/20 space-y-3">
                                                <div className="text-xs font-black uppercase tracking-wider text-emerald-800 dark:text-emerald-400 flex items-center gap-1.5">
                                                    <span>🌿</span>
                                                    <span>{t('Season & Lifecycle Controls')}</span>
                                                </div>

                                                {isEffectivePreview ? (
                                                    <div className="grid grid-cols-1 gap-3">
                                                        <LocalCommunityAction feature="enterprises" label={t('Pause for season')} className="w-full" {...ways} />
                                                        <LocalCommunityAction feature="enterprises" label={t('Start wind-up')} className="w-full" {...ways} />
                                                    </div>
                                                ) : (
                                                    <>
                                                        {/* Action Confirmation Cards with Plain Words BEFORE the Tap */}
                                                        {confirmingPause && (
                                                            <div className="p-4 rounded-xl border-2 border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/50 space-y-3">
                                                                <div className="font-bold text-sm text-amber-950 dark:text-amber-100 flex items-center gap-2">
                                                                    <span>❄️</span>
                                                                    <span>{t('Confirm Pause for Season')}</span>
                                                                </div>
                                                                <p className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed font-medium">
                                                                    {project
                                                                        ? (pauseDateFormatted
                                                                            ? tn(heldCredit, 'Pausing for the season holds your credit floor at {n} beans until {date} and pauses active listings so members cannot buy. Any collaborator can resume at any time.', 'Pausing for the season holds your credit floor at {n} beans until {date} and pauses active listings so members cannot buy. Any collaborator can resume at any time.', { date: pauseDateFormatted })
                                                                            : tn(heldCredit, 'Pausing for the season holds your credit floor at {n} beans for up to 90 days and pauses active listings so members cannot buy. Any collaborator can resume at any time.', 'Pausing for the season holds your credit floor at {n} beans for up to 90 days and pauses active listings so members cannot buy. Any collaborator can resume at any time.'))
                                                                        : (pauseDateFormatted
                                                                            ? tn(heldCredit, 'Pausing for the season holds your credit floor at {n} beans until {date} and pauses active listings so members cannot buy. Any keeper can resume at any time.', 'Pausing for the season holds your credit floor at {n} beans until {date} and pauses active listings so members cannot buy. Any keeper can resume at any time.', { date: pauseDateFormatted })
                                                                            : tn(heldCredit, 'Pausing for the season holds your credit floor at {n} beans for up to 90 days and pauses active listings so members cannot buy. Any keeper can resume at any time.', 'Pausing for the season holds your credit floor at {n} beans for up to 90 days and pauses active listings so members cannot buy. Any keeper can resume at any time.'))}
                                                                </p>
                                                                <div className="flex gap-2 pt-1">
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading}
                                                                        onClick={handlePause}
                                                                        className="flex-1 py-2 px-3 rounded-lg bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                                                                    >
                                                                        {lifecycleActionLoading ? t('Pausing…') : t('Confirm Season Pause')}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading}
                                                                        onClick={() => setConfirmingPause(false)}
                                                                        className="py-2 px-3 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 text-xs font-semibold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                                                    >
                                                                        {t('Cancel')}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {confirmingResume && (
                                                            <div className="p-4 rounded-xl border-2 border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/40 space-y-3">
                                                                <div className="font-bold text-sm text-emerald-950 dark:text-emerald-100 flex items-center gap-2">
                                                                    <span>▶️</span>
                                                                    <span>{project ? t('Confirm Resume Project') : t('Confirm Resume Enterprise')}</span>
                                                                </div>
                                                                <p className="text-xs text-emerald-900 dark:text-emerald-200 leading-relaxed font-medium">
                                                                    {t('Resuming reactivates all listings and restores the credit floor to normal daily calculation.')}
                                                                </p>
                                                                <div className="flex gap-2 pt-1">
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading}
                                                                        onClick={handleResume}
                                                                        className="flex-1 py-2 px-3 rounded-lg bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                                                                    >
                                                                        {lifecycleActionLoading ? t('Resuming…') : t('Confirm Resume')}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading}
                                                                        onClick={() => setConfirmingResume(false)}
                                                                        className="py-2 px-3 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 text-xs font-semibold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                                                    >
                                                                        {t('Cancel')}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {confirmingWindUp && (
                                                            <div className="p-4 rounded-xl border-2 border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-950/50 space-y-3">
                                                                <div className="font-bold text-sm text-red-950 dark:text-red-100 flex items-center gap-2">
                                                                    <span>⚠️</span>
                                                                    <span>{project ? t('Start Project Wind-Up') : t('Start Enterprise Wind-Up')}</span>
                                                                </div>
                                                                <p className="text-xs text-red-900 dark:text-red-200 leading-relaxed font-semibold">
                                                                    {project
                                                                        ? tn(keeperCount, 'Winding up returns {amount} beans to the Commons, releases {n} collaborator, and closes {name} for good. Any collaborator can stop this for the next 7 days.', 'Winding up returns {amount} beans to the Commons, releases {n} collaborators, and closes {name} for good. Any collaborator can stop this for the next 7 days.', { amount: formatNumber(Math.max(0, balance), 2), name })
                                                                        : tn(keeperCount, 'Winding up returns {amount} beans to the Commons, releases {n} keeper, and closes {name} for good. Any keeper can stop this for the next 7 days.', 'Winding up returns {amount} beans to the Commons, releases {n} keepers, and closes {name} for good. Any keeper can stop this for the next 7 days.', { amount: formatNumber(Math.max(0, balance), 2), name })}
                                                                </p>
                                                                {balance < 0 && (
                                                                    <p className="text-xs text-amber-700 dark:text-amber-400 font-bold">
                                                                        <span aria-hidden="true">⚠️ </span>
                                                                        {project
                                                                            ? t('Cannot wind up a project in deficit ({amount} 🫘). Debt must be resolved or written off first.', { amount: formatNumber(balance) })
                                                                            : t('Cannot wind up an enterprise in deficit ({amount} 🫘). Debt must be resolved or written off first.', { amount: formatNumber(balance) })}
                                                                    </p>
                                                                )}
                                                                <div className="flex gap-2 pt-1">
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading || balance < 0}
                                                                        onClick={handleInitiateWindUp}
                                                                        className="flex-1 py-2 px-3 rounded-lg bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                                                                    >
                                                                        {lifecycleActionLoading ? t('Starting Wind-Up…') : t('Confirm Start Wind-Up')}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading}
                                                                        onClick={() => setConfirmingWindUp(false)}
                                                                        className="py-2 px-3 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 text-xs font-semibold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                                                    >
                                                                        {t('Cancel')}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {confirmingCancelWindUp && (
                                                            <div className="p-4 rounded-xl border-2 border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/40 space-y-3">
                                                                <div className="font-bold text-sm text-emerald-950 dark:text-emerald-100 flex items-center gap-2">
                                                                    <span>🛑</span>
                                                                    <span>{project ? t('Stop Project Wind-Up') : t('Stop Enterprise Wind-Up')}</span>
                                                                </div>
                                                                <p className="text-xs text-emerald-900 dark:text-emerald-200 leading-relaxed font-medium">
                                                                    {project
                                                                        ? t('Cancelling wind-up restores {name} to active status immediately. Collaborators remain appointed and listings can resume.', { name })
                                                                        : t('Cancelling wind-up restores {name} to active status immediately. Keepers remain appointed and listings can resume.', { name })}
                                                                </p>
                                                                <div className="flex gap-2 pt-1">
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading}
                                                                        onClick={handleCancelWindUp}
                                                                        className="flex-1 py-2 px-3 rounded-lg bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                                                                    >
                                                                        {lifecycleActionLoading ? t('Stopping Wind-Up…') : t('Confirm Stop Wind-Up')}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading}
                                                                        onClick={() => setConfirmingCancelWindUp(false)}
                                                                        className="py-2 px-3 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 text-xs font-semibold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                                                    >
                                                                        {t('Keep Winding Up')}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {confirmingFinaliseWindUp && (
                                                            <div className="p-4 rounded-xl border-2 border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-950/50 space-y-3">
                                                                <div className="font-bold text-sm text-red-950 dark:text-red-100 flex items-center gap-2">
                                                                    <span>🏁</span>
                                                                    <span>{project ? t('Finalise Project Wind-Up') : t('Finalise Enterprise Wind-Up')}</span>
                                                                </div>
                                                                <p className="text-xs text-red-900 dark:text-red-200 leading-relaxed font-semibold">
                                                                    {/* {n} is the amount, to the cent as before ("12.50"); the count only picks the form. */}
                                                                    {project
                                                                        ? tn(Math.max(0, balance), 'The 7-day grace period has elapsed. Finalising sweeps {n} beans to the Commons, releases all collaborators, and closes {name} for good.', 'The 7-day grace period has elapsed. Finalising sweeps {n} beans to the Commons, releases all collaborators, and closes {name} for good.', { n: formatNumber(Math.max(0, balance), 2), name })
                                                                        : tn(Math.max(0, balance), 'The 7-day grace period has elapsed. Finalising sweeps {n} beans to the Commons, releases all keepers, and closes {name} for good.', 'The 7-day grace period has elapsed. Finalising sweeps {n} beans to the Commons, releases all keepers, and closes {name} for good.', { n: formatNumber(Math.max(0, balance), 2), name })}
                                                                </p>
                                                                <div className="flex gap-2 pt-1">
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading}
                                                                        onClick={handleFinaliseWindUp}
                                                                        className="flex-1 py-2 px-3 rounded-lg bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                                                                    >
                                                                        {lifecycleActionLoading ? t('Finalising…') : t('Finalise Wind-Up')}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={lifecycleActionLoading}
                                                                        onClick={() => setConfirmingFinaliseWindUp(false)}
                                                                        className="py-2 px-3 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 text-xs font-semibold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                                                    >
                                                                        {t('Cancel')}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {/* Buttons (when not confirming) */}
                                                        {!confirmingPause && !confirmingResume && !confirmingWindUp && !confirmingCancelWindUp && !confirmingFinaliseWindUp && (
                                                            <div className="grid grid-cols-2 gap-3">
                                                                {detail.status !== 'winding_up' && (
                                                                    detail.paused ? (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => setConfirmingResume(true)}
                                                                            className="py-2.5 px-3 rounded-xl border border-emerald-600 dark:border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 font-bold text-xs shadow-xs hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors flex items-center justify-center gap-1.5"
                                                                        >
                                                                            <span>▶️</span> {project ? t('Resume Project') : t('Resume Enterprise')}
                                                                        </button>
                                                                    ) : (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => setConfirmingPause(true)}
                                                                            className="py-2.5 px-3 rounded-xl border border-amber-500 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 font-bold text-xs shadow-xs hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors flex items-center justify-center gap-1.5"
                                                                        >
                                                                            <span>❄️</span> {t('Pause for Season')}
                                                                        </button>
                                                                    )
                                                                )}

                                                                {detail.status === 'winding_up' ? (
                                                                    <>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => setConfirmingCancelWindUp(true)}
                                                                            className="py-2.5 px-3 rounded-xl border border-emerald-600 dark:border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 font-bold text-xs shadow-xs hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors flex items-center justify-center gap-1.5"
                                                                        >
                                                                            <span>🛑</span> {t('Stop Wind-Up')}
                                                                        </button>
                                                                        {windUpGraceEnded && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => setConfirmingFinaliseWindUp(true)}
                                                                                className="py-2.5 px-3 rounded-xl border border-bp-danger-fill bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on font-bold text-xs shadow-xs transition-colors flex items-center justify-center gap-1.5"
                                                                            >
                                                                                <span>🏁</span> {t('Finalise Wind-Up')}
                                                                            </button>
                                                                        )}
                                                                    </>
                                                                ) : (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setConfirmingWindUp(true)}
                                                                        className="py-2.5 px-3 rounded-xl border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 font-bold text-xs shadow-xs hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors flex items-center justify-center gap-1.5"
                                                                    >
                                                                        <span>⚠️</span> {t('Start Wind-Up')}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        )}

                                        {!isEffectivePreview && detail?.lifecycle === 'bounded' && detail?.status !== 'funded' && (
                                            <div className="pt-4 border-t border-emerald-500/20">
                                                <button
                                                    type="button"
                                                    onClick={handleCancelInitiative}
                                                    disabled={cancelling}
                                                    className="w-full py-2.5 px-4 rounded-xl border border-red-300 dark:border-red-800/80 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 font-bold text-xs hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
                                                >
                                                    <span aria-hidden="true">🛑</span>
                                                    {cancelling ? t('Cancelling & Refunding Backers…') : t('Cancel Initiative & Refund Escrow')}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* The keepers' votes (DESIGN-group-decisions S2): drawn only for those the node answers */}
                                {!isEffectivePreview && isKeeperOfThis && (
                                    <EnterpriseDecisions treasuryKey={pubkey} myPubkey={myPubkey} keepers={keeperList} balance={balance}
                                        earnedSurplus={typeof detail?.earnedSurplus === 'number' ? detail.earnedSurplus : null} lifecycle={detail?.lifecycle} />
                                )}

                                {/* Lead Succession Panel (when lead has no activity for 30+ days) */}
                                {!isEffectivePreview && Boolean(leadInactivity?.isEligible ?? (leadInactivity as any)?.isEligibleForSuccession) && (
                                    <div className="bg-amber-50/60 dark:bg-amber-950/30 border-2 border-amber-500/50 rounded-2xl p-5 space-y-4 shadow-sm">
                                        <div className="flex items-start gap-2.5">
                                            <span className="text-xl" aria-hidden="true">⚠️</span>
                                            <div>
                                                <div className="text-xs font-black uppercase tracking-wider text-amber-800 dark:text-amber-300">
                                                    {successionHeading(leadInactivity, kw)}
                                                </div>
                                                <p className="text-xs text-amber-900 dark:text-amber-200 mt-1 leading-relaxed">
                                                    {successionExplainer(leadInactivity, kw)}
                                                </p>
                                            </div>
                                        </div>

                                        {activeProposal ? (
                                            <div className="bg-white dark:bg-nature-900 border border-amber-300 dark:border-amber-800 rounded-xl p-4 space-y-3">
                                                <div className="text-xs font-bold text-nature-900 dark:text-white">
                                                    <Sentence
                                                        text={project
                                                            ? t('Active Succession Proposal: Move the leader role to {name}')
                                                            : t('Active Succession Proposal: Move the lead keeper role to {name}')}
                                                        parts={{ name: <span className="text-emerald-700 dark:text-emerald-400 font-extrabold">{activeProposal.candidateCallsign}</span> }}
                                                    />
                                                </div>
                                                <div className="text-xs text-nature-600 dark:text-nature-400">
                                                    {successionTallyText(activeProposal, kw)}
                                                </div>
                                                {successionDeadlineText(activeProposal) && (
                                                    <div className="text-xs text-nature-600 dark:text-nature-400">
                                                        <span aria-hidden="true">⏳ </span>{successionDeadlineText(activeProposal)}
                                                    </div>
                                                )}
                                                {isEligibleSuccessor && (
                                                    <div>
                                                        {myChoice(activeProposal, myPubkey) ? (
                                                            <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-200 dark:border-emerald-800">
                                                                <span aria-hidden="true">✓</span>
                                                                <span>{myChoice(activeProposal, myPubkey) === 'no' ? t('You voted no. Votes cannot be changed.') : t('You voted yes. Votes cannot be changed.')}</span>
                                                            </div>
                                                        ) : (
                                                            <div className="flex gap-2">
                                                                <button
                                                                    type="button"
                                                                    disabled={submittingSuccession}
                                                                    onClick={() => handleVoteSuccession(activeProposal.id, 'yes')}
                                                                    aria-label={project
                                                                        ? t('Yes, make {name} leader', { name: activeProposal.candidateCallsign ?? '' })
                                                                        : t('Yes, make {name} lead keeper', { name: activeProposal.candidateCallsign ?? '' })}
                                                                    className="flex-1 py-2.5 px-4 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-xs shadow-sm transition-all disabled:opacity-50 min-h-[48px]"
                                                                >
                                                                    {submittingSuccession ? t('Registering…') : t('Yes')}
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    disabled={submittingSuccession}
                                                                    onClick={() => handleVoteSuccession(activeProposal.id, 'no')}
                                                                    aria-label={project
                                                                        ? t('No, do not make {name} leader', { name: activeProposal.candidateCallsign ?? '' })
                                                                        : t('No, do not make {name} lead keeper', { name: activeProposal.candidateCallsign ?? '' })}
                                                                    className="flex-1 py-2.5 px-4 rounded-xl border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-200 font-bold text-xs transition-all disabled:opacity-50 min-h-[48px]"
                                                                >
                                                                    {t('No')}
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ) : isEligibleSuccessor ? (
                                            <form onSubmit={handleProposeSuccession} className="bg-white dark:bg-nature-900 border border-amber-300 dark:border-amber-800 rounded-xl p-4 space-y-3">
                                                <div className="text-xs font-bold text-nature-800 dark:text-nature-200">
                                                    {project ? t('Propose an Active Collaborator as Leader') : t('Propose an Active Keeper as Lead')}
                                                </div>
                                                <div className="flex flex-col sm:flex-row gap-2">
                                                    <select
                                                        aria-label={project ? t('Propose an Active Collaborator as Leader') : t('Propose an Active Keeper as Lead')}
                                                        value={selectedSuccessionCandidate}
                                                        onChange={(e) => setSelectedSuccessionCandidate(e.target.value)}
                                                        className="flex-1 bg-nature-50 dark:bg-nature-800 border border-nature-300 dark:border-nature-700 rounded-xl px-3 py-2 text-xs font-semibold text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500 min-h-[44px]"
                                                    >
                                                        <option value="">{project ? t('Select an active collaborator…') : t('Select an active keeper…')}</option>
                                                        {keepers
                                                            .filter((k: any) => !k.suspended && (k.publicKey || k.pubkey || k.memberPubkey) !== leadInactivity.leadPubkey)
                                                            .map((k: any) => {
                                                                const pk = k.publicKey || k.pubkey || k.memberPubkey;
                                                                return (
                                                                    <option key={pk} value={pk}>
                                                                        {pk === identity?.publicKey ? t('{name} (yourself)', { name: k.callsign }) : k.callsign}
                                                                    </option>
                                                                );
                                                            })}
                                                    </select>
                                                    <button
                                                        type="submit"
                                                        disabled={submittingSuccession || !selectedSuccessionCandidate}
                                                        className="py-2 px-4 rounded-xl bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on font-bold text-xs shadow-sm transition-all disabled:opacity-50 shrink-0 min-h-[44px]"
                                                    >
                                                        {submittingSuccession ? t('Proposing…') : project ? t('Propose Leader') : t('Propose Lead')}
                                                    </button>
                                                </div>
                                            </form>
                                        ) : null}
                                    </div>
                                )}

                                {/* Remove a keeper, step down: the keepers card's own buttons, here with its keepers' names. */}
                                {!isEffectivePreview && (removableKeepers.length > 0 || canStepDown(myPubkey, keeperList)) && (
                                    <section aria-labelledby="manage-keepers-heading" className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-3">
                                        <h2 id="manage-keepers-heading" className="m-0 text-base font-extrabold text-nature-900 dark:text-white">
                                            {project ? t('Collaborators ({n})', { n: keepers.length }) : t('Keepers ({n})', { n: keepers.length })}
                                        </h2>
                                            {(
                                                <div className="flex flex-col gap-2 pt-1">
                                                    {removableKeepers.map((k) => (
                                                        <button
                                                            key={`rm-${k.publicKey}`}
                                                            type="button"
                                                            disabled={changeProcessingId === k.publicKey}
                                                            onClick={() => handleRemoveKeeper(k)}
                                                            className="w-full px-3 py-2 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 text-xs font-bold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors disabled:opacity-50 min-h-[48px]"
                                                        >
                                                            {t('Remove {name}', { name: k.callsign })}
                                                        </button>
                                                    ))}
                                                    {canStepDown(myPubkey, keeperList) && (
                                                        <button
                                                            type="button"
                                                            disabled={steppingDown}
                                                            onClick={handleStepDown}
                                                            className="w-full px-3 py-2 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 text-xs font-bold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors disabled:opacity-50 min-h-[48px]"
                                                        >
                                                            {steppingDown ? t('Stepping down…') : project ? t('Step down as a collaborator') : t('Step down as a keeper')}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                    </section>
                                )}

                                {/* The discussion's messages a keeper may remove (each then shows as removed by a keeper). */}
                                {!isEffectivePreview && isKeeperOfThis && threadMessages.some((m) => m.type !== 'removed') && (
                                    <section data-testid="manage-thread" aria-labelledby="manage-thread-heading" className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-3">
                                        <div>
                                            <h2 id="manage-thread-heading" className="m-0 text-base font-extrabold text-nature-900 dark:text-white">
                                                {project ? t('Project Discussion') : t('Enterprise Discussion')}
                                            </h2>
                                            <p className="m-0 mt-1 text-sm text-nature-600 dark:text-nature-300">
                                                {t('A message you remove shows as "{removed}".', { removed: removedLine(project) })}
                                            </p>
                                        </div>
                                        {threadError && <p role="alert" className="m-0 text-sm font-medium text-bp-ink-danger">{threadError}</p>}
                                        <ul className="m-0 p-0 list-none divide-y divide-nature-100 dark:divide-nature-800">
                                            {threadMessages.filter((m) => m.type !== 'removed').map((m) => {
                                                const authorName = m.authorCallsign || (m.authorPubkey ? m.authorPubkey.slice(0, 8) : t('Member'));
                                                return (
                                                    <li key={m.id} className="py-2 flex items-start gap-3">
                                                        <div className="min-w-0 flex-1 text-sm">
                                                            <span className="font-bold text-nature-900 dark:text-white">{authorName}</span>
                                                            <span className="ml-1.5 text-xs text-nature-500 dark:text-nature-400">{formatTimestamp(m.timestamp)}</span>
                                                            <p className="m-0 mt-0.5 text-nature-800 dark:text-nature-200 line-clamp-2 break-words">{decodeThreadText(m.ciphertext, m.type, m.metadata, project)}</p>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleRemoveThreadMessage(m.id)}
                                                            disabled={threadRemovingId === m.id}
                                                            aria-label={t('Remove message from {name}', { name: authorName })}
                                                            title={t('Remove message')}
                                                            className="shrink-0 min-h-[44px] px-3 rounded-lg border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-sm font-bold text-bp-ink-danger hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors disabled:opacity-50"
                                                        >
                                                            {threadRemovingId === m.id ? t('Removing...') : t('Remove')}
                                                        </button>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </section>
                                )}

                                {/* Its face and its Featured shelf (round 3 §3, §4): never in a preview, nor once it has closed (the node refuses both). */}
                                {!isEffectivePreview && faceOpen && (
                                    <EnterpriseFace treasury={pubkey} detail={detail} project={project} lead={isLeadOrSoleKeeperOrAdmin} shopEditable={isKeeperOfThis} onSaved={() => load(true)} />
                                )}
                                {!isEffectivePreview && faceOpen && isKeeperOfThis && (
                                    <EnterpriseFeatured treasury={pubkey} shopId={typeof detail?.shop?.id === 'string' ? detail.shop.id : null} listings={ownListings}
                                        onShopOpened={() => load(true)} onReadAgain={readListings} onFeatured={featuredHere} />
                                )}
                            </div>
                        ) : (
                            <div {...(canManage ? { role: 'tabpanel', id: 'enterprise-panel-page', 'aria-labelledby': 'enterprise-tab-page' } : {})} className="space-y-6">
                                {manageWordsOnPage && feedbackAlert}

                                {/* The shopfront (DESIGN-shops-round3-enterprise-shopfront-fable.md §3, S8; the phone's S5 order): its banner (its
                                    shop's photo, or a quiet block in its category's emoji), its logo (its avatar), its name, its category and since when, and
                                    what kind of group it is. */}
                                <ShopfrontHeader
                                    name={name}
                                    logoUrl={detail?.avatar}
                                    bannerUrl={shopPhotoOf(detail?.shop)}
                                    category={shopCategoryOf(detail?.shop)}
                                    fallbackEmoji={detail?.lifecycle === 'bounded' ? '🌱' : '🏛️'}
                                    lines={[categorySinceLine(shopCategoryOf(detail?.shop), sinceLine(detail?.since)), groupKindLine(detail?.lifecycle)]}
                                />

                                {/* State banners everyone can see */}
                                {detail.paused && detail.status !== 'winding_up' && detail.status !== 'completed' && (
                                    <div
                                        role="alert"
                                        aria-live="polite"
                                        className="p-5 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border-2 border-amber-400 dark:border-amber-600 text-amber-950 dark:text-amber-100 shadow-sm space-y-2.5"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-xl" aria-hidden="true">❄️</span>
                                            <span className="text-xs font-black uppercase tracking-wider text-amber-800 dark:text-amber-300">
                                                {t('Paused for the season')}
                                            </span>
                                        </div>
                                        <p className="text-sm sm:text-base font-bold text-amber-900 dark:text-amber-100 leading-snug">
                                            {pauseDateFormatted
                                                ? tn(heldCredit, 'Paused for the season. Credit held at {n} beans until {date}.', 'Paused for the season. Credit held at {n} beans until {date}.', { date: pauseDateFormatted })
                                                : tn(heldCredit, 'Paused for the season. Credit held at {n} beans.', 'Paused for the season. Credit held at {n} beans.')}
                                        </p>
                                        <p className="text-xs text-amber-800 dark:text-amber-300">
                                            {t('Listings are paused and cannot be bought right now.')}
                                        </p>
                                        {(detail.pauseWarning || (detail.pauseDaysRemaining !== null && detail.pauseDaysRemaining !== undefined && detail.pauseDaysRemaining <= 14)) && (
                                            <div className="pt-2 border-t border-amber-300/60 dark:border-amber-700/60 text-xs font-bold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                                                <span aria-hidden="true">⚠️</span>
                                                {/* The node's own warning is shown as it sent it (slice S4). */}
                                                <span>{detail.pauseWarning || (detail.pauseDaysRemaining === 0
                                                    ? t('Pause credit floor snapshot has expired')
                                                    : tn(detail.pauseDaysRemaining, 'Pause credit floor snapshot expires in {n} day', 'Pause credit floor snapshot expires in {n} days'))}</span>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {detail.status === 'winding_up' && (
                                    <div
                                        role="alert"
                                        aria-live="polite"
                                        className="p-5 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border-2 border-rose-400 dark:border-rose-600 text-rose-950 dark:text-rose-100 shadow-sm space-y-2.5"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-xl" aria-hidden="true">⏳</span>
                                            <span className="text-xs font-black uppercase tracking-wider text-rose-800 dark:text-rose-300">
                                                {t('Winding Up')}
                                            </span>
                                        </div>
                                        <p className="text-sm sm:text-base font-bold text-rose-900 dark:text-rose-100 leading-snug">
                                            {windingUpLine}
                                        </p>
                                        <p className="text-xs text-rose-800 dark:text-rose-300 leading-relaxed font-medium">
                                            {project
                                                ? t('This project is winding down. Listings are inactive and cannot be bought. Any collaborator can stop this during the 7-day grace period.')
                                                : t('This enterprise is winding down. Listings are inactive and cannot be bought. Any keeper can stop this during the 7-day grace period.')}
                                        </p>
                                        {windUpGraceEnded && (
                                            <p className="text-xs font-bold text-rose-700 dark:text-rose-400 pt-1">
                                                {t('The 7-day grace period has elapsed. Ready to be finalised.')}
                                            </p>
                                        )}
                                    </div>
                                )}

                                {detail.status === 'completed' && (
                                    <div
                                        role="alert"
                                        aria-live="polite"
                                        className="p-5 rounded-2xl bg-stone-100 dark:bg-stone-900 border-2 border-stone-300 dark:border-stone-700 text-stone-900 dark:text-stone-100 shadow-sm space-y-2.5"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-xl" aria-hidden="true">🏁</span>
                                            <span className="text-xs font-black uppercase tracking-wider text-stone-600 dark:text-stone-400">
                                                {t('Completed', undefined, 'enterprise state')}
                                            </span>
                                        </div>
                                        <p className="text-sm sm:text-base font-bold leading-snug">
                                            {t('Completed · Wound up')}
                                        </p>
                                        <p className="text-xs text-stone-600 dark:text-stone-400 leading-relaxed font-medium">
                                            {project
                                                ? t('This project has completed its purpose and wound up permanently. Surplus was returned to the Commons, collaborators were released, and listings are closed.')
                                                : t('This enterprise has completed its purpose and wound up permanently. Surplus was returned to the Commons, keepers were released, and listings are closed.')}
                                        </p>
                                    </div>
                                )}
                                {/* What it is for, the Commons' statement of it (docs/the-commons.md §2.1) */}
                                {!!detail?.purpose && <ShopfrontText title={t('What it is for')} text={detail.purpose} lines={3} testID="shopfront-purpose" />}

                                {/* Who keeps it, each with their badges: recognition, which gates nothing (round 3 §0 row 6). Not a button in a preview
                                    (Example Valley's keepers have no profile here, review of #2063, B3). */}
                                <ShopfrontKeepers keepers={shopfrontKeepers} project={project} onOpen={!isEffectivePreview && onOpenProfile ? onOpenProfile : undefined} />

                                {/* Funding Progress (for Bounded Enterprises with a goal) */}
                                {detail.goalAmount != null && detail.goalAmount > 0 && (() => {
                                    const current = detail.currentAmount != null ? detail.currentAmount : Math.max(0, balance);
                                    const goal = detail.goalAmount;
                                    const progress = Math.min(100, (current / goal) * 100);
                                    const isFunded = current >= goal || detail.status === 'funded' || detail.status === 'completed';
                                    const daysRemaining = getDaysRemaining(detail.deadlineAt);
                                    // The node takes a pledge only while the enterprise is active: otherwise a sentence, not a box.
                                    const pledgesClosed = pledgeClosedLine(detail.status, detail.lifecycle);

                                    return (
                                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-6 shadow-sm space-y-4">
                                            <div className="flex justify-between items-end">
                                                <div>
                                                    <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                                                        {t('Funding Progress')}
                                                    </div>
                                                    <div className={`text-2xl font-black mt-1 ${isFunded ? 'text-emerald-600 dark:text-emerald-400' : 'text-nature-900 dark:text-white'}`}>
                                                        <Sentence
                                                            text={t('{amount} 🫘 {raised}')}
                                                            parts={{
                                                                amount: formatNumber(current),
                                                                raised: <span className="text-xs font-semibold text-nature-500 dark:text-nature-400">{t('raised of {goal} 🫘 goal', { goal: formatNumber(goal) })}</span>,
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                                {daysRemaining && (
                                                    <span className={`text-xs font-bold px-2.5 py-1 rounded-lg ${
                                                        daysRemaining.expired
                                                            ? 'bg-bp-chip-danger-tint text-bp-chip-danger-ink'
                                                            : 'bg-bp-chip-ok-tint text-bp-chip-ok-ink'
                                                    }`}>
                                                        ⏳ {daysRemaining.text}
                                                    </span>
                                                )}
                                            </div>

                                            <div className="w-full bg-nature-100 dark:bg-nature-800 h-2.5 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full transition-all ${isFunded ? 'bg-emerald-500' : 'bg-emerald-600'}`}
                                                    style={{ width: `${progress}%` }}
                                                />
                                            </div>

                                            <p className="text-xs text-nature-500 dark:text-nature-400 leading-relaxed">
                                                {isFunded
                                                    ? (project
                                                        ? t("🎉 This project reached its funding goal! Pledged funds are held securely in the project's account.")
                                                        : t("🎉 This enterprise reached its funding goal! Pledged funds are held securely in the enterprise's account."))
                                                    : (project
                                                        ? t("🔒 Pledges are held securely in the project's account, spendable only on transparent offers and needs that the whole community can see.")
                                                        : t("🔒 Pledges are held securely in the enterprise's account, spendable only on transparent offers and needs that the whole community can see."))}
                                            </p>

                                            {/* Inline Pledge Form — pledging moves the member's own beans */}
                                            {isEffectivePreview ? (
                                                <div className="pt-2 border-t border-nature-100 dark:border-nature-800 space-y-3">
                                                    <div className="text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-300">
                                                        {t('Back this initiative')}
                                                    </div>
                                                    <LocalCommunityAction feature="enterprises" label={t('Pledge')} className="w-full" {...ways} />
                                                </div>
                                            ) : (
                                                <>
                                                    {viewerIsMember && pledgesClosed && (
                                                    <p data-testid="pledges-closed" className="pt-3 border-t border-nature-100 dark:border-nature-800 text-sm font-semibold text-nature-700 dark:text-nature-300 leading-relaxed">
                                                        {pledgesClosed}
                                                    </p>
                                                    )}
                                                    {viewerIsMember && !pledgesClosed && (
                                                    <form onSubmit={handlePledge} className="pt-2 border-t border-nature-100 dark:border-nature-800 space-y-3">
                                                        <div className="text-xs font-bold uppercase tracking-wider text-nature-600 dark:text-nature-300">
                                                            {t('Back this initiative')}
                                                        </div>
                                                        {/* Wraps: at 320px with 1.3x text the three in one row ran 327px past the screen's edge. */}
                                                        <div className="flex flex-wrap gap-2">
                                                            {/* Text, not type="number": a number box reads "12,5" by the browser's language, not the member's (#2202). */}
                                                            <input
                                                                type="text"
                                                                inputMode="decimal"
                                                                placeholder={t('Amount (🫘)')}
                                                                value={pledgeAmount}
                                                                onChange={(e) => setPledgeAmount(e.target.value)}
                                                                className="w-32 sm:w-36 min-w-[7.5rem] bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm font-bold text-nature-900 dark:text-white placeholder-nature-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                                            />
                                                            <input
                                                                type="text"
                                                                placeholder={t('Memo (optional)')}
                                                                value={pledgeMemo}
                                                                onChange={(e) => setPledgeMemo(e.target.value)}
                                                                className="flex-1 min-w-[8rem] bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white placeholder-nature-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                                            />
                                                            <button
                                                                type="submit"
                                                                disabled={pledging || !pledgeAmount}
                                                                className="py-2 px-4 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-sm shadow-sm transition-all disabled:opacity-40 whitespace-nowrap"
                                                            >
                                                                {pledging ? t('Pledging…') : t('Pledge Beans 🌱')}
                                                            </button>
                                                        </div>
                                                    </form>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    );
                                })()}

                                {feedbackAt('pledge') && feedbackAlert}


                                {/* About, in its keepers' words (members.bio, round 3 §0 row 5) */}
                                {!!detail?.about && <ShopfrontText title={t('About', undefined, "an enterprise's own words about itself")} text={detail.about} testID="shopfront-about" />}

                                {/* What it offers: Featured, what its keepers do together, its sections. A member's (round 3 §5): a visitor's page ends at How we deal. */}
                                {memberView && (
                                    <>
                                        <ShopfrontFeatured listings={featuredOf(shopListings)} showsBeans onOpen={openListing} />
                                        <ShopfrontTogether categories={Array.isArray(detail?.offerCategories) ? detail.offerCategories : []} />
                                        <ShopfrontSections sections={shopSectionsOf(shopListings)} showsBeans empty={t('No live listings yet.')} note={listingNote} onOpen={openListing} />
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
                                {!isEffectivePreview && viewerIsMember && !!onMessage && leadKeeper && leadKeeper.publicKey !== myPubkey && (
                                    <ShopfrontMessage label={messageLabel(leadKeeper.callsign, project ? 'project' : 'enterprise')} onClick={() => onMessage(leadKeeper.publicKey)} />
                                )}

                                {feedbackAt('join') && feedbackAlert}

                                {/* Ask to Join as a Keeper (for non-keepers when enterprise is not completed) */}
                                {isEffectivePreview ? (
                                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-4">
                                        <div>
                                            <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 flex items-center gap-1.5">
                                                <span aria-hidden="true">🤝</span>
                                                <span>{project ? t('Ask to join as a collaborator') : t('Ask to join as a keeper')}</span>
                                            </div>
                                            <p className="text-xs text-nature-600 dark:text-nature-400 mt-1 leading-relaxed">
                                                {project
                                                    ? t('Help run this project. You can back it with your earned trading standing to expand its credit floor.')
                                                    : t('Help run this enterprise. You can back it with your earned trading standing to expand its credit floor.')}
                                            </p>
                                        </div>
                                        <LocalCommunityAction feature="enterprises" label={project ? t('Join as collaborator') : t('Join as keeper')} className="w-full" {...ways} />
                                    </div>
                                ) : viewerIsMember && !isKeeperOfThis && detail.status !== 'completed' && (
                                    myPendingRequest ? (
                                        <div className="bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800 rounded-2xl p-5 space-y-2">
                                            <div className="text-xs font-bold uppercase tracking-wider text-sky-800 dark:text-sky-300 flex items-center gap-2">
                                                <span aria-hidden="true">⏳</span>
                                                <span>{t('Your request to join is waiting')}</span>
                                            </div>
                                            <p className="text-xs text-sky-900 dark:text-sky-200 leading-relaxed">
                                                {myPendingRequest.pendingChange ? approvedApplicantText(myPendingRequest.pendingChange.appliesAt, undefined, kw) : (
                                                    <Sentence
                                                        text={project
                                                            ? t('You asked to join this project with {amount} of backing standing. Waiting for the leader.')
                                                            : t('You asked to join this enterprise with {amount} of backing standing. Waiting for the lead keeper.')}
                                                        parts={{ amount: <strong className="font-bold text-emerald-700 dark:text-emerald-300">{formatNumber(myPendingRequest.pledgedBacking)} 🫘</strong> }}
                                                    />
                                                )}
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-4">
                                            <div>
                                                <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 flex items-center gap-1.5">
                                                    <span aria-hidden="true">🤝</span>
                                                    <span>{project ? t('Ask to join as a collaborator') : t('Ask to join as a keeper')}</span>
                                                </div>
                                                <p className="text-xs text-nature-600 dark:text-nature-400 mt-1 leading-relaxed">
                                                    {project
                                                        ? t('Help run this project. You can back it with your earned trading standing to expand its credit floor.')
                                                        : t('Help run this enterprise. You can back it with your earned trading standing to expand its credit floor.')}
                                                </p>
                                            </div>

                                            <form onSubmit={handleJoinRequest} className="space-y-4">
                                                <div className="space-y-2">
                                                    <label htmlFor="join-backing-input" className="block text-xs font-bold text-nature-800 dark:text-nature-200">
                                                        {project
                                                            ? t('Back this project with your standing: 0 … {n}', { n: availableToBack })
                                                            : t('Back this enterprise with your standing: 0 … {n}', { n: availableToBack })}
                                                    </label>
                                                    <div className="flex items-center gap-3">
                                                        <input
                                                            id="join-backing-input"
                                                            type="number"
                                                            min={0}
                                                            max={availableToBack}
                                                            step={1}
                                                            value={joinBackingPledge}
                                                            onChange={(e) => {
                                                                const raw = Math.floor(Number(e.target.value) || 0);
                                                                const val = Math.max(0, Math.min(availableToBack, raw));
                                                                setJoinBackingPledge(val);
                                                            }}
                                                            className="w-24 bg-nature-50 dark:bg-nature-800 border border-nature-300 dark:border-nature-700 rounded-xl px-3 py-2 text-sm font-bold text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                                        />
                                                        <input
                                                            type="range"
                                                            aria-label={project
                                                                ? t('Back this project with your standing: 0 to {n}', { n: availableToBack })
                                                                : t('Back this enterprise with your standing: 0 to {n}', { n: availableToBack })}
                                                            min={0}
                                                            max={availableToBack}
                                                            step={1}
                                                            value={joinBackingPledge}
                                                            onChange={(e) => setJoinBackingPledge(Number(e.target.value))}
                                                            disabled={availableToBack === 0}
                                                            className="flex-1 accent-emerald-600 disabled:opacity-40"
                                                        />
                                                        <span className="text-xs font-extrabold text-nature-700 dark:text-nature-300 w-16 text-right">
                                                            {formatNumber(joinBackingPledge)} 🫘
                                                        </span>
                                                    </div>
                                                    <p className="text-[11px] text-nature-500 dark:text-nature-400">
                                                        {project
                                                            ? t('A pledge of 0 is valid: someone who helps run it without pledging standing can still be a collaborator.')
                                                            : t('A pledge of 0 is valid: someone who helps run it without pledging standing can still be a keeper.')}
                                                    </p>
                                                </div>

                                                <button
                                                    type="submit"
                                                    disabled={submittingJoinRequest}
                                                    className="w-full py-2.5 px-4 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-xs shadow-sm transition-all disabled:opacity-50 min-h-[44px]"
                                                >
                                                    {submittingJoinRequest
                                                        ? t('Submitting request…')
                                                        : project ? t('Request to join as a collaborator') : t('Request to join as a keeper')}
                                                </button>
                                            </form>
                                        </div>
                                    )
                                )}

                                {/* The money in one line, and today's figures, the keepers' backing and its ledger behind "Money and backing" (round 3
                                    §0 row 9): public to every member as the Commons design says. Open from the start in a preview, which shows everything. */}
                                <ShopfrontMoney line={moneyLine(balance, Number(detail.creditLine ?? 0))} initiallyOpen={isEffectivePreview}>
                                    {/* Balance Card */}
                                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-6 shadow-sm">
                                        <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                                            {project ? t('Project Balance') : t('Enterprise Balance')}
                                        </div>
                                        <div className={`text-4xl font-black mt-2 ${balance < 0 ? 'text-amber-500 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                            {formatNumber(balance)} 🫘
                                        </div>

                                        {balance < 0 && (
                                            <div
                                                role="alert"
                                                aria-live="polite"
                                                className="mt-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs font-semibold leading-relaxed"
                                            >
                                                {project
                                                    ? t('⚠️ In Deficit: This project is currently in deficit ({amount} 🫘). Credit buys inputs and supplies, but collaborators can only be paid from profit. Collaborators cannot be paid while the project is in deficit.', { amount: formatNumber(balance) })
                                                    : t('⚠️ In Deficit: This enterprise is currently in deficit ({amount} 🫘). Credit buys inputs and supplies, but keepers can only be paid from profit. Keepers cannot be paid while the enterprise is in deficit.', { amount: formatNumber(balance) })}
                                            </div>
                                        )}

                                        {/* Tiles are at least 8rem wide, so they drop to one column when two would not fit "Uncapped"
                                            at the text size in use (rem-based, so this follows the phone's font scale too). */}
                                        <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3 mt-5 pt-5 border-t border-nature-100 dark:border-nature-800" data-testid="enterprise-balance-tiles">
                                            <div className="bg-nature-50 dark:bg-nature-800/50 rounded-xl p-3 border border-nature-200/60 dark:border-nature-700/50">
                                                <div className="text-[11px] font-bold uppercase tracking-wide text-nature-500 dark:text-nature-300">
                                                    {t('Credit Line')}
                                                </div>
                                                <div className="text-lg font-extrabold text-nature-900 dark:text-white mt-1">
                                                    {formatNumber(detail.creditLine ?? 0)} 🫘
                                                </div>
                                            </div>
                                            <div className="bg-nature-50 dark:bg-nature-800/50 rounded-xl p-3 border border-nature-200/60 dark:border-nature-700/50">
                                                <div className="text-[11px] font-bold uppercase tracking-wide text-nature-500 dark:text-nature-300">
                                                    {t('Live Offers')}
                                                </div>
                                                <div className="text-lg font-extrabold text-nature-900 dark:text-white mt-1">
                                                    {formatNumber(detail.liveOffers ?? 0)}
                                                </div>
                                            </div>
                                            <div className="bg-nature-50 dark:bg-nature-800/50 rounded-xl p-3 border border-nature-200/60 dark:border-nature-700/50">
                                                <div className="text-[11px] font-bold uppercase tracking-wide text-nature-500 dark:text-nature-300">
                                                    {t('Earned Surplus')}
                                                </div>
                                                <div className="text-lg font-extrabold text-nature-900 dark:text-white mt-1">
                                                    {formatNumber(detail.earnedSurplus ?? 0)} 🫘
                                                </div>
                                            </div>
                                            <div className="bg-nature-50 dark:bg-nature-800/50 rounded-xl p-3 border border-nature-200/60 dark:border-nature-700/50">
                                                <div className="text-[11px] font-bold uppercase tracking-wide text-nature-500 dark:text-nature-300">
                                                    {t('Capital Ceiling')}
                                                </div>
                                                <div className="text-lg font-extrabold text-nature-900 dark:text-white mt-1">
                                                    {detail.workingCapitalCeiling != null ? `${formatNumber(detail.workingCapitalCeiling)} 🫘` : t('Uncapped')}
                                                </div>
                                            </div>
                                        </div>

                                        {pendingClaims.length > 0 && (
                                            <div className="mt-4 p-3.5 rounded-xl bg-nature-50 dark:bg-nature-800/50 border border-nature-200 dark:border-nature-700">
                                                <div className="flex justify-between items-center text-xs">
                                                    <span className="font-bold uppercase tracking-wider text-nature-500 dark:text-nature-300">
                                                        {t('Pending Wage Claims ({n})', { n: pendingClaims.length })}
                                                    </span>
                                                    <span className="font-black text-amber-500 dark:text-amber-400 text-sm">
                                                        {formatNumber(pendingClaimsTotal)} 🫘
                                                    </span>
                                                </div>
                                                <p className="text-xs text-nature-500 dark:text-nature-300 mt-1 leading-relaxed">
                                                    {project
                                                        ? t('Deferred until the project earns sufficient trading profit. Paid automatically from future sales.')
                                                        : t('Deferred until the enterprise earns sufficient trading profit. Paid automatically from future sales.')}
                                                </p>
                                            </div>
                                        )}
                                    </div>

                                    {/* What each keeper backs it with, as their chips said before the shopfront (#106). */}
                                    {shopfrontKeepers.some((k) => k.backing > 0) && (
                                        <div data-testid="enterprise-backing" className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-1">
                                            <h3 className="m-0 mb-1 text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                                                {project ? t('Backed by its collaborators') : t('Backed by its keepers')}
                                            </h3>
                                            {shopfrontKeepers.filter((k) => k.backing > 0).map((k) => (
                                                <p key={k.publicKey} className="m-0 text-sm text-nature-800 dark:text-nature-200 break-words">
                                                    {t('{name} · {amount} 🫘', { name: k.callsign, amount: formatNumber(k.backing) }, "a keeper's backing")}
                                                </p>
                                            ))}
                                        </div>
                                    )}

                                    {/* Income & Spend (P&L) Accountability Panel */}
                                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-4">
                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                            <div>
                                                <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 flex items-center gap-1.5">
                                                    <span>📊</span>
                                                    <span>{t('Income & Spend (P&L)')}</span>
                                                </div>
                                                <p className="text-xs text-nature-500 dark:text-nature-400 mt-0.5">
                                                    {t('Transparent accounting · visible to every member')}
                                                </p>
                                            </div>
                                            {/* Two by two below sm: at 320px with 1.3x text the four periods in one row ran into the card's
                                                right padding. */}
                                            <div className="grid grid-cols-2 w-full sm:inline-flex sm:w-auto rounded-xl bg-nature-100 dark:bg-nature-800 p-1 self-start sm:self-auto">
                                                {(['all', '30d', '90d', '365d'] as const).map((period) => (
                                                    <button
                                                        key={period}
                                                        type="button"
                                                        onClick={() => setLedgerPeriod(period)}
                                                        className={`px-3 py-2.5 text-xs font-bold rounded-lg transition-colors ${
                                                            ledgerPeriod === period
                                                                ? 'bg-white dark:bg-nature-700 text-nature-900 dark:text-white shadow-xs'
                                                                : 'text-nature-600 dark:text-nature-300 hover:text-nature-900 dark:hover:text-white'
                                                        }`}
                                                    >
                                                        {t(LEDGER_PERIOD_WORDS[period])}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Summary Cards */}
                                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                            <div className="bg-emerald-50/70 dark:bg-emerald-950/30 rounded-xl p-3 border border-emerald-200/60 dark:border-emerald-800/40">
                                                <div className="text-[11px] font-bold uppercase tracking-wide text-emerald-800 dark:text-emerald-300">
                                                    {t('Came in')}
                                                </div>
                                                <div className="text-lg font-black text-emerald-700 dark:text-emerald-400 mt-1">
                                                    +{formatNumber(ledgerData?.summary?.totalIncome ?? 0, 2)} 🫘
                                                </div>
                                            </div>
                                            <div className="bg-amber-50/70 dark:bg-amber-950/30 rounded-xl p-3 border border-amber-200/60 dark:border-amber-800/40">
                                                <div className="text-[11px] font-bold uppercase tracking-wide text-amber-800 dark:text-amber-300">
                                                    {t('Went out')}
                                                </div>
                                                <div className="text-lg font-black text-amber-700 dark:text-amber-400 mt-1">
                                                    {ledgerData?.summary?.totalSpend ? `-${formatNumber(ledgerData.summary.totalSpend, 2)}` : formatNumber(0, 2)} 🫘
                                                </div>
                                            </div>
                                            <div className="col-span-2 sm:col-span-1 bg-nature-50 dark:bg-nature-800/50 rounded-xl p-3 border border-nature-200/60 dark:border-nature-700/50">
                                                <div className="text-[11px] font-bold uppercase tracking-wide text-nature-500 dark:text-nature-300">
                                                    {t('Net change')}
                                                </div>
                                                <div className={`text-lg font-black mt-1 ${
                                                    (ledgerData?.summary?.netChange ?? 0) >= 0
                                                        ? 'text-emerald-600 dark:text-emerald-400'
                                                        : 'text-amber-600 dark:text-amber-400'
                                                }`}>
                                                    {(ledgerData?.summary?.netChange ?? 0) >= 0 ? '+' : ''}
                                                    {formatNumber(ledgerData?.summary?.netChange ?? 0, 2)} 🫘
                                                </div>
                                            </div>
                                        </div>
                                        {ledgerFees > 0 && (
                                            // The node counts "came in" before the community fee, while net change is what the
                                            // balance actually moved, so without this the three numbers do not add up.
                                            <p className="text-[11px] text-nature-500 dark:text-nature-400 -mt-1" data-testid="ledger-fee-note">
                                                {t('Came in is before fees: {amount} 🫘 in fees came off it.', { amount: formatNumber(ledgerFees, 2) })}
                                            </p>
                                        )}

                                        {/* Ledger Entries Table */}
                                        {ledgerLoading ? (
                                            <div className="py-8 text-center text-xs text-nature-400 font-medium">
                                                {t('Loading ledger records…')}
                                            </div>
                                        ) : ledgerError && !viewerIsMember ? (
                                            <div className="py-4 text-center text-xs text-nature-500 dark:text-nature-400 italic" data-testid="ledger-members-only">
                                                {t('The full income and spend record is visible to members.')}
                                            </div>
                                        ) : ledgerError ? (
                                            <div className="py-4 text-center text-xs text-red-500 dark:text-red-300 font-medium space-y-2">
                                                <p>{ledgerError}</p>
                                                <button
                                                    type="button"
                                                    onClick={() => loadLedger(ledgerPeriod)}
                                                    className="text-xs font-bold underline text-red-600 dark:text-red-300"
                                                >
                                                    {t('Try again')}
                                                </button>
                                            </div>
                                        ) : !ledgerData?.entries?.length ? (
                                            <div className="py-6 text-center text-xs text-nature-400 italic">
                                                {t('No transactions recorded for this period.')}
                                            </div>
                                        ) : (
                                            <div className="space-y-3">
                                                {/* Below sm each transaction is a stacked row (what for + amount, with + running
                                                    balance, when): six columns needed 642px of a 272px card on a 320px phone. */}
                                                <div className="sm:overflow-x-auto sm:-mx-5 sm:px-5" tabIndex={0} role="region" aria-label={project ? t('Project ledger transactions') : t('Enterprise ledger transactions')}>
                                                    <table className="block sm:table w-full text-left text-xs border-collapse sm:min-w-[500px]">
                                                        <thead className="hidden sm:table-header-group">
                                                            <tr className="border-b border-nature-200 dark:border-nature-800 text-nature-500 dark:text-nature-400 font-bold uppercase text-[10px] tracking-wider">
                                                                <th scope="col" className="py-2 pr-3">{t('When', undefined, 'ledger column')}</th>
                                                                <th scope="col" className="py-2 px-3">{t('What for', undefined, 'ledger column')}</th>
                                                                <th scope="col" className="py-2 px-3">{t('With', undefined, 'ledger column')}</th>
                                                                <th scope="col" className="py-2 px-3 text-right">{t('Came in')}</th>
                                                                <th scope="col" className="py-2 px-3 text-right">{t('Went out')}</th>
                                                                <th scope="col" className="py-2 pl-3 text-right">{t('Running balance')}</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="block sm:table-row-group divide-y divide-nature-100 dark:divide-nature-800">
                                                            {ledgerData.entries.map((entry) => (
                                                                <tr key={entry.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2.5 sm:py-0 sm:table-row hover:bg-nature-50/50 dark:hover:bg-nature-800/30 transition-colors" data-testid="ledger-entry">
                                                                    <td className="order-5 text-[11px] sm:text-xs sm:order-none sm:py-2.5 sm:pr-3 text-nature-500 dark:text-nature-300 whitespace-nowrap">
                                                                        {formatTimestamp(entry.timestamp)}
                                                                    </td>
                                                                    <td className="order-1 sm:order-none sm:py-2.5 sm:px-3 font-semibold text-nature-800 dark:text-nature-200 [overflow-wrap:anywhere] sm:max-w-[140px] sm:truncate" title={entry.memo}>
                                                                        {entry.memo || t('Transfer')}
                                                                    </td>
                                                                    <td className="order-3 text-[11px] sm:text-xs sm:order-none sm:py-2.5 sm:px-3 text-nature-600 dark:text-nature-300 [overflow-wrap:anywhere] sm:max-w-[110px] sm:truncate" title={entry.counterpartyName}>
                                                                        {entry.counterpartyName || t('Member')}
                                                                    </td>
                                                                    <td className={`${entry.direction === 'income' ? 'order-2' : 'hidden'} sm:order-none sm:table-cell sm:py-2.5 sm:px-3 text-right font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap`}>
                                                                        {entry.direction === 'income' ? `+${formatNumber(entry.amount, 2)} 🫘` : <span className="text-nature-300 dark:text-nature-300 font-normal">—</span>}
                                                                    </td>
                                                                    <td className={`${entry.direction === 'spend' ? 'order-2' : 'hidden'} sm:order-none sm:table-cell sm:py-2.5 sm:px-3 text-right font-bold text-amber-600 dark:text-amber-400 whitespace-nowrap`}>
                                                                        {entry.direction === 'spend' ? `-${formatNumber(entry.amount, 2)} 🫘` : <span className="text-nature-300 dark:text-nature-300 font-normal">—</span>}
                                                                    </td>
                                                                    <td className="order-4 text-[11px] sm:text-xs sm:order-none sm:py-2.5 sm:pl-3 text-right font-extrabold text-nature-900 dark:text-white whitespace-nowrap">
                                                                        <span className="sm:hidden font-semibold text-nature-500 dark:text-nature-300">{t('bal', undefined, 'running balance, short')} </span>{formatNumber(entry.runningBalance, 2)} 🫘
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                                <div className="pt-2 border-t border-nature-100 dark:border-nature-800 flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-nature-500 dark:text-nature-400">
                                                    <span><Sentence text={t('Starting balance: {amount}')} parts={{ amount: <strong className="text-nature-700 dark:text-nature-300">{formatNumber(ledgerData.summary.startingBalance, 2)} 🫘</strong> }} /></span>
                                                    <span><Sentence text={t('Ending balance: {amount}')} parts={{ amount: <strong className="text-nature-700 dark:text-nature-300">{formatNumber(ledgerData.summary.endingBalance, 2)} 🫘</strong> }} /></span>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                </ShopfrontMoney>

                                {/* The keepers' votes (DESIGN-group-decisions S2): drawn only for those the node answers */}
                                {!isEffectivePreview && !canManage && (
                                    <EnterpriseDecisions treasuryKey={pubkey} myPubkey={myPubkey} keepers={keeperList} balance={balance}
                                        earnedSurplus={typeof detail?.earnedSurplus === 'number' ? detail.earnedSurplus : null} lifecycle={detail?.lifecycle} />
                                )}

                                {/* Recent Activity Flow */}
                                <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-3">
                                    <div className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                                        {t('Recent Activity')}
                                    </div>
                                    {flow.length === 0 ? (
                                        <p className="text-xs text-nature-400 italic py-2">{t('No recent activity.')}</p>
                                    ) : (
                                        <div className="divide-y divide-nature-100 dark:divide-nature-800">
                                            {flow.map((tx: any, idx: number) => {
                                                const isOut = !tx.incoming;
                                                return (
                                                    <div key={tx.id || `${tx.timestamp}-${idx}`} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                                                        <div className="min-w-0 flex-1">
                                                            <div className="font-semibold text-nature-800 dark:text-nature-200 truncate">
                                                                {tx.memo || t('Transfer')}
                                                            </div>
                                                            <div className="text-[11px] text-nature-400 mt-0.5">
                                                                {formatTimestamp(tx.timestamp)}
                                                            </div>
                                                        </div>
                                                        <div className={`font-black text-sm shrink-0 ${isOut ? 'text-amber-500' : 'text-emerald-500 dark:text-emerald-400'}`}>
                                                            {isOut ? '-' : '+'}{formatNumber(Number(tx.amount))} 🫘
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                {/* Enterprise Discussion Thread (Slice 6) */}
                                <div data-testid="enterprise-thread" className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm space-y-4">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <h3 className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 flex items-center gap-1.5 m-0">
                                                <span aria-hidden="true">💬</span>
                                                <span>{project ? t('Project Discussion') : t('Enterprise Discussion')}</span>
                                            </h3>
                                            <p className="text-xs text-nature-500 dark:text-nature-400 mt-0.5">
                                                {project ? t('Public coordination for this project') : t('Public coordination for this enterprise')}
                                            </p>
                                        </div>
                                        {threadReadOnly && (
                                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-stone-200 dark:bg-stone-800 text-stone-700 dark:text-stone-300">
                                                {t('Read-only (Wound up)')}
                                            </span>
                                        )}
                                    </div>

                                    {threadReadOnly && (
                                        <div className="bg-nature-50 dark:bg-nature-800/60 p-3 rounded-xl text-xs italic text-nature-600 dark:text-nature-300 text-center">
                                            {project
                                                ? t('This project has wound up. Discussion is read-only for accountability.')
                                                : t('This enterprise has wound up. Discussion is read-only for accountability.')}
                                        </div>
                                    )}

                                    {threadUnavailable && !viewerIsMember ? (
                                        <p className="text-xs text-nature-600 dark:text-nature-300 italic py-2" data-testid="thread-members-only">
                                            {t('The discussion is open to members.')}
                                        </p>
                                    ) : isEffectivePreview ? (
                                        // Example Valley's: no thread to start here, so no "Start the conversation!" (review N4).
                                        <div className="py-2" data-testid="thread-preview">
                                            <LocalCommunityLine
                                                feature="enterprises"
                                                text={project
                                                    ? t('🏘️ In a local community its collaborators and members talk it over here ›')
                                                    : t('🏘️ In a local community its keepers and members talk it over here ›')}
                                                {...ways}
                                            />
                                        </div>
                                    ) : threadMessages.length === 0 ? (
                                        <p className="text-xs text-nature-600 dark:text-nature-300 italic py-2">
                                            {viewerIsMember ? t('No messages yet. Start the conversation!') : t('No messages yet.')}
                                        </p>
                                    ) : (
                                        <div className="divide-y divide-nature-100 dark:divide-nature-800">
                                            {threadMessages.map((m) => {
                                                const isRemoved = m.type === 'removed';
                                                const authorName = m.authorCallsign || (m.authorPubkey ? m.authorPubkey.slice(0, 8) : t('Member'));
                                                const textContent = decodeThreadText(m.ciphertext, m.type, m.metadata, project);
                                                return (
                                                    <div key={m.id} className="py-3 flex items-start gap-3 text-xs">
                                                        {m.authorAvatar ? (
                                                            <img
                                                                src={resolveAvatarUrl(m.authorAvatar) || undefined}
                                                                alt={authorName}
                                                                className="w-8 h-8 rounded-full object-cover shrink-0 bg-nature-100 dark:bg-nature-800"
                                                            />
                                                        ) : (
                                                            <div className="w-8 h-8 rounded-full bg-nature-200 dark:bg-nature-700 flex items-center justify-center font-bold text-nature-700 dark:text-nature-200 shrink-0">
                                                                {upperCase(authorName.charAt(0))}
                                                            </div>
                                                        )}
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="font-bold text-nature-900 dark:text-white">{authorName}</span>
                                                                    <span className="text-[10px] text-nature-400">{formatTimestamp(m.timestamp)}</span>
                                                                </div>
                                                            </div>
                                                            <div className={`mt-1 leading-relaxed ${isRemoved ? 'italic text-nature-400 dark:text-nature-400' : 'text-nature-800 dark:text-nature-200'}`}>
                                                                {textContent}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {!threadReadOnly && !viewerIsMember && !threadUnavailable && !isEffectivePreview && (
                                        <p className="text-xs text-nature-500 dark:text-nature-400 italic" data-testid="thread-guest-note">
                                            {t('Join the community to post here.')}
                                        </p>
                                    )}

                                    {!threadReadOnly && !isEffectivePreview && viewerIsMember && (
                                        <form onSubmit={handlePostThreadMessage} className="mt-2 space-y-2">
                                            {threadError && (
                                                <div className="text-xs text-rose-600 dark:text-rose-300 font-medium">
                                                    {threadError}
                                                </div>
                                            )}
                                            <div className="flex gap-2">
                                                <input
                                                    type="text"
                                                    aria-label={project ? t('Message the project') : t('Message the enterprise')}
                                                    value={threadInput}
                                                    onChange={(e) => setThreadInput(e.target.value)}
                                                    disabled={threadPosting}
                                                    placeholder={project ? t('Message the project...') : t('Message the enterprise...')}
                                                    maxLength={2000}
                                                    className="flex-1 min-w-0 px-3 py-2 text-xs rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                                />
                                                <button
                                                    type="submit"
                                                    disabled={!threadInput.trim() || threadPosting}
                                                    className="px-4 py-2 text-xs font-bold rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on disabled:opacity-50 transition-colors shadow-xs cursor-pointer"
                                                >
                                                    {threadPosting ? t('Posting...') : t('Post', undefined, 'button: publish')}
                                                </button>
                                            </div>
                                        </form>
                                    )}
                                </div>

                                {/* Report Enterprise Action, and the "…" menu with Block */}
                                {!isEffectivePreview && (
                                    <div data-testid="enterprise-report" className="pt-4 border-t border-nature-200 dark:border-nature-800">
                                        <div className="flex items-center justify-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setShowReportModal(true)}
                                                className="text-xs text-red-600 dark:text-red-400 font-semibold hover:underline flex items-center gap-1 bg-transparent border-none cursor-pointer"
                                            >
                                                <span aria-hidden="true">🛡️</span> {project ? t('Report Project') : t('Report Enterprise')}
                                            </button>
                                            {mayBlock && (
                                                <button
                                                    type="button"
                                                    onClick={() => setShowMoreMenu((open) => !open)}
                                                    aria-label={t('More options')}
                                                    aria-haspopup="menu"
                                                    aria-expanded={showMoreMenu}
                                                    className="shrink-0 min-h-[48px] min-w-[48px] rounded-full flex items-center justify-center text-lg font-bold text-nature-600 dark:text-nature-300 hover:bg-nature-200/60 dark:hover:bg-nature-800 bg-transparent border-none cursor-pointer"
                                                >
                                                    <span aria-hidden="true">⋯</span>
                                                </button>
                                            )}
                                        </div>
                                        {mayBlock && showMoreMenu && (
                                            <div role="menu" aria-label={t('More options')} className="mt-2 mx-auto max-w-xs rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 overflow-hidden">
                                                <button
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={isBlocked ? handleUnblock : handleBlock}
                                                    disabled={isBlocking}
                                                    className={`w-full min-h-[48px] px-4 py-2 text-left text-sm font-bold flex items-center gap-2 cursor-pointer border-none transition-colors disabled:opacity-60 ${
                                                        isBlocked
                                                            ? 'bg-transparent text-nature-700 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-800'
                                                            : 'bg-bp-chip-danger-tint text-bp-chip-danger-ink hover:brightness-95'
                                                    }`}
                                                >
                                                    <span aria-hidden="true">{isBlocked ? '🛡️' : '🚫'}</span>
                                                    <span className="min-w-0 break-words">
                                                        {isBlocking ? (isBlocked ? t('Unblocking…') : t('Blocking…')) : isBlocked ? t('Unblock {name}', { name }) : t('Block {name}', { name })}
                                                    </span>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                                </>)}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Post Offer / Need Modal */}
            {postModalMode && (
                <div
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                    onClick={() => setPostModalMode(null)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="post-modal-title"
                        onClick={(e) => e.stopPropagation()}
                        className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-6 w-full max-w-md shadow-xl space-y-4 animate-in zoom-in-95 duration-200"
                    >
                        <div className="flex justify-between items-center">
                            <h2 id="post-modal-title" className="text-lg font-black text-nature-900 dark:text-white">
                                {postModalMode === 'offer'
                                    ? (project ? t('Post Project Offer') : t('Post Enterprise Offer'))
                                    : (project ? t('Post Project Need') : t('Post Enterprise Need'))}
                            </h2>
                            <button
                                type="button"
                                aria-label={t('Close dialog')}
                                onClick={() => setPostModalMode(null)}
                                className="text-nature-400 hover:text-nature-600 dark:hover:text-nature-200 text-lg font-bold min-w-[44px] min-h-[44px] flex items-center justify-center -mr-2"
                            >
                                ✕
                            </button>
                        </div>

                        {postError && (
                            <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 rounded-xl text-xs font-semibold">
                                {postError}
                            </div>
                        )}

                        <form onSubmit={handleCreatePost} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                    {t('Title')}
                                </label>
                                <input
                                    type="text"
                                    required
                                    placeholder={postModalMode === 'offer' ? t('e.g. Dozen fresh eggs') : t('e.g. Tend the chicken coop')}
                                    value={postTitle}
                                    onChange={(e) => setPostTitle(e.target.value)}
                                    className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                        {t('Category')}
                                    </label>
                                    <select
                                        value={postCategory}
                                        onChange={(e) => setPostCategory(e.target.value)}
                                        className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                    >
                                        {MARKETPLACE_CATEGORIES.map((c) => (
                                            <option key={c.id} value={c.id}>
                                                {t('{emoji} {label}', { emoji: c.emoji, label: t(c.label) })}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                        {t('Price Type')}
                                    </label>
                                    <select
                                        value={postPriceType}
                                        onChange={(e) => setPostPriceType(e.target.value)}
                                        className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                    >
                                        <option value="fixed">{t('Fixed Total')}</option>
                                        <option value="hourly">{t('Hourly (/hr)')}</option>
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                    {t('Credits (🫘 Beans)')}
                                </label>
                                {/* Text, not type="number": a number box reads "12,5" by the browser's language, not the member's (#2202). */}
                                <input
                                    type="text"
                                    inputMode="decimal"
                                    required
                                    placeholder="20"
                                    value={postCredits}
                                    onChange={(e) => setPostCredits(e.target.value)}
                                    className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                                    {t('Description (optional)')}
                                </label>
                                <textarea
                                    rows={3}
                                    placeholder={t('Describe the offer or need...')}
                                    value={postDescription}
                                    onChange={(e) => setPostDescription(e.target.value)}
                                    className="w-full bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 rounded-xl px-3 py-2 text-sm text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                            </div>

                            {postModalMode === 'offer' && (
                                <label className="flex items-center gap-2 cursor-pointer pt-1">
                                    <input
                                        type="checkbox"
                                        checked={postRepeatable}
                                        onChange={(e) => setPostRepeatable(e.target.checked)}
                                        className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 border-nature-300"
                                    />
                                    <span className="text-xs font-semibold text-nature-700 dark:text-nature-300">
                                        {t('Recurring listing (stays active after purchase)')}
                                    </span>
                                </label>
                            )}

                            <div className="flex gap-3 pt-3">
                                <button
                                    type="button"
                                    onClick={() => setPostModalMode(null)}
                                    className="flex-1 py-2.5 rounded-xl border border-nature-300 dark:border-nature-700 text-nature-700 dark:text-nature-300 font-bold text-sm hover:bg-nature-50 dark:hover:bg-nature-800"
                                >
                                    {t('Cancel')}
                                </button>
                                <button
                                    type="submit"
                                    disabled={posting}
                                    className="flex-1 py-2.5 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-bold text-sm disabled:opacity-50"
                                >
                                    {posting ? t('Posting…') : t('Publish Listing')}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {showReportModal && identity && (
                <ReportModal
                    isOpen={showReportModal}
                    onClose={() => setShowReportModal(false)}
                    reporterPubkey={identity.publicKey}
                    targetPubkey={pubkey}
                    targetName={name}
                />
            )}
        </div>
    );
}
