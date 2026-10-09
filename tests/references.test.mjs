import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { extractFromText, extractReferences, extractTaskList } from '../src/references.mjs';
import { buildContext } from '../src/context.mjs';
import { PROJECT, fixture } from './helpers.mjs';

const pathsOf = (result) => result.files.map((f) => f.path);
const find = (result, path) => result.files.find((f) => f.path === path);

describe('file references', () => {
  test('GitHub blob permalinks keep their line range and ref', () => {
    const result = extractFromText(
      'see https://github.com/acme/app/blob/release-2/src/lib/foo.ts#L10-L20 please',
      'issue_body'
    );
    assert.deepEqual(find(result, 'src/lib/foo.ts'), {
      path: 'src/lib/foo.ts',
      line_start: 10,
      line_end: 20,
      ref: 'release-2',
      repo: 'acme/app',
      permalink: 'https://github.com/acme/app/blob/release-2/src/lib/foo.ts#L10-L20',
      raw: 'https://github.com/acme/app/blob/release-2/src/lib/foo.ts#L10-L20',
      via: 'permalink',
      source: 'issue_body',
      source_id: null,
    });
  });

  test('a single-line anchor sets start and end to the same line', () => {
    const result = extractFromText('https://github.com/a/b/blob/main/x.ts#L7', 'issue_body');
    const file = find(result, 'x.ts');
    assert.equal(file.line_start, 7);
    assert.equal(file.line_end, 7);
  });

  test('backticked paths carry an optional line suffix', () => {
    const result = extractFromText('check `src/a.ts:88` and `src/b.ts:10-20` and `src/c.ts`', 'issue_body');
    assert.deepEqual(find(result, 'src/a.ts').line_start, 88);
    assert.deepEqual([find(result, 'src/b.ts').line_start, find(result, 'src/b.ts').line_end], [10, 20]);
    assert.equal(find(result, 'src/c.ts').line_start, null);
  });

  test('bare paths are found inside stack traces', () => {
    const result = extractFromText(
      '```\nTypeError: nope\n    at build (src/lib/profile.ts:212:18)\n```',
      'trigger_comment',
      99
    );
    const file = find(result, 'src/lib/profile.ts');
    assert.equal(file.line_start, 212);
    assert.equal(file.source, 'trigger_comment');
    assert.equal(file.source_id, 99);
  });

  test('a code fence path= attribute is recorded once', () => {
    const result = extractFromText('```ts path=src/queue.ts\nconst x = 1;\n```', 'issue_body');
    assert.deepEqual(pathsOf(result), ['src/queue.ts']);
    assert.equal(result.files[0].via, 'code_fence_path');
    assert.deepEqual(result.code_blocks[0].language, 'ts');
    assert.deepEqual(result.code_blocks[0].path, 'src/queue.ts');
  });

  test('domains, versions and bare words are not mistaken for paths', () => {
    const result = extractFromText(
      'visit example.com, we are on v1.2.3, node 22.1 is fine, see README',
      'issue_body'
    );
    assert.deepEqual(pathsOf(result), []);
  });

  test('path segments inside a URL are not re-read as bare paths', () => {
    const result = extractFromText('docs at https://example.com/guide/setup.md', 'issue_body');
    assert.deepEqual(pathsOf(result), []);
    assert.equal(result.urls.length, 1);
  });

  test('the same path is reported once per source', () => {
    const result = extractFromText('`src/a.ts` and again src/a.ts and `src/a.ts`', 'issue_body');
    assert.deepEqual(pathsOf(result), ['src/a.ts']);
  });
});

describe('issue, PR and commit references', () => {
  test('shorthand and URLs are classified separately', () => {
    const result = extractFromText(
      'blocked by #7 and my-org/infra#215, fixed in https://github.com/acme/app/pull/58',
      'issue_body'
    );
    assert.deepEqual(
      result.issues.map((i) => `${i.repo ?? ''}#${i.number}`).sort(),
      ['#7', 'my-org/infra#215']
    );
    assert.deepEqual(result.pull_requests.map((p) => `${p.repo}#${p.number}`), ['acme/app#58']);
  });

  test('commit SHAs come from URLs and bare tokens, but words do not', () => {
    const result = extractFromText(
      'broke in a1b2c3d4e5f6, see https://github.com/acme/app/commit/deadbee1234 — not beefcafe or 1234567',
      'issue_body'
    );
    const shas = result.commits.map((c) => c.sha).sort();
    assert.ok(shas.includes('a1b2c3d4e5f6'));
    assert.ok(shas.includes('deadbee1234'));
    assert.ok(!shas.includes('1234567'), 'digits alone are not a SHA');
  });
});

describe('task lists', () => {
  test('checked state and text are parsed', () => {
    assert.deepEqual(extractTaskList('- [x] done\n* [ ] todo\n- not a task'), [
      { checked: true, text: 'done' },
      { checked: false, text: 'todo' },
    ]);
  });

  test('non-string input yields an empty list', () => {
    assert.deepEqual(extractTaskList(undefined), []);
  });
});

describe('source attribution across a whole delivery', () => {
  test('body and comment references stay distinguishable', () => {
    const merged = extractReferences([
      { text: 'body mentions `src/body.ts`', source: 'issue_body', source_id: null },
      { text: 'comment mentions `src/comment.ts`', source: 'trigger_comment', source_id: 55 },
    ]);
    assert.equal(find(merged, 'src/body.ts').source, 'issue_body');
    assert.equal(find(merged, 'src/comment.ts').source, 'trigger_comment');
    assert.equal(find(merged, 'src/comment.ts').source_id, 55);
  });

  test('the manifest separates body, comment and fetch instructions', () => {
    const payload = fixture('issue_comment.created.json');
    const context = buildContext({
      event: 'issue_comment',
      action: 'comment_created',
      payload,
      project: PROJECT,
      deliveryId: 'delivery-1',
      deliveredAt: '2026-09-18T00:00:00Z',
    });

    assert.equal(context.schema_version, 1);
    assert.equal(context.issue.number, 42);
    assert.ok(context.issue.body.raw.includes('short-circuits'));
    assert.equal(context.trigger_comment.id, 9920114);
    assert.equal(context.trigger.comment_id, 9920114);
    assert.equal(context.trigger.delivery_id, 'delivery-1');

    // The thread is not in the payload, so the manifest says how much is missing and where.
    assert.equal(context.fetch.comment_count, 4);
    assert.equal(context.fetch.comments_included, 1);
    assert.match(context.fetch.comments_url, /issues\/42\/comments$/);

    const sources = new Set(context.references.files.map((f) => f.source));
    assert.deepEqual([...sources].sort(), ['issue_body', 'trigger_comment']);
  });

  test('an issues delivery has no trigger comment', () => {
    const context = buildContext({
      event: 'issues',
      action: 'agent:sdd',
      payload: fixture('issues.labeled.json'),
      project: PROJECT,
    });
    assert.equal(context.trigger_comment, null);
    assert.equal(context.fetch.comments_included, 0);
    assert.equal(context.issue.body.task_list.length, 3);
    assert.equal(context.repo.default_branch, 'main');
    assert.equal(context.issue.is_pull_request, false);
  });
});
