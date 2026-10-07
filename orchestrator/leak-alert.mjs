/**
 * Page the admin when a publish is refused, then refuse it.
 *
 * leak.mjs stays a pure string check. The scanned text is not included in the alert: only
 * needle names, the task label, and the issue number. A retry of the same task and the same
 * names is quiet. A failed notify still throws.
 */

import { assertNoLeak, leakHits } from './leak.mjs';
import { createCoalescer, notifyAdmin } from '../src/notify.mjs';

const leakWindow = createCoalescer();

export async function refuseIfLeak(
  text,
  needles,
  { label = 'task', issueNumber = null, notify = notifyAdmin, coalescer = leakWindow } = {}
) {
  const hits = leakHits(text, needles);
  if (!hits.length) return;

  const key = `${label}\0${issueNumber ?? ''}\0${[...hits].sort().join(',')}`;
  if (coalescer.allow(key)) {
    const suffix = issueNumber == null ? '' : ` #${issueNumber}`;
    const where = suffix && !String(label).endsWith(suffix) ? `${label}${suffix}` : label;
    try {
      await notify({
        title: 'tmt leak',
        tags: 'rotating_light',
        body: `Leak refused for ${where}: ${hits.join(', ')}`,
      });
    } catch {
      // The publish is still refused below.
    }
  }
  assertNoLeak(text, needles);
}
