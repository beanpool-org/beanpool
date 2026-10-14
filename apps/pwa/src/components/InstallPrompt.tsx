/**
 * InstallPrompt — PWA Install Banner
 *
 * Shows a floating prompt when the app isn't installed as a PWA.
 * Detects iOS vs Android and shows device-specific instructions.
 * Dismisses for 7 days on close.
 *
 * Never on top of the tour or a screen that fills the phone (rehearsal 14 Oct 2026, B1: at 320 px it took taps meant for
 * the tour's Next and Skip, and covered Start a community and the report form): App passes `hidden` while the tour runs
 * or is still offered, and any screen counted by lib/screen-cover keeps it down. It comes up 2 s after it may.
 *
 * The banner is navy in both themes, so its words are the brand's white ink (`--bp-commit-on`), never the page's ink.
 */

import { useState, useEffect } from 'react';
import { useScreenCovered } from '../lib/screen-cover';

const ON_BRAND = 'var(--bp-commit-on)';

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
// A separate key rather than a sentinel inside DISMISS_KEY: that field holds a timestamp and
// is read with Number(), so parking a string like 'forever' in it would evaluate to NaN and
// silently fail the comparison.
const DISMISS_FOREVER_KEY = 'beanpool-install-dismissed-forever';
const DISMISS_DAYS = 7;

export function InstallPrompt({ hidden = false }: { hidden?: boolean } = {}) {
    const covered = useScreenCovered();
    /** Not installed and not put away: the banner may come up once nothing else is in front. */
    const [eligible, setEligible] = useState(false);
    const [show, setShow] = useState(false);
    const [showSteps, setShowSteps] = useState(false);
    const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

    useEffect(() => {
        // Don't show if already installed
        if (isInstalled()) return;

        // Don't show if the member asked never to see it again
        if (localStorage.getItem(DISMISS_FOREVER_KEY) === '1') return;

        // Don't show if recently dismissed
        const dismissed = localStorage.getItem(DISMISS_KEY);
        if (dismissed && Date.now() - Number(dismissed) < DISMISS_DAYS * 86400000) return;

        setEligible(true);

        // Listen for the Chrome/Android install prompt
        const handler = (e: Event) => {
            e.preventDefault();
            setDeferredPrompt(e);
        };
        window.addEventListener('beforeinstallprompt', handler);

        return () => {
            window.removeEventListener('beforeinstallprompt', handler);
        };
    }, []);

    // Show after a short delay so it doesn't block first impression, counted from when nothing is in front of it.
    const blocked = hidden || covered;
    useEffect(() => {
        if (!eligible || show || blocked) return;
        const timer = setTimeout(() => setShow(true), 2000);
        return () => clearTimeout(timer);
    }, [eligible, show, blocked]);

    function handleDismiss() {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
        setEligible(false);
        setShow(false);
    }

    function handleDismissForever() {
        localStorage.setItem(DISMISS_FOREVER_KEY, '1');
        setEligible(false);
        setShow(false);
    }

    async function handleNativeInstall() {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const result = await deferredPrompt.userChoice;
            if (result.outcome === 'accepted') {
                setEligible(false);
                setShow(false);
            }
            setDeferredPrompt(null);
        }
    }

    if (!show || blocked) return null;

    const ios = isIOS();
    const android = isAndroid();

    return (
        <div
            role="region"
            aria-label="App installation prompt"
            style={{
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
            }}
        >
            <style>{`
                @keyframes slideUp {
                    from { transform: translateY(100%); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
            `}</style>

            {/* Close button */}
            <button
                type="button"
                onClick={handleDismiss}
                style={{
                    position: 'absolute', top: '0.4rem', right: '0.5rem',
                    background: 'rgba(255,255,255,0.1)', border: 'none', color: ON_BRAND,
                    fontSize: '1rem', cursor: 'pointer', padding: '0.4rem 0.6rem',
                    borderRadius: '8px', lineHeight: 1,
                    minWidth: '44px', minHeight: '44px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                className="focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                aria-label="Dismiss install prompt"
            >✕</button>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: showSteps ? '0.75rem' : 0 }}>
                <span style={{ fontSize: '2rem' }} aria-hidden="true">📲</span>
                <div style={{ flex: 1 }}>
                    <p style={{ fontWeight: 700, fontSize: '0.95rem', color: ON_BRAND, marginBottom: '0.2rem' }}>
                        Install BeanPool
                    </p>
                    <p style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                        Get the full app on your home screen
                    </p>
                </div>
                {deferredPrompt ? (
                    <button
                        type="button"
                        onClick={handleNativeInstall}
                        style={{
                            padding: '0.5rem 1rem', borderRadius: '10px',
                            background: 'var(--bp-commit-fill)', color: ON_BRAND, border: 'none',
                            fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                            fontFamily: 'inherit',
                            minWidth: '44px', minHeight: '44px',
                        }}
                        className="focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                        Install
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => setShowSteps(!showSteps)}
                        aria-expanded={showSteps}
                        style={{
                            padding: '0.5rem 1rem', borderRadius: '10px',
                            background: showSteps ? '#333' : 'var(--bp-commit-fill)', color: ON_BRAND,
                            border: 'none', fontSize: '0.85rem', fontWeight: 600,
                            // No nowrap: at 320 px with 130 % text the row squeezes the button, and 'Hide steps' ran out past its fill.
                            cursor: 'pointer', fontFamily: 'inherit',
                            minWidth: '44px', minHeight: '44px',
                        }}
                        className="focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                        {showSteps ? 'Hide steps' : 'How?'}
                    </button>
                )}
            </div>

            {/* The X only snoozes for a week. This is the way out for someone who is never
                going to install it — and it now survives signing out. */}
            <button
                type="button"
                onClick={handleDismissForever}
                style={{
                    alignSelf: 'flex-start', marginTop: '0.15rem', padding: '0.25rem 0',
                    background: 'none', border: 'none', color: '#94a3b8',
                    fontSize: '0.78rem', fontFamily: 'inherit', cursor: 'pointer',
                    textDecoration: 'underline', textUnderlineOffset: '2px',
                    minHeight: '44px', display: 'inline-flex', alignItems: 'center',
                }}
                className="focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
                Don&rsquo;t show this again
            </button>

            {/* Device-specific instructions */}
            {showSteps && (
                <div style={{
                    background: 'rgba(0,0,0,0.3)', borderRadius: '10px',
                    padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#cbd5e1',
                    lineHeight: 1.6,
                }}>
                    {ios ? (
                        <>
                            <p style={{ fontWeight: 600, color: ON_BRAND, marginBottom: '0.4rem' }}>iPhone / iPad:</p>
                            <p>1. Tap the <strong style={{ color: '#60a5fa' }}>Share</strong> button <span style={{ fontSize: '1.1rem' }}>⬆</span> at the bottom</p>
                            <p>2. Scroll down and tap <strong style={{ color: '#60a5fa' }}>"Add to Home Screen"</strong></p>
                            <p>3. Tap <strong style={{ color: '#60a5fa' }}>"Add"</strong> in the top right</p>
                        </>
                    ) : android ? (
                        <>
                            <p style={{ fontWeight: 600, color: ON_BRAND, marginBottom: '0.4rem' }}>Android:</p>
                            <p>1. Tap the <strong style={{ color: '#60a5fa' }}>⋮ menu</strong> in the top right</p>
                            <p>2. Tap <strong style={{ color: '#60a5fa' }}>"Add to Home screen"</strong></p>
                            <p>3. Tap <strong style={{ color: '#60a5fa' }}>"Add"</strong> to confirm</p>
                        </>
                    ) : (
                        <>
                            <p style={{ fontWeight: 600, color: ON_BRAND, marginBottom: '0.4rem' }}>Desktop:</p>
                            <p>Look for the <strong style={{ color: '#60a5fa' }}>install icon</strong> (⊕) in your browser's address bar, or use your browser menu → "Install app"</p>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
