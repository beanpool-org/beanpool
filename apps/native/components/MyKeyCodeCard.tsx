/**
 * Settings → Account Protection → "My key code" (DESIGN-dm-peer-key-pin §3.5, slice 2): the same 20 digits the other
 * person's phone shows on a "key changed" banner, for the two of them to compare in person. Worked out from the key each
 * time (utils/key-code.ts); nothing is stored or sent.
 */
import React from 'react';
import { View, Text } from 'react-native';
import { t } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { dmKeyChangeStyleSpec, MY_KEY_CODE_COPY } from '../utils/dm-key-change';
import { keyCodeOf, keyCodeSpoken } from '../utils/key-code';

export function MyKeyCodeCard({ publicKey }: { publicKey?: string | null }) {
    const styles = useStyles(({ colors }) => dmKeyChangeStyleSpec(colors));
    const code = keyCodeOf(publicKey);
    return (
        <View style={styles.myCodeCard}>
            <Text style={styles.myCodeTitle} accessibilityRole="header">{t(MY_KEY_CODE_COPY.title)}</Text>
            {code ? (
                <View style={styles.codeBox}>
                    <Text style={styles.myCode} accessibilityLabel={t('My key code: {code}', { code: keyCodeSpoken(code) })} selectable>{code}</Text>
                </View>
            ) : null}
            <Text style={styles.myCodeBody}>{code ? t(MY_KEY_CODE_COPY.body) : t(MY_KEY_CODE_COPY.unknown)}</Text>
        </View>
    );
}
