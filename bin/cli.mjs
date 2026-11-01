#!/usr/bin/env node
// antigravity-themes: installs, runs and removes the themes. See README.md.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, watch as watchFiles, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, pageScript, REMOVE_SCRIPT, PROBE_SCRIPT, selectScript } from '../lib/bundle.mjs';
import { readPort, listTargets, evaluateEverywhere, watch } from '../lib/injector.mjs';
import { installDir, stateFile, logFile, portFile } from '../lib/paths.mjs';
import { writeAutostart, removeAutostart, hasAutostart, autostartFile } from '../lib/autostart.mjs';

const NAME = 'antigravity-themes';
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NPX = `npx ${pkg.name}`;
const [command = 'help', ...args] = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const say = (line = '') => console.log(line);
function fail(message) {
  console.error(`${NAME}: ${message}`);
  process.exit(1);
}

if (typeof WebSocket !== 'function') fail(`Node.js 22 or newer is needed (this is ${process.version}).`);

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
  // keep the log short: it is only for troubleshooting
  try { if (statSync(logFile()).size > 512 * 1024) rmSync(logFile()); } catch { /* none yet */ }
  const log = openSync(logFile(), 'a');
  spawn(process.execPath, [cli, 'run'], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  closeSync(log);
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
  const log = (line) => say(`${new Date().toISOString()} ${line}`);
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

async function install() {
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
  if (has('--no-autostart')) {
    removeAutostart();
    say('Not started at logon (--no-autostart).');
  } else {
    say(`Starts at logon: ${writeAutostart(process.execPath, cli)}`);
  }
  const state = await startBackground(cli);
  say(state ? `${wasRunning ? 'Restarted' : 'Started'} in the background (process ${state.pid}).` : `Could not start the background process; see ${logFile()}`);
  try {
    const windows = await listTargets(readPort());
    say(`Antigravity is running: ${windows.length} window(s) will get the theme within a few seconds.`);
  } catch {
    say('Antigravity is not running: the theme appears when it starts.');
  }
  say();
  say('Choose a theme in Antigravity: the "Theme" menu in the title bar (Matte), or the menu button at the');
  say('top left, then Theme (Material 3 Expressive). Ctrl+Shift+F12 cycles through the themes.');
  say(`Remove everything with: ${NPX} uninstall`);
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
  say('Done. Antigravity keeps your last theme choice in its own storage; it has no effect without this tool.');
}

async function on() {
  const results = await evaluateEverywhere(pageScript(ROOT));
  const ok = results.filter((r) => !r.error).length;
  say(`Applied to ${ok} window(s).${await running() ? '' : ' Without the background process it lasts until a window reloads; run "start" to keep it.'}`);
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
  let port;
  try { port = readPort(); } catch { say(`Antigravity: not running (no ${portFile()})`); return; }
  try {
    const results = await evaluateEverywhere(PROBE_SCRIPT, port);
    say(`Antigravity: running, port ${port}, ${results.length} window(s)`);
    for (const r of results) {
      const host = r.value ? JSON.parse(r.value) : null;
      say(`  ${host ? `themed (${host.theme})` : 'not themed'}  ${r.url}`);
    }
  } catch (err) {
    say(`Antigravity: ${err.message}`);
  }
}

function help() {
  say(`${NAME} ${pkg.version}: Matte and Material 3 Expressive themes for Antigravity Desktop

Usage: ${NPX} <command>

  install [--no-autostart]  Copy the themes to ${installDir()},
                            start them at logon, and start them now
  uninstall                 Remove the themes from Antigravity, the logon entry and that folder
  start                     Start the background process that themes every window
  stop                      Stop it (open windows keep the theme until they reload)
  on                        Apply the themes to the open windows once
  off                       Stop the background process and remove the themes from the open windows
  theme [key]               List the themes, or switch every window to one
  status                    Show what is installed and running
  run [--dev]               Run the background process in this terminal (--dev reloads on file changes)`);
}

const commands = {
  install, uninstall, on, off, theme, status, run, help,
  start: async () => {
    const state = await running() ?? await startBackground(path.join(ROOT, 'bin', 'cli.mjs'));
    say(state ? `Running in the background (process ${state.pid}).` : `Could not start; see ${logFile()}`);
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
