import React, { useState } from 'react';

interface TotpModalProps {
    nodeName: string;
    onClose: () => void;
    onSubmit: (code: string) => void;
    error?: string;
}

export function TotpModal({ nodeName, onClose, onSubmit, error }: TotpModalProps) {
    const [code, setCode] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const clean = code.replace(/\s/g, '');
        if (!/^\d{6}$/.test(clean)) return;
        setSubmitting(true);
        onSubmit(clean);
    };

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-[60] animate-fade-in font-sans">
            <div className="bg-nature-900 border border-nature-800 rounded-3xl p-6 max-w-sm w-full space-y-5 shadow-2xl">
                <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-lg font-bold">
                            🔐
                        </div>
                        <h3 className="text-base font-bold text-white m-0">Two-Factor Auth Required</h3>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-nature-500 hover:text-white transition-colors text-lg"
                    >
                        ✕
                    </button>
                </div>

                <p className="text-xs text-nature-300 leading-relaxed m-0">
                    <strong className="text-white">{nodeName}</strong> has 2FA enabled.
                    Enter the 6-digit code from your authenticator app to connect.
                </p>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-nature-300 font-semibold mb-1 text-xs">
                            Authenticator Code
                        </label>
                        <input
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            value={code}
                            onChange={(e) => {
                                // Only allow digits and spaces
                                const val = e.target.value.replace(/[^\d\s]/g, '');
                                setCode(val);
                            }}
                            placeholder="000000"
                            maxLength={7}
                            required
                            className="w-full bg-nature-950 border border-nature-800 px-3.5 py-3 rounded-xl text-white text-center text-2xl font-mono tracking-[0.5em] focus:outline-none focus:border-amber-500 shadow-inner"
                            autoFocus
                        />
                    </div>

                    {error && (
                        <div className="p-2.5 rounded-xl bg-red-900/30 border border-red-800 text-red-300 text-[11px] font-mono">
                            {error}
                        </div>
                    )}

                    <div className="flex justify-end gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold transition-all text-xs"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={submitting || !/^\d{6}$/.test(code.replace(/\s/g, ''))}
                            className="px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-bold transition-all shadow-md active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed text-xs"
                        >
                            {submitting ? 'Verifying...' : 'Verify & Connect'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
