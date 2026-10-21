import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { usePwaInstall } from '../hooks/usePwaInstall.js';

/**
 * Android/Chromium: capture beforeinstallprompt and offer Install.
 * iOS Safari (not standalone): one-time Add to Home Screen hint.
 * Dismissed for 14 days — use the mobile sidebar "Install app" to try again.
 */
export function InstallPrompt() {
    const { installMode, wasDismissed, triggerNativeInstall, dismissInstallPrompt } = usePwaInstall();
    const [visible, setVisible] = useState(false);
    const location = useLocation();
    // Not for outside requesters or before sign-in, and never on top of a
    // form's action bar (Receive / Dispatch).
    const tab = new URLSearchParams(location.search).get('tab');
    const suppressed =
        location.pathname === '/login' ||
        location.pathname === '/request' ||
        tab === 'receive' ||
        tab === 'dispatch';

    useEffect(() => {
        if (installMode === 'installed' || wasDismissed) return;
        if (installMode === 'native' || installMode === 'ios') {
            setVisible(true);
        }
    }, [installMode, wasDismissed]);

    if (!visible || suppressed || installMode === 'installed') return null;

    const onDismiss = () => {
        dismissInstallPrompt();
        setVisible(false);
    };

    const onInstall = async () => {
        await triggerNativeInstall();
        setVisible(false);
    };

    return (
        <div className="pwa-install" role="dialog" aria-label="Install Stellar Matter">
            <div className="pwa-install-body">
                <p className="pwa-install-title">Install Stellar Matter</p>
                {installMode === 'ios' ? (
                    <p className="pwa-install-msg">
                        Tap <strong>Share</strong> then <strong>Add to Home Screen</strong> for the app icon.
                    </p>
                ) : (
                    <p className="pwa-install-msg">Add to your home screen for faster access on the go.</p>
                )}
            </div>
            <div className="pwa-install-actions">
                {installMode === 'native' && (
                    <button type="button" className="btn-primary pwa-install-btn" onClick={onInstall}>
                        Install
                    </button>
                )}
                <button type="button" className="chip chip-tool" onClick={onDismiss}>
                    Not now
                </button>
            </div>
        </div>
    );
}
