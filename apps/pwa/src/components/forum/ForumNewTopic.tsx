/**
 * A new topic on the web (slice F4; DESIGN-forums-fable.md §2, §5, §14 "New topic"): the section (only those the member may
 * start in: "News from BeanPool" is the owners' and admins'), a title, the words, a place in words (optional, never a map
 * point) and photos. A new member reads under the button that a moderator looks first, with the measured wait; their photos
 * go only there. On a public forum the sheet that anyone on the web can read it comes first, once.
 */
import { useState } from 'react';
import { FORUM_LIMITS, currentLanguage, forumSectionName, t, tn, word, wordn } from '@beanpool/core';
import { markForumTold, startForumTopic, type ForumFront, type ForumWaiting } from '../../lib/forum';
import { ForumPhotoAttach, ForumToldSheet } from './ForumBits';

export const NEW_TOPIC_WORDS = {
    heading: word('New topic'),
    section: word('Section'),
    title: word('Title'),
    words: word('What do you want to say?'),
    place: word('Place, in words (optional)'),
    placeHint: word('Like “near the town hall”. Never a map point.'),
    post: word('Post topic'),
    cancel: word('Cancel'),
    firstLook: word('Your first topic is looked at by a moderator before it shows.'),
    firstLookHours: wordn('Your first topic is looked at by a moderator before it shows. Usually within {n} hour.',
        'Your first topic is looked at by a moderator before it shows. Usually within {n} hours.'),
    count: word('{n} of {max}'),
};

const field = 'w-full min-h-[44px] rounded-lg px-3 py-2 text-[0.95rem]';
const fieldStyle = { background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' } as const;

export function ForumNewTopic({ front, sectionId, usuallyWithinHours, staff, onPosted, onCancel }: {
    front: ForumFront; sectionId: string | null; usuallyWithinHours: number | null; staff: boolean;
    onPosted: (out: { topicId: string } | { waiting: ForumWaiting }) => void; onCancel: () => void;
}) {
    const open = front.sections.filter((s) => !s.archived && (s.starts === 'members' || staff));
    const [section, setSection] = useState(open.some((s) => s.id === sectionId) ? sectionId! : open[0]?.id ?? '');
    const [title, setTitle] = useState('');
    const [words, setWords] = useState('');
    const [place, setPlace] = useState('');
    const [photos, setPhotos] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [telling, setTelling] = useState(false);
    const photosOk = front.linksOn || front.firstTopicWaits;
    const ready = !!section && title.trim().length > 0 && words.trim().length > 0 && Array.from(words.trim()).length <= FORUM_LIMITS.opening;

    /** `told`: they just agreed to the sheet (the front they were handed still says not). */
    async function post(told = false) {
        if (!ready || busy) return;
        if (front.public && !front.told && !told) { setTelling(true); return; }
        setBusy(true);
        setError(null);
        try {
            const out = await startForumTopic({ sectionId: section, title: title.trim(), words: words.trim(), place: place.trim() || undefined, lang: currentLanguage(), photos: photosOk ? photos : [] });
            onPosted('waiting' in out ? out : { topicId: out.topic.id });
        } catch (e) {
            setError((e as Error)?.message || t('Couldn’t save this in the forum.'));
            setBusy(false);
        }
    }

    return (
        <form data-testid="forum-new-topic" className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void post(); }}>
            <h2 className="m-0 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t(NEW_TOPIC_WORDS.heading)}</h2>
            <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {t(NEW_TOPIC_WORDS.section)}
                <select value={section} onChange={(e) => setSection(e.target.value)} className={field} style={fieldStyle} data-testid="forum-new-section">
                    {open.map((s) => <option key={s.id} value={s.id}>{forumSectionName(s)}</option>)}
                </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {t(NEW_TOPIC_WORDS.title)}
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={FORUM_LIMITS.title} className={field} style={fieldStyle} data-testid="forum-new-title" />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {t(NEW_TOPIC_WORDS.words)}
                <textarea value={words} onChange={(e) => setWords(e.target.value)} rows={6} className={`${field} resize-y`} style={fieldStyle} data-testid="forum-new-words" />
                <span className="text-xs font-normal self-end" style={{ color: 'var(--text-muted)' }}>{t(NEW_TOPIC_WORDS.count, { n: Array.from(words.trim()).length, max: FORUM_LIMITS.opening })}</span>
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {t(NEW_TOPIC_WORDS.place)}
                <input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={FORUM_LIMITS.place} className={field} style={fieldStyle} />
                <span className="text-xs font-normal" style={{ color: 'var(--text-muted)' }}>{t(NEW_TOPIC_WORDS.placeHint)}</span>
            </label>
            {photosOk && <div className="flex flex-wrap items-end gap-2"><ForumPhotoAttach photos={photos} onChange={setPhotos} disabled={busy} /></div>}
            {error && <p role="alert" className="m-0 text-sm" style={{ color: 'var(--bp-ink-danger)' }}>{error}</p>}
            <div className="flex flex-wrap gap-2 justify-end">
                <button type="button" onClick={onCancel} className="min-h-[44px] px-4 rounded-lg font-semibold" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}>{t(NEW_TOPIC_WORDS.cancel)}</button>
                <button type="submit" disabled={!ready || busy} data-testid="forum-new-post" className="min-h-[44px] px-4 rounded-lg font-bold disabled:opacity-50" style={{ background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' }}>{t(NEW_TOPIC_WORDS.post)}</button>
            </div>
            {front.firstTopicWaits && (
                <p data-testid="forum-first-look-note" className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {usuallyWithinHours ? tn(usuallyWithinHours, NEW_TOPIC_WORDS.firstLookHours.one, NEW_TOPIC_WORDS.firstLookHours.other, { n: usuallyWithinHours }) : t(NEW_TOPIC_WORDS.firstLook)}
                </p>
            )}
            {telling && (
                <ForumToldSheet busy={busy} onNotNow={() => setTelling(false)} onPost={() => {
                    setTelling(false);
                    void markForumTold().then(() => post(true)).catch((e) => setError((e as Error)?.message || t('Couldn’t save this in the forum.')));
                }} />
            )}
        </form>
    );
}
