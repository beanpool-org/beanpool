/**
 * CreditBar (PWA) — zero-centred "sweet spot" indicator.
 *
 * Direct port of the native CreditBar. Same anchored (non-linear) scale:
 * zero pinned at 50%, ±200 comfort band owns the centre, deep floors and
 * big balances compress into the tails. Four strict non-overlapping lanes
 * (tag → track → anchors → hint) so nothing ever collides.
 *
 * Uses CSS linear-gradient instead of expo-linear-gradient.
 */

const RED = '#bb4b32';
const WARM_BG = '#e9a23e';
const WARM = '#c07d2a';
const BEAN = '#2f9e44';
const BEAN_DEEP = '#1c6e30';

function marginalRate(b: number): number {
    if (b <= 200) return 0;
    if (b <= 500) return 1;
    if (b <= 1000) return 1.5;
    if (b <= 2000) return 2;
    return 2.5;
}

function toPct(v: number, floor: number): number {
    const F = Math.min(floor, 0);
    let pct: number;
    if (v >= 0) {
        const pos: [number, number][] = [[0, 50], [200, 68], [500, 80], [1000, 90], [2000, 98]];
        pct = 99;
        for (let i = 0; i < pos.length - 1; i++) {
            const [v0, p0] = pos[i], [v1, p1] = pos[i + 1];
            if (v <= v1) { pct = p0 + (v - v0) / (v1 - v0) * (p1 - p0); break; }
        }
    } else if (F === 0) {
        pct = 50;
    } else if (F >= -200) {
        pct = 6 + (v - F) / (0 - F) * (50 - 6);
    } else if (v <= -200) {
        pct = 6 + (v - F) / (-200 - F) * (34 - 6);
    } else {
        pct = 34 + (v + 200) / 200 * (50 - 34);
    }
    return Math.max(3, Math.min(98, pct));
}

const fmt = (n: number) => `${n >= 0 ? '+' : ''}${Number.isInteger(n) ? n : n.toFixed(1)}`;

interface Props {
    balance: number;
    floor: number;
    feeFreeMax?: number;
    className?: string;
}

export function CreditBar({ balance, floor, feeFreeMax = 200, className = '' }: Props) {
    const pct = toPct(balance, floor);
    const overFeeFree = balance > feeFreeMax;
    const nearLimit = floor < 0 && balance - floor < Math.abs(floor) * 0.12;
    const rate = marginalRate(balance);
    const tagBg = nearLimit ? RED : overFeeFree ? WARM_BG : '#16211b';
    const tagLabel = overFeeFree ? `${fmt(balance)} B · ≈${rate}%/mo` : `${fmt(balance)} B`;

    // Fee ladder — the monthly circulation-fee brackets above the fee-free ceiling. Opens up as the
    // balance climbs past halfway: revealT ramps 0→1 between feeFreeMax/2 and the ceiling, then
    // stays 1. Positions mirror the anchored scale (500→80%, 1000→90%, 2000→98%).
    const revealT = Math.max(0, Math.min(1, (balance - feeFreeMax / 2) / (feeFreeMax / 2)));
    const showFees = revealT > 0;
    const FEE_ZONES = [
        { label: '1%', mid: 74, lo: 200, hi: 500 },
        { label: '1.5%', mid: 85, lo: 500, hi: 1000 },
        { label: '2%', mid: 94, lo: 1000, hi: 2000 },
    ];
    const FEE_TICKS = [80, 90, 98]; // 500 / 1000 / 2000 boundaries

    return (
        <div className={`select-none ${className}`} style={{ paddingTop: 28, position: 'relative' }}>

            {/* Lane 1 — your position tag (sits above the track) */}
            <div
                style={{
                    position: 'absolute',
                    top: 0,
                    left: `${pct}%`,
                    transform: 'translateX(-50%)',
                    backgroundColor: tagBg,
                    color: '#fff',
                    padding: '3px 8px',
                    borderRadius: 7,
                    fontSize: 12,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                    zIndex: 2,
                }}
            >
                {tagLabel}
                {/* pointer */}
                <span style={{
                    position: 'absolute',
                    left: '50%',
                    bottom: -4,
                    transform: 'translateX(-50%)',
                    width: 0,
                    height: 0,
                    borderLeft: '4px solid transparent',
                    borderRight: '4px solid transparent',
                    borderTop: `5px solid ${tagBg}`,
                }} />
            </div>

            {/* Lane 2 — gradient track */}
            <div style={{
                height: 15,
                borderRadius: 9,
                position: 'relative',
                overflow: 'visible',
                background: `linear-gradient(90deg, ${RED} 4%, #cf6a3f 17%, #e0a35a 29%, #7ccb90 40%, ${BEAN} 50%, #7ccb90 60%, #e0a35a 74%, ${WARM} 96%)`,
            }}>
                {/* zero line */}
                <div style={{
                    position: 'absolute',
                    left: '50%',
                    top: -3,
                    bottom: -3,
                    width: 2,
                    marginLeft: -1,
                    backgroundColor: '#fff',
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.18)',
                }} />
                {/* bead */}
                <div style={{
                    position: 'absolute',
                    left: `${pct}%`,
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    backgroundColor: '#fff',
                    border: '4px solid #16211b',
                    boxShadow: '0 2px 5px rgba(0,0,0,0.28)',
                    zIndex: 2,
                }} />
                {/* fee-bracket ticks (500 / 1000 / 2000) */}
                {showFees && FEE_TICKS.map((t) => (
                    <div key={t} style={{ position: 'absolute', left: `${t}%`, top: -2, bottom: -2, width: 1, marginLeft: -0.5, backgroundColor: '#fff', opacity: 0.5 * revealT }} />
                ))}
            </div>

            {/* Fee ladder — circulation-fee brackets above +feeFreeMax, revealed as you climb */}
            {showFees && (
                <div style={{ position: 'relative', height: 12, marginTop: 4, opacity: revealT }}>
                    <span style={{ position: 'absolute', left: 0, top: 1, fontSize: 8, color: '#929c90', textTransform: 'uppercase', letterSpacing: '0.4px' }}>fee/mo</span>
                    {FEE_ZONES.map((z) => {
                        const active = balance > z.lo && balance <= z.hi;
                        return (
                            <span key={z.label} style={{ position: 'absolute', left: `${z.mid}%`, top: 0, transform: 'translateX(-50%)', fontSize: 9, fontVariantNumeric: 'tabular-nums', color: active ? WARM : '#929c90', fontWeight: active ? 800 : 600 }}>{z.label}</span>
                        );
                    })}
                </div>
            )}

            {/* Lane 3 — anchors (space-between, can't collide) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: RED, fontVariantNumeric: 'tabular-nums' }}>{floor}</div>
                    <div style={{ fontSize: 9, color: '#929c90', textTransform: 'uppercase', letterSpacing: '0.4px', marginTop: 1 }}>your limit</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: BEAN_DEEP }}>⚖️ 0</div>
                    <div style={{ fontSize: 9, color: BEAN_DEEP, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.4px', marginTop: 1 }}>sweet spot</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: WARM }}>+{feeFreeMax}</div>
                    <div style={{ fontSize: 9, color: '#929c90', textTransform: 'uppercase', letterSpacing: '0.4px', marginTop: 1 }}>fee-free</div>
                </div>
            </div>

            {/* Lane 4 — directional hint */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                <span style={{ fontSize: 10, color: '#929c90' }}>← carry credit</span>
                <span style={{ fontSize: 10, color: '#929c90' }}>hold credit →</span>
            </div>
        </div>
    );
}
