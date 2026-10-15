/**
 * App Shell — Main layout with bottom navigation
 *
 * Handles:
 * - Identity gate (first-run → WelcomePage)
 * - Tab routing (Marketplace / Ledger)
 * - Persistent header with SyncStatus
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { loadIdentity, type BeanPoolIdentity } from './lib/identity';
import { beginAccountEpoch } from './lib/account-epoch';
import { openWithNodeName } from './lib/member-name';
import { connectToAnchor, onSyncActivity } from './lib/sync';
import { registerLivePostTie, openDealTie } from './lib/live-posts';
import { getConversations, getMyMarketplaceTransactions, getCommunityHealth, getNodeApiUrl, type CommunityInfo, type MarketplaceTransaction, type Group } from './lib/api';
import { GroupDetailModal } from './components/GroupDetailModal';
import { GroupVotesSheet, landOnGroup, routeLanding } from './components/GroupVotesSheet';
import { withJitter } from './lib/jitter';
import { useTheme } from './lib/useTheme';
import { useLanguage } from './lib/useLanguage';
import { SyncStatus } from './components/SyncStatus';
import { WelcomePage } from './pages/WelcomePage';
import { GuestLobby } from './pages/GuestLobby';
import { communityInfoOnce, joinInFlight } from './lib/visitor-lobby-gate';
import { forgetRecentLookups } from './lib/members-on-demand';
import { visitorsSeeListings, takeKeptLinkedPost } from './lib/visitor-lobby';
import { MarketplacePage } from './pages/MarketplacePage';
import { LedgerPage } from './pages/LedgerPage';
import { LedgerPreview } from './components/ShowcasePreviews';
import { useFeatureMode } from './lib/features';
import { SettingsPage } from './pages/SettingsPage';
import { lazy, Suspense } from 'react';
import { webAppBehindServer } from './lib/app-version';
import { retryPendingReports, startBlocklist } from './lib/blocklist';
const MapPage = lazy(() => import('./pages/MapPage').then(m => ({ default: m.MapPage })));
import { PeoplePage } from './pages/PeoplePage';
import { MessagesPage } from './pages/MessagesPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { PulsePage } from './pages/PulsePage';
import { HomePage } from './pages/HomePage';
import { HeaderControls, HeaderTitle, SidebarControls, useDotOnlyChip } from './components/HeaderControls';
import { helpSheetFor, tourStepForTab, tourSteps, webHelpKey, type HomeSearchSettings } from '@beanpool/core';
import { TourBar } from './components/TourBar';
import { HelpDialog } from './components/HelpDialog';
import { OPEN_HELP_EVENT, askTourAgain, endTour, moveTour, useTour } from './lib/tour-store';
import { getBundledGuide } from './lib/guide';
import { InstallPrompt } from './components/InstallPrompt';
import { PublicProfilePage } from './pages/PublicProfilePage';
import { TreasuryDetailPage } from './pages/TreasuryDetailPage';
import { ProfileSetup } from './components/ProfileSetup';
import { RecoveryAlertBanner } from './components/RecoveryAlertBanner';
import { OwnerWordsPrompt } from './components/OwnerWordsPrompt';
import { NewAccountCard } from './components/NewAccountCard';
import { captureAuthReturn, consumeCapturedAuthReturn } from './lib/web-join';
import { clearPendingLink, finishLink, isLinkReturn, type LinkResult } from './lib/link-signin';
import { ModerationPauseCard } from './components/ModerationPauseCard';
import { SystemAlerts, type ShownAlert } from './components/SystemAlerts';
import { FormerAddressBanner } from './components/FormerAddressBanner';
import { takeProfileFragment } from './lib/profile-link';
import { takePostParam } from './lib/event-extras';

type Tab = 'home' | 'map' | 'marketplace' | 'pulse' | 'messages' | 'people' | 'ledger' | 'projects';

// Bottom nav sizing for a 320px phone at 1.3x text (docs: the audience runs old, small Androids).
// Each tab's share of the row follows its label length, with a floor for the emoji above it.
// Measured (e2e/home-check.mjs): "Home" in extrabold, its H and m wide, is cut by a pixel on four shares at 320px; it
// takes the fifth the Pulse had before the Pulse became a card on Home.
const WIDER_THAN_ITS_LENGTH: Record<string, number> = { Home: 5 };
export function navTabWeight(label: string): number {
    return WIDER_THAN_ITS_LENGTH[label] ?? Math.max(4, label.length);
}
// Measured in headless Chrome at 320px: "Commons" in extrabold needs ~4.9px of row per px of
// font and gets ~54px, so 3.3vw (10.6px there) keeps it whole; 0.6rem caps it on wider screens.
export const NAV_LABEL_FONT_SIZE = 'min(0.6rem, 3.3vw)';

// What the header reads out of GET /api/community/health. `online` is ours, not the
// node's: it records whether that call answered at all.
interface NodeHealthState {
    online: boolean;
    version?: string;
    minAppVersion?: string;
    nodeName?: string;
    callsign?: string;
    memberCount?: number;
    postCount?: number;
    tree?: { totalMembers?: number };
    activity?: { totalPosts?: number };
}

export function App() {
    // Every screen reads the new words the moment the language changes (lib/language.ts): App re-renders, and so does all of it.
    useLanguage();
    const [identity, setIdentity] = useState<BeanPoolIdentity | null>(null);
    const [loading, setLoading] = useState(true);
    /*
     * With no identity: the global lobby (G9b) when the node shows visitors its listings and nothing is part way through
     * a join in this browser; otherwise the welcome page, as always. Decided once, from the node's own word; a node
     * that can't be asked gets the welcome page, which says so; a check for a join in flight that fails is taken as one
     * in flight (the welcome page reads it again), so nothing leaves the visitor on the loading screen.
     */
    const [visitorView, setVisitorView] = useState<{ kind: 'checking' } | { kind: 'welcome'; info: CommunityInfo | null } | { kind: 'lobby'; info: CommunityInfo }>({ kind: 'checking' });
    useEffect(() => {
        if (loading || identity || visitorView.kind !== 'checking') return;
        let cancelled = false;
        Promise.all([communityInfoOnce().catch(() => null), joinInFlight().catch(() => true)])
            .then(([info, inFlight]) => {
                if (cancelled) return;
                setVisitorView(info && visitorsSeeListings(info) && !inFlight ? { kind: 'lobby', info } : { kind: 'welcome', info });
            });
        return () => { cancelled = true; };
    }, [loading, identity, visitorView.kind]);
    // Members land on Home (DESIGN-home-dashboard-fable.md §8): the Market is one tap away, and every link into it still opens it.
    const [activeTab, setActiveTab] = useState<Tab>('home');
    // Beans off here and the node shows previews (DESIGN-global-showcase-fable.md §4): the Ledger is Example Valley's.
    const beansMode = useFeatureMode('beans');
    const [peopleSubView, setPeopleSubView] = useState<'friends' | 'community' | 'invites'>('friends');
    const [showSettings, setShowSettings] = useState(false);
    const [settingsInitialMode, setSettingsInitialMode] = useState<'menu' | 'profile' | 'seed' | 'guide'>('menu');
    // The guide page Settings opens at (Home's Tips card, Read more); null: the guide's front page.
    const [settingsGuidePage, setSettingsGuidePage] = useState<string | null>(null);
    // A sign-in added to an account made with 12 words (lib/link-signin.ts): what came of it, said in Settings.
    const [linkResult, setLinkResult] = useState<LinkResult | null>(null);
    // "Check now" on the owners' 12-words prompt opens Settings with that card open; closing Settings resets it.
    const [ownerWordsOpen, setOwnerWordsOpen] = useState(false);
    useEffect(() => { if (!showSettings) setOwnerWordsOpen(false); }, [showSettings]);
    // Where Settings opens is for that one open ("See my 12 words" → the words, Edit profile → the profile): closing
    // Settings, by any way, sets it back, so the next open from the header is the menu, never the 12 words on screen.
    useEffect(() => { if (!showSettings) { setSettingsInitialMode('menu'); setSettingsGuidePage(null); } }, [showSettings]);

    // ── The tour (DESIGN-getting-started-fable.md §2) and the "?" (§4) ──
    // Home starts the tour and owns what it writes (lib/tour-store.ts); the bar is drawn here, over the real tabs.
    const { run: tour, home: tourHomeNow, offered: tourOffered } = useTour();
    const tourRunning = !!tour && !!identity && tour.publicKey === identity.publicKey;
    const steps = tour ? tourSteps('web', tour.node) : [];
    const tourIndex = tour ? Math.min(tour.step, steps.length - 1) : 0;
    const tourTab = tourRunning ? steps[tourIndex]?.tab ?? null : null;
    // Each step shows its own tab (Settings and an open profile close for it).
    useEffect(() => {
        if (!tourTab) return;
        setShowSettings(false);
        setOpenProfilePubkey(null);
        setActiveTab(tourTab as Tab);
    }, [tourTab, tourIndex]);
    // A tab the member opens during the tour moves the tour to that tab's step: it follows, never scolds.
    useEffect(() => {
        if (!tourRunning || activeTab === tourTab) return;
        const at = tourStepForTab(steps, activeTab);
        if (at >= 0) moveTour(at);
    }, [activeTab]);
    const finishTour = (kind: 'done' | 'skipped') => {
        endTour(kind);
        setShowSettings(false);
        setActiveTab('home');
    };
    const [helpOpen, setHelpOpen] = useState(false);
    useEffect(() => {
        const open = () => setHelpOpen(true);
        window.addEventListener(OPEN_HELP_EVENT, open);
        return () => window.removeEventListener(OPEN_HELP_EVENT, open);
    }, []);
    const helpWords = helpSheetFor(getBundledGuide(), webHelpKey({ tab: activeTab, settings: showSettings }));
    const [openConversationId, setOpenConversationId] = useState<string | null>(null);
    const [openMarketPostId, setOpenMarketPostId] = useState<string | null>(null);
    // Whether the Market says so when that post can't be opened: yes for a member's own tap (navigateToTab), no for a link
    // the app arrived on (a shared /?post=, the lobby's kept listing), which lands quietly on the Market as before.
    const [openMarketPostSaysWhy, setOpenMarketPostSaysWhy] = useState(false);
    const [openMarketReviewTxId, setOpenMarketReviewTxId] = useState<string | null>(null);
    // A saved search's See more on Home: the words the Market's search opens with.
    const [openMarketSearch, setOpenMarketSearch] = useState<string | null>(null);
    const clearMarketSearch = useCallback(() => setOpenMarketSearch(null), []);
    // The Market's "Save this search to Home": the search Home opens the saved search's dialog with, taken once.
    const [saveSearchToHome, setSaveSearchToHome] = useState<HomeSearchSettings | null>(null);
    const clearSaveSearch = useCallback(() => setSaveSearchToHome(null), []);
    const [openNewPost, setOpenNewPost] = useState(false);
    const [openNewPostGroupId, setOpenNewPostGroupId] = useState<string | undefined>(undefined);
    // An event's "Show on map" (docs/events-on-the-map.md §3): the map centres on it.
    const [focusMapPostId, setFocusMapPostId] = useState<string | null>(null);
    const clearFocusMapPost = useCallback(() => setFocusMapPostId(null), []);
    // "Copy to a new date" from an event's host panel: the map owns the event create form, so the event id
    // travels there and MapPage fetches it signed (which is what carries the private note to its host).
    const [copyEventPostId, setCopyEventPostId] = useState<string | null>(null);
    const clearCopyEventPost = useCallback(() => setCopyEventPostId(null), []);
    // "Edit event" from an event's host panel: the map's event form opens in edit mode, filled from it.
    const [editEventPostId, setEditEventPostId] = useState<string | null>(null);
    const clearEditEventPost = useCallback(() => setEditEventPostId(null), []);
    const [openProfilePubkey, setOpenProfilePubkey] = useState<string | null>(null);
    const [openTreasuryPubkey, setOpenTreasuryPubkey] = useState<string | null>(null);
    // A chat group's info, opened over whatever is on screen: Home's vote line lands here (DESIGN-group-decisions S3).
    const [openGroup, setOpenGroup] = useState<Group | null>(null);
    // A group whose own read is refused, but whose votes still hold the reader (removed mid-vote from an invite-only group).
    const [openGroupVotes, setOpenGroupVotes] = useState<{ groupId: string; canVote: boolean } | null>(null);
    const isBottomNavVisible = !openProfilePubkey && !openTreasuryPubkey;

    useEffect(() => {
        if (typeof document !== 'undefined') {
            if (isBottomNavVisible) {
                document.documentElement.removeAttribute('data-bottom-nav');
                document.documentElement.classList.remove('bottom-nav-hidden');
                document.documentElement.style.removeProperty('--bottom-nav-height');
                document.documentElement.style.removeProperty('--bottom-nav-offset');
            } else {
                document.documentElement.setAttribute('data-bottom-nav', 'hidden');
                document.documentElement.classList.add('bottom-nav-hidden');
                document.documentElement.style.setProperty('--bottom-nav-height', '0px');
                document.documentElement.style.setProperty('--bottom-nav-offset', 'calc(env(safe-area-inset-bottom, 0px) + var(--tour-bar-height, 0px))');
            }
        }
        return () => {
            if (typeof document !== 'undefined') {
                document.documentElement.removeAttribute('data-bottom-nav');
                document.documentElement.classList.remove('bottom-nav-hidden');
                document.documentElement.style.removeProperty('--bottom-nav-height');
                document.documentElement.style.removeProperty('--bottom-nav-offset');
            }
        };
    }, [isBottomNavVisible]);
    const [theme, themePreference, setThemePreference] = useTheme();
    // Read again when a pause or its lift is shown (SystemAlerts): "Posting paused" follows it at once.
    const [standingKey, setStandingKey] = useState(0);
    const onAlertShown = useCallback((a: ShownAlert) => {
        if (a.kind === 'moderation_muted' || a.kind === 'moderation_unmuted') setStandingKey(k => k + 1);
    }, []);
    const [totalUnread, setTotalUnread] = useState(0);
    const [pendingDealsCount, setPendingDealsCount] = useState(0);
    const [myTransactions, setMyTransactions] = useState<MarketplaceTransaction[]>([]);
    // A listing the viewer has an open deal on is not applied from the live feed: its change can reject or cancel
    // the deal without a trade event of its own, so it rings the doorbell and this poll runs (lib/live-posts).
    // Set in the commit, not in a later effect, so a push landing in between is tested against these deals.
    const myTransactionsRef = useRef<MarketplaceTransaction[]>([]);
    useLayoutEffect(() => { myTransactionsRef.current = myTransactions; }, [myTransactions]);
    useEffect(() => registerLivePostTie(openDealTie(() => myTransactionsRef.current)), []);
    const [marketClickCount, setMarketClickCount] = useState(0);
    // null until the node has answered the membership check. The Market, Commons and Map pages wait for it
    // before asking for the viewer's balance, so a guest never sends that request; everything else reads
    // null as a member, as before.
    const [isGuest, setIsGuest] = useState<boolean | null>(null);
    const [showProfileSetup, setShowProfileSetup] = useState(false);
    // The install banner (rehearsal 14 Oct, B1) never sits on the tour or a screen drawn over the tabs, and a member is
    // first offered it once the tour has ended: while Home has not said, or says its Getting started card is up, it waits.
    const tourStillOffered = !!identity && isGuest === false && (tourOffered?.publicKey !== identity.publicKey || tourOffered.up);
    const installHeldBack = tourRunning || tourStillOffered || showSettings || showProfileSetup || !!openTreasuryPubkey || !!openProfilePubkey;
    // "Your account is new" (G11-e): put away in this browser for this account; Settings keeps showing it.
    const [newAccountCardClosed, setNewAccountCardClosed] = useState(false);
    // The recent searches and "near you" answers (lib/members-on-demand) are kept by path alone: another account in this
    // tab asks afresh (#1965 review N5).
    useEffect(() => { forgetRecentLookups(); }, [identity?.publicKey]);
    useEffect(() => {
        try { setNewAccountCardClosed(!!identity?.publicKey && localStorage.getItem(`beanpool_new_account_card_closed_${identity.publicKey}`) === '1'); }
        catch { setNewAccountCardClosed(false); }
    }, [identity?.publicKey]);
    const closeNewAccountCard = useCallback(() => {
        setNewAccountCardClosed(true);
        try { if (identity?.publicKey) localStorage.setItem(`beanpool_new_account_card_closed_${identity.publicKey}`, '1'); } catch { /* private window */ }
    }, [identity?.publicKey]);
    const [showCommunityStatus, setShowCommunityStatus] = useState(false);
    const [communityHealth, setCommunityHealth] = useState<NodeHealthState | null>(null);
    // The node's own version, once health has answered; the baked-in bundle version until then.
    const displayVersion = communityHealth?.version?.trim() || __APP_VERSION__;
    // A page left open across this server's upgrade: a reload loads the new one (lib/app-version.ts webAppBehindServer). Not
    // the phone app's floor, which no reload could meet: the web app is this server's own copy, and has no block.
    const serverVersionAhead = webAppBehindServer(__APP_VERSION__, communityHealth,
        !!getNodeApiUrl() && getNodeApiUrl() !== (typeof window !== 'undefined' ? window.location.origin : ''));

    const toggleCommunityStatus = () => {
        if (showCommunityStatus) {
            setShowCommunityStatus(false);
            return;
        }
        if (communityHealth?.online) {
            setShowCommunityStatus(true);
            return;
        }
        // Never loaded, or loaded offline: re-check, so a cold start or a dropped
        // connection recovers on a tap instead of needing a page reload.
        getCommunityHealth()
            .then(h => { setCommunityHealth({ ...h, online: true }); setShowCommunityStatus(true); })
            .catch(() => { setCommunityHealth(prev => ({ ...prev, online: false })); setShowCommunityStatus(true); });
    };

    function navigateToTab(tab: string, contextId?: string) {
        if (tab === 'profile-setup') {
            setShowProfileSetup(true);
            return;
        }
        if (tab === 'map-post') {
            setActiveTab('map');
            setOpenNewPost(true);
            setOpenNewPostGroupId(contextId);
            return;
        }
        if (tab === 'map-event') {
            setActiveTab('map');
            if (contextId) setFocusMapPostId(contextId);
            return;
        }
        if (tab === 'map-copy-event') {
            setActiveTab('map');
            if (contextId) setCopyEventPostId(contextId);
            return;
        }
        if (tab === 'map-edit-event') {
            setActiveTab('map');
            if (contextId) setEditEventPostId(contextId);
            return;
        }
        if (tab === 'map') {
            setActiveTab('map');
            if (contextId) {
                setOpenNewPost(true);
                setOpenNewPostGroupId(contextId);
            }
            return;
        }
        if (tab === 'enterprise' || tab === 'treasury') {
            if (contextId) setOpenTreasuryPubkey(contextId);
            return;
        }
        // A group's vote: the group's info, where its Decisions block is. Read first, so the sheet opens whole; a group
        // that can't be read now opens just its votes when they still hold the reader (#1784 review B1), else Commons.
        if (tab === 'group') {
            if (contextId) {
                landOnGroup(contextId).then(l => routeLanding(l, {
                    group: setOpenGroup, votes: setOpenGroupVotes, commons: () => setActiveTab('projects'),
                }));
            }
            return;
        }
        // From Home's cards: People's community list or its invites, and Settings at the profile.
        if (tab === 'people-community' || tab === 'people-invites') {
            setPeopleSubView(tab === 'people-invites' ? 'invites' : 'community');
            setActiveTab('people');
            return;
        }
        if (tab === 'settings-profile') {
            setSettingsInitialMode('profile');
            setShowSettings(true);
            return;
        }
        // A chat's "Rate your partner": the Market with that trade's rating form open.
        if (tab === 'marketplace-review') {
            setActiveTab('marketplace');
            if (contextId) setOpenMarketReviewTxId(contextId);
            return;
        }
        // A saved search's See more: the Market with the words in its search.
        if (tab === 'marketplace-search') {
            setActiveTab('marketplace');
            setOpenMarketSearch(contextId ?? '');
            return;
        }
        // The Tips card's Read more: the members' guide in Settings, open at that page (Back walks to its front page).
        if (tab === 'guide') {
            setSettingsGuidePage(contextId ?? null);
            setSettingsInitialMode('guide');
            setShowSettings(true);
            return;
        }
        setActiveTab(tab as Tab);
        if (tab === 'messages' && contextId) setOpenConversationId(contextId);
        if (tab === 'marketplace' && contextId) { setOpenMarketPostSaysWhy(true); setOpenMarketPostId(contextId); }
    }

    // `/app#profile=<key>` (node Settings' "View my profile"): read once on load, opened once the identity has loaded.
    const [linkedProfile, setLinkedProfile] = useState<string | null>(null);
    useEffect(() => { setLinkedProfile(takeProfileFragment()); }, []);
    useEffect(() => {
        if (!identity || !linkedProfile) return;
        setOpenProfilePubkey(linkedProfile);
        setLinkedProfile(null);
    }, [identity, linkedProfile]);

    // `/?post=<id>` — a shared event (or any shared post). The same link the phone app claims, so one link
    // works for everyone; somebody who is not a member of this community never gets here, because the
    // identity gate shows them the join page instead, which is the right landing for them.
    const [linkedPost, setLinkedPost] = useState<string | null>(null);
    useEffect(() => { setLinkedPost(takePostParam()); }, []);
    const clearLinkedPost = useCallback(() => setLinkedPost(null), []);
    // On the global lobby a visitor reads the shared listing first; the lobby keeps it in this tab (a join by sign-in
    // leaves the page), and it opens here once, when they have joined. Before the address's own, so that one wins.
    useEffect(() => {
        if (!identity) return;
        const kept = takeKeptLinkedPost();
        if (!kept) return;
        setActiveTab('marketplace');
        setOpenMarketPostSaysWhy(false);
        setOpenMarketPostId(kept);
    }, [identity]);
    useEffect(() => {
        if (!identity || !linkedPost) return;
        setActiveTab('marketplace');
        setOpenMarketPostSaysWhy(false);
        setOpenMarketPostId(linkedPost);
        setLinkedPost(null);
    }, [identity, linkedPost]);

    // Load existing identity and initial community health on mount
    useEffect(() => {
        let mounted = true;

        loadIdentity()
            .then(id => { if (mounted) setIdentity(id); })
            .finally(() => { if (mounted) setLoading(false); });

        getCommunityHealth()
            .then(h => { if (mounted) setCommunityHealth({ ...h, online: true }); })
            .catch(() => { if (mounted) setCommunityHealth(prev => ({ ...prev, online: false })); });

        retryPendingReports().catch(() => {});
        const handleOnline = () => {
            retryPendingReports().catch(() => {});
        };
        window.addEventListener('online', handleOnline);

        return () => {
            mounted = false;
            window.removeEventListener('online', handleOnline);
        };
    }, []);

    /*
     * A member back from a provider (two-doors design §2.5): a sign-in this browser left to add to an account made with
     * 12 words. The answer is read and taken out of the address bar at once (captureAuthReturn), matched to the link this
     * browser started for this account, and finished; Settings opens with the result. A return nobody here started for
     * this account is dropped, and so is the link record: nothing else on a member's page takes a sign-in.
     */
    useEffect(() => {
        if (!identity) return;
        const ret = captureAuthReturn();
        if (!ret) return;
        consumeCapturedAuthReturn();
        if (!isLinkReturn(ret, identity)) {
            clearPendingLink();
            return;
        }
        let cancelled = false;
        finishLink(identity, ret).then((result) => {
            if (cancelled) return;
            setLinkResult(result);
            setSettingsInitialMode('menu');
            setShowSettings(true);
        });
        return () => { cancelled = true; };
    }, [identity]);

    // The account's block list, which the community keeps for it (lib/blocklist): read from the node now, again when the
    // node rings, and never kept in this browser. A list an older build kept here moves up to this account, once.
    useEffect(() => {
        if (!identity?.publicKey) return;
        return startBlocklist(identity.publicKey);
    }, [identity?.publicKey]);

    // Connect to BeanPool Node once identity is loaded
    useEffect(() => {
        if (!identity) return;

        // The node's alerts, live and kept for this member, are SystemAlerts' (below).
        connectToAnchor();
        // Membership for the guest/member UI, and the name: the node's name for this key is the member's, so this browser
        // takes it whenever the two differ (a join the node numbered or cut, a rename saved on the node and not here, a
        // restore while offline). A key that is no member is registered as before; a member never is, because that
        // register could only rename them back to this browser's copy (lib/member-name.ts).
        let cancelled = false;
        openWithNodeName(identity)
            .then(r => {
                if (cancelled) return;
                setIsGuest(!r.isMember);
                if (r.identity) setIdentity(r.identity);
            })
            // Unknown after a failed check: treat as a member so the pages waiting on it still load.
            .catch(() => { if (!cancelled) setIsGuest(prev => prev ?? false); });
        return () => { cancelled = true; };
    }, [identity]);

    // The identity in flight, read at await-resolution time rather than captured. The previous
    // guard compared `identity.publicKey !== currentPubkey` — both sides come from the same
    // closure, so it was always false and guarded nothing: a fetch resolving after a logout or an
    // account switch wrote the OLD account's transactions into the new one's view.
    const identityPubkeyRef = useRef<string | null>(null);
    useEffect(() => {
        identityPubkeyRef.current = identity?.publicKey ?? null;
        // Clear on switch or logout, so the next account never briefly renders the last one's
        // deals while its first fetch is still in flight.
        setMyTransactions([]);
        setPendingDealsCount(0);
        setTotalUnread(0);
    }, [identity?.publicKey]);

    const refreshTransactions = useCallback(async () => {
        if (!identity) return;
        const currentPubkey = identity.publicKey;
        try {
            const txs = await getMyMarketplaceTransactions(currentPubkey);
            if (identityPubkeyRef.current !== currentPubkey) return;
            setMyTransactions(txs);
            const activeDeals = txs.filter(t => t.status === 'pending').length;
            const pendingRequests = txs.filter(t => 
                t.buyerPublicKey === currentPubkey && t.status === 'requested'
            ).length;
            setPendingDealsCount(activeDeals + pendingRequests);
        } catch { /* offline */ }
    }, [identity?.publicKey]);

    // Poll unread message count and active deals
    useEffect(() => {
        if (!identity) return;
        let interval: ReturnType<typeof setInterval> | null = null;
        // Guards the awaits below: the effect re-runs on identity change, so without this a poll
        // started by the previous identity can resolve afterwards and write that member's counts
        // over the new one's — or set state on an unmounted tree.
        let cancelled = false;
        let lastPollTime = 0;
        let pollPromise: Promise<void> | null = null;

        const pollUnread = async () => {
            if (pollPromise) return pollPromise;
            const p = (async () => {
                try {
                    // Settled independently, not awaited in sequence. These were chained, so a failing
                    // /api/conversations threw out of the try before transactions were ever fetched —
                    // and since MarketplacePage stopped polling transactions itself and now reads them
                    // from here, one unrelated endpoint erroring starved the whole marketplace view.
                    const [convResult, txResult] = await Promise.allSettled([
                        getConversations(identity.publicKey),
                        getMyMarketplaceTransactions(identity.publicKey),
                    ]);
                    if (cancelled) return;

                    if (convResult.status === 'fulfilled') {
                        setTotalUnread(convResult.value.totalUnread || 0);
                    }

                    if (txResult.status === 'fulfilled') {
                        const txs = txResult.value;
                        setMyTransactions(txs);

                        const activeDeals = txs.filter(t => t.status === 'pending').length;

                        const pendingRequests = txs.filter(t =>
                            t.buyerPublicKey === identity.publicKey && t.status === 'requested'
                        ).length;

                        setPendingDealsCount(activeDeals + pendingRequests);
                    }

                    // Both failing means nothing was refreshed, so this must NOT count as a
                    // poll: stamping it would start the cooldown and suppress the retry, and it
                    // must reject so the coordinator does not advance the delta cursor past data
                    // that never arrived. One of the two failing is tolerated on purpose — that
                    // is why they are settled independently rather than chained.
                    if (convResult.status === 'rejected' && txResult.status === 'rejected') {
                        throw convResult.reason;
                    }
                    lastPollTime = Date.now();
                } finally {
                    pollPromise = null;
                }
            })();
            pollPromise = p;
            return p;
        };

        const startPolling = () => {
            if (!interval) {
                pollUnread().catch(() => {});
                interval = setInterval(() => {
                    pollUnread().catch(() => {});
                }, withJitter(300_000));
            }
        };

        const stopPolling = () => {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                stopPolling();
            } else {
                startPolling();
            }
        };

        if (!document.hidden) {
            startPolling();
        }

        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Fast path: update unread counts immediately on WebSocket activity.
        // The promise is RETURNED, not fired and forgotten: the coordinator only advances the
        // delta cursor when every listener resolved, so a listener that swallows its own
        // completion makes that check meaningless and lets the cursor move past data that
        // never arrived.
        // Coalesces with visibilitychange / reconnect sync if already in-flight or polled within 2000ms.
        const unsubscribe = onSyncActivity(() => {
            if (document.hidden) return;
            if (pollPromise) return pollPromise;
            if (Date.now() - lastPollTime < 2000) return;
            return pollUnread();
        });

        return () => {
            cancelled = true;
            stopPolling();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            unsubscribe();
        };
    }, [identity]);

    // Home first; the Pulse is a card on Home with its page one tap away, so Home takes its slot (design §8, §13 Q1).
    const TABS: { id: Tab; label: string; emoji: string }[] = [
        { id: 'home', label: 'Home', emoji: '🏠' },
        { id: 'marketplace', label: 'Market', emoji: '🤝' },
        { id: 'map', label: 'Map', emoji: '🗺️' },
        { id: 'projects', label: 'Commons', emoji: '🌱' },
        { id: 'messages', label: 'Chat', emoji: '💬' },
        { id: 'people', label: 'People', emoji: '👥' },
        { id: 'ledger', label: 'Ledger', emoji: '📊' },
    ];

    // The mobile header's title (none on the map, which shows the community's name), and the sync chip as its dot alone
    // where the title wouldn't fit beside the chip's words (a hook, so above the returns before the app).
    const headerTitle = activeTab !== 'map' || showSettings ? ((activeTab === 'pulse' ? 'The Pulse' : TABS.find(t => t.id === activeTab)?.label) ?? '') : null;
    const [headerRef, chipDotOnly] = useDotOnlyChip(headerTitle);

    if (loading || (!identity && visitorView.kind === 'checking')) {
        return (
            <div style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: '100vh',
                color: '#888',
                fontSize: '1.1rem',
            }}>
                Loading...
            </div>
        );
    }

    // First-run gate: the global lobby for a visitor with no key, where the node shows visitors its listings (G9b).
    if (!identity) {
        // Signed in here, with no reload: the account is this page's own from now (lib/account-epoch.ts), whatever
        // sign-out in another tab this page heard while it held no account.
        const signedInHere = (signedIn: BeanPoolIdentity) => {
            beginAccountEpoch();
            setIdentity(signedIn);
        };
        if (visitorView.kind === 'lobby') {
            return <GuestLobby info={visitorView.info} onComplete={signedInHere} linkedPostId={linkedPost} onLinkedPostTaken={clearLinkedPost} />;
        }
        // The node's answer, read once above, so the welcome page doesn't ask again; with none it asks, and says so.
        return (
            <>
                <FormerAddressBanner />
                <WelcomePage onComplete={signedInHere} initialInfo={visitorView.kind === 'welcome' ? visitorView.info ?? undefined : undefined} />
            </>
        );
    }

    // The community's status, opened from the header's title (or, on the map, its name).
    const communityStatus = showCommunityStatus && communityHealth && (
        <div 
            className="absolute top-full mt-2 bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-700 rounded-xl shadow-xl p-4 min-w-[220px] z-50 pointer-events-auto"
            onClick={e => e.stopPropagation()}
        >
            <div className="flex items-center gap-2 mb-3">
                <span className={`w-2.5 h-2.5 rounded-full ${communityHealth.online ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]'}`} />
                <span className="font-bold text-sm text-nature-900 dark:text-white">
                    {communityHealth.online ? 'Online' : 'Offline'}
                </span>
            </div>
            <div className="space-y-1.5 text-xs text-nature-600 dark:text-nature-300">
                <div className="flex justify-between">
                    <span>Node:</span>
                    <span className="font-mono font-semibold">{communityHealth.nodeName || communityHealth.callsign || 'Local'}</span>
                </div>
                <div className="flex justify-between">
                    <span>Members:</span>
                    <span className="font-mono font-semibold">{communityHealth.memberCount ?? communityHealth.tree?.totalMembers ?? 0}</span>
                </div>
                <div className="flex justify-between">
                    <span>Active Posts:</span>
                    <span className="font-mono font-semibold">{communityHealth.postCount ?? communityHealth.activity?.totalPosts ?? 0}</span>
                </div>
            </div>
            <button
                onClick={() => setShowCommunityStatus(false)}
                className="mt-3 w-full py-1 text-xs font-semibold text-center text-nature-500 dark:text-nature-400 hover:text-nature-800 dark:hover:text-white transition-colors"
            >
                Close
            </button>
        </div>
    );

    return (
        <div 
            className={`flex h-screen overflow-hidden text-text-primary ${!isBottomNavVisible ? 'bottom-nav-hidden' : ''}`}
            data-bottom-nav={isBottomNavVisible ? 'visible' : 'hidden'}
            style={{
                ...(!isBottomNavVisible ? {
                    '--bottom-nav-height': '0px',
                    '--bottom-nav-offset': 'calc(env(safe-area-inset-bottom, 0px) + var(--tour-bar-height, 0px))',
                } : {})
            } as React.CSSProperties}
        >
            {/* Desktop Left Sidebar (Visible on md and larger) */}
            <aside className="hidden md:flex flex-col w-64 shrink-0 bg-nature-50 dark:bg-nature-950 border-r border-nature-200 dark:border-nature-800 z-50">
                {/* Brand Logo Header */}
                <div className="p-4 border-b border-nature-200 dark:border-nature-800 flex items-center justify-between">
                    <div 
                        className="flex items-center gap-2 cursor-pointer"
                        onClick={() => {
                            setActiveTab('home');
                            setShowSettings(false);
                            setOpenProfilePubkey(null);
                        }}
                    >
                        <img src="/bean.png" alt="BeanPool Icon" className="w-9 h-9 object-contain drop-shadow-sm" />
                        <div className="flex flex-col">
                            <span className="font-extrabold text-xl tracking-tight text-rainbow">BeanPool</span>
                            <span
                                className="text-[10px] font-bold text-amber-700 dark:text-amber-500 tracking-wider"
                                aria-label={`Version ${displayVersion}`}
                            >v{displayVersion}</span>
                        </div>
                    </div>
                </div>

                {/* Navigation Tab Links */}
                <nav className="flex-1 p-3 space-y-1.5 overflow-y-auto">
                    {TABS.map((tab) => {
                        const isActive = activeTab === tab.id && !showSettings;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => {
                                    if (tab.id === 'marketplace') setMarketClickCount(c => c + 1);
                                    if (tab.id === 'people' && activeTab !== 'people') setPeopleSubView('friends');
                                    setActiveTab(tab.id);
                                    setShowSettings(false);
                                    setOpenProfilePubkey(null);
                                }}
                                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl font-bold text-sm transition-all duration-200 cursor-pointer ${
                                    isActive
                                        ? 'bg-nature-200 dark:bg-nature-800 text-nature-900 dark:text-white shadow-sm'
                                        : 'text-nature-600 dark:text-nature-400 hover:bg-nature-100 dark:hover:bg-nature-900 hover:text-nature-900 dark:hover:text-nature-200'
                                }`}
                            >
                                <div className="flex items-center gap-3">
                                    <span className="text-xl">{tab.emoji}</span>
                                    <span>{tab.label}</span>
                                </div>
                                {tab.id === 'messages' && totalUnread > 0 && (
                                    <span className="bg-bp-cta-fill text-bp-cta-on text-xs font-black px-2 py-0.5 rounded-full shadow-sm">
                                        {totalUnread > 99 ? '99+' : totalUnread}
                                    </span>
                                )}
                                {tab.id === 'marketplace' && pendingDealsCount > 0 && (
                                    <span className="bg-bp-cta-fill text-bp-cta-on text-xs font-black px-2 py-0.5 rounded-full shadow-sm">
                                        {pendingDealsCount}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </nav>

                {/* Sidebar Footer Controls */}
                <div className="p-3 border-t border-nature-200 dark:border-nature-800 space-y-2 bg-nature-100/50 dark:bg-nature-900/50">
                    <div className="flex items-center justify-between px-2 py-1">
                        <SyncStatus isMember={!isGuest} />
                        <SidebarControls showSettings={showSettings} setShowSettings={setShowSettings} />
                    </div>

                    {identity && (
                        <button
                            onClick={() => setOpenProfilePubkey(identity.publicKey)}
                            className="w-full flex items-center gap-2.5 p-2 rounded-xl bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 hover:border-nature-400 dark:hover:border-nature-600 transition-colors cursor-pointer text-left"
                        >
                            <div className="w-8 h-8 rounded-full bg-nature-200 dark:bg-nature-700 flex items-center justify-center font-bold text-xs text-nature-800 dark:text-nature-200 shrink-0">
                                {identity.callsign ? identity.callsign.substring(0, 2).toUpperCase() : 'ME'}
                            </div>
                            <div className="flex flex-col truncate">
                                <span className="font-bold text-xs truncate text-nature-900 dark:text-white">{identity.callsign || 'Anonymous'}</span>
                                <span className="text-[10px] text-nature-500 dark:text-nature-400">View Profile</span>
                            </div>
                        </button>
                    )}
                </div>
            </aside>

            {/* Main Content Viewport */}
            <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                {/* This page is older than the server it came from: Refresh loads the server's own (non-dismissible) */}
                {serverVersionAhead && (
                    <div
                        role="alert"
                        aria-live="assertive"
                        className="w-full bg-bp-gold-fill text-bp-gold-on px-3 sm:px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 shadow-md z-[120] text-sm font-medium border-b border-bp-gold-fill shrink-0"
                    >
                        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                            <span className="text-lg shrink-0" aria-hidden="true">⚠️</span>
                            <div className="leading-tight">
                                <span className="font-bold">BeanPool has been updated: </span>
                                <span className="text-xs sm:text-sm">
                                    this page is version {__APP_VERSION__} and your community now runs {serverVersionAhead}. Refresh to load it.
                                </span>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="px-3 py-1.5 bg-white text-amber-900 font-bold rounded-lg text-xs hover:bg-amber-50 active:scale-95 transition-all cursor-pointer border-none shadow-sm shrink-0"
                        >
                            Refresh
                        </button>
                    </div>
                )}

                {/* Opened at a name this community had before: where it lives now (lost-name L4). */}
                <FormerAddressBanner signedIn />

                {/* Header with Premium Dynamic AI Banner (Mobile only) */}
                <header ref={headerRef} className="relative shadow-md md:hidden" style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.3rem 0.75rem',
                    borderBottom: (activeTab === 'map' && !showSettings) ? 'none' : '1px solid #111',
                    position: (activeTab === 'map' && !showSettings) ? 'absolute' : 'sticky',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 100,
                    backgroundImage: "url('/assets/neon-vines-banner.png')",
                    backgroundSize: '150% auto',
                    backgroundPosition: 'center',
                }}>
                    <div className="absolute inset-0 bg-black/10 dark:bg-black/50 pointer-events-none" />

                    <div className="relative z-10 shrink-0" style={{ marginTop: '12px' }}>
                        <SyncStatus isMember={!isGuest} stacked dotOnly={chipDotOnly} />
                    </div>

                    {headerTitle !== null ? (
                        // The tab's own name, as the lobby's, in the room between the chip and the pill (never under either).
                        <HeaderTitle title={headerTitle} onClick={toggleCommunityStatus}>
                            {communityStatus}
                        </HeaderTitle>
                    ) : (
                        <div className="absolute left-1/2 -translate-x-1/2 flex justify-center items-center z-10">
                            <div 
                                className="relative flex items-center gap-1.5 pointer-events-auto cursor-pointer" 
                                style={{ transform: 'translateX(-12px) translateY(-2px)' }}
                                onClick={toggleCommunityStatus}
                            >
                                <img src="/bean.png" alt="BeanPool Icon" style={{ width: '40px', height: '40px', objectFit: 'contain' }} className="drop-shadow-sm" />
                                <span className="font-extrabold text-[1.6rem] tracking-tight text-rainbow drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">BeanPool</span>
                                <span
                                    className="absolute -right-6 bottom-0.5 text-[10px] font-bold text-amber-500 tracking-wider whitespace-nowrap"
                                    aria-label={`Version ${displayVersion}`}
                                >v{displayVersion}</span>
                            </div>
                            {communityStatus}
                        </div>
                    )}

                    <HeaderControls
                        showSettings={showSettings}
                        setShowSettings={setShowSettings}
                        identityPubkey={identity?.publicKey}
                        onOpenProfile={(pubkey) => setOpenProfilePubkey(pubkey)}
                    />
                </header>

                {/* Main Scrollable Canvas */}
                <main style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: (activeTab === 'map' && !showSettings) ? 'hidden' : 'auto',
                    paddingBottom: (activeTab === 'map' && !showSettings) ? '0' : 'var(--bottom-nav-offset)',
                    position: 'relative',
                }} className="md:pb-0">
                    {showSettings && (
                        // zIndex 100 ties the mobile header and bottom nav, so DOM order decides: Settings
                        // (in <main>) draws over the header before it, keeping its own Back tappable, and
                        // under the bottom nav after it, which stays usable. At 60 Back sat under the header.
                        // .page-overlay (index.css) places the layer: full bleed on a phone, but starting past
                        // the w-64 sidebar on md+, where covering it left it visible and swallowing clicks.
                        // zIndex stays inline — the stacking above is what this mount is about.
                        <div data-testid="settings-overlay" className="page-overlay" style={{ zIndex: 100, overflowY: 'auto' }}>
                            <SettingsPage
                                identity={identity}
                                onIdentityUpdated={(updated) => { setIdentity(updated); setShowSettings(false); }}
                                onBack={() => { setShowSettings(false); setLinkResult(null); }}
                                themePreference={themePreference}
                                onThemePreferenceChange={setThemePreference}
                                initialMode={settingsInitialMode}
                                initialGuidePage={settingsGuidePage}
                                linkResult={linkResult}
                                openOwnerWordsCheck={ownerWordsOpen}
                                onReRunSetup={() => { setShowSettings(false); setShowProfileSetup(true); }}
                                nodeVersion={communityHealth?.version?.trim() || undefined}
                            />
                        </div>
                    )}

                    {showProfileSetup && (
                        // 110: above the mobile header and the bottom nav (both 100), or the last step's Back sits under the nav.
                        <div data-testid="profile-setup-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 110, overflowY: 'auto', background: 'var(--bg-primary)' }}>
                            <ProfileSetup
                                identity={identity}
                                onDone={() => setShowProfileSetup(false)}
                                onIdentityUpdated={(updated) => setIdentity(updated)}
                            />
                        </div>
                    )}

                    {/* Tab content — always mounted when not in settings */}
                    {!showSettings && (
                        <>
                            {activeTab !== 'map' && (
                                <div className="max-w-xl mx-auto px-4 pt-2">
                                    <RecoveryAlertBanner identity={identity} />
                                    <OwnerWordsPrompt
                                        publicKey={identity?.publicKey}
                                        identity={identity}
                                        onCheckNow={() => { setSettingsInitialMode('menu'); setOwnerWordsOpen(true); setShowSettings(true); }}
                                    />
                                    {/* A member only: a guest has no standing here to read. A pause is never put away. */}
                                    {isGuest === false && <ModerationPauseCard refreshKey={standingKey} />}
                                    {/* The new account's limits and One way back show on Home only (rehearsal 14 Oct, S1): above
                                        every tab they pushed the Market, Commons and Ledger below the first screen at 320 px. */}
                                    {isGuest === false && activeTab === 'home' && !newAccountCardClosed && (
                                        <NewAccountCard onClose={closeNewAccountCard} />
                                    )}
                                    {/* Joined with 12 words alone, One way back is Home's `safety` card, in its place among the
                                        cards (pages/HomePage.tsx), and not repeated above the other tabs. */}
                                </div>
                            )}
                            {activeTab === 'map' && (
                                <Suspense fallback={<div className="flex-1 flex items-center justify-center">Loading map...</div>}>
                                    <MapPage
                                        identity={identity}
                                        openNewPost={openNewPost}
                                        initialGroupId={openNewPostGroupId}
                                        onOpenNewPostHandled={() => { setOpenNewPost(false); setOpenNewPostGroupId(undefined); }}
                                        onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)}
                                        onOpenTreasury={(pubkey) => setOpenTreasuryPubkey(pubkey)}
                                        isMember={isGuest === null ? null : !isGuest}
                                        covered={!!openTreasuryPubkey || !!openProfilePubkey}
                                        focusPostId={focusMapPostId}
                                        onFocusPostHandled={clearFocusMapPost}
                                        copyEventPostId={copyEventPostId}
                                        onCopyEventHandled={clearCopyEventPost}
                                        editEventPostId={editEventPostId}
                                        onEditEventHandled={clearEditEventPost}
                                    />
                                </Suspense>
                            )}
                            {activeTab === 'home' && (
                                <HomePage
                                    identity={identity}
                                    saveSearch={saveSearchToHome}
                                    onSaveSearchTaken={clearSaveSearch}
                                    onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)}
                                    onSeeWords={() => { setSettingsInitialMode('seed'); setShowSettings(true); }}
                                />
                            )}
                            {activeTab === 'marketplace' && (
                                <MarketplacePage
                                    identity={identity}
                                    marketClickCount={marketClickCount}
                                    openPostId={openMarketPostId}
                                    onPostOpened={() => setOpenMarketPostId(null)}
                                    sayWhenPostUnopened={openMarketPostSaysWhy}
                                    openReviewTxId={openMarketReviewTxId}
                                    onReviewOpened={() => setOpenMarketReviewTxId(null)}
                                    openSearch={openMarketSearch}
                                    onSearchOpened={clearMarketSearch}
                                    onSaveSearch={(settings) => { setSaveSearchToHome(settings); setActiveTab('home'); }}
                                    onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)}
                                    onOpenProfile={(pubkey) => setOpenProfilePubkey(pubkey)}
                                    transactions={myTransactions}
                                    onRefreshTransactions={refreshTransactions}
                                    isMember={isGuest === null ? null : !isGuest}
                                />
                            )}
                            {activeTab === 'pulse' && (
                                <PulsePage
                                    identity={identity}
                                    onOpenProfile={(pubkey) => setOpenProfilePubkey(pubkey)}
                                />
                            )}
                            {activeTab === 'messages' && <MessagesPage identity={identity} openConversationId={openConversationId} onConversationOpened={() => setOpenConversationId(null)} onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)} />}
                            {activeTab === 'people' && <PeoplePage identity={identity} initialView={peopleSubView} onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)} onOpenProfile={(pubkey) => setOpenProfilePubkey(pubkey)} />}
                            {activeTab === 'ledger' && (beansMode === 'preview'
                                ? <LedgerPreview onNearYou={() => setActiveTab('home')} onGuide={(slug) => navigateToTab('guide', slug)} />
                                : <LedgerPage identity={identity} onNavigate={navigateToTab} isMember={!isGuest} />)}
                            {activeTab === 'projects' && (
                                <ProjectsPage
                                    identity={identity}
                                    onOpenTreasury={(pubkey) => setOpenTreasuryPubkey(pubkey)}
                                    onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)}
                                    isMember={isGuest === null ? null : !isGuest}
                                />
                            )}
                        </>
                    )}

                    {openGroup && (
                        <GroupDetailModal
                            group={openGroup}
                            isOpen
                            onClose={() => setOpenGroup(null)}
                            myPubkey={identity?.publicKey}
                        />
                    )}
                    {openGroupVotes && (
                        <GroupVotesSheet groupId={openGroupVotes.groupId} canVote={openGroupVotes.canVote} myPubkey={identity?.publicKey ?? null} onClose={() => setOpenGroupVotes(null)} />
                    )}

                    {/* Treasury Detail Overlay */}
                    {openTreasuryPubkey && (
                        <TreasuryDetailPage
                            identity={identity}
                            isMember={!isGuest}
                            pubkey={openTreasuryPubkey}
                            onBack={() => setOpenTreasuryPubkey(null)}
                            onNavigatePost={(postId) => {
                                setOpenTreasuryPubkey(null);
                                navigateToTab('marketplace', postId);
                            }}
                            onOpenProfile={(pubkey) => setOpenProfilePubkey(pubkey)}
                        />
                    )}
                    {/* Public Profile Overlay — after the enterprise page: both stack at z-[110], so document order puts a
                        profile opened from a keeper row on top, and Back returns to the enterprise page. Leaving the
                        profile for anywhere else closes the enterprise page too. */}
                    {openProfilePubkey && (
                        <PublicProfilePage
                            identity={identity}
                            pubkey={openProfilePubkey}
                            onBack={() => setOpenProfilePubkey(null)}
                            onMessage={(pubkey) => {
                                setOpenProfilePubkey(null);
                                setOpenTreasuryPubkey(null);
                                navigateToTab('messages', pubkey);
                            }}
                            onNavigatePost={(postId) => {
                                setOpenProfilePubkey(null);
                                setOpenTreasuryPubkey(null);
                                navigateToTab('marketplace', postId);
                            }}
                            onEditProfile={() => {
                                setOpenProfilePubkey(null);
                                setOpenTreasuryPubkey(null);
                                setSettingsInitialMode('profile');
                                setShowSettings(true);
                            }}
                            onNavigateTab={(tab, subView) => {
                                setOpenProfilePubkey(null);
                                setOpenTreasuryPubkey(null);
                                // The 🏘️ sheet's How it works: a guide page, as every other screen opens one.
                                if (tab === 'guide') { navigateToTab('guide', subView); return; }
                                if (tab === 'people' && subView) {
                                    setPeopleSubView(subView as any);
                                }
                                setActiveTab(tab as any);
                                setShowSettings(false);
                            }}
                        />
                    )}

                </main>

                {/* Bottom nav — mobile only */}
                <nav 
                    // Visibility lives in the classes, never in `style`: an inline `display`
                    // beats `md:hidden`, which kept the bottom bar on screen next to the
                    // desktop sidebar at every width instead of swapping at 768px.
                    className={`relative bottom-nav-bar ${isBottomNavVisible ? 'flex' : 'hidden'} md:hidden`}
                    data-testid="mobile-bottom-nav"
                    style={{
                    position: 'fixed',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    backgroundImage: "url('/assets/neon-vines-banner.png')",
                    backgroundSize: '150% auto',
                    backgroundPosition: 'center',
                    borderTop: '1px solid #111',
                    zIndex: 100,
                    padding: '0.2rem 4px calc(0.2rem + env(safe-area-inset-bottom, 0px))',
                }}>
                    <div className="absolute inset-0 bg-black/30 pointer-events-none" />
                    <div className="relative z-10 w-full flex gap-px sm:gap-1">
                    {TABS.map((tab) => {
                        const isActive = activeTab === tab.id && !showSettings;
                        return (
                        <button
                            key={tab.id}
                            onClick={() => {
                                if (tab.id === 'marketplace') {
                                    setMarketClickCount(c => c + 1);
                                }
                                if (tab.id === 'people' && activeTab !== 'people') {
                                    setPeopleSubView('friends');
                                }
                                setActiveTab(tab.id);
                                setShowSettings(false);
                                setOpenProfilePubkey(null);
                            }}
                            style={{
                                // Width follows label length (floor 4, the emoji's width), so "Commons"
                                // gets the room it needs instead of every tab shrinking to fit it.
                                flexGrow: navTabWeight(tab.label),
                                flexShrink: 1,
                                flexBasis: 0,
                                minWidth: 0,
                                padding: 0,
                                background: 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                            }}
                        >
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                margin: '0 auto',
                                width: '100%',
                                gap: '0.1rem',
                                padding: '0.15rem 0',
                                borderRadius: '10px',
                                background: 'rgba(0,0,0,0.45)',
                                border: '1px solid rgba(255,255,255,0.05)',
                                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                                color: isActive ? undefined : '#fefefe',
                                transition: 'all 0.2s',
                            }}>
                                <span className="text-dark-aura" style={{ fontSize: '1.5rem', position: 'relative' }}>
                                    {tab.emoji}
                                    {tab.id === 'messages' && totalUnread > 0 && (
                                        <span style={{
                                            position: 'absolute',
                                            top: '-6px',
                                            right: '-10px',
                                            background: 'var(--danger)',
                                            color: 'var(--on-danger, #fff)',
                                            fontSize: '0.6rem',
                                            fontWeight: 700,
                                            minWidth: '16px',
                                            height: '16px',
                                            borderRadius: '8px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            padding: '0 3px',
                                            lineHeight: 1,
                                            boxShadow: '0 0 6px var(--danger)',
                                            textShadow: 'none',
                                        }}>
                                            {totalUnread > 99 ? '99+' : totalUnread}
                                        </span>
                                    )}
                                    {tab.id === 'marketplace' && pendingDealsCount > 0 && (
                                        <span style={{
                                            position: 'absolute',
                                            top: '-6px',
                                            right: '-10px',
                                            background: 'var(--danger)',
                                            color: 'var(--on-danger, #fff)',
                                            fontSize: '0.6rem',
                                            fontWeight: 700,
                                            minWidth: '16px',
                                            height: '16px',
                                            borderRadius: '8px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            padding: '0 3px',
                                            lineHeight: 1,
                                            boxShadow: '0 0 6px var(--danger)',
                                            textShadow: 'none',
                                        }}>
                                            {pendingDealsCount}
                                        </span>
                                    )}
                                </span>
                                {/* 0.6rem alone scales with the user's text size and cut "Market"/"Commons"
                                    to "Mar…"/"Co…" on a 320px phone at 1.3x. The vw cap keeps whole labels
                                    there; wider screens still get the full 0.6rem. */}
                                <span data-nav-label className={`${isActive ? 'text-rainbow text-dark-aura font-extrabold' : 'text-dark-aura font-semibold'} truncate max-w-full text-center`} style={{ fontSize: NAV_LABEL_FONT_SIZE, lineHeight: 1.1 }}>
                                    {tab.label}
                                </span>
                            </div>
                        </button>
                        );
                    })}
                    </div>
                </nav>
            </div>

            {/* The node's alerts: live, and the moderation notices kept while the web app was closed. */}
            <SystemAlerts memberPubkey={identity?.publicKey} isGuest={isGuest} onShown={onAlertShown} />

            {/* The tour's bar over the real tabs, and the "?"'s dialog (DESIGN-getting-started-fable.md §2, §4). */}
            {tourRunning && (
                <TourBar
                    steps={steps}
                    index={tourIndex}
                    home={activeTab === 'home' ? tourHomeNow : null}
                    onNext={() => moveTour(tourIndex + 1)}
                    onSkip={() => finishTour('skipped')}
                    onDone={() => finishTour('done')}
                />
            )}
            {helpOpen && (
                <HelpDialog
                    sheet={helpWords}
                    tourOpen={tourRunning}
                    canTour={!!identity && !isGuest}
                    onClose={() => setHelpOpen(false)}
                    onReadPage={() => {
                        setHelpOpen(false);
                        setSettingsGuidePage(helpWords.slug);
                        setSettingsInitialMode('guide');
                        setShowSettings(true);
                    }}
                    onSearch={() => {
                        setHelpOpen(false);
                        setSettingsGuidePage(null);
                        setSettingsInitialMode('guide');
                        setShowSettings(true);
                    }}
                    onTour={() => {
                        setHelpOpen(false);
                        if (!identity || tourRunning) return;
                        // Take the tour again: Home opens it on the account (`open`) and puts its card back.
                        setShowSettings(false);
                        setActiveTab('home');
                        askTourAgain(identity.publicKey);
                    }}
                />
            )}

            {/* PWA Install Banner */}
            <InstallPrompt hidden={installHeldBack} />
        </div>
    );
}
