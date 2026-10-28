/**
 * Home's "rule changed" card (vault rethink VR2, design §5.3 "Changing the rule"; utils/copies-rule.ts): the community
 * the phone is on changed where members' copies go since this account last saw it. From the community's answer the phone
 * keeps (Home asks nothing more of the community), looked at again when the tab strip's fresh answer at the app's start is
 * kept. Said once, at the next app open: what a sign-in linked here does now, and that a copy the member already has
 * stays where it is (nothing moves by itself). Where a move is possible and the phone knows there is a copy to move (one
 * at BeanPool's key vault, the community now keeping them itself), "Move mine" opens Account Protection, where the move
 * card makes it (components/VaultMoveCard.tsx). "See where my copies are" opens "Where your account can be brought back
 * from"; "OK" puts the card away. Drawn by components/CopiesRuleCardView.tsx.
 */
import React, { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { type AppColors } from '../constants/colors';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl } from '../utils/node-post';
import { getSavedNodes } from '../utils/nodes';
import { copiesRuleChange, copiesRuleSeen, type CopiesRuleChange } from '../utils/copies-rule';
import { vaultCopyKnowledge } from '../utils/vault';
import { onCommunitySwitched } from '../utils/community-switch';
import { onNodeProfileStored } from '../utils/node-profile';
import { CopiesRuleCardView } from './CopiesRuleCardView';

export { copiesRuleCardWords } from './CopiesRuleCardView';

/** The community's name as this phone saved it, else its address. */
async function communityName(url: string): Promise<string> {
    const saved = (await getSavedNodes().catch(() => [])).find(n => n.url.replace(/\/+$/, '').toLowerCase() === url.replace(/\/+$/, '').toLowerCase());
    if (saved?.alias) return saved.alias;
    try {
        return new URL(url).host || url;
    } catch {
        return url.replace(/^https?:\/\//, '');
    }
}

export function CopiesRuleCard({ colors }: { colors: AppColors }) {
    const { identity } = useIdentity();
    const [change, setChange] = useState<(CopiesRuleChange & { name: string; canMove: boolean }) | null>(null);

    useFocusEffect(
        useCallback(() => {
            let live = true;
            const check = async () => {
                const pk = identity?.publicKey;
                const url = await anchorUrl().catch(() => null);
                if (!pk || !url) { if (live) setChange(null); return; }
                const found = await copiesRuleChange(pk, url);
                if (!found) { if (live) setChange(null); return; }
                // A move to the community needs a copy at the vault to move: only when this phone knows there is one.
                const canMove = found.to === 'community' && found.from === 'vault' && (await vaultCopyKnowledge(pk)) === 'kept';
                const name = await communityName(url);
                if (live) setChange({ ...found, name, canMove });
            };
            void check();
            const off = onCommunitySwitched(() => { if (live) setChange(null); void check(); });
            // The card reads only what the phone kept (Home's one request): it looks again when a fresh answer is kept,
            // as the tab strip's at each start.
            const offStored = onNodeProfileStored(() => { void check(); });
            return () => { live = false; off(); offStored(); };
        }, [identity?.publicKey]),
    );

    if (!change || !identity) return null;
    const putAway = () => {
        setChange(null);
        void copiesRuleSeen(identity.publicKey, change.url, change.rule);
    };

    return (
        <CopiesRuleCardView
            to={change.to}
            community={change.name}
            canMove={change.canMove}
            colors={colors}
            onMove={() => { putAway(); router.push({ pathname: '/(tabs)/settings', params: { section: 'protection' } }); }}
            onSee={() => { putAway(); router.push('/ways-back'); }}
            onOk={putAway}
        />
    );
}
