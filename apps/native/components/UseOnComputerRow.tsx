/**
 * Settings → Account & identity → "Use BeanPool on a computer: open <the community's address>", with Copy and Share. For
 * EVERY member, owners and moderators too (Jay, a Byron member, 13 Nov 2026: Settings "didn't get me anywhere ... wasn't up
 * on everything enough to know if the desktop app was just this here in the browser"). There is no desktop app: BeanPool on
 * a computer is the web app, at the community's own address, in any browser, with the same account (Link a device, the row
 * under this one, brings the account across).
 *
 * Not the owners' "Manage this community from a computer" (components/NodeAdminEntry.tsx), which signs a computer's browser
 * into the community's Settings page and is for owners, admins and moderators only; an owner sees both rows. This one
 * asks the node nothing and waits for no role, so it never moves or blinks in when the role answers.
 *
 * The address is the one this phone uses for its community (utils/node-post.ts anchorUrl), read again each time Settings
 * comes into view and when the phone switches community. The line's words are core's (use-on-computer.ts), shared with the
 * web app's Settings so the two say the same thing. No address (none saved yet, or not an http(s) address): no row, never a
 * line with a blank in it.
 *
 * 320 dp at 1.3x text: the sentence wraps, the address sits under it on its own and wraps by letter (selectable, so a member
 * can pick it up by hand if the clipboard refuses), and the two 48 dp buttons sit side by side or stack, never cut.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, Share, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { t, USE_ON_COMPUTER_WORDS, addressToOpenOnAComputer } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { onCommunitySwitched } from '../utils/community-switch';
import { useCopyMessage } from './chat/useCopyMessage';

export function UseOnComputerRow() {
    // The row's own table, with Settings' menu-row values (app/(tabs)/settings.tsx: menuBtn, menuIconWrap, menuIcon, menuText), so it
    // looks like every other row. It is not handed Settings' `styles`: the contrast check (e2e/button-contrast.check.ts) cannot read a
    // table passed in as a prop, and a row whose colours it cannot read is a row it cannot check in Light, Classic and Dark.
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'flex-start', padding: 14, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle },
        iconWrap: {
            width: 36, height: 36, borderRadius: 12,
            backgroundColor: theme === 'dark' ? 'rgba(34, 197, 94, 0.15)' : palette.green50,
            justifyContent: 'center', alignItems: 'center', marginRight: 12,
        },
        icon: { fontSize: 18 },
        column: { flex: 1 },
        text: { fontSize: 15, fontWeight: '600', color: colors.text.body },
        address: { fontSize: 15, fontWeight: '700', color: colors.text.body },
        buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
        button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', borderColor: colors.border.strong, backgroundColor: colors.surface.card },
        buttonText: { fontSize: 14, fontWeight: '700', textAlign: 'center', color: colors.text.heading },
    }));
    const [address, setAddress] = useState<string | null>(null);
    // The same hook as a chat message's Copy: the address on the clipboard, "Copied" for a moment, or "Could not copy".
    const { answer, copy } = useCopyMessage(address ?? undefined);

    useFocusEffect(
        useCallback(() => {
            let live = true;
            // Only the latest ask's answer is shown: an earlier one still on its way never puts back an older community's.
            let latest = 0;
            const read = () => {
                const mine = ++latest;
                getAnchorUrl()
                    .then((url) => { if (live && mine === latest) setAddress(addressToOpenOnAComputer(url)); })
                    .catch(() => { if (live && mine === latest) setAddress(null); });
            };
            read();
            const off = onCommunitySwitched(() => { if (live) { setAddress(null); read(); } });
            return () => { live = false; off(); };
        }, []),
    );

    if (!address) return null;

    const line = t(USE_ON_COMPUTER_WORDS.phoneLine, { address });
    // The address is one unbreakable word, longer than a 320 dp column at 1.3x text, so it gets its own block under the
    // lead-in, which wraps it by letter (as the follow card's address does) and lets it be picked up by hand. To a screen
    // reader it is still one line: the whole sentence.

    return (
        <View style={styles.row} testID="settings-use-on-computer">
            <View style={styles.iconWrap}><Text style={styles.icon}>💻</Text></View>
            <View style={styles.column}>
                <View accessible accessibilityLabel={line}>
                    <Text style={styles.text}>{t(USE_ON_COMPUTER_WORDS.phoneLead)}</Text>
                    <Text style={styles.address} selectable>{address}</Text>
                </View>
                <View style={styles.buttons}>
                    <Pressable
                        style={styles.button}
                        onPress={() => { copy().catch(() => {}); }}
                        accessibilityRole="button"
                        accessibilityLabel={t('Copy')}
                        testID="settings-use-on-computer-copy"
                    >
                        <Text style={styles.buttonText}>{answer === 'copied' ? t('Copied') : answer === 'failed' ? t('Could not copy') : t('Copy')}</Text>
                    </Pressable>
                    <Pressable
                        style={styles.button}
                        onPress={() => { Share.share({ message: line }).catch(() => {}); }}
                        accessibilityRole="button"
                        accessibilityLabel={t('Share')}
                        testID="settings-use-on-computer-share"
                    >
                        <Text style={styles.buttonText}>{t('Share')}</Text>
                    </Pressable>
                </View>
            </View>
        </View>
    );
}
