import React from 'react';
import { AVATAR_PRESETS, t } from '@beanpool/core';
import { resolveAvatarUrl } from '../lib/avatar';

export interface AvatarPresetPickerProps {
    selected?: string | null;
    onSelect: (presetUri: string) => void;
    label?: string;
    className?: string;
    /** The heading's colour classes; a container with its own fixed background (the always-dark propose modal) sets them. */
    headingClassName?: string;
}

export function AvatarPresetPicker({
    selected,
    onSelect,
    label,
    className = '',
    headingClassName = 'text-nature-600 dark:text-nature-400',
}: AvatarPresetPickerProps) {
    const heading = label ?? t('Or choose an avatar:');
    return (
        <div className={`mt-3 ${className}`}>
            <p className={`m-0 mb-2 text-xs font-semibold ${headingClassName}`}>
                {heading}
            </p>
            <div
                tabIndex={0}
                role="region"
                aria-label={heading}
                style={{ display: 'flex', overflowX: 'auto', gap: '0.625rem' }}
                className="flex gap-2.5 overflow-x-auto py-1 px-1 custom-scrollbar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-xl"
            >
                {AVATAR_PRESETS.map((preset) => {
                    const uri = `bundled://${preset.id}`;
                    const isSelected = selected === uri;
                    const resolved = resolveAvatarUrl(uri) || '';
                    const presetName = t(preset.label);
                    const buttonLabel = t('Select {name} avatar', { name: presetName });

                    return (
                        <button
                            key={preset.id}
                            type="button"
                            onClick={() => onSelect(uri)}
                            aria-label={buttonLabel}
                            aria-pressed={isSelected}
                            title={presetName}
                            style={{ flexShrink: 0, width: '44px', height: '44px', borderRadius: '50%' }}
                            className={`shrink-0 w-11 h-11 rounded-full p-0 overflow-hidden cursor-pointer transition-all border-2 bg-nature-100 dark:bg-nature-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-nature-900 ${
                                isSelected
                                    ? 'ring-2 ring-emerald-500 ring-offset-2 ring-offset-white dark:ring-offset-nature-900 border-emerald-500 scale-105'
                                    : 'border-transparent hover:border-nature-300 dark:hover:border-nature-600 hover:scale-105 opacity-90 hover:opacity-100'
                            }`}
                        >
                            <img
                                src={resolved}
                                alt=""
                                aria-hidden="true"
                                className="w-full h-full object-cover pointer-events-none"
                                loading="lazy"
                            />
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
