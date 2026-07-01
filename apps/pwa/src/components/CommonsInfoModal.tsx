import { useState } from 'react';

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

const FLOW_STEPS = [
    { icon: '🤝', label: 'My Trade', desc: 'Credits transacted through community exchange' },
    { icon: '٪', label: 'Transaction Fee', desc: 'Flat 1.5% fee on completed marketplace trades (direct member transfers are free)' },
    { icon: '🌿', label: 'Circulation Fee', desc: 'Progressive monthly contribution from positive balances' },
    { icon: '🏛️', label: 'Commons Pool', desc: 'Community fund growing from all community and circulation fee contributions' },
    { icon: '🗳️', label: 'My Vote', desc: 'Quadratic Voting: N votes costs N² credits' },
    { icon: '🚀', label: 'Community Project', desc: 'Winning projects funded from the Commons Pool' },
];

interface Props {
    isOpen: boolean;
    onClose: () => void;
    commonsBalance?: number;
}

export function CommonsInfoModal({ isOpen, onClose, commonsBalance }: Props) {
    const [activeTab, setActiveTab] = useState<'brackets' | 'flow' | 'qv'>('flow');

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center" onClick={onClose}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
                className="relative bg-nature-100 dark:bg-[#0d0d0d] rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85vh] overflow-y-auto animate-in slide-in-from-bottom-4 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 bg-nature-100/90 dark:bg-[#0d0d0d]/90 backdrop-blur-md p-4 border-b border-nature-200 dark:border-nature-800 flex items-center justify-between z-10">
                    <div className="flex items-center gap-2">
                        <span className="text-xl">🏛️</span>
                        <h2 className="font-bold text-nature-900 dark:text-white text-lg">Community Commons</h2>
                    </div>
                    <button onClick={onClose} className="text-nature-500 hover:text-nature-900 dark:hover:text-white bg-transparent border-none cursor-pointer text-lg font-bold p-1" aria-label="Close information modal">✕</button>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 p-3 pb-0">
                    {[
                        { id: 'flow' as const, label: '🌊 How It Works' },
                        { id: 'brackets' as const, label: '📊 Circulation Fees' },
                        { id: 'qv' as const, label: '🗳️ Voting' },
                    ].map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            style={{
                                flex: 1,
                                padding: '8px 4px',
                                borderRadius: 8,
                                border: 'none',
                                cursor: 'pointer',
                                fontWeight: activeTab === tab.id ? 800 : 600,
                                fontSize: 12,
                                background: activeTab === tab.id ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                                color: activeTab === tab.id ? '#10b981' : '#9ca3af',
                                transition: 'all 0.2s',
                            }}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="p-4">
                    {activeTab === 'flow' && (
                        <div>
                            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16, lineHeight: 1.5 }}>
                                The Community Commons is a self-sustaining fund that redistributes value back to the community through democratically-voted projects.
                                <span style={{ display: 'block', marginTop: 10, color: '#10b981', fontWeight: 600 }}>
                                    🌱 100% Community-Owned: All collected fees remain inside the pool for local grants and solvency—never taken for private profit.
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
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: 1 }}>Current Commons Balance</div>
                                    <div style={{ fontSize: 28, fontWeight: 900, color: '#fff', marginTop: 4 }}>{commonsBalance.toFixed(2)} 🫘</div>
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
                                            <span style={{ fontSize: 24 }}>{step.icon}</span>
                                            <div>
                                                <div style={{ fontWeight: 800, fontSize: 14, color: '#fff' }}>{step.label}</div>
                                                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{step.desc}</div>
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
                                <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>Solvency & Account Pruning</div>
                                <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12, lineHeight: 1.5 }}>
                                    As a zero-sum mutual credit network, pruning inactive accounts requires balancing the ledger:
                                </p>
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                                    <span style={{ fontSize: 18, marginTop: 1 }}>🛡️</span>
                                    <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.4 }}>
                                        <strong style={{ color: '#fff' }}>Bad Debt Payouts:</strong> If an inactive account is pruned with a negative balance, the Commons Pool pays off their outstanding debt to maintain zero-sum equilibrium.
                                    </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                                    <span style={{ fontSize: 18, marginTop: 1 }}>✅</span>
                                    <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.4 }}>
                                        <strong style={{ color: '#fff' }}>Surplus Reclaims:</strong> If an inactive account is pruned with a positive balance, the community reclaims the surplus, transferring it into the Commons Pool to recycle the dormant value.
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'brackets' && (
                        <div>
                            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16, lineHeight: 1.5 }}>
                                Circulation Fee is a <strong style={{ color: '#fff' }}>progressive monthly contribution</strong> from positive balances.
                                Like progressive fee brackets, only the portion of your balance within each tier is charged at that tier's rate.
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
                                                <span style={{ fontSize: 14, fontWeight: 900, color: b.color }}>{b.rate}%</span>
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
                                <div style={{ fontSize: 11, fontWeight: 800, color: '#60a5fa', textTransform: 'uppercase', marginBottom: 4 }}>Example</div>
                                <div style={{ fontSize: 13, color: '#d1d5db', lineHeight: 1.5 }}>
                                    A balance of <strong style={{ color: '#fff' }}>600 🫘</strong> pays:<br />
                                    200 × 0% = 0.0 + 300 × 1.0% = 3.0 + 100 × 1.5% = 1.5 = <strong style={{ color: '#10b981' }}>4.5 🫘/month</strong>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'qv' && (
                        <div>
                            <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16, lineHeight: 1.5 }}>
                                <strong style={{ color: '#fff' }}>Quadratic Voting</strong> ensures fair allocation — many small voices outweigh a few large ones.
                            </p>

                            <div style={{
                                background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.1), rgba(59, 130, 246, 0.1))',
                                borderRadius: 12,
                                padding: 16,
                                border: '1px solid rgba(139, 92, 246, 0.2)',
                                marginBottom: 16,
                            }}>
                                <div style={{ fontSize: 11, fontWeight: 800, color: '#a78bfa', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>Formula</div>
                                <div style={{ fontSize: 22, fontWeight: 900, color: '#fff', textAlign: 'center', fontFamily: 'monospace' }}>
                                    Cost = Votes²
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
                                        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{n} vote{n > 1 ? 's' : ''}</span>
                                        <span style={{ fontSize: 14, fontWeight: 900, color: '#a78bfa' }}>{n * n} credits</span>
                                    </div>
                                ))}
                            </div>

                            <div style={{ marginTop: 16 }}>
                                <div style={{ fontSize: 11, fontWeight: 800, color: '#10b981', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>How Credits Are Earned</div>
                                <p style={{ fontSize: 13, color: '#d1d5db', lineHeight: 1.5 }}>
                                    Your governance credits are earned through <strong style={{ color: '#fff' }}>community participation</strong> — the total beans you've transacted (energy cycled).
                                    The more you trade and contribute, the more voice you earn in shaping community projects.
                                </p>
                            </div>

                            <div style={{
                                marginTop: 12,
                                padding: 12,
                                background: 'rgba(245, 158, 11, 0.1)',
                                borderRadius: 10,
                                border: '1px solid rgba(245, 158, 11, 0.2)',
                            }}>
                                <div style={{ fontSize: 11, fontWeight: 800, color: '#fbbf24', textTransform: 'uppercase', marginBottom: 4 }}>Process</div>
                                <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.5 }}>
                                    1. Members propose projects<br />
                                    2. Admin opens a voting round<br />
                                    3. Members allocate votes with QV credits<br />
                                    4. Round closes → winning project receives Commons funds<br />
                                    <em style={{ color: '#9ca3af' }}>Fund release is admin-triggered to ensure ledger integrity.</em>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
