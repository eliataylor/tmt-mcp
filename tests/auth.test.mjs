import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  extractBearer,
  peekRepoFullName,
  resolveWebhookSecret,
  safeEqual,
  signBody,
  verifySignature,
} from '../src/auth.mjs';
import { fixtureBuffer } from './helpers.mjs';

const SECRET = 'whsec_test_value';

describe('verifySignature', () => {
  const body = fixtureBuffer('issues.labeled.json');

  test('accepts a signature over the exact bytes GitHub sent', () => {
    assert.equal(verifySignature(body, signBody(body, SECRET), SECRET), true);
  });

  test('rejects a signature computed over re-serialized JSON', () => {
    // This is the bug in PLAN.md's server.mjs: hashing JSON.stringify(req.body) instead of
    // the raw buffer. Round-tripping changes the bytes, so the digest no longer matches.
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))), 'utf8');
    assert.notEqual(reserialized.length, body.length);
    assert.equal(verifySignature(body, signBody(reserialized, SECRET), SECRET), false);
  });

  test('rejects a tampered body', () => {
    const signature = signBody(body, SECRET);
    const tampered = Buffer.from(body.toString('utf8').replace('"number": 42', '"number": 43'), 'utf8');
    assert.equal(verifySignature(tampered, signature, SECRET), false);
  });

  test('rejects the wrong secret', () => {
    assert.equal(verifySignature(body, signBody(body, SECRET), 'other-secret'), false);
  });

  test('returns false instead of throwing on a malformed header', () => {
    // timingSafeEqual throws on a length mismatch, which would surface as a 500.
    for (const header of ['garbage', 'sha256=', 'sha256=abc', 'sha1=' + 'a'.repeat(40), '', undefined, null]) {
      assert.equal(verifySignature(body, header, SECRET), false, `header: ${String(header)}`);
    }
  });

  test('rejects a correct digest carrying the wrong prefix', () => {
    const digest = signBody(body, SECRET).slice('sha256='.length);
    assert.equal(verifySignature(body, `sha512=${digest}`, SECRET), false);
  });

  test('requires a secret and a buffer', () => {
    assert.equal(verifySignature(body, signBody(body, SECRET), ''), false);
    assert.equal(verifySignature('not a buffer', signBody(body, SECRET), SECRET), false);
  });
});

describe('safeEqual', () => {
  test('matches identical strings and rejects everything else', () => {
    assert.equal(safeEqual('token', 'token'), true);
    assert.equal(safeEqual('token', 'token '), false);
    assert.equal(safeEqual('token', 'a-much-longer-token'), false, 'must not throw on length mismatch');
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual(undefined, 'token'), false);
  });
});

describe('resolveWebhookSecret', () => {
  test('prefers the per-project variable', () => {
    const env = { GITHUB_WEBHOOK_SECRET: 'global', WEBHOOK_SECRET_MAIN_APP: 'scoped' };
    const result = resolveWebhookSecret({ webhook_secret_env: 'WEBHOOK_SECRET_MAIN_APP' }, env);
    assert.deepEqual(result, { secret: 'scoped', source: 'WEBHOOK_SECRET_MAIN_APP' });
  });

  test('falls back to the global secret when the project declares none', () => {
    const result = resolveWebhookSecret({ webhook_secret_env: null }, { GITHUB_WEBHOOK_SECRET: 'global' });
    assert.equal(result.secret, 'global');
    assert.equal(result.missing, false);
  });

  test('never silently falls back when a declared variable is unset', () => {
    const env = { GITHUB_WEBHOOK_SECRET: 'global' };
    const result = resolveWebhookSecret({ webhook_secret_env: 'WEBHOOK_SECRET_MISSING' }, env);
    assert.equal(result.secret, null);
    assert.equal(result.missing, true);
  });

  test('reports a missing global secret', () => {
    assert.equal(resolveWebhookSecret(null, {}).missing, true);
  });
});

describe('peekRepoFullName', () => {
  test('reads the repo from a well-formed delivery', () => {
    assert.equal(peekRepoFullName(fixtureBuffer('issues.labeled.json')), 'my-org/primary-app');
  });

  test('returns null rather than throwing on junk', () => {
    assert.equal(peekRepoFullName(Buffer.from('not json')), null);
    assert.equal(peekRepoFullName(Buffer.from('{}')), null);
    assert.equal(peekRepoFullName(Buffer.from('{"repository":{"full_name":42}}')), null);
  });
});

describe('extractBearer', () => {
  test('parses the token and tolerates casing', () => {
    assert.equal(extractBearer('Bearer abc123'), 'abc123');
    assert.equal(extractBearer('bearer abc123'), 'abc123');
    assert.equal(extractBearer('Token abc123'), null);
    assert.equal(extractBearer(undefined), null);
  });
});
