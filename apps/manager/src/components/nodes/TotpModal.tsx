import React, { useState, useEffect, useRef } from 'react';

interface TotpModalProps {
    nodeName: string;
    onClose: () => void;
    onSubmit: (code: string) => Promise<void> | void;
    error?: string;
}

export function TotpModal({ nodeName, onClose, onSubmit, error }: TotpModalProps) {
    const [code, setCode] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const dialogRef = useRef<HTMLDivElement>(null);

    // Focus trap: keep Tab within the dialog
    useEffect(() => {
        const el = dialogRef.current;
        if (!el) return;
        const focusable = el.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const trap = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            if (e.shiftKey) {
                if (document.activeElement === first) {
                    e.preventDefault();
                    last?.focus();
                }
            } else {
                if (document.activeElement === last) {
                    e.preventDefault();
                    first?.focus();
                }
            }
        };
        // Focus the first element on mount
        first?.focus();
        el.addEventListener('keydown', trap);
        return () => el.removeEventListener('keydown', trap);
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const clean = code.replace(/\s/g, '');
        if (!/^\d{6}$/.test(clean)) return;
        setSubmitting(true);
        try {
            await onSubmit(clean);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        // Outer overlay: Escape closes, click-outside closes
        <div
            className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-[60] animate-fade-in font-sans"
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="totp-title" aria-describedby="totp-desc"
                 className="bg-nature-900 border border-nature-800 rounded-3xl p-6 max-w-sm w-full space-y-5 shadow-2xl">
                <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                    <div className="flex items-center gap-2.5">
                        <div aria-hidden="true" className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-lg font-bold">
                            🔐
                        </div>
                        <h3 id="totp-title" className="text-base font-bold text-white m-0">Two-Factor Auth Required</h3>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="text-nature-500 hover:text-white transition-colors text-lg"
                    >
                        ✕
                    </button>
                </div>

                <p id="totp-desc" className="text-xs text-nature-300 leading-relaxed m-0">
                    <strong className="text-white">{nodeName}</strong> has 2FA enabled.
                    Enter the 6-digit code from your authenticator app to connect.
                </p>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label htmlFor="totp-code" className="block text-nature-300 font-semibold mb-1 text-xs">
                            Authenticator Code
                        </label>
                        <input
                            id="totp-code"
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            value={code}
                            onChange={(e) => {
                                const val = e.target.value.replace(/[^\d\s]/g, '');
                                setCode(val);
                            }}
                            placeholder="000000"
                            maxLength={7}
                            required
                            className={`w-full bg-nature-950 border px-3.5 py-3 rounded-xl text-white text-center text-2xl font-mono tracking-[0.5em] focus:outline-none shadow-inner ${error ? 'border-red-500 focus:border-red-500' : 'border-nature-800 focus:border-amber-500'}`}
                            autoFocus
                        />
                    </div>

                    {error && (
                        <div role="alert" aria-live="assertive" className="p-2.5 rounded-xl bg-red-900/30 border border-red-800 text-red-300 text-[11px] font-mono">
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
