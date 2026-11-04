import { useEffect, useState } from 'react';
import { t } from '@beanpool/core';

/** The page this community's server serves its Android APK on (apps/server/src/routes/android.ts). */
export const NODE_APK_PAGE = '/android';

/** An iPhone or iPad, where an Android APK is no use. */
function onIos(): boolean {
    return typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

/**
 * "Get the Android app": the APK this community's server holds, for a phone on its local network (lights-out H3). The
 * server answers /android/link only to a request straight off its local network, with an APK held and the operator's
 * link not hidden (HIDE_APK_LINK); anywhere else it is a path that does not exist, and this draws nothing. Never on an
 * iPhone.
 */
export function NodeApkLink() {
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (onIos() || typeof fetch !== 'function') return;
        let live = true;
        fetch(`${NODE_APK_PAGE}/link`, { cache: 'no-store', credentials: 'omit' })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (live && j && j.href === NODE_APK_PAGE) setShown(true); })
            .catch(() => undefined);
        return () => { live = false; };
    }, []);
    if (!shown) return null;
    return (
        <p style={{ margin: '-1rem 0 1.25rem' }}>
            <a
                href={NODE_APK_PAGE}
                data-testid="node-apk-link"
                className="text-nature-600 dark:text-nature-400 hover:underline font-semibold min-h-[44px] inline-flex items-center"
                style={{ overflowWrap: 'anywhere' }}
            >
                {t('Get the Android app')}
            </a>
        </p>
    );
}
