/**
 * LedgerPage — Balance, Standing, and Trade History
 *
 * Fetches real balance and transaction history from the BeanPool Node API.
 * Mirrors the native app's Trust Level and Financials tab layout and visualizations.
 */

import { useState, useEffect, useCallback } from 'react';
import { type BeanPoolIdentity } from '../lib/identity';
import {
    getBalance, getTransactions, sendTransfer, getMembers,
    type BalanceInfo, type TierInfo, type Transaction, type Member
} from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';
import { CommonsInfoModal } from '../components/CommonsInfoModal';

interface Props {
    identity: BeanPoolIdentity;
    onNavigate?: (tab: string, contextId?: string) => void;
}

// Tiers are recognition milestones. `floor` is the credit floor reached on ENTERING the tier
// (floors slide continuously between them). `min` = earned+granted credit needed.
const TIERS = [
    { name: 'Newcomer', emoji: '🌱', color: '#6b7280', bg: '#f3f4f6', border: '#d1d5db', min: 0,    floor: -20,   perks: ['Browse & trade the marketplace', 'Receive credits', 'Invite new members', 'Send credits after your 1st trade'] },
    { name: 'Resident', emoji: '🏠', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe', min: 180,  floor: -200,  perks: ['Credit floor deepens toward -200'] },
    { name: 'Steward',  emoji: '🏛️', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe', min: 580,  floor: -600,  perks: ['Credit floor deepens toward -600', 'Trusted-trader recognition'] },
    { name: 'Elder',    emoji: '⛰️', color: '#d97706', bg: '#fffbeb', border: '#fde68a', min: 1380, floor: -1400, perks: ['Credit floor deepens toward -1400 (max -2000)', 'Recognised as a community Elder'] },
];

// Trust curve (mirrors beanpool-core/protocol.ts): earned trust is a saturating function of
// qualified, diversity-capped trade VALUE. Floors slide continuously; gifts build no trust.
const CREDIT_MAX_EARNED = 1920;
const TRUST_CURVE_K = 5000;
const PER_COUNTERPARTY_CAP = 5000;
// Inverse of the curve: qualified value needed to reach a target earned credit.
function valueForEarned(target: number): number {
    if (target <= 0) return 0;
    if (target >= CREDIT_MAX_EARNED) return Infinity;
    return Math.ceil((TRUST_CURVE_K * target) / (CREDIT_MAX_EARNED - target));
}

export function LedgerPage({ identity, onNavigate }: Props) {
    const [balanceInfo, setBalanceInfo] = useState<BalanceInfo | null>(null);
    const [txns, setTxns] = useState<Transaction[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'trust' | 'financials'>('trust');

    // Send form
    const [showSend, setShowSend] = useState(false);
    const [sendTo, setSendTo] = useState('');
    const [sendAmount, setSendAmount] = useState('');
    const [sendMemo, setSendMemo] = useState('');
    const [sending, setSending] = useState(false);

    // Search filter for recipient select dropdown
    const [memberSearch, setMemberSearch] = useState('');
    const [showMemberPicker, setShowMemberPicker] = useState(false);
    const [showCommonsInfo, setShowCommonsInfo] = useState(false);

    function renderMemoText(memo: string) {
        const sanitized = memo
            .replace(/escrow hold/gi, 'Held in trust')
            .replace(/escrow/gi, 'trust');
            
        const uuidRegex = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
        const match = sanitized.match(uuidRegex);
        if (match && onNavigate) {
            const offerId = match[1];
            const parts = sanitized.split(offerId);
            return (
                <span>
                    {parts[0]}
                    <button
                        onClick={() => onNavigate('marketplace', offerId)}
                        className="text-emerald-600 dark:text-emerald-400 font-bold hover:underline"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', verticalAlign: 'baseline', font: 'inherit' }}
                    >
                        View Offer
                    </button>
                    {parts[1]}
                </span>
            );
        }
        return sanitized;
    }

    const refresh = useCallback(async () => {
        try {
            const [bal, txn, mem] = await Promise.all([
                getBalance(identity.publicKey).catch(() => null),
                getTransactions(identity.publicKey).catch(() => []),
                getMembers().catch(() => []),
            ]);
            if (bal) setBalanceInfo(bal);
            setTxns(txn);
            setMembers(mem.filter(m => m.publicKey !== identity.publicKey));
            setError(null);
        } catch (e: any) {
            setError(e.message || 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, [identity.publicKey]);

    useEffect(() => {
        refresh();
        const interval = setInterval(refresh, 10_000);
        return () => clearInterval(interval);
    }, [refresh]);

    async function handleSend() {
        if (!sendTo || !sendAmount) return;
        // Sends are positive-balance only — you can only send beans you actually hold. Your credit
        // line (overdraft) is for trading, not for gifting yourself into debt.
        if (Number(sendAmount) > balance) {
            setError(`You can only send beans you hold — your balance is ${balance.toFixed(2)}B.`);
            return;
        }
        setSending(true);
        setError(null);
        try {
            await sendTransfer(identity.publicKey, sendTo, Number(sendAmount), sendMemo);
            setShowSend(false);
            setSendTo('');
            setSendAmount('');
            setSendMemo('');
            await refresh();
        } catch (e: any) {
            setError(e.message || 'Transfer failed');
        } finally {
            setSending(false);
        }
    }

    const balance = balanceInfo?.balance ?? 0;
    const floor = balanceInfo?.floor ?? -80;
    const earned = balanceInfo?.earnedCredit ?? 0;     // from the saturating value curve
    const granted = balanceInfo?.grantedCredit ?? 0;   // vouch/genesis/admin (separate lane)
    const totalCredit = Math.min(CREDIT_MAX_EARNED, earned + granted);
    const ec = totalCredit;                            // "trust" shown to the user
    const qualifiedValue = balanceInfo?.qualifiedValue ?? 0;
    const avgRating = balanceInfo?.avgRating ?? 0;
    const reviewCount = balanceInfo?.reviewCount ?? 0;
    const canSend = earned > 0;                        // real send gate: any completed trade (PR#4)
    const ts = balanceInfo?.trustStats;
    const uniquePartners = ts?.uniquePartners ?? 0;

    // Tier: trust the server's authoritative tier name; fall back to the credit threshold.
    const TIER_NAMES = ['Newcomer', 'Resident', 'Steward', 'Elder'];
    const serverIdx = TIER_NAMES.indexOf(balanceInfo?.tier?.name ?? '');
    const tierIdx = serverIdx >= 0 ? serverIdx : (ec >= 1380 ? 3 : ec >= 580 ? 2 : ec >= 180 ? 1 : 0);
    const tier = TIERS[tierIdx];
    const nextTier = TIERS[tierIdx + 1] || null;
    const ELDER_MIN = 1380;
    const journeyPct = Math.min(1, totalCredit / ELDER_MIN);
    const creditsToNext = nextTier ? Math.max(0, nextTier.min - totalCredit) : 0;

    // Value needed for the next tier: invert the curve for the earned credit it requires
    // (granted credit is fixed), minus value already traded → rough "new partners" count.
    const targetEarned = nextTier ? Math.max(0, nextTier.min - granted) : 0;
    const valueToNext = nextTier ? Math.max(0, valueForEarned(targetEarned) - qualifiedValue) : 0;
    const partnersToNext = nextTier && Number.isFinite(valueToNext)
        ? Math.max(1, Math.ceil(valueToNext / PER_COUNTERPARTY_CAP)) : 0;

    const canInvite = balanceInfo?.tier?.canInvite ?? true;
    const hoursEquivalent = Math.abs(balance) / 40;

    // Piecewise Credit Bar setup
    const ANCHORS: [number, number][] = [
        [-1400, 0.04],
        [-600,  0.13],
        [-200,  0.24],
        [-80,   0.35],
        [0,     0.46],
        [200,   0.57],
        [500,   0.68],
        [1000,  0.79],
        [2000,  0.91],
    ];

    const toPos = (v: number): number => {
        if (v <= ANCHORS[0][0]) return ANCHORS[0][1];
        if (v >= ANCHORS[ANCHORS.length - 1][0]) return ANCHORS[ANCHORS.length - 1][1];
        for (let i = 0; i < ANCHORS.length - 1; i++) {
            const [v0, p0] = ANCHORS[i];
            const [v1, p1] = ANCHORS[i + 1];
            if (v >= v0 && v <= v1) {
                const t = (v - v0) / (v1 - v0);
                return p0 + t * (p1 - p0);
            }
        }
        return 0.5;
    };

    const balancePct = toPos(balance);

    const tierMarkers = [...TIERS].reverse().map(t => ({
        ...t,
        pos: ANCHORS.find(a => a[0] === t.floor)?.[1] ?? toPos(t.floor),
    }));

    const circMarkers = [
        { v: 200,  pos: 0.57  },
        { v: 500,  pos: 0.68  },
        { v: 1000, pos: 0.79  },
        { v: 2000, pos: 0.91  },
    ];

    const zoneRates = [
        { rate: '0%',   pos: (0.46 + 0.57) / 2, color: '#10b981' },
        { rate: '1%',   pos: (0.57 + 0.68) / 2 },
        { rate: '1.5%', pos: (0.68 + 0.79) / 2 },
        { rate: '2%',   pos: (0.79 + 0.91) / 2 },
        { rate: '2.5%', pos: (0.91 + 1.00) / 2 },
    ];

    const selectedMember = members.find(m => m.publicKey === sendTo);
    const filteredMembers = members.filter(m => m.callsign.toLowerCase().includes(memberSearch.toLowerCase()));

    return (
        <div className="p-4 max-w-[600px] mx-auto min-h-full pb-24">
            {/* Identity & Balance Overview */}
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between p-6 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm mb-4">
                <div className="flex items-center gap-3">
                    <div className="w-14 h-14 rounded-full border-2 border-emerald-500 overflow-hidden bg-oat-50 dark:bg-nature-800 shadow-inner flex items-center justify-center">
                        <img src="/assets/logo-192x192.png" className="w-[70%] h-[70%] object-contain" alt="Identity" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-nature-950 dark:text-white leading-tight">{identity.callsign}</h2>
                        <div className="mt-1 flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-nature-100 dark:bg-nature-800 text-nature-600 dark:text-nature-400 border border-nature-200 dark:border-nature-700 w-fit">
                            <span>{tier.emoji}</span>
                            <span>{tier.name}</span>
                        </div>
                    </div>
                </div>

                <div className="text-right flex flex-col items-center md:items-end">
                    <span className={`text-2xl font-black font-mono ${balance >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {balance >= 0 ? '+' : ''}{balance.toFixed(1)}B
                    </span>
                    <span className="text-[10px] font-bold text-nature-400 uppercase tracking-wider">Beans</span>
                </div>
            </div>

            {/* Credit Spectrum Bar */}
            <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 mb-4 shadow-sm relative overflow-hidden">
                <div className="h-[96px] relative select-none w-full">
                    {/* Background Bar Segments */}
                    {/* Red left: <= -600 */}
                    <div className="absolute h-3 top-6 left-[2%] w-[11%] bg-red-500 rounded-l-md" />
                    {/* Orange left: -600 to -200 */}
                    <div className="absolute h-3 top-6 left-[13%] w-[11%] bg-orange-500" />
                    {/* Yellow left: -200 to -80 */}
                    <div className="absolute h-3 top-6 left-[24%] w-[11%] bg-yellow-500" />
                    {/* Green overdraft: -80 to 0 */}
                    <div className="absolute h-3 top-6 left-[35%] w-[11%] bg-emerald-500" />
                    {/* Green tax-free: 0 to 200 */}
                    <div className="absolute h-3 top-6 left-[46%] w-[11%] bg-emerald-500" />
                    {/* Lime: 200 to 500 */}
                    <div className="absolute h-3 top-6 left-[57%] w-[11%] bg-lime-500" />
                    {/* Yellow right: 500 to 1000 */}
                    <div className="absolute h-3 top-6 left-[68%] w-[11%] bg-yellow-500" />
                    {/* Orange right: 1000 to 2000 */}
                    <div className="absolute h-3 top-6 left-[79%] w-[12%] bg-orange-500" />
                    {/* Red right: 2000+ */}
                    <div className="absolute h-3 top-6 left-[91%] w-[7%] bg-red-500 rounded-r-md" />

                    {/* Zero Line */}
                    <div className="absolute w-[2px] h-[16px] top-9 left-[46%] bg-nature-900 dark:bg-white" />
                    <span className="absolute top-[56px] left-[46%] -translate-x-1/2 text-[9px] font-bold text-nature-800 dark:text-white">0</span>

                    {/* Tier Floor Ticks */}
                    {tierMarkers.map(t => {
                        const isCurrent = t.name === tier.name;
                        return (
                            <div key={t.name} className="absolute flex flex-col items-center top-9" style={{ left: `${t.pos * 100}%`, transform: 'translateX(-50%)' }}>
                                <div className="w-[1px] h-[6px] bg-nature-400 dark:bg-nature-600" />
                                <span className={`text-[8px] font-bold ${isCurrent ? 'text-indigo-600 dark:text-indigo-400 font-black' : 'text-nature-400 dark:text-nature-500'}`}>{t.floor}</span>
                                <div className={`mt-0.5 px-1 rounded flex items-center justify-center ${isCurrent ? 'border-2 border-indigo-500 bg-white dark:bg-nature-950 scale-110 shadow-sm' : ''}`}>
                                    <span className="text-[10px]">{t.emoji}</span>
                                </div>
                                {isCurrent && <span className="text-[6px] font-black text-indigo-500 uppercase tracking-widest mt-0.5">YOU</span>}
                            </div>
                        );
                    })}

                    {/* Circ Markers */}
                    {circMarkers.map(c => (
                        <div key={c.v} className="absolute flex flex-col items-center top-9" style={{ left: `${c.pos * 100}%`, transform: 'translateX(-50%)' }}>
                            <div className="w-[1px] h-[6px] bg-nature-400 dark:bg-nature-600" />
                            <span className="text-[8px] font-bold text-nature-400 dark:text-nature-500">{c.v}</span>
                        </div>
                    ))}

                    {/* Tax Rates */}
                    {zoneRates.map(z => (
                        <span key={z.rate} className="absolute top-[56px] text-[8px] font-black text-nature-500 dark:text-nature-450" style={{ left: `${z.pos * 100}%`, transform: 'translateX(-50%)', color: z.color }}>
                            {z.rate}
                        </span>
                    ))}

                    {/* Balance Bead */}
                    <div className="absolute flex flex-col items-center w-16 top-0" style={{ left: `${balancePct * 100}%`, transform: 'translateX(-50%)' }}>
                        <span className={`text-[10px] font-extrabold mb-1 ${balance >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                            {balance >= 0 ? '+' : ''}{balance.toFixed(1)}
                        </span>
                        <div className="w-4 h-4 rounded-full border-2 border-white dark:border-nature-900 shadow-md" style={{ backgroundColor: tier.color }} />
                    </div>
                </div>

                <div className="text-center mt-3 text-[11px] text-nature-500 dark:text-nature-400 italic">
                    ⚖️ Zero is the sweet spot — you've given as much as you've received.
                </div>
            </div>

            {/* Tab Bar */}
            <div className="flex bg-white dark:bg-nature-900 border-b border-nature-200 dark:border-nature-800 rounded-t-2xl shadow-sm overflow-hidden">
                <button
                    className={`flex-1 py-3 text-center border-b-2 font-bold text-sm bg-transparent cursor-pointer transition-all flex items-center justify-center gap-1.5 ${
                        activeTab === 'trust'
                            ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400 font-extrabold'
                            : 'border-transparent text-nature-400 dark:text-nature-500 hover:text-nature-600'
                    }`}
                    onClick={() => setActiveTab('trust')}
                >
                    🛡️ Trust Level
                </button>
                <button
                    className={`flex-1 py-3 text-center border-b-2 font-bold text-sm bg-transparent cursor-pointer transition-all flex items-center justify-center gap-1.5 ${
                        activeTab === 'financials'
                            ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400 font-extrabold'
                            : 'border-transparent text-nature-400 dark:text-nature-500 hover:text-nature-600'
                    }`}
                    onClick={() => setActiveTab('financials')}
                >
                    💸 Financials
                </button>
            </div>

            {/* Tab Content */}
            {activeTab === 'trust' ? (
                <div className="flex flex-col gap-4 mt-4 animate-in fade-in duration-300">
                    {/* Tier Hero */}
                    <div className="border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 rounded-2xl p-5 shadow-sm" style={{ borderLeftColor: tier.color, borderLeftWidth: '6px' }}>
                        <div className="flex justify-between items-start mb-4">
                            <div>
                                <span className="text-[10px] font-bold text-nature-400 uppercase tracking-widest">YOUR TRUST LEVEL</span>
                                <div className="flex items-center gap-2 mt-1">
                                    <span className="text-3xl select-none">{tier.emoji}</span>
                                    <span className="text-xl font-black text-nature-950 dark:text-white" style={{ color: tier.color }}>{tier.name}</span>
                                </div>
                            </div>
                            <span className="text-xs font-bold px-2 py-1 rounded bg-nature-100 dark:bg-nature-800 text-nature-600 dark:text-nature-400 border">
                                Level {tierIdx + 1} / {TIERS.length}
                            </span>
                        </div>

                        {/* Journey to Elder Progress Bar */}
                        <div className="relative h-2 bg-nature-200 dark:bg-nature-800 rounded-full mt-6 mb-2">
                            <div className="absolute h-full rounded-full" style={{ width: `${journeyPct * 100}%`, backgroundColor: tier.color }} />
                            {TIERS.filter(t => t.min > 0).map(t => {
                                const pos = Math.min(1, t.min / ELDER_MIN);
                                const reached = ec >= t.min;
                                return (
                                    <div key={t.name} className="absolute flex flex-col items-center -top-0.5" style={{ left: `${pos * 100}%`, transform: 'translateX(-50%)' }}>
                                        <div className={`w-[2px] h-[12px] ${reached ? 'bg-emerald-500' : 'bg-nature-400'}`} />
                                        <span className="text-[10px] mt-1">{t.emoji}</span>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="flex justify-between mt-6 text-xs font-bold text-nature-500">
                            <span>{ec} trust</span>
                            {nextTier ? (
                                <span>{creditsToNext} to {nextTier.name}</span>
                            ) : (
                                <span className="text-amber-500">✨ Maximum level!</span>
                            )}
                        </div>

                        {/* Perks — Send unlocks after your 1st completed trade; Invite is open to everyone */}
                        <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-nature-100 dark:border-nature-800">
                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-extrabold ${canSend ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 text-emerald-600' : 'bg-nature-100 dark:bg-nature-800 border-nature-200 text-nature-400'}`}>
                                <span>{canSend ? '✓' : '🔒'}</span>
                                <span>{canSend ? 'Send Credits' : 'Send (after 1st trade)'}</span>
                            </div>
                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-extrabold ${canInvite ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 text-emerald-600' : 'bg-nature-100 dark:bg-nature-800 border-nature-200 text-nature-400'}`}>
                                <span>{canInvite ? '✓' : '🔒'}</span>
                                <span>Invite Members</span>
                            </div>
                        </div>
                    </div>

                    {/* How to reach next tier */}
                    {nextTier && (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm">
                            <h3 className="font-extrabold text-[15px] text-nature-950 dark:text-white mb-2">🚀 Reach {nextTier.emoji} {nextTier.name}</h3>
                            <p className="text-sm font-black text-indigo-650 dark:text-indigo-400 mb-2">{creditsToNext} trust to go</p>
                            <p className="text-xs text-nature-500 leading-relaxed mb-4">
                                Trust grows with the real value you trade. Trading with someone NEW counts fastest —
                                value with any one partner is capped, so a wide circle beats repeat trades with the same person.
                            </p>
                            <div className="grid grid-cols-2 gap-3 text-center">
                                <div className="p-3 bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/40 rounded-xl relative">
                                    <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{Number.isFinite(valueToNext) ? `~${valueToNext}` : '—'}</div>
                                    <div className="text-[9px] font-bold text-nature-400 uppercase mt-1">beans of value to trade</div>
                                    <span className="absolute -top-2 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-emerald-500 text-white font-black text-[8px] uppercase tracking-wider">the lever</span>
                                </div>
                                <div className="p-3 bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl">
                                    <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400">{partnersToNext || '—'}</div>
                                    <div className="text-[9px] font-bold text-nature-400 uppercase mt-1">new partners (roughly)</div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* What builds trust: value traded, a diverse circle of partners, and reputation */}
                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm">
                        <span className="text-[10px] font-bold text-nature-400 uppercase tracking-widest block mb-4">WHAT BUILDS YOUR TRUST</span>
                        <div className="grid grid-cols-3 gap-3">
                            {[
                                { icon: '💰', label: 'VALUE TRADED', big: `${qualifiedValue}`, foot: `+${earned} trust`, pct: Math.min(1, qualifiedValue / valueForEarned(1380)), color: '#10b981' },
                                { icon: '👥', label: 'PARTNERS', big: `${uniquePartners}`, foot: 'diverse = faster', pct: Math.min(1, uniquePartners / 20), color: '#3b82f6' },
                                { icon: '⭐', label: 'RATING', big: reviewCount > 0 ? avgRating.toFixed(1) : '—', foot: reviewCount > 0 ? `${reviewCount} review${reviewCount === 1 ? '' : 's'}` : 'no reviews yet', pct: reviewCount > 0 ? avgRating / 5 : 1, color: '#f97316' },
                            ].map(a => (
                                <div key={a.label} className="p-3 border border-nature-200 dark:border-nature-800 rounded-xl flex flex-col justify-between">
                                    <div>
                                        <span className="text-xl">{a.icon}</span>
                                        <div className="text-lg font-black text-nature-950 dark:text-white mt-1 leading-none">{a.big}</div>
                                        <div className="text-[9px] font-bold text-nature-400 uppercase tracking-wider mt-1">{a.label}</div>
                                    </div>
                                    <div className="mt-3">
                                        <div className="w-full h-1 bg-nature-100 dark:bg-nature-850 rounded-full overflow-hidden">
                                            <div className="h-full rounded-full" style={{ width: `${Math.min(100, a.pct * 100)}%`, backgroundColor: a.color }} />
                                        </div>
                                        <span className="text-[8px] font-bold text-nature-400 mt-1 block">{a.foot}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Trust Ladder */}
                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl shadow-sm overflow-hidden">
                        <span className="text-[10px] font-bold text-nature-400 uppercase tracking-widest block p-5 pb-0">TRUST LADDER</span>
                        <div className="flex flex-col mt-4">
                            {TIERS.map((t, i) => {
                                const reached = tierIdx >= i;
                                const isCurrent = tierIdx === i;
                                const creditsNeeded = Math.max(0, t.min - ec);
                                return (
                                    <div key={t.name} className={`p-4 border-b border-nature-100 dark:border-nature-800 last:border-0 flex gap-3 ${isCurrent ? 'bg-indigo-50/20 dark:bg-indigo-950/10' : ''}`}>
                                        <div className="flex flex-col items-center">
                                            <div className="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0" style={{ borderColor: t.color, backgroundColor: reached ? t.color : 'transparent' }}>
                                                {reached && <span className="text-[10px] text-white">✓</span>}
                                            </div>
                                            <div className="w-[1px] h-full bg-nature-200 dark:bg-nature-800 last:hidden" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-center">
                                                <span className={`font-black text-sm flex items-center gap-1.5 ${reached ? 'text-nature-950 dark:text-white' : 'text-nature-400 dark:text-nature-500'}`}>
                                                    <span>{t.emoji}</span>
                                                    <span>{t.name}</span>
                                                    {isCurrent && <span className="text-[9px] font-bold text-indigo-500 uppercase tracking-wider">current</span>}
                                                </span>
                                                {!reached && creditsNeeded > 0 && (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded border border-indigo-150 text-indigo-600 dark:text-indigo-400">{creditsNeeded} pts to go</span>
                                                )}
                                            </div>
                                            <p className="text-[11px] text-nature-400 dark:text-nature-500 mt-1">
                                                {t.min === 0 ? 'Starting tier' : `Reach ${t.min} trust from the value you trade`}
                                            </p>
                                            <div className="mt-2 space-y-1">
                                                <div className="flex items-center gap-1.5 text-[10px] text-nature-500">
                                                    <span>⚖️</span>
                                                    <span>Credit floor → {t.floor}B</span>
                                                </div>
                                                <div className="pt-1.5">
                                                    {t.perks.map(p => (
                                                        <div key={p} className="flex items-center gap-1 text-[10px] text-nature-500 dark:text-nature-400">
                                                            <span className={reached ? 'text-emerald-500' : 'text-nature-300'}>{reached ? '✓' : '•'}</span>
                                                            <span>{p}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    <span className="text-[10px] font-medium text-nature-400 dark:text-nature-500 text-center italic block">
                        💡 Trust is a saturating curve over the real value you trade — diverse trades climb fastest, and it levels off near the top so no one runs away. Gifts don't build trust.
                    </span>
                </div>
            ) : (
                <div className="flex flex-col gap-4 mt-4 animate-in fade-in duration-300">
                    {/* Financials overview details */}
                    <div className="flex gap-4">
                        <div className="flex-1 bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 text-center shadow-sm">
                            <p className="text-nature-500 dark:text-nature-400 text-sm font-semibold mb-2">Overdraft Floor</p>
                            <p className="text-2xl font-black font-mono text-nature-950 dark:text-white flex items-center justify-center gap-1">
                                {floor}
                                <img src="/assets/bean.png" className="w-[18px] h-[18px]" alt="B" />
                            </p>
                            <p className="text-nature-400 text-[10px] mt-1 font-semibold">
                                ≈ {hoursEquivalent.toFixed(1)} hrs capacity
                            </p>
                        </div>

                        <button
                            onClick={() => setShowCommonsInfo(true)}
                            className="flex-1 bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 text-center shadow-sm hover:bg-nature-50 dark:hover:bg-nature-850 hover:border-nature-300 dark:hover:border-nature-700 transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                        >
                            <p className="text-nature-500 dark:text-nature-400 text-sm font-semibold mb-2 flex items-center justify-center gap-1">
                                Commons Pool <span className="text-xs text-nature-400">ⓘ</span>
                            </p>
                            <p className="text-2xl font-black font-mono text-amber-500 flex items-center justify-center gap-1">
                                {(balanceInfo?.commonsBalance ?? 0).toFixed(1)}
                                <img src="/assets/bean.png" className="w-[18px] h-[18px]" alt="B" />
                            </p>
                            <p className="text-nature-450 dark:text-nature-450 text-[10px] mt-1 font-semibold">
                                🌱 View Solvency & Tax
                            </p>
                        </button>
                    </div>

                    {/* Send credits */}
                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm">
                        {!canSend && (
                            <div className="bg-nature-50 dark:bg-nature-850/50 border border-nature-200 dark:border-nature-800 rounded-xl p-3 mb-4 text-center">
                                <p className="text-xs text-nature-500 dark:text-nature-400 font-medium">
                                    🔒 Sending credits unlocks after your <strong>first completed trade</strong>. Trade on the Marketplace to get started.
                                </p>
                            </div>
                        )}
                        <button
                            onClick={() => canSend && setShowSend(!showSend)}
                            disabled={!canSend}
                            className={`w-full p-4 rounded-xl text-[15px] font-bold border-none cursor-pointer transition-all shadow-md ${
                                !canSend ? 'bg-nature-100 dark:bg-nature-800 text-nature-450 cursor-not-allowed opacity-60' :
                                showSend ? 'bg-nature-800 text-white hover:bg-nature-900' : 'bg-[#d97757] text-white hover:bg-[#c26749]'
                            }`}
                        >
                            {!canSend ? '🔒 Send Credits (after 1st trade)' : showSend ? '✕ Cancel' : '💸 Send Credits'}
                        </button>

                        {/* Send Form */}
                        {showSend && (
                            <div className="animate-in fade-in slide-in-from-top-2 bg-nature-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 mt-4 shadow-inner">
                                <div className="relative mb-3">
                                    <button
                                        onClick={() => setShowMemberPicker(!showMemberPicker)}
                                        className="w-full p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-950 text-nature-900 dark:text-white text-[15px] font-medium text-left flex justify-between items-center shadow-sm cursor-pointer"
                                    >
                                        <span>{selectedMember?.callsign || 'Select recipient...'}</span>
                                        <span className="text-nature-400 text-xs">▼</span>
                                    </button>

                                    {showMemberPicker && (
                                        <div className="absolute left-0 right-0 mt-1 bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-850 rounded-xl shadow-xl z-20 max-h-56 overflow-y-auto">
                                            <input
                                                type="text"
                                                placeholder="Search members..."
                                                value={memberSearch}
                                                onChange={(e) => setMemberSearch(e.target.value)}
                                                className="w-full p-3 border-b border-nature-100 dark:border-nature-850 bg-transparent text-sm focus:outline-none text-nature-900 dark:text-white"
                                            />
                                            {filteredMembers.length === 0 ? (
                                                <div className="p-4 text-xs text-nature-400 text-center">No members found</div>
                                            ) : (
                                                filteredMembers.map(m => (
                                                    <button
                                                        key={m.publicKey}
                                                        onClick={() => { setSendTo(m.publicKey); setShowMemberPicker(false); setMemberSearch(''); }}
                                                        className={`w-full p-3 text-left text-sm hover:bg-nature-50 dark:hover:bg-nature-900 flex justify-between items-center cursor-pointer border-none bg-transparent ${sendTo === m.publicKey ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-600' : 'text-nature-900 dark:text-white'}`}
                                                    >
                                                        <span className="font-bold">{m.callsign}</span>
                                                        <span className="text-[10px] font-mono opacity-50">{m.publicKey.slice(0, 10)}...</span>
                                                    </button>
                                                ))
                                            )}
                                        </div>
                                    )}
                                </div>

                                <input
                                    type="number"
                                    placeholder="Amount (B)"
                                    value={sendAmount}
                                    onChange={(e) => setSendAmount(e.target.value)}
                                    min="0.01"
                                    step="0.01"
                                    className="w-full p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-950 text-nature-900 dark:text-white text-[15px] font-medium mb-3 focus:ring-2 focus:ring-[#d97757] outline-none shadow-sm transition-all"
                                />
                                <input
                                    type="text"
                                    placeholder="Memo (optional)"
                                    value={sendMemo}
                                    onChange={(e) => setSendMemo(e.target.value)}
                                    className="w-full p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-950 text-nature-900 dark:text-white text-[15px] font-medium mb-4 focus:ring-2 focus:ring-[#d97757] outline-none shadow-sm transition-all"
                                />
                                {(() => {
                                    const parsedAmount = parseFloat(sendAmount);
                                    if (!isNaN(parsedAmount) && parsedAmount > 0) {
                                        // Peer transfers are fee-free — recipient receives the full amount.
                                        return (
                                            <div className="bg-nature-100 dark:bg-nature-850 rounded-xl p-3 mb-4 text-xs space-y-1.5 border border-nature-200 dark:border-nature-800">
                                                <div className="flex justify-between items-center text-nature-750 dark:text-nature-300">
                                                    <span>Recipient receives:</span>
                                                    <span className="font-mono font-bold text-nature-950 dark:text-white">{parsedAmount.toFixed(2)} B</span>
                                                </div>
                                            </div>
                                        );
                                    }
                                    return null;
                                })()}
                                <button
                                    onClick={handleSend}
                                    disabled={sending || !sendTo || !sendAmount}
                                    className={`w-full p-3.5 rounded-xl text-[15px] font-bold border-none transition-all shadow-md ${
                                        sending || !sendTo || !sendAmount
                                            ? 'bg-nature-300 dark:bg-nature-800 text-nature-500 cursor-not-allowed'
                                            : 'bg-emerald-500 text-white cursor-pointer hover:bg-emerald-600'
                                    }`}
                                >
                                    {sending ? 'Sending...' : 'Confirm Transfer'}
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Community Circulation info */}
                    {balance > 0 && (() => {
                        const brackets = [
                            { maxInBracket: 200, rate: 0.000 },
                            { maxInBracket: 300, rate: 0.010 },
                            { maxInBracket: 500, rate: 0.015 },
                            { maxInBracket: 1000, rate: 0.020 },
                            { maxInBracket: Infinity, rate: 0.025 }
                        ];
                        let remaining = balance;
                        let totalCirculation = 0;
                        for (const b of brackets) {
                            if (remaining <= 0) break;
                            const amountInBracket = Math.min(remaining, b.maxInBracket);
                            totalCirculation += amountInBracket * b.rate;
                            remaining -= amountInBracket;
                        }
                        const effectiveRate = ((totalCirculation / balance) * 100).toFixed(2);
                        const showAmber = balance > 1000;

                        return (
                            <div className="rounded-xl p-4 shadow-sm border" style={{ background: showAmber ? 'linear-gradient(135deg, #fef3c7, #fde68a)' : '#ecfdf5', borderColor: showAmber ? '#fbbf24' : '#a7f3d0' }}>
                                <div className="flex justify-between items-center">
                                    <span className="text-[13px] font-bold" style={{ color: showAmber ? '#92400e' : '#065f46' }}>
                                        🌿 Community Circulation
                                    </span>
                                    <span className="text-[13px] font-bold font-mono flex items-center" style={{ color: showAmber ? '#92400e' : '#047857' }}>
                                        −{totalCirculation.toFixed(3)}
                                        <img src="/assets/bean.png" className="w-[14px] h-[14px] mx-0.5" alt="B" />
                                        /mo → Commons
                                    </span>
                                </div>
                                <p className="text-[11px] mt-2 font-medium" style={{ color: showAmber ? '#92400e' : '#059669' }}>
                                    ≈ {effectiveRate}% /mo effective • Funds community projects
                                </p>
                            </div>
                        );
                    })()}

                    {/* Transaction history */}
                    <div className="flex justify-between items-center mb-1 px-1">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white">Recent Transactions</h3>
                        <button
                            onClick={async () => {
                                try {
                                    const res = await fetch('/api/ledger/export');
                                    const data = await res.json();
                                    
                                    const balBlob = new Blob([data.balancesCsv], { type: 'text/csv' });
                                    const balUrl = window.URL.createObjectURL(balBlob);
                                    const balA = document.createElement('a');
                                    balA.href = balUrl;
                                    balA.download = 'beanpool_balances.csv';
                                    balA.click();
                                    window.URL.revokeObjectURL(balUrl);
                                    
                                    setTimeout(() => {
                                        const txBlob = new Blob([data.transactionsCsv], { type: 'text/csv' });
                                        const txUrl = window.URL.createObjectURL(txBlob);
                                        const txA = document.createElement('a');
                                        txA.href = txUrl;
                                        txA.download = 'beanpool_transactions.csv';
                                        txA.click();
                                        window.URL.revokeObjectURL(txUrl);
                                    }, 500);
                                } catch (e) {
                                    console.error('Export failed', e);
                                    alert('Export failed');
                                }
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 rounded-lg text-[11px] font-bold hover:bg-nature-200 transition-colors border border-nature-200 dark:border-nature-750 shadow-sm cursor-pointer"
                        >
                            ⬇️ Node Audit
                        </button>
                    </div>

                    {txns.length === 0 ? (
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-8 text-center text-nature-500 dark:text-nature-400 text-[14px] shadow-sm font-medium">
                            No transactions yet. Start trading on the Marketplace!
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2.5">
                            {txns.map(tx => {
                                const isSent = tx.from === identity.publicKey;
                                return (
                                    <div key={tx.id} className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-xl p-4 flex justify-between items-center shadow-sm transition-transform hover:-translate-y-0.5">
                                        <div>
                                            <p className={`text-[14px] font-bold ${isSent ? 'text-nature-900 dark:text-white' : 'text-emerald-700 dark:text-emerald-400'}`}>
                                                {isSent ? '↑ Sent' : '↓ Received'}
                                            </p>
                                            {tx.memo && (
                                                <p className="text-[13px] text-nature-550 dark:text-nature-400 mt-1 leading-snug">
                                                    {renderMemoText(tx.memo)}
                                                </p>
                                            )}
                                            <p className="text-[11px] font-bold text-nature-400 mt-1.5 uppercase tracking-wide">
                                                {new Date(tx.timestamp).toLocaleString()}
                                            </p>
                                        </div>
                                        <p style={{ whiteSpace: 'nowrap' }} className={`text-lg font-bold font-mono ${isSent ? 'text-red-500' : 'text-emerald-500'} flex items-center`}>
                                            {isSent ? '−' : '+'}{tx.amount.toFixed(1)}
                                            <img src="/assets/bean.png" className="w-4 h-4 ml-1" alt="B" />
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {error && (
                <div className="animate-in fade-in bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-xl p-3 mt-4 text-red-650 dark:text-red-400 text-sm text-center font-bold shadow-sm">
                    {error}
                </div>
            )}

            <CommonsInfoModal 
                isOpen={showCommonsInfo} 
                onClose={() => setShowCommonsInfo(false)} 
                commonsBalance={balanceInfo?.commonsBalance ?? 0} 
            />
        </div>
    );
}
