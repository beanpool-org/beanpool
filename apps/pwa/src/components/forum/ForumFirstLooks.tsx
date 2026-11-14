/**
 * "Waiting for a first look" on the web (slice F4; DESIGN-forums-fable.md §5, §6), for the community's owners, admins and
 * moderators, in every language (not in Settings, which is English only): each new member's first topic, oldest first, with
 * its words and photos. OK makes the topic in the writer's name and marks them known; No takes one of the five reasons a
 * removal gives. The writer is told either way by the bell, and never who answered.
 */
import { useEffect, useState } from 'react';
import { forumSectionName, t, timeAgo, word } from '@beanpool/core';
import { FIRST_LOOK_NO_REASONS, listFirstLooks, noFirstLook, okFirstLook, type FirstLookNoReason, type ForumFront, type ForumWaiting } from '../../lib/forum';
import { ForumPhotos, ForumWords } from './ForumBits';

export const FIRST_LOOK_WORDS = {
    heading: word('Waiting for a first look'),
    none: word('Nothing is waiting. Thank you for looking.'),
    ok: word('OK, put it up'),
    no: word('No'),
    why: word('Why not?'),
    send: word('Say no'),
    cancel: word('Cancel'),
    back: word('Back to the forum'),
    failed: word('Couldn’t load the first looks. Check your connection and try again.'),
    reasons: {
        spam: word('Spam or a scam'),
        offensive: word('Offensive content'),
        misleading: word('Misleading'),
        unsafe: word('Unsafe or illegal'),
        rules: word('Against this community’s rules'),
    } satisfies Record<FirstLookNoReason, string>,
};

export function ForumFirstLooks({ front, onBack }: { front: ForumFront | null; onBack: () => void }) {
    const [waiting, setWaiting] = useState<ForumWaiting[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [saying, setSaying] = useState<string | null>(null);
    const [reason, setReason] = useState<FirstLookNoReason | ''>('');
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = () => listFirstLooks().then((r) => { setWaiting(r.waiting); setFailed(false); }).catch(() => setFailed(true));
    useEffect(() => { void load(); }, []);

    /** One answer, then the list again: a moderator with several waiting stays here and answers the next. */
    async function answer(id: string, fn: () => Promise<unknown>) {
        setBusy(id);
        setError(null);
        try {
            await fn();
            setSaying(null);
            setReason('');
            await load();
        } catch (e) {
            setError((e as Error)?.message || t('Couldn’t save this in the forum.'));
        } finally {
            setBusy(null);
        }
    }

    return (
        <div data-testid="forum-first-looks" className="flex flex-col gap-3">
            <div className="flex items-center gap-1">
                <button type="button" onClick={onBack} aria-label={t(FIRST_LOOK_WORDS.back)} className="min-w-[44px] min-h-[44px] text-xl" style={{ color: 'var(--text-primary)' }}>‹</button>
                <h2 className="m-0 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t(FIRST_LOOK_WORDS.heading)}</h2>
            </div>
            {failed && <p className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(FIRST_LOOK_WORDS.failed)}</p>}
            {waiting && waiting.length === 0 && <p className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(FIRST_LOOK_WORDS.none)}</p>}
            {error && <p role="alert" className="m-0 text-sm" style={{ color: 'var(--bp-ink-danger)' }}>{error}</p>}
            {waiting?.map((w) => {
                const section = front?.sections.find((s) => s.id === w.sectionId);
                return (
                    <article key={w.id} data-testid="forum-first-look" className="flex flex-col gap-2 p-3 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
                        <p className="m-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {[section ? forumSectionName(section) : '', w.writer.name, timeAgo(Math.max(0, Date.now() - Date.parse(w.createdAt)))].filter(Boolean).join(' · ')}
                        </p>
                        <h3 className="m-0 text-base font-bold" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{w.title}</h3>
                        {w.place && <p className="m-0 text-xs" style={{ color: 'var(--text-muted)' }}>📍 {w.place}</p>}
                        {/* A new writer's words: their links stay plain text here too, until a moderator says OK. */}
                        <ForumWords words={w.words} linksOn={false} />
                        <ForumPhotos id={w.id} count={w.photos} waiting />
                        {saying === w.id ? (
                            <div className="flex flex-col gap-2">
                                <fieldset className="m-0 p-0 border-0 flex flex-col gap-1">
                                    <legend className="text-sm font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>{t(FIRST_LOOK_WORDS.why)}</legend>
                                    {FIRST_LOOK_NO_REASONS.map((r) => (
                                        <label key={r} className="flex items-center gap-2 min-h-[44px] text-sm" style={{ color: 'var(--text-primary)' }}>
                                            <input type="radio" name={`no-${w.id}`} checked={reason === r} onChange={() => setReason(r)} className="w-5 h-5" />
                                            {t(FIRST_LOOK_WORDS.reasons[r])}
                                        </label>
                                    ))}
                                </fieldset>
                                <div className="flex flex-wrap gap-2 justify-end">
                                    <button type="button" onClick={() => { setSaying(null); setReason(''); }} className="min-h-[44px] px-4 rounded-lg font-semibold" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}>{t(FIRST_LOOK_WORDS.cancel)}</button>
                                    <button type="button" disabled={!reason || busy === w.id} onClick={() => reason && void answer(w.id, () => noFirstLook(w.id, reason))}
                                        className="min-h-[44px] px-4 rounded-lg font-bold disabled:opacity-50" style={{ background: 'var(--bp-chip-danger-tint)', color: 'var(--bp-chip-danger-ink)' }}>{t(FIRST_LOOK_WORDS.send)}</button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-wrap gap-2 justify-end">
                                <button type="button" disabled={busy === w.id} onClick={() => { setSaying(w.id); setReason(''); }} data-testid="forum-first-look-no"
                                    className="min-h-[44px] px-4 rounded-lg font-semibold" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}>{t(FIRST_LOOK_WORDS.no)}</button>
                                <button type="button" disabled={busy === w.id} data-testid="forum-first-look-ok"
                                    onClick={() => void answer(w.id, () => okFirstLook(w.id))}
                                    className="min-h-[44px] px-4 rounded-lg font-bold disabled:opacity-50" style={{ background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' }}>{t(FIRST_LOOK_WORDS.ok)}</button>
                            </div>
                        )}
                    </article>
                );
            })}
        </div>
    );
}
