/**
 * Settings → "Check your 12 words": owners only (sealed-keys.md §7, slice 7). Always there for an owner, with their
 * status ("12 words checked 3 Oct 2026" / "not checked"), so the check can be done any time. Nobody else sees it.
 *
 * Asked of the node on every focus of Settings (GET /api/node/owner/words-check, signed), like NodeAdminEntry. No
 * answer (offline, an older node) shows nothing. It never gates anything; it is a row that opens a screen.
 *
 * Beside it, "Take over or restore with this phone" (app/unlock-keys.tsx, slice 6). That one matters most when the main
 * server is gone, so it also shows when the node does not answer but this phone remembers being an owner (the silent
 * open check remembers it, utils/takeover-unlock.ts). Each focus also runs that check; it throttles itself.
 */
import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { OWNER_WORDS_COPY as COPY, fetchOwnerWordsStatus, type OwnerWordsStatus } from '../utils/owner-words';
import { readLockPin, runLockOpenCheck } from '../utils/takeover-unlock';
import { formatDate, t, word, type WordKey } from '@beanpool/core';

/**
 * utils/owner-words.ts is on the 12 words' key path and never reaches the words layer: the rows' lines it writes are
 * translated here, by their exact English (utils/__tests__/settings-words-render.test.ts holds them to OWNER_WORDS_COPY).
 */
const ROW_LINES: Readonly<Record<string, WordKey>> = {
    'Check your 12 words': word('Check your 12 words'),
    "Your 12 words aren't checked. If you lose this phone you couldn't take over the server or open a backup.": word("Your 12 words aren't checked. If you lose this phone you couldn't take over the server or open a backup."),
    'Take over or restore with this phone': word('Take over or restore with this phone'),
    "If your main server is gone: scan the code on the standby's Settings, or on a server restoring a backup.": word("If your main server is gone: scan the code on the standby's Settings, or on a server restoring a backup."),
};

/** One of owner-words.ts's row lines in the member's language; anything else exactly as given. */
export function ownerRowWords(english: string): string {
    return Object.prototype.hasOwnProperty.call(ROW_LINES, english) ? t(ROW_LINES[english]) : english;
}

/** The Settings screen's own menu styles, so the row looks like every other row. */
interface MenuStyles {
    sectionHeader: any; menuGroup: any; menuBtn: any; menuBtnLast: any;
    menuIconWrap: any; menuIcon: any; menuText: any; menuSub: any; menuChevron: any;
}

export function OwnerWordsCard({ styles }: { styles: MenuStyles }) {
    const { identity } = useIdentity();
    const [status, setStatus] = useState<OwnerWordsStatus | null>(null);
    const [rememberedOwner, setRememberedOwner] = useState(false);

    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                if (!identity?.privateKey) { if (!cancelled) setStatus(null); return; }
                const pin = await readLockPin(AsyncStorage, identity.publicKey);
                if (!cancelled) setRememberedOwner(!!pin?.owner);
                const url = await getAnchorUrl();
                if (!url) { if (!cancelled) setStatus(null); return; }
                const got = await fetchOwnerWordsStatus(url, identity);
                if (!cancelled) setStatus(got);
                if (got?.owner) void runLockOpenCheck(url, identity, AsyncStorage);
            })().catch(() => { if (!cancelled) setStatus(null); });
            return () => { cancelled = true; };
        }, [identity])
    );

    // The node's answer decides; with no answer at all, what this phone remembers does (the main server may be gone).
    const owner = status ? status.owner : rememberedOwner;
    if (!owner) return null;
    // COPY.checked's sentence, its date through core's formatDate (it was the device's own date format).
    const sub = status?.wordsCheckedAt
        ? t('12 words checked {date}', { date: formatDate(new Date(status.wordsCheckedAt), 'day-month-year') })
        : ownerRowWords(COPY.notChecked);

    return (
        <>
            <Text style={styles.sectionHeader}>{t('COMMUNITY KEYS')}</Text>
            <View style={styles.menuGroup}>
                {status?.owner && (
                    <Pressable
                        style={[styles.menuBtn, { minHeight: 48 }]}
                        onPress={() => router.push('/owner-words-check')}
                        accessibilityRole="button"
                        accessibilityLabel={ownerRowWords(COPY.title)}
                        accessibilityHint={sub}
                    >
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔑</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>{ownerRowWords(COPY.title)}</Text>
                            <Text style={styles.menuSub}>{sub}</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                )}
                <Pressable
                    style={[styles.menuBtn, styles.menuBtnLast, { minHeight: 48 }]}
                    onPress={() => router.push('/unlock-keys')}
                    accessibilityRole="button"
                    accessibilityLabel={ownerRowWords(COPY.unlockTitle)}
                    accessibilityHint={ownerRowWords(COPY.unlockSub)}
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📲</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>{ownerRowWords(COPY.unlockTitle)}</Text>
                        <Text style={styles.menuSub}>{ownerRowWords(COPY.unlockSub)}</Text>
                    </View>
                    <Text style={styles.menuChevron}>›</Text>
                </Pressable>
            </View>
        </>
    );
}
