/**
 * The example cards on a nearly empty Market (lib/example-listings.ts): a few made-up listings, each marked Example,
 * to show a newcomer what people post. Nothing here can be clicked: no card opens, links, messages or trades, and the
 * words are the app's own, never a person's.
 *
 * Set apart from real cards: a dashed border, a muted background and no photo, with the badge first in reading order,
 * so a screen reader says "Example" before the title.
 */

import { POST_TYPE_COLORS } from '../lib/marketplace';
import { EXAMPLE_BADGE, EXAMPLE_LISTINGS, EXAMPLES_HEADING, EXAMPLES_NOTE, exampleLabel } from '../lib/example-listings';

export function ExampleListings() {
    return (
        <section data-testid="example-listings" aria-label={EXAMPLES_HEADING} className="mt-3 mb-2">
            <h4 className="m-0 px-1 text-sm font-extrabold text-nature-800 dark:text-nature-100">{EXAMPLES_HEADING}</h4>
            <p className="mt-0.5 mb-2 px-1 text-xs font-semibold text-nature-600 dark:text-nature-300">{EXAMPLES_NOTE}</p>
            <ul className="list-none m-0 p-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {EXAMPLE_LISTINGS.map((example) => (
                    <li key={example.key} className="min-w-0">
                        <article
                            data-testid="example-card"
                            aria-label={exampleLabel(example)}
                            className="h-full min-w-0 rounded-xl border-2 border-dashed border-nature-300 dark:border-nature-600 bg-nature-50 dark:bg-nature-950 p-3 flex flex-row gap-3 select-none"
                        >
                            <span aria-hidden="true" className="w-14 h-14 rounded-xl flex-shrink-0 border border-dashed border-nature-300 dark:border-nature-700 flex items-center justify-center text-2xl opacity-80">
                                {example.emoji}
                            </span>
                            <span className="flex-1 min-w-0 flex flex-col gap-1">
                                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span data-testid="example-badge" className="text-[11px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full bg-oat-200 text-oat-900 dark:bg-oat-800 dark:text-oat-100">
                                        {EXAMPLE_BADGE}
                                    </span>
                                    <span className="text-xs font-black uppercase tracking-wide" style={{ color: POST_TYPE_COLORS[example.type] }}>
                                        {example.type === 'offer' ? 'Offer' : 'Need'}
                                    </span>
                                </span>
                                <span className="font-bold text-base leading-snug text-nature-800 dark:text-nature-100 break-words">{example.title}</span>
                                <span className="text-sm text-nature-600 dark:text-nature-300 break-words">{example.description}</span>
                            </span>
                        </article>
                    </li>
                ))}
            </ul>
        </section>
    );
}
