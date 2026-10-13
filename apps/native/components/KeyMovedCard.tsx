/**
 * The old phone, once its community says its key was replaced (utils/key-replaced.ts): "This account moved to a new
 * phone", and the offer of its old 12 words, so the new phone can unlock the group messages from before the change
 * (scratch/global-node/DESIGN-group-history-after-rekey-fable.md §3). The words show only behind the phone's lock, out of
 * screenshots, and are never sent. Nothing shows on a phone whose key is current, or one with no words on it.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { palette, type AppColors } from '../constants/colors';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl } from '../utils/node-post';
import { getMnemonic } from '../utils/identity';
import { readWordsBehindLock } from '../utils/words-behind-lock';
import { KEY_MOVED_BODY, KEY_MOVED_REASON, KEY_MOVED_SHOW, KEY_MOVED_TITLE, keyReplacedHere, onKeyReplaced } from '../utils/key-replaced';
import { NoScreenCapture } from './WordsOnScreen';

/** The primary button's green: white on it is 5.5:1, where on brand.primary (emerald-500) it is 2.5:1 (e2e/locked-history-320.mjs). */
const BUTTON_GREEN = palette.emerald700;

export function KeyMovedCard({ colors }: { colors: AppColors }) {
    const { identity } = useIdentity();
    const [moved, setMoved] = useState(false);
    const [hasWords, setHasWords] = useState(false);
    const [words, setWords] = useState<string[] | null>(null);

    useEffect(() => {
        let live = true;
        const check = async () => {
            const url = await anchorUrl().catch(() => null);
            if (!url || !identity?.publicKey) return;
            const yes = await keyReplacedHere(url, identity.publicKey);
            const w = yes ? await getMnemonic(identity).catch(() => null) : null;
            if (live) { setMoved(yes); setHasWords(!!w?.length); }
        };
        void check();
        const off = onKeyReplaced(() => { void check(); });
        return () => { live = false; off(); };
    }, [identity]);

    if (!moved) return null;
    return (
        <View style={[styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]} testID="key-moved-card">
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">{KEY_MOVED_TITLE}</Text>
            <Text style={[styles.body, { color: colors.text.secondary }]}>{KEY_MOVED_BODY}</Text>
            {words ? (
                <NoScreenCapture>
                    <View style={styles.grid}>
                        {words.map((w, i) => (
                            <View key={`${w}-${i}`} style={[styles.word, { backgroundColor: colors.surface.subtle }]} accessible accessibilityLabel={`Word ${i + 1}: ${w}`}>
                                <Text style={[styles.wordText, { color: colors.text.heading }]}>{i + 1}. {w}</Text>
                            </View>
                        ))}
                    </View>
                    <Pressable onPress={() => setWords(null)} style={styles.secondaryBtn} accessibilityRole="button">
                        <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>Hide the words</Text>
                    </Pressable>
                </NoScreenCapture>
            ) : hasWords ? (
                <Pressable
                    onPress={async () => { const w = await readWordsBehindLock(identity, KEY_MOVED_REASON).catch(() => null); if (w) setWords(w); }}
                    style={[styles.primaryBtn, { backgroundColor: BUTTON_GREEN }]}
                    accessibilityRole="button"
                >
                    <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{KEY_MOVED_SHOW}</Text>
                </Pressable>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10, marginBottom: 12 },
    title: { fontSize: 17, fontWeight: '800' },
    body: { fontSize: 15, lineHeight: 21 },
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 },
    primaryText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    secondaryText: { fontSize: 15, fontWeight: '700' },
    grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
    word: { width: '48%', borderRadius: 8, padding: 8, marginBottom: 8 },
    wordText: { fontSize: 15, fontWeight: '700' },
});
