/**
 * A member's copy of an Offer or a Need on a Market card, where its author's name would be (slice G1′): where it is from and its
 * price there, in words. Apart from the copy's page (ListingCopy.tsx), so the Market loads nothing of that page.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { copyPriceLine, type EventCopy } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';

export function ListingCopyLine({ copy }: { copy: EventCopy }) {
    const styles = useStyles(makeStyles);
    return <Text style={styles.line} numberOfLines={4} testID="listing-copy-line">{copyPriceLine(copy)}</Text>;
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    line: { fontSize: 12, fontWeight: '600', color: colors.text.secondary, marginTop: 4, lineHeight: 16 },
});
