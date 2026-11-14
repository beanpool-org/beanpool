/**
 * The Chat tab's Forum side on the web (slice F4; scratch/fable-design/DESIGN-forums-fable.md §2 to §6, §14, §18, and
 * DESIGN-forums-messaging-joint-fable.md §2.1), drawn under T0's Chats · Forum switch (pages/ChatTabPage.tsx) where this
 * community's forum is on. It calls the node's forum routes as they are (slices F1, F2, F5; lib/forum.ts).
 *
 * - **The list:** a section picker (All, or one), then for moderators "Waiting for a first look (n) ›", for a new member their
 *   own first topic while it waits (with the measured wait, and Withdraw), then the topics: pinned first, then the newest
 *   activity, each row opening its topic on a tap anywhere (a person's card opens only from inside the topic), ● where a
 *   followed topic has a reply they haven't opened. ＋ New topic.
 * - **A topic, a new topic, the first looks** are views in place (components/forum/), each with its own ‹ back to the list.
 * - **Kept copies:** what was last read draws at once from the page's own copies, then the node is asked again (§18: the web
 *   reads "while the page is open"; nothing is written to the browser's storage).
 * - **Older nodes and errors:** the forum's routes answer `feature_off` where the owners switched it off; the page says the
 *   node's words, with Try again.
 */
import { useEffect, useState } from 'react';
import { forumSectionName, t, timeAgo, tn, word } from '@beanpool/core';
import { myNodeRoleOnce } from '../lib/api';
import {
    getForumFront, getForumTopics, keptFront, keptList, myFirstLook, withdrawFirstLook, type ForumFront, type ForumTopic, type ForumWaiting,
} from '../lib/forum';
import { ForumTopicView } from '../components/forum/ForumTopicView';
import { ForumNewTopic } from '../components/forum/ForumNewTopic';
import { ForumFirstLooks } from '../components/forum/ForumFirstLooks';

export const FORUM_WORDS = {
    allSections: word('All sections'),
    pickSection: word('Section to show'),
    newTopic: word('＋ New topic'),
    firstLooks: word('Waiting for a first look ({n}) ›'),
    none: word('No topics here yet. Start the first one.'),
    more: word('Show more topics'),
    replies: { one: word('{n} reply'), other: word('{n} replies') },
    unread: word('New replies'),
    waitingMine: word('Your first topic “{title}” is waiting for a first look.'),
    usually: { one: word('Usually within {n} hour.'), other: word('Usually within {n} hours.') },
    withdraw: word('Withdraw it'),
    sentForLook: word('Thank you. A moderator looks at your first topic before it shows. You’ll hear by the bell.'),
    failed: word('Couldn’t load the forum. Check your connection and try again.'),
    again: word('Try again'),
    archived: word('{name} (archived)'),
};

type View = { kind: 'list' } | { kind: 'topic'; id: string } | { kind: 'new' } | { kind: 'firstLooks' };

export function ForumPage({ me, onOpenProfile }: { me: string; onOpenProfile?: (pubkey: string) => void }) {
    const [view, setView] = useState<View>({ kind: 'list' });
    const [front, setFront] = useState<ForumFront | null>(() => keptFront());
    const [section, setSection] = useState<string | null>(null);
    const [list, setList] = useState(() => keptList(null));
    const [failed, setFailed] = useState<string | null>(null);
    const [mine, setMine] = useState<{ waiting: ForumWaiting | null; usuallyWithinHours: number | null } | null>(null);
    const [sent, setSent] = useState(false);
    const [staff, setStaff] = useState(false);

    async function loadFront() {
        try {
            const f = await getForumFront();
            setFront(f);
            setFailed(null);
            if (f.firstTopicWaits) void myFirstLook().then(setMine).catch(() => {});
            else setMine(null);
        } catch (e) {
            setFailed((e as Error)?.message || t(FORUM_WORDS.failed));
        }
    }
    async function loadList(offset = 0) {
        try {
            setList(await getForumTopics(section, offset));
        } catch (e) {
            setFailed((e as Error)?.message || t(FORUM_WORDS.failed));
        }
    }
    useEffect(() => {
        void myNodeRoleOnce().then((role) => setStaff(role === 'owner' || role === 'admin'));
    }, []);
    // Each return to the list asks again: a reply, a first look's answer or another member's topic may have come meanwhile.
    useEffect(() => { if (view.kind === 'list') void loadFront(); }, [view.kind]);
    useEffect(() => {
        setList(keptList(section));
        if (view.kind === 'list') void loadList(0);
    }, [section, view.kind]);

    const toList = () => setView({ kind: 'list' });
    if (view.kind === 'topic') return <ForumTopicView topicId={view.id} front={front} me={me} onBack={toList} onOpenProfile={onOpenProfile} />;
    if (view.kind === 'firstLooks') return <ForumFirstLooks front={front} onBack={toList} />;
    if (view.kind === 'new' && front) {
        return (
            <ForumNewTopic front={front} sectionId={section} usuallyWithinHours={mine?.usuallyWithinHours ?? null} staff={staff} onCancel={toList}
                onPosted={(out) => {
                    if ('topicId' in out) setView({ kind: 'topic', id: out.topicId });
                    else { setSent(true); toList(); }
                }} />
        );
    }

    const sections = front?.sections ?? [];
    const nameOf = (id: string) => {
        const s = sections.find((x) => x.id === id);
        return s ? forumSectionName(s) : '';
    };
    const waiting = mine?.waiting ?? null;
    const button = 'min-h-[44px] px-4 rounded-lg font-semibold';
    const quiet = { background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' } as const;

    return (
        <div data-testid="forum-page" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <select value={section ?? ''} onChange={(e) => setSection(e.target.value || null)} aria-label={t(FORUM_WORDS.pickSection)} data-testid="forum-section-pick"
                    className="flex-1 min-w-0 min-h-[44px] rounded-lg px-2 text-[0.95rem]" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }}>
                    <option value="">{t(FORUM_WORDS.allSections)}</option>
                    {sections.map((s) => <option key={s.id} value={s.id}>{s.archived ? t(FORUM_WORDS.archived, { name: forumSectionName(s) }) : forumSectionName(s)}</option>)}
                </select>
                {front && (
                    <button type="button" onClick={() => { setSent(false); setView({ kind: 'new' }); }} data-testid="forum-new" disabled={!!waiting && front.firstTopicWaits}
                        className={`${button} font-bold disabled:opacity-50`} style={{ background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' }}>{t(FORUM_WORDS.newTopic)}</button>
                )}
            </div>

            {failed && (
                <div className="flex flex-col items-start gap-2">
                    <p role="alert" className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>{failed}</p>
                    <button type="button" onClick={() => { void loadFront(); void loadList(0); }} className={button} style={quiet}>{t(FORUM_WORDS.again)}</button>
                </div>
            )}

            {front?.moderator && (front.firstLooksWaiting ?? 0) > 0 && (
                <button type="button" onClick={() => setView({ kind: 'firstLooks' })} data-testid="forum-first-looks-row"
                    className="min-h-[48px] px-3 rounded-lg text-left font-bold" style={{ background: 'var(--bp-chip-warn-tint)', color: 'var(--bp-chip-warn-ink)' }}>
                    {t(FORUM_WORDS.firstLooks, { n: front.firstLooksWaiting! })}
                </button>
            )}

            {sent && !waiting && <p className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(FORUM_WORDS.sentForLook)}</p>}
            {waiting && (
                <div data-testid="forum-mine-waiting" className="flex flex-col gap-2 p-3 rounded-lg" style={{ background: 'var(--bp-info-fill)', color: 'var(--bp-info-on)' }}>
                    <p className="m-0 text-sm font-semibold" style={{ overflowWrap: 'anywhere' }}>{t(FORUM_WORDS.waitingMine, { title: waiting.title })}</p>
                    {mine?.usuallyWithinHours ? <p className="m-0 text-sm">{tn(mine.usuallyWithinHours, FORUM_WORDS.usually.one, FORUM_WORDS.usually.other, { n: mine.usuallyWithinHours })}</p> : null}
                    <button type="button" className={`${button} self-start`} style={quiet}
                        onClick={() => void withdrawFirstLook(waiting.id).then(loadFront).catch((e) => setFailed((e as Error)?.message || t(FORUM_WORDS.failed)))}>{t(FORUM_WORDS.withdraw)}</button>
                </div>
            )}

            {list && list.topics.length === 0 && !failed && <p className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(FORUM_WORDS.none)}</p>}
            <ul className="m-0 p-0 list-none flex flex-col" data-testid="forum-topics">
                {list?.topics.map((topic) => <TopicRow key={topic.id} topic={topic} sectionName={section ? '' : nameOf(topic.sectionId)} onOpen={() => setView({ kind: 'topic', id: topic.id })} />)}
            </ul>
            {list?.next != null && <button type="button" onClick={() => void loadList(list.next!)} className={button} style={quiet}>{t(FORUM_WORDS.more)}</button>}
        </div>
    );
}

/** One topic in the list: a tap anywhere opens it (the small-cards rule). */
function TopicRow({ topic, sectionName, onOpen }: { topic: ForumTopic; sectionName: string; onOpen: () => void }) {
    const when = timeAgo(Math.max(0, Date.now() - Date.parse(topic.lastActivityAt)));
    const replies = tn(topic.replyCount, FORUM_WORDS.replies.one, FORUM_WORDS.replies.other, { n: topic.replyCount });
    return (
        <li style={{ borderTop: '1px solid var(--border-primary)' }}>
            <button type="button" onClick={onOpen} data-testid="forum-topic-row" className="w-full min-h-[56px] py-2 text-left flex items-start gap-2">
                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="font-bold text-[0.95rem] leading-snug" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                        {topic.pinned && <span aria-hidden="true">📌 </span>}{topic.title}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
                        {[topic.writer.name, sectionName].filter(Boolean).join(' · ')}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{replies} · {when}</span>
                </span>
                {topic.unread && <span role="img" aria-label={t(FORUM_WORDS.unread)} className="mt-1 w-3 h-3 rounded-full shrink-0" style={{ background: 'var(--bp-accent-fill)' }} />}
            </button>
        </li>
    );
}
