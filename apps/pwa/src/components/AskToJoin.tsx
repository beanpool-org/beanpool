import { useEffect, useId, useState } from 'react';
import { t } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import {
    KNOCK_CALLSIGN_CHARS, KNOCK_MESSAGE_CHARS, KNOCK_MESSAGES, cancelledKnocks, communityOrigin, knockFormProblem, rememberKnock, sendKnock,
} from '../lib/knock';

export interface AskableCommunity {
    key?: string | null;
    name: string | null;
    url: string | null;
}

/**
 * "Ask to join {community}" on the web (front doors S2): the phone's Find a community button and form, on the web's Find
 * card and on the community a stranger came from (`/?ask=<host>`). The knock goes to that community's own address, signed
 * by this browser's key (lib/knock.ts sendKnock); the community's refusals are shown in its own words, as the phone shows
 * them. Once sent, this browser remembers it and Home's card says how it fares (`onAsked`): the waiting line and Cancel my
 * request are that card's, not this block's.
 *
 * `asked`: this browser already holds an open request to it (Home's remembered knocks).
 */
export function AskToJoin({ community, identity, asked, onAsked, testId }: {
    community: AskableCommunity;
    identity: BeanPoolIdentity;
    asked: boolean;
    onAsked?: () => void;
    testId?: string;
}) {
    const origin = communityOrigin(community.url);
    const label = community.name ?? (origin ? origin.replace(/^https:\/\//, '') : t('A community'));
    const [open, setOpen] = useState(false);
    const [callsign, setCallsign] = useState(() => Array.from(identity.callsign ?? '').slice(0, KNOCK_CALLSIGN_CHARS).join(''));
    const [message, setMessage] = useState('');
    const [problem, setProblem] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    // What the community said to the knock, kept under the row: waiting, or this key is a member there already.
    const [said, setSaid] = useState<string | null>(null);
    // Cancelled from this browser within the day: the node would refuse another ask until then (lib/knock.ts).
    const [cancelled, setCancelled] = useState(false);
    const id = useId();
    const tid = testId ?? `ask-to-join-${community.key ?? origin ?? 'community'}`;

    useEffect(() => {
        if (!origin) return;
        let alive = true;
        cancelledKnocks(identity.publicKey).then(recent => { if (alive) setCancelled(origin in recent); });
        return () => { alive = false; };
    }, [origin, identity.publicKey]);

    if (!origin) return <p className="m-0 py-1 text-sm text-nature-800 dark:text-nature-100 break-words" data-testid={`${tid}-no-address`}>{t(KNOCK_MESSAGES.noAddress)}</p>;
    if (said) return <p role="status" className="m-0 py-1 text-sm text-nature-800 dark:text-nature-100 break-words" data-testid={`${tid}-said`}>{said}</p>;
    if (asked) return null;
    if (cancelled) return <p className="m-0 py-1 text-sm text-nature-800 dark:text-nature-100 break-words" data-testid={`${tid}-cancelled`}>{t(KNOCK_MESSAGES.cancelled)}</p>;

    const send = async () => {
        const wrong = knockFormProblem({ callsign, message });
        if (wrong) { setProblem(wrong); return; }
        setSending(true);
        setProblem(null);
        const r = await sendKnock(origin, identity, { callsign, message });
        setSending(false);
        switch (r.kind) {
            case 'waiting':
            case 'invited':
                await rememberKnock(identity.publicKey, { url: origin, name: community.name, key: community.key ?? null });
                setOpen(false);
                setMessage('');
                setSaid(r.kind === 'waiting' ? r.message : t(KNOCK_MESSAGES.invited));
                onAsked?.();
                return;
            case 'member':
                setOpen(false);
                setSaid(r.message);
                return;
            default:
                // The community's own words, exactly as it sent them.
                setProblem(r.message);
        }
    };

    if (!open) {
        return (
            <div className="py-1">
                <button
                    type="button"
                    onClick={() => { setOpen(true); setProblem(null); }}
                    aria-label={t('Ask to join {name}', { name: label })}
                    data-testid={tid}
                    className="min-h-[44px] px-4 rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-sm font-bold cursor-pointer break-words max-w-full"
                >
                    {t('Ask to join')}
                </button>
            </div>
        );
    }

    const fieldClass = 'w-full box-border rounded-xl border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-950 text-nature-950 dark:text-white px-3 py-2.5 text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
    return (
        <form
            className="mt-1 mb-2 p-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-oat-50 dark:bg-nature-900"
            onSubmit={(e) => { e.preventDefault(); void send(); }}
            aria-label={t('Ask to join {name}', { name: label })}
            data-testid={`${tid}-form`}
        >
            <label htmlFor={`${id}-name`} className="block mb-1 text-sm font-bold text-nature-900 dark:text-nature-100">{t('Your name')}</label>
            <input
                id={`${id}-name`}
                className={fieldClass}
                value={callsign}
                onChange={e => setCallsign(Array.from(e.target.value).slice(0, KNOCK_CALLSIGN_CHARS).join(''))}
                maxLength={KNOCK_CALLSIGN_CHARS}
                autoComplete="nickname"
                data-testid={`${tid}-name`}
            />
            <label htmlFor={`${id}-message`} className="block mt-3 mb-1 text-sm font-bold text-nature-900 dark:text-nature-100">{t('A few words about yourself')}</label>
            <textarea
                id={`${id}-message`}
                className={`${fieldClass} min-h-[96px] resize-y`}
                value={message}
                onChange={e => setMessage(Array.from(e.target.value).slice(0, KNOCK_MESSAGE_CHARS).join(''))}
                placeholder={t("Where you live, what you'd like to share or learn")}
                data-testid={`${tid}-message`}
            />
            <p className="m-0 mt-1 text-xs text-right text-nature-600 dark:text-nature-300" aria-hidden="true">{Array.from(message).length}/{KNOCK_MESSAGE_CHARS}</p>
            {problem && <p role="alert" className="m-0 mt-1 text-sm text-bp-ink-danger break-words" data-testid={`${tid}-problem`}>{problem}</p>}
            <div className="flex flex-wrap gap-2 mt-2">
                <button
                    type="submit"
                    disabled={sending}
                    aria-busy={sending}
                    data-testid={`${tid}-send`}
                    className={`min-h-[44px] px-5 rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-sm font-bold cursor-pointer disabled:cursor-default ${sending ? 'opacity-60' : ''}`}
                >
                    {sending ? t('Sending…') : t('Send')}
                </button>
                <button
                    type="button"
                    onClick={() => { setOpen(false); setProblem(null); }}
                    className="min-h-[44px] px-5 rounded-xl border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 text-sm font-bold cursor-pointer"
                >
                    {t('Cancel')}
                </button>
            </div>
        </form>
    );
}
