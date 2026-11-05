/**
 * The poll in the Market GRID (Marty, 5 Nov 2026: "yes two wide it is but make sure it filled correctly. we dont want 2 wide
 * with heaps of space"): two cells wide, ONE tile row tall, a read-only summary that fills that box, and one button that opens
 * the full poll, where it is voted (as an item's tile opens the item). The list and compact views keep PollCard.
 *
 * The rules are core's (poll-grid-tile.ts) and the card's (PollCard's pollFacts / pollStatusWords): the percentages and the ✓
 * the card shows, a sealed poll's "You answered ✓", a closed poll's "See results ›". The answers' room is measured: as many
 * one-line rows as fit, the rest as "+N more".
 */

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
    POLL_GRID_TILE, pinLive, pollOtherLines, pollTileAction, pollTileAnswers, pollTileLabel, pollTileMore, pollTileQuestionLines,
    pollTileRowsThatFit, pollTileSummary, t,
} from '@beanpool/core';
import { type MarketplacePost } from '../lib/api';
import { MemberAvatar } from './MemberAvatar';
import { pollFacts, pollStatusWords } from './PollCard';
import {
    CARD_INK, GRID_POLL_ACTION, GRID_POLL_ANSWER, GRID_POLL_ANSWERS, GRID_POLL_BAR, GRID_POLL_CELL, GRID_POLL_FOOT, GRID_POLL_GHOST,
    GRID_POLL_GHOST_PHOTO, GRID_POLL_GHOST_TEXT, GRID_POLL_HEAD, GRID_POLL_NOTE, GRID_POLL_PCT, GRID_POLL_QUESTION, GRID_POLL_ROW, GRID_POLL_ROW_EDGE,
    GRID_POLL_TILE, chip, gridChip,
} from './market-card-shell';

/** The clamp's class for 2 or 3 lines, written out whole so Tailwind builds both. */
const CLAMP: Record<number, string> = { 2: 'line-clamp-2', 3: 'line-clamp-3' };

interface PollGridTileProps {
    post: MarketplacePost;
    /** The one press: the Market opens the poll's page (its detail), where it is voted. */
    onOpen: () => void;
    /** The cell's test id (the Market's pinned cells say `market-pinned-tile`). */
    testId?: string;
    /** The global community's polls (lib/informal-polls.ts): the tile says it decides nothing, as the card does. */
    informal?: boolean;
}

/** The rows that fit the answers' room, measured in the page's own rem (a larger text setting makes the rows taller). */
function useRowsThatFit(answerCount: number) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [fit, setFit] = useState<number | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => {
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            setFit(pollTileRowsThatFit(el.clientHeight, POLL_GRID_TILE.rowHeightRem * rem, POLL_GRID_TILE.rowGapRem * rem));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const watch = new ResizeObserver(measure);
        watch.observe(el);
        return () => watch.disconnect();
    }, [answerCount]);
    return { ref, fit };
}

export function PollGridTile({ post, onOpen, testId, informal = false }: PollGridTileProps) {
    const { openVote, isClosed, authorName, avatarSrc, options, totalVotes, sealed, answered } = pollFacts(post);
    const { ref, fit } = useRowsThatFit(options.length);
    const { answers, more } = pollTileAnswers(options, { totalVotes, userVotedOptionId: post.userVotedOptionId, sealed, fit });
    const action = pollTileAction({ closed: isClosed, answered });
    const pinned = pinLive(post as any);
    const label = pollTileLabel({ question: post.title, answerCount: options.length, totalVotes, closed: isClosed });
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
        }
    };

    return (
        <div data-testid={testId ?? 'poll-grid-cell'} className={GRID_POLL_CELL}>
            {/* A tile's height, drawn invisible: the cell is one tile row tall, never the poll's own height. */}
            <div aria-hidden="true" data-testid="poll-grid-ghost" className={GRID_POLL_GHOST}>
                <div className={GRID_POLL_GHOST_PHOTO} />
                <div className={GRID_POLL_GHOST_TEXT} />
            </div>
            {/* The card holds blocks, so a role, not a <button> (as the listing tiles). */}
            <div
                role="button"
                tabIndex={0}
                aria-label={label}
                data-testid="poll-grid-tile"
                onClick={onOpen}
                onKeyDown={onKeyDown}
                className={GRID_POLL_TILE}
            >
                <div data-testid="poll-grid-head" className={GRID_POLL_HEAD}>
                    <span className="flex items-center gap-1 min-w-0">
                        <span data-testid="poll-badge" className={chip('poll')}><span aria-hidden="true">🗳️ </span>{t('POLL')}</span>
                        <span data-testid="poll-status" className={gridChip('quiet')}>{pollStatusWords(post, isClosed)}</span>
                        {pinned && <span data-testid="poll-pinned-chip" title={t('📌 PINNED')} className={chip('pinned')}><span aria-hidden="true">📌</span></span>}
                    </span>
                    <span data-testid="poll-author" className="ms-auto flex items-center gap-1.5 min-w-0">
                        <MemberAvatar avatarUrl={avatarSrc} pubkey={post.authorPublicKey} callsign={authorName} size={18} className="shrink-0 border border-nature-200 dark:border-nature-700" />
                        <span className={`min-w-0 truncate text-xs font-bold ${CARD_INK.secondary}`}>{authorName}</span>
                    </span>
                </div>

                <h3 dir="auto" data-testid="poll-grid-question" className={`${GRID_POLL_QUESTION} ${CLAMP[pollTileQuestionLines(options.length)]} ${CARD_INK.title}`}>
                    {post.title}
                </h3>

                <div ref={ref} data-testid="poll-grid-answers" data-fit={fit ?? ''} className={GRID_POLL_ANSWERS}>
                    {answers.map(a => {
                        const words = a.option.other ? pollOtherLines.other() : a.option.text;
                        return (
                            <div key={a.key} data-testid="poll-grid-answer" data-chosen={a.chosen ? 'true' : undefined}
                                className={`${GRID_POLL_ROW} ${a.chosen ? GRID_POLL_ROW_EDGE.chosen : GRID_POLL_ROW_EDGE.open}`}>
                                <span aria-hidden="true" className={GRID_POLL_BAR} style={{ width: `${a.pct}%` }} />
                                <span dir="auto" className={`${GRID_POLL_ANSWER} ${CARD_INK.title}`}>{words}</span>
                                <span className={GRID_POLL_PCT}>
                                    {t('{rate}%', { rate: a.pct })}{a.chosen && <span data-testid="poll-grid-chosen"> ✓</span>}
                                </span>
                            </div>
                        );
                    })}
                    {more > 0 && (
                        <div data-testid="poll-grid-more" className={`${GRID_POLL_ROW} ${GRID_POLL_ROW_EDGE.open}`}>
                            <span className={`${GRID_POLL_ANSWER} ${CARD_INK.secondary}`}>{pollTileMore(more)}</span>
                        </div>
                    )}
                </div>

                {/* On the global community the card's own note, one line: a count there decides nothing (lib/informal-polls.ts). */}
                {informal && (
                    <p data-testid="poll-informal-note" className={GRID_POLL_NOTE}>
                        <span aria-hidden="true">💬 </span>{t('An informal poll; it decides nothing')}
                    </p>
                )}

                <div data-testid="poll-grid-foot" className={GRID_POLL_FOOT}>
                    <span data-testid="poll-grid-summary" className={`min-w-0 truncate font-semibold ${CARD_INK.secondary}`}>
                        {pollTileSummary({ totalVotes, closed: isClosed, openVote })}
                    </span>
                    <span data-testid="poll-grid-action" data-kind={action.kind} className={GRID_POLL_ACTION}>{action.words}</span>
                </div>
            </div>
        </div>
    );
}
