import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View, Text, ScrollView, Pressable, RefreshControl, StyleSheet, Animated, AccessibilityInfo, AppState, DeviceEventEmitter,
    Alert, ActivityIndicator, Platform, useWindowDimensions, type NativeSyntheticEvent, type NativeScrollEvent,
} from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import {
    TIPS_ALL_SEEN, dismissTips, emptyTipsRecord, homeCardType, localDay, nextTip, normalizeCategory, allTipsSeen, restartTips, tipNow, tipOnLanding,
    tipsCaption, tipsFor, type TipsRecord,
} from '@beanpool/core';
import { useTheme } from '../ThemeContext';
import { useIdentity } from '../IdentityContext';
import { PageTitle, useTabRetapScrollTop } from '../../components/PageTitle';
import { OneWayBackCard } from '../../components/OneWayBackCard';
import { NewPostTypeSheet } from '../../components/NewPostTypeSheet';
import { NewPollModal } from '../../components/NewPollModal';
import { NewEventModal } from '../../components/NewEventModal';
import { goToNeedsTarget } from '../../components/NeedsYouIcons';
import { useManageNode } from '../../components/useManageNode';
import { FabBandContext, HomeCard, HomeButton, homeStyles, type FabBand } from '../../components/home/HomeParts';
import { HomeCardMenu } from '../../components/home/HomeCardMenu';
import { EditHomeSheet } from '../../components/home/EditHomeSheet';
import { AddCardSheet } from '../../components/home/AddCardSheet';
import { CardSettingsSheet } from '../../components/home/CardSettingsSheet';
import { FindCommunityBody } from '../../components/home/FindCommunityBody';
import {
    BeansBody, CommunityBody, DealsBody, DecideBody, EnterpriseBody, EventsBody, GroupsBody, InterestsBody, InviteBody, JoinedBody,
    MarketBody, NeedsBody, NoticesBody, PulseBody, SearchBody, StepsBody, TipsBody,
} from '../../components/home/HomeCardBodies';
import {
    FEWER_CARDS_LINE, HOME_DOORBELL_SETTLE_MS, HOME_HINT_LINE, HOME_SAFETY_POLL_MS, addCard, addedLine, askPinned, canMoveCard, canRemoveCard,
    canTailor, cardCaption, cardName, cardOrder, cardsToAsk, cardsToDraw, changeCardSettings, createDoorbellDebounce, dismissSafety,
    effectiveInterests, fewerCardsNews, firstSteps, invitesForReader, localNeeds, marketForward, marketInOrder, mergeNeeds, moveCard,
    pickLayout, pickerGroups, pinnedCards, removeCard, removedLine, safetyWord, starredFirst,
    type HomeCardInstance, type HomeLayout, type HomeRole, type LocalNeeds, type PickerRow, type StepLine,
} from '../../utils/home-cards';
import {
    SAVE_REFUSED, SAVE_SHAPE_REFUSED, loadHome, markSeenOnce, readPhoneInterests, readPhoneLayout, readStoredHome, reconcileInterests,
    readTips, saveHomePreferences, saveInterests, seenOnce, writePhoneLayout, writeTips, yieldPhoneLayout, type HomePoint, type StoredHome,
} from '../../utils/home-store';
import { readGlobalHome } from '../../utils/community-directory';
import { rememberedKnocks, type RememberedKnock } from '../../utils/knock';
import { getCachedNodeProfile } from '../../utils/node-profile';
import { homeAccount, stillOnPhone, type HomeAccount } from '../../utils/home-account';
import { fabStepsAsideAny, type CardActionsAt } from '../../utils/fab-band';
import { anchorUrl, signedGet, signedPost } from '../../utils/node-post';
import { cachedNodeRole } from '../../utils/node-admin';
import { getMarketplaceTransactions, getUnreadByConversation } from '../../utils/db';
import { composeTargetFor } from '../../utils/compose-options';
import type { NeedsYouEntry } from '../../utils/needs-you';

/**
 * Home (scratch/global-node/DESIGN-home-dashboard-fable.md, slice H2): the screen the app opens on. A short list of cards
 * answering what needs me, what's alive around me, and what I could do next, each a line or three and one tap into a
 * screen that already exists. The rules are utils/home-cards.ts; the request and the copies are utils/home-store.ts.
 *
 * - **Drawn at once** from the answer the phone kept, then **one signed read** (`GET /api/home`, a 304 when nothing
 *   changed). Read again on returning to Home, on a pull, once after a burst of doorbells that matter to it (3 s), and
 *   every two minutes while it is in front: never a timer per card.
 * - **Nothing here waits on the network or blocks anything** (memory onboarding-no-hard-gates): with no answer yet and
 *   none kept, it says so plainly and the tabs work as ever.
 * - **Tailoring** (scratch/home/CARD-FRAME-DESIGN-fable.md, slice F2): a member's Home is a list of cards they own. Add a
 *   card (the picker) and Edit home at the bottom; each card's "…" (Settings…, Move up, Move down, Remove); kept on the
 *   account (`home.layout` version 2). A card added lands first and is read for once its save is answered (§2.4). A node
 *   from before the frame refuses the new shape: the cards stay on the phone, "not on your account yet", and are sent
 *   again at each landing (§2.3). A member's only: a visitor (a key with no account on the global node, which answers
 *   with its public cards) gets none of it, no hint, and no layout is ever sent for one.
 * - **The one-time reveal** (~300 ms, skipped when the phone asks for less motion) and its one-line hint (§6.2).
 * - **Where only the community's admins invite** (`door: 'admins'`), Grow your community and First steps' invite line are
 *   an owner's or admin's alone (PR #1483 review 4166559683): the role is the header's ten-minute copy
 *   (utils/node-admin.ts `cachedNodeRole`), asked only on such a node.
 * - **Nothing is written for an account that has left the phone** (PR #1483 review 4166559191): each landing and edit
 *   takes the account as it begins (utils/home-account.ts), and what it keeps (the answer, the layout, the stars, the
 *   reveal and hint) is kept only while that account is still the one on the phone.
 * - **"+ ADD POST"** floats as on the Market, and steps aside while a card's buttons, chips or links rest under it.
 * - **The global node** (slice H4): Find your community is a card here (the Market no longer draws it), pinned at the top
 *   and with no "…" for the member's first 30 days; First steps says the global words and the new-account limits; Who
 *   joined is a count; "Near you" lists the nearest first. Only there, the read carries the phone's last known place to
 *   about a kilometre, read only where location is already allowed (Home never asks for it), as the Market's card did;
 *   and only there, the knocks this phone sent are read, for the card's answers and First steps' ask.
 */

type Status = 'loading' | 'ok' | 'offline' | 'members_only' | 'no_community' | 'needs_update';

const REVEAL_MS = 300;

/** A sheet opened as another closes: iOS can't present one modal while the last is still going (Android can). */
const afterModal = (fn: () => void) => (Platform.OS === 'ios' ? void setTimeout(fn, 350) : fn());

/** The settings sheet's subject: a card about to be added, or one on Home being changed in place. */
type SettingsFor = { type: string; mode: 'add' } | { type: string; mode: 'save'; id: string; settings?: Record<string, unknown> };

/** The phone's last known place, only where location is already allowed: Home never asks for it. Null otherwise. */
async function lastKnownPlace(): Promise<HomePoint | null> {
    try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') return null;
        const last = await Location.getLastKnownPositionAsync();
        return last ? { lat: last.coords.latitude, lng: last.coords.longitude } : null;
    } catch {
        return null;
    }
}

/**
 * Whether the community Home reads is the global node, by what the phone already knows (no request): the answer it kept,
 * or its copy of the node's profile (utils/node-profile.ts, which the tab strip keeps current). A local community is never
 * sent a point: it would change what it answers (a distance on each listing).
 */
async function readsGlobal(url: string, kept: StoredHome | null): Promise<boolean> {
    if (kept?.answer.profile === 'global') return true;
    if (kept) return false;
    return (await getCachedNodeProfile(url).catch(() => null))?.profile === 'global';
}

export default function HomeScreen() {
    const { colors } = useTheme();
    const { identity } = useIdentity();
    const { height: winH } = useWindowDimensions();
    const s = homeStyles(colors);
    const manage = useManageNode();

    // The map's "My deals" (app/(tabs)/map.tsx, left as it is) links to `/` with the deals: passed on to the Market.
    const params = useLocalSearchParams<{ tab?: string; dealsTab?: string }>();
    useEffect(() => {
        const forward = marketForward(params);
        if (!forward) return;
        router.setParams({ tab: '', dealsTab: '' });
        router.navigate({ pathname: '/(tabs)/market', params: forward });
    }, [params.tab, params.dealsTab]);

    const [url, setUrl] = useState<string | null>(null);
    const [stored, setStored] = useState<StoredHome | null>(null);
    const [status, setStatus] = useState<Status>('loading');
    const [layout, setLayout] = useState<HomeLayout | null>(null);
    const [interests, setInterests] = useState<string[]>([]);
    // The interests card stays while Home is in front once it is up (opened from "Tune", or shown because nothing was
    // starred): the first star must not take away the card the member is picking "a few" on. It goes on leaving Home.
    const [tuneOpen, setTuneOpen] = useState(false);
    const [safetyUp, setSafetyUp] = useState(false);
    const [local, setLocal] = useState<LocalNeeds | null>(null);
    const [menuFor, setMenuFor] = useState<HomeCardInstance | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const [addOpen, setAddOpen] = useState(false);
    const [settingsFor, setSettingsFor] = useState<SettingsFor | null>(null);
    /** A node from before the frame refused the member's cards: they stay on the phone and are sent again (§2.3). */
    const [notOnAccount, setNotOnAccount] = useState(false);
    /** The one-time "Home now starts with fewer cards" line (§2.6). */
    const [fewer, setFewer] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [offlineNote, setOfflineNote] = useState(false);
    const [postPicker, setPostPicker] = useState(false);
    const [pollModal, setPollModal] = useState(false);
    const [eventModal, setEventModal] = useState(false);
    const [hint, setHint] = useState(false);
    /** The member's role here, asked only where only admins invite (undefined: not heard, so no invite asked of them). */
    const [role, setRole] = useState<HomeRole>(undefined);
    /** On the global node: the place the last read was measured from (the phone's, where allowed), and this phone's knocks. */
    const [place, setPlace] = useState<HomePoint | null>(null);
    const [knocks, setKnocks] = useState<RememberedKnock[]>([]);
    /** The Tips card's record for this account (@beanpool/core home-tips.ts); null: not read yet, so no card. */
    const [tips, setTips] = useState<TipsRecord | null>(null);
    const tipsRef = useRef<TipsRecord | null>(null);
    const roleRef = useRef<HomeRole>(undefined);
    roleRef.current = role;

    const identityRef = useRef(identity);
    identityRef.current = identity;
    const storedRef = useRef<StoredHome | null>(null);
    const phoneLayout = useRef<HomeLayout | null>(null);
    const layoutRef = useRef<HomeLayout | null>(null);
    layoutRef.current = layout;
    const focused = useRef(false);
    const scrollRef = useRef<ScrollView>(null);
    const cardY = useRef(new Map<string, number>());
    const menuRefs = useRef(new Map<string, React.RefObject<View | null>>());
    const menuRef = (id: string) => {
        let r = menuRefs.current.get(id);
        if (!r) { r = React.createRef<View | null>(); menuRefs.current.set(id, r); }
        return r;
    };
    useTabRetapScrollTop(scrollRef);

    // ── The floating button's band ──
    const scrollY = useRef(0);
    const regions = useRef(new Map<string, CardActionsAt>());
    const [fabAside, setFabAside] = useState(false);
    const [bandVersion, setBandVersion] = useState(0);
    const updateFab = useCallback(() => {
        const aside = fabStepsAsideAny(regions.current.values(), scrollY.current, winH);
        setFabAside(prev => (prev === aside ? prev : aside));
    }, [winH]);
    useEffect(() => { updateFab(); }, [updateFab]);
    const band: FabBand = useMemo(() => ({
        report: (key, at) => {
            if (at) regions.current.set(key, { ...at, scrollY: scrollY.current });
            else regions.current.delete(key);
            updateFab();
        },
        version: bandVersion,
    }), [bandVersion, updateFab]);
    const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        scrollY.current = e.nativeEvent.contentOffset.y;
        updateFab();
    }, [updateFab]);

    // ── The reveal and the hint (§6.2): once per account, never again ──
    const reveal = useRef(new Animated.Value(1)).current;
    const revealChecked = useRef<string | null>(null);
    const maybeReveal = useCallback(async (whose: HomeAccount) => {
        if (revealChecked.current === whose.publicKey) return;
        revealChecked.current = whose.publicKey;
        if (await seenOnce(whose.publicKey, 'reveal')) return;
        if (!stillOnPhone(whose)) return;
        void markSeenOnce(whose, 'reveal');
        if (!(await seenOnce(whose.publicKey, 'hint')) && stillOnPhone(whose)) {
            setHint(true);
            void markSeenOnce(whose, 'hint');
        }
        const calm = await AccessibilityInfo.isReduceMotionEnabled().catch(() => true);
        if (calm) return;
        reveal.setValue(0);
        Animated.timing(reveal, { toValue: 1, duration: REVEAL_MS, useNativeDriver: true }).start(() => setBandVersion(v => v + 1));
    }, [reveal]);

    // A member who never edited, here before the frame: one line, once (§2.6).
    const maybeFewer = useCallback(async (whose: HomeAccount) => {
        if (await seenOnce(whose.publicKey, 'fewer')) return;
        if (!stillOnPhone(whose) || identityRef.current?.publicKey !== whose.publicKey) return;
        setFewer(true);
        void markSeenOnce(whose, 'fewer');
    }, []);

    // ── The phone's own Needs you lines: its database, no request ──
    const readLocal = useCallback(async (me: string) => {
        const settle = <T,>(p: Promise<T>) => p.catch(() => null);
        const [transactions, conversations] = await Promise.all([
            settle(getMarketplaceTransactions(me)),
            settle(getUnreadByConversation(me)),
        ]);
        setLocal(localNeeds(me, Date.now(), transactions, conversations));
    }, []);

    // ── The layout: the phone's copy at once, the account's once it is saved ──
    const pushLayout = useCallback(async (next: HomeLayout, whose: HomeAccount) => {
        const id = identityRef.current;
        const u = storedRef.current?.url ?? url;
        if (!id || !u || id.publicKey !== whose.publicKey || !stillOnPhone(whose)) return;
        const saved = await saveHomePreferences(u, id, { layout: next });
        // The account left the phone while the save was out: nothing of it is drawn or kept.
        if (!stillOnPhone(whose)) return;
        const answered = storedRef.current?.answer;
        if (saved === SAVE_SHAPE_REFUSED && (!answered?.layout || answered.layoutV1)) {
            // A node from before the frame (its Home answer is version 1): the cards stay on the phone and are sent again at
            // each landing, never thrown away (CARD-FRAME §2.3).
            setNotOnAccount(true);
            return;
        }
        if (saved === SAVE_REFUSED || saved === SAVE_SHAPE_REFUSED) {
            // The node won't keep it: the account's copy stands, and the phone's is never sent again by itself.
            const account = storedRef.current?.answer.layout ?? null;
            phoneLayout.current = account;
            setLayout(account);
            await yieldPhoneLayout(id.publicKey, u, account, whose);
            return;
        }
        if (saved) setNotOnAccount(false);
        // The node keeps the newer layout (another phone's, the web app's): that one, then.
        if (saved?.layout && (saved.layout.updatedAt ?? '') > (next.updatedAt ?? '')) {
            phoneLayout.current = saved.layout;
            setLayout(saved.layout);
            await writePhoneLayout(id.publicKey, u, saved.layout, whose);
        }
    }, [url]);

    // ── Tips (scratch/home/TIPS-DESIGN-fable.md): the record is the phone's, per account ──
    const keepTips = useCallback((whose: HomeAccount, next: TipsRecord) => {
        if (!stillOnPhone(whose)) return;
        tipsRef.current = next;
        setTips(next);
        void writeTips(whose, next);
    }, []);
    // A return to Home's once-a-day advance, from the answer in hand (the kept one counts: tips work with no connection): a
    // tip first shown on an earlier day is marked seen and the next one drawn. With no answer in hand, the record as it is,
    // so the card can be drawn when one comes; it moves on the next return. Only a return lands (PR #1694 review 1).
    const landTips = useCallback(async (whose: HomeAccount) => {
        const record = await readTips(whose.publicKey);
        if (!stillOnPhone(whose) || identityRef.current?.publicKey !== whose.publicKey) return;
        const ans = storedRef.current?.answer;
        const next = ans?.me ? tipOnLanding(record, tipsFor(ans, roleRef.current), localDay()).record : record;
        if (next === record) { tipsRef.current = record; setTips(record); } else keepTips(whose, next);
    }, [keepTips]);

    // ── Reading Home ──
    // `focus` is a return to Home (the tab, the app coming back, another account): the only read that moves the Tips card.
    // `again` is a read while Home stays in front after the member's own step there (a notice opened, a poll or event made).
    const refresh = useCallback(async (why: 'focus' | 'pull' | 'bell' | 'poll' | 'layout' | 'again') => {
        const id = identityRef.current;
        if (!id) return;
        const whose = homeAccount(id.publicKey);
        const raw = await anchorUrl().catch(() => null);
        if (!raw) { setStatus('no_community'); return; }
        const u = raw.replace(/\/+$/, '');
        void readLocal(id.publicKey);
        let cached = storedRef.current;
        if (!cached || cached.url !== u || cached.publicKey !== id.publicKey) {
            // Another community or account than the one drawn: its own copies, drawn before the network answers.
            const [copy, mine, phoneStars] = await Promise.all([readStoredHome(id.publicKey, u), readPhoneLayout(id.publicKey, u), readPhoneInterests()]);
            cached = copy;
            storedRef.current = copy;
            phoneLayout.current = mine;
            setUrl(u);
            setRole(undefined);
            setPlace(null);
            setKnocks([]);
            setStored(copy);
            setLayout(canTailor(copy?.answer) ? pickLayout(copy!.answer.layout, mine, copy!.answer.layoutV1).layout : null);
            setNotOnAccount(false);
            setFewer(false);
            setInterests(effectiveInterests(copy?.answer.me?.interests, phoneStars));
            setStatus(copy ? 'ok' : 'loading');
        }
        // The Tips card lands on this return from the answer in hand, before the network is asked: never on what a read
        // brings later (a 304 or no answer changes nothing, and nothing moves while Home is in front). With none in hand
        // (the first landing), from what this read brings, at its end.
        const tipsLandNow = why === 'focus' && !!cached?.answer.me;
        if (tipsLandNow) void landTips(whose);
        const asked = cardsToAsk(pickLayout(cached?.answer.layout ?? null, phoneLayout.current, cached?.answer.layoutV1).layout, askPinned(cached?.answer, Date.now()));
        // The global node only: "near you" from where the phone is (where location is already allowed).
        const global = await readsGlobal(u, cached);
        const point = global ? await lastKnownPlace() : null;
        if (identityRef.current?.publicKey !== id.publicKey || !stillOnPhone(whose)) return;
        setPlace(was => (was?.lat === point?.lat && was?.lng === point?.lng ? was : point));
        const read = await loadHome(u, id, asked, cached, { whose, point });
        // Another account on the screen, or this one gone from the phone while the read was out (Sign Out, Replace).
        if (identityRef.current?.publicKey !== id.publicKey || read.kind === 'left' || !stillOnPhone(whose)) return;
        if (read.kind === 'answer') {
            storedRef.current = read.stored;
            setStored(read.stored);
            setStatus('ok');
            setOfflineNote(false);
            // A visitor keeps no Home here: drawn in the default order, and nothing is sent.
            const member = canTailor(read.stored.answer);
            const answered = read.stored.answer;
            const pick = member ? pickLayout(answered.layout, phoneLayout.current, answered.layoutV1) : { layout: null, push: false };
            setLayout(pick.layout);
            if (member && fewerCardsNews(answered.layout, phoneLayout.current, answered.me, Date.now())) void maybeFewer(whose);
            // The account's list asks for cards this read didn't (a first landing on this phone, or another device's edit):
            // one more read for them, never more (a `layout` read doesn't ask again).
            const wanted = cardsToAsk(pick.layout, askPinned(answered, Date.now()));
            if (member && why !== 'layout' && wanted.some(c => !asked.includes(c))) void refreshRef.current('layout');
            if (pick.push && pick.layout) void pushLayout(pick.layout, whose);
            else if (pick.layout && !answered.layoutV1) {
                // A version-1 copy is drawn and never kept as the phone's: it is not written until the member edits (§2.6),
                // and it must never stand in for the phone's own version 2 (review of #1697, note b).
                phoneLayout.current = pick.layout;
                void writePhoneLayout(id.publicKey, u, pick.layout, whose);
            }
            // Tips land with the other cards, not after the interests save below (up to 15 s on a first landing).
            if (why === 'focus' && !tipsLandNow) void landTips(whose);
            if (read.stored.answer.me) {
                // A star tapped while the node answered is newer than the answer's interests. Judged by when the read was
                // sent, not by this landing: one that joined a read already out gets that read's mark (home-store.ts).
                const drawn = await reconcileInterests(u, id, read.stored.answer.me.interests, read.since);
                if (stillOnPhone(whose)) setInterests(drawn);
            }
            if (member) void maybeReveal(whose);
            if (member && read.stored.answer.features.door === 'admins') {
                void cachedNodeRole(u, id).then(r => { if (stillOnPhone(whose) && identityRef.current?.publicKey === id.publicKey) setRole(r.role); });
            }
            // The knocks this phone sent, on the global node (where a member asks a local community to let them in).
            if (member && read.stored.answer.profile === 'global') {
                void rememberedKnocks(id.publicKey).catch(() => [] as RememberedKnock[]).then(list => {
                    if (stillOnPhone(whose) && identityRef.current?.publicKey === id.publicKey) setKnocks(list);
                });
            }
            if (why === 'pull') AccessibilityInfo.announceForAccessibility('Home updated');
        } else if (read.kind === 'members_only') {
            setStatus('members_only');
        } else if (read.kind === 'needs_update') {
            setStatus('needs_update');
            storedRef.current = null;
            setStored(null);
            setOfflineNote(false);
            if (why === 'pull') AccessibilityInfo.announceForAccessibility("This community's server needs an update before Home works. Market and Talk still work.");
        } else {
            setStatus(storedRef.current ? 'ok' : 'offline');
            setOfflineNote(!!storedRef.current);
            if (why === 'pull') AccessibilityInfo.announceForAccessibility("Couldn't reach your community; showing what we had");
        }
        // No answer this time (offline, members only, needs an update): land from what the phone holds.
        if (why === 'focus' && !tipsLandNow && read.kind !== 'answer') await landTips(whose);
    }, [readLocal, pushLayout, maybeReveal, maybeFewer, landTips]);

    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;

    // On landing and on returning to Home; the two-minute backstop while Home is in front and the app is open.
    useFocusEffect(useCallback(() => {
        focused.current = true;
        void refreshRef.current('focus');
        const poll = setInterval(() => { if (AppState.currentState === 'active') void refreshRef.current('poll'); }, HOME_SAFETY_POLL_MS);
        return () => { focused.current = false; clearInterval(poll); setTuneOpen(false); };
    }, []));

    // The app coming back while Home is in front, and the doorbells that matter to Home (one read after a burst).
    useEffect(() => {
        const bell = createDoorbellDebounce(() => {
            if (focused.current && AppState.currentState === 'active') void refreshRef.current('bell');
        }, HOME_DOORBELL_SETTLE_MS);
        const ws = DeviceEventEmitter.addListener('ws_activity', (data: unknown) => { if (focused.current) bell.ring(data); });
        const app = AppState.addEventListener('change', st => { if (st === 'active' && focused.current) void refreshRef.current('focus'); });
        return () => { bell.cancel(); ws.remove(); app.remove(); };
    }, []);

    // Another account on the phone (or the account loading after the screen did) starts from nothing, and reads its own
    // Home at once when Home is in front.
    const shownFor = useRef(identity?.publicKey);
    useEffect(() => {
        if (shownFor.current === identity?.publicKey) return;
        shownFor.current = identity?.publicKey;
        storedRef.current = null;
        phoneLayout.current = null;
        setStored(null);
        setLayout(null);
        setNotOnAccount(false);
        setFewer(false);
        setRole(undefined);
        setPlace(null);
        setKnocks([]);
        tipsRef.current = null;
        setTips(null);
        setStatus('loading');
        if (focused.current) void refreshRef.current('focus');
    }, [identity?.publicKey]);

    const onPull = useCallback(async () => {
        setRefreshing(true);
        try { await refresh('pull'); } finally { setRefreshing(false); }
    }, [refresh]);

    // ── Tips: Next, Don't show, and Edit home's switch ──
    const onTipNext = useCallback(() => {
        const id = identityRef.current;
        const ans = storedRef.current?.answer;
        if (!id || !ans || !tipsRef.current) return;
        const step = nextTip(tipsRef.current, tipsFor(ans, role), localDay());
        keepTips(homeAccount(id.publicKey), step.record);
        AccessibilityInfo.announceForAccessibility(step.view ? step.view.tip.text : 'That was the last tip. Add a card brings them back.');
    }, [role, keepTips]);

    // ── The member's edits ──
    // `reread`: a card's settings changed or a card was added, so Home is read again, but only once the save is answered:
    // the node builds an instance from the settings it keeps, and a read sent before them answers no body (CARD-FRAME
    // §2.4). A move or a remove reads nothing.
    const changeLayout = useCallback((next: HomeLayout | null, opts: { reread?: boolean } = {}) => {
        const id = identityRef.current;
        if (!next || !id || !url || !canTailor(storedRef.current?.answer)) return;
        const before = layoutRef.current;
        const whose = homeAccount(id.publicKey);
        phoneLayout.current = next;
        layoutRef.current = next;
        setLayout(next);
        void writePhoneLayout(id.publicKey, url, next, whose);
        const saving = pushLayout(next, whose);
        const pins = askPinned(storedRef.current?.answer, Date.now());
        const asksMore = cardsToAsk(next, pins).some(c => !cardsToAsk(before, pins).includes(c));
        if (asksMore || opts.reread) void saving.then(() => refreshRef.current('layout'));
    }, [url, pushLayout]);
    // "Don't show tips again", and Remove on Tips: the record says so and the card leaves the list, so the member's other
    // devices follow.
    const onTipsDontShow = useCallback(() => {
        const id = identityRef.current;
        if (!id) return;
        keepTips(homeAccount(id.publicKey), dismissTips(tipsRef.current ?? emptyTipsRecord(), new Date().toISOString()));
        setHint(false);
        changeLayout(removeCard(layoutRef.current, 'tips', Date.now(), pinnedCards(storedRef.current?.answer, Date.now())));
        AccessibilityInfo.announceForAccessibility(removedLine(cardName('tips')));
    }, [keepTips, changeLayout]);
    // Tips added from the picker, or Reset to defaults while they were off: the tips start over from the first one.
    const onTipsOn = useCallback(() => {
        const id = identityRef.current;
        const ans = storedRef.current?.answer;
        if (id) keepTips(homeAccount(id.publicKey), restartTips(ans ? tipsFor(ans, roleRef.current) : [], localDay()));
    }, [keepTips]);

    // ── Adding, removing, and a card's settings (CARD-FRAME §1.3) ──
    const addNow = useCallback((type: string, settings?: Record<string, unknown>) => {
        const ans = storedRef.current?.answer;
        const added = addCard(layoutRef.current, type, Date.now(), { settings, pinned: pinnedCards(ans, Date.now()) });
        setAddOpen(false);
        setSettingsFor(null);
        if (!added.ok) return;
        setHint(false);
        if (type === 'tips') onTipsOn();
        changeLayout(added.layout, { reread: true });
        scrollRef.current?.scrollTo({ y: 0, animated: true });
        AccessibilityInfo.announceForAccessibility(addedLine(cardName(type, ans?.profile)));
    }, [changeLayout, onTipsOn]);
    const onPick = useCallback((row: PickerRow) => {
        if (!row.hasSettings) { addNow(row.type); return; }
        setAddOpen(false);
        afterModal(() => setSettingsFor({ type: row.type, mode: 'add' }));
    }, [addNow]);
    const onRemoveCard = useCallback((c: HomeCardInstance) => {
        if (c.type === 'tips') { onTipsDontShow(); return; }
        setHint(false);
        changeLayout(removeCard(layoutRef.current, c.id, Date.now(), pinnedCards(storedRef.current?.answer, Date.now())));
        AccessibilityInfo.announceForAccessibility(removedLine(cardName(c.type, storedRef.current?.answer.profile)));
    }, [changeLayout, onTipsDontShow]);
    const openSettings = useCallback((c: HomeCardInstance) => {
        afterModal(() => setSettingsFor({ type: c.type, mode: 'save', id: c.id, settings: c.settings }));
    }, []);
    const onSettingsDone = useCallback((next: Record<string, unknown>) => {
        const what = settingsFor;
        if (!what) return;
        if (what.mode === 'add') { addNow(what.type, next); return; }
        setSettingsFor(null);
        // Changed in place: the card keeps where it is.
        changeLayout(changeCardSettings(layoutRef.current, what.id, next, Date.now()), { reread: true });
    }, [settingsFor, addNow, changeLayout]);

    const interestsRef = useRef(interests);
    interestsRef.current = interests;
    const toggleInterest = useCallback((category: string) => {
        const prev = interestsRef.current;
        const next = prev.includes(category) ? prev.filter(c => c !== category) : [...prev, category];
        interestsRef.current = next;
        // Shown the same moment (the Market card reorders in place); saved to the phone and the account behind it.
        setInterests(next);
        void saveInterests(url, identityRef.current, next);
    }, [url]);

    const openTune = useCallback(() => {
        setTuneOpen(true);
        setTimeout(() => {
            const y = cardY.current.get('interests');
            if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
        }, 50);
    }, []);

    const onStep = useCallback((step: StepLine['id']) => {
        // The global node's first post is an Offer too: something free or for swap (Beans are off there).
        if (step === 'offer' || step === 'post') router.push({ pathname: '/map', params: { newPost: 'offer' } });
        else if (step === 'photo') router.push({ pathname: '/(tabs)/settings', params: { section: 'profile' } });
        else if (step === 'interests') openTune();
        else if (step === 'ask') router.push('/find-community');
        else router.push({ pathname: '/(tabs)/people', params: { view: 'invites' } });
    }, [openTune]);

    const openNeeds = useCallback((e: NeedsYouEntry) => {
        const t = e.target;
        if (t.to === 'admin') { manage.start(storedRef.current?.answer.cards.community?.name || 'this community', t.section); return; }
        goToNeedsTarget(t);
    }, [manage]);

    // A kept notice: its whole text from the node (one read on the tap), then marked seen.
    const openNotice = useCallback(async (noticeId: string) => {
        const id = identityRef.current;
        const first = storedRef.current?.answer.cards.notices?.first;
        if (!id || !url) return;
        let title = first?.title ?? 'From your community';
        let body = first?.line ?? '';
        try {
            const res = await signedGet(url, '/api/notices?unseen=1', id);
            const list = res.ok ? ((await res.json()) as { notices?: { id: string; title: string; body: string }[] }).notices : null;
            const found = list?.find(n => n.id === noticeId);
            if (found) { title = found.title; body = found.body; }
        } catch { /* the card's own words */ }
        Alert.alert(title, body);
        try { await signedPost(url, '/api/notices/seen', { ids: [noticeId] }, id); } catch { /* seen next time */ }
        void refreshRef.current('again');
    }, [url]);

    // ── What to draw ──
    const answer = stored?.answer ?? null;
    const now = Date.now();
    const needsEntries = answer ? mergeNeeds(answer.cards.needs?.items, local, now, answer.features) : [];
    const knocked = knocks.length > 0;
    // Tips: the node's list, from the answer in hand; the card only once the record is read, and never advanced here.
    const tipsList = answer ? tipsFor(answer, role) : [];
    const tipsView = tips && answer?.me ? tipNow(tips, tipsList, localDay()).view : null;
    const drawn = answer ? cardsToDraw(answer, layout, { interests, tuneOpen, safetyUp, needs: needsEntries.length, role, knocked, now, tipsUp: !!tipsView }) : [];
    // Find your community's pin (the global node, a member's first 30 days): no "…", no move, at the top.
    const pins = pinnedCards(answer, now);
    const interestsUp = drawn.some(c => c.type === 'interests');
    useEffect(() => { if (interestsUp && focused.current) setTuneOpen(true); }, [interestsUp]);
    const word = answer && stored ? safetyWord(answer, stored.asked.split(',')) : null;
    const homeWord = word && stored ? { url: stored.url, standing: word } : null;
    const profile = answer?.profile ?? 'local';
    const showsBeans = answer?.features.beans !== false;
    const invitesOn = !!answer && invitesForReader(answer.features, role);
    const ordered = cardOrder(layout, pins);
    const tailor = canTailor(answer);
    const menuCard = tailor ? menuFor : null;
    const menuAt = menuCard ? drawn.findIndex(d => d.id === menuCard.id) : -1;
    const tipsAllSeen = !!tips && !tips.dismissedAt && tipsList.length > 0 && allTipsSeen(tips, tipsList);
    const picker = answer && tailor && addOpen ? pickerGroups(answer, layout, role, pins, tipsAllSeen ? { tips: TIPS_ALL_SEEN } : {}) : null;

    const card = (inst: HomeCardInstance): React.ReactNode => {
        if (!answer) return null;
        const { id, type } = inst;
        const c = answer.cards;
        const caption = type === 'tips' && tipsView ? tipsCaption(tipsView) : cardCaption(type, answer);
        const menu = tailor && canRemoveCard(type, pins) ? () => setMenuFor(inst) : undefined;
        const frame = (body: React.ReactNode, extra?: { right?: React.ReactNode; accent?: boolean }) => (
            <HomeCard id={id} caption={caption} colors={colors} onMenu={menu} menuRef={menuRef(id)} testID={`home-card-${id}`} right={extra?.right} accent={extra?.accent}>
                {body}
            </HomeCard>
        );
        switch (type) {
            case 'needs': return frame(<NeedsBody entries={needsEntries} colors={colors} onOpen={openNeeds} />, { accent: needsEntries.some(e => e.accent) });
            case 'safety':
                // Its own card (the two-doors design's): it says when it is up, and keeps its own ✕ and schedule.
                return (
                    <OneWayBackCard
                        place="landing"
                        colors={colors}
                        homeWord={homeWord}
                        accountDismissedAt={layout?.dismissed.safety ?? null}
                        onDismiss={at => changeLayout(dismissSafety(layoutRef.current, at))}
                        onUp={setSafetyUp}
                        onActionsAt={at => band.report('safety:actions', at)}
                    />
                );
            case 'find': {
                // The directory's rows are other people's publications: each is checked before it is drawn.
                const home = readGlobalHome(c.find);
                return home ? frame(
                    <FindCommunityBody home={home} knocks={knocks} identity={identity} nodeUrl={url} point={place ?? answer.me?.area ?? null} colors={colors} />,
                ) : null;
            }
            case 'steps': {
                if (!c.steps) return null;
                const steps = firstSteps(answer, { interests, role, knocked });
                return frame(<StepsBody lines={steps.lines} note={steps.note} colors={colors} onStep={onStep} />);
            }
            case 'interests': return frame(<InterestsBody interests={interests} colors={colors} onToggle={toggleInterest} />);
            case 'tips': return tipsView ? frame(
                <TipsBody
                    view={tipsView}
                    colors={colors}
                    onNext={onTipNext}
                    onReadMore={slug => router.push({ pathname: '/guide/[slug]', params: { slug } })}
                    onDontShow={onTipsDontShow}
                />,
            ) : null;
            case 'deals': return c.deals ? frame(<DealsBody card={c.deals} colors={colors} />) : null;
            case 'enterprise': return c.enterprise ? frame(<EnterpriseBody card={c.enterprise} colors={colors} />) : null;
            case 'events': return c.events ? frame(<EventsBody card={c.events} colors={colors} />) : null;
            case 'market': return c.market ? frame(
                <MarketBody
                    items={marketInOrder(c.market.items, interests, profile, normalizeCategory)}
                    examples={!!c.market.examples}
                    nodeUrl={url}
                    showsBeans={showsBeans}
                    colors={colors}
                    onSeeAll={() => router.navigate('/(tabs)/market')}
                />,
                {
                    // The interests are a member's (a visitor's answer has no `me`, so no interests card to open).
                    right: tailor ? (
                        <Pressable onPress={openTune} style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 8, justifyContent: 'center', alignItems: 'center' }}
                            accessibilityRole="button" accessibilityLabel="Tune: pick what you're into" testID="home-market-tune">
                            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text.link }}>Tune</Text>
                        </Pressable>
                    ) : undefined,
                },
            ) : null;
            case 'decide': return c.decide ? frame(<DecideBody card={c.decide} features={answer.features} colors={colors} now={now} />) : null;
            case 'groups': return c.groups ? frame(<GroupsBody card={c.groups} colors={colors} />) : null;
            case 'joined': return c.joined ? frame(<JoinedBody card={c.joined} profile={profile} colors={colors} />) : null;
            case 'pulse': return c.pulse ? frame(<PulseBody card={{ items: starredFirst(c.pulse.items, i => i.category, interests, normalizeCategory) }} nodeUrl={url} colors={colors} />) : null;
            case 'beans': return c.beans ? frame(<BeansBody card={c.beans} colors={colors} />) : null;
            case 'notices': return c.notices ? frame(<NoticesBody card={c.notices} colors={colors} onOpen={openNotice} />) : null;
            case 'invite': return frame(<InviteBody colors={colors} />);
            case 'search': return frame(<SearchBody settings={inst.settings} colors={colors} />);
            case 'community': return frame(
                <CommunityBody
                    card={c.community}
                    profile={profile}
                    invitesOn={invitesOn}
                    colors={colors}
                    onAdd={tailor ? () => setAddOpen(true) : undefined}
                    onEdit={tailor ? () => setEditOpen(true) : undefined}
                />,
            );
            default: return null;
        }
    };

    // Each card in the member's order: the drawn ones, and the "one way back" card while it may be up (it decides).
    const list = ordered.filter(c => drawn.some(d => d.id === c.id) || (c.type === 'safety' && !!answer));
    const firstDrawn = list.find(c => c.type !== 'safety' || safetyUp);

    let empty: React.ReactNode = null;
    if (!answer) {
        if (status === 'members_only') {
            empty = (
                <View style={st.empty}>
                    <Text style={[st.emptyText, { color: colors.text.body }]}>Home shows once you're a member of this community.</Text>
                    <HomeButton colors={colors} text="Open the Market" onPress={() => router.navigate('/(tabs)/market')} />
                </View>
            );
        } else if (status === 'needs_update') {
            empty = (
                <View style={st.empty}>
                    <Text style={[st.emptyText, { color: colors.text.body }]} accessibilityLiveRegion="polite" testID="home-needs-update-note">
                        This community's server needs an update before Home works. Market and Talk still work.
                    </Text>
                    <View style={s.buttonRow}>
                        <HomeButton colors={colors} text="Open the Market" onPress={() => router.navigate('/(tabs)/market')} testID="home-open-market" />
                        <HomeButton colors={colors} text="Open Talk" onPress={() => router.navigate('/(tabs)/chats')} testID="home-open-talk" />
                    </View>
                </View>
            );
        } else if (status === 'no_community') {
            empty = (
                <View style={st.empty}>
                    <Text style={[st.emptyText, { color: colors.text.body }]}>Connect to a community to see your Home.</Text>
                    <HomeButton colors={colors} primary text="Connect" onPress={() => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } })} />
                </View>
            );
        } else if (status === 'offline') {
            empty = (
                <View style={st.empty}>
                    <Text style={[st.emptyText, { color: colors.text.body }]} accessibilityLiveRegion="polite">
                        Couldn't reach your community yet. Home fills in when it answers.
                    </Text>
                    <View style={s.buttonRow}>
                        <HomeButton colors={colors} primary text="Try again" onPress={() => void refresh('pull')} testID="home-retry" />
                        <HomeButton colors={colors} text="Open the Market" onPress={() => router.navigate('/(tabs)/market')} />
                    </View>
                </View>
            );
        } else {
            empty = (
                <View style={st.empty} accessibilityLiveRegion="polite">
                    <ActivityIndicator color={colors.text.secondary} />
                    <Text style={[st.emptyText, { color: colors.text.secondary }]}>Getting your Home…</Text>
                </View>
            );
        }
    }

    const menuName = menuCard && answer ? cardCaption(menuCard.type, answer) : '';

    return (
        <FabBandContext.Provider value={band}>
            <View style={{ flex: 1, backgroundColor: colors.surface.page }}>
                <ScrollView
                    ref={scrollRef}
                    onScroll={onScroll}
                    scrollEventThrottle={32}
                    onContentSizeChange={() => setBandVersion(v => v + 1)}
                    contentContainerStyle={st.content}
                    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPull} />}
                    testID="home-scroll"
                >
                    <PageTitle title="Home" testID="page-title-home" />
                    {offlineNote && (
                        <Text style={[st.offline, { color: colors.text.secondary }]} accessibilityLiveRegion="polite" testID="home-offline-note">
                            Couldn't reach your community; showing what we had.
                        </Text>
                    )}
                    {answer?.me?.standing === 'suspended' && (
                        <Text style={[st.offline, { color: colors.text.body }]} testID="home-suspended-note">
                            Your account here is paused for now. You can still read your own messages, deals and Beans.
                        </Text>
                    )}
                    {empty}
                    <Animated.View style={{ opacity: reveal, transform: [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }}>
                        {list.map(c => (
                            <View key={c.id} onLayout={e => cardY.current.set(c.id, e.nativeEvent.layout.y)}>
                                {card(c)}
                                {hint && tailor && c.id === firstDrawn?.id && (
                                    <View style={[st.hint, { borderColor: colors.accent.border, backgroundColor: colors.accent.tint }]} testID="home-hint">
                                        <Text style={[st.hintText, { color: colors.text.body }]}>{HOME_HINT_LINE}</Text>
                                        <Pressable onPress={() => setHint(false)} style={st.hintClose} accessibilityRole="button" accessibilityLabel="Got it, hide this tip">
                                            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text.secondary }}>✕</Text>
                                        </Pressable>
                                    </View>
                                )}
                                {fewer && tailor && c.id === firstDrawn?.id && (
                                    <View style={[st.hint, { borderColor: colors.accent.border, backgroundColor: colors.accent.tint }]} testID="home-fewer">
                                        <Text style={[st.hintText, { color: colors.text.body }]}>{FEWER_CARDS_LINE}</Text>
                                        <Pressable onPress={() => setFewer(false)} style={st.hintClose} accessibilityRole="button" accessibilityLabel="Got it, hide this line">
                                            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text.secondary }}>✕</Text>
                                        </Pressable>
                                    </View>
                                )}
                            </View>
                        ))}
                    </Animated.View>
                </ScrollView>

                {!fabAside && (
                    <Pressable accessibilityRole="button" accessibilityLabel="Add a post" style={[st.fab, { backgroundColor: colors.action.fab }]} onPress={() => setPostPicker(true)} testID="home-add-post">
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text style={{ color: colors.text.inverse, fontSize: 20, fontWeight: '400', marginTop: -2 }}>+</Text>
                            <Text style={{ color: colors.text.inverse, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }}>ADD POST</Text>
                        </View>
                    </Pressable>
                )}

                <HomeCardMenu
                    visible={!!menuCard}
                    name={menuName}
                    colors={colors}
                    canRemove={!!menuCard && canRemoveCard(menuCard.type, pins)}
                    canUp={!!menuCard && canMoveCard(menuCard.type, pins) && menuAt > 0 && canMoveCard(drawn[menuAt - 1].type, pins)}
                    canDown={!!menuCard && canMoveCard(menuCard.type, pins) && menuAt >= 0 && menuAt < drawn.length - 1 && canMoveCard(drawn[menuAt + 1].type, pins)}
                    onSettings={menuCard && homeCardType(menuCard.type)?.readSettings ? () => openSettings(menuCard) : undefined}
                    onRemove={() => { if (menuCard) onRemoveCard(menuCard); }}
                    onUp={() => { if (menuCard) changeLayout(moveCard(layoutRef.current, menuCard.id, 'up', drawn, Date.now(), pins)); }}
                    onDown={() => { if (menuCard) changeLayout(moveCard(layoutRef.current, menuCard.id, 'down', drawn, Date.now(), pins)); }}
                    onClose={() => setMenuFor(null)}
                    returnTo={menuCard ? menuRef(menuCard.id) : undefined}
                />
                <EditHomeSheet
                    visible={editOpen && tailor && !!answer}
                    layout={layout}
                    node={answer ?? { profile, features: {} }}
                    role={role}
                    pinned={pins}
                    drawnNow={drawn}
                    colors={colors}
                    onChange={next => changeLayout(next)}
                    onClose={() => setEditOpen(false)}
                    onAdd={() => { setEditOpen(false); afterModal(() => setAddOpen(true)); }}
                    onRemove={onRemoveCard}
                    onSettings={c => { setEditOpen(false); openSettings(c); }}
                    onReset={() => { if (tips?.dismissedAt) onTipsOn(); }}
                    tipsAllSeen={tipsAllSeen}
                    notOnAccount={notOnAccount}
                />
                <AddCardSheet
                    visible={!!picker}
                    groups={picker?.groups ?? []}
                    full={!!picker?.full}
                    colors={colors}
                    onAdd={onPick}
                    onClose={() => setAddOpen(false)}
                />
                <CardSettingsSheet
                    visible={!!settingsFor && tailor}
                    type={settingsFor?.type ?? null}
                    settings={settingsFor?.mode === 'save' ? settingsFor.settings : undefined}
                    mode={settingsFor?.mode ?? 'add'}
                    colors={colors}
                    onDone={onSettingsDone}
                    onClose={() => setSettingsFor(null)}
                />
                <NewPostTypeSheet
                    visible={postPicker}
                    onClose={() => setPostPicker(false)}
                    onSelect={type => {
                        const target = composeTargetFor(type);
                        if (target === 'poll-modal') { setPollModal(true); return; }
                        if (target === 'event-modal') { setEventModal(true); return; }
                        // The Offer/Need form lives on the map, which takes the chosen type in the link (as the Market's).
                        router.push({ pathname: '/map', params: { newPost: type } });
                    }}
                />
                <NewPollModal visible={pollModal} onClose={() => setPollModal(false)} onSuccess={() => void refresh('again')} />
                <NewEventModal visible={eventModal} onClose={() => setEventModal(false)} onSuccess={() => void refresh('again')} />
                {manage.dialog}
            </View>
        </FabBandContext.Provider>
    );
}

const st = StyleSheet.create({
    // Room under the last card for the floating button, so every card can scroll clear of it.
    content: { paddingBottom: 110 },
    empty: { marginHorizontal: 16, marginTop: 24, alignItems: 'center', gap: 12 },
    emptyText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
    offline: { marginHorizontal: 16, marginBottom: 8, fontSize: 13, lineHeight: 18 },
    hint: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginTop: -4, marginBottom: 10, borderWidth: 1, borderRadius: 12, paddingLeft: 12 },
    hintText: { flex: 1, fontSize: 13, lineHeight: 18, paddingVertical: 8 },
    hintClose: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    fab: {
        position: 'absolute', bottom: 32, right: 24, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 28,
        shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 8, zIndex: 100,
    },
});
