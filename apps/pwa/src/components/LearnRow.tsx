/**
 * The row card of Learn (slice K2; DESIGN-local-knowledge-fable.md §3.1 as amended): the one shape a page of Local knowledge
 * takes in a list, whole card one tap to its page, no name on it. The photo, or the topic's tile when there is none (a post
 * without a photo is never bare) at 64 wide; then the chips (the topic in capitals, 📌 PINNED, MAY BE OUT OF DATE in amber),
 * the title on two lines, the first line of the body on one, and "Checked Nov 2026 · Helped 12". Spoken: "Local knowledge:
 * {title}, checked {month year}".
 *
 * The frame, the chip and the card's colours are the Market's own (market-card-shell.ts); the topic's teal is core's `learn`
 * role (`bp-chip-learn-*`), never a literal. Member text is `dir="auto"`, so a page in another script reads its own way.
 */
import { KNOWLEDGE_NAMES, LEARN_HOME_WORDS, t, upperCase, type KnowledgeRow } from '@beanpool/core';
import { resolveImageUrl } from '../lib/avatar';
import { checkedOverAYear, monthYear, topicEmoji, topicLabel } from '../lib/learn';
import { ListPhoto } from './ListPhoto';
import { CHIP, chip, listCard, LIST_TEXT } from './market-card-shell';

const TOPIC_CHIP = `${CHIP} bg-bp-chip-learn-tint text-bp-chip-learn-ink`;
/** The topic's full-colour tile, filling the slot it is in: its glyph on the learn tint. */
export function LearnTopicTile({ topic }: { topic: string }) {
    return (
        <span data-testid="learn-topic-tile" aria-hidden="true" className="absolute inset-0 flex items-center justify-center bg-bp-chip-learn-tint text-2xl leading-none">
            {topicEmoji(topic)}
        </span>
    );
}

/** "Checked Nov 2026", or "Checked over a year ago" once it has been that long. */
export function checkedWords(checkedAt: string, now = Date.now()): { text: string; old: boolean } {
    const old = checkedOverAYear(checkedAt, now);
    return { text: old ? t('Checked over a year ago') : t('Checked {date}', { date: monthYear(checkedAt) }), old };
}

/** `fresh`: the Home card's newest page of the last 14 days (slice K7), led by the chip "NEW". */
export function LearnRow({ row, onOpen, fresh, testId = 'learn-row' }: { row: KnowledgeRow; onOpen: () => void; fresh?: boolean; testId?: string }) {
    const checked = checkedWords(row.checkedAt);
    return (
        <button
            type="button"
            data-testid={testId}
            onClick={onOpen}
            aria-label={t('{kind}: {title}, checked {date}', { kind: t(KNOWLEDGE_NAMES.kind), title: row.title, date: monthYear(row.checkedAt) })}
            className={`${listCard()} text-start cursor-pointer hover:shadow-md transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn`}
        >
            {/* The photo's slot: 64 wide and the card's height. It is `relative`, written out here where the list-photo slot check
                (ListPhoto.slots.test.ts) reads it, so the photo and the tile fill THIS box while a photo loads, never an ancestor. */}
            <span className="relative w-16 min-h-16 self-stretch shrink-0 overflow-hidden">
                <ListPhoto
                    photo={row.photo}
                    // The web's image allow-list (lib/avatar.ts, PWA-2): a refused address draws the topic's tile, never itself.
                    resolve={(url) => resolveImageUrl(url)}
                    fallback={<LearnTopicTile topic={row.topic} />}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 w-full h-full object-cover"
                />
            </span>
            <span className={LIST_TEXT}>
                <span className="flex flex-wrap items-center gap-1 min-w-0">
                    {fresh && <span data-testid="learn-row-new" className={TOPIC_CHIP}>{upperCase(t(LEARN_HOME_WORDS.fresh))}</span>}
                    <span data-testid="learn-row-topic" className={TOPIC_CHIP}>{upperCase(topicLabel(row.topic))}</span>
                    {row.pinned && <span data-testid="learn-row-pinned" className={chip('pinned')}>{t('📌 PINNED')}</span>}
                    {row.outdated && <span data-testid="learn-row-outdated" className={chip('warn')}>{t('MAY BE OUT OF DATE')}</span>}
                </span>
                <span dir="auto" className="block m-0 text-sm font-extrabold leading-snug text-nature-950 dark:text-white line-clamp-2 break-words">{row.title}</span>
                {row.line && <span dir="auto" className="block min-w-0 truncate text-xs leading-snug text-nature-700 dark:text-nature-200">{row.line}</span>}
                <span className="block text-[11px] leading-snug text-nature-600 dark:text-nature-300">
                    <span data-testid="learn-row-checked" className={checked.old ? 'font-bold text-bp-ink-warning' : undefined}>{checked.text}</span>
                    {row.helped > 0 && <><span aria-hidden="true"> · </span><span data-testid="learn-row-helped">{t('Helped {n}', { n: row.helped })}</span></>}
                </span>
            </span>
        </button>
    );
}
