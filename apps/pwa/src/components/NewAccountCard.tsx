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
import { getCommunityMe, type CommunityStanding, type NewAccountLimit } from '../lib/api';

type Probation = CommunityStanding['probation'];

/** "in about 5 hours", from now to `iso`: the node's own phrasing in its refusals, with days for the longer waits. */
export function inAbout(iso: string, now: number = Date.now()): string {
    const mins = Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
    if (mins < 60) return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
    const hours = Math.round(mins / 60);
    if (hours < 36) return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
    const days = Math.round(hours / 24);
    return `in about ${days} days`;
}

const ROWS: { key: keyof Probation['limits']; label: string; again: string }[] = [
    { key: 'posts', label: 'Posts', again: 'You can post again' },
    { key: 'photos', label: 'Photos on posts', again: 'You can add more' },
    { key: 'new_dm_recipients', label: 'New people to message', again: 'You can message someone new again' },
];

function comesBack(row: typeof ROWS[number], l: NewAccountLimit, now: number): string | null {
    if (l.used <= 0 || !l.resetsAt || !Number.isFinite(Date.parse(l.resetsAt))) return null;
    const when = inAbout(l.resetsAt, now);
    return l.remaining <= 0 ? `${row.again} ${when}.` : `One more comes back ${when}.`;
}

/** The rule, in #1133's words, from the node's numbers (an older node without `endsWhen`: its fixed 72 hours). */
export function ruleSentence(p: Probation): string {
    const hours = p.endsWhen?.hours ?? 72;
    const kept = p.endsWhen?.keptPosts ?? p.keptPostsNeeded;
    const span = hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;
    return `New accounts have these limits for their first ${span}, and until ${kept} of their posts have stayed up.`;
}

function progressSentence(p: Probation, now: number): string {
    const hours = p.endsWhen?.hours ?? 72;
    const span = hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;
    const kept = p.endsWhen?.keptPosts ?? p.keptPostsNeeded;
    const ageEnds = p.ageEndsAt ? Date.parse(p.ageEndsAt) : NaN;
    const age = !Number.isFinite(ageEnds) ? '' : ageEnds > now ? `Your first ${span} end ${inAbout(p.ageEndsAt!, now)}. ` : `Your first ${span} are over. `;
    const posts = p.keptPosts === 1 ? '1 of your posts has' : `${p.keptPosts} of your posts have`;
    return `${age}So far ${posts} stayed up, of the ${kept} needed.`;
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
                    <span aria-hidden="true">🌱 </span>Your account is new
                </h2>
                {onClose && (
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Hide this for now"
                        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-transparent border-none text-nature-400 hover:text-nature-600 cursor-pointer"
                    >
                        ✕
                    </button>
                )}
            </div>
            <p className="text-sm text-nature-600 dark:text-nature-300 mt-1 mb-3 leading-relaxed break-words">
                For now, a few things are limited, each over any 24 hours:
            </p>
            <ul className="list-none p-0 m-0 space-y-2">
                {ROWS.map(row => {
                    const l = probation.limits[row.key];
                    if (!l) return null;
                    const back = comesBack(row, l, now);
                    return (
                        <li key={row.key} data-testid={`new-account-limit-${row.key}`} className="min-w-0">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                <span className="text-sm font-semibold text-nature-800 dark:text-nature-100 break-words min-w-0">{row.label}</span>
                                <span className={`text-sm whitespace-nowrap ${l.remaining <= 0 ? 'font-bold text-amber-700 dark:text-amber-400' : 'text-nature-700 dark:text-nature-200'}`}>
                                    {l.remaining} of {l.limit} left
                                </span>
                            </div>
                            {back && <div className="text-xs text-nature-500 dark:text-nature-400 break-words">{back}</div>}
                        </li>
                    );
                })}
            </ul>
            <p className="text-xs text-nature-500 dark:text-nature-400 mt-3 mb-0 leading-relaxed break-words">
                Replying to someone who wrote to you first is never limited.
            </p>
            <p data-testid="new-account-rule" className="text-sm text-nature-700 dark:text-nature-200 mt-2 mb-0 leading-relaxed break-words">
                {ruleSentence(probation)} {progressSentence(probation, now)}
            </p>
        </section>
    );
}
