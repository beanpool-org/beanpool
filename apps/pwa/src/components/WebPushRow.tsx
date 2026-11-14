/**
 * Settings → Notifications' first row on the web (scratch/fable-design/DESIGN-web-notifications-fable.md §2.3, slice W2):
 * "On this device", and what this browser is: On, Off, or Blocked by your browser. Turn on asks the browser there and then,
 * at the tap, with the phone's card's reason above it (memory permissions-only-when-asked: never on load, no worker
 * installed before it); Turn off lets the
 * community go of this browser and ends the browser's subscription, and once on it says how long this browser can be told
 * (design §2.4: while Chrome runs, even with Safari closed, on this phone). Where push can't reach this browser (an iPhone
 * outside the Home Screen, a private window, a page reached over http) or the browser blocks it, it says so; on a phone,
 * the app's store link comes first, the Home Screen words second (Marty, 9 Nov, Decision 3; web push W3), as the waiting
 * page's Tell me does. The switches under it now reach this browser too: the same ones as the phone.
 */
import { useState } from 'react';
import { PEEK_WORDS, t, word } from '@beanpool/core';
import {
    NOTIFICATION_CARD_WORDS, TELL_ME_WORDS, cannotLines, grantedLine, pushEnv, pushPlace, turnOffWebPush, turnOnWebPush, webPushOrigin, webPushState,
    type PushEnv, type WebPushState,
} from '../lib/web-push';
import { getNodeApiUrl } from '../lib/api';
import { useLanguage } from '../lib/useLanguage';
import type { BeanPoolIdentity } from '../lib/identity';

export const WEB_PUSH_ROW_WORDS = {
    name: word('On this device'),
    on: word('On', 'notifications on this device'),
    off: word('Off', 'notifications on this device'),
    blocked: word('Blocked by your browser'),
    turnOff: word('Turn off'),
    cannot: word("Notifications can't reach this browser. The bell still lists what happened."),
    /** An iPhone or iPad in Safari (iOS 16.4+): only BeanPool opened from the Home Screen gets notifications. */
    homeScreen: word('On an iPhone, notifications only work from the Home Screen. Tap Share, then Add to Home Screen, open BeanPool from there and tap Turn on again.'),
    failed: word("This community couldn't take the request. Try again in a moment."),
} as const;

/** `env`: this browser's answers to the feature tests, read afresh at each use unless given (tests give one). */
export function WebPushRow({ identity, env }: { identity: BeanPoolIdentity; env?: PushEnv }) {
    const [lang] = useLanguage();
    const origin = webPushOrigin(getNodeApiUrl());
    const envNow = () => env ?? pushEnv();
    const [state, setState] = useState<WebPushState>(() => webPushState(origin, identity.publicKey, envNow()));
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    const status = state === 'on' ? t(WEB_PUSH_ROW_WORDS.on) : state === 'blocked' ? t(WEB_PUSH_ROW_WORDS.blocked) : state === 'off' ? t(WEB_PUSH_ROW_WORDS.off) : null;
    // Where this browser stands, by feature tests (lib/web-push.ts pushPlace): how long it is told once on, and, where it
    // can't be, the words for it, after the app's store link on a phone.
    const place = pushPlace(envNow());
    const told = state === 'on' ? grantedLine(place) : '';
    const getApp = state === 'cannot' || state === 'blocked' ? cannotLines(place).getApp : null;
    const why = state === 'blocked' ? t(TELL_ME_WORDS.blocked)
        : state === 'cannot' ? (place.kind === 'home-screen' ? t(WEB_PUSH_ROW_WORDS.homeScreen) : t(WEB_PUSH_ROW_WORDS.cannot)) : null;

    const turnOn = async () => {
        if (!origin) return;
        setBusy(true);
        setFailed(false);
        const r = await turnOnWebPush(origin, identity, lang);
        setBusy(false);
        if (!r.ok && r.reason === 'failed') setFailed(true);
        setState(webPushState(origin, identity.publicKey, envNow()));
    };
    const turnOff = async () => {
        if (!origin) return;
        setBusy(true);
        await turnOffWebPush(origin, identity);
        setBusy(false);
        setState(webPushState(origin, identity.publicKey, envNow()));
    };

    return (
        <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800" data-testid="web-push-row" data-state={state}>
            <div className="flex flex-wrap justify-between items-center gap-3">
                <div className="min-w-0">
                    <div className="text-sm font-bold text-nature-900 dark:text-white">{t(WEB_PUSH_ROW_WORDS.name)}</div>
                    {status && <div className="text-xs text-nature-500 dark:text-nature-400" data-testid="web-push-status">{status}</div>}
                    {told && <div dir="auto" className="text-xs text-nature-600 dark:text-nature-300 mt-1 break-words" data-testid="web-push-told">{told}</div>}
                    {/* The reason first, before the tap that asks (the phone's card's words). */}
                    {state === 'off' && <div className="text-xs text-nature-600 dark:text-nature-300 mt-1">{t(NOTIFICATION_CARD_WORDS.body)}</div>}
                </div>
                {state === 'off' && (
                    <button type="button" onClick={turnOn} disabled={busy}
                        className="min-h-[48px] px-4 rounded-xl font-bold text-sm bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on border-none cursor-pointer disabled:opacity-60 disabled:cursor-wait">
                        {t(NOTIFICATION_CARD_WORDS.turnOn)}
                    </button>
                )}
                {state === 'on' && (
                    <button type="button" onClick={turnOff} disabled={busy}
                        className="min-h-[48px] px-4 rounded-xl font-bold text-sm bg-transparent border border-bp-ink-info text-bp-ink-info cursor-pointer disabled:opacity-60 disabled:cursor-wait">
                        {t(WEB_PUSH_ROW_WORDS.turnOff)}
                    </button>
                )}
            </div>
            {getApp && (
                <a href={getApp} rel="noopener noreferrer" data-testid="web-push-get-app"
                    className="mt-3 min-h-[48px] px-4 rounded-xl font-bold text-sm bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on no-underline flex items-center justify-center">
                    {t(PEEK_WORDS.getApp)}
                </a>
            )}
            {why && <p dir="auto" className="m-0 mt-2 text-xs text-nature-600 dark:text-nature-300 break-words" data-testid="web-push-why">{why}</p>}
            {failed && <p role="alert" className="m-0 mt-2 text-xs text-red-700 dark:text-red-300">{t(WEB_PUSH_ROW_WORDS.failed)}</p>}
        </div>
    );
}
