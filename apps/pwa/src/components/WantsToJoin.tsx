import { useCallback, useEffect, useState } from 'react';
import { t, tn, word } from '@beanpool/core';
import { answerJoinRequest, getJoinRequests, type JoinRequest } from '../lib/api';
import { MemberAvatar } from './MemberAvatar';

/**
 * The words of this section (the phone's components/WantsToJoin.tsx, word for word: one catalog entry serves both apps).
 */
export const WANTS_TO_JOIN_WORDS = {
    help: word('People asking to join this community. Invite makes an invite that only their key can use, and their app finds it by itself. Not now tells them nothing more than "no answer yet".'),
    unreachable: word("Couldn't reach your community. Check your connection and try again."),
} as const;

/** How many whole days ago a request was made (0 today), or null for a date that can't be read. */
export function joinRequestAge(r: Pick<JoinRequest, 'createdAt'>, now: number = Date.now()): number | null {
    const at = Date.parse(r.createdAt);
    return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 86_400_000)) : null;
}

/** Under each request: when, and where they came from, two facts side by side (the phone's requestMeta). */
function requestMeta(r: JoinRequest): string {
    const days = joinRequestAge(r);
    // English writes one form for both; the count is 2 or more here.
    const when = days === null ? '' : days === 0 ? t('Asked today') : days === 1 ? t('Asked yesterday') : tn(days, 'Asked {n} days ago', 'Asked {n} days ago');
    const from = r.fromNode ? t('from {node}', { node: r.fromNode }) : '';
    return [when, from].filter(Boolean).join(' · ');
}

/**
 * People → Invites → "Wants to join (n)" on the web (front doors S2, design §5.8): people asking to join this community,
 * for any member who may invite to answer, as the phone's knocks screen. Hidden where the community takes no requests or
 * the member can't answer them (the node's 404 / 403). `onCount` tells People how many wait, for its Invites tab.
 */
export function WantsToJoin({ onCount }: { onCount?: (n: number) => void }) {
    const [requests, setRequests] = useState<JoinRequest[] | null>(null);
    const [total, setTotal] = useState(0);
    const [hidden, setHidden] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [done, setDone] = useState<string | null>(null);

    const load = useCallback(async () => {
        const r = await getJoinRequests();
        if (r.ok) {
            setRequests(r.knocks);
            setTotal(r.total);
            setHidden(false);
            setError(null);
            onCount?.(r.total);
        } else if (r.kind === 'hidden') {
            setHidden(true);
            onCount?.(0);
        } else {
            setError(r.message ?? t(WANTS_TO_JOIN_WORDS.unreachable));
        }
    }, [onCount]);

    useEffect(() => { void load(); }, [load]);

    const answer = async (req: JoinRequest, verb: 'approve' | 'decline') => {
        setBusy(req.id);
        const r = await answerJoinRequest(req.id, verb);
        setBusy(null);
        if (r.ok) {
            setRequests(list => (list ?? []).filter(k => k.id !== req.id));
            setTotal(prev => { const n = Math.max(0, prev - 1); onCount?.(n); return n; });
            setNotes(n => ({ ...n, [req.id]: '' }));
            setDone(verb === 'approve' ? t('You invited {name}. Their app will find the invite by itself.', { name: req.callsign }) : null);
            return;
        }
        // Another member got there first, or it lapsed: the community's words, then the list as it is now.
        setNotes(n => ({ ...n, [req.id]: r.message ?? t(WANTS_TO_JOIN_WORDS.unreachable) }));
        void load();
    };

    if (hidden || (requests !== null && requests.length === 0 && !error && !done)) return null;

    return (
        <section className="p-4 sm:p-6 border-b border-nature-200 dark:border-nature-800" data-testid="wants-to-join" aria-labelledby="wants-to-join-title">
            <h2 id="wants-to-join-title" className="m-0 mb-1 text-xl font-extrabold text-nature-950 dark:text-white break-words">
                {tn(total, '🚪 Wants to join ({n})', '🚪 Wants to join ({n})')}
            </h2>
            <p className="m-0 mb-3 text-sm leading-snug text-nature-700 dark:text-nature-200 break-words">{t(WANTS_TO_JOIN_WORDS.help)}</p>
            {!!error && <p role="status" className="m-0 mb-3 text-sm text-bp-ink-warning break-words" data-testid="wants-to-join-error">{error}</p>}
            {!!done && <p role="status" className="m-0 mb-3 text-sm text-nature-800 dark:text-nature-100 break-words" data-testid="wants-to-join-done">{done}</p>}
            {requests === null ? (
                <p className="m-0 my-3 text-sm text-nature-600 dark:text-nature-300">{t('Loading…')}</p>
            ) : requests.map(req => {
                const meta = requestMeta(req);
                return (
                    <div key={req.id} className="mb-3 p-3.5 rounded-2xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900" data-testid={`wants-to-join-${req.id}`}>
                        <div className="flex items-center gap-3 min-w-0">
                            <MemberAvatar avatarUrl={req.avatar} pubkey={req.pubkey} callsign={req.callsign} size={44} alt="" />
                            <div className="flex-1 min-w-0">
                                <p dir="auto" className="m-0 text-base font-extrabold text-nature-950 dark:text-white truncate">{req.callsign}</p>
                                {meta && <p className="m-0 mt-0.5 text-xs text-nature-600 dark:text-nature-300 break-words">{meta}</p>}
                            </div>
                        </div>
                        <p dir="auto" className="m-0 mt-2.5 text-sm leading-relaxed text-nature-800 dark:text-nature-100 break-words whitespace-pre-wrap">{req.message}</p>
                        {!!notes[req.id] && <p role="status" className="m-0 mt-2 text-sm text-nature-800 dark:text-nature-100 break-words" data-testid={`wants-to-join-note-${req.id}`}>{notes[req.id]}</p>}
                        <div className="flex flex-wrap gap-2 mt-3">
                            <button
                                type="button"
                                onClick={() => void answer(req, 'approve')}
                                disabled={!!busy}
                                aria-label={busy === req.id ? t('Inviting {name}...', { name: req.callsign }) : t('Invite {name}', { name: req.callsign })}
                                aria-busy={busy === req.id}
                                className={`min-h-[44px] px-[18px] rounded-xl border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-[15px] font-extrabold cursor-pointer disabled:cursor-default ${busy === req.id ? 'opacity-60' : ''}`}
                            >
                                {t('Invite', undefined, 'button: let them in')}
                            </button>
                            <button
                                type="button"
                                onClick={() => void answer(req, 'decline')}
                                disabled={!!busy}
                                aria-label={busy === req.id ? t('Declining {name}...', { name: req.callsign }) : t('Not now, {name}', { name: req.callsign })}
                                aria-busy={busy === req.id}
                                className={`min-h-[44px] px-[18px] rounded-xl border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 text-[15px] font-bold cursor-pointer disabled:cursor-default ${busy === req.id ? 'opacity-60' : ''}`}
                            >
                                {t('Not now')}
                            </button>
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
