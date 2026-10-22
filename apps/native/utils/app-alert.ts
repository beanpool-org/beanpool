/**
 * An Alert from code that also runs outside React Native, as utils/app-events.ts reaches DeviceEventEmitter: utils/db.ts
 * is loaded by the vitest suite in plain Node, where React Native can't be imported, and a lazy `require` there throws
 * rather than giving a mock. So the rule that decides WHETHER to say something stays where it is, tested by mocking this
 * module, and only the plumbing is here.
 */
export function showAppAlert(title: string, body: string): void {
    try {
        const { Alert } = require('react-native');
        Alert.alert(title, body);
    } catch {
        // Not in a React Native runtime (vitest, a script): nobody to tell.
    }
}
