import { useEffect, useState } from 'react';
import { useIdentity } from '../app/IdentityContext';
import { lookingAroundHere } from './look-around';

/**
 * Whether this phone is looking around as a visitor with no account (slice S12, utils/look-around.ts): no identity once
 * it has loaded, and the community in use is the global community's visitors' view, chosen on the first screen. False
 * while the identity is still loading, so a member's screens never flash a visitor's line before their key is read.
 */
export function useLookingAround(): boolean {
    const { identity, isLoading } = useIdentity();
    const [looking, setLooking] = useState(false);
    useEffect(() => {
        if (identity || isLoading) { setLooking(false); return; }
        let live = true;
        void lookingAroundHere().then((v) => { if (live) setLooking(v); });
        return () => { live = false; };
    }, [identity?.publicKey, isLoading]);
    return looking && !identity;
}
