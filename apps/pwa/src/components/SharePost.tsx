/**
 * Share a post (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §2.5 C, §3.4): **Share with members**,
 * the community's own link to it (`?post=<id>`, which opens it for a member and the community's doors for anyone else),
 * and, where the community lets members share outside (`features.shareOutside`) and the post is one everyone here sees,
 * **Share outside the community**: a link the node makes for this post alone (lib/peek.ts), which anyone may open for
 * seven days and read the post without names or faces. It is listed under Settings, Shared outside, to stop it.
 *
 * Each hands the link to the browser's own share sheet where there is one, and copies it where there is not, and says
 * which. A refusal says the node's own words, and nothing is copied: never a false success.
 *
 * The page shows ONE button, 🔗 Share (DESIGN-detail-pages-fable.md §2.5, slice DW2), which opens a small menu in the page's
 * flow (components/ShareMenu.tsx) with the ways this member has here, each with the sentence that says what it does, read
 * before the tap that shares. What a way leaves behind (a note, a link to copy by hand, the invite panel) shows under the row.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { INVITE_ASK_WORDS, PEEK_WORDS as W, shareSays, t, type ShareSaysKind } from '@beanpool/core';
import type { MarketplacePost } from '../lib/api';
import { useCommunityInfo } from '../lib/features';
import { useShareRole } from '../lib/use-share-role';
import { eventLink } from '../lib/event-extras';
import { makePeekLink } from '../lib/peek';
import { handOver } from '../lib/hand-over';
import { loadIdentity } from '../lib/identity';
import { useInviteAndShare } from './InviteAndShare';
import { AskSheet } from './InviteAsks';
import { nodeOrigin } from './EventExtras';
import { MenuChoices, useInFlowMenu, type MenuChoice, type SharePart } from './ShareMenu';

/** The quiet, neutral outline (DESIGN-detail-pages-fable.md §2.2): the page's own words on the card ground, no colour of its own. */
const QUIET_BUTTON ='min-h-[48px] px-3 rounded-xl border text-sm font-bold bg-white dark:bg-nature-900 cursor-pointer break-words '
    + 'border-nature-300 dark:border-nature-700 text-nature-900 dark:text-white '
    + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-600 dark:focus-visible:ring-nature-300 focus-visible:ring-offset-1 '
    + 'disabled:opacity-60 disabled:cursor-not-allowed';

const RETRY = `flex-1 min-w-[8rem] ${QUIET_BUTTON}`;

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
 * "Share outside the community": its choice in the Share menu, with the line that says what it does, and what became of
 * the tap. `offered` is the community's say and this post's (`shareableOutside`); not offered, no part at all.
 *
 * The node makes the link before it is handed over, so a hand-over that fails (no share sheet and no clipboard, or a
 * browser that refuses either once the tap has waited on the node: Safari's share() and clipboard need the tap itself)
 * leaves a live link, seven days and one of the member's 50. It is never lost: it is shown to copy by hand, and Try
 * again (or the choice again) hands the same link over inside that tap, with no wait before it; no second link is made.
 * A share sheet the member closed leaves one too: it is kept the same way, unshown, for the next tap. The kept link lives
 * here, not in the menu, so closing the menu loses nothing.
 */
function useShareOutside(post: MarketplacePost, offered: boolean, line: string | null): SharePart | null {
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
    // The link made but not handed over, for the post it was made for (the same part may be drawn for another post
    // next): `failed`, shown to copy by hand; or the share sheet was closed, kept unshown for the next tap.
    const [kept, setKept] = useState<{ postId: string; link: string; failed: boolean } | null>(null);
    if (!offered) return null;
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

    return {
        // ONE note before the tap: how long anyone with the link can read it, no names or faces, that it can be stopped, and
        // (where joining is on) that they can then ask to join.
        choice: { key: 'outside', testId: 'share-outside-button', label: t(W.shareOutside), line, lineTestId: 'share-outside-line', disabled: busy, onSelect: () => { void share(); } },
        after: (note || shownLink) && (
            <div data-testid="share-outside" className="flex flex-col gap-1">
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
                        <button type="button" data-testid="share-outside-retry" onClick={() => { void share(); }} disabled={busy} className={RETRY}>
                            {t('Try again')}
                        </button>
                    </div>
                )}
            </div>
        ),
    };
}

/**
 * "Ask an admin to invite someone", under the line "only admins invite here" (core shareSays showAskAdmin). Its choice in the
 * Share menu opens the ONE ask form People → Invites uses (components/InviteAsks.tsx AskSheet). Offered only to someone with a
 * key here (a guest has none). Once the node has taken the ask the member is told so, under the row.
 */
function useAskAdmin(offered: boolean): SharePart | null {
    const [hasKey, setHasKey] = useState(false);
    const [open, setOpen] = useState(false);
    const [sent, setSent] = useState(false);
    useEffect(() => {
        if (!offered) return;
        let cancelled = false;
        loadIdentity().then(id => { if (!cancelled) setHasKey(!!id); }).catch(() => { if (!cancelled) setHasKey(false); });
        return () => { cancelled = true; };
    }, [offered]);
    if (!offered || !hasKey) return null;
    return {
        choice: { key: 'ask', testId: 'share-ask-admin-button', label: t(INVITE_ASK_WORDS.button), onSelect: () => { setSent(false); setOpen(true); } },
        after: (sent || open) && (
            <div data-testid="share-ask-admin" className="flex flex-col gap-1">
                {sent && <p role="status" data-testid="share-ask-admin-note" className="m-0 text-sm font-semibold text-bp-ink-accent break-words">{t(INVITE_ASK_WORDS.waiting)}</p>}
                {open && <AskSheet onClose={() => setOpen(false)} onSent={() => { setOpen(false); setSent(true); }} />}
            </div>
        ),
    };
}

interface ShareOptions {
    kind: ShareSaysKind;
    /** Invite and share is a member's: a guest here, or one not yet known to be a member, is not offered it. (Omitted means a member.) */
    isMember?: boolean | null;
    /** The page's row decides how the button looks and what it is called in a test. */
    triggerClassName: string;
    triggerTestId: string;
    /** The sentence under Share with members keeps the name each page gave it. */
    membersLineTestId: string;
    /** What Share with members hands over, where the page has its own words for it (an event's title, when and place); it says what became of the tap itself. */
    shareWithMembers?: () => Promise<void> | void;
}

/**
 * The ONE Share button and its menu (DESIGN-detail-pages-fable.md §2.5, slice DW2), for a listing and for an event. The
 * button opens the menu in the page's flow; the menu holds the ways this member has here, in this order, each with the
 * sentence that says what it does (core shareSays, as before, and the same rows):
 *   1. Share with members (always: a menu of one is a plain confirmation, and the same door everywhere);
 *   2. Share outside the community, where the community allows it and this post may be;
 *   3. Invite and share, where this member may invite (its panel opens under the row);
 *   4. Ask an admin to invite someone, where only admins invite and this member is none (never beside 3).
 * Choosing one closes the menu; what it leaves (a note, a link to copy by hand, a panel) shows under the row. Nothing is made
 * until a choice is tapped: opening the menu is not sharing.
 *
 * The button, the open menu and what follows are returned apart, because the event page puts its button in a row with Add to
 * calendar and its menus under that row.
 */
export function useShare(post: MarketplacePost, opts: ShareOptions): { trigger: ReactNode; menu: ReactNode; after: ReactNode } {
    const info = useCommunityInfo();
    const role = useShareRole(info?.features);
    const says = shareSays(info?.features, role, opts.kind);
    const member = opts.isMember !== false && opts.isMember !== null;
    const menu = useInFlowMenu();
    const [note, setNote] = useState<string | null>(null);
    const shareWithMembers = async () => {
        const how = await handOver(post.title, eventLink(nodeOrigin(), post.id));
        setNote(how === 'copied' ? t('Link copied.') : how === 'failed' ? t('Could not copy the link.') : null);
    };
    const outside = useShareOutside(post, says.showShareOutside && shareableOutside(post), says.outsideLine && t(says.outsideLine));
    // ONE invite action (share-one-flow): Invite and share, where this member may invite and the line does not say only
    // admins do. Where only admins invite and this member is none, the line stands and one more choice, "Ask an admin to
    // invite someone", opens the ask form of People → Invites (#2775). Never both.
    const invite = useInviteAndShare(post, says.showInviteButton && member);
    const ask = useAskAdmin(says.showAskAdmin && member);

    // A choice closes the menu and then does its work, in the same tap: a share sheet may only be opened by the tap itself.
    const pick = (part: SharePart, returnFocus = true): MenuChoice => ({ ...part.choice, onSelect: () => { menu.close(returnFocus); part.choice.onSelect(); } });
    const choices: MenuChoice[] = [{
        key: 'members', testId: 'share-members-button', label: t(W.shareWithMembers), line: says.membersLine && t(says.membersLine), lineTestId: opts.membersLineTestId,
        onSelect: () => { menu.close(); void (opts.shareWithMembers ?? shareWithMembers)(); },
    }];
    if (outside) choices.push(pick(outside));
    if (invite) choices.push(pick(invite));
    // The ask form is a dialog that takes the focus itself.
    if (ask) choices.push(pick(ask, false));

    // The node is making a link: the menu has closed, so the button shows that something is under way.
    const busy = outside?.choice.disabled === true;
    return {
        trigger: (
            <button ref={menu.buttonRef} type="button" data-testid={opts.triggerTestId} onClick={menu.toggle} aria-expanded={menu.open} aria-haspopup="menu"
                aria-busy={busy || undefined} className={`${opts.triggerClassName}${busy ? ' opacity-60' : ''}`}>
                <span aria-hidden="true">🔗 </span>{t('Share')}
            </button>
        ),
        menu: menu.open && <MenuChoices menu={menu} label={t('Share')} choices={choices} />,
        after: (
            <>
                {note && <p role="status" data-testid="share-members-result" className="m-0 text-sm font-semibold text-bp-ink-accent break-words">{note}</p>}
                {outside?.after}
                {invite?.after}
                {ask?.after}
            </>
        ),
    };
}

/** A listing's Share: one button, and the menu of the ways this member has here. */
export function SharePostButtons({ post, isMember }: { post: MarketplacePost; isMember?: boolean | null }) {
    const share = useShare(post, {
        kind: post.type === 'event' ? 'event' : 'listing',
        isMember,
        triggerClassName: `w-full ${QUIET_BUTTON}`,
        triggerTestId: 'share-button',
        membersLineTestId: 'share-members-note',
    });
    return (
        <div data-testid="share-post" className="flex flex-col gap-2 mt-4">
            {share.trigger}
            {share.menu}
            {share.after}
        </div>
    );
}
