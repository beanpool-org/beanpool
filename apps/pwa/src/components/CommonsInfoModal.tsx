import { useState, useEffect } from 'react';
import { formatNumber, t, tn, word } from '@beanpool/core';
import { Sentence } from './Sentence';

/**
 * CommonsInfoModal — Explains the Community Commons fund mechanics:
 * progressive demurrage brackets, QV redistribution, and the project funding flow.
 */

const BRACKETS = [
    { min: 0, max: 200, rate: 0.0, color: '#22c55e' },
    { min: 200, max: 500, rate: 1.0, color: '#84cc16' },
    { min: 500, max: 1000, rate: 1.5, color: '#eab308' },
    { min: 1000, max: 2000, rate: 2.0, color: '#f97316' },
    { min: 2000, max: Infinity, rate: 2.5, color: '#ef4444' },
];

// word() keys (the phone's), put through t() where they are shown.
const FLOW_STEPS = [
    { icon: '🤝', label: word('My Trade'), desc: word('Credits transacted through community exchange') },
    { icon: '٪', label: word('Transaction Fee'), desc: word('Flat 1.5% fee on completed marketplace trades (direct member transfers are free)') },
    { icon: '🌿', label: word('Circulation Fee'), desc: word('Progressive monthly contribution from positive balances') },
    { icon: '🏛️', label: word('Commons Pool'), desc: word('Community fund growing from all community and circulation fee contributions') },
    { icon: '🗳️', label: word('Decisions & Polls'), desc: word('Binding Decisions and feed Polls (1m1v for roles/polls; QV for pool grants)') },
    { icon: '🚀', label: word('Enterprises & Grants'), desc: word('Passed initiatives funded automatically from the Commons Pool') },
];

/** The worked example's sums, numbers in the language's way: "200 × 0% = 0.0 + 300 × 1.0% = 3.0 + 100 × 1.5% = 1.5". */
function exampleWorking(): string {
    return ([[200, 0, 0], [300, 1, 3], [100, 1.5, 1.5]] as const)
        .map(([amount, rate, fee]) => `${formatNumber(amount)} × ${formatNumber(rate, rate === 0 ? 0 : 1)}% = ${formatNumber(fee, 1)}`)
        .join(' + ');
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    commonsBalance?: number;
}

export function CommonsInfoModal({ isOpen, onClose, commonsBalance }: Props) {
    const [activeTab, setActiveTab] = useState<'brackets' | 'flow' | 'qv'>('flow');

    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="commons-modal-title"
        >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className="relative bg-nature-100 dark:bg-[#0d0d0d] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85vh] overflow-y-auto animate-in slide-in-from-bottom-4 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 bg-nature-100/90 dark:bg-[#0d0d0d]/90 backdrop-blur-md p-4 border-b border-nature-200 dark:border-nature-800 flex items-center justify-between z-10">
                    <div className="flex items-center gap-2">
                        <span className="text-xl" aria-hidden="true">🏛️</span>
                        <h2 id="commons-modal-title" className="font-bold text-nature-900 dark:text-white text-lg">{t('Community Commons')}</h2>
                    </div>
                    <button type="button" onClick={onClose} className="min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center text-nature-500 hover:text-nature-900 dark:hover:text-white bg-transparent border-none cursor-pointer text-lg font-bold p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-xl transition-colors" aria-label={t('Close information modal')}>✕</button>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 p-3 pb-0" role="tablist" aria-label={t('Commons information tabs')}>
                    {[
                        { id: 'flow' as const, icon: '🌊', label: t('How It Works') },
                        { id: 'brackets' as const, icon: '📊', label: t('Circulation Fees') },
                        { id: 'qv' as const, icon: '🗳️', label: t('Voting') },
                    ].map(tab => (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className="min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-xl"
                            style={{
                                flex: 1,
                                padding: '8px 4px',
                                border: 'none',
                                cursor: 'pointer',
                                fontWeight: activeTab === tab.id ? 800 : 600,
                                fontSize: 12,
                                background: activeTab === tab.id ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                                color: activeTab === tab.id ? '#10b981' : '#9ca3af',
                                transition: 'all 0.2s',
                            }}
                        >
                            {tab.icon} {tab.label}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="p-4">
                    {activeTab === 'flow' && (
                        <div>
                            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16, lineHeight: 1.5 }}>
                                {t('The Community Commons is a self-sustaining fund that redistributes value back to the community through democratically-voted projects.')}
                                <span style={{ display: 'block', marginTop: 10, color: '#10b981', fontWeight: 600 }}>
                                    <span aria-hidden="true">🌱 </span>{t('100% Community-Owned: All collected fees remain inside the pool for local grants and solvency—never taken for private profit.')}
                                </span>
                            </p>

                            {commonsBalance !== undefined && (
                                <div style={{
                                    background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(59, 130, 246, 0.1))',
                                    border: '1px solid rgba(16, 185, 129, 0.2)',
                                    borderRadius: 12,
                                    padding: 16,
                                    marginBottom: 16,
                                    textAlign: 'center',
                                }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: 1 }}>{t('Current Commons Balance')}</div>
                                    <div style={{ fontSize: 28, fontWeight: 900, color: '#fff', marginTop: 4 }}>{formatNumber(commonsBalance, 2)} 🫘</div>
                                </div>
                            )}

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {FLOW_STEPS.map((step, i) => (
                                    <div key={i}>
                                        <div style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 12,
                                            padding: '12px 14px',
                                            background: 'rgba(255,255,255,0.03)',
                                            borderRadius: 10,
                                            border: '1px solid rgba(255,255,255,0.05)',
                                        }}>
                                            <span style={{ fontSize: 24 }} aria-hidden="true">{step.icon}</span>
                                            <div>
                                                <div style={{ fontWeight: 800, fontSize: 14, color: '#fff' }}>{t(step.label)}</div>
                                                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{t(step.desc)}</div>
                                            </div>
                                        </div>
                                        {i < FLOW_STEPS.length - 1 && (
                                            <div style={{ textAlign: 'center', fontSize: 16, color: '#4b5563', margin: '2px 0' }}>↓</div>
                                        )}
                                    </div>
                                ))}
                            </div>

                            <div style={{
                                marginTop: 24,
                                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                                padding: 16,
                                borderRadius: 12,
                                border: '1px solid rgba(255, 255, 255, 0.05)',
                            }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>{t('Solvency & Account Pruning')}</div>
                                <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12, lineHeight: 1.5 }}>
                                    {t('As a zero-sum mutual credit network, pruning inactive accounts requires balancing the ledger:')}
                                </p>
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                                    <span style={{ fontSize: 18, marginTop: 1 }} aria-hidden="true">🛡️</span>
                                    <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.4 }}>
                                        <Sentence
                                            text={t('{label} If an inactive account is pruned with a negative balance, the Commons Pool pays off their outstanding debt to maintain zero-sum equilibrium.')}
                                            parts={{ label: <strong style={{ color: '#fff' }}>{t('Bad Debt Payouts:')}</strong> }}
                                        />
                                    </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                                    <span style={{ fontSize: 18, marginTop: 1 }} aria-hidden="true">✅</span>
                                    <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.4 }}>
                                        <Sentence
                                            text={t('{label} If an inactive account is pruned with a positive balance, the community reclaims the surplus, transferring it into the Commons Pool to recycle the dormant value.')}
                                            parts={{ label: <strong style={{ color: '#fff' }}>{t('Surplus Reclaims:')}</strong> }}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'brackets' && (
                        <div>
                            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16, lineHeight: 1.5 }}>
                                <Sentence
                                    text={t("Circulation Fee is a {contribution} from positive balances. Like progressive fee brackets, only the portion of your balance within each tier is charged at that tier's rate.")}
                                    parts={{ contribution: <strong style={{ color: '#fff' }}>{t('progressive monthly contribution')}</strong> }}
                                />
                            </p>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {BRACKETS.map((b, i) => {
                                    const range = b.max === Infinity ? `${b.min}+` : `${b.min}–${b.max}`;
                                    const width = b.max === Infinity ? 100 : (b.rate / 2.5) * 100;
                                    return (
                                        <div key={i} style={{
                                            background: 'rgba(255,255,255,0.03)',
                                            borderRadius: 10,
                                            padding: '10px 14px',
                                            border: '1px solid rgba(255,255,255,0.05)',
                                        }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                                <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>{range} 🫘</span>
                                                <span style={{ fontSize: 14, fontWeight: 900, color: b.color }}>{t('{rate}%', { rate: b.rate })}</span>
                                            </div>
                                            <div style={{ height: 6, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
                                                <div style={{
                                                    height: '100%',
                                                    width: `${width}%`,
                                                    background: `linear-gradient(90deg, ${b.color}88, ${b.color})`,
                                                    borderRadius: 3,
                                                    transition: 'width 0.5s ease',
                                                }} />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            <div style={{
                                marginTop: 16,
                                padding: 12,
                                background: 'rgba(59, 130, 246, 0.1)',
                                borderRadius: 10,
                                border: '1px solid rgba(59, 130, 246, 0.2)',
                            }}>
                                <div style={{ fontSize: 11, fontWeight: 800, color: '#60a5fa', textTransform: 'uppercase', marginBottom: 4 }}>{t('Example')}</div>
                                <div style={{ fontSize: 13, color: '#d1d5db', lineHeight: 1.5 }}>
                                    <Sentence
                                        text={t('A balance of {amount} {currency} pays:')}
                                        parts={{ amount: <strong style={{ color: '#fff' }}>{formatNumber(600)}</strong>, currency: <strong style={{ color: '#fff' }}>🫘</strong> }}
                                    /><br />
                                    <Sentence
                                        text={t('{working} = {total} {currency}/month', { working: exampleWorking() })}
                                        parts={{ total: <strong style={{ color: '#10b981' }}>{formatNumber(4.5, 1)}</strong>, currency: <strong style={{ color: '#10b981' }}>🫘</strong> }}
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'qv' && (
                        <div>
                            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16, lineHeight: 1.5 }}>
                                <Sentence
                                    text={t('{qv} ensures fair allocation — many small voices outweigh a few large ones.')}
                                    parts={{ qv: <strong style={{ color: '#fff' }}>{t('Quadratic Voting')}</strong> }}
                                />
                            </p>

                            <div style={{
                                background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.1), rgba(59, 130, 246, 0.1))',
                                borderRadius: 12,
                                padding: 16,
                                border: '1px solid rgba(139, 92, 246, 0.2)',
                                marginBottom: 16,
                            }}>
                                <div style={{ fontSize: 11, fontWeight: 800, color: '#a78bfa', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>{t('Formula')}</div>
                                <div style={{ fontSize: 22, fontWeight: 900, color: '#fff', textAlign: 'center', fontFamily: 'monospace' }}>
                                    {t('Cost = Votes²')}
                                </div>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {[1, 2, 3, 5, 10].map(n => (
                                    <div key={n} style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        padding: '8px 12px',
                                        background: 'rgba(255,255,255,0.03)',
                                        borderRadius: 8,
                                        border: '1px solid rgba(255,255,255,0.05)',
                                    }}>
                                        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{tn(n, '{n} vote', '{n} votes')}</span>
                                        {/* English writes one form for both, as it always has. */}
                                        <span style={{ fontSize: 14, fontWeight: 900, color: '#a78bfa' }}>{tn(n * n, '{n} credits', '{n} credits')}</span>
                                    </div>
                                ))}
                            </div>

                            <div style={{ marginTop: 16 }}>
                                <div style={{ fontSize: 11, fontWeight: 800, color: '#10b981', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>{t('How Credits Are Earned')}</div>
                                <p style={{ fontSize: 13, color: '#d1d5db', lineHeight: 1.5 }}>
                                    <Sentence
                                        text={t('Voice credits come from your {trades} — the beans you have traded with other members, counted up to a cap per trading partner. You get the full amount again on every Decision about community money; they are never used up. Voting on community money opens after your first completed trade.')}
                                        parts={{ trades: <strong style={{ color: '#fff' }}>{t('completed trades')}</strong> }}
                                    />
                                    <span> {t('The more you trade and contribute, the more voice you earn in shaping community projects.')}</span>
                                </p>
                            </div>

                            <div style={{
                                marginTop: 12,
                                padding: 12,
                                background: 'rgba(245, 158, 11, 0.1)',
                                borderRadius: 10,
                                border: '1px solid rgba(245, 158, 11, 0.2)',
                            }}>
                                <div style={{ fontSize: 11, fontWeight: 800, color: '#fbbf24', textTransform: 'uppercase', marginBottom: 4 }}>{t('Process')}</div>
                                <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.5 }}>
                                    {/* One step a line, each whole in the member's language. */}
                                    <span className="block">{t('1. Members with a completed trade or earned standing, and node admins, can propose a Decision')}</span>
                                    <span className="block">{t('2. Voting opens at once and runs for 7 days; members who joined before it opened can vote')}</span>
                                    <span className="block">{t('3. Ballots are secret — everyone sees the totals and their own vote')}</span>
                                    <span className="block">{t('4. Votes on community money cost voice credits from your completed trades; other Decisions are one member, one vote')}</span>
                                    <span className="block">{t('5. Voting closes → passed Decisions execute automatically')}</span>
                                    <em style={{ color: '#9ca3af' }}>{t('Fund release is self-executing by the node when quorum and majority are met.')}</em>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
