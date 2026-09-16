import React, { useState } from 'react';
import { resolveAvatarUrl, isShortEmoji } from '../../lib/avatar';

export interface AvatarProps {
    src?: string | null;
    alt: string;
    className?: string;
    imageClassName?: string;
    fallbackGlyph?: React.ReactNode;
    textClassName?: string;
}

export function Avatar({
    src,
    alt,
    className = 'w-9 h-9 rounded-xl bg-nature-800 border border-nature-700 flex items-center justify-center text-lg overflow-hidden shrink-0',
    imageClassName = 'w-full h-full object-cover',
    fallbackGlyph = '🌾',
    textClassName = '',
}: AvatarProps) {
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const isError = Boolean(src && failedSrc === src);

    const resolvedUrl = !isError ? resolveAvatarUrl(src) : null;
    const isEmoji = !resolvedUrl && isShortEmoji(src);

    return (
        <div className={className}>
            {resolvedUrl ? (
                <img
                    src={resolvedUrl}
                    alt={alt}
                    className={imageClassName}
                    onError={() => setFailedSrc(src ?? null)}
                />
            ) : (
                <span
                    role={!alt ? undefined : 'img'}
                    aria-label={!alt ? undefined : alt}
                    aria-hidden={!alt ? 'true' : undefined}
                    className={`select-none leading-none ${textClassName}`}
                >
                    {isEmoji ? src?.trim() : fallbackGlyph}
                </span>
            )}
        </div>
    );
}
