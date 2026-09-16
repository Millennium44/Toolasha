/**
 * Buy / Sell pricing dropdowns
 *
 * `profitCalc_pricingMode` is really a pair — which side of the book purchases
 * are priced at, and which side sales are — and the per-side patient ticks sit
 * on top of it. Two dropdowns say that directly: Buy is Instant (ask), Patient
 * (bid) or Patient +1 (bid plus one tick); Sell is Instant (bid), Patient (ask)
 * or Patient −1 (ask minus one tick).
 *
 * The dropdowns own no state. Each reads the settings to show its choice and
 * writes the settings when changed; the stored mode stays the four-value
 * setting everything else reads. The skill toolbar and the alchemy Best Items
 * header both build theirs here, so the two cannot drift apart.
 */

import config from '../core/config.js';
import { PATIENT_TICK_SETTING_KEYS, isPatientTickOn, patientTickSettingFor } from './patient-tick.js';

/**
 * The stored four-value pricing mode the two dropdowns are a view over.
 * Exported so a surface can ask whether that key is locked (Iron Cow) without
 * naming the literal a second time.
 */
export const PRICING_MODE_SETTING = 'profitCalc_pricingMode';
const PRICING_NAMING_SETTING = 'profitCalc_pricingNaming';

/**
 * Every setting a pricing dropdown shows. A surface holding one listens on all
 * of these (plus the settings-loaded channel) to stay in sync.
 */
export const PRICING_SIDE_SETTING_KEYS = Object.freeze([
    PRICING_MODE_SETTING,
    PRICING_NAMING_SETTING,
    ...PATIENT_TICK_SETTING_KEYS,
]);

/** A dropdown's options, in the order they are listed */
export const PRICING_SIDE_CHOICES = Object.freeze(['instant', 'patient', 'patientTick']);

/**
 * The book side each pricing mode prices each transaction side at. Mirrors
 * `getPricingMode`'s 'profit' branch in market-data.js, which stays the one
 * authority on what a stored mode means for a price.
 */
const MODE_SIDES = Object.freeze({
    conservative: Object.freeze({ buy: 'ask', sell: 'bid' }),
    hybrid: Object.freeze({ buy: 'ask', sell: 'ask' }),
    optimistic: Object.freeze({ buy: 'bid', sell: 'ask' }),
    patientBuy: Object.freeze({ buy: 'bid', sell: 'bid' }),
});

/** The book side an instant order fills against */
const INSTANT_BASIS = Object.freeze({ buy: 'ask', sell: 'bid' });
/** The book side a patient order queues on */
const PATIENT_BASIS = Object.freeze({ buy: 'bid', sell: 'ask' });

/** Shared tooltip per dropdown */
const SIDE_TITLES = Object.freeze({
    buy:
        'How purchases are priced.\n' +
        'Instant: buy at the ask.\n' +
        'Patient: place a buy order at the bid.\n' +
        'Patient +1: place it one market tick above the bid, first in the queue (never crossing the spread).',
    sell:
        'How sales are priced.\n' +
        'Instant: sell at the bid.\n' +
        'Patient: place a sell order at the ask.\n' +
        'Patient −1: place it one market tick below the ask, first in the queue (never crossing the spread).',
});

/** Background for the select and its option list — dark, like the game's panels */
export const PRICING_SELECT_BACKGROUND = '#1e1e1e';

/**
 * The marketplace listing auto-fill strategy per side. These price real orders
 * and are never written from here: a dropdown only mentions a mismatch in its
 * tooltip, because changing a profit view must not change how orders are placed.
 */
export const AUTO_FILL_STRATEGY_SETTINGS = Object.freeze({
    buy: 'market_autoFillBuyStrategy',
    sell: 'market_autoFillSellStrategy',
});

/** With auto-fill off the listing form is left as the game fills it, so no strategy applies */
const AUTO_FILL_ENABLED_SETTING = 'fillMarketOrderPrice';

/**
 * Settings that change only a dropdown's tooltip. Kept apart from
 * {@link PRICING_SIDE_SETTING_KEYS} so a surface resyncs the dropdowns for them
 * without re-pricing anything.
 */
export const PRICING_SIDE_TOOLTIP_SETTING_KEYS = Object.freeze([
    AUTO_FILL_ENABLED_SETTING,
    AUTO_FILL_STRATEGY_SETTINGS.buy,
    AUTO_FILL_STRATEGY_SETTINGS.sell,
]);

/**
 * The tooltip line for a patient side whose profit assumption disagrees with the
 * listing auto-fill strategy for that side. Instant sides take the other side's
 * listing rather than placing one, so they never carry a note.
 *
 * Buy: Patient +1 agrees with 'outbid', Patient with 'match'. Sell: Patient −1
 * agrees with 'undercut', Patient with 'match'. A buy 'undercut' is below the
 * bid, which no dropdown choice prices. An unrecognised strategy makes no claim.
 *
 * @param {'buy'|'sell'} side - Transaction side
 * @param {'instant'|'patient'|'patientTick'} choice - What the side's dropdown shows
 * @param {string} autoFillStrategy - That side's auto-fill strategy ('outbid'|'match'|'undercut')
 * @returns {string} The note, or '' when the two agree or cannot be compared
 */
export function autoFillMismatchNote(side, choice, autoFillStrategy) {
    if (side === 'buy') {
        if (choice === 'patient') {
            if (autoFillStrategy === 'outbid') {
                return 'Your listing auto-fill outbids by 1, but profit assumes the plain bid.';
            }
            if (autoFillStrategy === 'undercut') {
                return "Your listing auto-fill undercuts the bid by 1, which profit can't model: it assumes the plain bid.";
            }
        } else if (choice === 'patientTick') {
            if (autoFillStrategy === 'match') {
                return "Profit assumes bid +1, but your listing auto-fill doesn't outbid: it matches the bid.";
            }
            if (autoFillStrategy === 'undercut') {
                return "Profit assumes bid +1, but your listing auto-fill undercuts the bid by 1, which profit can't model.";
            }
        }
        return '';
    }
    if (side === 'sell') {
        if (choice === 'patient' && autoFillStrategy === 'undercut') {
            return 'Your listing auto-fill undercuts by 1, but profit assumes the plain ask.';
        }
        if (choice === 'patientTick' && autoFillStrategy === 'match') {
            return "Profit assumes ask −1, but your listing auto-fill doesn't undercut: it matches the ask.";
        }
    }
    return '';
}

/**
 * The auto-fill mismatch note for a side under the current settings.
 * @param {'buy'|'sell'} side - Transaction side
 * @param {'instant'|'patient'|'patientTick'} choice - What the side's dropdown shows
 * @returns {string}
 */
function currentAutoFillNote(side, choice) {
    if (config.getSettingValue(AUTO_FILL_ENABLED_SETTING, true) === false) return '';
    return autoFillMismatchNote(side, choice, config.getSettingValue(AUTO_FILL_STRATEGY_SETTINGS[side], 'match'));
}

/**
 * The book sides a stored pricing mode prices at. An unrecognised mode reads as
 * 'hybrid', the setting's default and what `getPricingMode` falls back to.
 * @param {string} mode - A `profitCalc_pricingMode` value
 * @returns {{buy: 'ask'|'bid', sell: 'ask'|'bid'}}
 */
export function sidesOfPricingMode(mode) {
    return MODE_SIDES[mode] || MODE_SIDES.hybrid;
}

/**
 * The pricing mode for a buy side and a sell side.
 * @param {'ask'|'bid'} buy - Book side purchases are priced at
 * @param {'ask'|'bid'} sell - Book side sales are priced at
 * @returns {string} The `profitCalc_pricingMode` value
 */
export function pricingModeFromSides(buy, sell) {
    for (const [mode, sides] of Object.entries(MODE_SIDES)) {
        if (sides.buy === buy && sides.sell === sell) return mode;
    }
    return 'hybrid';
}

/**
 * What a side's dropdown should show for the current settings. A tick switched
 * on for a side the mode prices instantly has nothing to move, so it shows as
 * Instant.
 * @param {'buy'|'sell'} side - Transaction side
 * @returns {'instant'|'patient'|'patientTick'}
 */
export function currentPricingSideChoice(side) {
    const mode = config.getSettingValue(PRICING_MODE_SETTING, 'hybrid');
    if (sidesOfPricingMode(mode)[side] === INSTANT_BASIS[side]) return 'instant';
    return isPatientTickOn(side) ? 'patientTick' : 'patient';
}

/**
 * An option's text, naming both halves so either wording says whether the
 * side is an instant trade or a waiting order: "Buy: Ask (instant) / Bid
 * (patient) / Bid +1 (patient)" under the Ask/Bid naming, "Buy: Instant (ask) /
 * Patient (bid) / Patient +1 (bid)" under the Instant/Patient naming.
 * @param {'buy'|'sell'} side - Transaction side
 * @param {'instant'|'patient'|'patientTick'} choice - The option
 * @param {boolean} instantNaming - Whether `profitCalc_pricingNaming` is on
 * @returns {string}
 */
export function pricingSideChoiceLabel(side, choice, instantNaming) {
    const prefix = side === 'buy' ? 'Buy' : 'Sell';
    const basis = choice === 'instant' ? INSTANT_BASIS[side] : PATIENT_BASIS[side];
    const speed = choice === 'instant' ? 'Instant' : 'Patient';
    const bookSide = basis === 'ask' ? 'Ask' : 'Bid';
    const word = instantNaming ? speed : bookSide;
    const other = (instantNaming ? bookSide : speed).toLowerCase();
    const tick = choice === 'patientTick' ? (side === 'buy' ? ' +1' : ' −1') : '';
    return `${prefix}: ${word}${tick} (${other})`;
}

/**
 * Write a side's choice into the settings: the combined pricing mode first
 * (keeping the other side as it is), then that side's tick. Only what actually
 * changes is written, so a listener fires for a real change and nothing else.
 * Instant turns the side's tick off, so no tick lingers unseen behind it.
 * @param {'buy'|'sell'} side - Transaction side
 * @param {'instant'|'patient'|'patientTick'} choice - The option chosen
 * @returns {boolean} Whether any setting was written
 */
export function applyPricingSideChoice(side, choice) {
    const tickKey = patientTickSettingFor(side);
    if (!tickKey || !PRICING_SIDE_CHOICES.includes(choice)) return false;

    const mode = config.getSettingValue(PRICING_MODE_SETTING, 'hybrid');
    const sides = { ...sidesOfPricingMode(mode) };
    sides[side] = choice === 'instant' ? INSTANT_BASIS[side] : PATIENT_BASIS[side];
    const nextMode = pricingModeFromSides(sides.buy, sides.sell);
    const nextTick = choice === 'patientTick';

    let written = false;
    if (nextMode !== mode) {
        config.setSettingValue(PRICING_MODE_SETTING, nextMode);
        written = true;
    }
    if (isPatientTickOn(side) !== nextTick) {
        config.setSetting(tickKey, nextTick);
        written = true;
    }
    return written;
}

/**
 * Whether a side's pricing choice, as recorded in a settingsMap, differs from
 * the schema default (mode 'hybrid', tick off).
 *
 * Pure — reads the map handed in rather than the live config singleton — so
 * a caller with its own map (tests, or the settings panel's "Changed only"
 * filter walking `config.settingsMap`) gets a real answer without going
 * through `config`. `profitCalc_pricingSideBuy`/`Sell` never hold a value of
 * their own — this is what lets the filter answer for them anyway, by
 * reading the settings the dropdown actually writes.
 *
 * @param {'buy'|'sell'} side - Transaction side
 * @param {Object} [settingsMap] - id -> {value}/{isTrue} entries (`config.settingsMap` shape)
 * @returns {boolean}
 */
export function isPricingSideChanged(side, settingsMap = {}) {
    const mode = settingsMap?.[PRICING_MODE_SETTING]?.value ?? 'hybrid';
    const basis = sidesOfPricingMode(mode)[side];
    const defaultBasis = sidesOfPricingMode('hybrid')[side];
    if (basis !== defaultBasis) return true;
    if (basis === INSTANT_BASIS[side]) return false; // instant either way, so no tick to check
    const tickKey = patientTickSettingFor(side);
    return Boolean(settingsMap?.[tickKey]?.isTrue);
}

/**
 * Bring a dropdown built by {@link createPricingSideSelect} up to date: option
 * text for the current naming, the selected choice, and the tooltip with any
 * auto-fill mismatch note. A surface calls this for
 * {@link PRICING_SIDE_TOOLTIP_SETTING_KEYS} changes as well as pricing ones.
 * @param {HTMLSelectElement} select - The dropdown
 * @returns {void}
 */
export function syncPricingSideSelect(select) {
    const side = select?.dataset?.mwiPricingSide;
    if (side !== 'buy' && side !== 'sell') return;
    const instantNaming = Boolean(config.getSetting(PRICING_NAMING_SETTING));
    for (const option of select.options) {
        option.textContent = pricingSideChoiceLabel(side, option.value, instantNaming);
    }
    const choice = currentPricingSideChoice(side);
    select.value = choice;
    const note = currentAutoFillNote(side, choice);
    select.title = note ? `${SIDE_TITLES[side]}\n\n${note}` : SIDE_TITLES[side];
}

/**
 * Build a Buy or Sell pricing dropdown, synced to the current settings.
 *
 * The dropdown does not write the settings itself: `onChoose` gets the choice,
 * so the surface decides how to batch the write with its own refresh — usually
 * {@link applyPricingSideChoice} and then one re-render.
 *
 * @param {'buy'|'sell'} side - Transaction side
 * @param {Object} [options]
 * @param {string} [options.cssText] - Inline style, to match the surface's buttons
 * @param {function(string): void} [options.onChoose] - Called with the chosen option
 * @returns {HTMLSelectElement}
 */
export function createPricingSideSelect(side, { cssText = '', onChoose } = {}) {
    const select = document.createElement('select');
    select.dataset.mwiPricingSide = side;
    select.setAttribute('aria-label', side === 'buy' ? 'Buy-side pricing' : 'Sell-side pricing');
    select.style.cssText = cssText;
    for (const choice of PRICING_SIDE_CHOICES) {
        const option = document.createElement('option');
        option.value = choice;
        // The open list is drawn by the browser; without its own colours it is
        // white text on a white menu in some browsers
        option.style.backgroundColor = PRICING_SELECT_BACKGROUND;
        option.style.color = '#fff';
        select.appendChild(option);
    }
    select.addEventListener('change', () => {
        if (typeof onChoose === 'function') onChoose(select.value);
    });
    syncPricingSideSelect(select);
    return select;
}
