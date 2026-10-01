/**
 * Background Task Registration
 *
 * Registers the Pillar Sync as an Expo Background Fetch task.
 * iOS gives ~30 seconds every 15-60 minutes.
 * Android is more lenient but still limited.
 *
 * The sync engine is designed to fit within these constraints
 * via the 20-second fail-fast timeout.
 */

import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { performSync } from './pillar-sync';

const TASK_NAME = 'BEANPOOL_PILLAR_SYNC';

/**
 * Define the background task.
 * This runs when the OS wakes the app.
 */
TaskManager.defineTask(TASK_NAME, async () => {
    console.log('[Pillar] Background task woke up');

    try {
        const result = await performSync();

        console.log(`[Pillar] Sync complete:`, {
            success: result.success,
            delta: result.deltaCount,
            duration: `${result.durationMs}ms`,
            aborted: result.aborted,
        });

        // The floor under push (utils/sync-notices.ts): the member's unseen notices from their own community, posted
        // on the phone, each once. No push service involved.
        try {
            const { postNoticesAfterSync } = await import('./push-notifications');
            const posted = await postNoticesAfterSync();
            if (posted > 0) console.log(`[Pillar] Posted ${posted} notice(s) from the sync`);
        } catch (e) {
            console.warn('[Pillar] The sync\'s notices were not posted:', e);
        }

        if (result.success || result.deltaCount > 0) {
            // Tell the OS we got new data (improves wake-up frequency)
            return BackgroundFetch.BackgroundFetchResult.NewData;
        }

        return BackgroundFetch.BackgroundFetchResult.NoData;
    } catch (err) {
        console.error('[Pillar] Background task error:', err);
        return BackgroundFetch.BackgroundFetchResult.Failed;
    }
});

/**
 * Register the background fetch task.
 * Should be called once on app startup.
 */
export async function registerPillarSync(): Promise<void> {
    const status = await BackgroundFetch.getStatusAsync();

    if (status === BackgroundFetch.BackgroundFetchStatus.Denied) {
        console.warn('[Pillar] Background fetch is denied by the OS');
        return;
    }

    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (isRegistered) {
        console.log('[Pillar] Background task already registered');
        return;
    }

    await BackgroundFetch.registerTaskAsync(TASK_NAME, {
        minimumInterval: 15 * 60,    // 15 minutes (iOS minimum)
        stopOnTerminate: false,       // Keep running after app is swiped away
        startOnBoot: true,            // Restart after device reboot
    });

    console.log('[Pillar] Background sync task registered');
}

/**
 * Unregister the background task.
 */
export async function unregisterPillarSync(): Promise<void> {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
    if (isRegistered) {
        await BackgroundFetch.unregisterTaskAsync(TASK_NAME);
        console.log('[Pillar] Background sync task unregistered');
    }
}
