/**
 * The Agent panel's button in the sidebar's toolbar, next to the sidebar toggle. Shown only
 * where the browser can dock the panel (patch 0042) and the native host can run it (not in
 * incognito). It toggles the panel without taking the keyboard from the page.
 */
import { cmd, on } from './client';
import { incognito } from './incognito';

const button = document.getElementById('btn-agent') as HTMLButtonElement | null;
const surface = document.documentElement.dataset.surface;
const supported = surface === 'window' && !incognito && typeof chrome.anusPrivate?.setAgentPanel === 'function';

if (button && supported) {
  button.hidden = false;
  button.addEventListener('click', () => cmd('agentPanel:toggle')());
  on('agentPanel', (panel: { open: boolean }) => {
    button.setAttribute('aria-pressed', String(panel.open));
    button.classList.toggle('on', panel.open);
    button.dataset.tip = panel.open ? 'Hide Agent' : 'Agent';
  });
}
