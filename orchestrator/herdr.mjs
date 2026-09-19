import { run, shellJoin, shellQuote, succeeds } from './exec.mjs';

/**
 * Herdr integration, used purely for observability: each task gets its own labeled workspace whose
 * pane streams the container's output, so a human can watch and intervene.
 *
 * The orchestrator runs as a daemon outside any Herdr pane, so it always addresses things by
 * explicit id and always passes --no-focus. It never uses --current, which would resolve to
 * whatever pane the user happens to be looking at, and it only ever closes workspaces it created.
 */

const MAX_LABEL_TITLE = 48;

/**
 * Issue titles are attacker-controlled text from GitHub and the label reaches a shell boundary
 * further down, so it is reduced to a conservative character set before it goes anywhere.
 */
export function sanitizeTitle(title, maxLength = MAX_LABEL_TITLE) {
  const cleaned = String(title || '')
    .replace(/[^\w .#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}\u2026` : cleaned;
}

export function workspaceLabelFor({ slug, issueNumber, title }) {
  const suffix = sanitizeTitle(title);
  return `[${slug}] #${issueNumber}${suffix ? ` ${suffix}` : ''}`;
}

/** Absolute host path to the task's bind-mounted /out/run.log (orchestrator-controlled). */
const RUN_LOG_PATH = /^\/[^\0\n\r`]+$/;

/**
 * argv for `herdr pane run` that follows the runner log on the host.
 *
 * pane run only submits Enter and returns immediately; the pane's shell (nvm, etc.) often starts
 * the command after the orchestrator has already finished the task and run `docker rm`. Tailing the
 * bind-mounted run.log avoids that race and keeps streaming after the container is gone.
 */
export function paneRunLogArgv(runLogPath) {
  const path = String(runLogPath);
  if (!RUN_LOG_PATH.test(path)) {
    throw new Error(`refusing unsafe run log path: ${runLogPath}`);
  }
  const quoted = shellQuote(path);
  const script =
    `for i in $(seq 1 300); do ` +
    `test -f ${quoted} && break; sleep 0.2; done; ` +
    `test -f ${quoted} || ` +
    `{ echo "run log ${path} not found (orchestrator has not created the task out dir yet)"; exit 1; }; ` +
    `exec tail -n +1 -f ${quoted}`;
  return ['bash', '-lc', script];
}

function parseJson(stdout, what) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Could not parse ${what} response as JSON: ${stdout.slice(0, 200)}`);
  }
}

export function createHerdr({ bin = 'herdr', logger = console, dryRun = false } = {}) {
  return {
    /** `herdr status` needs socket access that may be denied; listing workspaces is the real probe. */
    async available() {
      return succeeds(bin, ['workspace', 'list']);
    },

    async createWorkspace({ cwd, label }) {
      if (dryRun) {
        logger.log(`[DryRun] ${bin} workspace create --cwd ${cwd} --label ${label} --no-focus`);
        return { workspaceId: 'w0', paneId: 'w0:p0', label };
      }

      // Label goes through argv, so no quoting concerns here; only pane run needs a shell.
      const { stdout } = await run(bin, [
        'workspace',
        'create',
        '--cwd',
        cwd,
        '--label',
        label,
        '--no-focus',
      ]);

      const parsed = parseJson(stdout, 'herdr workspace create');
      const workspaceId = parsed?.result?.workspace?.workspace_id || parsed?.result?.workspace?.id;
      const paneId = parsed?.result?.root_pane?.pane_id || parsed?.result?.root_pane?.id;

      if (!workspaceId || !paneId) {
        throw new Error(
          `herdr workspace create did not return ids: ${JSON.stringify(parsed).slice(0, 300)}`
        );
      }
      return { workspaceId, paneId, label };
    },

    /**
     * `pane run` hands its argument to the pane's shell, so this is the one place a command string
     * is unavoidable. The argv is quoted exactly once, here, at that boundary.
     *
     * Herdr submits the command and returns as soon as Enter is sent; it does not wait for the
     * process to finish. Never use this to start a task container — start detached via docker.start,
     * then optionally tail logs here for observability.
     */
    async runInPane({ paneId, argv }) {
      const command = shellJoin(argv);
      if (dryRun) {
        logger.log(`[DryRun] ${bin} pane run ${paneId} ${command}`);
        return command;
      }
      await run(bin, ['pane', 'run', paneId, command]);
      return command;
    },

    async readPane({ paneId, lines = 120 }) {
      const result = await run(
        bin,
        ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(lines)],
        { allowFailure: true }
      );
      return result.code === 0 ? result.stdout : '';
    },

    async closeWorkspace(workspaceId) {
      if (!workspaceId || dryRun) return false;
      const ok = await succeeds(bin, ['workspace', 'close', workspaceId]);
      if (!ok) logger.warn(`[Herdr] could not close workspace ${workspaceId}`);
      return ok;
    },
  };
}

/**
 * Wraps the Herdr surface so an unavailable server degrades to running the container detached
 * instead of failing the task, unless the operator asked for Herdr to be mandatory.
 */
export async function resolveHerdrSurface({ bin, required, logger = console, dryRun = false }) {
  const herdr = createHerdr({ bin, logger, dryRun });
  const available = dryRun ? true : await herdr.available();

  if (!available) {
    if (required) {
      throw new Error(
        'HERDR_REQUIRED is set but the Herdr server is not reachable. Start Herdr, or unset it to ' +
          'run containers detached.'
      );
    }
    logger.warn('[Herdr] not reachable; running containers detached with no pane');
  }

  return { herdr, available };
}
