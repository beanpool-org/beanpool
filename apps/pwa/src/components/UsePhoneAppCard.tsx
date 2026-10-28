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

const APP_STORE_BADGE =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
        '<svg viewBox="0 0 135 40" width="135" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="135" height="40" rx="7" fill="#000"/><rect x="0.5" y="0.5" width="134" height="39" rx="6.5" stroke="#ffffff" stroke-opacity="0.65" fill="none"/><text x="42" y="15" fill="#fff" font-family="Inter,sans-serif" font-size="8" font-weight="400">Download on the</text><text x="42" y="29" fill="#fff" font-family="Inter,sans-serif" font-size="16" font-weight="600">App Store</text><g transform="translate(10, 6) scale(0.58)"><path d="M24.769 20.3c-.04-4.25 3.47-6.29 3.63-6.39-1.98-2.89-5.06-3.29-6.15-3.33-2.62-.27-5.11 1.54-6.44 1.54-1.33 0-3.38-1.5-5.56-1.46-2.86.04-5.5 1.66-6.97 4.22-2.97 5.16-.76 12.81 2.14 17 1.41 2.05 3.1 4.35 5.32 4.27 2.13-.09 2.94-1.38 5.52-1.38 2.58 0 3.3 1.38 5.56 1.34 2.3-.04 3.76-2.09 5.15-4.15 1.62-2.38 2.29-4.69 2.33-4.81-.05-.02-4.47-1.72-4.52-6.81z" fill="#fff"/><path d="M20.514 7.54c1.18-1.43 1.97-3.42 1.76-5.4-1.7.07-3.76 1.13-4.98 2.56-1.09 1.27-2.05 3.29-1.79 5.23 1.9.15 3.83-0.96 5.01-2.39z" fill="#fff"/></g></svg>'
    );

const GOOGLE_PLAY_BADGE =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
        '<svg viewBox="0 0 135 40" width="135" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="135" height="40" rx="7" fill="#000"/><rect x="0.5" y="0.5" width="134" height="39" rx="6.5" stroke="#ffffff" stroke-opacity="0.65" fill="none"/><text x="47" y="15" fill="#fff" font-family="Inter,sans-serif" font-size="8" font-weight="400">GET IT ON</text><text x="47" y="29" fill="#fff" font-family="Inter,sans-serif" font-size="14" font-weight="600">Google Play</text><g transform="translate(10, 7)"><path d="M4 1.5L17 13 4 24.5V1.5z" fill="#4285F4"/><path d="M4 1.5L17 13l4.5-4L8 1.5H4z" fill="#34A853"/><path d="M4 24.5l4.5 0 13-8L17 13 4 24.5z" fill="#EA4335"/><path d="M8 1.5l13.5 7.5L24 7.5 8 0v1.5z" fill="#FBBC04"/><path d="M21.5 18.5L8 26v-1.5l13.5-7.5L24 18.5z" fill="#EA4335"/></g></svg>'
    );

export function StoreBadges() {
    return (
        <div className="flex flex-wrap items-center gap-3 my-2" data-testid="store-badges">
            {/* App Store Badge */}
            <a
                href="https://apps.apple.com/au/app/bean-pool/id6761870086"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block hover:opacity-90 transition-opacity min-h-[44px] flex items-center"
                aria-label={t('Download on the App Store')}
            >
                <img src={APP_STORE_BADGE} alt="" width={135} height={40} className="h-10 w-[135px]" />
            </a>

            {/* Google Play Badge */}
            <a
                href="https://play.google.com/store/apps/details?id=org.beanpool.pillar"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block hover:opacity-90 transition-opacity min-h-[44px] flex items-center"
                aria-label={t('Get it on Google Play')}
            >
                <img src={GOOGLE_PLAY_BADGE} alt="" width={135} height={40} className="h-10 w-[135px]" />
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
                className="absolute top-3 right-3 text-nature-400 dark:text-nature-500 hover:text-nature-600 dark:hover:text-nature-300 min-w-[44px] min-h-[44px] flex items-center justify-center text-lg bg-transparent border-none cursor-pointer p-0"
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
