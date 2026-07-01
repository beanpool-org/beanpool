/**
 * InstallPrompt — PWA Install Banner
 *
 * Shows a floating prompt when the app isn't installed as a PWA.
 * Detects iOS vs Android and shows device-specific instructions.
 * Dismisses for 7 days on close.
 */

import { useState, useEffect } from 'react';

// Detect if running as installed PWA (standalone mode)
function isInstalled(): boolean {
    return window.matchMedia('(display-mode: standalone)').matches
        || (window.navigator as any).standalone === true;
}

function isIOS(): boolean {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
}

function isAndroid(): boolean {
    return /Android/.test(navigator.userAgent);
}

const DISMISS_KEY = 'beanpool-install-dismissed';
const DISMISS_DAYS = 7;

export function InstallPrompt() {
    const [show, setShow] = useState(false);
    const [showSteps, setShowSteps] = useState(false);
    const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

    useEffect(() => {
        // Don't show if already installed
        if (isInstalled()) return;

        // Don't show if recently dismissed
        const dismissed = localStorage.getItem(DISMISS_KEY);
        if (dismissed && Date.now() - Number(dismissed) < DISMISS_DAYS * 86400000) return;

        // Show after a short delay so it doesn't block first impression
        const timer = setTimeout(() => setShow(true), 2000);

        // Listen for the Chrome/Android install prompt
        const handler = (e: Event) => {
            e.preventDefault();
            setDeferredPrompt(e);
        };
        window.addEventListener('beforeinstallprompt', handler);

        return () => {
            clearTimeout(timer);
            window.removeEventListener('beforeinstallprompt', handler);
        };
    }, []);

    function handleDismiss() {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
        setShow(false);
    }

    async function handleNativeInstall() {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const result = await deferredPrompt.userChoice;
            if (result.outcome === 'accepted') {
                setShow(false);
            }
            setDeferredPrompt(null);
        }
    }

    if (!show) return null;

    const ios = isIOS();
    const android = isAndroid();

    return (
        <div style={{
            position: 'fixed',
            bottom: '4.5rem',
            left: '0.75rem',
            right: '0.75rem',
            background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
            border: '1px solid #2563eb',
            borderRadius: '16px',
            padding: '1rem 1.25rem',
            zIndex: 1000,
            boxShadow: '0 8px 32px rgba(37, 99, 235, 0.3)',
            animation: 'slideUp 0.4s ease-out',
        }}>
            <style>{`
                @keyframes slideUp {
                    from { transform: translateY(100%); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
            `}</style>

            {/* Close button */}
            <button
                onClick={handleDismiss}
                style={{
                    position: 'absolute', top: '0.4rem', right: '0.5rem',
                    background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff',
                    fontSize: '1rem', cursor: 'pointer', padding: '0.4rem 0.6rem',
                    borderRadius: '8px', lineHeight: 1,
                }}
                aria-label="Dismiss"
            >✕</button>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: showSteps ? '0.75rem' : 0 }}>
                <span style={{ fontSize: '2rem' }}>📲</span>
                <div style={{ flex: 1 }}>
                    <p style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '0.2rem' }}>
                        Install BeanPool
                    </p>
                    <p style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                        Get the full app on your home screen
                    </p>
                </div>
                {deferredPrompt ? (
                    <button
                        onClick={handleNativeInstall}
                        style={{
                            padding: '0.5rem 1rem', borderRadius: '10px',
                            background: '#2563eb', color: 'var(--text-primary)', border: 'none',
                            fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                            fontFamily: 'inherit', whiteSpace: 'nowrap',
                        }}
                    >
                        Install
                    </button>
                ) : (
                    <button
                        onClick={() => setShowSteps(!showSteps)}
                        style={{
                            padding: '0.5rem 1rem', borderRadius: '10px',
                            background: showSteps ? '#333' : '#2563eb', color: 'var(--text-primary)',
                            border: 'none', fontSize: '0.85rem', fontWeight: 600,
                            cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                        }}
                    >
                        {showSteps ? 'Hide' : 'How?'}
                    </button>
                )}
            </div>

            {/* Device-specific instructions */}
            {showSteps && (
                <div style={{
                    background: 'rgba(0,0,0,0.3)', borderRadius: '10px',
                    padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#cbd5e1',
                    lineHeight: 1.6,
                }}>
                    {ios ? (
                        <>
                            <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>iPhone / iPad:</p>
                            <p>1. Tap the <strong style={{ color: '#60a5fa' }}>Share</strong> button <span style={{ fontSize: '1.1rem' }}>⬆</span> at the bottom</p>
                            <p>2. Scroll down and tap <strong style={{ color: '#60a5fa' }}>"Add to Home Screen"</strong></p>
                            <p>3. Tap <strong style={{ color: '#60a5fa' }}>"Add"</strong> in the top right</p>
                        </>
                    ) : android ? (
                        <>
                            <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>Android:</p>
                            <p>1. Tap the <strong style={{ color: '#60a5fa' }}>⋮ menu</strong> in the top right</p>
                            <p>2. Tap <strong style={{ color: '#60a5fa' }}>"Add to Home screen"</strong></p>
                            <p>3. Tap <strong style={{ color: '#60a5fa' }}>"Add"</strong> to confirm</p>
                        </>
                    ) : (
                        <>
                            <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>Desktop:</p>
                            <p>Look for the <strong style={{ color: '#60a5fa' }}>install icon</strong> (⊕) in your browser's address bar, or use your browser menu → "Install app"</p>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
