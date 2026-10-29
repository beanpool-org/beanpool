import React from 'react';
import { resolveAvatarUrl } from '../lib/avatar';

export interface MemberAvatarProps {
    avatarUrl?: string | null;
    pubkey?: string | null;
    callsign?: string;
    size?: number;
    className?: string;
    /** The picture's words; '' where the name is beside it. The callsign by default. */
    alt?: string;
    onClick?: () => void;
}

/**
 * A member's, an enterprise's or a project's face on the web, as the phone's components/MemberAvatar draws it: its
 * picture, or with none (or one the browser may not load, or one that fails to load: a stale address after the photo
 * changed elsewhere) the ready-made picture its key picks (@beanpool/core avatarPresetForPubkey, its callsign where no key
 * is known). Never a bare initial (Pictures S4), never a broken image.
 */
export function MemberAvatar({
    avatarUrl,
    pubkey,
    callsign,
    size = 40,
    className = '',
    alt,
    onClick,
}: MemberAvatarProps) {
    const key = pubkey || callsign;
    const preset = resolveAvatarUrl(null, key) || '/avatars/avatar_bean_green.webp';
    const picture = resolveAvatarUrl(avatarUrl, key) || preset;
    // The picture that failed to load: the preset stands in for it. Another picture is tried afresh.
    const [failed, setFailed] = React.useState<string | null>(null);
    const src = picture === failed ? preset : picture;

    return (
        <img
            src={src}
            alt={alt ?? callsign ?? ''}
            width={size}
            height={size}
            onClick={onClick}
            onError={src === preset ? undefined : () => setFailed(src)}
            className={`rounded-full object-cover shrink-0 ${className}`}
            style={{ width: `${size}px`, height: `${size}px` }}
        />
    );
}

export default MemberAvatar;
