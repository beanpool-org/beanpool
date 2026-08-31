/**
 * Channel link chips for member profiles (The Pulse, Phase 1).
 *
 * Renders a member's syndicated creator channels as tappable link chips.
 * Opens the external profile URL in a new browser tab.
 *
 * Rules:
 * - Empty/missing channels: returns null (never an empty state or add prompt).
 * - Verified channel: shows distinct verification indicator when `isVerified === true`.
 * - Responsive wrapping on mobile and desktop viewports.
 */

import React from 'react';
import { platformMeta, type PublicCreatorChannel } from '@beanpool/core';

interface Props {
    channels?: PublicCreatorChannel[] | null;
}

export function ChannelChips({ channels }: Props) {
    if (!channels || channels.length === 0) {
        return null;
    }

    return (
        <div className="flex flex-wrap justify-center gap-2 mt-4 max-w-md" role="list" aria-label="External channels">
            {channels.map((channel) => {
                const meta = platformMeta(channel.platform);
                const hasHandle = Boolean(channel.handle && channel.handle.trim());
                const displayLabel = hasHandle
                    ? `${meta.label} · ${channel.handle}`
                    : meta.label;

                const accessLabel = `${meta.label}${hasHandle ? ` ${channel.handle}` : ''}${
                    channel.isVerified ? ' (verified account)' : ''
                }`;

                return (
                    <a
                        key={channel.id}
                        href={channel.url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={accessLabel}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all no-underline ${
                            channel.isVerified
                                ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 shadow-sm'
                                : 'border-nature-200 dark:border-nature-800 bg-white/80 dark:bg-nature-900/80 text-nature-700 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-800 shadow-sm'
                        }`}
                    >
                        <span className="text-sm select-none" aria-hidden="true">
                            {meta.icon}
                        </span>
                        <span className="truncate max-w-[200px]">
                            {displayLabel}
                        </span>
                        {channel.isVerified ? (
                            <span
                                className="w-3.5 h-3.5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[9px] font-black leading-none ml-0.5"
                                title="Verified account"
                                aria-label="Verified account"
                            >
                                ✓
                            </span>
                        ) : null}
                    </a>
                );
            })}
        </div>
    );
}
