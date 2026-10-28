/**
 * Share a post (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §2.5 C, §3.4): **Share with members**,
 * the community's own link to it (`?post=<id>`, which opens it for a member and the community's doors for anyone else),
 * and, where the community lets members share outside (`features.shareOutside`) and the post is one everyone here sees,
 * **Share outside the community**: a link the node makes for this post alone (lib/peek.ts), which anyone may open for
 * seven days and read the post without names or faces. It is listed under Settings, Shared outside, to stop it.
 *
 * Each hands the link to the browser's own share sheet where there is one, and copies it where there is not, and says
 * which. A refusal says the node's own words, and nothing is copied: never a false success.
 */
import { useState } from 'react';
import { PEEK_WORDS as W, t } from '@beanpool/core';
import type { MarketplacePost } from '../lib/api';
import { useCommunityInfo } from '../lib/features';
import { eventLink } from '../lib/event-extras';
import { makePeekLink } from '../lib/peek';
import { nodeOrigin } from './EventExtras';

const BUTTON = 'flex-1 min-w-[8rem] min-h-[48px] px-3 rounded-xl border text-sm font-bold bg-transparent cursor-pointer break-words '
    + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info focus-visible:ring-offset-1 '
    + 'border-bp-ink-info text-bp-ink-info disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * Whether a post may be offered for sharing outside: one everyone here sees, on the board, and not an event that has
 * ended or was cancelled (an ended event stays 'active' until the 30-day scrub; the node refuses it all the same). The
 * node decides in the end (apps/server engine/peek-tickets.ts visitorsPost).
 */
export function shareableOutside(
    post: Pick<MarketplacePost, 'audienceScope' | 'status' | 'active'> & Partial<Pick<MarketplacePost, 'type' | 'eventEndAt' | 'eventState'>>,
    now = Date.now(),
): boolean {
    const scope = post.audienceScope ?? 'public';
    if (post.type === 'event' && (post.eventState === 'cancelled' || (!!post.eventEndAt && Date.parse(post.eventEndAt) <= now))) return false;
    return scope === 'public' && post.active !== false && (post.status === 'active' || post.status === 'pending');
}

/** Hand `link` to the share sheet, or copy it: 'shared', 'copied', 'cancelled' (they closed the sheet) or 'failed'. */
async function handOver(title: string, link: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
        try {
            await nav.share({ title, text: title, url: link });
            return 'shared';
        } catch (e) {
            if ((e as Error)?.name === 'AbortError') return 'cancelled';
        }
    }
    try {
        await navigator.clipboard.writeText(link);
        return 'copied';
    } catch {
        const el = document.createElement('textarea');
        el.value = link;
        document.body.appendChild(el);
        el.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        document.body.removeChild(el);
        return ok ? 'copied' : 'failed';
    }
}

/** "Share outside the community", with the line that says what it does, and what became of the tap. */
export function ShareOutsideButton({ post }: { post: MarketplacePost }) {
    const info = useCommunityInfo();
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
    if (info?.features?.shareOutside !== true || !shareableOutside(post)) return null;

    const share = async () => {
        setBusy(true);
        setNote(null);
        try {
            const { link } = await makePeekLink(post.id, nodeOrigin());
            const how = await handOver(post.title, link);
            if (how === 'copied') setNote({ text: t('Link copied.'), ok: true });
            else if (how === 'failed') setNote({ text: t('Could not copy the link.'), ok: false });
        } catch (e) {
            setNote({ text: (e as Error)?.message || t(W.notShared), ok: false });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div data-testid="share-outside" className="flex flex-col gap-1">
            <button type="button" data-testid="share-outside-button" onClick={share} disabled={busy} className={BUTTON}>
                {t(W.shareOutside)}
            </button>
            <p className="m-0 text-xs text-text-primary break-words">{t(W.shareOutsideNote)}</p>
            {note && (
                <p role="status" data-testid="share-outside-note" className={`m-0 text-sm font-semibold break-words ${note.ok ? 'text-bp-ink-accent' : 'text-red-700 dark:text-red-300'}`}>
                    {note.text}
                </p>
            )}
        </div>
    );
}

/** A listing's two shares: the members' link, and outside where the community allows it. */
export function SharePostButtons({ post }: { post: MarketplacePost }) {
    const [note, setNote] = useState<string | null>(null);
    const shareWithMembers = async () => {
        const how = await handOver(post.title, eventLink(nodeOrigin(), post.id));
        setNote(how === 'copied' ? t('Link copied.') : how === 'failed' ? t('Could not copy the link.') : null);
    };
    return (
        <div data-testid="share-post" className="flex flex-col gap-2 mt-4">
            <button type="button" data-testid="share-members-button" onClick={shareWithMembers} className={BUTTON}>
                {t(W.shareWithMembers)}
            </button>
            {note && <p role="status" className="m-0 text-sm font-semibold text-bp-ink-accent break-words">{note}</p>}
            <ShareOutsideButton post={post} />
        </div>
    );
}
