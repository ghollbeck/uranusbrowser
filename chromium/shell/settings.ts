/**
 * The Settings page in the Chromium shell: Electron's Settings renderer as is, with
 * `window.settings` provided over the hub. Imports run in order, so the API is in place
 * before ui/settings.ts reads it. ui/aiPane.ts is the Chromium build's own AI pane.
 */
import './noPageMenu';
import './lib/themeFade';
import './settingsApi';
import './ui/settings';
import './ui/aiPane';
