import { useEffect, useId, useRef, useState } from 'react';
import { COMMUNITY_CARD_WORDS as W, t } from '@beanpool/core';
import { IdentityHeldError, SentJoinWaitingError, type BeanPoolIdentity } from '../lib/identity';
import { KNOCK_CALLSIGN_CHARS, KNOCK_MESSAGE_CHARS, KNOCK_MESSAGES, communityOrigin, knockFormProblem, rememberKnock, sendKnock } from '../lib/knock';
import { commitKnockKey, draftKnockKey, KnockKeyHeldError } from '../lib/knock-key';
import { getNodeApiUrl } from '../lib/api';

/** This community's own address, as a knock names it: the address this web app talks to. */
export function thisCommunityOrigin(): string | null {
    return communityOrigin(getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : ''));
}

/**
 * "Ask to join {name}" from a browser with no account here (DESIGN-shared-listing-door-fable.md §2.1, slice A1): the
 * form on the shared post's page, on the community's card, and at `/app?door=ask`. Your name, A few words about
 * yourself (280). The key is drafted when the form opens and written to this browser only when Send is tapped
 * (lib/knock-key.ts), then the knock goes to THIS community's own address, signed by it (lib/knock.ts sendKnock, with
 * `toNode`). Sent: this browser is waiting to be let in, and `onAsked` hands the key to the root, which shows the
 * waiting page. The community's refusals are shown in its own words.
 *
 * `held`: the key this browser already asked with ("Ask again" on the waiting page, after a request lapsed): it signs,
 * and no other is drafted.
 */
export function AskHere({ name, held, onAsked, onClose, testId = 'ask-here' }: {
    name: string;
    held?: BeanPoolIdentity | null;
    onAsked: (identity: BeanPoolIdentity) => void;
    onClose?: () => void;
    testId?: string;
}) {
    const origin = thisCommunityOrigin();
    const [callsign, setCallsign] = useState(() => Array.from(held?.callsign ?? '').slice(0, KNOCK_CALLSIGN_CHARS).join(''));
    const [message, setMessage] = useState('');
    const [problem, setProblem] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const id = useId();
    const nameRef = useRef<HTMLInputElement | null>(null);
    // The key this form will sign with: drafted as it opens, in memory only, and the same one at every Send.
    const draft = useRef<Promise<BeanPoolIdentity> | null>(null);
    useEffect(() => {
        if (!held && !draft.current) draft.current = draftKnockKey();
        nameRef.current?.focus();
    }, [held]);

    const send = async () => {
        const wrong = knockFormProblem({ callsign, message });
        if (wrong) { setProblem(wrong); return; }
        if (!origin) { setProblem(t(KNOCK_MESSAGES.noAddress)); return; }
        setSending(true);
        setProblem(null);
        let identity: BeanPoolIdentity;
        try {
            identity = held ? held : await commitKnockKey(await (draft.current ?? (draft.current = draftKnockKey())), callsign);
        } catch (e) {
            setSending(false);
            if (e instanceof IdentityHeldError) setProblem(t('This browser already has an account, so the request was not sent.'));
            else if (e instanceof SentJoinWaitingError || e instanceof KnockKeyHeldError) setProblem(t('This browser is finishing another join, so the request was not sent. Reload the page to finish it.'));
            else setProblem(t("This browser couldn't keep your account, so the request was not sent."));
            return;
        }
        const r = await sendKnock(origin, identity, { callsign, message });
        setSending(false);
        switch (r.kind) {
            case 'waiting':
            case 'invited':
                await rememberKnock(identity.publicKey, { url: origin, name });
                onAsked(identity);
                return;
            default:
                // The community's own words, exactly as it sent them. The key stays: Send again signs with it.
                setProblem(r.message);
        }
    };

    const fieldClass = 'w-full box-border rounded-xl border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-950 text-nature-950 dark:text-white px-3 py-2.5 text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
    return (
        <form
            className="text-left"
            onSubmit={(e) => { e.preventDefault(); void send(); }}
            aria-labelledby={`${id}-title`}
            data-testid={`${testId}-form`}
        >
            <h3 id={`${id}-title`} dir="auto" className="m-0 mb-1 text-lg font-bold leading-tight break-words text-text-primary">{t(W.askName, { name })}</h3>
            <p className="m-0 mb-3 text-sm break-words text-text-primary">{t(W.askNote, { name })}</p>
            <label htmlFor={`${id}-name`} className="block mb-1 text-sm font-bold text-nature-900 dark:text-nature-100">{t('Your name')}</label>
            <input
                ref={nameRef}
                id={`${id}-name`}
                className={fieldClass}
                value={callsign}
                onChange={e => setCallsign(Array.from(e.target.value).slice(0, KNOCK_CALLSIGN_CHARS).join(''))}
                maxLength={KNOCK_CALLSIGN_CHARS}
                autoComplete="nickname"
                data-testid={`${testId}-name`}
            />
            <label htmlFor={`${id}-message`} className="block mt-3 mb-1 text-sm font-bold text-nature-900 dark:text-nature-100">{t('A few words about yourself')}</label>
            <textarea
                id={`${id}-message`}
                className={`${fieldClass} min-h-[96px] resize-y`}
                value={message}
                onChange={e => setMessage(Array.from(e.target.value).slice(0, KNOCK_MESSAGE_CHARS).join(''))}
                placeholder={t("Where you live, what you'd like to share or learn")}
                data-testid={`${testId}-message`}
            />
            <p className="m-0 mt-1 text-xs text-right text-nature-600 dark:text-nature-300" aria-hidden="true">{Array.from(message).length}/{KNOCK_MESSAGE_CHARS}</p>
            {problem && <p role="alert" className="m-0 mt-1 text-sm text-bp-ink-danger break-words" data-testid={`${testId}-problem`}>{problem}</p>}
            <div className="flex flex-wrap gap-2 mt-2">
                <button
                    type="submit"
                    disabled={sending}
                    aria-busy={sending}
                    data-testid={`${testId}-send`}
                    className="min-h-[48px] px-5 rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-base font-bold cursor-pointer disabled:cursor-default disabled:opacity-60"
                >
                    {sending ? t('Sending…') : t('Send')}
                </button>
                {onClose && (
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-h-[48px] px-5 rounded-xl border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 text-base font-bold cursor-pointer"
                    >
                        {t('Cancel')}
                    </button>
                )}
            </div>
        </form>
    );
}
