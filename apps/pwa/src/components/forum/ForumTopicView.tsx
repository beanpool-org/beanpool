/**
 * One topic on the web (slice F4; DESIGN-forums-fable.md §2, §6, §9, §14 "A topic"): its title and opening words, then the
 * replies in time order, full-width rows with a name on top (bubbles waste a 320 px screen on long writing), the member's
 * own faintly tinted and still on the left. Each post's ⋯ holds Reply (a quote of it) · Copy · Report · Block · Remove, each
 * only where it applies. The topic's bell follows or leaves it; its ⋯ mutes it or closes it. The reply box is the chat's
 * shape: words, 📎, Send, and a quoted reply above it. Opening the topic marks it read up to the last post drawn, which takes
 * the forum's own bell rows for it off (POST /read, slice F5).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FORUM_LIMITS, currentLanguage, forumSectionName, t, timeAgo, word } from '@beanpool/core';
import {
    closeForumTopic, followForumTopic, getForumTopic, keptTopic, markForumTold, readForumTopic, removeForumPost, replyInForum, reportForumPost,
    type ForumFront, type ForumPost, type ForumTopicPage,
} from '../../lib/forum';
import { blockUser } from '../../lib/blocklist';
import { useCoversScreen } from '../../lib/screen-cover';
import { useGrowingComposer } from '../../lib/use-growing-composer';
import { ReportModal } from '../ReportModal';
import { ForumPhotoAttach, ForumPhotos, ForumToldSheet, ForumWords } from './ForumBits';

export const TOPIC_WORDS = {
    back: word('Back to the forum'),
    removedByWriter: word('Removed by its writer'),
    removedByModerator: word('Removed by a moderator'),
    removedTopic: word('A removed topic'),
    hidden: word('Hidden while moderators look'),
    edited: word('edited'),
    closed: word('This topic is closed, so it takes no new replies.'),
    writeReply: word('Write a reply…'),
    send: word('Send'),
    replyingTo: word('Replying to {name}'),
    cancelQuote: word('Don’t quote'),
    moreReplies: word('Show more replies'),
    follow: word('Follow this topic'),
    following: word('Following: tap to stop'),
    mute: word('Mute this topic'),
    unmute: word('Unmute this topic'),
    close: word('Close this topic'),
    topicMenu: word('More for this topic'),
    postMenu: word('More for this post'),
    reply: word('Reply'),
    copy: word('Copy'),
    report: word('Report'),
    block: word('Block {name}'),
    remove: word('Remove'),
    blockSure: word('Block {name}? You won’t see their posts or messages. You can unblock them in Settings.'),
    removeSure: word('Remove this post? Its words and photos go for everyone.'),
    reportTitle: word('Report this post'),
    reportNote: word('The community’s moderators see this post and your reason.'),
    cancel: word('Cancel'),
    failed: word('Couldn’t load this topic. Check your connection and try again.'),
    again: word('Try again'),
    tooLong: word('At most {n} characters.'),
};

type Menu = { kind: 'post'; post: ForumPost; confirm?: 'block' | 'remove' } | { kind: 'topic' } | null;
type MenuItem = [string, (() => void) | null, boolean?];

export function ForumTopicView({ topicId, front, me, onBack, onOpenProfile }: {
    topicId: string; front: ForumFront | null; me: string; onBack: () => void; onOpenProfile?: (pubkey: string) => void;
}) {
    const [page, setPage] = useState<ForumTopicPage | null>(() => keptTopic(topicId));
    const [failed, setFailed] = useState(false);
    const [menu, setMenu] = useState<Menu>(null);
    const [reporting, setReporting] = useState<ForumPost | null>(null);
    const [words, setWords] = useState('');
    const [photos, setPhotos] = useState<string[]>([]);
    const [quote, setQuote] = useState<ForumPost | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [telling, setTelling] = useState(false);
    const box = useRef<HTMLTextAreaElement>(null);
    useGrowingComposer(box);
    useCoversScreen(menu !== null);

    async function load(after = 0) {
        try {
            const p = await getForumTopic(topicId, after);
            setPage(p);
            setFailed(false);
            const last = p.posts.length ? p.posts[p.posts.length - 1].number : 0;
            if (last > p.lastRead) void readForumTopic(topicId, last).catch(() => { /* the next open marks it */ });
        } catch {
            setFailed(true);
        }
    }
    useEffect(() => { void load(0); }, [topicId]);

    const topic = page?.topic;
    const opening = page?.posts.find((p) => p.number === 1) ?? null;
    const replies = page?.posts.filter((p) => p.number > 1) ?? [];
    const section = front?.sections.find((s) => s.id === topic?.sectionId);
    const open = !!topic && !topic.closed;
    const tooLong = Array.from(words.trim()).length > FORUM_LIMITS.reply;

    /** `told`: they just agreed to the sheet (the front they were handed still says not). */
    async function send(told = false) {
        if (!topic || busy || !words.trim() || tooLong) return;
        if (front?.public && !front.told && !told) { setTelling(true); return; }
        setBusy(true);
        setError(null);
        try {
            await replyInForum(topic.id, { words: words.trim(), quotes: quote?.number ?? null, lang: currentLanguage(), photos });
            setWords('');
            setPhotos([]);
            setQuote(null);
            await load(0);
        } catch (e) {
            setError((e as Error)?.message || t('Couldn’t save this in the forum.'));
        } finally {
            setBusy(false);
        }
    }

    async function act(fn: () => Promise<unknown>) {
        setMenu(null);
        setError(null);
        try {
            await fn();
            await load(0);
        } catch (e) {
            setError((e as Error)?.message || t('Couldn’t save this in the forum.'));
        }
    }

    const quoted = (n: number | null) => (n ? page?.posts.find((p) => p.number === n) ?? null : null);
    const name = (p: { writer: { name: string } }) => p.writer.name || t('A member');

    function PostBody({ post }: { post: ForumPost }) {
        if (post.removed) return <p className="m-0 italic text-sm" style={{ color: 'var(--text-muted)' }}>{t(post.removed === 'moderator' ? TOPIC_WORDS.removedByModerator : TOPIC_WORDS.removedByWriter)}</p>;
        if (post.hidden && !post.words) return <p className="m-0 italic text-sm" style={{ color: 'var(--text-muted)' }}>{t(TOPIC_WORDS.hidden)}</p>;
        return (
            <>
                {post.hidden && <p className="m-0 mb-1 text-xs font-semibold" style={{ color: 'var(--bp-chip-warn-ink)' }}>{t(TOPIC_WORDS.hidden)}</p>}
                <ForumWords words={post.words} linksOn={post.linksOn} testId={`forum-words-${post.number}`} />
                <ForumPhotos id={post.id} count={post.photos} />
            </>
        );
    }

    function Byline({ post }: { post: ForumPost }) {
        return (
            <div className="flex items-center gap-2 min-w-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                <button type="button" onClick={() => onOpenProfile?.(post.writer.publicKey)} className="font-bold truncate min-h-[32px] text-left" style={{ color: 'var(--text-primary)' }}>{name(post)}</button>
                <span className="shrink-0">· {timeAgo(Math.max(0, Date.now() - Date.parse(post.createdAt)))}{post.editedAt ? ` · ${t(TOPIC_WORDS.edited)}` : ''}</span>
                <button type="button" onClick={() => setMenu({ kind: 'post', post })} aria-label={t(TOPIC_WORDS.postMenu)} data-testid={`forum-post-menu-${post.number}`}
                    className="ml-auto min-w-[44px] min-h-[44px] text-lg shrink-0" style={{ color: 'var(--text-muted)' }}>⋯</button>
            </div>
        );
    }

    return (
        <div data-testid="forum-topic" className="flex flex-col gap-3 pb-4">
            <div className="flex items-center gap-1">
                <button type="button" onClick={onBack} aria-label={t(TOPIC_WORDS.back)} data-testid="forum-back" className="min-w-[44px] min-h-[44px] text-xl" style={{ color: 'var(--text-primary)' }}>‹</button>
                <span className="text-sm font-semibold truncate min-w-0 flex-1" style={{ color: 'var(--text-secondary)' }}>{section ? forumSectionName(section) : ''}</span>
                {topic && (
                    <button type="button" data-testid="forum-follow" aria-pressed={topic.follow === 'following'}
                        aria-label={t(topic.follow === 'following' ? TOPIC_WORDS.following : TOPIC_WORDS.follow)} title={t(topic.follow === 'following' ? TOPIC_WORDS.following : TOPIC_WORDS.follow)}
                        onClick={() => void act(() => followForumTopic(topic.id, topic.follow === 'following' ? null : 'following'))}
                        className="min-w-[44px] min-h-[44px] text-lg" style={{ opacity: topic.follow === 'following' ? 1 : 0.55 }}>
                        <span aria-hidden="true">{topic.follow === 'muted' ? '🔕' : '🔔'}</span>
                    </button>
                )}
                {topic && <button type="button" onClick={() => setMenu({ kind: 'topic' })} aria-label={t(TOPIC_WORDS.topicMenu)} data-testid="forum-topic-menu" className="min-w-[44px] min-h-[44px] text-lg" style={{ color: 'var(--text-muted)' }}>⋯</button>}
            </div>

            {failed && !page && (
                <div className="flex flex-col items-start gap-2">
                    <p className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(TOPIC_WORDS.failed)}</p>
                    <button type="button" onClick={() => void load(0)} className="min-h-[44px] px-4 rounded-lg font-semibold" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}>{t(TOPIC_WORDS.again)}</button>
                </div>
            )}

            {topic && (
                <article className="flex flex-col gap-1">
                    <h2 data-testid="forum-topic-title" className="m-0 text-lg font-bold leading-snug" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                        {topic.pinned && <span aria-hidden="true">📌 </span>}{topic.removed ? t(TOPIC_WORDS.removedTopic) : topic.title}
                    </h2>
                    {topic.place && <p className="m-0 text-xs" style={{ color: 'var(--text-muted)' }}>📍 {topic.place}</p>}
                    {opening && <Byline post={opening} />}
                    {opening && <PostBody post={opening} />}
                </article>
            )}

            {replies.map((post) => {
                const q = quoted(post.quotes);
                return (
                    <article key={post.id} data-testid={`forum-post-${post.number}`} className="flex flex-col gap-1 pt-2 px-2 rounded-lg"
                        style={{ borderTop: '1px solid var(--border-primary)', background: post.writer.publicKey === me ? 'var(--bg-secondary)' : undefined }}>
                        <Byline post={post} />
                        {q && (
                            <p className="m-0 pl-2 text-xs truncate" style={{ borderLeft: '3px solid var(--bp-accent-fill)', color: 'var(--text-secondary)' }}>
                                {name(q)}: {q.words || t(q.removed ? TOPIC_WORDS.removedByWriter : TOPIC_WORDS.hidden)}
                            </p>
                        )}
                        <PostBody post={post} />
                    </article>
                );
            })}
            {page?.next != null && (
                <button type="button" onClick={() => void load(page.next!)} className="min-h-[44px] rounded-lg font-semibold" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}>{t(TOPIC_WORDS.moreReplies)}</button>
            )}

            {error && <p role="alert" className="m-0 text-sm" style={{ color: 'var(--bp-ink-danger)' }}>{error}</p>}

            {topic && !open && <p data-testid="forum-closed" className="m-0 text-sm italic" style={{ color: 'var(--text-muted)' }}>{t(TOPIC_WORDS.closed)}</p>}
            {topic && open && (
                <div className="sticky bottom-0 flex flex-col gap-2 pt-2" style={{ background: 'var(--bg-primary)', borderTop: '1px solid var(--border-primary)', bottom: 'var(--bottom-nav-offset, 0px)' }}>
                    {quote && (
                        <div className="flex items-center gap-2 pl-2 text-xs" style={{ borderLeft: '3px solid var(--bp-accent-fill)', color: 'var(--text-secondary)' }} data-testid="forum-quote">
                            <span className="truncate flex-1 min-w-0">{t(TOPIC_WORDS.replyingTo, { name: name(quote) })}: {quote.words}</span>
                            <button type="button" onClick={() => setQuote(null)} aria-label={t(TOPIC_WORDS.cancelQuote)} className="min-w-[44px] min-h-[44px]">✕</button>
                        </div>
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                        {front?.linksOn && <ForumPhotoAttach photos={photos} onChange={setPhotos} disabled={busy} />}
                        <textarea ref={box} value={words} onChange={(e) => setWords(e.target.value)} rows={1} placeholder={t(TOPIC_WORDS.writeReply)}
                            aria-label={t(TOPIC_WORDS.writeReply)} data-testid="forum-reply-box"
                            className="flex-1 min-w-0 min-h-[44px] rounded-lg px-3 py-2 text-[0.95rem] resize-none"
                            style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }} />
                        <button type="button" onClick={() => void send()} disabled={busy || !words.trim() || tooLong} data-testid="forum-send"
                            className="min-w-[44px] min-h-[44px] px-3 rounded-lg font-bold disabled:opacity-50" style={{ background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' }}>{t(TOPIC_WORDS.send)}</button>
                    </div>
                    {tooLong && <p className="m-0 text-xs" style={{ color: 'var(--bp-ink-danger)' }}>{t(TOPIC_WORDS.tooLong, { n: FORUM_LIMITS.reply })}</p>}
                </div>
            )}

            {menu && createPortal(
                <div role="dialog" aria-modal="true" aria-label={t(menu.kind === 'post' ? TOPIC_WORDS.postMenu : TOPIC_WORDS.topicMenu)} data-testid="forum-menu"
                    className="fixed inset-0 z-[130] flex items-end sm:items-center justify-center p-4 bg-black/60" onClick={() => setMenu(null)}>
                    <div className="w-full max-w-sm rounded-2xl p-2 flex flex-col" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }} onClick={(e) => e.stopPropagation()}>
                        {menuItems(menu).map(([label, fn, danger]) => (fn
                            ? <button key={label} type="button" onClick={fn} className="min-h-[48px] px-4 text-left rounded-lg font-semibold"
                                style={{ color: danger ? 'var(--bp-ink-danger)' : 'var(--text-primary)', overflowWrap: 'anywhere' }}>{label}</button>
                            : <p key={label} className="m-0 px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{label}</p>))}
                    </div>
                </div>,
                document.body,
            )}

            {reporting && (
                <ReportModal isOpen onClose={() => setReporting(null)} reporterPubkey={me} targetPubkey={reporting.writer.publicKey} targetName={name(reporting)}
                    title={t(TOPIC_WORDS.reportTitle)} note={t(TOPIC_WORDS.reportNote)} onSubmitReason={(reason) => reportForumPost(reporting.id, reason)} />
            )}

            {telling && (
                <ForumToldSheet busy={busy} onNotNow={() => setTelling(false)} onPost={() => {
                    setTelling(false);
                    setBusy(true);
                    void markForumTold().then(() => { setBusy(false); return send(true); })
                        .catch((e) => { setBusy(false); setError((e as Error)?.message || t('Couldn’t save this in the forum.')); });
                }} />
            )}
        </div>
    );

    /** What the open menu offers, each [label, action, danger] (no action: a sentence), only where it applies here. */
    function menuItems(m: NonNullable<Menu>): MenuItem[] {
        if (m.kind === 'topic') {
            if (!topic) return [];
            const items: MenuItem[] = [[
                t(topic.follow === 'muted' ? TOPIC_WORDS.unmute : TOPIC_WORDS.mute),
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
                [t(TOPIC_WORDS.block, { name: name(post) }), () => void act(() => blockUser(post.writer.publicKey)), true],
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
        const items: MenuItem[] = [];
        if (open && !post.removed && post.words) items.push([t(TOPIC_WORDS.reply), () => { setQuote(post); setMenu(null); box.current?.focus(); }]);
        if (post.words) items.push([t(TOPIC_WORDS.copy), () => { void navigator.clipboard?.writeText(post.words).catch(() => {}); setMenu(null); }]);
        if (!mine && !post.removed) items.push([t(TOPIC_WORDS.report), () => { setReporting(post); setMenu(null); }]);
        if (!mine) items.push([t(TOPIC_WORDS.block, { name: name(post) }), () => setMenu({ ...m, confirm: 'block' }), true]);
        if (mine && !post.removed) items.push([t(TOPIC_WORDS.remove), () => setMenu({ ...m, confirm: 'remove' }), true]);
        items.push([t(TOPIC_WORDS.cancel), () => setMenu(null)]);
        return items;
    }
}
