/**
 * Android's notification channels: their names and descriptions are what the phone's own settings list under BeanPool,
 * so they are written in the member's language (services/push-notifications.ts sets them each time it gets the token,
 * which also renames them after a language change). The channel ids are the server's categoryId and never change.
 */
import { t } from '@beanpool/core';

export interface NotificationChannel {
    id: 'default' | 'escrow' | 'chat' | 'marketplace' | 'recovery';
    name: string;
    description?: string;
    importance: 'MAX' | 'HIGH' | 'DEFAULT';
    vibrationPattern: number[];
    lightColor: string;
}

/** The channels, in the current language: made when they are set, never kept. */
export function notificationChannels(): NotificationChannel[] {
    return [
        { id: 'default', name: 'BeanPool', importance: 'MAX', vibrationPattern: [0, 250, 250, 250], lightColor: '#8b5cf6' },
        {
            id: 'escrow', name: t('Held in Trust Alerts'), description: t('Alerts for trust events (credits locked, released, cancelled)'),
            importance: 'HIGH', vibrationPattern: [0, 500, 250, 500], lightColor: '#059669',
        },
        {
            id: 'chat', name: t('Direct Messages'), description: t('Notifications for new messages'),
            importance: 'HIGH', vibrationPattern: [0, 250], lightColor: '#3b82f6',
        },
        {
            id: 'marketplace', name: t('Marketplace'), description: t('Requests and offers on your marketplace posts'),
            importance: 'DEFAULT', vibrationPattern: [0, 250, 250, 250], lightColor: '#8b5cf6',
        },
        // Recovery alerts are high-priority and must not be silenced by muting deal/marketplace notifications. Separate
        // channel means separate control.
        {
            id: 'recovery', name: t('Account Recovery Alerts'), description: t('Urgent alerts when someone tries to recover your account'),
            importance: 'MAX', vibrationPattern: [0, 500, 500, 500], lightColor: '#ef4444',
        },
    ];
}
