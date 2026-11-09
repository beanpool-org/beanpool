/**
 * "Invited by" and "Brought in n people ›" on a member's profile, the web's (scratch/fable-design/
 * DESIGN-invites-vouching-review-fable.md §3 ask 2, slice I3; Marty, 10 Nov 2026). The phone's components/InvitedByCard.tsx
 * draws the same lines from the same core words (invitedByLines), so both apps read alike.
 *
 * The server decides who reads what (POST /api/trust/profile): every member reads the inviter, named with their role word,
 * unless the member switched it off (then only the member, owners, admins and the inviter do); `broughtIn` comes only to an
 * owner or admin, and to the member on their own profile. The branch itself is GET /api/invite/tree?root=, asked when
 * Brought in is opened.
 */
import { useState } from 'react';
import { invitedByLines, broughtInWords, broughtInRowWords, t, type InvitedBy } from '@beanpool/core';
import { getInviteTree } from '../lib/api';
import { tierWords } from '../lib/trust-tier';
import { MemberAvatar } from './MemberAvatar';
import { resolveAvatarUrl } from '../lib/avatar';

type Branch = { publicKey: string; callsign: string; joinedAt: string | null; status: string | null }[];

export function InvitedByCard({ vouchedInBy, broughtIn, isSelf, targetPubkey, onOpenProfile }: {
    vouchedInBy: InvitedBy | null | undefined;
    broughtIn?: number;
    isSelf: boolean;
    targetPubkey: string;
    onOpenProfile?: (pubkey: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [branch, setBranch] = useState<Branch | null | undefined>(undefined);
    const showsBroughtIn = typeof broughtIn === 'number';
    if (!vouchedInBy && !showsBroughtIn) return null;

    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && branch === undefined) {
            getInviteTree(targetPubkey)
                .then((tree) => {
                    const children = Array.isArray(tree) ? tree[0]?.children : null;
                    setBranch(Array.isArray(children)
                        ? children.map((c: any) => ({ publicKey: c.publicKey, callsign: c.callsign, joinedAt: c.joinedAt ?? null, status: c.status ?? null }))
                        : []);
                })
                .catch(() => setBranch(null));
        }
    };
    const lines = vouchedInBy
        ? invitedByLines(vouchedInBy, isSelf, vouchedInBy.kind === 'member' ? (tier) => tierWords(tier ?? '') : undefined)
        : null;
    const canOpen = (pk: string | null | undefined): pk is string => !!pk && !!onOpenProfile;
    const rowClass = 'w-full min-h-[44px] flex items-center gap-3 text-left bg-transparent border-none p-0';

    return (
        <div className="mx-4 mt-4 p-4 rounded-2xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 shadow-sm flex flex-col gap-2" data-testid="profile-invited-by">
            {vouchedInBy && lines && (() => {
                const body = (
                    <>
                        {vouchedInBy.kind === 'member' && vouchedInBy.publicKey ? (
                            <MemberAvatar avatarUrl={resolveAvatarUrl(vouchedInBy.avatarUrl ?? null)} callsign={vouchedInBy.callsign || '?'} pubkey={vouchedInBy.publicKey} size={32} />
                        ) : (
                            <span aria-hidden="true" className="w-8 h-8 shrink-0 rounded-full bg-nature-100 dark:bg-nature-800 flex items-center justify-center">{vouchedInBy.kind === 'card' ? '🎟️' : '🛡️'}</span>
                        )}
                        <span className="flex-1 min-w-0">
                            <span className="block text-sm font-bold text-nature-950 dark:text-white break-words">{lines.title}</span>
                            {lines.sub && <span className="block text-xs font-semibold text-nature-600 dark:text-nature-300 break-words">{lines.sub}</span>}
                        </span>
                        {vouchedInBy.kind === 'member' && canOpen(vouchedInBy.publicKey) && <span aria-hidden="true" className="text-nature-500 dark:text-nature-400">›</span>}
                    </>
                );
                return vouchedInBy.kind === 'member' && canOpen(vouchedInBy.publicKey)
                    ? <button type="button" className={`${rowClass} cursor-pointer`} onClick={() => onOpenProfile!(vouchedInBy.publicKey!)}>{body}</button>
                    : <div className={rowClass}>{body}</div>;
            })()}
            {showsBroughtIn && (
                <>
                    <button type="button" aria-expanded={open} onClick={toggle} className={`${rowClass} cursor-pointer`} data-testid="profile-brought-in">
                        <span aria-hidden="true" className="w-8 h-8 shrink-0 rounded-full bg-nature-100 dark:bg-nature-800 flex items-center justify-center">👥</span>
                        <span className="flex-1 min-w-0 text-sm font-bold text-nature-950 dark:text-white break-words">{broughtInWords(broughtIn!)}</span>
                    </button>
                    {open && (branch === undefined ? (
                        <p className="m-0 text-xs font-semibold text-nature-500 dark:text-nature-400">{t('Loading...')}</p>
                    ) : branch === null ? (
                        <p className="m-0 text-xs font-semibold text-nature-500 dark:text-nature-400">{t('Couldn’t load this list. Check your connection and try again.')}</p>
                    ) : branch.length === 0 ? (
                        <p className="m-0 text-xs font-semibold text-nature-500 dark:text-nature-400">{t('Nobody yet.')}</p>
                    ) : (
                        <ul className="m-0 p-0 list-none flex flex-col">
                            {branch.map((p) => {
                                const line = (
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-sm font-bold text-nature-950 dark:text-white truncate">{p.callsign}</span>
                                        <span className="block text-xs font-semibold text-nature-600 dark:text-nature-300 break-words">
                                            {broughtInRowWords(p.joinedAt, p.status)}
                                        </span>
                                    </span>
                                );
                                return (
                                    <li key={p.publicKey}>
                                        {canOpen(p.publicKey)
                                            ? <button type="button" className={`${rowClass} cursor-pointer py-1`} onClick={() => onOpenProfile!(p.publicKey)}>{line}<span aria-hidden="true" className="text-nature-500 dark:text-nature-400">›</span></button>
                                            : <div className={`${rowClass} py-1`}>{line}</div>}
                                    </li>
                                );
                            })}
                        </ul>
                    ))}
                </>
            )}
        </div>
    );
}
