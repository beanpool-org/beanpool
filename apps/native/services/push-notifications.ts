import * as Device from 'expo-device';
import { Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { signedRequest } from '../utils/db';
import { loadIdentity } from '../utils/identity';
import { buildSignedHeaders } from '../utils/crypto';

const isExpoGo = Constants.appOwnership === 'expo';
let Notifications: any = null;

if (!isExpoGo) {
    try {
        Notifications = require('expo-notifications');
        // Configure how notifications appear when app is in foreground
        Notifications.setNotificationHandler({
            handleNotification: async () => ({
                shouldShowAlert: true,
                shouldPlaySound: true,
                shouldSetBadge: true,
                shouldShowBanner: true,
                shouldShowList: true,
            }),
        });
    } catch (e) {
        console.warn('Failed to load expo-notifications', e);
    }
}

/**
 * Registers for Expo Push Notifications and transmits the token to the BeanPool server.
 * Should be called once the user is logged in and has an identity.
 */
export async function registerForPushNotifications(publicKey: string): Promise<string | null> {
    if (isExpoGo || !Notifications) {
        console.log('[Push] Push notifications are not available in Expo Go');
        return null;
    }

    // Push notifications only work on physical devices
    if (!Device.isDevice) {
        console.log('[Push] Push notifications are not available on simulator/emulator');
        return null;
    }

    // Check existing permission
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    // Request permission if not already granted
    if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
    }

    if (finalStatus !== 'granted') {
        console.log('[Push] Push notification permission denied');
        return null;
    }

    try {
        // Get the Expo Push Token
        const projectId = Constants.expoConfig?.extra?.eas?.projectId;
        const tokenData = await Notifications.getExpoPushTokenAsync({
            projectId: projectId || '17a2a61a-9cbe-457e-bb10-84d8a666e6eb',
        });
        const token = tokenData.data;
        console.log('[Push] Expo push token:', token);

        // Store locally
        await AsyncStorage.setItem('bp_push_token', token);

        // Register with the BeanPool server
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (anchorUrl) {
            try {
                await signedRequest('/api/push-tokens', { publicKey, token, platform: Platform.OS });
                console.log('[Push] Token registered with server');
            } catch (e: any) {
                console.warn('[Push] Failed to register token with server:', e?.message || e);
            }
        }

        // Set up Android notification channel
        if (Platform.OS === 'android') {
            await Notifications.setNotificationChannelAsync('default', {
                name: 'BeanPool',
                importance: Notifications.AndroidImportance.MAX,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#8b5cf6',
            });

            await Notifications.setNotificationChannelAsync('escrow', {
                name: 'Held in Trust Alerts',
                importance: Notifications.AndroidImportance.HIGH,
                vibrationPattern: [0, 500, 250, 500],
                lightColor: '#059669',
                description: 'Alerts for trust events (credits locked, released, cancelled)',
            });

            await Notifications.setNotificationChannelAsync('chat', {
                name: 'Direct Messages',
                importance: Notifications.AndroidImportance.HIGH,
                vibrationPattern: [0, 250],
                lightColor: '#3b82f6',
                description: 'Notifications for new messages',
            });

            await Notifications.setNotificationChannelAsync('marketplace', {
                name: 'Marketplace',
                importance: Notifications.AndroidImportance.DEFAULT,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#8b5cf6',
                description: 'Requests and offers on your marketplace posts',
            });
        }

        return token;
    } catch (error) {
        console.error('[Push] Error getting push token:', error);
        return null;
    }
}

/**
 * Removes the push token from the server (e.g., on logout).
 */
export async function unregisterPushToken(publicKey: string): Promise<void> {
    if (isExpoGo || !Notifications) return;

    try {
        const token = await AsyncStorage.getItem('bp_push_token');
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        const identity = await loadIdentity();

        if (anchorUrl && token && identity) {
            // DELETE /api/push-tokens is a protected (deny-by-default) mutating route — it
            // must be Ed25519-signed or the server 401s and the token is never removed
            // server-side (so the device keeps receiving pushes after logout).
            const bodyString = JSON.stringify({ publicKey, token });
            const headers = await buildSignedHeaders('DELETE', '/api/push-tokens', bodyString, identity.privateKey, identity.publicKey);
            await fetch(`${anchorUrl}/api/push-tokens`, {
                method: 'DELETE',
                headers,
                body: bodyString,
            });
        }

        await AsyncStorage.removeItem('bp_push_token');
        console.log('[Push] Token unregistered');
    } catch (error) {
        console.warn('[Push] Error unregistering token:', error);
    }
}

/**
 * Sets up notification response listener for deep linking.
 * Call this in the root layout to handle taps on push notifications.
 * Returns a subscription that should be cleaned up on unmount.
 */
export function setupNotificationResponseHandler() {
    if (isExpoGo || !Notifications) {
        return { remove: () => {} };
    }

    const subscription = Notifications.addNotificationResponseReceivedListener((response: any) => {
        const data = response.notification.request.content.data;
        
        if (data?.screen === 'post' && data?.postId) {
            // Navigate directly to the post (escrow detail screen)
            router.push(`/post/${data.postId}`);
        } else if (data?.screen === 'chat' && data?.conversationId) {
            // Navigate to the specific chat thread
            router.push(`/chat/${data.conversationId}`);
        }
    });

    return subscription;
}
