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
import type { OwnerUnlockQr } from '@beanpool/core';

type Found = { qr: OwnerUnlockQr; look: Extract<UnlockLookup, { kind: 'ok' }> };

function day(iso: string | undefined): string {
    if (!iso) return 'an unknown date';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const BTN = 'flex-grow basis-[140px] min-h-[48px] px-4 py-3 rounded-xl font-bold text-[15px] disabled:opacity-50';

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
    const community = look ? (look.sameCommunity ? (communityName || 'your community') : `community ${look.check.header.communityId.slice(0, 8)}`) : '';

    return (
        <div data-testid="owner-unlock-card" className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 p-4 space-y-3 mt-3">
            <div className="flex items-start gap-3 min-w-0">
                <span aria-hidden="true">📲</span>
                <div className="min-w-0">
                    <div className="font-bold text-[15px] text-nature-900 dark:text-white break-words">Take over or restore with this browser</div>
                    <div className="text-sm mt-0.5 leading-relaxed break-words text-nature-600 dark:text-nature-300">
                        If your main server is gone: paste the code from the standby's Settings, or from a server restoring a backup.
                    </div>
                </div>
            </div>

            {!open ? (
                <button type="button" onClick={() => setOpen(true)} className={`${BTN} w-full bg-emerald-700 text-white hover:bg-emerald-800`}>
                    Paste a code
                </button>
            ) : done && look ? (
                <div className="space-y-3" role="status">
                    <p className="p-3 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-200 font-semibold text-sm break-words">
                        {done === 'takeover'
                            ? `Unlocked. Now finish on ${look.host}'s screen: it shows what will happen, then “Take over now”.`
                            : `Unlocked. ${look.host} is restoring the backup and will restart by itself.`}
                    </p>
                    <button type="button" onClick={reset} className={`${BTN} w-full border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-100`}>Done</button>
                </div>
            ) : found && look ? (
                <div className="space-y-3">
                    <div className="font-bold text-[15px] text-nature-900 dark:text-white break-words">
                        {takeover ? `Take over ${community} on ${look.host}?` : `Restore ${community} on ${look.host}?`}
                    </div>
                    <p className="text-sm leading-relaxed text-nature-700 dark:text-nature-200 break-words">
                        {takeover
                            ? "Do this only if your main server is really down. That server then becomes your community's main server, with the same identity, owners and web address."
                            : `That server restores the backup locked ${day(look.described.restore?.backup?.createdAt ?? look.check.header.createdAt)} and becomes your community's server.`}
                    </p>
                    {takeover && look.described.takeover?.mainServerAnswers === true && (
                        <p role="alert" className="p-3 rounded-xl border-2 border-red-400 text-red-800 dark:text-red-200 text-sm font-semibold break-words">
                            Your main server still answers. Two servers with one identity will compete. Take over only if it is really gone, and never start it again.
                        </p>
                    )}
                    {(look.check.signer === 'other' || look.described.restore?.databaseOnly) && (
                        <p role="alert" className="p-3 rounded-xl border-2 border-red-400 text-nature-800 dark:text-nature-100 text-sm break-words">
                            This backup was locked by another machine, not your community's server. Only its database comes back, never keys or passwords from inside it.
                        </p>
                    )}
                    <ul className="m-0 p-3 list-none rounded-xl border border-nature-200 dark:border-nature-700 text-sm text-nature-800 dark:text-nature-100 space-y-1 break-words">
                        <li>Community: {community}</li>
                        <li>Server: {look.host}</li>
                        <li>Keys locked: {day(look.check.header.createdAt)}</li>
                    </ul>
                    <p className="text-xs leading-relaxed text-nature-500 dark:text-nature-400">
                        This browser opens its own key to the locked keys and hands it to that server, locked so only that server can read it. It never sees what is inside. For a community key-holder, the phone app is safer: it asks for the phone's own unlock first.
                    </p>
                    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300 break-words">{error}</p>}
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={onUnlock} disabled={busy} className={`${BTN} bg-emerald-700 text-white`}>
                            {busy ? 'Unlocking…' : takeover ? 'Unlock for the take-over' : 'Unlock the backup'}
                        </button>
                        <button type="button" onClick={reset} disabled={busy} className={`${BTN} border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-100`}>Not now</button>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    <label htmlFor="owner-unlock-code" className="block text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                        The code from the server's screen
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
                        placeholder="beanpool://unlock-keys?…"
                        className="w-full min-h-[96px] p-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-950 text-nature-900 dark:text-white text-sm break-all"
                    />
                    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300 break-words">{error}</p>}
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={onCheck} disabled={busy || !text.trim()} className={`${BTN} bg-emerald-700 text-white`}>
                            {busy ? 'Checking…' : 'Check the code'}
                        </button>
                        <button type="button" onClick={reset} disabled={busy} className={`${BTN} border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-100`}>Close</button>
                    </div>
                </div>
            )}
        </div>
    );
}
