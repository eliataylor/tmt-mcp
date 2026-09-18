/**
 * Pull structured references out of issue and comment markdown.
 *
 * Everything is attributed with `source` ('issue_body' | 'trigger_comment') and
 * `source_id`, so the consumer can tell a file the author named in the description from
 * one somebody mentioned in the triggering comment.
 *
 * Code fences are scanned rather than skipped: stack traces pasted into a fence are one
 * of the richest sources of file paths, and step 2 of the agent protocol expects them.
 */

const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'md', 'mdx', 'txt', 'rst',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock', 'properties',
  'sql', 'prisma', 'graphql', 'gql', 'proto',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'scala', 'clj', 'ex', 'exs',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'm', 'mm',
  'php', 'pl', 'lua', 'r', 'dart',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg',
  'vue', 'svelte', 'astro',
  'tf', 'tfvars', 'gradle', 'dockerfile', 'mk',
]);

const GITHUB_BLOB_RE =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/\s#]+)\/([^\s#)\]"']+)(?:#L(\d+)(?:-L(\d+))?)?/g;
const GITHUB_ISSUE_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/g;
const GITHUB_COMMIT_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})/g;
const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const CROSS_REPO_ISSUE_RE = /(?<![\w./-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
const BARE_ISSUE_RE = /(?<![\w./&-])#(\d+)\b/g;
const BARE_SHA_RE = /(?<![\w/])([0-9a-f]{7,40})(?![\w/])/g;
const TASK_ITEM_RE = /^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/gm;

/** A path-ish token with an optional ":10" or ":10-20" line suffix. */
const PATH_TOKEN_RE =
  /(?<![\w@/\\-])((?:\.{1,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?)?(?![\w/])/g;

function toInt(value) {
  return value === undefined || value === null ? null : Number.parseInt(value, 10);
}

function extensionOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

function looksLikePath(candidate) {
  if (!candidate || candidate.length > 400) return false;
  if (candidate.includes('..') && !candidate.startsWith('../')) return false;
  const ext = extensionOf(candidate);
  if (!ext) return false;
  if (KNOWN_EXTENSIONS.has(ext)) return true;
  // An unknown extension still counts when the token is clearly a path, but a bare
  // "example.com" or "v1.2" must not be.
  return candidate.includes('/') && !/^\d+$/.test(ext);
}

function looksLikeSha(value) {
  // Require both a digit and a hex letter so English words and plain numbers drop out.
  return /\d/.test(value) && /[a-f]/.test(value);
}

/** Blank out a matched span so later passes cannot rediscover it. */
function blankSpans(text, spans) {
  if (!spans.length) return text;
  const chars = [...text];
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

function makeCollector() {
  const seen = new Set();
  const items = [];
  return {
    items,
    add(key, value) {
      if (seen.has(key)) return;
      seen.add(key);
      items.push(value);
    },
  };
}

/**
 * Extract every reference type from one block of markdown.
 * Returns partial arrays that extractReferences merges across sources.
 */
export function extractFromText(text, source, sourceId = null) {
  const files = makeCollector();
  const issues = makeCollector();
  const pullRequests = makeCollector();
  const commits = makeCollector();
  const urls = makeCollector();
  const codeBlocks = [];

  if (typeof text !== 'string' || text.trim() === '') {
    return { files: [], issues: [], pull_requests: [], commits: [], urls: [], code_blocks: [] };
  }

  const attribution = { source, source_id: sourceId };

  // 1. Fenced code blocks. The info string may carry an explicit path=.
  for (const match of text.matchAll(FENCE_RE)) {
    const info = (match[2] || '').trim();
    const [language = ''] = info.split(/\s+/);
    const pathAttr = /(?:^|\s)path=(["']?)([^\s"']+)\1/.exec(info);
    codeBlocks.push({
      language: language && !language.includes('=') ? language : null,
      path: pathAttr ? pathAttr[2] : null,
      content: match[3],
      ...attribution,
    });
    if (pathAttr) {
      const path = pathAttr[2];
      files.add(`${path}|||`, {
        path,
        line_start: null,
        line_end: null,
        ref: null,
        permalink: null,
        raw: info,
        via: 'code_fence_path',
        ...attribution,
      });
    }
  }

  // 2. GitHub permalinks, before generic URL handling, so line anchors survive.
  const consumed = [];
  for (const match of text.matchAll(GITHUB_BLOB_RE)) {
    const [raw, owner, repo, ref, path, lineStart, lineEnd] = match;
    consumed.push([match.index, match.index + raw.length]);
    files.add(`${path}|${lineStart ?? ''}|${lineEnd ?? ''}|${ref}`, {
      path,
      line_start: toInt(lineStart),
      line_end: toInt(lineEnd) ?? toInt(lineStart),
      ref,
      repo: `${owner}/${repo}`,
      permalink: raw,
      raw,
      via: 'permalink',
      ...attribution,
    });
  }

  for (const match of text.matchAll(GITHUB_ISSUE_URL_RE)) {
    const [raw, owner, repo, kind, number] = match;
    consumed.push([match.index, match.index + raw.length]);
    const target = kind === 'pull' ? pullRequests : issues;
    target.add(`${owner}/${repo}#${number}`, {
      repo: `${owner}/${repo}`,
      number: toInt(number),
      url: raw,
      ...attribution,
    });
  }

  for (const match of text.matchAll(GITHUB_COMMIT_URL_RE)) {
    const [raw, owner, repo, sha] = match;
    consumed.push([match.index, match.index + raw.length]);
    commits.add(sha, { sha, repo: `${owner}/${repo}`, url: raw, ...attribution });
  }

  // 3. Every URL, including the GitHub ones already classified above.
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    urls.add(url, { url, ...attribution });
  }

  // Blank the GitHub URLs so their path segments are not re-read as bare paths.
  const withoutGithubUrls = blankSpans(text, consumed);
  const remainingUrlSpans = [...withoutGithubUrls.matchAll(URL_RE)].map((m) => [
    m.index,
    m.index + m[0].length,
  ]);
  const scannable = blankSpans(withoutGithubUrls, remainingUrlSpans);

  // 4. Backticked paths, which are the most deliberate signal an author can give.
  for (const match of scannable.matchAll(INLINE_CODE_RE)) {
    const inner = match[1].trim();
    const pathMatch = new RegExp(`^${PATH_TOKEN_RE.source}$`).exec(inner);
    if (!pathMatch) continue;
    const [, path, lineStart, lineEnd] = pathMatch;
    if (!looksLikePath(path)) continue;
    files.add(`${path}|${lineStart ?? ''}|${lineEnd ?? ''}|`, {
      path,
      line_start: toInt(lineStart),
      line_end: toInt(lineEnd) ?? toInt(lineStart),
      ref: null,
      permalink: null,
      raw: inner,
      via: 'inline_code',
      ...attribution,
    });
  }

  // 5. Bare path-shaped tokens anywhere else, including inside stack traces.
  for (const match of scannable.matchAll(PATH_TOKEN_RE)) {
    const [raw, path, lineStart, lineEnd] = match;
    if (!looksLikePath(path)) continue;
    files.add(`${path}|${lineStart ?? ''}|${lineEnd ?? ''}|`, {
      path,
      line_start: toInt(lineStart),
      line_end: toInt(lineEnd) ?? toInt(lineStart),
      ref: null,
      permalink: null,
      raw: raw.trim(),
      via: 'bare_path',
      ...attribution,
    });
  }

  // 6. Issue and commit shorthand.
  for (const match of scannable.matchAll(CROSS_REPO_ISSUE_RE)) {
    const [, owner, repo, number] = match;
    issues.add(`${owner}/${repo}#${number}`, {
      repo: `${owner}/${repo}`,
      number: toInt(number),
      url: null,
      ...attribution,
    });
  }
  for (const match of scannable.matchAll(BARE_ISSUE_RE)) {
    const number = toInt(match[1]);
    issues.add(`#${number}`, { repo: null, number, url: null, ...attribution });
  }
  for (const match of scannable.matchAll(BARE_SHA_RE)) {
    const sha = match[1];
    if (!looksLikeSha(sha)) continue;
    commits.add(sha, { sha, repo: null, url: null, ...attribution });
  }

  return {
    files: files.items,
    issues: issues.items,
    pull_requests: pullRequests.items,
    commits: commits.items,
    urls: urls.items,
    code_blocks: codeBlocks,
  };
}

/**
 * Merge extraction across several sources.
 * Deduplication is per source, so a path named in both the body and the comment is
 * reported twice with different attribution — which is the point of tracking source.
 */
export function extractReferences(sources) {
  const merged = { files: [], issues: [], pull_requests: [], commits: [], urls: [], code_blocks: [] };
  for (const { text, source, source_id = null } of sources) {
    const part = extractFromText(text, source, source_id);
    for (const key of Object.keys(merged)) merged[key].push(...part[key]);
  }
  return merged;
}

/** Parse GitHub task-list checkboxes out of an issue body. */
export function extractTaskList(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(TASK_ITEM_RE)].map((match) => ({
    checked: match[1].toLowerCase() === 'x',
    text: match[2].trim(),
  }));
}
