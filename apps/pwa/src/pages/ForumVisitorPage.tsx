/**
 * The lobby's Forum tab (slice F7, the apps' part; DESIGN-forums-fable.md §7 "The apps' visitors", §14, §18): the global
 * community's forum, read only, for a visitor with no account, from the node's public answer (lib/forum-public.ts, unsigned).
 *
 * - Sections and topics, newest activity first; a tap anywhere on a row opens the topic (the small-cards rule). A topic shows
 *   each post's writer (name, and their community where they switched the label on) and words. No pictures, no profile.
 * - **A door, never a wall:** where the reply box would be, Join to reply; a forum with no public topic says so, with the same
 *   door. Join opens the lobby's join, and the topic is kept so the member lands on it once joined.
 * - No answer is never "nothing here": the members' forum's own "Couldn't load" line, with Try again.
 */
import { useEffect, useRef, useState } from 'react';
import {
    FORUM_VISITOR_WORDS, forumSectionName, forumWriterLine, t, timeAgo, tn,
    type ForumPublicList, type ForumPublicSection, type ForumPublicTopicPage,
} from '@beanpool/core';
import { getPublicForum, getPublicSection, getPublicTopic, keepLinkedTopic } from '../lib/forum-public';
import { ForumWords } from '../components/forum/ForumBits';
import { TOPIC_WORDS } from '../components/forum/ForumTopicView';
import { FORUM_WORDS } from './ForumPage';

const button = 'min-h-[44px] px-4 rounded-lg font-semibold';
const quiet = { background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' } as const;
/** The lobby draws on its patterned ground: the forum's words sit on the card surface, never on the pattern. */
const sheet = 'flex flex-col gap-3 mx-3 my-3 px-4 py-3 rounded-2xl';
const sheetStyle = { background: 'var(--bg-card)', border: '1px solid var(--border-primary)' } as const;

/** The door, where a member's reply box or New topic would be. */
function JoinDoor({ onJoin, topicId }: { onJoin: () => void; topicId?: string }) {
    return (
        <button type="button" data-testid="forum-visitor-join" onClick={() => { if (topicId) keepLinkedTopic(topicId); onJoin(); }}
            className="w-full min-h-[48px] rounded-xl font-bold text-base" style={{ background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' }}>
            {t(FORUM_VISITOR_WORDS.joinToReply)}
        </button>
    );
}

function Failed({ line, onAgain }: { line: string; onAgain: () => void }) {
    return (
        <div className="flex flex-col items-start gap-2" data-testid="forum-visitor-failed">
            <p role="alert" className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>{line}</p>
            <button type="button" onClick={onAgain} className={button} style={quiet}>{t(FORUM_WORDS.again)}</button>
        </div>
    );
}

export function ForumVisitorPage({ topicId = null, onTopic, onJoin }: {
    /** The topic open (a door's `?topic=`, or a tap on a row or a Home card); null: the list. */
    topicId?: string | null;
    onTopic: (id: string | null) => void;
    onJoin: () => void;
}) {
    const [sections, setSections] = useState<ForumPublicSection[]>([]);
    const [section, setSection] = useState<string | null>(null);
    const [list, setList] = useState<ForumPublicList | null>(null);
    const [failed, setFailed] = useState(false);
    const picked = useRef(section);
    picked.current = section;

    async function load(offset = 0) {
        const asked = section;
        try {
            const page = asked ? await getPublicSection(asked, offset) : await getPublicForum(offset);
            if ('sections' in page) setSections(page.sections.slice().sort((a, b) => a.position - b.position));
            if (picked.current !== asked) return;
            setList((was) => (offset && was ? { topics: [...was.topics, ...page.topics.filter((p) => !was.topics.some((x) => x.id === p.id))], next: page.next } : page));
            setFailed(false);
        } catch {
            if (picked.current === asked) setFailed(true);
        }
    }
    useEffect(() => { if (!topicId) void load(0); }, [section, topicId]);

    if (topicId) return <VisitorTopic id={topicId} sections={sections} onBack={() => onTopic(null)} onJoin={onJoin} />;

    const nameOf = (id: string) => { const s = sections.find((x) => x.id === id); return s ? forumSectionName(s) : ''; };
    return (
        <div data-testid="forum-visitor" className={sheet} style={sheetStyle}>
            {sections.length > 0 && (
                <select value={section ?? ''} onChange={(e) => { setList(null); setSection(e.target.value || null); }} aria-label={t(FORUM_WORDS.pickSection)} data-testid="forum-visitor-section"
                    className="min-w-0 min-h-[44px] rounded-lg px-2 text-[0.95rem]" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}>
                    <option value="">{t(FORUM_WORDS.allSections)}</option>
                    {sections.map((s) => <option key={s.id} value={s.id}>{forumSectionName(s)}</option>)}
                </select>
            )}
            {failed && !list && <Failed line={t(FORUM_WORDS.failed)} onAgain={() => void load(0)} />}
            {list && list.topics.length === 0 && (
                <>
                    <p data-testid="forum-visitor-none" className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(FORUM_VISITOR_WORDS.none)}</p>
                    <JoinDoor onJoin={onJoin} />
                </>
            )}
            {list && list.topics.length > 0 && (
                <ul className="m-0 p-0 list-none flex flex-col" data-testid="forum-visitor-topics">
                    {list.topics.map((topic) => {
                        const replies = tn(topic.replyCount, FORUM_WORDS.replies.one, FORUM_WORDS.replies.other, { n: topic.replyCount });
                        return (
                            <li key={topic.id} style={{ borderTop: '1px solid var(--border-primary)' }}>
                                <button type="button" onClick={() => onTopic(topic.id)} data-testid="forum-visitor-topic-row" className="w-full min-h-[56px] py-2 text-left flex flex-col gap-0.5">
                                    <span dir="auto" className="font-bold text-[0.95rem] leading-snug" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                                        {topic.pinned && <span aria-hidden="true">📌 </span>}{topic.title}
                                    </span>
                                    <span className="text-xs" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
                                        {[forumWriterLine(topic.writer, t('A member')), section ? '' : nameOf(topic.sectionId)].filter(Boolean).join(' · ')}
                                    </span>
                                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{replies} · {timeAgo(Math.max(0, Date.now() - Date.parse(topic.lastActivityAt)))}</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
            {list?.next != null && <button type="button" onClick={() => void load(list.next!)} className={button} style={quiet}>{t(FORUM_WORDS.more)}</button>}
        </div>
    );
}

/** One topic, read only: the opening post and its replies, then the door where the reply box would be. */
function VisitorTopic({ id, sections, onBack, onJoin }: { id: string; sections: ForumPublicSection[]; onBack: () => void; onJoin: () => void }) {
    const [page, setPage] = useState<ForumPublicTopicPage | null>(null);
    const [failed, setFailed] = useState(false);
    async function read(after = 0) {
        try {
            const next = await getPublicTopic(id, after);
            setPage((was) => (after && was ? { ...next, posts: [...was.posts.filter((p) => p.number <= after), ...next.posts] } : next));
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }
    useEffect(() => { setPage(null); void read(0); }, [id]);
    const topic = page?.topic;
    const section = page?.section ?? (topic ? sections.find((s) => s.id === topic.sectionId) : undefined);
    const member = t('A member');
    const quoted = (n: number | null) => (n ? page?.posts.find((p) => p.number === n) ?? null : null);
    return (
        <div data-testid="forum-visitor-topic" className={`${sheet} pb-6`} style={sheetStyle}>
            <div className="flex items-center gap-1">
                <button type="button" onClick={onBack} aria-label={t(TOPIC_WORDS.back)} data-testid="forum-visitor-back" className="min-w-[44px] min-h-[44px] text-xl" style={{ color: 'var(--text-primary)' }}>‹</button>
                <span className="text-sm font-semibold truncate min-w-0 flex-1" style={{ color: 'var(--text-secondary)' }}>{section ? forumSectionName(section) : ''}</span>
            </div>
            {failed && !page && <Failed line={t(TOPIC_WORDS.failed)} onAgain={() => void read(0)} />}
            {topic && (
                <h2 dir="auto" data-testid="forum-visitor-title" className="m-0 text-lg font-bold leading-snug" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                    {topic.pinned && <span aria-hidden="true">📌 </span>}{topic.title}
                </h2>
            )}
            {topic?.place && <p className="m-0 text-xs" style={{ color: 'var(--text-muted)' }}>📍 {topic.place}</p>}
            {page?.posts.map((post) => {
                const q = quoted(post.quotes);
                return (
                    <article key={post.id} data-testid={`forum-visitor-post-${post.number}`} className="flex flex-col gap-1 pt-2"
                        style={post.number > 1 ? { borderTop: '1px solid var(--border-primary)' } : undefined}>
                        <p className="m-0 text-xs font-semibold" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
                            {[forumWriterLine(post.writer, member), timeAgo(Math.max(0, Date.now() - Date.parse(post.createdAt))), post.edited ? t(TOPIC_WORDS.edited) : ''].filter(Boolean).join(' · ')}
                        </p>
                        {q && q.words && (
                            <p className="m-0 pl-2 text-xs truncate" style={{ borderLeft: '3px solid var(--bp-accent-fill)', color: 'var(--text-secondary)' }}>
                                {t(TOPIC_WORDS.quoteLine, { name: forumWriterLine(q.writer, member), words: q.words })}
                            </p>
                        )}
                        <ForumWords words={post.words} linksOn testId={`forum-visitor-words-${post.number}`} />
                    </article>
                );
            })}
            {page?.next != null && <button type="button" onClick={() => void read(page.next!)} className={button} style={quiet}>{t(TOPIC_WORDS.moreReplies)}</button>}
            {topic && (topic.closed
                ? <p className="m-0 text-sm italic" style={{ color: 'var(--text-muted)' }}>{t(TOPIC_WORDS.closed)}</p>
                : <div className="pt-3" style={{ borderTop: '1px solid var(--border-primary)' }}><JoinDoor onJoin={onJoin} topicId={topic.id} /></div>)}
        </div>
    );
}
