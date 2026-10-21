import { registerSW } from 'virtual:pwa-register';

/**
 * Registers the service worker and shows a themed toast when a new build
 * is waiting. Call `updateSW(true)` to activate and reload.
 */
export function initPwa() {
    if (typeof window === 'undefined') return;

    const updateSW = registerSW({
        immediate: true,
        onNeedRefresh() {
            showUpdateToast(() => updateSW(true));
        },
        onOfflineReady() {
            // App shell is cached; no toast — quiet offline readiness.
        }
    });
}

function showUpdateToast(onRefresh) {
    if (document.getElementById('pwa-update-toast')) return;

    // Receive / Dispatch keep unsaved entries as drafts that come back after a
    // reload, so refreshing mid-entry is safe; say so rather than leave the
    // operator guessing.
    let hasDraft = false;
    try {
        hasDraft = ['stellar-matter.draft.receive', 'stellar-matter.draft.dispatch'].some((k) => localStorage.getItem(k));
    } catch {
        hasDraft = false;
    }
    const toast = document.createElement('div');
    toast.id = 'pwa-update-toast';
    toast.className = 'pwa-toast';
    toast.setAttribute('role', 'status');
    toast.innerHTML = `
        <span class="pwa-toast-msg">New version available${hasDraft ? ' · your unsaved entry comes back after refreshing' : ''}</span>
        <button type="button" class="pwa-toast-btn">Refresh</button>
        <button type="button" class="pwa-toast-dismiss" aria-label="Dismiss">×</button>
    `;
    document.body.appendChild(toast);

    toast.querySelector('.pwa-toast-btn').addEventListener('click', () => {
        toast.remove();
        onRefresh();
    });
    toast.querySelector('.pwa-toast-dismiss').addEventListener('click', () => {
        toast.remove();
    });
}
