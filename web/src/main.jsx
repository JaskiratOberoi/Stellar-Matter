import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { App } from './App.jsx';
import { initPwa } from './pwa.js';
import { initPwaInstallCapture } from './lib/pwaInstall.js';
import './styles/tokens.css';

initPwa();
initPwaInstallCapture();

const root = createRoot(document.getElementById('root'));
root.render(
    <StrictMode>
        <BrowserRouter>
            <AuthProvider>
                <App />
            </AuthProvider>
        </BrowserRouter>
    </StrictMode>
);
