/**
 * "Your way back in" (two-doors design §2.5; DESIGN-notify-and-backup-asks-fable.md §5.2, amend2 slice B2): a member whose
 * 12 words are the only way back to their account is told so plainly, and offered a sign-in as a second way where one
 * works, without ever making either a gate. The same card as the phone's (apps/native/components/OneWayBackCard.tsx), from
 * the same rule (@beanpool/core way-back-schedule.ts), in a browser's words:
 *
 *   - one sentence on every card, "If this browser forgets your account, this is how you get back in." (core
 *     `WAY_BACK_WORDS.lineBrowser`: a browser loses an account to its saved data being cleared, Safari's after a week
 *     without a visit, a sign-out or a lost device; "this phone is lost" would not be true here), and at the first Beans
 *     the fact: "You have 40 Beans here now. Keep a way back in, so they don't go if this browser forgets your account.";
 *   - on the landing screen, while core's schedule says so: from the first landing after a join here that ended with no way
 *     back kept (Safety Backup's Next with its tick not ticked, the web's "Later"), until it is put away; then once at the
 *     first Beans, once 30 days after joining, then every 90 days while there is something to lose. ✕ puts it away, here
 *     and on the account (`onPutAway`, Home keeps it in `home.layout` `dismissed.safety`), and a put-away on the phone or
 *     another browser counts here too (`accountPutAwayAt`), as the phone reads the web's;
 *   - in Settings, the same card for as long as the account has no way back kept, with the sign-ins to add where they work.
 *
 * Kept, as on the phone: a sign-in's copy linked here (Home's `me.wayBack` covered), or "I still have my 12 words" said on
 * any device or after the kit (the account's `words_kept`, or the join's tick). Looking at the 12 words is not keeping them:
 * "See my 12 words" opens them, and the card stays on its schedule, as the phone's "Show my 12 words" does. The web keeps no
 * recovery key and never reaches BeanPool's key vault, so on the web the 12 words (and a sign-in where the community takes
 * one) are the only way back.
 *
 * "Something to lose" is what Home's answer holds: a balance that isn't zero, or an open deal. Your Beans and Your deals are
 * asked with this card whether or not the member keeps them on Home (core `WAY_BACK_ASKS`; review of #3341), so the first
 * Beans and the 90 days come as on the phone whatever is on Home. Home's answer says nothing of the member's live listings
 * or role, and the card asks for nothing later (a card arriving late moved every card after it, PR #2411), so on the web
 * those two don't bring the 90-day return; a balance, an open deal and the 30 days do.
 *
 * Who it is for is the node's word, never a guess: its Home answer, read by lib/home-cards.ts `wayBackOf`
 * (DESIGN-home-default-fable.md §2.5): every member whose 12 words are the only way back (`me.wayBack`), however they
 * joined, until they say they still have them. On Home it is passed as `home`, so the card's first paint is what it settles
 * on: nothing drawn and pulled, nothing popped in late; Home is told whether the card is drawn (`onDrawn`). In Settings the
 * card asks for the same answer itself (`GET /api/home?cards=safety`, {@link useWayBackWord}). Nothing is drawn while it has
 * not answered, or offline.
 *
 * What it offers is only what works for that member: "Add a sign-in" only where the node's link route takes them (the
 * 12-words door's own, `cards.safety`; anyone else is refused with 404 invite_only or 409 not_words_member). Sign-up counts
 * as the first showing for a member this browser has no record of (joined on another device, or brought back here), but
 * the 12-words door's own: their schedule starts as put away at the join, as the phone's does after a restore. "I still have
 * my 12 words" is kept on the account (`onKept`), from the card on Home and in Settings; in Settings a member the node still
 * takes a sign-in from is then offered one quietly, with no warning, as the phone's Settings does.
 *
 * Adding a sign-in (lib/link-signin.ts) leaves the page for the provider, as joining with one does; App.tsx finishes it
 * on the way back and shows the result here (`result`). Where the community keeps no copies of members' accounts (its
 * rule `none`, vault rethink VR2; the page passes `keepsNoCopies`), a sign-in only lifts the new-account limits, and its
 * words say so rather than promise a copy or a way back.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t, word, wayBackBeansSeen, wayBackLine, wayBackSchedule, type WayBackSchedule } from '@beanpool/core';
import { getHome } from '../lib/api';
import { beansAmount, wayBackOf, type HomeAnswer, type WayBackOnHome } from '../lib/home-cards';
import { hasMnemonic, type BeanPoolIdentity } from '../lib/identity';
import { NONCE_FRESH_MS, offeredProviders, providerLabel, type JoinNonce } from '../lib/web-join';
import { leaveForLink, linkResultMessage, requestLinkNonce, type LinkResult } from '../lib/link-signin';
import { wordsKeptOwed } from '../lib/words-kept';
import { keyLineWords } from './key-lines';
import { saidWords, type Said } from './WebJoin';

/** The card's own words, marked here and translated where they are shown. Its sentence is core's (`WAY_BACK_WORDS`). */
export const ONE_WAY_BACK_WORDS = {
    /** The say-so, kept on the account (DESIGN-home-default-fable.md §2.5). */
    kept: word('I still have my 12 words'),
    /** Why a sign-in, for an account that has only its 12 words: what it is, and who can open the copy it keeps. */
    why: word("A sign-in with Google, Apple or Facebook is a second way back if you lose this device. We keep only a scrambled reference to it, never your email or name from there. It also locks a copy of your account; the people who run this community's server can open that copy."),
    /** Why a sign-in where this community keeps no copies (its rule `none`): no copy is made, so it is no way back. */
    whyNoCopies: word("A sign-in with Google, Apple or Facebook only lifts the limits on new 12-words accounts. We keep only a scrambled reference to it, never your email or name from there. This community keeps no copies of members' accounts, so your 12 words are your way back."),
} as const;

/** What the card goes by: Home's own answer, read by lib/home-cards.ts `wayBackOf`, and where it is. */
export interface WayBackWord extends WayBackOnHome {
    /** The worldwide community. */
    global: boolean;
    /**
     * The words are said to be kept, but the node still takes a sign-in from this member (the 12-words door's own, while
     * their probation says so): Settings offers one quietly, with no warning, as the phone's Settings does.
     */
    quietSignIn?: boolean;
}

/** The card's word from a Home answer (Settings' own read of it; Home builds its `home` from the same `wayBackOf`). */
export function wayBackWordOf(answer: HomeAnswer): WayBackWord {
    const w = wayBackOf(answer);
    const me = answer.me;
    const quietSignIn = !w.forThem && !!me && !answer.welcome && me.standing === 'member'
        && me.probation?.rules === 'words' && me.wayBack !== 'covered';
    return { ...w, global: answer.profile === 'global', quietSignIn };
}

/**
 * The node's word on this member where Home's answer isn't handed in (Settings): the same answer, built for this card
 * alone (`GET /api/home?cards=safety`, a read that changes nothing). null while asking, or when it could not be asked.
 */
export function useWayBackWord(publicKey: string, refreshKey?: unknown, ask = true): WayBackWord | null {
    const [found, setFound] = useState<WayBackWord | null>(null);
    useEffect(() => {
        if (!ask) return;
        let cancelled = false;
        Promise.resolve()
            .then(() => getHome({ cards: ['safety'] }))
            .then((read) => { if (!cancelled) setFound(read.notModified ? null : wayBackWordOf(read.answer)); })
            .catch(() => { if (!cancelled) setFound(null); });
        return () => { cancelled = true; };
    }, [publicKey, refreshKey, ask]);
    return found;
}

// ---------- the landing card's schedule: core's rule, with what this browser keeps beside it ----------

/**
 * What this browser keeps for the card, per account, under the key it always had (`beanpool_one_way_back_<key>`): times
 * only, nothing secret. When it next shows is core's (way-back-schedule.ts), never worked out here.
 * A record from before (its `dismissed`, post and week flags, `checked`) has none of these and is read as no record: the
 * card then starts as a member this browser never saw would (below), and the next write keeps only these.
 */
export interface WayBackHere {
    /** The join in this browser ended with no way back kept (the web's "Later"): the card is up from the first landing. */
    shownFrom?: number;
    /** The last ✕ here. */
    putAwayAt?: number;
    /** When this browser first saw a balance above zero on the account: the card comes back once for it (core `wayBackBeansSeen`). */
    beansAt?: number;
}

const hereKey = (publicKey: string) => `beanpool_one_way_back_${publicKey}`;
const time = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** This browser's record for the account; empty when there is none, it can't be read, or it is from before. */
export function readWayBackHere(publicKey: string): WayBackHere {
    try {
        const v = JSON.parse(localStorage.getItem(hereKey(publicKey)) || 'null');
        if (v && typeof v === 'object') {
            const here: WayBackHere = {};
            const shownFrom = time(v.shownFrom);
            const putAwayAt = time(v.putAwayAt);
            const beansAt = time(v.beansAt);
            if (shownFrom !== undefined) here.shownFrom = shownFrom;
            if (putAwayAt !== undefined) here.putAwayAt = putAwayAt;
            if (beansAt !== undefined) here.beansAt = beansAt;
            return here;
        }
    } catch { /* private window, or not ours */ }
    return {};
}

function writeWayBackHere(publicKey: string, here: WayBackHere): void {
    try { localStorage.setItem(hereKey(publicKey), JSON.stringify(here)); } catch { /* private window: as if never written */ }
}

/**
 * The web's join ended on Safety Backup with no way back kept (its tick not ticked; pages/WelcomePage.tsx): as after the
 * phone's "Later", Home's card is up from the first landing until it is put away or a way back is kept. A record already
 * here is kept as it is.
 */
export function startWayBackShown(publicKey: string, now: number = Date.now()): void {
    const here = readWayBackHere(publicKey);
    if (here.shownFrom !== undefined || here.putAwayAt !== undefined) return;
    writeWayBackHere(publicKey, { ...here, shownFrom: now });
}

/**
 * Core's schedule for this member here: Home's word (`home`), this browser's record, and the account's own put-away (the
 * phone's ✕ or another browser's, `home.layout` `dismissed.safety`), whichever is later. With no showing or put-away known,
 * sign-up was its first showing for all but the 12-words door's own (`startsAway`): put away at the join.
 */
export function wayBackScheduleHere(home: WayBackOnHome, here: WayBackHere, accountPutAwayAt: string | null | undefined, now: number): WayBackSchedule {
    const account = accountPutAwayAt ? Date.parse(accountPutAwayAt) : NaN;
    const known = [here.putAwayAt, Number.isFinite(account) ? account : undefined].filter((v): v is number => v !== undefined);
    const joinedAt = home.joinedAt ?? here.shownFrom ?? now;
    const putAwayAt = known.length ? Math.max(...known) : here.shownFrom === undefined && home.startsAway ? joinedAt : null;
    return wayBackSchedule({
        joinedAt, now, kept: false, putAwayAt,
        beansAt: wayBackBeansSeen(here.beansAt, home.balance_c, now), balance_c: home.balance_c, holds: home.holds,
    });
}

// ---------- adding a sign-in ----------

interface AddSignInProps {
    identity: BeanPoolIdentity;
    /** The button's words (in the member's language); "Add a sign-in" when none are given. */
    label?: string;
    /** Leaves the page for the provider. Swappable in tests. */
    navigate?: (url: string) => void;
    origin?: string;
    /**
     * Awaited just before the page leaves (the end of onboarding: the steps every new member has are finished first).
     * Answering false keeps the page here.
     */
    onLeaving?: () => void | boolean | Promise<void | boolean>;
    /** Ask for the sign-ins as it opens, so the choice is shown at once (the member already chose to add one). */
    autoStart?: boolean;
    /** This community keeps no copies of members' accounts (its rule `none`): the words promise no copy and no way back. */
    keepsNoCopies?: boolean;
}

/**
 * "Add a sign-in": asks the node which sign-ins it offers (a nonce bound to adding one for this member), then the
 * member picks one and the page leaves for it. Every refusal is a sentence beside the button.
 */
export function AddSignIn({ identity, label, navigate, origin, onLeaving, autoStart = false, keepsNoCopies = false }: AddSignInProps) {
    const [nonce, setNonce] = useState<JoinNonce | null>(null);
    // When the nonce came: one held past NONCE_FRESH_MS is asked for again before the trip (time spent reading the
    // tour, say, must not come back from the provider as a failed sign-in), as WebJoin does.
    const nonceAt = useRef(0);
    const [busy, setBusy] = useState(false);
    // Why not, said in the language of the moment: a lib file's English, or this card's own (set with setMessage(() => …)).
    const [message, setMessage] = useState<Said | null>(null);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    async function open() {
        setBusy(true);
        setMessage(null);
        const got = await requestLinkNonce(identity);
        if (!mounted.current) return;
        setBusy(false);
        if ('message' in got) setMessage(got.message);
        else { nonceAt.current = Date.now(); setNonce(got.nonce); }
    }

    const started = useRef(false);
    useEffect(() => {
        if (!autoStart || started.current) return;
        started.current = true;
        void open();
        // Once, as it opens.
    }, [autoStart]);

    function leave(provider: Parameters<typeof leaveForLink>[1], n: JoinNonce) {
        const out = leaveForLink(identity, provider, n, { navigate, origin });
        // A nonce is spent on one trip: a sign-in that didn't start asks for another.
        if (!out.ok) { setMessage(out.message); setNonce(null); }
    }

    const fresh = () => Date.now() - nonceAt.current < NONCE_FRESH_MS;

    async function choose(provider: Parameters<typeof leaveForLink>[1]) {
        if (!nonce || busy) return;
        // Nothing to finish first and a fresh nonce: straight from the tap.
        if (!onLeaving && fresh()) return leave(provider, nonce);
        setBusy(true);
        let stay = false;
        try {
            stay = onLeaving ? (await onLeaving()) === false : false;
        } catch (e) {
            console.error('[AddSignIn] could not get ready to leave:', e);
            setMessage(() => () => t("Something went wrong on this page, so the sign-in didn't start. Try again."));
            stay = true;
        }
        let n: JoinNonce | null = nonce;
        if (!stay && !fresh()) {
            // Checked last, just before the trip: anything awaited above counts too.
            const got = await requestLinkNonce(identity);
            if ('message' in got) {
                setMessage(got.message);
                n = null;
            } else {
                nonceAt.current = Date.now();
                setNonce(got.nonce);
                n = got.nonce;
            }
        }
        if (!mounted.current) return;
        setBusy(false);
        if (!stay && n) leave(provider, n);
    }

    const offered = nonce ? offeredProviders(nonce) : [];
    return (
        <div data-testid="add-sign-in" className="min-w-0">
            {!nonce ? (
                <button type="button" data-testid="add-sign-in-start" disabled={busy} onClick={() => void open()}
                    className="w-full min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-bold bg-transparent text-nature-900 dark:text-white border border-nature-300 dark:border-nature-700 cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                    {busy ? t('One moment…') : label ?? t('Add a sign-in')}
                </button>
            ) : offered.length === 0 ? (
                <p role="alert" className="text-sm text-nature-700 dark:text-nature-200 m-0 break-words">{t('This community has no sign-in a browser can use yet.')}</p>
            ) : (
                <div className="space-y-2">
                    <p className="text-xs font-semibold text-nature-600 dark:text-nature-300 m-0">{t('Add a sign-in with')}</p>
                    {offered.map((provider) => (
                        <button key={provider} type="button" data-testid={`add-sign-in-${provider}`} disabled={busy} onClick={() => void choose(provider)}
                            className="w-full min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-bold bg-transparent text-nature-900 dark:text-white border border-nature-300 dark:border-nature-700 cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                            {providerLabel(provider)}
                        </button>
                    ))}
                </div>
            )}
            {message && (
                <p role="alert" data-testid="add-sign-in-problem" className="text-sm text-red-800 dark:text-red-300 mt-2 mb-0 break-words">{saidWords(message)}</p>
            )}
            <p className="text-xs text-nature-600 dark:text-nature-300 mt-2 mb-0 leading-relaxed break-words">
                {keepsNoCopies ? t(ONE_WAY_BACK_WORDS.whyNoCopies) : t(ONE_WAY_BACK_WORDS.why)}
            </p>
        </div>
    );
}


// ---------- the card ----------

interface CardProps {
    identity: BeanPoolIdentity;
    /** The landing screen (can be put away, on core's schedule) or Settings (kept while the account has no way back kept). */
    placement: 'landing' | 'settings';
    /** Open the 12 words (Settings → Recovery Phrase). */
    onSeeWords?: () => void;
    /** A sign-in that came back for a link (App.tsx): its result, said here. */
    result?: LinkResult | null;
    navigate?: (url: string) => void;
    origin?: string;
    /** Read the node again when this changes. */
    refreshKey?: unknown;
    /** What the card stands in (Home's cell, with its "…"): drawn only with the card, so a card with nothing to say takes no place. */
    frame?: (card: ReactNode) => ReactNode;
    /**
     * Home's own answer, read by lib/home-cards.ts `wayBackOf`: who the card is for, what works for them, and what its
     * schedule goes by. Given, it is the one word, at the first paint and after, and nothing is asked. Not given
     * (Settings), the card asks for the same answer itself ({@link useWayBackWord}).
     */
    home?: WayBackWord;
    /** "I still have my 12 words": kept on the account (lib/words-kept.ts sends `words_kept`). The card is done here at once. */
    onKept?: () => void;
    /** Told whether the card is drawn, before the page paints (Home: a card not drawn is not a place to move another to). */
    onDrawn?: (drawn: boolean) => void;
    /** This community keeps no copies of members' accounts (its rule `none`, from the page's /api/community/info). */
    keepsNoCopies?: boolean;
    /** The account's own put-away of the card (`home.layout` `dismissed.safety`): the phone's ✕, another browser's, or this one's. */
    accountPutAwayAt?: string | null;
    /** ✕, at the moment this browser keeps too: Home keeps it on the account (lib/home-layout.ts dismissSafety), as the phone does. */
    onPutAway?: (at: number) => void;
}

export function OneWayBackCard({ identity, placement, onSeeWords, result, navigate, origin, refreshKey, frame = (card) => card, home, onKept, onDrawn, keepsNoCopies = false, accountPutAwayAt, onPutAway }: CardProps) {
    const asked = useWayBackWord(identity.publicKey, `${String(refreshKey)}:${result?.kind ?? ''}`, !home);
    const wayBack = home ?? asked;
    // Said here just now: the card is done at once, before any answer says so.
    const [keptNow, setKeptNow] = useState(false);
    const [here, setHere] = useState(() => readWayBackHere(identity.publicKey));
    useEffect(() => { setHere(readWayBackHere(identity.publicKey)); }, [identity.publicKey]);
    // A sign-in that just came back: its result is the first thing read on the page that opened for it.
    const resultRef = useRef<HTMLParagraphElement | null>(null);
    useEffect(() => { if (result) resultRef.current?.scrollIntoView?.({ block: 'center' }); }, [result]);

    // A way back kept ends it: the node's word (`forThem`), said here just now, or said here and still owed to the node
    // (lib/words-kept.ts sends it again at the next landing), so a say-so the node didn't hear yet never brings it back.
    const forThem = !!wayBack?.forThem && !keptNow && !wordsKeptOwed(identity.publicKey);
    // Only what works for this member (§2.5): a sign-in where the node's link route takes them.
    const signIn = !!wayBack?.canAddSignIn;
    // Core's schedule, on the landing screen: whether it is up now, and why (the first Beans bring their own sentence).
    const schedule = forThem && placement === 'landing' && wayBack ? wayBackScheduleHere(wayBack, here, accountPutAwayAt, Date.now()) : null;
    const shown = forThem && (placement === 'settings' || !!schedule?.show);
    // Settings, once the words are said to be kept: a sign-in still offered, quietly, where the node takes one.
    const quietOffer = placement === 'settings' && !shown && (keptNow ? signIn : !!wayBack?.quietSignIn);

    function update(next: WayBackHere) {
        setHere(next);
        writeWayBackHere(identity.publicKey, next);
    }

    // The first Beans seen here (a balance above zero in Home's answer): kept once, so the card comes back for them. The
    // schedule above already counts them on this paint (core wayBackBeansSeen), so nothing pops in when this lands.
    const balance = wayBack?.balance_c ?? null;
    const firstBeans = placement === 'landing' && forThem && here.beansAt === undefined && balance !== null && balance > 0;
    useEffect(() => {
        if (firstBeans) update({ ...readWayBackHere(identity.publicKey), beansAt: Date.now() });
    }, [firstBeans, identity.publicKey]);

    useLayoutEffect(() => { onDrawn?.(shown); }, [shown]);
    useLayoutEffect(() => () => { onDrawn?.(false); }, []);

    // One sentence on every card, in a browser's words (core way-back-schedule.ts); at the first Beans, the fact with the amount.
    const line = wayBackLine(schedule?.why ?? null, balance !== null && balance > 0 ? beansAmount(balance) : null, 'browser');

    return (
        <>
            {result && (
                <p role="status" data-testid="link-result" ref={resultRef}
                    className={`w-full p-3 rounded-xl text-sm m-0 break-words ${result.kind === 'failed'
                        ? 'bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-300'
                        : 'bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 text-nature-800 dark:text-nature-100'}`}>
                    {keyLineWords(linkResultMessage(result))}
                </p>
            )}
            {shown && frame(
                <section data-testid={`one-way-back-${placement}`} aria-labelledby={`one-way-back-title-${placement}`}
                    className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-amber-300 dark:border-amber-700 p-4 mb-3 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                        <h2 id={`one-way-back-title-${placement}`} className="font-bold text-base text-nature-900 dark:text-white m-0 min-w-0 break-words">
                            <span aria-hidden="true">🔑 </span>{t('Your way back in')}
                        </h2>
                        {placement === 'landing' && (
                            <button type="button" aria-label={t('Hide this for now')}
                                onClick={() => {
                                    // One moment for this browser and the account (Home keeps it in `home.layout`).
                                    const at = Date.now();
                                    update({ ...here, putAwayAt: at });
                                    onPutAway?.(at);
                                }}
                                className="shrink-0 min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-full bg-transparent border-none text-nature-400 dark:text-nature-300 hover:text-nature-600 dark:hover:text-nature-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                                ✕
                            </button>
                        )}
                    </div>
                    <p data-testid="one-way-back-text" className="text-sm text-nature-700 dark:text-nature-200 mt-1 mb-3 leading-relaxed break-words">{line}</p>
                    <div className="space-y-2">
                        {onSeeWords && hasMnemonic(identity) && (
                            // Looking at them is not keeping them: the card stays on its schedule, as the phone's "Show my 12 words".
                            <button type="button" data-testid="one-way-back-words" onClick={() => onSeeWords()}
                                className="w-full min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-bold bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on border-none cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
                                {t('See my 12 words')}
                            </button>
                        )}
                        {onKept && (
                            <button type="button" data-testid="one-way-back-kept"
                                onClick={() => { setKeptNow(true); onKept(); }}
                                className="w-full min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-bold bg-transparent text-nature-900 dark:text-white border border-nature-300 dark:border-nature-700 cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                                {t(ONE_WAY_BACK_WORDS.kept)}
                            </button>
                        )}
                        {signIn && <AddSignIn identity={identity} navigate={navigate} origin={origin} keepsNoCopies={keepsNoCopies} />}
                    </div>
                </section>
            )}
            {quietOffer && (
                <div data-testid="one-way-back-quiet" className="min-w-0">
                    <AddSignIn identity={identity} navigate={navigate} origin={origin} keepsNoCopies={keepsNoCopies} />
                </div>
            )}
        </>
    );
}
