/**
 * Settings → Notifications' first row on the web (scratch/fable-design/DESIGN-web-notifications-fable.md §2.3, slice W2):
 * "On this device", and what this browser is: On, Off, or Blocked by your browser. Turn on asks the browser there and then,
 * at the tap, with the phone's card's reason above it (memory permissions-only-when-asked: never on load, no worker
 * installed before it); Turn off lets the
 * community go of this browser and ends the browser's subscription. Where push can't reach this browser (an iPhone outside
 * the Home Screen, a private window, a page reached over http, the app talking to another community), it says so and
 * offers nothing. The switches under it now reach this browser too: the same ones as the phone.
 */
import { useState } from 'react';
import { t, word } from '@beanpool/core';
import { NOTIFICATION_CARD_WORDS, TELL_ME_WORDS, turnOffWebPush, turnOnWebPush, webPushOrigin, webPushState, type WebPushState } from '../lib/web-push';
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
    failed: word("This community couldn't take the request. Try again in a moment."),
} as const;

export function WebPushRow({ identity }: { identity: BeanPoolIdentity }) {
    const [lang] = useLanguage();
    const origin = webPushOrigin(getNodeApiUrl());
    const [state, setState] = useState<WebPushState>(() => webPushState(origin, identity.publicKey));
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    const status = state === 'on' ? t(WEB_PUSH_ROW_WORDS.on) : state === 'blocked' ? t(WEB_PUSH_ROW_WORDS.blocked) : state === 'off' ? t(WEB_PUSH_ROW_WORDS.off) : null;

    const turnOn = async () => {
        if (!origin) return;
        setBusy(true);
        setFailed(false);
        const r = await turnOnWebPush(origin, identity, lang);
        setBusy(false);
        if (!r.ok && r.reason === 'failed') setFailed(true);
        setState(webPushState(origin, identity.publicKey));
    };
    const turnOff = async () => {
        if (!origin) return;
        setBusy(true);
        await turnOffWebPush(origin, identity);
        setBusy(false);
        setState(webPushState(origin, identity.publicKey));
    };

    return (
        <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800" data-testid="web-push-row" data-state={state}>
            <div className="flex flex-wrap justify-between items-center gap-3">
                <div className="min-w-0">
                    <div className="text-sm font-bold text-nature-900 dark:text-white">{t(WEB_PUSH_ROW_WORDS.name)}</div>
                    {status && <div className="text-xs text-nature-500 dark:text-nature-400" data-testid="web-push-status">{status}</div>}
                    {/* The reason first, before the tap that asks (the phone's card's words). */}
                    {state === 'off' && <div className="text-xs text-nature-600 dark:text-nature-300 mt-1">{t(NOTIFICATION_CARD_WORDS.body)}</div>}
                </div>
                {state === 'off' && (
                    <button type="button" onClick={turnOn} disabled={busy}
                        className="min-h-[48px] px-4 rounded-xl font-bold text-sm bg-nature-700 hover:bg-nature-800 text-white dark:bg-nature-600 dark:hover:bg-nature-500 border-none cursor-pointer disabled:opacity-60 disabled:cursor-wait">
                        {t(NOTIFICATION_CARD_WORDS.turnOn)}
                    </button>
                )}
                {state === 'on' && (
                    <button type="button" onClick={turnOff} disabled={busy}
                        className="min-h-[48px] px-4 rounded-xl font-bold text-sm bg-oat-100 hover:bg-oat-200 text-nature-800 dark:bg-nature-800 dark:hover:bg-nature-700 dark:text-nature-200 border-none cursor-pointer disabled:opacity-60 disabled:cursor-wait">
                        {t(WEB_PUSH_ROW_WORDS.turnOff)}
                    </button>
                )}
            </div>
            {state === 'blocked' && <p className="m-0 mt-2 text-xs text-nature-600 dark:text-nature-300">{t(TELL_ME_WORDS.blocked)}</p>}
            {state === 'cannot' && <p className="m-0 mt-2 text-xs text-nature-600 dark:text-nature-300">{t(WEB_PUSH_ROW_WORDS.cannot)}</p>}
            {failed && <p role="alert" className="m-0 mt-2 text-xs text-red-700 dark:text-red-300">{t(WEB_PUSH_ROW_WORDS.failed)}</p>}
        </div>
    );
}
