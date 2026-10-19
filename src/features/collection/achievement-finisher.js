/**
 * Achievement-tier finisher.
 *
 * A collapsible panel on the player's own Achievements page that lists, per
 * achievement tier, what is done, what is left, and the reward for finishing
 * the tier. Read-only and event-driven: it draws from the data manager's
 * catalog and the character's own achievement list, and redraws on
 * `achievements_updated` and on a character change. It stores nothing.
 *
 * The page is found by the game's `AchievementsPanel_*` classes (never by
 * visible text), and only the outermost such element that is not the
 * Collections or Bestiary tab and not inside a profile or dialog is used, so
 * another player's shared profile never gets one.
 *
 * Remaining work is a checklist. The only progress figures are the Collection
 * and Bestiary point totals for the two point-total achievements, which point
 * at the existing planners; nothing else is estimated, and nothing is summed
 * across a tier.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { countsByMonster, totalBestiaryPoints } from '../../utils/bestiary.js';
import { collectionCounts, totalCollectionPoints } from './collection-optimizer-plan.js';
import { buildTierChecklists } from './achievement-finisher-model.js';

/** The setting that turns the panel on */
export const SETTING_KEY = 'achievementFinisher';

/** The panel's root class */
export const PANEL_CLASS = 'toolasha-achfin';

/** Classes of the Achievements page that are not the tier-list tab, or only parts of a tab */
const NOT_THE_LIST =
    /AchievementsPanel_(collections|bestiary|monsters|controls|categories|checkboxControl|refreshButton)/i;

/** Where a panel must never go: shared profiles and dialogs */
const EXCLUDED_ANCESTORS = '[class*="SharableProfile_"], [class*="Modal"], [class*="Dialog"], [role="dialog"]';

const OTHER_TABS = '[class*="AchievementsPanel_collections"], [class*="AchievementsPanel_bestiary"]';

/**
 * The element on the Achievements page that holds the tier list, if on screen.
 * @param {ParentNode} [root]
 * @returns {Element|null}
 */
export function findAchievementsHost(root = document) {
    const candidates = [...root.querySelectorAll('[class*="AchievementsPanel_"]')].filter((node) => {
        const cls = typeof node.className === 'string' ? node.className : '';
        if (NOT_THE_LIST.test(cls)) return false;
        if (node.closest(EXCLUDED_ANCESTORS)) return false;
        // Part of the Collections / Bestiary tab, or a wrapper holding one: not the tier list
        if (node.closest(OTHER_TABS)) return false;
        if (node.querySelector(OTHER_TABS)) return false;
        return true;
    });
    // Outermost only: a candidate inside another candidate is a part of it
    return candidates.find((node) => !candidates.some((other) => other !== node && other.contains(node))) || null;
}

function el(tag, style = '', text = '') {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text) node.textContent = text;
    return node;
}

/** @returns {{collection: number|null, bestiary: number|null}} Totals; null where the tab has not loaded them */
function currentPoints() {
    const collections = dataManager.getCharacterCollections?.();
    const monsters = dataManager.getCharacterMonsters?.();
    return {
        collection: collections ? totalCollectionPoints(collectionCounts(collections)) : null,
        bestiary: monsters ? totalBestiaryPoints(countsByMonster(monsters)) : null,
    };
}

/**
 * The reward line for a tier.
 * @param {{complete: boolean, reward: {label: string, inferred: boolean}|null}} tier
 * @returns {string}
 */
export function rewardText(tier) {
    if (!tier.reward) return 'Reward: unknown';
    const lead = tier.complete ? 'Reward earned' : 'Reward on completion';
    return `${lead}: ${tier.reward.label}${tier.reward.inferred ? ' (inferred, not verified)' : ''}`;
}

const PLANNER_HINT = {
    collection: 'Collections tab: Collection Points Optimizer',
    bestiary: 'Combat simulator: Bestiary plan',
};

class AchievementFinisher {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.handlers = [];
        this.collapsed = true;
        this.openTiers = new Set();
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING_KEY)) return;
        this.isInitialized = true;

        this.unregisterHandlers.push(
            domObserver.onClass('AchievementFinisher-panel', 'AchievementsPanel_', () => this.mount())
        );

        const redraw = () => this.refresh();
        for (const event of [
            'achievements_updated',
            'character_initialized',
            'collections_updated',
            'monsters_updated',
        ]) {
            dataManager.on(event, redraw);
            this.handlers.push([event, redraw]);
        }
        // A character leaving: its checklist must not stay on screen for the next one
        const clear = () => this.removePanel();
        dataManager.on('character_switching', clear);
        this.handlers.push(['character_switching', clear]);

        this.mount();
    }

    disable() {
        this.unregisterHandlers.forEach((fn) => fn());
        this.unregisterHandlers = [];
        for (const [event, fn] of this.handlers) dataManager.off(event, fn);
        this.handlers = [];
        this.removePanel();
        this.collapsed = true;
        this.openTiers = new Set();
        this.isInitialized = false;
    }

    cleanup() {
        this.disable();
    }

    removePanel() {
        document.querySelectorAll(`.${PANEL_CLASS}`).forEach((node) => node.remove());
    }

    /** Put the panel onto the Achievements page if it is showing and has none. */
    mount() {
        if (!this.isInitialized) return;
        const host = findAchievementsHost();
        if (!host) return;
        let root = host.querySelector(`:scope > .${PANEL_CLASS}`);
        if (!root) {
            this.removePanel();
            root = el(
                'div',
                'margin:6px 0;padding:6px 8px;border:1px solid #444;border-radius:6px;background:rgba(0,0,0,0.25);font-size:12px;color:#ddd;'
            );
            root.className = PANEL_CLASS;
            host.insertBefore(root, host.firstChild);
        }
        this.render(root);
    }

    refresh() {
        if (!this.isInitialized) return;
        const root = document.querySelector(`.${PANEL_CLASS}`);
        if (root) this.render(root);
        else this.mount();
    }

    render(root) {
        root.replaceChildren();
        const clientData = dataManager.getInitClientData?.();
        const result = buildTierChecklists({
            detailMap: clientData?.achievementDetailMap,
            tierDetailMap: clientData?.achievementTierDetailMap ?? null,
            achievements: dataManager.getCharacterAchievements?.() ?? null,
            points: currentPoints(),
        });

        const header = el(
            'div',
            'display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:bold;flex-wrap:wrap;'
        );
        header.className = `${PANEL_CLASS}-header`;
        header.appendChild(el('span', '', `${this.collapsed ? '▸' : '▾'} Achievement tier finisher`));
        const summary =
            result.state === 'ok'
                ? `${result.completeTiers} of ${result.tiers.length} tiers complete`
                : 'progress unknown';
        header.appendChild(el('span', 'font-weight:normal;color:#aaa;', summary));
        header.addEventListener('click', () => {
            this.collapsed = !this.collapsed;
            this.render(root);
        });
        root.appendChild(header);
        if (this.collapsed) return;

        if (result.state === 'unknown') {
            const why =
                result.reason === 'catalog'
                    ? 'The achievement list from the game has not loaded yet, so tier progress is unknown.'
                    : 'Your achievement progress has not loaded yet, so tier progress is unknown.';
            const note = el('div', 'margin-top:4px;color:#aaa;', why);
            note.className = `${PANEL_CLASS}-unknown`;
            root.appendChild(note);
            return;
        }

        for (const tier of result.tiers) root.appendChild(this.renderTier(root, tier));
        root.appendChild(
            el(
                'div',
                'margin-top:6px;color:#888;',
                'The game data lists each achievement as done or not done; it does not give progress inside one, so none is shown.'
            )
        );
    }

    renderTier(root, tier) {
        const block = el('div', 'margin-top:6px;');
        block.className = `${PANEL_CLASS}-tier`;
        const open = this.openTiers.has(tier.tierHrid);
        const title = el('div', 'cursor:pointer;display:flex;gap:8px;flex-wrap:wrap;');
        title.appendChild(
            el(
                'span',
                `font-weight:bold;color:${tier.complete ? '#6c6' : '#ddd'};`,
                `${open ? '▾' : '▸'} ${tier.name} ${tier.doneCount}/${tier.total}${tier.complete ? ' ✓' : ''}`
            )
        );
        const reward = el('span', 'color:#aaa;', rewardText(tier));
        reward.className = `${PANEL_CLASS}-reward`;
        title.appendChild(reward);
        title.addEventListener('click', () => {
            if (this.openTiers.has(tier.tierHrid)) this.openTiers.delete(tier.tierHrid);
            else this.openTiers.add(tier.tierHrid);
            this.render(root);
        });
        block.appendChild(title);
        if (!open) return block;

        if (tier.complete) {
            block.appendChild(el('div', 'margin-left:14px;color:#6c6;', 'Every achievement in this tier is done.'));
        }
        for (const item of tier.remaining) {
            const row = el('div', 'margin-left:14px;');
            row.className = `${PANEL_CLASS}-item`;
            let text = `○ ${item.name}`;
            if (item.progress) text += ` — ${Math.floor(item.progress.current)} / ${item.progress.target} points`;
            else if (item.planner) text += ' — progress not loaded (open that tab once)';
            else text += ' — progress unavailable';
            row.appendChild(el('span', '', text));
            if (item.planner) {
                row.appendChild(el('span', 'margin-left:6px;color:#8ab;', `[${PLANNER_HINT[item.planner]}]`));
            }
            block.appendChild(row);
        }
        for (const item of tier.done) {
            const row = el('div', 'margin-left:14px;color:#888;', `✓ ${item.name}`);
            row.className = `${PANEL_CLASS}-done`;
            block.appendChild(row);
        }
        return block;
    }
}

const achievementFinisher = new AchievementFinisher();

export default achievementFinisher;
