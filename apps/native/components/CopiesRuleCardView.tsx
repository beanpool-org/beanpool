/**
 * Home's "rule changed" card as drawn (vault rethink VR2; components/CopiesRuleCard.tsx finds the change): its words for
 * where a copy made from the community goes now, and its buttons. Apart from the card's data, so e2e/ways-back-320.mjs
 * draws it at 320 dp with nothing of the phone's storage or network behind it.
 *
 * One column at 320 dp and 1.3× text: the sentences wrap, the 48 dp buttons stack.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { t } from '@beanpool/core';
import { type AppColors } from '../constants/colors';
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

/** The card as drawn, for a change to `to` at `community`. */
export function CopiesRuleCardView({ to, community, canMove, colors, onMove, onSee, onOk }: {
    to: SignInCopies;
    community: string;
    /** "Move mine" is offered: a copy at the key vault to move to the community. */
    canMove: boolean;
    colors: AppColors;
    onMove: () => void;
    onSee: () => void;
    onOk: () => void;
}) {
    const words = copiesRuleCardWords(to, community);
    return (
        <View style={[styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]} testID="copies-rule-card">
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">{words.title}</Text>
            <Text style={[styles.body, { color: colors.text.body }]}>{words.body}</Text>
            {canMove && (
                <Pressable
                    onPress={onMove}
                    style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }]}
                    accessibilityRole="button"
                    testID="copies-rule-move"
                >
                    <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{t('Move mine')}</Text>
                </Pressable>
            )}
            <Pressable
                onPress={onSee}
                style={canMove ? styles.secondaryBtn : [styles.primaryBtn, { backgroundColor: colors.brand.fill }]}
                accessibilityRole="button"
                testID="copies-rule-see"
            >
                <Text style={canMove ? [styles.secondaryText, { color: colors.text.link }] : [styles.primaryText, { color: colors.text.inverse }]}>
                    {t('See where my copies are')}
                </Text>
            </Pressable>
            <Pressable onPress={onOk} style={styles.secondaryBtn} accessibilityRole="button" testID="copies-rule-ok">
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
