/**
 * "Invite and share" on a listing or an event, beside the Share buttons (Marty, 3 Nov): one button that invites a friend and
 * brings them to that listing once they have joined. The phone's InviteAndShare on the web. It makes an ordinary invite (the
 * node makes the code), and hands the browser's share sheet the listing's title and `{community}/?invite={code}&post={id}`,
 * or copies it where there is no sheet, and says which (lib/invite-and-share.ts).
 *
 * Offered only where this member may invite: the community takes invites and its door lets them (an admin-only door asks their
 * role). Where they can't, nothing: asking an admin is another slice. An invite works once, for one person, and the line under
 * its name in the Share menu says so (components/SharePost.tsx). Its panel opens under the row, not in the menu. With no
 * answer from the community no offline ticket is made, and the member is told; a refusal says the community's own words, and
 * nothing is shared: never a false success. A link made but not copied is shown to copy by hand: the invite is spent on
 * whoever receives it, never lost.
 */
import { useEffect, useState } from 'react';
import { INVITE_SHARE_WORDS, t } from '@beanpool/core';
import { getMyVouching, request, type MyVouching } from '../lib/api';
import { useCommunityInfo } from '../lib/features';
import { loadIdentity, type BeanPoolIdentity } from '../lib/identity';
import { handOver } from '../lib/hand-over';
import { inviteAndShareLink, makeInviteForShare, offersInviteAndShare } from '../lib/invite-and-share';
import { onlyAdminsInvite, readInviteRole, roleReadRefused, type InviteRole } from '../lib/node-invites';
import { nodeOrigin } from './EventExtras';
import { VouchPresetChoice } from './VouchPresetChoice';
import type { SharePart } from './ShareMenu';

/**
 * "Invite and share": its choice in the Share menu, and the panel, note and link it leaves under the row. `offered` is the
 * community's say and the member's standing (core shareSays showInviteButton); this part then asks for the member's key and
 * role, and is none at all where `offersInviteAndShare` says no. Nothing is asked of the node while it is not offered.
 */
export function useInviteAndShare(post: { id: string; title: string }, offered: boolean): SharePart | null {
    const info = useCommunityInfo();
    const [identity, setIdentity] = useState<BeanPoolIdentity | null>(null);
    const [role, setRole] = useState<InviteRole | undefined>(undefined);
    const [myVouching, setMyVouching] = useState<MyVouching | null>(null);
    const [vouchPreset, setVouchPreset] = useState<number | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
    // A link made but not copied: shown to copy by hand.
    const [kept, setKept] = useState<string | null>(null);

    const adminsOnly = onlyAdminsInvite(info);

    useEffect(() => {
        if (!offered) return;
        let cancelled = false;
        loadIdentity().then((id) => {
            if (!cancelled) {
                setIdentity(id);
                if (id) {
                    getMyVouching().then((mv) => { if (!cancelled) setMyVouching(mv); }).catch(() => {});
                }
            }
        }).catch(() => { if (!cancelled) setIdentity(null); });
        return () => { cancelled = true; };
    }, [offered]);
    // Where only admins invite, this member's role, as the node says it. A refusal is an answer (no role); no answer at all
    // leaves it unknown, which counts as before: the node refuses a member's invite itself.
    useEffect(() => {
        if (!offered || !identity || !adminsOnly) return;
        let cancelled = false;
        request<{ role?: unknown }>('GET', '/api/node-admin/me')
            .then((body) => { if (!cancelled) setRole(readInviteRole(body?.role)); })
            .catch((e) => { if (!cancelled && roleReadRefused(e)) setRole(null); });
        return () => { cancelled = true; };
    }, [offered, identity, adminsOnly]);

    if (!offered || !identity || !offersInviteAndShare({ info, role, hasKey: true, postId: post.id })) return null;

    const finish = async (link: string) => {
        const how = await handOver(post.title, link);
        if (how === 'failed') {
            setKept(link);
            setNote({ text: t('Could not copy the link.'), ok: false });
            return;
        }
        setKept(null);
        setOpen(false);
        if (how === 'copied') setNote({ text: t('Link copied.'), ok: true });
    };

    const make = async () => {
        setBusy(true);
        setNote(null);
        try {
            const chosenVouch = myVouching?.voucher ? vouchPreset : null;
            const made = await makeInviteForShare(identity.publicKey, undefined, chosenVouch ?? undefined);
            if (!made.ok) {
                setNote({ text: made.message, ok: false });
                return;
            }
            setVouchPreset(null);
            await finish(inviteAndShareLink(nodeOrigin(), made.code, post.id));
        } catch (e) {
            setNote({ text: (e as Error)?.message || t(INVITE_SHARE_WORDS.notMade), ok: false });
        } finally {
            setBusy(false);
        }
    };

    return {
        choice: {
            key: 'invite', testId: 'invite-and-share-button', label: t(INVITE_SHARE_WORDS.button), line: t(INVITE_SHARE_WORDS.line), lineTestId: 'invite-and-share-line',
            expanded: open, onSelect: () => { setOpen((o) => !o); setNote(null); },
        },
        after: (open || note || kept) && (
            <div data-testid="invite-and-share" className="flex flex-col gap-1">
                {open && (
                    <div data-testid="invite-and-share-panel" className="rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 p-3">
                        <p className="m-0 mb-3 text-sm text-nature-950 dark:text-white break-words">{t(INVITE_SHARE_WORDS.panel)}</p>
                        {myVouching?.voucher && (
                            <div className="mb-3">
                                <VouchPresetChoice
                                    value={vouchPreset}
                                    onChange={setVouchPreset}
                                    budgetLeft={myVouching.budget?.left ?? 0}
                                    budgetTotal={myVouching.budget?.level ?? 0}
                                />
                            </div>
                        )}
                        <button type="button" data-testid="invite-and-share-make" onClick={make} disabled={busy}
                            className="w-full min-h-[48px] px-3 rounded-xl border-0 text-sm font-bold cursor-pointer break-words bg-bp-commit-fill text-bp-commit-on disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1">
                            {t(INVITE_SHARE_WORDS.make)}
                        </button>
                    </div>
                )}
                {note && (
                    <p role={note.ok ? 'status' : 'alert'} data-testid="invite-and-share-note"
                        className={`m-0 text-sm font-semibold break-words ${note.ok ? 'text-bp-ink-accent' : 'text-red-700 dark:text-red-300'}`}>
                        {note.text}
                    </p>
                )}
                {kept && (
                    <input type="text" readOnly value={kept} data-testid="invite-and-share-link" aria-label={t('The link to share')}
                        onFocus={(e) => e.currentTarget.select()}
                        className="min-h-[48px] px-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-950 text-nature-950 dark:text-white text-sm" />
                )}
            </div>
        ),
    };
}
