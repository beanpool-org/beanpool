/**
 * "Your account is new" (G11-e, design G11 §6): a new member in the web app is told about the new-account limits
 * before they meet one. Reads the signer's own standing (GET /api/community/me) and shows, while the node says they
 * are on probation, each daily limit with what is left and when more comes back, and the rule for when it ends.
 *
 * Renders nothing when they are not on probation (every local community: the switch is off there; a node role; past
 * the rule), when the node is older than the route, for a guest, or offline. Shown after onboarding (the app shell,
 * where the member can close it), in Settings, and in the post form when a limit is reached.
 */
import { useEffect, useState } from 'react';
import { t, tn, word, type WordKey } from '@beanpool/core';
import { getCommunityMe, type CommunityStanding, type NewAccountLimit } from '../lib/api';

type Probation = CommunityStanding['probation'];

/**
 * "in about 5 hours", from now to `iso`: the node's own phrasing in its refusals, with days for the longer waits. In the
 * member's language: a sentence takes it whole as its {when}.
 */
export function inAbout(iso: string, now: number = Date.now()): string {
    const mins = Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
    if (mins < 60) return tn(mins, 'in about a minute', 'in about {n} minutes');
    const hours = Math.round(mins / 60);
    if (hours < 36) return tn(hours, 'in about an hour', 'in about {n} hours');
    const days = Math.round(hours / 24);
    return tn(days, 'in about {n} day', 'in about {n} days');
}

/** Each limit's name, and the sentence for when it comes back once used up (`{when}`: inAbout). */
const ROWS: { key: keyof Probation['limits']; label: WordKey; again: WordKey }[] = [
    { key: 'posts', label: word('Posts'), again: word('You can post again {when}.') },
    { key: 'photos', label: word('Photos on posts'), again: word('You can add more {when}.') },
    { key: 'new_dm_recipients', label: word('New people to message'), again: word('You can message someone new again {when}.') },
];

/** What is left: the node's `remaining`, or on an older node that doesn't send it, the allowance less what is used (the server's own sum). */
export function leftOf(l: NewAccountLimit): number {
    return typeof l.remaining === 'number' ? l.remaining : Math.max(0, l.limit - l.used);
}

function comesBack(row: typeof ROWS[number], l: NewAccountLimit, now: number): string | null {
    if (l.used <= 0 || !l.resetsAt || !Number.isFinite(Date.parse(l.resetsAt))) return null;
    const when = inAbout(l.resetsAt, now);
    return leftOf(l) <= 0 ? t(row.again, { when }) : t('One more comes back {when}.', { when });
}

/**
 * "3 days" or "72 hours": how long the limits last at least. The English is as it always was (both forms the same, as
 * "{n} Beans"); a language with plural forms writes its own.
 */
function spanWords(hours: number): string {
    return hours % 24 === 0 ? tn(hours / 24, '{n} days', '{n} days') : tn(hours, '{n} hours', '{n} hours');
}

/** The rule, in #1133's words, from the node's numbers (an older node without `endsWhen`: its fixed 72 hours). */
export function ruleSentence(p: Probation): string {
    const hours = p.endsWhen?.hours ?? 72;
    const kept = p.endsWhen?.keptPosts ?? p.keptPostsNeeded;
    return tn(kept,
        'New accounts have these limits for their first {span}, and until {n} of their posts have stayed up.',
        'New accounts have these limits for their first {span}, and until {n} of their posts have stayed up.',
        { span: spanWords(hours) });
}

function progressSentence(p: Probation, now: number): string {
    const span = spanWords(p.endsWhen?.hours ?? 72);
    const kept = p.endsWhen?.keptPosts ?? p.keptPostsNeeded;
    const ageEnds = p.ageEndsAt ? Date.parse(p.ageEndsAt) : NaN;
    const age = !Number.isFinite(ageEnds) ? '' : ageEnds > now
        ? t('Your first {span} end {when}.', { span, when: inAbout(p.ageEndsAt!, now) })
        : t('Your first {span} are over.', { span });
    const posts = tn(p.keptPosts, 'So far {n} of your posts has stayed up, of the {kept} needed.', 'So far {n} of your posts have stayed up, of the {kept} needed.', { kept });
    return [age, posts].filter(Boolean).join(' ');
}

export interface NewAccountCardProps {
    /** Read again when this changes: after a refusal, the counts behind it. */
    refreshKey?: unknown;
    /** When given, a close button: the app shell lets the member put it away; Settings keeps it. */
    onClose?: () => void;
}

export function NewAccountCard({ refreshKey, onClose }: NewAccountCardProps) {
    const [probation, setProbation] = useState<Probation | null>(null);

    useEffect(() => {
        let cancelled = false;
        // Inside the promise chain, so nothing this read throws (an older node, a guest, offline) reaches the page.
        Promise.resolve()
            .then(() => getCommunityMe())
            .then(me => { if (!cancelled) setProbation(me?.probation?.onProbation === true && me.probation.limits ? me.probation : null); })
            .catch(() => { if (!cancelled) setProbation(null); });
        return () => { cancelled = true; };
    }, [refreshKey]);

    if (!probation) return null;
    const now = Date.now();

    return (
        <section
            data-testid="new-account-card"
            aria-labelledby="new-account-card-title"
            className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 p-4 mb-3 min-w-0"
        >
            <div className="flex items-start justify-between gap-2">
                <h2 id="new-account-card-title" className="font-bold text-base text-nature-900 dark:text-white m-0 min-w-0 break-words">
                    <span aria-hidden="true">🌱 </span>{t('Your account is new')}
                </h2>
                {onClose && (
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('Hide this for now')}
                        className="shrink-0 min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-full bg-transparent border-none text-nature-400 hover:text-nature-600 dark:hover:text-nature-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    >
                        ✕
                    </button>
                )}
            </div>
            <p className="text-sm text-nature-600 dark:text-nature-300 mt-1 mb-3 leading-relaxed break-words">
                {t('For now, a few things are limited, each over any 24 hours:')}
            </p>
            <ul className="list-none p-0 m-0 space-y-2">
                {ROWS.map(row => {
                    const l = probation.limits[row.key];
                    if (!l) return null;
                    const back = comesBack(row, l, now);
                    const left = leftOf(l);
                    return (
                        <li key={row.key} data-testid={`new-account-limit-${row.key}`} className="min-w-0">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                <span className="text-sm font-semibold text-nature-800 dark:text-nature-100 break-words min-w-0">{t(row.label)}</span>
                                <span className={`text-sm whitespace-nowrap ${left <= 0 ? 'font-bold text-amber-700 dark:text-amber-400' : 'text-nature-700 dark:text-nature-200'}`}>
                                    {t('{left} of {limit} left', { left, limit: l.limit })}
                                </span>
                            </div>
                            {back && <div className="text-xs text-nature-500 dark:text-nature-400 break-words">{back}</div>}
                        </li>
                    );
                })}
            </ul>
            <p className="text-xs text-nature-500 dark:text-nature-400 mt-3 mb-0 leading-relaxed break-words">
                {t('Replying to someone who wrote to you first is never limited.')}
            </p>
            <p data-testid="new-account-rule" className="text-sm text-nature-700 dark:text-nature-200 mt-2 mb-0 leading-relaxed break-words">
                {ruleSentence(probation)} {progressSentence(probation, now)}
            </p>
        </section>
    );
}
