/**
 * Local knowledge's card on the Pulse (slice KP; DESIGN-local-knowledge-amend-fable.md §2.12, §3.8). The node works it out
 * when the feed is read with `with=knowledge`: one card a day at most, for the pages Learn shows that went up that day.
 *
 * Smaller than a creator's card and never a creator's: a 📖 tile and "New local knowledge" (or "{n} new in Local
 * knowledge") with the time, no face and no profile; the one page's topic chip on the right and nothing else (no ⚑, no Hide:
 * there is no Pulse item behind it, and a page is reported from inside it). No wide picture: one to three rows, the page's
 * photo or its topic's tile at 64 wide, the title and one line (and "by {name}" under the one page a member wrote). A row
 * opens the page in the app; "and {n} more ›" and the foot "Open Learn ›" open Learn. Nothing is fetched from outside.
 *
 * The words and lines are core's (pulse-knowledge-card.ts), the phone's own; the colours are core's roles (`bp-chip-learn-*`
 * for the topic, the card's own nature tokens for its frame, as the creator's card has).
 */
import { useId } from 'react';
import { KNOWLEDGE_EMOJI, PULSE_KNOWLEDGE_CARD_WORDS, pulseKnowledgeCardLines, t, upperCase, type PulseKnowledgeCard as Card, type PulseKnowledgePost } from '@beanpool/core';
import { resolveImageUrl } from '../lib/avatar';
import { topicLabel } from '../lib/learn';
import { formatRelativeTime } from '../lib/pulse';
import { LearnTopicTile } from './LearnRow';
import { ListPhoto } from './ListPhoto';
import { CHIP } from './market-card-shell';

const TOPIC_CHIP = `${CHIP} bg-bp-chip-learn-tint text-bp-chip-learn-ink`;
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bp-ink-learn';

interface Props {
    card: Card;
    /** A row: the page, in Learn. */
    onOpenPage: (postId: string) => void;
    /** "and {n} more ›" and the foot: Learn's front. */
    onOpenLearn: () => void;
}

function Row({ page, by, spoken, onOpen }: { page: PulseKnowledgePost; by: string | null; spoken?: string; onOpen: () => void }) {
    return (
        <li className="m-0 p-0 list-none">
            <button
                type="button"
                data-testid="pulse-knowledge-row"
                onClick={onOpen}
                aria-label={spoken}
                className={`w-full min-w-0 flex items-stretch gap-3 p-3 text-start bg-transparent border-0 cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800/60 transition-colors ${FOCUS}`}
            >
                {/* The photo's slot, 64 wide: `relative`, so the photo and the tile fill THIS box while a photo loads
                    (ListPhoto.slots.test.ts reads it). A page with no photo, or one the allow-list refuses, has its topic's tile. */}
                <span className="relative w-16 h-16 shrink-0 overflow-hidden rounded-lg">
                    <ListPhoto
                        photo={page.photo}
                        resolve={(url) => resolveImageUrl(url)}
                        fallback={<LearnTopicTile topic={page.topic} />}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 w-full h-full object-cover"
                    />
                </span>
                <span className="min-w-0 flex-1 flex flex-col justify-center gap-0.5">
                    <span dir="auto" className="text-sm font-extrabold leading-snug text-nature-950 dark:text-white line-clamp-2 break-words">{page.title}</span>
                    {page.line && <span dir="auto" className="block min-w-0 truncate text-xs leading-snug text-nature-700 dark:text-nature-200">{page.line}</span>}
                    {by && <span dir="auto" className="block min-w-0 truncate text-[11px] leading-snug text-nature-600 dark:text-nature-300">{by}</span>}
                </span>
            </button>
        </li>
    );
}

export function PulseKnowledgeCard({ card, onOpenPage, onOpenLearn }: Props) {
    const headId = useId();
    const lines = pulseKnowledgeCardLines(card);
    if (!lines) return null;
    const timeAgo = formatRelativeTime(card.publishedAt);

    return (
        <article
            data-testid="pulse-knowledge-card"
            aria-labelledby={headId}
            className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl overflow-hidden shadow-sm flex flex-col min-w-0"
        >
            <div data-testid="pulse-knowledge-head" className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-nature-100 dark:border-nature-800/60">
                <div className="flex items-center gap-2.5 min-w-[9rem] flex-1">
                    <span data-testid="pulse-knowledge-tile" aria-hidden="true" className="w-9 h-9 shrink-0 rounded-xl bg-bp-chip-learn-tint flex items-center justify-center text-lg leading-none select-none">
                        {KNOWLEDGE_EMOJI}
                    </span>
                    <div className="min-w-0 flex-1">
                        <p id={headId} className="m-0 font-bold text-sm leading-tight text-nature-900 dark:text-white break-words">{lines.head}</p>
                        {timeAgo && <p className="m-0 mt-0.5 text-xs text-nature-500 dark:text-nature-400">{timeAgo}</p>}
                    </div>
                </div>
                {lines.topic && (
                    <span data-testid="pulse-knowledge-topic" className={`${TOPIC_CHIP} ml-auto`}>{upperCase(topicLabel(lines.topic))}</span>
                )}
            </div>

            <ul className="m-0 p-0 flex flex-col divide-y divide-nature-100 dark:divide-nature-800/60">
                {lines.rows.map((page) => (
                    <Row
                        key={page.id}
                        page={page}
                        by={lines.single ? lines.by : null}
                        spoken={lines.single ? lines.spoken : undefined}
                        onOpen={() => onOpenPage(page.id)}
                    />
                ))}
            </ul>

            {lines.more && (
                <button
                    type="button"
                    data-testid="pulse-knowledge-more"
                    onClick={onOpenLearn}
                    className={`min-h-[44px] w-full px-3 text-start text-xs font-bold bg-transparent border-0 border-t border-nature-100 dark:border-nature-800/60 text-bp-ink-learn cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800/60 ${FOCUS}`}
                >
                    {lines.more}<span aria-hidden="true"> ›</span>
                </button>
            )}

            <div className="px-3 pb-3 pt-2 border-t border-nature-100 dark:border-nature-800/60">
                <button
                    type="button"
                    data-testid="pulse-knowledge-open-learn"
                    onClick={onOpenLearn}
                    // One page: the row carries the card's spoken line, and this button says what it shows. Several: it does.
                    aria-label={lines.single ? undefined : lines.spoken}
                    // Not flex: a flex item drops the space before the ›, which drew "Open Learn›" (seen in the 320 shots).
                    className={`min-h-[44px] w-full block text-center px-4 py-2 rounded-xl text-sm font-bold bg-nature-100 hover:bg-nature-200 dark:bg-nature-800 dark:hover:bg-nature-700 text-nature-900 dark:text-white border border-nature-200 dark:border-nature-700 transition-colors cursor-pointer ${FOCUS}`}
                >
                    {t(PULSE_KNOWLEDGE_CARD_WORDS.openLearn)}<span aria-hidden="true"> ›</span>
                </button>
            </div>
        </article>
    );
}
