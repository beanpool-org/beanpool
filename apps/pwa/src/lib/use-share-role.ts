/**
 * The signed member's role here, for the lines under the Share buttons (share-says): asked only where it changes what is
 * said (a community where only admins invite, or a private preview). A role, null (the node answered: no role), or
 * undefined (not asked, not heard yet, or the node did not answer): shareSays says nothing for undefined rather than
 * guess that the member is no admin.
 */
import { useEffect, useState } from 'react';
import type { ShareSaysFeatures, ShareSaysRole } from '@beanpool/core';
import { myNodeRoleOnce } from './api';

export function useShareRole(features: ShareSaysFeatures | null | undefined): ShareSaysRole {
    const [role, setRole] = useState<ShareSaysRole>(undefined);
    const needsRole = features?.door === 'admins' || features?.privatePreview === true;
    useEffect(() => {
        if (!needsRole) return;
        let cancelled = false;
        void myNodeRoleOnce().then(r => { if (!cancelled) setRole(r); });
        return () => { cancelled = true; };
    }, [needsRole]);
    return role;
}
