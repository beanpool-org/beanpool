/**
 * What a forum topic links, on the phone (slice F9 part 3; DESIGN-forums-fable.md §10.2, §10.4, §14; the node's side is #3237,
 * apps/server/src/engine/forum-links.ts):
 *
 * - **ForumLinkChips**, under a topic's opening words: a shown link is a chip that opens the thing (a group's page, a listing's or
 *   an event's, a Learn page), its kind on the first line ("Posted as a Need ›" for a Need the topic's writer made) and its title
 *   under it; a link this member can't see is the sketch's "Linked: a group", its kind alone, nothing to tap.
 * - **ForumLinkPicker**, from the topic's ⋯ (its writer only): what to link (one of your groups, one of your listings, an event),
 *   then the member's own of that kind. One already linked says so, and a tap takes it off. The node decides: it refuses what the
 *   member may not link, and past three a topic, in its own words.
 * - **ForumLinkedTopics**, the topics that link one thing (GET /api/forum/linked): "Talked about in the forum" on a listing,
 *   "Topics about this group" in a group's sheet, "From the forum" on a Learn page. Nothing at all when there are none, when the
 *   member can't see the thing, or with no answer (a community with no forum, or a node from before F9): never an empty heading.
 *
 * The node's calls and the member's lists are read when first needed (import()), as utils/worldwide-forum.ts does: the listing,
 * Learn and group screens that draw these rows load nothing more as they open.
 *
 * **The invariant: a link never shows its reader anything they could not already see.** The phone draws exactly the node's answer
 * for this member: a title only on a shown link, a placeholder by its kind alone, never a title kept, picked or made up for one.
 * After a pick the topic is read again from the node; the picker's own title is never drawn as a chip.
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { t, tn, type ForumLink, type ForumLinkKind } from '@beanpool/core';
import { useForumStyles } from './forum-style';
import { FORUM_WORDS, LINK_WORDS, TOPIC_WORDS } from './forum-words';
import type { ForumLinkedTopic } from '../../utils/forum';

type Shown = Extract<ForumLink, { shown: true }>;
/** What the picker offers: the design's three (§10.4). A Learn page is linked by "Turn into a Learn page" (§10.3), later. */
export type PickKind = 'group' | 'listing' | 'event';
export interface LinkCandidate { id: string; title: string }

/** Where a shown link opens: a group's page (it says what this member may do there), a listing's or event's, a Learn page. */
export function forumLinkHref(link: Shown): { pathname: string; params: Record<string, string> } {
    if (link.kind === 'group') return { pathname: '/group/[id]', params: { id: link.id } };
    if (link.kind === 'learn') return { pathname: '/post/[id]', params: { id: link.id, kind: 'knowledge' } };
    return { pathname: '/post/[id]', params: { id: link.id } };
}

/** The first line of a shown link's chip: its kind, or "Posted as a Need ›" for a Need the topic's writer made (§10.2). */
export function forumLinkKindLine(link: Shown): string {
    if (link.kind === 'listing') {
        if (link.listingType === 'need') return link.byWriter ? t(LINK_WORDS.postedAsNeed) : t(LINK_WORDS.aNeed);
        return t(LINK_WORDS.anOffer);
    }
    if (link.kind === 'group') return t(LINK_WORDS.aGroup);
    if (link.kind === 'event') return t(LINK_WORDS.anEvent);
    return t(LINK_WORDS.aLearnPage);
}

/** A link this member can't see: its kind alone (#3237's placeholder holds nothing else, and nothing else is drawn). */
export const forumLinkHiddenLine = (kind: ForumLinkKind): string => t(LINK_WORDS.hidden[kind]);

/** The member's own things of one kind that the picker lists: their groups, their open listings, the events they are going to. */
export async function linkCandidates(kind: PickKind, me: string): Promise<LinkCandidate[]> {
    const { fetchMyEvents, fetchYourGroups, getMyPosts } = await import('../../utils/db');
    if (kind === 'group') return (await fetchYourGroups()).items.filter((g) => g.kind === 'group').map((g) => ({ id: g.id, title: g.name }));
    if (kind === 'listing') {
        return ((await getMyPosts(me)) as { id: string; title: string; type: string; status: string }[])
            .filter((p) => (p.type === 'offer' || p.type === 'need') && ['active', 'paused', 'pending'].includes(p.status))
            .map((p) => ({ id: p.id, title: p.title }));
    }
    return (await fetchMyEvents()).map((e) => ({ id: e.postId, title: e.title }));
}

export function ForumLinkChips({ links }: { links: ForumLink[] | undefined }) {
    const styles = useForumStyles();
    if (!links?.length) return null;
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }} testID="forum-link-chips">
            {links.map((link, i) => (link.shown
                ? (
                    <Pressable key={`${link.kind}:${link.id}`} accessibilityRole="button" testID={`forum-link-${link.kind}`} onPress={() => router.push(forumLinkHref(link) as never)}
                        style={styles.linkChip}>
                        <Text style={styles.small}>{forumLinkKindLine(link)}</Text>
                        <Text style={styles.rowTitle}>{link.title}</Text>
                    </Pressable>
                )
                : (
                    <View key={`hidden:${link.kind}:${i}`} testID={`forum-link-hidden-${link.kind}`} style={styles.linkHidden}>
                        <Text style={styles.italic}>{forumLinkHiddenLine(link.kind)}</Text>
                    </View>
                )))}
        </View>
    );
}

/**
 * The Link picker: `kind` null asks what to link; a kind lists the member's own of that kind (`linked`: the ids this topic
 * already links, which a tap takes off). `onPick` links or unlinks and closes it; the screen reads the topic again.
 */
export function ForumLinkPicker({ open, me, linked, onPick, onClose }: {
    open: boolean; me: string | null; linked: string[]; onPick: (kind: PickKind, id: string, on: boolean) => void; onClose: () => void;
}) {
    const styles = useForumStyles();
    const [kind, setKind] = useState<PickKind | null>(null);
    const [items, setItems] = useState<LinkCandidate[] | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => { if (!open) { setKind(null); setItems(null); setFailed(false); } }, [open]);
    useEffect(() => {
        if (!kind || !me) return undefined;
        let shown = true;
        setItems(null);
        setFailed(false);
        linkCandidates(kind, me).then((c) => { if (shown) setItems(c); }, () => { if (shown) setFailed(true); });
        return () => { shown = false; };
    }, [kind, me]);
    const item = (words: string, onPress: () => void, testID?: string, label?: string) => (
        <Pressable key={testID ?? words} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.menuItem} testID={testID}>
            <Text style={styles.menuText}>{words}</Text>
        </Pressable>
    );
    return (
        <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t(LINK_WORDS.pickKind)}>
                <Pressable style={[styles.sheet, { maxHeight: '85%' }]} onPress={() => {}} testID="forum-link-picker">
                    <ScrollView>
                        <Text style={[styles.label, { paddingHorizontal: 16, paddingVertical: 12 }]} accessibilityRole="header">
                            {kind === 'group' ? t(LINK_WORDS.groups) : kind === 'listing' ? t(LINK_WORDS.listings) : kind === 'event' ? t(LINK_WORDS.events) : t(LINK_WORDS.pickKind)}
                        </Text>
                        {!kind && (['group', 'listing', 'event'] as const).map((k) =>
                            item(k === 'group' ? t(LINK_WORDS.groups) : k === 'listing' ? t(LINK_WORDS.listings) : t(LINK_WORDS.events), () => setKind(k), `forum-link-kind-${k}`))}
                        {kind && failed && <Text style={[styles.small, { paddingHorizontal: 16, paddingVertical: 12 }]}>{t(LINK_WORDS.failed)}</Text>}
                        {kind && items?.length === 0 && <Text style={[styles.small, { paddingHorizontal: 16, paddingVertical: 12 }]}>{t(LINK_WORDS.none)}</Text>}
                        {kind && items?.map((c) => {
                            const on = linked.includes(c.id);
                            return item(on ? `✓ ${c.title}` : c.title, () => onPick(kind, c.id, !on), `forum-link-pick-${c.id}`, on ? t(LINK_WORDS.linked, { title: c.title }) : undefined);
                        })}
                        {kind ? item(t(LINK_WORDS.back), () => setKind(null), 'forum-link-back') : null}
                        {item(t(TOPIC_WORDS.cancel), onClose, 'forum-link-cancel')}
                    </ScrollView>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

/**
 * The topics this member may read that link one thing, under the heading for where it shows; nothing when there are none.
 * `onLeave`: before a topic opens (a sheet closes itself, so the topic isn't drawn under it).
 */
export function ForumLinkedTopics({ kind, id, onLeave }: { kind: 'listing' | 'group' | 'learn'; id: string | null | undefined; onLeave?: () => void }) {
    const styles = useForumStyles();
    const [topics, setTopics] = useState<ForumLinkedTopic[]>([]);
    useEffect(() => {
        setTopics([]);
        if (!id) return undefined;
        let shown = true;
        void (async () => {
            try {
                const list = await (await import('../../utils/forum')).forumTopicsLinking(kind, id);
                if (shown) setTopics(Array.isArray(list) ? list : []);
            } catch { /* no answer: nothing drawn */ }
        })();
        return () => { shown = false; };
    }, [kind, id]);
    if (!topics.length) return null;
    return (
        <View style={{ marginTop: 12 }} testID={`forum-linked-${kind}`}>
            <Text style={styles.label} accessibilityRole="header">{t(LINK_WORDS.about[kind])}</Text>
            {topics.map((topic) => (
                <Pressable key={topic.id} accessibilityRole="button" testID="forum-linked-topic" onPress={() => { onLeave?.(); router.push({ pathname: '/forum/[id]', params: { id: topic.id } } as never); }}
                    style={[styles.row, { alignItems: 'center' }]}>
                    <View style={styles.rowWords}>
                        <Text style={styles.rowTitle}>{topic.title}</Text>
                        <Text style={styles.muted}>{tn(topic.replyCount, FORUM_WORDS.replies.one, FORUM_WORDS.replies.other, { n: topic.replyCount })}</Text>
                    </View>
                    <Text style={styles.muted}>›</Text>
                </Pressable>
            ))}
        </View>
    );
}
