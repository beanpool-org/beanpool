/**
 * The poll in the Market GRID on the phone (Marty, 5 Nov 2026: "yes two wide it is but make sure it filled correctly. we dont
 * want 2 wide with heaps of space"): a row of its own, both cells wide, at a TILE row's height (never its own), a read-only
 * summary that fills that box, and one press that opens the poll's page (/post/{id}), where it is voted, as an item's tile
 * opens the item. The list and compact views keep PollCard.
 *
 * The row's height is a tile's, drawn invisible in its first cell (the card's border, the 4:3 photo at the cell's width and
 * the text block at this phone's font scale, as every tile is built), and the tile is laid over the whole row. The rules are
 * core's (poll-grid-tile.ts) and the card's (PollCard's pollFacts / pollStatusWords); the answers' room is measured by its
 * layout: as many one-line rows as fit, the rest as "+N more".
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
    MARKET_CARD_SHELL as SHELL, POLL_GRID_TILE, gridTextBlockHeight, pollOtherLines, pollTileAction, pollTileAnswers, pollTileLabel,
    pollTileMore, pollTileQuestionLines, pollTileRowGrow, pollTileRowsThatFit, pollTileSummary, t,
} from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { MemberAvatar } from './MemberAvatar';
import { pollFacts, pollStatusWords } from './PollCard';
import { CardChip, useCardShell } from './market-card-shell';
import { isPostPinned } from '../utils/pins';
import { INFORMAL_POLL_NOTE } from '../utils/node-profile';

/** Lines kept as word() elsewhere, shown here in the member's language (the card's own). */
const LINES = { informal: INFORMAL_POLL_NOTE };

interface PollGridTileProps {
    post: any;
    /** The one press: the Market opens the poll's page. */
    onOpen: () => void;
    /** The phone's font scale (useWindowDimensions), as the tiles beside it are built at. */
    fontScale: number;
    /** The worldwide community's polls (utils/node-profile.ts pollsInformal): the tile says it decides nothing, as the card does. */
    informal?: boolean;
}

export function PollGridTile({ post, onOpen, fontScale, informal = false }: PollGridTileProps) {
    const shell = useCardShell();
    const styles = useStyles(makeStyles);
    const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
    const rowHeight = POLL_GRID_TILE.rowHeight * scale;
    const rowGap = POLL_GRID_TILE.rowGap * scale;
    const [fit, setFit] = useState<number | null>(null);

    const { isClosed, authorName, avatarUrl, options, totalVotes, userVotedOptionId, openVote, sealed, answered } = pollFacts(post);
    const { answers, more } = pollTileAnswers(options, { totalVotes, userVotedOptionId, sealed, fit });
    const action = pollTileAction({ closed: isClosed, answered });
    const label = pollTileLabel({ question: post.title, answerCount: options.length, totalVotes, closed: isClosed });
    const authorKey: string = post.author_pubkey || post.authorPublicKey || '';
    const onAnswersLayout = (e: LayoutChangeEvent) => setFit(pollTileRowsThatFit(e.nativeEvent.layout.height, rowHeight, rowGap));
    // How far a row may grow: further for a short poll, so two answers still fill the tile.
    const row = { minHeight: rowHeight, maxHeight: rowHeight * pollTileRowGrow(answers.length + (more > 0 ? 1 : 0)) };

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
            <Pressable
                style={[shell.card, styles.tile]}
                onPress={onOpen}
                accessibilityRole="button"
                accessibilityLabel={label}
                testID={`market-poll-tile-${post.id}`}
            >
                <View style={styles.head} testID="poll-grid-head">
                    <View style={styles.chips}>
                        <CardChip shell={shell} role="poll" label={t('🗳️ POLL')} testID="poll-badge" />
                        <CardChip shell={shell} role="quiet" label={pollStatusWords(post, isClosed)} testID="poll-status" />
                        {isPostPinned(post) && <CardChip shell={shell} role="pinned" label="📌" testID="pinned-chip" />}
                    </View>
                    <View style={styles.author} testID="poll-author">
                        <MemberAvatar pubkey={authorKey} avatarUrl={avatarUrl} callsign={authorName} size={18} />
                        <Text style={styles.authorText} numberOfLines={1}>{authorName}</Text>
                    </View>
                </View>

                <Text style={shell.gridTitle} numberOfLines={pollTileQuestionLines(options.length)} testID="poll-grid-question">{post.title}</Text>

                <View style={[styles.answers, { gap: rowGap }]} onLayout={onAnswersLayout} testID="poll-grid-answers">
                    {answers.map(a => (
                        <View key={a.key} style={[styles.row, row, a.chosen && styles.rowChosen]} testID={a.chosen ? 'poll-grid-answer-chosen' : 'poll-grid-answer'}>
                            <View style={[styles.bar, { width: `${a.pct}%` }]} />
                            <Text style={styles.answerText} numberOfLines={1}>{a.option.other ? pollOtherLines.other() : a.option.text}</Text>
                            <Text style={styles.pct} testID="poll-grid-pct">{a.pct}%{a.chosen ? ' ✓' : ''}</Text>
                        </View>
                    ))}
                    {more > 0 && (
                        <View style={[styles.row, row]} testID="poll-grid-more">
                            <Text style={styles.moreText} numberOfLines={1}>{pollTileMore(more)}</Text>
                        </View>
                    )}
                </View>

                {/* On the worldwide community the card's own note, one line: a count there decides nothing. */}
                {informal && <Text style={styles.note} numberOfLines={1} testID="poll-informal-note">{t('💬 {note}', { note: t(LINES.informal) })}</Text>}

                <View style={styles.foot} testID="poll-grid-foot">
                    <Text style={styles.summary} numberOfLines={1} testID="poll-grid-summary">{pollTileSummary({ totalVotes, closed: isClosed, openVote })}</Text>
                    <Text style={styles.action} numberOfLines={1} testID={`poll-grid-action-${action.kind}`}>{action.words}</Text>
                </View>
            </Pressable>
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
        bar: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: colors.market.poll.bg },
        answerText: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '700', color: colors.text.body },
        pct: { flexShrink: 0, fontSize: 12, fontWeight: '900', color: colors.market.poll.fg },
        moreText: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '700', color: colors.text.secondary },
        note: { fontSize: 11, fontWeight: '600', color: colors.market.poll.fg },
        foot: {
            flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 6, borderTopWidth: SHELL.borderWidth,
            borderTopColor: colors.border.default,
        },
        summary: { flexShrink: 1, minWidth: 0, fontSize: 11, fontWeight: '600', color: colors.text.secondary },
        action: { flexShrink: 0, marginLeft: 'auto', fontSize: 11, fontWeight: '700', color: colors.market.poll.fg },
    });
