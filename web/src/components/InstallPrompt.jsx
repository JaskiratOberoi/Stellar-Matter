import { useEffect, useState } from 'react';

const DISMISS_KEY = 'stellar_matter_install_dismissed';
const DISMISS_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function isStandalone() {
    if (typeof window === 'undefined') return false;
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        // iOS Safari legacy flag
        window.navigator.standalone === true
    );
}

function isIosSafari() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const webkit = /WebKit/.test(ua);
    const notOther = !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua);
    return iOS && webkit && notOther;
}

function wasDismissed() {
    try {
        const raw = localStorage.getItem(DISMISS_KEY);
        if (!raw) return false;
        const at = Number(raw);
        if (!Number.isFinite(at)) return false;
        return Date.now() - at < DISMISS_MS;
    } catch {
        return false;
    }
}

function dismiss() {
    try {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
        /* ignore */
    }
}

/**
 * Android/Chromium: capture beforeinstallprompt and offer Install.
 * iOS Safari (not standalone): one-time Add to Home Screen hint.
 */
export function InstallPrompt() {
    const [deferred, setDeferred] = useState(null);
    const [showIos, setShowIos] = useState(false);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (isStandalone() || wasDismissed()) return undefined;

        const onBip = (e) => {
            e.preventDefault();
            setDeferred(e);
            setVisible(true);
        };
        window.addEventListener('beforeinstallprompt', onBip);

        if (isIosSafari()) {
            setShowIos(true);
            setVisible(true);
        }

        return () => window.removeEventListener('beforeinstallprompt', onBip);
    }, []);

    if (!visible) return null;

    const onDismiss = () => {
        dismiss();
        setVisible(false);
        setDeferred(null);
        setShowIos(false);
    };

    const onInstall = async () => {
        if (!deferred) return;
        deferred.prompt();
        try {
            await deferred.userChoice;
        } catch {
            /* ignore */
        }
        setDeferred(null);
        setVisible(false);
        dismiss();
    };

    return (
        <div className="pwa-install" role="dialog" aria-label="Install Stellar Matter">
            <div className="pwa-install-body">
                <p className="pwa-install-title">Install Stellar Matter</p>
                {showIos && !deferred ? (
                    <p className="pwa-install-msg">
                        Tap <strong>Share</strong> then <strong>Add to Home Screen</strong> for the app icon.
                    </p>
                ) : (
                    <p className="pwa-install-msg">Add to your home screen for faster access on the go.</p>
                )}
            </div>
            <div className="pwa-install-actions">
                {deferred && (
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
