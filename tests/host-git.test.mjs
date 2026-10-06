import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, hostGitConfigArgs } from '../orchestrator/exec.mjs';
import { ensureMirror, restoreGitMetadata, snapshotGitMetadata } from '../orchestrator/repo.mjs';

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
  test('clone git disables hooks, fsmonitor, and sshCommand; mirror git keeps ssh', () => {
    const args = hostGitConfigArgs().join(' ');
    assert.match(args, /core\.hooksPath=/);
    assert.match(args, /core\.fsmonitor=/);
    assert.match(args, /core\.sshCommand=/);
    assert.doesNotMatch(hostGitConfigArgs({ allowSsh: true }).join(' '), /core\.sshCommand/);
  });

  test('https pushes take the token from the environment and do not store it in the clone', async () => {
    const root = initRepo();
    const token = 'ghp_host_push_token_value';
    const args = hostGitConfigArgs({ withGithubToken: true }).join(' ');
    assert.match(args, /credential\.helper=/);
    assert.match(args, /\$GITHUB_TOKEN/);
    assert.equal(args.includes(token), false);

    const { stdout } = await git(root, { githubToken: token }).run(['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
    });
    assert.match(stdout, /username=x-access-token/);
    assert.match(stdout, new RegExp(`password=${token}`));
    assert.equal(readFileSync(join(root, '.git', 'config'), 'utf8').includes(token), false);

    await assert.rejects(
      () => git(root, { githubToken: token }).run(['push', '--set-upstream', 'origin', 'main']),
      (err) => {
        assert.equal(String(err.message).includes(token), false);
        assert.match(String(err.message), /\$GITHUB_TOKEN/);
        return true;
      }
    );
    rmSync(root, { recursive: true, force: true });
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

describe('mirror refresh', () => {
  test('an existing mirror is pointed at the configured fetch url before update', async () => {
    const upstream = initRepo();
    const mirrors = mkdtempSync(join(tmpdir(), 'mirrors-'));
    const mirror = join(mirrors, 'demo.git');
    execFileSync('git', ['clone', '--mirror', '--quiet', upstream, mirror]);
    execFileSync('git', ['-C', mirror, 'remote', 'set-url', 'origin', 'https://github.com/example/old.git']);

    await ensureMirror({
      mirrorsDir: mirrors,
      slug: 'demo',
      fetchUrl: upstream,
      logger: { log() {} },
    });

    const url = execFileSync('git', ['-C', mirror, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    assert.equal(url, upstream);
    rmSync(upstream, { recursive: true, force: true });
    rmSync(mirrors, { recursive: true, force: true });
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
