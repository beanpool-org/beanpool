/**
 * Home's "rule changed" card (vault rethink VR2, design §5.3 "Changing the rule"; utils/copies-rule.ts): the community
 * the phone is on changed where members' copies go since this account last saw it. From the community's answer the phone
 * keeps (Home asks nothing more of the community), looked at again when the tab strip's fresh answer at the app's start is
 * kept. Said once, at the next app open: what
 * a sign-in linked here does now, and that a copy the member already has stays where it is (nothing moves by itself).
 * Where a move is possible and the phone knows there is a copy to move (one at BeanPool's key vault, the community now
 * keeping them itself), "Move mine" opens Account Protection, where the move card makes it (components/VaultMoveCard.tsx).
 * "See where my copies are" opens "Where your account can be brought back from"; "OK" puts the card away.
 *
 * One column at 320 dp and 1.3× text: the sentences wrap, the 48 dp buttons stack.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { t } from '@beanpool/core';
import { type AppColors } from '../constants/colors';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl } from '../utils/node-post';
import { getSavedNodes } from '../utils/nodes';
import { copiesRuleChange, copiesRuleSeen, type CopiesRuleChange } from '../utils/copies-rule';
import { vaultCopyKnowledge } from '../utils/vault';
import { onCommunitySwitched } from '../utils/community-switch';
import { onNodeProfileStored } from '../utils/node-profile';
import type { SignInCopies } from '../utils/vault-config';

/** What the card says for a change to `to` at `community` (its name, or its address). */
export function copiesRuleCardWords(to: SignInCopies, community: string): { title: string; body: string } {
    switch (to) {
        case 'none':
            return {
                title: t('{community} keeps no copies now', { community }),
                body: t("{community} no longer keeps copies of members' accounts, and doesn't use BeanPool's key vault. Yours stay where they are until you remove them.", { community }),
            };
        case 'community':
            return {
                title: t("{community} keeps members' copies itself now", { community }),
                body: t("A sign-in you link here keeps its copy on {community}'s own server, not at BeanPool's key vault. A copy you already have stays where it is until you move or remove it.", { community }),
            };
        default:
            return {
                title: t("{community} uses BeanPool's key vault now", { community }),
                body: t("A sign-in you link here keeps its copy at BeanPool's key vault, a small server in Iceland. A copy {community}'s server keeps for you stays there until you move or remove it.", { community }),
            };
    }
}

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
    const words = copiesRuleCardWords(change.to, change.name);
    const putAway = () => {
        setChange(null);
        void copiesRuleSeen(identity.publicKey, change.url, change.rule);
    };

    return (
        <View style={[styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]} testID="copies-rule-card">
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">{words.title}</Text>
            <Text style={[styles.body, { color: colors.text.body }]}>{words.body}</Text>
            {change.canMove && (
                <Pressable
                    onPress={() => { putAway(); router.push({ pathname: '/(tabs)/settings', params: { section: 'protection' } }); }}
                    style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }]}
                    accessibilityRole="button"
                    testID="copies-rule-move"
                >
                    <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{t('Move mine')}</Text>
                </Pressable>
            )}
            <Pressable
                onPress={() => { putAway(); router.push('/ways-back'); }}
                style={change.canMove ? styles.secondaryBtn : [styles.primaryBtn, { backgroundColor: colors.brand.fill }]}
                accessibilityRole="button"
                testID="copies-rule-see"
            >
                <Text style={change.canMove ? [styles.secondaryText, { color: colors.text.link }] : [styles.primaryText, { color: colors.text.inverse }]}>
                    {t('See where my copies are')}
                </Text>
            </Pressable>
            <Pressable onPress={putAway} style={styles.secondaryBtn} accessibilityRole="button" testID="copies-rule-ok">
                <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>{t('OK')}</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10, marginBottom: 12 },
    title: { fontSize: 17, lineHeight: 23, fontWeight: '800' },
    body: { fontSize: 15, lineHeight: 21 },
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 },
    primaryText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
    secondaryText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
