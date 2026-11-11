/**
 * The Market's one line about Learn (slice K2; DESIGN-local-knowledge-amend-fable.md §2.7, §3.9): while the Market's search box
 * holds words and Learn has a match, one line sits above the results (and in the empty state): "📖 In Learn: 2 for "tip" ›".
 * It opens Learn with the search filled. No page of Local knowledge is ever among the listings, on any pill, with or without
 * words: the Market asks for none (`CLIENT_POST_TYPES` and the map's list filter are as they were), this line asks Learn's own
 * search for a count and nothing else.
 *
 * - **On the timer the listing search waits on** (300 ms after the last key), so typing asks once, not at every letter.
 * - **Learn's mode comes from the Market**, which reads it once for the whole visit (`useLearn`), so the first key is already
 *   counting down. The line draws nothing where Learn is off or the node has not said.
 * - **A failed count shows no line**, never an error; so does a count of none.
 * - **Where Learn is previewed** (the global community) the count is a plain match over Example Valley's pages, and the line
 *   opens the preview.
 * - One line at least 44 tall; a long word wraps inside it rather than past the edge (320 px, 130% text).
 */
import { useEffect, useState } from 'react';
import { t, type FeatureMode } from '@beanpool/core';
import { learnSearchOf, searchLearn, showsLearn } from '../lib/learn';
import { sampleLearnPosts } from './ShowcasePreviews';

/** How long the Market's search waits after a key (MarketplacePage's listing search waits the same). */
export const LEARN_COUNT_DELAY_MS = 300;

export function LearnSearchLine({ words, mode, onOpen }: { words: string; mode: FeatureMode; onOpen: (words: string) => void }) {
    const typed = words.trim().slice(0, 100);
    const on = showsLearn(mode);
    const [count, setCount] = useState<{ words: string; n: number } | null>(null);
    useEffect(() => {
        if (!on || !typed) { setCount(null); return; }
        let live = true;
        const timer = setTimeout(() => {
            const read = mode === 'preview' ? Promise.resolve(learnSearchOf(sampleLearnPosts(), typed)) : searchLearn(typed);
            read.then((r) => { if (live) setCount({ words: typed, n: r.total }); }, () => { if (live) setCount(null); });
        }, LEARN_COUNT_DELAY_MS);
        return () => { live = false; clearTimeout(timer); };
    }, [on, mode, typed]);

    if (!on || !count || count.words !== typed || count.n < 1) return null;
    return (
        <button
            type="button"
            data-testid="market-learn-line"
            onClick={() => onOpen(typed)}
            className="my-1 w-full min-h-[44px] flex items-center text-start px-3 py-1 rounded-xl bg-transparent border-0 cursor-pointer text-sm font-bold text-bp-ink-learn break-words hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn"
        >
            {t('📖 In Learn: {n} for "{words}" ›', { n: count.n, words: typed })}
        </button>
    );
}
