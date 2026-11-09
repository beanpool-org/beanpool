/**
 * The holding half of the account handoff (DESIGN-global-yes-join-fable.md §2.1-2.2, slice Y1): a yes from another
 * community, on the page that holds the account that asked (global's Home, or any community's whose member asked another).
 * **Join {name}** opens the community's page in this browser and hands it the account (lib/handoff.ts): to that exact
 * address, over the browser's own window-to-window channel, never an address, a request or a server.
 *
 *   - idle: Join {name}, and "Opens {name}'s page in this browser and brings your account with you. Same 12 words.";
 *   - running: "Carry on in the new tab.";
 *   - joined: "You joined {name}." and Open {name}; the request is forgotten here;
 *   - the tap couldn't work (pop-ups blocked, no answer, any refusal): the fallback card, with Try again, the 12 words at
 *     its page (slice Y0's route), and the phone.
 */
import { useEffect, useRef, useState } from 'react';
import { t } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { forgetKnock, type RememberedKnock } from '../lib/knock';
import { handoffUrl, holderPhoto, newHandoffNonce, runHandoff, type HandoffRun } from '../lib/handoff';

const PRIMARY = 'flex w-full min-h-[48px] px-4 py-2 items-center justify-center rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-base font-bold text-center break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info disabled:cursor-default disabled:opacity-60';
const SECONDARY = 'flex w-full min-h-[48px] px-4 py-2 items-center justify-center rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-900 dark:text-white no-underline text-center break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const NOTE = 'm-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words';

type State = 'idle' | 'running' | 'fallback' | 'joined';

export function YesJoin({ knock, name, identity, testId, onTapped, onJoined, readyMs }: {
    knock: RememberedKnock;
    name: string;
    identity: BeanPoolIdentity;
    testId: string;
    /** Join was tapped (the banner goes: Marty, 9 Nov, "until tapped"). */
    onTapped?: () => void;
    /** The community's page said the account joined. */
    onJoined?: () => void;
    /** How long to wait for the community's page to answer the open (lib/handoff.ts HANDOFF_READY_MS); tests shorten it. */
    readyMs?: number;
}) {
    const [state, setState] = useState<State>('idle');
    const run = useRef<HandoffRun | null>(null);
    useEffect(() => () => run.current?.cancel(), []);
    const address = knock.url.replace(/^https:\/\//, '');

    const join = () => {
        run.current?.cancel();
        const nonce = newHandoffNonce();
        // Inside the tap, synchronously: a pop-up blocker refuses an open made after an await.
        const win = window.open(handoffUrl(knock.url, nonce, window.location.origin), '_blank');
        onTapped?.();
        if (!win) {
            setState('fallback');
            return;
        }
        setState('running');
        run.current = runHandoff({
            win,
            origin: knock.url,
            nonce,
            listenOn: window,
            readyMs,
            // Read at the answer, not before: the name the request sent (the one its members saw), else this account's.
            account: async () => ({
                account: {
                    publicKey: identity.publicKey,
                    privateKey: identity.privateKey,
                    ...(identity.mnemonic?.length ? { mnemonic: [...identity.mnemonic] } : {}),
                    callsign: typeof knock.callsign === 'string' && knock.callsign.trim() ? knock.callsign : identity.callsign,
                },
                photo: await holderPhoto(identity.publicKey),
            }),
            onEnd: (end) => {
                run.current = null;
                if (end === 'joined') {
                    void forgetKnock(identity.publicKey, knock.url);
                    setState('joined');
                    onJoined?.();
                } else if (end === 'closed') {
                    setState('idle');
                } else {
                    setState('fallback');
                }
            },
        });
    };

    if (state === 'joined') {
        return (
            <div data-testid={`${testId}-joined`} role="status">
                <p dir="auto" className="m-0 font-semibold text-sm text-text-primary break-words">{t('You joined {name}.', { name })}</p>
                <div className="mt-2">
                    <a href={`${knock.url}/app`} target="_blank" rel="noopener noreferrer" className={SECONDARY} data-testid={`${testId}-open-joined`}>
                        {t('Open {name}', { name })}
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div>
            <button type="button" onClick={join} disabled={state === 'running'} data-testid={`${testId}-join`} className={PRIMARY}>
                {t('Join {name}', { name })}
            </button>
            <div role="status">
                {state === 'running'
                    ? <p dir="auto" className={NOTE} data-testid={`${testId}-running`}>{t('Carry on in the new tab.')}</p>
                    : state === 'idle' && (
                        <p dir="auto" className={NOTE}>{t("Opens {name}'s page in this browser and brings your account with you. Same 12 words.", { name })}</p>
                    )}
            </div>
            {state === 'fallback' && (
                <div data-testid={`${testId}-fallback`} className="mt-2">
                    <p dir="auto" role="alert" className={NOTE}>{t("Couldn't open {name}'s page here. Allow pop-ups for this site and try again.", { name })}</p>
                    <p dir="auto" className={NOTE}>
                        {t('Or: open {address}, tap Already a member and restore with your 12 words (Settings → Show my 12 words, first), then Join.', { address })}
                    </p>
                    <div className="mt-2">
                        <a href={`${knock.url}/app?door=signin`} target="_blank" rel="noopener noreferrer" className={SECONDARY} data-testid={`${testId}-open`}>
                            {t('Open {address}', { address })}
                        </a>
                    </div>
                    <p dir="auto" className={NOTE}>
                        {t('Or on your phone: the BeanPool app, restore your account, then Find a community → {name} → Join.', { name })}
                    </p>
                </div>
            )}
        </div>
    );
}
