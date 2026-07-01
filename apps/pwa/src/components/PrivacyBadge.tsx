/**
 * PrivacyBadge — Interactive 4-tier privacy toggle
 *
 * Displays the current privacy tier with emoji + name.
 * Tapping cycles through tiers: Ghost → Post → Zone → Live → Ghost
 */

import { useState } from 'react';
import { loadPrivacyState, cycleTier, TIER_CONFIG, type PrivacyState } from '../lib/privacy';

export function PrivacyBadge() {
    const [privacy, setPrivacy] = useState<PrivacyState>(loadPrivacyState);

    const config = TIER_CONFIG[privacy.tier];

    function handleCycle() {
        const next = cycleTier(privacy);
        setPrivacy(next);

        // Haptic feedback if available
        if ('vibrate' in navigator) {
            navigator.vibrate(next.tier === 0 ? [100, 50, 100] : [50]);
        }
    }

    return (
        <button
            onClick={handleCycle}
            title={`Privacy: ${config.name} — ${config.description}`}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.3rem 0.75rem',
                borderRadius: '9999px',
                background: 'var(--bg-card)',
                border: `1px solid ${config.color}40`,
                color: config.color,
                fontSize: '0.75rem',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                fontFamily: 'inherit',
            }}
        >
            <span style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: config.color,
                boxShadow: `0 0 6px ${config.color}80`,
                flexShrink: 0,
            }} />
            <span style={{ whiteSpace: 'nowrap' }}>{config.name}</span>
        </button>
    );
}
