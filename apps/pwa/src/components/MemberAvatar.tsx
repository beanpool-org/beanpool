import React from 'react';
import { resolveAvatarUrl } from '../lib/avatar';

export interface MemberAvatarProps {
    avatarUrl?: string | null;
    pubkey?: string | null;
    callsign?: string;
    size?: number;
    className?: string;
    alt?: string;
    onClick?: () => void;
}

export function MemberAvatar({
    avatarUrl,
    pubkey,
    callsign,
    size = 40,
    className = '',
    alt,
    onClick,
}: MemberAvatarProps) {
    const src = resolveAvatarUrl(avatarUrl, pubkey);

    return (
        <img
            src={src || '/avatars/avatar_bean_green.jpg'}
            alt={alt || callsign || 'Avatar'}
            width={size}
            height={size}
            onClick={onClick}
            className={`rounded-full object-cover shrink-0 ${className}`}
            style={{ width: `${size}px`, height: `${size}px` }}
        />
    );
}

export default MemberAvatar;
