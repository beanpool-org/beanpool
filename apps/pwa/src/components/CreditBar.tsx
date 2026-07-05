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
const MARK = '#38bdf8';
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

// Offer-covenant bands - a faithful copy of @beanpool/core's OFFER_BANDS, where the array INDEX is
// the live-offer count (index 0 = 0 offers → 0 unlocked, index 3 = 3 offers → -1000).
// Kept local rather than imported because core's barrel pulls Node/libp2p modules that don't belong
// in the web bundle (the PWA mirrors core constants throughout). Keep in sync with core if the bands change.
const OFFER_BANDS = [0, 200, 500, 1000, 1500, 2000];

interface Props {
    balance: number;
    floor: number;                 // earned credit LIMIT (deepest the floor could ever reach)
    usableFloor?: number;          // v3: how deep offers currently unlock (≥ floor, ≤ 0). Omit → no ladder.
    liveOffers?: number;           // v3: current live-offer count (for the ladder caption)
    feeFreeMax?: number;
    className?: string;
}

export function CreditBar({ balance, floor, usableFloor, liveOffers = 0, feeFreeMax = 200, className = '' }: Props) {
    const pct = toPct(balance, floor);
    const overFeeFree = balance > feeFreeMax;
    const nearLimit = floor < 0 && balance - floor < Math.abs(floor) * 0.12;
    const rate = marginalRate(balance);
    const tagBg = nearLimit ? RED : overFeeFree ? WARM_BG : '#16211b';
    const tagLabel = overFeeFree ? `${fmt(balance)} B · ≈${rate}%/mo` : `${fmt(balance)} B`;

    // Offer ladder — the negative side mirrors the fee ladder above zero. `usableFloor` is the depth
    // your live Offers currently unlock; anything deeper (usableFloor → floor) is LOCKED until you
    // post more Offers. Only drawn when usableFloor is provided and the member has an earned line.
    const uFloor = usableFloor ?? floor;
    const showLadder = usableFloor !== undefined && floor < 0;
    const hasLocked = showLadder && uFloor > floor;          // some earned depth is offer-locked
    const usablePct = toPct(uFloor, floor);                   // right edge of the unlocked (reachable) zone
    const floorPct = toPct(floor, floor);                     // left edge (earned limit)
    // Band rungs that fall within the earned limit (skip the outermost = the limit itself, and 0).
    const rungs = showLadder ? OFFER_BANDS.filter(b => b > 0 && b < Math.abs(floor)).map(b => ({ b, pct: toPct(-b, floor) })) : [];
    // Next unlock = the next band above what you've unlocked, capped at your earned limit
    // (a 4th offer on a −1400 limit unlocks −1400, not −1500).
    const nextBand = OFFER_BANDS.find(b => b > Math.abs(uFloor));
    const nextUnlock = hasLocked && nextBand ? Math.min(nextBand, Math.abs(floor)) : undefined;
    // Total live Offers needed to unlock the FULL earned floor (band index, capped at 5).
    const fullIdx = OFFER_BANDS.findIndex(b => b >= Math.abs(floor));
    const offersForFull = fullIdx === -1 ? OFFER_BANDS.length - 1 : fullIdx;

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
                {/* Offer-locked zone: earned depth your live Offers haven't unlocked yet (hatched) */}
                {hasLocked && (
                    <div style={{
                        position: 'absolute',
                        left: `${floorPct}%`,
                        width: `${usablePct - floorPct}%`,
                        top: 0, bottom: 0,
                        background: 'repeating-linear-gradient(45deg, rgba(15,23,42,0.55) 0 5px, rgba(15,23,42,0.30) 5px 10px)',
                    }} />
                )}
                {/* Offer-band rungs (the "ladder") */}
                {rungs.map((r) => (
                    <div key={r.b} style={{ position: 'absolute', left: `${r.pct}%`, top: -2, bottom: -2, width: 1, marginLeft: -0.5, backgroundColor: '#fff', opacity: 0.4 }} />
                ))}
                {/* Current usable-floor marker — how deep you can actually spend right now */}
                {hasLocked && uFloor < 0 && (
                    <div style={{ position: 'absolute', left: `${usablePct}%`, top: -10, bottom: -2, width: 4, marginLeft: -2, backgroundColor: MARK, boxShadow: '0 0 0 2px rgba(255,255,255,0.8), 0 0 8px 1px rgba(56,189,248,0.55)', zIndex: 1 }} />
                )}
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

            {/* Offer ladder caption — what your live Offers unlock, and how many reach your full line */}
            {showLadder && hasLocked && (
                <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.4, color: '#64748b', fontWeight: 500, display: 'flex', alignItems: 'baseline', gap: 4 }}>
                    <span>🎣</span>
                    {uFloor < 0 ? (
                        <span><b style={{ color: WARM }}>{liveOffers} offer{liveOffers === 1 ? '' : 's'}</b> {liveOffers === 1 ? 'unlocks' : 'unlock'} −{Math.abs(uFloor)}{nextUnlock ? <> · <b style={{ color: WARM }}>{liveOffers + 1} offer{liveOffers + 1 === 1 ? '' : 's'}</b> → −{nextUnlock}</> : ''}</span>
                    ) : (
                        <span><b style={{ color: WARM }}>Post an Offer</b> to open your credit line — <b style={{ color: WARM }}>{offersForFull}</b> offer{offersForFull === 1 ? '' : 's'} {offersForFull === 1 ? 'unlocks' : 'unlock'} your full −{Math.abs(floor)}.</span>
                    )}
                </div>
            )}

            {/* Fee ladder — circulation-fee brackets above +feeFreeMax, revealed as you climb */}
            {showFees && (
                <div style={{ position: 'relative', height: 12, marginTop: 4, opacity: revealT }}>
                    <span style={{ position: 'absolute', left: 0, top: 1, fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>fee/mo</span>
                    {FEE_ZONES.map((z) => {
                        const active = balance > z.lo && balance <= z.hi;
                        return (
                            <span key={z.label} style={{ position: 'absolute', left: `${z.mid}%`, top: 0, transform: 'translateX(-50%)', fontSize: 9, fontVariantNumeric: 'tabular-nums', color: active ? WARM : 'var(--text-muted)', fontWeight: active ? 800 : 600 }}>{z.label}</span>
                        );
                    })}
                </div>
            )}

            {/* Lane 3 — anchors (space-between, can't collide) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: RED, fontVariantNumeric: 'tabular-nums' }}>{floor}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginTop: 1 }}>your limit</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: BEAN_DEEP }}>⚖️ 0</div>
                    <div style={{ fontSize: 9, color: BEAN_DEEP, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.4px', marginTop: 1 }}>sweet spot</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: WARM }}>+{feeFreeMax}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginTop: 1 }}>fee-free</div>
                </div>
            </div>

            {/* Lane 4 — directional hint */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>← carry credit</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>hold credit →</span>
            </div>
        </div>
    );
}
