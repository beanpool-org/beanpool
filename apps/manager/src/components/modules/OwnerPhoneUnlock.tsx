import { useEffect, useState } from 'react';
import { generateOfflineQrUrl } from '../../lib/qr';

/**
 * The QR an owner scans with the BeanPool app to open this server's locked keys (sealed-keys.md §5.2, §6.2; slice 6).
 * Shared by "Take over with an owner's phone" (TakeoverPanel) and "Open with an owner's phone" when restoring a locked
 * backup (RestoreLockedBackup). The same code is shown as a link to copy: tapped on a phone it opens the app; pasted
 * into the web app (Settings → Take over or restore with this browser) it works there too.
 *
 * Nothing in it is secret: the server, a session number, the session's public key and which lock. The phone signs, and
 * only a key the lock names can open it.
 */

export interface OwnerPhoneSession {
    sessionId: string;
    expiresAt: number;
    qr: string;
    link: string;
    owners: string[];
    envelope: { envelopeId: string; sealedAt: string };
    /** A restore only: follows it after this server's admin password changes. */
    followToken?: string;
}

function minutesLeft(expiresAt: number, now: number): string {
    const s = Math.max(0, Math.round((expiresAt - now) / 1000));
    const m = Math.floor(s / 60);
    return m >= 1 ? `${m} min` : `${s} s`;
}

const WRAP: React.CSSProperties = { overflowWrap: 'anywhere' };

export function OwnerPhoneUnlock({ session, purpose }: { session: OwnerPhoneSession; purpose: 'takeover' | 'restore' }) {
    const [now, setNow] = useState(() => Date.now());
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    const img = generateOfflineQrUrl(session.qr);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(session.link);
            setCopied(true);
        } catch { /* the link is on screen to select by hand */ }
    };
    return (
        <div className="space-y-3 text-sm text-nature-200 min-w-0" data-testid="owner-phone-unlock" style={WRAP}>
            <p className="m-0">
                {purpose === 'takeover'
                    ? 'An owner opens the BeanPool app → Settings → Take over or restore with this phone, and scans this code.'
                    : 'An owner opens the BeanPool app → Settings → Take over or restore with this phone, and scans this code to open the backup.'}
                {' '}Their phone asks for its own unlock, then hands this server the key, locked so only this server can read it.
            </p>
            {img && (
                <div className="flex justify-center">
                    <img src={img} alt="Code for an owner's phone" className="w-56 h-56 max-w-full bg-white p-2 rounded-xl" />
                </div>
            )}
            <p className="m-0">Who can: <strong className="text-white">{session.owners.join(', ') || 'no owner'}</strong>.</p>
            <p className="m-0 text-nature-400" aria-live="polite">Waiting for the phone… this code works for {minutesLeft(session.expiresAt, now)}, once.</p>
            <details className="text-xs text-nature-400">
                <summary className="cursor-pointer min-h-[48px] flex items-center">On the owner's phone already, or using the web app?</summary>
                <p className="m-0 mt-1">Open this link on the phone, or paste it into the web app (Settings → Take over or restore with this browser):</p>
                <code className="block mt-2 p-2 rounded-lg bg-nature-950 border border-nature-800 text-[11px] text-nature-200 break-all select-all">{session.link}</code>
                <button type="button" onClick={copy} className="mt-2 min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold text-sm">
                    {copied ? 'Copied' : 'Copy the link'}
                </button>
            </details>
        </div>
    );
}
