#!/usr/bin/env node
/**
 * Collect strays the orchestrator left behind: containers from a crashed daemon, clone and task
 * directories retained by KEEP_ARTIFACTS, and per-issue volumes for issues that are long done.
 *
 * Reports by default. Nothing is deleted without --apply.
 *
 * Usage:
 *   node scripts/gc-agent-artifacts.mjs
 *   node scripts/gc-agent-artifacts.mjs --older-than 7d --apply
 *   node scripts/gc-agent-artifacts.mjs --volumes --apply
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../orchestrator/config.mjs';
import { createDocker } from '../orchestrator/runner.mjs';
import { run } from '../orchestrator/exec.mjs';

function parseDuration(text) {
  const match = /^(\d+)([hd])$/.exec(String(text || ''));
  if (!match) throw new Error(`--older-than expects a value like 12h or 7d, got "${text}"`);
  const [, amount, unit] = match;
  return Number(amount) * (unit === 'h' ? 3600 : 86400) * 1000;
}

function parseArgs(argv) {
  const args = { olderThanMs: parseDuration('2d'), apply: false, volumes: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--older-than') args.olderThanMs = parseDuration(argv[++i]);
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--volumes') args.volumes = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function ageOf(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function humanAge(ms) {
  const hours = ms / 3600000;
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(0);
}

const config = loadConfig();
const docker = createDocker({ logger: console });
const plan = { containers: [], directories: [], volumes: [] };

if (!(await docker.available())) {
  console.warn('docker info failed; skipping container and volume collection.');
} else {
  for (const container of await docker.listAgentContainers()) {
    // A running container may be a live task, so only exited ones are candidates.
    if (/^Up /.test(container.status)) {
      console.log(`skip (running)   ${container.name}  ${container.status}`);
      continue;
    }
    plan.containers.push(container);
  }

  if (args.volumes) {
    const result = await run(
      'docker',
      ['volume', 'ls', '--filter', 'name=tmt-agent-', '--format', '{{.Name}}'],
      { allowFailure: true }
    );
    if (result.code === 0) {
      for (const name of result.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
        // The modules and npm caches are shared per project and worth keeping; home volumes hold
        // chat state that only matters while an issue is still being worked.
        if (name.startsWith('tmt-agent-modules-') || name.startsWith('tmt-agent-npm-')) continue;
        plan.volumes.push(name);
      }
    }
  }
}

for (const dir of [config.paths.clones, config.paths.tasks]) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const age = ageOf(path);
    if (age < args.olderThanMs) continue;
    plan.directories.push({ path, age });
  }
}

console.log(`\nworkdir: ${config.paths.workdir}`);
console.log(`older than: ${humanAge(args.olderThanMs)}\n`);

if (plan.containers.length) {
  console.log(`exited containers (${plan.containers.length}):`);
  for (const c of plan.containers) console.log(`  ${c.name}  ${c.status}`);
}
if (plan.directories.length) {
  console.log(`\nstale directories (${plan.directories.length}):`);
  for (const d of plan.directories) console.log(`  ${d.path}  (${humanAge(d.age)} old)`);
}
if (plan.volumes.length) {
  console.log(`\nper-issue volumes (${plan.volumes.length}):`);
  for (const v of plan.volumes) console.log(`  ${v}`);
  console.log('  note: removing these loses cursor-agent chat state, so --resume starts cold.');
}

const total = plan.containers.length + plan.directories.length + plan.volumes.length;
if (!total) {
  console.log('Nothing to collect.');
  process.exit(0);
}

if (!args.apply) {
  console.log(`\n${total} item(s) would be removed. Re-run with --apply to do it.`);
  process.exit(0);
}

let removed = 0;
for (const container of plan.containers) {
  if (await docker.remove(container.name)) removed += 1;
}
for (const { path } of plan.directories) {
  try {
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  } catch (err) {
    console.warn(`could not remove ${path}: ${err.message}`);
  }
}
for (const volume of plan.volumes) {
  if (await docker.removeVolume(volume)) removed += 1;
}

console.log(`\nRemoved ${removed} of ${total} item(s).`);
