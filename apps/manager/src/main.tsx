import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { installTokenFetchGuard } from './lib/token-guard';

// A profile's automation token never reaches an owner-only route: said here, before the request (lib/token-guard.ts).
installTokenFetchGuard();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
