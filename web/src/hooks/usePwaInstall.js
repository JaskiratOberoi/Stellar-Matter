import { useCallback, useEffect, useState } from 'react';
import {
    canNativeInstall,
    getInstallMode,
    isStandalone,
    subscribePwaInstall,
    triggerNativeInstall,
    wasInstallDismissed,
    dismissInstallPrompt as dismissInstall,
} from '../lib/pwaInstall.js';

/** Reactive install state for InstallPrompt + mobile sidebar. */
export function usePwaInstall() {
    const [, bump] = useState(0);

    useEffect(() => subscribePwaInstall(() => bump((n) => n + 1)), []);

    const installMode = getInstallMode();
    const standalone = isStandalone();

    return {
        installMode,
        isStandalone: standalone,
        canNativeInstall: canNativeInstall(),
        wasDismissed: wasInstallDismissed(),
        triggerNativeInstall: useCallback(() => triggerNativeInstall(), []),
        dismissInstallPrompt: useCallback(() => dismissInstall(), []),
    };
}
