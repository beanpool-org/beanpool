/**
 * "Tell me when they answer" (DESIGN-web-notifications-fable.md §2.3, §2.4): the reason first, the browser asked only at the
 * tap. Subscribed already (this browser keeps the pin and still has permission): the ✓ line. Where push can't work: the
 * plain words, and on a phone the app's store link above them (Marty, 9 Nov, Decision 3).
 *
 * Two places, one card: the waiting page on the community's own address (web push W1, `tellMeWhenTheyAnswer`), and Home's
 * Find card, on the row of a community a member asked from here (DESIGN-global-yes-join-fable.md §2.4, slice Y2:
 * `tellMeAtHome`, which subscribes this browser with that community's key and gives it that community, signed by the key
 * that asked).
 */
import { useState } from 'react';
import { PEEK_WORDS, currentLanguage, t } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    TELL_ME_WORDS as TW, cannotLines, grantedLine, pushPlace, readWebPushPin, tellMeWhenTheyAnswer, type PushPlace, type TellMeResult,
} from '../lib/web-push';

const DOOR = 'block w-full min-h-[48px] px-4 py-3 rounded-xl text-center text-base font-bold break-words no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info';
const PRIMARY = `${DOOR} border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on cursor-pointer disabled:cursor-default disabled:opacity-60`;

export function TellMeCard({ origin, identity, name, subscribe = tellMeWhenTheyAnswer, testId = 'tell-me', compact = false }: {
    /** The community that will answer, whose key the browser subscribes with and which keeps the subscription. */
    origin: string;
    identity: BeanPoolIdentity;
    name: string;
    subscribe?: (origin: string, identity: BeanPoolIdentity, lang: string) => Promise<TellMeResult>;
    /** The card's test ids: `{testId}-card`, `{testId}` (the button), `{testId}-on`, `{testId}-off`, `{testId}-get-app`. */
    testId?: string;
    /** Inside a card (Home's Find card): smaller words and spacing. */
    compact?: boolean;
}) {
    const [state, setState] = useState<{ kind: 'idle' | 'asking' } | { kind: 'on' | 'off'; place: PushPlace; dismissed?: boolean }>(() => {
        const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
        return readWebPushPin(origin, identity.publicKey) && granted ? { kind: 'on', place: pushPlace() } : { kind: 'idle' };
    });
    // Called straight from the tap, with nothing awaited first: a browser asks for permission only inside the gesture.
    const tap = () => {
        setState({ kind: 'asking' });
        void subscribe(origin, identity, currentLanguage()).then(r => {
            if (r.ok) setState({ kind: 'on', place: r.place });
            else if (r.reason === 'dismissed') setState({ kind: 'idle' });
            else setState({ kind: 'off', place: r.place, dismissed: r.reason === 'failed' });
        });
    };
    const off = state.kind === 'off' ? (state.dismissed ? { lines: [t(TW.failed)], getApp: null } : cannotLines(state.place)) : null;
    const head = compact ? 'text-sm' : 'text-base';
    return (
        <div data-testid={`${testId}-card`} className={compact ? 'mt-2 p-3 rounded-xl border border-nature-200 dark:border-nature-700' : 'mb-4 p-4 max-[359px]:p-3 rounded-xl border border-nature-200 dark:border-nature-800'}>
            {state.kind === 'on' ? (
                <div role="status">
                    <p dir="auto" data-testid={`${testId}-on`} className={`m-0 ${head} font-bold break-words`}>{t(TW.granted, { name })}</p>
                    {grantedLine(state.place) && <p dir="auto" className="m-0 mt-1 text-sm text-text-secondary break-words">{grantedLine(state.place)}</p>}
                </div>
            ) : (
                <>
                    <p dir="auto" className={`m-0 mb-1 ${head} font-bold break-words`}>{t(TW.title)}</p>
                    <p dir="auto" className="m-0 mb-3 text-sm text-text-secondary break-words">{t(TW.line, { name })}</p>
                    {off ? (
                        <div role="status" data-testid={`${testId}-off`} className="grid gap-2">
                            {off.getApp && (
                                <a href={off.getApp} rel="noopener noreferrer" data-testid={`${testId}-get-app`} className={`${PRIMARY} no-underline`}>{t(PEEK_WORDS.getApp)}</a>
                            )}
                            {off.lines.map(line => <p key={line} dir="auto" className="m-0 text-sm break-words">{line}</p>)}
                        </div>
                    ) : (
                        <button type="button" data-testid={testId} className={PRIMARY} disabled={state.kind === 'asking'} aria-busy={state.kind === 'asking'} onClick={tap}>
                            {state.kind === 'asking' ? t(TW.asking) : t(TW.button)}
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
