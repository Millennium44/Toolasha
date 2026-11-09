/** Equipment output warnings, independent of profit/output-total settings. */
import dataManager from '../../core/data-manager.js';
import { onDetailPanel, resolveDetailPanel, PANEL_SELECTOR } from '../../utils/action-panel-helper.js';
import { itemRequirementHtml, refreshItemRequirementWarnings } from '../../utils/item-requirements.js';

const EVENTS = ['skills_updated', 'action_completed', 'actions_updated', 'character_initialized', 'character_switched'];
const CLASS = 'mwi-action-item-requirements';

/**
 * Add warnings for the action's actual outputs (not refinement inputs or rare drops).
 * @param {Object} context - Resolved action panel and details
 */
export function renderActionItemRequirements({ panel, actionDetails }) {
    if (!panel) return;
    const hrids = [...new Set((actionDetails?.outputItems || []).map((item) => item.itemHrid).filter(Boolean))];
    const html = hrids
        .map((hrid) => itemRequirementHtml(hrid, { showName: hrids.length > 1 }))
        .filter(Boolean)
        .join('<br>');
    let group = panel.querySelector(`.${CLASS}`);
    const anchor =
        panel.querySelector('[class*="SkillActionDetail_outputItems"]') ||
        panel.querySelector('[class*="SkillActionDetail_dropTable"]');
    if (!html || !anchor) {
        group?.remove();
        return;
    }
    if (!group) {
        group = document.createElement('div');
        group.className = CLASS;
        group.style.cssText = 'margin:4px 0; line-height:1.4;';
        anchor.after(group);
    }
    // No replacing unchanged markup on a mutation dispatch: that would retrigger the shared observer.
    if (group._toolashaRequirementHtml !== html) {
        group.innerHTML = html;
        group._toolashaRequirementHtml = html;
    }
    refreshItemRequirementWarnings(panel);
}

let detach = null;

/** Refresh current action outputs and all already-rendered Watch/advisor warning slots. */
function refresh() {
    for (const panel of document.querySelectorAll(PANEL_SELECTOR))
        renderActionItemRequirements(resolveDetailPanel(panel));
    refreshItemRequirementWarnings();
}

/** Start once with the existing action-panel observer; no polling or game actions. */
export function initializeItemRequirementWarnings() {
    if (detach) return;
    detach = onDetailPanel(renderActionItemRequirements);
    for (const event of EVENTS) dataManager.on(event, refresh);
    refresh();
}

/** Remove listeners and our action-panel nodes when the observer is disabled. */
export function cleanupItemRequirementWarnings() {
    detach?.();
    detach = null;
    for (const event of EVENTS) dataManager.off(event, refresh);
    document.querySelectorAll(`.${CLASS}`).forEach((node) => node.remove());
}
