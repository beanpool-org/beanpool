import { useEffect, useRef, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';
import { restoreShortfall, shortfallSuffix } from '../../lib/backup-shortfall';
import { OwnerPhoneUnlock, type OwnerPhoneSession } from './OwnerPhoneUnlock';

/**
 * Restore → a locked backup (`.bpsealed`, sealed-keys.md §6.2). The server has read the file's public header and said
 * who can open it; this asks for one of them: the printed recovery code (slice 3's X-Recovery-Code), or an owner's
 * phone (slice 6: the file waits on the server, the owner scans a QR, the phone opens it for this server). A backup's
 * keys bring back the community's admin password, so this server's own stops working part-way: the phone path follows
 * the restore with the one-time follow token the upload answered, and says "restarting" when the server goes quiet.
 */

export interface LockedBackupInfo {
    envelopeId?: string;
    createdAt?: string;
    opensWith?: string;
}

function day(iso: string | undefined): string {
    if (!iso) return 'an unknown date';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const BTN = 'min-h-[48px] px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50';

export function RestoreLockedBackup({ activeNode, file, backup, canUseCode, canUsePhone, onDone, onCancel, pollMs = 2000 }: {
    activeNode: NodeProfile;
    file: File;
    backup: LockedBackupInfo;
    canUseCode: boolean;
    canUsePhone: boolean;
    onDone: (message: string) => void;
    onCancel: () => void;
    pollMs?: number;
}) {
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [phone, setPhone] = useState<OwnerPhoneSession | null>(null);
    const [restarting, setRestarting] = useState(false);
    const restartingRef = useRef(false);
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    /**
     * What a restore that did not come back whole has to say. Shared with `ApplianceSection`'s own restore
     * path (`../../lib/backup-shortfall`), which takes the same answer from the same route.
     *
     * A restore that is short of photos still answers `success: true` — the database IS in and the node IS
     * restarting — so the only place the operator can learn of it is here. Without it they find out at the
     * first 503.
     */
    const shortfall = (body: unknown): string => shortfallSuffix(restoreShortfall(body));

    const upload = async (extra: Record<string, string>) => {
        const headers = buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id));
        delete headers['Content-Type'];
        const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/restore'), {
            method: 'POST', headers: { ...headers, ...extra }, body: file,
        });
        return { res, data: await res.json().catch(() => ({})) };
    };

    const openWithCode = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const { res, data } = await upload({ 'X-Recovery-Code': code });
            if (res.ok) onDone('Backup restored. The server restarts to load it; sign in again with the community\'s admin password.' + shortfall(data));
            else setError(typeof data.error === 'string' ? data.error : `The server answered HTTP ${res.status}.`);
        } catch (err: unknown) {
            setError(`The server did not answer: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusy(false);
        }
    };

    const openWithPhone = async () => {
        setBusy(true);
        setError(null);
        try {
            const { res, data } = await upload({ 'X-Unlock-With': 'phone', 'X-Unlock-Server-Url': activeNode.url });
            if (res.status === 202 && data.phone) setPhone(data.phone as OwnerPhoneSession);
            else setError(typeof data.error === 'string' ? data.error : `The server answered HTTP ${res.status}.`);
        } catch (err: unknown) {
            setError(`The server did not answer: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        if (!phone) return;
        let cancelled = false;
        let t: ReturnType<typeof setTimeout> | null = null;
        const tick = async () => {
            try {
                const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/restore/phone/wait'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Unlock-Follow': phone.followToken || '' },
                    body: JSON.stringify({ sessionId: phone.sessionId }),
                });
                const data = await res.json().catch(() => ({}));
                if (cancelled) return;
                if (data.state === 'restored') {
                    onDoneRef.current(`Backup restored, opened by ${data.unlockedBy}'s phone. The server restarts to load it; sign in again with the community's admin password.${shortfall(data.result)}`);
                    return;
                }
                if (data.state === 'failed') { setError(data.error || 'The restore failed.'); setPhone(null); return; }
                if (data.state === 'expired' || data.state === 'closed' || data.state === 'gone' || res.status === 401) {
                    // After the restore the server restarts and forgets the session: that is not a failure to report.
                    if (restartingRef.current) { onDoneRef.current('The server restarted with the restored backup. Sign in again with the community\'s admin password.'); return; }
                    setError('The code ran out before a phone used it. Try again.');
                    setPhone(null);
                    return;
                }
            } catch {
                // Quiet: the server is restarting after the restore.
                restartingRef.current = true;
                setRestarting(true);
            }
            if (!cancelled) t = setTimeout(tick, pollMs);
        };
        t = setTimeout(tick, pollMs);
        return () => { cancelled = true; if (t) clearTimeout(t); };
    }, [phone, activeNode.url, pollMs]);

    const cancel = () => {
        if (phone) {
            void fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/unlock/cancel'), {
                method: 'POST', headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ password: activeNode.adminPassword, sessionId: phone.sessionId }),
            }).catch(() => {});
        }
        onCancel();
    };

    return (
        <div className="space-y-3 text-xs text-nature-200 min-w-0" data-testid="restore-locked-backup" style={{ overflowWrap: 'anywhere' }}>
            <p className="m-0 text-sm text-white font-bold">This backup is locked.</p>
            <p className="m-0">Made {day(backup.createdAt)}. It opens with: {backup.opensWith || 'its owners or the recovery code'}.</p>
            {error && <div role="alert" className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-red-200">{error}</div>}
            {restarting && <p className="m-0 text-amber-200" aria-live="polite">The server is restarting with the restored backup…</p>}
            {phone ? (
                <OwnerPhoneUnlock session={phone} purpose="restore" />
            ) : (
                <>
                    {canUsePhone && (
                        <button type="button" onClick={openWithPhone} disabled={busy} className={`${BTN} w-full bg-red-900/80 hover:bg-red-800 text-white border border-red-700`}>
                            {busy ? 'Starting…' : "Open with an owner's phone"}
                        </button>
                    )}
                    {canUseCode && (
                        <form onSubmit={openWithCode} className="space-y-2">
                            <label htmlFor="restore-recovery-code" className="block">Or type the printed recovery code:</label>
                            <input id="restore-recovery-code" type="text" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off"
                                autoCapitalize="characters" spellCheck={false} placeholder="BPRC-1  XXXX-XXXX-…"
                                className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white font-mono" />
                            <button type="submit" disabled={busy || !code.trim()} className={`${BTN} w-full bg-red-900/80 hover:bg-red-800 text-white border border-red-700`}>
                                {busy ? 'Opening…' : 'Open with the code and restore'}
                            </button>
                        </form>
                    )}
                </>
            )}
            <button type="button" onClick={cancel} disabled={busy} className={`${BTN} w-full bg-nature-800 hover:bg-nature-700 text-white`}>Cancel</button>
        </div>
    );
}
