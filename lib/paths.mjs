// Where Antigravity writes its debug port, and where this tool installs
// itself, per platform. Windows is tested; macOS and Linux follow Electron's
// conventions for an app named "Antigravity".
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

// Electron's userData folder for Antigravity
export function appDataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Antigravity');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Antigravity');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Antigravity');
}

// Antigravity starts with --remote-debugging-port=0 and writes the port it
// got here (first line), anew on every launch
export const portFile = () => path.join(appDataDir(), 'DevToolsActivePort');

export function installDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'antigravity-themes');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'antigravity-themes');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'antigravity-themes');
}

// The background process writes how to reach it here while it runs
export const stateFile = () => path.join(installDir(), 'run.json');
export const logFile = () => path.join(installDir(), 'run.log');
