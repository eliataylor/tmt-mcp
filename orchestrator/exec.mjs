import { execFile as execFileCb } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

/**
 * Hooks, fsmonitor, and sshCommand in a clone's `.git/config` run as the host user. The agent can
 * rewrite that config through the `/workspace` bind mount, so every host git command overrides it.
 * An empty directory (not the clone's `.git/hooks`) is what makes a planted hook a no-op.
 */
export function hostGitHooksDir() {
  const dir = join(tmpdir(), 'tmt-agent-no-hooks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** argv fragment inserted before `-C` and the subcommand. */
export function hostGitConfigArgs() {
  return [
    '-c',
    `core.hooksPath=${hostGitHooksDir()}`,
    '-c',
    'core.fsmonitor=',
    '-c',
    'core.sshCommand=',
  ];
}

function gitEnv(options = {}) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...options.env,
  };
}

/**
 * Every process this daemon starts goes through here.
 *
 * execFile with an argv array never involves a shell, which matters because issue titles, branch
 * names, and label text all originate from GitHub. Interpolating any of it into a command string
 * would be a remote-code-execution path onto the host.
 */
export async function run(file, args, options = {}) {
  const { allowFailure = false, maxBuffer = 8 * 1024 * 1024, ...rest } = options;
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { maxBuffer, ...rest });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (allowFailure) {
      return { code: err.code ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
    const detail = (err.stderr || err.message || '').trim().split('\n').slice(0, 5).join('; ');
    throw new Error(`${file} ${args.join(' ')} failed: ${detail}`);
  }
}

/** True when the command exits 0. For probes where the output does not matter. */
export async function succeeds(file, args, options = {}) {
  const result = await run(file, args, { ...options, allowFailure: true });
  return result.code === 0;
}

export function git(cwd) {
  const base = [...hostGitConfigArgs(), ...(cwd ? ['-C', cwd] : [])];
  const withGitEnv = (options = {}) => ({ ...options, env: gitEnv(options) });
  return {
    run: (args, options) => run('git', [...base, ...args], withGitEnv(options)),
    succeeds: (args, options) => succeeds('git', [...base, ...args], withGitEnv(options)),
    async capture(args, options) {
      const { stdout } = await run('git', [...base, ...args], withGitEnv(options));
      return stdout.trim();
    },
  };
}

/**
 * POSIX single-quote escaping.
 *
 * Only for the one place a shell is unavoidable: `herdr pane run` takes a command string that the
 * pane's shell executes. Everything else uses argv arrays and must not call this.
 */
export function shellQuote(value) {
  const str = String(value);
  if (/^[\w@%+=:,./-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv) {
  return argv.map(shellQuote).join(' ');
}
