/**
 * Settings → Legal & Privacy on the worldwide community: what shows beside the member's name on its forum (slice F10 apps;
 * DESIGN-forums-fable.md §12, §18 "one tap"; utils/forum-label.ts). The choices: Don't show · each of the member's other
 * communities on this phone · I'm waiting to join one. A tap applies at once; a refusal is said under the choices and changes
 * nothing. Shown only where the forum is public (settings.tsx), and only once the forum has answered what is chosen now.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { FORUM_LABEL_WORDS, forumLabelWhyLine, forumWriterLine, t, type ForumLabelChoice, type ForumLabelState } from '@beanpool/core';
import { otherCommunities, readForumLabel, setForumLabel, type PhoneCommunity } from '../../utils/forum-label';
import { useForumStyles } from './forum-style';

export function ForumLabelRow({ myName }: { myName: string }) {
    const styles = useForumStyles();
    const [state, setState] = useState<ForumLabelState | null>(null);
    const [mine, setMine] = useState<PhoneCommunity[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** The address picked in this visit: its record may not know the community's server key yet. */
    const [picked, setPicked] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        void readForumLabel().then((s) => { if (alive) setState(s); });
        void otherCommunities().then((c) => { if (alive) setMine(c); });
        return () => { alive = false; };
    }, []);

    if (!state) return null;

    async function choose(choice: ForumLabelChoice) {
        setBusy(true);
        setError(null);
        const done = await setForumLabel(choice);
        setBusy(false);
        if (!done.ok) { setError(done.error); return; }
        setState(done.state);
        setPicked(choice.show === 'community' ? choice.address : null);
    }

    const chosenKey = state.show === 'community' ? state.community?.key ?? null : null;
    const isChosen = (c: PhoneCommunity) => !!chosenKey && (c.key === chosenKey || (!c.key && c.address === picked));
    // The community chosen when this phone doesn't keep it (picked on the web): shown, chosen, so the choice is never hidden.
    const elsewhere = chosenKey && !mine.some(isChosen) ? state.community?.name ?? null : null;
    const options: Array<{ id: string; label: string; on: boolean; choice: ForumLabelChoice | null }> = [
        { id: 'none', label: t(FORUM_LABEL_WORDS.none), on: state.show === 'none', choice: { show: 'none' } },
        ...mine.map((c) => ({ id: c.address, label: c.name, on: isChosen(c), choice: { show: 'community' as const, address: c.address } })),
        ...(elsewhere ? [{ id: 'elsewhere', label: elsewhere, on: true, choice: null }] : []),
        { id: 'waiting', label: t(FORUM_LABEL_WORDS.waiting), on: state.show === 'waiting', choice: { show: 'waiting' } },
    ];
    const why = forumLabelWhyLine(state);

    return (
        <View style={[styles.card, { margin: 12 }]} testID="settings-forum-label">
            <View style={{ flexDirection: 'row', gap: 8 }}>
                <Text style={styles.rowTitle} aria-hidden={true} importantForAccessibility="no">🏷️</Text>
                <Text style={[styles.rowTitle, { flex: 1 }]}>{t(FORUM_LABEL_WORDS.title)}</Text>
            </View>
            <Text style={styles.muted}>{t(FORUM_LABEL_WORDS.hint)}</Text>
            <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {options.map((o) => (
                    <Pressable key={o.id} accessibilityRole="radio" accessibilityState={{ checked: o.on, disabled: busy }} disabled={busy}
                        testID={`forum-label-${o.id === 'none' || o.id === 'waiting' ? o.id : 'community'}`}
                        onPress={() => { if (o.choice && !o.on) void choose(o.choice); }}
                        style={[styles.chip, o.on && styles.chipOn, { minHeight: 48, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
                        {o.on && <Text style={styles.chipTextOn} aria-hidden={true} importantForAccessibility="no">✓</Text>}
                        <Text style={[o.on ? styles.chipTextOn : styles.chipText, { flexShrink: 1 }]}>{o.label}</Text>
                    </Pressable>
                ))}
            </View>
            {mine.length === 0 && !elsewhere && <Text style={styles.muted}>{t(FORUM_LABEL_WORDS.noOther)}</Text>}
            {busy && <Text style={styles.muted} accessibilityLiveRegion="polite">{t(FORUM_LABEL_WORDS.asking)}</Text>}
            {!!why && !error && <Text style={styles.small}>{why}</Text>}
            {!!error && <Text style={styles.danger} accessibilityRole="alert">{error}</Text>}
            {state.label && !!myName && (
                <Text style={styles.small} testID="forum-label-shown">{t(FORUM_LABEL_WORDS.shown, { line: forumWriterLine({ name: myName, label: state.label }, myName) })}</Text>
            )}
        </View>
    );
}
