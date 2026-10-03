import React, { useState } from 'react';
import { HelpLink } from '../manual/Manual';
import { buildAdminHeaders, resolveNodeApiUrl } from '../../lib/node-client';

/**
 * Design step 6 (D3): the admin password needs a second factor. On a node whose 2FA is off, a password sign-in lands
 * here and nothing else in Settings opens until a code from a new authenticator is confirmed (the node answers every
 * other admin route 403 `totp_setup_required` for this session, admin-auth.ts TOTP_SETUP_ROUTES). Confirming lifts it
 * at once, in the same session: `onDone` and Settings opens. The eight backup codes are shown here, once.
 *
 * A soft gate: the node serves its members, sign-out is always here, and the phone's Manage (a key session) is never
 * held to this card. The first-run wizard runs after it, so its Step 2 finds 2FA already on.
 */
export const TOTP_GATE_SENTENCE = 'Set up two-factor sign-in to open Settings: the admin password alone is not enough.';

type Setup = { qrDataUrl?: string; formattedSecret: string; backupCodes: string[] };

interface TotpSetupGateProps {
    nodeUrl: string;
    onDone: () => void;
    onSignOut: () => void;
}

async function errorFrom(res: Response | null): Promise<string> {
    if (!res) return 'The node could not be reached';
    const body = await res.json().catch(() => ({} as { error?: string }));
    return (body && typeof body.error === 'string' && body.error) || `HTTP ${res.status}`;
}

export function TotpSetupGate({ nodeUrl, onDone, onSignOut }: TotpSetupGateProps) {
    const [setup, setSetup] = useState<Setup | null>(null);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const start = async () => {
        setBusy(true);
        setError(null);
        let res: Response | null;
        try {
            res = await fetch(resolveNodeApiUrl(nodeUrl, '/api/local/admin/2fa/setup'), {
                method: 'POST', credentials: 'same-origin', headers: buildAdminHeaders(), body: '{}',
            });
        } catch { res = null; }
        if (res && res.ok) {
            const data = await res.json().catch(() => ({} as Record<string, unknown>));
            if (typeof data.secret === 'string' && data.secret) {
                setSetup({
                    qrDataUrl: typeof data.qrDataUrl === 'string' ? data.qrDataUrl : undefined,
                    formattedSecret: (typeof data.formattedSecret === 'string' && data.formattedSecret) || data.secret,
                    backupCodes: Array.isArray(data.backupCodes) ? data.backupCodes.map(String) : [],
                });
                setCode('');
                setBusy(false);
                return;
            }
        }
        setError(res && !res.ok ? await errorFrom(res) : 'The node did not return a 2FA secret');
        setBusy(false);
    };

    const confirm = async (e: React.FormEvent) => {
        e.preventDefault();
        const clean = code.trim();
        if (!clean) return;
        setBusy(true);
        setError(null);
        let res: Response | null;
        try {
            res = await fetch(resolveNodeApiUrl(nodeUrl, '/api/local/admin/2fa/verify'), {
                method: 'POST', credentials: 'same-origin', headers: buildAdminHeaders(), body: JSON.stringify({ code: clean }),
            });
        } catch { res = null; }
        const data = res ? await res.json().catch(() => ({} as Record<string, unknown>)) : {};
        setBusy(false);
        if (res && res.ok && data.success === true && data.totpEnabled === true) {
            onDone();
            return;
        }
        setError((typeof data.error === 'string' && data.error) || (res ? `HTTP ${res.status}` : 'The node could not be reached'));
    };

    return (
        <div className="min-h-screen bg-nature-950 flex items-center justify-center p-4 font-sans">
            <div className="w-full max-w-md bg-nature-900/90 border border-nature-800 rounded-3xl p-5 sm:p-8 shadow-2xl backdrop-blur-xl" data-testid="totp-setup-gate">
                <div className="flex items-center gap-3 mb-5 border-b border-nature-800/80 pb-5">
                    {/* No icon below 360 px: at 320 px and 1.3× text it squeezed the title to one word a line. */}
                    <div className="hidden min-[360px]:flex w-12 h-12 shrink-0 rounded-2xl bg-terra-500/20 border border-terra-500/30 items-center justify-center text-2xl" aria-hidden="true">
                        🔐
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-xl font-black text-white m-0 tracking-tight">Two-factor sign-in</h2>
                        <p className="text-xs text-nature-400 m-0 mt-0.5 font-medium">Needed once, before Settings opens</p>
                    </div>
                    <HelpLink screen="login" />
                </div>

                <p role="status" className="text-sm text-nature-100 leading-relaxed mt-0 mb-4">{TOTP_GATE_SENTENCE}</p>

                {error && (
                    <div role="alert" className="p-3.5 mb-4 rounded-xl bg-red-950/70 border border-red-800/60 text-red-200 text-xs break-words">
                        {error}
                    </div>
                )}

                {!setup ? (
                    <>
                        <p className="text-xs text-nature-400 leading-relaxed mt-0 mb-4">
                            You need an authenticator app on your phone (Google Authenticator, Aegis, 1Password or similar).
                            Signing in from the BeanPool app's Manage button uses your phone's lock instead, and is not asked for this.
                        </p>
                        <button
                            type="button"
                            onClick={start}
                            disabled={busy}
                            className="w-full min-h-[48px] py-3 rounded-xl bg-terra-600 hover:bg-terra-500 text-white font-bold text-sm disabled:opacity-50"
                        >
                            {busy ? 'Starting…' : 'Set up two-factor sign-in'}
                        </button>
                    </>
                ) : (
                    <form onSubmit={confirm} className="space-y-4">
                        <div>
                            <p className="text-xs font-bold text-nature-300 mb-2 uppercase tracking-wider mt-0">1. Scan this with your authenticator</p>
                            {setup.qrDataUrl && (
                                <img src={setup.qrDataUrl} alt="2FA setup QR code" className="block w-44 h-44 max-w-full bg-white rounded-xl p-2 mb-2" />
                            )}
                            <p className="text-xs text-nature-400 m-0">Or type this key:</p>
                            <code className="block font-mono text-sm text-white break-all mt-1" data-testid="totp-gate-secret">{setup.formattedSecret}</code>
                        </div>
                        {setup.backupCodes.length > 0 && (
                            <div>
                                <p className="text-xs font-bold text-nature-300 mb-1 uppercase tracking-wider mt-0">2. Keep these backup codes</p>
                                <p className="text-xs text-nature-400 mt-0 mb-2 leading-relaxed">
                                    Each one works once, instead of a code, if you lose your phone. Write them down or save them somewhere safe now: they are not shown again.
                                </p>
                                <ul className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-1.5 list-none p-0 m-0" data-testid="totp-gate-backup-codes">
                                    {setup.backupCodes.map((c) => (
                                        <li key={c} className="font-mono text-sm text-white bg-nature-950 border border-nature-800 rounded-lg px-2 py-1 break-all">{c}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <div>
                            <label htmlFor="totp-gate-code" className="block text-xs font-bold text-nature-300 mb-1.5 uppercase tracking-wider">
                                {setup.backupCodes.length > 0 ? '3.' : '2.'} Type the 6-digit code it shows
                            </label>
                            <input
                                id="totp-gate-code"
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                maxLength={8}
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                placeholder="123456"
                                className="w-full bg-nature-950 border border-terra-500/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-nature-500 font-mono tracking-widest text-center focus:outline-none focus:border-terra-400"
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={busy || !code.trim()}
                            className="w-full min-h-[48px] py-3 rounded-xl bg-terra-600 hover:bg-terra-500 text-white font-bold text-sm disabled:opacity-50"
                        >
                            {busy ? 'Checking…' : 'Confirm and open Settings'}
                        </button>
                    </form>
                )}

                <p className="text-xs text-nature-400 leading-relaxed mt-5 mb-0">
                    Lost access? Backup codes, a second owner, or <code className="whitespace-nowrap">beanpool recover</code> on the server get you back in.
                </p>
                <button
                    type="button"
                    onClick={onSignOut}
                    className="w-full mt-3 min-h-[44px] rounded-xl border border-nature-700 text-nature-300 hover:text-white text-sm font-semibold"
                >
                    Sign out
                </button>
            </div>
        </div>
    );
}
