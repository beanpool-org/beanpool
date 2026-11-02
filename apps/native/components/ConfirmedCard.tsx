/**
 * Home's card about the rule of being confirmed (scratch/fable-design/DESIGN-balance-rule-fable.md §1, §2, §3): "You're
 * confirmed" the first time this account is seen confirmed, and again after a re-confirmation; or, for a member already
 * confirmed, when the rule reaches them or a line tightens. Which one, and when: @beanpool/core ruleCardFor. Stays until
 * OK, offers the one way out, and asks nothing of a member the rule doesn't reach.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { KNOWN_RULE_WORDS, confirmedBody, ruleCardFor, ruleChangesTitle, ruleSeenNow, t, yourRuleLine, type RuleCard } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl } from '../utils/node-post';
import { onCommunitySwitched } from '../utils/community-switch';
import { keepRuleSeen, memberRule, ruleSeenAt, type MemberRule } from '../utils/known-rule';
import type { BeanPoolIdentity } from '../utils/identity';
import { StepBackSheet } from './StepBackSheet';

export function ConfirmedCard() {
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();
    const [found, setFound] = useState<{ card: RuleCard; held: MemberRule; url: string } | null>(null);
    const [asking, setAsking] = useState(false);

    useFocusEffect(
        useCallback(() => {
            let live = true;
            const check = async () => {
                const url = await anchorUrl().catch(() => null);
                if (!identity?.publicKey || !identity.privateKey || !url) { if (live) setFound(null); return; }
                const held = await memberRule(url, identity as BeanPoolIdentity);
                const seen = held ? await ruleSeenAt(identity.publicKey, url) : null;
                const card = held ? ruleCardFor(held.me, held.rule, seen) : null;
                if (live) setFound(card && held ? { card, held, url } : null);
            };
            void check();
            const off = onCommunitySwitched(() => { if (live) setFound(null); void check(); });
            return () => { live = false; off(); };
        }, [identity]),
    );

    if (!found || !identity) return null;
    const { card, held, url } = found;
    const putAway = () => {
        void keepRuleSeen(identity.publicKey, url, ruleSeenNow(held.me, held.rule));
        setFound(null);
    };

    return (
        <View style={styles.card} testID={card.kind === 'confirmed' ? 'confirmed-card' : 'rule-changes-card'}>
            {card.kind === 'confirmed' ? (
                <>
                    <Text style={styles.title} accessibilityRole="header">{t(KNOWN_RULE_WORDS.confirmedTitle)}</Text>
                    <Text style={styles.body}>{confirmedBody(held.rule)}</Text>
                    <Text style={styles.body}>{yourRuleLine(held.rule)}</Text>
                    <Pressable onPress={() => router.push({ pathname: '/guide/[slug]', params: { slug: 'what-the-admins-can-see' } })} accessibilityRole="link" style={styles.guide}>
                        <Text style={styles.link}>{t(KNOWN_RULE_WORDS.guideLine)}</Text>
                    </Pressable>
                </>
            ) : (
                <>
                    <Text style={styles.title} accessibilityRole="header">{ruleChangesTitle(card.on)}</Text>
                    <Text style={styles.body}>{yourRuleLine(held.rule)}</Text>
                    {card.first && <Text style={styles.body}>{t(KNOWN_RULE_WORDS.replacesEarlier)}</Text>}
                    <Text style={styles.body}>{t(KNOWN_RULE_WORDS.stayOut)}</Text>
                </>
            )}
            <Pressable style={styles.primary} onPress={putAway} accessibilityRole="button" testID="confirmed-card-ok">
                <Text style={styles.primaryText}>{t(KNOWN_RULE_WORDS.ok)}</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={() => setAsking(true)} accessibilityRole="button" testID="confirmed-card-step-back">
                <Text style={styles.secondaryText}>{t(KNOWN_RULE_WORDS.stayUnconfirmed)}</Text>
            </Pressable>
            <StepBackSheet
                visible={asking}
                onClose={() => setAsking(false)}
                onSteppedBack={() => { setAsking(false); setFound(null); }}
            />
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10, marginBottom: 12, backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border },
    title: { fontSize: 17, lineHeight: 23, fontWeight: '800', color: colors.text.heading },
    body: { fontSize: 15, lineHeight: 21, color: colors.text.body },
    guide: { minHeight: 44, justifyContent: 'center' },
    link: { fontSize: 15, lineHeight: 21, fontWeight: '700', color: colors.text.link },
    primary: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: colors.brand.fill },
    primaryText: { fontSize: 15, fontWeight: '800', textAlign: 'center', color: colors.text.inverse },
    secondary: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
    secondaryText: { fontSize: 15, fontWeight: '700', textAlign: 'center', color: colors.text.link },
});
