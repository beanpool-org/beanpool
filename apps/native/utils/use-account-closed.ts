import { useEffect, useState } from 'react';
import { accountClosedAtGlobal } from './global-join-existing';

/** Whether global has answered `account_closed` for this key on this phone (the door is then no longer offered). */
export function useAccountClosedAtGlobal(publicKey: string | null | undefined): boolean {
    const [closed, setClosed] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setClosed(false);
        accountClosedAtGlobal(publicKey).then(c => { if (!cancelled) setClosed(c); }).catch(() => {});
        return () => { cancelled = true; };
    }, [publicKey]);
    return closed;
}
