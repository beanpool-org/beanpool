/**
 * PulseKnowledgeCard: Local knowledge's card on the Pulse (DESIGN-local-knowledge-amend-fable.md §2.12, §3.8; slice KP).
 *
 * The node works it out when the feed is read with `with=knowledge`: one card a day at most, for pages Learn shows that
 * first showed in the last 30 days. The Pulse list draws this for `source === 'knowledge'` before anything else; the
 * creator's card (PulseFeedCard) never sees one.
 *
 * Unlike a creator's card it is the community's own page, inside the app:
 * - Head: a 📖 tile, "New local knowledge" (one page) or "{n} new in Local knowledge" (several), and how long ago. No face, no
 *   name to tap, no profile. Right of the head, the topic chip on a single page; nothing else: no ⚑ and no Hide (there is no
 *   item to hide or report; a page is reported from inside it).
 * - Middle: no wide picture. One to three rows: the page's photo or its topic's picture (64 dp), title, first line; "by
 *   {name}" only on a single page a member wrote (the node sends the name only then).
 * - One page: the whole card opens that page. Several: the head opens Learn, each row opens its page, "and {n} more ›" opens
 *   Learn.
 * - Foot: "Open Learn ›". Nothing is fetched from outside BeanPool.
 * Words: @beanpool/core PULSE_KNOWLEDGE_WORDS, the same on the web. Colours: the central tokens (Learn's teal for the tile
 * and the chip), light and dark. At 320 dp with 1.3× text the head's words wrap beside the tile and the chip shows its
 * picture only, as the creator's card's category pill does.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { PULSE_KNOWLEDGE_WORDS as W, formatCount, formatDate, inCapitalsOf, t, tn, type PulseKnowledgePost } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { pulseAge, type PulseFeedItem } from '../utils/pulse';
import { ListPhoto } from './ListPhoto';
import { ChipText, TopicTile } from './learn/KnowledgeRowCard';
import { LEARN_LINES, topicOf } from './learn/learn-lines';

const TILE = 64;
const HEAD_TILE = 38;

/** When the day's newest page first showed, in the member's language, as the creator's card says it. */
function agoWords(iso: string | null | undefined): string {
    const age = pulseAge(iso);
    if (!age) return '';
    switch (age.unit) {
        case 'now': return t('Just now');
        case 'minutes': return t('{n}m ago', { n: age.n });
        case 'hours': return t('{n}h ago', { n: age.n });
        case 'days': return t('{n}d ago', { n: age.n });
        case 'date': return formatDate(age.date, 'day-month');
    }
}

/** A page opens in the app, as a Learn row does (app/learn.tsx). */
function openPage(id: string) {
    router.push({ pathname: '/post/[id]', params: { id, kind: 'knowledge' } });
}

function openLearn() {
    router.push('/learn');
}

export function PulseKnowledgeCard({ item }: { item: PulseFeedItem }) {
    const styles = useStyles(makeStyles);
    const { width, fontScale } = useWindowDimensions();
    const compact = width / fontScale < 360;
    const posts = item.knowledge?.posts ?? [];
    // A card with nothing to show is drawn as nothing: never the creator's card, never an empty box.
    if (posts.length === 0) return null;
    const count = Math.max(item.knowledge?.count ?? posts.length, posts.length);
    const single = count === 1;
    const ago = agoWords(item.publishedAt);
    const more = count - posts.length;

    const tile = (
        <View style={styles.headTile} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={styles.headTileText}>📖</Text>
        </View>
    );
    const headWords = (
        <View style={styles.headWords}>
            <Text style={styles.headTitle} numberOfLines={2}>
                {single ? t(W.head) : tn(count, W.headMany.one, W.headMany.other, { n: formatCount(count) })}
            </Text>
            {ago ? <Text style={styles.headTime} numberOfLines={1}>{ago}</Text> : null}
        </View>
    );
    const row = (post: PulseKnowledgePost) => (
        <View style={styles.row}>
            <View style={styles.picture}>
                <ListPhoto photo={post.photo} fallback={<TopicTile topic={post.topic} />} style={{ width: TILE, height: TILE }} contentFit="cover" />
            </View>
            <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={2}>{post.title}</Text>
                {post.line ? <Text style={styles.rowLine} numberOfLines={1}>{post.line}</Text> : null}
                {single && post.by ? <Text style={styles.rowBy} numberOfLines={1}>{t(W.by, { name: post.by })}</Text> : null}
            </View>
        </View>
    );
    const foot = (
        <Pressable
            onPress={openLearn}
            style={({ pressed }) => [styles.foot, pressed && styles.pressed]}
            accessibilityRole="link"
            accessibilityLabel={t(W.openLearnSpoken)}
            testID="pulse-knowledge-open-learn"
        >
            <Text style={styles.footText}>{t(W.openLearn)}</Text>
        </Pressable>
    );

    if (single) {
        const post = posts[0];
        const topic = topicOf(post.topic);
        return (
            <View style={styles.card} testID={`pulse-knowledge-${item.id}`}>
                <Pressable
                    onPress={() => openPage(post.id)}
                    style={({ pressed }) => [styles.body, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t(W.spokenOne, { title: post.title })}
                >
                    <View style={styles.head}>
                        {tile}
                        {headWords}
                        <View style={styles.chip} testID="pulse-knowledge-topic">
                            <ChipText bg="learn">{compact ? topic.emoji : t(LEARN_LINES.emojiTopic, { emoji: topic.emoji, topic: inCapitalsOf(t(topic.label)) })}</ChipText>
                        </View>
                    </View>
                    {row(post)}
                </Pressable>
                {foot}
            </View>
        );
    }

    return (
        <View style={styles.card} testID={`pulse-knowledge-${item.id}`}>
            <Pressable
                onPress={openLearn}
                style={({ pressed }) => [styles.head, styles.headAlone, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={tn(count, W.spokenMany.one, W.spokenMany.other, { n: formatCount(count) })}
            >
                {tile}
                {headWords}
            </Pressable>
            <View style={styles.rows}>
                {posts.map((post) => (
                    <Pressable
                        key={post.id}
                        onPress={() => openPage(post.id)}
                        style={({ pressed }) => [styles.rowPress, pressed && styles.pressed]}
                        accessibilityRole="button"
                        accessibilityLabel={t(W.rowSpoken, { title: post.title })}
                        testID={`pulse-knowledge-row-${post.id}`}
                    >
                        {row(post)}
                    </Pressable>
                ))}
                {more > 0 ? (
                    <Pressable
                        onPress={openLearn}
                        style={({ pressed }) => [styles.more, pressed && styles.pressed]}
                        accessibilityRole="link"
                        accessibilityLabel={tn(more, W.moreSpoken.one, W.moreSpoken.other, { n: formatCount(more) })}
                    >
                        <Text style={styles.moreText}>{tn(more, W.more.one, W.more.other, { n: formatCount(more) })}</Text>
                    </Pressable>
                ) : null}
            </View>
            {foot}
        </View>
    );
}

const makeStyles = ({ colors, theme }: { colors: any; theme: string }) =>
    StyleSheet.create({
        // The creator's card's frame (PulseFeedCard cardContainer), so one list reads as one kind of thing.
        card: {
            backgroundColor: colors.surface.card,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border.default,
            marginBottom: 16,
            overflow: 'hidden',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: theme === 'dark' ? 0.3 : 0.06,
            shadowRadius: 6,
            elevation: 2,
        },
        pressed: { backgroundColor: colors.surface.subtle },
        body: { paddingBottom: 4 },
        head: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 8,
        },
        headAlone: { minHeight: 44 },
        headTile: {
            width: HEAD_TILE,
            height: HEAD_TILE,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.chip.learn.bg,
            flexShrink: 0,
        },
        headTileText: { fontSize: 20 },
        headWords: { flex: 1, flexShrink: 1, minWidth: 0 },
        headTitle: { fontSize: 15, fontWeight: '700', color: colors.text.heading, flexShrink: 1 },
        headTime: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
        chip: { flexShrink: 0, maxWidth: '45%' },
        rows: { paddingBottom: 2 },
        rowPress: { minHeight: 44 },
        row: { flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 6 },
        picture: { width: TILE, height: TILE, borderRadius: 12, overflow: 'hidden', flexShrink: 0 },
        rowBody: { flex: 1, minWidth: 0, gap: 2, justifyContent: 'center' },
        rowTitle: { fontSize: 15, fontWeight: '700', lineHeight: 20, color: colors.text.heading },
        rowLine: { fontSize: 13.5, color: colors.text.body },
        rowBy: { fontSize: 12, color: colors.text.secondary },
        more: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14 },
        moreText: { fontSize: 13, fontWeight: '600', color: colors.text.link },
        foot: {
            minHeight: 44,
            justifyContent: 'center',
            paddingHorizontal: 14,
            borderTopWidth: 1,
            borderTopColor: colors.border.default,
        },
        footText: { fontSize: 13, fontWeight: '600', color: colors.text.link },
    });
