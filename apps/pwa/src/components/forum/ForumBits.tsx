/**
 * Small parts the web forum's screens share (slice F4; DESIGN-forums-fable.md §2, §5, §14): a post's words with their links,
 * its photos read signed, the photo button of a composer, and the sheet a public forum's first post waits on.
 */
import { useEffect, useRef, useState, type ReactPortal } from 'react';
import { createPortal } from 'react-dom';
import { FORUM_LIMITS, forumWordRuns, t, word } from '@beanpool/core';
import { forumPhotoUrl } from '../../lib/forum';
import { resizePhotoFile } from '../../lib/photo-resize';
import { useCoversScreen } from '../../lib/screen-cover';

/**
 * A post's words, its line breaks kept. A known writer's links open in a new tab (`nofollow ugc`: members' words); a new
 * writer's are plain text (`linksOn` false), so nothing in them can be tapped before a moderator has seen them.
 */
export function ForumWords({ words, linksOn, testId }: { words: string; linksOn: boolean; testId?: string }) {
    return (
        <p data-testid={testId} className="m-0 whitespace-pre-wrap text-[0.95rem] leading-snug" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
            {forumWordRuns(words, linksOn).map((run, i) => run.isUrl
                ? <a key={i} href={/^https?:\/\//i.test(run.text) ? run.text : `https://${run.text}`} target="_blank" rel="noopener noreferrer nofollow ugc" style={{ color: 'var(--link)' }}>{run.text}</a>
                : <span key={i}>{run.text}</span>)}
        </p>
    );
}

/** One photo of a post (or of a waiting topic), read signed and drawn when it has come; a tap opens it whole in a new tab. */
function ForumPhoto({ id, n, waiting }: { id: string; n: number; waiting?: boolean }) {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        void forumPhotoUrl(id, n, waiting).then((u) => { if (live) setUrl(u); });
        return () => { live = false; };
    }, [id, n, waiting]);
    return (
        <a href={url ?? undefined} target="_blank" rel="noopener noreferrer" aria-label={t('Photo {n}', { n: n + 1 })}
            className="block w-24 h-24 rounded-lg overflow-hidden shrink-0" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            {url && <img src={url} alt="" className="w-full h-full object-cover" />}
        </a>
    );
}

export function ForumPhotos({ id, count, waiting }: { id: string; count: number; waiting?: boolean }) {
    if (count <= 0) return null;
    return (
        <div className="flex flex-wrap gap-2 mt-2" data-testid="forum-photos">
            {Array.from({ length: Math.min(count, FORUM_LIMITS.photos) }, (_, n) => <ForumPhoto key={n} id={id} n={n} waiting={waiting} />)}
        </div>
    );
}

/**
 * The photos a post brings, up to 3, each made 800 px as a listing's (lib/photo-resize.ts): a 📎 button and the picked ones
 * with ✕. The picker opens only at the tap (permissions only when asked).
 */
export function ForumPhotoAttach({ photos, onChange, disabled }: { photos: string[]; onChange: (photos: string[]) => void; disabled?: boolean }) {
    const input = useRef<HTMLInputElement>(null);
    const full = photos.length >= FORUM_LIMITS.photos;
    async function picked(files: FileList | null) {
        if (!files) return;
        const room = FORUM_LIMITS.photos - photos.length;
        const made: string[] = [];
        for (const f of Array.from(files).slice(0, room)) {
            try { made.push(await resizePhotoFile(f)); } catch { /* a file that isn't a picture is left out */ }
        }
        if (made.length) onChange([...photos, ...made]);
        if (input.current) input.current.value = '';
    }
    return (
        <>
            <button type="button" data-testid="forum-attach" disabled={disabled || full} onClick={() => input.current?.click()}
                aria-label={t('Add a photo')} title={full ? t('At most {n} photos.', { n: FORUM_LIMITS.photos }) : t('Add a photo')}
                className="min-w-[44px] min-h-[44px] rounded-lg text-xl disabled:opacity-40 shrink-0" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}>
                <span aria-hidden="true">📎</span>
            </button>
            <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void picked(e.target.files)} />
            {photos.length > 0 && (
                <div className="flex flex-wrap gap-2 w-full order-first" data-testid="forum-attached">
                    {photos.map((p, i) => (
                        <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-primary)' }}>
                            <img src={p} alt="" className="w-full h-full object-cover" />
                            <button type="button" onClick={() => onChange(photos.filter((_, j) => j !== i))} aria-label={t('Remove photo {n}', { n: i + 1 })}
                                className="absolute top-0 right-0 w-7 h-7 text-sm" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>✕</button>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

export const TOLD_WORDS = {
    title: word('Anyone on the web can read this forum'),
    body: word('Anyone on the web can read this forum, with your name. Not your picture, your area or your profile.'),
    post: word('Post'),
    notNow: word('Not now'),
};

/**
 * Before a member's first post on a public forum (the global community's), once per account (design §5): the node keeps
 * the time they agreed and refuses a first post without it, so no app can skip the telling. Post agrees and sends; Not now
 * keeps what they wrote and sends nothing.
 */
export function ForumToldSheet({ onPost, onNotNow, busy }: { onPost: () => void; onNotNow: () => void; busy?: boolean }): ReactPortal {
    useCoversScreen(true);
    return createPortal(
        <div role="dialog" aria-modal="true" aria-labelledby="forum-told-title" data-testid="forum-told"
            className="fixed inset-0 z-[130] flex items-end sm:items-center justify-center p-4 bg-black/60">
            <div className="w-full max-w-md rounded-2xl p-5 flex flex-col gap-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
                <h3 id="forum-told-title" className="m-0 text-base font-bold" style={{ color: 'var(--text-primary)' }}>{t(TOLD_WORDS.title)}</h3>
                <p className="m-0 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(TOLD_WORDS.body)}</p>
                <div className="flex flex-wrap gap-2 justify-end">
                    <button type="button" onClick={onNotNow} disabled={busy} className="min-h-[44px] px-4 rounded-lg font-semibold"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}>{t(TOLD_WORDS.notNow)}</button>
                    <button type="button" onClick={onPost} disabled={busy} data-testid="forum-told-post" className="min-h-[44px] px-4 rounded-lg font-bold"
                        style={{ background: 'var(--bp-commit-fill)', color: 'var(--bp-commit-on)' }}>{t(TOLD_WORDS.post)}</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
