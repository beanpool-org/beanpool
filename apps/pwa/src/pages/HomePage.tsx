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
 * - **The card frame** (CARD-FRAME §1–§2): "…" on a card (Settings… · Move up · Move down · Remove), Add a card
 *   (components/AddCardDialog.tsx) and Edit home (components/EditHomeDialog.tsx) on the community card; the version-2
 *   list is saved on the account (`home.layout`) with this browser's copy. Which copy stands, what is asked and every edit
 *   are lib/home-layout.ts, the phone's rules (apps/native/utils/home-cards.ts).
 * - **A wide screen** (scratch/global-node/DESIGN-home-wide-and-content-fable.md D1, slice W2): the cards stand in as many
 *   320–576 px columns as the page's own width holds, up to three, row first in the saved order; Needs you and the
 *   community card span the row. A phone's width is one column, as before. Auto only: a saved choice of columns is W0's.
 * - **Interests** (§4.3): the chips save on the account and in this browser's Market (`bp_fav_categories`); a tap reorders
 *   the Market card in place, the same second.
 * - **No dark patterns** (§6.3): real numbers or nothing, amber (never red) only for what waits on the member, nothing
 *   tier-locked, examples always say Example, nothing here blocks the app or waits on the network to draw.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    TIPS_DONT_SHOW, TIPS_DONT_SHOW_LABEL, allTipsSeen, dismissTips, emptyTipsRecord, findGuidePage, localDay, nextTip, readTipsRecord,
    restartTips, tipNow, tipOnLanding, tipsCaption, tipsFor, tipsNextLabel,
    type TipsRecord,
    homeCardType, listPhotoUrl, readSearchSettings,
    SAVE_SEARCH_NOT_NOW, saveSearchLine, saveSearchState, type HomeSearchSettings,
    currentLanguage, formatCount, t, tn, word,
} from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { getHome, getNodeApiUrl, markNoticesSeen, saveHomePreferences, watchPlace } from '../lib/api';
import { StartCommunityScreen } from '../components/StartCommunityScreen';
import {
    NOTICES_SEEN_EVENT, beansAmount, beansLines, cardTitle, closesIn, closesWords, communityFacts, communityLine, communityName, dealStatusLine, dealTitleLine,
    dealsLine, decideLine, distanceText, enterpriseLatestLine, findBody, findListed, findOffersStart, frameOf, groupLastLine, homeEventRepeats, homeEventWhen, isHomeCardId,
    joinedLine, monthSummaryLine, nearbyLine, probationSentence, pulseByLine, searchCardFor, shownFrame, shownLayout, skyOf,
    starredFirst, stepLines, tierWords, toggleInterest, SKY_NO_PLACE_LINE,
    type HomeAnswer, type HomeCardId, type HomeCards, type HomeMarketItem, type NeedsItem, type StepLine,
} from '../lib/home-cards';
import {
    FEWER_CARDS_LINE, FIXED_FIRST, FIXED_LAST, HOME_COLUMN_GAP, HOME_COLUMN_MAX, HOME_HINT_LINE, SEARCH_OFFLINE_LINE, addCard, addedLine, askPinned, canMoveCard,
    canRemoveCard, cardLabelName, cardName, cardOnNode, cardRowName, columnsFor, gridWidth, searchEmptyLine, searchFirstLine, cardOrder, cardsToAsk, changeCardSettings, fewerCardsNews, layoutV1Of,
    listOf, moveCard, ownMarkedSave, pickLayout, pickerGroups, pinnedCards, readLayout, rememberMarkSent, removeCard, removedLine,
    resetLayout, sameList, type HomeCardInstance, type HomeLayoutV2, type MarkSent,
} from '../lib/home-layout';
import { homeCacheKey, readCachedHome, writeCachedHome } from '../lib/home-cache';
import { markHomeInflight, recordHomeAnswer } from '../lib/home-store';
import { settleInterests, shareInterests } from '../lib/home-interests';
import { accountEpoch, accountEpochHolds, onAccountEpochEnd } from '../lib/account-epoch';
import { onSocketOpen, onSyncActivity, onSystemAnnouncement } from '../lib/sync';
import { onLivePostChange } from '../lib/live-posts';
import { withJitter } from '../lib/jitter';
import { loadRadiusSettings } from '../lib/geo';
import { sentCentre } from '../lib/listings-near';
import { resolveImageUrl } from '../lib/avatar';
import { resolvePulseThumbnailUrl } from '../lib/pulse';
import { getBundledGuide } from '../lib/guide';
import { standingFromRefusal } from '../lib/standing-refusal';
import {
    START_CARD_WORDS, endTourLayout, resumeStep, startCardButton, tourChips, tourRecord, tourSteps, type TourProgress,
} from '@beanpool/core';
import {
    keepPendingTourRecord, lendTourHome, offerTour, pendingTourRecord, readProgress, startTour, takePendingEnd, takeTourAgain, useTour,
} from '../lib/tour-store';
import { MARKETPLACE_CATEGORIES, MARKETPLACE_CATEGORIES_BY_ID } from '../lib/marketplace';
import { EXAMPLE_LISTINGS, EXAMPLE_WORDS, exampleLabel } from '../lib/example-listings';
import { VISITOR_WORDS } from '../lib/visitor-lobby';
import { CardMenu, HomeCard, HomeLine, HomeMore, useCardContainer } from '../components/HomeCard';
import { EditHomeDialog, type EditHomeRow } from '../components/EditHomeDialog';
import { AddCardDialog, CardSettingsDialog } from '../components/AddCardDialog';
import { OneWayBackCard } from '../components/OneWayBack';
import { ToolHomeCard } from '../tools/home-card';
import { toolOfCard } from '../tools/cards';
import { AddressSearch } from '../components/AddressSearch';
import {
    FIND_TOWN_SEARCH_WORDS, NOT_HERE_TYPE_YOUR_TOWN, PLACE_WATCH_LIMIT_CODE, TYPE_YOUR_TOWN, placeWatchLimitLine, type AddressResult, type AddressSearchWords,
} from '@beanpool/core';

/** A doorbell's re-read waits this long, so a burst of changes is one read (§5.2). */
export const HOME_DOORBELL_DEBOUNCE_MS = 3_000;

/** Find your community's town links ("or type your town", "change", "Cancel"): the link and accent roles, light and dark. */
/** The find card's buttons, as its Share my area. */
const FIND_ACTION = 'w-full min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-900 dark:text-white cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
/** "Tell me when one starts here", in the phone's words where it has them (FindCommunityBody); t(WATCH_WORDS.…) where shown. */
export const WATCH_WORDS = {
    done: word("Done. You'll be told when a community starts near here."),
    joinFirst: word('Join first: being told is kept for a member. Join is at the top of this page.'),
    needsPlace: word('Share your area or type your town first, so we know where "here" is.'),
} as const;
const TOWN_LINK = 'min-h-[44px] px-1 border-0 bg-transparent text-sm font-semibold underline text-link cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const HOME_CARD_IN_STYLE = '@keyframes home-card-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }';
/** The safety poll while the tab is in front (§5.2: the 120 s the header runs on the phone). */
export const HOME_SAFETY_POLL_MS = 120_000;
/** Back in front after this long, Home asks again. */
const HOME_RETURN_STALE_MS = 30_000;
/** The socket's first sync, right after it opens, is not a change when Home was read this recently. */
const SOCKET_OPEN_QUIET_MS = 10_000;

export const HOME_HINT = HOME_HINT_LINE;
/** The sentences this page keeps in one place and says where they are shown: marked with word(), translated by t(HOME_WORDS.x). */
const HOME_WORDS = {
    offline: word("Couldn't reach your community; showing what we had."),
    failed: word("Couldn't reach your community. Your other tabs still work."),
    signedOut: word('You signed out of this browser in another tab. Reload this page to carry on.'),
    notOnNode: word("This community's server doesn't have Home yet. The Market and the other tabs work as before."),
    tipsDone: word('That was the last tip. Add a card brings them back.'),
};
export const HOME_OFFLINE = HOME_WORDS.offline;
export const HOME_FAILED = HOME_WORDS.failed;
/** The member signed out in another tab: this page shows and keeps nothing of theirs any more. */
export const HOME_SIGNED_OUT = HOME_WORDS.signedOut;
/** A community's server older than Home (a web app pointed at another server in Settings): the tabs work as before. */
export const HOME_NOT_ON_NODE = HOME_WORDS.notOnNode;
/** Said politely once a card is hidden: where it went, and how it comes back. */
/** Said politely when Done on the last tip takes the Tips card away. */
export const TIPS_DONE_WORDS = HOME_WORDS.tipsDone;
/**
 * The lines lib/ (home-cards.ts, home-layout.ts) and core (the town search's) keep as word() keys, in the member's language
 * where Home draws them.
 */
const LIB_LINES = {
    skyNoPlace: SKY_NO_PLACE_LINE, fewerCards: FEWER_CARDS_LINE, hint: HOME_HINT_LINE, searchOffline: SEARCH_OFFLINE_LINE,
    typeYourTown: TYPE_YOUR_TOWN, notHereTypeYourTown: NOT_HERE_TYPE_YOUR_TOWN, startCard: START_CARD_WORDS,
    tipsDontShow: TIPS_DONT_SHOW, tipsDontShowLabel: TIPS_DONT_SHOW_LABEL, saveSearchNotNow: SAVE_SEARCH_NOT_NOW,
} as const;
/** Core's FIND_TOWN_SEARCH_WORDS as the town search draws them, in the member's language (made where drawn). */
const findTownWords = (): AddressSearchWords => ({
    label: t(FIND_TOWN_SEARCH_WORDS.label),
    placeholder: t(FIND_TOWN_SEARCH_WORDS.placeholder),
    unavailable: t(FIND_TOWN_SEARCH_WORDS.unavailable),
    noMatches: t(FIND_TOWN_SEARCH_WORDS.noMatches),
    source: t(FIND_TOWN_SEARCH_WORDS.source),
    pickLabel: FIND_TOWN_SEARCH_WORDS.pickLabel,
});

const revealKey = (pk: string) => `beanpool_home_revealed_${pk}`;
const hintKey = (pk: string) => `beanpool_home_hint_closed_${pk}`;
const fewerKey = (pk: string) => `beanpool_home_fewer_seen_${pk}`;
/** A raw account layout's date (an empty version-1 one's too): the mark an edit made on the newcomer's list carries. */
const rawDate = (raw: unknown): string => {
    const at = raw && typeof raw === 'object' ? (raw as { updatedAt?: unknown }).updatedAt : undefined;
    return typeof at === 'string' && at.length <= 40 ? at : '';
};
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

/** A card that spans the grid's row: Needs you at the top, the community card at the bottom, and the notes under the first card. */
const FULL_ROW: React.CSSProperties = { gridColumn: '1 / -1' };
/** Needs you and the community card are full rows of the grid; every other card is one cell (D1, D3). */
const spansRow = (type: string) => type === FIXED_FIRST || type === FIXED_LAST;

/**
 * How many columns Home's cards stand in (DESIGN-home-wide-and-content-fable.md D1, slice W2; Auto only): the page's own
 * width inside its gutters (lib/home-layout.ts columnsFor), measured before the first paint and again whenever it changes
 * (the window, the sidebar). A browser without ResizeObserver follows the window.
 */
function useHomeColumns(): [(el: HTMLDivElement | null) => void, number] {
    const [el, setEl] = useState<HTMLDivElement | null>(null);
    const [cols, setCols] = useState(1);
    useLayoutEffect(() => {
        if (!el) return;
        const measure = () => {
            const cs = getComputedStyle(el);
            setCols(columnsFor(el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [el]);
    return [setEl, cols];
}

/**
 * The point "near you" is measured from: one shared or typed here (`coarse` already), or the centre the Market was given,
 * held as picked with its radius (`radiusKm`) and only ever sent through sentPoint.
 */
type HomePoint = { lat: number; lng: number; radiusKm?: number };

/** The centre the Market was given in Distance, with its radius; one with no radius kept is measured by Home's own. */
function marketPoint(): HomePoint | null {
    const r = loadRadiusSettings();
    if (!r || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return null;
    return { lat: r.lat, lng: r.lng, radiusKm: Number.isFinite(r.radiusKm) && r.radiusKm > 0 ? r.radiusKm : Infinity };
}

/**
 * Home's point as the node is sent it. The Market's centre goes only as precisely as the least Home measures from it
 * needs, by the Market's and the Map's own rule (lib/listings-near sentCentre): its radius, or a saved search's distance
 * on `list` when that is less (a 10 km setting goes to 2 decimals, a search within 1 km to 3). Never as picked: the read
 * is a query string, every landing and every 2 minutes (N5, review of #2363). One shared or typed here goes as it is.
 */
function sentPoint(p: HomePoint | null, list: HomeLayoutV2 | null): { lat: number; lng: number } | null {
    if (!p) return null;
    if (p.radiusKm === undefined) return { lat: p.lat, lng: p.lng };
    const searchKms = (list?.cards ?? []).flatMap(c => (c.type === 'search' ? [readSearchSettings(c.settings).km ?? Infinity] : []));
    return sentCentre(p, Math.min(p.radiusKm, ...searchKms));
}

/** A shared position, rounded to 0.1° (about 11 km): enough for "near you", never a doorstep. */
const coarse = (n: number) => Math.round(n * 10) / 10;

/**
 * A listing's price in words: Beans to the cent ("33.33", never a float's "20.299999999999997"). English groups thousands
 * as it always has, a fraction's too ("1,234.5"); every other language writes the digits alone with its own decimal sign
 * (formatCount: "1.500" reads as 1.5 in pt and es).
 */
function priceWords(credits: number): string {
    const r = Math.round(credits * 100) / 100;
    const [whole, fraction] = String(r).split('.');
    const n = currentLanguage() === 'en' && fraction !== undefined ? `${formatCount(Number(whole))}.${fraction}` : formatCount(r);
    return tn(r, '{n} Beans', '{n} Beans', { n });
}

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
    /**
     * The Market's "Save this search to Home" (Marty, 7 Oct): once Home knows the member's list, the saved search's dialog
     * opens with it filled in (Add to Home its last button), or Home says why not; then `onSaveSearchTaken`.
     */
    saveSearch?: HomeSearchSettings | null;
    onSaveSearchTaken?: () => void;
    /**
     * A tool's Home card (`tool-<id>`), from the one offer its empty state makes (DESIGN-tool-template-fable.md §0, T0.3):
     * added as Add a card adds it, once Home knows the member's list; then `onAddCardTaken`. Never added by itself.
     */
    addCardType?: string | null;
    onAddCardTaken?: () => void;
}

// ── Card bodies (DESIGN-home-wide-and-content-fable.md §2, slice W4) ──────────────────────────────────────────────────

function MarketListingItem({
    item,
    testId,
    beansOn,
    isVisitor,
    wide,
    onNavigate,
    nextImageLoading,
}: {
    item: HomeMarketItem;
    testId: string;
    beansOn: boolean;
    isVisitor: boolean;
    wide: boolean;
    onNavigate: (page: string, id?: string) => void;
    nextImageLoading: () => 'eager' | 'lazy';
}) {
    const photo = resolveImageUrl(item.photoUrl);
    const cat = MARKETPLACE_CATEGORIES_BY_ID.get(item.category);
    const price = !beansOn ? (isVisitor ? t(VISITOR_WORDS.noBeansTerms) : null)
        : typeof item.credits === 'number' ? (item.credits > 0 ? priceWords(item.credits) : t('Free', undefined, 'price')) : null;
    const km = distanceText(item.distanceKm);
    const kind = item.type === 'need' ? 'NEED' : 'OFFER';
    const label = [
        kind === 'NEED' ? t('Need', undefined, 'listing type') : t('Offer', undefined, 'listing type'),
        item.title,
        price,
        km ? t('{km} away', { km }) : null,
    ].filter(Boolean).join(', ');

    if (wide) {
        return (
            <button
                key={item.id}
                type="button"
                onClick={() => onNavigate('marketplace', item.id)}
                aria-label={label}
                data-testid={testId}
                className="w-full min-h-[44px] p-2 text-left bg-transparent border border-border-primary hover:bg-bg-hover rounded-xl cursor-pointer flex flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                {photo ? (
                    <img
                        src={listPhotoUrl(photo)}
                        alt=""
                        loading={nextImageLoading()}
                        decoding="async"
                        className="w-full h-24 rounded-lg object-cover bg-bg-hover mb-2"
                    />
                ) : (
                    <span aria-hidden="true" className="w-full h-24 rounded-lg flex items-center justify-center text-2xl bg-bg-hover mb-2">
                        {cat?.emoji ?? '🌱'}
                    </span>
                )}
                <div className="min-w-0 flex-1">
                    <div className="mb-1">
                        <span className={`text-[0.65rem] font-extrabold mr-1 ${kind === 'NEED' ? 'text-orange-800 dark:text-orange-300' : 'text-blue-800 dark:text-blue-300'}`}>
                            {kind === 'NEED' ? t('NEED', undefined, 'listing type') : t('OFFER', undefined, 'listing type')}
                        </span>
                        <span dir="auto" className="text-sm font-semibold break-words text-text-primary">
                            {item.title}
                        </span>
                    </div>
                    {(price || km) && (
                        <span className="block text-xs text-text-secondary break-words">
                            {[price, km].filter(Boolean).join(' · ')}
                        </span>
                    )}
                </div>
            </button>
        );
    }

    return (
        <HomeLine
            key={item.id}
            onClick={() => onNavigate('marketplace', item.id)}
            testId={testId}
            label={label}
        >
            {photo ? (
                <img
                    src={listPhotoUrl(photo)}
                    alt=""
                    loading={nextImageLoading()}
                    decoding="async"
                    className="shrink-0 w-12 h-12 rounded-lg object-cover bg-bg-hover"
                />
            ) : (
                <span aria-hidden="true" className="shrink-0 w-12 h-12 rounded-lg flex items-center justify-center text-xl bg-bg-hover">
                    {cat?.emoji ?? '🌱'}
                </span>
            )}
            <span className="min-w-0 flex-1">
                <span className="block break-words">
                    <span className={`text-[0.65rem] font-extrabold mr-1 ${kind === 'NEED' ? 'text-orange-800 dark:text-orange-300' : 'text-blue-800 dark:text-blue-300'}`}>
                        {kind === 'NEED' ? t('NEED', undefined, 'listing type') : t('OFFER', undefined, 'listing type')}
                    </span>
                    <span dir="auto">{item.title}</span>
                </span>
                {(price || km) && <span className="block text-xs text-text-secondary">{[price, km].filter(Boolean).join(' · ')}</span>}
            </span>
        </HomeLine>
    );
}

function MarketBody({
    m,
    isVisitor,
    myInterests,
    beansOn,
    onNavigate,
    nextImageLoading,
}: {
    m: NonNullable<HomeCards['market']>;
    isVisitor: boolean;
    myInterests: string[];
    beansOn: boolean;
    onNavigate: (page: string, id?: string) => void;
    nextImageLoading: () => 'eager' | 'lazy';
}) {
    const { wide } = useCardContainer();
    const items = starredFirst(m.items, i => i.category, isVisitor ? [] : myInterests);
    const examples = m.examples && m.items.length < 6;

    return (
        <div>
            <div
                data-testid="home-market-items"
                data-layout={wide ? 'tiles' : 'rows'}
                className={wide ? 'home-tiles-grid grid grid-cols-2 gap-3' : 'flex flex-col'}
            >
                {items.map(item => (
                    <MarketListingItem
                        key={item.id}
                        item={item}
                        testId="home-market-item"
                        beansOn={beansOn}
                        isVisitor={isVisitor}
                        wide={wide}
                        onNavigate={onNavigate}
                        nextImageLoading={nextImageLoading}
                    />
                ))}
            </div>
            {isVisitor && items.length > 0 && <p className="m-0 mt-1 text-xs text-text-secondary">{t(VISITOR_WORDS.listNote)}</p>}
            {examples && (
                <div data-testid="home-examples" className="mt-2">
                    <p className="m-0 mb-1 text-xs font-bold text-text-secondary">{t(EXAMPLE_WORDS.heading)}</p>
                    {EXAMPLE_LISTINGS.slice(0, 2).map(ex => (
                        <p key={ex.key} data-testid="home-example" className="m-0 py-1 text-sm text-text-primary flex items-start gap-2 min-w-0">
                            <span className="sr-only">{exampleLabel(ex)}</span>
                            <span aria-hidden="true" className="shrink-0">{ex.emoji}</span>
                            <span aria-hidden="true" className="min-w-0 break-words">
                                <span className="text-[0.65rem] font-extrabold mr-1 px-1 rounded bg-bg-hover text-text-primary">{t(EXAMPLE_WORDS.badge)}</span>
                                {t(ex.title)}
                            </span>
                        </p>
                    ))}
                    <p className="m-0 text-xs text-text-secondary">{t(EXAMPLE_WORDS.note)}</p>
                </div>
            )}
            <HomeMore onClick={() => onNavigate('marketplace')} label={t('See all of the Market')}>{t('See all ›')}</HomeMore>
        </div>
    );
}

function SearchBody({
    card,
    a,
    beansOn,
    onNavigate,
    nextImageLoading,
}: {
    card: HomeCardInstance;
    a: HomeAnswer;
    beansOn: boolean;
    onNavigate: (page: string, id?: string) => void;
    nextImageLoading: () => 'eager' | 'lazy';
}) {
    const { wide } = useCardContainer();
    const { q, km } = readSearchSettings(card.settings);
    const found = searchCardFor(a, card);
    const first = searchFirstLine(q, found ? found.km : km ?? null);

    return (
        <div>
            <p data-testid="home-search-words" className="m-0 mb-1 text-sm font-semibold text-text-primary break-words">{first}</p>
            {!found && <p data-testid="home-search-offline" className="m-0 text-sm text-text-primary break-words">{t(LIB_LINES.searchOffline)}</p>}
            {found && !found.items.length && <p data-testid="home-search-empty" className="m-0 text-sm text-text-primary break-words">{searchEmptyLine(q, found.km)}</p>}
            {found && found.items.length > 0 && (
                <div
                    data-testid="home-search-items"
                    data-layout={wide ? 'tiles' : 'rows'}
                    className={wide ? 'home-tiles-grid grid grid-cols-2 gap-3' : 'flex flex-col'}
                >
                    {found.items.map(item => (
                        <MarketListingItem
                            key={item.id}
                            item={item}
                            testId="home-search-item"
                            beansOn={beansOn}
                            isVisitor={false}
                            wide={wide}
                            onNavigate={onNavigate}
                            nextImageLoading={nextImageLoading}
                        />
                    ))}
                </div>
            )}
            {found?.more && (
                <HomeMore onClick={() => onNavigate('marketplace-search', q)} testId="home-search-more" label={q ? t('See more listings for {q} in the Market', { q }) : t('See more listings for this search in the Market')}>{t('See more ›')}</HomeMore>
            )}
        </div>
    );
}

function PulseBody({
    items,
    onNavigate,
    nextImageLoading,
}: {
    items: NonNullable<HomeCards['pulse']>['items'];
    onNavigate: (page: string) => void;
    nextImageLoading: () => 'eager' | 'lazy';
}) {
    const { wide } = useCardContainer();
    return (
        <div>
            <div
                data-testid="home-pulse-items"
                data-layout={wide ? 'tiles' : 'rows'}
                className={wide ? 'home-tiles-grid grid grid-cols-2 gap-3' : 'flex flex-col'}
            >
                {items.slice(0, 4).map(p => {
                    const thumb = p.thumbnailUrl ? resolvePulseThumbnailUrl(p.id) : null;
                    const postTitle = p.title || t('A new post');
                    const byLine = pulseByLine(p);
                    const label = t('{title}, by {name}. Opens the Pulse.', { title: postTitle, name: p.callsign });

                    if (wide) {
                        return (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => onNavigate('pulse')}
                                aria-label={label}
                                data-testid="home-pulse-tile"
                                className="w-full min-h-[44px] p-2 text-left bg-transparent border border-border-primary hover:bg-bg-hover rounded-xl cursor-pointer flex flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            >
                                {thumb ? (
                                    <img
                                        src={thumb}
                                        alt=""
                                        loading={nextImageLoading()}
                                        decoding="async"
                                        className="w-full h-24 rounded-lg object-cover bg-bg-hover mb-2"
                                    />
                                ) : (
                                    <span aria-hidden="true" className="w-full h-24 rounded-lg flex items-center justify-center text-2xl bg-bg-hover mb-2">
                                        📡
                                    </span>
                                )}
                                <span dir="auto" className="block text-sm font-semibold line-clamp-2 break-words text-text-primary mb-1">
                                    {postTitle}
                                </span>
                                <span className="block text-xs text-text-secondary break-words">
                                    {byLine}
                                </span>
                            </button>
                        );
                    }

                    return (
                        <HomeLine
                            key={p.id}
                            onClick={() => onNavigate('pulse')}
                            label={label}
                            testId="home-pulse-item"
                        >
                            {thumb ? (
                                <img
                                    src={thumb}
                                    alt=""
                                    loading={nextImageLoading()}
                                    decoding="async"
                                    className="shrink-0 w-12 h-12 rounded-lg object-cover bg-bg-hover"
                                />
                            ) : (
                                <span aria-hidden="true" className="shrink-0 w-12 h-12 rounded-lg flex items-center justify-center text-xl bg-bg-hover">
                                    📡
                                </span>
                            )}
                            <span className="min-w-0 flex-1">
                                <span dir="auto" className="block break-words line-clamp-2 font-semibold">{postTitle}</span>
                                <span className="block text-xs text-text-secondary break-words">{byLine}</span>
                            </span>
                        </HomeLine>
                    );
                })}
            </div>
            <HomeMore onClick={() => onNavigate('pulse')} label={t('See all of the Pulse')}>{t('See all ›')}</HomeMore>
        </div>
    );
}

function DealsBody({
    d,
    onNavigate,
}: {
    d: NonNullable<HomeCards['deals']>;
    onNavigate: (page: string, id?: string) => void;
}) {
    const items = d.items ?? [];
    if (items.length === 0) {
        return (
            <HomeLine onClick={() => onNavigate('marketplace', d.waitingOnMe?.postId)} label={t('Your deals: {line}', { line: dealsLine(d) })}>
                <span className="min-w-0 break-words">{dealsLine(d)}</span>
            </HomeLine>
        );
    }
    return (
        <div>
            {items.slice(0, 3).map(item => {
                const titleLine = dealTitleLine(item);
                const statusLine = dealStatusLine(item);
                const lineLabel = t('{title}. {status}', { title: titleLine, status: statusLine });
                return (
                    <HomeLine
                        key={item.txId}
                        onClick={() => onNavigate('marketplace', item.postId)}
                        label={lineLabel}
                        testId="home-deal-item"
                    >
                        <span className="min-w-0 flex-1">
                            <span className="block break-words font-semibold">{titleLine}</span>
                            <span className="block text-xs text-text-secondary break-words">
                                {item.waitsOnMe && (
                                    <span aria-hidden="true" className="shrink-0 text-amber-700 dark:text-amber-400 font-black mr-1">▲</span>
                                )}
                                {statusLine}
                            </span>
                        </span>
                    </HomeLine>
                );
            })}
            <HomeMore onClick={() => onNavigate('marketplace')} label={t('All deals')}>{t('All deals ›')}</HomeMore>
        </div>
    );
}

function EnterpriseBody({
    e,
    onNavigate,
}: {
    e: NonNullable<HomeCards['enterprise']>;
    onNavigate: (page: string, id?: string) => void;
}) {
    const lifecycleWord = e.lifecycle === 'bounded' ? t('project', undefined, 'lifecycle') : t('enterprise', undefined, 'lifecycle');
    const titleLine = `${e.name} · ${lifecycleWord}`;
    const requests = e.requests ? tn(e.requests, '{n} request to approve', '{n} requests to approve') : null;
    const keeperText = typeof e.keepers === 'number' ? tn(e.keepers, '{n} keeper', '{n} keepers') : null;
    const balanceText = typeof e.balance === 'number' && keeperText
        ? t('Balance {balance} · {keepers}', { balance: beansAmount(e.balance), keepers: keeperText })
        : typeof e.balance === 'number'
            ? t('Balance {balance}', { balance: beansAmount(e.balance) })
            : keeperText;
    const monthText = e.month ? monthSummaryLine(e.month) : null;
    const latestText = e.latest ? enterpriseLatestLine(e.latest) : null;

    const fullLine = [titleLine, balanceText, monthText, latestText, requests].filter(Boolean).join('. ');

    return (
        <div>
            <HomeLine
                onClick={() => onNavigate('enterprise', e.id)}
                label={e.lifecycle === 'bounded' ? t('{line}. Opens the project.', { line: fullLine }) : t('{line}. Opens the enterprise.', { line: fullLine })}
            >
                <span className="min-w-0 flex-1">
                    <span className="block break-words font-semibold">{titleLine}</span>
                    {balanceText && (
                        <span className="block text-xs text-text-secondary break-words">{balanceText}</span>
                    )}
                    {monthText && (
                        <span className="block text-xs text-text-secondary break-words">{monthText}</span>
                    )}
                    {latestText && (
                        <span className="block text-xs text-text-secondary break-words">{latestText}</span>
                    )}
                    {requests && (
                        <span className="block text-xs font-bold text-amber-700 dark:text-amber-400 break-words">{requests}</span>
                    )}
                </span>
            </HomeLine>
            {e.others > 0 && (
                <p className="m-0 mt-1 text-xs text-text-secondary">{tn(e.others, 'and {n} more you keep', 'and {n} more you keep')}</p>
            )}
        </div>
    );
}

function DecideBody({
    d,
    now,
    onNavigate,
}: {
    d: NonNullable<HomeCards['decide']>;
    now: number;
    onNavigate: (page: string, contextId?: string) => void;
}) {
    const items = d.items ?? [];
    if (items.length === 0 && !d.poll) {
        return (
            <HomeLine onClick={() => onNavigate('projects')} label={t('{line}. Opens Commons.', { line: decideLine(d, now) })}>
                <span className="min-w-0 break-words">{decideLine(d, now)}</span>
            </HomeLine>
        );
    }

    return (
        <div>
            {items.slice(0, 3).map(item => {
                const when = closesIn(item.closesAt, now);
                const votedStatus = item.voted ? t('You voted') : t('Not yet');
                const sub = [when, votedStatus].filter(Boolean).join(' · ');
                const label = sub ? t('{title} · {status}. Opens Commons.', { title: item.title, status: sub }) : t('{title}. Opens Commons.', { title: item.title });
                return (
                    <HomeLine key={item.id} onClick={() => onNavigate('projects')} label={label} testId="home-decide-item">
                        <span className="min-w-0 flex-1">
                            <span className="block break-words font-semibold">{item.title}</span>
                            {sub && <span className="block text-xs text-text-secondary break-words">{sub}</span>}
                        </span>
                    </HomeLine>
                );
            })}
            {d.poll && (() => {
                const pollCloses = closesIn(d.poll.closesAt, now);
                const pollHeading = t('Poll: {title}', { title: d.poll.title });
                const pollLabel = pollCloses
                    ? t('{title} · {status}. Opens the Market.', { title: pollHeading, status: pollCloses })
                    : t('{title}. Opens the Market.', { title: pollHeading });
                return (
                    <HomeLine
                        onClick={() => onNavigate('marketplace', d.poll!.id)}
                        label={pollLabel}
                        testId="home-decide-poll"
                    >
                        <span className="min-w-0 flex-1">
                            <span className="block break-words text-sm font-semibold">{pollHeading}</span>
                            {pollCloses && <span className="block text-xs text-text-secondary break-words">{pollCloses}</span>}
                        </span>
                    </HomeLine>
                );
            })()}
            <HomeMore onClick={() => onNavigate('projects')} label={t('Decide')}>{t('Decide ›')}</HomeMore>
        </div>
    );
}

function GroupsBody({
    groups,
    onNavigate,
}: {
    groups: NonNullable<HomeCards['groups']>;
    onNavigate: (page: string, id: string) => void;
}) {
    return (
        <div>
            {groups.items.map(g => {
                const status = g.unread > 0 ? tn(g.unread, '{n} new', '{n} new') : t('quiet');
                const line = `${g.name} · ${status}`;
                const lastLine = g.last ? groupLastLine(g.last) : null;
                const fullLabel = lastLine ? `${line}. ${lastLine}` : line;
                return (
                    <HomeLine
                        key={g.id}
                        onClick={() => onNavigate('messages', g.id)}
                        label={g.muted ? t('{line}, muted', { line: fullLabel }) : fullLabel}
                        testId="home-group-item"
                    >
                        <span className="min-w-0 flex-1">
                            <span className="block break-words font-semibold">{line}</span>
                            {lastLine && (
                                <span className="block text-xs text-text-secondary break-words line-clamp-1">
                                    {lastLine}
                                </span>
                            )}
                        </span>
                    </HomeLine>
                );
            })}
        </div>
    );
}

function BeansBody({
    b,
    onNavigate,
}: {
    b: NonNullable<HomeCards['beans']>;
    onNavigate: (page: string) => void;
}) {
    const lines = beansLines(b);
    const month = b.month ? monthSummaryLine(b.month) : null;
    const isNewcomer = !b.activated && Math.round(b.balance * 100) / 100 === 0;
    const tierBadge = !isNewcomer && b.tier ? tierWords(b.tier) : null;
    const note = isNewcomer ? lines.note : null;
    const fullLine = [lines.line, month].filter(Boolean).join('. ');

    return (
        <HomeLine
            onClick={() => onNavigate('ledger')}
            label={lines.note ? t('{line}. {note}. Opens the Ledger.', { line: fullLine, note: lines.note }) : t('{line}. Opens the Ledger.', { line: fullLine })}
        >
            <span className="min-w-0 flex-1">
                <span className="block break-words font-semibold">{lines.line}</span>
                {month && <span className="block text-xs text-text-secondary break-words">{month}</span>}
                {note && <span className="block text-xs text-text-secondary break-words">{note}</span>}
            </span>
            {tierBadge && (
                <span className="shrink-0 self-center text-xs font-semibold px-2 py-0.5 rounded-full bg-bg-hover text-text-secondary border border-border-primary">
                    {tierBadge}
                </span>
            )}
        </HomeLine>
    );
}

function CommunityBody({
    cm,
    profile,
    isVisitor,
    onAddCard,
    onEditHome,
}: {
    cm: NonNullable<HomeCards['community']>;
    profile: string;
    isVisitor: boolean;
    onAddCard: () => void;
    onEditHome: () => void;
}) {
    const { wide } = useCardContainer();
    const isGlobal = profile === 'global';
    const hasDetailedStats = !isGlobal
        ? (typeof cm.joined7d === 'number' || typeof cm.commonsPot === 'number' || typeof cm.listings === 'number' || typeof cm.eventsSoon === 'number')
        : typeof cm.listings === 'number';

    const globalTiles = [
        { figure: formatCount(cm.members), label: tn(cm.members, 'member', 'members') },
        ...(typeof cm.communities === 'number' ? [{ figure: formatCount(cm.communities), label: tn(cm.communities, 'community listed', 'communities listed') }] : []),
        ...(typeof cm.listings === 'number' ? [{ figure: formatCount(cm.listings), label: tn(cm.listings, 'listing', 'listings') }] : []),
    ];

    const localTiles = [
        { figure: formatCount(cm.members), label: tn(cm.members, 'member', 'members') },
        ...(typeof cm.joined7d === 'number' ? [{ figure: formatCount(cm.joined7d), label: t('joined this week') }] : []),
        ...(typeof cm.tradesThisMonth === 'number' ? [{ figure: formatCount(cm.tradesThisMonth), label: t('trades this month') }] : []),
        ...(typeof cm.commonsPot === 'number' ? [{ figure: beansAmount(cm.commonsPot), label: t('Commons pot') }] : []),
        ...(typeof cm.listings === 'number' ? [{ figure: formatCount(cm.listings), label: tn(cm.listings, 'listing', 'listings') }] : []),
        ...(typeof cm.eventsSoon === 'number' ? [{ figure: formatCount(cm.eventsSoon), label: tn(cm.eventsSoon, 'event coming up', 'events coming up') }] : []),
    ];

    const tiles = isGlobal ? globalTiles : localTiles;

    const globalLine1 = tn(cm.members, '{n} member', '{n} members', { n: formatCount(cm.members) });
    const globalLine2 = typeof cm.communities === 'number' ? tn(cm.communities, '{n} community listed', '{n} communities listed', { n: formatCount(cm.communities) }) : null;
    const globalLine3 = typeof cm.listings === 'number' ? tn(cm.listings, '{n} listing', '{n} listings', { n: formatCount(cm.listings) }) : null;

    const isSolo = cm.members === 1 && !isVisitor;
    const localLine1 = isSolo
        ? t("1 member. You're first. Invite someone.")
        : [
            tn(cm.members, '{n} member', '{n} members'),
            typeof cm.joined7d === 'number' ? tn(cm.joined7d, '{n} joined this week', '{n} joined this week') : null,
        ].filter(Boolean).join(' · ');

    const localLine2 = [
        typeof cm.tradesThisMonth === 'number' ? tn(cm.tradesThisMonth, '{n} trade this month', '{n} trades this month') : null,
        typeof cm.commonsPot === 'number' ? t('Commons pot {amount}', { amount: beansAmount(cm.commonsPot) }) : null,
    ].filter(Boolean).join(' · ');

    const localLine3 = [
        typeof cm.listings === 'number' ? tn(cm.listings, '{n} listing', '{n} listings') : null,
        typeof cm.eventsSoon === 'number' ? tn(cm.eventsSoon, '{n} event coming up', '{n} events coming up') : null,
    ].filter(Boolean).join(' · ');

    const line1 = isGlobal ? globalLine1 : localLine1;
    const line2 = isGlobal ? globalLine2 : localLine2;
    const line3 = isGlobal ? globalLine3 : localLine3;

    return (
        <div>
            {wide && hasDetailedStats ? (
                <>
                    {isSolo && (
                        <p className="m-0 mb-3 text-sm text-text-primary break-words">
                            {t("1 member. You're first. Invite someone.")}
                        </p>
                    )}
                    <div data-testid="home-community-body" data-layout="tiles" className={isGlobal || tiles.length === 3 ? "grid grid-cols-3 gap-2 mb-3" : tiles.length === 4 ? "grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3" : "grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3"}>
                        {tiles.map((tile, i) => (
                            <div key={i} data-testid="home-community-tile" className="p-2 rounded-xl bg-bg-hover text-center flex flex-col justify-center min-w-0">
                                <span className="text-base font-bold text-text-primary break-words leading-tight">{tile.figure}</span>
                                <span className="text-[0.7rem] text-text-secondary break-words leading-tight">{tile.label}</span>
                            </div>
                        ))}
                    </div>
                </>
            ) : hasDetailedStats ? (
                <div data-testid="home-community-body" data-layout="rows" className="mb-2">
                    <p className="m-0 text-sm text-text-primary break-words">{line1}</p>
                    {line2 ? <p className="m-0 text-sm text-text-secondary break-words">{line2}</p> : null}
                    {line3 ? <p className="m-0 text-sm text-text-secondary break-words">{line3}</p> : null}
                </div>
            ) : (
                <div data-testid="home-community-body" data-layout="rows" className="mb-2">
                    <p className="m-0 text-sm text-text-primary break-words">
                        {cm.members === 1 && !isVisitor ? t("1 member. You're first. Invite someone.") : t('{line}.', { line: communityLine(cm, profile) })}
                    </p>
                </div>
            )}
            {!isVisitor && (
                <div className="flex flex-wrap justify-end gap-x-4">
                    <HomeMore onClick={onAddCard} testId="home-add-open" label={t('Add a card to Home')}>{t('Add a card ›')}</HomeMore>
                    <HomeMore onClick={onEditHome} testId="home-edit-open" label={t('Edit home: the cards on Home and their order')}>{t('Edit home ›')}</HomeMore>
                </div>
            )}
        </div>
    );
}

export function HomePage({ identity, visitor, onNavigate, onSeeWords, saveSearch, onSaveSearchTaken, addCardType, onAddCardTaken }: Props) {
    const publicKey = visitor ? null : identity?.publicKey ?? null;
    // Moves on when a clear (here or in another tab) has this page land again: the community may have changed with it.
    const [landing, setLanding] = useState(0);
    const cacheKey = useMemo(() => homeCacheKey(publicKey), [publicKey, landing]);

    const [answer, setAnswer] = useState<HomeAnswer | null>(null);
    // The layout drawn: this browser's copy, or the newcomer's list drawn for an unknown (empty version-1) account list.
    const [layout, setLayout] = useState<HomeLayoutV2 | null>(null);
    const [status, setStatus] = useState<'loading' | 'ready' | 'offline' | 'failed' | 'signed-out'>('loading');
    // Which failure, not its words: the words are written at render, so a language switch translates them (#1947 review
    // N2). A refusal the node wrote (401/403) is kept as the node wrote it.
    const [failure, setFailure] = useState<'notOnNode' | 'failed' | { message: string } | null>(null);
    const [live, setLive] = useState('');
    // The interests the page holds after a tap (saved in the background); null: the answer's.
    const [interests, setInterests] = useState<string[] | null>(null);
    // Once shown or opened from Tune, the interests card stays for this visit: a first tap must not take it away.
    const [interestsOpen, setInterestsOpen] = useState(false);
    // "Your way back in" is drawn: only the card knows (its schedule is in this browser), and it says so before the paint.
    const [safetyDrawn, setSafetyDrawn] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    // A card's Settings… (from its "…" or Edit home).
    const [settingsFor, setSettingsFor] = useState<HomeCardInstance | null>(null);
    // The node refused the version-2 layout (a node from before the frame): Edit home says the cards stay here (§2.3).
    const [notOnAccount, setNotOnAccount] = useState(false);
    const [fewerOpen, setFewerOpen] = useState(false);
    const [point, setPoint] = useState<HomePoint | null>(() => marketPoint());
    const [pointProblem, setPointProblem] = useState<string | null>(null);
    // "Or type your town" (Marty, 14 Oct): the shared address search, open; and the town picked, by its short name.
    const [townOpen, setTownOpen] = useState(false);
    const [townName, setTownName] = useState<string | null>(null);
    // The find card's two ways on when nothing listed is near (Sonnet review S5; the phone's FindCommunityBody): start one
    // (the screen the 🏘️ sheet opens), or be told.
    const [startOpen, setStartOpen] = useState(false);
    const [watched, setWatched] = useState(false);
    const [watchNote, setWatchNote] = useState<string | null>(null);
    const [reveal, setReveal] = useState(false);
    const [hintOpen, setHintOpen] = useState(false);
    /** The tour ended in this browser (Done or Skip) before the account's answer says so (DESIGN-getting-started-fable.md §2). */
    const [tourOver, setTourOver] = useState(false);
    const tourOverRef = useRef(false);
    tourOverRef.current = tourOver;
    /** A tour part way in this browser, for "Pick up the tour at step n ›". */
    const [tourProgress, setTourProgress] = useState<TourProgress | null>(null);
    const { run: tourRun, pendingEnd, pendingAgain } = useTour();
    // The Tips card's record as changed on this landing (Next, Don't show, Edit home); another landing's is not this one's.
    const [tipsChanged, setTipsChanged] = useState<{ landing: string; record: TipsRecord } | null>(null);
    const tipsRef = useRef<TipsRecord | null>(null);
    // The landing whose once-a-day advance has been written: once per landing, never while Home is in front.
    const tipsLandedFor = useRef<string | null>(null);

    const statusRef = useRef(status);
    const answerRef = useRef<HomeAnswer | null>(null);
    // The node's tag for the answer drawn: the next read sends it, and is a 304 while nothing changed.
    const etagRef = useRef<string | null>(null);
    // This browser's own copy of the layout (the account's once read, or the member's edit); null while it has none.
    const layoutRef = useRef<HomeLayoutV2 | null>(null);
    const drawnRef = useRef<HomeLayoutV2 | null>(null);
    // Set while this browser's copy is an edit made on the newcomer's list drawn for an unknown account list: that list's
    // date (lib/home-layout.ts pickLayout). Such an edit is never sent by itself: a read decides (review of #1699, finding 2).
    const overRef = useRef<string | undefined>(undefined);
    // While marked: the edits this browser sent (each its date and its list's print). A version-2 answer that is one of them
    // is this browser's own save, not the account's real list (lib/home-layout.ts ownMarkedSave; review of #1701
    // confirmation, finding 2; review of #1715, finding 1).
    const overSentRef = useRef<MarkSent[]>([]);
    // The node refused this browser's version-2 layout on this landing: it is sent again at the next landing, never in a loop.
    const refusedLanding = useRef(false);
    // The one extra read a landing makes for cards the answer wasn't built for (review of #1697, note a: bounded).
    const extraRead = useRef(false);
    // After an add: the new card, whose "…" takes focus once it is drawn; `read`: the add's read of Home has answered, so a
    // card still not drawn has nothing to show, and focus stays on Add a card (review of #1701, finding 3).
    const focusAfterAdd = useRef<{ id: string; read: boolean } | null>(null);
    const [addRead, setAddRead] = useState(0);
    const unsavedRef = useRef(false);
    const layoutSeq = useRef(0);
    // Layout saves still on their way: a read meanwhile doesn't send the same layout again.
    const savingLayout = useRef(0);
    // The cards the answer drawn was built for (the `cards=` it was read with, or the node's own choice: builtFor); null: not known.
    const builtForRef = useRef<string[] | null>(null);
    const inFlight = useRef(false);
    const again = useRef(false);
    const lastStart = useRef(0);
    const mounted = useRef(true);
    const pointRef = useRef(point);
    pointRef.current = point;
    const interestsCardRef = useRef<HTMLDivElement | null>(null);
    const pageRef = useRef<HTMLDivElement | null>(null);
    const [measurePage, cols] = useHomeColumns();
    const setPage = useCallback((el: HTMLDivElement | null) => { pageRef.current = el; measurePage(el); }, [measurePage]);
    // After a Hide: the cards to give focus to, nearest first (the card itself is gone, and so is its "…").
    const focusAfterHide = useRef<string[] | null>(null);
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
    const keep = useCallback((a: HomeAnswer, l: HomeLayoutV2 | null, epoch: number) => {
        void writeCachedHome(cacheKey, {
            answer: a, asked: builtForRef.current, etag: etagRef.current, layout: l, layoutUnsaved: unsavedRef.current,
            ...(overRef.current !== undefined ? { localOnlyOver: overRef.current, localOnlySent: overSentRef.current } : {}), savedAt: Date.now(),
        }, epoch);
    }, [cacheKey]);

    const draw = (l: HomeLayoutV2 | null) => { drawnRef.current = l; setLayout(l); };

    /*
     * Save the layout on the account, as the phone does (apps/native/app/(tabs)/index.tsx pushLayout). A 400 from a node
     * whose Home answer is version 1 (or has none) is a node from before the card frame: the cards stay in this browser,
     * Edit home says so, and they are sent again at the next landing, never in a loop (CARD-FRAME §2.3). Any other refusal:
     * the account's copy stands and this one is never sent again by itself. A success clears both.
     */
    const saveLayout = useCallback((next: HomeLayoutV2): Promise<void> => {
        // Signed out or cleared, here or in another tab: nothing more is sent as that account.
        const epoch = landedEpoch();
        if (!publicKey || epoch === null) return Promise.resolve();
        const seq = ++layoutSeq.current;
        savingLayout.current += 1;
        if (overRef.current !== undefined) overSentRef.current = rememberMarkSent(overSentRef.current, next);
        return saveHomePreferences(publicKey, { 'home.layout': next })
            .finally(() => { savingLayout.current -= 1; })
            .then((r) => {
                if (!mounted.current || seq !== layoutSeq.current || !holds(epoch)) return;
                // A newer edit made here while this save was out, and not sent by itself (one made while marked, which a
                // read decided): it is sent now, as any edit on the member's own list (review of #1701 confirmation,
                // finding 2). Otherwise this answer marked it saved and it waited, unsent, for some later read.
                const waiting = unsavedRef.current && layoutRef.current && layoutRef.current !== next ? layoutRef.current : null;
                unsavedRef.current = false;
                refusedLanding.current = false;
                // On the account now: the list is the member's, no longer an edit on an unknown one (the phone's
                // clearPhoneOnly; review of #1701, finding 1: the next edit was otherwise thrown away unsent).
                overRef.current = undefined;
                overSentRef.current = [];
                setNotOnAccount(false);
                // What the node kept: this layout, or a newer one saved from another device (a phone's, another tab's).
                const kept = readLayout(r['home.layout']);
                if (kept && (kept.updatedAt ?? '') > (next.updatedAt ?? '')) {
                    // Newer than this save: the node dropped it. That list stands, and an edit that waited on this save
                    // goes with it, unsent: it was made on a list the account no longer holds (review of #1715, finding 2).
                    layoutRef.current = kept;
                    draw(kept);
                } else if (waiting) {
                    // The node kept this save (never dated later than sent: the node only holds a date to its now).
                    unsavedRef.current = true;
                } else if (kept && layoutRef.current === next && kept.updatedAt !== next.updatedAt && sameList(kept, next)) {
                    // This save, dated earlier by the node (a clock ahead of the node's is held to its now): that date is
                    // this browser's copy's too, so no read takes the copy as newer and sends it again (review of #1715, note 1).
                    layoutRef.current = kept;
                    draw(kept);
                }
                if (answerRef.current) keep(answerRef.current, layoutRef.current, epoch);
                if (unsavedRef.current && waiting) void saveLayout(waiting);
            }, (e: unknown) => {
                if (!mounted.current || seq !== layoutSeq.current || !holds(epoch)) return;
                const code = (e as { status?: number } | null)?.status;
                // Not a refusal (no connection, a timeout, too many): kept in this browser, sent again after the next read.
                if (typeof code !== 'number' || code < 400 || code >= 500 || code === 408 || code === 429) return;
                const answered = answerRef.current?.layout;
                if (code === 400 && (!answered || layoutV1Of(answered))) {
                    refusedLanding.current = true;
                    setNotOnAccount(true);
                    return;
                }
                unsavedRef.current = false;
                overRef.current = undefined;
                overSentRef.current = [];
                const account = readLayout(answered);
                layoutRef.current = account;
                draw(account);
                if (answerRef.current) keep(answerRef.current, account, epoch);
            });
    }, [publicKey, keep, holds, landedEpoch]);

    // The cards an answer read with no `cards=` was built for: the node's own choice from the account's list.
    const builtFor = (a: HomeAnswer): string[] => cardsToAsk(readLayout(a.layout), askPinned(a, Date.now()), frameOf(a));

    const fetchHome = useCallback(async (why: 'landing' | 'doorbell' | 'poll' | 'return' | 'retry' | 'point' | 'layout') => {
        // Signed out, here or in another tab: nothing more is read as that account. Cleared since the page landed: it
        // lands again (the news has it do so), and that landing reads afresh, as the current account.
        const epoch = landedEpoch();
        if (epoch === null) return;
        if (inFlight.current) { again.current = true; return; }
        inFlight.current = true;
        lastStart.current = Date.now();
        try {
            const p = sentPoint(pointRef.current, drawnRef.current);
            // `cards=` from the list drawn (lib/home-layout.ts cardsToAsk), the newcomer's for a member with none; none only on
            // a first read with no answer in hand, so the node draws the account's own list (review of #1697, note a). Never
            // left off after that: the node would build its whole old catalogue every read (review of #1701, finding 6).
            const held = answerRef.current;
            const sent = drawnRef.current || (held?.me && !held.welcome)
                ? cardsToAsk(drawnRef.current, askPinned(held, Date.now()), held ? frameOf(held) : null) : undefined;
            const readPromise = getHome({ cards: sent, ...(p ? { lat: p.lat, lng: p.lng } : {}) },
                answerRef.current ? etagRef.current : null);
            markHomeInflight(readPromise);
            const read = await readPromise;
            // The page has gone, or a sign-out or a clear came while the read was out: what it brought is not this
            // page's to draw or keep any more.
            if (!mounted.current || !holds(epoch)) return;
            // 304: the copy drawn is still the answer, layout and all (its tag covers the cards asked). Anything not sent
            // since is sent again.
            if (read?.notModified && answerRef.current) {
                recordHomeAnswer(answerRef.current, publicKey);
                builtForRef.current = sent ?? builtFor(answerRef.current);
                if (unsavedRef.current && layoutRef.current && savingLayout.current === 0 && !refusedLanding.current) void saveLayout(layoutRef.current);
                // The account's interests are the ones in the copy drawn: a change made here that never reached them is
                // sent again while they are unchanged since (lib/home-interests.ts).
                const me = answerRef.current.me;
                if (publicKey && me) {
                    const settled = settleInterests(publicKey, me.interests, me.interestsUpdatedAt);
                    setInterests(settled.movedUp ? settled.interests : null);
                }
                if (statusRef.current === 'offline' || why === 'retry') setLive(t('Home updated.'));
                statusRef.current = 'ready';
                setStatus('ready');
                return;
            }
            const a = read && !read.notModified ? read.answer : null;
            // Only an answer shaped as Home is drawn (a proxy's page or an odd reply is a failed read, never a crash).
            if (!a || typeof a !== 'object' || !a.cards || typeof a.cards !== 'object' || Array.isArray(a.cards)) throw new Error('not a Home answer');
            recordHomeAnswer(a, publicKey);
            etagRef.current = read && !read.notModified ? read.etag : null;
            // Which list stands (lib/home-layout.ts pickLayout): the account's or this browser's, by date, with the standby tie
            // and the empty version-1 "unknown" rule. A visitor keeps no layout.
            const account = readLayout(a.layout);
            const v1 = layoutV1Of(a.layout);
            const local = layoutRef.current;
            const member = !!a.me && !a.welcome;
            if (member && overRef.current !== undefined && ownMarkedSave(account, v1, overSentRef.current)) {
                // This browser's own marked save, read back (the read overtook the save's answer): the account's list is
                // known and is this browser's, so the mark goes and the dates decide (a newer edit made since wins).
                overRef.current = undefined;
                overSentRef.current = [];
            }
            const pick = member ? pickLayout(account, local, v1, overRef.current) : { layout: null, push: false };
            if (member && account && !v1) {
                // A version-2 answer: this node keeps the new shape, so nothing waits on it any more.
                refusedLanding.current = false;
                setNotOnAccount(false);
                // The account's real list is back: it stands, and the edit made on the unknown one goes, unsent.
                if (overRef.current !== undefined && !pick.push) { overRef.current = undefined; overSentRef.current = []; }
            }
            // The newcomer's list drawn for an unknown account list is not this browser's copy: nothing of it is sent.
            const unknown = member && !local && !!v1?.empty;
            unsavedRef.current = !!pick.layout && pick.layout === local && (pick.push || unsavedRef.current);
            layoutRef.current = unknown ? null : pick.layout;
            const fewerFrom = v1?.empty && !local ? null : account;
            if (member && publicKey && fewerCardsNews(fewerFrom, local, a.me, Date.now()) && !readFlag(fewerKey(publicKey))) {
                writeFlag(fewerKey(publicKey));
                setFewerOpen(true);
            }
            if (publicKey && a.me) {
                // The account's interests are this browser's Market favourites too; a change made here that never reached
                // the account (while it is unchanged since), and ones an older build kept only here, are sent up instead.
                const settled = settleInterests(publicKey, a.me.interests, a.me.interestsUpdatedAt);
                setInterests(settled.movedUp ? settled.interests : null);
            }
            builtForRef.current = sent ?? builtFor(a);
            answerRef.current = a;
            setAnswer(a);
            draw(pick.layout);
            if (statusRef.current === 'offline' || why === 'retry') setLive(t('Home updated.'));
            statusRef.current = 'ready';
            setStatus('ready');
            setFailure(null);
            keep(a, layoutRef.current, epoch);
            // This browser's list, newer than the account's (an edit made offline, or one whose save failed), is sent; one the
            // node refused as a shape it doesn't know yet only at the next landing.
            const saving = unsavedRef.current && layoutRef.current && !refusedLanding.current && savingLayout.current === 0
                ? saveLayout(layoutRef.current) : null;
            // The list drawn asks for cards this answer wasn't built for (a first landing here, or another device's edit), or
            // has Home's point go otherwise (a saved search closer than the list it was read by): one more read for them,
            // once a landing, after the save's answer.
            const built = builtForRef.current ?? [];
            const goes = sentPoint(pointRef.current, pick.layout);
            const moved = !!p && !!goes && (goes.lat !== p.lat || goes.lng !== p.lng);
            if (member && !extraRead.current && (moved || cardsToAsk(pick.layout, askPinned(a, Date.now()), frameOf(a)).some(id => !built.includes(id)))) {
                extraRead.current = true;
                if (saving) void saving.then(() => fetchHomeRef.current?.('layout'));
                else again.current = true;
            }
        } catch (e) {
            if (!mounted.current || !holds(epoch)) return;
            const standing = standingFromRefusal(e);
            if (standing) {
                answerRef.current = null;
                setAnswer(null);
                statusRef.current = 'failed';
                setStatus('failed');
                setFailure({ message: standing.sentence });
                setLive(standing.sentence);
            } else if (answerRef.current) {
                statusRef.current = 'offline';
                setStatus('offline');
                setLive(t(HOME_WORDS.offline));
            } else {
                statusRef.current = 'failed';
                setStatus('failed');
                const code = (e as { status?: number } | null)?.status;
                // 404: a server from before Home (lib/api.ts isRouteMissing).
                const said = (e as Error | null)?.message;
                setFailure(code === 404 ? 'notOnNode' : (code === 401 || code === 403) && said ? { message: said } : 'failed');
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
        drawnRef.current = null;
        overRef.current = undefined;
        overSentRef.current = [];
        refusedLanding.current = false;
        extraRead.current = false;
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
                recordHomeAnswer(cached.answer, publicKey);
                answerRef.current = cached.answer;
                builtForRef.current = cached.asked ?? null;
                etagRef.current = cached.etag;
                layoutRef.current = cached.layout;
                overRef.current = cached.localOnlyOver;
                overSentRef.current = cached.localOnlySent ?? [];
                unsavedRef.current = cached.layoutUnsaved;
                setAnswer(cached.answer);
                const ans = cached.answer;
                draw(ans.me && !ans.welcome ? pickLayout(readLayout(ans.layout), cached.layout, layoutV1Of(ans.layout), cached.localOnlyOver).layout : null);
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
        drawnRef.current = null;
        overRef.current = undefined;
        overSentRef.current = [];
        builtForRef.current = null;
        unsavedRef.current = false;
        setAnswer(null);
        setLayout(null);
        setInterests(null);
        setEditOpen(false);
        setPickerOpen(false);
        setSettingsFor(null);
        setNotOnAccount(false);
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
    const shown = answer ? shownFrame(answer, layout, { now, interests: myInterests, interestsOpen, tipsUp: !!tipsView, tourOver }) : [];
    /** The layout edits start from: the one drawn, or the starter set for a Home never saved once the tour has ended. */
    const drawnBase = () => shownLayout(answerRef.current, drawnRef.current, { tourOver: tourOverRef.current });
    const startUp = shown.some(c => c.type === 'start');

    // ── "Save this search to Home" from the Market (Marty, 7 Oct) ──
    // The search to add, its dialog open; and why one couldn't be (the same search there, five there, Home full, Home not
    // answered), shown until closed and said: never a silent no.
    const [addSearch, setAddSearch] = useState<HomeSearchSettings | null>(null);
    const [saveNote, setSaveNote] = useState<string | null>(null);
    const noteSaveSearch = (line: string) => { setSaveNote(line); setLive(line); };
    // The search handed over that this page has taken: each is taken once, even before App lets go of it.
    const takenSearch = useRef<HomeSearchSettings | null>(null);
    useEffect(() => {
        if (!saveSearch) { takenSearch.current = null; return; }
        if (status === 'loading' || !answer || takenSearch.current === saveSearch) return;
        takenSearch.current = saveSearch;
        onSaveSearchTaken?.();
        setSaveNote(null);
        if (answer.welcome || !answer.me || visitor) { noteSaveSearch(t(LIB_LINES.saveSearchNotNow)); return; }
        const state = saveSearchState(drawnBase(), saveSearch);
        if (state !== 'add') { noteSaveSearch(saveSearchLine(state, saveSearch.q)!); return; }
        pageRef.current?.scrollIntoView?.({ block: 'start' });
        setAddSearch(saveSearch);
    }, [saveSearch, status, answer]);

    // ── A tool's Home card, from its one offer inside the tool (T0.3) ──
    // Taken once, as the saved search is; added as the picker adds (first, under Needs you, said). A card already on Home,
    // or one Home can't take, is left as it is.
    const takenCardType = useRef<string | null>(null);
    useEffect(() => {
        if (!addCardType) { takenCardType.current = null; return; }
        if (status === 'loading' || !answer || takenCardType.current === addCardType) return;
        takenCardType.current = addCardType;
        onAddCardTaken?.();
        if (answer.welcome || !answer.me || visitor) return;
        if (drawnBase()?.cards.some(c => c.type === addCardType)) return;
        addToHome(addCardType);
    }, [addCardType, status, answer]);

    // ── The tour's Home side (DESIGN-getting-started-fable.md §2–§3) ──
    // The bar is App's (lib/tour-store.ts); Home lends it the chips (Add's own path) and applies the end as it opens: one
    // layout write, then the account's record. Nothing here starts a tour by itself.
    // With the global showcase on, Commons and Ledger are previews there and the tour has their steps, as the phone's does (T5).
    const tourNode = { global: String(answer?.profile) === 'global', beans: answer?.features.beans !== false, showcase: answer?.features.showcase === true };
    const tourTotal = tourSteps('web', tourNode).length;
    const member = !!answer?.me && !answer.welcome && !visitor;
    const chips = member && answer ? tourChips(frameOf(answer), null, { members: answer.cards.community?.members ?? null }) : [];
    const addToHomeRef = useRef<(type: string) => void>(() => {});
    async function sendTourRecord(pk: string, record: ReturnType<typeof tourRecord>) {
        try {
            await saveHomePreferences(pk, { tour: record });
            keepPendingTourRecord(pk, null);
        } catch (err) {
            // Offline or a node that is down: kept in this browser and sent on the next Home open. A node that refuses it
            // outright (4xx: a node from before the tour) drops it, as the phone does: the layout write ends the card here.
            const status = (err as { status?: number } | null)?.status;
            keepPendingTourRecord(pk, typeof status === 'number' && status >= 400 && status < 500 ? null : record);
        }
    }
    function applyTourEnd(kind: 'done' | 'skipped') {
        if (!publicKey) return;
        const answered = answerRef.current;
        tourOverRef.current = true;
        setTourOver(true);
        setTourProgress(null);
        if (answered?.me && !answered.welcome) {
            changeLayout(() => endTourLayout(drawnRef.current, { pinned: pinnedCards(frameOf(answered), Date.now()) }), { reread: true });
        }
        if (kind === 'done') { setHintOpen(false); writeFlag(hintKey(publicKey)); }
        else setHintOpen(!readFlag(hintKey(publicKey)));
        void sendTourRecord(publicKey, tourRecord(kind));
    }
    function tourAgain() {
        if (!publicKey) return;
        const answered = answerRef.current;
        tourOverRef.current = false;
        setTourOver(false);
        // The card returns until the tour ends again: on a Home already set up it is put back on top (the end takes it off).
        if (answered?.me && drawnRef.current) {
            const r = addCard(drawnRef.current, 'start', Date.now(), { pinned: pinnedCards(frameOf(answered), Date.now()) });
            if (r.ok) changeLayout(() => r.layout);
        }
        void sendTourRecord(publicKey, tourRecord('open'));
        startTour(publicKey, tourNode, 0);
    }
    useEffect(() => {
        if (!publicKey || !member) return;
        const kind = takePendingEnd(publicKey);
        if (kind) applyTourEnd(kind);
        if (takeTourAgain(publicKey)) tourAgain();
    }, [publicKey, member, pendingEnd, pendingAgain]);
    // App holds the install banner back while the tour is offered here (rehearsal 14 Oct, B1): said once Home has an answer.
    useEffect(() => {
        if (publicKey && answer) offerTour(publicKey, member && startUp);
    }, [publicKey, !!answer, member, startUp]);
    // A tour part way is read whenever the bar closes; a Done or Skip the node didn't take is sent again.
    useEffect(() => {
        if (!publicKey || !member) return;
        setTourProgress(tourRun ? null : readProgress(publicKey));
        const pending = pendingTourRecord(publicKey);
        if (pending && !tourRun) void sendTourRecord(publicKey, pending);
    }, [publicKey, member, landing, !!tourRun]);
    const chipsKey = chips.join(',');
    useEffect(() => {
        if (!member || !answer) { lendTourHome(null); return; }
        const profileName = String(answer.profile);
        lendTourHome({
            chips,
            chipName: (t) => cardName(t, profileName),
            onHome: (t) => listOf(drawnBase()).some(c => c.type === t),
            addChip: (t) => addToHomeRef.current(t),
            moreCards: () => setPickerOpen(true),
        });
    }, [member, answer, layout, tourOver, chipsKey]);
    useEffect(() => () => lendTourHome(null), []);
    const interestsShown = shown.some(c => c.type === 'interests');
    // A card shown as Home opened stays open for the visit (a first tap must not take it away).
    useEffect(() => {
        if (interestsShown && !interestsOpen) setInterestsOpen(true);
    }, [interestsShown]);

    /**
     * A layout change made here (a card's "…", Edit home). Returns false when it was made on a Home this page no longer
     * holds: a sign-out or a clear this call was the first to hear of (landedEpoch). The change goes with what the page
     * held, drawn, kept and sent nowhere, and the page lands again.
     */
    function changeLayout(make: (current: HomeLayoutV2 | null) => HomeLayoutV2 | null, opts: { reread?: boolean; afterRead?: () => void } = {}): boolean {
        const epoch = landedEpoch();
        const answered = answerRef.current;
        if (epoch === null || !answered?.me || answered.welcome) return false;
        // A Home never saved is the starter set once the tour has ended: edits start from what is drawn.
        const before = shownLayout(answered, drawnRef.current, { tourOver: tourOverRef.current });
        const next = make(before);
        if (!next) return false;
        if (overRef.current === undefined && !layoutRef.current && layoutV1Of(answered.layout)?.empty) {
            // Made while the account's list is unknown: this browser's only, until the account's real list answers.
            overRef.current = rawDate(answered.layout);
            overSentRef.current = [];
        }
        unsavedRef.current = true;
        layoutRef.current = next;
        draw(next);
        keep(answered, next, epoch);
        if (overRef.current !== undefined) {
            // Never sent by itself, as the account's real list may be back (the primary after a standby): a read decides,
            // and sends the edit only if it still stands (review of #1699 confirmation, finding 1).
            void fetchHomeRef.current('layout').then(opts.afterRead);
            return true;
        }
        // Refused on this landing as a shape the node doesn't know yet: kept here, sent at the next landing.
        const saving = refusedLanding.current ? Promise.resolve() : saveLayout(next);
        // An add, a card's settings, Reset, or a card the answer wasn't built for: read Home again once the save is
        // answered (the node builds an instance from the settings it keeps). A move or a remove reads nothing.
        const pins = askPinned(answered, Date.now());
        const had = builtForRef.current ?? cardsToAsk(before, pins, frameOf(answered));
        if (opts.reread || cardsToAsk(next, pins, frameOf(answered)).some(id => !had.includes(id))) void saving.then(() => fetchHomeRef.current('layout')).then(opts.afterRead);
        else opts.afterRead?.();
        return true;
    }

    // After a Remove, focus goes to the nearest card left (its "…", else its heading; Edit home on the community card),
    // never to the page's <body>. After an add, to the new card's "…" once it is drawn; until then, and for good once the
    // add's read finds nothing to show, to the community card's Add a card (review of #1701, finding 3). Focus the member
    // moved on themselves meanwhile stays where they put it.
    useEffect(() => {
        const added = focusAfterAdd.current;
        if (added) {
            const card = pageRef.current?.querySelector<HTMLElement>(`[data-testid="home-card-${added.id}"]`);
            const target = card?.querySelector<HTMLElement>('[data-testid="home-card-menu"]') ?? card?.querySelector<HTMLElement>('h2');
            const waiting = pageRef.current?.querySelector<HTMLElement>('[data-testid="home-add-open"]');
            const active = document.activeElement;
            const free = !active || active === document.body || !active.isConnected || active === waiting;
            if (target || added.read) focusAfterAdd.current = null;
            if (free) (target ?? waiting)?.focus();
        }
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
    }, [layout, tips, answer, addRead]);

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
        if (!navigator.geolocation) { setPointProblem(t("This browser can't share a location.")); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const p = { lat: coarse(pos.coords.latitude), lng: coarse(pos.coords.longitude) };
                pointRef.current = p;
                setPoint(p);
                // The browser's place again, as the phone's "Use my location": a town picked before is let go.
                setTownName(null);
                setTownOpen(false);
                void fetchHomeRef.current('point');
            },
            () => { setPointProblem(t("Your location wasn't shared. Type your town instead.")); setTownOpen(true); },
            { maximumAge: 600_000, timeout: 15_000, enableHighAccuracy: false },
        );
    }

    /** "Tell me when one starts here": a member's, at the point Home was read from; a visitor is told to join first. */
    async function tellMe() {
        setWatchNote(null);
        if (!publicKey) { setWatchNote(t(WATCH_WORDS.joinFirst)); return; }
        const p = pointRef.current;
        if (!p) { setWatchNote(t(WATCH_WORDS.needsPlace)); setTownOpen(true); return; }
        try {
            await watchPlace(p.lat, p.lng);
            setWatched(true);
            setWatchNote(t(WATCH_WORDS.done));
        } catch (e: any) {
            // Watching as many places as the node allows: in the member's language, with the node's number.
            if (e?.code === PLACE_WATCH_LIMIT_CODE && typeof e.limit === 'number') setWatchNote(placeWatchLimitLine(e.limit));
            else setWatchNote(e?.message || t("That didn't go through. Try again."));
        }
    }

    /** A town picked in the shared search: the point Home is read from, as roughly as a shared location (`coarse`). */
    function pickTown(r: AddressResult) {
        if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return;
        const p = { lat: coarse(r.lat), lng: coarse(r.lng) };
        pointRef.current = p;
        setPoint(p);
        setTownName(r.shortName || r.displayName);
        setTownOpen(false);
        setPointProblem(null);
        void fetchHomeRef.current('point');
    }

    // ── loading and failure: never a blank page, never a block on the other tabs ────────────────────────────────────
    if (!answer) {
        return (
            <div ref={setPage} className="px-4 pt-2 pb-6 min-w-0" data-testid="home-page" data-columns={cols}>
                <div className="mx-auto" style={{ maxWidth: gridWidth(cols) }}>
                    {visitor?.joinCard}
                    {status === 'signed-out' ? (
                        <div role="status" data-testid="home-signed-out" className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 p-4">
                            <p className="m-0 mb-3 text-sm text-nature-800 dark:text-nature-100">{t(HOME_WORDS.signedOut)}</p>
                            <button type="button" onClick={() => window.location.reload()}
                                className="min-h-[44px] px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                                {t('Reload')}
                            </button>
                        </div>
                    ) : status === 'failed' ? (
                        <div role="alert" data-testid="home-failed" className="bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 p-4">
                            <p className="m-0 mb-3 text-sm text-nature-800 dark:text-nature-100">
                                {failure === 'notOnNode' ? t(HOME_WORDS.notOnNode) : failure === 'failed' || !failure ? t(HOME_WORDS.failed) : failure.message}
                            </p>
                            <button type="button" onClick={() => void fetchHome('retry')}
                                className="min-h-[44px] px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                                {t('Try again')}
                            </button>
                        </div>
                    ) : (
                        <p className="text-sm text-nature-600 dark:text-nature-300" role="status">{t('Loading your Home…')}</p>
                    )}
                </div>
            </div>
        );
    }

    const a = answer;
    const profile = String(a.profile);
    const isVisitor = !!a.welcome || !a.me;
    const beansOn = visitor ? visitor.beans : a.features.beans !== false;
    const pins = pinnedCards(a, now);
    let imgCount = 0;
    const nextImageLoading = () => (imgCount++ < 8 ? 'eager' : 'lazy');
    // Only the cards on screen: a "Your way back in" with nothing to say is no place to move to, or a press on the card
    // next to it would swap the two in the saved list and move nothing anyone can see (PR #2411 review).
    const movable = shown.filter(c => canMoveCard(c.type, pins) && (c.type !== 'safety' || safetyDrawn));
    const nameOf = (c: Pick<HomeCardInstance, 'type'>) => (isHomeCardId(c.type) ? cardTitle(c.type, a) : cardName(c.type, profile));

    function menuFor(card: HomeCardInstance) {
        if (isVisitor || !canRemoveCard(card.type, pins)) return undefined;
        const i = movable.findIndex(c => c.id === card.id);
        return {
            // A saved search is named by its words; any other card by its heading, as before.
            ...(card.type === 'search' ? { label: cardLabelName(card, profile) } : {}),
            canMoveUp: i > 0,
            canMoveDown: i >= 0 && i < movable.length - 1,
            across: cols > 1,
            onRemove: () => removeFromHome(card.id),
            ...(homeCardType(card.type)?.readSettings ? { onSettings: () => setSettingsFor(card) } : {}),
            onMove: (d: 'up' | 'down') => { changeLayout((l) => moveCard(l, card.id, d, movable, Date.now(), pins)); },
        };
    }

    /**
     * Remove (§1.3): the instance leaves the list, said politely by the card's words, and focus goes to the nearest card
     * left. Remove on Tips does what "Don't show tips again" does: the record holds it too.
     */
    function removeFromHome(id: string, inDialog = false) {
        const card = shown.find(c => c.id === id) ?? listOf(drawnBase()).find(c => c.id === id);
        if (!card) return;
        if (card.type === 'tips') { tipsDontShow(inDialog); return; }
        const name = cardLabelName(card, profile);
        const onList = listOf(drawnBase()).some(c => c.id === id);
        // The interests card opened from Tune without being on the list just closes.
        if (onList && !changeLayout((l) => removeCard(l, id, Date.now(), pins))) return;
        // From Edit home, the dialog keeps focus on its nearest row: the page behind a modal never takes it.
        if (!inDialog) focusAround(id);
        setLive(removedLine(name));
        if (card.type === 'interests') setInterestsOpen(false);
    }

    /** Focus to the nearest card left once `id` has gone (read after the next draw, the effect above). */
    function focusAround(id: string) {
        const ids = shown.map(c => c.id);
        const at = shown.findIndex(c => c.id === id || c.type === id);
        focusAfterHide.current = [...ids.slice(at + 1), ...ids.slice(0, Math.max(at, 0)).reverse()];
    }

    addToHomeRef.current = (type: string) => addToHome(type);
    /** Add (§1.3): first, under Needs you; the picker closes, the page goes to the top, it is said, and focus goes to its "…". */
    function addToHome(type: string, settings?: Record<string, unknown>) {
        setPickerOpen(false);
        const r = addCard(drawnBase(), type, Date.now(), { settings, pinned: pins });
        if (!r.ok) {
            // The picker offers no Add it would refuse, but a search saved from the Market can meet a Home that filled
            // while its dialog was open: said, never a silent no.
            if (type === 'search') noteSaveSearch(saveSearchLine(r.refused === 'type-full' ? 'type-full' : 'home-full', readSearchSettings(settings).q)!);
            return;
        }
        const mark = { id: r.id, read: false };
        // Read once the save is answered (§2.4); sun and moon is worked out here and needs nothing from the node.
        if (!changeLayout(() => r.layout, { reread: type !== 'sky', afterRead: () => { mark.read = true; if (mounted.current) setAddRead(n => n + 1); } })) return;
        // Tips put back after "Don't show tips again" start over from the first tip.
        if (type === 'tips' && tipsRef.current?.dismissedAt) keepTips(restartTips(tipsList, localDay()));
        if (type === 'interests') setInterestsOpen(true);
        focusAfterAdd.current = mark;
        pageRef.current?.scrollIntoView?.({ block: 'start' });
        setLive(addedLine(cardLabelName(r.layout.cards.find(c => c.id === r.id) ?? { type }, profile)));
    }

    // Next (Done on the last): the tip is seen and the next one drawn in place, said politely; Done takes the card away.
    function tipsNext() {
        if (!publicKey || landedEpoch() === null || !tipsRef.current) return;
        const step = nextTip(tipsRef.current, tipsList, localDay());
        if (!step.view) focusAround('tips');
        keepTips(step.record);
        setLive(step.view ? t(step.view.tip.text) : t(HOME_WORDS.tipsDone));
    }

    // "Don't show tips again" (and the card's Hide): the record says so, and the layout hides it for the other devices.
    function tipsDontShow(inDialog = false) {
        if (!publicKey || landedEpoch() === null) return;
        if (!inDialog) focusAround('tips');
        keepTips(dismissTips(tipsRef.current ?? emptyTipsRecord(), new Date().toISOString()));
        const tipsCard = listOf(drawnBase()).find(c => c.type === 'tips');
        if (tipsCard) changeLayout((l) => removeCard(l, tipsCard.id, Date.now(), pins));
        setLive(removedLine(cardTitle('tips', a)));
    }

    const cardStyle = (index: number): React.CSSProperties | undefined => reveal
        ? { animation: 'home-card-in 300ms ease-out both', animationDelay: `${Math.min(index, 8) * 30}ms` }
        : undefined;

    function needsLine(item: NeedsItem, i: number) {
        const words = item.kind === 'vote' && item.closesAt && item.count === 1
            ? item.label.replace(/closes (within the hour|in \d+ (hours?|days))/, closesWords(item.closesAt, now))
            : item.label;
        const go = () => {
            const target = item.target;
            switch (target.to) {
                case 'deal': return onNavigate('marketplace', target.postId);
                case 'my-deals': return onNavigate('marketplace');
                case 'decide': return onNavigate('projects');
                case 'chat': return onNavigate('messages', target.conversationId);
                case 'unread-messages': case 'your-groups': return onNavigate('messages');
                // A keepers' vote is never in Commons → Decide: it lands on the enterprise, whose Decisions block lists it.
                case 'enterprise': return onNavigate('enterprise', target.id);
                // A group's vote lands on the group: its info, where its Decisions block is; never the Messages list.
                case 'group': return onNavigate('group', target.id);
                // An invitation: the group's info, which offers Join to the member invited; several, Commons, where each
                // group shows as invited.
                case 'invite': return onNavigate('group', target.id);
                case 'invites': return onNavigate('projects');
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
            return <HomeLine key={i} href={`${getNodeApiUrl()}/settings#from=pwa`} label={t("{line}. Opens your community's settings.", { line: words })} testId={`home-needs-${item.kind}`}>{body}</HomeLine>;
        }
        return <HomeLine key={i} onClick={go} label={item.accent ? t('{line}. Waiting on you.', { line: words }) : words} testId={`home-needs-${item.kind}`}>{body}</HomeLine>;
    }

    function renderCard(card: HomeCardInstance, index: number): ReactNode {
        const id = card.type as HomeCardId;
        const c = a.cards;
        const title = nameOf(card);
        const common = { id: card.id, title, menu: menuFor(card), style: spansRow(card.type) ? { ...cardStyle(index), ...FULL_ROW } : cardStyle(index) };
        switch (card.type) {
            case 'needs':
                return c.needs && (
                    <HomeCard key={id} {...common} accent={c.needs.items.some(i => i.accent)}>
                        {c.needs.items.map(needsLine)}
                    </HomeCard>
                );
            case 'safety':
                // The two-doors card, with its own ✕ and schedule kept in this browser (components/OneWayBack.tsx).
                // Its "…" (Move up · Move down · Remove) sits over the card's own ✕. The cell comes with the card: put away
                // or checked, it has nothing to say and takes no cell (PR #2411 review). `c.safety` is the node's word that the
                // member has only their 12 words, so a card not yet put away is drawn with the answer, not a request later
                // (arriving second in the order, it moved every card after it to another cell).
                return identity && (
                    <OneWayBackCard key={id} identity={identity} placement="landing" onSeeWords={onSeeWords} known={!!c.safety} onDrawn={setSafetyDrawn} frame={(oneWayBack) => (
                        <div style={cardStyle(index)} data-testid={`home-card-${card.id}`}>
                            {common.menu && <div className="flex justify-end -mb-2"><CardMenu title={title} {...common.menu} /></div>}
                            {oneWayBack}
                        </div>
                    )} />
                );
            case 'find': {
                const f = c.find!;
                const more = findListed(f);
                const nearby = nearbyLine(f);
                return (
                    <HomeCard key={id} {...common}>
                        <p className="m-0 mb-1 text-sm text-nature-800 dark:text-nature-100 break-words" data-testid="home-find-body">{findBody(f)}</p>
                        {more.map(cm => {
                            const facts = communityFacts(cm);
                            const text = `${cm.name ?? t('A community')}${facts ? ` · ${facts}` : ''}`;
                            return cm.url
                                ? <HomeLine key={cm.key} href={cm.url} external label={t('{text}. Opens its page.', { text })}><span dir="auto" className="min-w-0 break-words font-semibold underline">{text}</span></HomeLine>
                                : <p key={cm.key} className="m-0 py-1 text-sm text-nature-800 dark:text-nature-100 break-words">{text}</p>;
                        })}
                        {/* Nothing listed within 250 km, and the list has loaded (findOffersStart): Start leads, as on the
                            phone, and a member can be told when one starts here. Never before the list loads, never while near. */}
                        {findOffersStart(f) && (
                            <div className="mt-2 mb-1 flex flex-col gap-2" data-testid="home-find-actions">
                                <button type="button" onClick={() => setStartOpen(true)} data-testid="home-find-start"
                                    className="w-full min-h-[44px] px-4 rounded-xl border-0 bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on text-sm font-bold cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                                    {t('Start a community')}
                                </button>
                                {!(watched || (f.watches?.length ?? 0) > 0) && (
                                    <button type="button" onClick={() => void tellMe()} data-testid="home-find-watch" className={FIND_ACTION}
                                        aria-label={t('Tell me when a community starts near here')}>
                                        {t('Tell me when one starts here')}
                                    </button>
                                )}
                                {watchNote && <p role="status" data-testid="home-find-watch-note" className="m-0 text-sm text-nature-800 dark:text-nature-100 break-words">{watchNote}</p>}
                            </div>
                        )}
                        {nearby && <p className="m-0 py-1 text-sm text-nature-700 dark:text-nature-200">{nearby}</p>}
                        {townName && !townOpen && (
                            <div className="mt-1 flex flex-wrap items-center gap-x-3" data-testid="home-town-picked">
                                <span className="min-w-0 break-words text-sm font-semibold text-text-primary">{t('Near {town}', { town: townName })}</span>
                                <button type="button" onClick={() => setTownOpen(true)} aria-label={t('Change the town (near {town})', { town: townName })} className={TOWN_LINK}>
                                    {t('change', undefined, 'link beside the town name')}
                                </button>
                            </div>
                        )}
                        {(f.point === null || townName) && (
                            <div className="mt-1">
                                <button type="button" onClick={sharePoint} data-testid="home-share-area"
                                    className="w-full min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-900 dark:text-white cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                                    {t('Share my area')}
                                </button>
                                <p className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300">{t("Only a rough area (about 10 km) is used, to find what's near.")}</p>
                                {pointProblem && <p role="alert" className="m-0 mt-1 text-xs text-nature-800 dark:text-nature-100">{pointProblem}</p>}
                                {!townOpen && !townName && (
                                    <button type="button" onClick={() => setTownOpen(true)} data-testid="home-type-town" className={TOWN_LINK}>
                                        {t(LIB_LINES.typeYourTown)}
                                    </button>
                                )}
                            </div>
                        )}
                        {f.point !== null && !townName && !townOpen && (
                            <button type="button" onClick={() => setTownOpen(true)} data-testid="home-type-town-instead" className={TOWN_LINK}>
                                {t(LIB_LINES.notHereTypeYourTown)}
                            </button>
                        )}
                        {townOpen && (
                            <div className="mt-2">
                                <AddressSearch words={findTownWords()} onPick={pickTown} />
                                <button type="button" onClick={() => setTownOpen(false)} data-testid="home-town-cancel" className={TOWN_LINK}
                                    aria-label={townName ? t('Cancel, and keep near {town}', { town: townName }) : t('Cancel the town search')}>
                                    {t('Cancel')}
                                </button>
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
                            const label = l.done ? t('Done: {text}', { text: l.text }) : t('To do: {text}', { text: l.text });
                            return l.href
                                ? <HomeLine key={l.text} href={l.href} external label={label}>{body}</HomeLine>
                                : <HomeLine key={l.text} onClick={l.go} label={label}>{body}</HomeLine>;
                        })}
                        {limits && <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words" data-testid="home-steps-limits">{limits}</p>}
                    </HomeCard>
                );
            }
            case 'start': {
                // Getting started (DESIGN-getting-started-fable.md §1): no "…", Skip is its remove; it blocks nothing.
                const btn = 'min-h-[44px] px-4 rounded-xl text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2';
                return (
                    <HomeCard key={id} {...common} menu={undefined}>
                        <p data-testid="home-start-words" className="m-0 mb-2 text-[0.9375rem] text-nature-900 dark:text-nature-100 break-words">{t(LIB_LINES.startCard)}</p>
                        <div className="flex flex-wrap items-center gap-2">
                            <button type="button" data-testid="home-start-look"
                                onClick={() => { if (publicKey) startTour(publicKey, tourNode, resumeStep(tourProgress, tourTotal)); }}
                                className={`${btn} border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on focus-visible:ring-emerald-400`}>
                                {startCardButton(tourProgress, tourTotal)}
                            </button>
                            <button type="button" data-testid="home-start-skip" aria-label={t('Skip the tour')} onClick={() => applyTourEnd('skipped')}
                                className={`${btn} border-0 bg-transparent text-emerald-800 dark:text-emerald-300 focus-visible:ring-emerald-500`}>
                                {t('Skip')}
                            </button>
                        </div>
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
                        <p data-testid="home-tip-text" className="m-0 mb-2 text-[0.9375rem] text-nature-900 dark:text-nature-100 break-words">{t(v.tip.text)}</p>
                        <div className="flex flex-wrap gap-2">
                            {/* The same element on every tip, so focus stays on it after a tap. */}
                            <button type="button" onClick={tipsNext} aria-label={tipsNextLabel(v)} data-testid="home-tips-next"
                                className={`${btn} flex-1 min-w-[96px] border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on focus-visible:ring-emerald-400`}>
                                {v.last ? t('Done') : t('Next')}
                            </button>
                            {slug && page && (
                                <button type="button" onClick={() => onNavigate('guide', slug)} aria-label={t('Read more in the guide: {title}', { title: page.title })} data-testid="home-tips-more"
                                    className={`${btn} flex-1 min-w-[96px] border border-nature-300 dark:border-nature-700 bg-transparent text-nature-900 dark:text-white focus-visible:ring-emerald-500`}>
                                    {t('Read more')}
                                </button>
                            )}
                        </div>
                        <button type="button" onClick={() => tipsDontShow()} aria-label={t(LIB_LINES.tipsDontShowLabel)} data-testid="home-tips-dont-show"
                            className="w-full min-h-[44px] mt-1 px-2 bg-transparent border-0 rounded-lg text-sm font-bold text-nature-700 dark:text-nature-200 whitespace-normal break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                            {t(LIB_LINES.tipsDontShow)}
                        </button>
                    </HomeCard>
                );
            }
            case 'interests':
                return (
                    <HomeCard key={id} {...common}>
                        <div ref={interestsCardRef}>
                            <p className="m-0 mb-2 text-sm text-nature-700 dark:text-nature-200">{t('Tap what you like: those come first on Home and in the Market. Nothing is hidden.')}</p>
                            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Things you like')}>
                                {MARKETPLACE_CATEGORIES.map(cat => {
                                    const on = myInterests.includes(cat.id);
                                    return (
                                        <button key={cat.id} type="button" aria-pressed={on} onClick={() => toggleChip(cat.id)} data-testid={`home-interest-${cat.id}`}
                                            className={`min-h-[44px] max-w-full px-3 rounded-full text-sm font-semibold border cursor-pointer break-words text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${on
                                                ? 'bg-bp-commit-fill border-bp-commit-fill text-bp-commit-on'
                                                : 'bg-transparent border-nature-300 dark:border-nature-700 text-nature-900 dark:text-nature-100'}`}>
                                            <span aria-hidden="true">{cat.emoji} </span>{cat.label}
                                        </button>
                                    );
                                })}
                            </div>
                            {myInterests.length > 0 && (
                                <HomeMore onClick={() => setInterestsOpen(false)} testId="home-interests-done">{t('Done')}</HomeMore>
                            )}
                        </div>
                    </HomeCard>
                );
            case 'deals': {
                const d = c.deals;
                if (!d) return null;
                const hasItems = (d.items && d.items.length > 0);
                const showOpen = d.open > 3 || (hasItems && d.open > d.items!.length);
                return (
                    <HomeCard
                        key={id}
                        {...common}
                        titleAside={showOpen ? <span className="text-xs font-normal text-text-secondary min-w-0 break-words text-right">{tn(d.open, '{n} open', '{n} open')}</span> : undefined}
                    >
                        <DealsBody d={d} onNavigate={onNavigate} />
                    </HomeCard>
                );
            }
            case 'enterprise':
                return c.enterprise && (
                    <HomeCard key={id} {...common}>
                        <EnterpriseBody e={c.enterprise} onNavigate={onNavigate} />
                    </HomeCard>
                );
            case 'events': {
                const ev = c.events!;
                return (
                    <HomeCard key={id} {...common} title={ev.radiusKm ? t('{title} · within {km} km', { title, km: ev.radiusKm }) : title}>
                        {ev.items.map(item => {
                            // An online event has no place and no distance (DESIGN-event-times §4).
                            const where = item.online ? t('Online') : item.place ?? (isVisitor ? t(VISITOR_WORDS.placeAfterJoin) : null);
                            const rsvp = item.rsvp === 'going' ? t('Going') : item.rsvp === 'interested' ? t('Interested') : null;
                            const km = item.online ? null : distanceText(item.distanceKm);
                            const when = homeEventWhen(item);
                            const repeats = homeEventRepeats(item);
                            return (
                                <HomeLine key={item.id} onClick={() => onNavigate('marketplace', item.id)} testId="home-event"
                                    label={[when, repeats, item.title, where, km, rsvp].filter(Boolean).join(', ')}>
                                    <span className="min-w-0 flex-1">
                                        {/* The time on a line of its own (with a zone named, run into the title it read as one phrase), each piece whole. */}
                                        {when && (
                                            <span data-testid="home-event-when" className="flex flex-wrap gap-x-1 text-sm font-bold text-nature-700 dark:text-nature-200">
                                                {when.split(' · ').map((piece, i, all) => <span key={i} className="whitespace-nowrap">{piece}{i < all.length - 1 ? ' ·' : ''}</span>)}
                                            </span>
                                        )}
                                        {repeats && <span data-testid="home-event-repeats" className="block break-words text-xs font-bold text-violet-800 dark:text-violet-200"><span aria-hidden="true">↻ </span>{repeats}</span>}
                                        <span dir="auto" className="block break-words font-semibold">{item.title}</span>
                                        {(where || km) && <span className="block text-xs text-nature-600 dark:text-nature-300 break-words">{[where, km].filter(Boolean).join(' · ')}</span>}
                                    </span>
                                    {rsvp && <span className="shrink-0 text-xs font-bold text-emerald-800 dark:text-emerald-300">{rsvp}</span>}
                                </HomeLine>
                            );
                        })}
                        <HomeMore onClick={() => onNavigate('map')}>{t('All events ›')}</HomeMore>
                    </HomeCard>
                );
            }
            case 'market': {
                const m = c.market!;
                return (
                    <HomeCard key={id} {...common} titleAside={!isVisitor && (
                        <button type="button" onClick={openTune} aria-label={t('Tune: pick what comes first')} data-testid="home-tune"
                            className="min-h-[44px] px-2 -mt-2 bg-transparent border-0 text-xs font-bold text-text-secondary hover:text-text-primary cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                            {t('Tune')}
                        </button>
                    )}>
                        <MarketBody
                            m={m}
                            isVisitor={isVisitor}
                            myInterests={myInterests}
                            beansOn={beansOn}
                            onNavigate={onNavigate}
                            nextImageLoading={nextImageLoading}
                        />
                    </HomeCard>
                );
            }
            case 'decide': {
                const d = c.decide;
                if (!d) return null;
                const hasItems = (d.items && d.items.length > 0) || !!d.poll;
                return (
                    <HomeCard
                        key={id}
                        {...common}
                        titleAside={hasItems ? (
                            <span className="text-xs font-normal text-text-secondary min-w-0 break-words text-right">
                                {decideLine(d, now)}
                            </span>
                        ) : undefined}
                    >
                        <DecideBody d={d} now={now} onNavigate={onNavigate} />
                    </HomeCard>
                );
            }
            case 'groups':
                return c.groups && (
                    <HomeCard key={id} {...common}>
                        <GroupsBody groups={c.groups} onNavigate={onNavigate} />
                    </HomeCard>
                );
            case 'joined': {
                const j = c.joined!;
                const faces = (j.names ?? []).map(n => ({ ...n, src: resolveImageUrl(n.avatarUrl) }));
                return (
                    <HomeCard key={id} {...common}>
                        <HomeLine onClick={() => onNavigate(faces.length ? 'people-community' : 'people')} label={t('{line} Opens People.', { line: joinedLine(j) })}>
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
                return c.pulse && (
                    <HomeCard key={id} {...common}>
                        <PulseBody items={c.pulse.items} onNavigate={onNavigate} nextImageLoading={nextImageLoading} />
                    </HomeCard>
                );
            case 'beans':
                return c.beans && (
                    <HomeCard key={id} {...common}>
                        <BeansBody b={c.beans} onNavigate={onNavigate} />
                    </HomeCard>
                );
            case 'notices': {
                const n = c.notices!;
                return (
                    <HomeCard key={id} {...common}>
                        <p className="m-0 text-sm font-semibold text-nature-900 dark:text-white break-words">{n.first.title}</p>
                        {n.first.line && <p className="m-0 text-sm text-nature-700 dark:text-nature-200 break-words">{n.first.line}</p>}
                        {n.unseen > 1 && <p className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300">{tn(n.unseen - 1, 'and {n} more', 'and {n} more')}</p>}
                        <HomeMore onClick={() => {
                            // Never a notice of a Home this page no longer holds (another community's, in a tab that missed the news).
                            if (landedEpoch() === null) return;
                            void markNoticesSeen([n.first.id]).catch(() => { /* still unseen: the card stays */ });
                        }} testId="home-notice-seen">{t('Mark as read')}</HomeMore>
                    </HomeCard>
                );
            }
            case 'invite':
                return (
                    <HomeCard key={id} {...common}>
                        <button type="button" onClick={() => onNavigate('people-invites')}
                            className="w-full min-h-[44px] px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-sm font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
                            {t('Invite someone')}
                        </button>
                    </HomeCard>
                );
            case 'community': {
                const cm = c.community;
                if (!cm) return null;
                return (
                    <HomeCard key={id} {...common} title={communityName(cm, profile)}>
                        <CommunityBody
                            cm={cm}
                            profile={profile}
                            isVisitor={isVisitor}
                            onAddCard={() => setPickerOpen(true)}
                            onEditHome={() => setEditOpen(true)}
                        />
                    </HomeCard>
                );
            }
            case 'search':
                return (
                    <HomeCard key={card.id} {...common}>
                        <SearchBody
                            card={card}
                            a={a}
                            beansOn={beansOn}
                            onNavigate={onNavigate}
                            nextImageLoading={nextImageLoading}
                        />
                    </HomeCard>
                );
            case 'sky': {
                // Sun and moon (CARD-FRAME §4): one line worked out here, nothing to open, no request of its own. A screen
                // reader hears it in words, never the picture.
                const sky = skyOf(a, card, now);
                if (!sky) return null;
                return (
                    <HomeCard key={card.id} {...common}>
                        <p data-testid="home-sky-line" className="m-0 text-sm font-semibold text-nature-900 dark:text-white break-words">
                            <span aria-hidden="true">{sky.text}</span>
                            <span className="sr-only">{sky.label}</span>
                        </p>
                    </HomeCard>
                );
            }
            default:
                // A tool's card (`tool-<id>`): its lines worked out on this device from the tool's own document, never
                // asked of the node (tools/home-card.tsx). Any other type this build doesn't draw is kept and not drawn.
                return toolOfCard(card.type)
                    ? <ToolHomeCard key={card.id} {...common} type={card.type} publicKey={publicKey} now={now} onNavigate={onNavigate} />
                    : null;
        }
    }

    const tipsAllSeen = !!tips && !tips.dismissedAt && tipsList.length > 0 && allTipsSeen(tips, tipsList);
    // Edit home's rows (§1.3): the cards on Home in order, without the fixed two and a pinned card.
    const editCards = editOpen && !isVisitor
        ? cardOrder(shownLayout(a, layout, { tourOver }), pins).filter(c => c.type !== FIXED_FIRST && c.type !== FIXED_LAST && !pins.includes(c.type) && cardOnNode(c.type, frameOf(a)))
        : [];
    const editRows: EditHomeRow[] = editCards.map(c => ({
                id: c.id,
                // A saved search's row is named by its words (cardRowName), so two searches read as two rows.
                name: c.type === 'search' ? cardRowName(c, profile) : nameOf(c),
                label: cardLabelName(c, profile),
                note: shown.some(s => s.id === c.id) ? null : c.type === 'tips' && tipsAllSeen ? t('All tips seen') : c.type === 'sky' ? t(LIB_LINES.skyNoPlace) : t('Nothing to show now'),
                hasSettings: !!homeCardType(c.type)?.readSettings,
            }));
    // A saved search's distance needs a point the node measures from: the member's area, or the place this browser shared.
    const hasPoint = !!point || !!a.me?.area;
    const picker = pickerOpen && !isVisitor ? pickerGroups(frameOf(a), shownLayout(a, layout, { tourOver }), null, pins, tipsAllSeen ? { tips: t('All tips seen') } : {}) : null;
    // The fewer-cards note and the one-time hint go under the first card, the row's full width. Side by side that holds
    // only when the first card is a full row itself: with nothing waiting there is no Needs you, and a full-row note after
    // a one-cell card would push the cards beside it to the next row, leaving the first row empty (PR #2411 review). There
    // the notes stand above the grid, as wide as it. One column keeps them under the first card, as before.
    const notesUnderFirst = cols === 1 || (!!shown[0] && spansRow(shown[0].type));
    const firstNotes = (under: boolean) => (
        <>
            {fewerOpen && !isVisitor && (
                <p data-testid="home-fewer" style={under ? FULL_ROW : undefined} className={`${under ? '-mt-1' : 'm-0'} mb-3 pl-3 flex items-center gap-2 rounded-xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 text-sm text-nature-800 dark:text-nature-100`}>
                    <span className="min-w-0 flex-1 break-words">{t(LIB_LINES.fewerCards)}</span>
                    <button type="button" aria-label={t('Close this note')} onClick={() => setFewerOpen(false)}
                        className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-transparent border-0 text-nature-500 dark:text-nature-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                        ✕
                    </button>
                </p>
            )}
            {hintOpen && !isVisitor && !startUp && (
                <p data-testid="home-hint" style={under ? FULL_ROW : undefined} className={`${under ? '-mt-1' : 'm-0'} mb-3 pl-3 flex items-center gap-2 rounded-xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 text-sm text-nature-800 dark:text-nature-100`}>
                    <span className="min-w-0 flex-1 break-words">{t(LIB_LINES.hint)}</span>
                    <button type="button" aria-label={t('Close this tip')} onClick={() => { setHintOpen(false); if (publicKey && landedEpoch() !== null) writeFlag(hintKey(publicKey)); }}
                        className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-transparent border-0 text-nature-500 dark:text-nature-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                        ✕
                    </button>
                </p>
            )}
        </>
    );

    return (
        <div ref={setPage} className="px-4 pt-2 pb-6 min-w-0" data-testid="home-page" data-columns={cols}>
            <div className="mx-auto" style={{ maxWidth: gridWidth(cols) }}>
                {reveal && <style>{HOME_CARD_IN_STYLE}</style>}
                <p className="sr-only" aria-live="polite" data-testid="home-live">{live}</p>
                {status === 'offline' && (
                    <p data-testid="home-offline" className="m-0 mb-2 text-xs text-nature-700 dark:text-nature-200">{t(HOME_WORDS.offline)}</p>
                )}
                {visitor?.joinCard}
                {startOpen && <StartCommunityScreen onClose={() => setStartOpen(false)} />}
                {saveNote && (
                    <p data-testid="home-save-search-note" className="m-0 mb-3 pl-3 py-1 flex items-center gap-2 rounded-xl bg-bg-card border border-border-primary text-sm text-text-primary">
                        <span className="min-w-0 flex-1 break-words">{saveNote}</span>
                        <button type="button" aria-label={t('Close this note')} onClick={() => setSaveNote(null)}
                            className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full bg-transparent border-0 text-text-secondary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                            ✕
                        </button>
                    </p>
                )}
                {a.me?.standing === 'suspended' && (
                    <p className="m-0 mb-3 text-sm text-nature-800 dark:text-nature-100 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 p-4">
                        {t("Your account here is paused for now. You can read your own messages, deals and Beans; the community's listings come back when it is lifted.")}
                    </p>
                )}
                {!notesUnderFirst && firstNotes(false)}
                {/* The cards (D1): columns 320–576 px wide, filled row first in the saved order, tops aligned, each card its
                    own height; never `dense`, which would put a card on screen out of the order a screen reader and Tab follow.
                    Between rows the cards' own 12 px and 4 more, as between columns; one column keeps its 12 px, as before. */}
                <div data-testid="home-grid" style={{
                    display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, ${HOME_COLUMN_MAX}px))`, columnGap: HOME_COLUMN_GAP,
                    rowGap: cols > 1 ? 4 : 0, justifyContent: 'center', alignItems: 'start',
                }}>
                    {shown.map((card, i) => (
                        <Fragment key={card.id}>
                            {renderCard(card, i)}
                            {i === 0 && notesUnderFirst && firstNotes(true)}
                        </Fragment>
                    ))}
                </div>
                {editOpen && !isVisitor && (
                    <EditHomeDialog
                        rows={editRows}
                        notOnAccount={notOnAccount}
                        onAdd={() => { setEditOpen(false); setPickerOpen(true); }}
                        onMove={(id, d) => { changeLayout((l) => moveCard(l, id, d, editCards, Date.now(), pins)); }}
                        onSettings={(id) => { const card = listOf(drawnRef.current).find(c => c.id === id); if (card) setSettingsFor(card); }}
                        onRemove={(id) => removeFromHome(id, true)}
                        // Reset brings Tips back when they were off, so then the tips start over (PR #1694 review 3); a member
                        // part-way through keeps their place (confirmation 1, finding 2).
                        onReset={() => {
                            const tipsOff = !!tipsRef.current?.dismissedAt || !listOf(drawnRef.current).some(c => c.type === 'tips');
                            if (changeLayout((l) => resetLayout(l, Date.now()), { reread: true }) && tipsOff) keepTips(restartTips(tipsList, localDay()));
                        }}
                        onClose={() => setEditOpen(false)}
                        returnFocus={() => pageRef.current?.querySelector<HTMLElement>('[data-testid="home-edit-open"]')}
                    />
                )}
                {picker && (
                    <AddCardDialog groups={picker.groups} full={picker.full} onAdd={addToHome} onClose={() => setPickerOpen(false)} hasPoint={hasPoint}
                        // Opened from Edit home, which has closed: the community card's Add a card.
                        returnFocus={() => pageRef.current?.querySelector<HTMLElement>('[data-testid="home-add-open"]')} />
                )}
                {addSearch && (
                    <CardSettingsDialog
                        type="search"
                        name={cardName('search', profile)}
                        mode="add"
                        initial={addSearch}
                        hasPoint={hasPoint}
                        onSubmit={(next) => { setAddSearch(null); addToHome('search', next); }}
                        onClose={() => setAddSearch(null)}
                        // Its opener, the Market's button, is on another tab: the community card's Add a card.
                        returnFocus={() => pageRef.current?.querySelector<HTMLElement>('[data-testid="home-add-open"]')}
                    />
                )}
                {settingsFor && (
                    <CardSettingsDialog
                        type={settingsFor.type}
                        name={cardName(settingsFor.type, profile)}
                        mode="save"
                        initial={settingsFor.settings}
                        hasPoint={hasPoint}
                        onSubmit={(next) => {
                            const { id, type } = settingsFor;
                            setSettingsFor(null);
                            // Sun and moon's place is worked out here: no read.
                            changeLayout((l) => changeCardSettings(l, id, next, Date.now()), { reread: type !== 'sky' });
                        }}
                        onClose={() => setSettingsFor(null)}
                        // Its opener was a menu's Settings…, gone with the menu: Edit home's row "…" while Edit home is open, else
                        // the card's "…".
                        returnFocus={() => {
                            const id = settingsFor.id;
                            return pageRef.current?.querySelector<HTMLElement>(`[data-testid="home-edit-menu-${id}"]`)
                                ?? pageRef.current?.querySelector<HTMLElement>(`[data-testid="home-card-${id}"] [data-testid="home-card-menu"]`)
                                ?? pageRef.current?.querySelector<HTMLElement>('[data-testid="home-add-open"]');
                        }}
                    />
                )}
            </div>
        </div>
    );
}
