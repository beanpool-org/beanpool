/**
 * Local knowledge's card on the Pulse (slice KP; DESIGN-local-knowledge-amend-fable.md §2.12, §3.8). The node works it out
 * when the feed is read with `with=knowledge`: one card a day at most, for the pages Learn shows that went up that day.
 *
 * Smaller than a creator's card and never a creator's: a 📖 tile and "New local knowledge" (or "{n} new in Local
 * knowledge") with the time, no face and no profile; the one page's topic chip on the right and nothing else (no ⚑, no Hide:
 * there is no Pulse item behind it, and a page is reported from inside it). No wide picture: one to three rows, the page's
 * photo or its topic's tile at 64 wide, the title and one line (and "by {name}" under the one page a member wrote).
 *
 * The taps and what a screen reader says are the phone's (apps/native/components/PulseKnowledgeCard.tsx), from core's
 * pulseKnowledgeCardLines in PULSE_KNOWLEDGE_WORDS: one page, the head and the row are one tap to the page; several, the head
 * is a tap to Learn, each row to its page, "and {n} more ›" to Learn; the foot "Open Learn ›" to Learn. Nothing is fetched
 * from outside. The colours are core's roles (`bp-chip-learn-*`, `bp-ink-learn`) on the creator card's own frame.
 */
import { useId } from 'react';
import { KNOWLEDGE_EMOJI, pulseKnowledgeCardLines, upperCase, type PulseKnowledgeCard as Card, type PulseKnowledgePost } from '@beanpool/core';
import { resolveImageUrl } from '../lib/avatar';
import { topicLabel } from '../lib/learn';
import { formatRelativeTime } from '../lib/pulse';
import { LearnTopicTile } from './LearnRow';
import { ListPhoto } from './ListPhoto';
import { CHIP } from './market-card-shell';

const TOPIC_CHIP = `${CHIP} bg-bp-chip-learn-tint text-bp-chip-learn-ink`;
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bp-ink-learn';
const TAP = `w-full min-w-0 text-start bg-transparent border-0 cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800/60 transition-colors ${FOCUS}`;
const LINE = 'border-nature-100 dark:border-nature-800/60';

interface Props {
    card: Card;
    /** A row (and a one-page card's head): the page, in Learn. */
    onOpenPage: (postId: string) => void;
    /** A several-page card's head, "and {n} more ›" and the foot: Learn's front. */
    onOpenLearn: () => void;
}

/** The head: the 📖 tile, the card's words and the time; the one page's topic chip on the right. Phrasing content only. */
function Head({ id, text, timeAgo, topic }: { id: string; text: string; timeAgo: string; topic: string | null }) {
    return (
        <>
            <span className="flex items-center gap-2.5 min-w-[9rem] flex-1">
                <span data-testid="pulse-knowledge-tile" aria-hidden="true" className="w-9 h-9 shrink-0 rounded-xl bg-bp-chip-learn-tint flex items-center justify-center text-lg leading-none select-none">
                    {KNOWLEDGE_EMOJI}
                </span>
                <span className="min-w-0 flex-1">
                    <span id={id} data-testid="pulse-knowledge-heading" className="block font-bold text-sm leading-tight text-nature-900 dark:text-white break-words">{text}</span>
                    {timeAgo && <span className="block mt-0.5 text-xs text-nature-500 dark:text-nature-400">{timeAgo}</span>}
                </span>
            </span>
            {topic && <span data-testid="pulse-knowledge-topic" className={`${TOPIC_CHIP} ml-auto`}>{upperCase(topicLabel(topic))}</span>}
        </>
    );
}

/** A row's insides: the photo or the topic's tile at 64, the title, one line, and "by {name}" when there is one. */
function RowBody({ page, by }: { page: PulseKnowledgePost; by: string | null }) {
    return (
        <>
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
        </>
    );
}

export function PulseKnowledgeCard({ card, onOpenPage, onOpenLearn }: Props) {
    const headId = useId();
    const lines = pulseKnowledgeCardLines(card);
    if (!lines) return null;
    const timeAgo = formatRelativeTime(card.publishedAt);
    const head = <Head id={headId} text={lines.head.text} timeAgo={timeAgo} topic={lines.topic} />;

    return (
        <article
            data-testid="pulse-knowledge-card"
            aria-labelledby={headId}
            className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl overflow-hidden shadow-sm flex flex-col min-w-0"
        >
            {lines.single ? (
                // One page: the head and the row are one tap to the page, with the card's spoken line.
                <button type="button" data-testid="pulse-knowledge-row" onClick={() => onOpenPage(lines.rows[0].post.id)} aria-label={lines.head.spoken} className={`${TAP} flex flex-col`}>
                    <span data-testid="pulse-knowledge-head" className={`flex flex-wrap items-center gap-2 px-3 py-2.5 border-b ${LINE}`}>{head}</span>
                    <span className="flex items-stretch gap-3 p-3">
                        <RowBody page={lines.rows[0].post} by={lines.by} />
                    </span>
                </button>
            ) : (
                <>
                    {/* Several: the head is a tap to Learn ("{n} new in Local knowledge. Opens Learn."), each row to its page. */}
                    <button type="button" data-testid="pulse-knowledge-head" onClick={onOpenLearn} aria-label={lines.head.spoken} className={`${TAP} flex flex-wrap items-center gap-2 px-3 py-2.5 border-b ${LINE}`}>
                        {head}
                    </button>
                    <ul className="m-0 p-0 flex flex-col divide-y divide-nature-100 dark:divide-nature-800/60">
                        {lines.rows.map(({ post, spoken }) => (
                            <li key={post.id} className="m-0 p-0 list-none">
                                <button type="button" data-testid="pulse-knowledge-row" onClick={() => onOpenPage(post.id)} aria-label={spoken} className={`${TAP} flex items-stretch gap-3 p-3`}>
                                    <RowBody page={post} by={null} />
                                </button>
                            </li>
                        ))}
                    </ul>
                    {lines.more && (
                        <button
                            type="button"
                            data-testid="pulse-knowledge-more"
                            onClick={onOpenLearn}
                            aria-label={lines.more.spoken}
                            className={`${TAP} min-h-[44px] px-3 text-xs font-bold text-bp-ink-learn border-t ${LINE}`}
                        >
                            {lines.more.text}
                        </button>
                    )}
                </>
            )}

            <div className={`px-3 pb-3 pt-2 border-t ${LINE}`}>
                <button
                    type="button"
                    data-testid="pulse-knowledge-open-learn"
                    onClick={onOpenLearn}
                    aria-label={lines.foot.spoken}
                    className={`min-h-[44px] w-full block text-center px-4 py-2 rounded-xl text-sm font-bold bg-nature-100 hover:bg-nature-200 dark:bg-nature-800 dark:hover:bg-nature-700 text-nature-900 dark:text-white border border-nature-200 dark:border-nature-700 transition-colors cursor-pointer ${FOCUS}`}
                >
                    {lines.foot.text}
                </button>
            </div>
        </article>
    );
}
