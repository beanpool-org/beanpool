import React, { useState, useEffect, useRef } from 'react';
import { HelpLink } from '../manual/Manual';
import { resolveNodeApiUrl } from '../../lib/node-client';
import { signInWithPassword, type KeySession } from '../../lib/key-session';
import { PhoneSignIn } from './PhoneSignIn';
import { UnclaimedCard } from './UnclaimedCard';
import { useClaimState } from './useClaimState';
import { CLAIM_PATH } from '../../lib/node-claim';

interface AdminLoginCardProps {
    nodeUrl: string;
    /**
     * Signed in with the password. The node has set the httpOnly session cookie; this is its CSRF token. The password
     * itself is not handed on: nothing on this page keeps it (lib/key-session.ts, signInWithPassword).
     * `totpSetupRequired`: the node's 2FA is off, so Settings opens on the 2FA setup card only (TotpSetupGate).
     */
    onPasswordSession: (csrfToken: string, totpSetupRequired: boolean) => void;
    /** Offers "Sign in with your phone" (a QR for the BeanPool app) when given. Single-node /settings only. */
    onKeySession?: (session: KeySession, csrfToken: string) => void;
}

export function AdminLoginCard({ nodeUrl, onPasswordSession, onKeySession }: AdminLoginCardProps) {
    const [mode, setMode] = useState<'password' | 'phone'>('password');
    const [password, setPassword] = useState('');
    const [totpCode, setTotpCode] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [showTotpField, setShowTotpField] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Asked before sign-in; the form shows meanwhile and whenever the answer is not "unclaimed" (useClaimState).
    const claim = useClaimState(resolveNodeApiUrl(nodeUrl, CLAIM_PATH));
    const [passwordFoldOpen, setPasswordFoldOpen] = useState(false);
    // This server has no admin password (the claim check answers password: false), so no password field is drawn: a new
    // install never had one (node sign-in step 8), or an owner retired it (design step 10; the answer says which).
    const noPassword = claim.kind === 'claimed' && claim.password === false;
    const passwordRetired = claim.kind === 'claimed' && claim.password === false && claim.retired === true;
    // If the operator has entered a password or submitted (an error shown, 2FA open, or in flight)
    // before the first claim check answers "unclaimed", start the fold open so their form and result stay visible.
    const wasUnclaimedRef = useRef(claim.kind === 'unclaimed');
    useEffect(() => {
        if (!wasUnclaimedRef.current && claim.kind === 'unclaimed') {
            wasUnclaimedRef.current = true;
            if (password || error || showTotpField || loading) {
                setPasswordFoldOpen(true);
            }
        }
    }, [claim.kind, password, error, showTotpField, loading]);


    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!password) {
            setError('Please enter the admin password');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            // Exchanged once for the node's httpOnly session cookie: the password goes no further than this request.
            const res = await signInWithPassword(
                resolveNodeApiUrl(nodeUrl, '/api/local/admin/auth/password'),
                password,
                totpCode.trim() || undefined,
            );

            if (!res.ok && res.totpRequired && !showTotpField) {
                // 2FA is required on this node — show TOTP input
                setShowTotpField(true);
                setError('2FA is enabled. Please enter your 6-digit TOTP code.');
                setLoading(false);
                return;
            }

            if (!res.ok) {
                throw new Error(res.error);
            }

            setPassword('');
            setTotpCode('');
            onPasswordSession(res.csrfToken, res.totpSetupRequired);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Authentication failed';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    // Today's password form: the sign-in, or under the unclaimed card's fold while the node has no owner.
    const passwordForm = (
        <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
                <div className="p-3.5 rounded-xl bg-red-950/70 border border-red-800/60 text-red-200 text-xs flex items-center gap-2">
                    <span>⚠️</span>
                    <span>{error}</span>
                </div>
            )}

            <div>
                <label className="block text-xs font-bold text-nature-300 mb-1.5 uppercase tracking-wider">
                    Admin Password
                </label>
                {/* Show/Hide sits beside the input, not over it: absolutely placed, it was drawn
                    across the placeholder on a 320px screen. */}
                <div className="flex items-center bg-nature-950 border border-nature-700/80 rounded-xl focus-within:border-terra-500 transition-colors" data-testid="admin-password-field">
                    <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        autoFocus
                        required
                        className="flex-1 min-w-0 bg-transparent border-none rounded-xl pl-4 pr-2 py-2.5 text-sm text-white placeholder-nature-500 text-ellipsis focus:outline-none"
                    />
                    <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="shrink-0 self-stretch pl-2 pr-4 text-nature-400 hover:text-nature-200 text-xs font-semibold"
                    >
                        {showPassword ? 'Hide' : 'Show'}
                    </button>
                </div>
            </div>

            {showTotpField && (
                <div className="animate-fade-in">
                    <label className="block text-xs font-bold text-nature-300 mb-1.5 uppercase tracking-wider">
                        2FA Authenticator Code
                    </label>
                    <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={8}
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value)}
                        placeholder="6-digit code (e.g. 123456)"
                        autoFocus
                        className="w-full bg-nature-950 border border-terra-500/60 rounded-xl px-4 py-2.5 text-sm text-white placeholder-nature-500 font-mono tracking-widest text-center focus:outline-none focus:border-terra-400"
                    />
                </div>
            )}

            <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 py-3 rounded-xl bg-terra-600 hover:bg-terra-500 active:scale-[0.98] text-white font-bold text-sm shadow-lg shadow-terra-900/30 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
                {loading ? (
                    <>
                        <span className="animate-spin">⏳</span>
                        <span>Verifying...</span>
                    </>
                ) : (
                    <>
                        <span>🔓</span>
                        <span>Unlock Settings</span>
                    </>
                )}
            </button>
        </form>
    );

    return (
        <div className="min-h-screen bg-nature-950 flex items-center justify-center p-4 font-sans">
            <div className="w-full max-w-md bg-nature-900/90 border border-nature-800 rounded-3xl p-5 sm:p-8 shadow-2xl backdrop-blur-xl animate-fade-in">
                <div className="flex items-center gap-3 mb-6 border-b border-nature-800/80 pb-5">
                    <div className="w-12 h-12 shrink-0 rounded-2xl bg-terra-500/20 border border-terra-500/30 flex items-center justify-center text-2xl text-terra-400 font-bold">
                        ⚙️
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-xl font-black text-white m-0 tracking-tight">Node Settings</h2>
                        <p className="text-xs text-nature-400 m-0 mt-0.5 font-medium">
                            Operator administration &amp; community governance
                        </p>
                    </div>
                    <HelpLink screen="login" />
                </div>

                {claim.kind === 'unclaimed' ? (
                    <>
                    <UnclaimedCard codeId={claim.codeId} primaryAddress={claim.primaryAddress} address={claim.address} addresses={claim.addresses} />
                    {/* Stage B: the password still works, second. Stage C's nodes answer password: false and have none. */}
                    {claim.password && (
                        <details open={passwordFoldOpen} className="mt-6 border-t border-nature-800/80 pt-2" data-testid="claim-password-fold">
                            <summary
                                onClick={(e) => { e.preventDefault(); setPasswordFoldOpen((o) => !o); }}
                                className="min-h-[48px] flex items-center gap-2 cursor-pointer list-none text-sm font-semibold text-nature-300 hover:text-white"
                            >
                                {/* A flex summary loses the browser's own triangle: draw one. */}
                                <span aria-hidden="true" className="shrink-0 w-4 text-center">{passwordFoldOpen ? '▾' : '▸'}</span>
                                <span>This server also has an admin password</span>
                            </summary>
                            {passwordFoldOpen && <div className="mt-2">{passwordForm}</div>}
                        </details>
                    )}
                    </>
                ) : noPassword ? (
                    <div data-testid={passwordRetired ? 'password-retired-signin' : 'no-password-signin'}>
                        <p className="text-xs text-nature-300 mt-0 mb-4 leading-relaxed">
                            {passwordRetired
                                ? 'This server has no admin password: an owner retired it. Sign in with the BeanPool app on your phone.'
                                : 'This server has no admin password. Owners and admins sign in with the BeanPool app on your phone.'}
                        </p>
                        {onKeySession
                            ? <PhoneSignIn onSignedIn={onKeySession} />
                            : <p className="text-xs text-amber-300 m-0">Open this server&apos;s own /settings page to sign in with your phone, or use an automation token.</p>}
                    </div>
                ) : mode === 'phone' && onKeySession ? (
                    <PhoneSignIn onSignedIn={onKeySession} onUsePassword={() => setMode('password')} />
                ) : (
                <>
                {passwordForm}

                {onKeySession && (
                    <div className="mt-4">
                        <div className="flex items-center gap-3 my-4 text-xs text-nature-500 uppercase tracking-wider" aria-hidden="true">
                            <span className="flex-1 border-t border-nature-800" />or<span className="flex-1 border-t border-nature-800" />
                        </div>
                        <button
                            type="button"
                            onClick={() => setMode('phone')}
                            className="w-full min-h-[48px] px-4 rounded-xl border border-nature-700 bg-nature-950 hover:border-terra-500 text-white font-bold text-sm flex items-center justify-center gap-2"
                        >
                            <span aria-hidden="true">📱</span>
                            <span>Sign in with your phone</span>
                        </button>
                        <p className="text-xs text-nature-400 mt-2 mb-0 text-center leading-relaxed">
                            Owners, admins and moderators: scan a code with the BeanPool app. No password needed.
                        </p>
                    </div>
                )}
                </>
                )}

                <div className="mt-6 text-center">
                    <a
                        href="/settings-legacy"
                        className="text-xs text-nature-400 hover:text-terra-400 transition-colors underline"
                    >
                        Switch to Legacy Settings Page
                    </a>
                </div>
            </div>
        </div>
    );
}
