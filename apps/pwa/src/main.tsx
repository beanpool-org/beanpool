import { StrictMode, Component, type ReactNode, type ErrorInfo } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyPatternPreference } from './lib/usePatternBackground';
import { captureAuthReturn } from './lib/web-join';
import './index.css';

// A sign-in returning to /app/auth/<provider> carries its token in the fragment: read it and take it out of the
// address bar and the history before anything else runs, whoever is signed in here (lib/web-join.ts). The join
// screens pick it up from there.
captureAuthReturn();

// Before the first paint, so "plain background" never flashes the pattern in.
applyPatternPreference();

/**
 * Inter, from Google Fonts. Added from here rather than as a <link> in index.html: a stylesheet the page's <head>
 * names holds the first paint until Google answers (on a slow or filtered network, for a long time), and the old way
 * around that, an inline `onload`, is script the app document's CSP refuses (apps/server/src/app-document-csp.ts).
 * A stylesheet added by script never holds the paint: the app draws in the system font and switches when Inter
 * arrives (display=swap), as it did before.
 */
function loadWebFont(): void {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(link);
}
loadWebFont();

// Error boundary to catch and display React rendering errors
class ErrorBoundary extends Component<
    { children: ReactNode },
    { error: Error | null }
> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('React error boundary caught:', error, info);
    }

    render() {
        if (this.state.error) {
            return (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    minHeight: '100vh',
                    padding: '2rem',
                    color: '#ef4444',
                    textAlign: 'center',
                    fontFamily: 'monospace',
                }}>
                    <h1>⚠️ BeanPool Error</h1>
                    <p style={{ color: '#888', margin: '1rem 0' }}>
                        The app failed to load. Error details:
                    </p>
                    <pre style={{
                        background: '#1a1a1a',
                        padding: '1rem',
                        borderRadius: '8px',
                        maxWidth: '90vw',
                        overflow: 'auto',
                        fontSize: '0.8rem',
                        color: '#ff6b6b',
                    }}>
                        {this.state.error.message}
                    </pre>
                </div>
            );
        }
        return this.props.children;
    }
}

try {
    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <ErrorBoundary>
                <App />
            </ErrorBoundary>
        </StrictMode>
    );
} catch (err) {
    console.error('[BeanPool] FATAL:', err);
    const root = document.getElementById('root');
    if (root) {
        // SECURITY (PWA-1): build the DOM with textContent rather than
        // interpolating the error message into innerHTML. The private key lives
        // in IndexedDB on this origin, so an unescaped message reaching innerHTML
        // would be a script-execution → key-exfiltration sink.
        root.replaceChildren();
        const wrap = document.createElement('div');
        wrap.setAttribute('style', 'color: #ef4444; padding: 2rem; font-family: monospace; text-align: center;');
        const h1 = document.createElement('h1');
        h1.textContent = '⚠️ BeanPool failed to start';
        const pre = document.createElement('pre');
        pre.setAttribute('style', 'color: #ff6b6b; margin-top: 1rem;');
        pre.textContent = (err as Error)?.message ?? String(err);
        wrap.append(h1, pre);
        root.append(wrap);
    }
}
