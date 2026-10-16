import { useEffect, useRef, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';
import { restoreDoneWords } from '../../lib/restore-words';
import { OwnerPhoneUnlock, type OwnerPhoneSession } from './OwnerPhoneUnlock';
import { nodeCredential } from '../../lib/profiles';
import { passwordField } from '../../lib/node-client';

/**
 * Restore → a locked backup (`.bpsealed`, sealed-keys.md §6.2). The server has read the file's public header and said
 * who can open it; this is the confirmation (design case 18 §3.4, no window confirm(): the proof is the confirmation).
 * It shows the file's community and the machine that locked it beside this server's own (the shell's prompt does the
 * same, #2017: a file's code and owner stanzas are whoever sealed it, so "it opened" proves nothing about this
 * community), says what is lost and that a restore point is taken first, then asks for one way to open it: the printed
 * recovery code (X-Recovery-Code), or an owner's phone (the file waits on the server, the owner scans a QR, the phone
 * opens it for this server). A backup's keys bring back the community's admin password, so this server's own stops
 * working part-way: the phone path follows the restore with the one-time follow token the upload answered, and says
 * "restarting" when the server goes quiet.
 */

export interface LockedBackupInfo {
    envelopeId?: string;
    createdAt?: string;
    opensWith?: string;
    /** The file's community (its genesis communityId), from the header. */
    communityId?: string;
    /** The node key that locked the file (its PeerId), from the header. */
    sealedBy?: string;
}

/** This server's own community and node key (GET /api/local/admin/backup-enroll), to set beside the file's. */
interface ThisServer {
    communityId: string | null;
    peerId: string | null;
}

function day(iso: string | undefined): string {
    if (!iso) return 'an unknown date';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const BTN = 'min-h-[48px] px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50';

/** What the two IDs say together, in one line; null while this server's own are not known. */
function verdict(backup: LockedBackupInfo, here: ThisServer | null): string | null {
    if (!here || !here.communityId || !backup.communityId) return null;
    if (backup.communityId !== here.communityId) {
        return "A different community's backup. Restoring it replaces the community on this server with that one.";
    }
    if (here.peerId && backup.sealedBy && backup.sealedBy !== here.peerId) {
        return 'This community\'s backup, locked by another machine.';
    }
    return 'This community\'s backup, locked by this server.';
}

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
    const [here, setHere] = useState<ThisServer | null>(null);
    const [hereUnknown, setHereUnknown] = useState(false);
    const restartingRef = useRef(false);
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/backup-enroll'), {
                    method: 'GET', headers: buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
                });
                const data = await res.json().catch(() => ({}));
                if (cancelled) return;
                if (res.ok && typeof data.communityId === 'string') {
                    setHere({ communityId: data.communityId, peerId: typeof data.primaryPeerId === 'string' ? data.primaryPeerId : null });
                } else {
                    setHereUnknown(true);
                }
            } catch {
                if (!cancelled) setHereUnknown(true);
            }
        })();
        return () => { cancelled = true; };
    }, [activeNode]);

    const upload = async (extra: Record<string, string>) => {
        const headers = buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id));
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
            if (res.ok) onDone(restoreDoneWords(data));
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
                    onDoneRef.current(restoreDoneWords(data.result, String(data.unlockedBy || 'an owner')));
                    return;
                }
                if (data.state === 'failed') { setError(data.error || 'The restore failed.'); setPhone(null); return; }
                if (data.state === 'expired' || data.state === 'closed' || data.state === 'gone' || res.status === 401) {
                    // After the restore the server restarts and forgets the session: that is not a failure to report.
                    if (restartingRef.current) { onDoneRef.current('The server restarted with the restored backup. A restore point of the server as it was is kept: you can roll back from Backups & Restore. Sign in again.'); return; }
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
                method: 'POST', headers: buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ ...passwordField(nodeCredential(activeNode)), sessionId: phone.sessionId }),
            }).catch(() => {});
        }
        onCancel();
    };

    const said = verdict(backup, here);
    const idRow = (label: string, fileValue: string | undefined, serverValue: string | null | undefined, testId: string) => (
        <div className="space-y-0.5" data-testid={testId}>
            <dt className="text-nature-400">{label}</dt>
            <dd className="m-0 font-mono text-white">This backup: {fileValue || 'not stated'}</dd>
            <dd className="m-0 font-mono text-nature-300">
                This server: {here ? (serverValue || 'not known') : hereUnknown ? 'could not be read' : 'reading…'}
            </dd>
        </div>
    );

    return (
        <div className="space-y-3 text-xs text-nature-200 min-w-0" data-testid="restore-locked-backup" style={{ overflowWrap: 'anywhere' }}>
            <p className="m-0 text-sm text-white font-bold">Restore this backup?</p>
            <dl className="m-0 space-y-2" data-testid="restore-confirmation">
                <div className="space-y-0.5">
                    <dt className="text-nature-400">File</dt>
                    <dd className="m-0 text-white">{file.name}, made {day(backup.createdAt)}</dd>
                </div>
                {idRow('Community', backup.communityId, here?.communityId, 'restore-community')}
                {idRow('Locked by (node key)', backup.sealedBy, here?.peerId, 'restore-signer')}
                <div className="space-y-0.5">
                    <dt className="text-nature-400">Opens with</dt>
                    <dd className="m-0 text-white">{backup.opensWith || 'its owners or the recovery code'}</dd>
                </div>
            </dl>
            {said && <p className="m-0 text-white font-bold" data-testid="restore-verdict">{said}</p>}
            <p className="m-0 p-3 rounded-xl bg-nature-950 border border-terra-500/50 text-bp-ink-terra">
                Everything on this server since {day(backup.createdAt)} will be lost. A restore point is taken first: you can roll
                back from Backups &amp; Restore (Restore points), or on the server with <code className="font-mono">beanpool restore-point</code>.
            </p>
            {error && <div role="alert" className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-red-200">{error}</div>}
            {restarting && <p className="m-0 text-amber-200" aria-live="polite">The server is restarting with the restored backup…</p>}
            {phone ? (
                <OwnerPhoneUnlock session={phone} purpose="restore" />
            ) : (
                <>
                    {canUsePhone && (
                        <button type="button" onClick={openWithPhone} disabled={busy} className={`${BTN} w-full bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on border border-bp-danger-fill`}>
                            {busy ? 'Starting…' : "Open with an owner's phone"}
                        </button>
                    )}
                    {canUseCode && (
                        <form onSubmit={openWithCode} className="space-y-2">
                            <label htmlFor="restore-recovery-code" className="block">Or type the printed recovery code:</label>
                            <input id="restore-recovery-code" type="text" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off"
                                autoCapitalize="characters" spellCheck={false} placeholder="BPRC-1  XXXX-XXXX-…"
                                className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white font-mono" />
                            <button type="submit" disabled={busy || !code.trim()} className={`${BTN} w-full bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on border border-bp-danger-fill`}>
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
