import React, { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { knownRuleLine, type KnownRule } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { fetchKnownRule } from '../utils/known-rule';
import { looksLikeNodeAddress, normalizeNodeUrl, shouldBlockCleartextNodeUrl } from '../utils/node-url';

/**
 * The address a door reads the rule from, as the join screen checks it (app/welcome.tsx): a node's address, never a
 * cleartext one the app wouldn't join. Null draws nothing.
 */
export function doorRuleAddress(url: string | null | undefined): string | null {
    const target = normalizeNodeUrl(url ?? '');
    if (!target || !looksLikeNodeAddress(target) || shouldBlockCleartextNodeUrl(target)) return null;
    return target;
}

/**
 * The rule's one sentence on a door into a known community that has a screen before the join (Marty, board card
 * balance-rule-other-doors, 3 Nov 2026: "Yes, show the sentence"): the community card, People's Join Another Community
 * and Find a community's yes. The same sentence the join screen and the rules page say (core knownRuleLine), read from
 * the community's own address as the join screen reads it (utils/known-rule.ts). Nothing to tick or tap, and no card.
 * Draws nothing where the community doesn't confirm its members, an older node, an address that isn't one, or no answer.
 * `delayMs`: a typed address waits for the typing to stop, as the join screen's does.
 */
export function DoorRuleLine({ url, delayMs = 0, testID = 'door-rule' }: { url: string | null | undefined; delayMs?: number; testID?: string }) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        line: { color: colors.text.body, fontSize: 14, lineHeight: 20, marginTop: 12 },
    }));
    const target = doorRuleAddress(url);
    // Kept with the address it was read from: a sentence for one address never shows under another.
    const [read, setRead] = useState<{ url: string; rule: KnownRule | null } | null>(null);
    useEffect(() => {
        if (!target) return;
        let live = true;
        const timer = setTimeout(() => {
            void fetchKnownRule(target).then((rule) => { if (live) setRead({ url: target, rule }); });
        }, delayMs);
        return () => { live = false; clearTimeout(timer); };
    }, [target, delayMs]);
    const line = target && read?.url === target && read.rule ? knownRuleLine(read.rule) : null;
    if (!line) return null;
    return <Text style={styles.line} testID={testID}>{line}</Text>;
}
