import { ACTIONS } from '../../src/triggers.mjs';
import { artifactKindForAction, ARTIFACT_KINDS } from '../artifacts.mjs';
import { renderExecuteSections } from './execute.mjs';
import { renderMonitorSections } from './monitor.mjs';
import { renderResearchSections } from './research.mjs';
import { renderSddSections } from './sdd.mjs';
import { renderTestSections } from './test.mjs';
import { renderTriageSections } from './triage.mjs';
import { renderWireframeSections } from './wireframe.mjs';

function isWireframeAction(action) {
  return action === ACTIONS.WIREFRAME || action === ACTIONS.GRAPHIC;
}

export function renderModeSections(ctx) {
  const { action } = ctx;
  const executeLabel = ctx.project.execute_label || 'agent:execute';

  if (action === ACTIONS.TRIAGE) {
    return renderTriageSections(ctx);
  }
  if (action === ACTIONS.EXECUTE) {
    return renderExecuteSections({ ...ctx, executeLabel });
  }
  if (action === ACTIONS.TEST) {
    return renderTestSections(ctx);
  }
  if (action === ACTIONS.RESEARCH) {
    return renderResearchSections({ ...ctx, executeLabel });
  }
  if (isWireframeAction(action)) {
    return renderWireframeSections({ ...ctx, executeLabel });
  }
  if (action === ACTIONS.MONITOR) {
    return renderMonitorSections({ ...ctx, executeLabel });
  }
  // SDD, OPENED, COMMENT — System Design / PLAN.md
  if (artifactKindForAction(action) === ARTIFACT_KINDS.PLAN) {
    return renderSddSections({ ...ctx, executeLabel });
  }
  return renderSddSections({ ...ctx, executeLabel });
}
