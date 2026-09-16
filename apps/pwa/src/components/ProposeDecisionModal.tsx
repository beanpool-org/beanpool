import { useState, useEffect, useMemo } from 'react';
import {
    createDecision,
    getBalance,
    type DecisionTouch,
    type DecisionEffect,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
    identity: BeanPoolIdentity | null;
    commonsBalance: number;
    members?: Array<{ publicKey: string; callsign?: string; balance?: number }>;
    treasuries?: Array<{ publicKey: string; name: string; balance?: number }>;
}

const TOUCH_OPTIONS: Array<{ id: DecisionTouch; label: string; icon: string }> = [
    { id: 'member', label: 'Member', icon: '👤' },
    { id: 'pool', label: 'Commons Pool', icon: '🏛️' },
];

const EFFECTS_BY_TOUCH: Record<DecisionTouch, Array<{ id: DecisionEffect; label: string; desc: string }>> = {
    member: [
        { id: 'remove_member', label: 'Remove Member', desc: 'Expulsion from this node (66% supermajority, 25% quorum, 7-day grace window)' },
        { id: 'suspend_member', label: 'Suspend Member', desc: 'Temporary freeze of trading and messaging' },
        { id: 'unsuspend_member', label: 'Unsuspend Member', desc: 'Restore member to active standing (simple majority)' },
        { id: 'reinstate_member', label: 'Reinstate Member', desc: 'Cancel pending removal and restore account (simple majority)' },
        { id: 'freeze_credit', label: 'Freeze Credit', desc: 'Lock credit floor to zero' },
        { id: 'unfreeze_credit', label: 'Unfreeze Credit', desc: 'Restore credit floor (simple majority)' },
        { id: 'grant_voucher', label: 'Grant Voucher', desc: 'Authorise member to vouch for newcomers' },
        { id: 'revoke_voucher', label: 'Revoke Voucher', desc: 'Remove vouching privileges' },
        { id: 'grant_tier', label: 'Grant Tier Badge', desc: 'Assign Newcomer / Resident / Steward / Elder' },
        { id: 'revoke_tier', label: 'Revoke Tier Badge', desc: 'Reset member tier badge' },
        { id: 'grant_elder', label: 'Grant Elder', desc: 'Grant community Elder standing' },
        { id: 'revoke_elder', label: 'Revoke Elder', desc: 'Revoke community Elder standing' },
        { id: 'remove_lead_keeper', label: 'Remove Lead Keeper', desc: 'Replace rogue enterprise lead keeper' },
    ],
    pool: [
        { id: 'grant_enterprise', label: 'Grant to Enterprise', desc: 'Disburse Commons funds directly to an enterprise account' },
        { id: 'grant_hardship', label: 'Hardship Grant', desc: 'Direct emergency support grant from Commons pool to a member' },
        { id: 'write_off_deficit', label: 'Write Off Deficit', desc: 'Absorb bad debt of a defaulted enterprise' },
    ],
    rule: [],
    nothing: [
        { id: 'poll', label: 'Poll', desc: 'Everyday question' },
    ],
};

export function ProposeDecisionModal({
    isOpen,
    onClose,
    onCreated,
    identity,
    commonsBalance,
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
    const [tier, setTier] = useState<'Newcomer' | 'Resident' | 'Steward' | 'Elder'>('Resident');
    const [ruleKey, setRuleKey] = useState('');
    const [ruleValue, setRuleValue] = useState('');
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

    const [fetchedBalance, setFetchedBalance] = useState<number | null>(null);

    // Lookup selected member details for removal preview
    const selectedMember = useMemo(() => {
        if (!subject) return null;
        return members.find(m => m.publicKey === subject || m.callsign?.toLowerCase() === subject.toLowerCase());
    }, [members, subject]);

    useEffect(() => {
        if (effect !== 'remove_member' || !subject) {
            setFetchedBalance(null);
            return;
        }
        const targetPubkey = selectedMember ? selectedMember.publicKey : (subject.trim().length >= 32 ? subject.trim() : null);
        if (!targetPubkey) {
            setFetchedBalance(null);
            return;
        }
        if (selectedMember && typeof selectedMember.balance === 'number') {
            setFetchedBalance(null);
            return;
        }
        let cancelled = false;
        getBalance(targetPubkey)
            .then(bal => {
                if (!cancelled && bal && typeof bal.balance === 'number') {
                    setFetchedBalance(bal.balance);
                }
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [effect, subject, selectedMember]);

    const targetName = selectedMember?.callsign || subject || 'Member';
    const targetBalance = selectedMember?.balance ?? fetchedBalance ?? 0;
    const debtAmount = Math.abs(targetBalance < 0 ? targetBalance : 0);
    const poolAmount = Math.round(commonsBalance || 0);

    // §3.8 verbatim line:
    // "<name>'s balance is −N beans. Removing them charges that N to the Commons pool, which currently holds M."
    // Note: Unicode \u2212 minus sign
    const debtWriteOffLine = debtAmount > 0
        ? `${targetName}'s balance is \u2212${debtAmount} beans. Removing them charges that ${debtAmount} to the Commons pool, which currently holds ${poolAmount}.`
        : `${targetName} has no outstanding debt (balance: ${targetBalance} beans). Removing them incurs no write-off charge against the Commons pool (balance: ${poolAmount}).`;

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!identity) return;
        if (!title.trim()) {
            setError('Please enter a clear title for this decision.');
            return;
        }
        if (!description.trim()) {
            setError('Please provide a description and rationale.');
            return;
        }

        const targetPubkey = selectedMember?.publicKey || (subject.trim().length === 64 ? subject.trim() : null);

        if (touches === 'member' && !targetPubkey) {
            setError('Please enter a valid member callsign or 64-character public key.');
            return;
        }

        let params: any = {};
        if (effect === 'grant_enterprise' || effect === 'grant_hardship') {
            const amount = Number(grantAmount);
            if (!amount || amount <= 0) {
                setError('Please enter a valid positive grant amount in Beans.');
                return;
            }
            params = { amount };
        } else if (effect === 'grant_tier') {
            params = { tier };
        } else if (effect === 'remove_lead_keeper') {
            if (!enterprisePubkey.trim()) {
                setError('Please select or enter the enterprise public key.');
                return;
            }
            if (!targetPubkey) {
                setError('Please enter the lead keeper callsign or public key to remove.');
                return;
            }
            params = { enterprisePubkey: enterprisePubkey.trim(), leadPubkey: targetPubkey };
        } else if (effect === 'write_off_deficit') {
            if (!enterprisePubkey.trim()) {
                setError('Please select or enter the enterprise public key.');
                return;
            }
        } else if (effect === 'set_rule') {
            params = { key: ruleKey, value: ruleValue };
        } else if (effect === 'remove_member') {
            params = {
                memberName: targetName,
                debt: debtAmount,
                commonsPool: poolAmount,
            };
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
                setError((res as any).error || 'Failed to propose decision');
            }
        } catch (err: any) {
            setError(err.message || 'Failed to propose decision');
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
                        <span>🌱</span> Propose a Community Decision
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-nature-400 hover:text-white p-1 text-lg rounded-lg transition-colors"
                        aria-label="Close modal"
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
                            What does this decision touch? (§3.6)
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {TOUCH_OPTIONS.map(opt => (
                                <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => setTouches(opt.id)}
                                    className={`py-2 px-3 rounded-xl border text-sm font-semibold flex items-center justify-center gap-2 transition-all ${
                                        touches === opt.id
                                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                                            : 'bg-nature-800/60 border-nature-700 text-nature-400 hover:border-nature-600'
                                    }`}
                                >
                                    <span>{opt.icon}</span>
                                    <span>{opt.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Title */}
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                            Title
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="e.g. Grant 200 beans to the Tool Library"
                            className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            required
                        />
                    </div>

                    {/* Description */}
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                            Description & Rationale
                        </label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Explain why this decision is needed, the plan, and who will oversee it."
                            rows={3}
                            className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            required
                        />
                    </div>

                    {/* Effect Selection */}
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-2">
                            Specific Action / Effect
                        </label>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1" role="radiogroup" aria-label="Specific Action or Effect">
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
                                        {eff.label}
                                    </div>
                                    <div className="text-xs text-nature-400 leading-tight mt-0.5">
                                        {eff.desc}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Enterprise Input for remove_lead_keeper and write_off_deficit */}
                    {(effect === 'remove_lead_keeper' || effect === 'write_off_deficit') && (
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                                Target Enterprise / Treasury
                            </label>
                            {treasuries.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                    {treasuries.map(t => (
                                        <button
                                            key={t.publicKey}
                                            type="button"
                                            onClick={() => setEnterprisePubkey(t.publicKey)}
                                            className={`px-2.5 py-1 rounded-lg border text-xs font-semibold transition-all ${
                                                enterprisePubkey === t.publicKey
                                                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                                                    : 'bg-nature-800/60 border-nature-700 text-nature-300 hover:border-nature-600'
                                            }`}
                                        >
                                            {t.name}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <input
                                type="text"
                                value={enterprisePubkey}
                                onChange={(e) => setEnterprisePubkey(e.target.value)}
                                placeholder="Enter enterprise pubkey..."
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                                required
                            />
                        </div>
                    )}

                    {/* Subject Input */}
                    {touches === 'member' && (
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                                {effect === 'remove_lead_keeper' ? 'Lead Keeper Callsign or Public Key to Remove' : 'Target Member Callsign or Public Key'}
                            </label>
                            <input
                                type="text"
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                placeholder={effect === 'remove_lead_keeper' ? 'Enter lead keeper callsign or pubkey...' : 'Enter member callsign or pubkey...'}
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                        </div>
                    )}

                    {effect === 'grant_enterprise' && (
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                                Target Enterprise Public Key
                            </label>
                            <input
                                type="text"
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                placeholder="Enter enterprise pubkey..."
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mt-2 mb-1">
                                Grant Amount (Beans)
                            </label>
                            <input
                                type="number"
                                value={grantAmount}
                                onChange={(e) => setGrantAmount(e.target.value)}
                                placeholder="e.g. 250"
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                        </div>
                    )}

                    {effect === 'grant_hardship' && (
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                                Recipient Member Public Key
                            </label>
                            <input
                                type="text"
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                placeholder="Enter recipient pubkey..."
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mt-2 mb-1">
                                Hardship Amount (Beans)
                            </label>
                            <input
                                type="number"
                                value={grantAmount}
                                onChange={(e) => setGrantAmount(e.target.value)}
                                placeholder="e.g. 100"
                                className="w-full bg-nature-800/80 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white placeholder-nature-500 focus:outline-none focus:border-emerald-500"
                            />
                        </div>
                    )}

                    {effect === 'grant_tier' && (
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider text-nature-400 mb-1">
                                Select Tier Badge
                            </label>
                            <div className="grid grid-cols-4 gap-2">
                                {(['Newcomer', 'Resident', 'Steward', 'Elder'] as const).map(t => (
                                    <button
                                        key={t}
                                        type="button"
                                        onClick={() => setTier(t)}
                                        className={`py-2 px-2 rounded-xl border text-xs font-bold transition-all ${
                                            tier === t
                                                ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                                                : 'bg-nature-800/60 border-nature-700 text-nature-400'
                                        }`}
                                    >
                                        {t}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* §3.8 Removal Ballot Special Debt Disclosure Warning Box */}
                    {effect === 'remove_member' && (
                        <div
                            className="bg-red-500/10 border border-red-500/30 rounded-xl p-3"
                            data-testid="removal-debt-write-off-box"
                        >
                            <div className="text-xs font-bold text-red-400 uppercase tracking-wider mb-1">
                                Mandatory Debt Disclosure (§3.8)
                            </div>
                            <div className="text-sm font-semibold text-red-200" data-testid="removal-debt-write-off-line">
                                {debtWriteOffLine}
                            </div>
                        </div>
                    )}

                    {/* No Bond Info Banner */}
                    <div className="bg-nature-800/40 border border-nature-700/60 rounded-xl p-3 flex items-start gap-2 text-xs text-nature-300">
                        <span className="text-emerald-400 text-sm">🛡️</span>
                        <div>
                            <span className="font-bold text-white">No bond required.</span> Gated by your earned trade standing (earnedCredit &gt; 0). Open for 7 days, executing automatically on pass.
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 py-2.5 px-4 rounded-xl border border-nature-700 text-nature-300 hover:bg-nature-800 font-semibold text-sm transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={submitting}
                            className="flex-1 py-2.5 px-4 rounded-xl bg-accent hover:bg-emerald-500 text-white font-bold text-sm shadow-md transition-all active:scale-95 disabled:opacity-50"
                        >
                            {submitting ? 'Submitting...' : 'Submit Decision'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
