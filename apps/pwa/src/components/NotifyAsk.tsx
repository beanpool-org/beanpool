/**
 * The web's one soft ask for notifications (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §4, §7, §10;
 * slice N5a): the join's last screen, and the same ask once as a card at the top of Home for a member already in. The
 * phone's twins are apps/native/components/welcome/NotifyStep.tsx and Home's once card (N1h).
 *
 * The same words as the phone, from core (`notifyJoinWords`): "Hear from {community}", the reason only BeanPool has, what
 * arrives and "Never ads.". "Turn on notifications" brings the BROWSER's own prompt, and only that tap does (lib/web-push.ts
 * turnOnFromAsk); the line under it says the browser will ask, or is left out where the browser already allows this site and
 * asks nothing. "Later" goes on, records no "no", and is not final: plain words in the heading ink with a full 48 px target,
 * quiet, not hidden, under the main button so a double tap never lands on it.
 *
 * Shown only where the browser can deliver (core's rule): elsewhere neither is drawn and the join ends at Home as before.
 * Never a gate: every way off ends at Home. Colours from the central tokens only: the call to action's fill for the main
 * button, as the front door's; the sky card band for the card, as Home's cards.
 */
import type { NotifyJoinWords } from '@beanpool/core';
import { t } from '@beanpool/core';
import { webPushFailureMessage, type WebPushFailure } from '../lib/web-push';
import { StepAction } from './StepAction';
import { WEB_PUSH_ROW_WORDS } from './WebPushRow';

export function NotifyAsk({ form, words, busy, failed, onTurnOn, onLater }: {
    /** `step`: the join's last screen, its two buttons in the sticky foot; `card`: Home's once card. */
    form: 'step' | 'card';
    words: NotifyJoinWords;
    /** The tap's work is out (the browser's prompt, the subscription): Turn on waits; Later never does. */
    busy: boolean;
    /** Notifications failed after permission: said by which side refused, with both buttons still there. */
    failed: WebPushFailure | boolean | null;
    onTurnOn: () => void;
    onLater: () => void;
}) {
    const card = form === 'card';
    const failedMessage = failed
        ? (typeof failed === 'object' ? webPushFailureMessage(failed) : t(WEB_PUSH_ROW_WORDS.failed))
        : null;
    const buttons = (
        <div className="flex flex-col items-stretch">
            {failedMessage && <p role="alert" dir="auto" data-testid="notify-ask-failed" className="m-0 mb-2 text-sm text-center text-bp-ink-danger break-words">{failedMessage}</p>}
            <button type="button" data-testid="notify-ask-turn-on" onClick={onTurnOn} disabled={busy}
                className="block w-full min-h-[52px] px-4 py-3 rounded-2xl border-none bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on text-base font-bold break-words cursor-pointer disabled:opacity-60 disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand">
                {words.turnOn}
            </button>
            {words.confirm && <p dir="auto" data-testid="notify-ask-confirm" className="m-0 mt-2 text-xs text-center text-text-secondary break-words">{words.confirm}</p>}
            {/* Never waits: the subscription after the browser's yes goes to the community, which can be slow, and Later is
                always the way on. */}
            <button type="button" data-testid="notify-ask-later" onClick={onLater}
                className="block w-full min-h-[48px] px-3 mt-1 bg-transparent border-none text-base font-bold text-text-primary break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand">
                {words.later}
            </button>
        </div>
    );
    const body = (
        <>
            <h3 dir="auto" data-testid="notify-ask-title" className={`m-0 mb-2 font-extrabold text-text-primary break-words ${card ? 'text-base' : 'text-xl'}`}>{words.title}</h3>
            <p dir="auto" className="m-0 mb-2 text-sm text-text-primary break-words">
                {words.never} <strong>{words.only}</strong>
            </p>
            <p dir="auto" data-testid="notify-ask-arrives" className="m-0 mb-3 text-sm text-text-secondary break-words">{words.arrives} {words.ads}</p>
        </>
    );
    if (card) {
        return (
            <section data-testid="notify-once-card" aria-labelledby="notify-once-band" className="bg-bg-card rounded-2xl shadow-sm border border-border-primary p-4 mb-3 min-w-0">
                <div className="-mx-4 -mt-4 px-4 mb-3 py-1 rounded-t-2xl flex items-center min-h-[48px]"
                    style={{ backgroundColor: 'var(--bp-card-sky-tint)', color: 'var(--bp-card-sky-ink)' }}>
                    <h2 id="notify-once-band" className="m-0 break-words text-[0.7rem] font-extrabold uppercase tracking-wider" style={{ color: 'var(--bp-card-sky-ink)' }}>
                        {t('Notifications')}
                    </h2>
                </div>
                {body}
                {buttons}
            </section>
        );
    }
    return (
        <div data-testid="notify-step" className="text-left">
            {body}
            <StepAction>{buttons}</StepAction>
        </div>
    );
}
