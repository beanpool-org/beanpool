/**
 * "Your account has one way back" (two-doors design §2.5, slice S5): a member who joined with 12 words alone has no other
 * way back to their account, by their own choice. The web app says so plainly, and offers a sign-in as a second way,
 * without ever making either a gate:
 *
 *   - on the landing screen, a plain card (not a dot) until they have looked at their 12 words from it or added a
 *     sign-in. It can be put away; it comes back once after their next post that stays up, and once when their first
 *     week is over, then lives in Settings only;
 *   - in Settings, the same card for as long as the account has no sign-in and the words aren't said to be kept, with
 *     the sign-ins to add where they work.
 *
 * Who it is for is the node's word, never a guess: its Home answer, read by lib/home-cards.ts `wayBackOf`
 * (DESIGN-home-default-fable.md §2.5): every member whose 12 words are the only way back (`me.wayBack`), however they
 * joined, until they say they still have them, with the counts its schedule goes by. On Home it is passed as `home`, so
 * the card's first paint is what it settles on: nothing drawn and pulled, nothing popped in late (the jump PR #2411
 * fixed); Home is told whether the card is drawn (`onDrawn`). In Settings the card asks for the same answer itself
 * (`GET /api/home?cards=safety`, {@link useWayBackWord}), so a member who came by invite and whose words are their only
 * way back has the reminder there too once Home's two returns are over, as on the phone. Nothing is drawn while it has
 * not answered, or offline.
 *
 * What it offers is only what works for that member: "Add a sign-in" only where the node's link route takes them (the
 * 12-words door's own, `cards.safety`; anyone else is refused with 404 invite_only or 409 not_words_member), and "one
 * way back" only where it is true (the worldwide community; on a local one an admin can set a member up again with a new
 * key, recovery model point 3), on Home and in Settings alike, as the phone says it. Sign-up counts as the first showing
 * for everyone but the 12-words door's own: their schedule starts as put away, so on day one First steps' line says it,
 * and the card comes once after a post and once when the first week is over. "I still have my 12 words" is kept on the
 * account (`onKept`), as Yes after the kit is, from the card on Home and in Settings; in Settings a member the node still
 * takes a sign-in from is then offered one quietly, with no warning, as the phone's Settings does.
 *
 * Adding a sign-in (lib/link-signin.ts) leaves the page for the provider, as joining with one does; App.tsx finishes it
 * on the way back and shows the result here (`result`). Where the community keeps no copies of members' accounts (its
 * rule `none`, vault rethink VR2; the page passes `keepsNoCopies`), a sign-in only lifts the new-account limits, and its
 * words say so rather than promise a copy or a way back.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t, word } from '@beanpool/core';
import { getHome } from '../lib/api';
import { wayBackOf, type HomeAnswer, type WayBackOnHome } from '../lib/home-cards';
import { hasMnemonic, type BeanPoolIdentity } from '../lib/identity';
import { NONCE_FRESH_MS, offeredProviders, providerLabel, type JoinNonce } from '../lib/web-join';
import { leaveForLink, linkResultMessage, requestLinkNonce, type LinkResult } from '../lib/link-signin';
import { keyLineWords } from './key-lines';
import { saidWords, type Said } from './WebJoin';

/** The card's words, marked here and translated where they are shown. */
export const ONE_WAY_BACK_WORDS = {
    line: word('Your account has one way back: your 12 words. Check you still have them, or add a sign-in.'),
    /** Where an admin can set a member up again (a local community), and a sign-in can be added (§2.5). */
    lineLocal: word('Your 12 words are how you get back in. Check you still have them, or add a sign-in.'),
    /** Where no sign-in can be added for this member (§2.5's short form). */
    lineShort: word('Your 12 words are how you get back in. Check you still have them.'),
    /** The say-so, kept on the account (DESIGN-home-default-fable.md §2.5). */
    kept: word('I still have my 12 words'),
    /** Why a sign-in, for an account that has only its 12 words: what it is, and who can open the copy it keeps. */
    why: word("A sign-in with Google, Apple or Facebook is a second way back if you lose this device. We keep only a scrambled reference to it, never your email or name from there. It also locks a copy of your account; the people who run this community's server can open that copy."),
    /** Why a sign-in where this community keeps no copies (its rule `none`): no copy is made, so it is no way back. */
    whyNoCopies: word("A sign-in with Google, Apple or Facebook only lifts the limits on new 12-words accounts. We keep only a scrambled reference to it, never your email or name from there. This community keeps no copies of members' accounts, so your 12 words are your way back."),
} as const;

export const ONE_WAY_BACK = ONE_WAY_BACK_WORDS.line;
export const ADD_SIGN_IN_WHY = ONE_WAY_BACK_WORDS.why;

interface Standing {
    words: boolean;
    keptPosts: number;
    weekOverAt: number | null;
}

/** What the card goes by: Home's own answer, read by lib/home-cards.ts `wayBackOf`, and where it is. */
export interface WayBackWord extends WayBackOnHome {
    /** The worldwide community, where no admin can set a member up again: the one place "one way back" is true (§2.5). */
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

// ---------- the landing card's schedule, kept in this browser for this account ----------

/**
 * Two returns, each independent of the other (design §2.5, the guide page): once after a post has stayed up since it
 * was first put away, and once when the first week is over. ✕ marks every return that is due at that moment as shown,
 * so it always puts the card away until the next one is due.
 */
interface Schedule {
    /** It has been put away at least once. */
    dismissed: boolean;
    /** Posts that had stayed up when it was first put away. */
    keptPostsAtDismissal: number;
    /** The return after a post that stayed up has been shown and put away. */
    postReturnShown: boolean;
    /** The return when the first week is over has been shown and put away (or was due when it was put away). */
    weekReturnShown: boolean;
    /** They looked at their 12 words from the card: it is done on the landing screen. */
    checked: boolean;
    /** When it was first put away, if the node's counts weren't known then: they settle it when they come (null once settled). */
    awayBeforeCounts: number | null;
}

const scheduleKey = (publicKey: string) => `beanpool_one_way_back_${publicKey}`;
const NEW_SCHEDULE: Schedule = { dismissed: false, keptPostsAtDismissal: 0, postReturnShown: false, weekReturnShown: false, checked: false, awayBeforeCounts: null };

/**
 * The record in this browser, or a new one: shown at once, or (`startsAway`) put away at sign-up with no post up then,
 * so its two returns are what bring it (§2.5 "sign-up counts as the first showing").
 */
export function readSchedule(publicKey: string, startsAway = false): Schedule {
    try {
        const v = JSON.parse(localStorage.getItem(scheduleKey(publicKey)) || 'null');
        if (v && typeof v === 'object') {
            return {
                dismissed: v.dismissed === true,
                keptPostsAtDismissal: Number(v.keptPostsAtDismissal) || 0,
                postReturnShown: v.postReturnShown === true,
                weekReturnShown: v.weekReturnShown === true,
                checked: v.checked === true,
                awayBeforeCounts: typeof v.awayBeforeCounts === 'number' && Number.isFinite(v.awayBeforeCounts) ? v.awayBeforeCounts : null,
            };
        }
    } catch { /* private window, or not ours */ }
    return startsAway ? { ...NEW_SCHEDULE, dismissed: true } : { ...NEW_SCHEDULE };
}

function writeSchedule(publicKey: string, s: Schedule): void {
    try { localStorage.setItem(scheduleKey(publicKey), JSON.stringify(s)); } catch { /* private window: shown again next time */ }
}

function postReturnDue(s: Schedule, standing: Standing): boolean {
    return s.dismissed && !s.postReturnShown && standing.keptPosts > s.keptPostsAtDismissal;
}

function weekReturnDue(s: Schedule, standing: Standing, now: number): boolean {
    return !s.weekReturnShown && standing.weekOverAt !== null && now >= standing.weekOverAt;
}

/**
 * Whether the landing screen shows the card now: until it is first put away; then once after a post that stayed up
 * since, and once when the first week is over, in whichever order they come; then never (Settings keeps it).
 */
export function landingDue(s: Schedule, standing: Standing | null, now: number = Date.now()): boolean {
    if (s.checked) return false;
    if (!s.dismissed) return true;
    // Put away before the counts came: nothing was due at that moment, and they settle it (settleAway) when they come.
    if (s.awayBeforeCounts !== null) return false;
    // A return goes by the node's counts: none until it has answered.
    return !!standing && (postReturnDue(s, standing) || weekReturnDue(s, standing, now));
}

/** ✕: put away until the next return is due. Every return due now counts as shown. */
export function putAway(s: Schedule, standing: Standing, now: number = Date.now()): Schedule {
    const postDue = postReturnDue(s, standing);
    const weekDue = weekReturnDue(s, standing, now);
    return {
        ...s,
        dismissed: true,
        keptPostsAtDismissal: s.dismissed ? s.keptPostsAtDismissal : standing.keptPosts,
        postReturnShown: s.postReturnShown || postDue,
        weekReturnShown: s.weekReturnShown || weekDue,
    };
}

/**
 * ✕ before the node's counts were known: put away now, with no count yet (the card is only drawn then when it was never
 * put away, so this is always the first time).
 */
export function putAwayBeforeCounts(s: Schedule, now: number = Date.now()): Schedule {
    return { ...s, dismissed: true, awayBeforeCounts: now };
}

/**
 * The counts that came after such a ✕: the posts up now are the ones it was put away with, and a week that was over at
 * the ✕ counts as shown, as {@link putAway} would have had it. Anything else is left as it is.
 */
export function settleAway(s: Schedule, standing: Standing): Schedule {
    if (s.awayBeforeCounts === null) return s;
    return putAway({ ...s, dismissed: false, awayBeforeCounts: null }, standing, s.awayBeforeCounts);
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
    /** The landing screen (can be put away, on its schedule) or Settings (kept while the account has no sign-in). */
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
     * Home's own answer, read by lib/home-cards.ts `wayBackOf`: who the card is for, what works for them, and the counts
     * its schedule goes by. Given, it is the one word, at the first paint and after, and nothing is asked. Not given
     * (Settings), the card asks for the same answer itself ({@link useWayBackWord}).
     */
    home?: WayBackWord;
    /** "I still have my 12 words": kept on the account (lib/words-kept.ts sends `words_kept`). The card is done here at once. */
    onKept?: () => void;
    /** Told whether the card is drawn, before the page paints (Home: a card not drawn is not a place to move another to). */
    onDrawn?: (drawn: boolean) => void;
    /** This community keeps no copies of members' accounts (its rule `none`, from the page's /api/community/info). */
    keepsNoCopies?: boolean;
}

export function OneWayBackCard({ identity, placement, onSeeWords, result, navigate, origin, refreshKey, frame = (card) => card, home, onKept, onDrawn, keepsNoCopies = false }: CardProps) {
    const asked = useWayBackWord(identity.publicKey, `${String(refreshKey)}:${result?.kind ?? ''}`, !home);
    const wayBack = home ?? asked;
    const standing: Standing | null = wayBack ? { words: wayBack.forThem, keptPosts: wayBack.keptPosts, weekOverAt: wayBack.weekOverAt } : null;
    const startsAway = !!wayBack?.startsAway;
    // Said here just now: the card is done at once, before any answer says so.
    const [keptNow, setKeptNow] = useState(false);
    const [schedule, setSchedule] = useState(() => readSchedule(identity.publicKey, startsAway));
    useEffect(() => { setSchedule(readSchedule(identity.publicKey, startsAway)); }, [identity.publicKey, startsAway]);
    // A sign-in that just came back: its result is the first thing read on the page that opened for it.
    const resultRef = useRef<HTMLParagraphElement | null>(null);
    useEffect(() => { if (result) resultRef.current?.scrollIntoView?.({ block: 'center' }); }, [result]);

    const forThem = !!standing?.words && !keptNow;
    // Only what works for this member (§2.5): a sign-in where the node's link route takes them; "one way back" only on the
    // worldwide community, where no admin can set them up again (the phone's rule too, components/OneWayBackCard.tsx).
    const signIn = !!wayBack?.canAddSignIn;
    const oneWayBack = !!wayBack?.global && signIn;
    const shown = forThem && (placement === 'settings' || landingDue(schedule, standing));
    // Settings, once the words are said to be kept: a sign-in still offered, quietly, where the node takes one.
    const quietOffer = placement === 'settings' && !shown && (keptNow ? signIn : !!wayBack?.quietSignIn);

    function update(next: Schedule) {
        setSchedule(next);
        writeSchedule(identity.publicKey, next);
    }

    // A ✕ before the node's counts were known, on this visit or an earlier one: settled once they are.
    useEffect(() => {
        if (standing && schedule.awayBeforeCounts !== null) update(settleAway(schedule, standing));
    }, [standing, schedule]);

    useLayoutEffect(() => { onDrawn?.(shown); }, [shown]);
    useLayoutEffect(() => () => { onDrawn?.(false); }, []);

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
                            <span aria-hidden="true">🔑 </span>{oneWayBack ? t('One way back') : t('Your way back in')}
                        </h2>
                        {placement === 'landing' && (
                            <button type="button" aria-label={t('Hide this for now')}
                                onClick={() => update(standing ? putAway(schedule, standing) : putAwayBeforeCounts(schedule))}
                                className="shrink-0 min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-full bg-transparent border-none text-nature-400 hover:text-nature-600 dark:hover:text-nature-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                                ✕
                            </button>
                        )}
                    </div>
                    <p data-testid="one-way-back-text" className="text-sm text-nature-700 dark:text-nature-200 mt-1 mb-3 leading-relaxed break-words">{oneWayBack ? t(ONE_WAY_BACK_WORDS.line) : signIn ? t(ONE_WAY_BACK_WORDS.lineLocal) : t(ONE_WAY_BACK_WORDS.lineShort)}</p>
                    <div className="space-y-2">
                        {onSeeWords && hasMnemonic(identity) && (
                            <button type="button" data-testid="one-way-back-words"
                                onClick={() => { if (placement === 'landing') update({ ...schedule, checked: true }); onSeeWords(); }}
                                className="w-full min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-bold bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on border-none cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
                                {t('See my 12 words')}
                            </button>
                        )}
                        {onKept && (
                            <button type="button" data-testid="one-way-back-kept"
                                onClick={() => { if (placement === 'landing') update({ ...schedule, checked: true }); setKeptNow(true); onKept(); }}
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
