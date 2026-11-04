/**
 * EventCard — an event in the Market feed, on the same card as an Offer or a Need (DESIGN-market-event-cards-fable.md §2,
 * slice P2; DESIGN-card-style-box-fable.md §1: "one card, three sizes, every kind, both apps").
 *
 * The list card's shell from the style box (components/market-card-shell.ts): corners 14, a 1 dp border, the card ground,
 * the picture flush under the card's left corners and the card's full height, 12 dp of text padding. The card takes its own
 * height from its lines (Marty, 4 Nov: "the big card doesnt need to conform to the same size"). Then:
 *
 *   EVENT · 📌 PINNED · CANCELLED / UPDATED · 🔒 group   the chip row, as on every card; the date keeps its whole line
 *   THU 5 NOV · 7:00–11:00                            the when, the loud line, in the event's ink, two lines at most
 *   the reader's own clock, ↻ the repeat rule           as before
 *   Byron Bay Farmers Market                          the title, two lines
 *   📍 Butler Street Reserve · 22 km                    the place, one line
 *   Going ✓                                           the member's own answer; the host's "You're hosting this event";
 *                                                     else the counts, only when someone has answered; else nothing
 *
 * No button on the card (Marty, 4 Nov: Going / Interested on the event's page, the mark on the card): the whole card is one
 * press that opens the event, where the two big buttons are (EventDetail). A tap anywhere opens the item (#2839).
 *
 * In the grid (slice P3', DESIGN-market-grid-sizes-fable.md §2.2) the event is a tile like the listing beside it, from the same
 * box: the 4:3 photo flush at the top, EVENT at its top-left, the foot row of pills (📌 PINNED, CANCELLED / UPDATED, a group's
 * 🔒, and your mark at the end, where a listing's price sits), then the listing tiles' four-row text block (gridTextBlock at the
 * font scale market.tsx reads, so the same numbers):
 *
 *   SAT 7 NOV                                         the date, in the event's ink
 *   16:00–21:00                                       the time, two whole pieces "16:00" "–21:00" (no time, repeating: its ↻ rule)
 *   Byron Bay Twilight Market                         the title, one line
 *   📍 Railway Park · 3 km                             the place, one line (a copy on global: "from Mullumbimby · 740 km")
 *
 * The date and the time each stay whole in half a 320 dp row at 1.3x text (core eventTileWhen): an event that ends on a later
 * date shows its start ("FRI 6 NOV" / "10:26"; the end is on the page), and a span with no room for its end piece drops it
 * whole and reads "10:26" (gridBlock.timeRow; DESIGN-grid-event-rows-fable.md call 4). Every clock on the tile is the
 * reader's own. When it differs from the place's (a Byron event read on a Gold Coast phone), the last row opens with
 * "🕒 your time" before the place (DESIGN-event-times §4: a member never reads the place's clock as their own).
 * "15:00–20:00 your time" cannot fit the time row at 320 dp and 1.3x (188 dp of text in 110, in Android's Roboto), nor can
 * "15:00 your time" (130). Online, row 2 is the bare span and no row says "your time": there is no second clock on the tile
 * to tell it from (call 3); the tile's label still says it. A group-only event's 🔒 pill is named with the whole sentence,
 * "🔒 Only {group} can see this", and so is the tile (call 1).
 *
 * The counts and "You're hosting this event" are on the event's page in the grid; the list card keeps them.
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { copyCardLine, copyFromLine, eventCopyOf, t, upperCase } from '@beanpool/core';
import { router } from 'expo-router';
import { MARKET_GRID_CROP, MarketCardPicture } from './MarketCardPicture';
import { CardChip, gridTextBlock, useCardShell } from './market-card-shell';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { isPostPinned } from '../utils/pins';
import {
    formatEventWhenFor, eventWhen, eventTileWhenFor, eventRepeatCaption, eventPlaceLine, isOnlineEvent, eventCardState, formatRsvpCounts,
    formatDistance, distanceKm, isOwnEvent, eventCoverPhoto, type EventRsvpStatus,
} from '../utils/events';

/** The event violet of the map's pin and the page's buttons (map.tsx, EventDetail, EventExtras); the card no longer draws it. */
export const EVENT_ACCENT = '#7c3aed';

/**
 * The Market's view decides the card's size: the list card, or in the grid a tile whose text block is the listing tiles' own,
 * built by the same function at the phone's font scale market.tsx reads (gridTextBlock(fontScale)), so the two cannot differ.
 * In the compact view (slice C1) the event is a compact row like a listing's, from the same box (shell.compactRow).
 */
interface EventCardBaseProps {
    post: any;
    currentPubkey?: string | null;
    myLocation?: { lat: number; lng: number } | null;
}

/** The list card, or the compact row: on the Market, or (the list card) as the map's pin card. */
interface EventCardListProps extends EventCardBaseProps {
    viewMode?: 'list' | 'compact';
    fontScale?: undefined;
    /**
     * The map's pin card (components/MapPreviewCard.tsx, slice M1): this same card, floating over the map with the ✕ the pop-up
     * draws over its top-right corner. Its press is the pop-up's (it closes as the event opens), it keeps the name the map's card
     * has always had ("Open event: {title}", map-preview-opens-render), and its chip row stops short of the ✕.
     */
    popUp?: { onOpen: () => void };
}

/** The grid's tile. Never the map's pin card: `popUp` is the list card's alone, so the two never meet. */
interface EventCardGridProps extends EventCardBaseProps {
    viewMode: 'grid';
    fontScale: number;
    popUp?: undefined;
}

type EventCardProps = EventCardListProps | EventCardGridProps;

const count = (n: unknown): number => Number(n ?? 0) || 0;

export function EventCard({ post, currentPubkey, myLocation, viewMode, fontScale, popUp }: EventCardProps) {
    const shell = useCardShell();
    const styles = useStyles(makeStyles);
    const gridBlock = useMemo(() => gridTextBlock(fontScale ?? 1), [fontScale]);

    // The place's clock first; the reader's own on a second line only when it differs; online, the reader's with "your time"
    // (DESIGN-event-times §4).
    const when = formatEventWhenFor(post);
    const timeNote = eventWhen(post)?.note ?? null;
    // A repeating event: still only its next date, and the rule under it (DESIGN-event-times §4, §8).
    const repeats = eventRepeatCaption(post);
    // CANCELLED, ENDED (over and not cancelled) or UPDATED: the web card's chip, on every size of this one.
    const badge = eventCardState(post);
    const distance = myLocation && post.lat != null && post.lng != null
        ? formatDistance(distanceKm(myLocation.lat, myLocation.lng, post.lat, post.lng))
        : null;
    const placeLine = eventPlaceLine(post, distance);
    const photo = eventCoverPhoto(post);
    // A member's copy, on the global community: where it is from, and nothing to answer here.
    const copy = eventCopyOf(post);
    // A group-only event says who can see it, read as the listing card beside it reads it (market.tsx).
    const groupOnly = post.audience_scope === 'group' || post.audienceScope === 'group' || !!post.target_group_id || !!post.targetGroupId;
    const groupName = post.target_group_name || post.targetGroupName || t('Group');

    // One status line. The member's own answer is the mark, the selected button's own words on the page ("Going ✓"); the host
    // reads that they are hosting; anyone else sees the counts once someone has answered, and nothing while nobody has
    // ("0 going · 0 interested" on eight cards reads as a dead community). "Your events" rows carry no counts: none shown.
    const mine = (post.myRsvp ?? null) as EventRsvpStatus | null;
    const going = count(post.goingCount ?? post.event_going_count);
    const interested = count(post.interestedCount ?? post.event_interested_count);
    const hosting = isOwnEvent(post, currentPubkey);
    const answer = copy ? null
        : mine === 'going' ? t('{label} ✓', { label: t('Going') })
        : mine === 'interested' ? t('{label} ✓', { label: t('Interested') })
        : null;
    const mark = hosting ? t("You're hosting this event") : answer;
    const counts = !mark && !copy && (going > 0 || interested > 0) ? formatRsvpCounts(going, interested) : null;

    // An ended event's name is the event's, then the chip's own word, each whole, as the tile's name lists its lock and mark.
    const endedWord = badge === 'ENDED' ? t('ENDED', undefined, 'event') : null;
    const stateLabel = (whenSaid: string) => {
        if (badge === 'CANCELLED') return t('Event: {title}, {when}, cancelled', { title: post.title, when: whenSaid });
        if (badge === 'UPDATED') return t('Event: {title}, {when}, updated', { title: post.title, when: whenSaid });
        const named = t('Event: {title}, {when}', { title: post.title, when: whenSaid });
        return [named, endedWord].filter(Boolean).join(', ');
    };
    const label = stateLabel(when);
    const pinned = isPostPinned(post);

    // A pin card (popUp) is always the list card, whatever else it is handed.
    if (viewMode === 'grid' && !popUp) {
        // The tile's mark is the member's own answer, on the photo where a listing's price sits; a host's line and the counts
        // are the page's (§2.2). The date and the time each take a row, each kept whole (core eventTileWhen).
        const tileMark = hosting ? null : answer;
        const tileWhen = eventTileWhenFor(post);
        // Row 2 in core's whole pieces ("10:26", "–14:26"): a row with no room for the end drops it whole (gridBlock.timeRow).
        // Online too, the bare span: every clock on the tile is the reader's own (DESIGN-grid-event-rows calls 3 and 4). A
        // repeating event with no readable time keeps its rule as one piece.
        const timePieces = tileWhen ? tileWhen.timePieces : repeats ? [`↻ ${repeats}`] : [];
        // The rows are the reader's own clock: the last row says so first, whole, and the place gives way after it.
        const yourTime = tileWhen?.yours ? t('{time} your time', { time: '🕒' }) : null;
        // A copy on global points at its community where the place would be, with the distance after it (call 2); with no
        // community to name (an unreadable copy), the place line.
        const place = copy?.from ? [copyFromLine(copy.from), distance].filter(Boolean).join(' · ')
            : placeLine ? `${isOnlineEvent(post) ? '💻' : '📍'} ${placeLine}` : '';
        // A group-only event: a 🔒 pill on the photo's foot (call 1), the whole sentence its name and the tile's.
        const lock = groupOnly ? t('🔒 Only {group} can see this', { group: groupName }) : null;
        // The label speaks the when the tile shows: the reader's own clock, with "your time", when the rows are theirs; online,
        // the card's line, which says "your time" though no row does.
        const spoken = tileWhen?.spoken ?? when;
        const tileLabel = stateLabel(spoken);
        return (
            <Pressable
                style={[shell.card, shell.gridTile]}
                onPress={() => router.push(`/post/${post.id}`)}
                accessibilityRole="button"
                accessibilityLabel={[tileLabel, lock, tileMark].filter(Boolean).join(', ')}
                testID={`event-card-${post.id}`}
            >
                <View style={shell.gridImageWrapper}>
                    <MarketCardPicture
                        postId={post.id}
                        cover={photo}
                        picture={photo}
                        kind="event"
                        size="grid"
                        contentPosition={MARKET_GRID_CROP}
                        accessibilityLabel={post.title}
                        imageStyle={shell.gridImage}
                    />
                    <View style={shell.gridBadgeRow} testID="grid-badge-row">
                        {pinned && <View style={shell.gridBadge} testID="pinned-chip"><Text style={shell.gridPinText}>{t('📌 PINNED')}</Text></View>}
                        {badge === 'CANCELLED' && <View style={shell.gridBadge} testID="event-state-chip"><Text style={shell.gridPinText}>{t('CANCELLED', undefined, 'event')}</Text></View>}
                        {badge === 'ENDED' && <View style={shell.gridBadge} testID="event-state-chip"><Text style={shell.gridPinText}>{t('ENDED', undefined, 'event')}</Text></View>}
                        {badge === 'UPDATED' && <View style={shell.gridBadge} testID="event-state-chip"><Text style={shell.gridPinText}>{t('UPDATED', undefined, 'event')}</Text></View>}
                        {!!lock && <View style={shell.gridBadge} testID="event-group-chip" accessibilityLabel={lock}><Text style={shell.gridPinText}>🔒</Text></View>}
                        {!!tileMark && (
                            <View style={[shell.gridBadge, shell.gridPriceEnd]} testID="event-mark">
                                <Text style={shell.gridPriceText} numberOfLines={1}>{tileMark}</Text>
                            </View>
                        )}
                    </View>
                    <View style={shell.gridTypeSlot}>
                        <CardChip shell={shell} role="event" label={upperCase(t('EVENT', undefined, 'event category tile label'))} testID="event-type-chip" />
                    </View>
                </View>
                <View style={gridBlock.block} testID="grid-text-block">
                    <View style={gridBlock.row}>
                        <Text testID="event-when" style={[shell.gridWhen, badge === 'CANCELLED' && styles.whenCancelled]} numberOfLines={1}>{tileWhen?.date ?? ''}</Text>
                    </View>
                    <View style={gridBlock.timeRow} testID="event-time-row">
                        {timePieces.map((piece, i) => (
                            <Text key={i} testID={i === 0 ? 'event-time' : 'event-time-end'} style={[shell.gridWhen, gridBlock.timePiece, badge === 'CANCELLED' && styles.whenCancelled]} numberOfLines={1}>{piece}</Text>
                        ))}
                    </View>
                    <View style={gridBlock.row}>
                        <Text style={shell.gridSecond} numberOfLines={1}>{post.title}</Text>
                    </View>
                    {yourTime ? (
                        // The label first and whole, its own line (one truncating line would put its "…" inside the label at
                        // 320 dp and 1.3x); the place after it gives way, as a listing's row 4 lays out its distance and chip.
                        <View style={gridBlock.lastRow} testID="grid-last-row">
                            <Text testID="event-your-time" style={[shell.gridLine, styles.yourTime]} numberOfLines={1}>{yourTime}</Text>
                            {!!place && <Text style={[shell.gridLine, gridBlock.lastRowPiece]} numberOfLines={1}>{place}</Text>}
                        </View>
                    ) : (
                        <View style={gridBlock.row} testID="grid-last-row">
                            {!!place && <Text style={shell.gridLine} numberOfLines={1}>{place}</Text>}
                        </View>
                    )}
                </View>
            </Pressable>
        );
    }

    if (viewMode === 'compact' && !popUp) {
        // The compact row (slice C1, DESIGN-market-event-cards-fable.md §2.4): the listing row's shell, its 32 dp picture and
        // its three lines at most, so the row is a listing's and one line more at 320 dp and 1.3x text (the Yoga test,
        // market-card-height-layout). Line 1 the title; line 2 the when in the reader's own clock ("your time" where it differs
        // from the place's, as the tile says it: core's event-when); line 3 📌 PINNED and the state (ENDED, UPDATED), the chip
        // row's own words in their chips' ink, then the place, which gives way. Your mark ("Going ✓", "You're hosting this event")
        // sits where a listing's price sits, above EVENT, as the tile puts it where a tile's price is: "{when} · {mark}" on one
        // line is ~250 dp at 1.3x in a 164 dp line, and on two the row was 100 dp against a listing's 69 (measured). The counts
        // are the page's.
        const tileWhen = eventTileWhenFor(post);
        const rowWhen = tileWhen?.spoken ?? when;
        const rowMark = hosting ? t("You're hosting this event") : answer;
        const lock = groupOnly ? t('🔒 Only {group} can see this', { group: groupName }) : null;
        const rowPlace = copy?.from ? [copyFromLine(copy.from), distance].filter(Boolean).join(' · ')
            : placeLine ? `${isOnlineEvent(post) ? '💻' : '📍'} ${placeLine}` : '';
        const stateWord = badge === 'CANCELLED' ? t('CANCELLED', undefined, 'event')
            : badge === 'ENDED' ? t('ENDED', undefined, 'event')
            : badge === 'UPDATED' ? t('UPDATED', undefined, 'event')
            : null;
        // The chip row's words, each whole and in its chip's ink, then ' · ' (the separator every line on the card uses).
        const pinWord = pinned ? t('📌 PINNED') : null;
        const lineThree = pinned || !!stateWord || !!rowPlace || !!lock;
        return (
            <Pressable
                style={shell.compactRow}
                onPress={() => router.push(`/post/${post.id}`)}
                accessibilityRole="button"
                accessibilityLabel={[stateLabel(rowWhen), lock, rowMark].filter(Boolean).join(', ')}
                testID={`event-card-${post.id}`}
            >
                <View style={shell.compactPicture} testID="compact-picture">
                    <MarketCardPicture
                        postId={post.id}
                        cover={photo}
                        picture={photo}
                        kind="event"
                        size="thumb"
                        accessibilityLabel={post.title}
                        imageStyle={shell.compactImage}
                    />
                </View>
                <View style={shell.compactText}>
                    <Text style={shell.compactTitle} numberOfLines={1}>{post.title}</Text>
                    <Text testID="event-when" style={[shell.compactLine, styles.compactWhen, badge === 'CANCELLED' && styles.whenCancelled]} numberOfLines={lineThree ? 1 : 2}>{rowWhen}</Text>
                    {lineThree && (
                        <Text style={shell.compactLine} numberOfLines={1} testID="event-row-place">
                            {!!pinWord && <Text testID="pinned-chip" style={shell.compactPinned}>{pinWord} · </Text>}
                            {!!stateWord && <Text testID="event-state-chip" style={badge === 'UPDATED' ? shell.compactMark : shell.compactDanger}>{stateWord} · </Text>}
                            {!!lock && '🔒 '}
                            {rowPlace}
                        </Text>
                    )}
                </View>
                <View style={shell.compactEnd}>
                    {!!rowMark && <Text testID="event-mark" style={[shell.compactLine, shell.compactMark, styles.compactEndMark]} numberOfLines={2}>{rowMark}</Text>}
                    <CardChip shell={shell} role="event" label={upperCase(t('EVENT', undefined, 'event category tile label'))} testID="event-type-chip" />
                </View>
            </Pressable>
        );
    }

    // The map's name for its card; an event with no title is "Event", as the map's card has always read it (eventPinCard).
    const named = popUp ? t('Open event: {title}', { title: post.title || t('Event') }) : label;

    return (
        <Pressable
            style={[shell.card, shell.list, popUp && shell.floating]}
            onPress={popUp ? popUp.onOpen : () => router.push(`/post/${post.id}`)}
            accessibilityRole="button"
            accessibilityLabel={mark ? `${named}, ${mark}` : named}
            testID={popUp ? 'map-preview-open' : `event-card-${post.id}`}
        >
            {/*
              * The host's photo in the list card's slot, exactly as the Offer card beside it draws its own (market.tsx list
              * view): 80 wide, flush under the left corners, the card's height. MarketCardPicture holds the slot with the
              * event tile until the photo has drawn, and steps down to it when the photo will not load: never an empty slot.
              * It has no press of its own, so it never becomes a second tap target.
              */}
            <MarketCardPicture
                postId={post.id}
                cover={photo}
                picture={photo}
                kind="event"
                size="thumb"
                accessibilityLabel={post.title}
                imageStyle={shell.listPhoto}
                tileBox={shell.listPhotoBox}
            />
            <View style={shell.listText}>
                <View style={[shell.chipRow, styles.chipRow, popUp && shell.clearOfClose]}>
                    <CardChip shell={shell} role="event" label={upperCase(t('EVENT', undefined, 'event category tile label'))} testID="event-type-chip" />
                    {pinned && <CardChip shell={shell} role="pinned" label={t('📌 PINNED')} testID="pinned-chip" />}
                    {badge === 'CANCELLED' && <CardChip shell={shell} role="danger" label={t('CANCELLED', undefined, 'event')} testID="event-state-chip" />}
                    {badge === 'ENDED' && <CardChip shell={shell} role="danger" label={t('ENDED', undefined, 'event')} testID="event-state-chip" />}
                    {badge === 'UPDATED' && <CardChip shell={shell} role="event" label={t('UPDATED', undefined, 'event')} testID="event-state-chip" />}
                    {groupOnly && <CardChip shell={shell} role="quiet" label={t('🔒 Only {group} can see this', { group: groupName })} testID="event-group-chip" wrap />}
                </View>
                <Text testID="event-when" style={[shell.loud, styles.when, badge === 'CANCELLED' && styles.whenCancelled]} numberOfLines={2}>{when}</Text>
                {!!timeNote && <Text style={styles.timeNote} numberOfLines={2}>{timeNote}</Text>}
                {!!repeats && <Text testID="event-repeat-caption" style={styles.repeats}>↻ {repeats}</Text>}
                <Text style={[shell.second, styles.line]} numberOfLines={2}>{post.title}</Text>
                {!!placeLine && <Text style={[shell.place, styles.line]} numberOfLines={1}>{isOnlineEvent(post) ? '💻' : '📍'} {placeLine}</Text>}
                {copy?.from && <Text style={[shell.place, styles.line]} numberOfLines={2} testID="event-copy-line">{copyCardLine(copy.from)}</Text>}
                {/* Two lines at most, never cut: beside the picture, at 320 dp and 1.3x text, "You're hosting this event" and
                    "4 going · 2 interested" each need a second line (market-order-320.mjs measures it). */}
                {!!mark && <Text testID="event-mark" style={shell.mark} numberOfLines={2}>{mark}</Text>}
                {!!counts && <Text testID="event-counts" style={shell.place} numberOfLines={2}>👥 {counts}</Text>}
            </View>
        </Pressable>
    );
}

const makeStyles = ({ colors }: ThemeContextType) =>
    StyleSheet.create({
        chipRow: { marginBottom: 4 },
        // The when is the card's loud line, in the event's ink (the EVENT chip's own), the date and time kept whole.
        when: { color: colors.tile.event.ink, marginBottom: 2 },
        whenCancelled: {
            textDecorationLine: 'line-through',
            color: colors.text.secondary,
        },
        timeNote: {
            fontSize: 13,
            color: colors.text.secondary,
            marginBottom: 2,
        },
        repeats: { fontSize: 13, fontWeight: '700', color: colors.accent.primary, marginBottom: 2 },
        // The grid tile's "🕒 your time": in the event's ink, with the date and the time it labels; never shrunk for the place,
        // and cut with "…" at the row's end only where a language's label is longer than the row.
        yourTime: { color: colors.tile.event.ink, fontWeight: '700', flexShrink: 0, maxWidth: '100%' },
        line: { marginBottom: 2 },
        // The compact row's when: the event's ink, the row's size, bold enough to be the row's loud line after the title.
        compactWhen: { color: colors.tile.event.ink, fontWeight: '700' },
        // The mark at the row's end: right-aligned, as a listing's price is.
        compactEndMark: { marginTop: 0, textAlign: 'right' },
    });
