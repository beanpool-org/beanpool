import React, { useState } from 'react';
import { loginToNode, resolveNodeApiUrl, buildAdminHeaders } from '../../lib/node-client';

interface AdminLoginCardProps {
    nodeUrl: string;
    onAuthenticated: (password: string, sessionToken?: string) => void;
}

export function AdminLoginCard({ nodeUrl, onAuthenticated }: AdminLoginCardProps) {
    const [password, setPassword] = useState('');
    const [totpCode, setTotpCode] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [showTotpField, setShowTotpField] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!password) {
            setError('Please enter the admin password');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            // First attempt verify-password or login
            const verifyEndpoint = resolveNodeApiUrl(nodeUrl, '/api/local/verify-password');
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'X-Admin-Password': password,
            };
            if (totpCode.trim()) {
                headers['X-Admin-TOTP'] = totpCode.trim();
            }
            let res = await fetch(verifyEndpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({ password, totpCode: totpCode.trim() || undefined }),
            });

            if (res.status === 404) {
                // Fallback to /api/verify-password if /api/local prefix is not present
                const fallbackEndpoint = resolveNodeApiUrl(nodeUrl, '/api/verify-password');
                res = await fetch(fallbackEndpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ password, totpCode: totpCode.trim() || undefined }),
                });
            }

            const body = await res.json().catch(() => ({}));

            if (res.status === 401 && body?.totpRequired && !showTotpField) {
                // 2FA is required on this node — show TOTP input
                setShowTotpField(true);
                setError('2FA is enabled. Please enter your 6-digit TOTP code.');
                setLoading(false);
                return;
            }

            if (!res.ok) {
                throw new Error(body?.error || `Authentication failed (${res.status})`);
            }

            const sessionToken = body?.sessionToken || body?.tfaSessionToken;
            sessionStorage.setItem('bp-admin-token', password);
            if (sessionToken) {
                sessionStorage.setItem('bp_tfa_session_local-node', sessionToken);
                sessionStorage.setItem('bp-2fa-session', sessionToken);
            }

            onAuthenticated(password, sessionToken);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Authentication failed';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-nature-950 flex items-center justify-center p-4 font-sans">
            <div className="w-full max-w-md bg-nature-900/90 border border-nature-800 rounded-3xl p-8 shadow-2xl backdrop-blur-xl animate-fade-in">
                <div className="flex items-center gap-3 mb-6 border-b border-nature-800/80 pb-5">
                    <div className="w-12 h-12 rounded-2xl bg-terra-500/20 border border-terra-500/30 flex items-center justify-center text-2xl text-terra-400 font-bold">
                        ⚙️
                    </div>
                    <div>
                        <h2 className="text-xl font-black text-white m-0 tracking-tight">Node Settings</h2>
                        <p className="text-xs text-nature-400 m-0 mt-0.5 font-medium">
                            Operator administration &amp; community governance
                        </p>
                    </div>
                </div>

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
                        <div className="relative">
                            <input
                                type={showPassword ? 'text' : 'password'}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Enter node admin password"
                                autoFocus
                                required
                                className="w-full bg-nature-950 border border-nature-700/80 rounded-xl px-4 py-2.5 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-terra-500 transition-colors"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-nature-400 hover:text-nature-200 text-xs font-semibold px-1"
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
