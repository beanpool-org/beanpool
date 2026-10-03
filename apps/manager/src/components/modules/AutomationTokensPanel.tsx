import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * "Automation tokens" (node sign-in design step 7, D8; the server is apps/server routes/automation-tokens.ts). An owner makes
 * a token so a script or the fleet manager can use this node's Settings without the password. It never does an owner-only
 * change. Owners only: the card is not drawn for anyone else (the node refuses them as well). Only an owner's KEY session
 * makes one (the node answers token_needs_key to the password): a password session sees the list and Revoke, and in place
 * of the form one line saying where to make one.
 *
 * The token is shown ONCE. It lives in this component's state and nowhere else (never localStorage, sessionStorage, a log
 * or the list) and is dropped the moment Done is pressed, or the card goes away.
 */

export type TokenScope = 'read' | 'backups' | 'admin';

export interface AutomationTokenRecord {
    id: string;
    name: string;
    scope: TokenScope;
    createdBy?: string;
    createdAt: number;
    expiresAt: number | null;
    lastUsedAt: number | null;
    lastUsedRoute: string | null;
}

export interface AutomationTokensPanelProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
}

const SCOPES: Array<{ value: TokenScope; label: string }> = [
    { value: 'read', label: 'Read only: dashboards and checks' },
    { value: 'backups', label: 'Backups: take, list and download backups' },
    { value: 'admin', label: 'Admin: what an admin can do; never owner-only changes' },
];

const EXPIRIES: Array<{ value: string; label: string; days: number | null }> = [
    { value: 'never', label: 'Never expires', days: null },
    { value: '30', label: 'Expires in 30 days', days: 30 },
    { value: '90', label: 'Expires in 90 days', days: 90 },
    { value: '365', label: 'Expires in 1 year', days: 365 },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDay(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function scopeLabel(scope: string): string {
    return SCOPES.find((s) => s.value === scope)?.label.split(':')[0] ?? scope;
}

export function AutomationTokensPanel({ activeNode, viewer = { kind: 'password' } }: AutomationTokensPanelProps) {
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';
    const canMake = viewer.kind === 'key' && viewer.role === 'owner';

    const [tokens, setTokens] = useState<AutomationTokenRecord[] | null>(null);
    const [listMessage, setListMessage] = useState('');
    const [name, setName] = useState('');
    const [scope, setScope] = useState<TokenScope>('read');
    const [expiry, setExpiry] = useState('never');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    // The one-time token: component state only.
    const [shownToken, setShownToken] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const tokenRef = useRef<HTMLParagraphElement | null>(null);

    const headers = useCallback(
        () => buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
        [activeNode.adminPassword, activeNode.id],
    );

    const load = useCallback(async () => {
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/automation-tokens'), {
                headers: headers(),
                credentials: 'same-origin',
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setTokens(Array.isArray(data.tokens) ? (data.tokens as AutomationTokenRecord[]) : []);
                setListMessage('');
            } else {
                setListMessage(`The tokens could not be listed: ${data.error || `HTTP ${res.status}`}`);
            }
        } catch (e: unknown) {
            setListMessage(e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.url, headers]);

    useEffect(() => {
        if (!isOwner) return;
        void load();
    }, [isOwner, load]);

    // A different node: nothing of the last one's token stays.
    useEffect(() => {
        setShownToken(null);
        setCopied(false);
        setMessage('');
    }, [activeNode.id]);

    if (!isOwner) return null;

    const handleMake = async () => {
        setMessage('');
        const trimmed = name.trim();
        if (!trimmed) {
            setMessage('Give the token a name, so you know what uses it.');
            return;
        }
        const days = EXPIRIES.find((e) => e.value === expiry)?.days ?? null;
        const body: Record<string, unknown> = { name: trimmed, scope };
        if (days !== null) body.expiresAt = Date.now() + days * DAY_MS;
        setBusy(true);
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/automation-tokens'), {
                method: 'POST',
                headers: headers(),
                credentials: 'same-origin',
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && typeof data.token === 'string') {
                setShownToken(data.token);
                setCopied(false);
                setName('');
                await load();
            } else {
                // The node's own words, including its "press Manage again" for a stale phone session.
                setMessage(`No token was made: ${data.error || `HTTP ${res.status}`}`);
            }
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const handleCopy = async () => {
        if (!shownToken) return;
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(shownToken);
                setCopied(true);
                return;
            }
        } catch {
            // fall through to select-all
        }
        const el = tokenRef.current;
        if (el && typeof window !== 'undefined' && window.getSelection) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        }
        setMessage('Your browser would not copy it. It is selected: copy it by hand.');
    };

    const handleDone = () => {
        setShownToken(null);
        setCopied(false);
        setMessage('');
    };

    const handleRevoke = async (t: AutomationTokenRecord) => {
        if (!confirm(`Revoke the token "${t.name}"? Anything using it stops working at once.`)) return;
        setMessage('');
        try {
            const res = await fetch(
                resolveNodeApiUrl(activeNode.url, `/api/local/admin/automation-tokens/${encodeURIComponent(t.id)}/revoke`),
                { method: 'POST', headers: headers(), credentials: 'same-origin', body: '{}' },
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) setMessage(`The token was not revoked: ${data.error || `HTTP ${res.status}`}`);
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        }
        await load();
    };

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4" data-testid="automation-tokens-card">
            <div className="min-w-0">
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                    <span>🤖</span>
                    <span className="min-w-0 break-words">Automation tokens</span>
                </h3>
                <p className="text-xs text-nature-400 m-0 mt-0.5">
                    A token lets a script or the fleet manager use this node&rsquo;s Settings without the password. It is shown once. It never makes
                    owner-only changes: roles, password, 2FA, tokens, break-glass, the public address, restore.
                </p>
            </div>

            {shownToken ? (
                <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-3" data-testid="automation-token-shown">
                    <span className="text-xs font-semibold text-nature-300">Your new token</span>
                    <p
                        ref={tokenRef}
                        className="font-mono text-xs text-white break-all select-all m-0 p-3 rounded-xl bg-nature-950 border border-nature-700"
                        data-testid="automation-token-value"
                    >
                        {shownToken}
                    </p>
                    <p className="text-[11px] text-amber-300 m-0">Copy it now: it is not shown again.</p>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={handleCopy}
                            className="min-h-[48px] flex-1 min-w-[8rem] py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white"
                        >
                            {copied ? 'Copied' : 'Copy'}
                        </button>
                        <button
                            type="button"
                            onClick={handleDone}
                            className="min-h-[48px] flex-1 min-w-[8rem] py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                        >
                            Done
                        </button>
                    </div>
                </div>
            ) : !canMake ? (
                <p className="text-xs text-nature-400 m-0 break-words" data-testid="automation-token-needs-key">
                    Tokens are made with an owner&rsquo;s key, never the password: use Manage in the app, or sign in on a computer by scanning a code.
                </p>
            ) : (
                <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-3">
                    <span className="text-xs font-semibold text-nature-300">Make a token</span>
                    <div className="space-y-1">
                        <label htmlFor="automation-token-name" className="block text-xs text-nature-400">Name</label>
                        <input
                            id="automation-token-name"
                            type="text"
                            maxLength={80}
                            placeholder="e.g. Nightly backup script"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white"
                        />
                    </div>
                    <div className="space-y-1">
                        <label htmlFor="automation-token-scope" className="block text-xs text-nature-400">What it can do</label>
                        <select
                            id="automation-token-scope"
                            value={scope}
                            onChange={(e) => setScope(e.target.value as TokenScope)}
                            className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white"
                        >
                            {SCOPES.map((s) => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="space-y-1">
                        <label htmlFor="automation-token-expiry" className="block text-xs text-nature-400">Expiry</label>
                        <select
                            id="automation-token-expiry"
                            value={expiry}
                            onChange={(e) => setExpiry(e.target.value)}
                            className="w-full min-w-0 min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white"
                        >
                            {EXPIRIES.map((e) => (
                                <option key={e.value} value={e.value}>{e.label}</option>
                            ))}
                        </select>
                    </div>
                    <button
                        type="button"
                        onClick={handleMake}
                        disabled={busy}
                        className="min-h-[48px] w-full py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                    >
                        Make token
                    </button>
                </div>
            )}

            {message && <p className="text-[11px] text-amber-300 m-0" role="alert">{message}</p>}

            <div className="space-y-2">
                <span className="text-xs font-semibold text-nature-300">Tokens on this node</span>
                {listMessage && <p className="text-[11px] text-amber-300 m-0" role="alert">{listMessage}</p>}
                {tokens && tokens.length === 0 && <p className="text-[11px] text-nature-400 m-0">No tokens yet.</p>}
                {tokens && tokens.length > 0 && (
                    <ul className="list-none p-0 m-0 space-y-2" data-testid="automation-token-list">
                        {tokens.map((t) => (
                            <li key={t.id} className="p-3 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-2" data-testid="automation-token-row">
                                <div className="min-w-0">
                                    <p className="text-xs font-bold text-white m-0 break-words">{t.name}</p>
                                    <p className="text-[11px] text-nature-400 m-0 break-words">
                                        {scopeLabel(t.scope)} &middot; made {formatDay(t.createdAt)}
                                    </p>
                                    <p className="text-[11px] text-nature-400 m-0 break-words">
                                        Last used: {t.lastUsedAt ? `${formatDay(t.lastUsedAt)}${t.lastUsedRoute ? `, ${t.lastUsedRoute}` : ''}` : 'never'}
                                    </p>
                                    <p className="text-[11px] text-nature-400 m-0 break-words">
                                        Expires: {t.expiresAt ? formatDay(t.expiresAt) : 'never'}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => handleRevoke(t)}
                                    aria-label={`Revoke ${t.name}`}
                                    className="min-h-[48px] w-full py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                                >
                                    Revoke
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
