import React, { useState, useEffect, useCallback } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';
import type { RolesViewer } from './NodeRolesPanel';
import { nodeCredential } from '../../lib/profiles';

/**
 * "Retire the admin password" (node sign-in design step 10; the server is apps/server routes/admin.ts retire-password).
 * Owners only: the card is not drawn for anyone else. Only an owner signed in by KEY can retire it (the node refuses the
 * password itself and any token): a password session reads the state and one line saying to sign in with the phone.
 * Once retired the card says when and by whom, and nothing else.
 */

export interface PasswordRetirement {
    passwordRetired: boolean;
    retiredAt: number | null;
    retiredByCallsign: string | null;
    owners: number;
    hasBreakGlassCode: boolean | null;
}

export interface RetirePasswordPanelProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
}

/** What the owner types to confirm. */
export const RETIRE_CONFIRM_WORD = 'RETIRE';

function formatDay(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function RetirePasswordPanel({ activeNode, viewer = { kind: 'password' } }: RetirePasswordPanelProps) {
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';
    const canRetire = viewer.kind === 'key' && viewer.role === 'owner';

    const [state, setState] = useState<PasswordRetirement | null>(null);
    const [loadMessage, setLoadMessage] = useState('');
    const [acceptOneOwner, setAcceptOneOwner] = useState(false);
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');

    const headers = useCallback(
        () => buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
        [nodeCredential(activeNode), activeNode.id],
    );

    const load = useCallback(async () => {
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/auth/password-retirement'), { headers: headers() });
            const data = await res.json().catch(() => ({}));
            if (res.ok && typeof data.passwordRetired === 'boolean') {
                setState(data as PasswordRetirement);
                setLoadMessage('');
            } else {
                // An older node has no such route: say nothing is known rather than offering a button that 404s.
                setLoadMessage(res.status === 404 ? 'This server is too old to retire its password. Update it first.' : (data.error || `HTTP ${res.status}`));
            }
        } catch (e: unknown) {
            setLoadMessage(e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.url, headers]);

    useEffect(() => {
        if (isOwner) void load();
    }, [isOwner, load]);

    if (!isOwner) return null;

    const oneOwner = !!state && state.owners < 2;
    const ready = canRetire && !!state && !state.passwordRetired && state.hasBreakGlassCode === true
        && confirm.trim() === RETIRE_CONFIRM_WORD && (!oneOwner || acceptOneOwner) && !busy;

    const handleRetire = async () => {
        if (!ready) return;
        setBusy(true);
        setMessage('');
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/auth/retire-password'), {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(oneOwner ? { acceptOneOwner: true } : {}),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.passwordRetired) {
                setState(data as PasswordRetirement);
                setConfirm('');
            } else {
                setMessage(`The password was not retired: ${data.error || `HTTP ${res.status}`}`);
                void load();
            }
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4" data-testid="retire-password-panel">
            <div className="border-b border-nature-800 pb-3 min-w-0">
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                    <span aria-hidden="true">🔐</span>
                    <span>Retire the admin password</span>
                </h3>
            </div>

            {loadMessage && <p className="text-xs text-amber-300 m-0" role="alert">{loadMessage}</p>}

            {state?.passwordRetired ? (
                <p className="text-sm text-nature-200 m-0" data-testid="retired-line">
                    Retired on {formatDay(state.retiredAt)}{state.retiredByCallsign ? ` by ${state.retiredByCallsign}` : ''}. This server
                    has no admin password: Settings opens with an owner&apos;s or admin&apos;s phone.
                </p>
            ) : state ? (
                <div className="space-y-3 text-xs text-nature-300 leading-relaxed">
                    <p className="m-0">
                        Removes this server&apos;s admin password for good. It then signs nobody in, from anywhere, and
                        nothing sets one again, not even a password in the server&apos;s <code>.env</code> file. Scripts
                        that send the password stop working: give them an automation token first.
                    </p>
                    <p className="m-0">
                        <strong className="text-white">What stays:</strong> Manage in the app, &ldquo;Sign in with your
                        phone&rdquo; on a computer, your break-glass code, and <code>beanpool recover</code> on the server.
                    </p>
                    {!canRetire ? (
                        <p className="m-0 text-amber-300">Only an owner signed in with their phone can retire it. Sign in with your phone, then come back here.</p>
                    ) : state.hasBreakGlassCode !== true ? (
                        <p className="m-0 text-amber-300">Make your break-glass code first (above) and keep it safe: once the password is gone, it is how you get back in if your phone is lost.</p>
                    ) : (
                        <>
                            {oneOwner && (
                                <label className="flex items-start gap-3 min-h-[48px] cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={acceptOneOwner}
                                        onChange={(e) => setAcceptOneOwner(e.target.checked)}
                                        className="mt-1 shrink-0 w-5 h-5"
                                    />
                                    <span>
                                        I accept one owner. This community has only me as owner: if my phone and my 12
                                        words are both lost, only my break-glass code or <code>beanpool recover</code> on
                                        the server get me back in.
                                    </span>
                                </label>
                            )}
                            <label htmlFor="retire-password-confirm" className="block text-nature-400">
                                Type {RETIRE_CONFIRM_WORD} to confirm
                            </label>
                            <input
                                id="retire-password-confirm"
                                type="text"
                                autoCapitalize="characters"
                                autoComplete="off"
                                spellCheck={false}
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                                className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white font-mono"
                            />
                            <button
                                type="button"
                                onClick={handleRetire}
                                disabled={!ready}
                                className="min-h-[48px] w-full py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                            >
                                {busy ? 'Retiring…' : 'Retire the admin password'}
                            </button>
                        </>
                    )}
                </div>
            ) : null}

            {message && <p className="text-xs text-amber-300 m-0" role="alert">{message}</p>}
        </div>
    );
}
