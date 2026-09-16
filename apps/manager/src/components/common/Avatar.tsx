import React, { useState, useEffect } from 'react';
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
    const [imgError, setImgError] = useState(false);

    useEffect(() => {
        setImgError(false);
    }, [src]);

    const resolvedUrl = !imgError ? resolveAvatarUrl(src) : null;
    const isEmoji = !resolvedUrl && !imgError && isShortEmoji(src);

    return (
        <div className={className}>
            {resolvedUrl ? (
                <img
                    src={resolvedUrl}
                    alt={alt}
                    className={imageClassName}
                    onError={() => setImgError(true)}
                />
            ) : isEmoji ? (
                <span className={`select-none leading-none ${textClassName}`}>{src}</span>
            ) : (
                <span className={`select-none leading-none ${textClassName}`}>{fallbackGlyph}</span>
            )}
        </div>
    );
}
