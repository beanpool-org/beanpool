import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { BEANPOOL_WEBSITE_URL } from '@beanpool/core';

/**
 * Open beanpool.org in the browser (an in-app browser tab), from Settings and from the BeanPool sheet.
 *
 * Not Linking.openURL: while the Android app links still claim all of beanpool.org, handing the URL to the system
 * can route it straight back into this app. The browser tab opens the page itself. If no browser can be opened,
 * fall back to the system.
 */
export async function openBeanPoolWebsite(): Promise<void> {
    try {
        await WebBrowser.openBrowserAsync(BEANPOOL_WEBSITE_URL);
    } catch {
        await Linking.openURL(BEANPOOL_WEBSITE_URL).catch(() => {});
    }
}
