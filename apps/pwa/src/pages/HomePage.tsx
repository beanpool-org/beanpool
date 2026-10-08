/**
 * Home, the screen that isn't the Market (scratch/global-node/DESIGN-home-dashboard-fable.md, slice H3): a short list of
 * cards a member lands on, top to bottom answering what needs me, what's alive around me, what could I do next. Each
 * card is two or three lines and one tap into a screen that already exists; a card with nothing to say takes no space.
 * In the global lobby the same page is a visitor's Home: the Join card, then the public cards (§5.3).
 *
 * - **One request.** The whole screen is GET /api/home (lib/api.ts getHome), signed for a member, unsigned for a visitor.
 *   The node tags it, so an unchanged Home is a 304 (§5.2). The last answer is kept in IndexedDB (lib/home-cache.ts) and
 *   drawn at once while the node is asked again; offline, it stays, and the page says so.
 * - **When it asks again:** on landing, on coming back to the tab, once after a doorbell (a sync, a live post, a notice;
 *   debounced 3 s), once the member's notices are marked seen, when a layout change shows a card the answer in hand
 *   wasn't built for (made here, or the account's newer layout arriving in an answer), and a 120 s safety poll while the
 *   tab is in front. Never a per-card timer.
 * - **Sign-out in another tab** (lib/account-epoch.ts): this page drops the member's Home at once, reads nothing more as
 *   them and writes nothing back; a clear that keeps the account (Force Clear, leaving a community) is read afresh. A
 *   tab that missed the news finds it at the start of its next read or write, and that call stops there: what the page
 *   held went with the news, so nothing of it is kept or sent (PR #1479's review, round 3).
 * - **Tailoring** (§4): "…" on a card (Hide · Move up · Move down) and Edit home (components/HomeEditDialog.tsx); the
 *   layout is saved on the account (`home.layout`, H1) with this browser's copy, last write wins. The rules are
 *   lib/home-cards.ts.
 * - **Interests** (§4.3): the chips save on the account and in this browser's Market (`bp_fav_categories`); a tap reorders
 *   the Market card in place, the same second.
 * - **No dark patterns** (§6.3): real numbers or nothing, amber (never red) only for what waits on the member, nothing
 *   tier-locked, examples always say Example, nothing here blocks the app or waits on the network to draw.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    TIPS_DONT_SHOW, TIPS_DONT_SHOW_LABEL, allTipsSeen, dismissTips, emptyTipsRecord, findGuidePage, localDay, nextTip, readTipsRecord,
    restartTips, tipNow, tipOnLanding, tipsCaption, tipsFor, tipsNextLabel,
    type TipsRecord,
} from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { getHome, getNodeApiUrl, markNoticesSeen, saveHomePreferences } from '../lib/api';
import {
    NOTICES_SEEN_EVENT, askedCards, beansLines, canTailor, cardTitle, cardsBuiltFor, closesWords, communityFacts, communityLine,
    communityName, dayLabel, dealsLine, decideLine, distanceText, editableCards, findBody, hideCard, joinedLine, layoutNeedsRead,
    moveCard, nearbyLine, newerLayout, normalizeLayout, probationSentence, resetLayout, shownCards, showCard, starredFirst,
    stepLines, toggleInterest,
    type HomeAnswer, type HomeCardId, type HomeLayout, type NeedsItem, type StepLine,
} from '../lib/home-cards';
import { homeCacheKey, readCachedHome, writeCachedHome } from '../lib/home-cache';
import { settleInterests, shareInterests } from '../lib/home-interests';
import { accountEpoch, accountEpochHolds, onAccountEpochEnd } from '../lib/account-epoch';
import { onSocketOpen, onSyncActivity, onSystemAnnouncement } from '../lib/sync';
import { onLivePostChange } from '../lib/live-posts';
import { withJitter } from '../lib/jitter';
import { loadRadiusSettings } from '../lib/geo';
import { resolveImageUrl } from '../lib/avatar';
import { resolvePulseThumbnailUrl } from '../lib/pulse';
import { getBundledGuide } from '../lib/guide';
import { MARKETPLACE_CATEGORIES, MARKETPLACE_CATEGORIES_BY_ID } from '../lib/marketplace';
import { EXAMPLE_BADGE, EXAMPLE_LISTINGS, EXAMPLES_HEADING, EXAMPLES_NOTE, exampleLabel } from '../lib/example-listings';
import { NO_BEANS_TERMS_TEXT, PLACE_AFTER_JOIN, VISITOR_LIST_NOTE } from '../lib/visitor-lobby';
import { HomeCard, HomeLine, HomeMore } from '../components/HomeCard';
import { HomeEditDialog } from '../components/HomeEditDialog';
import { OneWayBackCard } from '../components/OneWayBack';

/** A doorbell's re-read waits this long, so a burst of changes is one read (§5.2). */
export const HOME_DOORBELL_DEBOUNCE_MS = 3_000;
/** The safety poll while the tab is in front (§5.2: the 120 s the header runs on the phone). */
export const HOME_SAFETY_POLL_MS = 120_000;
/** Back in front after this long, Home asks again. */
const HOME_RETURN_STALE_MS = 30_000;
/** The socket's first sync, right after it opens, is not a change when Home was read this recently. */
const SOCKET_OPEN_QUIET_MS = 10_000;

export const HOME_HINT = 'This is your Home. Tap … on any card to move or hide it.';
export const HOME_OFFLINE = "Couldn't reach your community; showing what we had.";
export const HOME_FAILED = "Couldn't reach your community. Your other tabs still work.";
/** The member signed out in another tab: this page shows and keeps nothing of theirs any more. */
export const HOME_SIGNED_OUT = 'You signed out of this browser in another tab. Reload this page to carry on.';
/** A community's server older than Home (a web app pointed at another server in Settings): the tabs work as before. */
export const HOME_NOT_ON_NODE = "This community's server doesn't have Home yet. The Market and the other tabs work as before.";
/** Said politely once a card is hidden: where it went, and how it comes back. */
export const hiddenWords = (title: string) => `${title} is hidden. Edit home brings it back.`;
/** Said politely when Done on the last tip takes the Tips card away. */
export const TIPS_DONE_WORDS = 'That was the last tip. Edit home brings them back.';

const revealKey = (pk: string) => `beanpool_home_revealed_${pk}`;
const hintKey = (pk: string) => `beanpool_home_hint_closed_${pk}`;
/** The Tips card's record (@beanpool/core home-tips.ts), per account in this browser, never on the account. */
export const tipsKey = (pk: string) => `beanpool_home_tips_${pk}`;

function readFlag(key: string): boolean {
    try { return localStorage.getItem(key) === '1'; } catch { return true; }
}
/** A member's own flag: never written once their account has left this browser (lib/account-epoch.ts). */
function writeFlag(key: string): void {
    if (!accountEpochHolds()) return;
    try { localStorage.setItem(key, '1'); } catch { /* a private window: shown again next time */ }
}
/** A private window that keeps nothing starts the tips at the first one each visit. */
function readTips(pk: string): TipsRecord {
    try {
        const raw = localStorage.getItem(tipsKey(pk));
        return readTipsRecord(raw ? JSON.parse(raw) : null);
    } catch { return emptyTipsRecord(); }
}
/** Written only while the member's account is still in this browser (lib/account-epoch.ts), as the flags above. */
function writeTips(pk: string, record: TipsRecord): void {
    if (!accountEpochHolds()) return;
    try { localStorage.setItem(tipsKey(pk), JSON.stringify(record)); } catch { /* a private window: not kept */ }
}
function reducedMotion(): boolean {
    try { return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}

/** The point "near you" is measured from: the one the visitor shared here, else the centre the Market was given. */
function marketPoint(): { lat: number; lng: number } | null {
    const r = loadRadiusSettings();
    return r && Number.isFinite(r.lat) && Number.isFinite(r.lng) ? { lat: r.lat, lng: r.lng } : null;
}

/** A shared position, rounded to 0.1° (about 11 km): enough for "near you", never a doorstep. */
const coarse = (n: number) => Math.round(n * 10) / 10;

export interface HomeVisitor {
    /** The lobby's Join card, drawn first (§3.2 (c)). */
    joinCard: ReactNode;
    beans: boolean;
}

interface Props {
    identity: BeanPoolIdentity | null;
    /** The global lobby's visitor Home. */
    visitor?: HomeVisitor;
    /**
     * Into the screens that already exist: 'marketplace' (a post), 'map', 'map-post', 'projects', 'messages' (a
     * conversation), 'people', 'people-community', 'people-invites', 'ledger', 'pulse', 'enterprise' (its key),
     * 'settings-profile', 'guide' (a page of the members' guide, by slug: the Tips card's Read more). The lobby takes
     * 'marketplace' and 'map' only.
     */
    onNavigate: (tab: string, contextId?: string) => void;
    /** The safety card's "See my 12 words". */
    onSeeWords?: () => void;
}

export function HomePage({ identity, visitor, onNavigate, onSeeWords }: Props) {
    const publicKey = visitor ? null : identity?.publicKey ?? null;
    // Moves on when a clear (here or in another tab) has this page land again: the community may have changed with it.
    const [landing, setLanding] = useState(0);
    const cacheKey = useMemo(() => homeCacheKey(publicKey), [publicKey, landing]);

    const [answer, setAnswer] = useState<HomeAnswer | null>(null);
    const [layout, setLayout] = useState<HomeLayout | null>(null);
    const [status, setStatus] = useState<'loading' | 'ready' | 'offline' | 'failed' | 'signed-out'>('loading');
    const [failure, setFailure] = useState<string | null>(null);
    const [live, setLive] = useState('');
    // The interests the page holds after a tap (saved in the background); null: the answer's.
    const [interests, setInterests] = useState<string[] | null>(null);
    // Once shown or opened from Tune, the interests card stays for this visit: a first tap must not take it away.
    const [interestsOpen, setInterestsOpen] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const [point, setPoint] = useState<{ lat: number; lng: number } | null>(() => marketPoint());
    const [pointProblem, setPointProblem] = useState<string | null>(null);
    const [reveal, setReveal] = useState(false);
    const [hintOpen, setHintOpen] = useState(false);
    // The Tips card's record as changed on this landing (Next, Don't show, Edit home); another landing's is not this one's.
    const [tipsChanged, setTipsChanged] = useState<{ landing: string; record: TipsRecord } | null>(null);
    const tipsRef = useRef<TipsRecord | null>(null);
    // The landing whose once-a-day advance has been written: once per landing, never while Home is in front.
    const tipsLandedFor = useRef<string | null>(null);

    const statusRef = useRef(status);
    const answerRef = useRef<HomeAnswer | null>(null);
    // The node's tag for the answer drawn: the next read sends it, and is a 304 while nothing changed.
    const etagRef = useRef<string | null>(null);
    const layoutRef = useRef<HomeLayout | null>(null);
    const unsavedRef = useRef(false);
    const layoutSeq = useRef(0);
    // Layout saves still on their way: a read meanwhile doesn't send the same layout again.
    const savingLayout = useRef(0);
    // The data cards the answer drawn was built for (lib/home-cards.ts cardsBuiltFor); null: not known.
    const builtForRef = useRef<HomeCardId[] | null>(null);
    const inFlight = useRef(false);
    const again = useRef(false);
    const lastStart = useRef(0);
    const mounted = useRef(true);
    const pointRef = useRef(point);
    pointRef.current = point;
    const interestsCardRef = useRef<HTMLDivElement | null>(null);
    const pageRef = useRef<HTMLDivElement | null>(null);
    // After a Hide: the cards to give focus to, nearest first (the card itself is gone, and so is its "…").
    const focusAfterHide = useRef<HomeCardId[] | null>(null);
    // The next landing comes after a clear: the kept copy is gone (or going), so the node is asked afresh.
    const skipCopy = useRef(false);
    // The epoch this page last landed under (lib/account-epoch.ts accountEpoch); null until it lands, and from the news of
    // a sign-out or a clear until it lands again.
    const landedUnder = useRef<number | null>(null);
    // How many ends this page has heard: a landing that is itself the first to hear one leaves the reading to the next.
    const endsHeard = useRef(0);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    /*
     * The first step of every read and every write this page makes: the epoch, if it is still the one the page landed
     * under (and, for a member, still signed in here); null otherwise, and the call stops there. Taking the epoch takes in
     * any news this tab missed (the channel, the storage event), and the news has the page drop what it held at once (the
     * listener below), so a call that is the first to hear of a clear never carries on with the old render's answer,
     * layout or community (PR #1479's review, round 3: a Hide put back the answer from before Force Clear, or a deleted
     * account's Home under the community it was deleted at). The page's next landing reads as the current account.
     */
    const landedEpoch = useCallback((): number | null => {
        const epoch = accountEpoch();
        if (epoch !== landedUnder.current) return null;
        return !publicKey || accountEpochHolds(epoch) ? epoch : null;
    }, [publicKey]);

    // Whether what was read or started under `epoch` may still be drawn and kept (lib/account-epoch.ts): nothing cleared
    // since, and for a member, still signed in here. The lobby's visitor holds no account.
    const holds = useCallback((epoch: number) => (publicKey ? accountEpochHolds(epoch) : epoch === accountEpoch()), [publicKey]);

    // Kept only while it may be (writeCachedHome checks the epoch, `epoch` being the one the answer was read under, from
    // landedEpoch: never one taken after the answer was).
    const keep = useCallback((a: HomeAnswer, l: HomeLayout | null, epoch: number) => {
        void writeCachedHome(cacheKey, { answer: a, asked: builtForRef.current, etag: etagRef.current, layout: l, layoutUnsaved: unsavedRef.current, savedAt: Date.now() }, epoch);
    }, [cacheKey]);

    const saveLayout = useCallback((next: HomeLayout) => {
        // Signed out or cleared, here or in another tab: nothing more is sent as that account.
        const epoch = landedEpoch();
        if (!publicKey || epoch === null) return;
        const seq = ++layoutSeq.current;
        savingLayout.current += 1;
        saveHomePreferences(publicKey, { 'home.layout': next })
            .finally(() => { savingLayout.current -= 1; })
            .then((r) => {
                if (!mounted.current || seq !== layoutSeq.current || !holds(epoch)) return;
                unsavedRef.current = false;
                // What the node kept: this layout with its stamp, or a newer one saved from another device.
                const kept = normalizeLayout(r['home.layout']);
                if (kept) {
                    layoutRef.current = kept;
                    setLayout(kept);
                }
                if (answerRef.current) keep(answerRef.current, layoutRef.current, epoch);
            })
            .catch(() => { /* kept in this browser, sent again after the next read */ });
    }, [publicKey, keep, holds, landedEpoch]);

    const fetchHome = useCallback(async (why: 'landing' | 'doorbell' | 'poll' | 'return' | 'retry' | 'point' | 'layout') => {
        // Signed out, here or in another tab: nothing more is read as that account. Cleared since the page landed: it
        // lands again (the news has it do so), and that landing reads afresh, as the current account.
        const epoch = landedEpoch();
        if (epoch === null) return;
        if (inFlight.current) { again.current = true; return; }
        inFlight.current = true;
        lastStart.current = Date.now();
        try {
            const p = pointRef.current;
            const sent = askedCards(layoutRef.current, answerRef.current);
            const read = await getHome({ cards: sent, ...(p ? { lat: p.lat, lng: p.lng } : {}) },
                answerRef.current ? etagRef.current : null);
            // The page has gone, or a sign-out or a clear came while the read was out: what it brought is not this
            // page's to draw or keep any more.
            if (!mounted.current || !holds(epoch)) return;
            // 304: the copy drawn is still the answer, layout and all (its tag covers the cards asked). Anything not sent
            // since is sent again.
            if (read?.notModified && answerRef.current) {
                builtForRef.current = cardsBuiltFor(sent, answerRef.current);
                if (unsavedRef.current && layoutRef.current && savingLayout.current === 0) saveLayout(layoutRef.current);
                // The account's interests are the ones in the copy drawn: a change made here that never reached them is
                // sent again while they are unchanged since (lib/home-interests.ts).
                const me = answerRef.current.me;
                if (publicKey && me) {
                    const settled = settleInterests(publicKey, me.interests, me.interestsUpdatedAt);
                    setInterests(settled.movedUp ? settled.interests : null);
                }
                if (statusRef.current === 'offline' || why === 'retry') setLive('Home updated.');
                statusRef.current = 'ready';
                setStatus('ready');
                return;
            }
            const a = read && !read.notModified ? read.answer : null;
            // Only an answer shaped as Home is drawn (a proxy's page or an odd reply is a failed read, never a crash).
            if (!a || typeof a !== 'object' || !a.cards || typeof a.cards !== 'object' || Array.isArray(a.cards)) throw new Error('not a Home answer');
            etagRef.current = read && !read.notModified ? read.etag : null;
            const fromNode = normalizeLayout(a.layout);
            const local = layoutRef.current;
            const merged = newerLayout(fromNode, local);
            // This browser's newer layout, not on the account yet, is sent again (unless its save is still on its way).
            if (merged && merged === local && unsavedRef.current) { if (savingLayout.current === 0) saveLayout(merged); }
            else if (merged === fromNode) unsavedRef.current = false;
            if (publicKey && a.me) {
                // The account's interests are this browser's Market favourites too; a change made here that never reached
                // the account (while it is unchanged since), and ones an older build kept only here, are sent up instead.
                const settled = settleInterests(publicKey, a.me.interests, a.me.interestsUpdatedAt);
                setInterests(settled.movedUp ? settled.interests : null);
            }
            builtForRef.current = cardsBuiltFor(sent, a);
            answerRef.current = a;
            layoutRef.current = merged;
            setAnswer(a);
            setLayout(merged);
            if (statusRef.current === 'offline' || why === 'retry') setLive('Home updated.');
            statusRef.current = 'ready';
            setStatus('ready');
            setFailure(null);
            keep(a, merged, epoch);
            // The account's layout, newer than this browser's (saved on another device or tab), shows a card this answer
            // wasn't built for: read again at once with it in `cards=`, not at the next poll or doorbell.
            if (merged && layoutNeedsRead(null, merged, a, builtForRef.current)) again.current = true;
        } catch (e) {
            if (!mounted.current || !holds(epoch)) return;
            if (answerRef.current) {
                statusRef.current = 'offline';
                setStatus('offline');
                setLive(HOME_OFFLINE);
            } else {
                statusRef.current = 'failed';
                setStatus('failed');
                const code = (e as { status?: number } | null)?.status;
                // 404: a server from before Home (lib/api.ts isRouteMissing).
                setFailure(code === 404 ? HOME_NOT_ON_NODE
                    : code === 401 || code === 403 ? ((e as Error).message || HOME_FAILED) : HOME_FAILED);
            }
        } finally {
            inFlight.current = false;
            if (again.current && mounted.current) {
                again.current = false;
                void fetchHomeRef.current?.('doorbell');
            }
        }
    }, [keep, saveLayout, publicKey, holds, landedEpoch]);
    const fetchHomeRef = useRef(fetchHome);
    fetchHomeRef.current = fetchHome;

    // Landing: the copy this browser kept, drawn at once, then the node.
    useEffect(() => {
        let cancelled = false;
        answerRef.current = null;
        etagRef.current = null;
        layoutRef.current = null;
        builtForRef.current = null;
        setAnswer(null);
        // What this landing's reads and writes are under: news after this is a reason to land again (landedEpoch). News
        // taken in by this very call has the page land again at once, and that landing, with the community as it is
        // now, is the one that reads.
        const heard = endsHeard.current;
        const epoch = accountEpoch();
        if (endsHeard.current !== heard) return;
        landedUnder.current = epoch;
        // Signed out (here or in another tab) since this page loaded: nothing of the member's is read or drawn.
        if (publicKey && !accountEpochHolds()) {
            statusRef.current = 'signed-out';
            setStatus('signed-out');
            return;
        }
        statusRef.current = 'loading';
        setStatus('loading');
        const afterClear = skipCopy.current;
        skipCopy.current = false;
        (afterClear ? Promise.resolve(null) : readCachedHome(cacheKey)).then((cached) => {
            if (cancelled || !mounted.current) return;
            // A sign-out or a clear came while the copy was read: what it read is from before, and the page lands again.
            if (landedEpoch() === null) return;
            if (cached && !answerRef.current) {
                answerRef.current = cached.answer;
                builtForRef.current = cached.asked ?? null;
                etagRef.current = cached.etag;
                layoutRef.current = cached.layout;
                unsavedRef.current = cached.layoutUnsaved;
                setAnswer(cached.answer);
                setLayout(cached.layout);
            }
        }).finally(() => {
            if (!cancelled) void fetchHomeRef.current('landing');
        });
        return () => { cancelled = true; };
    }, [cacheKey, landing, publicKey]);

    // A sign-out or a clear, here or in another tab (lib/account-epoch.ts): what this page holds goes at once, and it
    // lands again, which reads nothing as a member who signed out, and reads afresh after a clear.
    useEffect(() => onAccountEpochEnd((end) => {
        // Nothing this page started or holds is current until it has landed again.
        endsHeard.current += 1;
        landedUnder.current = null;
        answerRef.current = null;
        etagRef.current = null;
        layoutRef.current = null;
        builtForRef.current = null;
        unsavedRef.current = false;
        setAnswer(null);
        setLayout(null);
        setInterests(null);
        setEditOpen(false);
        // Said in the same render as her Home goes, never a moment of "Loading" between.
        if (end === 'signed-out' && publicKey) {
            statusRef.current = 'signed-out';
            setStatus('signed-out');
        }
        skipCopy.current = true;
        setLanding((n) => n + 1);
    }), [publicKey]);

    // Doorbells, the tab coming back, and the safety poll.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let stale = false;
        let openedAt = 0;
        const ring = () => {
            if (document.hidden) { stale = true; return; }
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; void fetchHomeRef.current('doorbell'); }, HOME_DOORBELL_DEBOUNCE_MS);
        };
        const offOpen = onSocketOpen(() => { openedAt = Date.now(); });
        const offSync = onSyncActivity(() => {
            // The socket's own catch-up as it opens, just after Home was read: nothing has happened yet.
            if (Date.now() - openedAt < 2_000 && openedAt - lastStart.current < SOCKET_OPEN_QUIET_MS && lastStart.current > 0) return;
            ring();
        });
        const offLive = onLivePostChange(() => ring());
        // A new notice (an announcement, a moderation notice): "From your community" comes with the alert (§5.2).
        const offNotice = onSystemAnnouncement(() => ring());
        // The member put a notice away (the alert, or Home's own Mark as read): the card goes now, not at the next poll.
        const onSeen = () => { void fetchHomeRef.current('doorbell'); };
        window.addEventListener(NOTICES_SEEN_EVENT, onSeen);
        const onVisibility = () => {
            if (document.hidden) return;
            if (stale || Date.now() - lastStart.current > HOME_RETURN_STALE_MS) {
                stale = false;
                void fetchHomeRef.current('return');
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        const poll = setInterval(() => { if (!document.hidden) void fetchHomeRef.current('poll'); }, withJitter(HOME_SAFETY_POLL_MS));
        return () => {
            if (timer) clearTimeout(timer);
            offOpen();
            offSync();
            offLive();
            offNotice();
            window.removeEventListener(NOTICES_SEEN_EVENT, onSeen);
            document.removeEventListener('visibilitychange', onVisibility);
            clearInterval(poll);
        };
    }, []);

    // The one-time reveal and hint (§6.2), for a member, once their Home has something to show.
    useEffect(() => {
        if (!publicKey || !answer || answer.welcome || landedEpoch() === null) return;
        if (!readFlag(revealKey(publicKey))) {
            writeFlag(revealKey(publicKey));
            if (!reducedMotion()) setReveal(true);
        }
        setHintOpen(!readFlag(hintKey(publicKey)));
    }, [publicKey, !!answer]);

    // ── Tips (scratch/home/TIPS-DESIGN-fable.md): the node's list from the answer in hand, the record this browser's ──
    // The web holds no role on the node, so a community whose door is admins-only leaves the invites tip out for all.
    const tipsList = answer?.me && !visitor ? tipsFor({ profile: String(answer.profile), features: answer.features }, null) : [];
    const tipsLanding = publicKey && answer?.me && !visitor ? `${publicKey}:${landing}` : null;
    // Once per landing, with an answer in hand (the kept copy counts: tips work with no connection), read in the same
    // render as the cards so the card is there from the first draw: a tip first shown on an earlier local day is marked
    // seen and the next one drawn.
    const tipsLanded = useMemo(() => (publicKey && tipsLanding ? tipOnLanding(readTips(publicKey), tipsList, localDay()).record : null),
        [tipsLanding]);
    const tips = tipsChanged && tipsChanged.landing === tipsLanding ? tipsChanged.record : tipsLanded;
    tipsRef.current = tips;
    const keepTips = useCallback((next: TipsRecord) => {
        if (!tipsLanding) return;
        tipsRef.current = next;
        setTipsChanged({ landing: tipsLanding, record: next });
        if (publicKey) writeTips(publicKey, next);
    }, [publicKey, tipsLanding]);
    // The landing's advance is kept, once.
    useEffect(() => {
        if (!publicKey || !tipsLanding || !tipsLanded || tipsLandedFor.current === tipsLanding || landedEpoch() === null) return;
        tipsLandedFor.current = tipsLanding;
        writeTips(publicKey, tipsLanded);
    }, [tipsLanding, tipsLanded]);
    const tipsView = tips && answer?.me && !visitor ? tipNow(tips, tipsList, localDay()).view : null;

    const now = Date.now();
    const myInterests = interests ?? answer?.me?.interests ?? [];
    const shown = answer ? shownCards(answer, layout, { now, interests: myInterests, interestsOpen, tipsUp: !!tipsView }) : [];
    // A card shown as Home opened stays open for the visit (a first tap must not take it away).
    useEffect(() => {
        if (shown.includes('interests') && !interestsOpen) setInterestsOpen(true);
    }, [shown.includes('interests')]);

    /**
     * A layout change made here (a card's "…", Edit home). Returns false when it was made on a Home this page no longer
     * holds: a sign-out or a clear this call was the first to hear of (landedEpoch). The change goes with what the page
     * held, drawn, kept and sent nowhere, and the page lands again.
     */
    function changeLayout(make: (current: HomeLayout | null) => HomeLayout): boolean {
        const epoch = landedEpoch();
        if (epoch === null) return false;
        const prev = layoutRef.current;
        const next = make(prev);
        unsavedRef.current = true;
        layoutRef.current = next;
        setLayout(next);
        if (answerRef.current) keep(answerRef.current, next, epoch);
        saveLayout(next);
        // Show, or Reset to defaults, brought back a card the answer in hand wasn't built for (a hidden card is left out
        // of `cards=`, and the node builds only what it is asked for): read Home again with the new `cards=`, now.
        // Nothing else needs a read: a Hide or a move is drawn from the answer in hand.
        if (answerRef.current && layoutNeedsRead(prev, next, answerRef.current, builtForRef.current)) void fetchHomeRef.current('layout');
        return true;
    }

    // After a Hide, focus goes to the nearest card left (its "…", else its heading; Edit home on the community card),
    // never to the page's <body>.
    useEffect(() => {
        const order = focusAfterHide.current;
        if (!order) return;
        focusAfterHide.current = null;
        for (const id of order) {
            const card = pageRef.current?.querySelector<HTMLElement>(`[data-testid="home-card-${id}"]`);
            if (!card) continue;
            const target = card.querySelector<HTMLElement>('[data-testid="home-card-menu"]')
                ?? card.querySelector<HTMLElement>('[data-testid="home-edit-open"]')
                ?? card.querySelector<HTMLElement>('h2');
            if (target) { target.focus(); return; }
        }
    }, [layout, tips]);

    // On the account and in this browser's Market (lib/home-interests.ts); a save that fails is marked in this browser
    // and sent again after the next read, whichever page made it. Never from a Home the page no longer holds (a chip on
    // another community's Home, deleted in a tab this one never heard).
    function toggleChip(id: string) {
        if (!publicKey || landedEpoch() === null) return;
        const next = toggleInterest(myInterests, id);
        setInterests(next);
        setInterestsOpen(true);
        void shareInterests(publicKey, next);
    }

    function openTune() {
        setInterestsOpen(true);
        requestAnimationFrame(() => interestsCardRef.current?.querySelector<HTMLElement>('button')?.focus());
    }

    function sharePoint() {
        setPointProblem(null);
        if (!navigator.geolocation) { setPointProblem("This browser can't share a location."); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const p = { lat: coarse(pos.coords.latitude), lng: coarse(pos.coords.longitude) };
                pointRef.current = p;
                setPoint(p);
                void fetchHomeRef.current('point');
            },
            () => setPointProblem("Your location wasn't shared. The Market's \"near me\" can be set by hand."),
            { maximumAge: 600_000, timeout: 15_000, enableHighAccuracy: false },
        );
    }

    // ── loading and failure: never a blank page, never a block on the other tabs ────────────────────────────────────
    if (!answer) {
        return (
            <div className="max-w-xl mx-auto px-4 pt-2 pb-6" data-testid="home-page">
                {visitor?.joinCard}
                {status === 'signed-out' ? (
                    <div role="status" data-testid="home-signed-out" className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 p-4">
                        <p className="m-0 mb-3 text-sm text-nature-800 dark:text-nature-100">{HOME_SIGNED_OUT}</p>
                        <button type="button" onClick={() => window.location.reload()}
                            className="min-h-[44px] px-4 rounded-xl border-0 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                            Reload
                        </button>
                    </div>
                ) : status === 'failed' ? (
                    <div role="alert" data-testid="home-failed" className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 p-4">
                        <p className="m-0 mb-3 text-sm text-nature-800 dark:text-nature-100">{failure}</p>
                        <button type="button" onClick={() => void fetchHome('retry')}
                            className="min-h-[44px] px-4 rounded-xl border-0 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                            Try again
                        </button>
                    </div>
                ) : (
                    <p className="text-sm text-nature-600 dark:text-nature-300" role="status">Loading your Home…</p>
                )}
            </div>
        );
    }

    const a = answer;
    const profile = String(a.profile);
    const isVisitor = !!a.welcome || !a.me;
    const beansOn = visitor ? visitor.beans : a.features.beans !== false;
    const movable = shown.filter(id => canTailor(id, a, now));

    function menuFor(id: HomeCardId) {
        if (isVisitor || !canTailor(id, a, now)) return undefined;
        const i = movable.indexOf(id);
        return {
            canMoveUp: i > 0,
            canMoveDown: i >= 0 && i < movable.length - 1,
            onHide: () => {
                // Hide on Tips does what "Don't show tips again" does: the record holds it on a node that drops `tips`.
                if (id === 'tips') { tipsDontShow(); return; }
                const at = shown.indexOf(id);
                if (!changeLayout((l) => hideCard(l, id))) return;
                // Read once the layout has been drawn (the effect below), so set in the same turn as the change.
                focusAfterHide.current = [...shown.slice(at + 1), ...shown.slice(0, Math.max(at, 0)).reverse()];
                setLive(hiddenWords(cardTitle(id, a)));
                if (id === 'interests') setInterestsOpen(false);
            },
            onMove: (d: 'up' | 'down') => { changeLayout((l) => moveCard(l, id, d, movable)); },
        };
    }

    /** Focus to the nearest card left once `id` has gone (read after the next draw, the effect above). */
    function focusAround(id: HomeCardId) {
        const at = shown.indexOf(id);
        focusAfterHide.current = [...shown.slice(at + 1), ...shown.slice(0, Math.max(at, 0)).reverse()];
    }

    // Next (Done on the last): the tip is seen and the next one drawn in place, said politely; Done takes the card away.
    function tipsNext() {
        if (!publicKey || landedEpoch() === null || !tipsRef.current) return;
        const step = nextTip(tipsRef.current, tipsList, localDay());
        if (!step.view) focusAround('tips');
        keepTips(step.record);
        setLive(step.view ? step.view.tip.text : TIPS_DONE_WORDS);
    }

    // "Don't show tips again" (and the card's Hide): the record says so, and the layout hides it for the other devices.
    function tipsDontShow() {
        if (!publicKey || landedEpoch() === null) return;
        focusAround('tips');
        keepTips(dismissTips(tipsRef.current ?? emptyTipsRecord(), new Date().toISOString()));
        changeLayout((l) => hideCard(l, 'tips'));
        setLive(hiddenWords(cardTitle('tips', a)));
    }

    const cardStyle = (index: number): React.CSSProperties | undefined => reveal
        ? { animation: 'home-card-in 300ms ease-out both', animationDelay: `${Math.min(index, 8) * 30}ms` }
        : undefined;

    function needsLine(item: NeedsItem, i: number) {
        const words = item.kind === 'vote' && item.closesAt && item.count === 1
            ? item.label.replace(/closes (within the hour|in \d+ (hours?|days))/, closesWords(item.closesAt, now))
            : item.label;
        const go = () => {
            const t = item.target;
            switch (t.to) {
                case 'deal': return onNavigate('marketplace', t.postId);
                case 'my-deals': return onNavigate('marketplace');
                case 'decide': return onNavigate('projects');
                case 'chat': return onNavigate('messages', t.conversationId);
                case 'unread-messages': case 'your-groups': return onNavigate('messages');
                default: return undefined;
            }
        };
        const body = (
            <>
                {item.accent
                    ? <span aria-hidden="true" className="shrink-0 text-amber-700 dark:text-amber-400 font-black">▲</span>
                    : <span aria-hidden="true" className="shrink-0 w-[1ch]" />}
                <span className={`min-w-0 break-words ${item.accent ? 'font-bold' : ''}`}>{words}</span>
            </>
        );
        if (item.target.to === 'admin') {
            return <HomeLine key={i} href={`${getNodeApiUrl()}/settings#from=pwa`} label={`${words}. Opens your community's settings.`} testId={`home-needs-${item.kind}`}>{body}</HomeLine>;
        }
        return <HomeLine key={i} onClick={go} label={item.accent ? `${words}. Waiting on you.` : words} testId={`home-needs-${item.kind}`}>{body}</HomeLine>;
    }

    function renderCard(id: HomeCardId, index: number): ReactNode {
        const c = a.cards;
        const title = cardTitle(id, a);
        const common = { id, title, menu: menuFor(id), style: cardStyle(index) };
        switch (id) {
            case 'needs':
                return c.needs && (
                    <HomeCard key={id} {...common} accent={c.needs.items.some(i => i.accent)}>
                        {c.needs.items.map(needsLine)}
                    </HomeCard>
                );
            case 'safety':
                // The two-doors card, with its own ✕ and schedule kept in this browser (components/OneWayBack.tsx).
                return identity && (
                    <div key={id} style={cardStyle(index)}>
                        <OneWayBackCard identity={identity} placement="landing" onSeeWords={onSeeWords} />
                    </div>
                );
            case 'find': {
                const f = c.find!;
                const more = f.communities.slice(0, 3);
                const nearby = nearbyLine(f);
                return (
                    <HomeCard key={id} {...common}>
                        <p className="m-0 mb-1 text-sm text-nature-800 dark:text-nature-100 break-words">{findBody(f)}</p>
                        {more.map(cm => {
                            const facts = communityFacts(cm);
                            const text = `${cm.name ?? 'A community'}${facts ? ` · ${facts}` : ''}`;
                            return cm.url
                                ? <HomeLine key={cm.key} href={cm.url} external label={`${text}. Opens its page.`}><span className="min-w-0 break-words font-semibold underline">{text}</span></HomeLine>
                                : <p key={cm.key} className="m-0 py-1 text-sm text-nature-800 dark:text-nature-100 break-words">{text}</p>;
                        })}
                        {nearby && <p className="m-0 py-1 text-sm text-nature-700 dark:text-nature-200">{nearby}</p>}
                        {f.point === null && (
                            <div className="mt-1">
                                <button type="button" onClick={sharePoint} data-testid="home-share-area"
                                    className="w-full min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-900 dark:text-white cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                                    Share my area
                                </button>
                                <p className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300">Only a rough area (about 10 km) is used, to find what's near.</p>
                                {pointProblem && <p role="alert" className="m-0 mt-1 text-xs text-nature-800 dark:text-nature-100">{pointProblem}</p>}
                            </div>
                        )}
                    </HomeCard>
                );
            }
            case 'steps': {
                // The lines and when the card goes are lib/home-cards.ts stepLines / stepsSaySomething; here, where each leads.
                const goes: Record<StepLine['key'], (() => void) | undefined> = {
                    firstOffer: () => onNavigate('map-post'),
                    firstPost: () => onNavigate('map-post'),
                    photo: () => onNavigate('settings-profile'),
                    interests: openTune,
                    invite: () => onNavigate('people-invites'),
                    ask: undefined,
                };
                const lines = stepLines(a, myInterests).map(l => ({ ...l, go: goes[l.key] }));
                const limits = probationSentence(a.me?.probation);
                return (
                    <HomeCard key={id} {...common}>
                        {lines.map(l => {
                            const body = (
                                <>
                                    <span aria-hidden="true" className="shrink-0 text-base">{l.done ? '☑' : '☐'}</span>
                                    <span className={`min-w-0 break-words ${l.done ? 'line-through text-nature-500 dark:text-nature-400' : ''}`}>{l.text}</span>
                                </>
                            );
                            const label = `${l.done ? 'Done' : 'To do'}: ${l.text}`;
                            return l.href
                                ? <HomeLine key={l.text} href={l.href} external label={label}>{body}</HomeLine>
                                : <HomeLine key={l.text} onClick={l.go} label={label}>{body}</HomeLine>;
                        })}
                        {limits && <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words" data-testid="home-steps-limits">{limits}</p>}
                    </HomeCard>
                );
            }
            case 'tips': {
                const v = tipsView;
                if (!v) return null;
                const slug = v.tip.guide;
                const page = slug ? findGuidePage(getBundledGuide(), slug) : null;
                const btn = 'min-h-[44px] px-4 rounded-xl text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2';
                return (
                    <HomeCard key={id} {...common} title={tipsCaption(v)}>
                        <p data-testid="home-tip-text" className="m-0 mb-2 text-[0.9375rem] text-nature-900 dark:text-nature-100 break-words">{v.tip.text}</p>
                        <div className="flex flex-wrap gap-2">
                            {/* The same element on every tip, so focus stays on it after a tap. */}
                            <button type="button" onClick={tipsNext} aria-label={tipsNextLabel(v)} data-testid="home-tips-next"
                                className={`${btn} flex-1 min-w-[96px] border-0 bg-emerald-700 hover:bg-emerald-800 text-white focus-visible:ring-emerald-400`}>
                                {v.last ? 'Done' : 'Next'}
                            </button>
                            {slug && page && (
                                <button type="button" onClick={() => onNavigate('guide', slug)} aria-label={`Read more in the guide: ${page.title}`} data-testid="home-tips-more"
                                    className={`${btn} flex-1 min-w-[96px] border border-nature-300 dark:border-nature-700 bg-transparent text-nature-900 dark:text-white focus-visible:ring-emerald-500`}>
                                    Read more
                                </button>
                            )}
                        </div>
                        <button type="button" onClick={tipsDontShow} aria-label={TIPS_DONT_SHOW_LABEL} data-testid="home-tips-dont-show"
                            className="w-full min-h-[44px] mt-1 px-2 bg-transparent border-0 rounded-lg text-sm font-bold text-nature-700 dark:text-nature-200 whitespace-normal break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                            {TIPS_DONT_SHOW}
                        </button>
                    </HomeCard>
                );
            }
            case 'interests':
                return (
                    <HomeCard key={id} {...common}>
                        <div ref={interestsCardRef}>
                            <p className="m-0 mb-2 text-sm text-nature-700 dark:text-nature-200">Tap what you like: those come first on Home and in the Market. Nothing is hidden.</p>
                            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Things you like">
                                {MARKETPLACE_CATEGORIES.map(cat => {
                                    const on = myInterests.includes(cat.id);
                                    return (
                                        <button key={cat.id} type="button" aria-pressed={on} onClick={() => toggleChip(cat.id)} data-testid={`home-interest-${cat.id}`}
                                            className={`min-h-[44px] max-w-full px-3 rounded-full text-sm font-semibold border cursor-pointer break-words text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${on
                                                ? 'bg-emerald-700 border-emerald-700 text-white'
                                                : 'bg-transparent border-nature-300 dark:border-nature-700 text-nature-900 dark:text-nature-100'}`}>
                                            <span aria-hidden="true">{cat.emoji} </span>{cat.label}
                                        </button>
                                    );
                                })}
                            </div>
                            {myInterests.length > 0 && (
                                <HomeMore onClick={() => setInterestsOpen(false)} testId="home-interests-done">Done</HomeMore>
                            )}
                        </div>
                    </HomeCard>
                );
            case 'deals':
                return (
                    <HomeCard key={id} {...common}>
                        <HomeLine onClick={() => onNavigate('marketplace', c.deals!.waitingOnMe?.postId)} label={`Your deals: ${dealsLine(c.deals!)}`}>
                            <span className="min-w-0 break-words">{dealsLine(c.deals!)}</span>
                        </HomeLine>
                    </HomeCard>
                );
            case 'enterprise': {
                const e = c.enterprise!;
                const line = `${e.name}${e.requests ? ` · ${e.requests} ${e.requests === 1 ? 'request' : 'requests'} to approve` : ''}`;
                return (
                    <HomeCard key={id} {...common}>
                        <HomeLine onClick={() => onNavigate('enterprise', e.id)} label={`${line}. Opens the enterprise.`}>
                            <span className="min-w-0 break-words">{line}</span>
                        </HomeLine>
                        {e.others > 0 && <p className="m-0 text-xs text-nature-600 dark:text-nature-300">and {e.others} more you keep</p>}
                    </HomeCard>
                );
            }
            case 'events': {
                const ev = c.events!;
                return (
                    <HomeCard key={id} {...common} title={ev.radiusKm ? `${title} · within ${ev.radiusKm} km` : title}>
                        {ev.items.map(item => {
                            const where = item.place ?? (isVisitor ? PLACE_AFTER_JOIN : null);
                            const rsvp = item.rsvp === 'going' ? 'Going' : item.rsvp === 'interested' ? 'Interested' : null;
                            const km = distanceText(item.distanceKm);
                            const text = [dayLabel(item.startsAt), item.title].filter(Boolean).join('  ');
                            return (
                                <HomeLine key={item.id} onClick={() => onNavigate('marketplace', item.id)} testId="home-event"
                                    label={[dayLabel(item.startsAt), item.title, where, km, rsvp].filter(Boolean).join(', ')}>
                                    <span className="min-w-0 flex-1">
                                        <span className="block break-words font-semibold">{text}</span>
                                        {(where || km) && <span className="block text-xs text-nature-600 dark:text-nature-300 break-words">{[where, km].filter(Boolean).join(' · ')}</span>}
                                    </span>
                                    {rsvp && <span className="shrink-0 text-xs font-bold text-emerald-800 dark:text-emerald-300">{rsvp}</span>}
                                </HomeLine>
                            );
                        })}
                        <HomeMore onClick={() => onNavigate('map')}>All events ›</HomeMore>
                    </HomeCard>
                );
            }
            case 'market': {
                const m = c.market!;
                const items = starredFirst(m.items, i => i.category, isVisitor ? [] : myInterests);
                const examples = m.examples && m.items.length < 6;
                return (
                    <HomeCard key={id} {...common} titleAside={!isVisitor && (
                        <button type="button" onClick={openTune} aria-label="Tune: pick what comes first" data-testid="home-tune"
                            className="min-h-[44px] px-2 -mt-2 bg-transparent border-0 text-xs font-bold text-nature-700 dark:text-nature-200 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                            Tune
                        </button>
                    )}>
                        {items.map(item => {
                            const photo = resolveImageUrl(item.photoUrl);
                            const cat = MARKETPLACE_CATEGORIES_BY_ID.get(item.category);
                            const price = !beansOn ? (isVisitor ? NO_BEANS_TERMS_TEXT : null)
                                : typeof item.credits === 'number' ? (item.credits > 0 ? `${item.credits.toLocaleString('en')} Beans` : 'Free') : null;
                            const km = distanceText(item.distanceKm);
                            const kind = item.type === 'need' ? 'NEED' : 'OFFER';
                            return (
                                <HomeLine key={item.id} onClick={() => onNavigate('marketplace', item.id)} testId="home-market-item"
                                    label={[kind === 'NEED' ? 'Need' : 'Offer', item.title, price, km ? `${km} away` : null].filter(Boolean).join(', ')}>
                                    {photo
                                        ? <img src={photo} alt="" loading="lazy" decoding="async" className="shrink-0 w-12 h-12 rounded-lg object-cover bg-nature-100 dark:bg-nature-800" />
                                        : <span aria-hidden="true" className="shrink-0 w-12 h-12 rounded-lg flex items-center justify-center text-xl bg-nature-100 dark:bg-nature-800">{cat?.emoji ?? '🌱'}</span>}
                                    <span className="min-w-0 flex-1">
                                        <span className="block break-words"><span className={`text-[0.65rem] font-extrabold mr-1 ${kind === 'NEED' ? 'text-orange-800 dark:text-orange-300' : 'text-blue-800 dark:text-blue-300'}`}>{kind}</span>{item.title}</span>
                                        {(price || km) && <span className="block text-xs text-nature-600 dark:text-nature-300">{[price, km].filter(Boolean).join(' · ')}</span>}
                                    </span>
                                </HomeLine>
                            );
                        })}
                        {isVisitor && items.length > 0 && <p className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300">{VISITOR_LIST_NOTE}</p>}
                        {examples && (
                            <div data-testid="home-examples" className="mt-2">
                                <p className="m-0 mb-1 text-xs font-bold text-nature-700 dark:text-nature-200">{EXAMPLES_HEADING}</p>
                                {EXAMPLE_LISTINGS.slice(0, 2).map(ex => (
                                    <p key={ex.key} data-testid="home-example" className="m-0 py-1 text-sm text-nature-800 dark:text-nature-100 flex items-start gap-2 min-w-0">
                                        {/* "Example" first for a screen reader (lib/example-listings.ts exampleLabel). */}
                                        <span className="sr-only">{exampleLabel(ex)}</span>
                                        <span aria-hidden="true" className="shrink-0">{ex.emoji}</span>
                                        <span aria-hidden="true" className="min-w-0 break-words">
                                            <span className="text-[0.65rem] font-extrabold mr-1 px-1 rounded bg-nature-200 dark:bg-nature-700 text-nature-900 dark:text-white">{EXAMPLE_BADGE}</span>
                                            {ex.title}
                                        </span>
                                    </p>
                                ))}
                                <p className="m-0 text-xs text-nature-600 dark:text-nature-300">{EXAMPLES_NOTE}</p>
                            </div>
                        )}
                        <HomeMore onClick={() => onNavigate('marketplace')} label="See all of the Market">See all ›</HomeMore>
                    </HomeCard>
                );
            }
            case 'decide':
                return (
                    <HomeCard key={id} {...common}>
                        <HomeLine onClick={() => onNavigate('projects')} label={`${decideLine(c.decide!, now)}. Opens Commons.`}>
                            <span className="min-w-0 break-words">{decideLine(c.decide!, now)}</span>
                        </HomeLine>
                    </HomeCard>
                );
            case 'groups':
                return (
                    <HomeCard key={id} {...common}>
                        {c.groups!.items.map(g => {
                            const line = `${g.name} · ${g.unread > 0 ? `${g.unread} new` : 'quiet'}`;
                            return (
                                <HomeLine key={g.id} onClick={() => onNavigate('messages', g.id)} label={`${line}${g.muted ? ', muted' : ''}`}>
                                    <span className="min-w-0 break-words">{line}</span>
                                </HomeLine>
                            );
                        })}
                    </HomeCard>
                );
            case 'joined': {
                const j = c.joined!;
                const faces = (j.names ?? []).map(n => ({ ...n, src: resolveImageUrl(n.avatarUrl) }));
                return (
                    <HomeCard key={id} {...common}>
                        <HomeLine onClick={() => onNavigate(faces.length ? 'people-community' : 'people')} label={`${joinedLine(j)} Opens People.`}>
                            {faces.length > 0 && (
                                <span aria-hidden="true" className="shrink-0 flex -space-x-2">
                                    {faces.slice(0, 3).map((f, i) => f.src
                                        ? <img key={i} src={f.src} alt="" className="w-8 h-8 rounded-full border-2 border-white dark:border-nature-900 object-cover" />
                                        : <span key={i} className="w-8 h-8 rounded-full border-2 border-white dark:border-nature-900 bg-nature-200 dark:bg-nature-700 flex items-center justify-center text-[0.65rem] font-bold">{f.callsign.slice(0, 2).toUpperCase()}</span>)}
                                </span>
                            )}
                            <span className="min-w-0 break-words">{joinedLine(j)}</span>
                        </HomeLine>
                    </HomeCard>
                );
            }
            case 'pulse':
                return (
                    <HomeCard key={id} {...common}>
                        {c.pulse!.items.map(p => {
                            const thumb = p.thumbnailUrl ? resolvePulseThumbnailUrl(p.id) : null;
                            const t = p.title || 'A new post';
                            return (
                                <HomeLine key={p.id} onClick={() => onNavigate('pulse')} label={`${t}, by ${p.callsign}. Opens the Pulse.`}>
                                    {thumb
                                        ? <img src={thumb} alt="" loading="lazy" decoding="async" className="shrink-0 w-12 h-12 rounded-lg object-cover bg-nature-100 dark:bg-nature-800" />
                                        : <span aria-hidden="true" className="shrink-0 w-12 h-12 rounded-lg flex items-center justify-center text-xl bg-nature-100 dark:bg-nature-800">📡</span>}
                                    <span className="min-w-0 flex-1">
                                        <span className="block break-words line-clamp-2">{t}</span>
                                        <span className="block text-xs text-nature-600 dark:text-nature-300 break-words">by {p.callsign}</span>
                                    </span>
                                </HomeLine>
                            );
                        })}
                        <HomeMore onClick={() => onNavigate('pulse')} label="See all of the Pulse">See all ›</HomeMore>
                    </HomeCard>
                );
            case 'beans': {
                const b = beansLines(c.beans!);
                return (
                    <HomeCard key={id} {...common}>
                        <HomeLine onClick={() => onNavigate('ledger')} label={`${b.line}${b.note ? `. ${b.note}` : ''}. Opens the Ledger.`}>
                            <span className="min-w-0">
                                <span className="block break-words font-semibold">{b.line}</span>
                                {b.note && <span className="block text-xs text-nature-600 dark:text-nature-300 break-words">{b.note}</span>}
                            </span>
                        </HomeLine>
                    </HomeCard>
                );
            }
            case 'notices': {
                const n = c.notices!;
                return (
                    <HomeCard key={id} {...common}>
                        <p className="m-0 text-sm font-semibold text-nature-900 dark:text-white break-words">{n.first.title}</p>
                        {n.first.line && <p className="m-0 text-sm text-nature-700 dark:text-nature-200 break-words">{n.first.line}</p>}
                        {n.unseen > 1 && <p className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300">and {n.unseen - 1} more</p>}
                        <HomeMore onClick={() => {
                            // Never a notice of a Home this page no longer holds (another community's, in a tab that missed the news).
                            if (landedEpoch() === null) return;
                            void markNoticesSeen([n.first.id]).catch(() => { /* still unseen: the card stays */ });
                        }} testId="home-notice-seen">Mark as read</HomeMore>
                    </HomeCard>
                );
            }
            case 'invite':
                return (
                    <HomeCard key={id} {...common}>
                        <button type="button" onClick={() => onNavigate('people-invites')}
                            className="w-full min-h-[44px] px-4 rounded-xl border-0 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                            Invite someone
                        </button>
                    </HomeCard>
                );
            case 'community': {
                const cm = c.community!;
                return (
                    <HomeCard key={id} {...common} title={communityName(cm, profile)}>
                        <p className="m-0 text-sm text-nature-800 dark:text-nature-100 break-words">
                            {cm.members === 1 && !isVisitor ? "1 member. You're first. Invite someone." : `${communityLine(cm, profile)}.`}
                        </p>
                        {!isVisitor && (
                            <HomeMore onClick={() => setEditOpen(true)} testId="home-edit-open" label="Edit home: choose which cards show, and their order">Edit home ›</HomeMore>
                        )}
                    </HomeCard>
                );
            }
            default:
                return null;
        }
    }

    const editable = editOpen ? editableCards(a, layout, now) : null;

    return (
        <div ref={pageRef} className="max-w-xl mx-auto px-4 pt-2 pb-6 min-w-0" data-testid="home-page">
            {reveal && <style>{'@keyframes home-card-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }'}</style>}
            <p className="sr-only" aria-live="polite" data-testid="home-live">{live}</p>
            {status === 'offline' && (
                <p data-testid="home-offline" className="m-0 mb-2 text-xs text-nature-700 dark:text-nature-200">{HOME_OFFLINE}</p>
            )}
            {visitor?.joinCard}
            {a.me?.standing === 'suspended' && (
                <p className="m-0 mb-3 text-sm text-nature-800 dark:text-nature-100 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 p-4">
                    Your account here is paused for now. You can read your own messages, deals and Beans; the community's listings come back when it is lifted.
                </p>
            )}
            {shown.map((id, i) => (
                <div key={id}>
                    {renderCard(id, i)}
                    {i === 0 && hintOpen && !isVisitor && (
                        <p data-testid="home-hint" className="-mt-1 mb-3 pl-3 flex items-center gap-2 rounded-xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 text-sm text-nature-800 dark:text-nature-100">
                            <span className="min-w-0 flex-1 break-words">{HOME_HINT}</span>
                            <button type="button" aria-label="Close this tip" onClick={() => { setHintOpen(false); if (publicKey && landedEpoch() !== null) writeFlag(hintKey(publicKey)); }}
                                className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-transparent border-0 text-nature-500 dark:text-nature-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                                ✕
                            </button>
                        </p>
                    )}
                </div>
            ))}
            {editable && (
                <HomeEditDialog
                    answer={a}
                    shown={editable.shown}
                    hidden={editable.hidden}
                    tipsAllSeen={!!tips && !tips.dismissedAt && tipsList.length > 0 && allTipsSeen(tips, tipsList)}
                    onToggle={(id, show) => {
                        if (!changeLayout((l) => (show ? showCard(l, id) : hideCard(l, id)))) return;
                        // Tips switched on starts over from the first tip; off holds as "Don't show tips again" does.
                        if (id === 'tips') keepTips(show ? restartTips(tipsList, localDay()) : dismissTips(tipsRef.current ?? emptyTipsRecord(), new Date().toISOString()));
                    }}
                    onMove={(id, d) => { changeLayout((l) => moveCard(l, id, d, editable.shown)); }}
                    // Reset shows Tips again when it was off, so then the tips start over as a switch-on does (PR #1694
                    // review 3); a member part-way through keeps their place (confirmation 1, finding 2).
                    onReset={() => {
                        const tipsOff = !!tipsRef.current?.dismissedAt || !!layoutRef.current?.hidden.includes('tips');
                        if (changeLayout(resetLayout) && tipsOff) keepTips(restartTips(tipsList, localDay()));
                    }}
                    onClose={() => setEditOpen(false)}
                />
            )}
        </div>
    );
}
