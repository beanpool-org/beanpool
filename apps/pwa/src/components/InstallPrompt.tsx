/**
 * InstallPrompt — PWA Install helpers & Desktop steps (front doors S4)
 *
 * S4: The floating install banner on phones has been removed to prevent the "two icons"
 * problem and guide phone users to the native app instead.
 * Desktop install promotion now lives in Settings ("Install on this computer"),
 * triggering the deferred beforeinstallprompt or showing instructions.
 */

import { useState, useEffect } from 'react';
import { t } from '@beanpool/core';
import { Sentence } from './Sentence';

/** Detect if running as installed PWA (standalone mode) */
export function isInstalled(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(display-mode: standalone)').matches
        || (window.navigator as any).standalone === true;
}

let globalDeferredPrompt: any = null;
const promptListeners = new Set<(prompt: any) => void>();

if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (e: Event) => {
        e.preventDefault();
        globalDeferredPrompt = e;
        promptListeners.forEach(listener => listener(e));
    });

    window.addEventListener('appinstalled', () => {
        globalDeferredPrompt = null;
        promptListeners.forEach(listener => listener(null));
    });
}

/**
 * Access the deferred install prompt on desktop.
 */
export function useDeferredInstallPrompt() {
    const [prompt, setPrompt] = useState<any>(globalDeferredPrompt);

    useEffect(() => {
        const handler = (p: any) => setPrompt(p);
        promptListeners.add(handler);
        return () => {
            promptListeners.delete(handler);
        };
    }, []);

    return prompt;
}

/**
 * Desktop installation instructions shown when browser has no beforeinstallprompt.
 */
export function DesktopInstallSteps() {
    return (
        <div
            className="p-3 rounded-xl bg-nature-100 dark:bg-nature-800 text-xs text-nature-700 dark:text-nature-200 leading-relaxed mt-2"
            data-testid="desktop-install-steps"
        >
            <Sentence
                text={t('Look for the {icon} (⊕) in your browser\'s address bar, or use your browser menu → "Install app"')}
                parts={{
                    icon: <strong className="font-semibold text-bp-commit-fill dark:text-blue-400">{t('install icon')}</strong>,
                }}
            />
        </div>
    );
}

/**
 * InstallPrompt banner is removed on phones and desktop (front doors S4).
 * Retained for backwards compatibility returning null.
 */
export function InstallPrompt(_props?: { hidden?: boolean }) {
    return null;
}
