/**
 * Spawn `cypress run` off-screen in Chrome (not Electron).
 *
 * Electron hangs on all-at-once picture preload through the Cypress proxy
 * (vocab / TROG / stories). Chrome talks to GCS more like a real tab.
 * Override with QA_BROWSER=electron (or any Cypress browser name).
 *
 * Under WSLg, even headless Electron often attaches to DISPLAY=:0 and steals
 * the Windows desktop. Prefer xvfb-run; fall back to unsetting DISPLAY.
 *
 * Opt into a visible window with QA_CYPRESS_HEADED=1 or a `--headed` argv flag.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const XVFB = '/usr/bin/xvfb-run';
const XVFB_SCREEN = ['-a', '-s', '-screen 0 1280x1024x24'];

export function wantCypressHeaded(env = process.env, argv = []) {
  if (argv.includes('--headed')) return true;
  return /^(1|true|yes|on)$/i.test(String(env.QA_CYPRESS_HEADED || ''));
}

/**
 * @param {string[]} cyArgs arguments after `cypress run` (e.g. --spec …)
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdio?: import('node:child_process').StdioOptions, detached?: boolean, headed?: boolean }} opts
 */
function withBrowser(cyArgs, env) {
  const browser = String(env.QA_BROWSER || 'chrome').trim();
  if (!browser || cyArgs.includes('--browser')) return cyArgs;
  return ['--browser', browser, ...cyArgs];
}

export function spawnCypressRun(cyArgs, opts = {}) {
  const { cwd, stdio, detached } = opts;
  const envIn = opts.env ?? process.env;
  const headed = opts.headed ?? wantCypressHeaded(envIn);
  const env = { ...envIn };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = withBrowser(cyArgs, env);

  if (headed) {
    return spawn('npx', ['cypress', 'run', '--headed', ...args], { cwd, env, stdio, detached });
  }

  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;

  if (existsSync(XVFB)) {
    return spawn(XVFB, [...XVFB_SCREEN, 'npx', 'cypress', 'run', ...args], {
      cwd,
      env,
      stdio,
      detached,
    });
  }

  return spawn('npx', ['cypress', 'run', ...args], { cwd, env, stdio, detached });
}
