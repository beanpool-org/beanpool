/**
 * A sentence with emphasis, kept whole for a translator (design §2.1: rich text keeps the repo's `**bold**` convention,
 * so a sentence stays one string): `richWords(t('Your **Trust** grows…'), styles.bold)` draws each `**…**` run in
 * `bold` (core's splitBold), and each `{name}` given in `parts` as that element (the currency mark, which is an image).
 * A placeholder not in `parts` stays as written. Goes inside a <Text>, whose style the rest of the sentence keeps.
 */
import React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { splitBold } from '@beanpool/core';

export function richWords(sentence: string, bold: StyleProp<TextStyle>, parts: Readonly<Record<string, React.ReactNode>> = {}): React.ReactNode[] {
    return splitBold(sentence).map((run, i) => {
        const pieces = run.text.split(/\{([A-Za-z0-9_]+)\}/).map((piece, j) => {
            if (j % 2 === 0) return piece;
            return Object.prototype.hasOwnProperty.call(parts, piece) ? <React.Fragment key={j}>{parts[piece]}</React.Fragment> : `{${piece}}`;
        }).filter((piece) => piece !== '');
        return run.bold ? <Text key={i} style={bold}>{pieces}</Text> : <React.Fragment key={i}>{pieces}</React.Fragment>;
    });
}
