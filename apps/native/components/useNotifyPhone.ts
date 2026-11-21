/**
 * What the phone itself says about notifications, for slice N2b's true lines (DESIGN-notify-and-backup-asks-fable-amend2.md
 * §6, §12.3: an event's "⏰ Reminders need notifications on."). Its own file, beside components/NotifyLine.tsx, so a screen
 * that draws a true line and no named line (EventExtras) loads no icons and nothing of expo-notifications as it opens.
 */
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { NotifyPhone } from '@beanpool/core';

/** Every place drawing from the phone's own answer (useNotifyPhone), told to read it again after a Turn on or a Tell me. */
const phoneReaders = new Set<() => void>();

/** A Turn on or a Tell me has had its answer: every true line on screen reads the phone again. */
export function notePhoneChanged(): void {
    for (const read of [...phoneReaders]) read();
}

const NOTHING_HERE: NotifyPhone = { available: false, granted: false, canAskAgain: false };

/**
 * The phone's own answer (utils/notification-permission.ts readOsNotificationPermission): null until read, then read again on
 * each return to the app (back from the phone's settings) and after any Turn on or Tell me on this phone (notePhoneChanged).
 * Never asks; a read that fails is "nothing to turn on here". `wanted`: only while the line could be drawn (an event's
 * reminder box is drawn only for a member Going or Interested), so a screen that draws none never loads expo-notifications;
 * null while not wanted. Loaded at the call, as NotifyLine's rule is.
 */
export function useNotifyPhone(wanted = true): NotifyPhone | null {
    const [phone, setPhone] = useState<NotifyPhone | null>(null);
    useEffect(() => {
        if (!wanted) return;
        let live = true;
        const read = () => {
            void import('../utils/notification-permission')
                .then((m) => m.readOsNotificationPermission())
                .catch(() => NOTHING_HERE)
                .then((p) => { if (live) setPhone(p); });
        };
        read();
        phoneReaders.add(read);
        let sub: { remove?: () => void } | undefined;
        try {
            sub = AppState.addEventListener('change', (next) => { if (next === 'active') read(); });
        } catch {
            // No app state here (a runner without it): the reads at the taps still come.
        }
        return () => { live = false; phoneReaders.delete(read); sub?.remove?.(); };
    }, [wanted]);
    return wanted ? phone : null;
}
