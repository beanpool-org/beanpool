import React, { createContext, useContext, useState, useEffect } from 'react';
import { loadIdentity, BeanPoolIdentity } from '../utils/identity';

interface IdentityContextState {
    identity: BeanPoolIdentity | null;
    isLoading: boolean;
    setIdentity: (identity: BeanPoolIdentity | null) => void;
}

const IdentityContext = createContext<IdentityContextState>({
    identity: null,
    isLoading: true,
    setIdentity: () => {},
});

export function IdentityProvider({ children }: { children: React.ReactNode }) {
    const [identity, setIdentity] = useState<BeanPoolIdentity | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        loadIdentity()
            .then((loaded) => {
                setIdentity(loaded);
            })
            .catch((err) => {
                console.error("Failed to load native identity", err);
            })
            .finally(() => {
                setIsLoading(false);
            });
    }, []);

    return (
        <IdentityContext.Provider value={{ identity, isLoading, setIdentity }}>
            {children}
        </IdentityContext.Provider>
    );
}

export function useIdentity() {
    return useContext(IdentityContext);
}

// Dummy default export to satisfy Expo Router's requirement for all files in app/
export default function IdentityContextRoute() {
    return null;
}
