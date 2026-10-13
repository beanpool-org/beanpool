/**
 * The "Decisions" block on an enterprise's or project's page (DESIGN-group-decisions §4 row S2), and on a chat group's info
 * (row S3): its votes, each card with its two tally states (turnout while open, Yes and No once closed), Yes / No for
 * someone on the roll who hasn't voted, and the propose form. One block for both scopes; the forms differ by what each
 * scope may vote on. The words and the form's checks are @beanpool/core scoped-decision.ts, shared with the phone.
 *
 * Shown only to those the node answers (its keepers or the group's members, and those on a vote's roll): anyone else gets
 * a 404, and the block draws nothing. A roll of one holds no vote, so then there is no propose button (canPropose); nor
 * for an observer, who watches, or in a group its members closed.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    GROUP_DECISIONS_NOTE, GROUP_SOMEONE, groupChoiceLabel, groupChoicePeople, groupChoicesFor, groupChoiceWhoWords, groupProposal, joinPolicyChoices,
    joinPolicyLabel, type GroupChoice, type GroupJoinPolicy, type GroupPerson,
    beansHeld, checkPayOutAmount, payOutFeeWords, rollChoices, scopedClosesWords, scopedEffectLabel, scopedEffectsFor, scopedEffectWords,
    scopedOutcomeWords, scopedTallyWords, SMALL_ROLL_BALLOT_NOTE, wageNoteWords,
    type RollPerson, type ScopedDecisionCard, type ScopedDecisionList, type ScopedEffect,
} from '@beanpool/core';
import {
    getEnterpriseDecisions, proposeEnterpriseDecision, voteEnterpriseDecision, getGroupDecisions, proposeGroupDecision, voteGroupDecision,
} from '../lib/api';

export interface EnterpriseDecisionsProps {
    treasuryKey: string;
    myPubkey: string | null;
    /** The enterprise's keepers as its detail lists them; suspended ones are off the roll. */
    keepers: Array<{ publicKey: string; callsign?: string; role?: string; suspended?: boolean }>;
    /** What it holds now, in Beans. */
    balance: number;
    /** What it has earned above its costs (the detail's earnedSurplus): the most it can pay a keeper. Null when not known. */
    earnedSurplus?: number | null;
    lifecycle?: string | null;
}

const btn = 'min-h-[44px] px-4 rounded-xl font-bold text-sm';
const btnYes = `${btn} bg-emerald-600 dark:bg-emerald-700 hover:bg-emerald-500 dark:hover:bg-emerald-800 text-white disabled:opacity-50`;
const btnNo = `${btn} border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-nature-100 disabled:opacity-50`;

export function EnterpriseDecisions({ treasuryKey, myPubkey, keepers, balance, earnedSurplus, lifecycle }: EnterpriseDecisionsProps) {
    const roll: RollPerson[] = useMemo(() => keepers.filter(k => !k.suspended)
        .map(k => ({ pubkey: k.publicKey, name: k.callsign || 'A keeper', role: k.role })), [keepers]);
    const nameOf = useCallback((pk: string) => keepers.find(k => k.publicKey === pk)?.callsign || 'a member', [keepers]);
    const read = useCallback(() => getEnterpriseDecisions(treasuryKey), [treasuryKey]);
    const cast = useCallback((id: string, support: boolean) => voteEnterpriseDecision(treasuryKey, id, support), [treasuryKey]);
    return (
        <ScopedDecisions
            id="enterprise-decisions" read={read} cast={cast} nameOf={nameOf} lifecycle={lifecycle}
            note={<>Votes among this {lifecycle === 'bounded' ? "project's leader and collaborators" : "enterprise's keepers"}. More than half must vote.
                {' '}7 days, or sooner once the answer can't change.</>}
            propose={myPubkey ? (close, done) => (
                <ProposeScopedDecision treasuryKey={treasuryKey} me={myPubkey} roll={roll} balance={balance} earnedSurplus={earnedSurplus} lifecycle={lifecycle}
                    onClose={close} onDone={done} />
            ) : null}
        />
    );
}

export interface GroupDecisionsProps {
    groupId: string;
    myPubkey: string | null;
    /** Everyone in the group now (any role, the lead as 'lead'), for the names and the pickers. */
    people: GroupPerson[];
    joinPolicy?: string | null;
    /** A vote was cast or opened: the group may have changed (a new lead, a role, closed), so its info reads again. */
    onChanged?: () => void;
}

/** A chat group's votes (slice S3), on its info: the same block, its own form (no recipient, no amount). */
export function GroupDecisions({ groupId, myPubkey, people, joinPolicy, onChanged }: GroupDecisionsProps) {
    // Someone removed lands here with no roster (people is []): the card's own names, then plain words (#1794 N7).
    const nameOf = useCallback((pk: string, names?: Record<string, string>) => people.find(p => p.pubkey === pk)?.name || names?.[pk] || GROUP_SOMEONE, [people]);
    const read = useCallback(() => getGroupDecisions(groupId), [groupId]);
    const cast = useCallback((id: string, support: boolean) => voteGroupDecision(groupId, id, support), [groupId]);
    return (
        <ScopedDecisions
            id="group-decisions" read={read} cast={cast} nameOf={nameOf} note={GROUP_DECISIONS_NOTE} onChanged={onChanged}
            propose={myPubkey ? (close, done, list) => (
                // Only the people the node takes in a vote (no suspended member, #1784 review N2).
                <ProposeGroupDecision groupId={groupId} me={myPubkey}
                    people={list.nameable ? people.filter(p => list.nameable!.includes(p.pubkey)) : people}
                    joinPolicy={joinPolicy} onClose={close} onDone={done} />
            ) : null}
        />
    );
}

/** The block both scopes draw: the cards, Yes / No, and the propose button that opens the scope's own form. */
function ScopedDecisions({ id, read, cast, nameOf, note, lifecycle, propose, onChanged }: {
    id: string;
    read: () => Promise<ScopedDecisionList | null>;
    cast: (decisionId: string, support: boolean) => Promise<unknown>;
    nameOf: (pubkey: string, names?: Record<string, string>) => string;
    note: ReactNode;
    lifecycle?: string | null;
    propose: ((close: () => void, done: () => void, list: ScopedDecisionList) => ReactNode) | null;
    onChanged?: () => void;
}) {
    const [list, setList] = useState<ScopedDecisionList | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [voteError, setVoteError] = useState<string | null>(null);
    const [proposing, setProposing] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    const load = useCallback(async () => {
        setList(await read());
        setNow(Date.now());
    }, [read]);
    useEffect(() => { void load(); }, [load]);

    if (!list) return null;
    if (list.decisions.length === 0 && !list.canPropose) return null;
    const open = list.decisions.filter(d => d.status === 'open');
    const closed = list.decisions.filter(d => d.status !== 'open').slice(0, 5);

    const vote = async (d: ScopedDecisionCard, support: boolean) => {
        setBusyId(d.id);
        setVoteError(null);
        try {
            await cast(d.id, support);
            await load();
            onChanged?.();
        } catch (e) {
            setVoteError(e instanceof Error && e.message ? e.message : 'Your vote was not counted. Try again in a moment.');
        } finally {
            setBusyId(null);
        }
    };

    return (
        <section aria-labelledby={`${id}-heading`} data-testid={id}
            className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-700 rounded-2xl p-4 space-y-3 min-w-0">
            <h3 id={`${id}-heading`} className="m-0 text-xs font-black tracking-wide text-nature-600 dark:text-nature-300">DECISIONS</h3>
            <p className="m-0 text-sm text-nature-700 dark:text-nature-300 break-words">{note}</p>
            {list.watching === true && !list.closedAt && (
                <p className="m-0 text-sm text-nature-700 dark:text-nature-300 break-words">You watch this group, so you see its votes but don't vote.</p>
            )}
            {[...open, ...closed].map(d => {
                const mine = d.myVote ? (d.myVote.support === true || d.myVote.support === 1 ? 'Yes' : 'No') : null;
                const isOpen = d.status === 'open';
                return (
                    <article key={d.id} data-testid="scoped-decision" className="border-t border-nature-200 dark:border-nature-700 pt-3 min-w-0">
                        <h4 className="m-0 text-base font-bold text-nature-900 dark:text-nature-100 break-words">{d.title}</h4>
                        <p className="m-0 mt-1 text-sm text-nature-800 dark:text-nature-200 break-words">{scopedEffectWords(d, pk => nameOf(pk, d.names), lifecycle)}</p>
                        {d.description && (
                            <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-300 break-words whitespace-pre-wrap" data-testid="scoped-why">{d.description}</p>
                        )}
                        <p className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300 break-words">
                            Proposed by {nameOf(d.authorPubkey, d.names)} · {isOpen ? scopedClosesWords(d.closesAt, now) : scopedOutcomeWords(d)}
                        </p>
                        <p className="m-0 mt-1 text-sm font-semibold text-nature-900 dark:text-nature-100 break-words" data-testid="scoped-tally">{scopedTallyWords(d)}</p>
                        {mine && <p className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300">You voted {mine}.</p>}
                        {/* The vote's own roll, frozen when it opened, says who votes: never who is in the group now. */}
                        {isOpen && !mine && d.canVote === true && (
                            <div className="flex flex-wrap gap-2 mt-2">
                                <button type="button" className={`${btnYes} flex-1 min-w-[6rem]`} disabled={busyId === d.id}
                                    onClick={() => vote(d, true)} aria-label={`Vote Yes on ${d.title}`}>Yes</button>
                                <button type="button" className={`${btnNo} flex-1 min-w-[6rem]`} disabled={busyId === d.id}
                                    onClick={() => vote(d, false)} aria-label={`Vote No on ${d.title}`}>No</button>
                            </div>
                        )}
                    </article>
                );
            })}
            {voteError && <p role="alert" className="m-0 text-sm text-amber-700 dark:text-amber-400 break-words">{voteError}</p>}
            {list.decisions.length > 0 && list.rollSize <= 4 && <p className="m-0 text-xs text-nature-700 dark:text-nature-300 break-words">{SMALL_ROLL_BALLOT_NOTE}</p>}
            {list.canPropose && !!propose && !proposing && (
                <button type="button" className={`${btnNo} w-full`} onClick={() => setProposing(true)}>Propose a vote</button>
            )}
            {proposing && propose?.(() => setProposing(false), () => { setProposing(false); void load(); onChanged?.(); }, list)}
        </section>
    );
}

/** The propose form: the three effects (two in a project), the person from the roll, and for a pay-out the amount and its fee. */
export function ProposeScopedDecision({ treasuryKey, me, roll, balance, earnedSurplus, lifecycle, onClose, onDone }: {
    treasuryKey: string; me: string; roll: RollPerson[]; balance: number; earnedSurplus?: number | null; lifecycle?: string | null;
    onClose: () => void; onDone: () => void;
}) {
    const effects = scopedEffectsFor(lifecycle);
    const [effect, setEffect] = useState<ScopedEffect>('pay_out');
    const [who, setWho] = useState<string | null>(null);
    const [amountText, setAmountText] = useState('');
    const [title, setTitle] = useState('');
    const [why, setWhy] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const choices = rollChoices(effect, roll, me);
    const person = choices.find(p => p.pubkey === who) ?? null;
    // Everyone the form offers is a keeper on the roll, so every pay-out is a wage: capped at the earned surplus too.
    const wageSurplus = typeof earnedSurplus === 'number' && Number.isFinite(earnedSurplus) ? earnedSurplus : null;
    const amount = effect === 'pay_out' ? checkPayOutAmount(amountText, balance, wageSurplus) : null;
    const amountError = amount && 'error' in amount && amountText.trim() ? amount.error : null;
    const ready = !!person && title.trim().length > 0 && why.trim().length >= 10 && (effect !== 'pay_out' || (!!amount && 'amount' in amount));

    const send = async () => {
        if (!ready || !person) return;
        setBusy(true);
        setError(null);
        try {
            await proposeEnterpriseDecision(treasuryKey, effect === 'pay_out' && amount && 'amount' in amount
                ? { title: title.trim(), description: why.trim(), effect, params: { to: person.pubkey, amount: amount.amount } }
                : { title: title.trim(), description: why.trim(), effect, subject: person.pubkey });
            onDone();
        } catch (e) {
            setError(e instanceof Error && e.message ? e.message : 'The vote was not opened. Try again in a moment.');
        } finally {
            setBusy(false);
        }
    };

    const chip = (on: boolean) => `min-h-[44px] px-3 py-1 rounded-2xl border text-sm max-w-full break-words text-left ${on
        ? 'bg-emerald-600 dark:bg-emerald-700 border-emerald-600 text-white font-bold'
        : 'border-nature-300 dark:border-nature-600 text-nature-900 dark:text-nature-100 bg-white dark:bg-nature-900'}`;
    const label = 'block text-sm font-bold text-nature-900 dark:text-nature-100 mt-3 mb-1';
    const input = 'w-full min-w-0 rounded-xl border border-nature-300 dark:border-nature-600 bg-nature-50 dark:bg-nature-950 px-3 py-2 text-base text-nature-900 dark:text-nature-100';

    return (
        <form data-testid="propose-scoped-decision" className="border-t border-nature-200 dark:border-nature-700 pt-3 min-w-0"
            onSubmit={e => { e.preventDefault(); void send(); }} aria-labelledby="propose-scoped-heading">
            <h4 id="propose-scoped-heading" className="m-0 text-base font-black text-nature-900 dark:text-nature-100">Propose a vote</h4>
            <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-300 break-words">Everyone on the roll votes. It runs 7 days, or ends sooner once the answer can't change.</p>
            <fieldset className="m-0 p-0 border-0 min-w-0">
                <legend className={label}>What should happen?</legend>
                <div className="flex flex-wrap gap-2" role="radiogroup">
                    {effects.map(e => (
                        <button key={e} type="button" role="radio" aria-checked={effect === e} className={chip(effect === e)}
                            onClick={() => { setEffect(e); setWho(null); }}>{scopedEffectLabel(e, lifecycle)}</button>
                    ))}
                </div>
            </fieldset>
            <fieldset className="m-0 p-0 border-0 min-w-0">
                <legend className={label}>{effect === 'pay_out' ? 'Pay whom?' : effect === 'remove_keeper' ? 'Remove whom?' : 'Who should lead?'}</legend>
                {choices.length === 0
                    ? <p className="m-0 text-sm text-nature-700 dark:text-nature-300">Nobody on the roll can be chosen for this.</p>
                    : (
                        <div className="flex flex-wrap gap-2" role="radiogroup">
                            {choices.map(p => (
                                <button key={p.pubkey} type="button" role="radio" aria-checked={who === p.pubkey} className={chip(who === p.pubkey)}
                                    onClick={() => setWho(p.pubkey)}>{p.name}{p.pubkey === me ? ' (you)' : ''}</button>
                            ))}
                        </div>
                    )}
            </fieldset>
            {effect === 'pay_out' && (
                <>
                    <label className={label} htmlFor="scoped-amount">How many Beans?</label>
                    <input id="scoped-amount" className={input} inputMode="decimal" placeholder="40" value={amountText}
                        onChange={e => setAmountText(e.target.value)} aria-describedby="scoped-amount-help" />
                    <p id="scoped-amount-help" className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-300">It holds {beansHeld(balance)} Beans now.</p>
                    {amountError && <p className="m-0 mt-1 text-sm text-amber-700 dark:text-amber-400 break-words">{amountError}</p>}
                    {amount && 'amount' in amount && person && (
                        <p className="m-0 mt-1 text-sm text-nature-900 dark:text-nature-100 break-words" data-testid="scoped-fee">{payOutFeeWords(amount.amount, person.name)}</p>
                    )}
                    <p className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300 break-words">{wageNoteWords(wageSurplus, lifecycle)}</p>
                </>
            )}
            <label className={label} htmlFor="scoped-title">Title</label>
            <input id="scoped-title" className={input} maxLength={120} placeholder="Pay Ali for the stall repairs" value={title} onChange={e => setTitle(e.target.value)} />
            <label className={label} htmlFor="scoped-why">Why?</label>
            <textarea id="scoped-why" className={`${input} min-h-[4.5rem]`} placeholder="Say why, in a sentence or two." value={why} onChange={e => setWhy(e.target.value)} />
            {error && <p role="alert" className="m-0 mt-2 text-sm text-amber-700 dark:text-amber-400 break-words">{error}</p>}
            <div className="flex flex-wrap gap-2 mt-3">
                <button type="submit" className={`${btnYes} flex-1 min-w-[8rem]`} disabled={!ready || busy} aria-busy={busy}>
                    {busy ? 'Opening…' : 'Open the vote'}
                </button>
                <button type="button" className={`${btnNo} flex-1 min-w-[6rem]`} onClick={onClose}>Cancel</button>
            </div>
        </form>
    );
}

/**
 * A chat group's propose form (slice S3): what should happen (the five effects, a role vote as its two directions), the
 * person or the join rule it names, a title and why. No recipient and no amount: a group holds no Beans.
 */
export function ProposeGroupDecision({ groupId, me, people, joinPolicy, onClose, onDone }: {
    groupId: string; me: string; people: GroupPerson[]; joinPolicy?: string | null; onClose: () => void; onDone: () => void;
}) {
    const offered = groupChoicesFor(people, me);
    const [choice, setChoice] = useState<GroupChoice>(offered[0] ?? 'close');
    const [who, setWho] = useState<string | null>(null);
    const [policy, setPolicy] = useState<GroupJoinPolicy | null>(null);
    const [title, setTitle] = useState('');
    const [why, setWhy] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const whoWords = groupChoiceWhoWords(choice);
    const pickable = groupChoicePeople(choice, people, me);
    const proposal = groupProposal(choice, pickable.some(p => p.pubkey === who) ? who : null, policy);
    const ready = !!proposal && title.trim().length > 0 && why.trim().length >= 10;

    const send = async () => {
        if (!ready || !proposal) return;
        setBusy(true);
        setError(null);
        try {
            await proposeGroupDecision(groupId, { title: title.trim(), description: why.trim(), ...proposal });
            onDone();
        } catch (e) {
            setError(e instanceof Error && e.message ? e.message : 'The vote was not opened. Try again in a moment.');
        } finally {
            setBusy(false);
        }
    };

    const chip = (on: boolean) => `min-h-[44px] px-3 py-1 rounded-2xl border text-sm max-w-full break-words text-left ${on
        ? 'bg-emerald-600 dark:bg-emerald-700 border-emerald-600 text-white font-bold'
        : 'border-nature-300 dark:border-nature-600 text-nature-900 dark:text-nature-100 bg-white dark:bg-nature-900'}`;
    const label = 'block text-sm font-bold text-nature-900 dark:text-nature-100 mt-3 mb-1';
    const input = 'w-full min-w-0 rounded-xl border border-nature-300 dark:border-nature-600 bg-nature-50 dark:bg-nature-950 px-3 py-2 text-base text-nature-900 dark:text-nature-100';

    return (
        <form data-testid="propose-group-decision" className="border-t border-nature-200 dark:border-nature-700 pt-3 min-w-0"
            onSubmit={e => { e.preventDefault(); void send(); }} aria-labelledby="propose-group-heading">
            <h4 id="propose-group-heading" className="m-0 text-base font-black text-nature-900 dark:text-nature-100">Propose a vote</h4>
            <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-300 break-words">The group's members and convenors vote. It runs 7 days, or ends sooner once the answer can't change.</p>
            <fieldset className="m-0 p-0 border-0 min-w-0">
                <legend className={label}>What should happen?</legend>
                <div className="flex flex-wrap gap-2" role="radiogroup">
                    {offered.map(c => (
                        <button key={c} type="button" role="radio" aria-checked={choice === c} className={chip(choice === c)}
                            onClick={() => { setChoice(c); setWho(null); setPolicy(null); }}>{groupChoiceLabel(c)}</button>
                    ))}
                </div>
            </fieldset>
            {whoWords && (
                <fieldset className="m-0 p-0 border-0 min-w-0">
                    <legend className={label}>{whoWords}</legend>
                    <div className="flex flex-wrap gap-2" role="radiogroup">
                        {pickable.map(p => (
                            <button key={p.pubkey} type="button" role="radio" aria-checked={who === p.pubkey} className={chip(who === p.pubkey)}
                                onClick={() => setWho(p.pubkey)}>{p.name}{p.pubkey === me ? ' (you)' : ''}</button>
                        ))}
                    </div>
                </fieldset>
            )}
            {choice === 'join_policy' && (
                <fieldset className="m-0 p-0 border-0 min-w-0">
                    <legend className={label}>Who should be able to join?</legend>
                    <div className="flex flex-wrap gap-2" role="radiogroup">
                        {joinPolicyChoices(joinPolicy).map(p => (
                            <button key={p} type="button" role="radio" aria-checked={policy === p} className={chip(policy === p)}
                                onClick={() => setPolicy(p)}>{joinPolicyLabel(p)}</button>
                        ))}
                    </div>
                </fieldset>
            )}
            {choice === 'close' && (
                <p className="m-0 mt-2 text-sm text-nature-900 dark:text-nature-100 break-words">
                    If it passes, the group takes no new messages, posts or members, and its other open votes end. Its chat stays to read.
                </p>
            )}
            <label className={label} htmlFor="group-vote-title">Title</label>
            <input id="group-vote-title" className={input} maxLength={120} placeholder="Ada leads the guild" value={title} onChange={e => setTitle(e.target.value)} />
            <label className={label} htmlFor="group-vote-why">Why?</label>
            <textarea id="group-vote-why" className={`${input} min-h-[4.5rem]`} placeholder="Say why, in a sentence or two." value={why} onChange={e => setWhy(e.target.value)} />
            {error && <p role="alert" className="m-0 mt-2 text-sm text-amber-700 dark:text-amber-400 break-words">{error}</p>}
            <div className="flex flex-wrap gap-2 mt-3">
                <button type="submit" className={`${btnYes} flex-1 min-w-[8rem]`} disabled={!ready || busy} aria-busy={busy}>
                    {busy ? 'Opening…' : 'Open the vote'}
                </button>
                <button type="button" className={`${btnNo} flex-1 min-w-[6rem]`} onClick={onClose}>Cancel</button>
            </div>
        </form>
    );
}
