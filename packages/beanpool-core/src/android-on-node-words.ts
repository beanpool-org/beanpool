/**
 * The words of the Android APK a node serves on its local network (lights-out H3): the node's `/android` page
 * (apps/server/src/routes/android.ts) and the web app's link to it (apps/pwa, the welcome screen). The page's install steps
 * and its same-app and certificate sentences are the website's own (apps/website/android.html), so their translations are
 * the website's too.
 */
import { word } from './words.js';

export const ANDROID_ON_NODE_WORDS = {
    /** The link on the web app's welcome screen and the server's trust page, shown only to a phone on the local network. */
    getApp: word('Get the Android app'),
    title: word('BeanPool for Android, as a download'),
    fromHere: word("This copy comes from this community's server, over this Wi-Fi. It needs no internet."),
    sameApp: word('This is the same app as on Google Play, signed by the same key.'),
    download: word('Download BeanPool {version} APK'),
    facts: word('Version {version}, an APK file of {mb} MB.'),
    fileDigest: word("The file's SHA-256: {sha256}"),
    installHeading: word('Install it'),
    stepOpen: word("Open the file once it has downloaded: tap it in the notification, or find it in your phone's Downloads."),
    stepAllow: word('The first time, Android asks you to let your browser install apps. Allow it in the settings that open, then go back.'),
    stepConfirm: word('Confirm the install. If BeanPool is already on your phone, Android calls it an update. Then open BeanPool.'),
    certificate: word('This file is signed with the same key as BeanPool on Google Play. The SHA-256 fingerprint of its certificate is:'),
    noneYet: word("This server holds no copy of the Android app yet. Ask the person who runs it, or get the app from beanpool.org/android when you are online."),
} as const;
