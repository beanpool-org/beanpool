/**
 * The community's name for the invite message (front doors S10, core inviteShareText), read from its public card but never
 * waited for long: a member sharing an invite from a village with one bar of signal must not stare at a Share button that
 * does nothing (the card read alone may take 15 s, utils/peek.ts). Past `waitMs`, or on any failure, the address names it.
 */
export async function shareCommunityName(
    address: string,
    fetchName: () => Promise<string>,
    waitMs = 2000,
): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            fetchName().then((name) => (name && name.trim() ? name : address), () => address),
            new Promise<string>((resolve) => { timer = setTimeout(() => resolve(address), waitMs); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
