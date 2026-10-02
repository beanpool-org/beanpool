/**
 * "Your account has one way back" (two-doors design §2.5, slice S5): a member who joined with 12 words alone has no other
 * way back to their account, by their own choice. The web app says so plainly, and offers a sign-in as a second way,
 * without ever making either a gate:
 *
 *   - on the landing screen, a plain card (not a dot) until they have looked at their 12 words from it or added a
 *     sign-in. It can be put away; it comes back once after their next post that stays up, and once when their first
 *     week is over, then lives in Settings only;
 *   - in Settings, the same card for as long as the account has no sign-in, with the sign-ins to add.
 *
 * Who it is for is the node's word, never a guess: `GET /api/community/me` says `rules: 'words'` for a member who came
 * in with 12 words and has added no sign-in. Nothing is drawn while it has not answered, for an older node that does
 * not say, or offline.
 *
 * Adding a sign-in (lib/link-signin.ts) leaves the page for the provider, as joining with one does; App.tsx finishes it
 * on the way back and shows the result here (`result`).
 */
import { useEffect, useRef, useState } from 'react';
import { getCommunityMe } from '../lib/api';
import { hasMnemonic, type BeanPoolIdentity } from '../lib/identity';
import { offeredProviders, providerLabel, type JoinNonce } from '../lib/web-join';
import { leaveForLink, linkResultMessage, requestLinkNonce, type LinkResult } from '../lib/link-signin';

export const ONE_WAY_BACK = 'Your account has one way back: your 12 words. Check you still have them, or add a sign-in.';

/** Why a sign-in, for an account that has only its 12 words: what it is, and who can open the copy it keeps. */
export const ADD_SIGN_IN_WHY =
    "A sign-in with Google, Apple or Facebook is a second way back if you lose this device. We keep only a scrambled reference to it, never your email or name from there. It also locks a copy of your account; the people who run this community's server can open that copy.";

interface Standing {
    words: boolean;
    keptPosts: number;
    weekOverAt: number | null;
}

/** The node's word on whether this member has only their 12 words: null while asking, or when it could not be asked. */
export function useOneWayBack(publicKey: string, refreshKey?: unknown): Standing | null {
    const [standing, setStanding] = useState<Standing | null>(null);
    useEffect(() => {
        let cancelled = false;
        Promise.resolve()
            .then(() => getCommunityMe())
            .then((me) => {
                if (cancelled) return;
                const p = me?.probation;
                const ends = p?.ageEndsAt ? Date.parse(p.ageEndsAt) : NaN;
                setStanding({ words: p?.rules === 'words', keptPosts: Number(p?.keptPosts) || 0, weekOverAt: Number.isFinite(ends) ? ends : null });
            })
            .catch(() => { if (!cancelled) setStanding(null); });
        return () => { cancelled = true; };
    }, [publicKey, refreshKey]);
    return standing;
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
}

const scheduleKey = (publicKey: string) => `beanpool_one_way_back_${publicKey}`;
const NEW_SCHEDULE: Schedule = { dismissed: false, keptPostsAtDismissal: 0, postReturnShown: false, weekReturnShown: false, checked: false };

export function readSchedule(publicKey: string): Schedule {
    try {
        const v = JSON.parse(localStorage.getItem(scheduleKey(publicKey)) || 'null');
        if (v && typeof v === 'object') {
            return {
                dismissed: v.dismissed === true,
                keptPostsAtDismissal: Number(v.keptPostsAtDismissal) || 0,
                postReturnShown: v.postReturnShown === true,
                weekReturnShown: v.weekReturnShown === true,
                checked: v.checked === true,
            };
        }
    } catch { /* private window, or not ours */ }
    return { ...NEW_SCHEDULE };
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
export function landingDue(s: Schedule, standing: Standing, now: number = Date.now()): boolean {
    if (s.checked) return false;
    if (!s.dismissed) return true;
    return postReturnDue(s, standing) || weekReturnDue(s, standing, now);
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

// ---------- adding a sign-in ----------

interface AddSignInProps {
    identity: BeanPoolIdentity;
    /** The button's words. */
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
}

/**
 * "Add a sign-in": asks the node which sign-ins it offers (a nonce bound to adding one for this member), then the
 * member picks one and the page leaves for it. Every refusal is a sentence beside the button.
 */
export function AddSignIn({ identity, label = 'Add a sign-in', navigate, origin, onLeaving, autoStart = false }: AddSignInProps) {
    const [nonce, setNonce] = useState<JoinNonce | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
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
        else setNonce(got.nonce);
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

    async function choose(provider: Parameters<typeof leaveForLink>[1]) {
        if (!nonce || busy) return;
        // Nothing to finish first: straight from the tap.
        if (!onLeaving) return leave(provider, nonce);
        setBusy(true);
        let stay = false;
        try {
            stay = (await onLeaving()) === false;
        } catch (e) {
            console.error('[AddSignIn] could not get ready to leave:', e);
            setMessage('Something went wrong on this page, so the sign-in didn\'t start. Try again.');
            stay = true;
        }
        if (!mounted.current) return;
        setBusy(false);
        if (!stay) leave(provider, nonce);
    }

    const offered = nonce ? offeredProviders(nonce) : [];
    return (
        <div data-testid="add-sign-in" className="min-w-0">
            {!nonce ? (
                <button type="button" data-testid="add-sign-in-start" disabled={busy} onClick={() => void open()}
                    className="w-full min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-bold bg-transparent text-nature-900 dark:text-white border border-nature-300 dark:border-nature-700 cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                    {busy ? 'One moment…' : label}
                </button>
            ) : offered.length === 0 ? (
                <p role="alert" className="text-sm text-nature-700 dark:text-nature-200 m-0 break-words">This community has no sign-in a browser can use yet.</p>
            ) : (
                <div className="space-y-2">
                    <p className="text-xs font-semibold text-nature-600 dark:text-nature-300 m-0">Add a sign-in with</p>
                    {offered.map((provider) => (
                        <button key={provider} type="button" data-testid={`add-sign-in-${provider}`} disabled={busy} onClick={() => void choose(provider)}
                            className="w-full min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-bold bg-transparent text-nature-900 dark:text-white border border-nature-300 dark:border-nature-700 cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                            {providerLabel(provider)}
                        </button>
                    ))}
                </div>
            )}
            {message && (
                <p role="alert" data-testid="add-sign-in-problem" className="text-sm text-red-800 dark:text-red-300 mt-2 mb-0 break-words">{message}</p>
            )}
            <p className="text-xs text-nature-600 dark:text-nature-300 mt-2 mb-0 leading-relaxed break-words">{ADD_SIGN_IN_WHY}</p>
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
}

export function OneWayBackCard({ identity, placement, onSeeWords, result, navigate, origin, refreshKey }: CardProps) {
    const standing = useOneWayBack(identity.publicKey, `${String(refreshKey)}:${result?.kind ?? ''}`);
    const [schedule, setSchedule] = useState(() => readSchedule(identity.publicKey));
    useEffect(() => { setSchedule(readSchedule(identity.publicKey)); }, [identity.publicKey]);
    // A sign-in that just came back: its result is the first thing read on the page that opened for it.
    const resultRef = useRef<HTMLParagraphElement | null>(null);
    useEffect(() => { if (result) resultRef.current?.scrollIntoView?.({ block: 'center' }); }, [result]);

    const shown = !!standing?.words && (placement === 'settings' || landingDue(schedule, standing));

    function update(next: Schedule) {
        setSchedule(next);
        writeSchedule(identity.publicKey, next);
    }

    return (
        <>
            {result && (
                <p role="status" data-testid="link-result" ref={resultRef}
                    className={`w-full p-3 rounded-xl text-sm m-0 break-words ${result.kind === 'failed'
                        ? 'bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-300'
                        : 'bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 text-nature-800 dark:text-nature-100'}`}>
                    {linkResultMessage(result)}
                </p>
            )}
            {shown && (
                <section data-testid={`one-way-back-${placement}`} aria-labelledby={`one-way-back-title-${placement}`}
                    className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-amber-300 dark:border-amber-700 p-4 mb-3 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                        <h2 id={`one-way-back-title-${placement}`} className="font-bold text-base text-nature-900 dark:text-white m-0 min-w-0 break-words">
                            <span aria-hidden="true">🔑 </span>One way back
                        </h2>
                        {placement === 'landing' && (
                            <button type="button" aria-label="Hide this for now"
                                onClick={() => { if (standing) update(putAway(schedule, standing)); }}
                                className="shrink-0 min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-full bg-transparent border-none text-nature-400 hover:text-nature-600 dark:hover:text-nature-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                                ✕
                            </button>
                        )}
                    </div>
                    <p data-testid="one-way-back-text" className="text-sm text-nature-700 dark:text-nature-200 mt-1 mb-3 leading-relaxed break-words">{ONE_WAY_BACK}</p>
                    <div className="space-y-2">
                        {onSeeWords && hasMnemonic(identity) && (
                            <button type="button" data-testid="one-way-back-words"
                                onClick={() => { if (placement === 'landing') update({ ...schedule, checked: true }); onSeeWords(); }}
                                className="w-full min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-bold bg-amber-700 hover:bg-amber-800 text-white border-none cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
                                See my 12 words
                            </button>
                        )}
                        <AddSignIn identity={identity} navigate={navigate} origin={origin} />
                    </div>
                </section>
            )}
        </>
    );
}
