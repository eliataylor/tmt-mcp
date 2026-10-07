import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { assertKnownReposOnly, loadRegistry } from '../src/projects.mjs';

function loadFrom(projects, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-projects-'));
  const configPath = join(dir, 'projects.json');
  writeFileSync(configPath, JSON.stringify({ projects }));
  try {
    return loadRegistry({ configPath, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const main = {
  slug: 'main-app',
  repo: 'my-org/primary-app',
  webhook_secret_env: 'WEBHOOK_SECRET_MAIN_APP',
};

describe('project registry', () => {
  test('requires a distinct webhook_secret_env on every project', () => {
    const registry = loadFrom([
      main,
      {
        slug: 'side-project',
        repo: 'personal/side-project',
        webhook_secret_env: 'WEBHOOK_SECRET_SIDE_PROJECT',
      },
    ]);
    assert.equal(registry.byRepo('My-Org/Primary-App').webhook_secret_env, 'WEBHOOK_SECRET_MAIN_APP');
    assert.equal(registry.byRepo('someone/else'), null);

    assert.throws(() => loadFrom([{ ...main, webhook_secret_env: undefined }]), /webhook_secret_env/);
    assert.throws(
      () => loadFrom([{ ...main, webhook_secret_env: 'GITHUB_WEBHOOK_SECRET' }]),
      /per-repository variable/
    );
    assert.throws(
      () =>
        loadFrom([
          main,
          {
            slug: 'side-project',
            repo: 'personal/side-project',
            webhook_secret_env: 'WEBHOOK_SECRET_MAIN_APP',
          },
        ]),
      /duplicate webhook_secret_env/
    );
  });

  test('rejects trusted_logins', () => {
    assert.throws(() => loadFrom([{ ...main, trusted_logins: ['helper'] }]), /trusted_logins/);
    assert.throws(() => loadFrom([{ ...main, trusted_logins: [] }]), /trusted_logins/);
  });

  test('ALLOW_UNKNOWN_REPOS cannot be turned on', () => {
    assert.doesNotThrow(() => assertKnownReposOnly({}));
    assert.doesNotThrow(() => assertKnownReposOnly({ ALLOW_UNKNOWN_REPOS: 'false' }));
    assert.throws(
      () => assertKnownReposOnly({ ALLOW_UNKNOWN_REPOS: 'true' }),
      /ALLOW_UNKNOWN_REPOS=true is not supported/
    );
    assert.throws(() => loadFrom([main], { ALLOW_UNKNOWN_REPOS: '1' }), /ALLOW_UNKNOWN_REPOS=1 is not supported/);
  });
});
