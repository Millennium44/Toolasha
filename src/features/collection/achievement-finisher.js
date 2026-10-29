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
 * at the existing planners. Every other row shows the game's own description,
 * and — when the achievement resolves to a game action, zone or item (see
 * achievement-finisher-resolve.js) — a readiness hint and a Go button. Go only
 * navigates: it opens the action, the alchemy tab, the combat zone at its tier,
 * or the marketplace, and never starts, queues or buys anything. Nothing is
 * summed across a tier.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import { countsByMonster, totalBestiaryPoints } from '../../utils/bestiary.js';
import { collectionCounts, totalCollectionPoints } from './collection-optimizer-plan.js';
import { buildTierChecklists, nameFromHrid } from './achievement-finisher-model.js';
import { readiness, resolveAchievement, sortRemaining } from './achievement-finisher-resolve.js';
import { getGameObject, navigateToAction } from '../../utils/item-navigation.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { openCombatZoneAtTier } from '../../utils/combat-zone-open.js';
import { openAlchemyOnItem, selectAlchemyTab } from '../../utils/alchemy-navigation.js';
import { getItemPriceInfo } from '../../utils/market-data.js';
import { isIronCowCharacter } from '../../utils/ironcow-valuation.js';
import { combatLevel } from '../../utils/combat-level.js';
import { formatKMB } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

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

/** Game events that change readiness (stock, levels, prices) but not the checklist itself */
const READINESS_EVENTS = [
    'items_updated',
    'skills_updated',
    'market_item_order_books_updated',
    'market_item_values_updated',
];

/** Toolasha settings that change a buy cost */
const READINESS_SETTINGS = ['profitCalc_pricingMode'];

/** Readiness redraws are coalesced: an inventory update lands with every finished action */
const READINESS_REDRAW_MS = 1000;

const skillName = (clientData, skillHrid) => clientData?.skillDetailMap?.[skillHrid]?.name || nameFromHrid(skillHrid);
const itemName = (clientData, itemHrid) => clientData?.itemDetailMap?.[itemHrid]?.name || nameFromHrid(itemHrid);

/**
 * The readiness hint for a resolved row.
 * @param {Object} res - Resolution
 * @param {Object} ready - From `readiness`
 * @param {Object|null} clientData
 * @param {number|null} ownCombatLevel
 * @returns {string}
 */
export function readinessText(res, ready, clientData, ownCombatLevel) {
    const parts = [];
    const lv = ready.level;
    if (res.kind === 'combat') {
        if (res.dungeon) parts.push('dungeon');
        parts.push(`T${res.tier}`);
        if (lv && lv.met === true) parts.push('level met');
        else if (lv && lv.met === false) parts.push(`needs Lv ${lv.need} (you ${lv.have})`);
        else if (lv) parts.push('level unknown');
        else parts.push('no level requirement');
        // A solo fight: the levels to weigh it by, without running the sim
        if (Number.isFinite(ownCombatLevel)) parts.push(`your Combat Lv ${ownCombatLevel}`);
        if (res.monsterLevel) parts.push(`monster Lv ${res.monsterLevel}`);
        return parts.join(' · ');
    }

    if (lv?.met === true) parts.push('level met');
    else if (lv?.met === false) parts.push(`needs ${skillName(clientData, lv.skillHrid)} ${lv.need} (you ${lv.have})`);
    else parts.push('level unknown');

    if (res.kind === 'equip') {
        if (ready.owned === true) parts.push(`in inventory: ${itemName(clientData, ready.ownedHrid)}`);
        else if (ready.owned === null) parts.push('inventory not loaded');
        else if (ready.buyHrid)
            parts.push(
                `cheapest: ${itemName(clientData, ready.buyHrid)} ~${formatKMB(ready.cost)}${ready.estimated ? ' (est.)' : ''}`
            );
        else if (ready.unpriced.length > 0) parts.push('not owned, no price for any');
        else parts.push('not owned');
        return parts.join(' · ');
    }

    if (ready.owned === true) parts.push('materials owned');
    else if (ready.owned === null) parts.push('inventory not loaded');
    else if (Number.isFinite(ready.cost))
        parts.push(`buy ~${formatKMB(ready.cost)}${ready.estimated ? ' (est.)' : ''}`);
    else if (ready.unpriced.length > 0) {
        const names = ready.unpriced.map((hrid) => itemName(clientData, hrid)).join(', ');
        parts.push(
            ready.partialCost > 0 ? `buy ≥ ~${formatKMB(ready.partialCost)}, unpriced: ${names}` : `unpriced: ${names}`
        );
    } else parts.push(`missing ${ready.shortfall.length} input${ready.shortfall.length === 1 ? '' : 's'}`);
    return parts.join(' · ');
}

/**
 * Whether a resolved row gets a Go button: every kind does, except an equip row with nothing to buy
 * (already owned, unpriced everywhere, or an Iron Cow character).
 * @param {Object} res
 * @param {Object|null} ready
 * @returns {boolean}
 */
export function hasGoButton(res, ready) {
    if (res.kind !== 'equip') return true;
    return Boolean(ready?.buyHrid);
}

class AchievementFinisher {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.handlers = [];
        this.collapsed = true;
        this.openTiers = new Set();
        this.timers = createTimerRegistry();
        /** achievement hrid → resolution (or null), for the client data in `resolutionSource` */
        this.resolutions = new Map();
        this.resolutionSource = null;
        /** `${characterId}|${achievement hrid}` → {version, value} */
        this.readinessCache = new Map();
        this.readinessVersion = 0;
        this.readinessRedrawPending = false;
        this.marketListener = null;
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
        const clear = () => {
            this.readinessCache.clear();
            this.readinessVersion += 1;
            this.removePanel();
        };
        dataManager.on('character_switching', clear);
        this.handlers.push(['character_switching', clear]);

        const stale = () => this.readinessChanged();
        for (const event of READINESS_EVENTS) {
            dataManager.on(event, stale);
            this.handlers.push([event, stale]);
        }
        for (const key of READINESS_SETTINGS) {
            const off = config.onSettingChange?.(key, stale);
            if (typeof off === 'function') this.unregisterHandlers.push(off);
        }
        this.marketListener = stale;
        marketAPI.on?.(stale);

        this.mount();
    }

    disable() {
        this.unregisterHandlers.forEach((fn) => fn());
        this.unregisterHandlers = [];
        for (const [event, fn] of this.handlers) dataManager.off(event, fn);
        this.handlers = [];
        if (this.marketListener) marketAPI.off?.(this.marketListener);
        this.marketListener = null;
        this.timers.clearAll();
        this.readinessRedrawPending = false;
        this.removePanel();
        this.collapsed = true;
        this.openTiers = new Set();
        this.resolutions = new Map();
        this.resolutionSource = null;
        this.readinessCache = new Map();
        this.isInitialized = false;
    }

    /** Stock, levels or prices moved: readiness is stale, and an open tier redraws once shortly after */
    readinessChanged() {
        if (!this.isInitialized) return;
        this.readinessVersion += 1;
        if (this.collapsed || this.openTiers.size === 0 || this.readinessRedrawPending) return;
        this.readinessRedrawPending = true;
        this.timers.scheduleTimeout(() => {
            this.readinessRedrawPending = false;
            this.refresh();
        }, READINESS_REDRAW_MS);
    }

    /**
     * The resolution of one achievement, cached for as long as the client data is the same object.
     * @param {string} hrid
     * @param {Object|null} clientData
     * @returns {Object|null}
     */
    resolutionFor(hrid, clientData) {
        if (clientData !== this.resolutionSource) {
            this.resolutions = new Map();
            this.resolutionSource = clientData;
        }
        if (!this.resolutions.has(hrid)) {
            let res = null;
            try {
                res = resolveAchievement(clientData?.achievementDetailMap?.[hrid], {
                    actionDetailMap: clientData?.actionDetailMap,
                    itemDetailMap: clientData?.itemDetailMap,
                    combatMonsterDetailMap: clientData?.combatMonsterDetailMap,
                });
            } catch (error) {
                console.error('[AchievementFinisher] Resolving failed for', hrid, error);
            }
            this.resolutions.set(hrid, res);
        }
        return this.resolutions.get(hrid);
    }

    /** What readiness reads, gathered once per render */
    readinessContext() {
        const skills = dataManager.getSkills?.() ?? null;
        const skillLevels = skills ? new Map(skills.map((skill) => [skill.skillHrid, skill.level])) : null;
        let ownCombat = null;
        if (skills) {
            const byName = {};
            for (const skill of skills) byName[String(skill.skillHrid).split('/').pop()] = skill.level;
            ownCombat = combatLevel(byName).level;
        }
        // Prices read off the game's value map rather than a live book, so the hint can say so
        const estimated = new Set();
        return {
            skillLevels,
            combatLevel: ownCombat,
            inventory: dataManager.getInventory?.() ?? null,
            ironCow: isIronCowCharacter(),
            buyPrice: (itemHrid) => {
                const info = getItemPriceInfo(itemHrid, { context: 'profit', side: 'buy', marketQuote: true });
                if (!Number.isFinite(info.price)) return null;
                if (info.estimated) estimated.add(itemHrid);
                return info.price;
            },
            isEstimated: (itemHrid) => estimated.has(itemHrid),
        };
    }

    /**
     * Readiness of one resolved achievement, cached per character until stock, levels or prices move.
     * @param {string} hrid
     * @param {Object} res
     * @param {() => Object} getContext
     * @returns {Object|null}
     */
    readinessFor(hrid, res, getContext) {
        const key = `${dataManager.getCurrentCharacterId?.() ?? ''}|${hrid}`;
        const hit = this.readinessCache.get(key);
        if (hit && hit.version === this.readinessVersion) return hit.value;
        let value = null;
        try {
            value = readiness(res, getContext());
        } catch (error) {
            console.error('[AchievementFinisher] Readiness failed for', hrid, error);
        }
        this.readinessCache.set(key, { version: this.readinessVersion, value });
        return value;
    }

    /**
     * Open the game where the player can do a resolved achievement. Navigation only: the
     * player presses the game's own Start, Add Queue or Buy.
     * @param {Object} res
     * @param {Object|null} ready
     */
    go(res, ready) {
        try {
            switch (res.kind) {
                case 'production':
                    navigateToAction(res.actionHrid);
                    break;
                case 'alchemy': {
                    const characterId = dataManager.getCurrentCharacterId?.();
                    const opened = openAlchemyOnItem(getGameObject(), {
                        itemHrid: res.itemHrid,
                        actionType: res.alchemyType,
                    });
                    if (!opened) break;
                    selectAlchemyTab(
                        res.alchemyType,
                        this.timers.scheduleTimeout,
                        () => this.isInitialized && dataManager.getCurrentCharacterId?.() === characterId
                    ).catch((error) => console.error('[AchievementFinisher] Alchemy tab failed:', error));
                    break;
                }
                case 'combat':
                    openCombatZoneAtTier(res.actionHrid, res.tier).catch((error) =>
                        console.error('[AchievementFinisher] Opening the zone failed:', error)
                    );
                    break;
                case 'equip':
                    if (ready?.buyHrid) navigateToMarketplace(ready.buyHrid, 0);
                    break;
                default:
                    break;
            }
        } catch (error) {
            console.error('[AchievementFinisher] Navigation failed:', error);
        }
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
                // The Achievements header centers its text; the checklist reads as a list
                'margin:6px 0;padding:6px 8px;border:1px solid #444;border-radius:6px;background:rgba(0,0,0,0.25);font-size:12px;color:#ddd;text-align:left;'
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

        const view = { clientData, context: null };
        for (const tier of result.tiers) root.appendChild(this.renderTier(root, tier, view));
        root.appendChild(
            el(
                'div',
                'margin-top:6px;color:#888;',
                'The game data lists each achievement as done or not done, not progress inside one. Go only opens the screen; nothing is started or bought.'
            )
        );
    }

    renderTier(root, tier, view = { clientData: null, context: null }) {
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
        // Readiness is read only for an open tier, from one context per render
        const getContext = () => (view.context ||= this.readinessContext());
        const rows = tier.remaining.map((item) => {
            if (item.planner) return { item, res: null, readiness: null };
            const res = this.resolutionFor(item.hrid, view.clientData);
            return { item, res, readiness: res ? this.readinessFor(item.hrid, res, getContext) : null };
        });
        for (const { item, res, readiness: ready } of sortRemaining(rows)) {
            const row = el('div', 'margin-left:14px;');
            row.className = `${PANEL_CLASS}-item`;
            let text = `○ ${item.name}`;
            if (item.progress) text += ` — ${Math.floor(item.progress.current)} / ${item.progress.target} points`;
            else if (item.planner) text += ' — progress not loaded (open that tab once)';
            else if (item.description) text += ` — ${item.description}`;
            row.appendChild(el('span', '', text));
            if (item.planner) {
                row.appendChild(el('span', 'margin-left:6px;color:#8ab;', `[${PLANNER_HINT[item.planner]}]`));
            }
            if (res && ready) {
                const hint = el(
                    'span',
                    'margin-left:6px;color:#aaa;',
                    `[${readinessText(res, ready, view.clientData, getContext().combatLevel)}]`
                );
                hint.className = `${PANEL_CLASS}-ready`;
                row.appendChild(hint);
                if (hasGoButton(res, ready)) {
                    const button = el(
                        'button',
                        'margin-left:6px;padding:0 6px;font-size:11px;cursor:pointer;background:#2a3a4a;color:#ddd;border:1px solid #567;border-radius:3px;',
                        'Go'
                    );
                    button.type = 'button';
                    button.className = `${PANEL_CLASS}-go`;
                    button.addEventListener('click', (event) => {
                        event.stopPropagation();
                        this.go(res, ready);
                    });
                    row.appendChild(button);
                }
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
