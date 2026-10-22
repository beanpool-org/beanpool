/**
 * Settings → "Take over or restore with this browser" (sealed-keys.md §5.2, §6.2; slice 6). Logic: lib/takeover-unlock.ts.
 *
 * Owners only — as far as this browser knows: the silent open check (run here, and on the home screen) remembers that
 * this account is an owner, so the card stays when the main server is gone, which is when it matters. The owner pastes
 * the code a standby's (or a restoring server's) Settings shows, sees which community, which server and what will
 * happen, and unlocks. The browser hands that server the key to the community's locked keys, re-locked so only that
 * server can read it; it never sees what is inside. Nothing waits on this card.
 */
import { useEffect, useState } from 'react';
import {
    readLockPin, readUnlockPaste, pasteProblemMessage, lookupUnlock, approveUnlock, runLockOpenCheck,
    type UnlockLookup,
} from '../lib/takeover-unlock';
import { formatDate, t, type OwnerUnlockQr } from '@beanpool/core';
import { keyLineWords } from './key-lines';

type Found = { qr: OwnerUnlockQr; look: Extract<UnlockLookup, { kind: 'ok' }> };

/**
 * When the keys or the backup were locked, in the member's language ("20 Oct 2026, 9:05", as the phone's unlock-keys
 * says it); null when the server gave no date, and each sentence then says "an unknown date" whole.
 */
function day(iso: string | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : t('{date}, {time}', { date: formatDate(d, 'day-month-year'), time: formatDate(d, 'time') });
}

const BTN = 'flex-grow basis-[140px] min-h-[48px] px-4 py-3 rounded-xl font-bold text-[15px] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1';
const UNLOCK_KEYS_PLACEHOLDER = 'beanpool://unlock-keys?…';

export function OwnerUnlockCard({ identity, communityName }: {
    identity: { publicKey: string; privateKey: string } | null;
    communityName?: string;
}) {
    const [owner, setOwner] = useState(() => (identity ? !!readLockPin(identity.publicKey)?.owner : false));
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [found, setFound] = useState<Found | null>(null);
    const [done, setDone] = useState<'takeover' | 'restore' | null>(null);

    useEffect(() => {
        if (!identity) return;
        let cancelled = false;
        void runLockOpenCheck(identity).then(() => {
            if (!cancelled) setOwner(!!readLockPin(identity.publicKey)?.owner);
        });
        return () => { cancelled = true; };
    }, [identity]);

    if (!identity || !owner) return null;

    const reset = () => { setText(''); setError(null); setFound(null); setDone(null); setOpen(false); };

    const onCheck = async () => {
        setError(null);
        const paste = readUnlockPaste(text);
        if (paste.kind !== 'ok') { setError(pasteProblemMessage(paste.kind)); return; }
        setBusy(true);
        const look = await lookupUnlock(paste.qr, identity, readLockPin(identity.publicKey));
        setBusy(false);
        if (look.kind !== 'ok') { setError(look.message); return; }
        setFound({ qr: paste.qr, look });
    };

    const onUnlock = async () => {
        if (!found) return;
        setBusy(true);
        setError(null);
        const out = await approveUnlock(found.qr, found.look.check, identity);
        setBusy(false);
        if (out.kind === 'unlocked') setDone(out.purpose);
        else setError(out.message);
    };

    const look = found?.look;
    const takeover = look?.described.purpose === 'takeover';
    // Which community, as the phone's unlock-keys says it: this one by its name (or "your community"), another by its id.
    const named = look?.sameCommunity ? communityName || null : null;
    const otherId = look && !look.sameCommunity ? look.check.header.communityId.slice(0, 8) : '';
    const host = look?.host ?? '';
    const backupLocked = look ? day(look.described.restore?.backup?.createdAt ?? look.check.header.createdAt) : null;
    const keysLocked = look ? day(look.check.header.createdAt) : null;

    return (
        <div data-testid="owner-unlock-card" className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 p-4 space-y-3 mt-3">
            <div className="flex items-start gap-3 min-w-0">
                <span aria-hidden="true">📲</span>
                <div className="min-w-0">
                    <div className="font-bold text-[15px] text-nature-900 dark:text-white break-words">{t('Take over or restore with this browser')}</div>
                    <div className="text-sm mt-0.5 leading-relaxed break-words text-nature-600 dark:text-nature-300">
                        {t("If your main server is gone: paste the code from the standby's Settings, or from a server restoring a backup.")}
                    </div>
                </div>
            </div>

            {!open ? (
                <button type="button" onClick={() => setOpen(true)} className={`${BTN} w-full bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on`}>
                    {t('Paste a code')}
                </button>
            ) : done && look ? (
                <div className="space-y-3" role="status">
                    <p className="p-3 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-200 font-semibold text-sm break-words">
                        {done === 'takeover'
                            ? t("Unlocked. Now finish on {host}'s screen: it shows what will happen, then “Take over now”.", { host })
                            : t('Unlocked. {host} is restoring the backup and will restart by itself.', { host })}
                    </p>
                    <button type="button" onClick={reset} className={`${BTN} w-full border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-100`}>{t('Done')}</button>
                </div>
            ) : found && look ? (
                <div className="space-y-3">
                    <div className="font-bold text-[15px] text-nature-900 dark:text-white break-words">
                        {look.sameCommunity
                            ? (named
                                ? (takeover ? t('Take over {name} on {host}?', { name: named, host }) : t('Restore {name} on {host}?', { name: named, host }))
                                : (takeover ? t('Take over your community on {host}?', { host }) : t('Restore your community on {host}?', { host })))
                            : (takeover ? t('Take over community {id} on {host}?', { id: otherId, host }) : t('Restore community {id} on {host}?', { id: otherId, host }))}
                    </div>
                    <p className="text-sm leading-relaxed text-nature-700 dark:text-nature-200 break-words">
                        {takeover
                            ? t("Do this only if your main server is really down. That server then becomes your community's main server, with the same identity, owners and web address.")
                            : backupLocked
                                ? t("That server restores the backup locked {date} and becomes your community's server.", { date: backupLocked })
                                : t("That server restores the backup locked an unknown date and becomes your community's server.")}
                    </p>
                    {takeover && look.described.takeover?.mainServerAnswers === true && (
                        <p role="alert" className="p-3 rounded-xl border-2 border-red-400 text-red-800 dark:text-red-200 text-sm font-semibold break-words">
                            {t('Your main server still answers. Two servers with one identity will compete. Take over only if it is really gone, and never start it again.')}
                        </p>
                    )}
                    {(look.check.signer === 'other' || look.described.restore?.databaseOnly) && (
                        <p role="alert" className="p-3 rounded-xl border-2 border-red-400 text-nature-800 dark:text-nature-100 text-sm break-words">
                            {t("This backup was locked by another machine, not your community's server. Only its database comes back, never keys or passwords from inside it.")}
                        </p>
                    )}
                    <ul className="m-0 p-3 list-none rounded-xl border border-nature-200 dark:border-nature-700 text-sm text-nature-800 dark:text-nature-100 space-y-1 break-words">
                        <li>{look.sameCommunity ? (named ? t('Community: {name}', { name: named }) : t('Community: your community')) : t('Community: community {id}', { id: otherId })}</li>
                        <li>{t('Server: {host}', { host })}</li>
                        <li>{keysLocked ? t('Keys locked: {date}', { date: keysLocked }) : t('Keys locked: an unknown date')}</li>
                    </ul>
                    <p className="text-xs leading-relaxed text-nature-500 dark:text-nature-400">
                        {t("This browser opens its own key to the locked keys and hands it to that server, locked so only that server can read it. It never sees what is inside. For a community key-holder, the phone app is safer: it asks for the phone's own unlock first.")}
                    </p>
                    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300 break-words">{keyLineWords(error)}</p>}
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={onUnlock} disabled={busy} className={`${BTN} bg-bp-commit-fill text-bp-commit-on`}>
                            {busy ? t('Unlocking…') : takeover ? t('Unlock for the take-over') : t('Unlock the backup')}
                        </button>
                        <button type="button" onClick={reset} disabled={busy} className={`${BTN} border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-100`}>{t('Not now')}</button>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    <label htmlFor="owner-unlock-code" className="block text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                        {t("The code from the server's screen")}
                    </label>
                    <textarea
                        id="owner-unlock-code"
                        value={text}
                        onChange={(e) => { setText(e.target.value); setError(null); }}
                        rows={3}
                        disabled={busy}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        placeholder={UNLOCK_KEYS_PLACEHOLDER}
                        className="w-full min-h-[96px] p-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-950 text-nature-900 dark:text-white text-sm break-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    />
                    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300 break-words">{keyLineWords(error)}</p>}
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={onCheck} disabled={busy || !text.trim()} className={`${BTN} bg-bp-commit-fill text-bp-commit-on`}>
                            {busy ? t('Checking…') : t('Check the code')}
                        </button>
                        <button type="button" onClick={reset} disabled={busy} className={`${BTN} border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-100`}>{t('Close')}</button>
                    </div>
                </div>
            )}
        </div>
    );
}
