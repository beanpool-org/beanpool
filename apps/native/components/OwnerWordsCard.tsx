/**
 * Settings → "Check your 12 words": owners only (sealed-keys.md §7, slice 7). Always there for an owner, with their
 * status ("12 words checked 3 Oct 2026" / "not checked"), so the check can be done any time. Nobody else sees it.
 *
 * Asked of the node on every focus of Settings (GET /api/node/owner/words-check, signed), like NodeAdminEntry. No
 * answer (offline, an older node) shows nothing. It never gates anything; it is a row that opens a screen.
 */
import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { OWNER_WORDS_COPY as COPY, fetchOwnerWordsStatus, type OwnerWordsStatus } from '../utils/owner-words';

/** The Settings screen's own menu styles, so the row looks like every other row. */
interface MenuStyles {
    sectionHeader: any; menuGroup: any; menuBtn: any; menuBtnLast: any;
    menuIconWrap: any; menuIcon: any; menuText: any; menuSub: any; menuChevron: any;
}

export function OwnerWordsCard({ styles }: { styles: MenuStyles }) {
    const { identity } = useIdentity();
    const [status, setStatus] = useState<OwnerWordsStatus | null>(null);

    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                const url = await getAnchorUrl();
                if (!url || !identity?.privateKey) { if (!cancelled) setStatus(null); return; }
                const got = await fetchOwnerWordsStatus(url, identity);
                if (!cancelled) setStatus(got);
            })().catch(() => { if (!cancelled) setStatus(null); });
            return () => { cancelled = true; };
        }, [identity])
    );

    if (!status?.owner) return null;
    const sub = status.wordsCheckedAt ? COPY.checked(status.wordsCheckedAt) : COPY.notChecked;

    return (
        <>
            <Text style={styles.sectionHeader}>COMMUNITY KEYS</Text>
            <View style={styles.menuGroup}>
                <Pressable
                    style={[styles.menuBtn, styles.menuBtnLast, { minHeight: 48 }]}
                    onPress={() => router.push('/owner-words-check')}
                    accessibilityRole="button"
                    accessibilityLabel={COPY.title}
                    accessibilityHint={sub}
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔑</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>{COPY.title}</Text>
                        <Text style={styles.menuSub}>{sub}</Text>
                    </View>
                    <Text style={styles.menuChevron}>›</Text>
                </Pressable>
            </View>
        </>
    );
}
