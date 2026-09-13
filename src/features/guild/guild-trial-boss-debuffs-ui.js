/**
 * Debuff timers on the boss tiles of a spectated guild trial.
 *
 * Draws what `guild-trial-boss-debuffs.js` infers from the trial stream: a chip
 * per debuff seen landing, with its countdown, and a stun for as long as the
 * stream states one. Only inside the guild panel's monsters area — this
 * character's own fight is `combat-unit-buff-bars.js`'s, which reads the real
 * buff maps and stands down inside the guild panel for exactly that reason.
 *
 * Joined by slot: the boss tiles in DOM order are the `mMap` slots, the same
 * join buff bars make for monsters. A strip carries its own mark, distinct from
 * the buff bars', because buff bars remove their own marks from a trial's areas.
 *
 * Refreshed on a one-second timer and on the fight view being rebuilt; a draw
 * that changes nothing writes nothing.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { abilitySpriteHref, countdownText, isTrialArea } from '../combat/combat-unit-buff-bars.js';
import { liveBossDebuffs } from './guild-trial-damage.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { GAME } from '../../utils/selectors.js';

/** Marks a strip as this feature's */
export const STRIP_MARK = 'data-toolasha-trial-boss-debuffs';

/** Marks one chip; its value is the effect's key */
export const CHIP_MARK = 'data-toolasha-trial-boss-debuff';

/** The setting that turns it on and off, live */
export const SETTING = 'guildTrialBossDebuffs';

/** Countdowns are whole seconds */
export const REFRESH_MS = 1000;

/** Red for a debuff, amber for a stun */
const COLORS = { debuff: '#ff8b7a', stun: '#f0d060' };

/**
 * A trial monsters area's boss tiles, in slot order.
 * @param {Element} area - A monsters area
 * @returns {HTMLElement[]} Full cards, or the mini tiles when the view draws none
 */
export function bossTiles(area) {
    if (!area?.querySelectorAll) return [];
    const cards = [...area.querySelectorAll(GAME.COMBAT_UNIT)];
    return cards.length ? cards : [...area.querySelectorAll(GAME.MINI_UNIT)];
}

/**
 * What hovering a chip says: what the effect is and where its timer comes from.
 * @param {Object} effect - From `activeBossDebuffs`
 * @returns {string}
 */
export function chipTitle(effect) {
    if (effect.kind === 'stun') {
        return (
            `${effect.name} — the trial stream states the stun; the countdown is the ability's own stun ` +
            'duration, where the landing cast is known.'
        );
    }
    return (
        `${effect.name} — timed from a cast seen landing on this boss, for the duration the game data gives ` +
        'its debuff. The stream carries no buff state, so a debuff the boss resisted is not told apart.'
    );
}

class GuildTrialBossDebuffsUI {
    constructor() {
        this.enabled = false;
        this.unwatch = null;
        this.unregister = null;
        this.unregisterReady = null;
        this.timers = createTimerRegistry();
        this.drawScheduled = null;
    }

    /** Follow the setting, and start drawing when it is on */
    initialize() {
        this.unwatch?.();
        this.unwatch = config.onSettingChange(SETTING, (enabled) => (enabled ? this._enable() : this._disable()));
        if (config.getSetting(SETTING, true)) this._enable();
    }

    /** Stop following the setting, and take everything down */
    cleanup() {
        this.unwatch?.();
        this.unwatch = null;
        this._disable();
    }

    _enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.unregister = domObserver.onClass(
            'GuildTrialBossDebuffs',
            ['BattlePanel_monstersArea', 'CombatUnit_combatUnit'],
            () => this._scheduleDraw(),
            { debounce: true, debounceDelay: 150, debounceMaxWait: 1000 }
        );
        this.timers.registerInterval(
            setInterval(() => {
                if (typeof document !== 'undefined' && document.hidden) return;
                this.draw();
            }, REFRESH_MS),
            'guildTrialBossDebuffs.tick'
        );
        this.unregisterReady = domObserver.onReady?.('GuildTrialBossDebuffsCatchUp', () => this.draw()) ?? null;
    }

    _disable() {
        this.unregister?.();
        this.unregister = null;
        this.unregisterReady?.();
        this.unregisterReady = null;
        this.timers.clearAll();
        if (this.drawScheduled !== null) {
            clearTimeout(this.drawScheduled);
            this.drawScheduled = null;
        }
        if (typeof document !== 'undefined') {
            for (const strip of document.querySelectorAll(`[${STRIP_MARK}]`)) strip.remove();
        }
        this.enabled = false;
    }

    /** At most one redraw for a burst of mutations */
    _scheduleDraw() {
        if (this.drawScheduled !== null) return;
        this.drawScheduled = setTimeout(() => {
            this.drawScheduled = null;
            this.draw();
        }, 0);
    }

    /**
     * Draw every trial boss tile's strip from the live state.
     * @param {number} [now] - Clock, taken once for the pass
     */
    draw(now = Date.now()) {
        try {
            if (typeof document === 'undefined') return;
            const live = liveBossDebuffs(now);
            for (const area of document.querySelectorAll(GAME.BATTLE_MONSTERS_AREA)) {
                if (!isTrialArea(area)) continue;
                bossTiles(area).forEach((tile, slot) => this._strip(tile, live?.get(String(slot)), now));
            }
        } catch (error) {
            console.error('[GuildTrialBossDebuffs] Drawing the boss debuffs failed:', error);
        }
    }

    /**
     * One tile's strip, diffed against what is already on it.
     * @param {HTMLElement} tile - A boss tile
     * @param {Array<Object>|undefined} effects - What is standing on that boss
     * @param {number} now - Clock
     */
    _strip(tile, effects, now) {
        const existing = tile.querySelector(`:scope > [${STRIP_MARK}]`);
        if (!effects?.length) {
            existing?.remove();
            return;
        }

        let strip = existing;
        if (!strip) {
            strip = document.createElement('div');
            strip.setAttribute(STRIP_MARK, '1');
            Object.assign(strip.style, {
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: '3px',
                pointerEvents: 'none',
                lineHeight: '1',
                padding: '1px 0',
            });
            tile.appendChild(strip);
        }

        const chips = new Map();
        for (const chip of strip.children) chips.set(chip.getAttribute(CHIP_MARK), chip);

        for (const effect of effects) {
            let chip = chips.get(effect.key);
            if (chip) chips.delete(effect.key);
            else chip = this._chip(effect);
            // Appended in order every pass, so a stun arriving sits first
            if (strip.lastElementChild !== chip) strip.appendChild(chip);
            const text = countdownText(effect.expiresAt, now);
            if (chip.dataset.left !== text) {
                chip.dataset.left = text;
                chip.lastElementChild.textContent = text;
            }
        }
        for (const chip of chips.values()) chip.remove();
    }

    /**
     * @param {Object} effect - From `activeBossDebuffs`
     * @returns {HTMLElement} The ability's sprite or abbreviation, over its countdown
     */
    _chip(effect) {
        const chip = document.createElement('span');
        chip.setAttribute(CHIP_MARK, effect.key);
        chip.title = chipTitle(effect);
        Object.assign(chip.style, {
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'center',
            fontSize: '9px',
            fontWeight: 'bold',
            color: COLORS[effect.kind] || COLORS.debuff,
            textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
        });

        const href = abilitySpriteHref(effect.slug);
        if (href) {
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('width', '14');
            icon.setAttribute('height', '14');
            icon.setAttribute('aria-hidden', 'true');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', href);
            icon.appendChild(use);
            chip.appendChild(icon);
        } else {
            const label = document.createElement('span');
            label.textContent = effect.label;
            chip.appendChild(label);
        }

        // Last child by contract: the diff writes the countdown through it
        chip.appendChild(document.createElement('span'));
        return chip;
    }
}

const guildTrialBossDebuffsUI = new GuildTrialBossDebuffsUI();

export default {
    name: 'Guild Trial Boss Debuffs',
    initialize: () => guildTrialBossDebuffsUI.initialize(),
    cleanup: () => guildTrialBossDebuffsUI.cleanup(),
    /** Draw now rather than on the next tick — for tests */
    redraw: (now) => guildTrialBossDebuffsUI.draw(now),
};

export { guildTrialBossDebuffsUI };
