/**
 * "Invite and share" on a listing or an event, beside the Share buttons (Marty, 3 Nov): one button that invites a friend and
 * brings them to that listing once they have joined. The phone's InviteAndShare on the web. It makes an ordinary invite (the
 * node makes the code), with the Vouch for them choice of the Invites page for someone who can vouch (None unless they
 * choose), and hands the browser's share sheet the listing's title and `{community}/?invite={code}&post={id}`, or copies it
 * where there is no sheet, and says which (lib/invite-and-share.ts).
 *
 * Drawn only where this member may invite: the community takes invites and its door lets them (an admin-only door asks their
 * role). Where they can't, nothing: asking an admin is another slice. An invite works once, for one person, and the line under
 * the button says so. With no answer from the community no offline ticket is made, and the member is told; a refusal says the
 * community's own words, and nothing is shared: never a false success. A link made but not copied is shown to copy by hand:
 * the invite is spent on whoever receives it, never lost.
 */
import { useEffect, useState } from 'react';
import { INVITE_SHARE_WORDS, offersInviteVouch, t, type VouchLevel } from '@beanpool/core';
import { getBalance, request } from '../lib/api';
import { useCommunityInfo } from '../lib/features';
import { loadIdentity, type BeanPoolIdentity } from '../lib/identity';
import { handOver } from '../lib/hand-over';
import { inviteAndShareLink, makeInviteForShare, offersInviteAndShare } from '../lib/invite-and-share';
import { onlyAdminsInvite, readInviteRole, type InviteRole } from '../lib/node-invites';
import { InviteVouchChoice } from './InviteVouchChoice';
import { nodeOrigin } from './EventExtras';

const BUTTON = 'w-full min-h-[48px] px-3 rounded-xl border text-sm font-bold bg-transparent cursor-pointer break-words '
    + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info focus-visible:ring-offset-1 '
    + 'border-bp-ink-info text-bp-ink-info disabled:opacity-60 disabled:cursor-not-allowed';

export function InviteAndShareButton({ post }: { post: { id: string; title: string } }) {
    const info = useCommunityInfo();
    const [identity, setIdentity] = useState<BeanPoolIdentity | null>(null);
    const [role, setRole] = useState<InviteRole | undefined>(undefined);
    const [canVouch, setCanVouch] = useState(false);
    const [open, setOpen] = useState(false);
    const [vouchLevel, setVouchLevel] = useState<VouchLevel | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
    // A link made but not copied: shown to copy by hand.
    const [kept, setKept] = useState<string | null>(null);

    const adminsOnly = onlyAdminsInvite(info);
    const vouchHere = (info?.features as { inviteVouch?: boolean } | undefined)?.inviteVouch === true;

    useEffect(() => {
        let cancelled = false;
        loadIdentity().then((id) => { if (!cancelled) setIdentity(id); }).catch(() => { if (!cancelled) setIdentity(null); });
        return () => { cancelled = true; };
    }, []);
    // Where only admins invite, this member's role, as the node says it. A refusal is an answer (no role); no answer at all
    // leaves it unknown, which counts as before: the node refuses a member's invite itself.
    useEffect(() => {
        if (!identity || !adminsOnly) return;
        let cancelled = false;
        request<{ role?: unknown }>('GET', '/api/node-admin/me')
            .then((body) => { if (!cancelled) setRole(readInviteRole(body?.role)); })
            .catch((e) => {
                const status = (e as { status?: unknown } | null)?.status;
                if (!cancelled && typeof status === 'number' && status < 500) setRole(null);
            });
        return () => { cancelled = true; };
    }, [identity, adminsOnly]);
    useEffect(() => {
        if (!identity || !vouchHere) return;
        let cancelled = false;
        getBalance(identity.publicKey).then((b) => { if (!cancelled) setCanVouch(b?.canVouch === true); }).catch(() => {});
        return () => { cancelled = true; };
    }, [identity, vouchHere]);

    if (!identity || !offersInviteAndShare({ info, role, hasKey: true, postId: post.id })) return null;
    const offersVouch = offersInviteVouch(info?.features, canVouch);

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
            const made = await makeInviteForShare(identity.publicKey, offersVouch ? vouchLevel : null);
            if (!made.ok) {
                setNote({ text: made.message, ok: false });
                return;
            }
            setVouchLevel(null);
            await finish(inviteAndShareLink(nodeOrigin(), made.code, post.id));
        } catch (e) {
            setNote({ text: (e as Error)?.message || t(INVITE_SHARE_WORDS.notMade), ok: false });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div data-testid="invite-and-share" className="flex flex-col gap-1">
            <button type="button" data-testid="invite-and-share-button" aria-expanded={open}
                onClick={() => { setOpen((o) => !o); setNote(null); }} className={BUTTON}>
                {t(INVITE_SHARE_WORDS.button)}
            </button>
            <p data-testid="invite-and-share-line" className="m-0 text-xs text-text-primary break-words">{t(INVITE_SHARE_WORDS.line)}</p>
            {open && (
                <div data-testid="invite-and-share-panel" className="rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 p-3">
                    <p className="m-0 mb-3 text-sm text-nature-950 dark:text-white break-words">{t(INVITE_SHARE_WORDS.panel)}</p>
                    {offersVouch && <InviteVouchChoice value={vouchLevel} onChange={setVouchLevel} />}
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
    );
}
