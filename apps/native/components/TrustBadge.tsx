import React from 'react';
import Svg, { Defs, RadialGradient, LinearGradient, Stop, Circle, Path, Polygon, Ellipse, G } from 'react-native-svg';

/**
 * TrustBadge — a minted green "coin" medallion, one per trust level.
 *
 * Rank reads through the enamel shade (light → deep green), an engraved emblem that grows
 * with standing (sprout → home → pillars → summit), and ornament (laurel for Steward+, a
 * crown-star for Elder). `ring`/`ringPct` draws a progress arc around it for the hero.
 * All SVG so it stays razor-sharp at any size. Colours are intentionally all-green.
 */
export type TrustLevel = 'newcomer' | 'resident' | 'steward' | 'elder';

const GEMS: Record<TrustLevel, { face: [string, string, string]; ring: [string, string]; ornament: 'none' | 'laurel' | 'crown' }> = {
    newcomer: { face: ['#9fe0b0', '#5cbf78', '#2f9e44'], ring: ['#79cf90', '#268a3e'], ornament: 'none' },
    resident: { face: ['#7fd39a', '#3fa85c', '#1f7d3a'], ring: ['#59b974', '#166b2f'], ornament: 'none' },
    steward:  { face: ['#6ec489', '#2f9a52', '#136730'], ring: ['#4bab66', '#0f5827'], ornament: 'laurel' },
    elder:    { face: ['#77d992', '#249247', '#0c5225'], ring: ['#8ff0a6', '#0a4a20'], ornament: 'crown' },
};

// Engraved emblem per level (cream on the enamel face), designed for a 120×120 viewBox.
function Emblem({ level }: { level: TrustLevel }) {
    const cream = '#effaf1';
    switch (level) {
        case 'newcomer':
            return (
                <G>
                    <Path d="M60 84 Q60 66 60 52" fill="none" stroke={cream} strokeWidth={5} strokeLinecap="round" />
                    <Ellipse cx={47} cy={58} rx={12} ry={7.5} fill={cream} transform="rotate(-35 47 58)" />
                    <Ellipse cx={73} cy={58} rx={12} ry={7.5} fill={cream} transform="rotate(35 73 58)" />
                    <Ellipse cx={60} cy={46} rx={8} ry={6.5} fill={cream} />
                </G>
            );
        case 'resident':
            return (
                <G>
                    <Polygon points="60,42 82,60 38,60" fill={cream} />
                    <Path d="M44 60 h32 v22 a2 2 0 0 1 -2 2 h-28 a2 2 0 0 1 -2 -2 z" fill={cream} />
                    <Path d="M55 68 h10 v16 h-10 z" fill="#2a8f49" />
                </G>
            );
        case 'steward':
            return (
                <G fill={cream}>
                    <Polygon points="60,38 86,50 34,50" />
                    <Path d="M36 50 h48 v4.5 h-48 z" />
                    <Path d="M42 57 h6.5 v21 h-6.5 z" />
                    <Path d="M56.5 57 h6.5 v21 h-6.5 z" />
                    <Path d="M71 57 h6.5 v21 h-6.5 z" />
                    <Path d="M34 80 h52 v5.5 a2 2 0 0 1 -2 2 h-48 a2 2 0 0 1 -2 -2 z" />
                </G>
            );
        case 'elder':
            return (
                <G>
                    <Polygon points="42,82 58,50 74,82" fill={cream} />
                    <Polygon points="62,82 78,58 92,82" fill="#dff6e5" />
                    <Polygon points="53,64 58,50 63,64" fill="#ffffff" />
                </G>
            );
    }
}

export function TrustBadge({
    level,
    size = 64,
    locked = false,
    ring = false,
    ringPct = 0,
}: {
    level: TrustLevel;
    size?: number;
    locked?: boolean;
    ring?: boolean;
    ringPct?: number;
}) {
    // Unique gradient ids per instance so multiple badges on screen never collide.
    const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
    const g = GEMS[level];
    const fid = `bf${uid}`, rid = `br${uid}`;
    const RING_R = 56;
    const C = 2 * Math.PI * RING_R;
    const dash = Math.max(0, Math.min(1, ringPct)) * C;

    return (
        <Svg width={size} height={size} viewBox="0 0 120 120" opacity={locked ? 0.5 : 1}>
            <Defs>
                <RadialGradient id={fid} cx="38%" cy="30%" r="75%">
                    <Stop offset="0" stopColor={g.face[0]} />
                    <Stop offset="0.55" stopColor={g.face[1]} />
                    <Stop offset="1" stopColor={g.face[2]} />
                </RadialGradient>
                <LinearGradient id={rid} x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor={g.ring[0]} />
                    <Stop offset="1" stopColor={g.ring[1]} />
                </LinearGradient>
            </Defs>

            {/* progress ring (hero) */}
            {ring && (
                <>
                    <Circle cx={60} cy={60} r={RING_R} stroke="#e0e7dc" strokeWidth={5} fill="none" />
                    <Circle
                        cx={60} cy={60} r={RING_R} stroke="#2f9e44" strokeWidth={5} fill="none"
                        strokeLinecap="round" strokeDasharray={`${dash},${C}`} transform="rotate(-90 60 60)"
                    />
                </>
            )}

            {/* coin body */}
            <Circle cx={60} cy={60} r={48} fill={`url(#${rid})`} />
            <Circle cx={60} cy={60} r={48} fill="none" stroke="#08300f" strokeOpacity={0.2} strokeWidth={1.5} />
            {/* milled edge */}
            <Circle cx={60} cy={60} r={44} fill="none" stroke="#08300f" strokeOpacity={0.28} strokeWidth={3} strokeDasharray="2,3.2" />

            {/* laurel (steward + elder) */}
            {(g.ornament === 'laurel' || g.ornament === 'crown') && (
                <>
                    <Path d="M18 62 Q28 44 40 41" fill="none" stroke="#effaf1" strokeOpacity={0.58} strokeWidth={3.2} strokeLinecap="round" />
                    <Path d="M102 62 Q92 44 80 41" fill="none" stroke="#effaf1" strokeOpacity={0.58} strokeWidth={3.2} strokeLinecap="round" />
                </>
            )}
            {/* crown star (elder) */}
            {g.ornament === 'crown' && (
                <Path d="M60 8 l3 6 6 .8 -4.5 4.4 1.1 6.3 -5.6 -3 -5.6 3 1.1 -6.3 -4.5 -4.4 6 -.8 z" fill="#c7f7d5" />
            )}

            {/* enamel face */}
            <Circle cx={60} cy={60} r={38} fill={`url(#${fid})`} />
            <Circle cx={60} cy={60} r={38} fill="none" stroke="#08300f" strokeOpacity={0.22} strokeWidth={1.4} />
            {/* sheen */}
            <Ellipse cx={48} cy={44} rx={19} ry={11} fill="#ffffff" opacity={0.22} />

            <Emblem level={level} />
        </Svg>
    );
}
