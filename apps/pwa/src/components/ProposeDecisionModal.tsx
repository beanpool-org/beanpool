import { useState, useEffect, useMemo } from 'react';
import {
    createDecision,
    type DecisionTouch,
    type DecisionEffect,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { keeperWords, amountRefusalWords, ANY_DECIMALS, isAmbiguousAmount, parseAmount, t, word, type WordKey } from '@beanpool/core';
import { Sentence } from './Sentence';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
    identity: BeanPoolIdentity | null;
    /** Not read since removal by vote S3: it fed the removal's debt line, and a removal is no longer proposed here. */
    commonsBalance: number;
    members?: Array<{ publicKey: string; callsign?: string; balance?: number }>;
    treasuries?: Array<{ publicKey: string; name: string; balance?: number; lifecycle?: string | null }>;
}

/** What a Decision can touch and do: word() keys (the phone's), shown through t(). */
const TOUCH_OPTIONS: Array<{ id: DecisionTouch; label: WordKey; icon: string }> = [
    { id: 'member', label: word('Member', 'what a Decision touches'), icon: '👤' },
    { id: 'pool', label: word('Commons Pool'), icon: '🏛️' },
];

/**
 * Not a vote on removing a member: since removal by vote S3 (Amendment A of the design, point 1) that opens only when an
 * admin pauses someone, and the node refuses it as a proposal (server decisions-engine.ts REMOVAL_FOLLOWS_A_PAUSE). A
 * report is how a member asks for it.
 */
const EFFECTS_BY_TOUCH: Record<DecisionTouch, Array<{ id: DecisionEffect; label: WordKey; desc: WordKey }>> = {
    member: [
        { id: 'suspend_member', label: word('Suspend Member'), desc: word('Temporary freeze of trading and messaging') },
        { id: 'unsuspend_member', label: word('Unsuspend Member'), desc: word('Restore member to active standing (simple majority)') },
        { id: 'reinstate_member', label: word('Reinstate Member'), desc: word('Cancel pending removal and restore account (simple majority)') },
        { id: 'freeze_credit', label: word('Freeze Credit'), desc: word('Lock credit floor to zero') },
        { id: 'unfreeze_credit', label: word('Unfreeze Credit'), desc: word('Restore credit floor (simple majority)') },
        { id: 'grant_voucher', label: word('Grant Voucher'), desc: word('Authorise member to vouch for newcomers') },
        { id: 'revoke_voucher', label: word('Revoke Voucher'), desc: word('Remove vouching privileges') },
        { id: 'remove_lead_keeper', label: word('Remove a lead keeper or project leader'), desc: word("Replace an enterprise's lead keeper or a project's leader") },
    ],
    pool: [
        { id: 'grant_enterprise', label: word('Give Beans to a project or enterprise'), desc: word("Pay Beans from the Commons pool straight into a project's or enterprise's account") },
        { id: 'grant_hardship', label: word('Hardship Grant'), desc: word('Direct emergency support grant from Commons pool to a member') },
        { id: 'write_off_deficit', label: word("Pay off a project's or enterprise's debt"), desc: word("The Commons pool takes on the debt of a project or enterprise that can't pay it") },
    ],
};

/**
 * The removal of a lead: a project's leader, an enterprise's lead keeper, or (none picked yet) both words. Whole
 * sentences for each, never the word glued in (the phone's keys).
 */
function leadWords(lead: 'leader' | 'lead keeper' | 'either') {
    if (lead === 'leader') {
        return {
            enter: t("Please enter the leader's callsign or public key."),
            label: t('The leader to remove: callsign or public key'), placeholder: t("Enter the leader's callsign or pubkey..."),
        };
    }
    if (lead === 'lead keeper') {
        return {
            enter: t("Please enter the lead keeper's callsign or public key."),
            label: t('The lead keeper to remove: callsign or public key'), placeholder: t("Enter the lead keeper's callsign or pubkey..."),
        };
    }
    return {
        enter: t("Please enter the lead keeper or leader's callsign or public key."),
        label: t('The lead keeper or leader to remove: callsign or public key'), placeholder: t("Enter the lead keeper or leader's callsign or pubkey..."),
    };
}

export function ProposeDecisionModal({
    isOpen,
    onClose,
    onCreated,
    identity,
    members = [],
    treasuries = [],
}: Props) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [touches, setTouches] = useState<DecisionTouch>('member');
    const [effect, setEffect] = useState<DecisionEffect>('suspend_member');
    const [subject, setSubject] = useState('');
    const [enterprisePubkey, setEnterprisePubkey] = useState('');
    const [grantAmount, setGrantAmount] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset effect when touch changes
    useEffect(() => {
        const available = EFFECTS_BY_TOUCH[touches];
        if (available && available.length > 0) {
            setEffect(available[0].id);
        }
    }, [touches]);

    // Handle Escape key
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);


    // ⚡ Bolt: O(1) Map lookup for selected member details by publicKey and callsign instead of O(M) .find() scans
    const membersByKeyMap = useMemo(() => {
        const map = new Map<string, typeof members[number]>();
        for (const m of members) {
            if (m.publicKey) map.set(m.publicKey, m);
            if (m.callsign) map.set(m.callsign.toLowerCase(), m);
        }
        return map;
    }, [members]);

    // Lookup selected member details by callsign or key
    const selectedMember = useMemo(() => {
        if (!subject) return null;
        return membersByKeyMap.get(subject) || membersByKeyMap.get(subject.toLowerCase()) || null;
    }, [membersByKeyMap, subject]);

    // The one removed is a project's leader or an enterprise's lead keeper (§3.1); until one is picked, both words.
    const pickedGroup = treasuries.find(tr => tr.publicKey === enterprisePubkey.trim());
    const lead = leadWords(pickedGroup ? (keeperWords(pickedGroup.lifecycle).lead === 'leader' ? 'leader' : 'lead keeper') : 'either');

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!identity) return;
        if (!title.trim()) {
            setError(t('Please enter a clear title for this decision.'));
            return;
        }
        if (!description.trim()) {
            setError(t('Please provide a description and rationale.'));
            return;
        }

        const targetPubkey = selectedMember?.publicKey || (subject.trim().length === 64 ? subject.trim() : null);

        if (touches === 'member' && !targetPubkey) {
            setError(t('Please enter a valid member callsign or 64-character public key.'));
            return;
        }

        let params: any = {};
        if (effect === 'grant_enterprise' || effect === 'grant_hardship') {
            // The language's decimal mark (core parseAmount): fr "12,5" is 12.5; "1.000", which could be a thousand, is refused
            // in words that say so. The node's cents rule decides the decimals, as before.
            const read = parseAmount(grantAmount, undefined, ANY_DECIMALS);
            if (!read.ok && isAmbiguousAmount(read.refusal)) {
                setError(amountRefusalWords(read.refusal));
                return;
            }
            const amount = read.ok ? read.value : NaN;
            if (!amount || amount <= 0) {
                setError(t('Please enter a valid positive grant amount in Beans.'));
                return;
            }
            params = { amount };
        } else if (effect === 'remove_lead_keeper') {
            if (!enterprisePubkey.trim()) {
                setError(t('Please pick the project or enterprise, or enter its public key.'));
                return;
            }
            if (!targetPubkey) {
                setError(lead.enter);
                return;
            }
            params = { enterprisePubkey: enterprisePubkey.trim(), leadPubkey: targetPubkey };
        } else if (effect === 'write_off_deficit') {
            if (!enterprisePubkey.trim()) {
                setError(t('Please pick the project or enterprise, or enter its public key.'));
                return;
            }
        }

        setSubmitting(true);
        setError(null);
        try {
            const resolvedSubject = (effect === 'write_off_deficit' ? enterprisePubkey.trim() : (touches === 'member' ? targetPubkey : (selectedMember ? selectedMember.publicKey : (subject.trim() || null)))) || null;
            const res = await createDecision({
                authorPubkey: identity.publicKey,
                title: title.trim(),
                description: description.trim(),
                touches,
                effect,
                subject: resolvedSubject,
                params,
            });

            if (res.success) {
                setTitle('');
                setDescription('');
                setSubject('');
                setEnterprisePubkey('');
                setGrantAmount('');
                onCreated();
                onClose();
            } else {
                setError((res as any).error || t('Failed to propose decision'));
            }
        } catch (err: any) {
            setError(err.message || t('Failed to propose decision'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="propose-modal-title"
        >
            <div
                className="relative bg-nature-900 border border-nature-800 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-xl max-h-[90vh] overflow-y-auto shadow-2xl p-6 flex flex-col gap-4 text-white"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                    <h2 id="propose-modal-title" className="text-lg font-bold flex items-center gap-2">
                        <span aria-hidden="true">🌱</span> {t('Propose a Community Decision')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-nature-400 hover:text-white p-1 text-lg rounded-lg transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        aria-label={t('Close modal')}
                    >
                        ✕
                    </button>
                </div>

                {error && (
                    <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm p-3 rounded-xl">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    {/* What it touches */}
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-2">
                            {t('What does this decision touch? (§3.6)')}
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {TOUCH_OPTIONS.map(opt => (
                                <button
                                    key={opt.id}
                                    type="button"
                                    aria-pressed={touches === opt.id}
                                    onClick={() => setTouches(opt.id)}
                                    className={`py-2 px-3 min-h-[44px] rounded-xl border text-sm font-semibold flex items-center justify-center gap-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                                        touches === opt.id
                                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                                            : 'bg-nature-800/60 border-nature-700 text-nature-400 hover:border-nature-600'
                                    }`}
                                >
                                    <span aria-hidden="true">{opt.icon}</span>
                                    <span>{t(opt.label)}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Title */}
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                            {t('Title')}
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={t('e.g. Grant 200 beans to the Tool Library')}
                            className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            required
                        />
                    </div>

                    {/* Description */}
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                            {t('Description & Rationale')}
                        </label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={t('Explain why this decision is needed, the plan, and who will oversee it.')}
                            rows={3}
                            className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            required
                        />
                    </div>

                    {/* Effect Selection */}
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-2">
                            {t('Specific Action / Effect')}
                        </label>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1" role="radiogroup" aria-label={t('Specific Action or Effect')}>
                            {EFFECTS_BY_TOUCH[touches].map(eff => (
                                <button
                                    type="button"
                                    key={eff.id}
                                    role="radio"
                                    aria-checked={effect === eff.id}
                                    onClick={() => !submitting && setEffect(eff.id)}
                                    disabled={submitting}
                                    className={`w-full text-left p-2.5 rounded-xl border transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                                        effect === eff.id
                                            ? 'bg-emerald-500/15 border-emerald-500'
                                            : 'bg-nature-800/40 border-nature-700 hover:border-nature-600'
                                    } ${submitting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                                >
                                    <div className={`text-sm font-semibold ${effect === eff.id ? 'text-emerald-300' : 'text-white'}`}>
                                        {t(eff.label)}
                                    </div>
                                    <div className="text-xs text-nature-400 leading-tight mt-0.5">
                                        {t(eff.desc)}
                                    </div>
                                </button>
                            ))}
                        </div>
                        {/* Removal by vote S3: in place of proposing a removal, the way a member asks for one */}
                        {touches === 'member' && (
                            <p className="text-xs text-nature-300 leading-snug mt-2" data-testid="removal-follows-a-pause">
                                {t('A vote on removing a member opens only when an admin pauses them. To ask for one, report them with Report Member on their profile.')}
                            </p>
                        )}
                    </div>

                    {/* Enterprise Input for remove_lead_keeper and write_off_deficit */}
                    {(effect === 'remove_lead_keeper' || effect === 'write_off_deficit') && (
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                                {t('Project or enterprise')}
                            </label>
                            {treasuries.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                    {treasuries.map(tr => (
                                        <button
                                            key={tr.publicKey}
                                            type="button"
                                            onClick={() => setEnterprisePubkey(tr.publicKey)}
                                            className={`px-2.5 py-1 rounded-lg border text-xs font-semibold transition-all ${
                                                enterprisePubkey === tr.publicKey
                                                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                                                    : 'bg-nature-800/60 border-nature-700 text-nature-300 hover:border-nature-600'
                                            }`}
                                        >
                                            {tr.name}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <input
                                type="text"
                                value={enterprisePubkey}
                                onChange={(e) => setEnterprisePubkey(e.target.value)}
                                placeholder={t('Or enter its public key...')}
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                                required
                            />
                        </div>
                    )}

                    {/* Subject Input */}
                    {touches === 'member' && (
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                                {effect === 'remove_lead_keeper' ? lead.label : t('Target Member Callsign or Public Key')}
                            </label>
                            <input
                                type="text"
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                placeholder={effect === 'remove_lead_keeper' ? lead.placeholder : t('Enter member callsign or pubkey...')}
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                        </div>
                    )}

                    {effect === 'grant_enterprise' && (
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                                {t('Project or enterprise public key')}
                            </label>
                            <input
                                type="text"
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                placeholder={t('Enter its public key...')}
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mt-2 mb-1">
                                {t('Grant Amount (Beans)')}
                            </label>
                            <input
                                type="text"
                                inputMode="decimal"
                                value={grantAmount}
                                onChange={(e) => setGrantAmount(e.target.value)}
                                placeholder={t('e.g. {amount}', { amount: 250 })}
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                        </div>
                    )}

                    {effect === 'grant_hardship' && (
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                                {t('Recipient Member Public Key')}
                            </label>
                            <input
                                type="text"
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                placeholder={t('Enter recipient pubkey...')}
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mt-2 mb-1">
                                {t('Hardship Amount (Beans)')}
                            </label>
                            <input
                                type="text"
                                inputMode="decimal"
                                value={grantAmount}
                                onChange={(e) => setGrantAmount(e.target.value)}
                                placeholder={t('e.g. {amount}', { amount: 100 })}
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                        </div>
                    )}

                    {/* No Bond Info Banner */}
                    <div className="bg-nature-800/40 border border-nature-700/60 rounded-xl p-3 flex items-start gap-2 text-xs text-nature-300">
                        <span className="text-emerald-400 text-sm" aria-hidden="true">🛡️</span>
                        <div>
                            <Sentence
                                text={t('{bond} Open to members who have completed a trade, and to node admins. Open for 7 days, executing automatically on pass.')}
                                parts={{ bond: <span className="font-bold text-white">{t('No bond required.')}</span> }}
                            />
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 min-h-[44px] py-2.5 px-4 rounded-xl border border-nature-700 text-nature-300 hover:bg-nature-800 font-semibold text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                            {t('Cancel')}
                        </button>
                        <button
                            type="submit"
                            disabled={submitting}
                            className="flex-1 min-h-[44px] py-2.5 px-4 rounded-xl bg-bp-sage-fill hover:bg-bp-sage-hover text-bp-sage-on font-bold text-sm shadow-md transition-all active:scale-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                            {submitting ? t('Submitting...') : t('Submit Decision')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
