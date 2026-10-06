import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, hostGitConfigArgs } from '../orchestrator/exec.mjs';
import { restoreGitMetadata, snapshotGitMetadata } from '../orchestrator/repo.mjs';

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'host-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'readme.txt'), 'hello\n');
  execFileSync('git', ['-C', root, 'add', 'readme.txt']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init']);
  return root;
}

describe('host git overrides', () => {
  test('every invocation disables hooks, fsmonitor, and sshCommand', () => {
    const args = hostGitConfigArgs().join(' ');
    assert.match(args, /core\.hooksPath=/);
    assert.match(args, /core\.fsmonitor=/);
    assert.match(args, /core\.sshCommand=/);
  });

  test('a hook in the clone does not run when the host commits', async () => {
    const root = initRepo();
    const marker = join(root, 'hook-ran');
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker.replace(/'/g, `'\\''`)}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(root, 'readme.txt'), 'changed\n');
    await git(root).run(['add', 'readme.txt']);
    await git(root).run(['commit', '-m', 'second']);
    assert.equal(existsSync(marker), false);
    rmSync(root, { recursive: true, force: true });
  });

  test('a configured fsmonitor command does not run', async () => {
    const root = initRepo();
    const marker = join(root, 'fsmonitor-ran');
    const script = join(root, 'watch.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    execFileSync('git', ['-C', root, 'config', 'core.fsmonitor', script]);
    await git(root).run(['status', '--porcelain']);
    assert.throws(() => readFileSync(marker));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('git metadata restore', () => {
  test('puts config and hooks back and does not follow a symlink the container left behind', () => {
    const root = initRepo();
    const snap = mkdtempSync(join(tmpdir(), 'git-meta-'));
    snapshotGitMetadata(root, snap);

    writeFileSync(join(root, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/pwned\n');
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    const outside = join(root, 'outside-config');
    writeFileSync(outside, 'do-not-overwrite\n');
    rmSync(join(root, '.git', 'config'));
    symlinkSync(outside, join(root, '.git', 'config'));

    restoreGitMetadata(root, snap);

    const config = readFileSync(join(root, '.git', 'config'), 'utf8');
    assert.match(config, /\[user\]/);
    assert.match(config, /name = test/);
    assert.doesNotMatch(config, /fsmonitor/);
    assert.equal(readFileSync(outside, 'utf8'), 'do-not-overwrite\n');
    assert.throws(() => readFileSync(join(root, '.git', 'hooks', 'pre-commit')));
    rmSync(root, { recursive: true, force: true });
    rmSync(snap, { recursive: true, force: true });
  });
});
