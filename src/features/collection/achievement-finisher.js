/**
 * Achievement hints on the game's own achievement cards.
 *
 * Each unfinished card on the player's own Achievements tab gets one line under
 * its description: a readiness hint (level, stock, cost to buy), a Go button
 * and, where inputs are short, a Missing Mats button. Finished cards, and
 * achievements that resolve to nothing the game can open (see
 * achievement-finisher-resolve.js), get nothing. The point-total achievements
 * get nothing either: the game card shows that progress itself.
 *
 * Go and Missing Mats only navigate: they open the action, the alchemy tab, the
 * combat zone at its tier, or the marketplace, and never start, queue or buy.
 *
 * A "Toolasha hints" checkbox beside the game's "Show Incomplete Only" control
 * flips the feature's own setting. The checkbox is drawn whenever the tier list
 * is on screen, even with the setting off, so a player can turn the hints back
 * on; the registry entry therefore always initializes this module and the module
 * gates the card additions on the setting itself.
 *
 * Nothing is stored. Everything is drawn from the data manager's catalog and
 * the character's own achievement list, redrawn on `achievements_updated`, on
 * stock/price/level events (coalesced) and when the game re-renders its cards.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import { nameFromHrid, plannerFor } from './achievement-finisher-model.js';
import { readiness, resolveAchievement } from './achievement-finisher-resolve.js';
import { getGameObject, navigateToAction } from '../../utils/item-navigation.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { openCombatZoneAtTier } from '../../utils/combat-zone-open.js';
import { openAlchemyOnItem, selectAlchemyTab } from '../../utils/alchemy-navigation.js';
import { getItemPriceInfo } from '../../utils/market-data.js';
import { missingMaterialsButton } from '../../utils/bundle-bridge.js';
import { isIronCowCharacter } from '../../utils/ironcow-valuation.js';
import { combatLevel } from '../../utils/combat-level.js';
import { formatKMB } from '../../utils/formatters.js';
import { spriteIcon, spriteUrl } from '../../utils/overlay-format.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/** The setting that turns the panel on */
export const SETTING_KEY = 'achievementFinisher';

/** Class prefix of everything this module adds to the page */
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
    // The Achievements tab's own panel (controls + tier sections). The game keeps the
    // Collections and Bestiary tab panels mounted beside it, so the outermost-wrapper search
    // below would land on the page title instead; measured live on 2026-10-29.
    const tabPanel = [...root.querySelectorAll('[class*="AchievementsPanel_achievements__"]')].find(
        (node) => !node.closest(EXCLUDED_ANCESTORS) && !node.closest(OTHER_TABS)
    );
    if (tabPanel) return tabPanel;
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

/** Marks where a gold amount ends in a readiness hint; drawn as the game's coin icon */
const COIN_MARK = '';

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
                `cheapest: ${itemName(clientData, ready.buyHrid)} ~${formatKMB(ready.cost)}${COIN_MARK}${ready.estimated ? ' (est.)' : ''}`
            );
        else if (ready.unpriced.length > 0) parts.push('not owned, no price for any');
        else parts.push('not owned');
        return parts.join(' · ');
    }

    if (ready.owned === true) parts.push('materials owned');
    else if (ready.owned === null) parts.push('inventory not loaded');
    else if (Number.isFinite(ready.cost))
        parts.push(`buy ~${formatKMB(ready.cost)}${COIN_MARK}${ready.estimated ? ' (est.)' : ''}`);
    else if (ready.unpriced.length > 0) {
        const names = ready.unpriced.map((hrid) => itemName(clientData, hrid)).join(', ');
        parts.push(
            ready.partialCost > 0
                ? `buy ≥ ~${formatKMB(ready.partialCost)}${COIN_MARK}, unpriced: ${names}`
                : `unpriced: ${names}`
        );
    } else parts.push(`missing ${ready.shortfall.length} input${ready.shortfall.length === 1 ? '' : 's'}`);
    return parts.join(' · ');
}

/**
 * A readiness hint as a span, with each gold amount followed by the game's coin icon
 * (the word "coin" until the game has drawn from its item sheet).
 * @param {string} text - From `readinessText`
 * @returns {HTMLSpanElement}
 */
function hintWithCoins(text) {
    const span = el('span', 'margin-left:6px;color:#aaa;');
    const pieces = text.split(COIN_MARK);
    pieces.forEach((piece, i) => {
        if (piece) span.appendChild(document.createTextNode(piece));
        if (i === pieces.length - 1) return;
        if (!spriteUrl('items')) {
            span.appendChild(document.createTextNode(' coin'));
            return;
        }
        const icon = spriteIcon('coin', 12);
        icon.style.verticalAlign = 'middle';
        icon.style.marginLeft = '2px';
        span.appendChild(icon);
    });
    return span;
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

/**
 * The bill lines a Missing Mats press would open tabs for: this row's short inputs, one action's worth.
 * Empty for a row that is not a production or alchemy one, is owned, or is an Iron Cow's (which cannot buy).
 * @param {Object} res
 * @param {Object|null} ready - From `readiness`
 * @param {Object|null} clientData
 * @param {boolean} ironCow
 * @returns {Array<Object>}
 */
export function missingMatsLines(res, ready, clientData, ironCow) {
    if (res.kind !== 'production' && res.kind !== 'alchemy') return [];
    if (!ready || ironCow || ready.owned !== false) return [];
    const lines = (ready.shortfall || []).map((short) => ({
        itemHrid: short.itemHrid,
        itemName: itemName(clientData, short.itemHrid),
        missing: short.need - short.have,
        isTradeable: clientData?.itemDetailMap?.[short.itemHrid]?.isTradable === true,
    }));
    // The action panel's own filter (missing-materials-button.js `buyableMissing`): coins never
    // reach the bill and an untradeable line cannot be bought
    return lines.filter((m) => m.isTradeable !== false && m.missing > 0 && m.itemHrid !== '/items/coin');
}

/**
 * The Missing Mats button for a resolved row, or null when the row has nothing to buy.
 * Takes the row and returns DOM, so any list of these rows can reuse it.
 * @param {Object} res
 * @param {Object|null} ready
 * @param {Object|null} clientData
 * @param {boolean} ironCow
 * @param {() => void} onPress
 * @returns {HTMLButtonElement|null}
 */
export function createMissingMatsButton(res, ready, clientData, ironCow, onPress) {
    // No button when the actions bundle (which owns the opener) is not loaded
    if (!missingMaterialsButton()) return null;
    const lines = missingMatsLines(res, ready, clientData, ironCow);
    if (lines.length === 0) return null;
    const mats = el(
        'button',
        'margin-left:6px;padding:0 6px;font-size:11px;cursor:pointer;color:#fff;background:linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%);border:1px solid rgba(91,141,239,0.4);border-radius:3px;',
        'Missing Mats'
    );
    mats.type = 'button';
    mats.className = `${PANEL_CLASS}-mats`;
    mats.title = `Will buy: ${lines.map((m) => `${m.itemName} ×${formatKMB(m.missing)}`).join(', ')}`;
    mats.addEventListener('click', (event) => {
        event.stopPropagation();
        onPress();
    });
    return mats;
}

/** Selector assumptions about the game's markup (class prefixes, not hashes); check live */
export const CARD_SELECTOR = '[class*="Achievement_achievement__"]';
const CHECKBOX_CONTROL_SELECTOR = '[class*="AchievementsPanel_checkboxControl"]';
const LINE_CLASS = `${PANEL_CLASS}-line`;
const TOGGLE_CLASS = `${PANEL_CLASS}-toggle`;
const TOGGLE_LABEL = 'Toolasha hints';
const INCOMPLETE_LABEL = /incomplete/i;

const CHECKED_SVG =
    '<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall" focusable="false" aria-hidden="true" viewBox="0 0 24 24"><path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path></svg>';
const UNCHECKED_SVG =
    '<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeSmall" focusable="false" aria-hidden="true" viewBox="0 0 24 24"><path d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"></path></svg>';

/** Whether the hints are switched on */
const hintsOn = () => Boolean(config.getSetting(SETTING_KEY));

/**
 * The achievement cards inside the tier list: outermost `Achievement_*` elements only, never the
 * game's own `AchievementsPanel_*` wrappers, and never our additions.
 * @param {Element} host
 * @returns {Element[]}
 */
export function findCards(host) {
    const nodes = [...host.querySelectorAll(CARD_SELECTOR)].filter((node) => !node.closest(`.${LINE_CLASS}`));
    return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
}

/**
 * The achievement a card shows, from its icon: the sprite id in `achievements_sprite` is the hrid's last
 * segment (`#cook_peach_yogurt` is `/achievements/cook_peach_yogurt`).
 * @param {Element} card
 * @param {Object} detailMap
 * @returns {string|null}
 */
function hridFromIcon(card, detailMap) {
    for (const use of card.querySelectorAll('svg use')) {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        if (!href.includes('achievements_sprite')) continue;
        const id = href.split('#')[1];
        const hrid = id ? `/achievements/${id}` : null;
        if (hrid && detailMap?.[hrid]) return hrid;
    }
    return null;
}

/** The visible text of every leaf element under a card, first element per text */
function leafTexts(card) {
    const texts = new Map();
    for (const node of card.querySelectorAll('*')) {
        if (node.childElementCount > 0 || node.closest(`.${LINE_CLASS}`)) continue;
        const text = node.textContent.trim();
        if (text && !texts.has(text)) texts.set(text, node);
    }
    return texts;
}

class AchievementFinisher {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.handlers = [];
        this.timers = createTimerRegistry();
        /** achievement hrid → resolution (or null), for the client data in `resolutionSource` */
        this.resolutions = new Map();
        this.resolutionSource = null;
        /** `${characterId}|${achievement hrid}` → {version, value} */
        this.readinessCache = new Map();
        this.readinessVersion = 0;
        this.readinessRedrawPending = false;
        this.marketListener = null;
        this.catalogSource = null;
        this.catalog = null;
    }

    /** Always runs when the module is loaded: the checkbox must exist to turn the hints back on */
    initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        this.unregisterHandlers.push(
            domObserver.onClass('AchievementFinisher-cards', ['AchievementsPanel_', 'Achievement_'], () => this.mount())
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
        // A character leaving: its hints must not stay on screen for the next one
        const clear = () => {
            this.readinessCache.clear();
            this.readinessVersion += 1;
            this.removeAll();
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
        const offSetting = config.onSettingChange?.(SETTING_KEY, redraw);
        if (typeof offSetting === 'function') this.unregisterHandlers.push(offSetting);
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
        this.removeAll();
        this.resolutions = new Map();
        this.resolutionSource = null;
        this.readinessCache = new Map();
        this.catalogSource = null;
        this.catalog = null;
        this.isInitialized = false;
    }

    cleanup() {
        this.disable();
    }

    /** Stock, levels or prices moved: readiness is stale, and the visible hints redraw once shortly after */
    readinessChanged() {
        if (!this.isInitialized) return;
        this.readinessVersion += 1;
        if (!hintsOn() || this.readinessRedrawPending || !document.querySelector(`.${LINE_CLASS}`)) return;
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

    /**
     * Open the marketplace on one action's missing inputs, the same path as the action panel's
     * Missing Mats Marketplace button. Navigation only: nothing is bought.
     * @param {Object} res
     */
    openMissingMats(res) {
        try {
            // Read through the bridge: the opener lives in the actions bundle, and importing it
            // here would copy its calculators into this one
            const opener = missingMaterialsButton();
            if (!opener) return;
            const pending =
                res.kind === 'alchemy'
                    ? opener.openAlchemyMissingMaterials(res.itemHrid, res.alchemyType, 1)
                    : opener.openMissingMaterials(res.actionHrid, 1);
            Promise.resolve(pending).catch((error) =>
                console.error('[AchievementFinisher] Missing Mats failed:', error)
            );
        } catch (error) {
            console.error('[AchievementFinisher] Missing Mats failed:', error);
        }
    }

    /** Everything this module put on the page */
    removeAll() {
        document.querySelectorAll(`.${LINE_CLASS}, .${TOGGLE_CLASS}`).forEach((node) => node.remove());
    }

    removeLines() {
        document.querySelectorAll(`.${LINE_CLASS}`).forEach((node) => node.remove());
    }

    /** Draw the checkbox and, when the hints are on, the card lines, on the Achievements tab if it is showing. */
    mount() {
        if (!this.isInitialized) return;
        const host = findAchievementsHost();
        if (!host) return;
        this.ensureToggle(host);
        if (!hintsOn()) {
            this.removeLines();
            return;
        }
        this.decorateCards(host);
    }

    refresh() {
        this.mount();
    }

    /**
     * The checkbox beside "Show Incomplete Only" (the first native checkbox control on the tab when no
     * label says incomplete). With no native control at all it sits at the top of the list.
     * @param {Element} host
     */
    ensureToggle(host) {
        const checked = hintsOn();
        const scope = host.parentElement || host;
        const natives = [...scope.querySelectorAll(CHECKBOX_CONTROL_SELECTOR)].filter(
            (node) => !node.classList.contains(TOGGLE_CLASS) && !node.closest(`${OTHER_TABS}, ${EXCLUDED_ANCESTORS}`)
        );
        const native = natives.find((node) => INCOMPLETE_LABEL.test(node.textContent)) || natives[0] || null;
        const existing = scope.querySelector(`.${TOGGLE_CLASS}`);
        const anchored = native
            ? Boolean(existing) && existing.previousElementSibling === native
            : existing?.parentElement === host;
        if (existing && anchored && existing.dataset.checked === String(checked)) return;
        existing?.remove();

        const box = el('div', native ? '' : 'margin:6px 0;');
        box.className = `${native ? native.className : ''} ${TOGGLE_CLASS}`.trim();
        box.dataset.checked = String(checked);
        const label = el('label', 'display:flex;align-items:center;gap:4px;cursor:pointer;');
        const nativeLabel = native?.querySelector('label');
        if (nativeLabel) label.className = nativeLabel.className;
        const mark = el('span', 'display:inline-flex;');
        const nativeMark = native?.querySelector('[class*="MuiCheckbox-root"]');
        if (nativeMark) mark.className = nativeMark.className;
        mark.classList.toggle('Mui-checked', checked);
        mark.innerHTML = checked ? CHECKED_SVG : UNCHECKED_SVG;
        label.appendChild(mark);
        label.appendChild(el('span', '', TOGGLE_LABEL));
        label.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            config.setSetting(SETTING_KEY, !hintsOn());
        });
        box.appendChild(label);
        if (native) native.after(box);
        else host.insertBefore(box, host.firstChild);
    }

    /** The catalog's names and descriptions, indexed once per client data object */
    catalogFor(detailMap) {
        if (detailMap === this.catalogSource && this.catalog) return this.catalog;
        const byName = new Map();
        for (const [key, detail] of Object.entries(detailMap || {})) {
            const hrid = detail?.hrid || key;
            const name = detail?.name || nameFromHrid(hrid);
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push({ hrid, description: detail?.description || null });
        }
        this.catalogSource = detailMap;
        this.catalog = byName;
        return byName;
    }

    /**
     * Which achievement a card shows: its icon's sprite id first (works in any language), then its name
     * (and description, for same-named ones). The game's nodes carry no React props to read.
     * @param {Element} card
     * @param {Object} detailMap
     * @returns {string|null}
     */
    hridOfCard(card, detailMap) {
        // Read each time: the game may reuse one card element for another achievement when it
        // re-renders the list (Show Incomplete Only, a tab switch), so an answer cached on the element
        // goes stale
        let hrid = hridFromIcon(card, detailMap);
        if (!hrid) {
            const texts = leafTexts(card);
            const byName = this.catalogFor(detailMap);
            for (const text of texts.keys()) {
                const hits = byName.get(text);
                if (!hits) continue;
                const exact =
                    hits.length === 1 ? hits : hits.filter((hit) => hit.description && texts.has(hit.description));
                if (exact.length === 1) {
                    hrid = exact[0].hrid;
                    break;
                }
            }
        }
        return hrid;
    }

    /** Add (or refresh) the hint line on every unfinished card */
    decorateCards(host) {
        const clientData = dataManager.getInitClientData?.();
        const detailMap = clientData?.achievementDetailMap;
        const achievements = dataManager.getCharacterAchievements?.() ?? null;
        if (!detailMap || !Array.isArray(achievements)) {
            this.removeLines();
            return;
        }
        const completed = new Set(
            achievements.filter((row) => row?.isCompleted === true).map((row) => row.achievementHrid)
        );
        let context = null;
        const getContext = () => (context ||= this.readinessContext());

        for (const card of findCards(host)) {
            const own = card.querySelector(`.${LINE_CLASS}`);
            const hrid = this.hridOfCard(card, detailMap);
            const spec = hrid && !completed.has(hrid) ? this.lineFor(hrid, clientData, getContext) : null;
            if (!spec) {
                own?.remove();
                continue;
            }
            if (own && own.dataset.key === spec.key) continue;
            own?.remove();
            const line = spec.build();
            line.dataset.key = spec.key;
            this.placeLine(card, line);
        }
    }

    /** Insert the line right under the card's description (inside its left column), else at the end of the card */
    placeLine(card, line) {
        const anchor = card.querySelector('[class*="Achievement_description"]');
        if (anchor) anchor.after(line);
        else (card.querySelector('[class*="Achievement_leftColumn"]') || card).appendChild(line);
    }

    /**
     * What a card's line says and does, or null for nothing.
     * @returns {{key: string, build: () => HTMLElement}|null}
     */
    lineFor(hrid, clientData, getContext) {
        // The game card shows the point-total achievements' progress itself
        if (plannerFor(hrid)) return null;
        const res = this.resolutionFor(hrid, clientData);
        if (!res) return null;
        const ready = this.readinessFor(hrid, res, getContext);
        if (!ready) return null;
        const text = `[${readinessText(res, ready, clientData, getContext().combatLevel)}]`;
        const go = hasGoButton(res, ready);
        const ironCow = getContext().ironCow;
        const mats = missingMatsLines(res, ready, clientData, ironCow).length > 0;
        return {
            key: JSON.stringify(['ready', text, go, mats, ready.buyHrid]),
            build: () => {
                const hint = hintWithCoins(text);
                hint.className = `${PANEL_CLASS}-ready`;
                const line = this.buildLine(hint);
                if (go) {
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
                    line.appendChild(button);
                }
                const matsButton = createMissingMatsButton(res, ready, clientData, ironCow, () =>
                    this.openMissingMats(res)
                );
                if (matsButton) line.appendChild(matsButton);
                return line;
            },
        };
    }

    buildLine(first) {
        const line = el('div', 'margin-top:2px;font-size:12px;text-align:left;');
        line.className = LINE_CLASS;
        line.appendChild(first);
        return line;
    }
}

const achievementFinisher = new AchievementFinisher();

export default achievementFinisher;
