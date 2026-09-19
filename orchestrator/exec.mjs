import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

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
  const base = cwd ? ['-C', cwd] : [];
  return {
    run: (args, options) => run('git', [...base, ...args], options),
    succeeds: (args, options) => succeeds('git', [...base, ...args], options),
    async capture(args, options) {
      const { stdout } = await run('git', [...base, ...args], options);
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
