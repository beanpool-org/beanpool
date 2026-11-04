/**
 * The map's pin card (app/(tabs)/map.tsx): the Market's list card from the style box, floating over the map, with a ✕
 * (DESIGN-card-style-box-fable.md §2 "Map pop-up, phone", slice M1; Marty, 4 Nov 2026, on the map's event pop-up: "yes restyle -
 * look at the similar market place offer and map card offer").
 *
 * The same card as the Market's list view, not a look-alike: an event is EventCard itself (its `popUp` form), an Offer or a Need
 * is drawn from the same box (components/market-card-shell.ts) with the same parts as market.tsx's list card: the picture flush
 * in the 80 dp slot through MarketCardPicture (the category tile until the photo has drawn, never an empty box), the chip row
 * (OFFER / NEED, 👤 YOU, 📌 PINNED, the category, ↻ RECURRING, 💸 CASH TOO, the group's lock) with the price at its end, the title,
 * the who-line (PostAuthorTrust, display only) or a copy's community line. It takes its own height from its lines.
 *
 * No button on it besides the ✕: the whole card is one press that opens the item (Marty, 4 Nov: "click anywhere on the card and
 * have the card come up", #2839), so the old "View event" / "View Details" buttons are gone. No count of nobody: an event's
 * counts show only once someone has answered (EventCard).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t, type EventCopy } from '@beanpool/core';
import { EventCard } from './EventCard';
import { MarketCardPicture } from './MarketCardPicture';
import { CardChip, useCardShell } from './market-card-shell';
import { PostAuthorTrust, isElder } from './PostAuthorTrust';
import { ListingCopyLine } from './ListingCopyLine';
import { CurrencyDisplay } from './CurrencyDisplay';
import { categoryEmoji, categoryLabel } from '../constants/categories';
import { marketCardPicture } from '../utils/market-card-picture';
import { isPostPinned } from '../utils/pins';
import { useIdentity } from '../app/IdentityContext';

interface MapPreviewCardProps {
    post: any;
    /** A member's copy from another community (eventCopyOf, as the map reads it): its line stands where the author's would. */
    copy: EventCopy | null;
    /** Where the community has Beans off (the global one), no amount and no tier. */
    showsBeans: boolean;
    /** The card's one press: the map closes its pop-up and opens the item. */
    onOpen: () => void;
    onClose: () => void;
}

export function MapPreviewCard({ post, copy, showsBeans, onOpen, onClose }: MapPreviewCardProps) {
    const shell = useCardShell();
    // Whose phone this is: the 👤 YOU chip on a listing, "You're hosting this event" on an event, as on the Market's cards.
    const me = useIdentity()?.identity?.publicKey ?? null;
    return (
        <View testID="map-preview-card">
            {post.type === 'event'
                ? <EventCard post={post} currentPubkey={me} popUp={{ onOpen }} />
                : <ListingPinCard post={post} copy={copy} showsBeans={showsBeans} me={me} onOpen={onOpen} />}
            {/* The one other control: a sibling of the card, so a press on it never opens the item and a screen reader meets it
                on its own. Lifted above the card's elevation, or Android draws the card over it (shell.close). */}
            <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} style={shell.close} onPress={onClose} hitSlop={15} testID="map-preview-close">
                <View style={shell.closeDot} testID="map-preview-close-dot">
                    <Text style={shell.closeText}>✕</Text>
                </View>
            </Pressable>
        </View>
    );
}

/** The unit after a listing's price, as the Market's list card writes it (market.tsx `priceUnit`): per hour, day, week or month. */
function priceUnit(priceType: string | null | undefined): string {
    if (priceType === 'hourly') return t('/Hr', undefined, 'price per hour');
    if (priceType === 'daily') return t('/Dy', undefined, 'price per day');
    if (priceType === 'weekly') return t('/Wk', undefined, 'price per week');
    if (priceType === 'monthly') return t('/Mo', undefined, 'price per month');
    return '';
}

function ListingPinCard({ post, copy, showsBeans, me, onOpen }: {
    post: any; copy: EventCopy | null; showsBeans: boolean; me: string | null; onOpen: () => void;
}) {
    const shell = useCardShell();
    // Its own first photo, else its enterprise's shop banner, else the CategoryTile (utils/market-card-picture.ts).
    const { cover, picture } = marketCardPicture(post);
    const author = post.author_callsign || post.author_pubkey?.slice(0, 6) || t('Unknown');
    // Elder is a tier, and a tier is Beans: no Elder look where the community shows none (as the Market's card).
    const elder = showsBeans && isElder(post.author_energy_cycled);
    const own = !!(me && post.author_pubkey === me);
    const groupOnly = post.audience_scope === 'group' || post.audienceScope === 'group' || !!post.target_group_id || !!post.targetGroupId;
    const groupName = post.target_group_name || post.targetGroupName || t('Group');
    const credits = post.credits !== undefined && post.credits !== null ? post.credits : '?';

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('Open listing: {title}', { title: post.title })}
            testID="map-preview-open"
            onPress={onOpen}
            style={[shell.card, shell.list, shell.floating, elder && shell.elder]}
        >
            <MarketCardPicture
                postId={post.id}
                cover={cover}
                picture={picture}
                category={post.category}
                kind="listing"
                size="thumb"
                imageStyle={shell.listPhoto}
                tileBox={shell.listPhotoBox}
            />
            <View style={shell.listText}>
                <View style={[styles.head, shell.clearOfClose]}>
                    <View style={[shell.chipRow, styles.chips]}>
                        <CardChip shell={shell} role={post.type === 'offer' ? 'offer' : 'need'} label={post.type === 'offer' ? t('OFFER') : t('NEED')} testID="map-preview-type-chip" />
                        {own && <CardChip shell={shell} role="info" label={t('👤 YOU')} />}
                        {isPostPinned(post, Date.now()) && <CardChip shell={shell} role="pinned" label={t('📌 PINNED')} testID="pinned-chip" />}
                        <CardChip shell={shell} role="quiet" label={categoryEmoji(post.category) + ' ' + categoryLabel(post.category)} testID="map-preview-category-chip" />
                        {!!post.repeatable && <CardChip shell={shell} role="quiet" label={t('↻ RECURRING')} />}
                        {post.cash_also_needed === 1 && <CardChip shell={shell} role="warn" label={t('💸 CASH TOO')} />}
                        {groupOnly && <CardChip shell={shell} role="quiet" label={t('🔒 Only {group} can see this', { group: groupName })} wrap />}
                    </View>
                    {showsBeans && !copy && (
                        <CurrencyDisplay amount={`${credits}${priceUnit(post.price_type)}`} style={shell.price} asView={true} />
                    )}
                </View>
                <Text style={[shell.loud, styles.title]} numberOfLines={1}>{post.title}</Text>
                {copy ? (
                    <View testID="map-preview-copy-line"><ListingCopyLine copy={copy} /></View>
                ) : (
                    <View testID="map-preview-author">
                        <PostAuthorTrust pubkey={post.author_pubkey} callsign={author} energyCycled={post.author_energy_cycled} avatarUrl={post.author_avatar} mode="full" isFounding={showsBeans && post.authorFoundingNeeded} showTier={showsBeans} navigable={false} />
                    </View>
                )}
            </View>
        </Pressable>
    );
}

// Layout only: every size, colour and corner is the box's.
const styles = StyleSheet.create({
    head: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
    chips: { flex: 1 },
    title: { marginBottom: 4 },
});
