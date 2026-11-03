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
import { useEffect, useState } from 'react';
import { INVITE_ASK_WORDS, PEEK_WORDS as W, shareSays, t, type WordKey } from '@beanpool/core';
import type { MarketplacePost } from '../lib/api';
import { useCommunityInfo } from '../lib/features';
import { useShareRole } from '../lib/use-share-role';
import { eventLink } from '../lib/event-extras';
import { makePeekLink } from '../lib/peek';
import { handOver } from '../lib/hand-over';
import { loadIdentity } from '../lib/identity';
import { InviteAndShareButton } from './InviteAndShare';
import { AskSheet } from './InviteAsks';
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

/**
 * "Share outside the community", with the line that says what it does, and what became of the tap.
 *
 * The node makes the link before it is handed over, so a hand-over that fails (no share sheet and no clipboard, or a
 * browser that refuses either once the tap has waited on the node: Safari's share() and clipboard need the tap itself)
 * leaves a live link, seven days and one of the member's 50. It is never lost: it is shown to copy by hand, and Try
 * again (or the button again) hands the same link over inside that tap, with no wait before it; no second link is made.
 * A share sheet the member closed leaves one too: it is kept the same way, unshown, for the next tap.
 */
export function ShareOutsideButton({ post }: { post: MarketplacePost }) {
    const info = useCommunityInfo();
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
    // The link made but not handed over, for the post it was made for (the same button may be drawn for another post
    // next): `failed`, shown to copy by hand; or the share sheet was closed, kept unshown for the next tap.
    const [kept, setKept] = useState<{ postId: string; link: string; failed: boolean } | null>(null);
    const says = shareSays(info?.features, undefined, post.type === 'event' ? 'event' : 'listing');
    if (!says.showShareOutside || !shareableOutside(post)) return null;
    const keptLink = kept?.postId === post.id ? kept.link : null;
    const shownLink = kept?.postId === post.id && kept.failed ? kept.link : null;

    const handOverNow = async (link: string) => {
        const how = await handOver(post.title, link);
        if (how === 'failed') {
            setKept({ postId: post.id, link, failed: true });
            setNote({ text: t('Could not copy the link.'), ok: false });
            return;
        }
        if (how === 'cancelled') {
            // A field already shown stays shown.
            setKept(k => ({ postId: post.id, link, failed: k?.postId === post.id && k.link === link && k.failed }));
            return;
        }
        setKept(null);
        if (how === 'copied') setNote({ text: t('Link copied.'), ok: true });
    };

    const share = async () => {
        setBusy(true);
        setNote(null);
        try {
            // A kept link goes straight to the hand-over, still inside the tap; only a new one waits on the node.
            await handOverNow(keptLink ?? (await makePeekLink(post.id, nodeOrigin())).link);
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
            {/* ONE note before the tap: how long anyone with the link can read it, no names or faces, that it can be stopped, and
                (where joining is on) that they can then ask to join. */}
            {says.outsideLine && <p data-testid="share-outside-line" className="m-0 text-xs text-text-secondary break-words">{t(says.outsideLine)}</p>}
            {note && (
                <p role="status" data-testid="share-outside-note" className={`m-0 text-sm font-semibold break-words ${note.ok ? 'text-bp-ink-accent' : 'text-red-700 dark:text-red-300'}`}>
                    {note.text}
                </p>
            )}
            {shownLink && (
                <div className="flex flex-wrap gap-2 items-center">
                    <input type="text" readOnly value={shownLink} data-testid="share-outside-link" aria-label={t('The link to share')}
                        onFocus={e => e.currentTarget.select()}
                        className="flex-1 min-w-0 basis-48 min-h-[48px] px-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-950 text-nature-950 dark:text-white text-sm" />
                    <button type="button" data-testid="share-outside-retry" onClick={share} disabled={busy} className={BUTTON}>
                        {t('Try again')}
                    </button>
                </div>
            )}
        </div>
    );
}

/**
 * "Ask an admin to invite someone", under the line "only admins invite here" (core shareSays showAskAdmin). It opens the ONE ask
 * form People → Invites uses (components/InviteAsks.tsx AskSheet). Drawn only for someone with a key here (a guest has none).
 * Once the node has taken the ask the member is told so.
 */
export function AskAdminButton() {
    const [hasKey, setHasKey] = useState(false);
    const [open, setOpen] = useState(false);
    const [sent, setSent] = useState(false);
    useEffect(() => {
        let cancelled = false;
        loadIdentity().then(id => { if (!cancelled) setHasKey(!!id); }).catch(() => { if (!cancelled) setHasKey(false); });
        return () => { cancelled = true; };
    }, []);
    if (!hasKey) return null;
    return (
        <div data-testid="share-ask-admin" className="flex flex-col gap-1">
            <button type="button" data-testid="share-ask-admin-button" onClick={() => { setSent(false); setOpen(true); }} className={BUTTON}>
                {t(INVITE_ASK_WORDS.button)}
            </button>
            {sent && <p role="status" data-testid="share-ask-admin-note" className="m-0 text-sm font-semibold text-bp-ink-accent break-words">{t(INVITE_ASK_WORDS.waiting)}</p>}
            {open && <AskSheet onClose={() => setOpen(false)} onSent={() => { setOpen(false); setSent(true); }} />}
        </div>
    );
}

/** A listing's two shares: the members' link, and outside where the community allows it. */
export function SharePostButtons({ post, isMember }: { post: MarketplacePost; isMember?: boolean | null }) {
    const info = useCommunityInfo();
    const role = useShareRole(info?.features);
    const says = shareSays(info?.features, role, post.type === 'event' ? 'event' : 'listing');
    // Invite and share is a member's: a guest here, or one not yet known to be a member, is not offered it. (Omitted means a member.)
    const showInvite = says.showInviteButton && isMember !== false && isMember !== null;
    // Where only admins invite and this member is none: the same member-only gate, then "Ask an admin to invite someone".
    const showAsk = says.showAskAdmin && isMember !== false && isMember !== null;
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
            {says.membersLine && (
                <p data-testid="share-members-note" className="m-0 text-xs text-text-secondary break-words">
                    {t(says.membersLine)}
                </p>
            )}
            {note && <p role="status" className="m-0 text-sm font-semibold text-bp-ink-accent break-words">{note}</p>}
            {says.showShareOutside && <ShareOutsideButton post={post} />}
            {/* ONE invite action (share-one-flow): Invite and share, where this member may invite and the line above does not
                say only admins do. Where only admins invite and this member is none, the line stands and one more button,
                "Ask an admin to invite someone", opens the ask form of People → Invites (#2775). Never both. */}
            {showInvite && <InviteAndShareButton post={post} />}
            {showAsk && <AskAdminButton />}
        </div>
    );
}
