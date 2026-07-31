const DISMISS_KEY = 'stellar_matter_install_dismissed';
const DISMISS_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

/** @type {BeforeInstallPromptEvent | null} */
let deferredPrompt = null;

/** @type {Set<() => void>} */
const subscribers = new Set();

function notify() {
    subscribers.forEach((cb) => cb());
}

/** Call once at app boot to capture Chromium install prompt. */
export function initPwaInstallCapture() {
    if (typeof window === 'undefined') return;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        notify();
    });
}

/** @param {() => void} cb */
export function subscribePwaInstall(cb) {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
}

export function isStandalone() {
    if (typeof window === 'undefined') return false;
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true
    );
}

export function isIosSafari() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const webkit = /WebKit/.test(ua);
    const notOther = !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua);
    return iOS && webkit && notOther;
}

export function wasInstallDismissed() {
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

export function dismissInstallPrompt() {
    try {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
        /* ignore */
    }
}

export function canNativeInstall() {
    return deferredPrompt != null;
}

/** @returns {'installed' | 'native' | 'ios' | 'manual'} */
export function getInstallMode() {
    if (isStandalone()) return 'installed';
    if (canNativeInstall()) return 'native';
    if (isIosSafari()) return 'ios';
    return 'manual';
}

export async function triggerNativeInstall() {
    if (!deferredPrompt) return { ok: false, reason: 'unavailable' };
    const prompt = deferredPrompt;
    prompt.prompt();
    try {
        const choice = await prompt.userChoice;
        deferredPrompt = null;
        notify();
        dismissInstallPrompt();
        return { ok: choice.outcome === 'accepted', outcome: choice.outcome };
    } catch {
        return { ok: false, reason: 'error' };
    }
}
