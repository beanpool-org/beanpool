/**
 * The poll in the Market GRID on the phone (Marty, 5 Nov 2026: "yes two wide it is but make sure it filled correctly. we dont
 * want 2 wide with heaps of space"): a row of its own, both cells wide, at a TILE row's height (never its own), a summary that
 * fills that box. The list and compact views keep PollCard.
 *
 * Voted in the tile only when the WHOLE poll is in front of the member (Marty and Damo, 6 Nov 2026: "if there are 2+ more it
 * should jump to the card mandatory so you are presented with all answers. Otherwise the poll will be loaded"): every answer
 * shown, none cut, no typed Other, not a sealed poll they answered, not closed, a member signed in, and room for every row to
 * be a finger's press tall (core's pollTileVoteBlock). Then each answer row is a button that votes as the card does
 * (usePollVote: votePoll, and "Change your vote?" first), and the question, the author and the footer open the poll's page.
 * Otherwise the whole tile is one press that opens the page (/post/{id}), where it is voted, as before.
 *
 * The row's height is a tile's, drawn invisible in its first cell (the card's border, the 4:3 photo at the cell's width and
 * the text block at this phone's font scale, as every tile is built), and the tile is laid over the whole row. The rules are
 * core's (poll-grid-tile.ts) and the card's (PollCard's pollFacts / pollStatusWords); the answers' room is measured by its
 * layout: as many one-line rows as fit, the rest as "+N more"; and each shown answer's words, laid out unclamped at its row's
 * width out of sight: more than one line is a cut answer.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type NativeSyntheticEvent, type TextLayoutEventData } from 'react-native';
import {
    MARKET_CARD_SHELL as SHELL, POLL_GRID_TILE, POLL_TILE_PRESS, gridTextBlockHeight, pollOtherLines, pollOtherOption, pollTileAction,
    pollTileAnswerLabel, pollTileAnswers, pollTileLabel, pollTileMore, pollTileOpenLabel, pollTilePressesFit, pollTileQuestionLines,
    pollTileRowGrow, pollTileRowsThatFit, pollTileSummary, pollTileVoteBlock, t,
} from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { MemberAvatar } from './MemberAvatar';
import { pollFacts, pollStatusWords, usePollVote } from './PollCard';
import { CardChip, useCardShell } from './market-card-shell';
import { isPostPinned } from '../utils/pins';
import { INFORMAL_POLL_NOTE } from '../utils/node-profile';

/** Lines kept as word() elsewhere, shown here in the member's language (the card's own). */
const LINES = { informal: INFORMAL_POLL_NOTE };

interface PollGridTileProps {
    post: any;
    /** The tile's press (or, on a tile voted in place, its question, author and footer): the Market opens the poll's page. */
    onOpen: () => void;
    /** The phone's font scale (useWindowDimensions), as the tiles beside it are built at. */
    fontScale: number;
    /** The worldwide community's polls (utils/node-profile.ts pollsInformal): the tile says it decides nothing, as the card does. */
    informal?: boolean;
    /** The member signed in on this phone: without one the tile only opens the poll. */
    currentPubkey?: string | null;
    /** After a vote in the tile (the Market reloads its list, as after a vote on the card). */
    onVoteSuccess?: () => void;
}

export function PollGridTile({ post, onOpen, fontScale, informal = false, currentPubkey = null, onVoteSuccess }: PollGridTileProps) {
    const shell = useCardShell();
    const styles = useStyles(makeStyles);
    const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
    const rowHeight = POLL_GRID_TILE.rowHeight * scale;
    const rowGap = POLL_GRID_TILE.rowGap * scale;
    const [room, setRoom] = useState(0);
    const [fit, setFit] = useState<number | null>(null);
    /** Each shown answer's words, laid out unclamped at its row's width: how many lines they take. */
    const [lines, setLines] = useState<Record<string, number>>({});

    // The node's answer to a vote cast here is drawn in place, as on the card; a new list from the Market replaces it.
    const [livePost, setLivePost] = useState(post);
    useEffect(() => { setLivePost(post); }, [post]);
    const { votingOptionId, handleVote } = usePollVote(livePost, setLivePost, { currentPubkey, onVoteSuccess });

    const { isClosed, authorName, avatarUrl, options, totalVotes, userVotedOptionId, openVote, sealed, answered } = pollFacts(livePost);
    const { answers, more } = pollTileAnswers(options, { totalVotes, userVotedOptionId, sealed, fit });
    const block = pollTileVoteBlock({
        closed: isClosed,
        canVote: Boolean(currentPubkey),
        other: pollOtherOption(options) !== null,
        sealed,
        answered,
        measured: fit !== null && answers.every(a => lines[a.key] !== undefined),
        more,
        cut: answers.some(a => (lines[a.key] ?? 0) > 1),
        pressesFit: pollTilePressesFit(room, answers.length, rowGap),
    });
    const votable = block === null;
    const action = pollTileAction({ closed: isClosed, answered, votable });
    const label = pollTileLabel({ question: livePost.title, answerCount: options.length, totalVotes, closed: isClosed });
    const authorKey: string = livePost.author_pubkey || livePost.authorPublicKey || '';
    const onAnswersLayout = (e: LayoutChangeEvent) => {
        const height = e.nativeEvent.layout.height;
        setRoom(height);
        setFit(pollTileRowsThatFit(height, rowHeight, rowGap));
    };
    const onWordsLayout = (key: string) => (e: NativeSyntheticEvent<TextLayoutEventData>) => {
        const n = e.nativeEvent.lines.length;
        setLines(prev => (prev[key] === n ? prev : { ...prev, [key]: n }));
    };
    // How far a row may grow: further for a short poll, so two answers still fill the tile. A row that votes is a finger's press
    // tall at least (the room was measured to hold every row at that height).
    const grow = pollTileRowGrow(answers.length + (more > 0 ? 1 : 0));
    const row = votable
        ? { minHeight: Math.max(rowHeight, POLL_TILE_PRESS), maxHeight: Math.max(rowHeight * grow, POLL_TILE_PRESS) }
        : { minHeight: rowHeight, maxHeight: rowHeight * grow };

    // Voted in place: the tile is no button (its answers are), and its question, author and footer open the poll. Otherwise the
    // whole tile is the one press, as before.
    const Tile: React.ElementType = votable ? View : Pressable;
    const tileProps = votable
        ? {}
        : { onPress: onOpen, accessibilityRole: 'button' as const, accessibilityLabel: label };
    const Head: React.ElementType = votable ? Pressable : View;
    const Foot: React.ElementType = votable ? Pressable : View;
    const footProps = votable ? { onPress: onOpen, accessibilityRole: 'button' as const, accessibilityLabel: pollTileOpenLabel(livePost.title) } : {};

    return (
        <View style={shell.gridRow} testID="market-grid-poll-row">
            {/* A tile's height, drawn invisible: the row is one tile row tall, never the poll's own height. */}
            <View style={shell.gridCell} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <View style={styles.ghost} testID="poll-grid-ghost">
                    <View style={shell.gridImageWrapper} />
                    <View style={{ height: gridTextBlockHeight(scale) }} testID="poll-grid-ghost-text" />
                </View>
            </View>
            <View style={shell.gridCell} />
            <Tile style={[shell.card, styles.tile]} testID={`market-poll-tile-${livePost.id}`} {...tileProps}>
                <Head style={styles.head} testID="poll-grid-head" {...(votable ? { onPress: onOpen, accessible: false } : {})}>
                    <View style={styles.chips}>
                        <CardChip shell={shell} role="poll" label={t('🗳️ POLL')} testID="poll-badge" />
                        <CardChip shell={shell} role="quiet" label={pollStatusWords(livePost, isClosed)} testID="poll-status" />
                        {isPostPinned(livePost) && <CardChip shell={shell} role="pinned" label="📌" testID="pinned-chip" />}
                    </View>
                    <View style={styles.author} testID="poll-author">
                        <MemberAvatar pubkey={authorKey} avatarUrl={avatarUrl} callsign={authorName} size={18} />
                        <Text style={styles.authorText} numberOfLines={1}>{authorName}</Text>
                    </View>
                </Head>

                <Text style={shell.gridTitle} numberOfLines={pollTileQuestionLines(options.length)} testID="poll-grid-question" onPress={votable ? onOpen : undefined}>{livePost.title}</Text>

                <View style={[styles.answers, { gap: rowGap }]} onLayout={onAnswersLayout} testID="poll-grid-answers">
                    {answers.map(a => {
                        const words = a.option.other ? pollOtherLines.other() : a.option.text;
                        const optionId = a.option.id;
                        const inner = (
                            <>
                                <View style={[styles.bar, { width: `${a.pct}%` }]} />
                                <View style={styles.words}>
                                    <Text style={styles.answerText} numberOfLines={1}>{words}</Text>
                                    {/* The same words unclamped at the same width, out of sight: more than one line is a cut answer. */}
                                    <Text
                                        style={[styles.answerText, styles.measure]}
                                        onTextLayout={onWordsLayout(a.key)}
                                        accessibilityElementsHidden
                                        importantForAccessibility="no"
                                        testID="poll-grid-answer-measure"
                                    >
                                        {words}
                                    </Text>
                                </View>
                                <Text style={styles.pct} testID="poll-grid-pct">{a.pct}%{a.chosen ? ' ✓' : ''}</Text>
                            </>
                        );
                        const testID = a.chosen ? 'poll-grid-answer-chosen' : 'poll-grid-answer';
                        const rowStyle = [styles.row, row, a.chosen && styles.rowChosen];
                        if (votable && optionId) {
                            const busy = votingOptionId === optionId;
                            return (
                                <Pressable
                                    key={a.key}
                                    style={({ pressed }: { pressed: boolean }) => [...rowStyle, (pressed || busy) && styles.rowPressed]}
                                    onPress={() => { void handleVote(optionId); }}
                                    disabled={Boolean(votingOptionId)}
                                    accessibilityRole="button"
                                    accessibilityLabel={pollTileAnswerLabel(words ?? '', a.pct)}
                                    accessibilityState={{ selected: a.chosen, busy, disabled: Boolean(votingOptionId) }}
                                    testID={testID}
                                >
                                    {inner}
                                </Pressable>
                            );
                        }
                        return <View key={a.key} style={rowStyle} testID={testID}>{inner}</View>;
                    })}
                    {more > 0 && (
                        <View style={[styles.row, row]} testID="poll-grid-more">
                            <Text style={styles.moreText} numberOfLines={1}>{pollTileMore(more)}</Text>
                        </View>
                    )}
                </View>

                {/* On the worldwide community the card's own note, one line: a count there decides nothing. */}
                {informal && <Text style={styles.note} numberOfLines={1} testID="poll-informal-note">{t('💬 {note}', { note: t(LINES.informal) })}</Text>}

                <Foot style={styles.foot} testID="poll-grid-foot" {...footProps}>
                    {/* On a tile voted in place the turnout gives way first, then "Tap an answer to vote"; "Open poll ›" never. */}
                    <Text style={[styles.summary, action.hint ? styles.summaryGivesWay : null]} numberOfLines={1} testID="poll-grid-summary">{pollTileSummary({ totalVotes, closed: isClosed, openVote })}</Text>
                    {action.hint ? (
                        <View style={styles.actionHere} testID={`poll-grid-action-${action.kind}`}>
                            <Text style={[styles.action, styles.hint]} numberOfLines={1} testID="poll-grid-hint">{action.hint}</Text>
                            {/* The separator stays whole when the hint gives way: "Tap an answer to v… · Open poll ›". */}
                            <Text style={[styles.action, styles.separator]} numberOfLines={1}>{' · '}</Text>
                            <Text style={styles.action} numberOfLines={1}>{action.words}</Text>
                        </View>
                    ) : (
                        <Text style={styles.action} numberOfLines={1} testID={`poll-grid-action-${action.kind}`}>{action.words}</Text>
                    )}
                </Foot>
            </Tile>
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) =>
    StyleSheet.create({
        /** The invisible tile: the card's border round the photo and the text block, as a real tile is drawn. */
        ghost: { opacity: 0, borderWidth: SHELL.borderWidth, borderColor: 'transparent' },
        /** The tile over the whole row (not its gutter below): the card, a column with its 12 of padding. */
        tile: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, marginBottom: 0, padding: SHELL.textPadding, gap: 6 },
        head: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
        chips: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, overflow: 'hidden' },
        /** The author gives way first (a far larger shrink), so the chips stay whole while there is room for them. */
        author: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 100, minWidth: 0, marginLeft: 'auto' },
        authorText: { flexShrink: 1, fontSize: 12, fontWeight: '700', color: colors.text.secondary },
        /** The answers' room between the question and the footer: rows grow to fill it, then spread evenly. */
        answers: { flex: 1, minHeight: 0, justifyContent: 'space-evenly', overflow: 'hidden' },
        row: {
            flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderRadius: 8, borderWidth: SHELL.borderWidth,
            borderColor: colors.border.default, overflow: 'hidden',
        },
        rowChosen: { borderColor: colors.market.poll.fg },
        /** A row under a finger, or sending its vote: the poll ink round it. */
        rowPressed: { borderColor: colors.market.poll.fg },
        bar: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: colors.market.poll.bg },
        /** The answer's words, the room the row leaves beside the percentage. */
        words: { flex: 1, minWidth: 0, justifyContent: 'center' },
        answerText: { fontSize: 12, fontWeight: '700', color: colors.text.body },
        /** The words laid out unclamped at the row's width, out of sight and out of the layout. */
        measure: { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 },
        pct: { flexShrink: 0, fontSize: 12, fontWeight: '900', color: colors.market.poll.fg },
        moreText: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '700', color: colors.text.secondary },
        note: { fontSize: 11, fontWeight: '600', color: colors.market.poll.fg },
        foot: {
            flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 6, borderTopWidth: SHELL.borderWidth,
            borderTopColor: colors.border.default,
        },
        summary: { flexShrink: 1, minWidth: 0, fontSize: 11, fontWeight: '600', color: colors.text.secondary },
        action: { flexShrink: 0, marginLeft: 'auto', fontSize: 11, fontWeight: '700', color: colors.market.poll.fg },
        /** On a tile voted in place: the turnout gives way first (a far larger shrink), then the hint; "Open poll ›" never. */
        summaryGivesWay: { flexShrink: 100 },
        actionHere: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, minWidth: 0, marginLeft: 'auto' },
        hint: { flexShrink: 1, minWidth: 0, marginLeft: 0 },
        separator: { marginLeft: 0 },
    });
