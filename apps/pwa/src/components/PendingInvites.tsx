/**
 * Invites → the invites a member has made, said in words (invites-vouching slice I1; DESIGN-invites-vouching-review-fable.md §3
 * asks 3 and 5; the phone's twin is apps/native/components/InviteRows.tsx). Marty, 10 Nov: a bound invite showed as a bare
 * code, so a second, plain one was made for the same person. Now:
 *
 *   Pending (n) ›  and  Joined (n) ›   folded, closed until opened (and kept open for the session once opened), count in the row
 *   each Pending row   who it is for (the note, else the code; "Name on the phone" for an invite bound to the names list, whose
 *                      names are opened on a phone that holds the list's keys), what it carries ("200 vouch · voucher budget
 *                      1,000 · confirms them as known"), "23 days left" (red at 3 or fewer)
 *   the whole row      opens the invite: its QR, its code and Share
 *   the made card      "Invite for … · 200 vouch · 30 days left" and Share
 *   Revoke (I2)        on an open invite and the made card: a first tap shows the design's words in place (core inviteRevokeAsk)
 *                      with Revoke and Cancel; the caller revokes it on the community. Never on an offline ticket (inviteRevocable).
 *
 * The words are core's (invite-rows.ts), the same as the phone's. Every control is at least 44 px tall and wraps at 320 px
 * with 1.3x text; colours are the central tokens, light and dark.
 */
import { useRef, useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
    formatDate, inviteCarries, inviteFolds, inviteMadeTitle, inviteRevocable, inviteRevokeAsk, inviteRevokeWords, inviteTimeLeft, inviteWho, joinedHeading,
    joinedInvites, pendingHeading, pendingInvites, t, type InviteRowSource,
} from '@beanpool/core';
import { useDialogFocus } from './dialog-focus';

const QRCodeSVGComponent = QRCodeSVG as any;

/** A fold's open state: closed at first, kept for the session (core inviteFolds). */
function useFold(key: string): [boolean, () => void] {
    const [open, setOpen] = useState(() => inviteFolds.isOpen(key));
    return [open, () => { inviteFolds.set(key, !open); setOpen(!open); }];
}

const dayWords = (iso: string | null | undefined): string => {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime()) ? formatDate(d, 'day-month-year') : '';
};

/** The three lines of an invite: who, what it carries, how long. A name needs the names list's key, which only a phone holds. */
function InviteLines({ inv, now }: { inv: InviteRowSource; now: number }) {
    const left = inviteTimeLeft(inv, now);
    return (
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-[15px] font-bold text-nature-950 dark:text-white break-words" data-testid="invite-who">{inviteWho(inv, { nameOnPhone: true })}</span>
            <span className="text-[13px] leading-snug text-nature-600 dark:text-nature-300 break-words" data-testid="invite-carries">{inviteCarries(inv)}</span>
            {left && (
                <span
                    className={`text-[12px] font-bold ${left.urgent ? 'text-bp-ink-danger' : 'text-nature-500 dark:text-nature-300'}`}
                    data-testid="invite-left"
                >
                    {left.text}
                </span>
            )}
        </div>
    );
}

/**
 * Revoke, asked in place: the first tap shows the design's words (the name stays on the names list, for a bound invite: the
 * web holds no list key, so "The name") with Revoke and Cancel. `onRevoke` resolves null once revoked, or the sentence to show.
 */
export function RevokeInvite({ inv, onRevoke, testId = 'invite-revoke' }: { inv: InviteRowSource; onRevoke: (inv: InviteRowSource) => Promise<string | null>; testId?: string }) {
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    const words = inviteRevokeAsk(inv, null);
    const go = async () => {
        setBusy(true);
        setRefused(null);
        const said = await onRevoke(inv).catch(() => inviteRevokeWords.failed());
        setBusy(false);
        if (said) setRefused(said);
        else setAsking(false);
    };
    if (!asking) {
        return (
            <button
                type="button"
                onClick={() => setAsking(true)}
                className="w-full min-h-[44px] py-2 px-4 rounded-xl border border-bp-ink-danger bg-transparent text-bp-ink-danger font-bold cursor-pointer"
                data-testid={testId}
            >
                {inviteRevokeWords.revoke()}
            </button>
        );
    }
    return (
        <div role="group" aria-label={words.title} className="w-full flex flex-col gap-2 p-3 rounded-xl border border-nature-200 dark:border-nature-700 text-left" data-testid={`${testId}-ask`}>
            <p className="m-0 text-[15px] font-bold text-nature-950 dark:text-white break-words">{words.title}</p>
            <p className="m-0 text-[13px] leading-snug text-nature-600 dark:text-nature-300 break-words">{words.body}</p>
            {refused && <p role="alert" className="m-0 text-[13px] font-bold text-bp-ink-danger break-words" data-testid={`${testId}-refused`}>{refused}</p>}
            <div className="flex gap-2 flex-wrap">
                <button
                    type="button"
                    onClick={go}
                    disabled={busy}
                    className="flex-1 min-w-[120px] min-h-[44px] py-2 px-4 rounded-xl border-none bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on font-bold cursor-pointer disabled:opacity-60"
                    data-testid={`${testId}-confirm`}
                >
                    {busy ? inviteRevokeWords.revoking() : inviteRevokeWords.revoke()}
                </button>
                <button
                    type="button"
                    onClick={() => { setAsking(false); setRefused(null); }}
                    disabled={busy}
                    className="flex-1 min-w-[120px] min-h-[44px] py-2 px-4 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white font-bold cursor-pointer"
                    data-testid={`${testId}-cancel`}
                >
                    {inviteRevokeWords.cancel()}
                </button>
            </div>
        </div>
    );
}

function InviteDialog({ inv, now, link, share, onClose, onRevoke }: {
    inv: InviteRowSource; now: number; link: string; share: ReactNode; onClose: () => void; onRevoke?: (inv: InviteRowSource) => Promise<string | null>;
}) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose, { initialFocus: () => dialog.current?.querySelector<HTMLElement>('[data-testid="invite-sheet-close"]') });
    return (
        <div
            ref={dialog}
            className="fixed inset-0 z-[320] flex items-center justify-center p-4 bg-black/50"
            role="dialog"
            aria-modal="true"
            aria-label={inviteWho(inv, { nameOnPhone: true })}
            data-testid="invite-sheet"
            onClick={onClose}
        >
            <div
                className="w-full max-w-[420px] max-h-[90vh] overflow-y-auto p-5 rounded-2xl bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 shadow-xl flex flex-col gap-4"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex"><InviteLines inv={inv} now={now} /></div>
                {/* The QR code keeps its white quiet zone in dark mode too: a phone camera cannot read it on a dark ground. */}
                <div className="self-center bg-white dark:bg-white rounded-xl p-4 shadow-sm">
                    <QRCodeSVGComponent value={link} size={180} />
                </div>
                <p className="m-0 text-center font-mono text-[13px] font-semibold text-nature-950 dark:text-white break-all" title={inv.code}>{inv.code}</p>
                {share}
                {onRevoke && inviteRevocable(inv) && <RevokeInvite inv={inv} onRevoke={onRevoke} />}
                <button
                    type="button"
                    onClick={onClose}
                    className="w-full min-h-[44px] py-2 px-4 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white font-bold cursor-pointer"
                    data-testid="invite-sheet-close"
                >
                    {t('Close')}
                </button>
            </div>
        </div>
    );
}

export interface PendingInvitesProps {
    /** Every invite the member has made: the node's, and any offline tickets this browser made. */
    invites: readonly InviteRowSource[];
    now: number;
    /** What the QR of an open invite holds: its link. */
    linkFor: (code: string) => string;
    /** The Share button for an open invite (or, where invites are only previewed, the marker that says so). */
    shareFor: (code: string) => ReactNode;
    /** Revoke an open invite on the community (I2): null once gone (the dialog closes), else the sentence to show. */
    onRevoke?: (inv: InviteRowSource) => Promise<string | null>;
}

export function PendingInvites({ invites, now, linkFor, shareFor, onRevoke }: PendingInvitesProps) {
    const [pendingOpen, togglePending] = useFold('pending');
    const [joinedOpen, toggleJoined] = useFold('joined');
    const [openCode, setOpenCode] = useState<string | null>(null);
    const pending = pendingInvites(invites, now);
    const joined = joinedInvites(invites);
    const opened = openCode ? pending.find((i) => i.code === openCode) ?? null : null;

    const fold = (label: string, open: boolean, toggle: () => void, testId: string) => (
        <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="w-full min-h-[44px] py-2 flex items-center justify-between gap-2 border-0 bg-transparent cursor-pointer text-left"
            data-testid={testId}
        >
            <span className="text-[13px] font-bold text-nature-500 dark:text-nature-300 uppercase tracking-wider break-words">{label}</span>
            <span aria-hidden="true" className="text-nature-400 dark:text-nature-300 font-bold">{open ? '⌄' : '›'}</span>
        </button>
    );

    return (
        <>
            {pending.length > 0 && (
                <div className="mb-4">
                    {fold(pendingHeading(pending.length), pendingOpen, togglePending, 'invites-pending-fold')}
                    {pendingOpen && pending.map((inv) => (
                        <button
                            key={inv.code}
                            type="button"
                            onClick={() => setOpenCode(inv.code)}
                            className="w-full min-h-[56px] mb-3 p-4 flex items-center gap-2 text-left rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 shadow-sm cursor-pointer"
                            data-testid="invite-pending-row"
                        >
                            <InviteLines inv={inv} now={now} />
                            <span aria-hidden="true" className="text-nature-400 dark:text-nature-300 font-bold">›</span>
                        </button>
                    ))}
                </div>
            )}

            {joined.length > 0 && (
                <div className="mb-4">
                    {fold(joinedHeading(joined.length), joinedOpen, toggleJoined, 'invites-joined-fold')}
                    {joinedOpen && joined.map((inv) => {
                        const who = inviteWho(inv, { nameOnPhone: true });
                        return (
                            <div
                                key={inv.code}
                                className="mb-3 p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50 dark:bg-nature-950 opacity-90 flex flex-col gap-0.5"
                                data-testid="invite-joined-row"
                            >
                                <span className="text-[15px] font-bold text-nature-950 dark:text-white break-words">{inv.usedByCallsign ? `${who} · @${inv.usedByCallsign}` : who}</span>
                                {inv.usedAt && <span className="text-[13px] text-nature-600 dark:text-nature-300">{t('Joined {date}', { date: dayWords(inv.usedAt) })}</span>}
                            </div>
                        );
                    })}
                </div>
            )}

            {opened && (
                <InviteDialog
                    inv={opened}
                    now={now}
                    link={linkFor(opened.code)}
                    share={shareFor(opened.code)}
                    onClose={() => setOpenCode(null)}
                    onRevoke={onRevoke && (async (i) => {
                        const said = await onRevoke(i);
                        if (!said) setOpenCode(null);
                        return said;
                    })}
                />
            )}
        </>
    );
}

/** After Generate: who the invite is for, what it carries, how long it lasts, its QR, Share and Revoke. */
export function InviteMadeCard({ who, invite, now, link, actions, testId, onRevoke }: {
    who: string | null; invite: InviteRowSource; now: number; link: string; actions: ReactNode; testId?: string;
    /** Revoke it on the community (I2): null once gone, else the sentence to show. None in a preview. */
    onRevoke?: (inv: InviteRowSource) => Promise<string | null>;
}) {
    const left = inviteTimeLeft(invite, now);
    return (
        <div className="bg-oat-50 dark:bg-nature-950 border-2 border-emerald-500 rounded-2xl p-6 text-center mb-6 shadow-md flex flex-col items-center gap-1.5" data-testid={testId ?? 'invite-made-card'}>
            <p className="m-0 text-base font-extrabold text-nature-950 dark:text-white break-words" data-testid="invite-made-title">{inviteMadeTitle(who)}</p>
            <p className="m-0 text-[13px] leading-snug text-nature-600 dark:text-nature-300 break-words" data-testid="invite-made-carries">{inviteCarries(invite)}</p>
            {left && <p className="m-0 text-[13px] text-nature-600 dark:text-nature-300" data-testid="invite-made-left">{left.text}</p>}
            <p className="m-0 mt-2 font-mono text-xl font-bold tracking-widest text-nature-950 dark:text-white break-all" title={invite.code}>
                {invite.code.length > 20 ? `${invite.code.substring(0, 16)}...` : invite.code.toUpperCase()}
            </p>
            {/* White in dark mode too, for the same reason: the QR code needs its quiet zone to scan. */}
            <div className="bg-white dark:bg-white rounded-xl p-4 inline-block my-3 shadow-sm max-w-full">
                <QRCodeSVGComponent value={link} size={200} className="block max-w-full h-auto" />
            </div>
            <div className="flex gap-3 justify-center flex-wrap">{actions}</div>
            {onRevoke && inviteRevocable(invite) && <div className="w-full mt-2"><RevokeInvite inv={invite} onRevoke={onRevoke} testId="invite-made-revoke" /></div>}
        </div>
    );
}
