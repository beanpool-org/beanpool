/**
 * The poll in the Market GRID (Marty, 5 Nov 2026: "yes two wide it is but make sure it filled correctly. we dont want 2 wide
 * with heaps of space"): two cells wide, ONE tile row tall, a summary that fills that box. The list and compact views keep
 * PollCard.
 *
 * Voted in the tile only when the WHOLE poll is in front of the member (Marty and Damo, 6 Nov 2026: "if there are 2+ more it
 * should jump to the card mandatory so you are presented with all answers. Otherwise the poll will be loaded"): every answer
 * shown, none cut, no typed Other, not a sealed poll they answered, not closed, a member signed in, and room for every row to
 * be a finger's press tall (core's pollTileVoteBlock). Then each answer row is a button that votes as the card does
 * (usePollVote: votePoll, and "Change your vote?" first), and the question, the author and the footer open the poll.
 * Otherwise the whole tile is one button that opens the full poll, where it is voted, as before.
 *
 * The rules are core's (poll-grid-tile.ts) and the card's (PollCard's pollFacts / pollStatusWords): the percentages and the ✓
 * the card shows, a sealed poll's "You answered ✓", a closed poll's "See results ›". The answers' room is measured: as many
 * one-line rows as fit, the rest as "+N more"; and each shown answer's words, cut when they are wider than their row.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
    POLL_GRID_TILE, pinLive, pollOtherLines, pollOtherOption, pollTileAction, pollTileAnswerLabel, pollTileAnswers, pollTileLabel, pollTileMore,
    pollTileOpenLabel, pollTilePressesFit, pollTileQuestionLines, pollTileRowGrow, pollTileRowsThatFit, pollTileSummary, pollTileVoteBlock, t,
    POLL_TILE_PRESS,
} from '@beanpool/core';
import { type MarketplacePost } from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { MemberAvatar } from './MemberAvatar';
import { pollFacts, pollStatusWords, usePollVote } from './PollCard';
import {
    CARD_INK, GRID_POLL_ACTION, GRID_POLL_ANSWER, GRID_POLL_ANSWERS, GRID_POLL_BAR, GRID_POLL_CELL, GRID_POLL_FOOT, GRID_POLL_GHOST,
    GRID_POLL_GHOST_PHOTO, GRID_POLL_GHOST_TEXT, GRID_POLL_HEAD, GRID_POLL_NOTE, GRID_POLL_PCT, GRID_POLL_PRESS, GRID_POLL_QUESTION, GRID_POLL_ROW,
    GRID_POLL_ROW_EDGE, GRID_POLL_ROW_MAX, GRID_POLL_TILE, chip, gridChip,
} from './market-card-shell';

/** The clamp's class for 2 or 3 lines, written out whole so Tailwind builds both. */
const CLAMP: Record<number, string> = { 2: 'line-clamp-2', 3: 'line-clamp-3' };

interface PollGridTileProps {
    post: MarketplacePost;
    /** The tile's press (or, on a tile voted in place, its question, author and footer): the Market opens the poll's page. */
    onOpen: () => void;
    /** The cell's test id (the Market's pinned cells say `market-pinned-tile`). */
    testId?: string;
    /** The global community's polls (lib/informal-polls.ts): the tile says it decides nothing, as the card does. */
    informal?: boolean;
    /** The member signed in: without one the tile only opens the poll. */
    identity?: BeanPoolIdentity | null;
    /** A member of this community (the Market's `isMember`, never a visitor): only a member's tile is voted in place. */
    member?: boolean;
    /** After a vote in the tile (the Market refreshes its list, as after a vote on the card). */
    onVoteSuccess?: () => void;
}

/** What the answers' room measures: the rows that fit it, its height and gap in px, and whether a shown answer's words are cut. */
interface Room { fit: number | null; height: number; gap: number; cut: boolean }

/**
 * The answers' room, measured in the page's own rem (a larger text setting makes the rows taller), and each shown answer's
 * words: cut when they are wider inside than their box (scrollWidth past clientWidth). Measured after every draw and on every
 * resize; the state changes only when a number does.
 */
function useAnswersRoom() {
    const ref = useRef<HTMLDivElement | null>(null);
    const [room, setRoom] = useState<Room>({ fit: null, height: 0, gap: 0, cut: false });
    const measure = () => {
        const el = ref.current;
        if (!el) return;
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const gap = POLL_GRID_TILE.rowGapRem * rem;
        const height = el.clientHeight;
        const fit = pollTileRowsThatFit(height, POLL_GRID_TILE.rowHeightRem * rem, gap);
        const cut = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="poll-grid-answer-words"]')).some(w => w.scrollWidth > w.clientWidth);
        setRoom(prev => (prev.fit === fit && prev.height === height && prev.gap === gap && prev.cut === cut ? prev : { fit, height, gap, cut }));
    };
    // Every draw: the answers shown, their words and the percentages beside them may have changed.
    useLayoutEffect(measure);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const watch = new ResizeObserver(measure);
        watch.observe(el);
        return () => watch.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return { ref, room };
}

export function PollGridTile({ post, onOpen, testId, informal = false, identity = null, member = true, onVoteSuccess }: PollGridTileProps) {
    // The node's answer to a vote cast here is drawn in place, as on the card; a new list from the Market replaces it.
    const [livePost, setLivePost] = useState<MarketplacePost>(post);
    useEffect(() => { setLivePost(post); }, [post]);
    const { votingOptionId, error, handleVote } = usePollVote(livePost, setLivePost, { identity, onVoteSuccess });

    const { openVote, isClosed, authorName, avatarSrc, options, totalVotes, sealed, answered } = pollFacts(livePost);
    const { ref, room } = useAnswersRoom();
    const { answers, more } = pollTileAnswers(options, { totalVotes, userVotedOptionId: livePost.userVotedOptionId, sealed, fit: room.fit });
    const block = pollTileVoteBlock({
        closed: isClosed,
        canVote: Boolean(identity) && member,
        other: pollOtherOption(options) !== null,
        sealed,
        answered,
        measured: room.fit !== null,
        more,
        cut: room.cut,
        pressesFit: pollTilePressesFit(room.height, answers.length, room.gap),
    });
    const votable = block === null;
    // How far a row may grow: further for a short poll, so two answers still fill a wide tile. A row that votes is a finger's
    // press tall at least (the room was measured to hold every row at that height).
    const grow = pollTileRowGrow(answers.length + (more > 0 ? 1 : 0));
    const row = `${GRID_POLL_ROW} ${GRID_POLL_ROW_MAX[grow]}`;
    const press = votable ? { minHeight: POLL_TILE_PRESS, maxHeight: `max(${grow * POLL_GRID_TILE.rowHeightRem}rem, ${POLL_TILE_PRESS}px)` } : undefined;
    const action = pollTileAction({ closed: isClosed, answered, votable });
    const pinned = pinLive(livePost as any);
    const label = pollTileLabel({ question: livePost.title, answerCount: options.length, totalVotes, closed: isClosed });
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
        }
    };
    // Voted in place: the tile is no button (its answers are), and its question, author and footer open the poll; the footer
    // is the one in the tab order. Otherwise the whole tile is the one button, as before.
    const tileButton = votable ? {} : { role: 'button', tabIndex: 0, 'aria-label': label, onClick: onOpen, onKeyDown };
    const opens = votable ? { onClick: onOpen } : {};
    const footButton = votable ? { role: 'button', tabIndex: 0, 'aria-label': pollTileOpenLabel(livePost.title), onClick: onOpen, onKeyDown } : {};

    return (
        <div data-testid={testId ?? 'poll-grid-cell'} className={GRID_POLL_CELL}>
            {/* A tile's height, drawn invisible: the cell is one tile row tall, never the poll's own height. */}
            <div aria-hidden="true" data-testid="poll-grid-ghost" className={GRID_POLL_GHOST}>
                <div className={GRID_POLL_GHOST_PHOTO} />
                <div className={GRID_POLL_GHOST_TEXT} />
            </div>
            {/* The card holds blocks, so a role, not a <button> (as the listing tiles). */}
            <div
                {...tileButton}
                data-testid="poll-grid-tile"
                data-votable={votable ? 'true' : 'false'}
                data-vote-block={block ?? ''}
                className={GRID_POLL_TILE}
            >
                <div data-testid="poll-grid-head" className={GRID_POLL_HEAD} {...opens}>
                    <span className="flex items-center gap-1 min-w-0">
                        <span data-testid="poll-badge" className={chip('poll')}><span aria-hidden="true">🗳️ </span>{t('POLL')}</span>
                        <span data-testid="poll-status" className={gridChip('quiet')}>{pollStatusWords(livePost, isClosed)}</span>
                        {pinned && <span data-testid="poll-pinned-chip" title={t('📌 PINNED')} className={chip('pinned')}><span aria-hidden="true">📌</span></span>}
                    </span>
                    {/* The author gives way first (a far larger shrink), so the chips stay whole while there is room for them. */}
                    <span data-testid="poll-author" className="ms-auto flex items-center gap-1.5 min-w-0 shrink-[100]">
                        <MemberAvatar avatarUrl={avatarSrc} pubkey={livePost.authorPublicKey} callsign={authorName} size={18} className="shrink-0 border border-nature-200 dark:border-nature-700" />
                        <span className={`min-w-0 truncate text-xs font-bold ${CARD_INK.secondary}`}>{authorName}</span>
                    </span>
                </div>

                <h3 dir="auto" data-testid="poll-grid-question" className={`${GRID_POLL_QUESTION} ${CLAMP[pollTileQuestionLines(options.length)]} ${CARD_INK.title}`} {...opens}>
                    {livePost.title}
                </h3>

                <div ref={ref} data-testid="poll-grid-answers" data-fit={room.fit ?? ''} className={GRID_POLL_ANSWERS}>
                    {answers.map(a => {
                        const words = a.option.other ? pollOtherLines.other() : a.option.text;
                        const optionId = a.option.id;
                        const inner = (
                            <>
                                <span aria-hidden="true" className={GRID_POLL_BAR} style={{ width: `${a.pct}%` }} />
                                <span dir="auto" data-testid="poll-grid-answer-words" className={`${GRID_POLL_ANSWER} ${CARD_INK.title}`}>{words}</span>
                                <span className={GRID_POLL_PCT}>
                                    {t('{rate}%', { rate: a.pct })}{a.chosen && <span data-testid="poll-grid-chosen"> ✓</span>}
                                </span>
                            </>
                        );
                        const edge = a.chosen ? GRID_POLL_ROW_EDGE.chosen : GRID_POLL_ROW_EDGE.open;
                        if (votable && optionId) {
                            return (
                                <button
                                    key={a.key}
                                    type="button"
                                    data-testid="poll-grid-answer"
                                    data-chosen={a.chosen ? 'true' : undefined}
                                    aria-label={pollTileAnswerLabel(words ?? '', a.pct)}
                                    aria-pressed={a.chosen}
                                    aria-busy={votingOptionId === optionId}
                                    disabled={Boolean(votingOptionId)}
                                    onClick={() => { void handleVote(optionId); }}
                                    style={press}
                                    className={`${row} ${edge} ${GRID_POLL_PRESS}`}
                                >
                                    {inner}
                                </button>
                            );
                        }
                        return (
                            <div key={a.key} data-testid="poll-grid-answer" data-chosen={a.chosen ? 'true' : undefined} className={`${row} ${edge}`}>
                                {inner}
                            </div>
                        );
                    })}
                    {more > 0 && (
                        <div data-testid="poll-grid-more" className={`${row} ${GRID_POLL_ROW_EDGE.open}`}>
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

                <div data-testid="poll-grid-foot" className={GRID_POLL_FOOT} {...footButton}>
                    {/* A vote the node refused says so where the turnout was, on the same one line, so nothing moves. */}
                    {error ? (
                        <span role="alert" data-testid="poll-grid-error" className="min-w-0 truncate font-semibold text-red-600 dark:text-red-400">{error}</span>
                    ) : (
                        <span data-testid="poll-grid-summary" className={`min-w-0 truncate font-semibold ${CARD_INK.secondary}`}>
                            {pollTileSummary({ totalVotes, closed: isClosed, openVote })}
                        </span>
                    )}
                    <span data-testid="poll-grid-action" data-kind={action.kind} className={GRID_POLL_ACTION}>{action.words}</span>
                </div>
            </div>
        </div>
    );
}
