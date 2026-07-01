export enum BeanPoolMode {
    SIMULATION = 'SIMULATION',
    LOCAL_MESH = 'LOCAL_MESH',
    FEDERATED = 'FEDERATED'
}

export const GlobalConfig = {
    // Attempt to read from Expo or Next.js environment variables, defaulting to SIMULATION
    MODE: (
        process.env.EXPO_PUBLIC_BEANPOOL_MODE ||
        process.env.NEXT_PUBLIC_BEANPOOL_MODE ||
        BeanPoolMode.SIMULATION
    ) as BeanPoolMode,
};
