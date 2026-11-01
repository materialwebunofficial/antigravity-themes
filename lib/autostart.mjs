// Starts the background process when the user logs in, with no window:
//   Windows  a .vbs launcher in the Startup folder (no admin rights needed)
//   macOS    a LaunchAgent (untested)
//   Linux    an XDG autostart entry (untested)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './bundle.mjs';

const NAME = 'antigravity-themes';
const PACKAGE = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;

export function autostartFile() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${NAME}.vbs`);
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `dev.${NAME}.plist`);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'autostart', `${NAME}.desktop`);
}

// node and the installed cli.mjs, as absolute paths: the entry keeps working
// after the npx cache is gone (and stops if Node moves: install again then)
export function writeAutostart(node, cli) {
  const file = autostartFile();
  mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'win32') {
    const q = (s) => s.replace(/"/g, '""');
    writeFileSync(file, [
      `' ${NAME}: applies the themes to Antigravity at logon, with no window.`,
      `' Remove it with: npx ${PACKAGE} uninstall`,
      `CreateObject("WScript.Shell").Run """${q(node)}"" ""${q(cli)}"" run", 0, False`,
      '',
    ].join('\r\n'));
  } else if (process.platform === 'darwin') {
    const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.${NAME}</string>
  <key>ProgramArguments</key>
  <array><string>${x(node)}</string><string>${x(cli)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`);
  } else {
    const q = (s) => `"${s.replace(/(["\\`$])/g, '\\$1')}"`;
    writeFileSync(file, `[Desktop Entry]
Type=Application
Name=${NAME}
Comment=Applies the themes to Antigravity
Exec=${q(node)} ${q(cli)} run
X-GNOME-Autostart-enabled=true
NoDisplay=true
`);
  }
  return file;
}

export function removeAutostart() {
  const file = autostartFile();
  if (!existsSync(file)) return null;
  rmSync(file);
  return file;
}

export const hasAutostart = () => existsSync(autostartFile());
