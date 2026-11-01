// Builds the script that runs inside Antigravity: the vendored md3e-web
// components, the theme modules and the theme host, started with a bundle
// read from themes/index.json (each theme's CSS, its fonts as base64, and
// the choices in the Theme menu).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The components come first: the indicator modules need them defined.
const MODULES = [
  'vendor/md3e/components.js',
  'src/context-card.js',
  'src/turn-tokens.js',
  'src/loading-indicator.js',
  'src/progress-indicators.js',
  'src/code-tools.js',
  'src/theme-host.js',
];

export function loadBundle(root = ROOT) {
  const themesDir = path.join(root, 'themes');
  const index = JSON.parse(readFileSync(path.join(themesDir, 'index.json'), 'utf8'));
  const themes = {};
  for (const [id, files] of Object.entries(index.themes)) {
    themes[id] = [].concat(files).map((file) => readFileSync(path.join(themesDir, file), 'utf8')).join('\n');
  }
  const fonts = {};
  for (const [id, list] of Object.entries(index.fonts ?? {})) {
    fonts[id] = list.map(({ file, ...descriptors }) => ({
      ...descriptors,
      data: readFileSync(path.join(themesDir, file)).toString('base64'),
    }));
  }
  return { default: index.default, themes, fonts, ripple: index.ripple ?? [], options: index.options };
}

// On a new document the script runs before the parser has created <html>,
// so it waits for that element; the host then waits for the rest itself.
export function pageScript(root = ROOT) {
  const parts = MODULES.map((file) => readFileSync(path.join(root, file), 'utf8'));
  return `(() => {
const start = () => {
${parts.join('\n;')}
;agyThemeHost(${JSON.stringify(loadBundle(root))});
};
if (document.documentElement) start();
else new MutationObserver((_, observer) => {
  if (!document.documentElement) return;
  observer.disconnect();
  start();
}).observe(document, { childList: true });
})();`;
}

// Undoes everything the page script did in that window
export const REMOVE_SCRIPT = `(() => {
  window.__agyThemeHost?.dispose();
  document.getElementById('agy-theme-css')?.remove();
  document.documentElement?.removeAttribute('data-agy-theme');
})();`;

// The theme host's version and theme in a window, or null without one
export const PROBE_SCRIPT = `JSON.stringify(window.__agyThemeHost ? { version: window.__agyThemeHost.version, theme: window.__agyThemeHost.get() } : null)`;

export const selectScript = (key) => `(() => {
  const host = window.__agyThemeHost;
  if (!host) return 'no-host';
  if (!host.options().some((o) => o.key === ${JSON.stringify(key)})) return 'unknown';
  host.select(${JSON.stringify(key)});
  return 'ok';
})()`;
