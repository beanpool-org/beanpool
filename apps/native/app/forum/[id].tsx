/**
 * One topic on the phone (slice F3; DESIGN-forums-fable.md §2, §6, §9, §14 "A topic"), as the web's
 * components/forum/ForumTopicView.tsx: its title and opening words, then the replies in time order, full-width rows with a name
 * on top (bubbles waste a 320 dp screen on long writing), the member's own faintly tinted and still on the left. Each post's ⋯
 * holds Reply (a quote of it) · Copy · Report · Block · Remove, each only where it applies. The topic's bell follows or leaves
 * it; its ⋯ mutes it or closes it. The reply box is the chat's own (components/chat/ChatComposer.tsx), with a quoted reply
 * above it. Opening the topic marks it read up to the last post drawn (POST /read, slice F5).
 *
 * - **The reader's range.** A topic is read 30 posts at a time. Every read again (opening it, a reply sent, a ⋯ action) reads
 *   through the last post the member had drawn, never only the first 30, and after Send on through their own reply.
 * - **Kept copy.** The last read draws at once (utils/forum-kept.ts); with no connection it is what shows.
 * - **Gone.** When the node says the topic isn't there for this member any more (`not_found`), the kept copy is dropped and the
 *   member is back on the list with one line saying so.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { FORUM_LIMITS, currentLanguage, forumSectionName, t, timeAgo } from '@beanpool/core';
import { useStyles, useTheme } from '../ThemeContext';
import { Alert } from '../../utils/keyboard-alert';
import { blockUser } from '../../utils/blocklist';
import { loadIdentity } from '../../utils/identity';
import { REPORT_SENT_TEXT } from '../../utils/reportReasons';
import {
    closeForumTopic, followForumTopic, forgetForumTopic, getForumTopic, keptForumFront, keptForumTopic, markForumTold, noteForumBack,
    readForumTopic, removeForumPost, replyInForum, reportForumPost, type ForumFront, type ForumPost, type ForumTopicPage,
} from '../../utils/forum';
import { ChatComposer, type ChatComposerHandle } from '../../components/chat/ChatComposer';
import { makeChatStyles } from '../../components/chat/styles';
import { ReportMessageSheet } from '../../components/ReportMessageSheet';
import { ForumMenu, ForumPhotos, ForumWords, askForumTold, useForumStyles, type ForumMenuItem } from '../../components/forum/ForumBits';
import { TOPIC_WORDS } from '../../components/forum/forum-words';

type Menu = { kind: 'post'; post: ForumPost; confirm?: 'block' | 'remove' } | { kind: 'topic' } | null;

/** The number of the last post a read drew (0: none). */
const lastOf = (p: ForumTopicPage | null) => (p?.posts.length ? p.posts[p.posts.length - 1].number : 0);

export default function ForumTopicScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const topicId = String(id);
    const styles = useForumStyles();
    const chatStyles = useStyles(makeChatStyles);
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [me, setMe] = useState<string | null>(null);
    const [front, setFront] = useState<ForumFront | null>(null);
    const [page, setPage] = useState<ForumTopicPage | null>(null);
    const [failed, setFailed] = useState(false);
    const [menu, setMenu] = useState<Menu>(null);
    const [reporting, setReporting] = useState<ForumPost | null>(null);
    const [quote, setQuote] = useState<ForumPost | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const composer = useRef<ChatComposerHandle>(null);
    const pageRef = useRef(page);
    useEffect(() => { pageRef.current = page; }, [page]);
    // Whether this topic is still the one on screen: an answer that lands after the member left it changes nothing.
    const shown = useRef(true);

    /** Reads the posts after number `from` afresh, on through post `upTo` (or the topic's end), 30 a read. */
    const readThrough = useCallback(async (from: number, upTo: number, goneWords?: string) => {
        try {
            let p = await getForumTopic(topicId, from);
            while (p.next != null && p.next > from && lastOf(p) < upTo) {
                from = p.next;
                p = await getForumTopic(topicId, from);
            }
            if (!shown.current) return;
            setPage(p);
            setFailed(false);
            const last = lastOf(p);
            if (last > p.lastRead) void readForumTopic(topicId, last).catch(() => { /* the next open marks it */ });
        } catch (e) {
            const err = e as Error & { status?: number; code?: string };
            // Not there for this member any more: never the old copy left on screen with nothing said.
            if (err?.status === 404 && err.code === 'not_found') {
                await forgetForumTopic(topicId);
                if (shown.current) { noteForumBack({ kind: 'gone', words: goneWords ?? err.message }); router.back(); }
            } else if (shown.current) {
                setFailed(true);
            }
        }
    }, [topicId]);

    useEffect(() => {
        shown.current = true;
        void loadIdentity().then((i) => setMe(i?.publicKey ?? null));
        void keptForumFront().then(setFront);
        void keptForumTopic(topicId).then((kept) => {
            if (kept && shown.current) setPage((now) => now ?? kept);
            void readThrough(0, lastOf(kept));
        });
        return () => { shown.current = false; };
    }, [topicId, readThrough]);

    const topic = page?.topic;
    const opening = page?.posts.find((p) => p.number === 1) ?? null;
    const replies = page?.posts.filter((p) => p.number > 1) ?? [];
    const section = front?.sections.find((s) => s.id === topic?.sectionId);
    const open = !!topic && !topic.closed;
    const name = (p: { writer: { name: string } }) => p.writer.name || t(TOPIC_WORDS.member);

    /** The box's words, sent (the box is already empty: a refusal puts them back). `told`: they just agreed to the sheet. */
    async function send(words: string, told = false) {
        if (!topic || !words) return;
        if (front?.public && !front.told && !told) {
            composer.current?.setText(words);
            if (!(await askForumTold())) return;
            try {
                await markForumTold();
            } catch (e) {
                setError((e as Error)?.message || t(TOPIC_WORDS.saveFailed));
                return;
            }
            setFront((f) => (f ? { ...f, told: true } : f));
            composer.current?.reset();
            return send(words, true);
        }
        setBusy(true);
        setError(null);
        let mine: ForumPost;
        try {
            mine = await replyInForum(topic.id, { words, quotes: quote?.number ?? null, lang: currentLanguage() });
        } catch (e) {
            composer.current?.setText(words);
            setError((e as Error)?.message || t(TOPIC_WORDS.saveFailed));
            setBusy(false);
            return;
        }
        setQuote(null);
        // On from the last post drawn, through their own reply: it shows where it went, and nothing read is lost.
        await readThrough(lastOf(pageRef.current), mine.number);
        setBusy(false);
    }

    /** One of the member's own ⋯ actions, then every post they had drawn read again. `goneWords`: if it takes the topic away. */
    async function act(fn: () => Promise<unknown>, goneWords?: string) {
        setMenu(null);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError((e as Error)?.message || t(TOPIC_WORDS.saveFailed));
            return;
        }
        await readThrough(0, lastOf(pageRef.current), goneWords);
    }

    const quoted = (n: number | null) => (n ? page?.posts.find((p) => p.number === n) ?? null : null);

    function postBody(post: ForumPost) {
        if (post.removed) return <Text style={styles.italic}>{post.removed === 'moderator' ? t(TOPIC_WORDS.removedByModerator) : t(TOPIC_WORDS.removedByWriter)}</Text>;
        if (post.hidden && !post.words) return <Text style={styles.italic}>{t(TOPIC_WORDS.hidden)}</Text>;
        return (
            <>
                {post.hidden && <Text style={[styles.small, { color: colors.feedback.warning.fg, fontWeight: '700' }]}>{t(TOPIC_WORDS.hidden)}</Text>}
                <ForumWords words={post.words} linksOn={post.linksOn} styles={styles} testID={`forum-words-${post.number}`} />
                <ForumPhotos id={post.id} count={post.photos} styles={styles} />
            </>
        );
    }

    function byline(post: ForumPost) {
        const when = timeAgo(Math.max(0, Date.now() - Date.parse(post.createdAt)));
        return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: post.writer.publicKey, callsign: post.writer.name } })}
                    style={{ minHeight: 48, justifyContent: 'center', flexShrink: 1 }}>
                    <Text style={[styles.small, { fontWeight: '800', color: colors.text.heading }]}>{name(post)}</Text>
                </Pressable>
                <Text style={[styles.muted, { flex: 1 }]}>{['', when, post.editedAt ? t(TOPIC_WORDS.edited) : ''].filter((x, i) => i === 0 || x).join(' · ')}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t(TOPIC_WORDS.postMenu)} testID={`forum-post-menu-${post.number}`} onPress={() => setMenu({ kind: 'post', post })} style={styles.iconBtn}>
                    <MaterialCommunityIcons name="dots-horizontal" size={22} color={colors.text.muted} />
                </Pressable>
            </View>
        );
    }

    /** What the open menu offers, each [label, action, danger] (no action: a sentence), only where it applies here. */
    function menuItems(m: NonNullable<Menu>): ForumMenuItem[] {
        if (m.kind === 'topic') {
            if (!topic) return [];
            const items: ForumMenuItem[] = [[
                topic.follow === 'muted' ? t(TOPIC_WORDS.unmute) : t(TOPIC_WORDS.mute),
                () => void act(() => followForumTopic(topic.id, topic.follow === 'muted' ? null : 'muted')),
            ]];
            if (open && (topic.writer.publicKey === me || front?.moderator)) items.push([t(TOPIC_WORDS.close), () => void act(() => closeForumTopic(topic.id))]);
            items.push([t(TOPIC_WORDS.cancel), () => setMenu(null)]);
            return items;
        }
        const post = m.post;
        const mine = post.writer.publicKey === me;
        if (m.confirm === 'block') {
            return [
                [t(TOPIC_WORDS.blockSure, { name: name(post) }), null],
                // Blocking the topic's own writer takes their topic away for this member: the list says why.
                [t(TOPIC_WORDS.block, { name: name(post) }), () => void act(() => blockUser(post.writer.publicKey), t(TOPIC_WORDS.goneBlocked, { name: name(post) })), true],
                [t(TOPIC_WORDS.cancel), () => setMenu(null)],
            ];
        }
        if (m.confirm === 'remove') {
            return [
                [t(TOPIC_WORDS.removeSure), null],
                [t(TOPIC_WORDS.remove), () => void act(() => removeForumPost(post.id)), true],
                [t(TOPIC_WORDS.cancel), () => setMenu(null)],
            ];
        }
        const items: ForumMenuItem[] = [];
        if (open && !post.removed && post.words) items.push([t(TOPIC_WORDS.reply), () => { setQuote(post); setMenu(null); composer.current?.focus(); }]);
        if (post.words) items.push([t(TOPIC_WORDS.copy), () => { void Clipboard.setStringAsync(post.words).catch(() => {}); setMenu(null); }]);
        if (!mine && !post.removed) items.push([t(TOPIC_WORDS.report), () => { setReporting(post); setMenu(null); }]);
        if (!mine) items.push([t(TOPIC_WORDS.block, { name: name(post) }), () => setMenu({ ...m, confirm: 'block' }), true]);
        if (mine && !post.removed) items.push([t(TOPIC_WORDS.remove), () => setMenu({ ...m, confirm: 'remove' }), true]);
        items.push([t(TOPIC_WORDS.cancel), () => setMenu(null)]);
        return items;
    }

    const following = topic?.follow === 'following';
    return (
        <SafeAreaView style={styles.page} edges={['top']} testID="forum-topic">
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <View style={styles.head}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t(TOPIC_WORDS.back)} testID="forum-back" onPress={() => router.back()} style={styles.iconBtn}>
                        <MaterialCommunityIcons name="chevron-left" size={28} color={colors.text.body} />
                    </Pressable>
                    <Text style={styles.headWords} numberOfLines={2}>{section ? forumSectionName(section) : ''}</Text>
                    {topic && (
                        <Pressable accessibilityRole="button" testID="forum-follow" accessibilityState={{ selected: following }}
                            accessibilityLabel={following ? t(TOPIC_WORDS.following) : t(TOPIC_WORDS.follow)}
                            onPress={() => void act(() => followForumTopic(topic.id, following ? null : 'following'))} style={styles.iconBtn}>
                            <MaterialCommunityIcons name={topic.follow === 'muted' ? 'bell-off-outline' : following ? 'bell' : 'bell-outline'} size={22} color={following ? colors.accent.primary : colors.text.muted} />
                        </Pressable>
                    )}
                    {topic && (
                        <Pressable accessibilityRole="button" accessibilityLabel={t(TOPIC_WORDS.topicMenu)} testID="forum-topic-menu" onPress={() => setMenu({ kind: 'topic' })} style={styles.iconBtn}>
                            <MaterialCommunityIcons name="dots-vertical" size={22} color={colors.text.muted} />
                        </Pressable>
                    )}
                </View>
                <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.pad, { paddingTop: 10 }]} keyboardShouldPersistTaps="handled">
                    {failed && !page && (
                        <View style={{ gap: 8, alignItems: 'flex-start' }}>
                            <Text style={styles.small}>{t(TOPIC_WORDS.failed)}</Text>
                            <Pressable accessibilityRole="button" onPress={() => void readThrough(0, 0)} style={styles.quiet}><Text style={styles.quietText}>{t(TOPIC_WORDS.again)}</Text></Pressable>
                        </View>
                    )}
                    {topic && (
                        <View style={{ gap: 2 }}>
                            <Text style={styles.title} accessibilityRole="header" testID="forum-topic-title">{`${topic.pinned ? '📌 ' : ''}${topic.removed ? t(TOPIC_WORDS.removedTopic) : topic.title}`}</Text>
                            {topic.place ? <Text style={styles.muted}>📍 {topic.place}</Text> : null}
                            {opening && byline(opening)}
                            {opening && postBody(opening)}
                        </View>
                    )}
                    {replies.map((post) => {
                        const q = quoted(post.quotes);
                        return (
                            <View key={post.id} testID={`forum-post-${post.number}`} style={[styles.row, { flexDirection: 'column', alignItems: 'stretch', gap: 2, paddingHorizontal: 8, borderRadius: 8 }, post.writer.publicKey === me && styles.mine]}>
                                {byline(post)}
                                {q && (
                                    <Text style={[styles.small, styles.quote]} numberOfLines={2}>
                                        {t(TOPIC_WORDS.quoteLine, { name: name(q), words: q.words || (q.removed ? t(TOPIC_WORDS.removedByWriter) : t(TOPIC_WORDS.hidden)) })}
                                    </Text>
                                )}
                                {postBody(post)}
                            </View>
                        );
                    })}
                    {page?.next != null && (
                        <Pressable accessibilityRole="button" onPress={() => void readThrough(page.next!, 0)} style={styles.quiet}><Text style={styles.quietText}>{t(TOPIC_WORDS.moreReplies)}</Text></Pressable>
                    )}
                    {error && <Text style={styles.danger} accessibilityRole="alert">{error}</Text>}
                    {topic && !open && <Text style={styles.italic} testID="forum-closed">{t(TOPIC_WORDS.closed)}</Text>}
                </ScrollView>
                {topic && open && (
                    <View testID="forum-reply">
                        {quote && (
                            <View style={[styles.quote, { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginTop: 6 }]} testID="forum-quote">
                                <Text style={[styles.small, { flex: 1 }]} numberOfLines={2}>{t(TOPIC_WORDS.replyingTo, { name: name(quote), words: quote.words })}</Text>
                                <Pressable accessibilityRole="button" accessibilityLabel={t(TOPIC_WORDS.cancelQuote)} onPress={() => setQuote(null)} style={styles.iconBtn}>
                                    <MaterialCommunityIcons name="close" size={20} color={colors.text.muted} />
                                </Pressable>
                            </View>
                        )}
                        <ChatComposer ref={composer} styles={chatStyles} onSend={(words) => send(words.trim())} placeholder={t(TOPIC_WORDS.writeReply)}
                            accessibilityLabel={t(TOPIC_WORDS.writeReply)} busy={busy} disabled={busy} maxLength={FORUM_LIMITS.reply} bottomPadding={Math.max(insets.bottom, 12)} />
                    </View>
                )}
            </KeyboardAvoidingView>
            <ForumMenu label={menu?.kind === 'post' ? t(TOPIC_WORDS.postMenu) : t(TOPIC_WORDS.topicMenu)} items={menu ? menuItems(menu) : null} onClose={() => setMenu(null)} styles={styles} />
            <ReportMessageSheet isOpen={!!reporting} photo={false} title={t(TOPIC_WORDS.reportTitle)} note={t(TOPIC_WORDS.reportNote)} onClose={() => setReporting(null)}
                onSubmit={async (reason) => {
                    if (!reporting) return;
                    try {
                        await reportForumPost(reporting.id, reason);
                    } catch (e) {
                        Alert.alert((e as Error)?.message || t(TOPIC_WORDS.saveFailed));
                        throw e;
                    }
                    setReporting(null);
                    Alert.alert(t(REPORT_SENT_TEXT));
                }} />
        </SafeAreaView>
    );
}
