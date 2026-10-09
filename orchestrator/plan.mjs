/**
 * Compatibility surface for plan-era imports.
 * Prefer `artifacts.mjs` for new code.
 */
export {
  ARTIFACT_KINDS,
  artifactBranchLink,
  artifactKindForAction,
  artifactPermalink,
  cardMarker,
  commitsArtifactOnly,
  compareLink,
  extractNeedsFromYou,
  extractPlanSummary,
  extractSummary,
  isArtifactAction,
  isExecuteAction,
  isMentionHelpAction,
  isTestAction,
  isTriageAction,
  isTmtCardComment,
  MENTION_HELP_MARKER,
  renderMentionHelpComment,
  needsTaskBranch,
  planBranchLink,
  planPermalink,
  renderArtifactCard,
  renderPlanComment,
  resolveArtifactRelativePath,
  resolveIssueArtifactDir,
  resolvePlanRelativePath,
  resolveTestRelativePath,
} from './artifacts.mjs';

import { ACTIONS } from '../src/triggers.mjs';
import { artifactKindForAction, ARTIFACT_KINDS, isArtifactAction } from './artifacts.mjs';

/** Actions whose deliverable is a revision of PLAN.md (System Design). */
export function isPlanAction(action) {
  return isArtifactAction(action) && artifactKindForAction(action) === ARTIFACT_KINDS.PLAN;
}

/** True for any stage-file revision mode (research, UX, SDD, monitor). */
export function isStageArtifactAction(action) {
  return isArtifactAction(action);
}

export { ACTIONS };
