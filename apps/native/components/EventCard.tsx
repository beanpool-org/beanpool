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
 * box: the 4:3 photo flush at the top, EVENT at its top-left, the foot row of pills (📌 PINNED, CANCELLED / UPDATED, and your
 * mark at the end, where a listing's price sits), then the four-row text block the listing tiles use, the very same one:
 *
 *   SAT 7 NOV                                         the date, in the event's ink
 *   16:00–21:00                                       the time (a repeating event with no time: its ↻ rule)
 *   Byron Bay Twilight Market                         the title, one line
 *   📍 Railway Park · 3 km                             the place, one line
 *
 * The counts and "You're hosting this event" are on the event's page in the grid; the list card keeps them.
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { copyCardLine, eventCopyOf, t, upperCase } from '@beanpool/core';
import { router } from 'expo-router';
import { MARKET_GRID_CROP, MarketCardPicture } from './MarketCardPicture';
import { CardChip, gridTextBlock, useCardShell } from './market-card-shell';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { isPostPinned } from '../utils/pins';
import {
    formatEventWhenFor, eventWhen, eventRepeatCaption, eventPlaceLine, isOnlineEvent, eventBadge, formatRsvpCounts,
    formatDistance, distanceKm, isOwnEvent, eventCoverPhoto, type EventRsvpStatus,
} from '../utils/events';

/** The event violet of the map's pin and the page's buttons (map.tsx, EventDetail, EventExtras); the card no longer draws it. */
export const EVENT_ACCENT = '#7c3aed';

/**
 * The Market's view decides the card's size: the list card, or in the grid a tile whose text block is the listing tiles' own,
 * built by the same function at the phone's font scale market.tsx reads (gridTextBlock(fontScale)), so the two cannot differ.
 * Compact is the list card until slice C1.
 */
type EventCardProps = {
    post: any;
    currentPubkey?: string | null;
    myLocation?: { lat: number; lng: number } | null;
} & ({ viewMode?: 'list' | 'compact'; fontScale?: undefined } | { viewMode: 'grid'; fontScale: number });

const count = (n: unknown): number => Number(n ?? 0) || 0;

export function EventCard({ post, currentPubkey, myLocation, viewMode, fontScale }: EventCardProps) {
    const shell = useCardShell();
    const styles = useStyles(makeStyles);
    const gridBlock = useMemo(() => gridTextBlock(fontScale ?? 1), [fontScale]);

    // The place's clock first; the reader's own on a second line only when it differs; online, the reader's with "your time"
    // (DESIGN-event-times §4).
    const when = formatEventWhenFor(post);
    const timeNote = eventWhen(post)?.note ?? null;
    // A repeating event: still only its next date, and the rule under it (DESIGN-event-times §4, §8).
    const repeats = eventRepeatCaption(post);
    const badge = eventBadge(post);
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

    const label = badge === 'CANCELLED' ? t('Event: {title}, {when}, cancelled', { title: post.title, when })
        : badge === 'UPDATED' ? t('Event: {title}, {when}, updated', { title: post.title, when })
        : t('Event: {title}, {when}', { title: post.title, when });
    const pinned = isPostPinned(post);

    if (viewMode === 'grid') {
        // The tile's mark is the member's own answer, on the photo where a listing's price sits; a host's line and the counts
        // are the page's (§2.2). The date and the time each take a row: the when's two pieces, kept whole.
        const tileMark = hosting ? null : answer;
        const parts = eventWhen(post);
        const time = parts?.second || (repeats ? `↻ ${repeats}` : '');
        return (
            <Pressable
                style={[shell.card, shell.gridTile]}
                onPress={() => router.push(`/post/${post.id}`)}
                accessibilityRole="button"
                accessibilityLabel={tileMark ? `${label}, ${tileMark}` : label}
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
                        {badge === 'UPDATED' && <View style={shell.gridBadge} testID="event-state-chip"><Text style={shell.gridPinText}>{t('UPDATED', undefined, 'event')}</Text></View>}
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
                        <Text testID="event-when" style={[shell.gridWhen, badge === 'CANCELLED' && styles.whenCancelled]} numberOfLines={1}>{parts?.first ?? ''}</Text>
                    </View>
                    <View style={gridBlock.row}>
                        <Text testID="event-time" style={[shell.gridWhen, badge === 'CANCELLED' && styles.whenCancelled]} numberOfLines={1}>{time}</Text>
                    </View>
                    <View style={gridBlock.row}>
                        <Text style={shell.gridSecond} numberOfLines={1}>{post.title}</Text>
                    </View>
                    <View style={gridBlock.row} testID="grid-last-row">
                        {!!placeLine && <Text style={shell.gridLine} numberOfLines={1}>{isOnlineEvent(post) ? '💻' : '📍'} {placeLine}</Text>}
                    </View>
                </View>
            </Pressable>
        );
    }

    return (
        <Pressable
            style={[shell.card, shell.list]}
            onPress={() => router.push(`/post/${post.id}`)}
            accessibilityRole="button"
            accessibilityLabel={mark ? `${label}, ${mark}` : label}
            testID={`event-card-${post.id}`}
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
                <View style={[shell.chipRow, styles.chipRow]}>
                    <CardChip shell={shell} role="event" label={upperCase(t('EVENT', undefined, 'event category tile label'))} testID="event-type-chip" />
                    {pinned && <CardChip shell={shell} role="pinned" label={t('📌 PINNED')} testID="pinned-chip" />}
                    {badge === 'CANCELLED' && <CardChip shell={shell} role="danger" label={t('CANCELLED', undefined, 'event')} testID="event-state-chip" />}
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
        line: { marginBottom: 2 },
    });
