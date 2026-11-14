/**
 * "Learn something local" on Home (DESIGN-local-knowledge-amend-fable.md §3.6, slice K7): what core's `learnHomeLines` says to
 * draw, the same as the phone's card (apps/native components/home/LearnBody.tsx). An owner's or admin's amber "N to check ›"
 * row first, where this app opens To check; "Add the first thing worth knowing about {community}" where it opens the form and
 * Learn shows nothing; then up to three of the day's pages in Learn's own row card, the newest of the last 14 days led by
 * "NEW", each opening its page; "See all ›" (spoken "See all of Learn") opens Learn. While the card arrives on a Home its
 * member already arranged, "Keep on Home" keeps it.
 */
import { LEARN_HOME_WORDS, formatCount, t, tn, type LearnHomeLines } from '@beanpool/core';
import { HomeLine, HomeMore } from './HomeCard';
import { LearnRow } from './LearnRow';

export function LearnHomeBody({ lines, community, onOpen, onSeeAll, onToCheck, onAddFirst, onKeep }: {
    lines: LearnHomeLines;
    /** The community's name, for "Add the first thing worth knowing about {community}". */
    community: string;
    onOpen: (id: string) => void;
    onSeeAll: () => void;
    onToCheck?: () => void;
    onAddFirst?: () => void;
    /** Only while the card arrives (core `arrivingCards`): Keep on Home puts it on the member's list. */
    onKeep?: () => void;
}) {
    const toCheck = lines.toCheck > 0 ? tn(lines.toCheck, LEARN_HOME_WORDS.toCheck.one, LEARN_HOME_WORDS.toCheck.other, { n: formatCount(lines.toCheck) }) : '';
    const first = lines.first ? t(LEARN_HOME_WORDS.first, { community }) : '';
    return (
        <div>
            {toCheck && onToCheck && (
                <HomeLine onClick={onToCheck} label={toCheck} testId="home-learn-check">
                    {/* Never colour alone: the amber is a ▲ too, as Needs you draws it. */}
                    <span aria-hidden="true" className="shrink-0 text-amber-700 dark:text-amber-400 font-black">▲</span>
                    <span className="min-w-0 break-words font-bold">{toCheck}</span>
                </HomeLine>
            )}
            {first && onAddFirst && (
                <HomeLine onClick={onAddFirst} label={first} testId="home-learn-first">
                    <span className="min-w-0 break-words font-bold">{first}<span aria-hidden="true"> ›</span></span>
                </HomeLine>
            )}
            {lines.rows.length > 0 && (
                <div data-testid="home-learn-rows" className="flex flex-col gap-2 mt-1">
                    {lines.rows.map(row => (
                        <LearnRow key={row.id} row={row} fresh={row.isNew === true} testId={`home-learn-${row.id}`} onOpen={() => onOpen(row.id)} />
                    ))}
                </div>
            )}
            {lines.rows.length > 0 && (
                <HomeMore onClick={onSeeAll} testId="home-learn-all" label={t(LEARN_HOME_WORDS.seeAllSpoken)}>{t('See all ›')}</HomeMore>
            )}
            {onKeep && (
                <button type="button" data-testid="home-learn-keep" onClick={onKeep}
                    className="mt-1 min-w-[44px] min-h-[44px] px-4 rounded-xl border border-border-primary bg-transparent text-sm font-bold text-text-primary cursor-pointer hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                    {t(LEARN_HOME_WORDS.keep)}
                </button>
            )}
        </div>
    );
}
