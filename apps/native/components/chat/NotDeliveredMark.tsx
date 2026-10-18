/**
 * "! not delivered", trailing a failed message's time in every chat: tapping the bubble offers Resend or Discard.
 * Its words are one sentence of their own, after a space; the space stays outside them.
 */

import React from 'react';
import { Text } from 'react-native';
import { t } from '@beanpool/core';

export function NotDeliveredMark({ color }: { color: string }) {
    return (
        <Text style={{ fontSize: 10, color, fontWeight: '800' }}>
            {' '}
            <Text>{t('! not delivered')}</Text>
        </Text>
    );
}
