#!/usr/bin/env node
// antigravity-themes: installs, runs and removes the themes. See README.md.
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, watch as watchFiles, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, pageScript, REMOVE_SCRIPT, PROBE_SCRIPT, selectScript } from '../lib/bundle.mjs';
import { readPort, evaluateEverywhere, watch } from '../lib/injector.mjs';
import { installDir, stateFile, logFile, portFile, appResourcesDir } from '../lib/paths.mjs';
import { launch, writeAutostart, removeAutostart, hasAutostart, autostartFile } from '../lib/autostart.mjs';

const NAME = 'antigravity-themes';
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// npx.cmd: PowerShell's default script policy on Windows blocks plain npx (npx.ps1)
const NPX = `${process.platform === 'win32' ? 'npx.cmd' : 'npx'} -y ${pkg.name}`;
const [command = 'help', ...args] = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const say = (line = '') => console.log(line);
function fail(message) {
  console.error(`${NAME}: ${message}`);
  process.exit(1);
}

if (typeof WebSocket !== 'function') fail(`Node.js 22 or newer is needed (this is ${process.version}). Get it from https://nodejs.org`);

// ---- Background process ------------------------------------------------------
// It answers on 127.0.0.1 with a random token, written to run.json: other
// commands find and stop it through that, never by process id (an id can be
// reused by an unrelated process after a reboot).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readState() {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { return null; }
}
async function running() {
  const state = readState();
  if (!state) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/ping?token=${state.token}`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return state;
  } catch { /* not answering */ }
  return null;
}

async function stopBackground() {
  const state = await running();
  if (!state) return false;
  try {
    await fetch(`http://127.0.0.1:${state.port}/stop?token=${state.token}`, { method: 'POST', signal: AbortSignal.timeout(2000) });
  } catch { /* it exits while answering */ }
  for (let i = 0; i < 30 && await running(); i++) await sleep(100);
  return true;
}

async function startBackground(cli) {
  mkdirSync(installDir(), { recursive: true });
  launch(process.execPath, cli);
  for (let i = 0; i < 100; i++) {
    const state = await running();
    if (state) return state;
    await sleep(100);
  }
  return null;
}

async function run() {
  const other = await running();
  if (other) {
    say(`Already running (process ${other.pid}).`);
    return;
  }
  const token = randomUUID();
  const control = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('token') !== token) { res.writeHead(403).end(); return; }
    if (url.pathname === '/ping') { res.end(pkg.version); return; }
    if (url.pathname === '/stop' && req.method === 'POST') { res.end('stopping'); setTimeout(() => process.exit(0), 50); return; }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
  mkdirSync(installDir(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ pid: process.pid, port: control.address().port, token, version: pkg.version }));
  process.on('exit', () => {
    if (readState()?.token === token) rmSync(stateFile(), { force: true });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
  // Never two processes theming the same windows: when another one has
  // written run.json since (the last one started wins), or the file is gone
  // (uninstall), this one ends.
  setInterval(() => {
    if (readState()?.token !== token) process.exit(0);
  }, 2000);
  // keep the log short: it is only for troubleshooting
  try { if (statSync(logFile()).size > 512 * 1024) rmSync(logFile()); } catch { /* none yet */ }
  const log = (line) => {
    const entry = `${new Date().toISOString()} ${line}`;
    say(entry);
    try { appendFileSync(logFile(), `${entry}\n`); } catch { /* uninstalling */ }
  };
  process.on('uncaughtException', (err) => {
    log(err.stack);
    process.exit(1);
  });
  log(`${NAME} ${pkg.version} running from ${ROOT}`);
  const watcher = watch({ getSource: () => pageScript(ROOT), log });
  if (has('--dev')) {
    let timer;
    for (const dir of ['src', 'themes', 'vendor']) {
      watchFiles(path.join(ROOT, dir), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => watcher.reload().catch((err) => log(err.message)), 150);
      });
    }
    log('--dev: reloading on changes to src/, themes/ and vendor/');
  }
}

// ---- Commands -----------------------------------------------------------------
const RUNTIME = ['bin', 'lib', 'src', 'themes', 'vendor', 'package.json', 'README.md', 'LICENSE', 'NOTICE'];

const isThemed = (result) => Boolean(result.value && JSON.parse(result.value));

// Waits for the background process to reach the open windows, so that install
// can report the result itself. Throws when Antigravity is not open.
async function themedWindows() {
  let results = [];
  for (let i = 0; i < 40; i++) {
    results = await evaluateEverywhere(PROBE_SCRIPT);
    if (results.length && results.every(isThemed)) break;
    await sleep(200);
  }
  return { themed: results.filter(isThemed).length, total: results.length };
}

async function installNative() {
  const { execSync } = await import('node:child_process');
  const resDir = appResourcesDir();
  const asarPath = path.join(resDir, 'app.asar');
  const appDir = path.join(resDir, 'app');
  if (!existsSync(asarPath) && !existsSync(appDir)) {
    fail(`Could not find Antigravity resources at ${resDir}. Is Antigravity installed?`);
  }
  await stopBackground();
  removeAutostart();

  if (!existsSync(appDir)) {
    say('Extracting Antigravity app.asar into resources/app...');
    execSync(`npx -y @electron/asar extract "${asarPath}" "${appDir}"`, { stdio: 'inherit' });
  }

  const bundleCode = pageScript(ROOT);
  const bundleDest = path.join(appDir, 'dist', 'theme-bundle.js');
  writeFileSync(bundleDest, bundleCode, 'utf8');

  const preloadPath = path.join(appDir, 'dist', 'preload.js');
  let preloadContent = readFileSync(preloadPath, 'utf8');
  const marker = '// Antigravity Native Theme Injection (Zero background processes)';
  if (!preloadContent.includes(marker)) {
    const patch = `\n\n${marker}\n(function() {\n  try {\n    const electron = require('electron');\n    const path = require('path');\n    const fs = require('fs');\n    const b = path.join(__dirname, 'theme-bundle.js');\n    if (fs.existsSync(b)) {\n      const c = fs.readFileSync(b, 'utf8');\n      if (electron.webFrame) electron.webFrame.executeJavaScript(c);\n    }\n  } catch (e) {}\n})();\n`;
    appendFileSync(preloadPath, patch, 'utf8');
  }

  say(`Installed natively into Antigravity (${resDir}).`);
  say('No background process, no host server, and no startup entry.');
  say('Done. The themes load permanently whenever Antigravity starts.');
}

async function install() {
  if (has('--native')) return installNative();
  const dir = installDir();
  const same = path.resolve(dir) === path.resolve(ROOT);
  const wasRunning = await stopBackground();
  if (!same) {
    mkdirSync(dir, { recursive: true });
    for (const entry of RUNTIME) {
      const from = path.join(ROOT, entry);
      if (!existsSync(from)) continue;
      rmSync(path.join(dir, entry), { recursive: true, force: true });
      cpSync(from, path.join(dir, entry), { recursive: true });
    }
  }
  const cli = path.join(dir, 'bin', 'cli.mjs');
  say(`Installed ${NAME} ${pkg.version} in ${dir}`);
  const permanent = !has('--no-autostart');
  if (permanent) {
    say(`Starts at logon: ${writeAutostart(process.execPath, cli)}`);
  } else {
    removeAutostart();
    say('Not started at logon (--no-autostart).');
  }
  const state = await startBackground(cli);
  if (!state) fail(`could not start the background process, see ${logFile()}. On Windows it needs Windows Script Host (wscript.exe), and so does the logon entry.`);
  say(`${wasRunning ? 'Restarted' : 'Started'} in the background (process ${state.pid}).`);
  let windows = null;
  try { windows = await themedWindows(); } catch { /* not open */ }
  if (!windows?.total) say('Antigravity is not open: the theme appears when it starts.');
  else if (!windows.themed) fail(`Antigravity is open, but no window got the theme; see ${logFile()}`);
  else say(`Theme applied to ${windows.themed} of ${windows.total} Antigravity window(s).`);
  say();
  say('Choose a theme in Antigravity: the "Theme" menu in the title bar (Matte), or the menu button at the');
  say('top left, then Theme (Material 3 Expressive). Ctrl+Shift+F12 cycles through the themes.');
  say(`Remove everything with: ${NPX} uninstall`);
  say();
  say(permanent
    ? 'Done. This is permanent: the themes return at every logon and every Antigravity start. Nothing else to do.'
    : `Done. Not permanent: after the next logon, run "${NPX} start".`);
}

async function uninstall() {
  if (await stopBackground()) say('Stopped the background process.');
  try {
    const results = await evaluateEverywhere(REMOVE_SCRIPT);
    say(`Removed the theme from ${results.filter((r) => !r.error).length} open window(s).`);
  } catch {
    say('Antigravity is not running: nothing to remove from its windows.');
  }
  const entry = removeAutostart();
  if (entry) say(`Removed the logon entry: ${entry}`);
  const dir = installDir();
  if (path.basename(dir) === NAME && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    say(`Deleted ${dir}`);
  }
  const appDir = path.join(appResourcesDir(), 'app');
  if (existsSync(appDir)) {
    rmSync(appDir, { recursive: true, force: true });
    say(`Removed native installation at ${appDir}. Restored stock app.asar.`);
  }
  say('Done. Antigravity keeps your last theme choice in its own storage; it has no effect without this tool.');
}

async function on() {
  const results = await evaluateEverywhere(pageScript(ROOT));
  const ok = results.filter((r) => !r.error).length;
  say(`Applied to ${ok} window(s).${await running() ? '' : ' Without the background process it lasts until a window reloads; "install" makes it permanent.'}`);
}

async function off() {
  if (await stopBackground()) say('Stopped the background process.');
  const results = await evaluateEverywhere(REMOVE_SCRIPT);
  say(`Removed from ${results.filter((r) => !r.error).length} window(s).${hasAutostart() ? ' It comes back at the next logon; "uninstall" removes it for good.' : ''}`);
}

async function theme() {
  const index = JSON.parse(readFileSync(path.join(ROOT, 'themes', 'index.json'), 'utf8'));
  const key = args.find((a) => !a.startsWith('-'));
  if (!key) {
    say('Themes:');
    for (const o of index.options) say(`  ${o.key.padEnd(14)} ${o.name}`);
    say(`\nSwitch with: ${NPX} theme <key>`);
    return;
  }
  if (!index.options.some((o) => o.key === key)) fail(`no theme "${key}". Run "theme" to list them.`);
  const results = await evaluateEverywhere(selectScript(key));
  const ok = results.filter((r) => r.value === 'ok').length;
  if (!ok) fail('no themed window found. Is the background process running? Try "status".');
  say(`Switched ${ok} window(s) to ${key}.`);
}

async function status() {
  const dir = installDir();
  let installed = null;
  try { installed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { /* not installed */ }
  say(`Installed:   ${installed ? `${installed} in ${dir}` : 'no'}`);
  say(`At logon:    ${hasAutostart() ? autostartFile() : 'no'}`);
  const state = await running();
  say(`Background:  ${state ? `running (process ${state.pid}, version ${state.version})` : 'not running'}`);
  try {
    const port = readPort();
    const results = await evaluateEverywhere(PROBE_SCRIPT, port);
    say(`Antigravity: running, port ${port}, ${results.length} window(s)`);
    for (const r of results) {
      const host = r.value ? JSON.parse(r.value) : null;
      say(`  ${host ? `themed (${host.theme})` : 'not themed'}  ${r.url}`);
    }
  } catch (err) {
    say(`Antigravity: ${existsSync(portFile()) ? err.message : `not running (no ${portFile()})`}`);
  }
  say();
  if (installed && hasAutostart() && state) {
    say('OK: installed and permanent.');
  } else {
    say(`Not permanent. Fix it with: ${NPX} install`);
    process.exitCode = 1;
  }
}

function help() {
  say(`${NAME} ${pkg.version}: Matte, Paper, Nordic, and Material 3 Expressive themes for Antigravity Desktop

Usage: ${NPX} <command>

  install [--native]        Install the themes permanently.
                            With --native: installs directly into Antigravity with ZERO background processes or servers.
                            Default: copies themes to ${installDir()} and keeps them synced.
  uninstall                 Remove the themes from Antigravity, the logon entry, and native app directory
  start                     Start the background process that themes every window (not permanent)
  stop                      Stop it (open windows keep the theme until they reload)
  on                        Apply the themes to the open windows once (not permanent)
  off                       Stop the background process and remove the themes from the open windows
  theme [key]               List the themes, or switch every window to one
  status                    Show what is installed and running; exit code 1 if not permanent
  run [--dev]               Run the background process in this terminal (--dev reloads on file changes)`);
}

const commands = {
  install, uninstall, on, off, theme, status, run, help,
  start: async () => {
    const state = await running() ?? await startBackground(path.join(ROOT, 'bin', 'cli.mjs'));
    if (!state) fail(`could not start; see ${logFile()}`);
    say(`Running in the background (process ${state.pid}).${hasAutostart() ? '' : ' Until the next logon; "install" makes it permanent.'}`);
  },
  stop: async () => say(await stopBackground() ? 'Stopped.' : 'Not running.'),
  '--version': () => say(pkg.version),
  '-v': () => say(pkg.version),
  '--help': help,
  '-h': help,
};
const handler = commands[command];
if (!handler) fail(`unknown command "${command}". Run "help" for the list.`);
try {
  await handler();
} catch (err) {
  fail(err.message);
}
