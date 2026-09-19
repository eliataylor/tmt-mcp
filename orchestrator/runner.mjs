import { statSync } from 'node:fs';

import { run, succeeds } from './exec.mjs';

/**
 * The runner container.
 *
 * Everything about this invocation is chosen so the container can see this one task and nothing
 * else: an isolated network with no route to the queue, an explicit mount allowlist, no Docker or
 * Herdr socket, a read-only root, and secrets delivered as a mounted file rather than as
 * environment variables that `docker inspect` would echo back.
 */

/** Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*, so anything else in a slug has to go. */
export function containerNameFor({ slug, issueNumber, taskId }) {
  const safeSlug = String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `tmt-agent-${safeSlug}-${issueNumber}-${String(taskId).slice(0, 8)}`;
}

export function homeVolumeFor({ slug, issueNumber }) {
  return `tmt-agent-home-${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}-${issueNumber}`;
}

export function modulesVolumeFor({ slug }) {
  return `tmt-agent-modules-${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

/**
 * Shared per project, not per issue: the npm cache is content-addressed, so every task on a project
 * reuses the same tarballs. Kept off the per-issue home volume so closing an issue does not throw
 * the download cache away with it.
 */
export function npmCacheVolumeFor({ slug }) {
  return `tmt-agent-npm-${String(slug).replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

/** Agent uid in the runner image; matches docker/agent-runner.Dockerfile. */
export const AGENT_CONTAINER_USER = '1001:1001';

/**
 * Ephemeral node_modules (default on macOS). Avoids root-owned named-volume debris and slow bind
 * mounts; npm ci runs each task but always as uid 1001.
 *
 * `exec` is not redundant: docker adds noexec to every --tmpfs unless it is named explicitly, and
 * installers run their own binaries (esbuild's install.js shells out to node_modules/.bin/esbuild).
 * Also note tmpfs pages count against --memory, so size stays well under RUNNER_MEMORY.
 */
export const MODULES_TMPFS_SPEC =
  '/workspace/node_modules:rw,exec,nosuid,size=2048m,uid=1001,gid=1001,mode=0755';

/**
 * The complete set of paths a runner may see. Anything not on this list is a bug, and the unit
 * tests assert the produced mount list matches it exactly.
 */
export function expectedMountTargets() {
  return [
    '/workspace',
    '/task',
    '/out',
    '/run/secrets/env',
    '/home/agent',
    '/home/agent/.npm',
    '/workspace/node_modules',
  ];
}

function hostOwner(path) {
  const { uid, gid } = statSync(path);
  return `${uid}:${gid}`;
}

/**
 * Build the `docker run` argv.
 *
 * Pure: no filesystem or process access beyond an optional stat for --user, so tests can assert on
 * the result. Returns argv without the leading 'docker'.
 */
export function buildRunArgs({
  image,
  network,
  containerName,
  clonePath,
  taskDir,
  outDir,
  secretsFile,
  homeVolume,
  npmCacheVolume,
  modulesVolume,
  modulesTmpfs = false,
  env = {},
  labels = {},
  memory = '4g',
  cpus = '2',
  pidsLimit = 512,
  nofile = 4096,
  stopTimeout = 30,
  noExecTmp = false,
  matchHostUid = false,
  detach = true,
}) {
  const args = ['run'];

  if (detach) args.push('--detach');
  args.push('--name', containerName);

  // Isolated bridge: a user-defined network only connects containers attached to it, so this
  // cannot reach the queue, cloudflared, or another runner, while outbound NAT still works.
  args.push('--network', network);

  // Docker Desktop injects these names to reach the host. Blackholing them removes the easy path;
  // the raw gateway IP still routes, which is why the runner holds no queue credential.
  args.push('--add-host', 'host.docker.internal:127.0.0.1');
  args.push('--add-host', 'gateway.docker.internal:127.0.0.1');

  args.push('--cap-drop', 'ALL');
  // gosu in the entrypoint needs these after cap-drop; without them the container exits before
  // run.log or result.json are written (Docker Desktop shows "operation not permitted").
  args.push('--cap-add', 'SETUID');
  args.push('--cap-add', 'SETGID');
  args.push('--security-opt', 'no-new-privileges');
  args.push('--read-only');
  args.push('--tmpfs', `/tmp:rw,nosuid,size=512m${noExecTmp ? ',noexec' : ''}`);
  args.push('--pids-limit', String(pidsLimit));
  args.push('--memory', memory);
  // Equal to --memory so the container cannot escape its limit into swap.
  args.push('--memory-swap', memory);
  args.push('--cpus', String(cpus));
  args.push('--ulimit', `nofile=${nofile}`);
  // Gives the entrypoint's SIGTERM trap time to write result.json before SIGKILL.
  args.push('--stop-timeout', String(stopTimeout));

  if (matchHostUid) {
    // Off by default: Docker Desktop remaps bind-mount ownership already, and forcing an arbitrary
    // uid breaks the named volumes the image seeds. Useful on a Linux host.
    args.push('--user', hostOwner(clonePath));
  }

  args.push('--volume', `${clonePath}:/workspace`);
  args.push('--volume', `${taskDir}:/task:ro`);
  args.push('--volume', `${outDir}:/out`);
  args.push('--volume', `${secretsFile}:/run/secrets/env:ro`);
  args.push('--volume', `${homeVolume}:/home/agent`);
  // Nested inside the home volume on purpose; the inner mount wins for that subtree.
  args.push('--volume', `${npmCacheVolume}:/home/agent/.npm`);
  if (modulesTmpfs) {
    args.push('--tmpfs', MODULES_TMPFS_SPEC);
    if (!matchHostUid) args.push('--user', AGENT_CONTAINER_USER);
  } else {
    // Named volume: cache deps across tasks on Linux; entrypoint chowns the tree before npm ci.
    args.push('--volume', `${modulesVolume}:/workspace/node_modules`);
  }

  args.push('--workdir', '/workspace');

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null || value === '') continue;
    args.push('--env', `${key}=${value}`);
  }

  args.push('--label', 'tmt-agent=1');
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined || value === null || value === '') continue;
    args.push('--label', `tmt-agent.${key}=${value}`);
  }

  args.push(image);
  return args;
}

/** Extracts the `-v host:target[:mode]` targets, for assertions and logging. */
export function mountTargetsFrom(args) {
  const targets = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--volume') {
      const parts = args[i + 1].split(':');
      targets.push(parts[1]);
      continue;
    }
    if (args[i] === '--tmpfs') {
      const mountPath = args[i + 1].split(':')[0];
      if (mountPath === '/workspace/node_modules') targets.push(mountPath);
    }
  }
  return targets;
}

export function createDocker({ logger = console, dryRun = false } = {}) {
  return {
    async available() {
      return succeeds('docker', ['info']);
    },

    async imageExists(image) {
      return succeeds('docker', ['image', 'inspect', image]);
    },

    async networkExists(network) {
      return succeeds('docker', ['network', 'inspect', network]);
    },

    async ensureNetwork(network) {
      if (await this.networkExists(network)) return false;
      logger.log(`[Docker] creating isolated runner network ${network}`);
      await run('docker', ['network', 'create', '--driver', 'bridge', network]);
      return true;
    },

    async start(args) {
      if (dryRun) {
        logger.log(`[DryRun] docker ${args.join(' ')}`);
        return 'dry-run-container-id';
      }
      const { stdout } = await run('docker', args);
      return stdout.trim();
    },

    /** Resolves with the container's exit code, or null if it vanished before it could be read. */
    async wait(containerName) {
      if (dryRun) return 0;
      const result = await run('docker', ['wait', containerName], { allowFailure: true });
      if (result.code !== 0) return null;
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return Number.isInteger(parsed) ? parsed : null;
    },

    async isRunning(containerName) {
      const result = await run(
        'docker',
        ['inspect', '-f', '{{.State.Running}}', containerName],
        { allowFailure: true }
      );
      return result.code === 0 && result.stdout.trim() === 'true';
    },

    async stop(containerName, { timeout = 30 } = {}) {
      if (dryRun) return true;
      return succeeds('docker', ['stop', '--timeout', String(timeout), containerName]);
    },

    async remove(containerName) {
      if (dryRun) return true;
      return succeeds('docker', ['rm', '--force', containerName]);
    },

    async removeVolume(name) {
      if (dryRun) return true;
      return succeeds('docker', ['volume', 'rm', name]);
    },

    async listAgentContainers() {
      const result = await run(
        'docker',
        ['ps', '--all', '--filter', 'label=tmt-agent=1', '--format', '{{.Names}}\t{{.Status}}'],
        { allowFailure: true }
      );
      if (result.code !== 0) return [];
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, status] = line.split('\t');
          return { name, status };
        });
    },
  };
}
