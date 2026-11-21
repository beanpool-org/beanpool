/**
 * The browser and the record for the web's named lines and true lines (slice N5b; components/NotifyLine.tsx), shared by each
 * surface's table (EventDetail.notify, HomePage.notify-lines, ForumPage.notify, MessagesPage.notify). Nothing here asks a
 * real browser: each state is what the browser would already say, and its prompt is a spy that must not run before a tap.
 */
import { expect, vi } from 'vitest';
import { localDay } from '@beanpool/core';

/** The four browser states the brief names, and the one between: granted for the site while this account isn't on here. */
export type BrowserKind = 'unsupported' | 'default' | 'denied' | 'granted' | 'granted-site-only';
export const BROWSERS: readonly BrowserKind[] = ['unsupported', 'default', 'denied', 'granted', 'granted-site-only'];
/** Where a soft ask (a named line) may show: web push here, it can still ask, and this account's notifications aren't on. */
export const CAN_OFFER: Record<BrowserKind, boolean> = { unsupported: false, default: true, denied: false, granted: false, 'granted-site-only': true };
/** Where the true lines say notifications are off (core notifyRemindersOff): web push here and this account's not on. */
export const SAYS_OFF: Record<BrowserKind, boolean> = { unsupported: false, default: true, denied: true, granted: false, 'granted-site-only': true };

/** Stands the browser in; answers the prompt's spy (it must not run before a tap). */
export function standBrowser(kind: BrowserKind, publicKey: string, answer: NotificationPermission = 'default') {
    const requestPermission = vi.fn(async () => answer);
    if (kind === 'unsupported') return requestPermission;
    Object.defineProperty(navigator, 'serviceWorker', {
        value: { register: vi.fn(async () => { throw new Error('no worker here'); }), getRegistration: vi.fn(async () => undefined), addEventListener() {}, removeEventListener() {} },
        configurable: true,
    });
    (globalThis as any).Notification = { permission: kind === 'granted' || kind === 'granted-site-only' ? 'granted' : kind, requestPermission };
    (window as any).PushManager = function PushManager() {};
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    if (kind === 'granted') turnedOnHere(publicKey);
    return requestPermission;
}

/** This account's notifications on in this browser: the member's pin a Turn on leaves. */
export function turnedOnHere(publicKey: string) {
    localStorage.setItem('beanpool_web_push', JSON.stringify([{ origin: window.location.origin, publicKey, subId: 'e'.repeat(64), pushKey: null, vapidKey: 'BAAA', for: 'member' }]));
}

export function clearBrowser() {
    delete (globalThis as any).Notification;
    delete (window as any).PushManager;
    delete (navigator as any).serviceWorker;
    localStorage.clear();
}

/** The record's states the rule reads for a line (core notifyAsks `line`), each kept in this browser for the key. */
export type RecordKind = 'fresh' | 'kind spent' | 'day taken by Home\'s once card' | 'the join\'s screen today' | 'a Later yesterday';
export const RECORDS: Record<RecordKind, { offers: boolean; pins: string }> = {
    fresh: { offers: true, pins: 'none' },
    'kind spent': { offers: false, pins: 'each kind once (lines)' },
    "day taken by Home's once card": { offers: false, pins: 'one soft ask a day (askDay)' },
    "the join's screen today": { offers: true, pins: "the join's day still allows one line" },
    'a Later yesterday': { offers: true, pins: 'Later is never final' },
};
export function keepRecord(publicKey: string, kind: RecordKind, line: string, now = Date.now()) {
    const today = localDay(new Date(now));
    const r = kind === 'kind spent' ? { lines: [line] }
        : kind === "day taken by Home's once card" ? { askDay: today, askKind: 'once', onceAt: now }
            : kind === "the join's screen today" ? { askDay: today, askKind: 'join', joinAt: now, laterAt: now }
                : kind === 'a Later yesterday' ? { laterAt: now - 86_400_000 }
                    : {};
    localStorage.setItem(`beanpool_notify_ask:${publicKey}`, JSON.stringify(r));
}

/** An old phone's browser: 320 px wide with text at 130%, in light or dark. */
export function oldPhone(dark: boolean) {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true });
    document.documentElement.style.fontSize = '130%';
    document.documentElement.classList.toggle('dark', dark);
}
export function resetScreen() {
    document.documentElement.classList.remove('dark');
    document.documentElement.style.fontSize = '';
}

/** The named line wraps and keeps its 44 px target at 320 px and 130%, with colours from the tokens only. */
export function expectLineFits(line: HTMLElement) {
    const tellMe = line.querySelector('[data-testid="notify-line-tell-me"]') as HTMLElement | null;
    if (tellMe) expect(tellMe.className).toMatch(/min-h-\[44px\]/);
    expect(line.className).toMatch(/flex-wrap|break-words/);
    expect(line.outerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|text-(red|green|blue|gray)-\d/i);
}
