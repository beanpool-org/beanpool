import { useState } from 'react';
import { t } from '@beanpool/core';
import { BoldWords } from './BoldWords';
import { isPhoneBrowser } from '../lib/global-entry';

const DISMISS_KEY_PREFIX = 'beanpool_use_phone_app_dismissed_';

export function isUsePhoneAppDismissed(publicKey: string): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
        return localStorage.getItem(`${DISMISS_KEY_PREFIX}${publicKey}`) === '1';
    } catch {
        return false;
    }
}

export function dismissUsePhoneApp(publicKey: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(`${DISMISS_KEY_PREFIX}${publicKey}`, '1');
    } catch {}
}

// The two store badges are Apple's and Google's OWN files (public/assets/app-store-badge.svg and google-play-badge.svg,
// byte for byte; storeBadgeArt.test.ts holds them to the SHA-256 recorded in the server's store-badge-art.ts). Both
// programmes forbid redrawing, recolouring, cropping, tilting or animating a badge, so nothing here touches the picture:
// no opacity, no hover movement. Rules kept, as on the invite page: both 40 px tall (Apple's minimum), the width each
// file's own shape gives (w-auto, so nothing is stretched), a quarter of the height (10 px = p-2.5) clear round each as
// the link's own padding, Apple's first. The pictures are English (the same file for every language); the alt text and
// the link's name are the page's language. The files are this node's own, so nothing here asks apple.com or google.com.
const APP_STORE_BADGE = '/assets/app-store-badge.svg';
const GOOGLE_PLAY_BADGE = '/assets/google-play-badge.svg';
// shrink-0 and max-w-none: Tailwind's base style holds every img to max-width: 100%. In the card's narrow text column at
// 320 px and 130% text that squeezed both pictures sideways to 131 px while h-10 held their height (52 px at 130%), so
// they were drawn out of shape. A badge keeps its shape and the row wraps instead.
const BADGE_LINK_CLASS =
    'block shrink-0 p-2.5 rounded-[10px] leading-[0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500';
const BADGE_IMG_CLASS = 'block h-10 w-auto max-w-none';

// The row's -mx-2.5 pulls it back by the clear space each link carries, so the pictures line up with the words above and
// below while the empty space round them stays (it falls on the padding of the box they stand in).
export function StoreBadges() {
    return (
        <div className="flex flex-wrap items-center -mx-2.5" data-testid="store-badges">
            {/* App Store Badge */}
            <a
                href="https://apps.apple.com/au/app/bean-pool/id6761870086"
                target="_blank"
                rel="noopener noreferrer"
                className={BADGE_LINK_CLASS}
                aria-label={t('Download on the App Store')}
            >
                <img src={APP_STORE_BADGE} alt={t('Download on the App Store')} width={120} height={40} loading="lazy" className={BADGE_IMG_CLASS} />
            </a>

            {/* Google Play Badge */}
            <a
                href="https://play.google.com/store/apps/details?id=org.beanpool.pillar"
                target="_blank"
                rel="noopener noreferrer"
                className={BADGE_LINK_CLASS}
                aria-label={t('Get it on Google Play')}
            >
                <img src={GOOGLE_PLAY_BADGE} alt={t('Get it on Google Play')} width={135} height={40} loading="lazy" className={BADGE_IMG_CLASS} />
            </a>
        </div>
    );
}

export function ApkDownloadLink() {
    return (
        <div className="mt-1">
            <a
                href="https://beanpool.org/android"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-nature-600 dark:text-nature-400 hover:underline min-h-[44px] inline-flex items-center"
            >
                {t('No Google Play? Download the app')}
            </a>
        </div>
    );
}

export function UsePhoneAppCard({
    publicKey,
    onDismiss,
    phoneLater,
}: {
    publicKey: string;
    onDismiss?: () => void;
    phoneLater?: string[];
}) {
    const isPhone = isPhoneBrowser();
    const handleDismiss = () => {
        dismissUsePhoneApp(publicKey);
        onDismiss?.();
    };

    return (
        <div
            data-testid="use-phone-app-card"
            className="w-full bg-white dark:bg-nature-900 rounded-2xl p-4 shadow-sm border border-nature-200 dark:border-nature-800 relative mb-3 text-nature-900 dark:text-white"
        >
            {/* Dismiss button */}
            <button
                type="button"
                onClick={handleDismiss}
                className="absolute top-3 right-3 text-nature-400 dark:text-nature-300 hover:text-nature-600 dark:hover:text-nature-200 min-w-[44px] min-h-[44px] flex items-center justify-center text-lg bg-transparent border-none cursor-pointer p-0"
                aria-label={t('Dismiss')}
            >
                ✕
            </button>

            <div className="flex items-start gap-3 pr-8">
                <span className="text-2xl" aria-hidden="true">📲</span>
                <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-base m-0 mb-1">
                        {t('Use the phone app')}
                    </h3>
                    <p className="text-sm text-nature-600 dark:text-nature-300 m-0 mb-2 leading-relaxed">
                        {t('Your account comes with you.')}
                    </p>
                    <p className="text-xs text-nature-500 dark:text-nature-400 m-0 mb-3 leading-relaxed">
                        {isPhone
                            ? t('BeanPool works best as the app on your phone: notifications, photos from your camera, your account kept safe.')
                            : t('Have a phone? BeanPool works best as the app on your phone: notifications, photos from your camera, your account kept safe.')}
                    </p>

                    <StoreBadges />
                    <ApkDownloadLink />

                    {phoneLater && phoneLater.length > 0 && (
                        <div className="mt-3 space-y-1 text-xs text-nature-600 dark:text-nature-300">
                            {phoneLater.map((line, i) => (
                                <p key={i} className="m-0 leading-relaxed">
                                    <BoldWords text={line} />
                                </p>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
