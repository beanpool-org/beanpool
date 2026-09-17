import * as Haptics from 'expo-haptics';

/** Deal done, escrow released, transfer sent — the "payday" pulse */
export const hapticSuccess = () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

/** Gate rejection, error, cancelled escrow — the "stop" buzz */
export const hapticWarning = () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});

/** Clipboard copy, avatar pick, vote stepper tap — the "tick" */
export const hapticTick = () =>
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
