import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * CreditBar — the zero-centred "sweet spot" indicator.
 *
 * Zero sits at the middle (the goal: give ≈ receive). The ±200 comfort band always owns the
 * centre via an ANCHORED (non-linear) scale, so the deep floors and big balances compress into
 * the tails and zero stays legible for everyone. The left label is the member's real floor; once
 * past the fee-free zone the marker carries the circulation rate. Strict lanes → nothing overlaps.
 */

const RED = '#bb4b32', WARM = '#c07d2a', WARM_BG = '#e9a23e', BEAN = '#2f9e44', BEAN_DEEP = '#1c6e30';

// Offer-covenant bands (mirrors @beanpool/core OFFER_BANDS): live-offer count → unlocked depth.
const OFFER_BANDS = [200, 500, 1000, 1500, 2000];

// Marginal monthly circulation rate at a positive balance (mirrors the demurrage brackets).
function marginalRate(b: number): number {
    if (b <= 200) return 0;
    if (b <= 500) return 1;
    if (b <= 1000) return 1.5;
    if (b <= 2000) return 2;
    return 2.5;
}

// value → percent [0..100] on the anchored scale (zero pinned at 50%).
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
        // shallow floor — linear floor..0 → 6..50
        pct = 6 + (v - F) / (0 - F) * (50 - 6);
    } else if (v <= -200) {
        // deep floor, between floor and −200 → 6..34
        pct = 6 + (v - F) / (-200 - F) * (34 - 6);
    } else {
        // deep floor, between −200 and 0 → 34..50
        pct = 34 + (v + 200) / 200 * (50 - 34);
    }
    return Math.max(3, Math.min(98, pct));
}

const fmt = (n: number) => `${n >= 0 ? '+' : ''}${Number.isInteger(n) ? n : n.toFixed(1)}`;

export function CreditBar({ balance, floor, colors, feeFreeMax = 200, usableFloor, liveOffers = 0 }: {
    balance: number;
    floor: number;
    colors: any;
    feeFreeMax?: number;
    usableFloor?: number;   // v3: how deep offers currently unlock (≥ floor, ≤ 0). Omit → no ladder.
    liveOffers?: number;    // v3: current live-offer count (for the ladder caption)
}) {
    const [tagW, setTagW] = useState(0);
    const pct = toPct(balance, floor);
    const overFeeFree = balance > feeFreeMax;
    const nearLimit = floor < 0 && balance - floor < Math.abs(floor) * 0.12;
    const rate = marginalRate(balance);
    const tagBg = nearLimit ? RED : overFeeFree ? WARM_BG : colors.text.heading;
    const tagLabel = overFeeFree ? `${fmt(balance)} B · ≈${rate}%/mo` : `${fmt(balance)} B`;

    // Offer ladder — the negative side mirrors the fee ladder above zero. usableFloor is the depth
    // your live Offers currently unlock; earned depth beyond it (usableFloor → floor) is LOCKED.
    const uFloor = usableFloor === undefined ? floor : usableFloor;
    const showLadder = usableFloor !== undefined && floor < 0;
    const hasLocked = showLadder && uFloor > floor;
    const usablePct = toPct(uFloor, floor);
    const floorPct = toPct(floor, floor);
    const rungs = showLadder ? OFFER_BANDS.filter(b => b < Math.abs(floor)).map(b => ({ b, pct: toPct(-b, floor) })) : [];
    const nextBand = OFFER_BANDS.find(b => b > Math.abs(uFloor));
    const nextUnlock = hasLocked && nextBand ? Math.min(nextBand, Math.abs(floor)) : undefined;
    const fullIdx = OFFER_BANDS.findIndex(b => b >= Math.abs(floor));
    const offersForFull = fullIdx === -1 ? OFFER_BANDS.length : fullIdx + 1;

    // Fee ladder — the monthly circulation-fee brackets that live ABOVE the fee-free ceiling.
    // It "opens up" as the balance climbs past the halfway mark: revealT ramps 0→1 between
    // feeFreeMax/2 and the ceiling, then stays 1. Positions mirror the anchored scale
    // (500→80%, 1000→90%, 2000→98%); the current bracket is highlighted.
    const revealT = Math.max(0, Math.min(1, (balance - feeFreeMax / 2) / (feeFreeMax / 2)));
    const showFees = revealT > 0;
    const FEE_ZONES = [
        { label: '1%', mid: 74, lo: 200, hi: 500 },
        { label: '1.5%', mid: 85, lo: 500, hi: 1000 },
        { label: '2%', mid: 94, lo: 1000, hi: 2000 },
    ];
    const FEE_TICKS = [80, 90, 98]; // 500 / 1000 / 2000 boundaries

    const s = styles(colors);
    return (
        <View style={s.cbar}>
            {/* Lane 1 — your marker (the only thing above the track) */}
            <View
                style={[s.you, { backgroundColor: tagBg, left: `${pct}%`, marginLeft: -tagW / 2 }]}
                onLayout={(e) => setTagW(e.nativeEvent.layout.width)}
            >
                <Text style={s.youText}>{tagLabel}</Text>
                <View style={[s.pointer, { borderTopColor: tagBg }]} />
            </View>

            {/* Lane 2 — the track */}
            <View style={s.track}>
                <LinearGradient
                    colors={[RED, '#cf6a3f', '#e0a35a', '#7ccb90', BEAN, '#7ccb90', '#e0a35a', WARM]}
                    locations={[0.04, 0.17, 0.29, 0.4, 0.5, 0.6, 0.74, 0.96]}
                    start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
                    style={StyleSheet.absoluteFill}
                />
                <View style={s.zero} />
                {/* Offer-locked zone: earned depth your live Offers haven't unlocked yet */}
                {hasLocked && <View style={[s.lockedZone, { left: `${floorPct}%`, width: `${usablePct - floorPct}%` }]} />}
                {/* Offer-band rungs (the "ladder") */}
                {rungs.map((r) => (<View key={r.b} style={[s.rung, { left: `${r.pct}%` }]} />))}
                {/* Current usable-floor marker — how deep you can actually spend right now */}
                {hasLocked && uFloor < 0 && <View style={[s.usableMark, { left: `${usablePct}%` }]} />}
                {showFees && FEE_TICKS.map((t, i) => (
                    <View key={i} style={[s.feeTick, { left: `${t}%`, opacity: 0.5 * revealT }]} />
                ))}
                <View style={[s.bead, { left: `${pct}%` }]} />
            </View>

            {/* Offer ladder caption — what your live Offers unlock, and the next rung */}
            {showLadder && hasLocked && (
                <View style={s.ladderRow} pointerEvents="none">
                    <Text style={s.ladderText}>
                        🎣 {uFloor < 0 ? (
                            <>
                                <Text style={s.ladderStrong}>{liveOffers} offer{liveOffers === 1 ? '' : 's'}</Text> {liveOffers === 1 ? 'unlocks' : 'unlock'} −{Math.abs(uFloor)}{nextUnlock ? ` · post another → −${nextUnlock}` : ''}
                            </>
                        ) : (
                            <>
                                <Text style={s.ladderStrong}>Post an Offer</Text> to open your credit line — <Text style={s.ladderStrong}>{offersForFull}</Text> offer{offersForFull === 1 ? '' : 's'} unlock your full −{Math.abs(floor)}.
                            </>
                        )}
                    </Text>
                </View>
            )}

            {/* Fee ladder — the circulation-fee brackets above +feeFreeMax, revealed as you climb */}
            {showFees && (
                <View style={s.feeRow} pointerEvents="none">
                    <Text style={[s.feeCaption, { opacity: revealT }]}>fee/mo</Text>
                    {FEE_ZONES.map((z, i) => {
                        const active = balance > z.lo && balance <= z.hi;
                        return (
                            <Text
                                key={i}
                                style={[s.feeRate, { left: `${z.mid}%`, opacity: revealT, color: active ? WARM : colors.text.muted, fontWeight: active ? '800' : '600' }]}
                            >{z.label}</Text>
                        );
                    })}
                </View>
            )}

            {/* Lane 3 — anchors: left / centre / right (space-between can't collide) */}
            <View style={s.anchors}>
                <View>
                    <Text style={[s.aVal, { color: RED }]}>{floor}</Text>
                    <Text style={s.aSub}>your limit</Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                    <Text style={[s.aVal, { color: BEAN_DEEP }]}>⚖️ 0</Text>
                    <Text style={[s.aSub, { color: BEAN_DEEP, opacity: 0.85 }]}>sweet spot</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[s.aVal, { color: WARM }]}>+{feeFreeMax}</Text>
                    <Text style={s.aSub}>fee-free</Text>
                </View>
            </View>

            {/* Lane 4 — directional hint */}
            <View style={s.hint}>
                <Text style={s.hintText}>← carry credit</Text>
                <Text style={s.hintText}>hold credit →</Text>
            </View>
        </View>
    );
}

const styles = (colors: any) => StyleSheet.create({
    cbar: { position: 'relative', paddingTop: 26 },
    you: { position: 'absolute', top: 0, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 },
    youText: { color: '#fff', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
    pointer: {
        position: 'absolute', left: '50%', marginLeft: -4, bottom: -4,
        borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 5,
        borderLeftColor: 'transparent', borderRightColor: 'transparent',
    },
    track: { height: 15, borderRadius: 9, overflow: 'visible' },
    zero: { position: 'absolute', left: '50%', marginLeft: -1, top: -3, bottom: -3, width: 2, backgroundColor: '#fff' },
    feeTick: { position: 'absolute', top: -2, bottom: -2, width: 1, marginLeft: -0.5, backgroundColor: '#fff' },
    lockedZone: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(15,23,42,0.42)' },
    rung: { position: 'absolute', top: -2, bottom: -2, width: 1, marginLeft: -0.5, backgroundColor: '#fff', opacity: 0.4 },
    usableMark: { position: 'absolute', top: -3, bottom: -3, width: 2, marginLeft: -1, backgroundColor: WARM_BG, zIndex: 1 },
    ladderRow: { marginTop: 6 },
    ladderText: { fontSize: 11, lineHeight: 15, color: colors.text.body },
    ladderStrong: { color: WARM, fontWeight: '800' },
    feeRow: { position: 'relative', height: 12, marginTop: 4 },
    feeRate: { position: 'absolute', top: 0, width: 44, marginLeft: -22, textAlign: 'center', fontSize: 9, fontVariant: ['tabular-nums'] },
    feeCaption: { position: 'absolute', top: 1, left: 0, fontSize: 8, color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
    bead: {
        position: 'absolute', top: '50%', marginTop: -9, marginLeft: -9, width: 18, height: 18, borderRadius: 9,
        backgroundColor: '#fff', borderWidth: 4, borderColor: colors.text.heading, zIndex: 2,
    },
    anchors: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
    aVal: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
    aSub: { fontSize: 9, color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 1 },
    hint: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
    hintText: { fontSize: 10, color: colors.text.muted },
});
