/**
 * Toolasha Utils Library
 * All utility modules
 * Version: 2.89.0
 * License: CC-BY-NC-SA-4.0
 */

(function (config, dataManager, webSocketHook, storage, marketAPI, domObserver) {
    'use strict';

    /**
     * Formatting Utilities
     * Pure functions for formatting numbers and time
     */


    /**
     * Check if number abbreviation (K/M/B) is enabled based on user settings.
     * Returns true for both 'compact' and 'threshold' modes, false for 'full'.
     * Also handles legacy boolean values from old settings.
     * @returns {boolean}
     */
    function isAbbreviationEnabled() {
        const mode = config.getSettingValue('formatting_useKMBFormat', 'compact');
        if (mode === false || mode === 'full') return false;
        return true;
    }

    /**
     * Format numbers with thousand separators
     * @param {number} num - The number to format
     * @param {number} digits - Number of decimal places (default: 0 for whole numbers)
     * @returns {string} Formatted number (e.g., "1,500", "1,500,000")
     *
     * @example
     * numberFormatter(1500) // "1,500"
     * numberFormatter(1500000) // "1,500,000"
     * numberFormatter(1500.5, 1) // "1,500.5"
     */
    function numberFormatter(num, digits = 0) {
        if (num === null || num === undefined) {
            return null;
        }

        // Round to specified decimal places
        const rounded = digits > 0 ? num.toFixed(digits) : Math.round(num);

        // Format with thousand separators
        return new Intl.NumberFormat().format(rounded);
    }

    /**
     * Convert seconds to human-readable time format
     * @param {number} sec - Seconds to convert
     * @returns {string} Formatted time (e.g., "1h 23m 45s" or "3 years 5 months 3 days")
     *
     * @example
     * timeReadable(3661) // "1h 01m 01s"
     * timeReadable(90000) // "1 day"
     * timeReadable(31536000) // "1 year"
     * timeReadable(100000000) // "3 years 2 months 3 days"
     */
    function timeReadable(sec) {
        // For times >= 1 year, show in years/months/days
        if (sec >= 31536000) {
            // 365 days
            const years = Math.floor(sec / 31536000);
            const remainingAfterYears = sec - years * 31536000;
            const months = Math.floor(remainingAfterYears / 2592000); // 30 days
            const remainingAfterMonths = remainingAfterYears - months * 2592000;
            const days = Math.floor(remainingAfterMonths / 86400);

            const parts = [];
            if (years > 0) parts.push(`${years} year${years !== 1 ? 's' : ''}`);
            if (months > 0) parts.push(`${months} month${months !== 1 ? 's' : ''}`);
            if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);

            return parts.join(' ');
        }

        // For times >= 1 day, show in days/hours/minutes
        if (sec >= 86400) {
            const days = Math.floor(sec / 86400);
            const remainingAfterDays = sec - days * 86400;
            const hours = Math.floor(remainingAfterDays / 3600);
            const remainingAfterHours = remainingAfterDays - hours * 3600;
            const minutes = Math.floor(remainingAfterHours / 60);

            const parts = [];
            if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
            if (hours > 0) parts.push(`${hours}h`);
            if (minutes > 0) parts.push(`${minutes}m`);

            return parts.join(' ');
        }

        // For times < 1 day, show as HH:MM:SS
        const d = new Date(Math.round(sec * 1000));
        function pad(i) {
            return ('0' + i).slice(-2);
        }

        const hours = d.getUTCHours();
        const minutes = d.getUTCMinutes();
        const seconds = d.getUTCSeconds();

        // For times < 1 minute, just show seconds
        if (hours === 0 && minutes === 0) {
            return seconds + 's';
        }

        const str = hours + 'h ' + pad(minutes) + 'm ' + pad(seconds) + 's';
        return str;
    }

    /**
     * Read a KMB shorthand back into a number.
     *
     * The inverse of the formatters above, for the places where a person types an
     * amount: `50m`, `1.5b`, `100k`, `500,000,000`. Separators are stripped rather
     * than rejected — a figure copied out of the game or off a spreadsheet arrives
     * with them, and refusing it teaches people to distrust the field.
     *
     * @param {string} text - What was typed
     * @returns {number} The value, or NaN when it is not an amount
     */
    function parseKMB(text) {
        const cleaned = String(text ?? '')
            .trim()
            .toLowerCase()
            .replace(/[,_\s]/g, '');
        const match = cleaned.match(/^(\d+\.?\d*)([kmb]?)$/);
        if (!match) return NaN;
        const multipliers = { k: 1e3, m: 1e6, b: 1e9 };
        return parseFloat(match[1]) * (multipliers[match[2]] || 1);
    }

    /**
     * Format a number with thousand separators based on locale
     * @param {number} num - The number to format
     * @returns {string} Formatted number with separators
     *
     * @example
     * formatWithSeparator(1000000) // "1,000,000" (US locale)
     */
    function formatWithSeparator(num) {
        return new Intl.NumberFormat().format(num);
    }

    /**
     * Format large numbers in K/M/B notation
     * @param {number} num - The number to format
     * @param {number} decimals - Number of decimal places (default: 1)
     * @returns {string} Formatted number (e.g., "1.5K", "2.3M", "1.2B")
     *
     * @example
     * formatKMB(1500) // "1.5K"
     * formatKMB(2300000) // "2.3M"
     * formatKMB(1234567890) // "1.2B"
     */
    function formatKMB(num, decimals = 1) {
        if (num === null || num === undefined) {
            return null;
        }

        const absNum = Math.abs(num);
        const sign = num < 0 ? '-' : '';

        if (absNum >= 1e15) {
            return sign + (absNum / 1e15).toFixed(decimals) + 'Q';
        } else if (absNum >= 1e12) {
            return sign + (absNum / 1e12).toFixed(decimals) + 'T';
        } else if (absNum >= 1e9) {
            return sign + (absNum / 1e9).toFixed(decimals) + 'B';
        } else if (absNum >= 1e6) {
            return sign + (absNum / 1e6).toFixed(decimals) + 'M';
        } else if (absNum >= 1e3) {
            return sign + (absNum / 1e3).toFixed(decimals) + 'K';
        } else {
            return sign + absNum.toFixed(0);
        }
    }

    /**
     * Format large numbers in K/M/B notation with 3 significant digits
     * @param {number} num - The number to format
     * @returns {string} Formatted number (e.g., "999", "1.25K", "82.1K", "825K", "1.25M")
     *
     * Handles rounding edge cases properly:
     * - 9999 rounds to "10.0K" (not "10.00K")
     * - 99999 rounds to "100K" (not "100.0K")
     * - 999999 promotes to "1.00M" (not "1000K")
     *
     * @example
     * formatKMB3Digits(999) // "999"
     * formatKMB3Digits(1250) // "1.25K"
     * formatKMB3Digits(8210) // "8.21K"
     * formatKMB3Digits(9999) // "10.0K"
     * formatKMB3Digits(82100) // "82.1K"
     * formatKMB3Digits(99999) // "100K"
     * formatKMB3Digits(825000) // "825K"
     * formatKMB3Digits(999999) // "1.00M"
     * formatKMB3Digits(1250000) // "1.25M"
     * formatKMB3Digits(82300000) // "82.3M"
     */
    function formatKMB3Digits(num) {
        if (num === null || num === undefined) {
            return null;
        }

        const absNum = Math.abs(num);
        const sign = num < 0 ? '-' : '';

        if (absNum >= 1e9) {
            const value = absNum / 1e9;
            // Round to 2 decimals first to check actual display value
            const rounded = parseFloat(value.toFixed(2));
            let decimals = 2;
            if (rounded >= 100) decimals = 0;
            else if (rounded >= 10) decimals = 1;
            return sign + value.toFixed(decimals) + 'B';
        } else if (absNum >= 1e6) {
            const value = absNum / 1e6;
            const rounded = parseFloat(value.toFixed(2));
            if (rounded >= 1000) {
                // Promote to B (e.g., 999999999 -> 1.00B not 1000M)
                return sign + (value / 1000).toFixed(2) + 'B';
            }
            let decimals = 2;
            if (rounded >= 100) decimals = 0;
            else if (rounded >= 10) decimals = 1;
            return sign + value.toFixed(decimals) + 'M';
        } else if (absNum >= 1e3) {
            const value = absNum / 1e3;
            const rounded = parseFloat(value.toFixed(2));
            if (rounded >= 1000) {
                // Promote to M (e.g., 999999 -> 1.00M not 1000K)
                return sign + (value / 1000).toFixed(2) + 'M';
            }
            let decimals = 2;
            if (rounded >= 100) decimals = 0;
            else if (rounded >= 10) decimals = 1;
            return sign + value.toFixed(decimals) + 'K';
        } else {
            return sign + Math.floor(absNum).toString();
        }
    }

    /**
     * Format numbers using game-style coin notation (4-digit maximum display)
     * @param {number} num - The number to format
     * @returns {string} Formatted number (e.g., "999", "1,000", "10K", "9,999K", "10M")
     *
     * Game formatting rules (4-digit bounded notation):
     * - 0-999: Raw number (no formatting)
     * - 1,000-9,999: Comma format
     * - 10,000-9,999,999: K suffix (10K to 9,999K)
     * - 10,000,000-9,999,999,999: M suffix (10M to 9,999M)
     * - 10,000,000,000-9,999,999,999,999: B suffix (10B to 9,999B)
     * - 10,000,000,000,000+: T suffix (10T+)
     *
     * Key rule: Display never exceeds 4 numeric digits. When a 5th digit is needed,
     * promote to the next unit (K→M→B→T).
     *
     * @example
     * coinFormatter(999) // "999"
     * coinFormatter(1000) // "1,000"
     * coinFormatter(9999) // "9,999"
     * coinFormatter(10000) // "10K"
     * coinFormatter(999999) // "999K"
     * coinFormatter(1000000) // "1,000K"
     * coinFormatter(9999999) // "9,999K"
     * coinFormatter(10000000) // "10M"
     */
    function coinFormatter(num) {
        if (num === null || num === undefined) {
            return null;
        }

        const absNum = Math.abs(num);
        const sign = num < 0 ? '-' : '';

        // 0-999: raw number
        if (absNum < 1000) {
            return sign + Math.floor(absNum).toString();
        }
        // 1,000-9,999: comma format
        if (absNum < 10000) {
            return sign + new Intl.NumberFormat().format(Math.floor(absNum));
        }
        // 10K-9,999K (10,000 to 9,999,999)
        if (absNum < 10000000) {
            const val = Math.floor(absNum / 1000);
            const formatted = val >= 1000 ? new Intl.NumberFormat().format(val) : val;
            return sign + formatted + 'K';
        }
        // 10M-9,999M (10,000,000 to 9,999,999,999)
        if (absNum < 10000000000) {
            const val = Math.floor(absNum / 1000000);
            const formatted = val >= 1000 ? new Intl.NumberFormat().format(val) : val;
            return sign + formatted + 'M';
        }
        // 10B-9,999B (10,000,000,000 to 9,999,999,999,999)
        if (absNum < 10000000000000) {
            const val = Math.floor(absNum / 1000000000);
            const formatted = val >= 1000 ? new Intl.NumberFormat().format(val) : val;
            return sign + formatted + 'B';
        }
        // 10T+ (10,000,000,000,000+)
        const val = Math.floor(absNum / 1000000000000);
        const formatted = val >= 1000 ? new Intl.NumberFormat().format(val) : val;
        return sign + formatted + 'T';
    }

    /**
     * Format milliseconds as relative time
     * @param {number} ageMs - Age in milliseconds
     * @returns {string} Formatted relative time (e.g., "5m", "2h 30m", "3d 12h", "14d")
     *
     * @example
     * formatRelativeTime(30000) // "Just now" (< 1 min)
     * formatRelativeTime(300000) // "5m" (5 minutes)
     * formatRelativeTime(7200000) // "2h 0m" (2 hours)
     * formatRelativeTime(93600000) // "1d 2h" (26 hours)
     * formatRelativeTime(864000000) // "10d" (10 days)
     * formatRelativeTime(2678400000) // "30+ days" (31 days)
     */
    function formatRelativeTime(ageMs) {
        const minutes = Math.floor(ageMs / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        // Edge cases
        if (minutes < 1) return 'Just now';
        if (days > 30) return '30+ days';

        // Format based on age
        if (days > 7) return `${days}d`;
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        return `${minutes}m`;
    }

    /**
     * Format numbers for networth display with decimal precision
     * Uses 2 decimal places for better readability in detailed breakdowns
     * @param {number} num - The number to format
     * @returns {string} Formatted number (e.g., "1.23K", "45.67M", "89.01B")
     *
     * @example
     * networthFormatter(1234) // "1.23K"
     * networthFormatter(45678) // "45.68K"
     * networthFormatter(1234567) // "1.23M"
     * networthFormatter(89012345) // "89.01M"
     * networthFormatter(1234567890) // "1.23B"
     */
    function networthFormatter(num) {
        if (num === null || num === undefined) {
            return null;
        }

        const absNum = Math.abs(num);
        const sign = num < 0 ? '-' : '';

        // 0-999: raw number (no decimals needed)
        if (absNum < 1000) {
            return sign + Math.floor(absNum).toString();
        }
        // 1,000-999,999: K with 2 decimals
        if (absNum < 1000000) {
            return sign + (absNum / 1000).toFixed(2) + 'K';
        }
        // 1M-999,999,999: M with 2 decimals
        if (absNum < 1000000000) {
            return sign + (absNum / 1000000).toFixed(2) + 'M';
        }
        // 1B+: B with 2 decimals
        return sign + (absNum / 1000000000).toFixed(2) + 'B';
    }

    /**
     * Format a decimal value as a percentage
     * @param {number} value - The decimal value to format (e.g., 0.05 for 5%)
     * @param {number} decimals - Number of decimal places (default: 1)
     * @returns {string} Formatted percentage (e.g., "5.0%", "12.5%")
     *
     * @example
     * formatPercentage(0.05) // "5.0%"
     * formatPercentage(0.125, 1) // "12.5%"
     * formatPercentage(0.00123, 2) // "0.12%"
     * formatPercentage(0.00123, 3) // "0.123%"
     */
    function formatPercentage(value, decimals = 1) {
        if (value === null || value === undefined) {
            return null;
        }

        const percentage = value * 100;
        const formatted = new Intl.NumberFormat(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        }).format(percentage);

        return formatted + '%';
    }

    /**
     * Format currency/coin amounts intelligently based on context
     * @param {number} amount - The amount to format
     * @param {Object} options - Formatting options
     * @param {string} options.style - 'game' (4-digit), 'compact' (K/M/B), 'full' (thousand separators), 'networth' (2 decimals)
     * @param {number} options.decimals - Decimal places for compact style (default: 1)
     * @returns {string} Formatted currency string
     *
     * @example
     * formatCurrency(1500, {style: 'game'}) // "1,500"
     * formatCurrency(1500000, {style: 'game'}) // "1,500K"
     * formatCurrency(1500000, {style: 'compact'}) // "1.5M"
     * formatCurrency(1500000, {style: 'full'}) // "1,500,000"
     * formatCurrency(1234, {style: 'networth'}) // "1.23K"
     */
    function formatCurrency(amount, options = {}) {
        const style = options.style || 'game';
        const decimals = options.decimals !== undefined ? options.decimals : 1;

        switch (style) {
            case 'game':
                return coinFormatter(amount);
            case 'compact':
                return formatKMB(amount, decimals);
            case 'networth':
                return networthFormatter(amount);
            case 'full':
                return formatWithSeparator(amount);
            default:
                return coinFormatter(amount);
        }
    }

    /**
     * Format numbers in compact notation (K/M/B)
     * Alias for formatKMB for clearer naming
     * @param {number} value - The number to format
     * @param {number} decimals - Number of decimal places (default: 1)
     * @returns {string} Formatted number (e.g., "1.5K", "2.3M", "1.2B")
     *
     * @example
     * formatCompactNumber(1500) // "1.5K"
     * formatCompactNumber(2300000) // "2.3M"
     * formatCompactNumber(1234567890) // "1.2B"
     */
    function formatCompactNumber(value, decimals = 1) {
        return formatKMB(value, decimals);
    }

    /**
     * Format large numbers with threshold-based abbreviation.
     * Keeps full comma-separated digits until the number exceeds 4 display digits,
     * then abbreviates with the configured precision.
     * @param {number} num - The number to format
     * @param {number} decimals - Number of decimal places (default: user setting)
     * @returns {string} Formatted number (e.g., "9,999" or "10.0K" or "1.25M")
     *
     * @example
     * formatThreshold(9999, 2) // "9,999"
     * formatThreshold(10000, 2) // "10.00K"
     * formatThreshold(1250000, 2) // "1.25M"
     */
    function formatThreshold(num, decimals = 1) {
        if (num === null || num === undefined) {
            return null;
        }

        const absNum = Math.abs(num);
        const sign = num < 0 ? '-' : '';

        if (absNum < 10000) {
            return sign + new Intl.NumberFormat().format(Math.round(absNum));
        }

        return sign + _abbreviate(absNum, decimals);
    }

    /**
     * Internal: abbreviate a positive number with K/M/B suffix.
     * @private
     */
    function _abbreviate(absNum, decimals) {
        if (absNum >= 1e9) {
            return (absNum / 1e9).toFixed(decimals) + 'B';
        } else if (absNum >= 1e6) {
            return (absNum / 1e6).toFixed(decimals) + 'M';
        } else if (absNum >= 1e3) {
            return (absNum / 1e3).toFixed(decimals) + 'K';
        }
        return absNum.toFixed(0);
    }

    /**
     * Format large numbers based on user preference
     * Dispatches to full, threshold, or compact format based on settings
     * @param {number} value - The number to format
     * @param {number} [decimals] - Override decimal places (if omitted, uses user setting)
     * @returns {string} Formatted number
     *
     * @example
     * // compact mode, precision 2: formatLargeNumber(1500000) → "1.50M"
     * // threshold mode, precision 2: formatLargeNumber(9999) → "9,999", formatLargeNumber(10000) → "10.00K"
     * // full mode: formatLargeNumber(1500000) → "1,500,000"
     */
    function formatLargeNumber(value, decimals) {
        const mode = config.getSettingValue('formatting_useKMBFormat', 'compact');

        if (mode === 'full' || mode === false) {
            return formatWithSeparator(value);
        }

        const precision = decimals !== undefined ? decimals : Number(config.getSettingValue('formatting_precision', '2'));

        if (mode === 'threshold') {
            return formatThreshold(value, precision);
        }

        return formatKMB(value, precision);
    }

    /**
     * Format a Date using the user's date/time format settings.
     * @param {Date} date - The date to format
     * @param {Object} [options]
     * @param {boolean} [options.includeDate=true] - Include the date portion (MM-DD or DD-MM)
     * @param {boolean} [options.includeTime=true] - Include the time portion
     * @param {boolean} [options.includeSeconds=true] - Include seconds in time
     * @returns {string}
     */
    function formatDateTime(date, options = {}) {
        const { includeDate = true, includeTime = true, includeSeconds = true, includeYear = false } = options;
        const use24h = config.getSettingValue('market_listingTimeFormat', '24hour') === '24hour';
        const dateFormat = config.getSettingValue('market_listingDateFormat', 'MM-DD');

        const parts = [];

        if (includeDate) {
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            let datePart = dateFormat === 'DD-MM' ? `${day}-${month}` : `${month}-${day}`;
            if (includeYear) datePart += `-${String(date.getFullYear()).slice(-2)}`;
            parts.push(datePart);
        }

        if (includeTime) {
            const timeOpts = { hour: 'numeric', minute: '2-digit', hour12: !use24h };
            if (includeSeconds) timeOpts.second = '2-digit';
            parts.push(date.toLocaleString('en-US', timeOpts).trim());
        }

        return parts.join(' ');
    }

    var formatters = /*#__PURE__*/Object.freeze({
        __proto__: null,
        coinFormatter: coinFormatter,
        formatCompactNumber: formatCompactNumber,
        formatCurrency: formatCurrency,
        formatDateTime: formatDateTime,
        formatKMB: formatKMB,
        formatKMB3Digits: formatKMB3Digits,
        formatLargeNumber: formatLargeNumber,
        formatPercentage: formatPercentage,
        formatRelativeTime: formatRelativeTime,
        formatThreshold: formatThreshold,
        formatWithSeparator: formatWithSeparator,
        isAbbreviationEnabled: isAbbreviationEnabled,
        networthFormatter: networthFormatter,
        numberFormatter: numberFormatter,
        parseKMB: parseKMB,
        timeReadable: timeReadable
    });

    /**
     * Loadout Snapshot
     *
     * Listens for `loadouts_updated` WebSocket messages to capture all loadout configurations
     * (equipment, abilities, consumables, enhancement levels) in real time.
     *
     * Stored snapshots are used by profit calculators to apply the correct tool/equipment
     * bonuses for a skill even when that loadout is not currently equipped.
     *
     * Skill matching: the loadout's actionTypeHrid (e.g. "/action_types/brewing") is compared
     * to the action type of the profit calculation. An "All Skills" loadout (empty actionTypeHrid)
     * is used as a fallback when no skill-specific snapshot is found.
     *
     * Priority: skill default > all skills default > skill non-default > all skills non-default
     */


    const STORAGE_KEY_PREFIX = 'loadout_snapshots';

    /**
     * Returns the active WebSocket hook instance.
     * In the multi-bundle production build each library bundles its own copy of websocket.js,
     * but only the Core library's instance has install() called on it.
     * Prefer window.Toolasha.Core.webSocketHook so listeners actually receive messages.
     * Falls back to the bundled copy for the dev standalone build (single bundle, one instance).
     */
    function getWebSocketHook() {
        return (typeof window !== 'undefined' && window.Toolasha?.Core?.webSocketHook) || webSocketHook;
    }

    /**
     * Get character-scoped storage key.
     * @returns {string}
     */
    function getStorageKey() {
        const charId = dataManager.getCurrentCharacterId() || 'default';
        return `${STORAGE_KEY_PREFIX}_${charId}`;
    }

    /**
     * Parse a wearable hash string into itemLocationHrid, itemHrid, and enhancementLevel.
     * Format: "characterId::/item_locations/location::/items/item_hrid::enhancementLevel"
     * Empty string means no item in that slot.
     * @param {string} itemLocationHrid - The equipment slot key (e.g. "/item_locations/body")
     * @param {string} wearableHash - The wearable hash value
     * @returns {{ itemLocationHrid: string, itemHrid: string, enhancementLevel: number }|null}
     */
    function parseWearable(itemLocationHrid, wearableHash) {
        if (!wearableHash) return null;

        const parts = wearableHash.split('::');
        const itemHrid = parts.find((p) => p.startsWith('/items/'));
        if (!itemHrid) return null;

        const lastPart = parts[parts.length - 1];
        const enhancementLevel = !lastPart.startsWith('/') ? parseInt(lastPart, 10) || 0 : 0;

        return { itemLocationHrid, itemHrid, enhancementLevel };
    }

    /**
     * The best enhancement level owned of every item, from the inventory.
     *
     * Equipped pieces are in `characterItems` alongside the loose ones, so this
     * covers what is worn as well as what is in the bag — which is what "highest
     * owned" means to the game.
     *
     * @param {Array<Object>} [items] - Defaults to the live inventory
     * @returns {Map<string, number>} Item hrid → highest enhancement level owned
     */
    function highestOwnedEnhancements(items) {
        const inventory = dataManager.characterItems || dataManager.characterData?.characterItems || [];
        const highest = new Map();
        for (const item of inventory) {
            if (!item?.itemHrid || !(item.count > 0)) continue;
            const level = item.enhancementLevel || 0;
            if (!highest.has(item.itemHrid) || level > highest.get(item.itemHrid)) {
                highest.set(item.itemHrid, level);
            }
        }
        return highest;
    }

    /**
     * What one slot of a loadout is really wearing.
     *
     * A loadout pinned with "use exact enhancement" wears what it says. Every other
     * loadout wears the best copy owned, so a stored level is a stale reading of
     * that rather than a fact — it is the level at the moment the loadout was last
     * saved, and enhancing the item since does not rewrite it.
     *
     * Never lower than what is stored: an inventory that has not arrived yet is an
     * empty map, and dropping a known +10 to 0 on the strength of it would be worse
     * than the staleness this is here to fix.
     *
     * @param {Object} snapshot - The loadout
     * @param {Object} equip - One entry of `snapshot.equipment`
     * @param {Map<string, number>} owned - From `highestOwnedEnhancements`
     * @returns {number} Enhancement level
     */
    function resolveEnhancementLevel(snapshot, equip, owned) {
        const stored = equip?.enhancementLevel || 0;
        if (snapshot?.useExactEnhancement) return stored;
        const highest = owned?.get(equip?.itemHrid);
        return highest === undefined ? stored : Math.max(stored, highest);
    }

    /**
     * Convert a server loadout object into our snapshot format.
     * @param {Object} loadout - A loadout entry from characterLoadoutMap
     * @returns {Object} snapshot
     */
    function buildSnapshot(loadout) {
        // Parse equipment from wearableMap
        const equipment = [];
        for (const [locationHrid, hash] of Object.entries(loadout.wearableMap || {})) {
            const parsed = parseWearable(locationHrid, hash);
            if (parsed) equipment.push(parsed);
        }

        // Parse drinks
        const drinks = (loadout.drinkItemHrids || []).map((hrid) => ({
            itemHrid: hrid || '',
        }));

        // Parse food
        const food = (loadout.foodItemHrids || []).map((hrid) => ({
            itemHrid: hrid || '',
        }));

        // Parse abilities
        const abilities = [];
        for (const [slot, hrid] of Object.entries(loadout.abilityMap || {})) {
            if (hrid) abilities.push({ abilityHrid: hrid, slot: parseInt(slot, 10) });
        }

        return {
            name: loadout.name,
            actionTypeHrid: loadout.actionTypeHrid || '',
            isDefault: !!loadout.isDefault,
            useExactEnhancement: loadout.useExactEnhancement ?? false,
            ordinal: loadout.ordinal || 0,
            equipment,
            abilities,
            food,
            drinks,
            abilityCombatTriggersMap: loadout.abilityCombatTriggersMap || {},
            consumableCombatTriggersMap: loadout.consumableCombatTriggersMap || {},
            savedAt: Date.now(),
        };
    }

    class LoadoutSnapshot {
        constructor() {
            this.snapshots = {}; // In-memory cache: { [loadoutName]: snapshot }
            this.characterInitializedHandler = null;
            this.updateListeners = [];
            this.isInitialized = false;

            // Register WebSocket handler at module load time so in-session loadout
            // changes are captured whenever loadouts_updated fires.
            this.loadoutsUpdatedHandler = (data) => this._onLoadoutsUpdated(data);
            getWebSocketHook().on('loadouts_updated', this.loadoutsUpdatedHandler);
        }

        /**
         * Register a callback to be called whenever snapshots are updated.
         * @param {Function} fn
         */
        onUpdate(fn) {
            this.updateListeners.push(fn);
        }

        /**
         * Remove a previously registered update callback.
         * @param {Function} fn
         */
        offUpdate(fn) {
            this.updateListeners = this.updateListeners.filter((l) => l !== fn);
        }

        _emitUpdate() {
            this.updateListeners.forEach((fn) => fn());
        }

        async initialize() {
            if (this.isInitialized) return;
            this.isInitialized = true;

            // Re-register WS handler if it was cleared by disable()
            if (!this.loadoutsUpdatedHandler) {
                this.loadoutsUpdatedHandler = (data) => this._onLoadoutsUpdated(data);
                getWebSocketHook().on('loadouts_updated', this.loadoutsUpdatedHandler);
            }

            // Load from storage — loadouts_updated only fires when the user visits the loadouts
            // UI, so storage is always the source of snapshots at startup.
            if (Object.keys(this.snapshots).length === 0) {
                const storageKey = getStorageKey();
                // NOTE: getCurrentCharacterId() is set by the time this runs, because
                // features are initialized from inside the character_initialized
                // handler — so the key here is already character-scoped. The listener
                // below cannot correct it if it ever were not: that event has already
                // fired and will only come again on a character switch.
                this.snapshots = (await storage.getJSON(storageKey, 'settings', null)) || {};

                // Fallback for Steam users: if storage is also empty, bootstrap from
                // the characterLoadoutMap embedded in init_character_data (already in dataManager).
                if (Object.keys(this.snapshots).length === 0) {
                    const characterLoadoutMap = dataManager.characterData?.characterLoadoutMap;
                    if (characterLoadoutMap && Object.keys(characterLoadoutMap).length > 0) {
                        this._onLoadoutsUpdated({ characterLoadoutMap });
                    }
                }
            }

            // Reload from the correct character-scoped key once character data is available
            this.characterInitializedHandler = async () => {
                const storageKey = getStorageKey();
                const fresh = (await storage.getJSON(storageKey, 'settings', null)) || {};
                if (Object.keys(fresh).length > 0) {
                    this.snapshots = fresh;
                    this._emitUpdate();
                }
            };
            dataManager.on('character_initialized', this.characterInitializedHandler);
        }

        /**
         * Handle a loadouts_updated WebSocket message.
         * Replaces all snapshots with the server's current state.
         * @param {Object} data - The WebSocket message payload
         */
        _onLoadoutsUpdated(data) {
            const loadoutMap = data.characterLoadoutMap;
            if (!loadoutMap) {
                console.warn('[LoadoutSnapshot] loadouts_updated received but no characterLoadoutMap');
                return;
            }

            const newSnapshots = {};
            for (const [id, loadout] of Object.entries(loadoutMap)) {
                if (!loadout.name) continue;
                newSnapshots[id] = buildSnapshot(loadout);
            }

            this.snapshots = newSnapshots;
            storage.setJSON(getStorageKey(), this.snapshots, 'settings');
            this._emitUpdate();
        }

        /**
         * Update a snapshot equipment item's enhancement level.
         * Used when the highest owned enhancement of a loadout item changes (up or down).
         * @param {string} itemHrid - Base item HRID (e.g. "/items/sword")
         * @param {number} newLevel - New enhancement level (highest currently owned)
         * @returns {boolean} True if any snapshot was updated
         */
        updateEnhancementLevel(itemHrid, newLevel) {
            let changed = false;
            for (const snapshot of Object.values(this.snapshots)) {
                // Exact-mode snapshots intentionally hold a frozen level — never auto-update them.
                if (snapshot.useExactEnhancement) continue;
                for (const eq of snapshot.equipment || []) {
                    if (eq.itemHrid === itemHrid && eq.enhancementLevel !== newLevel) {
                        eq.enhancementLevel = newLevel;
                        snapshot.savedAt = Date.now();
                        changed = true;
                    }
                }
            }
            if (changed) {
                storage.setJSON(getStorageKey(), this.snapshots, 'settings');
                this._emitUpdate();
            }
            return changed;
        }

        /**
         * Find the best snapshot for a given action type.
         * Priority: skill default > all skills default > skill non-default > all skills non-default
         * @param {string} actionTypeHrid - e.g. "/action_types/brewing"
         * @returns {Object|null} snapshot entry or null
         */
        _findSnapshot(actionTypeHrid) {
            if (!config.getSetting('loadoutSnapshot')) return null;

            let skillDefault = null;
            let allSkillsDefault = null;
            let skillNonDefault = null;
            let allSkillsNonDefault = null;

            for (const snapshot of Object.values(this.snapshots)) {
                if (snapshot.actionTypeHrid === actionTypeHrid) {
                    if (snapshot.isDefault) {
                        skillDefault = snapshot;
                    } else {
                        skillNonDefault = snapshot;
                    }
                } else if (snapshot.actionTypeHrid === '') {
                    if (snapshot.isDefault) {
                        allSkillsDefault = snapshot;
                    } else {
                        allSkillsNonDefault = snapshot;
                    }
                }
            }

            return skillDefault || allSkillsDefault || skillNonDefault || allSkillsNonDefault || null;
        }

        /**
         * Get a Map<itemLocationHrid, item> for the best loadout snapshot matching the given
         * action type. Returns null if no snapshot exists or the feature is disabled.
         * The returned Map has the same format as dataManager.getEquipment().
         * @param {string} actionTypeHrid
         * @returns {Map<string, Object>|null}
         */
        getSnapshotForSkill(actionTypeHrid) {
            const snapshot = this._findSnapshot(actionTypeHrid);
            if (!snapshot || !snapshot.equipment?.length) return null;
            return new Map(snapshot.equipment.map((e) => [e.itemLocationHrid, e]));
        }

        /**
         * Get the drink slots array for the best loadout snapshot matching the given
         * action type. Returns null if no snapshot exists or the feature is disabled.
         * The returned array has the same format as dataManager.getActionDrinkSlots().
         * @param {string} actionTypeHrid
         * @returns {Array<{itemHrid: string}>|null}
         */
        getSnapshotDrinksForSkill(actionTypeHrid) {
            const snapshot = this._findSnapshot(actionTypeHrid);
            if (!snapshot) return null;
            // Filter out empty slots so callers get only actual items
            const filled = (snapshot.drinks || []).filter((d) => d.itemHrid);
            return filled.length > 0 ? filled : null;
        }

        /**
         * Get all saved loadout snapshots as a flat array.
         * @returns {Array<Object>} Array of snapshot objects
         */
        getAllSnapshots() {
            return Object.values(this.snapshots).sort((a, b) => a.ordinal - b.ordinal);
        }

        /**
         * The equipment a loadout would actually put on, at the levels it would
         * actually wear.
         *
         * A snapshot's stored enhancement level is only the truth for a loadout
         * pinned with "use exact enhancement". The default is the other way round —
         * the game equips the **highest copy you own** — and the wearable hash the
         * snapshot is parsed from routinely carries 0, or a level from before the
         * last enhancement. Reading it literally reports a refined cape at +0 while
         * the character is wearing it at +10, and every number computed from that
         * loadout is quietly wrong in the same direction.
         *
         * @param {Object} snapshot - From `snapshots` / `getAllSnapshots`
         * @returns {Array<{itemHrid: string, enhancementLevel: number, itemLocationHrid: string}>}
         */
        resolveEquipment(snapshot) {
            const owned = highestOwnedEnhancements();
            return (snapshot?.equipment || []).map((equip) => ({
                ...equip,
                enhancementLevel: resolveEnhancementLevel(snapshot, equip, owned),
            }));
        }

        /**
         * Get the name and default status of the saved loadout being used for a given action type.
         * Returns an object with name and isDefault, or null if no snapshot exists or feature is disabled.
         * @param {string} actionTypeHrid
         * @returns {{ name: string, isDefault: boolean }|null}
         */
        getSnapshotInfoForSkill(actionTypeHrid) {
            const snapshot = this._findSnapshot(actionTypeHrid);
            if (!snapshot) return null;
            return { name: snapshot.name, isDefault: !!snapshot.isDefault };
        }

        disable() {
            if (this.loadoutsUpdatedHandler) {
                getWebSocketHook().off('loadouts_updated', this.loadoutsUpdatedHandler);
                this.loadoutsUpdatedHandler = null;
            }

            if (this.characterInitializedHandler) {
                dataManager.off('character_initialized', this.characterInitializedHandler);
                this.characterInitializedHandler = null;
            }

            this.updateListeners = [];
            this.isInitialized = false;
        }
    }

    const loadoutSnapshot = new LoadoutSnapshot();

    /**
     * Action context resolver
     *
     * Returns the equipment and active drinks to use when predicting an action's
     * outcome (XP, time, profit, materials). When the loadoutSnapshot feature is
     * enabled and a saved loadout matches the action type, that snapshot is used
     * — so predictions reflect the gear the user would auto-equip rather than
     * whatever happens to be on their character right now.
     *
     * Resolution priority (handled inside loadoutSnapshot._findSnapshot):
     *   1. Skill-specific default loadout
     *   2. All-skills default loadout
     *   3. Skill-specific non-default
     *   4. All-skills non-default
     *   5. Fall back to currently-equipped gear / current drinks
     *
     * Equipment and drinks are resolved independently — it's valid to inherit the
     * snapshot's equipment while no snapshot drinks exist, in which case the
     * current drinks are used (and vice-versa).
     */


    /**
     * The loadout store that actually has the loadouts in it.
     *
     * In the multi-bundle build every bundle that imports this file gets its own
     * copy of the snapshot singleton, and only the Combat one has `initialize`
     * called on it — the others never read storage, so they answer "no loadout" to
     * everything and every caller quietly falls back to whatever is worn right now.
     * The global is the initialized one. The bundled copy is the dev build, where
     * there is only ever one.
     *
     * @returns {Object} The snapshot store
     */
    function loadouts() {
        return (typeof window !== 'undefined' && window.Toolasha?.Combat?.loadoutSnapshot) || loadoutSnapshot;
    }

    /**
     * @param {string} actionTypeHrid - e.g. "/action_types/cooking"
     * @returns {{equipment: Map, drinks: Array}}
     */
    function resolveActionContext(actionTypeHrid) {
        const loadoutSnapshot = loadouts();
        const rawDrinks =
            loadoutSnapshot.getSnapshotDrinksForSkill(actionTypeHrid) ?? dataManager.getActionDrinkSlots(actionTypeHrid);

        // Only include drinks that are actually in stock — slotted-but-empty teas give no buff
        const inventory = dataManager.getInventory() || [];
        const drinks = (rawDrinks || []).filter(
            (d) => d?.itemHrid && inventory.some((i) => i.itemHrid === d.itemHrid && (i.count || 0) > 0)
        );

        return {
            equipment: loadoutSnapshot.getSnapshotForSkill(actionTypeHrid) ?? dataManager.getEquipment(),
            drinks,
        };
    }

    /**
     * Enhancement Multiplier System
     *
     * Handles enhancement bonus calculations for equipment.
     * Different equipment slots have different multipliers:
     * - Accessories (neck/ring/earring), Back, Trinket, Charm: 5× multiplier
     * - All other slots (weapons, armor, pouch): 1× multiplier
     */

    /**
     * Enhancement multiplier by equipment slot type
     */
    const ENHANCEMENT_MULTIPLIERS = {
        '/equipment_types/neck': 5,
        '/equipment_types/ring': 5,
        // The game's equipment type is plural; the singular is kept as an alias so any older
        // caller (or saved loadout) that still says "earring" keeps its 5× multiplier.
        '/equipment_types/earrings': 5,
        '/equipment_types/earring': 5,
        '/equipment_types/back': 5,
        '/equipment_types/trinket': 5,
        '/equipment_types/charm': 5,
        // All other slots: 1× (default)
    };

    /**
     * Enhancement bonus table
     * Maps enhancement level to percentage bonus
     */
    const ENHANCEMENT_BONUSES = {
        1: 0.02,
        2: 0.042,
        3: 0.066,
        4: 0.092,
        5: 0.12,
        6: 0.15,
        7: 0.182,
        8: 0.216,
        9: 0.252,
        10: 0.29,
        11: 0.334,
        12: 0.384,
        13: 0.44,
        14: 0.502,
        15: 0.57,
        16: 0.644,
        17: 0.724,
        18: 0.81,
        19: 0.902,
        20: 1.0,
    };

    /**
     * Get enhancement multiplier for an item
     * @param {Object} itemDetails - Item details from itemDetailMap
     * @param {number} enhancementLevel - Current enhancement level of item
     * @returns {number} Multiplier to apply to bonuses
     */
    function getEnhancementMultiplier(itemDetails, enhancementLevel) {
        if (enhancementLevel === 0) {
            return 1;
        }

        const equipmentType = itemDetails?.equipmentDetail?.type;
        const slotMultiplier = ENHANCEMENT_MULTIPLIERS[equipmentType] || 1;
        const enhancementBonus = ENHANCEMENT_BONUSES[enhancementLevel] || 0;

        return 1 + enhancementBonus * slotMultiplier;
    }

    var enhancementMultipliers = /*#__PURE__*/Object.freeze({
        __proto__: null,
        ENHANCEMENT_BONUSES: ENHANCEMENT_BONUSES,
        ENHANCEMENT_MULTIPLIERS: ENHANCEMENT_MULTIPLIERS,
        getEnhancementMultiplier: getEnhancementMultiplier
    });

    /**
     * Equipment Parser Utility
     * Parses equipment bonuses for action calculations
     *
     * PART OF EFFICIENCY SYSTEM (Phase 1 of 3):
     * - Phase 1 ✅: Equipment speed bonuses (this module) + level advantage
     * - Phase 2 ✅: Community buffs + house rooms (WebSocket integration)
     * - Phase 3 ✅: Consumable buffs (tea parser integration)
     *
     * Speed bonuses are MULTIPLICATIVE with time (reduce duration).
     * Efficiency bonuses are ADDITIVE with each other, then MULTIPLICATIVE with time.
     *
     * Formula: actionTime = baseTime / (1 + totalEfficiency + totalSpeed)
     */


    /**
     * Map action type HRID to equipment field name
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/cheesesmithing")
     * @param {string} suffix - Field suffix (e.g., "Speed", "Efficiency", "RareFind")
     * @param {Array<string>} validFields - Array of valid field names
     * @returns {string|null} Field name (e.g., "cheesesmithingSpeed") or null
     */
    function getFieldForActionType(actionTypeHrid, suffix, validFields) {
        if (!actionTypeHrid) {
            return null;
        }

        // Extract skill name from action type HRID
        // e.g., "/action_types/cheesesmithing" -> "cheesesmithing"
        const skillName = actionTypeHrid.replace('/action_types/', '');

        // Map to field name with suffix
        // e.g., "cheesesmithing" + "Speed" -> "cheesesmithingSpeed"
        const fieldName = skillName + suffix;

        return validFields.includes(fieldName) ? fieldName : null;
    }

    /**
     * Slot multipliers for enhancement bonuses
     * Accessories get 5× bonus, weapons/armor get 1× bonus
     * Keys use item_locations (not equipment_types) to match characterEquipment map keys
     */
    const SLOT_MULTIPLIERS = {
        '/item_locations/neck': 5, // Necklace
        '/item_locations/ring': 5, // Ring
        '/item_locations/earrings': 5, // Earrings
        '/item_locations/back': 5, // Back/Cape
        '/item_locations/trinket': 5, // Trinket
        '/item_locations/charm': 5, // Charm
        '/item_locations/main_hand': 1, // Main hand weapon
        '/item_locations/two_hand': 1, // Two-handed weapon
        '/item_locations/off_hand': 1, // Off-hand/shield
        '/item_locations/head': 1, // Head armor
        '/item_locations/body': 1, // Body armor
        '/item_locations/legs': 1, // Leg armor
        '/item_locations/hands': 1, // Hand armor
        '/item_locations/feet': 1, // Feet armor
        '/item_locations/pouch': 1, // Pouch
    };

    /**
     * Calculate enhancement scaling for equipment stats
     * Uses percentage-based enhancement system with slot multipliers
     *
     * Formula: base × (1 + enhancementPercentage × slotMultiplier)
     *
     * @param {number} baseValue - Base stat value from item data
     * @param {number} enhancementLevel - Enhancement level (0-20)
     * @param {string} slotHrid - Equipment slot HRID (e.g., "/equipment_types/neck")
     * @returns {number} Scaled stat value
     *
     * @example
     * // Philosopher's Necklace +4 (4% base speed, neck slot 5×)
     * calculateEnhancementScaling(0.04, 4, '/equipment_types/neck')
     * // = 0.04 × (1 + 0.092 × 5) = 0.04 × 1.46 = 0.0584 (5.84%)
     *
     * // Lumberjack's Top +10 (10% base efficiency, body slot 1×)
     * calculateEnhancementScaling(0.10, 10, '/equipment_types/body')
     * // = 0.10 × (1 + 0.290 × 1) = 0.10 × 1.29 = 0.129 (12.9%)
     */
    function calculateEnhancementScaling(baseValue, enhancementLevel, slotHrid) {
        if (enhancementLevel === 0) {
            return baseValue;
        }

        // Get enhancement percentage from shared table (no level-0 entry; early return above covers it)
        const enhancementPercentage = ENHANCEMENT_BONUSES[enhancementLevel] || 0;

        // Get slot multiplier (default to 1× if slot not found)
        const slotMultiplier = SLOT_MULTIPLIERS[slotHrid] || 1;

        // Apply formula: base × (1 + percentage × multiplier)
        return baseValue * (1 + enhancementPercentage * slotMultiplier);
    }

    /**
     * Generic equipment stat parser - handles all noncombat stats with consistent logic
     * @param {Map} characterEquipment - Equipment map from dataManager.getEquipment()
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {Object} config - Parser configuration
     * @param {string|null} config.skillSpecificField - Skill-specific field (e.g., "brewingSpeed")
     * @param {string|null} config.genericField - Generic skilling field (e.g., "skillingSpeed")
     * @param {boolean} config.returnAsPercentage - Whether to convert to percentage (multiply by 100)
     * @returns {number} Total stat bonus
     *
     * @example
     * // Parse speed bonuses for brewing
     * parseEquipmentStat(equipment, items, {
     *   skillSpecificField: "brewingSpeed",
     *   genericField: "skillingSpeed",
     *   returnAsPercentage: false
     * })
     */
    function parseEquipmentStat(characterEquipment, itemDetailMap, config) {
        if (!characterEquipment || characterEquipment.size === 0) {
            return 0; // No equipment
        }

        if (!itemDetailMap) {
            return 0; // Missing item data
        }

        const { skillSpecificField, genericField, returnAsPercentage } = config;

        let totalBonus = 0;

        // Iterate through all equipped items
        for (const [slotHrid, equippedItem] of characterEquipment) {
            // Get item details from game data
            const itemDetails = itemDetailMap[equippedItem.itemHrid];

            if (!itemDetails || !itemDetails.equipmentDetail) {
                continue; // Not an equipment item
            }

            // Check if item has noncombat stats
            const noncombatStats = itemDetails.equipmentDetail.noncombatStats;

            if (!noncombatStats) {
                continue; // No noncombat stats
            }

            // Get enhancement level from equipped item
            const enhancementLevel = equippedItem.enhancementLevel || 0;

            // Check for skill-specific stat (e.g., brewingSpeed, brewingEfficiency, brewingRareFind)
            if (skillSpecificField) {
                const baseValue = noncombatStats[skillSpecificField];

                if (baseValue && baseValue > 0) {
                    const scaledValue = calculateEnhancementScaling(baseValue, enhancementLevel, slotHrid);
                    totalBonus += scaledValue;
                }
            }

            // Check for generic skilling stat (e.g., skillingSpeed, skillingEfficiency, skillingRareFind, skillingEssenceFind)
            if (genericField) {
                const baseValue = noncombatStats[genericField];

                if (baseValue && baseValue > 0) {
                    const scaledValue = calculateEnhancementScaling(baseValue, enhancementLevel, slotHrid);
                    totalBonus += scaledValue;
                }
            }
        }

        // Convert to percentage if requested (0.15 -> 15%)
        return returnAsPercentage ? totalBonus * 100 : totalBonus;
    }

    /**
     * Valid speed fields from game data
     */
    const VALID_SPEED_FIELDS = [
        'milkingSpeed',
        'foragingSpeed',
        'woodcuttingSpeed',
        'cheesesmithingSpeed',
        'craftingSpeed',
        'tailoringSpeed',
        'brewingSpeed',
        'cookingSpeed',
        'alchemySpeed',
        'enhancingSpeed',
        'taskSpeed',
    ];

    /**
     * Parse equipment speed bonuses for a specific action type
     * @param {Map} characterEquipment - Equipment map from dataManager.getEquipment()
     * @param {string} actionTypeHrid - Action type HRID
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @returns {number} Total speed bonus as decimal (e.g., 0.15 for 15%)
     *
     * @example
     * parseEquipmentSpeedBonuses(equipment, "/action_types/brewing", items)
     * // Cheese Pot (base 0.15, bonus 0.003) +0: 0.15 (15%)
     * // Cheese Pot (base 0.15, bonus 0.003) +10: 0.18 (18%)
     * // Azure Pot (base 0.3, bonus 0.006) +10: 0.36 (36%)
     */
    function parseEquipmentSpeedBonuses(characterEquipment, actionTypeHrid, itemDetailMap) {
        const skillSpecificField = getFieldForActionType(actionTypeHrid, 'Speed', VALID_SPEED_FIELDS);

        return parseEquipmentStat(characterEquipment, itemDetailMap, {
            skillSpecificField,
            genericField: 'skillingSpeed',
            returnAsPercentage: false,
        });
    }

    /**
     * Valid efficiency fields from game data
     */
    const VALID_EFFICIENCY_FIELDS = [
        'milkingEfficiency',
        'foragingEfficiency',
        'woodcuttingEfficiency',
        'cheesesmithingEfficiency',
        'craftingEfficiency',
        'tailoringEfficiency',
        'brewingEfficiency',
        'cookingEfficiency',
        'alchemyEfficiency',
    ];

    /**
     * Parse equipment efficiency bonuses for a specific action type
     * @param {Map} characterEquipment - Equipment map from dataManager.getEquipment()
     * @param {string} actionTypeHrid - Action type HRID
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @returns {number} Total efficiency bonus as percentage (e.g., 12 for 12%)
     *
     * @example
     * parseEquipmentEfficiencyBonuses(equipment, "/action_types/brewing", items)
     * // Brewer's Top (base 0.1, bonus 0.002) +0: 10%
     * // Brewer's Top (base 0.1, bonus 0.002) +10: 12%
     * // Philosopher's Necklace (skillingEfficiency 0.02, bonus 0.002) +10: 4%
     * // Total: 16%
     */
    function parseEquipmentEfficiencyBonuses(characterEquipment, actionTypeHrid, itemDetailMap) {
        const skillSpecificField = getFieldForActionType(actionTypeHrid, 'Efficiency', VALID_EFFICIENCY_FIELDS);

        return parseEquipmentStat(characterEquipment, itemDetailMap, {
            skillSpecificField,
            genericField: 'skillingEfficiency',
            returnAsPercentage: true,
        });
    }

    /**
     * Parse Essence Find bonus from equipment
     * @param {Map} characterEquipment - Equipment map from dataManager.getEquipment()
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @returns {number} Total essence find bonus as percentage (e.g., 15 for 15%)
     *
     * @example
     * parseEssenceFindBonus(equipment, items)
     * // Ring of Essence Find (base 0.15, bonus 0.015) +0: 15%
     * // Ring of Essence Find (base 0.15, bonus 0.015) +10: 30%
     */
    function parseEssenceFindBonus(characterEquipment, itemDetailMap) {
        return parseEquipmentStat(characterEquipment, itemDetailMap, {
            skillSpecificField: null, // No skill-specific essence find
            genericField: 'skillingEssenceFind',
            returnAsPercentage: true,
        });
    }

    /**
     * Get total gathering quantity bonus from equipment.
     * @param {Map} characterEquipment - Equipment map
     * @param {Object} itemDetailMap - Item details
     * @returns {number} Total gathering quantity bonus (decimal, e.g. 0.02)
     */
    function parseGatheringQuantityBonus(characterEquipment, itemDetailMap) {
        return parseEquipmentStat(characterEquipment, itemDetailMap, {
            skillSpecificField: null,
            genericField: 'gatheringQuantity',
            returnAsPercentage: false,
        });
    }

    /**
     * Valid rare find fields from game data
     */
    const VALID_RARE_FIND_FIELDS = [
        'milkingRareFind',
        'foragingRareFind',
        'woodcuttingRareFind',
        'cheesesmithingRareFind',
        'craftingRareFind',
        'tailoringRareFind',
        'brewingRareFind',
        'cookingRareFind',
        'alchemyRareFind',
        'enhancingRareFind',
    ];

    /**
     * Parse Rare Find bonus from equipment
     * @param {Map} characterEquipment - Equipment map from dataManager.getEquipment()
     * @param {string} actionTypeHrid - Action type HRID (for skill-specific rare find)
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @returns {number} Total rare find bonus as percentage (e.g., 15 for 15%)
     *
     * @example
     * parseRareFindBonus(equipment, "/action_types/brewing", items)
     * // Brewer's Top (base 0.15, bonus 0.003) +0: 15%
     * // Brewer's Top (base 0.15, bonus 0.003) +10: 18%
     * // Earrings of Rare Find (base 0.08, bonus 0.002) +0: 8%
     * // Total: 26%
     */
    function parseRareFindBonus(characterEquipment, actionTypeHrid, itemDetailMap) {
        const skillSpecificField = getFieldForActionType(actionTypeHrid, 'RareFind', VALID_RARE_FIND_FIELDS);

        return parseEquipmentStat(characterEquipment, itemDetailMap, {
            skillSpecificField,
            genericField: 'skillingRareFind',
            returnAsPercentage: true,
        });
    }

    /**
     * Generic per-item equipment stat breakdown
     * @param {Map} characterEquipment - Equipment map
     * @param {Object} itemDetailMap - Item details
     * @param {string|null} skillSpecificField - e.g. "foragingEfficiency"
     * @param {string|null} genericField - e.g. "skillingEfficiency"
     * @param {boolean} returnAsPercentage - Multiply by 100
     * @returns {Array<{name, enhancementLevel, value}>}
     */
    function parseEquipmentStatBreakdown(
        characterEquipment,
        itemDetailMap,
        skillSpecificField,
        genericField,
        returnAsPercentage
    ) {
        if (!characterEquipment || characterEquipment.size === 0) return [];
        if (!itemDetailMap) return [];

        const items = [];

        for (const [slotHrid, equippedItem] of characterEquipment) {
            const itemDetails = itemDetailMap[equippedItem.itemHrid];
            if (!itemDetails?.equipmentDetail?.noncombatStats) continue;

            const noncombatStats = itemDetails.equipmentDetail.noncombatStats;
            const enhancementLevel = equippedItem.enhancementLevel || 0;
            let value = 0;

            if (skillSpecificField) {
                const base = noncombatStats[skillSpecificField];
                if (base > 0) value += calculateEnhancementScaling(base, enhancementLevel, slotHrid);
            }
            if (genericField) {
                const base = noncombatStats[genericField];
                if (base > 0) value += calculateEnhancementScaling(base, enhancementLevel, slotHrid);
            }

            if (value > 0) {
                items.push({
                    name: itemDetails.name,
                    enhancementLevel,
                    value: value * 100 ,
                });
            }
        }

        return items;
    }

    /**
     * Get per-item efficiency bonus breakdown for an action type
     * @param {Map} characterEquipment - Equipment map
     * @param {string} actionTypeHrid - Action type HRID
     * @param {Object} itemDetailMap - Item details
     * @returns {Array<{name, enhancementLevel, value}>}
     */
    function parseEquipmentEfficiencyBreakdown(characterEquipment, actionTypeHrid, itemDetailMap) {
        const skillSpecificField = getFieldForActionType(actionTypeHrid, 'Efficiency', VALID_EFFICIENCY_FIELDS);
        return parseEquipmentStatBreakdown(
            characterEquipment,
            itemDetailMap,
            skillSpecificField,
            'skillingEfficiency');
    }

    /**
     * Get per-item rare find bonus breakdown for an action type
     * @param {Map} characterEquipment - Equipment map
     * @param {string} actionTypeHrid - Action type HRID
     * @param {Object} itemDetailMap - Item details
     * @returns {Array<{name, enhancementLevel, value}>}
     */
    function parseRareFindBreakdown(characterEquipment, actionTypeHrid, itemDetailMap) {
        const skillSpecificField = getFieldForActionType(actionTypeHrid, 'RareFind', VALID_RARE_FIND_FIELDS);
        return parseEquipmentStatBreakdown(characterEquipment, itemDetailMap, skillSpecificField, 'skillingRareFind');
    }

    /**
     * Get all speed bonuses for debugging
     * @param {Map} characterEquipment - Equipment map
     * @param {Object} itemDetailMap - Item details
     * @returns {Array} Array of speed bonus objects
     */
    function debugEquipmentSpeedBonuses(characterEquipment, itemDetailMap) {
        if (!characterEquipment || characterEquipment.size === 0) {
            return [];
        }

        const bonuses = [];

        for (const [slotHrid, equippedItem] of characterEquipment) {
            const itemDetails = itemDetailMap[equippedItem.itemHrid];

            if (!itemDetails || !itemDetails.equipmentDetail) {
                continue;
            }

            const noncombatStats = itemDetails.equipmentDetail.noncombatStats;

            if (!noncombatStats) {
                continue;
            }

            // Find all speed bonuses on this item
            for (const [statName, value] of Object.entries(noncombatStats)) {
                if (statName.endsWith('Speed') && value > 0) {
                    const enhancementLevel = equippedItem.enhancementLevel || 0;
                    const scaledValue = calculateEnhancementScaling(value, enhancementLevel, slotHrid);

                    bonuses.push({
                        itemName: itemDetails.name,
                        itemHrid: equippedItem.itemHrid,
                        slot: slotHrid,
                        speedType: statName,
                        baseBonus: value,
                        enhancementLevel,
                        scaledBonus: scaledValue,
                    });
                }
            }
        }

        return bonuses;
    }

    var equipmentParser = /*#__PURE__*/Object.freeze({
        __proto__: null,
        debugEquipmentSpeedBonuses: debugEquipmentSpeedBonuses,
        parseEquipmentEfficiencyBonuses: parseEquipmentEfficiencyBonuses,
        parseEquipmentEfficiencyBreakdown: parseEquipmentEfficiencyBreakdown,
        parseEquipmentSpeedBonuses: parseEquipmentSpeedBonuses,
        parseEssenceFindBonus: parseEssenceFindBonus,
        parseGatheringQuantityBonus: parseGatheringQuantityBonus,
        parseRareFindBonus: parseRareFindBonus,
        parseRareFindBreakdown: parseRareFindBreakdown
    });

    /**
     * Tea Buff Parser Utility
     * Calculates efficiency bonuses from active tea buffs
     *
     * Tea efficiency comes from two buff types:
     * 1. /buff_types/efficiency - Generic efficiency (e.g., Efficiency Tea: 10%)
     * 2. /buff_types/{skill}_level - Skill level bonuses (e.g., Brewing Tea: +3 levels)
     *
     * All tea effects scale with Drink Concentration equipment stat.
     */


    /**
     * Generic tea buff parser - handles all tea buff types with consistent logic
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.12 for 12%)
     * @param {Object} config - Parser configuration
     * @param {Array<string>} config.buffTypeHrids - Buff type HRIDs to check (e.g., ['/buff_types/artisan'])
     * @returns {number} Total buff bonus
     *
     * @example
     * // Parse artisan bonus
     * parseTeaBuff(drinks, items, 0.12, { buffTypeHrids: ['/buff_types/artisan'] })
     */
    function parseTeaBuff(activeDrinks, itemDetailMap, drinkConcentration, config) {
        if (!activeDrinks || activeDrinks.length === 0) {
            return 0; // No active teas
        }

        if (!itemDetailMap) {
            return 0; // Missing required data
        }

        const { buffTypeHrids } = config;
        let totalBonus = 0;

        // Process each active tea/drink
        for (const drink of activeDrinks) {
            if (!drink || !drink.itemHrid) {
                continue; // Empty slot
            }

            const itemDetails = itemDetailMap[drink.itemHrid];
            if (!itemDetails || !itemDetails.consumableDetail || !itemDetails.consumableDetail.buffs) {
                continue; // Not a consumable or has no buffs
            }

            // Check each buff on this tea
            for (const buff of itemDetails.consumableDetail.buffs) {
                // Check if this buff matches any of the target types
                if (buffTypeHrids.includes(buff.typeHrid)) {
                    const baseValue = buff.flatBoost;
                    const scaledValue = baseValue * (1 + drinkConcentration);
                    totalBonus += scaledValue;
                }
            }
        }

        return totalBonus;
    }

    /**
     * Parse tea efficiency bonuses for a specific action type
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/brewing")
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.12 for 12%)
     * @returns {number} Total tea efficiency bonus as percentage (e.g., 12 for 12%)
     *
     * @example
     * // With Efficiency Tea (10% base) and 12% Drink Concentration:
     * parseTeaEfficiency("/action_types/brewing", activeDrinks, items, 0.12)
     * // Returns: 11.2 (10% × 1.12 = 11.2%)
     */
    function parseTeaEfficiency(actionTypeHrid, activeDrinks, itemDetailMap, drinkConcentration = 0) {
        if (!activeDrinks || activeDrinks.length === 0) {
            return 0; // No active teas
        }

        if (!actionTypeHrid || !itemDetailMap) {
            return 0; // Missing required data
        }

        let totalEfficiency = 0;

        // Process each active tea/drink
        for (const drink of activeDrinks) {
            if (!drink || !drink.itemHrid) {
                continue; // Empty slot
            }

            const itemDetails = itemDetailMap[drink.itemHrid];
            if (!itemDetails || !itemDetails.consumableDetail || !itemDetails.consumableDetail.buffs) {
                continue; // Not a consumable or has no buffs
            }

            // Check each buff on this tea
            for (const buff of itemDetails.consumableDetail.buffs) {
                // Generic efficiency buff (e.g., Efficiency Tea)
                if (buff.typeHrid === '/buff_types/efficiency') {
                    const baseEfficiency = buff.flatBoost * 100; // Convert to percentage
                    const scaledEfficiency = baseEfficiency * (1 + drinkConcentration);
                    totalEfficiency += scaledEfficiency;
                }
                // Note: Skill-specific level buffs are NOT counted here
                // They affect Level Bonus calculation, not Tea Bonus
            }
        }

        return totalEfficiency;
    }

    /**
     * Parse tea efficiency bonuses with breakdown by individual tea
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/brewing")
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.12 for 12%)
     * @returns {Array<{name: string, efficiency: number, baseEfficiency: number, dcContribution: number}>} Array of tea contributions
     *
     * @example
     * // With Efficiency Tea (10% base) and Ultra Cheesesmithing Tea (6% base) with 12% DC:
     * parseTeaEfficiencyBreakdown("/action_types/cheesesmithing", activeDrinks, items, 0.12)
     * // Returns: [
     * //   { name: "Efficiency Tea", efficiency: 11.2, baseEfficiency: 10.0, dcContribution: 1.2 },
     * //   { name: "Ultra Cheesesmithing Tea", efficiency: 6.72, baseEfficiency: 6.0, dcContribution: 0.72 }
     * // ]
     */
    function parseTeaEfficiencyBreakdown(actionTypeHrid, activeDrinks, itemDetailMap, drinkConcentration = 0) {
        if (!activeDrinks || activeDrinks.length === 0) {
            return []; // No active teas
        }

        if (!actionTypeHrid || !itemDetailMap) {
            return []; // Missing required data
        }

        const teaBreakdown = [];

        // Process each active tea/drink
        for (const drink of activeDrinks) {
            if (!drink || !drink.itemHrid) {
                continue; // Empty slot
            }

            const itemDetails = itemDetailMap[drink.itemHrid];
            if (!itemDetails || !itemDetails.consumableDetail || !itemDetails.consumableDetail.buffs) {
                continue; // Not a consumable or has no buffs
            }

            let baseEfficiency = 0;
            let totalEfficiency = 0;

            // Check each buff on this tea
            for (const buff of itemDetails.consumableDetail.buffs) {
                // Generic efficiency buff (e.g., Efficiency Tea)
                if (buff.typeHrid === '/buff_types/efficiency') {
                    const baseValue = buff.flatBoost * 100; // Convert to percentage
                    const scaledValue = baseValue * (1 + drinkConcentration);
                    baseEfficiency += baseValue;
                    totalEfficiency += scaledValue;
                }
                // Note: Skill-specific level buffs are NOT counted here
                // They affect Level Bonus calculation, not Tea Bonus
            }

            // Only add to breakdown if this tea contributes efficiency
            if (totalEfficiency > 0) {
                teaBreakdown.push({
                    name: itemDetails.name,
                    efficiency: totalEfficiency,
                    baseEfficiency: baseEfficiency,
                    dcContribution: totalEfficiency - baseEfficiency,
                });
            }
        }

        return teaBreakdown;
    }

    /**
     * Get Drink Concentration stat from equipped items
     * @param {Map} characterEquipment - Equipment map from dataManager.getEquipment()
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @returns {number} Total drink concentration as decimal (e.g., 0.12 for 12%)
     *
     * @example
     * getDrinkConcentration(equipment, items)
     * // Returns: 0.12 (if wearing items with 12% total drink concentration)
     */
    function getDrinkConcentration(characterEquipment, itemDetailMap) {
        if (!characterEquipment || characterEquipment.size === 0) {
            return 0; // No equipment
        }

        if (!itemDetailMap) {
            return 0; // Missing item data
        }

        let totalDrinkConcentration = 0;

        // Iterate through all equipped items
        for (const [_slotHrid, equippedItem] of characterEquipment) {
            const itemDetails = itemDetailMap[equippedItem.itemHrid];

            if (!itemDetails || !itemDetails.equipmentDetail) {
                continue; // Not an equipment item
            }

            const noncombatStats = itemDetails.equipmentDetail.noncombatStats;
            if (!noncombatStats) {
                continue; // No noncombat stats
            }

            // Check for drink concentration stat
            const baseDrinkConcentration = noncombatStats.drinkConcentration;
            if (!baseDrinkConcentration || baseDrinkConcentration <= 0) {
                continue; // No drink concentration on this item
            }

            // Get enhancement level from equipped item
            const enhancementLevel = equippedItem.enhancementLevel || 0;

            // Calculate scaled drink concentration with enhancement
            // Uses enhancement multiplier table (e.g., +10 = 1.29× for 1× slots like pouch)
            const enhancementMultiplier = getEnhancementMultiplier(itemDetails, enhancementLevel);
            const scaledDrinkConcentration = baseDrinkConcentration * enhancementMultiplier;

            totalDrinkConcentration += scaledDrinkConcentration;
        }

        return totalDrinkConcentration;
    }

    /**
     * Parse Artisan bonus from active tea buffs
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.12 for 12%)
     * @returns {number} Artisan material reduction as decimal (e.g., 0.112 for 11.2% reduction)
     *
     * @example
     * // With Artisan Tea (10% base) and 12% Drink Concentration:
     * parseArtisanBonus(activeDrinks, items, 0.12)
     * // Returns: 0.112 (10% × 1.12 = 11.2% reduction)
     */
    function parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration = 0) {
        return parseTeaBuff(activeDrinks, itemDetailMap, drinkConcentration, {
            buffTypeHrids: ['/buff_types/artisan'],
        });
    }

    /**
     * Parse Gourmet bonus from active tea buffs
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.12 for 12%)
     * @returns {number} Gourmet bonus chance as decimal (e.g., 0.1344 for 13.44% bonus items)
     *
     * @example
     * // With Gourmet Tea (12% base) and 12% Drink Concentration:
     * parseGourmetBonus(activeDrinks, items, 0.12)
     * // Returns: 0.1344 (12% × 1.12 = 13.44% bonus items)
     */
    function parseGourmetBonus(activeDrinks, itemDetailMap, drinkConcentration = 0) {
        return parseTeaBuff(activeDrinks, itemDetailMap, drinkConcentration, {
            buffTypeHrids: ['/buff_types/gourmet'],
        });
    }

    /**
     * Parse Processing bonus from active tea buffs
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.12 for 12%)
     * @returns {number} Processing conversion chance as decimal (e.g., 0.168 for 16.8% conversion chance)
     *
     * @example
     * // With Processing Tea (15% base) and 12% Drink Concentration:
     * parseProcessingBonus(activeDrinks, items, 0.12)
     * // Returns: 0.168 (15% × 1.12 = 16.8% conversion chance)
     */
    function parseProcessingBonus(activeDrinks, itemDetailMap, drinkConcentration = 0) {
        return parseTeaBuff(activeDrinks, itemDetailMap, drinkConcentration, {
            buffTypeHrids: ['/buff_types/processing'],
        });
    }

    /**
     * Parse Action Level bonus from active tea buffs
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.12 for 12%)
     * @returns {number} Action Level bonus as flat number (e.g., 5.645 for +5.645 levels, floored to 5 when used)
     *
     * @example
     * // With Artisan Tea (+5 Action Level base) and 12% Drink Concentration:
     * parseActionLevelBonus(activeDrinks, items, 0.129)
     * // Returns: 5.645 (scales with DC, but game floors this to 5 when calculating requirement)
     */
    function parseActionLevelBonus(activeDrinks, itemDetailMap, drinkConcentration = 0) {
        // Action Level DOES scale with DC (like all other buffs)
        // However, the game floors the result when calculating effective requirement
        return parseTeaBuff(activeDrinks, itemDetailMap, drinkConcentration, {
            buffTypeHrids: ['/buff_types/action_level'],
        });
    }

    /**
     * Parse Action Level bonus with breakdown by individual tea
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.12 for 12%)
     * @returns {Array<{name: string, actionLevel: number, baseActionLevel: number, dcContribution: number}>} Array of tea contributions
     *
     * @example
     * // With Artisan Tea (+5 Action Level base) and 12.9% Drink Concentration:
     * parseActionLevelBonusBreakdown(activeDrinks, items, 0.129)
     * // Returns: [{ name: "Artisan Tea", actionLevel: 5.645, baseActionLevel: 5.0, dcContribution: 0.645 }]
     * // Note: Game floors actionLevel to 5 when calculating requirement, but we show full precision
     */
    function parseActionLevelBonusBreakdown(activeDrinks, itemDetailMap, drinkConcentration = 0) {
        if (!activeDrinks || activeDrinks.length === 0) {
            return []; // No active teas
        }

        if (!itemDetailMap) {
            return []; // Missing required data
        }

        const teaBreakdown = [];

        // Process each active tea/drink
        for (const drink of activeDrinks) {
            if (!drink || !drink.itemHrid) {
                continue; // Empty slot
            }

            const itemDetails = itemDetailMap[drink.itemHrid];
            if (!itemDetails || !itemDetails.consumableDetail || !itemDetails.consumableDetail.buffs) {
                continue; // Not a consumable or has no buffs
            }

            let baseActionLevel = 0;
            let totalActionLevel = 0;

            // Check each buff on this tea
            for (const buff of itemDetails.consumableDetail.buffs) {
                // Action Level buff (e.g., Artisan Tea: +5 Action Level)
                if (buff.typeHrid === '/buff_types/action_level') {
                    const baseValue = buff.flatBoost;
                    // Action Level DOES scale with DC (like all other buffs)
                    const scaledValue = baseValue * (1 + drinkConcentration);
                    baseActionLevel += baseValue;
                    totalActionLevel += scaledValue;
                }
            }

            // Only add to breakdown if this tea contributes action level
            if (totalActionLevel > 0) {
                teaBreakdown.push({
                    name: itemDetails.name,
                    actionLevel: totalActionLevel,
                    baseActionLevel: baseActionLevel,
                    dcContribution: totalActionLevel - baseActionLevel,
                });
            }
        }

        return teaBreakdown;
    }

    /**
     * Parse Gathering bonus from active tea buffs
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.12 for 12%)
     * @returns {number} Gathering quantity bonus as decimal (e.g., 0.168 for 16.8% more items)
     *
     * @example
     * // With Gathering Tea (+15% base) and 12% Drink Concentration:
     * parseGatheringBonus(activeDrinks, items, 0.12)
     * // Returns: 0.168 (15% × 1.12 = 16.8% gathering quantity)
     */
    function parseGatheringBonus(activeDrinks, itemDetailMap, drinkConcentration = 0) {
        return parseTeaBuff(activeDrinks, itemDetailMap, drinkConcentration, {
            buffTypeHrids: ['/buff_types/gathering'],
        });
    }

    /**
     * Parse skill level bonus from active tea buffs for a specific action type
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/cheesesmithing")
     * @param {Array} activeDrinks - Array of active drink items from actionTypeDrinkSlotsMap
     * @param {Object} itemDetailMap - Item details from init_client_data
     * @param {number} drinkConcentration - Drink Concentration stat (as decimal, e.g., 0.129 for 12.9%)
     * @returns {number} Total skill level bonus (e.g., 9.032 for +8 base × 1.129 DC)
     *
     * @example
     * // With Ultra Cheesesmithing Tea (+8 Cheesesmithing base) and 12.9% DC:
     * parseTeaSkillLevelBonus("/action_types/cheesesmithing", activeDrinks, items, 0.129)
     * // Returns: 9.032 (8 × 1.129 = 9.032 levels)
     */
    function parseTeaSkillLevelBonus(actionTypeHrid, activeDrinks, itemDetailMap, drinkConcentration = 0) {
        if (!activeDrinks || activeDrinks.length === 0) {
            return 0; // No active teas
        }

        if (!actionTypeHrid || !itemDetailMap) {
            return 0; // Missing required data
        }

        // Extract skill name from action type HRID
        // "/action_types/cheesesmithing" -> "cheesesmithing"
        const skillName = actionTypeHrid.split('/').pop();
        const skillLevelBuffType = `/buff_types/${skillName}_level`;

        let totalLevelBonus = 0;

        // Process each active tea/drink
        for (const drink of activeDrinks) {
            if (!drink || !drink.itemHrid) {
                continue; // Empty slot
            }

            const itemDetails = itemDetailMap[drink.itemHrid];
            if (!itemDetails || !itemDetails.consumableDetail || !itemDetails.consumableDetail.buffs) {
                continue; // Not a consumable or has no buffs
            }

            // Check each buff on this tea
            for (const buff of itemDetails.consumableDetail.buffs) {
                // Skill-specific level buff (e.g., "/buff_types/cheesesmithing_level")
                if (buff.typeHrid === skillLevelBuffType) {
                    const baseValue = buff.flatBoost;
                    const scaledValue = baseValue * (1 + drinkConcentration);
                    totalLevelBonus += scaledValue;
                }
            }
        }

        return totalLevelBonus;
    }

    var teaParser = {
        parseTeaEfficiency,
        getDrinkConcentration,
        parseArtisanBonus,
        parseGourmetBonus,
        parseProcessingBonus,
        parseActionLevelBonus,
        parseGatheringBonus,
        parseTeaSkillLevelBonus,
    };

    var teaParser$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        default: teaParser,
        getDrinkConcentration: getDrinkConcentration,
        parseActionLevelBonus: parseActionLevelBonus,
        parseActionLevelBonusBreakdown: parseActionLevelBonusBreakdown,
        parseArtisanBonus: parseArtisanBonus,
        parseGatheringBonus: parseGatheringBonus,
        parseGourmetBonus: parseGourmetBonus,
        parseProcessingBonus: parseProcessingBonus,
        parseTeaEfficiency: parseTeaEfficiency,
        parseTeaEfficiencyBreakdown: parseTeaEfficiencyBreakdown,
        parseTeaSkillLevelBonus: parseTeaSkillLevelBonus
    });

    /**
     * House Efficiency Utility
     * Calculates efficiency bonuses from house rooms
     *
     * PART OF EFFICIENCY SYSTEM (Phase 2):
     * - House rooms provide +1.5% efficiency per level to matching actions
     * - Formula: houseLevel × 1.5%
     * - Data source: WebSocket (characterHouseRoomMap)
     */


    /**
     * Map action type HRID to house room HRID
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/brewing")
     * @returns {string|null} House room HRID or null
     */
    function getHouseRoomForActionType(actionTypeHrid) {
        // Mapping matches original MWI Tools
        const actionTypeToHouseRoomMap = {
            '/action_types/brewing': '/house_rooms/brewery',
            '/action_types/cheesesmithing': '/house_rooms/forge',
            '/action_types/cooking': '/house_rooms/kitchen',
            '/action_types/crafting': '/house_rooms/workshop',
            '/action_types/foraging': '/house_rooms/garden',
            '/action_types/milking': '/house_rooms/dairy_barn',
            '/action_types/tailoring': '/house_rooms/sewing_parlor',
            '/action_types/woodcutting': '/house_rooms/log_shed',
            '/action_types/alchemy': '/house_rooms/laboratory',
        };

        return actionTypeToHouseRoomMap[actionTypeHrid] || null;
    }

    /**
     * Calculate house efficiency bonus for an action type
     * @param {string} actionTypeHrid - Action type HRID
     * @returns {number} Efficiency bonus percentage (e.g., 12 for 12%)
     *
     * @example
     * calculateHouseEfficiency("/action_types/brewing")
     * // Returns: 12 (if brewery is level 8: 8 × 1.5% = 12%)
     */
    function calculateHouseEfficiency(actionTypeHrid) {
        // Get the house room for this action type
        const houseRoomHrid = getHouseRoomForActionType(actionTypeHrid);

        if (!houseRoomHrid) {
            return 0; // No house room for this action type
        }

        // Get house room level from game data (via dataManager)
        const roomLevel = dataManager.getHouseRoomLevel(houseRoomHrid);

        // Formula: houseLevel × 1.5%
        // Returns as percentage (e.g., 12 for 12%)
        return roomLevel * 1.5;
    }

    /**
     * Get friendly name for house room
     * @param {string} houseRoomHrid - House room HRID
     * @returns {string} Friendly name
     */
    function getHouseRoomName(houseRoomHrid) {
        const names = {
            '/house_rooms/brewery': 'Brewery',
            '/house_rooms/forge': 'Forge',
            '/house_rooms/kitchen': 'Kitchen',
            '/house_rooms/workshop': 'Workshop',
            '/house_rooms/garden': 'Garden',
            '/house_rooms/dairy_barn': 'Dairy Barn',
            '/house_rooms/sewing_parlor': 'Sewing Parlor',
            '/house_rooms/log_shed': 'Log Shed',
            '/house_rooms/laboratory': 'Laboratory',
        };

        return names[houseRoomHrid] || 'Unknown';
    }

    /**
     * Calculate total Rare Find bonus from all house rooms
     * @returns {number} Total rare find bonus as percentage (e.g., 1.6 for 1.6%)
     *
     * @example
     * calculateHouseRareFind()
     * // Returns: 1.6 (if total house room levels = 8: 8 × 0.2% per level = 1.6%)
     *
     * Formula from game data:
     * - flatBoostLevelBonus: 0.2% per level
     * - Total: totalLevels × 0.2%
     * - Max: 8 rooms × 8 levels = 64 × 0.2% = 12.8%
     */
    function calculateHouseRareFind() {
        // Get all house rooms
        const houseRooms = dataManager.getHouseRooms();

        if (!houseRooms || houseRooms.size === 0) {
            return 0; // No house rooms
        }

        // Sum all house room levels
        let totalLevels = 0;
        for (const [_hrid, room] of houseRooms) {
            totalLevels += room.level || 0;
        }

        // Formula: totalLevels × flatBoostLevelBonus
        // flatBoostLevelBonus: 0.2% per level (no base bonus)
        const flatBoostLevelBonus = 0.2;

        return totalLevels * flatBoostLevelBonus;
    }

    var houseEfficiency = {
        calculateHouseEfficiency,
        getHouseRoomName,
        calculateHouseRareFind,
    };

    var houseEfficiency$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateHouseEfficiency: calculateHouseEfficiency,
        calculateHouseRareFind: calculateHouseRareFind,
        default: houseEfficiency,
        getHouseRoomName: getHouseRoomName
    });

    /**
     * Profit Calculation Constants
     * Shared constants used across profit calculators
     */

    /**
     * Marketplace tax rate (2%)
     */
    const MARKET_TAX = 0.02;

    /**
     * Bag of 10 Cowbells item HRID (subject to 18% market tax)
     */
    const COWBELL_BAG_HRID = '/items/bag_of_10_cowbells';

    /**
     * Bag of 10 Cowbells market tax rate (18%)
     */
    const COWBELL_BAG_TAX = 0.18;

    /**
     * Base drink consumption rate per hour (before Drink Concentration)
     */
    const DRINKS_PER_HOUR_BASE = 12;

    /**
     * Seconds per hour (for rate conversions)
     */
    const SECONDS_PER_HOUR = 3600;

    /**
     * Minimum action time in seconds (game-enforced cap)
     */
    const MIN_ACTION_TIME_SECONDS = 3;

    /**
     * Hours per day (for daily profit calculations)
     */
    const HOURS_PER_DAY = 24;

    /**
     * Gathering skill action types
     * Skills that gather raw materials from the world
     */
    const GATHERING_TYPES = ['/action_types/foraging', '/action_types/woodcutting', '/action_types/milking'];

    /**
     * Production skill action types
     * Skills that craft items from materials
     */
    const PRODUCTION_TYPES = [
        '/action_types/brewing',
        '/action_types/cooking',
        '/action_types/cheesesmithing',
        '/action_types/crafting',
        '/action_types/tailoring',
    ];

    /**
     * All non-combat skill action types
     */
    const ALL_SKILL_TYPES = [...GATHERING_TYPES, ...PRODUCTION_TYPES];

    var profitConstants = {
        MARKET_TAX,
        COWBELL_BAG_HRID,
        COWBELL_BAG_TAX,
        DRINKS_PER_HOUR_BASE,
        SECONDS_PER_HOUR,
        MIN_ACTION_TIME_SECONDS,
        HOURS_PER_DAY,
        GATHERING_TYPES,
        PRODUCTION_TYPES,
        ALL_SKILL_TYPES,
    };

    var profitConstants$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        ALL_SKILL_TYPES: ALL_SKILL_TYPES,
        COWBELL_BAG_HRID: COWBELL_BAG_HRID,
        COWBELL_BAG_TAX: COWBELL_BAG_TAX,
        DRINKS_PER_HOUR_BASE: DRINKS_PER_HOUR_BASE,
        GATHERING_TYPES: GATHERING_TYPES,
        HOURS_PER_DAY: HOURS_PER_DAY,
        MARKET_TAX: MARKET_TAX,
        MIN_ACTION_TIME_SECONDS: MIN_ACTION_TIME_SECONDS,
        PRODUCTION_TYPES: PRODUCTION_TYPES,
        SECONDS_PER_HOUR: SECONDS_PER_HOUR,
        default: profitConstants
    });

    /**
     * Efficiency Utilities Module
     * Calculations for efficiency stacking and breakdowns
     */


    /**
     * Stack additive bonuses (most game bonuses)
     * @param {number[]} bonuses - Array of bonus percentages
     * @returns {number} Total stacked bonus percentage
     *
     * @example
     * stackAdditive([10, 20, 5])
     * // Returns: 35
     * // Because: 10% + 20% + 5% = 35%
     */
    function stackAdditive(...bonuses) {
        return bonuses.reduce((total, bonus) => total + bonus, 0);
    }

    /**
     * Calculate efficiency multiplier from efficiency percentage
     * Efficiency gives bonus action completions per time-consuming action
     *
     * @param {number} efficiencyPercent - Efficiency as percentage (e.g., 150 for 150%)
     * @returns {number} Multiplier (e.g., 2.5 for 150% efficiency)
     *
     * @example
     * calculateEfficiencyMultiplier(0)   // Returns 1.0 (no bonus)
     * calculateEfficiencyMultiplier(50)  // Returns 1.5
     * calculateEfficiencyMultiplier(150) // Returns 2.5
     */
    function calculateEfficiencyMultiplier(efficiencyPercent) {
        return 1 + (efficiencyPercent || 0) / 100;
    }

    /**
     * Calculate efficiency breakdown from supplied sources
     * @param {Object} params - Efficiency inputs
     * @param {number} params.requiredLevel - Action required level
     * @param {number} params.skillLevel - Player skill level
     * @param {number} [params.teaSkillLevelBonus=0] - Bonus skill levels from tea
     * @param {number} [params.actionLevelBonus=0] - Action level bonus from tea (affects requirement)
     * @param {number} [params.houseEfficiency=0] - House room efficiency bonus
     * @param {number} [params.equipmentEfficiency=0] - Equipment efficiency bonus
     * @param {number} [params.teaEfficiency=0] - Tea efficiency bonus
     * @param {number} [params.communityEfficiency=0] - Community buff efficiency bonus
     * @param {number} [params.achievementEfficiency=0] - Achievement efficiency bonus
     * @param {number} [params.personalEfficiency=0] - Personal buff (seal) efficiency bonus
     * @returns {Object} Efficiency breakdown
     */
    function calculateEfficiencyBreakdown({
        requiredLevel,
        skillLevel,
        teaSkillLevelBonus = 0,
        actionLevelBonus = 0,
        houseEfficiency = 0,
        equipmentEfficiency = 0,
        teaEfficiency = 0,
        communityEfficiency = 0,
        achievementEfficiency = 0,
        personalEfficiency = 0,
        guildEfficiency = 0,
    }) {
        const effectiveRequirement = (requiredLevel || 0) + actionLevelBonus;
        const baseSkillLevel = Math.max(skillLevel || 0, requiredLevel || 0);
        const effectiveLevel = baseSkillLevel + teaSkillLevelBonus;
        const levelEfficiency = Math.max(0, effectiveLevel - effectiveRequirement);
        const totalEfficiency = stackAdditive(
            levelEfficiency,
            houseEfficiency,
            equipmentEfficiency,
            teaEfficiency,
            communityEfficiency,
            achievementEfficiency,
            personalEfficiency,
            guildEfficiency
        );

        return {
            totalEfficiency,
            levelEfficiency,
            effectiveRequirement,
            effectiveLevel,
            breakdown: {
                houseEfficiency,
                equipmentEfficiency,
                teaEfficiency,
                communityEfficiency,
                achievementEfficiency,
                personalEfficiency,
                guildEfficiency,
                actionLevelBonus,
                teaSkillLevelBonus,
            },
        };
    }

    /**
     * Build the shared efficiency context for a production or gathering action.
     * Consolidates equipment lookup, tea parsing, house bonus, skill level, and
     * efficiency breakdown calculation that would otherwise be duplicated across
     * profit-calculator.js (production) and gathering-profit.js (gathering).
     *
     * @param {Object} actionDetails - Action detail object from dataManager
     * @param {Object} [options={}] - Configuration flags
     * @param {boolean} [options.isProduction=false] - True for production actions.
     *   When true: includes artisanBonus, actionLevelBonus, uses calculateHouseEfficiency.
     *   When false (gathering): uses inline houseRooms loop, includes gatheringQuantity.
     * @param {Object} [options.gameData=null] - Pre-fetched gameData (required for gathering path).
     * @param {number} [options.communityEfficiency=0] - Community buff efficiency (production only).
     *   Caller computes this via their own method (e.g. calculateCommunityBuffBonus) and passes it in.
     * @returns {Object} Efficiency context with all computed values
     */
    function getActionEfficiencyContext(actionDetails, options = {}) {
        const { isProduction = false, gameData = null, communityEfficiency = 0 } = options;

        const skills = dataManager.getSkills();
        const { equipment, drinks: drinkSlots } = resolveActionContext(actionDetails.type);
        const itemDetailMap = gameData?.itemDetailMap ?? dataManager.getInitClientData()?.itemDetailMap ?? {};

        // Drink concentration
        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);

        // Action time (nanoseconds → seconds)
        const baseTimePerActionSec = actionDetails.baseTimeCost / 1e9;
        const speedBonus = parseEquipmentSpeedBonuses(equipment, actionDetails.type, itemDetailMap);
        const personalSpeedBonus = dataManager.getPersonalBuffFlatBoost(actionDetails.type, '/buff_types/action_speed');

        const guildBuffs = dataManager.characterData?.guildActionTypeBuffsMap?.[actionDetails.type] || [];
        const guildSpeedBonus = guildBuffs.reduce(
            (sum, b) => (b.typeHrid === '/buff_types/action_speed' ? sum + (b.flatBoost || 0) + (b.ratioBoost || 0) : sum),
            0
        );
        const guildEfficiency = guildBuffs.reduce(
            (sum, b) =>
                b.typeHrid === '/buff_types/efficiency' ? sum + ((b.flatBoost || 0) + (b.ratioBoost || 0)) * 100 : sum,
            0
        );

        const actionTime = baseTimePerActionSec / (1 + speedBonus + personalSpeedBonus + guildSpeedBonus);

        // Skill level
        const baseRequirement = actionDetails.levelRequirement?.level || 1;
        const skillHrid = actionDetails.levelRequirement?.skillHrid;
        let skillLevel = baseRequirement;
        if (skills) {
            for (const skill of skills) {
                if (skill.skillHrid === skillHrid) {
                    skillLevel = skill.level;
                    break;
                }
            }
        }

        // Tea bonuses (shared by both paths)
        const teaSkillLevelBonus = parseTeaSkillLevelBonus(
            actionDetails.type,
            drinkSlots,
            itemDetailMap,
            drinkConcentration
        );
        const teaEfficiency = parseTeaEfficiency(actionDetails.type, drinkSlots, itemDetailMap, drinkConcentration);
        const processingBonus = GATHERING_TYPES.includes(actionDetails.type)
            ? parseProcessingBonus(drinkSlots, itemDetailMap, drinkConcentration) +
              dataManager.getPersonalBuffFlatBoost(actionDetails.type, '/buff_types/processing')
            : 0;
        const gourmetBonus = PRODUCTION_TYPES.includes(actionDetails.type)
            ? parseGourmetBonus(drinkSlots, itemDetailMap, drinkConcentration) +
              dataManager.getPersonalBuffFlatBoost(actionDetails.type, '/buff_types/gourmet')
            : 0;

        // Equipment efficiency
        const equipmentEfficiency = parseEquipmentEfficiencyBonuses(equipment, actionDetails.type, itemDetailMap);
        const equipmentEfficiencyItems = parseEquipmentEfficiencyBreakdown(equipment, actionDetails.type, itemDetailMap);
        const achievementEfficiency =
            dataManager.getAchievementBuffFlatBoost(actionDetails.type, '/buff_types/efficiency') * 100;
        const personalEfficiency = dataManager.getPersonalBuffFlatBoost(actionDetails.type, '/buff_types/efficiency') * 100;

        // Production-specific: artisan bonus, action level bonus, house via calculateHouseEfficiency
        // Gathering-specific: house via inline houseRooms loop
        let artisanBonus = 0;
        let actionLevelBonus = 0;
        let houseEfficiency = 0;

        if (isProduction) {
            artisanBonus = parseArtisanBonus(drinkSlots, itemDetailMap, drinkConcentration);
            actionLevelBonus = parseActionLevelBonus(drinkSlots, itemDetailMap, drinkConcentration);
            houseEfficiency = calculateHouseEfficiency(actionDetails.type);
        } else {
            // Gathering: compute house efficiency from houseRooms + houseRoomDetailMap
            const houseRooms = Array.from(dataManager.getHouseRooms().values());
            const initData = gameData ?? dataManager.getInitClientData();
            for (const room of houseRooms) {
                const roomDetail = initData?.houseRoomDetailMap?.[room.houseRoomHrid];
                if (roomDetail?.usableInActionTypeMap?.[actionDetails.type]) {
                    houseEfficiency += (room.level || 0) * 1.5;
                }
            }
        }

        // Gathering-only: gathering quantity bonuses
        let totalGathering = 0;
        let gatheringDetails = null;

        if (!isProduction && GATHERING_TYPES.includes(actionDetails.type)) {
            const gatheringTea = parseGatheringBonus(drinkSlots, itemDetailMap, drinkConcentration);
            const communityBuffLevel = dataManager.getCommunityBuffLevel('/community_buff_types/gathering_quantity');
            const communityGathering = communityBuffLevel ? 0.2 + (communityBuffLevel - 1) * 0.005 : 0;
            const achievementGathering = dataManager.getAchievementBuffFlatBoost(
                actionDetails.type,
                '/buff_types/gathering'
            );
            const personalGathering = dataManager.getPersonalBuffFlatBoost(actionDetails.type, '/buff_types/gathering');
            totalGathering = gatheringTea + communityGathering + achievementGathering + personalGathering;
            gatheringDetails = { gatheringTea, communityGathering, achievementGathering, personalGathering };
        }

        // Build efficiency breakdown
        const efficiencyBreakdown = calculateEfficiencyBreakdown({
            requiredLevel: baseRequirement,
            skillLevel,
            teaSkillLevelBonus,
            actionLevelBonus,
            houseEfficiency,
            equipmentEfficiency,
            teaEfficiency,
            communityEfficiency,
            achievementEfficiency,
            personalEfficiency,
            guildEfficiency,
        });

        const efficiencyMultiplier = calculateEfficiencyMultiplier(efficiencyBreakdown.totalEfficiency);

        return {
            // Equipment / drinks
            equipment,
            drinkSlots,
            drinkConcentration,
            itemDetailMap,
            // Timing
            actionTime,
            speedBonus,
            personalSpeedBonus,
            guildSpeedBonus,
            baseTimePerActionSec,
            // Skill
            skillLevel,
            baseRequirement,
            // Tea bonuses
            teaSkillLevelBonus,
            teaEfficiency,
            processingBonus,
            gourmetBonus,
            // Equipment efficiency
            equipmentEfficiency,
            equipmentEfficiencyItems,
            achievementEfficiency,
            personalEfficiency,
            guildEfficiency,
            // Production-only (zero for gathering)
            artisanBonus,
            actionLevelBonus,
            houseEfficiency,
            communityEfficiency,
            // Gathering-only (zero/null for production)
            totalGathering,
            gatheringDetails,
            // Final efficiency results
            efficiencyBreakdown,
            efficiencyMultiplier,
        };
    }

    var efficiency = {
        stackAdditive,
        calculateEfficiencyMultiplier,
        calculateEfficiencyBreakdown,
        getActionEfficiencyContext,
    };

    var efficiency$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateEfficiencyBreakdown: calculateEfficiencyBreakdown,
        calculateEfficiencyMultiplier: calculateEfficiencyMultiplier,
        default: efficiency,
        getActionEfficiencyContext: getActionEfficiencyContext,
        stackAdditive: stackAdditive
    });

    /**
     * Custom Price Overrides
     * Manages user-defined buy/sell price overrides for profit calculations.
     * Overrides are stored in IndexedDB and cached in memory.
     */


    const STORAGE_KEY$2 = 'Toolasha_customPriceOverrides';

    /** @type {Object|null} In-memory cache of overrides */
    let overridesCache = null;

    /**
     * Load overrides from storage into cache
     * @returns {Promise<Object>} The overrides object
     */
    async function loadOverrides() {
        if (overridesCache === null) {
            overridesCache = (await storage.getJSON(STORAGE_KEY$2, 'settings', {})) || {};
        }
        return overridesCache;
    }

    /**
     * Get all custom price overrides
     * @returns {Object} The overrides object (may be empty if not yet loaded)
     */
    function getCustomPriceOverrides() {
        if (overridesCache === null) {
            // Trigger async load but return empty for now
            loadOverrides();
            return {};
        }
        return overridesCache;
    }

    /**
     * Get a custom price for a specific item, enhancement level, and transaction side.
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level (default 0)
     * @param {string} side - Transaction side ('buy' or 'sell')
     * @returns {number|null} Custom price or null if no override exists
     */
    function getCustomPrice(itemHrid, enhancementLevel = 0, side = 'sell') {
        const overrides = getCustomPriceOverrides();
        const key = `${itemHrid}:${enhancementLevel}`;
        const override = overrides[key];
        if (!override) {
            return null;
        }
        const price = override[side];
        if (price === undefined || price === null || price === '') {
            return null;
        }
        return price;
    }

    /**
     * Market Data Utility
     * Centralized access to market prices with smart pricing mode handling
     */


    // Track logged warnings to prevent console spam
    const loggedWarnings = new Set();

    /**
     * Get item price based on pricing mode and context
     * @param {string} itemHrid - Item HRID
     * @param {Object} options - Configuration options
     * @param {number} [options.enhancementLevel=0] - Enhancement level
     * @param {string} [options.mode] - Pricing mode ('ask'|'bid'|'average'). If not provided, uses context or user settings
     * @param {string} [options.context] - Context hint ('profit'|'networth'|null). Used to determine pricing mode from settings
     * @param {string} [options.side='sell'] - Transaction side ('buy'|'sell') - used with 'profit' context to determine correct price
     * @returns {number|null} Price in gold, or null if no market data
     */
    function getItemPrice(itemHrid, options = {}) {
        // Validate inputs
        if (!itemHrid || typeof itemHrid !== 'string') {
            return null;
        }

        // Handle case where someone passes enhancementLevel as second arg (old API)
        if (typeof options === 'number') {
            options = { enhancementLevel: options };
        }

        // Ensure options is an object
        if (typeof options !== 'object' || options === null) {
            options = {};
        }

        const { enhancementLevel = 0, mode, context, side = 'sell' } = options;

        // Check for custom price override
        const customPrice = getCustomPrice(itemHrid, enhancementLevel, side);
        if (customPrice !== null) {
            return customPrice;
        }

        // Get raw price data from API
        const priceData = marketAPI.getPrice(itemHrid, enhancementLevel);

        if (!priceData) {
            return null;
        }

        // Determine pricing mode
        const pricingMode = mode || getPricingMode(context, side);

        // Validate pricing mode
        const validModes = ['ask', 'bid', 'average'];
        if (!validModes.includes(pricingMode)) {
            const warningKey = `mode:${pricingMode}`;
            if (!loggedWarnings.has(warningKey)) {
                console.warn(`[Market Data] Unknown pricing mode: ${pricingMode}, defaulting to ask`);
                loggedWarnings.add(warningKey);
            }
            return priceData.ask || 0;
        }

        const resolvePrice = (value) => {
            if (typeof value !== 'number') {
                return null;
            }

            if (value < 0) {
                return null;
            }

            return value;
        };

        // Return price based on mode
        switch (pricingMode) {
            case 'ask':
                return resolvePrice(priceData.ask);
            case 'bid':
                return resolvePrice(priceData.bid);
            case 'average':
                if (typeof priceData.ask !== 'number' || typeof priceData.bid !== 'number') {
                    return null;
                }

                if (priceData.ask < 0 || priceData.bid < 0) {
                    return null;
                }

                return (priceData.ask + priceData.bid) / 2;
            default:
                return resolvePrice(priceData.ask);
        }
    }

    /**
     * Check whether a custom price override applies to a given item/side.
     * `getItemPrice` returns a bare number for backward compatibility, so callers that need to
     * know whether that number came from the user's own price overrides (rather than the market)
     * can check this in parallel instead of relying on `getItemPrice`'s return shape.
     * @param {string} itemHrid - Item HRID
     * @param {number} [enhancementLevel=0] - Enhancement level
     * @param {string} [side='sell'] - Transaction side ('buy'|'sell')
     * @returns {boolean} True if a custom price override is set for this item/enhancement/side
     */
    function isPriceOverridden(itemHrid, enhancementLevel = 0, side = 'sell') {
        if (!itemHrid || typeof itemHrid !== 'string') {
            return false;
        }

        return getCustomPrice(itemHrid, enhancementLevel, side) !== null;
    }

    /**
     * Get a short, human-readable description of how stale the current market price data is.
     * Backed by marketAPI's fetch timestamp (data is refreshed at most every CACHE_DURATION).
     * @returns {string|null} e.g. "prices 4m old", "prices updated just now", or null if no data loaded yet
     */
    function getPriceAgeString() {
        const ageMs = marketAPI.getDataAge();
        if (ageMs === null) {
            return null;
        }

        const relative = formatRelativeTime(ageMs);
        return relative === 'Just now' ? 'prices updated just now' : `prices ${relative} old`;
    }

    /**
     * Get all price variants for an item
     * @param {string} itemHrid - Item HRID
     * @param {number} [enhancementLevel=0] - Enhancement level
     * @returns {Object|null} Object with {ask, bid, average} or null if no market data
     */
    function getItemPrices(itemHrid, enhancementLevel = 0) {
        const priceData = marketAPI.getPrice(itemHrid, enhancementLevel);

        if (!priceData) {
            return null;
        }

        return {
            ask: priceData.ask,
            bid: priceData.bid,
            average: (priceData.ask + priceData.bid) / 2,
        };
    }

    /**
     * Format price with K/M/B suffixes
     * @param {number} amount - Amount to format
     * @param {Object} options - Formatting options
     * @param {number} [options.decimals=1] - Number of decimal places
     * @param {boolean} [options.showZero=true] - Whether to show '0' for zero values
     * @returns {string} Formatted price string
     */
    function formatPrice(amount, options = {}) {
        const { decimals = 1, showZero = true } = options;

        if (amount === null || amount === undefined) {
            return '--';
        }

        if (amount === 0) {
            return showZero ? '0' : '--';
        }

        const absAmount = Math.abs(amount);
        const sign = amount < 0 ? '-' : '';

        if (absAmount >= 1_000_000_000) {
            return `${sign}${(absAmount / 1_000_000_000).toFixed(decimals)}B`;
        } else if (absAmount >= 1_000_000) {
            return `${sign}${(absAmount / 1_000_000).toFixed(decimals)}M`;
        } else if (absAmount >= 1_000) {
            return `${sign}${(absAmount / 1_000).toFixed(decimals)}K`;
        } else {
            return `${sign}${absAmount.toFixed(decimals)}`;
        }
    }

    /**
     * Determine pricing mode from context and user settings
     * @param {string} [context] - Context hint ('profit'|'networth'|null)
     * @param {string} [side='sell'] - Transaction side ('buy'|'sell') - used with 'profit' context
     * @returns {string} Pricing mode ('ask'|'bid'|'average')
     */
    function getPricingMode(context, side = 'sell') {
        // If no context, default to 'ask'
        if (!context) {
            return 'ask';
        }

        // Validate context is a string
        if (typeof context !== 'string') {
            return 'ask';
        }

        // Get pricing mode from settings based on context
        switch (context) {
            case 'profit': {
                const profitMode = config.getSettingValue('profitCalc_pricingMode');

                // Convert profit calculation modes to price types based on transaction side
                // Conservative: Ask/Bid (instant buy materials, instant sell output)
                // Hybrid: Ask/Ask (instant buy materials, patient sell output)
                // Optimistic: Bid/Ask (patient buy materials, patient sell output)
                // Patient Buy: Bid/Bid (patient buy materials, instant sell output)
                let selectedPriceType;
                switch (profitMode) {
                    case 'conservative':
                        selectedPriceType = side === 'buy' ? 'ask' : 'bid';
                        break;
                    case 'hybrid':
                        selectedPriceType = 'ask'; // Ask for both buy and sell
                        break;
                    case 'optimistic':
                        selectedPriceType = side === 'buy' ? 'bid' : 'ask';
                        break;
                    case 'patientBuy':
                        selectedPriceType = 'bid'; // Bid for both buy and sell
                        break;
                    default:
                        selectedPriceType = 'ask';
                }
                return selectedPriceType;
            }
            case 'networth': {
                return config.getSettingValue('networth_pricingMode') || 'ask';
            }
            default: {
                const warningKey = `context:${context}`;
                if (!loggedWarnings.has(warningKey)) {
                    console.warn(`[Market Data] Unknown context: ${context}, defaulting to ask`);
                    loggedWarnings.add(warningKey);
                }
                return 'ask';
            }
        }
    }

    /**
     * Get prices for multiple items in batch
     * @param {Array<{itemHrid: string, enhancementLevel?: number}>} items - Array of items to price
     * @param {Object} options - Configuration options
     * @param {string} [options.mode] - Pricing mode ('ask'|'bid'|'average')
     * @param {string} [options.context] - Context hint ('profit'|'networth'|null)
     * @param {string} [options.side='sell'] - Transaction side ('buy'|'sell')
     * @returns {Map<string, number>} Map of itemHrid+enhancementLevel to price
     */
    function getItemPricesBatch(items, options = {}) {
        const result = new Map();

        for (const item of items) {
            const key = `${item.itemHrid}:${item.enhancementLevel || 0}`;
            const price = getItemPrice(item.itemHrid, {
                enhancementLevel: item.enhancementLevel || 0,
                mode: options.mode,
                context: options.context,
                side: options.side,
            });

            if (price !== null) {
                result.set(key, price);
            }
        }

        return result;
    }

    var marketData = {
        getItemPrice,
        getItemPrices,
        formatPrice,
        getPricingMode,
        getItemPricesBatch,
        isPriceOverridden,
        getPriceAgeString,
    };

    var marketData$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        default: marketData,
        formatPrice: formatPrice,
        getItemPrice: getItemPrice,
        getItemPrices: getItemPrices,
        getItemPricesBatch: getItemPricesBatch,
        getPriceAgeString: getPriceAgeString,
        getPricingMode: getPricingMode,
        isPriceOverridden: isPriceOverridden
    });

    /**
     * Game Data Lookup Utilities
     *
     * Centralized functions for resolving display names to HRIDs.
     * Handles the ★ ↔ (R) refined item display name difference between
     * test server and live server.
     */


    /**
     * Generate alternate display names to handle ★ ↔ (R) refined item naming.
     * @param {string} name - Original display name
     * @returns {string[]} Array of alternate names to try (may be empty)
     */
    function getRefinedNameVariants(name) {
        const variants = [];
        if (name.includes('★')) {
            variants.push(name.replace(/\s*★/, ' (R)'));
        }
        if (name.includes('(R)')) {
            variants.push(name.replace(/\s*\(R\)/, ' ★'));
        }
        return variants;
    }

    /**
     * Find an action HRID from its display name.
     * Tries exact match first, then ★ ↔ (R) variants for refined items.
     * @param {string} actionName - Display name of the action
     * @returns {string|null} Action HRID or null if not found
     */
    function getActionHridFromName(actionName) {
        const gameData = dataManager.getInitClientData();
        if (!gameData?.actionDetailMap) {
            return null;
        }

        // Try exact match first
        for (const [hrid, detail] of Object.entries(gameData.actionDetailMap)) {
            if (detail.name === actionName) {
                return hrid;
            }
        }

        // Try ★ ↔ (R) variants for refined items
        for (const variant of getRefinedNameVariants(actionName)) {
            for (const [hrid, detail] of Object.entries(gameData.actionDetailMap)) {
                if (detail.name === variant) {
                    return hrid;
                }
            }
        }

        return null;
    }

    /**
     * Find an item HRID from its display name.
     * Tries exact match first, then ★ ↔ (R) variants for refined items.
     * @param {string} itemName - Display name of the item
     * @returns {string|null} Item HRID or null if not found
     */
    function getItemHridFromName(itemName) {
        const gameData = dataManager.getInitClientData();
        if (!gameData?.itemDetailMap) {
            return null;
        }

        // Try exact match first
        for (const [hrid, detail] of Object.entries(gameData.itemDetailMap)) {
            if (detail.name === itemName) {
                return hrid;
            }
        }

        // Try ★ ↔ (R) variants for refined items
        for (const variant of getRefinedNameVariants(itemName)) {
            for (const [hrid, detail] of Object.entries(gameData.itemDetailMap)) {
                if (detail.name === variant) {
                    return hrid;
                }
            }
        }

        return null;
    }

    /**
     * Get the coin cost of an item from the in-game shop.
     * Returns 0 if the item is not available in the shop or not purchasable with coins.
     * @param {string} itemHrid - Item HRID
     * @returns {number} Coin cost, or 0 if not available in shop
     */
    function getShopCoinCost(itemHrid) {
        const gameData = dataManager.getInitClientData();
        if (!gameData?.shopItemDetailMap) return 0;

        for (const shopItem of Object.values(gameData.shopItemDetailMap)) {
            if (shopItem.itemHrid === itemHrid) {
                if (shopItem.costs && shopItem.costs.length > 0) {
                    const coinCost = shopItem.costs.find((cost) => cost.itemHrid === '/items/coin');
                    if (coinCost) {
                        return coinCost.count;
                    }
                }
            }
        }

        return 0;
    }

    var gameLookups = /*#__PURE__*/Object.freeze({
        __proto__: null,
        getActionHridFromName: getActionHridFromName,
        getItemHridFromName: getItemHridFromName,
        getShopCoinCost: getShopCoinCost
    });

    /**
     * Enhancement Calculator
     *
     * Uses Markov Chain matrix math to calculate exact expected values for enhancement attempts.
     * Based on the original MWI Tools Enhancelate() function.
     *
     * Math.js library is loaded via userscript @require header.
     */


    /**
     * Base success rates by enhancement level (before bonuses)
     */
    const BASE_SUCCESS_RATES = [
        50, // +1
        45, // +2
        45, // +3
        40, // +4
        40, // +5
        40, // +6
        35, // +7
        35, // +8
        35, // +9
        35, // +10
        30, // +11
        30, // +12
        30, // +13
        30, // +14
        30, // +15
        30, // +16
        30, // +17
        30, // +18
        30, // +19
        30, // +20
    ];

    /**
     * Blessed Tea's base chance to skip an extra level on success, as a decimal.
     * Used when the caller has no live consumable data to read the real flatBoost from.
     */
    const BLESSED_TEA_BASE_CHANCE = 0.01;

    /**
     * Build the enhancement Markov transition matrix.
     *
     * This body is the single source of the chain. The networth and enhancement worker pools run
     * inside blob workers that cannot import a module, so their managers serialise this function
     * with `toString()` and drop the identical text into their worker scripts — which is why it
     * takes `math` and the base rates as arguments and closes over nothing. Any module-scope name
     * read from here would not exist in the worker, and the two copies would drift apart again.
     *
     * @param {Object} math - math.js namespace (a parameter, not the global, so this can be serialised)
     * @param {Object} options - Chain parameters
     * @param {number[]} options.baseSuccessRates - Base success rate per level, as percentages
     * @param {number} options.successMultiplier - Multiplier applied to the base rates
     * @param {number} options.targetLevel - Absorbing state
     * @param {number} [options.protectFrom=0] - Level from which a failure drops one level instead of to 0
     * @param {boolean} [options.blessedTea=false] - Whether Blessed Tea is active
     * @param {number} [options.guzzlingBonus=1.0] - Drink concentration multiplier
     * @param {number} [options.blessedTeaBonus=0.01] - Blessed Tea double-jump chance as a decimal
     * @returns {Object} 20×20 transition matrix
     */
    function buildEnhancementMarkov(math, options) {
        const {
            baseSuccessRates,
            successMultiplier,
            targetLevel,
            protectFrom = 0,
            blessedTea = false,
            guzzlingBonus = 1.0,
            blessedTeaBonus = 0.01,
        } = options;

        const markov = math.zeros(20, 20);

        for (let i = 0; i < targetLevel; i++) {
            const baseSuccessRate = baseSuccessRates[i] / 100.0;
            // A big enough success multiplier pushes the raw product past 1, which would hand the
            // failure row a negative probability and quietly corrupt the whole chain.
            const successChance = Math.min(1, baseSuccessRate * successMultiplier);

            // Where do we go on failure?
            // Protection only applies when protectFrom > 0 AND we're at or above that level
            const failureDestination = protectFrom > 0 && i >= protectFrom ? i - 1 : 0;

            if (blessedTea) {
                // Blessed Tea: base chance to jump +2 (read from item data when available),
                // scaled by guzzling bonus. Remaining success chance goes to +1.
                const skipChance = successChance * blessedTeaBonus * guzzlingBonus;
                const remainingSuccess = successChance * (1 - blessedTeaBonus * guzzlingBonus);

                // A jump from the last transient level lands past the absorbing state, which is
                // outside the matrix. It is already absorbed either way, so drop it.
                if (i + 2 <= targetLevel) {
                    markov.set([i, i + 2], skipChance);
                }
                markov.set([i, i + 1], remainingSuccess);
                markov.set([i, failureDestination], 1 - successChance);
            } else {
                // Normal: Success goes to +1, failure goes to destination
                markov.set([i, i + 1], successChance);
                markov.set([i, failureDestination], 1.0 - successChance);
            }
        }

        // Absorbing state at target level
        markov.set([targetLevel, targetLevel], 1.0);

        return markov;
    }

    /**
     * Variance of the number of attempts an enhancement run takes.
     *
     * The expected count on its own says nothing about the spread, and for this chain the spread is
     * most of the story: a run that averages 40 attempts is not a run that takes 40 attempts, it is
     * one that takes 12 if it goes well and 150 if it does not. Quoting only the mean turns a
     * gamble into a price list.
     *
     * From the fundamental matrix M already computed, with t = M·1 the expected attempts from each
     * state, the standard absorbing-chain result is
     *
     *   var = (2M − I)·t − t∘t
     *
     * taken at the starting state's row. Nothing extra is inverted — this is a second read of the
     * matrix the expected count already came from, so the two can never disagree.
     *
     * Takes the matrix rather than the chain parameters so it stays a pure function of M, which is
     * what lets a caller that already has one avoid rebuilding it.
     *
     * @param {Object} M - Fundamental matrix (I − Q)^-1, math.js matrix or anything with .get([i,j])
     * @param {number} targetLevel - Absorbing state, so the transient block is 0..targetLevel−1
     * @param {number} [startLevel=0] - State the run starts from
     * @returns {number} Variance in attempts, never negative
     */
    function absorptionVariance(M, targetLevel, startLevel = 0) {
        const expectedFrom = [];
        for (let i = 0; i < targetLevel; i++) {
            let rowSum = 0;
            for (let j = 0; j < targetLevel; j++) {
                rowSum += M.get([i, j]);
            }
            expectedFrom.push(rowSum);
        }

        let secondMoment = 0;
        for (let j = 0; j < targetLevel; j++) {
            // (2M − I) is the identity subtracted from twice M, which only touches the diagonal
            const coefficient = 2 * M.get([startLevel, j]) - (j === startLevel ? 1 : 0);
            secondMoment += coefficient * expectedFrom[j];
        }

        const mean = expectedFrom[startLevel] ?? 0;
        // Floating-point error on a near-deterministic run can push this a hair below zero, and a
        // negative variance would propagate as NaN through every standard deviation taken from it
        return Math.max(0, secondMoment - mean * mean);
    }

    /**
     * The standard normal quantile, to about seven decimal places.
     *
     * Acklam's rational approximation. Needed because the cost percentiles below are read off a
     * fitted distribution, and there is no inverse normal in the language.
     *
     * @param {number} p - Probability in (0, 1)
     * @returns {number} z such that Φ(z) = p
     */
    function normalQuantile(p) {
        if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;

        const a = [
            -39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924,
        ];
        const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
        const c = [
            -0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497,
            2.93816398269878,
        ];
        const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];

        const low = 0.02425;
        const high = 1 - low;

        if (p < low) {
            const q = Math.sqrt(-2 * Math.log(p));
            return (
                (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
                ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
            );
        }
        if (p > high) {
            const q = Math.sqrt(-2 * Math.log(1 - p));
            return -(
                (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
                ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
            );
        }

        const q = p - 0.5;
        const r = q * q;
        return (
            ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
            (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
        );
    }

    /**
     * The standard normal CDF, via the Abramowitz & Stegun error-function approximation.
     * @param {number} z - Standard score
     * @returns {number} Φ(z)
     */
    function normalCdf(z) {
        const t = 1 / (1 + 0.2316419 * Math.abs(z));
        const density = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
        const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
        const upper = density * poly;
        return z >= 0 ? 1 - upper : upper;
    }

    /**
     * Turn an attempt count and its variance into what a run costs.
     *
     * Everything an enhancement consumes is either paid once — the base item — or paid per attempt:
     * materials, and the protection items whose expected count is itself proportional to attempts.
     * So the cost is an affine function of the attempt count, and its distribution is the attempt
     * distribution scaled and shifted. That is the whole reason the variance is worth computing:
     * once it exists, the cost spread follows without simulating anything.
     *
     * @param {Object} attempts - { attempts, attemptsVariance, minAttempts } from calculateEnhancement
     * @param {Object} prices - Cost model
     * @param {number} [prices.costPerAttempt=0] - Coins each attempt burns (materials, protection)
     * @param {number} [prices.fixedCost=0] - Coins paid once, whatever happens (the base item)
     * @returns {Object} { expected, variance, stdDev, minimum } in coins
     */
    function costStats(attempts, prices = {}) {
        const perAttempt = Number(prices.costPerAttempt) || 0;
        const fixed = Number(prices.fixedCost) || 0;
        const mean = Number(attempts?.attempts) || 0;
        const variance = Math.max(0, Number(attempts?.attemptsVariance) || 0);
        const minimum = Math.max(0, Number(attempts?.minAttempts) || 0);

        return {
            expected: fixed + perAttempt * mean,
            variance: variance * perAttempt * perAttempt,
            stdDev: Math.sqrt(variance) * Math.abs(perAttempt),
            minimum: fixed + perAttempt * minimum,
        };
    }

    /**
     * Percentiles of a run's cost.
     *
     * Fitted as a *shifted* gamma rather than a normal, because the attempt count is neither
     * symmetric nor unbounded below. A normal fit on a run whose standard deviation approaches its
     * mean — which is the ordinary case here — puts its tenth percentile below zero, which is not a
     * cheap run, it is an impossible one. The shift is the fewest attempts the run could physically
     * take, and the gamma matched on the remaining mean and the variance carries the long right tail
     * that makes enhancing feel the way it does.
     *
     * Quantiles come from the Wilson–Hilferty cube-root transform, which is closed form and good to
     * a few parts in a thousand over the range worth quoting. Below the shift is impossible, so
     * every answer is clamped there.
     *
     * @param {Object} cost - Result of costStats
     * @param {number[]} [probabilities=[0.1, 0.5, 0.9]] - Probabilities to report
     * @returns {Object} { p10, p50, p90, values } — values pairs each probability with its cost,
     *   and the named fields are present only when their probability was asked for
     */
    function costPercentiles(cost, probabilities = [0.1, 0.5, 0.9]) {
        const expected = Number(cost?.expected) || 0;
        const variance = Math.max(0, Number(cost?.variance) || 0);
        const minimum = Math.min(Number(cost?.minimum) || 0, expected);
        const spread = expected - minimum;

        const quantile = (p) => {
            if (!(p > 0) || !(p < 1)) return expected;
            // A run with no spread costs what it costs; fitting a distribution to it would only
            // introduce error
            if (variance <= 0 || spread <= 0) return expected;

            const shape = (spread * spread) / variance;
            const scale = variance / spread;
            const z = normalQuantile(p);
            const factor = 1 - 1 / (9 * shape) + z / (3 * Math.sqrt(shape));
            return Math.max(minimum, minimum + shape * scale * Math.max(0, factor) ** 3);
        };

        const values = probabilities.map((p) => ({ p, cost: quantile(p) }));
        const named = {};
        for (const entry of values) {
            const label = `p${Math.round(entry.p * 100)}`;
            named[label] = entry.cost;
        }
        return { ...named, values };
    }

    /**
     * The chance a run costs more than some threshold — the sale proceeds, usually.
     *
     * The same fitted distribution read the other way round. It is the figure that decides whether
     * an enhance-to-sell is a trade or a bet: a median profit means nothing if two runs in five lose
     * money.
     *
     * @param {Object} cost - Result of costStats
     * @param {number} threshold - Coins to compare against
     * @returns {number} Probability in [0, 1]
     */
    function costExceedanceProbability(cost, threshold) {
        const expected = Number(cost?.expected) || 0;
        const variance = Math.max(0, Number(cost?.variance) || 0);
        const minimum = Math.min(Number(cost?.minimum) || 0, expected);
        const spread = expected - minimum;
        const limit = Number(threshold) || 0;

        if (variance <= 0 || spread <= 0) return expected > limit ? 1 : 0;
        if (limit <= minimum) return 1;

        const shape = (spread * spread) / variance;
        const scale = variance / spread;
        // Wilson–Hilferty inverted: the cube root of a gamma is very nearly normal
        const standardised = (limit - minimum) / (scale * shape);
        const z = 3 * Math.sqrt(shape) * (Math.cbrt(standardised) - 1 + 1 / (9 * shape));
        return Math.min(1, Math.max(0, 1 - normalCdf(z)));
    }

    /**
     * Calculate total success rate bonus multiplier
     * @param {Object} params - Enhancement parameters
     * @param {number} params.enhancingLevel - Effective enhancing level (base + tea bonus)
     * @param {number} params.toolBonus - Tool success bonus % (already includes equipment + house bonus)
     * @param {number} params.itemLevel - Item level being enhanced
     * @returns {number} Success rate multiplier (e.g., 1.0519 = 105.19% of base rates)
     */
    function calculateSuccessMultiplier(params) {
        const { enhancingLevel, toolBonus, itemLevel } = params;

        // Total bonus calculation
        // toolBonus already includes equipment + house success bonus from config
        // We only need to add level advantage here

        let totalBonus;

        if (enhancingLevel >= itemLevel) {
            // Above or at item level: +0.05% per level above item level
            const levelAdvantage = 0.05 * (enhancingLevel - itemLevel);
            totalBonus = 1 + (toolBonus + levelAdvantage) / 100;
        } else {
            // Below item level: Penalty based on level deficit
            totalBonus = 1 - 0.5 * (1 - enhancingLevel / itemLevel) + toolBonus / 100;
        }

        return totalBonus;
    }

    /**
     * Calculate per-action time for enhancement
     * Simple calculation that doesn't require Markov chain analysis
     * @param {number} enhancingLevel - Effective enhancing level (includes tea bonus)
     * @param {number} itemLevel - Item level being enhanced
     * @param {number} speedBonus - Speed bonus % (for action time calculation)
     * @returns {number} Per-action time in seconds
     */
    function calculatePerActionTime(enhancingLevel, itemLevel, speedBonus = 0) {
        const baseActionTime = 12; // seconds
        let speedMultiplier;

        if (enhancingLevel > itemLevel) {
            // Above item level: Get speed bonus from level advantage + equipment + house
            // Note: speedBonus already includes house level bonus (1% per level)
            speedMultiplier = 1 + (enhancingLevel - itemLevel + speedBonus) / 100;
        } else {
            // Below item level: Only equipment + house speed bonus
            // Note: speedBonus already includes house level bonus (1% per level)
            speedMultiplier = 1 + speedBonus / 100;
        }

        return Math.max(MIN_ACTION_TIME_SECONDS, baseActionTime / speedMultiplier);
    }

    /**
     * Calculate enhancement statistics using Markov Chain matrix inversion
     * @param {Object} params - Enhancement parameters
     * @param {number} params.enhancingLevel - Effective enhancing level (includes tea bonus)
     * @param {number} params.houseLevel - Observatory house room level (used for speed calculation only)
     * @param {number} params.toolBonus - Tool success bonus % (already includes equipment + house success bonus from config)
     * @param {number} params.speedBonus - Speed bonus % (for action time calculation)
     * @param {number} params.itemLevel - Item level being enhanced
     * @param {number} params.targetLevel - Target enhancement level (1-20)
     * @param {number} params.startLevel - Starting enhancement level (0-19, default 0)
     * @param {number} params.protectFrom - Start using protection items at this level (0 = never)
     * @param {boolean} params.blessedTea - Whether Blessed Tea is active (1% double jump)
     * @param {number} params.guzzlingBonus - Drink concentration multiplier (1.0 = no bonus, scales blessed tea)
     * @param {number} [params.blessedTeaBonus] - Blessed Tea double-jump chance as a decimal (default 1%)
     * @param {number} [params.perActionTimeOverride] - Per-action time in seconds measured from the
     *   game's buff maps. When supplied it replaces the formula below, so a tracker reading the live
     *   buff maps and a prediction built here share one time base.
     * @returns {Object} Enhancement statistics
     */
    function calculateEnhancement(params) {
        const {
            enhancingLevel,
            _houseLevel,
            toolBonus,
            speedBonus = 0,
            itemLevel,
            targetLevel,
            startLevel = 0,
            protectFrom = 0,
            blessedTea = false,
            guzzlingBonus = 1.0,
            blessedTeaBonus = BLESSED_TEA_BASE_CHANCE,
            perActionTimeOverride = 0,
        } = params;

        // Validate inputs
        if (targetLevel < 1 || targetLevel > 20) {
            throw new Error('Target level must be between 1 and 20');
        }
        if (protectFrom < 0 || protectFrom > targetLevel) {
            throw new Error('Protection level must be between 0 and target level');
        }

        // Calculate success rate multiplier
        const successMultiplier = calculateSuccessMultiplier({
            enhancingLevel,
            toolBonus,
            itemLevel,
        });

        // Build Markov Chain transition matrix (20×20) — shared with the worker pools
        const markov = buildEnhancementMarkov(math, {
            baseSuccessRates: BASE_SUCCESS_RATES,
            successMultiplier,
            targetLevel,
            protectFrom,
            blessedTea,
            guzzlingBonus,
            blessedTeaBonus,
        });

        // Extract transient matrix Q (all states before target)
        const Q = markov.subset(math.index(math.range(0, targetLevel), math.range(0, targetLevel)));

        // Fundamental matrix: M = (I - Q)^-1
        const I = math.identity(targetLevel);
        const M = math.inv(math.subtract(I, Q));

        // Expected attempts from startLevel to target.
        // This is the full row sum of the fundamental matrix: a failure below startLevel drops the
        // item back to states the run started above, and every visit there costs an attempt too.
        // Summing only from startLevel up would silently discount those.
        let attempts = 0;
        for (let i = 0; i < targetLevel; i++) {
            attempts += M.get([startLevel, i]);
        }

        // How far a run can stray from that expectation. Read off the same M, so the two figures
        // are one measurement rather than two that have to be kept in step.
        const attemptsVariance = absorptionVariance(M, targetLevel, startLevel);

        // Expected protection item uses
        let protects = 0;
        if (protectFrom > 0 && protectFrom < targetLevel) {
            for (let i = protectFrom; i < targetLevel; i++) {
                const timesAtLevel = M.get([startLevel, i]);
                const failureChance = markov.get([i, i - 1]);
                protects += timesAtLevel * failureChance;
            }
        }

        // Action time calculation
        const baseActionTime = 12; // seconds
        let speedMultiplier;

        if (enhancingLevel > itemLevel) {
            // Above item level: Get speed bonus from level advantage + equipment + house
            // Note: speedBonus already includes house level bonus (1% per level)
            speedMultiplier = 1 + (enhancingLevel - itemLevel + speedBonus) / 100;
        } else {
            // Below item level: Only equipment + house speed bonus
            // Note: speedBonus already includes house level bonus (1% per level)
            speedMultiplier = 1 + speedBonus / 100;
        }

        // A caller that can read the game's own buff maps knows the real per-action time; prefer it
        // over the formula so predictions and live tracking never disagree about the time base.
        const perActionTime =
            perActionTimeOverride > 0
                ? perActionTimeOverride
                : Math.max(MIN_ACTION_TIME_SECONDS, baseActionTime / speedMultiplier);
        const totalTime = perActionTime * attempts;

        // The fewest attempts the run could physically take: one per level, or one per two levels
        // when Blessed Tea can double-jump. Nothing below this is possible, which is what stops a
        // fitted cost distribution quoting a tenth percentile nobody could ever hit.
        const levelsToClimb = Math.max(0, targetLevel - startLevel);
        const minAttempts = blessedTea ? Math.ceil(levelsToClimb / 2) : levelsToClimb;

        return {
            attempts: attempts, // Keep exact decimal value for calculations
            attemptsRounded: Math.round(attempts), // Rounded for display
            // The spread around that expectation — see absorptionVariance
            attemptsVariance,
            attemptsStdDev: Math.sqrt(attemptsVariance),
            minAttempts,
            protectionCount: protects, // Keep decimal precision
            perActionTime: perActionTime,
            totalTime: totalTime,
            successMultiplier: successMultiplier,

            // Detailed success rates for each level
            successRates: BASE_SUCCESS_RATES.slice(0, targetLevel).map((base, i) => {
                return {
                    level: i + 1,
                    baseRate: base,
                    actualRate: Math.min(100, base * successMultiplier),
                };
            }),

            // Expected number of times each state is visited (from fundamental matrix M)
            visitCounts: Array.from({ length: targetLevel }, (_, i) => M.get([startLevel, i])),
        };
    }

    var enhancementCalculator = /*#__PURE__*/Object.freeze({
        __proto__: null,
        BASE_SUCCESS_RATES: BASE_SUCCESS_RATES,
        BLESSED_TEA_BASE_CHANCE: BLESSED_TEA_BASE_CHANCE,
        absorptionVariance: absorptionVariance,
        buildEnhancementMarkov: buildEnhancementMarkov,
        calculateEnhancement: calculateEnhancement,
        calculatePerActionTime: calculatePerActionTime,
        costExceedanceProbability: costExceedanceProbability,
        costPercentiles: costPercentiles,
        costStats: costStats
    });

    /**
     * Skill Gear Detector
     *
     * Auto-detects gear and buffs from character equipment for any skill.
     * Originally designed for enhancing, now works generically for all skills.
     */


    /**
     * Detect best gear for a specific skill by equipment slot
     * @param {string} skillName - Skill name (e.g., 'enhancing', 'cooking', 'milking')
     * @param {Map} equipment - Character equipment map (equipped items only)
     * @param {Object} itemDetailMap - Item details map from init_client_data
     * @returns {Object} Best gear per slot with bonuses
     */
    function detectSkillGear(skillName, equipment, itemDetailMap) {
        const gear = {
            // Totals for calculations
            toolBonus: 0,
            speedBonus: 0,
            rareFindBonus: 0,
            experienceBonus: 0,

            // Per-slot breakdown for display
            slotBreakdown: [],

            // Best items per slot for display
            toolSlot: null, // main_hand or two_hand
            bodySlot: null, // body
            legsSlot: null, // legs
            handsSlot: null, // hands
        };

        // Get items to scan - only use equipment map (already filtered to equipped items only)
        let itemsToScan = [];

        if (equipment) {
            // Scan only equipped items from equipment map
            itemsToScan = Array.from(equipment.values()).filter((item) => item && item.itemHrid);
        }

        // Track best item per slot (by item level, then enhancement level)
        const slotCandidates = {
            tool: [], // main_hand or two_hand or skill-specific tool
            body: [], // body
            legs: [], // legs
            hands: [], // hands
            neck: [], // neck (accessories have 5× multiplier)
            ring: [], // ring (accessories have 5× multiplier)
            earrings: [], // earrings (accessories have 5× multiplier)
            back: [], // back (capes)
            charm: [], // charm (5× multiplier)
        };

        // Dynamic stat names based on skill
        const successStat = `${skillName}Success`;
        const speedStat = `${skillName}Speed`;
        const rareFindStat = `${skillName}RareFind`;
        const experienceStat = `${skillName}Experience`;

        // Search all items for skill-related bonuses and group by slot
        for (const item of itemsToScan) {
            const itemDetails = itemDetailMap[item.itemHrid];
            if (!itemDetails?.equipmentDetail?.noncombatStats) {
                continue;
            }

            const stats = itemDetails.equipmentDetail.noncombatStats;
            const enhancementLevel = item.enhancementLevel || 0;
            const multiplier = getEnhancementMultiplier(itemDetails, enhancementLevel);
            const equipmentType = itemDetails.equipmentDetail.type;

            // Generic stat calculation: Loop over ALL stats and apply multiplier
            const allStats = {};
            for (const [statName, statValue] of Object.entries(stats)) {
                if (typeof statValue !== 'number') continue; // Skip non-numeric values
                allStats[statName] = statValue * 100 * multiplier;
            }

            // Check if item has any skill-related stats (including universal skills)
            const hasSkillStats =
                allStats[successStat] ||
                allStats[speedStat] ||
                allStats[rareFindStat] ||
                allStats[experienceStat] ||
                allStats.skillingSpeed ||
                allStats.skillingRareFind ||
                allStats.skillingExperience;

            if (!hasSkillStats) {
                continue;
            }

            // Calculate bonuses for this item (backward-compatible output)
            const itemBonuses = {
                item: item,
                itemDetails: itemDetails,
                itemLevel: itemDetails.itemLevel || 0,
                enhancementLevel: enhancementLevel,
                // Named bonuses (dynamic based on skill)
                toolBonus: allStats[successStat] || 0,
                speedBonus: (allStats[speedStat] || 0) + (allStats.skillingSpeed || 0), // Combine speed sources
                rareFindBonus: (allStats[rareFindStat] || 0) + (allStats.skillingRareFind || 0),
                experienceBonus: (allStats[experienceStat] || 0) + (allStats.skillingExperience || 0), // Combine experience sources
                // Generic access to all stats
                allStats: allStats,
            };

            // Group by slot
            // Tool slots: skill-specific tools (e.g., enhancing_tool, cooking_tool) plus main_hand/two_hand
            const skillToolType = `/equipment_types/${skillName}_tool`;
            if (
                equipmentType === skillToolType ||
                equipmentType === '/equipment_types/main_hand' ||
                equipmentType === '/equipment_types/two_hand'
            ) {
                slotCandidates.tool.push(itemBonuses);
            } else if (equipmentType === '/equipment_types/body') {
                slotCandidates.body.push(itemBonuses);
            } else if (equipmentType === '/equipment_types/legs') {
                slotCandidates.legs.push(itemBonuses);
            } else if (equipmentType === '/equipment_types/hands') {
                slotCandidates.hands.push(itemBonuses);
            } else if (equipmentType === '/equipment_types/neck') {
                slotCandidates.neck.push(itemBonuses);
            } else if (equipmentType === '/equipment_types/ring') {
                slotCandidates.ring.push(itemBonuses);
            } else if (equipmentType === '/equipment_types/earrings') {
                slotCandidates.earrings.push(itemBonuses);
            } else if (equipmentType === '/equipment_types/back') {
                slotCandidates.back.push(itemBonuses);
            } else if (equipmentType === '/equipment_types/charm') {
                slotCandidates.charm.push(itemBonuses);
            }
        }

        // Select best item per slot (highest item level, then highest enhancement level)
        const selectBest = (candidates) => {
            if (candidates.length === 0) return null;

            return candidates.reduce((best, current) => {
                // Compare by item level first
                if (current.itemLevel > best.itemLevel) return current;
                if (current.itemLevel < best.itemLevel) return best;

                // If item levels are equal, compare by enhancement level
                if (current.enhancementLevel > best.enhancementLevel) return current;
                return best;
            });
        };

        const bestTool = selectBest(slotCandidates.tool);
        const bestBody = selectBest(slotCandidates.body);
        const bestLegs = selectBest(slotCandidates.legs);
        const bestHands = selectBest(slotCandidates.hands);
        const bestNeck = selectBest(slotCandidates.neck);
        const bestRing = selectBest(slotCandidates.ring);
        const bestEarrings = selectBest(slotCandidates.earrings);
        const bestBack = selectBest(slotCandidates.back);
        const bestCharm = selectBest(slotCandidates.charm);

        // Add bonuses from best items in each slot
        const addSlot = (best) => {
            if (!best) return;
            gear.toolBonus += best.toolBonus;
            gear.speedBonus += best.speedBonus;
            gear.rareFindBonus += best.rareFindBonus;
            gear.experienceBonus += best.experienceBonus;
            gear.slotBreakdown.push({
                name: best.itemDetails.name,
                enhancementLevel: best.enhancementLevel,
                success: best.toolBonus,
                speed: best.speedBonus,
                rareFind: best.rareFindBonus,
                experience: best.experienceBonus,
            });
            return { name: best.itemDetails.name, enhancementLevel: best.enhancementLevel };
        };

        gear.toolSlot = addSlot(bestTool) || null;
        gear.bodySlot = addSlot(bestBody) || null;
        gear.legsSlot = addSlot(bestLegs) || null;
        gear.handsSlot = addSlot(bestHands) || null;
        addSlot(bestNeck);
        addSlot(bestRing);
        addSlot(bestEarrings);
        addSlot(bestBack);
        addSlot(bestCharm);

        return gear;
    }

    /**
     * Detect active enhancing teas from drink slots
     * @param {Array} drinkSlots - Active drink slots for enhancing action type
     * @param {Object} itemDetailMap - Item details map from init_client_data
     * @returns {Object} Active teas { enhancing, superEnhancing, ultraEnhancing, blessed }
     */
    function detectEnhancingTeas(drinkSlots, _itemDetailMap) {
        const teas = {
            enhancing: false, // Enhancing Tea (+3 levels)
            superEnhancing: false, // Super Enhancing Tea (+6 levels)
            ultraEnhancing: false, // Ultra Enhancing Tea (+8 levels)
            blessed: false, // Blessed Tea (1% double jump)
        };

        if (!drinkSlots || drinkSlots.length === 0) {
            return teas;
        }

        // Tea HRIDs to check for
        const teaMap = {
            '/items/enhancing_tea': 'enhancing',
            '/items/super_enhancing_tea': 'superEnhancing',
            '/items/ultra_enhancing_tea': 'ultraEnhancing',
            '/items/blessed_tea': 'blessed',
        };

        for (const drink of drinkSlots) {
            if (!drink || !drink.itemHrid) continue;

            const teaKey = teaMap[drink.itemHrid];
            if (teaKey) {
                teas[teaKey] = true;
            }
        }

        return teas;
    }

    /**
     * Get enhancing tea level bonus
     * @param {Object} teas - Active teas from detectEnhancingTeas()
     * @returns {number} Total level bonus from teas
     */
    function getEnhancingTeaLevelBonus(teas) {
        // Teas don't stack - highest one wins
        if (teas.ultraEnhancing) return 8;
        if (teas.superEnhancing) return 6;
        if (teas.enhancing) return 3;

        return 0;
    }

    /**
     * Get enhancing tea speed bonus (base, before concentration)
     * @param {Object} teas - Active teas from detectEnhancingTeas()
     * @returns {number} Base speed bonus % from teas
     */
    function getEnhancingTeaSpeedBonus(teas) {
        // Teas don't stack - highest one wins
        // Base speed bonuses (before drink concentration):
        if (teas.ultraEnhancing) return 6; // +6% base
        if (teas.superEnhancing) return 4; // +4% base
        if (teas.enhancing) return 2; // +2% base

        return 0;
    }

    /**
     * Backward-compatible wrapper for enhancing gear detection
     * @param {Map} equipment - Character equipment map (equipped items only)
     * @param {Object} itemDetailMap - Item details map from init_client_data
     * @returns {Object} Best enhancing gear per slot with bonuses
     */
    function detectEnhancingGear(equipment, itemDetailMap) {
        return detectSkillGear('enhancing', equipment, itemDetailMap);
    }

    var enhancementGearDetector = /*#__PURE__*/Object.freeze({
        __proto__: null,
        detectEnhancingGear: detectEnhancingGear,
        detectEnhancingTeas: detectEnhancingTeas,
        detectSkillGear: detectSkillGear,
        getEnhancingTeaLevelBonus: getEnhancingTeaLevelBonus,
        getEnhancingTeaSpeedBonus: getEnhancingTeaSpeedBonus
    });

    /**
     * Enhancement Configuration Manager
     *
     * Combines auto-detected enhancing parameters with manual overrides from settings.
     * Provides single source of truth for enhancement simulator inputs.
     */


    /**
     * Read Blessed Tea's double-jump chance out of the game's consumable data.
     * The number is a balance lever the game can move, so read it the same way the wisdom tea
     * bonus is read rather than freezing last patch's value into the source.
     * @param {Object} itemDetailMap - Item details map from init client data
     * @returns {number} Double-jump chance as a decimal (e.g. 0.01 for 1%)
     */
    function getBlessedTeaBonus(itemDetailMap) {
        const buffs = itemDetailMap?.['/items/blessed_tea']?.consumableDetail?.buffs;
        if (Array.isArray(buffs)) {
            const blessed = buffs.find((buff) => typeof buff?.typeHrid === 'string' && buff.typeHrid.includes('blessed'));
            if (blessed?.flatBoost > 0) {
                return blessed.flatBoost;
            }
        }
        return BLESSED_TEA_BASE_CHANCE;
    }

    /**
     * Get enhancing parameters (auto-detected or manual)
     *
     * Every surface that quotes what *this* character's enhancing will cost goes through here, so
     * the default has to be the character's own stats. The manual fields ship preloaded with a
     * professional enhancer's kit — level 140, a +13 celestial enhancer, ultra tea — and any field
     * still holding those shipped numbers is a field nobody chose, so it is answered from detection
     * instead. Only a field the player actually edited overrides what they really have.
     *
     * @returns {Object} Enhancement parameters for simulator, tagged with `paramsSource`
     *   ('auto' | 'manual') and `manualOverrides` (labels of edited fields)
     */
    function getEnhancingParams() {
        const autoDetect = config.getSettingValue('enhanceSim_autoDetect', false);

        if (autoDetect) {
            return getAutoDetectedParams();
        } else {
            return getManualParams();
        }
    }

    /**
     * The kit this script ships with: enhancing 140, a max Observatory, ultra and blessed tea, a
     * +13 Celestial enhancer and +10 enhancing gear. It is what the manual fields are preloaded
     * with, so the "pro rates" a surface quotes and the defaults the settings panel shows are one
     * definition rather than two that can drift.
     *
     * Character-wide facts that are not part of anybody's kit — the server's community buff level,
     * the item map's blessed tea chance — still come from live data, exactly as they do for the
     * player's own numbers.
     *
     * @returns {Object} Enhancement parameters for a top-end enhancer, tagged `paramsSource: 'pro'`
     */
    function getProRatesParams() {
        return getManualParams({ useShippedDefaults: true });
    }

    // Detection walks the loadout and the item map, and getEnhancingParams runs once per item
    // during a networth or inventory sweep. The character cannot re-gear between two items of the
    // same sweep, so the answer is held briefly instead of being rebuilt hundreds of times.
    const DETECTION_CACHE_MS = 1000;
    let _detectionCache = null;
    let _detectionCacheAt = 0;

    /**
     * Detected gear settings, memoised for a moment.
     * @returns {Object} Map of settingId → detected value
     */
    function getDetectedSettingsCached() {
        const now = Date.now();
        if (_detectionCache && now - _detectionCacheAt < DETECTION_CACHE_MS) {
            return _detectionCache;
        }

        _detectionCache = getDetectedGearSettings();
        _detectionCacheAt = now;
        return _detectionCache;
    }

    /**
     * Drop the memoised detection, so the next read re-inspects the character.
     * Exists for tests and for any caller that knows the loadout just changed.
     */
    function resetDetectedSettingsCache() {
        _detectionCache = null;
        _detectionCacheAt = 0;
    }

    /**
     * Compare two setting values, including the compound `{ enabled, tier, level }` gear objects.
     * @param {*} a - First value
     * @param {*} b - Second value
     * @returns {boolean} True when the two describe the same setting
     */
    function settingsEqual(a, b) {
        if (a === b) return true;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) {
            if (a[key] !== b[key]) return false;
        }
        return true;
    }

    /**
     * Describe where a set of enhancing parameters came from, for display next to a prediction.
     * @param {Object} params - Result of getEnhancingParams()
     * @returns {string|null} Short label when manual overrides are in play, otherwise null
     */
    function describeParamsSource(params) {
        const overrides = params?.manualOverrides;
        if (!Array.isArray(overrides) || overrides.length === 0) {
            return null;
        }

        const shown = overrides.slice(0, 3).join(', ');
        return overrides.length > 3 ? `manual params: ${shown} +${overrides.length - 3} more` : `manual params: ${shown}`;
    }

    /**
     * Get auto-detected enhancing parameters from character data
     * @returns {Object} Auto-detected parameters
     */
    function getAutoDetectedParams() {
        // The gear the character would be wearing to enhance, not whatever is on
        // them at this instant. Somebody in combat kit reading their enhancing
        // costs off a battleaxe gets a run nobody would ever make; the loadout is
        // what they actually enhance in. Skill-specific default first, then the
        // all-skills default, then anything saved, then what is worn.
        const { equipment, drinks: drinkSlots } = resolveActionContext('/action_types/enhancing');
        const skills = dataManager.getSkills();
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};

        // Detect gear from equipped items only
        const gear = detectEnhancingGear(equipment, itemDetailMap);

        // Detect drink concentration from equipment (Guzzling Pouch)
        // IMPORTANT: Only scan equipped items, not entire inventory
        let drinkConcentration = 0;
        const itemsToScan = equipment ? Array.from(equipment.values()).filter((item) => item && item.itemHrid) : [];

        for (const item of itemsToScan) {
            const itemDetails = itemDetailMap[item.itemHrid];
            if (!itemDetails?.equipmentDetail?.noncombatStats?.drinkConcentration) continue;

            const concentration = itemDetails.equipmentDetail.noncombatStats.drinkConcentration;
            const enhancementLevel = item.enhancementLevel || 0;
            const multiplier = getEnhancementMultiplier(itemDetails, enhancementLevel);
            const scaledConcentration = concentration * 100 * multiplier;

            // Only keep the highest concentration (shouldn't have multiple, but just in case)
            if (scaledConcentration > drinkConcentration) {
                drinkConcentration = scaledConcentration;
            }
        }

        // Detect teas
        const teas = detectEnhancingTeas(drinkSlots);

        // Get tea level bonus (base, then scale with concentration)
        const baseTeaLevel = getEnhancingTeaLevelBonus(teas);
        const teaLevelBonus = baseTeaLevel > 0 ? baseTeaLevel * (1 + drinkConcentration / 100) : 0;

        // Get tea speed bonus (base, then scale with concentration)
        const baseTeaSpeed = getEnhancingTeaSpeedBonus(teas);
        const teaSpeedBonus = baseTeaSpeed > 0 ? baseTeaSpeed * (1 + drinkConcentration / 100) : 0;

        // Get tea wisdom bonus (base, then scale with concentration)
        // Wisdom Tea/Coffee provide 12% wisdom, scales with drink concentration
        let baseTeaWisdom = 0;
        if (drinkSlots && drinkSlots.length > 0) {
            for (const drink of drinkSlots) {
                if (!drink || !drink.itemHrid) continue;
                const drinkDetails = itemDetailMap[drink.itemHrid];
                if (!drinkDetails?.consumableDetail?.buffs) continue;

                const wisdomBuff = drinkDetails.consumableDetail.buffs.find(
                    (buff) => buff.typeHrid === '/buff_types/wisdom'
                );

                if (wisdomBuff && wisdomBuff.flatBoost) {
                    baseTeaWisdom += wisdomBuff.flatBoost * 100; // Convert to percentage
                }
            }
        }
        const teaWisdomBonus = baseTeaWisdom > 0 ? baseTeaWisdom * (1 + drinkConcentration / 100) : 0;

        // Get Enhancing skill level
        const enhancingSkill = skills?.find((s) => s.skillHrid === '/skills/enhancing');
        if (!enhancingSkill) {
            console.error('[EnhancementConfig] Skill not found: /skills/enhancing');
        }
        const enhancingLevel = enhancingSkill?.level || 1;

        // Get Observatory house room level (enhancing uses observatory, NOT laboratory!)
        const houseLevel = dataManager.getHouseRoomLevel('/house_rooms/observatory');

        // Calculate global house buffs from ALL house rooms
        // Rare Find: 0.2% base + 0.2% per level (per room, only if level >= 1)
        // Wisdom: 0.05% base + 0.05% per level (per room, only if level >= 1)
        const houseRooms = dataManager.getHouseRooms();
        let houseRareFindBonus = 0;
        let houseWisdomBonus = 0;

        for (const [_hrid, room] of houseRooms) {
            const level = room.level || 0;
            if (level >= 1) {
                // Each room: 0.2% per level (NOT 0.2% base + 0.2% per level)
                houseRareFindBonus += 0.2 * level;
                // Each room: 0.05% per level (NOT 0.05% base + 0.05% per level)
                houseWisdomBonus += 0.05 * level;
            }
        }

        // Get Enhancing Speed community buff level
        const communityBuffLevel = dataManager.getCommunityBuffLevel('/community_buff_types/enhancing_speed');
        // Formula: 20% base + 0.5% per level
        const communitySpeedBonus = communityBuffLevel > 0 ? 20 + (communityBuffLevel - 1) * 0.5 : 0;

        // Get Experience (Wisdom) community buff level
        const communityWisdomLevel = dataManager.getCommunityBuffLevel('/community_buff_types/experience');
        // Formula: 20% base + 0.5% per level (same as other community buffs)
        const communityWisdomBonus = communityWisdomLevel > 0 ? 20 + (communityWisdomLevel - 1) * 0.5 : 0;

        const achievementWisdomBonus =
            dataManager.getAchievementBuffFlatBoost('/action_types/enhancing', '/buff_types/wisdom') * 100;
        const achievementRareFindBonus =
            dataManager.getAchievementBuffFlatBoost('/action_types/enhancing', '/buff_types/rare_find') * 100;

        // Calculate total success rate bonus
        // Equipment + house + achievement
        const houseSuccessBonus = houseLevel * 0.05; // 0.05% per level for success
        const equipmentSuccessBonus = gear.toolBonus;
        const achievementSuccessBonus =
            dataManager.getAchievementBuffRatioBoost('/action_types/enhancing', '/buff_types/enhancing_success') * 100;
        const totalSuccessBonus = equipmentSuccessBonus + houseSuccessBonus + achievementSuccessBonus;

        // Calculate total speed bonus
        // Speed bonus (from equipment) + house bonus (1% per level) + community buff + tea speed
        const houseSpeedBonus = houseLevel * 1.0; // 1% per level for action speed
        const totalSpeedBonus = gear.speedBonus + houseSpeedBonus + communitySpeedBonus + teaSpeedBonus;

        // Calculate total experience bonus
        // Equipment + house wisdom + tea wisdom + community wisdom + achievement wisdom
        const totalExperienceBonus =
            gear.experienceBonus + houseWisdomBonus + teaWisdomBonus + communityWisdomBonus + achievementWisdomBonus;

        // Calculate guzzling bonus multiplier (1.0 at level 0, scales with drink concentration)
        const guzzlingBonus = 1 + drinkConcentration / 100;

        return {
            // Core values for calculations
            enhancingLevel: enhancingLevel + teaLevelBonus, // Base level + tea bonus
            houseLevel: houseLevel,
            toolBonus: totalSuccessBonus, // Tool + house combined
            speedBonus: totalSpeedBonus, // Speed + house + community + tea combined
            rareFindBonus: gear.rareFindBonus + houseRareFindBonus + achievementRareFindBonus, // Rare find (equipment + house rooms + achievements)
            experienceBonus: totalExperienceBonus, // Experience (equipment + house + tea + community wisdom)
            guzzlingBonus: guzzlingBonus, // Drink concentration multiplier for blessed tea
            blessedTeaBonus: getBlessedTeaBonus(itemDetailMap), // Double-jump chance from item data
            teas: teas,

            // Display info (for UI) - show best item per slot
            toolSlot: gear.toolSlot,
            bodySlot: gear.bodySlot,
            legsSlot: gear.legsSlot,
            handsSlot: gear.handsSlot,
            detectedTeaBonus: teaLevelBonus,
            communityBuffLevel: communityBuffLevel, // For display (speed)
            communitySpeedBonus: communitySpeedBonus, // For display
            communityWisdomLevel: communityWisdomLevel, // For display
            communityWisdomBonus: communityWisdomBonus, // For display
            achievementWisdomBonus: achievementWisdomBonus, // For display
            teaSpeedBonus: teaSpeedBonus, // For display
            teaWisdomBonus: teaWisdomBonus, // For display
            drinkConcentration: drinkConcentration, // For display
            houseRareFindBonus: houseRareFindBonus, // For display
            achievementRareFindBonus: achievementRareFindBonus, // For display
            houseWisdomBonus: houseWisdomBonus, // For display
            equipmentRareFind: gear.rareFindBonus, // For display
            equipmentExperience: gear.experienceBonus, // For display
            equipmentSuccessBonus: equipmentSuccessBonus, // For display
            houseSuccessBonus: houseSuccessBonus, // For display
            achievementSuccessBonus: achievementSuccessBonus, // For display
            equipmentSpeedBonus: gear.speedBonus, // For display
            houseSpeedBonus: houseSpeedBonus, // For display
            slotBreakdown: gear.slotBreakdown || [], // Per-item breakdown for display
            paramsSource: 'auto', // Everything above came from this character
            manualOverrides: [], // Nothing was overridden
        };
    }

    /**
     * Detect current character's enhancing gear and return values mapped to setting keys.
     * Used by settings UI to populate gear inputs when auto-detect is toggled on.
     * @returns {Object} Map of settingId → detected value
     */
    function getDetectedGearSettings() {
        const { equipment, drinks: drinkSlots } = resolveActionContext('/action_types/enhancing');
        const skills = dataManager.getSkills();

        const result = {};

        // Enhancing level
        const enhancingSkill = skills?.find((s) => s.skillHrid === '/skills/enhancing');
        result.enhanceSim_enhancingLevel = enhancingSkill?.level || 1;

        // Observatory
        result.enhanceSim_houseLevel = dataManager.getHouseRoomLevel('/house_rooms/observatory');

        // Community buff
        const communityLevel = dataManager.getCommunityBuffLevel('/community_buff_types/enhancing_speed');
        result.enhanceSim_communityBuff = { enabled: true, level: communityLevel };

        // Achievement
        const achievementBonus = dataManager.getAchievementBuffRatioBoost(
            '/action_types/enhancing',
            '/buff_types/enhancing_success'
        );
        result.enhanceSim_achievement = achievementBonus > 0;

        // Tea detection
        const teaMap = {
            '/items/ultra_enhancing_tea': 'ultra',
            '/items/super_enhancing_tea': 'super',
            '/items/enhancing_tea': 'basic',
        };
        let detectedTea = 'none';
        let hasBlessed = false;
        if (drinkSlots) {
            for (const drink of drinkSlots) {
                if (!drink?.itemHrid) continue;
                if (teaMap[drink.itemHrid]) detectedTea = teaMap[drink.itemHrid];
                if (drink.itemHrid === '/items/blessed_tea') hasBlessed = true;
            }
        }
        result.enhanceSim_tea = detectedTea;
        result.enhanceSim_blessedTea = hasBlessed;

        // Gear detection — match equipped items to known gear HRIDs
        const ENHANCER_HRIDS = {
            '/items/cheese_enhancer': 'cheese',
            '/items/verdant_enhancer': 'verdant',
            '/items/azure_enhancer': 'azure',
            '/items/burble_enhancer': 'burble',
            '/items/crimson_enhancer': 'crimson',
            '/items/rainbow_enhancer': 'rainbow',
            '/items/holy_enhancer': 'holy',
            '/items/celestial_enhancer': 'celestial',
        };
        const CAPE_HRIDS = {
            '/items/chance_cape': 'normal',
            '/items/chance_cape_refined': 'refined',
        };
        const CHARM_HRIDS = {
            '/items/trainee_enhancing_charm': 'trainee',
            '/items/basic_enhancing_charm': 'basic',
            '/items/advanced_enhancing_charm': 'advanced',
            '/items/expert_enhancing_charm': 'expert',
            '/items/master_enhancing_charm': 'master',
            '/items/grandmaster_enhancing_charm': 'grandmaster',
        };
        const FIXED_HRIDS = {
            '/items/enchanted_gloves': 'gloves',
            '/items/enhancers_top': 'top',
            '/items/enhancers_bottoms': 'bottoms',
            '/items/guzzling_pouch': 'guzzling',
        };
        const NECK_HRIDS = {
            '/items/philosophers_necklace': 'philo',
            '/items/necklace_of_speed': 'speed',
        };
        const RING_HRIDS = {
            '/items/philosophers_ring': 'philo',
            '/items/ring_of_rare_find': 'rarefind',
        };
        const EARRING_HRIDS = {
            '/items/philosophers_earrings': 'philo',
            '/items/earrings_of_rare_find': 'rarefind',
        };

        // Default all gear to disabled (not detected)
        result.enhanceSim_gear_enhancer = { enabled: false, tier: 'celestial', level: 0 };
        result.enhanceSim_gear_gloves = { enabled: false, level: 0 };
        result.enhanceSim_gear_top = { enabled: false, level: 0 };
        result.enhanceSim_gear_bottoms = { enabled: false, level: 0 };
        result.enhanceSim_gear_neck = { enabled: false, tier: 'philo', level: 0 };
        result.enhanceSim_gear_ring = { enabled: false, tier: 'philo', level: 0 };
        result.enhanceSim_gear_earring = { enabled: false, tier: 'philo', level: 0 };
        result.enhanceSim_gear_cape = { enabled: false, tier: 'normal', level: 0 };
        result.enhanceSim_gear_guzzling = { enabled: false, level: 0 };
        result.enhanceSim_gear_charm = { enabled: false, tier: 'grandmaster', level: 0 };

        if (equipment) {
            for (const item of equipment.values()) {
                if (!item?.itemHrid) continue;
                const hrid = item.itemHrid;
                const enhLevel = item.enhancementLevel || 0;

                if (ENHANCER_HRIDS[hrid]) {
                    result.enhanceSim_gear_enhancer = { enabled: true, tier: ENHANCER_HRIDS[hrid], level: enhLevel };
                } else if (CAPE_HRIDS[hrid]) {
                    result.enhanceSim_gear_cape = { enabled: true, tier: CAPE_HRIDS[hrid], level: enhLevel };
                } else if (CHARM_HRIDS[hrid]) {
                    result.enhanceSim_gear_charm = { enabled: true, tier: CHARM_HRIDS[hrid], level: enhLevel };
                } else if (NECK_HRIDS[hrid]) {
                    result.enhanceSim_gear_neck = { enabled: true, tier: NECK_HRIDS[hrid], level: enhLevel };
                } else if (RING_HRIDS[hrid]) {
                    result.enhanceSim_gear_ring = { enabled: true, tier: RING_HRIDS[hrid], level: enhLevel };
                } else if (EARRING_HRIDS[hrid]) {
                    result.enhanceSim_gear_earring = { enabled: true, tier: EARRING_HRIDS[hrid], level: enhLevel };
                } else if (FIXED_HRIDS[hrid]) {
                    const slot = FIXED_HRIDS[hrid];
                    result[`enhanceSim_gear_${slot}`] = { enabled: true, level: enhLevel };
                }
            }
        }

        return result;
    }

    /**
     * Get manual enhancing parameters from gear-based config settings
     * @param {Object} [options] - Options
     * @param {boolean} [options.useShippedDefaults=false] - Answer every field with the value it
     *   ships with, ignoring both what the player saved and what the character has. This is the
     *   "pro rates" run: a fixed, top-end kit nobody's gear can change.
     * @returns {Object} Manual parameters
     */
    function getManualParams({ useShippedDefaults = false } = {}) {
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};

        // What this character actually has. Used to fill in every manual field the player never
        // touched, so an untouched panel quotes their own run rather than a stranger's.
        let detectedSettings = {};
        try {
            // With no character loaded there is nothing to detect, and "detected" would read as
            // "owns nothing" — worse than the shipped defaults. Fall back to those instead.
            // A pro-rates run answers from the shipped kit throughout, so it never asks.
            if (!useShippedDefaults && dataManager.getSkills()?.length) {
                detectedSettings = getDetectedSettingsCached();
            }
        } catch (error) {
            console.error('[EnhancementConfig] Gear detection failed, using saved settings:', error);
        }

        const manualOverrides = [];

        /**
         * Read a manual setting.
         * @param {string} key - Setting id
         * @param {*} shippedDefault - The value this field ships with
         * @param {string} [label] - Human name, listed when the field overrides detection
         * @returns {*} The value to simulate with
         */
        const readSetting = (key, shippedDefault, label) => {
            // Pro rates are the shipped kit itself, so nothing the player saved or wears applies
            if (useShippedDefaults) {
                return shippedDefault;
            }

            const stored = config.getSettingValue(key, shippedDefault);
            const detectedValue = detectedSettings[key];

            if (detectedValue === undefined) {
                return stored;
            }
            // Untouched shipped default: nobody chose this, so answer from the character
            if (settingsEqual(stored, shippedDefault)) {
                return detectedValue;
            }
            if (label && !settingsEqual(stored, detectedValue)) {
                manualOverrides.push(label);
            }
            return stored;
        };

        const getValue = readSetting;

        // --- ENHANCING ---
        const houseLevel = getValue('enhanceSim_houseLevel', 8, 'Observatory level');
        const baseEnhancingLevel = getValue('enhanceSim_enhancingLevel', 140, 'Enhancing level');

        // --- TEA ---
        const teaSelection = getValue('enhanceSim_tea', 'ultra', 'Tea');
        const teas = {
            enhancing: teaSelection === 'basic',
            superEnhancing: teaSelection === 'super',
            ultraEnhancing: teaSelection === 'ultra',
            blessed: getValue('enhanceSim_blessedTea', true, 'Blessed tea'),
        };
        const teaLevelBonus =
            teaSelection === 'ultra' ? 8 : teaSelection === 'super' ? 6 : teaSelection === 'basic' ? 3 : 0;
        const teaSpeedBonus =
            teaSelection === 'ultra' ? 6 : teaSelection === 'super' ? 4 : teaSelection === 'basic' ? 2 : 0;

        // --- GEAR ---
        const ENHANCER_TIERS = {
            cheese: '/items/cheese_enhancer',
            verdant: '/items/verdant_enhancer',
            azure: '/items/azure_enhancer',
            burble: '/items/burble_enhancer',
            crimson: '/items/crimson_enhancer',
            rainbow: '/items/rainbow_enhancer',
            holy: '/items/holy_enhancer',
            celestial: '/items/celestial_enhancer',
        };
        const CAPE_TIERS = {
            normal: '/items/chance_cape',
            refined: '/items/chance_cape_refined',
        };
        const CHARM_TIERS = {
            trainee: '/items/trainee_enhancing_charm',
            basic: '/items/basic_enhancing_charm',
            advanced: '/items/advanced_enhancing_charm',
            expert: '/items/expert_enhancing_charm',
            master: '/items/master_enhancing_charm',
            grandmaster: '/items/grandmaster_enhancing_charm',
        };
        const FIXED_GEAR = {
            gloves: '/items/enchanted_gloves',
            top: '/items/enhancers_top',
            bottoms: '/items/enhancers_bottoms',
            guzzling: '/items/guzzling_pouch',
        };
        const NECK_TIERS = {
            philo: '/items/philosophers_necklace',
            speed: '/items/necklace_of_speed',
        };
        const RING_TIERS = {
            philo: '/items/philosophers_ring',
            rarefind: '/items/ring_of_rare_find',
        };
        const EARRING_TIERS = {
            philo: '/items/philosophers_earrings',
            rarefind: '/items/earrings_of_rare_find',
        };

        // Helper to read compound gear setting
        const getGear = (key, defaults, label) => {
            const val = readSetting(key, defaults, label);
            // Handle both object (new format) and missing/null
            if (val && typeof val === 'object') return val;
            return defaults;
        };

        // Calculate bonuses from each gear slot
        let equipmentSuccessBonus = 0;
        let equipmentSpeedBonus = 0;
        let equipmentRareFind = 0;
        let equipmentExperience = 0;
        let drinkConcentration = 0;
        const slotBreakdown = [];

        // Enhancer
        const enhancer = getGear('enhanceSim_gear_enhancer', { enabled: true, tier: 'celestial', level: 13 }, 'Enhancer');
        if (enhancer.enabled) {
            const hrid = ENHANCER_TIERS[enhancer.tier] || ENHANCER_TIERS.celestial;
            const bonus = getGearSlotBonus(hrid, enhancer.level, itemDetailMap);
            equipmentSuccessBonus += bonus.success;
            equipmentSpeedBonus += bonus.speed;
            equipmentRareFind += bonus.rareFind;
            equipmentExperience += bonus.experience;
            const details = itemDetailMap[hrid];
            slotBreakdown.push({
                name: details?.name || 'Enhancer',
                enhancementLevel: enhancer.level,
                success: bonus.success,
                speed: bonus.speed,
                rareFind: bonus.rareFind,
                experience: bonus.experience,
            });
        }

        // Gloves
        const gloves = getGear('enhanceSim_gear_gloves', { enabled: true, level: 10 }, 'Gloves');
        if (gloves.enabled) {
            const bonus = getGearSlotBonus(FIXED_GEAR.gloves, gloves.level, itemDetailMap);
            equipmentSpeedBonus += bonus.speed;
            equipmentExperience += bonus.experience;
            const details = itemDetailMap[FIXED_GEAR.gloves];
            slotBreakdown.push({
                name: details?.name || 'Gloves',
                enhancementLevel: gloves.level,
                success: 0,
                speed: bonus.speed,
                rareFind: 0,
                experience: bonus.experience,
            });
        }

        // Top
        const top = getGear('enhanceSim_gear_top', { enabled: true, level: 10 }, 'Top');
        if (top.enabled) {
            const bonus = getGearSlotBonus(FIXED_GEAR.top, top.level, itemDetailMap);
            equipmentSpeedBonus += bonus.speed;
            equipmentRareFind += bonus.rareFind;
            equipmentExperience += bonus.experience;
            const details = itemDetailMap[FIXED_GEAR.top];
            slotBreakdown.push({
                name: details?.name || 'Top',
                enhancementLevel: top.level,
                success: 0,
                speed: bonus.speed,
                rareFind: bonus.rareFind,
                experience: bonus.experience,
            });
        }

        // Bottoms
        const bottoms = getGear('enhanceSim_gear_bottoms', { enabled: true, level: 10 }, 'Bottoms');
        if (bottoms.enabled) {
            const bonus = getGearSlotBonus(FIXED_GEAR.bottoms, bottoms.level, itemDetailMap);
            equipmentSpeedBonus += bonus.speed;
            equipmentExperience += bonus.experience;
            const details = itemDetailMap[FIXED_GEAR.bottoms];
            slotBreakdown.push({
                name: details?.name || 'Bottoms',
                enhancementLevel: bottoms.level,
                success: 0,
                speed: bonus.speed,
                rareFind: 0,
                experience: bonus.experience,
            });
        }

        // Neck
        const neck = getGear('enhanceSim_gear_neck', { enabled: true, tier: 'philo', level: 10 }, 'Necklace');
        if (neck.enabled) {
            const hrid = NECK_TIERS[neck.tier] || NECK_TIERS.philo;
            const bonus = getGearSlotBonus(hrid, neck.level, itemDetailMap);
            equipmentSuccessBonus += bonus.success;
            equipmentSpeedBonus += bonus.speed;
            equipmentRareFind += bonus.rareFind;
            equipmentExperience += bonus.experience;
            const details = itemDetailMap[hrid];
            slotBreakdown.push({
                name: details?.name || 'Necklace',
                enhancementLevel: neck.level,
                success: bonus.success,
                speed: bonus.speed,
                rareFind: bonus.rareFind,
                experience: bonus.experience,
            });
        }

        // Ring
        const ring = getGear('enhanceSim_gear_ring', { enabled: true, tier: 'philo', level: 10 }, 'Ring');
        if (ring.enabled) {
            const hrid = RING_TIERS[ring.tier] || RING_TIERS.philo;
            const bonus = getGearSlotBonus(hrid, ring.level, itemDetailMap);
            equipmentSuccessBonus += bonus.success;
            equipmentSpeedBonus += bonus.speed;
            equipmentRareFind += bonus.rareFind;
            equipmentExperience += bonus.experience;
            const details = itemDetailMap[hrid];
            slotBreakdown.push({
                name: details?.name || 'Ring',
                enhancementLevel: ring.level,
                success: bonus.success,
                speed: bonus.speed,
                rareFind: bonus.rareFind,
                experience: bonus.experience,
            });
        }

        // Earring
        const earring = getGear('enhanceSim_gear_earring', { enabled: true, tier: 'philo', level: 10 }, 'Earrings');
        if (earring.enabled) {
            const hrid = EARRING_TIERS[earring.tier] || EARRING_TIERS.philo;
            const bonus = getGearSlotBonus(hrid, earring.level, itemDetailMap);
            equipmentSuccessBonus += bonus.success;
            equipmentSpeedBonus += bonus.speed;
            equipmentRareFind += bonus.rareFind;
            equipmentExperience += bonus.experience;
            const details = itemDetailMap[hrid];
            slotBreakdown.push({
                name: details?.name || 'Earrings',
                enhancementLevel: earring.level,
                success: bonus.success,
                speed: bonus.speed,
                rareFind: bonus.rareFind,
                experience: bonus.experience,
            });
        }

        // Cape
        const cape = getGear('enhanceSim_gear_cape', { enabled: true, tier: 'normal', level: 5 }, 'Cape');
        if (cape.enabled) {
            const hrid = CAPE_TIERS[cape.tier] || CAPE_TIERS.normal;
            const bonus = getGearSlotBonus(hrid, cape.level, itemDetailMap);
            equipmentSuccessBonus += bonus.success;
            equipmentSpeedBonus += bonus.speed;
            equipmentRareFind += bonus.rareFind;
            equipmentExperience += bonus.experience;
            const details = itemDetailMap[hrid];
            slotBreakdown.push({
                name: details?.name || 'Cape',
                enhancementLevel: cape.level,
                success: bonus.success,
                speed: bonus.speed,
                rareFind: bonus.rareFind,
                experience: bonus.experience,
            });
        }

        // Guzzling Pouch (provides drink concentration)
        const guzzling = getGear('enhanceSim_gear_guzzling', { enabled: true, level: 10 }, 'Guzzling Pouch');
        if (guzzling.enabled) {
            const bonus = getGearSlotBonus(FIXED_GEAR.guzzling, guzzling.level, itemDetailMap);
            drinkConcentration = bonus.drinkConc;
        }

        // Charm (provides experience/wisdom bonus)
        const charm = getGear('enhanceSim_gear_charm', { enabled: true, tier: 'grandmaster', level: 0 }, 'Charm');
        if (charm.enabled) {
            const hrid = CHARM_TIERS[charm.tier] || CHARM_TIERS.grandmaster;
            const bonus = getGearSlotBonus(hrid, charm.level, itemDetailMap);
            equipmentSuccessBonus += bonus.success;
            equipmentSpeedBonus += bonus.speed;
            equipmentRareFind += bonus.rareFind;
            equipmentExperience += bonus.experience;
            const details = itemDetailMap[hrid];
            slotBreakdown.push({
                name: details?.name || 'Charm',
                enhancementLevel: charm.level,
                success: bonus.success,
                speed: bonus.speed,
                rareFind: bonus.rareFind,
                experience: bonus.experience,
            });
        }

        // --- COMMUNITY BUFF ---
        const communityBuff = getGear('enhanceSim_communityBuff', { enabled: true, level: 1 }, 'Community buff');
        let communityBuffLevel;
        if (communityBuff.enabled) {
            // Checked = auto-detect from game
            communityBuffLevel = dataManager.getCommunityBuffLevel('/community_buff_types/enhancing_speed');
        } else {
            communityBuffLevel = communityBuff.level;
        }
        const communitySpeedBonus = communityBuffLevel > 0 ? 20 + (communityBuffLevel - 1) * 0.5 : 0;

        // --- ACHIEVEMENT ---
        // The toggle only says whether to count the achievement buff; how big it is comes from the
        // character's own data, the same source auto-detect reads, so the two modes cannot drift.
        const achievementEnabled = getValue('enhanceSim_achievement', false, 'Achievement');
        const achievementSuccessBonus = achievementEnabled
            ? dataManager.getAchievementBuffRatioBoost('/action_types/enhancing', '/buff_types/enhancing_success') * 100
            : 0;

        // --- HOUSE BONUSES ---
        const houseSpeedBonus = houseLevel * 1.0;
        const houseSuccessBonus = houseLevel * 0.05;

        // House wisdom: 0.05% per level per room (same as auto-detect)
        const houseRooms = dataManager.getHouseRooms();
        let houseWisdomBonus = 0;
        for (const [_hrid, room] of houseRooms) {
            const level = room.level || 0;
            if (level >= 1) {
                houseWisdomBonus += 0.05 * level;
            }
        }

        // --- SCALE TEA BONUSES WITH DRINK CONCENTRATION ---
        const scaledTeaLevelBonus = teaLevelBonus > 0 ? teaLevelBonus * (1 + drinkConcentration / 100) : 0;
        const scaledTeaSpeedBonus = teaSpeedBonus > 0 ? teaSpeedBonus * (1 + drinkConcentration / 100) : 0;

        // Tea wisdom bonus (Wisdom Tea/Coffee provide 12% wisdom, scales with drink concentration)
        let baseTeaWisdom = 0;
        const drinkSlots = dataManager.getActionDrinkSlots('/action_types/enhancing');
        if (drinkSlots && drinkSlots.length > 0) {
            for (const drink of drinkSlots) {
                if (!drink || !drink.itemHrid) continue;
                const drinkDetails = itemDetailMap[drink.itemHrid];
                if (!drinkDetails?.consumableDetail?.buffs) continue;
                const wisdomBuff = drinkDetails.consumableDetail.buffs.find(
                    (buff) => buff.typeHrid === '/buff_types/wisdom'
                );
                if (wisdomBuff && wisdomBuff.flatBoost) {
                    baseTeaWisdom += wisdomBuff.flatBoost * 100;
                }
            }
        }
        const teaWisdomBonus = baseTeaWisdom > 0 ? baseTeaWisdom * (1 + drinkConcentration / 100) : 0;

        // Community wisdom buff
        const communityWisdomLevel = dataManager.getCommunityBuffLevel('/community_buff_types/experience');
        const communityWisdomBonus = communityWisdomLevel > 0 ? 20 + (communityWisdomLevel - 1) * 0.5 : 0;

        // Achievement wisdom buff
        const achievementWisdomBonus =
            dataManager.getAchievementBuffFlatBoost('/action_types/enhancing', '/buff_types/wisdom') * 100;

        // --- TOTALS ---
        const totalToolBonus = equipmentSuccessBonus + houseSuccessBonus + achievementSuccessBonus;
        const totalSpeedBonus = equipmentSpeedBonus + houseSpeedBonus + communitySpeedBonus + scaledTeaSpeedBonus;
        const totalExperienceBonus =
            equipmentExperience + houseWisdomBonus + teaWisdomBonus + communityWisdomBonus + achievementWisdomBonus;
        const guzzlingBonus = 1 + drinkConcentration / 100;

        return {
            enhancingLevel: baseEnhancingLevel + scaledTeaLevelBonus,
            houseLevel: houseLevel,
            toolBonus: totalToolBonus,
            speedBonus: totalSpeedBonus,
            rareFindBonus: equipmentRareFind,
            experienceBonus: totalExperienceBonus,
            guzzlingBonus: guzzlingBonus,
            blessedTeaBonus: getBlessedTeaBonus(itemDetailMap), // Double-jump chance from item data
            teas: teas,

            // Display info for manual mode
            toolSlot: null,
            bodySlot: null,
            legsSlot: null,
            handsSlot: null,
            detectedTeaBonus: scaledTeaLevelBonus,
            communityBuffLevel: communityBuffLevel,
            communitySpeedBonus: communitySpeedBonus,
            teaSpeedBonus: scaledTeaSpeedBonus,
            equipmentSpeedBonus: equipmentSpeedBonus,
            houseSpeedBonus: houseSpeedBonus,
            equipmentSuccessBonus: equipmentSuccessBonus,
            houseSuccessBonus: houseSuccessBonus,
            achievementSuccessBonus: achievementSuccessBonus,
            slotBreakdown: slotBreakdown,
            // Fields left at their shipped values were answered from detection, so a run with no
            // edited fields is an auto-detected run no matter what the toggle says
            paramsSource: useShippedDefaults ? 'pro' : manualOverrides.length > 0 ? 'manual' : 'auto',
            manualOverrides,
        };
    }

    /**
     * Calculate enhancing bonuses from a single gear slot
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level (0-20)
     * @param {Object} itemDetailMap - Item details map
     * @returns {Object} { success, speed, rareFind, experience, drinkConc }
     */
    function getGearSlotBonus(itemHrid, enhancementLevel, itemDetailMap) {
        const itemDetails = itemDetailMap[itemHrid];
        if (!itemDetails) return { success: 0, speed: 0, rareFind: 0, experience: 0, drinkConc: 0 };

        const multiplier = getEnhancementMultiplier(itemDetails, enhancementLevel);
        const stats = itemDetails.equipmentDetail?.noncombatStats || {};

        return {
            success: (stats.enhancingSuccess || 0) * 100 * multiplier,
            speed: ((stats.enhancingSpeed || 0) + (stats.skillingSpeed || 0)) * 100 * multiplier,
            rareFind: ((stats.enhancingRareFind || 0) + (stats.skillingRareFind || 0)) * 100 * multiplier,
            experience: ((stats.enhancingExperience || 0) + (stats.skillingExperience || 0)) * 100 * multiplier,
            drinkConc: (stats.drinkConcentration || 0) * 100 * multiplier,
        };
    }

    var enhancementConfig = /*#__PURE__*/Object.freeze({
        __proto__: null,
        describeParamsSource: describeParamsSource,
        getAutoDetectedParams: getAutoDetectedParams,
        getBlessedTeaBonus: getBlessedTeaBonus,
        getDetectedGearSettings: getDetectedGearSettings,
        getEnhancingParams: getEnhancingParams,
        getProRatesParams: getProRatesParams,
        resetDetectedSettingsCache: resetDetectedSettingsCache
    });

    /**
     * Enhancement Tooltip Module
     *
     * Provides enhancement analysis for item tooltips.
     * Calculates optimal enhancement path and total costs for reaching current enhancement level.
     *
     * This module is part of Phase 2 of Option D (Hybrid Approach):
     * - Enhancement panel: Shows 20-level enhancement table
     * - Item tooltips: Shows optimal path to reach current enhancement level
     */


    const _costCache = new Map();
    const _chainTimeCache = new Map();

    marketAPI.on(() => {
        _costCache.clear();
        _chainTimeCache.clear();
    });

    /**
     * Calculate production cost from crafting recipe
     * Matches original MWI Tools v25.0 getBaseItemProductionCost logic
     * @param {string} itemHrid
     * @param {'ask'|'bid'} [mode='ask'] - Pricing side to use for input materials
     * @private
     */
    function getProductionCost(itemHrid, mode = 'ask') {
        const cacheKey = `${itemHrid}|${mode}`;
        if (_costCache.has(cacheKey)) return _costCache.get(cacheKey);
        const result = _computeProductionCost(itemHrid, mode);
        _costCache.set(cacheKey, result);
        return result;
    }

    function _computeProductionCost(itemHrid, mode = 'ask') {
        const gameData = dataManager.getInitClientData();
        const itemDetails = gameData.itemDetailMap[itemHrid];

        if (!itemDetails || !itemDetails.name) {
            return 0;
        }

        // Find the action that produces this item
        let actionHrid = null;
        let outputCount = 1;
        for (const [hrid, action] of Object.entries(gameData.actionDetailMap)) {
            if (action.outputItems && action.outputItems.length > 0) {
                const output = action.outputItems[0];
                if (output.itemHrid === itemHrid) {
                    actionHrid = hrid;
                    outputCount = output.count || 1;
                    break;
                }
            }
        }

        if (!actionHrid) {
            return 0;
        }

        const action = gameData.actionDetailMap[actionHrid];
        let totalPrice = 0;

        // Compute artisan tea reduction dynamically (same approach as material-calculator.js)
        let artisanBonus = 0;
        try {
            const equipment = dataManager.getEquipment();
            const itemDetailMap = gameData.itemDetailMap || {};
            const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
            const activeDrinks = dataManager.getActionDrinkSlots(action.type);
            artisanBonus = parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);
        } catch {
            // Fall back to no reduction if data unavailable
        }

        // Sum up input material costs (artisan tea reduces material quantities, not upgrade items)
        if (action.inputItems) {
            for (const input of action.inputItems) {
                if (input.itemHrid === '/items/coin') {
                    totalPrice += input.count * (1 - artisanBonus);
                    continue;
                }
                let inputPrice = getItemPrice(input.itemHrid, { mode }) || 0;
                if (inputPrice === 0) {
                    inputPrice = getProductionCost(input.itemHrid, mode);
                }
                totalPrice += inputPrice * input.count * (1 - artisanBonus);
            }
        }

        // Add upgrade item cost if this is an upgrade recipe (not affected by artisan tea)
        // Use min(market, craft) so refined items reflect the cheapest way to obtain the base item
        if (action.upgradeItemHrid) {
            const upgradeMarketPrice = getItemPrice(action.upgradeItemHrid, { mode }) || 0;
            const upgradeCraftPrice = getProductionCost(action.upgradeItemHrid, mode);
            let upgradePrice;
            if (upgradeMarketPrice > 0 && upgradeCraftPrice > 0) {
                upgradePrice = Math.min(upgradeMarketPrice, upgradeCraftPrice);
            } else {
                upgradePrice = upgradeMarketPrice || upgradeCraftPrice;
            }
            totalPrice += upgradePrice;
        }

        return totalPrice / outputCount;
    }

    /**
     * Profit Calculation Helpers
     * Pure functions for profit/rate calculations used across features
     *
     * These functions consolidate duplicated calculations from:
     * - profit-calculator.js
     * - gathering-profit.js
     * - task-profit-calculator.js
     * - action-time-display.js
     * - tooltip-prices.js
     */


    /**
     * Calculate actions per hour from action time
     * @param {number} actionTimeSeconds - Time per action in seconds
     * @returns {number} Actions per hour (0 if invalid input)
     *
     * @example
     * calculateActionsPerHour(6) // Returns 600 (3600 / 6)
     * calculateActionsPerHour(0) // Returns 0 (invalid)
     */
    function calculateActionsPerHour(actionTimeSeconds) {
        if (!actionTimeSeconds || actionTimeSeconds <= 0) {
            return 0;
        }
        return SECONDS_PER_HOUR / Math.max(MIN_ACTION_TIME_SECONDS, actionTimeSeconds);
    }

    /**
     * Calculate effective actions per hour after efficiency
     * @param {number} actionsPerHour - Base actions per hour (without efficiency)
     * @param {number} [efficiencyMultiplier=1] - Efficiency multiplier (1 + efficiencyPercent/100)
     * @returns {number} Effective actions per hour (0 if invalid input)
     *
     * @example
     * calculateEffectiveActionsPerHour(600, 1.2) // Returns 720
     */
    function calculateEffectiveActionsPerHour(actionsPerHour, efficiencyMultiplier = 1) {
        if (!actionsPerHour || actionsPerHour <= 0) {
            return 0;
        }
        if (!efficiencyMultiplier || efficiencyMultiplier <= 0) {
            return 0;
        }
        return actionsPerHour * efficiencyMultiplier;
    }

    /**
     * Calculate hours needed for a number of actions
     * @param {number} actionCount - Number of queued actions
     * @param {number} actionsPerHour - Actions per hour rate
     * @returns {number} Hours needed (0 if invalid input)
     *
     * @example
     * calculateHoursForActions(600, 600) // Returns 1
     * calculateHoursForActions(1200, 600) // Returns 2
     */
    function calculateHoursForActions(actionCount, actionsPerHour) {
        if (!actionsPerHour || actionsPerHour <= 0) {
            return 0;
        }
        return actionCount / actionsPerHour;
    }

    /**
     * Calculate seconds needed for a number of actions
     * @param {number} actionCount - Number of queued actions
     * @param {number} actionsPerHour - Actions per hour rate
     * @returns {number} Seconds needed (0 if invalid input)
     *
     * @example
     * calculateSecondsForActions(100, 600) // Returns 600 (100/600 * 3600)
     */
    function calculateSecondsForActions(actionCount, actionsPerHour) {
        return calculateHoursForActions(actionCount, actionsPerHour) * SECONDS_PER_HOUR;
    }

    /**
     * Calculate profit per action from hourly profit data
     *
     * IMPORTANT: This assumes profitPerHour already includes efficiency.
     * The formula works because:
     * - profitPerHour = actionsPerHour × efficiencyMultiplier × profitPerItem
     * - profitPerHour / actionsPerHour = efficiencyMultiplier × profitPerItem
     * - This gives profit per ATTEMPT (what the queue shows)
     *
     * @param {number} profitPerHour - Profit per hour (includes efficiency)
     * @param {number} actionsPerHour - Base actions per hour (without efficiency)
     * @returns {number} Profit per action (0 if invalid input)
     *
     * @example
     * // With 150% efficiency (2.5x), 600 actions/hr, 50 profit/item:
     * // profitPerHour = 600 × 2.5 × 50 = 75,000
     * calculateProfitPerAction(75000, 600) // Returns 125 (profit per action)
     */
    function calculateProfitPerAction(profitPerHour, actionsPerHour) {
        if (!actionsPerHour || actionsPerHour <= 0) {
            return 0;
        }
        return profitPerHour / actionsPerHour;
    }

    /**
     * Calculate total profit for a number of actions
     *
     * @param {number} profitPerHour - Profit per hour (includes efficiency)
     * @param {number} actionsPerHour - Base actions per hour (without efficiency)
     * @param {number} actionCount - Number of queued actions
     * @returns {number} Total profit (0 if invalid input)
     *
     * @example
     * // Queue shows "Produce 100 times" with 75,000 profit/hr and 600 actions/hr
     * calculateTotalProfitForActions(75000, 600, 100) // Returns 12,500
     */
    function calculateTotalProfitForActions(profitPerHour, actionsPerHour, actionCount) {
        const profitPerAction = calculateProfitPerAction(profitPerHour, actionsPerHour);
        return profitPerAction * actionCount;
    }

    /**
     * Calculate profit per day from hourly profit
     * @param {number} profitPerHour - Profit per hour
     * @returns {number} Profit per day
     *
     * @example
     * calculateProfitPerDay(10000) // Returns 240,000
     */
    function calculateProfitPerDay(profitPerHour) {
        return profitPerHour * HOURS_PER_DAY;
    }

    /**
     * Calculate drink consumption rate with Drink Concentration
     * @param {number} drinkConcentration - Drink Concentration stat as decimal (e.g., 0.15 for 15%)
     * @returns {number} Drinks consumed per hour
     *
     * @example
     * calculateDrinksPerHour(0)    // Returns 12 (base rate)
     * calculateDrinksPerHour(0.15) // Returns 13.8 (12 × 1.15)
     */
    function calculateDrinksPerHour(drinkConcentration = 0) {
        return DRINKS_PER_HOUR_BASE * (1 + drinkConcentration);
    }

    /**
     * Calculate tea consumption costs per hour
     * @param {Object} params - Tea cost inputs
     * @param {Array} params.drinkSlots - Equipped drink slots
     * @param {number} params.drinkConcentration - Drink Concentration stat as decimal
     * @param {Object} params.itemDetailMap - Item detail map for names
     * @param {Function} params.getItemPrice - Price resolver function
     * @returns {Object} Tea costs breakdown
     */
    function calculateTeaCostsPerHour({
        drinkSlots = [],
        drinkConcentration = 0,
        itemDetailMap = {},
        getItemPrice,
    }) {
        if (!Array.isArray(drinkSlots) || drinkSlots.length === 0) {
            return {
                costs: [],
                totalCostPerHour: 0,
                hasMissingPrices: false,
                drinksPerHour: calculateDrinksPerHour(drinkConcentration),
            };
        }

        const drinksPerHour = calculateDrinksPerHour(drinkConcentration);

        const costs = drinkSlots.reduce((entries, drink) => {
            if (!drink || !drink.itemHrid) {
                return entries;
            }

            const itemDetails = itemDetailMap[drink.itemHrid];
            const itemName = itemDetails?.name || 'Unknown';
            const price =
                typeof getItemPrice === 'function'
                    ? getItemPrice(drink.itemHrid, { context: 'profit', side: 'buy' })
                    : null;
            const isPriceMissing = price === null;
            const resolvedPrice = isPriceMissing ? 0 : price;
            const totalCost = resolvedPrice * drinksPerHour;

            entries.push({
                itemHrid: drink.itemHrid,
                itemName,
                pricePerDrink: resolvedPrice,
                drinksPerHour,
                totalCost,
                missingPrice: isPriceMissing,
            });

            return entries;
        }, []);

        const totalCostPerHour = costs.reduce((sum, entry) => sum + entry.totalCost, 0);
        const hasMissingPrices = costs.some((entry) => entry.missingPrice);

        return {
            costs,
            totalCostPerHour,
            hasMissingPrices,
            drinksPerHour,
        };
    }

    /**
     * Calculate price after marketplace tax
     * @param {number} price - Price before tax
     * @param {number} [taxRate=MARKET_TAX] - Tax rate (e.g., 0.02 for 2%)
     * @returns {number} Price after tax deduction
     *
     * @example
     * calculatePriceAfterTax(100) // Returns 98
     */
    function calculatePriceAfterTax(price, taxRate = MARKET_TAX) {
        return price * (1 - taxRate);
    }

    /**
     * Create a memoized price lookup closure backed by a fresh Map per calculation.
     * Caches results keyed on itemHrid + side + enhancementLevel to avoid redundant
     * market API calls within a single profit calculation pass.
     *
     * @param {Function} getItemPriceFn - Price resolver function (itemHrid, options) => number|null
     * @returns {Function} getCachedPrice(itemHrid, options) closure
     *
     * @example
     * const getCachedPrice = createPriceCache(getItemPrice);
     * const price = getCachedPrice('/items/cotton', { context: 'profit', side: 'sell' });
     */
    function createPriceCache(getItemPriceFn) {
        const priceCache = new Map();

        return function getCachedPrice(itemHrid, options) {
            const side = options?.side || '';
            const enhancementLevel = options?.enhancementLevel ?? '';
            const cacheKey = `${itemHrid}|${side}|${enhancementLevel}`;

            if (priceCache.has(cacheKey)) {
                return priceCache.get(cacheKey);
            }

            const price = getItemPriceFn(itemHrid, options);
            priceCache.set(cacheKey, price);
            return price;
        };
    }

    /**
     * Calculate action-based totals for production actions
     * Uses per-action base inputs (efficiency only affects time)
     *
     * @param {Object} params - Calculation parameters
     * @param {number} params.actionsCount - Number of queued actions
     * @param {number} params.actionsPerHour - Base actions per hour
     * @param {number} params.outputAmount - Items produced per action
     * @param {number} params.outputPrice - Output price per item (pre-tax)
     * @param {number} params.gourmetBonus - Gourmet bonus as decimal (e.g., 0.1 for 10%)
     * @param {Array} [params.bonusDrops] - Bonus drop entries with revenuePerAction
     * @param {Array} [params.materialCosts] - Material cost entries per action
     * @param {number} params.totalTeaCostPerHour - Tea cost per hour
     * @param {number} [params.efficiencyMultiplier=1] - Efficiency multiplier for time scaling
     * @returns {Object} Totals and time values
     */
    function calculateProductionActionTotalsFromBase({
        actionsCount,
        actionsPerHour,
        outputAmount,
        outputPrice,
        gourmetBonus,
        bonusDrops = [],
        materialCosts = [],
        totalTeaCostPerHour,
        efficiencyMultiplier = 1,
    }) {
        const effectiveActionsPerHour = calculateEffectiveActionsPerHour(actionsPerHour, efficiencyMultiplier);
        if (!effectiveActionsPerHour || effectiveActionsPerHour <= 0) {
            return {
                totalBaseItems: 0,
                totalGourmetItems: 0,
                totalBaseRevenue: 0,
                totalGourmetRevenue: 0,
                totalBonusRevenue: 0,
                totalRevenue: 0,
                totalMarketTax: 0,
                totalMaterialCost: 0,
                totalTeaCost: 0,
                totalCosts: 0,
                totalProfit: 0,
                hoursNeeded: 0,
            };
        }
        // actionsCount represents completed actions (including efficiency repeats), so no
        // additional efficiencyMultiplier scaling is needed — it's already baked into the count.
        const totalBaseItems = outputAmount * actionsCount;
        const totalGourmetItems = outputAmount * gourmetBonus * actionsCount;
        const totalBaseRevenue = totalBaseItems * outputPrice;
        const totalGourmetRevenue = totalGourmetItems * outputPrice;
        const totalBonusRevenue = bonusDrops.reduce((sum, drop) => sum + (drop.revenuePerAction || 0) * actionsCount, 0);
        const totalRevenue = totalBaseRevenue + totalGourmetRevenue + totalBonusRevenue;
        const totalMarketTax = totalRevenue * MARKET_TAX;
        const totalMaterialCost = materialCosts.reduce((sum, material) => sum + material.totalCost * actionsCount, 0);
        const hoursNeeded = calculateHoursForActions(actionsCount, effectiveActionsPerHour);
        const totalTeaCost = totalTeaCostPerHour * hoursNeeded;
        const totalCosts = totalMaterialCost + totalTeaCost + totalMarketTax;
        const totalProfit = totalRevenue - totalCosts;

        return {
            totalBaseItems,
            totalGourmetItems,
            totalBaseRevenue,
            totalGourmetRevenue,
            totalBonusRevenue,
            totalRevenue,
            totalMarketTax,
            totalMaterialCost,
            totalTeaCost,
            totalCosts,
            totalProfit,
            hoursNeeded,
        };
    }

    /**
     * Calculate action-based totals for gathering actions
     * Uses per-action base inputs (efficiency only affects time)
     *
     * @param {Object} params - Calculation parameters
     * @param {number} params.actionsCount - Number of queued actions
     * @param {number} params.actionsPerHour - Base actions per hour
     * @param {Array} [params.baseOutputs] - Base outputs with revenuePerAction
     * @param {Array} [params.bonusDrops] - Bonus drop entries with revenuePerAction
     * @param {number} params.processingRevenueBonusPerAction - Processing bonus per action
     * @param {number} params.gourmetRevenueBonusPerAction - Gourmet bonus revenue per action
     * @param {number} params.drinkCostPerHour - Drink costs per hour
     * @param {number} [params.efficiencyMultiplier=1] - Efficiency multiplier for time scaling
     * @returns {Object} Totals and time values
     */
    function calculateGatheringActionTotalsFromBase({
        actionsCount,
        actionsPerHour,
        baseOutputs = [],
        bonusDrops = [],
        processingRevenueBonusPerAction,
        gourmetRevenueBonusPerAction,
        drinkCostPerHour,
        efficiencyMultiplier = 1,
    }) {
        const effectiveActionsPerHour = calculateEffectiveActionsPerHour(actionsPerHour, efficiencyMultiplier);
        if (!effectiveActionsPerHour || effectiveActionsPerHour <= 0) {
            return {
                totalBaseRevenue: 0,
                totalBonusRevenue: 0,
                totalProcessingRevenue: 0,
                totalGourmetRevenue: 0,
                totalRevenue: 0,
                totalMarketTax: 0,
                totalDrinkCost: 0,
                totalCosts: 0,
                totalProfit: 0,
                hoursNeeded: 0,
            };
        }
        const totalBaseRevenue = baseOutputs.reduce(
            (sum, output) => sum + (output.revenuePerAction || 0) * actionsCount,
            0
        );
        const totalBonusRevenue = bonusDrops.reduce((sum, drop) => sum + (drop.revenuePerAction || 0) * actionsCount, 0);
        const totalProcessingRevenue = (processingRevenueBonusPerAction || 0) * actionsCount;
        const totalGourmetRevenue = (gourmetRevenueBonusPerAction || 0) * actionsCount;
        const totalRevenue = totalBaseRevenue + totalGourmetRevenue + totalBonusRevenue + totalProcessingRevenue;
        const totalMarketTax = totalRevenue * MARKET_TAX;
        const hoursNeeded = calculateHoursForActions(actionsCount, effectiveActionsPerHour);
        const totalDrinkCost = drinkCostPerHour * hoursNeeded;
        const totalCosts = totalDrinkCost + totalMarketTax;
        const totalProfit = totalRevenue - totalCosts;

        return {
            totalBaseRevenue,
            totalBonusRevenue,
            totalProcessingRevenue,
            totalGourmetRevenue,
            totalRevenue,
            totalMarketTax,
            totalDrinkCost,
            totalCosts,
            totalProfit,
            hoursNeeded,
        };
    }

    /**
     * Resolve the best available price for an item through the full resolution chain:
     * custom override → shop floor → market price → production cost fallback
     *
     * @param {string} itemHrid - Item HRID
     * @param {Object} options - Configuration options
     * @param {number} [options.enhancementLevel=0] - Enhancement level
     * @param {string} [options.mode] - Pricing mode ('ask'|'bid'|'average')
     * @param {string} [options.context] - Context for pricing mode ('profit'|'networth')
     * @param {string} [options.side='sell'] - Transaction side ('buy'|'sell')
     * @returns {{ price: number, custom: boolean, missing: boolean }}
     */
    function resolveItemPrice(itemHrid, options = {}) {
        const { enhancementLevel = 0, mode, context, side = 'sell' } = options;

        // 1. Custom override — absolute priority
        const customPrice = getCustomPrice(itemHrid, enhancementLevel, side);
        if (customPrice !== null) {
            return { price: customPrice, custom: true, missing: false };
        }

        // 2. Market price (via getItemPrice which handles pricing mode)
        const marketPrice = getItemPrice(itemHrid, { enhancementLevel, mode, context, side });

        // 3. Shop price floor (buy-side only)
        if (side === 'buy') {
            const shopCost = getShopCoinCost(itemHrid);
            if (shopCost > 0 && (marketPrice === null || shopCost < marketPrice)) {
                return { price: shopCost, custom: false, missing: false };
            }
        }

        if (marketPrice !== null) {
            return { price: marketPrice, custom: false, missing: false };
        }

        // 4. Production cost fallback
        const prodCost = getProductionCost(itemHrid, mode || 'ask');
        if (prodCost > 0) {
            return { price: prodCost, custom: false, missing: false };
        }

        // 5. No price found
        return { price: 0, custom: false, missing: true };
    }

    var profitHelpers = {
        // Rate conversions
        calculateActionsPerHour,
        calculateEffectiveActionsPerHour,
        calculateHoursForActions,
        calculateSecondsForActions,

        // Profit
        calculateProfitPerAction,
        calculateTotalProfitForActions,
        calculateProfitPerDay,

        // Costs
        calculateDrinksPerHour,
        calculateTeaCostsPerHour,
        calculatePriceAfterTax,
        createPriceCache,
        resolveItemPrice,

        calculateProductionActionTotalsFromBase,
        calculateGatheringActionTotalsFromBase,
    };

    var profitHelpers$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateActionsPerHour: calculateActionsPerHour,
        calculateDrinksPerHour: calculateDrinksPerHour,
        calculateEffectiveActionsPerHour: calculateEffectiveActionsPerHour,
        calculateGatheringActionTotalsFromBase: calculateGatheringActionTotalsFromBase,
        calculateHoursForActions: calculateHoursForActions,
        calculatePriceAfterTax: calculatePriceAfterTax,
        calculateProductionActionTotalsFromBase: calculateProductionActionTotalsFromBase,
        calculateProfitPerAction: calculateProfitPerAction,
        calculateProfitPerDay: calculateProfitPerDay,
        calculateSecondsForActions: calculateSecondsForActions,
        calculateTeaCostsPerHour: calculateTeaCostsPerHour,
        calculateTotalProfitForActions: calculateTotalProfitForActions,
        createPriceCache: createPriceCache,
        default: profitHelpers,
        resolveItemPrice: resolveItemPrice
    });

    /**
     * DOM Utilities Module
     * Helpers for DOM manipulation and element creation
     */


    // Compiled regex pattern (created once, reused for performance)
    const REGEX_TRANSFORM3D = /translate3d\(([^,]+),\s*([^,]+),\s*([^)]+)\)/;

    /**
     * Wait for an element to appear in the DOM
     * @param {string} selector - CSS selector
     * @param {number} timeout - Max wait time in ms (default: 10000)
     * @param {number} interval - Check interval in ms (default: 100)
     * @returns {Promise<Element|null>} The element or null if timeout
     */
    function waitForElement(selector, timeout = 10000, interval = 100) {
        return new Promise((resolve) => {
            const startTime = Date.now();

            const check = () => {
                const element = document.querySelector(selector);

                if (element) {
                    resolve(element);
                } else if (Date.now() - startTime >= timeout) {
                    console.warn(`[DOM] Timeout waiting for: ${selector}`);
                    resolve(null);
                } else {
                    setTimeout(check, interval);
                }
            };

            check();
        });
    }

    /**
     * Wait for multiple elements to appear
     * @param {string} selector - CSS selector
     * @param {number} minCount - Minimum number of elements to wait for (default: 1)
     * @param {number} timeout - Max wait time in ms (default: 10000)
     * @returns {Promise<NodeList|null>} The elements or null if timeout
     */
    function waitForElements(selector, minCount = 1, timeout = 10000) {
        return new Promise((resolve) => {
            const startTime = Date.now();

            const check = () => {
                const elements = document.querySelectorAll(selector);

                if (elements.length >= minCount) {
                    resolve(elements);
                } else if (Date.now() - startTime >= timeout) {
                    console.warn(`[DOM] Timeout waiting for ${minCount}× ${selector}`);
                    resolve(null);
                } else {
                    setTimeout(check, 100);
                }
            };

            check();
        });
    }

    /**
     * Create a styled div element
     * @param {Object} styles - CSS styles object
     * @param {string} text - Optional text content
     * @param {string} className - Optional class name
     * @returns {HTMLDivElement} Created div
     */
    function createStyledDiv(styles = {}, text = '', className = '') {
        const div = document.createElement('div');

        if (className) {
            div.className = className;
        }

        if (text) {
            div.textContent = text;
        }

        Object.assign(div.style, styles);

        return div;
    }

    /**
     * Create a styled span element
     * @param {Object} styles - CSS styles object
     * @param {string} text - Text content
     * @param {string} className - Optional class name
     * @returns {HTMLSpanElement} Created span
     */
    function createStyledSpan(styles = {}, text = '', className = '') {
        const span = document.createElement('span');

        if (className) {
            span.className = className;
        }

        if (text) {
            span.textContent = text;
        }

        Object.assign(span.style, styles);

        return span;
    }

    /**
     * Create a colored text span (uses script colors from config)
     * @param {string} text - Text content
     * @param {string} colorType - 'main', 'tooltip', or 'alert' (default: 'main')
     * @returns {HTMLSpanElement} Created span with color
     */
    function createColoredText(text, colorType = 'main') {
        let color;

        switch (colorType) {
            case 'main':
                color = config.SCRIPT_COLOR_MAIN;
                break;
            case 'tooltip':
                color = config.SCRIPT_COLOR_TOOLTIP;
                break;
            case 'alert':
                color = config.SCRIPT_COLOR_ALERT;
                break;
            default:
                color = config.SCRIPT_COLOR_MAIN;
        }

        return createStyledSpan({ color }, text);
    }

    /**
     * Insert element before another element
     * @param {Element} newElement - Element to insert
     * @param {Element} referenceElement - Element to insert before
     */
    function insertBefore(newElement, referenceElement) {
        if (!referenceElement?.parentNode) {
            console.warn('[DOM] Cannot insert: reference element has no parent');
            return;
        }

        referenceElement.parentNode.insertBefore(newElement, referenceElement);
    }

    /**
     * Insert element after another element
     * @param {Element} newElement - Element to insert
     * @param {Element} referenceElement - Element to insert after
     */
    function insertAfter(newElement, referenceElement) {
        if (!referenceElement?.parentNode) {
            console.warn('[DOM] Cannot insert: reference element has no parent');
            return;
        }

        referenceElement.parentNode.insertBefore(newElement, referenceElement.nextSibling);
    }

    /**
     * Remove all elements matching selector
     * @param {string} selector - CSS selector
     * @returns {number} Number of elements removed
     */
    function removeElements(selector) {
        const elements = document.querySelectorAll(selector);
        elements.forEach((el) => el.parentNode?.removeChild(el));
        return elements.length;
    }

    /**
     * Get original text from element (strips our injected content)
     * @param {Element} element - Element to get text from
     * @returns {string} Original text content
     */
    function getOriginalText(element) {
        if (!element) return '';

        // Clone element to avoid modifying original
        const clone = element.cloneNode(true);

        // Remove inserted spans/divs (our injected content)
        clone.querySelectorAll('.insertedSpan, .script-injected').forEach((el) => el.remove());

        return clone.textContent.trim();
    }

    /**
     * Add CSS to page
     * @param {string} css - CSS rules to add
     * @param {string} id - Optional style element ID (for removal later)
     */
    function addStyles(css, id = '') {
        const style = document.createElement('style');

        if (id) {
            style.id = id;
        }

        style.textContent = css;
        document.head.appendChild(style);
    }

    /**
     * Remove CSS by ID
     * @param {string} id - Style element ID to remove
     */
    function removeStyles(id) {
        const style = document.getElementById(id);
        if (style) {
            style.remove();
        }
    }

    /**
     * Dismiss all open MUI tooltips by dispatching mouseleave events
     * Useful when DOM elements are reordered (e.g., sorting action panels)
     * which can cause tooltips to get "stuck" since no natural mouseleave fires
     */
    function dismissTooltips() {
        const tooltips = document.querySelectorAll('.MuiTooltip-popper');
        tooltips.forEach((tooltip) => {
            // Find the element that triggered this tooltip and dispatch mouseleave
            // MUI tooltips listen for mouseleave on the trigger element
            const triggerId = tooltip.id?.replace('-tooltip', '');
            if (triggerId) {
                const trigger = document.querySelector(`[aria-describedby="${tooltip.id}"]`);
                if (trigger) {
                    if (trigger.matches(':hover')) {
                        return;
                    }
                    trigger.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
                    trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
                }
            }
        });
    }

    /**
     * Set up scroll listener to dismiss tooltips when scrolling
     * Prevents tooltips from getting stuck when scrolling quickly
     * @returns {Function} Cleanup function to remove the listener
     */
    function setupScrollTooltipDismissal() {
        let scrollTimeout = null;
        let lastUserScrollTime = 0;
        const USER_SCROLL_WINDOW_MS = 200;

        const markUserScroll = () => {
            lastUserScrollTime = Date.now();
        };

        const handleUserKeyScroll = (event) => {
            const key = event.key;
            if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'PageUp' || key === 'PageDown' || key === ' ') {
                markUserScroll();
            }
        };

        const handleScroll = (event) => {
            const target = event.target;
            if (target?.closest?.('.MuiTooltip-tooltip, .MuiTooltip-popper')) {
                return;
            }

            if (Date.now() - lastUserScrollTime > USER_SCROLL_WINDOW_MS) {
                return;
            }

            // Early exit: skip if no tooltips are visible
            if (!document.querySelector('.MuiTooltip-popper')) {
                return;
            }

            // Debounce: only dismiss after scrolling stops for 50ms
            // This prevents excessive calls during continuous scrolling
            if (scrollTimeout) {
                clearTimeout(scrollTimeout);
            }
            scrollTimeout = setTimeout(() => {
                dismissTooltips();
                scrollTimeout = null;
            }, 50);
        };

        // Listen on document with capture to catch all scroll events
        // (including scrolls in nested containers)
        document.addEventListener('scroll', handleScroll, { capture: true, passive: true });

        // Track user-driven scrolling intent
        document.addEventListener('wheel', markUserScroll, { capture: true, passive: true });
        document.addEventListener('touchmove', markUserScroll, { capture: true, passive: true });
        document.addEventListener('keydown', handleUserKeyScroll, { capture: true });

        // Return cleanup function
        return () => {
            document.removeEventListener('scroll', handleScroll, { capture: true });
            document.removeEventListener('wheel', markUserScroll, { capture: true });
            document.removeEventListener('touchmove', markUserScroll, { capture: true });
            document.removeEventListener('keydown', handleUserKeyScroll, { capture: true });
            if (scrollTimeout) {
                clearTimeout(scrollTimeout);
            }
        };
    }

    /**
     * Fix tooltip overflow to ensure it stays within viewport
     * @param {Element} tooltipElement - The tooltip popper element
     * @param {Object} [options={}]
     * @param {boolean} [options.forceTop=false] - Pin the tooltip centered at the top of the viewport
     */
    function fixTooltipOverflow(tooltipElement, { forceTop = false } = {}) {
        // Use triple requestAnimationFrame to ensure MUI positioning is complete
        // Frame 1: MUI does initial positioning
        // Frame 2: Content finishes rendering (especially for long lists)
        // Frame 3: We check and fix overflow
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (!tooltipElement.isConnected) {
                        return; // Tooltip already removed
                    }

                    const bBox = tooltipElement.getBoundingClientRect();
                    const viewportHeight = window.innerHeight;
                    const viewportWidth = window.innerWidth;

                    // Find the actual tooltip content element (child of popper)
                    const tooltipContent = tooltipElement.querySelector('.MuiTooltip-tooltip');

                    if (forceTop) {
                        // Use position:fixed to place tooltip at top-center, bypassing
                        // MUI's transform-based positioning which breaks at low browser
                        // zoom levels (the offset parent may not be at viewport origin).
                        const targetTop = 10;
                        const targetLeft = Math.round((viewportWidth - bBox.width) / 2);

                        tooltipElement.style.position = 'fixed';
                        tooltipElement.style.top = `${targetTop}px`;
                        tooltipElement.style.left = `${targetLeft}px`;
                        tooltipElement.style.transform = 'none';

                        // Cap height if tooltip is taller than viewport
                        if (tooltipContent && bBox.height >= viewportHeight - 20) {
                            tooltipContent.style.maxHeight = `${viewportHeight - 20}px`;
                            tooltipContent.style.overflowY = 'auto';
                        }
                        return;
                    }

                    // Check if tooltip extends beyond viewport
                    if (bBox.top < 0 || bBox.bottom > viewportHeight) {
                        // Get current transform
                        const transformString = tooltipElement.style.transform;

                        if (transformString) {
                            // Parse transform3d(x, y, z)
                            const match = transformString.match(REGEX_TRANSFORM3D);

                            if (match) {
                                const x = match[1];
                                const currentY = parseFloat(match[2]);
                                const z = match[3];

                                // Calculate how much to adjust Y
                                let newY;

                                if (bBox.height >= viewportHeight - 20) {
                                    // Tooltip is taller than viewport - position at top
                                    newY = 0;

                                    // Force max-height on the tooltip content to enable scrolling
                                    if (tooltipContent) {
                                        tooltipContent.style.maxHeight = `${viewportHeight - 20}px`;
                                        tooltipContent.style.overflowY = 'auto';
                                    }
                                } else if (bBox.top < 0) {
                                    // Tooltip extends above viewport - move it down
                                    newY = currentY - bBox.top;
                                } else if (bBox.bottom > viewportHeight) {
                                    // Tooltip extends below viewport - move it up
                                    newY = currentY - (bBox.bottom - viewportHeight) - 10;
                                }

                                if (newY !== undefined) {
                                    // Ensure tooltip never goes above viewport (minimum y=0)
                                    newY = Math.max(0, newY);
                                    tooltipElement.style.transform = `translate3d(${x}, ${newY}px, ${z})`;
                                }
                            }
                        }
                    }
                });
            });
        });
    }

    var dom = {
        waitForElement,
        waitForElements,
        createStyledDiv,
        createStyledSpan,
        createColoredText,
        insertBefore,
        insertAfter,
        removeElements,
        getOriginalText,
        addStyles,
        removeStyles,
        dismissTooltips,
        setupScrollTooltipDismissal,
        fixTooltipOverflow,
    };

    var dom$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        addStyles: addStyles,
        createColoredText: createColoredText,
        createStyledDiv: createStyledDiv,
        createStyledSpan: createStyledSpan,
        default: dom,
        dismissTooltips: dismissTooltips,
        fixTooltipOverflow: fixTooltipOverflow,
        getOriginalText: getOriginalText,
        insertAfter: insertAfter,
        insertBefore: insertBefore,
        removeElements: removeElements,
        removeStyles: removeStyles,
        setupScrollTooltipDismissal: setupScrollTooltipDismissal,
        waitForElement: waitForElement,
        waitForElements: waitForElements
    });

    /**
     * Whether this is a touch device, and whether to act like it.
     *
     * Two questions, deliberately separate. `hasCoarsePointer` is a fact about the
     * hardware — the primary pointer cannot hit a 14px target — and things sized
     * for fingers key on it directly. `isMobileMode` is a *choice* that defaults to
     * that fact: auto-detection is right until the one person on a touchscreen
     * laptop wants desktop layouts, and a setting that cannot be overridden is a
     * bug report waiting to be written.
     */


    /**
     * Whether the primary pointer is a finger rather than a cursor.
     *
     * `pointer: coarse` rather than user-agent sniffing: it asks about the actual
     * input device instead of guessing from a browser string that lies for
     * compatibility reasons.
     *
     * @returns {boolean}
     */
    function hasCoarsePointer() {
        return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    }

    /**
     * Whether features should adjust for a phone-sized, touch-driven screen.
     *
     * @returns {boolean}
     */
    function isMobileMode() {
        const mode = config.getSettingValue('mobileMode', 'auto');
        if (mode === 'on') return true;
        if (mode === 'off') return false;
        return hasCoarsePointer();
    }

    /**
     * What auto-detection is deciding right now, in a word.
     *
     * "Auto-detect" is a promise the settings page cannot keep quietly: on the one
     * machine where the detection is wrong, the setting looks correct and the
     * layout does not, and there is nothing on screen to tell the two apart. The
     * settings UI shows this beside the option so the answer is visible before the
     * override is needed.
     *
     * @returns {string} `'mobile'` or `'desktop'`
     */
    function detectedModeLabel() {
        return hasCoarsePointer() ? 'mobile' : 'desktop';
    }

    var mobile = /*#__PURE__*/Object.freeze({
        __proto__: null,
        detectedModeLabel: detectedModeLabel,
        hasCoarsePointer: hasCoarsePointer,
        isMobileMode: isMobileMode
    });

    /**
     * DOM Observer Helper Utilities
     * Standardized wrappers around domObserver to reduce boilerplate
     */


    /**
     * Create a singleton observer that automatically prevents duplicate processing
     * Uses an internal WeakSet to track processed elements
     *
     * @param {string} name - Observer name for debugging
     * @param {string|string[]} classNames - Class name(s) to watch for
     * @param {Function} handler - Handler function (receives element)
     * @param {Object} options - Optional configuration
     * @param {boolean} options.debounce - Enable debouncing
     * @param {number} options.debounceDelay - Debounce delay in ms
     * @returns {Function} Unregister function
     *
     * @example
     * // Before (20 lines)
     * this.processedDivs = new WeakSet();
     * this.unregister = domObserver.onClass('MyFeature', 'selector', (elem) => {
     *     if (this.processedDivs.has(elem)) return;
     *     this.processedDivs.add(elem);
     *     // do work
     * });
     *
     * // After (5 lines)
     * this.unregister = createSingletonObserver('MyFeature', 'selector', (elem) => {
     *     // do work (processed flag automatic)
     * });
     */
    function createSingletonObserver(name, classNames, handler, options = {}) {
        const processedElements = new WeakSet();

        return domObserver.onClass(
            name,
            classNames,
            (element) => {
                if (processedElements.has(element)) {
                    return;
                }

                // Mark as processed
                processedElements.add(element);

                // Call user handler
                handler(element);
            },
            options
        );
    }

    /**
     * Create a tracked observer that manages cleanup functions for processed elements
     * Uses an internal Map to track element → cleanup function pairs
     * Automatically calls cleanup functions when unregistered
     *
     * @param {string} name - Observer name for debugging
     * @param {string|string[]} classNames - Class name(s) to watch for
     * @param {Function} handler - Handler function (receives element, should return cleanup function or null)
     * @param {Object} options - Optional configuration
     * @param {boolean} options.debounce - Enable debouncing
     * @param {number} options.debounceDelay - Debounce delay in ms
     * @returns {Function} Unregister function (also calls all cleanup functions)
     *
     * @example
     * // Before (15 lines)
     * this.trackedElements = new Map();
     * this.unregister = domObserver.onClass('MyFeature', 'selector', (elem) => {
     *     if (this.trackedElements.has(elem)) return;
     *     const cleanup = attachListeners(...);
     *     this.trackedElements.set(elem, cleanup);
     * });
     *
     * // After (5 lines)
     * this.unregister = createTrackedObserver('MyFeature', 'selector', (elem) => {
     *     return attachListeners(...); // Return cleanup function
     * });
     */
    function createTrackedObserver(name, classNames, handler, options = {}) {
        const trackedElements = new Map();

        const unregister = domObserver.onClass(
            name,
            classNames,
            (element) => {
                // Skip if already tracked
                if (trackedElements.has(element)) {
                    return;
                }

                // Call user handler and store cleanup function
                const cleanup = handler(element);
                if (cleanup && typeof cleanup === 'function') {
                    trackedElements.set(element, cleanup);
                } else {
                    // Mark as tracked even if no cleanup function returned
                    trackedElements.set(element, null);
                }
            },
            options
        );

        // Return enhanced unregister that also calls all cleanup functions
        return () => {
            // Call all cleanup functions
            for (const [_element, cleanup] of trackedElements.entries()) {
                if (cleanup && typeof cleanup === 'function') {
                    try {
                        cleanup();
                    } catch (error) {
                        console.error(`[DOM Observer Helpers] Cleanup error for ${name}:`, error);
                    }
                }
            }

            // Clear tracked elements
            trackedElements.clear();

            unregister();
        };
    }

    /**
     * Create a simplified MutationObserver with automatic cleanup
     * Wrapper around native MutationObserver that returns unwatch function
     *
     * @param {Element} element - Element to observe
     * @param {Function} callback - Callback function (receives mutations, observer)
     * @param {Object} options - MutationObserver options (default: { childList: true, subtree: true })
     * @returns {Function} Unwatch function (disconnects observer)
     *
     * @example
     * // Before (25 lines)
     * let observer = null;
     * const cleanup = () => {
     *     if (observer) {
     *         observer.disconnect();
     *         observer = null;
     *     }
     * };
     * observer = new MutationObserver(() => { ... });
     * observer.observe(element, { childList: true });
     *
     * // After (5 lines)
     * const unwatch = createMutationWatcher(element, () => {
     *     // callback
     * }, { childList: true });
     */
    function createMutationWatcher(element, callback, options = null) {
        if (!element) {
            console.warn('[DOM Observer Helpers] createMutationWatcher called with null element');
            return () => {}; // Return no-op unwatch function
        }

        // Default options
        const observerOptions = options || {
            childList: true,
            subtree: true,
        };

        const observer = new MutationObserver((mutations) => {
            callback(mutations, observer);
        });

        observer.observe(element, observerOptions);

        // Return unwatch function
        return () => {
            observer.disconnect();
        };
    }

    /**
     * Create a persistent display helper
     * Handles cleanup and re-creation of DOM elements on re-render
     *
     * @param {string} name - Helper name for debugging
     * @param {string|string[]} classNames - Class name(s) to watch for
     * @param {Function} createFn - Function to create display element (receives container)
     * @param {Object} options - Optional configuration
     * @param {boolean} options.debounce - Enable debouncing
     * @param {number} options.debounceDelay - Debounce delay in ms
     * @returns {Function} Unregister function
     *
     * @example
     * this.unregister = createPersistentDisplay(
     *     'MyDisplay',
     *     'container-class',
     *     (container) => {
     *         const display = document.createElement('div');
     *         display.className = 'my-display';
     *         display.textContent = 'Hello';
     *         container.appendChild(display);
     *     }
     * );
     */
    function createPersistentDisplay(name, classNames, createFn, options = {}) {
        return createSingletonObserver(
            name,
            classNames,
            (container) => {
                try {
                    createFn(container);
                } catch (error) {
                    console.error(`[DOM Observer Helpers] createPersistentDisplay error for ${name}:`, error);
                }
            },
            options
        );
    }

    var domObserverHelpers = /*#__PURE__*/Object.freeze({
        __proto__: null,
        createMutationWatcher: createMutationWatcher,
        createPersistentDisplay: createPersistentDisplay,
        createSingletonObserver: createSingletonObserver,
        createTrackedObserver: createTrackedObserver
    });

    /**
     * Timer Registry Utility
     * Centralized registration for intervals and timeouts.
     */

    /**
     * Create a timer registry for deterministic teardown.
     * @returns {{
     *   registerInterval: (intervalId: number) => void,
     *   registerTimeout: (timeoutId: number) => void,
     *   clearAll: () => void
     * }} Timer registry API
     */
    function createTimerRegistry() {
        const intervals = [];
        const timeouts = [];

        const registerInterval = (intervalId) => {
            if (!intervalId) {
                console.warn('[TimerRegistry] registerInterval called with invalid interval id');
                return;
            }

            intervals.push(intervalId);
        };

        const registerTimeout = (timeoutId) => {
            if (!timeoutId) {
                console.warn('[TimerRegistry] registerTimeout called with invalid timeout id');
                return;
            }

            timeouts.push(timeoutId);
        };

        const clearAll = () => {
            intervals.forEach((intervalId) => {
                try {
                    clearInterval(intervalId);
                } catch (error) {
                    console.error('[TimerRegistry] Failed to clear interval:', error);
                }
            });
            intervals.length = 0;

            timeouts.forEach((timeoutId) => {
                try {
                    clearTimeout(timeoutId);
                } catch (error) {
                    console.error('[TimerRegistry] Failed to clear timeout:', error);
                }
            });
            timeouts.length = 0;
        };

        return {
            registerInterval,
            registerTimeout,
            clearAll,
        };
    }

    var timerRegistry = /*#__PURE__*/Object.freeze({
        __proto__: null,
        createTimerRegistry: createTimerRegistry
    });

    /**
     * Token Valuation Utility
     * Shared logic for calculating dungeon token values
     * (Task token valuation lives in features/tasks/task-profit-calculator.js)
     */


    /**
     * Calculate dungeon token value based on best shop item value
     * Uses "best market value per token" approach: finds the shop item with highest (market price / token cost)
     * @param {string} tokenHrid - Token HRID (e.g., '/items/chimerical_token')
     * @param {string} pricingModeSetting - Config setting key for pricing mode (default: 'profitCalc_pricingMode')
     * @param {string} respectModeSetting - Config setting key for respect pricing mode flag (default: 'expectedValue_respectPricingMode')
     * @returns {number|null} Value per token, or null if no data
     */
    function calculateDungeonTokenValue(
        tokenHrid,
        pricingModeSetting = 'profitCalc_pricingMode',
        respectModeSetting = 'expectedValue_respectPricingMode'
    ) {
        const gameData = dataManager.getInitClientData();
        if (!gameData) return null;

        // Get all shop items for this token type
        const shopItems = Object.values(gameData.shopItemDetailMap || {}).filter(
            (item) => item.costs && item.costs[0]?.itemHrid === tokenHrid
        );

        if (shopItems.length === 0) return null;

        let bestValuePerToken = 0;

        // For each shop item, calculate market price / token cost
        for (const shopItem of shopItems) {
            const itemHrid = shopItem.itemHrid;
            const tokenCost = shopItem.costs[0].count;

            // Get market price for this item
            const prices = marketAPI.getPrice(itemHrid, 0);
            if (!prices) continue;

            // Use pricing mode to determine which price to use
            const pricingMode = config.getSettingValue(pricingModeSetting, 'conservative');
            const respectPricingMode = config.getSettingValue(respectModeSetting, true);

            let marketPrice = 0;
            if (respectPricingMode) {
                // Conservative/Patient Buy: Bid, Hybrid/Optimistic: Ask
                marketPrice = pricingMode === 'conservative' || pricingMode === 'patientBuy' ? prices.bid : prices.ask;
            } else {
                // Always conservative
                marketPrice = prices.bid;
            }

            if (marketPrice <= 0) continue;

            // Calculate value per token
            const valuePerToken = marketPrice / tokenCost;

            // Keep track of best value
            if (valuePerToken > bestValuePerToken) {
                bestValuePerToken = valuePerToken;
            }
        }

        // Fallback to essence price if no shop items found
        if (bestValuePerToken === 0) {
            const essenceMap = {
                '/items/chimerical_token': '/items/chimerical_essence',
                '/items/sinister_token': '/items/sinister_essence',
                '/items/enchanted_token': '/items/enchanted_essence',
                '/items/pirate_token': '/items/pirate_essence',
            };

            const essenceHrid = essenceMap[tokenHrid];
            if (essenceHrid) {
                const essencePrice = marketAPI.getPrice(essenceHrid, 0);
                if (essencePrice) {
                    const pricingMode = config.getSettingValue(pricingModeSetting, 'conservative');
                    const respectPricingMode = config.getSettingValue(respectModeSetting, true);

                    let marketPrice = 0;
                    if (respectPricingMode) {
                        marketPrice =
                            pricingMode === 'conservative' || pricingMode === 'patientBuy'
                                ? essencePrice.bid
                                : essencePrice.ask;
                    } else {
                        marketPrice = essencePrice.bid;
                    }

                    return marketPrice > 0 ? marketPrice : null;
                }
            }
        }

        return bestValuePerToken > 0 ? bestValuePerToken : null;
    }

    /**
     * A shop line's costs, whichever shape the shop keeps them in.
     *
     * The dungeon and task shops carry a `costs` array; the labyrinth shop carries a
     * single `cost`. Same idea, two spellings.
     *
     * @param {Object} line - A shop line
     * @returns {Array<{itemHrid: string, count: number}>}
     */
    function shopCosts(line) {
        if (Array.isArray(line?.costs)) return line.costs;
        if (line?.cost) return [line.cost];
        return [];
    }

    /**
     * The best coins one token buys, within the shop that takes it.
     *
     * A token is worth the most valuable thing its own shop converts to. Only lines
     * the market prices count — a line nobody can sell says nothing about what a
     * token is worth.
     *
     * @param {Object} shopMap - One of the game's shop maps
     * @param {Function} priceOf - `(itemHrid) => number|null`
     * @param {string} tokenHrid - The currency
     * @returns {number} Coins per token, or 0
     */
    function tokenValueIn(shopMap, priceOf, tokenHrid) {
        let best = 0;

        for (const line of Object.values(shopMap || {})) {
            const cost = shopCosts(line).find((entry) => entry?.itemHrid === tokenHrid);
            if (!(cost?.count > 0)) continue;

            const price = priceOf(line.itemHrid);
            if (!(price > 0)) continue;

            const perToken = (price * (line.outputCount || 1)) / cost.count;
            if (perToken > best) best = perToken;
        }
        return best;
    }

    /**
     * What a shop charges for something, in coins.
     *
     * Some equipment is never listed on the market at all — capes drop, and are
     * otherwise bought from a shop for tokens. A market-only reading says such a
     * piece cannot be had at any price, which is the opposite of true. The shop
     * knows the price; it is just quoted in a currency that needs converting, and a
     * token converts at whatever the best line in its own shop is worth.
     *
     * @param {string} itemHrid - The item
     * @param {Array<Object>} shopMaps - The game's shop maps, in preference order
     * @param {Function} priceOf - `(itemHrid) => number|null`, a market ask
     * @returns {number|null} Coins, or null when no shop sells it for anything priceable
     */
    function shopPurchasePrice(itemHrid, shopMaps, priceOf) {
        for (const shopMap of shopMaps || []) {
            const line = Object.values(shopMap || {}).find((entry) => entry?.itemHrid === itemHrid);
            const costs = shopCosts(line);
            if (!costs.length) continue;

            let total = 0;
            let priced = true;

            for (const cost of costs) {
                const each =
                    cost?.itemHrid === '/items/coin'
                        ? 1
                        : priceOf(cost?.itemHrid) || tokenValueIn(shopMap, priceOf, cost?.itemHrid);
                // One unpriceable currency makes the whole line unpriceable rather
                // than cheap, the same rule the rest of this file runs on
                if (!(each > 0) || !(cost?.count > 0)) {
                    priced = false;
                    break;
                }
                total += each * cost.count;
            }

            if (priced && total > 0) return total / (line.outputCount || 1);
        }
        return null;
    }

    /**
     * The best coins a labyrinth token can be turned into.
     *
     * Labyrinth rewards are bought with tokens, and a token is worth whatever the
     * most valuable thing in its shop converts to. Only tradable shop lines count —
     * a shop line nobody can sell prices a token at nothing, which would then price
     * every reward at nothing.
     *
     * @param {Object} shopMap - The game's `labyrinthShopItemDetailMap`
     * @param {Function} priceOf - `(itemHrid) => number|null`
     * @returns {number} Coins per token, or 0 when nothing in the shop is priced
     */
    function labyrinthTokenValue(shopMap, priceOf) {
        let best = 0;

        for (const line of Object.values(shopMap || {})) {
            const cost = line?.cost?.count || 0;
            if (!(cost > 0)) continue;

            const price = priceOf(line.itemHrid);
            if (!(price > 0)) continue;

            // One token can buy several of something, and the shop says so
            const perToken = (price * (line.outputCount || 1)) / cost;
            if (perToken > best) best = perToken;
        }
        return best;
    }

    /**
     * What a labyrinth reward is worth, through the tokens it costs.
     *
     * Scrolls and seals never appear on the market — they are bought from the
     * labyrinth shop and used — so a market-only reading prices them at nothing and
     * leaves them out of a chest's contents entirely. They cost tokens, and tokens
     * have a value, so they have one.
     *
     * @param {string} itemHrid - The reward
     * @param {Object} shopMap - The game's `labyrinthShopItemDetailMap`
     * @param {Function} priceOf - `(itemHrid) => number|null`
     * @returns {number|null} Coins, or null when it is not a labyrinth reward
     */
    function labyrinthRewardValue(itemHrid, shopMap, priceOf) {
        const line = Object.values(shopMap || {}).find((entry) => entry?.itemHrid === itemHrid);
        const cost = line?.cost?.count || 0;
        if (!(cost > 0)) return null;

        const perToken = labyrinthTokenValue(shopMap, priceOf);
        if (!(perToken > 0)) return null;

        return (perToken * cost) / (line.outputCount || 1);
    }

    var tokenValuation = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateDungeonTokenValue: calculateDungeonTokenValue,
        labyrinthRewardValue: labyrinthRewardValue,
        labyrinthTokenValue: labyrinthTokenValue,
        shopPurchasePrice: shopPurchasePrice
    });

    /**
     * Worker Pool Manager
     * Manages a pool of Web Workers for parallel task execution
     */

    class WorkerPool {
        constructor(workerScript, poolSize = null) {
            // Auto-detect optimal pool size (max 4 workers)
            this.poolSize = poolSize || Math.min(navigator.hardwareConcurrency || 2, 4);
            this.workerScript = workerScript;
            this.workers = [];
            this.taskQueue = [];
            this.activeWorkers = new Set();
            this.nextTaskId = 0;
            this.initialized = false;
        }

        /**
         * Initialize the worker pool
         */
        async initialize() {
            if (this.initialized) {
                return;
            }

            try {
                // Create workers
                for (let i = 0; i < this.poolSize; i++) {
                    const worker = new Worker(URL.createObjectURL(this.workerScript));
                    this.workers.push({
                        id: i,
                        worker,
                        busy: false,
                        currentTask: null,
                    });
                }

                this.initialized = true;
            } catch (error) {
                console.error('[WorkerPool] Failed to initialize:', error);
                throw error;
            }
        }

        /**
         * Execute a task in the worker pool
         * @param {Object} taskData - Data to send to worker
         * @returns {Promise} Promise that resolves with worker result
         */
        async execute(taskData) {
            if (!this.initialized) {
                await this.initialize();
            }

            return new Promise((resolve, reject) => {
                const taskId = this.nextTaskId++;
                const task = {
                    id: taskId,
                    data: taskData,
                    resolve,
                    reject,
                    timestamp: Date.now(),
                };

                // Try to assign to an available worker immediately
                const availableWorker = this.workers.find((w) => !w.busy);

                if (availableWorker) {
                    this.assignTask(availableWorker, task);
                } else {
                    // Queue the task if all workers are busy
                    this.taskQueue.push(task);
                }
            });
        }

        /**
         * Execute multiple tasks in parallel
         * @param {Array} taskDataArray - Array of task data objects
         * @returns {Promise<Array>} Promise that resolves with array of results
         */
        async executeAll(taskDataArray) {
            if (!this.initialized) {
                await this.initialize();
            }

            const promises = taskDataArray.map((taskData) => this.execute(taskData));
            return Promise.all(promises);
        }

        /**
         * Assign a task to a worker
         * @private
         */
        assignTask(workerWrapper, task) {
            workerWrapper.busy = true;
            workerWrapper.currentTask = task;

            // Set up message handler for this specific task
            const messageHandler = (e) => {
                const { taskId, result, error } = e.data;

                if (taskId === task.id) {
                    // Clean up
                    workerWrapper.worker.removeEventListener('message', messageHandler);
                    workerWrapper.worker.removeEventListener('error', errorHandler);
                    workerWrapper.busy = false;
                    workerWrapper.currentTask = null;

                    // Resolve or reject the promise
                    if (error) {
                        task.reject(new Error(error));
                    } else {
                        task.resolve(result);
                    }

                    // Process next task in queue
                    this.processQueue();
                }
            };

            const errorHandler = (error) => {
                console.error('[WorkerPool] Worker error:', error);
                workerWrapper.worker.removeEventListener('message', messageHandler);
                workerWrapper.worker.removeEventListener('error', errorHandler);
                workerWrapper.busy = false;
                workerWrapper.currentTask = null;

                task.reject(error);

                // Process next task in queue
                this.processQueue();
            };

            workerWrapper.worker.addEventListener('message', messageHandler);
            workerWrapper.worker.addEventListener('error', errorHandler);

            // Send task to worker
            workerWrapper.worker.postMessage({
                taskId: task.id,
                data: task.data,
            });
        }

        /**
         * Process the next task in the queue
         * @private
         */
        processQueue() {
            if (this.taskQueue.length === 0) {
                return;
            }

            const availableWorker = this.workers.find((w) => !w.busy);
            if (availableWorker) {
                const task = this.taskQueue.shift();
                this.assignTask(availableWorker, task);
            }
        }

        /**
         * Get pool statistics
         */
        getStats() {
            return {
                poolSize: this.poolSize,
                busyWorkers: this.workers.filter((w) => w.busy).length,
                queuedTasks: this.taskQueue.length,
                totalWorkers: this.workers.length,
            };
        }

        /**
         * Terminate all workers and clean up
         */
        terminate() {
            for (const workerWrapper of this.workers) {
                workerWrapper.worker.terminate();
            }

            this.workers = [];
            this.taskQueue = [];
            this.initialized = false;
        }
    }

    var workerPool$3 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        default: WorkerPool
    });

    /**
     * Expected Value Calculator Worker Manager
     * Manages a worker pool for parallel EV container calculations
     */


    // Worker pool instance
    let workerPool$2 = null;

    // Worker script as inline string
    const WORKER_SCRIPT$2 = `
// Cache for EV calculation results
const evCache = new Map();

/**
 * Calculate expected value for a single container
 * @param {Object} data - Container calculation data
 * @returns {Object} {containerHrid, ev}
 */
function calculateContainerEV(data) {
    const { containerHrid, dropTable, priceMap, COIN_HRID, MARKET_TAX } = data;

    if (!dropTable || dropTable.length === 0) {
        return { containerHrid, ev: null };
    }

    let totalExpectedValue = 0;

    // Calculate expected value for each drop
    for (const drop of dropTable) {
        const itemHrid = drop.itemHrid;
        const dropRate = drop.dropRate || 0;
        const minCount = drop.minCount || 0;
        const maxCount = drop.maxCount || 0;

        // Skip invalid drops
        if (dropRate <= 0 || (minCount === 0 && maxCount === 0)) {
            continue;
        }

        // Calculate average drop count
        const avgCount = (minCount + maxCount) / 2;

        // Get price for this drop
        const priceData = priceMap[itemHrid];
        if (!priceData || priceData.price === null) {
            continue; // Skip drops with missing data
        }

        const price = priceData.price;
        const canBeSold = priceData.canBeSold;
        const isCoin = itemHrid === COIN_HRID;

        // Calculate drop value with tax
        const dropValue = isCoin
            ? avgCount * dropRate * price
            : canBeSold
              ? avgCount * dropRate * price * (1 - MARKET_TAX)
              : avgCount * dropRate * price;

        totalExpectedValue += dropValue;
    }

    return { containerHrid, ev: totalExpectedValue };
}

/**
 * Calculate EV for a batch of containers
 * @param {Array} containers - Array of container data objects
 * @returns {Array} Array of {containerHrid, ev} results
 */
function calculateBatchEV(containers) {
    const results = [];

    for (const container of containers) {
        const result = calculateContainerEV(container);
        if (result.ev !== null) {
            evCache.set(result.containerHrid, result.ev);
        }
        results.push(result);
    }

    return results;
}

self.onmessage = function (e) {
    const { taskId, data } = e.data;
    try {
        const { action, params } = data;

        if (action === 'calculateBatch') {
            const results = calculateBatchEV(params.containers);
            self.postMessage({ taskId, result: results });
        } else if (action === 'clearCache') {
            evCache.clear();
            self.postMessage({ taskId, result: { success: true, message: 'Cache cleared' } });
        } else {
            throw new Error(\`Unknown action: \${action}\`);
        }
    } catch (error) {
        self.postMessage({ taskId, error: error.message || String(error) });
    }
};
`;

    /**
     * Get or create the worker pool instance
     */
    async function getWorkerPool$2() {
        if (workerPool$2) {
            return workerPool$2;
        }

        try {
            // Create worker blob from inline script
            const blob = new Blob([WORKER_SCRIPT$2], { type: 'application/javascript' });

            // Initialize worker pool with 2-4 workers
            workerPool$2 = new WorkerPool(blob);
            await workerPool$2.initialize();

            return workerPool$2;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Calculate EV for multiple containers in parallel
     * @param {Array} containers - Array of container data objects
     * @returns {Promise<Array>} Array of {containerHrid, ev} results
     */
    async function calculateEVBatch(containers) {
        const pool = await getWorkerPool$2();

        // Split containers into chunks for parallel processing
        const chunkSize = Math.ceil(containers.length / pool.getStats().poolSize);
        const chunks = [];

        for (let i = 0; i < containers.length; i += chunkSize) {
            chunks.push(containers.slice(i, i + chunkSize));
        }

        // Process chunks in parallel
        const tasks = chunks.map((chunk) => ({
            action: 'calculateBatch',
            params: { containers: chunk },
        }));

        const results = await pool.executeAll(tasks);

        // Flatten results
        return results.flat();
    }

    /**
     * Clear the worker cache
     */
    async function clearEVCache() {
        if (!workerPool$2) {
            return;
        }

        const pool = await getWorkerPool$2();
        return pool.execute({
            action: 'clearCache',
        });
    }

    /**
     * Get worker pool statistics
     */
    function getEVWorkerStats() {
        return workerPool$2 ? workerPool$2.getStats() : null;
    }

    /**
     * Terminate the worker pool
     */
    function terminateEVWorkerPool() {
        if (workerPool$2) {
            workerPool$2.terminate();
            workerPool$2 = null;
        }
    }

    var evWorkerManager = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateEVBatch: calculateEVBatch,
        clearEVCache: clearEVCache,
        getEVWorkerStats: getEVWorkerStats,
        terminateEVWorkerPool: terminateEVWorkerPool
    });

    /**
     * Expected Value Calculator Module
     * Calculates expected value for openable containers
     */


    /**
     * ExpectedValueCalculator class handles EV calculations for openable containers
     */
    class ExpectedValueCalculator {
        constructor() {
            // Constants
            this.MARKET_TAX = 0.02; // 2% marketplace tax
            this.CONVERGENCE_ITERATIONS = 4; // Nested container convergence

            // Cache for container EVs
            this.containerCache = new Map();

            // Special item HRIDs
            this.COIN_HRID = '/items/coin';
            this.COWBELL_HRID = '/items/cowbell';
            this.COWBELL_BAG_HRID = '/items/bag_of_10_cowbells';

            // Dungeon token HRIDs
            this.DUNGEON_TOKENS = [
                '/items/chimerical_token',
                '/items/sinister_token',
                '/items/enchanted_token',
                '/items/pirate_token',
            ];

            // Flag to track if initialized
            this.isInitialized = false;

            // Retry handler reference for cleanup
            this.retryHandler = null;
        }

        /**
         * Initialize the calculator
         * Pre-calculates all openable containers with nested convergence
         */
        async initialize() {
            if (this.isInitialized) {
                return true;
            }

            if (!dataManager.getInitClientData()) {
                // Init data not yet available - set up retry on next character update
                if (!this.retryHandler) {
                    this.retryHandler = () => {
                        this.initialize(); // Retry initialization
                    };
                    dataManager.on('character_initialized', this.retryHandler);
                }
                return false;
            }

            // Data is available - remove retry handler if it exists
            if (this.retryHandler) {
                dataManager.off('character_initialized', this.retryHandler);
                this.retryHandler = null;
            }

            // Wait for market data to load
            if (!marketAPI.isLoaded()) {
                await marketAPI.fetch(true); // Force fresh fetch on init
            }

            // Calculate all containers with 4-iteration convergence for nesting (now async with workers)
            await this.calculateNestedContainers();

            this.isInitialized = true;

            // Notify listeners that calculator is ready
            dataManager.emit('expected_value_initialized', { timestamp: Date.now() });

            return true;
        }

        /**
         * Calculate all containers with nested convergence using workers
         * Iterates 4 times to resolve nested container values
         */
        async calculateNestedContainers() {
            const initData = dataManager.getInitClientData();
            if (!initData || !initData.openableLootDropMap) {
                return;
            }

            // Get all openable container HRIDs
            const containerHrids = Object.keys(initData.openableLootDropMap);

            // Iterate 4 times for convergence (handles nesting depth)
            for (let iteration = 0; iteration < this.CONVERGENCE_ITERATIONS; iteration++) {
                // Build price map for all items (includes cached container EVs from previous iterations)
                const priceMap = this.buildPriceMap(containerHrids, initData);

                // Prepare container data for workers
                const containerData = containerHrids.map((containerHrid) => ({
                    containerHrid,
                    dropTable: initData.openableLootDropMap[containerHrid],
                    priceMap,
                    COIN_HRID: this.COIN_HRID,
                    MARKET_TAX: this.MARKET_TAX,
                }));

                // Calculate all containers in parallel using workers
                try {
                    const results = await calculateEVBatch(containerData);

                    // Update cache with results
                    for (const result of results) {
                        if (result.ev !== null) {
                            this.containerCache.set(result.containerHrid, result.ev);
                        }
                    }
                } catch (error) {
                    // Worker failed, fall back to main thread calculation
                    console.warn('[ExpectedValueCalculator] Worker failed, falling back to main thread:', error);
                    for (const containerHrid of containerHrids) {
                        const ev = this.calculateSingleContainer(containerHrid, initData);
                        if (ev !== null) {
                            this.containerCache.set(containerHrid, ev);
                        }
                    }
                }
            }
        }

        /**
         * Build price map for all items needed for container calculations
         * @param {Array} containerHrids - Array of container HRIDs
         * @param {Object} initData - Game data
         * @returns {Object} Map of itemHrid to {price, canBeSold}
         */
        buildPriceMap(containerHrids, initData) {
            const priceMap = {};
            const processedItems = new Set();

            // Collect all unique items from all containers
            for (const containerHrid of containerHrids) {
                const dropTable = initData.openableLootDropMap[containerHrid];
                if (!dropTable) continue;

                for (const drop of dropTable) {
                    const itemHrid = drop.itemHrid;
                    if (processedItems.has(itemHrid)) continue;
                    processedItems.add(itemHrid);

                    // Get price and tradeable status
                    const price = this.getDropPrice(itemHrid);
                    const itemDetails = dataManager.getItemDetails(itemHrid);
                    const canBeSold = itemDetails?.isTradable !== false;

                    priceMap[itemHrid] = {
                        price,
                        canBeSold,
                    };
                }
            }

            return priceMap;
        }

        /**
         * Calculate expected value for a single container
         * @param {string} containerHrid - Container item HRID
         * @param {Object} initData - Cached game data (optional, will fetch if not provided)
         * @returns {number|null} Expected value or null if unavailable
         */
        calculateSingleContainer(containerHrid, initData = null) {
            // Use cached data if provided, otherwise fetch
            if (!initData) {
                initData = dataManager.getInitClientData();
            }
            if (!initData || !initData.openableLootDropMap) {
                return null;
            }

            // Get drop table for this container
            const dropTable = initData.openableLootDropMap[containerHrid];
            if (!dropTable || dropTable.length === 0) {
                return null;
            }

            let totalExpectedValue = 0;

            // Calculate expected value for each drop
            for (const drop of dropTable) {
                const itemHrid = drop.itemHrid;
                const dropRate = drop.dropRate || 0;
                const minCount = drop.minCount || 0;
                const maxCount = drop.maxCount || 0;

                // Skip invalid drops
                if (dropRate <= 0 || (minCount === 0 && maxCount === 0)) {
                    continue;
                }

                // Calculate average drop count
                const avgCount = (minCount + maxCount) / 2;

                // Get price for this drop
                const price = this.getDropPrice(itemHrid);

                if (price === null) {
                    continue; // Skip drops with missing data
                }

                // Check if item is tradeable (for tax calculation)
                const itemDetails = dataManager.getItemDetails(itemHrid);
                const canBeSold = itemDetails?.isTradable !== false;

                // Special case: Coin never has market tax (it's currency, not a market item)
                const isCoin = itemHrid === this.COIN_HRID;

                const dropValue = isCoin
                    ? avgCount * dropRate * price // No tax for coins
                    : canBeSold
                      ? calculatePriceAfterTax(avgCount * dropRate * price, this.MARKET_TAX)
                      : avgCount * dropRate * price;
                totalExpectedValue += dropValue;
            }

            // Cache the result for future lookups
            if (totalExpectedValue > 0) {
                this.containerCache.set(containerHrid, totalExpectedValue);
            }

            return totalExpectedValue;
        }

        /**
         * Get price for a drop item
         * Handles special cases (Coin, Cowbell, Dungeon Tokens, nested containers)
         * @param {string} itemHrid - Item HRID
         * @returns {number|null} Price or null if unavailable
         */
        getDropPrice(itemHrid) {
            // Special case: Coin (face value = 1)
            if (itemHrid === this.COIN_HRID) {
                return 1;
            }

            // Special case: Cowbell (use bag price ÷ 10, with 18% tax)
            if (itemHrid === this.COWBELL_HRID) {
                if (!config.getSetting('expectedValue_includeCowbells')) {
                    return 0;
                }
                // Get Cowbell Bag price using profit context (sell side - you're selling the bag)
                const bagValue = getItemPrice(this.COWBELL_BAG_HRID, { context: 'profit', side: 'sell' }) || 0;

                if (bagValue > 0) {
                    // Apply 18% market tax (Cowbell Bag only), then divide by 10
                    return calculatePriceAfterTax(bagValue, 0.18) / 10;
                }
                return null; // No bag price available
            }

            // Special case: Dungeon Tokens (calculate value from shop items)
            if (this.DUNGEON_TOKENS.includes(itemHrid)) {
                return calculateDungeonTokenValue(itemHrid, 'profitCalc_pricingMode', 'expectedValue_respectPricingMode');
            }

            // Check if this is a nested container (use cached EV)
            if (this.containerCache.has(itemHrid)) {
                return this.containerCache.get(itemHrid);
            }

            // Regular market item - get price based on pricing mode (sell side - you're selling drops)
            const dropPrice = getItemPrice(itemHrid, { enhancementLevel: 0, context: 'profit', side: 'sell' });
            return dropPrice > 0 ? dropPrice : null;
        }

        /**
         * Calculate expected value for an openable container
         * @param {string} itemHrid - Container item HRID
         * @returns {Object|null} EV data or null
         */
        calculateExpectedValue(itemHrid) {
            if (!this.isInitialized) {
                console.warn('[ExpectedValueCalculator] Not initialized');
                return null;
            }

            // Get item details
            const itemDetails = dataManager.getItemDetails(itemHrid);
            if (!itemDetails) {
                return null;
            }

            // Verify this is an openable container
            if (!itemDetails.isOpenable) {
                return null; // Not an openable container
            }

            // Get detailed drop breakdown (calculates with fresh market prices)
            const drops = this.getDropBreakdown(itemHrid);

            // Calculate total expected value from fresh drop data
            const expectedReturn = drops.reduce((sum, drop) => sum + drop.expectedValue, 0);

            return {
                itemName: itemDetails.name,
                itemHrid,
                expectedValue: expectedReturn,
                drops,
            };
        }

        /**
         * Get cached expected value for a container (for use by other modules)
         * @param {string} itemHrid - Container item HRID
         * @returns {number|null} Cached EV or null
         */
        getCachedValue(itemHrid) {
            return this.containerCache.get(itemHrid) || null;
        }

        /**
         * Get detailed drop breakdown for display
         * @param {string} containerHrid - Container HRID
         * @returns {Array} Array of drop objects
         */
        getDropBreakdown(containerHrid) {
            const initData = dataManager.getInitClientData();
            if (!initData || !initData.openableLootDropMap) {
                return [];
            }

            const dropTable = initData.openableLootDropMap[containerHrid];
            if (!dropTable) {
                return [];
            }

            const drops = [];

            for (const drop of dropTable) {
                const itemHrid = drop.itemHrid;
                const dropRate = drop.dropRate || 0;
                const minCount = drop.minCount || 0;
                const maxCount = drop.maxCount || 0;

                if (dropRate <= 0) {
                    continue;
                }

                // Get item details
                const itemDetails = dataManager.getItemDetails(itemHrid);
                if (!itemDetails) {
                    continue;
                }

                // Calculate average count
                const avgCount = (minCount + maxCount) / 2;

                // Get price
                const price = this.getDropPrice(itemHrid);

                // Calculate expected value for this drop
                const itemCanBeSold = itemDetails.isTradable !== false;

                // Special case: Coin never has market tax (it's currency, not a market item)
                const isCoin = itemHrid === this.COIN_HRID;

                const dropValue =
                    price !== null
                        ? isCoin
                            ? avgCount * dropRate * price // No tax for coins
                            : itemCanBeSold
                              ? calculatePriceAfterTax(avgCount * dropRate * price, this.MARKET_TAX)
                              : avgCount * dropRate * price
                        : 0;

                drops.push({
                    itemHrid,
                    itemName: itemDetails.name,
                    dropRate,
                    avgCount,
                    priceEach: price || 0,
                    expectedValue: dropValue,
                    hasPriceData: price !== null,
                });
            }

            // Sort by expected value (highest first)
            drops.sort((a, b) => b.expectedValue - a.expectedValue);

            return drops;
        }

        /**
         * Invalidate cache (call when market data refreshes)
         */
        invalidateCache() {
            this.containerCache.clear();
            this.isInitialized = false;

            // Re-initialize if data is available
            if (dataManager.getInitClientData() && marketAPI.isLoaded()) {
                this.initialize();
            }
        }

        /**
         * Cleanup calculator state and handlers
         */
        cleanup() {
            if (this.retryHandler) {
                dataManager.off('character_initialized', this.retryHandler);
                this.retryHandler = null;
            }

            this.containerCache.clear();
            this.isInitialized = false;

            // The pool recreates itself on the next batch; idle workers should not
            // outlive the feature that spawned them
            terminateEVWorkerPool();
        }

        disable() {
            this.cleanup();
        }
    }

    const expectedValueCalculator = new ExpectedValueCalculator();

    /**
     * Bonus Revenue Calculator Utility
     * Calculates revenue from essence and rare find drops
     * Shared by both gathering and production profit calculators
     */


    /**
     * Calculate bonus revenue from essence and rare find drops
     * @param {Object} actionDetails - Action details from game data
     * @param {number} actionsPerHour - Base actions per hour (efficiency not applied)
     * @param {Map} characterEquipment - Equipment map
     * @param {Object} itemDetailMap - Item details map
     * @returns {Object} Bonus revenue data with essence and rare find drops
     */
    function calculateBonusRevenue(actionDetails, actionsPerHour, characterEquipment, itemDetailMap) {
        // Get Essence Find bonus from equipment
        const essenceFindBonus = parseEssenceFindBonus(characterEquipment, itemDetailMap);

        // Get Rare Find bonus from BOTH equipment and house rooms
        const equipmentRareFindBonus = parseRareFindBonus(characterEquipment, actionDetails.type, itemDetailMap);
        const houseRareFindBonus = calculateHouseRareFind();
        const achievementRareFindBonus =
            dataManager.getAchievementBuffFlatBoost(actionDetails.type, '/buff_types/rare_find') * 100;
        const personalRareFindBonus =
            dataManager.getPersonalBuffFlatBoost(actionDetails.type, '/buff_types/rare_find') * 100;

        const guildBuffs = dataManager.characterData?.guildActionTypeBuffsMap?.[actionDetails.type] || [];
        const guildRareFindBonus =
            guildBuffs.reduce(
                (sum, b) => (b.typeHrid === '/buff_types/rare_find' ? sum + (b.flatBoost || 0) + (b.ratioBoost || 0) : sum),
                0
            ) * 100;
        const guildEssenceFindBonus =
            guildBuffs.reduce(
                (sum, b) =>
                    b.typeHrid === '/buff_types/essence_find' ? sum + (b.flatBoost || 0) + (b.ratioBoost || 0) : sum,
                0
            ) * 100;

        const totalEssenceFindBonus = essenceFindBonus + guildEssenceFindBonus;
        const rareFindBonus =
            equipmentRareFindBonus +
            houseRareFindBonus +
            achievementRareFindBonus +
            personalRareFindBonus +
            guildRareFindBonus;
        const equipmentRareFindItems = parseRareFindBreakdown(characterEquipment, actionDetails.type, itemDetailMap);
        const rareFindBreakdown = {
            equipment: equipmentRareFindBonus,
            equipmentItems: equipmentRareFindItems,
            house: houseRareFindBonus,
            achievement: achievementRareFindBonus,
            personal: personalRareFindBonus,
            guild: guildRareFindBonus,
        };

        const bonusDrops = [];
        let totalBonusRevenue = 0;
        let hasMissingPrices = false;

        // Process essence drops
        if (actionDetails.essenceDropTable && actionDetails.essenceDropTable.length > 0) {
            for (const drop of actionDetails.essenceDropTable) {
                const itemDetails = itemDetailMap[drop.itemHrid];
                if (!itemDetails) continue;

                // Calculate average drop count
                const avgCount = (drop.minCount + drop.maxCount) / 2;

                // Apply Essence Find multiplier to drop rate
                const finalDropRate = drop.dropRate * (1 + totalEssenceFindBonus / 100);

                // Expected drops per hour
                const dropsPerHour = actionsPerHour * finalDropRate * avgCount;

                // Get price: Check if openable container (use EV), otherwise market price
                let itemPrice = 0;
                let isMissingPrice = false;
                if (itemDetails.isOpenable) {
                    // Use expected value for openable containers (with on-demand fallback)
                    itemPrice =
                        expectedValueCalculator.getCachedValue(drop.itemHrid) ||
                        expectedValueCalculator.calculateSingleContainer(drop.itemHrid) ||
                        0;
                    if (itemPrice === 0) {
                        console.warn(`[BonusRevenue] EV lookup returned 0 for openable container: ${drop.itemHrid}`);
                        isMissingPrice = true;
                    }
                } else {
                    // Use market price for regular items
                    const price = marketAPI.getPrice(drop.itemHrid, 0);
                    itemPrice = price?.bid ?? 0; // Use bid price (instant sell)
                    isMissingPrice = price?.bid === null || price?.bid === undefined;
                }

                // Revenue per hour from this drop
                const revenuePerHour = dropsPerHour * itemPrice;
                const dropsPerAction = actionsPerHour > 0 ? dropsPerHour / actionsPerHour : 0;
                const revenuePerAction = actionsPerHour > 0 ? revenuePerHour / actionsPerHour : 0;

                bonusDrops.push({
                    itemHrid: drop.itemHrid,
                    itemName: itemDetails.name,
                    dropRate: finalDropRate,
                    dropsPerHour,
                    dropsPerAction,
                    priceEach: itemPrice,
                    revenuePerHour,
                    revenuePerAction,
                    type: 'essence',
                    missingPrice: isMissingPrice,
                });

                totalBonusRevenue += revenuePerHour;
                if (isMissingPrice) {
                    hasMissingPrices = true;
                }
            }
        }

        // Process rare find drops
        if (actionDetails.rareDropTable && actionDetails.rareDropTable.length > 0) {
            for (const drop of actionDetails.rareDropTable) {
                const itemDetails = itemDetailMap[drop.itemHrid];
                if (!itemDetails) continue;

                // Calculate average drop count
                const avgCount = (drop.minCount + drop.maxCount) / 2;

                // Apply Rare Find multiplier to drop rate
                const finalDropRate = drop.dropRate * (1 + rareFindBonus / 100);

                // Expected drops per hour
                const dropsPerHour = actionsPerHour * finalDropRate * avgCount;

                // Get price: Check if openable container (use EV), otherwise market price
                let itemPrice = 0;
                let isMissingPrice = false;
                if (itemDetails.isOpenable) {
                    // Use expected value for openable containers (with on-demand fallback)
                    itemPrice =
                        expectedValueCalculator.getCachedValue(drop.itemHrid) ||
                        expectedValueCalculator.calculateSingleContainer(drop.itemHrid) ||
                        0;
                    if (itemPrice === 0) {
                        console.warn(`[BonusRevenue] EV lookup returned 0 for openable container: ${drop.itemHrid}`);
                        isMissingPrice = true;
                    }
                } else {
                    // Use market price for regular items
                    const price = marketAPI.getPrice(drop.itemHrid, 0);
                    itemPrice = price?.bid ?? 0; // Use bid price (instant sell)
                    isMissingPrice = price?.bid === null || price?.bid === undefined;
                }

                // Revenue per hour from this drop
                const revenuePerHour = dropsPerHour * itemPrice;
                const dropsPerAction = actionsPerHour > 0 ? dropsPerHour / actionsPerHour : 0;
                const revenuePerAction = actionsPerHour > 0 ? revenuePerHour / actionsPerHour : 0;

                bonusDrops.push({
                    itemHrid: drop.itemHrid,
                    itemName: itemDetails.name,
                    dropRate: finalDropRate,
                    dropsPerHour,
                    dropsPerAction,
                    priceEach: itemPrice,
                    revenuePerHour,
                    revenuePerAction,
                    type: 'rare_find',
                    missingPrice: isMissingPrice,
                });

                totalBonusRevenue += revenuePerHour;
                if (isMissingPrice) {
                    hasMissingPrices = true;
                }
            }
        }

        return {
            essenceFindBonus: totalEssenceFindBonus, // Essence Find % from equipment + guild
            rareFindBonus, // Rare Find % from equipment + house rooms + achievements (combined)
            rareFindBreakdown,
            bonusDrops, // Array of all bonus drops with details
            totalBonusRevenue, // Total revenue/hour from all bonus drops
            hasMissingPrices,
        };
    }

    var bonusRevenueCalculator = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateBonusRevenue: calculateBonusRevenue
    });

    /**
     * Experience Parser Utility
     * Parses wisdom and experience bonuses from all sources
     *
     * Experience Formula (Skilling):
     * Final XP = Base XP × (1 + Wisdom + Charm Experience)
     *
     * Where Wisdom and Charm Experience are ADDITIVE
     */


    /**
     * Parse equipment wisdom bonus (skillingExperience stat)
     * @param {Map} equipment - Character equipment map
     * @param {Object} itemDetailMap - Item details from game data
     * @returns {Object} {total: number, breakdown: Array} Total wisdom and item breakdown
     */
    function parseEquipmentWisdom(equipment, itemDetailMap) {
        let totalWisdom = 0;
        const breakdown = [];

        for (const [_slot, item] of equipment) {
            const itemDetails = itemDetailMap[item.itemHrid];
            if (!itemDetails?.equipmentDetail) continue;

            const noncombatStats = itemDetails.equipmentDetail.noncombatStats || {};

            // Get base skillingExperience
            const baseWisdom = noncombatStats.skillingExperience || 0;
            if (baseWisdom === 0) continue;

            const enhancementLevel = item.enhancementLevel || 0;
            const multiplier = getEnhancementMultiplier(itemDetails, enhancementLevel);
            const itemWisdom = baseWisdom * multiplier * 100;
            totalWisdom += itemWisdom;

            // Add to breakdown
            breakdown.push({
                name: itemDetails.name,
                value: itemWisdom,
                enhancementLevel: enhancementLevel,
            });
        }

        return {
            total: totalWisdom,
            breakdown: breakdown,
        };
    }

    /**
     * Parse skill-specific charm experience (e.g., foragingExperience)
     * @param {Map} equipment - Character equipment map
     * @param {string} skillHrid - Skill HRID (e.g., "/skills/foraging")
     * @param {Object} itemDetailMap - Item details from game data
     * @returns {Object} {total: number, breakdown: Array} Total charm XP and item breakdown
     */
    function parseCharmExperience(equipment, skillHrid, itemDetailMap) {
        let totalCharmXP = 0;
        const breakdown = [];

        // Convert skill HRID to stat name (e.g., "/skills/foraging" → "foragingExperience")
        const skillName = skillHrid.replace('/skills/', '');
        const statName = `${skillName}Experience`;

        for (const [_slot, item] of equipment) {
            const itemDetails = itemDetailMap[item.itemHrid];
            if (!itemDetails?.equipmentDetail) continue;

            const noncombatStats = itemDetails.equipmentDetail.noncombatStats || {};

            // Get base charm experience
            const baseCharmXP = noncombatStats[statName] || 0;
            if (baseCharmXP === 0) continue;

            const enhancementLevel = item.enhancementLevel || 0;
            const multiplier = getEnhancementMultiplier(itemDetails, enhancementLevel);
            const itemCharmXP = baseCharmXP * multiplier * 100;
            totalCharmXP += itemCharmXP;

            // Add to breakdown
            breakdown.push({
                name: itemDetails.name,
                value: itemCharmXP,
                enhancementLevel: enhancementLevel,
            });
        }

        return {
            total: totalCharmXP,
            breakdown: breakdown,
        };
    }

    /**
     * Parse house room wisdom bonus
     * All house rooms provide +0.05% wisdom per level
     * @returns {number} Total wisdom from house rooms (e.g., 0.4 for 8 total levels)
     */
    function parseHouseRoomWisdom() {
        const houseRooms = dataManager.getHouseRooms();
        if (!houseRooms || houseRooms.size === 0) {
            return 0;
        }

        // Sum all house room levels
        let totalLevels = 0;
        for (const [_hrid, room] of houseRooms) {
            totalLevels += room.level || 0;
        }

        // Formula: totalLevels × 0.05% per level
        return totalLevels * 0.05;
    }

    /**
     * Parse community buff wisdom bonus
     * Formula: 20% + ((level - 1) × 0.5%)
     * @returns {number} Wisdom percentage from community buff (e.g., 29.5 for T20)
     */
    function parseCommunityBuffWisdom() {
        const buffLevel = dataManager.getCommunityBuffLevel('/community_buff_types/experience');
        if (!buffLevel) {
            return 0;
        }

        // Formula: 20% base + 0.5% per level above 1
        return 20 + (buffLevel - 1) * 0.5;
    }

    /**
     * Parse MooPass wisdom bonus
     * MooPass provides a flat 5% wisdom boost
     * @returns {number} Wisdom percentage from MooPass (5% if active, 0 if not)
     */
    function parseMooPassWisdom() {
        const mooPassBuffs = dataManager.getMooPassBuffs();
        if (!mooPassBuffs || mooPassBuffs.length === 0) {
            return 0;
        }

        // Check for wisdom buff from MooPass
        const wisdomBuff = mooPassBuffs.find((buff) => buff.typeHrid === '/buff_types/wisdom');

        if (!wisdomBuff || !wisdomBuff.flatBoost) {
            return 0;
        }

        // Convert to percentage (0.05 → 5%)
        return wisdomBuff.flatBoost * 100;
    }

    /**
     * Parse wisdom from active consumables (Wisdom Tea/Coffee)
     * @param {Array} drinkSlots - Active drink slots for the action type
     * @param {Object} itemDetailMap - Item details from game data
     * @param {number} drinkConcentration - Drink concentration bonus (e.g., 12.16 for 12.16%)
     * @returns {number} Wisdom percentage from consumables (e.g., 13.46 for 12% × 1.1216)
     */
    function parseConsumableWisdom(drinkSlots, itemDetailMap, drinkConcentration) {
        if (!drinkSlots || drinkSlots.length === 0) {
            return 0;
        }

        let totalWisdom = 0;

        for (const drink of drinkSlots) {
            if (!drink || !drink.itemHrid) continue; // Skip empty slots

            const itemDetails = itemDetailMap[drink.itemHrid];
            if (!itemDetails?.consumableDetail) continue;

            // Check for wisdom buff (typeHrid === "/buff_types/wisdom")
            const buffs = itemDetails.consumableDetail.buffs || [];
            for (const buff of buffs) {
                // Check if this is a wisdom buff by typeHrid
                if (buff.typeHrid === '/buff_types/wisdom' && buff.flatBoost) {
                    // Base wisdom (e.g., 0.12 for 12%)
                    const baseWisdom = buff.flatBoost * 100;

                    // Scale with drink concentration
                    const scaledWisdom = baseWisdom * (1 + drinkConcentration / 100);

                    totalWisdom += scaledWisdom;
                }
            }
        }

        return totalWisdom;
    }

    /**
     * Calculate total experience multiplier and breakdown
     * @param {string} skillHrid - Skill HRID (e.g., "/skills/foraging")
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/foraging")
     * @returns {Object} Experience data with breakdown
     */
    function calculateExperienceMultiplier(skillHrid, actionTypeHrid) {
        const { equipment, drinks: activeDrinks } = resolveActionContext(actionTypeHrid);
        const gameData = dataManager.getInitClientData();
        const itemDetailMap = gameData?.itemDetailMap || {};

        // Get drink concentration (tea-parser returns a decimal; convert to percentage for parseConsumableWisdom)
        const drinkConcentration = equipment ? getDrinkConcentration(equipment, itemDetailMap) * 100 : 0;

        // Parse wisdom from all sources
        const equipmentWisdomData = parseEquipmentWisdom(equipment, itemDetailMap);
        const equipmentWisdom = equipmentWisdomData.total;
        const houseWisdom = parseHouseRoomWisdom();
        const communityWisdom = parseCommunityBuffWisdom();
        const consumableWisdom = parseConsumableWisdom(activeDrinks, itemDetailMap, drinkConcentration);
        const achievementWisdom = dataManager.getAchievementBuffFlatBoost(actionTypeHrid, '/buff_types/wisdom') * 100;
        const mooPassWisdom = parseMooPassWisdom();
        const personalWisdom = dataManager.getPersonalBuffFlatBoost(actionTypeHrid, '/buff_types/wisdom') * 100;
        const guildBuffs = dataManager.characterData?.guildActionTypeBuffsMap?.[actionTypeHrid] || [];
        const guildWisdom =
            guildBuffs.reduce(
                (sum, b) => (b.typeHrid === '/buff_types/wisdom' ? sum + (b.flatBoost || 0) + (b.ratioBoost || 0) : sum),
                0
            ) * 100;

        const totalWisdom =
            equipmentWisdom +
            houseWisdom +
            communityWisdom +
            consumableWisdom +
            achievementWisdom +
            mooPassWisdom +
            personalWisdom +
            guildWisdom;

        // Parse charm experience (skill-specific) - now returns object with total and breakdown
        const charmData = parseCharmExperience(equipment, skillHrid, itemDetailMap);
        const charmExperience = charmData.total;

        // Total multiplier (additive)
        const totalMultiplier = 1 + totalWisdom / 100 + charmExperience / 100;

        return {
            totalMultiplier,
            totalWisdom,
            charmExperience,
            charmBreakdown: charmData.breakdown,
            wisdomBreakdown: equipmentWisdomData.breakdown,
            breakdown: {
                equipmentWisdom,
                houseWisdom,
                communityWisdom,
                consumableWisdom,
                achievementWisdom,
                mooPassWisdom,
                personalWisdom,
                guildWisdom,
                charmExperience,
            },
        };
    }

    var experienceParser = {
        parseEquipmentWisdom,
        parseCharmExperience,
        parseHouseRoomWisdom,
        parseCommunityBuffWisdom,
        parseMooPassWisdom,
        parseConsumableWisdom,
        calculateExperienceMultiplier,
    };

    var experienceParser$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateExperienceMultiplier: calculateExperienceMultiplier,
        default: experienceParser,
        parseCharmExperience: parseCharmExperience,
        parseCommunityBuffWisdom: parseCommunityBuffWisdom,
        parseConsumableWisdom: parseConsumableWisdom,
        parseEquipmentWisdom: parseEquipmentWisdom,
        parseHouseRoomWisdom: parseHouseRoomWisdom,
        parseMooPassWisdom: parseMooPassWisdom
    });

    /**
     * Merge market listing updates into the current list.
     * @param {Array} currentListings - Existing market listings.
     * @param {Array} updatedListings - Updated listings from WebSocket.
     * @returns {Array} New merged listings array.
     */
    const mergeMarketListings = (currentListings = [], updatedListings = []) => {
        const safeCurrent = Array.isArray(currentListings) ? currentListings : [];
        const safeUpdates = Array.isArray(updatedListings) ? updatedListings : [];

        if (safeUpdates.length === 0) {
            return [...safeCurrent];
        }

        const indexById = new Map();
        safeCurrent.forEach((listing, index) => {
            if (!listing || listing.id === undefined || listing.id === null) {
                return;
            }
            indexById.set(listing.id, index);
        });

        const merged = [...safeCurrent];

        for (const listing of safeUpdates) {
            if (!listing || listing.id === undefined || listing.id === null) {
                continue;
            }

            const existingIndex = indexById.get(listing.id);
            if (existingIndex !== undefined) {
                merged[existingIndex] = listing;
            } else {
                merged.push(listing);
            }
        }

        // Remove dead listings: cancelled/expired immediately, filled once fully claimed
        return merged.filter((listing) => {
            if (!listing) return false;
            if (
                listing.status === '/market_listing_status/cancelled' ||
                listing.status === '/market_listing_status/expired'
            ) {
                return false;
            }
            if (
                listing.status === '/market_listing_status/filled' &&
                (listing.unclaimedItemCount || 0) === 0 &&
                (listing.unclaimedCoinCount || 0) === 0
            ) {
                return false;
            }
            return true;
        });
    };

    var marketListings = /*#__PURE__*/Object.freeze({
        __proto__: null,
        mergeMarketListings: mergeMarketListings
    });

    /**
     * Action Calculator
     * Shared calculation logic for action time and efficiency
     * Used by action-time-display.js and quick-input-buttons.js
     */


    /**
     * Calculate complete action statistics (time + efficiency)
     * @param {Object} actionDetails - Action detail object from game data
     * @param {Object} options - Configuration options
     * @param {Array} options.skills - Character skills array
     * @param {Array} options.equipment - Character equipment array
     * @param {Object} options.itemDetailMap - Item detail map from game data
     * @param {string} options.actionHrid - Action HRID for task detection (optional)
     * @param {boolean} options.includeCommunityBuff - Include community buff in efficiency (default: false)
     * @param {boolean} options.includeBreakdown - Include detailed breakdown data (default: false)
     * @param {number} options.levelRequirementOverride - Override base level requirement (e.g., item level for alchemy)
     * @returns {Object} { actionTime, totalEfficiency, breakdown? }
     */
    function calculateActionStats(actionDetails, options = {}) {
        const {
            skills,
            equipment,
            itemDetailMap,
            actionHrid,
            includeCommunityBuff = false,
            includeBreakdown = false,
            levelRequirementOverride,
        } = options;

        try {
            // Calculate base action time
            const baseTime = actionDetails.baseTimeCost / 1e9; // nanoseconds to seconds

            // Get equipment speed bonus
            const speedBonus = parseEquipmentSpeedBonuses(equipment, actionDetails.type, itemDetailMap);
            const personalSpeedBonus = dataManager.getPersonalBuffFlatBoost(actionDetails.type, '/buff_types/action_speed');

            const guildBuffs = dataManager.characterData?.guildActionTypeBuffsMap?.[actionDetails.type] || [];
            const guildSpeedBonus = guildBuffs.reduce(
                (sum, b) =>
                    b.typeHrid === '/buff_types/action_speed' ? sum + (b.flatBoost || 0) + (b.ratioBoost || 0) : sum,
                0
            );
            const guildEfficiency = guildBuffs.reduce(
                (sum, b) =>
                    b.typeHrid === '/buff_types/efficiency' ? sum + ((b.flatBoost || 0) + (b.ratioBoost || 0)) * 100 : sum,
                0
            );

            // Calculate action time with equipment speed
            let actionTime = baseTime / (1 + speedBonus + personalSpeedBonus + guildSpeedBonus);

            // Apply task speed multiplicatively (if action is an active task)
            if (actionHrid && dataManager.isTaskAction(actionHrid)) {
                const taskSpeedBonus = dataManager.getTaskSpeedBonus(); // Returns percentage (e.g., 15 for 15%)
                actionTime = actionTime / (1 + taskSpeedBonus / 100); // Apply multiplicatively
            }

            // Enforce game minimum action time
            actionTime = Math.max(MIN_ACTION_TIME_SECONDS, actionTime);

            // Calculate efficiency
            const skillLevel = getSkillLevel(skills, actionDetails.type);
            const baseRequirement = levelRequirementOverride ?? actionDetails.levelRequirement?.level ?? 1;

            // Get drink concentration
            const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);

            // Get active drinks for this action type (loadout-snapshot aware)
            const activeDrinks = resolveActionContext(actionDetails.type).drinks;

            // Calculate Action Level bonus from teas
            const actionLevelBonus = parseActionLevelBonus(activeDrinks, itemDetailMap, drinkConcentration);

            // Get Action Level bonus breakdown (if requested)
            let actionLevelBreakdown = null;
            if (includeBreakdown) {
                actionLevelBreakdown = parseActionLevelBonusBreakdown(activeDrinks, itemDetailMap, drinkConcentration);
            }

            // Calculate effective requirement
            // Game uses full fractional action level bonus (no flooring)
            const effectiveRequirement = baseRequirement + actionLevelBonus;

            // Calculate tea skill level bonus (e.g., +8 Cheesesmithing from Ultra Cheesesmithing Tea)
            const teaSkillLevelBonus = parseTeaSkillLevelBonus(
                actionDetails.type,
                activeDrinks,
                itemDetailMap,
                drinkConcentration
            );

            // Calculate efficiency components
            // Apply tea skill level bonus to effective player level
            const effectiveLevel = skillLevel + teaSkillLevelBonus;
            const levelEfficiency = Math.max(0, effectiveLevel - effectiveRequirement);
            const houseEfficiency = calculateHouseEfficiency(actionDetails.type);
            const equipmentEfficiency = parseEquipmentEfficiencyBonuses(equipment, actionDetails.type, itemDetailMap);
            const achievementEfficiency =
                dataManager.getAchievementBuffFlatBoost(actionDetails.type, '/buff_types/efficiency') * 100;
            const personalEfficiency =
                dataManager.getPersonalBuffFlatBoost(actionDetails.type, '/buff_types/efficiency') * 100;

            // Calculate tea efficiency
            let teaEfficiency;
            let teaBreakdown = null;
            if (includeBreakdown) {
                // Get detailed breakdown
                teaBreakdown = parseTeaEfficiencyBreakdown(
                    actionDetails.type,
                    activeDrinks,
                    itemDetailMap,
                    drinkConcentration
                );
                teaEfficiency = teaBreakdown.reduce((sum, tea) => sum + tea.efficiency, 0);
            } else {
                // Simple total
                teaEfficiency = parseTeaEfficiency(actionDetails.type, activeDrinks, itemDetailMap, drinkConcentration);
            }

            // Get community buff efficiency (if requested)
            let communityEfficiency = 0;
            if (includeCommunityBuff) {
                // Production Efficiency buff applies to production skills and alchemy
                const productionSkills = [
                    '/action_types/alchemy',
                    '/action_types/brewing',
                    '/action_types/cheesesmithing',
                    '/action_types/cooking',
                    '/action_types/crafting',
                    '/action_types/tailoring',
                ];

                if (productionSkills.includes(actionDetails.type)) {
                    const communityBuffLevel = dataManager.getCommunityBuffLevel(
                        '/community_buff_types/production_efficiency'
                    );
                    communityEfficiency = communityBuffLevel ? (0.14 + (communityBuffLevel - 1) * 0.003) * 100 : 0;
                }
            }

            // Total efficiency (stack all components additively)
            const totalEfficiency = stackAdditive(
                levelEfficiency,
                houseEfficiency,
                equipmentEfficiency,
                teaEfficiency,
                communityEfficiency,
                achievementEfficiency,
                personalEfficiency,
                guildEfficiency
            );

            // Build result object
            const result = {
                actionTime,
                totalEfficiency,
            };

            // Add breakdown if requested
            if (includeBreakdown) {
                result.efficiencyBreakdown = {
                    levelEfficiency,
                    houseEfficiency,
                    equipmentEfficiency,
                    teaEfficiency,
                    teaBreakdown,
                    communityEfficiency,
                    achievementEfficiency,
                    personalEfficiency,
                    guildEfficiency,
                    skillLevel,
                    baseRequirement,
                    actionLevelBonus,
                    actionLevelBreakdown,
                    effectiveRequirement,
                };
            }

            return result;
        } catch (error) {
            console.error('[Action Calculator] Error calculating action stats:', error);
            return null;
        }
    }

    /**
     * Get character skill level for a skill type
     * @param {Array} skills - Character skills array
     * @param {string} skillType - Skill type HRID (e.g., "/action_types/cheesesmithing")
     * @returns {number} Skill level
     */
    function getSkillLevel(skills, skillType) {
        // Combat/labyrinth actions don't map to a single skill — efficiency scaling doesn't apply
        if (skillType === '/action_types/combat' || skillType === '/action_types/labyrinth') {
            return 1;
        }
        // Map action type to skill HRID
        const skillHrid = skillType.replace('/action_types/', '/skills/');
        const skill = skills.find((s) => s.skillHrid === skillHrid);
        if (!skill) {
            console.error(`[ActionCalculator] Skill not found: ${skillHrid}`);
        }
        return skill?.level || 1;
    }

    var actionCalculator = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateActionStats: calculateActionStats
    });

    /**
     * Action Panel Display Helper
     * Utilities for working with action detail panels (gathering, production, enhancement)
     */

    /**
     * Find the action count input field within a panel
     * @param {HTMLElement} panel - The action detail panel
     * @returns {HTMLInputElement|null} The input element or null if not found
     */
    function findActionInput(panel) {
        const inputContainer = panel.querySelector('[class*="maxActionCountInput"]');
        if (!inputContainer) {
            return null;
        }

        const inputField = inputContainer.querySelector('input');
        return inputField || null;
    }

    /**
     * Attach input listeners to an action panel for tracking value changes
     * Sets up three listeners:
     * - keyup: For manual typing
     * - input: For quick input button clicks (React dispatches input events)
     * - panel click: For any panel interactions with 50ms delay
     *
     * @param {HTMLElement} panel - The action detail panel
     * @param {HTMLInputElement} input - The input element
     * @param {Function} updateCallback - Callback function(value) called on input changes
     * @param {Object} options - Optional configuration
     * @param {number} options.clickDelay - Delay in ms for panel click handler (default: 50)
     * @returns {Function} Cleanup function to remove all listeners
     */
    function attachInputListeners(panel, input, updateCallback, options = {}) {
        const { clickDelay = 50 } = options;

        // Handler for keyup and input events
        const updateHandler = () => {
            updateCallback(input.value);
        };

        // Handler for panel clicks (with delay to allow React updates)
        const panelClickHandler = (event) => {
            // Skip if click is on the input box itself
            if (event.target === input) {
                return;
            }
            setTimeout(() => {
                updateCallback(input.value);
            }, clickDelay);
        };

        // Attach all listeners
        input.addEventListener('keyup', updateHandler);
        input.addEventListener('input', updateHandler);
        panel.addEventListener('click', panelClickHandler);

        // Return cleanup function
        return () => {
            input.removeEventListener('keyup', updateHandler);
            input.removeEventListener('input', updateHandler);
            panel.removeEventListener('click', panelClickHandler);
        };
    }

    /**
     * Perform initial update if input already has a valid value
     * @param {HTMLInputElement} input - The input element
     * @param {Function} updateCallback - Callback function(value) called if valid
     * @returns {boolean} True if initial update was performed
     */
    function performInitialUpdate(input, updateCallback) {
        if (input.value) {
            updateCallback(input.value);
            return true;
        }
        return false;
    }

    var actionPanelHelper = /*#__PURE__*/Object.freeze({
        __proto__: null,
        attachInputListeners: attachInputListeners,
        findActionInput: findActionInput,
        performInitialUpdate: performInitialUpdate
    });

    /**
     * Buff Parser Utilities
     * Parse active buffs from character data
     */


    /**
     * Get alchemy success rate bonus from active buffs
     * @returns {number} Alchemy success rate bonus (0-1, e.g., 0.087 for 8.7% multiplicative bonus)
     */
    function getAlchemySuccessBonus() {
        try {
            const characterData = dataManager.characterData;
            if (!characterData || !characterData.consumableActionTypeBuffsMap) {
                return 0;
            }

            const alchemyBuffs = characterData.consumableActionTypeBuffsMap['/action_types/alchemy'];
            if (!Array.isArray(alchemyBuffs)) {
                return 0;
            }

            let bonus = 0;
            for (const buff of alchemyBuffs) {
                if (buff.typeHrid === '/buff_types/alchemy_success') {
                    // ratioBoost is already scaled with drink concentration by the game
                    bonus += buff.ratioBoost || 0;
                }
            }

            return bonus;
        } catch (error) {
            console.error('[BuffParser] Failed to get alchemy success bonus:', error);
            return 0;
        }
    }

    var buffParser = /*#__PURE__*/Object.freeze({
        __proto__: null,
        getAlchemySuccessBonus: getAlchemySuccessBonus
    });

    /**
     * DOM Selector Constants
     * Centralized selector strings for querying game elements
     * If game class names change, update here only
     */

    /**
     * Game UI Selectors (class names from game code)
     */
    const GAME = {
        // Header
        TOTAL_LEVEL: '[class*="Header_totalLevel"]',

        // Settings Panel
        SETTINGS_PANEL_TITLE: '[class*="SettingsPanel_title"]',
        SETTINGS_TABS_CONTAINER: 'div[class*="SettingsPanel_tabsComponentContainer"]',
        TABS_FLEX_CONTAINER: '[class*="MuiTabs-flexContainer"]',
        TAB_PANELS_CONTAINER: '[class*="TabsComponent_tabPanelsContainer"]',
        TAB_PANEL: '[class*="TabPanel_tabPanel"]',

        // Game Panel
        GAME_PANEL: 'div[class*="GamePage_gamePanel"]',

        // Skill Action Detail
        SKILL_ACTION_DETAIL: '[class*="SkillActionDetail_skillActionDetail"]',
        SKILL_ACTION_NAME: '[class*="SkillActionDetail_name"]',
        ENHANCING_COMPONENT: 'div[class*="SkillActionDetail_enhancingComponent"]',

        // Action Queue
        QUEUED_ACTIONS: '[class*="QueuedActions_action"]',
        MAX_ACTION_COUNT_INPUT: '[class*="maxActionCountInput"]',

        // Tasks
        TASK_PANEL: '[class*="TasksPanel_taskSlotCount"]',
        TASK_LIST: '[class*="TasksPanel_taskList"]',
        TASK_CARD: '[class*="RandomTask_randomTask"]',
        TASK_NAME: '[class*="RandomTask_name"]',
        TASK_INFO: '[class*="RandomTask_taskInfo"]',
        TASK_ACTION: '[class*="RandomTask_action"]',
        TASK_REWARDS: '[class*="RandomTask_rewards"]',
        TASK_CONTENT: '[class*="RandomTask_content"]',
        TASK_NAME_DIV: 'div[class*="RandomTask_name"]',
        // Buttons within a task card. "Button_button" is the shared base class every
        // button carries, so it is paired with the variant class ("Button_buy"/
        // "Button_success") that actually distinguishes a claim button from any other.
        TASK_CLAIM_BUTTON: 'button[class*="Button_button"][class*="Button_buy"]',
        TASK_GO_BUTTON: 'button[class*="Button_success"]',
        // The Tasks panel's own <h1> title, used to anchor the sprite-warning banner
        TASKS_PANEL_TITLE: 'h1[class*="TasksPanel_title"]',

        // House Panel
        HOUSE_HEADER: '[class*="HousePanel_header"]',
        HOUSE_COSTS: '[class*="HousePanel_costs"]',
        HOUSE_ITEM_REQUIREMENTS: '[class*="HousePanel_itemRequirements"]',

        // Loot Log
        LOOT_LOG_CONTAINER: '[class*="LootLogPanel_actionLoots"]',
        // "actionLoot" is a prefix of "actionLoots" (the container above), so this
        // needs the trailing "__" — the point where the CSS-module hash begins — to
        // stay a single entry rather than also matching the whole container.
        LOOT_LOG_ENTRY: '[class*="LootLogPanel_actionLoot__"]',

        // Inventory
        INVENTORY_ITEMS: '[class*="Inventory_items"]',
        INVENTORY_CATEGORY_BUTTON: '[class*="Inventory_categoryButton"]',
        INVENTORY_LABEL: '[class*="Inventory_label"]',

        // Items
        ITEM_CONTAINER: '[class*="Item_itemContainer"]',
        // "Item_item" is a prefix of "Item_itemContainer" (above), so this needs the
        // trailing "__" too, or it would match every item container as well.
        ITEM_ITEM: '[class*="Item_item__"]',
        ITEM_COUNT: '[class*="Item_count"]',
        ITEM_TOOLTIP_TEXT: '[class*="ItemTooltipText_itemTooltipText"]',

        // Navigation/Experience Bars
        NAV_LEVEL: '[class*="NavigationBar_level"]',
        NAV_CURRENT_EXPERIENCE: '[class*="NavigationBar_currentExperience"]',

        // Enhancement
        PROTECTION_ITEM_INPUT: '[class*="protectionItemInputContainer"]',

        // Tooltips
        MUI_TOOLTIP: '.MuiTooltip-tooltip',
    };

    /**
     * Toolasha-specific selectors (our injected elements)
     */
    const TOOLASHA = {
        // Settings
        SETTINGS_TAB: '#toolasha-settings-tab',
        SETTING_WITH_DEPS: '.toolasha-setting[data-dependencies]',

        // Task features
        TASK_PROFIT: '.mwi-task-profit',
        REROLL_COST_DISPLAY: '.mwi-reroll-cost-display',
        TASK_STATS_BTN: '.toolasha-task-stats-btn',
        TASK_STATS_OVERLAY: '.toolasha-task-stats-overlay',

        // Action features
        QUEUE_TOTAL_TIME: '#mwi-queue-total-time',
        FORAGING_PROFIT: '#mwi-foraging-profit',
        PRODUCTION_PROFIT: '#mwi-production-profit',

        // House features
        HOUSE_PRICING: '.mwi-house-pricing',
        HOUSE_PRICING_EMPTY: '.mwi-house-pricing-empty',
        HOUSE_TOTAL: '.mwi-house-total',
        HOUSE_TO_LEVEL: '.mwi-house-to-level',

        // Profile/Combat Score
        SCORE_CLOSE_BTN: '#mwi-score-close-btn',
        SCORE_TOGGLE: '#mwi-score-toggle',
        SCORE_DETAILS: '#mwi-score-details',
        HOUSE_TOGGLE: '#mwi-house-toggle',
        HOUSE_BREAKDOWN: '#mwi-house-breakdown',
        ABILITY_TOGGLE: '#mwi-ability-toggle',
        ABILITY_BREAKDOWN: '#mwi-ability-breakdown',
        EQUIPMENT_TOGGLE: '#mwi-equipment-toggle',
        EQUIPMENT_BREAKDOWN: '#mwi-equipment-breakdown',

        // Market features
        MARKET_PRICE_INJECTED: '.market-price-injected',
        MARKET_PROFIT_INJECTED: '.market-profit-injected',
        MARKET_EV_INJECTED: '.market-ev-injected',
        MARKET_ENHANCEMENT_INJECTED: '.market-enhancement-injected',

        // UI features
        ALCHEMY_DIMMED: '.mwi-alchemy-dimmed',
        EXP_PERCENTAGE: '.mwi-exp-percentage',
        STACK_PRICE: '.mwi-stack-price',
        NETWORTH_HEADER: '.mwi-networth-header',

        // Enhancement
        ENHANCEMENT_STATS: '#mwi-enhancement-stats',

        // Generic
        COLLAPSIBLE_SECTION: '.mwi-collapsible-section',
        EXPANDABLE_HEADER: '.mwi-expandable-header',
        SECTION_HEADER_NEXT: '.mwi-section-header + div',

        // Legacy/cleanup markers
        INSERTED_SPAN: '.insertedSpan',
        SCRIPT_INJECTED: '.script-injected',
        CONSUMABLE_STATS_INJECTED: '.consumable-stats-injected',
    };

    /**
     * Enhancement-specific input IDs
     */
    const ENHANCEMENT = {
        TILL_LEVEL: '#tillLevel',
        TILL_LEVEL_INPUT: '#tillLevelInput',
        TILL_LEVEL_NUMBER: '#tillLevelNumber',
    };

    /**
     * Combat Sim Integration
     */
    const COMBAT_SIM = {
        GROUP_COMBAT_TAB: 'a#group-combat-tab',
        GET_PRICES_BUTTON: 'button#buttonGetPrices',
    };

    var selectors = /*#__PURE__*/Object.freeze({
        __proto__: null,
        COMBAT_SIM: COMBAT_SIM,
        ENHANCEMENT: ENHANCEMENT,
        GAME: GAME,
        TOOLASHA: TOOLASHA
    });

    /**
     * Experience Calculator
     * Shared utility for calculating experience per hour across features
     *
     * Calculates accurate XP/hour including:
     * - Base experience from action
     * - Experience multipliers (Wisdom + Charm Experience)
     * - Action time with speed bonuses
     * - Efficiency repeats (critical for accuracy)
     */


    /**
     * Calculate experience per hour for an action
     * @param {string} actionHrid - The action HRID (e.g., "/actions/cheesesmithing/cheese")
     * @returns {Object|null} Experience data or null if not applicable
     *   {
     *     expPerHour: number,           // Total XP per hour (with all bonuses)
     *     baseExp: number,              // Base XP per action
     *     modifiedXP: number,           // XP per action after multipliers
     *     actionsPerHour: number,       // Actions per hour (with efficiency)
     *     xpMultiplier: number,         // Total XP multiplier (Wisdom + Charm)
     *     actionTime: number,           // Time per action in seconds
     *     totalEfficiency: number       // Total efficiency percentage
     *   }
     */
    function calculateExpPerHour(actionHrid) {
        const actionDetails = dataManager.getActionDetails(actionHrid);

        // Validate action has experience gain
        if (!actionDetails || !actionDetails.experienceGain || !actionDetails.experienceGain.value) {
            return null;
        }

        // Get character data
        const skills = dataManager.getSkills();
        const { equipment } = resolveActionContext(actionDetails.type);
        const gameData = dataManager.getInitClientData();

        if (!gameData || !skills || !equipment) {
            return null;
        }

        // Calculate action stats (time + efficiency)
        const stats = calculateActionStats(actionDetails, {
            skills,
            equipment,
            itemDetailMap: gameData.itemDetailMap,
            includeCommunityBuff: true,
            includeBreakdown: false,
        });

        if (!stats) {
            return null;
        }

        const { actionTime, totalEfficiency } = stats;

        // Calculate actions per hour (base rate)
        const baseActionsPerHour = calculateActionsPerHour(actionTime);

        // Calculate average queued actions completed per time-consuming action
        // Efficiency gives guaranteed repeats + chance for extra
        const avgActionsPerBaseAction = calculateEfficiencyMultiplier(totalEfficiency);

        // Calculate actions per hour WITH efficiency (total completions including instant repeats)
        const actionsPerHourWithEfficiency = calculateEffectiveActionsPerHour(baseActionsPerHour, avgActionsPerBaseAction);

        // Calculate experience multiplier (Wisdom + Charm Experience)
        const skillHrid = actionDetails.experienceGain.skillHrid;
        const xpData = calculateExperienceMultiplier(skillHrid, actionDetails.type);

        // Calculate exp per hour with all bonuses
        const baseExp = actionDetails.experienceGain.value;
        const modifiedXP = baseExp * xpData.totalMultiplier;
        const expPerHour = actionsPerHourWithEfficiency * modifiedXP;

        return {
            expPerHour: Math.floor(expPerHour),
            baseExp,
            modifiedXP,
            actionsPerHour: actionsPerHourWithEfficiency,
            xpMultiplier: xpData.totalMultiplier,
            actionTime,
            totalEfficiency,
        };
    }

    /**
     * Calculate actions and time needed to reach a target level
     * Accounts for progressive efficiency gains (+1% per level)
     * @param {number} currentLevel - Current skill level
     * @param {number} currentXP - Current experience points
     * @param {number} targetLevel - Target skill level
     * @param {number} baseEfficiency - Starting efficiency percentage
     * @param {number} actionTime - Time per action in seconds
     * @param {number} xpPerAction - Modified XP per action (with multipliers, success rate, etc.)
     * @param {Object} levelExperienceTable - XP requirements per level
     * @returns {{ actionsNeeded: number, timeNeeded: number }}
     */
    function calculateMultiLevelProgress(
        currentLevel,
        currentXP,
        targetLevel,
        baseEfficiency,
        actionTime,
        xpPerAction,
        levelExperienceTable
    ) {
        let totalActions = 0;
        let totalTime = 0;

        for (let level = currentLevel; level < targetLevel; level++) {
            let xpNeeded;
            if (level === currentLevel) {
                xpNeeded = levelExperienceTable[level + 1] - currentXP;
            } else {
                xpNeeded = levelExperienceTable[level + 1] - levelExperienceTable[level];
            }

            // Progressive efficiency: +1% per level gained during grind
            const levelsGained = level - currentLevel;
            const progressiveEfficiency = baseEfficiency + levelsGained;
            const efficiencyMultiplier = 1 + progressiveEfficiency / 100;

            const xpPerPerformedAction = xpPerAction * efficiencyMultiplier;
            const baseActionsForLevel = Math.ceil(xpNeeded / xpPerPerformedAction);
            const actionsToQueue = Math.round(baseActionsForLevel * efficiencyMultiplier);
            totalActions += actionsToQueue;
            totalTime += baseActionsForLevel * actionTime;
        }

        return { actionsNeeded: totalActions, timeNeeded: totalTime };
    }

    var experienceCalculator = {
        calculateExpPerHour,
        calculateMultiLevelProgress,
    };

    var experienceCalculator$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateExpPerHour: calculateExpPerHour,
        calculateMultiLevelProgress: calculateMultiLevelProgress,
        default: experienceCalculator
    });

    /**
     * Ability Cost Calculator Utility
     * Calculates the cost to reach a specific ability level
     * Extracted from ability-book-calculator.js for reuse in combat score
     */


    /**
     * List of starter abilities that give 50 XP per book (others give 500)
     */
    const STARTER_ABILITIES = [
        'poke',
        'scratch',
        'smack',
        'quick_shot',
        'water_strike',
        'fireball',
        'entangle',
        'minor_heal',
    ];

    /**
     * Check if an ability is a starter ability (50 XP per book)
     * @param {string} abilityHrid - Ability HRID
     * @returns {boolean} True if starter ability
     */
    function isStarterAbility(abilityHrid) {
        return STARTER_ABILITIES.some((skill) => abilityHrid.includes(skill));
    }

    /**
     * What it costs to own an ability at a level, from nothing.
     *
     * The books to learn it plus the books to level it, at the book's market price —
     * which is what `explainAbilityLevelUpCost` already answers, starting from level
     * zero with zero XP.
     *
     * There used to be a `calculateAbilityCost` here that returned this number and
     * `0` when the book had no listing, so an unpriced ability was reported as free.
     * It is gone: `null` is the honest answer to "what does the market say", and
     * every caller now has to decide what to draw for it. See
     * `explainAbilityLevelUpCost` below.
     *
     * @param {string} abilityHrid - Ability HRID, e.g. `/abilities/fireball`
     * @param {number} targetLevel - Level being priced
     * @returns {Object} Same shape as `explainAbilityLevelUpCost`; `total` is null when unpriced
     */
    function explainAbilityCost(abilityHrid, targetLevel) {
        return explainAbilityLevelUpCost(abilityHrid, 0, 0, targetLevel);
    }

    /**
     * The same cost, itemised: which book, how many, at what price.
     *
     * An ability is levelled by reading books, not by buying a copy of itself at an
     * enhancement level — so a breakdown built from `resolveUpgradeBuyPrice` asks the
     * market for something that does not exist and comes back with "no price found"
     * for an ability anyone can buy books for today. This is what an ability upgrade
     * actually costs, in the terms it is actually paid in.
     *
     * @param {string} abilityHrid - Ability HRID, e.g. `/abilities/fireball`
     * @param {number} currentLevel - Level it is at now (0 = not learned)
     * @param {number} currentXp - XP it has now
     * @param {number} targetLevel - Level being priced
     * @returns {Object} `{ bookHrid, bookName, books, xpPerBook, bookPrice, total, learnBook }`,
     *   with `bookPrice` and `total` null when the book has no market listing
     */
    function explainAbilityLevelUpCost(abilityHrid, currentLevel, currentXp, targetLevel) {
        const gameData = dataManager.getInitClientData();
        const bookHrid = String(abilityHrid || '').replace('/abilities/', '/items/');
        const bookName =
            gameData?.itemDetailMap?.[bookHrid]?.name || bookHrid.split('/').pop().replace(/_/g, ' ') || 'ability book';
        const blank = { bookHrid, bookName, books: 0, xpPerBook: 0, bookPrice: null, total: null, learnBook: false };

        const levelXpTable = gameData?.levelExperienceTable;
        if (!levelXpTable) return blank;

        const targetXp = levelXpTable[targetLevel] || 0;
        const xpPerBook = isStarterAbility(abilityHrid) ? 50 : 500;

        let books = (targetXp - currentXp) / xpPerBook;
        // A book is spent learning the ability before any of them count as levels
        const learnBook = currentLevel === 0;
        if (learnBook) books += 1;

        const prices = marketAPI.getPrice(bookHrid, 0);
        // Match MCS behavior: if only one side of the order book exists, use it for both
        // (getPrice normalizes missing sides to null)
        let ask = prices?.ask ?? null;
        let bid = prices?.bid ?? null;
        if (ask != null && bid == null) bid = ask;
        if (bid != null && ask == null) ask = bid;
        if (ask == null || bid == null) return { ...blank, books, xpPerBook, learnBook };

        const bookPrice = (ask + bid) / 2;
        return { bookHrid, bookName, books, xpPerBook, bookPrice, total: books * bookPrice, learnBook };
    }

    var abilityCalc = /*#__PURE__*/Object.freeze({
        __proto__: null,
        explainAbilityCost: explainAbilityCost,
        explainAbilityLevelUpCost: explainAbilityLevelUpCost,
        isStarterAbility: isStarterAbility
    });

    /**
     * Shared UI Components
     *
     * Reusable UI component builders for MWI Tools
     */

    /**
     * Create a collapsible section with expand/collapse functionality
     * @param {string} icon - Icon/emoji for the section (optional, pass empty string to omit)
     * @param {string} title - Section title
     * @param {string} summary - Summary text shown when collapsed (optional)
     * @param {HTMLElement} content - Content element to show/hide
     * @param {boolean} defaultOpen - Whether section starts open (default: false)
     * @param {number} indent - Indentation level: 0 = root, 1 = nested, etc. (default: 0)
     * @returns {HTMLElement} Section container
     */
    function createCollapsibleSection(icon, title, summary, content, defaultOpen = false, indent = 0) {
        const section = document.createElement('div');
        section.className = 'mwi-collapsible-section';
        section.style.cssText = `
        margin-top: ${indent > 0 ? '4px' : '8px'};
        margin-bottom: ${indent > 0 ? '4px' : '8px'};
        margin-left: ${indent * 16}px;
    `;

        // Create header
        const header = document.createElement('div');
        header.className = 'mwi-section-header';
        header.style.cssText = `
        display: flex;
        align-items: center;
        cursor: pointer;
        user-select: none;
        padding: 4px 0;
        color: var(--text-color-primary, #fff);
        font-weight: ${indent === 0 ? '500' : '400'};
        font-size: ${indent > 0 ? '0.9em' : '1em'};
    `;

        const arrow = document.createElement('span');
        arrow.textContent = defaultOpen ? '▼' : '▶';
        arrow.style.cssText = `
        margin-right: 6px;
        font-size: 0.7em;
        transition: transform 0.2s;
    `;

        const label = document.createElement('span');
        if (icon) {
            // Emojis that need spacing fix (stopwatch has rendering issues in some browsers)
            const needsSpacingFix = icon === '⏱';
            if (needsSpacingFix) {
                label.innerHTML = `<span style="display: inline-block; margin-right: 0.25em;">${icon}</span> ${title}`;
            } else {
                label.textContent = `${icon} ${title}`;
            }
        } else {
            label.textContent = title;
        }

        header.appendChild(arrow);
        header.appendChild(label);

        // Create summary (shown when collapsed)
        const summaryDiv = document.createElement('div');
        summaryDiv.style.cssText = `
        margin-left: 16px;
        margin-top: 2px;
        color: var(--text-color-secondary, #888);
        font-size: 0.9em;
        display: ${defaultOpen ? 'none' : 'block'};
    `;
        if (summary) {
            summaryDiv.textContent = summary;
        }

        // Create content wrapper
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'mwi-section-content';
        contentWrapper.style.cssText = `
        display: ${defaultOpen ? 'block' : 'none'};
        margin-left: ${indent === 0 ? '16px' : '0px'};
        margin-top: 4px;
        color: var(--text-color-secondary, #888);
        font-size: 0.9em;
        line-height: 1.6;
        text-align: left;
    `;
        contentWrapper.appendChild(content);

        // Toggle functionality
        header.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event from bubbling to parent collapsible sections
            const isOpen = contentWrapper.style.display === 'block';
            contentWrapper.style.display = isOpen ? 'none' : 'block';
            if (summary) {
                summaryDiv.style.display = isOpen ? 'block' : 'none';
            }
            arrow.textContent = isOpen ? '▶' : '▼';
        });

        section.appendChild(header);
        if (summary) {
            section.appendChild(summaryDiv);
        }
        section.appendChild(contentWrapper);

        return section;
    }

    var uiComponents = {
        createCollapsibleSection,
    };

    var uiComponents$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        createCollapsibleSection: createCollapsibleSection,
        default: uiComponents
    });

    /**
     * React Input Utility
     * Handles programmatic updates to React-controlled input elements
     *
     * React uses an internal _valueTracker to detect changes. When setting
     * input values programmatically, we must manipulate this tracker to
     * ensure React recognizes the change and updates its state.
     */

    /**
     * Set value on a React-controlled input element
     * This is the critical pattern for making React recognize programmatic changes
     *
     * @param {HTMLInputElement} input - Input element (text, number, etc.)
     * @param {string|number} value - Value to set
     * @param {Object} options - Optional configuration
     * @param {boolean} options.focus - Whether to focus the input after setting (default: true)
     * @param {boolean} options.dispatchInput - Whether to dispatch input event (default: true)
     * @param {boolean} options.dispatchChange - Whether to dispatch change event (default: false)
     */
    function setReactInputValue(input, value, options = {}) {
        const { focus = true, dispatchInput = true, dispatchChange = false } = options;

        if (!input) {
            console.warn('[React Input] No input element provided');
            return;
        }

        // Save the current value
        const lastValue = input.value;

        // Set the new value directly on the DOM
        input.value = value;

        // This is the critical part: React stores an internal _valueTracker
        // We need to set it to the old value before dispatching the event
        // so React sees the difference and updates its state
        const tracker = input._valueTracker;
        if (tracker) {
            tracker.setValue(lastValue);
        }

        // Dispatch events based on options
        if (dispatchInput) {
            const inputEvent = new Event('input', { bubbles: true });
            inputEvent.simulated = true;
            input.dispatchEvent(inputEvent);
        }

        if (dispatchChange) {
            const changeEvent = new Event('change', { bubbles: true });
            changeEvent.simulated = true;
            input.dispatchEvent(changeEvent);
        }

        // Focus the input to show the value
        if (focus) {
            input.focus();
        }
    }

    /**
     * Check if an input element is React-controlled
     * React-controlled inputs have an internal _valueTracker property
     *
     * @param {HTMLInputElement} input - Input element to check
     * @returns {boolean} True if React-controlled
     */
    function isReactControlledInput(input) {
        return input && input._valueTracker !== undefined;
    }

    /**
     * Set value on a select element (non-React pattern, for completeness)
     *
     * @param {HTMLSelectElement} select - Select element
     * @param {string} value - Value to select
     * @param {boolean} dispatchChange - Whether to dispatch change event (default: true)
     */
    function setSelectValue(select, value, dispatchChange = true) {
        if (!select) {
            console.warn('[React Input] No select element provided');
            return;
        }

        // Find and select the option
        for (let i = 0; i < select.options.length; i++) {
            if (select.options[i].value === value) {
                select.options[i].selected = true;
                break;
            }
        }

        // Dispatch change event
        if (dispatchChange) {
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    /**
     * Set checked state on a checkbox/radio input (non-React pattern, for completeness)
     *
     * @param {HTMLInputElement} input - Checkbox or radio input
     * @param {boolean} checked - Checked state
     * @param {boolean} dispatchChange - Whether to dispatch change event (default: true)
     */
    function setCheckboxValue(input, checked, dispatchChange = true) {
        if (!input) {
            console.warn('[React Input] No input element provided');
            return;
        }

        input.checked = checked;

        // Dispatch change event
        if (dispatchChange) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    var reactInput = /*#__PURE__*/Object.freeze({
        __proto__: null,
        isReactControlledInput: isReactControlledInput,
        setCheckboxValue: setCheckboxValue,
        setReactInputValue: setReactInputValue,
        setSelectValue: setSelectValue
    });

    /**
     * Material Calculator Utility
     * Shared calculation logic for material requirements with artisan bonus
     */


    const ARTISAN_MATERIAL_MODE = {
        EXPECTED: 'expected',
        WORST_CASE: 'worst-case',
    };

    function normalizeArtisanMode(mode) {
        return mode === ARTISAN_MATERIAL_MODE.WORST_CASE
            ? ARTISAN_MATERIAL_MODE.WORST_CASE
            : ARTISAN_MATERIAL_MODE.EXPECTED;
    }

    /**
     * Get artisan material mode setting.
     * @returns {string}
     */
    function getArtisanMaterialMode() {
        const setting = config.getSettingValue('actions_artisanMaterialMode', ARTISAN_MATERIAL_MODE.EXPECTED);
        return normalizeArtisanMode(setting);
    }
    /**
     * Calculate total materials required, optionally using conservative per-action rounding.
     * @param {number} basePerAction
     * @param {number} artisanBonus
     * @param {number} numActions
     * @param {string} artisanMode
     * @returns {number}
     */
    function calculateTotalRequired(basePerAction, artisanBonus, numActions, artisanMode) {
        const materialsPerAction = basePerAction * (1 - artisanBonus);
        if (artisanMode === ARTISAN_MATERIAL_MODE.WORST_CASE) {
            return Math.ceil(materialsPerAction) * numActions;
        }
        return Math.ceil(materialsPerAction * numActions);
    }

    /**
     * Calculate materials reserved by queued actions
     * @param {string} actionHrid - Action HRID to check queue for (optional - if null, calculates for ALL queued actions)
     * @returns {Map<string, number>} Map of itemHrid -> queued quantity
     */
    function calculateQueuedMaterialsForAction(actionHrid = null) {
        const queuedMaterials = new Map();
        const gameData = dataManager.getInitClientData();

        if (!gameData) {
            return queuedMaterials;
        }

        // Get all queued actions
        const queuedActions = dataManager.getCurrentActions();

        if (!queuedActions || queuedActions.length === 0) {
            return queuedMaterials;
        }

        const artisanMode = getArtisanMaterialMode();

        // Process each queued action
        for (const queuedAction of queuedActions) {
            // If actionHrid is specified, only process matching actions
            if (actionHrid && queuedAction.actionHrid !== actionHrid) {
                continue;
            }

            const actionDetails = dataManager.getActionDetails(queuedAction.actionHrid);
            if (!actionDetails) {
                continue;
            }

            // Calculate remaining actions for this queued action
            // Finite actions: maxCount is target, currentCount is progress
            // Infinite actions: Skip for now (would require material limit calculation which is complex)
            let actionCount = 0;
            if (queuedAction.hasMaxCount) {
                actionCount = queuedAction.maxCount - queuedAction.currentCount;
            } else {
                // Infinite action - skip for now (materials for infinite actions are complex)
                // User can use the "Ignore queue" setting if they queue many infinite actions
                continue;
            }

            if (actionCount <= 0) {
                continue;
            }

            // Calculate artisan bonus for this action type
            const artisanBonus = calculateArtisanBonus(actionDetails);

            // Process regular input items
            if (actionDetails.inputItems && actionDetails.inputItems.length > 0) {
                for (const input of actionDetails.inputItems) {
                    const basePerAction = input.count || input.amount || 1;

                    // Calculate total materials needed for this queued action
                    const totalForAction = calculateTotalRequired(basePerAction, artisanBonus, actionCount, artisanMode);

                    // Add to queued total
                    const currentQueued = queuedMaterials.get(input.itemHrid) || 0;
                    queuedMaterials.set(input.itemHrid, currentQueued + totalForAction);
                }
            }

            // Process upgrade item (if exists)
            if (actionDetails.upgradeItemHrid) {
                // Upgrade items always need exactly 1 per action, no artisan reduction
                const totalForAction = actionCount;

                const currentQueued = queuedMaterials.get(actionDetails.upgradeItemHrid) || 0;
                queuedMaterials.set(actionDetails.upgradeItemHrid, currentQueued + totalForAction);
            }
        }

        return queuedMaterials;
    }

    /**
     * Calculate material requirements for an action
     * @param {string} actionHrid - Action HRID (e.g., "/actions/crafting/celestial_enhancer")
     * @param {number} numActions - Number of actions to perform
     * @param {boolean} accountForQueue - Whether to subtract queued materials from available inventory (default: false)
     * @returns {Array<Object>} Array of material requirement objects (includes upgrade items)
     */
    function calculateMaterialRequirements(actionHrid, numActions, accountForQueue = false) {
        const actionDetails = dataManager.getActionDetails(actionHrid);
        const inventory = dataManager.getInventory() || [];
        const gameData = dataManager.getInitClientData();

        if (!actionDetails) {
            return [];
        }

        const artisanMode = getArtisanMaterialMode();

        // Calculate artisan bonus (material reduction from Artisan Tea)
        const artisanBonus = calculateArtisanBonus(actionDetails);

        // Get queued materials if accounting for queue
        // Pass null to get materials for ALL queued actions (not just matching actionHrid)
        const queuedMaterialsMap = accountForQueue ? calculateQueuedMaterialsForAction(null) : new Map();

        const materials = [];

        // Process regular input items first
        if (actionDetails.inputItems && actionDetails.inputItems.length > 0) {
            for (const input of actionDetails.inputItems) {
                const basePerAction = input.count || input.amount || 1;

                // Calculate total materials needed for requested actions
                const totalRequired = calculateTotalRequired(basePerAction, artisanBonus, numActions, artisanMode);

                // Only count unenhanced items — enhanced copies are distinct items the player
                // would not want consumed as crafting materials
                const have = inventory
                    .filter((i) => i.itemHrid === input.itemHrid && !i.enhancementLevel)
                    .reduce((sum, i) => sum + (i.count || 0), 0);

                // Calculate queued and available amounts
                const queued = queuedMaterialsMap.get(input.itemHrid) || 0;
                const available = Math.max(0, have - queued);
                const missingAmount = Math.max(0, totalRequired - available);

                const itemDetails = gameData.itemDetailMap[input.itemHrid];
                if (!itemDetails) {
                    continue;
                }

                materials.push({
                    itemHrid: input.itemHrid,
                    itemName: itemDetails.name,
                    required: totalRequired,
                    have: have,
                    queued: queued,
                    available: available,
                    missing: missingAmount,
                    isTradeable: itemDetails.isTradable === true, // British spelling
                    isUpgradeItem: false,
                });
            }
        }

        // Process upgrade item at the end (if exists)
        if (actionDetails.upgradeItemHrid) {
            // Upgrade items always need exactly 1 per action, no artisan reduction
            const totalRequired = numActions;

            const have = inventory
                .filter((i) => i.itemHrid === actionDetails.upgradeItemHrid && !i.enhancementLevel)
                .reduce((sum, i) => sum + (i.count || 0), 0);

            // Calculate queued and available amounts
            const queued = queuedMaterialsMap.get(actionDetails.upgradeItemHrid) || 0;
            const available = Math.max(0, have - queued);
            const missingAmount = Math.max(0, totalRequired - available);

            const itemDetails = gameData.itemDetailMap[actionDetails.upgradeItemHrid];
            if (itemDetails) {
                materials.push({
                    itemHrid: actionDetails.upgradeItemHrid,
                    itemName: itemDetails.name,
                    required: totalRequired,
                    have: have,
                    queued: queued,
                    available: available,
                    missing: missingAmount,
                    isTradeable: itemDetails.isTradable === true, // British spelling
                    isUpgradeItem: true, // Flag to identify upgrade items
                });
            }
        }

        return materials;
    }

    /**
     * Calculate artisan bonus (material reduction) for an action
     * @param {Object} actionDetails - Action details from game data
     * @returns {number} Artisan bonus (0-1 decimal, e.g., 0.1129 for 11.29% reduction)
     */
    function calculateArtisanBonus(actionDetails) {
        try {
            const gameData = dataManager.getInitClientData();
            if (!gameData) {
                return 0;
            }

            const { equipment, drinks: activeDrinks } = resolveActionContext(actionDetails.type);
            const itemDetailMap = gameData.itemDetailMap || {};
            const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);

            return parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);
        } catch (error) {
            console.error('[Material Calculator] Error calculating artisan bonus:', error);
            return 0;
        }
    }

    /**
     * Returns true if artisan tea is selected in a drink slot but has 0 quantity in inventory.
     * Used to warn the user that material counts reflect no artisan reduction.
     * @param {string} actionHrid
     * @returns {boolean}
     */
    function isArtisanTeaOutOfStock(actionHrid) {
        try {
            const actionDetails = dataManager.getActionDetails(actionHrid);
            if (!actionDetails) return false;

            const gameData = dataManager.getInitClientData();
            if (!gameData) return false;

            const itemDetailMap = gameData.itemDetailMap || {};

            // Raw slotted drinks (ignoring stock)
            const rawDrinks = dataManager.getActionDrinkSlots(actionDetails.type);
            if (!rawDrinks?.length) return false;

            // In-stock drinks come from resolveActionContext (already filtered)
            const { equipment, drinks: inStockDrinks } = resolveActionContext(actionDetails.type);
            const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);

            return (
                parseArtisanBonus(rawDrinks, itemDetailMap, drinkConcentration) > 0 &&
                parseArtisanBonus(inStockDrinks, itemDetailMap, drinkConcentration) === 0
            );
        } catch (error) {
            console.error('[Material Calculator] Error checking artisan tea stock:', error);
            return false;
        }
    }

    /**
     * Calculate material requirements for enhancement actions
     * Uses Markov chain statistics to determine expected materials needed
     * @param {string} itemHrid - Item HRID being enhanced
     * @param {number} startLevel - Current enhancement level (0-19)
     * @param {number} targetLevel - Target enhancement level (1-20)
     * @param {string|null} protectionItemHrid - Protection item HRID or null
     * @param {number} protectFromLevel - Level at which protection begins (0 = never)
     * @returns {Array<Object>} Array of material requirement objects (same format as calculateMaterialRequirements)
     */
    function calculateEnhancementMaterialRequirements(
        itemHrid,
        startLevel,
        targetLevel,
        protectionItemHrid,
        protectFromLevel,
        repeatCount
    ) {
        const gameData = dataManager.getInitClientData();
        if (!gameData) {
            return [];
        }

        const itemDetails = gameData.itemDetailMap[itemHrid];
        if (!itemDetails) {
            return [];
        }

        const enhancementCosts = itemDetails.enhancementCosts || [];
        if (enhancementCosts.length === 0) {
            return [];
        }

        // Get enhancing parameters (level, tool bonus, teas, etc.)
        const params = getEnhancingParams();
        const effectiveProtect = protectFromLevel >= 2 && protectFromLevel <= targetLevel ? protectFromLevel : 0;

        // Single Markov chain call for the full level range
        const calc = calculateEnhancement({
            enhancingLevel: params.enhancingLevel,
            houseLevel: params.houseLevel,
            toolBonus: params.toolBonus,
            speedBonus: params.speedBonus,
            itemLevel: itemDetails.itemLevel || 1,
            targetLevel: targetLevel,
            startLevel: startLevel,
            protectFrom: effectiveProtect,
            blessedTea: params.teas.blessed,
            guzzlingBonus: params.guzzlingBonus,
        });

        const inventory = dataManager.getInventory() || [];
        const materials = [];

        // Process enhancement cost materials
        for (const cost of enhancementCosts) {
            // Skip coins — not tradeable, auto-deducted by the game
            if (cost.itemHrid === '/items/coin') {
                continue;
            }

            const matDetails = gameData.itemDetailMap[cost.itemHrid];
            if (!matDetails) {
                continue;
            }

            const totalQuantity = Math.ceil(cost.count * (repeatCount ?? calc.attempts));
            const have = inventory
                .filter((i) => i.itemHrid === cost.itemHrid && !i.enhancementLevel)
                .reduce((sum, i) => sum + (i.count || 0), 0);
            const missing = Math.max(0, totalQuantity - have);

            materials.push({
                itemHrid: cost.itemHrid,
                itemName: matDetails.name,
                required: totalQuantity,
                have: have,
                queued: 0,
                available: have,
                missing: missing,
                isTradeable: matDetails.isTradable === true,
                isUpgradeItem: false,
            });
        }

        // Add protection item if applicable
        // Skip Philosopher's Mirror — special mechanic, not consumed as standard protection
        if (calc.protectionCount > 0 && protectionItemHrid && protectionItemHrid !== '/items/philosophers_mirror') {
            const totalProtection = Math.ceil(calc.protectionCount);
            const protDetails = gameData.itemDetailMap[protectionItemHrid];

            if (protDetails) {
                const have = inventory
                    .filter((i) => i.itemHrid === protectionItemHrid && !i.enhancementLevel)
                    .reduce((sum, i) => sum + (i.count || 0), 0);
                const missing = Math.max(0, totalProtection - have);

                materials.push({
                    itemHrid: protectionItemHrid,
                    itemName: protDetails.name,
                    required: totalProtection,
                    have: have,
                    queued: 0,
                    available: have,
                    missing: missing,
                    isTradeable: protDetails.isTradable === true,
                    isUpgradeItem: false,
                });
            }
        }

        return materials;
    }

    var materialCalculator = /*#__PURE__*/Object.freeze({
        __proto__: null,
        ARTISAN_MATERIAL_MODE: ARTISAN_MATERIAL_MODE,
        calculateArtisanBonus: calculateArtisanBonus,
        calculateEnhancementMaterialRequirements: calculateEnhancementMaterialRequirements,
        calculateMaterialRequirements: calculateMaterialRequirements,
        calculateQueuedMaterialsForAction: calculateQueuedMaterialsForAction,
        isArtisanTeaOutOfStock: isArtisanTeaOutOfStock
    });

    /**
     * Pricing Helper Utility
     * Shared logic for selecting market prices based on pricing mode settings
     */


    /**
     * Select appropriate price from market data based on pricing mode settings
     * @param {Object} priceData - Market price data with bid/ask properties
     * @param {string} modeSetting - Config setting key for pricing mode (default: 'profitCalc_pricingMode')
     * @param {string} respectSetting - Config setting key for respect pricing mode flag (default: 'expectedValue_respectPricingMode')
     * @returns {number} Selected price (bid or ask)
     */
    function selectPrice(
        priceData,
        modeSetting = 'profitCalc_pricingMode',
        respectSetting = 'expectedValue_respectPricingMode'
    ) {
        if (!priceData) return 0;

        const pricingMode = config.getSettingValue(modeSetting, 'conservative');
        const respectPricingMode = config.getSettingValue(respectSetting, true);

        // If not respecting mode or mode is conservative/patientBuy, always use bid
        if (!respectPricingMode || pricingMode === 'conservative' || pricingMode === 'patientBuy') {
            return priceData.bid || 0;
        }

        // Hybrid/Optimistic: Use ask
        return priceData.ask || 0;
    }

    var pricingHelper = /*#__PURE__*/Object.freeze({
        __proto__: null,
        selectPrice: selectPrice
    });

    /**
     * Cleanup Registry Utility
     * Centralized registration for listeners, observers, timers, and custom cleanup.
     */

    /**
     * Create a cleanup registry for deterministic teardown.
     * @returns {{
     *   registerListener: (target: EventTarget, event: string, handler: Function, options?: Object) => void,
     *   registerObserver: (observer: MutationObserver|{ disconnect: Function }) => void,
     *   registerInterval: (intervalId: number) => void,
     *   registerTimeout: (timeoutId: number) => void,
     *   registerCleanup: (cleanupFn: Function) => void,
     *   cleanupAll: () => void
     * }} Cleanup registry API
     */
    function createCleanupRegistry() {
        const listeners = [];
        const observers = [];
        const intervals = [];
        const timeouts = [];
        const customCleanups = [];

        const registerListener = (target, event, handler, options) => {
            if (!target || !event || !handler) {
                console.warn('[CleanupRegistry] registerListener called with invalid arguments');
                return;
            }

            target.addEventListener(event, handler, options);
            listeners.push({ target, event, handler, options });
        };

        const registerObserver = (observer) => {
            if (!observer || typeof observer.disconnect !== 'function') {
                console.warn('[CleanupRegistry] registerObserver called with invalid observer');
                return;
            }

            observers.push(observer);
        };

        const registerInterval = (intervalId) => {
            if (!intervalId) {
                console.warn('[CleanupRegistry] registerInterval called with invalid interval id');
                return;
            }

            intervals.push(intervalId);
        };

        const registerTimeout = (timeoutId) => {
            if (!timeoutId) {
                console.warn('[CleanupRegistry] registerTimeout called with invalid timeout id');
                return;
            }

            timeouts.push(timeoutId);
        };

        const registerCleanup = (cleanupFn) => {
            if (typeof cleanupFn !== 'function') {
                console.warn('[CleanupRegistry] registerCleanup called with invalid function');
                return;
            }

            customCleanups.push(cleanupFn);
        };

        const cleanupAll = () => {
            listeners.forEach(({ target, event, handler, options }) => {
                try {
                    target.removeEventListener(event, handler, options);
                } catch (error) {
                    console.error('[CleanupRegistry] Failed to remove listener:', error);
                }
            });
            listeners.length = 0;

            observers.forEach((observer) => {
                try {
                    observer.disconnect();
                } catch (error) {
                    console.error('[CleanupRegistry] Failed to disconnect observer:', error);
                }
            });
            observers.length = 0;

            intervals.forEach((intervalId) => {
                try {
                    clearInterval(intervalId);
                } catch (error) {
                    console.error('[CleanupRegistry] Failed to clear interval:', error);
                }
            });
            intervals.length = 0;

            timeouts.forEach((timeoutId) => {
                try {
                    clearTimeout(timeoutId);
                } catch (error) {
                    console.error('[CleanupRegistry] Failed to clear timeout:', error);
                }
            });
            timeouts.length = 0;

            customCleanups.forEach((cleanupFn) => {
                try {
                    cleanupFn();
                } catch (error) {
                    console.error('[CleanupRegistry] Custom cleanup failed:', error);
                }
            });
            customCleanups.length = 0;
        };

        return {
            registerListener,
            registerObserver,
            registerInterval,
            registerTimeout,
            registerCleanup,
            cleanupAll,
        };
    }

    var cleanupRegistry = /*#__PURE__*/Object.freeze({
        __proto__: null,
        createCleanupRegistry: createCleanupRegistry
    });

    /**
     * House Cost Calculator Utility
     *
     * What it costs to build a house room up to a level, materials priced at the
     * market.
     *
     * ## Which side of the book
     *
     * The buy side — the ask. Every question asked of this is some form of "what
     * would it cost me to do this now": the Houses panel's affordability count, the
     * upgrade advisor, the equipment savings goals, the combat score's estimate of
     * what a character's rooms represent. Buying the materials is what any of those
     * would involve, and the ask is what buying costs.
     *
     * It used to price at the ask/bid midpoint, which is a defensible number for
     * nothing in particular and had the concrete cost that the same room was quoted
     * two different figures in two of this script's own panels — the advisor and the
     * savings row already asked for the ask. One side, and it is the one the money
     * actually leaves at.
     */


    /**
     * Calculate the total cost to build a house room to a specific level
     * @param {string} houseRoomHrid - House room HRID (e.g., '/house_rooms/dojo')
     * @param {number} currentLevel - Target level (1-8)
     * @returns {number} Total build cost in coins
     */
    function calculateHouseBuildCost(houseRoomHrid, currentLevel) {
        const gameData = dataManager.getInitClientData();
        if (!gameData) return 0;

        const houseRoomDetailMap = gameData.houseRoomDetailMap;
        if (!houseRoomDetailMap) return 0;

        const houseDetail = houseRoomDetailMap[houseRoomHrid];
        if (!houseDetail) return 0;

        const upgradeCostsMap = houseDetail.upgradeCostsMap;
        if (!upgradeCostsMap) return 0;

        let totalCost = 0;

        // Sum costs for all levels from 1 to current
        for (let level = 1; level <= currentLevel; level++) {
            const levelUpgrades = upgradeCostsMap[level];
            if (!levelUpgrades) continue;

            // Add cost for each material required at this level
            for (const item of levelUpgrades) {
                // Special case: Coins have face value of 1 (no market price)
                if (item.itemHrid === '/items/coin') {
                    const itemCost = item.count * 1;
                    totalCost += itemCost;
                    continue;
                }

                const prices = marketAPI.getPrice(item.itemHrid, 0);
                if (!prices) continue;

                // The buy side, because buying is the thing being costed. A book
                // with no ask still has a bid to go on — one side is a worse
                // estimate than two, but it is an estimate, and dropping the
                // material would understate the room by exactly that material
                // (getPrice normalizes missing sides to null)
                const price = prices.ask ?? prices.bid;
                if (price == null) continue;

                totalCost += item.count * price;
            }
        }

        return totalCost;
    }

    /**
     * Calculate total cost for all battle houses
     * @param {Object} characterHouseRooms - Map of character house rooms from profile data
     * @returns {Object} {totalCost, breakdown: [{name, level, cost}]}
     */
    function calculateBattleHousesCost(characterHouseRooms) {
        const battleHouses = ['dining_room', 'library', 'dojo', 'gym', 'armory', 'archery_range', 'mystical_study'];

        const gameData = dataManager.getInitClientData();
        if (!gameData) return { totalCost: 0, breakdown: [] };

        const houseRoomDetailMap = gameData.houseRoomDetailMap;
        if (!houseRoomDetailMap) return { totalCost: 0, breakdown: [] };

        let totalCost = 0;
        const breakdown = [];

        for (const [houseRoomHrid, houseData] of Object.entries(characterHouseRooms)) {
            // Check if this is a battle house
            const isBattleHouse = battleHouses.some((battleHouse) => houseRoomHrid.includes(battleHouse));

            if (!isBattleHouse) continue;

            const level = houseData.level || 0;
            if (level === 0) continue;

            const cost = calculateHouseBuildCost(houseRoomHrid, level);
            totalCost += cost;

            // Get human-readable name
            const houseDetail = houseRoomDetailMap[houseRoomHrid];
            const houseName = houseDetail?.name || houseRoomHrid.replace('/house_rooms/', '');

            breakdown.push({
                name: houseName,
                level: level,
                cost: cost,
            });
        }

        // Sort by cost descending
        breakdown.sort((a, b) => b.cost - a.cost);

        return { totalCost, breakdown };
    }

    var houseCostCalculator = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateBattleHousesCost: calculateBattleHousesCost,
        calculateHouseBuildCost: calculateHouseBuildCost
    });

    /**
     * Overlay Rows
     *
     * The registry of rows the overlay panel draws.
     *
     * Deliberately here in `utils` rather than beside the panel in `features/ui`,
     * because of how this project ships. The production build is six separate
     * bundles loaded in order — core, utils, market, actions, combat, ui — and a
     * module that is not declared shared is **copied into every bundle that imports
     * it**, each copy with its own state. A registry living in the UI bundle would
     * therefore give the combat features one row list, the market features another,
     * and the panel a third, so the panel would render nothing. Worse, ui loads
     * last, so a combat feature registering at module scope would be reaching for a
     * bundle that does not exist yet.
     *
     * Utils loads before every feature bundle and is declared shared in
     * `rollup.config.js`, so there is exactly one list and it exists before anyone
     * registers into it.
     *
     * None of this shows up in the dev standalone build, which is a single bundle
     * where every arrangement works.
     */

    /**
     * Rows, in registration order.
     *
     * Module-level so a feature can register while the shell is still asleep — the
     * alternative is every feature having to know whether the panel has started yet.
     * @type {Array<{key: string, name: string, render: Function, defaultVisible: boolean}>}
     */
    const rows$1 = [];

    /**
     * Add a row to the overlay.
     *
     * Safe to call before the panel exists, and safe to call twice — a repeated key
     * replaces the earlier definition rather than drawing the row twice, so a feature
     * that re-initialises does not double up.
     *
     * @param {Object} row - Row definition
     * @param {string} row.key - Stable identifier, used as the storage key
     * @param {string} row.name - Label in the row picker
     * @param {Function} row.render - `(container: HTMLElement) => void`, called per refresh
     * @param {boolean} [row.defaultVisible] - Whether it starts on
     * @param {Function} [row.onOpen] - Called when the row is double-clicked. A row is
     *   a summary; this is where the panel behind it opens. It should **toggle**,
     *   since the same gesture is what you reach for to dismiss what it summoned.
     *   Rows without one are simply not interactive.
     * @param {{width: number, height: number}} [row.defaultSize] - How large a tile the row
     *   needs before anyone has resized it. A row knows how much it draws; the panel
     *   does not, and guessing one size for all of them leaves half of them clipped.
     * @param {number} [row.defaultZoom] - Starting text size, as a percentage
     * @param {string} [row.empty] - What the tile says when the row draws nothing,
     *   and only where that is worth a whole tile — see {@link emptyPolicyFor}, which
     *   decides whether an empty tile says this, says its own name, or stands down.
     *   Defaults to naming the row.
     * @param {string} [row.tileClass] - One of {@link TILE_CLASS}. What kind of thing
     *   the tile shows, which is what decides how it behaves before it has anything
     *   to show. Optional: rows that do not say are classed by the table below.
     * @param {string} [row.whenEmpty] - `hide`, `compact` or `full`, when this
     *   particular row wants something other than what its class would give it.
     */
    function registerRow({
        key,
        name,
        render,
        defaultVisible = true,
        onOpen = null,
        defaultSize = null,
        defaultZoom = null,
        empty = '',
        tileClass = '',
        whenEmpty = '',
    }) {
        if (!key || typeof render !== 'function') {
            console.error('[OverlayPanel] A row needs a key and a render function:', key);
            return;
        }

        const definition = {
            key,
            name: name || key,
            render,
            defaultVisible,
            onOpen,
            defaultSize,
            defaultZoom,
            empty,
            tileClass,
            whenEmpty,
        };
        const existing = rows$1.findIndex((row) => row.key === key);
        if (existing >= 0) rows$1[existing] = definition;
        else rows$1.push(definition);
    }

    /**
     * The registered rows, in the order they should be offered.
     * Exported for tests and for anything that wants to know what is available.
     * @returns {Array<Object>} Row definitions
     */
    function registeredRows() {
        return [...rows$1];
    }

    /**
     * What kind of thing a tile shows.
     *
     * The distinction only matters in one place, and it is the place the overlay was
     * worst at: what a tile does before it has anything to show. A net worth that
     * has not been counted yet will be counted in a moment, and saying so is worth a
     * dim line. A dungeon run that has not happened may never happen, and a tile
     * reserving space for it is a tile in the way — every one of those placeholders
     * is a promise the overlay is making about a number it does not have.
     */
    const TILE_CLASS = {
        /** Reads state the game already has, so it fills itself in shortly */
        VALUE: 'value',
        /** Needs something to happen first — a fight, a run, a chest opened */
        MEASUREMENT: 'measurement',
        /** Shows what you asked it to watch, and is empty until you ask */
        WATCH: 'watch',
    };

    /** What a tile does when it has drawn nothing */
    const EMPTY_POLICY = {
        /** Whatever the tile's class says; the setting's default */
        AUTO: 'auto',
        /** Not drawn at all until there is something to draw */
        HIDE: 'hide',
        /** A dim strip carrying the tile's own name */
        COMPACT: 'compact',
        /** The row's full placeholder line, at the tile's full size */
        FULL: 'full',
    };

    /**
     * Every registered row's class.
     *
     * Here rather than in the `registerRow` calls because those live across a dozen
     * feature files owned by as many features, and the classification is one
     * judgement about the overlay as a whole — it wants to be readable in one place,
     * beside the curated default set it has to agree with. A row may still say for
     * itself with `tileClass`, and anything unlisted is treated as a value, which is
     * the forgiving answer: an unrecognised tile shows a dim name rather than
     * vanishing.
     */
    const TILE_CLASSES = {
        // Figures the game already knows, or knows as soon as it has loaded
        netWorth: TILE_CLASS.VALUE,
        coins: TILE_CLASS.VALUE,
        inventoryValue: TILE_CLASS.VALUE,
        marketListings: TILE_CLASS.VALUE,
        skillBooks: TILE_CLASS.VALUE,
        buildScore: TILE_CLASS.VALUE,
        combatLevel: TILE_CLASS.VALUE,
        houses: TILE_CLASS.VALUE,
        accountView: TILE_CLASS.VALUE,
        guildRoster: TILE_CLASS.VALUE,
        combatStatus: TILE_CLASS.VALUE,
        battleTimer: TILE_CLASS.VALUE,
        consumables: TILE_CLASS.VALUE,
        // The queue is state the game holds; the plan is state this script holds,
        // and both are true the moment they are read
        queueTimeLeft: TILE_CLASS.VALUE,
        goalNextStep: TILE_CLASS.VALUE,

        // Nothing to say until you have done something
        // Drop Luck and Over Expected % are one tile now, under luck's key
        luck: TILE_CLASS.MEASUREMENT,
        dps: TILE_CLASS.MEASUREMENT,
        combatRevenue: TILE_CLASS.MEASUREMENT,
        totalProfit: TILE_CLASS.MEASUREMENT,
        experiencePerHour: TILE_CLASS.MEASUREMENT,
        deathsPerHour: TILE_CLASS.MEASUREMENT,
        combatSession: TILE_CLASS.MEASUREMENT,
        manaPerFight: TILE_CLASS.MEASUREMENT,
        timeToLevel: TILE_CLASS.MEASUREMENT,
        treasure: TILE_CLASS.MEASUREMENT,
        charmValue: TILE_CLASS.MEASUREMENT,
        replayCheck: TILE_CLASS.MEASUREMENT,
        predictionCalibration: TILE_CLASS.MEASUREMENT,
        combatText: TILE_CLASS.MEASUREMENT,
        // Each waits on something being under way — an enhancement started, a task
        // board dealt, a trial tab looked at — and none of the three is a figure a
        // fresh character would ever see filled in
        enhancementSession: TILE_CLASS.MEASUREMENT,
        taskTokens: TILE_CLASS.MEASUREMENT,
        guildTrialsPace: TILE_CLASS.MEASUREMENT,

        // Empty until you put something in them
        watchlist: TILE_CLASS.WATCH,
        equipmentWatch: TILE_CLASS.WATCH,
    };

    /**
     * The tiles a character who has never arranged the overlay starts with.
     *
     * Small on purpose. Every row defaulting to on gave a first open that was a wall
     * of placeholders with three real figures buried in it, and a panel where
     * nothing is worth reading is a panel nobody opens twice. These are the ones
     * that are alive for any character within a minute of playing: what you are
     * worth, what you are carrying, what you are doing, and what it is earning. The
     * rest are one click away in ⚙, where a list of switched-off rows reads as a
     * menu rather than as clutter.
     *
     * Order is the order they are placed in, left to right and wrapping — so the
     * two figures that are true the moment the game loads come first.
     */
    const CURATED_ROWS = [
        'netWorth',
        'coins',
        'buildScore',
        'combatStatus',
        'battleTimer',
        'experiencePerHour',
        'totalProfit',
        'timeToLevel',
    ];

    /**
     * Which class a row belongs to.
     * @param {Object} row - A row definition
     * @returns {string} One of {@link TILE_CLASS}
     */
    function tileClassFor(row) {
        const declared = row?.tileClass;
        if (declared && Object.values(TILE_CLASS).includes(declared)) return declared;
        return TILE_CLASSES[row?.key] || TILE_CLASS.VALUE;
    }

    /**
     * What a tile that drew nothing should do about it.
     *
     * The setting wins where it has an opinion, so somebody who wants the old wall
     * of placeholders back — or wants every empty tile gone — says so once and is
     * obeyed everywhere. Left on `auto`, the class decides, and a watch tile decides
     * on top of that: "nothing watched" is only worth a line when there is something
     * you can do about it, which means the tile has to be able to open the panel you
     * would add to. A watch tile with no `onOpen` is a dead end, and stands down.
     *
     * @param {Object} row - A row definition
     * @param {string} [setting] - The panel's `emptyTiles` setting
     * @returns {string} `hide`, `compact` or `full`
     */
    function emptyPolicyFor(row, setting = EMPTY_POLICY.AUTO) {
        const forced = [EMPTY_POLICY.HIDE, EMPTY_POLICY.COMPACT, EMPTY_POLICY.FULL];
        if (forced.includes(setting)) return setting;
        if (forced.includes(row?.whenEmpty)) return row.whenEmpty;

        switch (tileClassFor(row)) {
            case TILE_CLASS.MEASUREMENT:
                return EMPTY_POLICY.HIDE;
            case TILE_CLASS.WATCH:
                return typeof row?.onOpen === 'function' ? EMPTY_POLICY.COMPACT : EMPTY_POLICY.HIDE;
            default:
                return EMPTY_POLICY.COMPACT;
        }
    }

    /**
     * What a compact tile says.
     *
     * Its own name, never its placeholder line. Two rows are allowed to have nothing
     * to report in the same words — "Nothing watched" belongs to both the watchlist
     * and the equipment watch, "No run measured yet" to both luck tiles — and two
     * identical strips sitting beside each other are worse than one, because now you
     * cannot even tell which feature is idle. A name is the one thing a tile has
     * that is its own.
     *
     * @param {Object} row - A row definition
     * @returns {string} The line to draw
     */
    function compactLabel(row) {
        const name = row?.name || row?.key || '';
        if (tileClassFor(row) === TILE_CLASS.WATCH && typeof row?.onOpen === 'function') return `${name} — click to add`;
        return name;
    }

    /**
     * What a tile is waiting for, in one short line.
     *
     * Only ever shown to somebody who has just switched the tile on by hand. The
     * auto-hiding policies above are the right *passive* default — a fresh character
     * should not open the overlay onto a wall of promises — but they are the wrong
     * answer to a gesture. Switching a tile on and watching nothing appear is not
     * "the overlay is decluttering for me", it is "the overlay is broken", and that
     * is exactly how it was reported. So the gesture gets an answer: the tile draws,
     * dim, saying what it is waiting for. The decluttering rationale survives intact
     * because nobody asked for the tiles it hides.
     *
     * @param {Object} row - A row definition
     * @returns {string} A line to draw under the row's name
     */
    function waitingLine(row) {
        switch (tileClassFor(row)) {
            case TILE_CLASS.MEASUREMENT:
                return 'waiting for data';
            case TILE_CLASS.WATCH:
                return typeof row?.onOpen === 'function' ? 'waiting for something to watch' : 'nothing watched yet';
            default:
                return 'waiting for the game to load this';
        }
    }

    /**
     * What a row promises about when it will appear, for the ⚙ list.
     *
     * The contract a tile is under ought to be legible *before* it is switched on,
     * not discovered afterwards by its absence. Empty for the tiles that fill
     * themselves in, because a caption on every chip is a caption nobody reads.
     *
     * @param {Object} row - A row definition
     * @returns {string} A short badge, or an empty string when there is nothing to warn about
     */
    function emptyContract(row) {
        switch (tileClassFor(row)) {
            case TILE_CLASS.MEASUREMENT:
                return 'shows when it has data';
            case TILE_CLASS.WATCH:
                return 'shows what you add to it';
            default:
                return '';
        }
    }

    /**
     * Put saved settings and the rows that actually exist together.
     *
     * Kept pure so the awkward cases are testable: a row saved in the order but since
     * removed from the code, and a row added by an update that no saved order has
     * heard of. The first must not leave a hole and the second must not be lost at
     * the bottom of a list nobody knows to look at.
     *
     * `curatedDefaults` is what tells a character who has never touched the overlay
     * from one who arranged it before the curated set existed. It is set once, when
     * the panel finds nothing saved, and persists — so an existing layout keeps
     * answering "is this row on?" the way it always did, with each row's own
     * `defaultVisible`, and only a fresh one gets {@link CURATED_ROWS}. A row the
     * settings have an explicit opinion about beats both.
     *
     * @param {Array<Object>} available - Registered rows
     * @param {Object} saved - `{ visible: {key: bool}, order: string[], curatedDefaults: bool }`
     * @returns {Array<Object>} Rows to draw, in order, each with `visible`
     */
    function resolveRows(available, saved) {
        const order = saved?.order || [];
        const visible = saved?.visible || {};
        const curated = saved?.curatedDefaults === true;

        const known = new Map(available.map((row) => [row.key, row]));
        const ordered = [];

        for (const key of order) {
            const row = known.get(key);
            // A key left over from a row that no longer exists
            if (!row) continue;
            ordered.push(row);
            known.delete(key);
        }
        // Anything the saved order has not heard of is new, and goes at the end
        ordered.push(...known.values());

        // Nobody has arranged anything yet, so the curated set is the arrangement:
        // its tiles first and in its order, which is what the initial packing lays
        // out. Sorting is stable, so everything else keeps registration order.
        if (curated && !order.length) {
            const rank = (key) => {
                const index = CURATED_ROWS.indexOf(key);
                return index < 0 ? CURATED_ROWS.length : index;
            };
            ordered.sort((a, b) => rank(a.key) - rank(b.key));
        }

        return ordered.map((row) => ({
            ...row,
            visible: visible[row.key] ?? (curated ? CURATED_ROWS.includes(row.key) : row.defaultVisible),
        }));
    }

    /**
     * Move a key one place through an order.
     *
     * Works on the full order rather than only the visible rows, so hiding a row and
     * showing it again does not quietly move it.
     *
     * @param {string[]} order - Current order
     * @param {string} key - What to move
     * @param {number} delta - -1 for up, 1 for down
     * @returns {string[]} A new order
     */
    function moveRow(order, key, delta) {
        const index = order.indexOf(key);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= order.length) return order;

        const next = [...order];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
    }

    /**
     * A tile's display option, as set in the overlay's own settings.
     *
     * Some tiles can be drawn more than one way — with or without the names beside
     * the figures, for one player or for the party — and OPanel keeps those choices
     * beside the row list rather than in a settings dialog, which is where somebody
     * arranging an overlay is already looking.
     *
     * Read through the global rather than imported: the panel that owns these lives
     * in the UI bundle and the rows that read them are scattered across the others,
     * so importing it would put a second copy of the panel in every one of them.
     *
     * @param {string} key - The option, e.g. `luckOnlyNumbers`
     * @returns {boolean} False when the panel is not up, which is the quiet default
     */
    function rowOption(key) {
        if (typeof window === 'undefined') return false;
        return Boolean(window.Toolasha?.UI?.overlayPanel?.settings?.[key]);
    }

    var overlayRows = /*#__PURE__*/Object.freeze({
        __proto__: null,
        CURATED_ROWS: CURATED_ROWS,
        EMPTY_POLICY: EMPTY_POLICY,
        TILE_CLASS: TILE_CLASS,
        compactLabel: compactLabel,
        emptyContract: emptyContract,
        emptyPolicyFor: emptyPolicyFor,
        moveRow: moveRow,
        registerRow: registerRow,
        registeredRows: registeredRows,
        resolveRows: resolveRows,
        rowOption: rowOption,
        tileClassFor: tileClassFor,
        waitingLine: waitingLine
    });

    /**
     * Overlay Layout
     *
     * Where each overlay row sits, how big it is, and how large it draws.
     *
     * The overlay started as a vertical stack, which is the wrong shape for what it
     * holds. A stack forces one ordering decision — what comes above what — when the
     * real question is what sits beside what: revenue next to profit, luck next to
     * expectation. OPanel solves this by making the body a canvas of freely placed
     * tiles, and this module is the arithmetic behind that.
     *
     * Kept pure and apart from the panel because layout is where the awkward cases
     * live — a row added by an update that no saved layout has heard of, a tile left
     * off the edge by a since-resized panel, a repack that has to fit tiles of
     * different heights. None of that is testable through the DOM in this project,
     * and all of it is testable here.
     *
     * The model is OPanel's, from MWI Combat Suite by Frotty (MIT) — see
     * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
     * Toolasha's own.
     */

    /** Everything snaps to this when snapping is on; OPanel's saved layouts are all multiples of it */
    const GRID = 10;

    /** What a row gets before anyone has moved or resized it */
    const DEFAULT_TILE = { width: 160, height: 30 };

    /** Percent of the panel's base font size; a tile can be made to read larger or smaller */
    const DEFAULT_ZOOM = 100;
    const MIN_ZOOM = 50;
    const MAX_ZOOM = 200;

    /** Below this a tile has no room for content, and becomes impossible to grab */
    const MIN_TILE = { width: 40, height: 20 };

    /**
     * How tall a tile is while it is standing down to a dim name.
     *
     * Height only. A compact tile keeps the width it was given, because tiles are
     * arranged in columns and a placeholder that also narrows breaks the column it
     * is sitting in — the layout you arranged comes back different every time a
     * feature goes quiet, which is worse than the space it saves.
     */
    const COMPACT_TILE = { height: 20 };

    /**
     * Round to the nearest grid step.
     * @param {number} value - Pixels
     * @param {number} [grid] - Step, or 1 to leave the value alone
     * @returns {number} Snapped pixels
     */
    function snap(value, grid = GRID) {
        if (!(grid > 1)) return Math.round(value);
        return Math.round(value / grid) * grid;
    }

    /**
     * Round up to the next grid step.
     *
     * For advancing past something rather than placing something: rounding the far
     * edge of a tile *down* to the grid puts the next tile back inside it, which is
     * an overlap of up to a step for every tile whose size is not a multiple of one.
     *
     * @param {number} value - Pixels
     * @param {number} [grid] - Step, or 1 to leave the value alone
     * @returns {number} Snapped pixels, never less than `value`
     */
    function snapUp(value, grid = GRID) {
        if (!(grid > 1)) return Math.ceil(value);
        return Math.ceil(value / grid) * grid;
    }

    /**
     * Do two tiles cover any of the same ground?
     * @param {{x: number, y: number, width: number, height: number}} a - One tile
     * @param {{x: number, y: number, width: number, height: number}} b - The other
     * @returns {boolean} True when they overlap
     */
    function overlaps(a, b) {
        return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    }

    /**
     * Find somewhere to put a tile that nothing else is already using.
     *
     * Scans left to right then top to bottom, which puts a new row where the eye
     * looks for it rather than in whatever gap happens to be largest. Falls back to
     * below everything when the canvas is genuinely full — a tile off the bottom can
     * be scrolled to, where a tile hidden under another cannot be found at all.
     *
     * @param {Array<Object>} placed - Tiles already positioned
     * @param {{width: number, height: number}} size - The tile to place
     * @param {number} width - Canvas width to wrap at
     * @param {number} [grid] - Step to search on
     * @returns {{x: number, y: number}} Somewhere free
     */
    function findFreeSpot(placed, size, width, grid = GRID) {
        const step = grid > 1 ? grid : GRID;
        const bottom = placed.reduce((max, tile) => Math.max(max, tile.y + tile.height), 0);

        for (let y = 0; y <= bottom; y += step) {
            for (let x = 0; x + size.width <= Math.max(width, size.width); x += step) {
                const candidate = { x, y, width: size.width, height: size.height };
                if (!placed.some((tile) => overlaps(candidate, tile))) return { x, y };
            }
        }
        return { x: 0, y: snap(bottom, step) };
    }

    /**
     * Keep a tile on the canvas.
     *
     * Only the left edge is held: the canvas scrolls downward, so a tile below the
     * fold is merely out of sight, while a tile past the right edge is unreachable
     * once the panel is narrowed. A tile wider than the canvas sits at zero rather
     * than at a negative offset.
     *
     * @param {{x: number, y: number}} position - Where it wants to be
     * @param {{width: number, height: number}} size - How big it is
     * @param {{width: number}} bounds - The canvas
     * @returns {{x: number, y: number}} Somewhere reachable
     */
    function clampTile(position, size, bounds) {
        const maxX = Math.max(0, bounds.width - size.width);
        return {
            x: Math.min(Math.max(0, position.x), maxX),
            y: Math.max(0, position.y),
        };
    }

    /**
     * Put the rows to be drawn together with the layout saved for them.
     *
     * A row that no saved layout knows about is placed rather than left at the
     * origin on top of an existing tile, because a fresh row hidden under an old one
     * reads as a row that failed to render.
     *
     * @param {Array<Object>} rows - Resolved, visible rows
     * @param {Object} layout - `{ positions, sizes, zoom }` keyed by row key
     * @param {number} width - Canvas width, for placing anything new
     * @param {Function} [sizeFor] - `(row, size) => size`, a last word on how big a
     *   tile is drawn this time round. For a tile standing down to a dim name: the
     *   size it was *given* is still the size it has, so shrinking it in the saved
     *   layout would lose the arrangement the moment a feature went quiet.
     * @returns {Array<Object>} Each row with `x`, `y`, `width`, `height`, `zoom`
     */
    function resolveLayout(rows, layout, width, sizeFor = null) {
        const positions = layout?.positions || {};
        const sizes = layout?.sizes || {};
        const zooms = layout?.zoom || {};

        const tiles = [];
        for (const row of rows) {
            const given = sizes[row.key] || row.defaultSize || DEFAULT_TILE;
            const size = sizeFor ? sizeFor(row, given) : given;
            const saved = positions[row.key];
            const spot = saved ? clampTile(saved, size, { width }) : findFreeSpot(tiles, size, width);

            tiles.push({
                ...row,
                x: spot.x,
                y: spot.y,
                width: size.width,
                height: size.height,
                zoom: clampZoom(zooms[row.key] ?? row.defaultZoom ?? DEFAULT_ZOOM),
            });
        }
        return tiles;
    }

    /**
     * Hold a zoom level inside what stays legible.
     * @param {number} zoom - Percent
     * @returns {number} Percent within range
     */
    function clampZoom(zoom) {
        if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
        return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
    }

    /**
     * Settle every tile upwards in its own column, closing gaps and collisions alike.
     *
     * For an imported layout rather than for one built here. A layout built here
     * cannot overlap — every drag is clamped as it happens — but a layout that came
     * from OPanel was measured against OPanel's rendering, and the same rows drawn
     * by this overlay are not the same size. Import it verbatim and tiles land on
     * top of one another; grow them to fit and push the collisions down, and the
     * layout stretches into a scatter with holes in it.
     *
     * So: gravity. Each tile falls to the highest position in its column that
     * nothing already occupies. Overlaps resolve because two tiles cannot settle in
     * the same place, and the gaps left by resizing close because a tile does not
     * stop at the gap it used to sit below.
     *
     * The column is held rather than searched. An OPanel layout is two columns, and
     * a tile that resolves a collision by sliding into the other one has not been
     * nudged, it has been scrambled — so a tile only ever moves vertically.
     *
     * @param {Array<Object>} tiles - Tiles with `key`, `x`, `y`, `width`, `height`
     * @param {number} width - Canvas width
     * @param {number} [grid] - Step to settle onto
     * @returns {Array<{key: string, x: number, y: number}>} Settled positions
     */
    function compactColumns(tiles, width, grid = GRID) {
        const step = grid > 1 ? grid : GRID;
        const placed = [];
        const positions = [];

        // Top to bottom, then left to right: a tile above another before should
        // still be above it after, since it gets to claim its place first
        const ordered = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);

        for (const tile of ordered) {
            const size = { width: tile.width, height: tile.height };
            const { x } = clampTile({ x: tile.x, y: tile.y }, size, { width });

            let y = 0;
            for (;;) {
                const candidate = { x, y, ...size };
                if (!placed.some((other) => overlaps(candidate, other))) break;
                y += step;
            }

            placed.push({ x, y, ...size });
            positions.push({ key: tile.key, x, y });
        }
        return positions;
    }

    /**
     * Repack every tile against the top-left, in order, wrapping at the canvas edge.
     *
     * Rows within a wrapped line share the height of the tallest, so a short tile
     * next to a tall one does not leave the next line interleaved with this one.
     * Sizes are left alone — this answers "where has everything gone", not "make
     * them all the same".
     *
     * @param {Array<Object>} tiles - Tiles in the order they should be laid out
     * @param {number} width - Canvas width
     * @param {number} [grid] - Step to align to
     * @returns {Array<{key: string, x: number, y: number}>} New positions
     */
    function autoGrid(tiles, width, grid = GRID) {
        const step = grid > 1 ? grid : 1;
        const positions = [];

        let x = 0;
        let y = 0;
        let lineHeight = 0;

        for (const tile of tiles) {
            // Wrapping on the first tile of a line would leave an empty line above it
            if (x > 0 && x + tile.width > width) {
                x = 0;
                // Up, not to the nearest: a tile 245 wide on a 10 grid ends at 245,
                // and a nearest-snap advance of 240 would start the next one five
                // pixels inside it. Rounding up costs at most a step of empty
                // space and can never overlap.
                y = snapUp(y + lineHeight, step);
                lineHeight = 0;
            }
            positions.push({ key: tile.key, x, y });
            x = snapUp(x + tile.width, step);
            lineHeight = Math.max(lineHeight, tile.height);
        }
        return positions;
    }

    /**
     * How much room the tiles actually need.
     *
     * The canvas is sized from this rather than from the panel, so dragging a tile
     * to the bottom extends the scroll instead of putting it out of reach.
     *
     * @param {Array<Object>} tiles - Placed tiles
     * @returns {{width: number, height: number}} Extent
     */
    function contentBounds(tiles) {
        let width = 0;
        let height = 0;
        for (const tile of tiles) {
            width = Math.max(width, tile.x + tile.width);
            height = Math.max(height, tile.y + tile.height);
        }
        return { width, height };
    }

    var overlayLayout = /*#__PURE__*/Object.freeze({
        __proto__: null,
        COMPACT_TILE: COMPACT_TILE,
        DEFAULT_TILE: DEFAULT_TILE,
        DEFAULT_ZOOM: DEFAULT_ZOOM,
        GRID: GRID,
        MAX_ZOOM: MAX_ZOOM,
        MIN_TILE: MIN_TILE,
        MIN_ZOOM: MIN_ZOOM,
        autoGrid: autoGrid,
        clampTile: clampTile,
        clampZoom: clampZoom,
        compactColumns: compactColumns,
        contentBounds: contentBounds,
        findFreeSpot: findFreeSpot,
        overlaps: overlaps,
        resolveLayout: resolveLayout,
        snap: snap,
        snapUp: snapUp
    });

    /**
     * Overlay row formatting
     *
     * How a tile reads, in one place.
     *
     * Tiles are small and fixed. Anything that wraps does not get taller — it gets
     * cut off, or pushes the rest of the tile out of sight — so **nothing in a row
     * may wrap**, and a value too long for its tile has to be shortened rather than
     * folded. Every row was doing that for itself, differently, which is how the
     * overlay ended up with "Drop luck" broken across two lines beside a figure that
     * had run off the edge.
     *
     * The other half is what a row says. A tile is read at a glance from three feet
     * away, so the unit belongs on the value — `260,572 exp/hr` rather than
     * `Experience` on the left and `260,572/hr` on the right. Half the label was
     * saying what the number's own unit already said, in the space the number needed.
     *
     * The style is OPanel's, from MWI Combat Suite by Frotty (MIT) — see
     * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
     * Toolasha's own.
     */

    /**
     * The game's own sprite sheets, found once each.
     *
     * Read off an existing icon rather than hardcoded: the URL carries a build hash
     * that changes with every game update, so a constant would be right until the
     * next Tuesday and silently wrong after it.
     */
    const spriteSheets = {};

    /**
     * A sprite sheet's URL, or an empty string before the game has drawn from it.
     *
     * @param {string} [sheet] - `items`, `skills`, `actions`, `combat_monsters`
     * @returns {string}
     */
    function spriteUrl(sheet = 'items') {
        if (spriteSheets[sheet]) return spriteSheets[sheet];

        const use = document.querySelector(`svg use[href*="${sheet}_sprite"]`);
        const found = use?.getAttribute('href')?.split('#')[0] || '';
        // Not cached when it came back empty — the game may simply not have drawn
        // from this sheet yet, and one empty answer should not be the answer forever
        if (found) spriteSheets[sheet] = found;
        return found;
    }

    /**
     * The item sheet, kept as its own name because most callers only want that one.
     * @returns {string}
     */
    function itemSpriteUrl() {
        return spriteUrl('items');
    }

    /**
     * One sprite, from whichever sheet holds it.
     *
     * @param {string} id - The sprite's id, or an hrid whose last segment is one
     * @param {number} [size] - Pixels
     * @param {string} [sheet] - Which sheet
     * @returns {SVGElement|HTMLElement} An icon, or a spacer while the sheet is unknown
     */
    function spriteIcon(id, size = 18, sheet = 'items') {
        const sprite = spriteUrl(sheet);
        if (!sprite) {
            // A spacer rather than nothing, so a row of icons does not reflow the
            // moment the sheet turns up
            const spacer = document.createElement('span');
            Object.assign(spacer.style, { width: `${size}px`, flex: '0 0 auto', display: 'inline-block' });
            return spacer;
        }

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.style.flex = '0 0 auto';

        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `${sprite}#${String(id).split('/').pop()}`);
        svg.appendChild(use);
        return svg;
    }

    /**
     * An item's icon.
     * @param {string} itemHrid - Item to draw
     * @param {number} [size] - Pixels
     * @returns {SVGElement|HTMLElement} An icon, or a spacer while the sheet is unknown
     */
    function itemIcon(itemHrid, size = 18) {
        return spriteIcon(itemHrid, size, 'items');
    }

    /**
     * A skill's icon.
     *
     * The sheet OPanel and JHouse draw their headings from — a house room is
     * recognised by the skill it boosts far faster than by its name.
     *
     * @param {string} skill - `milking`, `attack`, and so on
     * @param {number} [size] - Pixels
     * @returns {SVGElement|HTMLElement}
     */
    function skillIcon(skill, size = 18) {
        return spriteIcon(skill, size, 'skills');
    }

    /**
     * Make an element open an item's marketplace listing when clicked.
     *
     * Applied to icons and names rather than to a separate button, because the icon
     * and the name are what you point at when you think "what does that cost" — and
     * a row about consumables is read while deciding whether to go and buy some.
     *
     * @param {HTMLElement} element - Icon or name
     * @param {string} itemHrid - Item to open
     * @param {Function} navigate - `(itemHrid) => void`, injected so this file stays DOM-only
     */
    function linkToMarketplace(element, itemHrid, navigate) {
        if (!element || !itemHrid) return;

        element.style.cursor = 'pointer';
        element.title = 'Open in the marketplace';
        element.addEventListener('click', (event) => {
            // Stopped, or the click reaches the tile behind and counts towards a
            // double-click that would toggle the panel shut under you
            event.stopPropagation();
            try {
                navigate(itemHrid);
            } catch (error) {
                console.error('[OverlayFormat] Opening the marketplace failed:', error);
            }
        });
    }

    /** The palette every row draws from, so two rows never disagree about what green means */
    const ROW_COLORS = {
        good: '#4ade80',
        bad: '#f87171',
        neutral: '#e8ecf5',
        dim: 'rgba(232, 236, 245, 0.55)',
        accent: '#9ec4ff',
        gold: '#ffcf5c',
        violet: '#c9a0ff',
    };

    /**
     * The overlay's glyphs, in one place, following OPanel's vocabulary.
     *
     * A tile has room for a symbol or a word, not both, so the symbol has to carry
     * the label — which only works if it means the same thing everywhere. These were
     * chosen per file before, so a coin was 🪙 in one row and 💰 in another and the
     * overlay read as several tools stacked up rather than one.
     *
     * Matched to OPanel where OPanel has an opinion, because the two sit side by
     * side on the same screen and a reader should not have to learn two alphabets.
     * Where it does not — it draws some of these as game sprites rather than text —
     * the nearest emoji is used.
     */
    const GLYPHS = {
        /** Coins in hand */
        coin: '🪙',
        /** Market value, listings, anything priced */
        market: '📈',
        /** Bid orders waiting to fill */
        bid: '📦',
        /** The inventory as a whole */
        inventory: '🎒',
        /** Chests and other openables */
        chest: '🎁',
        /** Ability books */
        books: '📖',
        /** Mana */
        mana: '💧',
        /** Food and drink */
        consumable: '🍴',
        /** Damage dealt */
        dealt: '⚔',
        /** Damage taken */
        taken: '🛡',
        /** Watched items */
        watch: '👁',
        /** Locked and unlocked, as the overlay's own header uses them */
        locked: '🔒',
        unlocked: '🔓',
        /** Settings */
        settings: '⚙',
        /** Close */
        close: '✖',
        /** Something is wrong with the figure rather than with the run */
        warning: '⚠',
    };

    /**
     * The glyphs the game itself has artwork for.
     *
     * OPanel draws these as sprites rather than as text, and beside the game's own
     * UI that is the difference between a row that belongs on the screen and one
     * that looks pasted on: an emoji is whatever font the browser picked, at
     * whatever weight, in whatever palette its designer chose. The game's coin is
     * *the* coin.
     *
     * Only the ones the game actually draws. A bid order and a market trend are
     * concepts rather than objects, so they have no sprite and stay as emoji — which
     * is what OPanel does with them too.
     */
    const GLYPH_SPRITES = {
        coin: { id: 'coin', sheet: 'items' },
        chest: { id: 'chimerical_chest', sheet: 'items' },
        books: { id: 'ability_book', sheet: 'items' },
        consumable: { id: 'cooking', sheet: 'skills' },
        mana: { id: 'intelligence', sheet: 'skills' },
        dealt: { id: 'attack', sheet: 'skills' },
        taken: { id: 'defense', sheet: 'skills' },
    };

    /**
     * A glyph as a row segment: the game's own artwork where it has some, the emoji
     * where it does not.
     *
     * Falls back on its own, so a caller never has to know which is which — and a
     * sheet the game has not drawn from yet produces a spacer rather than a gap that
     * shifts everything when it arrives.
     *
     * @param {string} name - A key of `GLYPHS`
     * @param {number} [size] - Pixels, for the sprite form
     * @returns {Object} A segment for `row` or `rows`
     */
    function glyph(name, size = 16) {
        const sprite = GLYPH_SPRITES[name];
        if (sprite && spriteUrl(sprite.sheet)) return { icon: sprite.id, sheet: sprite.sheet, size };

        return { text: GLYPHS[name] || '' };
    }

    /**
     * A piece of a line.
     * @typedef {Object} Segment
     * @property {string} [text] - What it says
     * @property {string} [icon] - An item hrid, or any sprite id, to draw instead of text
     * @property {string} [sheet] - Which sprite sheet `icon` is on; items by default
     * @property {number} [size] - Icon size in pixels
     * @property {string} [color] - From `ROW_COLORS`, or any CSS colour
     * @property {boolean} [bold] - Emphasis
     * @property {boolean} [ellipsis] - This is the piece that gives way when the tile is too narrow
     * @property {boolean} [push] - Push this and everything after it to the right
     */

    /**
     * Draw one line of segments into an element.
     *
     * Exactly one piece should be marked `ellipsis` — a name, usually. Everything
     * else keeps its full width, because a truncated number is not a smaller number,
     * it is a wrong one.
     *
     * @param {HTMLElement} host - Where to draw
     * @param {Segment[]} segments - The line
     */
    function drawLine(host, segments) {
        // Text on a line together is aligned on its baseline, which is what makes a
        // row of figures read as a row. An icon has no baseline: it is a box, and
        // against baselined text it sits low and drags the line's height with it.
        // So a line carrying one is centred instead — the box and the numbers are
        // then aligned on the only thing they share, their middles.
        const hasIcon = segments.some((segment) => segment?.icon);

        Object.assign(host.style, {
            display: 'flex',
            alignItems: hasIcon ? 'center' : 'baseline',
            gap: '5px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
        });

        for (const segment of segments) {
            if (!segment) continue;

            // An item's own icon says which item without spending the width a name
            // costs, which is the only reason a forty-pixel tile can name one at all
            if (segment.icon) {
                const icon = spriteIcon(segment.icon, segment.size || 16, segment.sheet || 'items');
                if (segment.push) icon.style.marginLeft = 'auto';
                host.appendChild(icon);
                continue;
            }

            const span = document.createElement('span');
            span.textContent = segment.text;
            if (segment.color) span.style.color = segment.color;
            if (segment.bold) span.style.fontWeight = 'bold';
            if (segment.push) span.style.marginLeft = 'auto';

            if (segment.ellipsis) {
                Object.assign(span.style, { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' });
            } else {
                // Never allowed to shrink: a number squeezed to "1.2…" reads as a
                // number rather than as a truncation
                span.style.flex = '0 0 auto';
            }

            host.appendChild(span);
        }
    }

    /**
     * Draw a tile as one line.
     *
     * @param {HTMLElement} container - The row's container
     * @param {Segment[]} segments - The line
     * @param {Object} [options] - Layout
     * @param {boolean} [options.center] - Centre the line rather than filling the
     *   tile. Right for a tile whose pieces belong together — an icon, a count and
     *   a price read as one phrase, and pushing the price to the far edge of a
     *   resized tile puts a gap in the middle of it.
     */
    function row(container, segments, { center = false } = {}) {
        container.replaceChildren();
        container.style.flexDirection = '';
        drawLine(container, segments);
        container.style.justifyContent = center ? 'center' : '';
    }

    /**
     * Draw a tile as several lines.
     *
     * By default each line is laid out independently, which is right when the lines
     * are different facts — an income line above a cost line has no columns to
     * agree about.
     *
     * `align` is for when they *are* a table: a row per player and then a total is
     * the same measurement three times, and a figure that sits a few pixels off the
     * one above it makes a reader check whether it is the same kind of number. The
     * lines share columns then, the first stretching and the rest sized to their
     * contents against the right edge.
     *
     * @param {HTMLElement} container - The row's container
     * @param {Segment[][]} lines - One array of segments per line
     * @param {Object} [options] - Layout
     * @param {boolean} [options.align] - Share columns between the lines
     */
    function rows(container, lines, { align = false } = {}) {
        container.replaceChildren();

        const drawn = lines.filter((segments) => segments?.length);
        // An icon has no width until it loads, so it cannot size a column; those
        // tiles keep the independent layout, where nothing depends on its width
        const alignable = align && !drawn.some((segments) => segments.some((segment) => segment?.icon));

        if (alignable) return alignedRows(container, drawn);

        Object.assign(container.style, {
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            lineHeight: '1.3',
            overflow: 'hidden',
        });

        for (const segments of drawn) {
            const line = document.createElement('div');
            drawLine(line, segments);
            container.appendChild(line);
        }
    }

    /**
     * The lines as a grid, so every column lines up.
     *
     * The first column takes the slack and the rest are as wide as their widest
     * cell, which puts the figures in a column against the right edge whether or
     * not every line has the same number of them. `push` is ignored here — the
     * stretching first column already does what it was for.
     *
     * @param {HTMLElement} container - The row's container
     * @param {Segment[][]} lines - One array of segments per line
     */
    function alignedRows(container, lines) {
        const columns = Math.max(...lines.map((segments) => segments.length), 1);

        Object.assign(container.style, {
            display: 'grid',
            gridTemplateColumns: `minmax(0, 1fr)${' auto'.repeat(Math.max(columns - 1, 0))}`,
            // From the top, not centred. These tiles sit in a row beside each other
            // and carry different numbers of lines — DPS has a player and a total,
            // Luck has one line — and centring puts the single line of one tile
            // halfway down the two lines of the next. Aligned to the top, the first
            // line of every one of them is at the same height.
            alignContent: 'start',
            columnGap: '5px',
            lineHeight: '1.3',
            overflow: 'hidden',
            // Digits of one width, so a column of figures is a column rather than a
            // ragged edge that shifts as the numbers change
            fontVariantNumeric: 'tabular-nums',
        });

        for (const segments of lines) {
            for (let index = 0; index < columns; index += 1) {
                const segment = segments[index];
                const span = document.createElement('span');

                if (segment) {
                    span.textContent = segment.text;
                    if (segment.color) span.style.color = segment.color;
                    if (segment.bold) span.style.fontWeight = 'bold';
                }

                Object.assign(span.style, {
                    // The first column holds a name and is the one that may be cut;
                    // a figure squeezed to "1.2…" reads as a number rather than as
                    // a truncation
                    textAlign: index === 0 ? 'left' : 'right',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: index === 0 ? 'ellipsis' : 'clip',
                    minWidth: '0',
                });

                container.appendChild(span);
            }
        }
    }

    /** Draw nothing, for a row with nothing to say yet */
    function blank(container) {
        container.replaceChildren();
    }

    /**
     * A signed percentage, and what colour it should be.
     *
     * The band matters as much as the sign: everything sits a percent or two off
     * whatever it is being compared with, and colouring that makes a row into a
     * light that is always on.
     *
     * @param {number} percent - Signed percentage
     * @param {number} [band] - How far from zero counts as news
     * @returns {{text: string, color: string}}
     */
    function signedPercent(percent, band = 5) {
        const text = `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
        if (percent > band) return { text, color: ROW_COLORS.good };
        if (percent < -band) return { text, color: ROW_COLORS.bad };
        return { text, color: ROW_COLORS.dim };
    }

    /**
     * A duration short enough to sit in a tile.
     *
     * `timeReadable` writes "71 days 9h 55m", which is right in a tooltip and wrong
     * in a tile forty pixels wide — it pushed the label it sat beside down to a
     * single letter. Two units at most, and the small one drops off once the large
     * one is big enough to make it noise.
     *
     * @param {number} seconds - Duration
     * @returns {string} e.g. `45s`, `12m`, `3h 20m`, `4d 16h`, `71d`
     */
    function shortDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '—';

        if (seconds < 60) return `${Math.round(seconds)}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;

        if (seconds < 86400) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
        }

        const days = Math.floor(seconds / 86400);
        // Past a month the hours are noise beside the days, and the space they take
        // is the space the label beside them needs
        if (days >= 30) return `${days}d`;

        const hours = Math.floor((seconds % 86400) / 3600);
        return hours ? `${days}d ${hours}h` : `${days}d`;
    }

    var overlayFormat = /*#__PURE__*/Object.freeze({
        __proto__: null,
        GLYPHS: GLYPHS,
        ROW_COLORS: ROW_COLORS,
        blank: blank,
        drawLine: drawLine,
        glyph: glyph,
        itemIcon: itemIcon,
        itemSpriteUrl: itemSpriteUrl,
        linkToMarketplace: linkToMarketplace,
        row: row,
        rows: rows,
        shortDuration: shortDuration,
        signedPercent: signedPercent,
        skillIcon: skillIcon,
        spriteIcon: spriteIcon,
        spriteUrl: spriteUrl
    });

    /**
     * Order book reading
     *
     * How deep a price level is, and how long an order placed there would wait.
     *
     * The game sends an order book with each listing's creation timestamp, and those
     * timestamps are the only rate signal available anywhere: twenty listings at one
     * price spanning ten minutes is a level that churns, and twenty spanning a week
     * is a level where an order is a week-long proposition.
     *
     * ## The assumption, stated
     *
     * Fill time is estimated as **depth ahead ÷ the rate at which depth arrived**.
     * That is the steady-state assumption — that a price level drains about as fast
     * as it fills — which holds in a liquid market and fails in a moving one. It is
     * the honest reading of what the data can support: the book says how fast orders
     * *arrive*, and nothing directly says how fast they are *taken*.
     *
     * The queue extrapolation is Ranged Way Idle's, by way of the queue length
     * estimator this shares its arithmetic with.
     */

    /** The book only ever sends this many listings per side */
    const VISIBLE_LISTINGS = 20;

    /**
     * The best price on one side of the book.
     *
     * Listings arrive best-first, so this is simply the head — but reading it
     * through a function keeps the assumption in one place rather than in every
     * caller that indexes `[0]`.
     *
     * @param {Array<Object>} listings - One side of the book
     * @returns {number|null} The price, or null when the side is empty
     */
    function bestPrice(listings) {
        const price = listings?.[0]?.price;
        return price > 0 ? price : null;
    }

    /**
     * How much sits at a price, extrapolating past the twenty the game shows.
     *
     * When all twenty visible listings share the best price, the level is deeper
     * than the window and the timestamps are used to guess by how much — the same
     * extrapolation the queue length display makes, so the two never disagree.
     *
     * @param {Array<Object>} listings - One side of the book
     * @param {number} price - The price level to measure
     * @returns {{quantity: number, estimated: boolean, spanMs: number}} Depth at that price
     */
    function queueAt(listings, price) {
        const rows = listings || [];

        let quantity = 0;
        for (const listing of rows) {
            if (listing?.price === price) quantity += listing.quantity || 0;
        }

        // Fewer than a full window means the level is fully visible, and the count
        // is a fact rather than an estimate
        if (rows.length < VISIBLE_LISTINGS || rows[VISIBLE_LISTINGS - 1]?.price !== price) {
            return { quantity, estimated: false, spanMs: listingSpanMs(rows) };
        }

        const spanMs = listingSpanMs(rows);
        if (!(spanMs > 0)) return { quantity, estimated: false, spanMs };

        // Nothing has arrived since the newest listing when it arrived a moment ago,
        // which extrapolates to exactly the visible depth — a real answer, not an
        // inapplicable one, so it still counts as estimated
        const sinceLast = Math.max(0, Date.now() - new Date(rows[VISIBLE_LISTINGS - 1].createdTimestamp).getTime());

        // Ranged Way Idle's formula: the window covers a known stretch of time, and
        // the rest of the queue is assumed to have arrived at the same rate
        const multiplier = 1 + ((VISIBLE_LISTINGS - 1) / VISIBLE_LISTINGS) * (sinceLast / spanMs);
        return { quantity: quantity * multiplier, estimated: true, spanMs };
    }

    /**
     * How long the visible listings took to accumulate.
     * @param {Array<Object>} listings - One side of the book
     * @returns {number} Milliseconds, or 0 when it cannot be told
     */
    function listingSpanMs(listings) {
        const rows = listings || [];
        if (rows.length < 2) return 0;

        const first = new Date(rows[0]?.createdTimestamp).getTime();
        const last = new Date(rows[rows.length - 1]?.createdTimestamp).getTime();
        const span = Math.abs(last - first);
        return Number.isFinite(span) ? span : 0;
    }

    /**
     * How long an order joining the back of a queue would wait.
     *
     * Depth ahead divided by the rate depth arrived at — see the note at the top of
     * this file for why that is the rate being used and what it assumes. Returns
     * null rather than a guess when the book gives nothing to measure, so a caller
     * can tell "slow" apart from "unknown".
     *
     * @param {Array<Object>} listings - The side the order would join
     * @param {number} count - How many the order is for
     * @returns {number|null} Seconds, or null when unmeasurable
     */
    function estimateFillSeconds(listings, count) {
        const price = bestPrice(listings);
        if (price === null) return null;

        const { quantity, spanMs } = queueAt(listings, price);
        if (!(spanMs > 0)) return null;

        // Quantity that arrived across the window, which is the rate's numerator.
        // The extrapolated total is what the order waits behind, not what arrived.
        let arrived = 0;
        for (const listing of listings) {
            if (listing?.price === price) arrived += listing.quantity || 0;
        }
        if (!(arrived > 0)) return null;

        const perSecond = arrived / (spanMs / 1000);
        // The order's own quantity counts: it is not filled until all of it is
        return (quantity + count) / perSecond;
    }

    var orderBook = /*#__PURE__*/Object.freeze({
        __proto__: null,
        bestPrice: bestPrice,
        estimateFillSeconds: estimateFillSeconds,
        queueAt: queueAt
    });

    /**
     * Combat level
     *
     * What your combat level actually is, and what it would take to move it.
     *
     * The game shows a whole number and nothing else, which hides the two facts
     * worth knowing: how close the next one is, and which skill would get you there
     * soonest. Combat level is a weighted average, so those two questions have
     * different answers for every skill — a level of Melee is worth six times a
     * level of Defense, and no amount of Defense may be the fastest route anyway.
     *
     * ## The formula
     *
     * ```
     * 0.1 × (stamina + intelligence + attack + defense + MAX(melee, ranged, magic))
     *   + 0.5 × MAX(attack, defense, melee, ranged, magic)
     * ```
     *
     * The two maxima are over **different sets**, which is the detail worth getting
     * right: the first counts only the three offensive skills, and the second
     * includes Attack and Defense as well. They agree whenever an offensive skill
     * leads overall — which is most builds, and is exactly why taking them to be the
     * same set survives casual checking — and disagree the moment Attack or Defense
     * is your highest, where the doubled term is Attack's rather than Melee's.
     *
     * So a skill can count twice, once, or not at all, and which of those it is
     * depends on the rest of the build. Rather than encode that as a table of cases,
     * what a level is worth is measured by adding one and re-running the formula.
     *
     * The displayed level is the floor, and the fraction it discards is exactly the
     * progress bar the game does not draw.
     *
     * The model is GWhiz's, from MWI Combat Suite by Frotty (MIT) — see
     * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
     * Toolasha's own.
     */

    /** Every skill that counts, and what one level of it is worth on its own */
    const COMBAT_SKILLS = ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic'];

    /** The three that compete for the slot inside the flat sum */
    const OFFENSE_SKILLS = ['melee', 'ranged', 'magic'];

    /** The five that compete for the doubled term — Attack and Defense are in it too */
    const DOUBLED_SKILLS = ['attack', 'defense', 'melee', 'ranged', 'magic'];

    /** Weight on the flat sum, and the extra weight the best offensive skill carries */
    const FLAT_WEIGHT = 0.1;
    const BEST_WEIGHT = 0.5;

    /**
     * A skill's level, defaulting to zero rather than to NaN.
     * @param {Object} levels - Skill name → level
     * @param {string} skill - Which one
     * @returns {number}
     */
    function levelOf(levels, skill) {
        const value = Number(levels?.[skill]);
        return Number.isFinite(value) ? value : 0;
    }

    /**
     * The highest of a set of skills.
     *
     * Ties resolve to the first in the given order, so the answer does not wander
     * between two equal skills as unrelated levels change — which would make the
     * combat level appear to flicker without anything having happened.
     *
     * @param {Object} levels - Skill name → level
     * @param {string[]} among - Which skills to consider
     * @returns {{skill: string, level: number}}
     */
    function highestOf(levels, among) {
        let skill = among[0];
        let level = levelOf(levels, skill);

        for (const candidate of among.slice(1)) {
            const value = levelOf(levels, candidate);
            if (value > level) {
                skill = candidate;
                level = value;
            }
        }
        return { skill, level };
    }

    /**
     * The offensive skill inside the flat sum.
     * @param {Object} levels - Skill name → level
     * @returns {{skill: string, level: number}}
     */
    function bestOffense(levels) {
        return highestOf(levels, OFFENSE_SKILLS);
    }

    /**
     * The skill carrying the doubled term, which may be Attack or Defense.
     * @param {Object} levels - Skill name → level
     * @returns {{skill: string, level: number}}
     */
    function bestDoubled(levels) {
        return highestOf(levels, DOUBLED_SKILLS);
    }

    /**
     * Your combat level, and the arithmetic behind it.
     *
     * @param {Object} levels - Skill name → level
     * @returns {{level: number, exact: number, best: string, progress: number, terms: number[]}}
     *   `level` is what the game shows, `exact` the unrounded figure, and `progress`
     *   the fraction of the way to the next whole level — the bar the game omits.
     */
    function combatLevel(levels) {
        const offense = bestOffense(levels);
        const doubled = bestDoubled(levels);

        const terms = [
            levelOf(levels, 'stamina'),
            levelOf(levels, 'intelligence'),
            levelOf(levels, 'attack'),
            levelOf(levels, 'defense'),
            offense.level,
        ];

        const exact = FLAT_WEIGHT * terms.reduce((sum, value) => sum + value, 0) + BEST_WEIGHT * doubled.level;
        return {
            level: Math.floor(exact),
            exact,
            best: offense.skill,
            doubled: doubled.skill,
            doubledLevel: doubled.level,
            terms,
            progress: exact - Math.floor(exact),
        };
    }

    /**
     * What one more level of a skill is worth towards combat level.
     *
     * Measured rather than looked up: add one and re-run the formula. A skill can
     * count twice, once, or not at all depending on the rest of the build, and this
     * gets the awkward cases right for free — a skill one level below the leader is
     * worth 0.1 for that level and 0.6 for the next, which no fixed table says.
     *
     * @param {Object} levels - Skill name → level
     * @param {string} skill - Which skill
     * @returns {number} Combat levels gained by one level of it
     */
    function combatValueOf(levels, skill) {
        if (!COMBAT_SKILLS.includes(skill)) return 0;

        const before = combatLevel(levels).exact;
        const after = combatLevel({ ...levels, [skill]: levelOf(levels, skill) + 1 }).exact;
        return after - before;
    }

    /**
     * How many levels of one skill would raise your combat level.
     *
     * Counted by adding levels until the whole number moves, rather than by
     * dividing — because the value of each level is not constant. A skill below the
     * leader contributes little until it overtakes and then contributes a lot, and
     * dividing by today's rate would report a number that is wrong in both
     * directions at once.
     *
     * @param {Object} levels - Skill name → level
     * @param {string} skill - Which skill to raise
     * @param {number} [limit] - Give up past this many levels
     * @returns {number|null} Levels needed, or null when it would take more than the limit
     */
    function levelsToNextCombat(levels, skill, limit = 200) {
        if (!COMBAT_SKILLS.includes(skill)) return null;

        const target = Math.floor(combatLevel(levels).exact) + 1;
        const start = levelOf(levels, skill);

        for (let added = 1; added <= limit; added++) {
            if (combatLevel({ ...levels, [skill]: start + added }).exact >= target) return added;
        }
        return null;
    }

    /**
     * The skill that reaches the next combat level in the fewest levels.
     *
     * Fewest *levels*, not fastest — how long a level takes is a question about
     * experience rates, which this module deliberately knows nothing about.
     *
     * @param {Object} levels - Skill name → level
     * @returns {{skill: string, levels: number}|null}
     */
    function cheapestRouteToNextCombat(levels) {
        let best = null;
        for (const skill of COMBAT_SKILLS) {
            const needed = levelsToNextCombat(levels, skill);
            if (needed === null) continue;
            if (!best || needed < best.levels) best = { skill, levels: needed };
        }
        return best;
    }

    /**
     * How far through its current level a skill is, as a fraction.
     *
     * Which matters here rather than only cosmetically: fed back into the formula,
     * it turns the combat level from a step function into the continuous figure it
     * really is. A character at Combat 126.300 with Melee 81.7% of the way to 135 is
     * not 30% of the way to Combat 127 — it is 79%, because most of the Melee level
     * that carries the doubled term is already earned. The whole-number formula
     * cannot see that, and it is the difference between "a third of the way" and
     * "nearly there".
     *
     * @param {number} experience - Cumulative experience in the skill
     * @param {number} level - Current level
     * @param {number[]} table - The game's cumulative `levelExperienceTable`
     * @returns {number} 0 to 1; zero at the cap, where there is nothing to be part of
     */
    function levelFraction(experience, level, table) {
        const floor = table?.[level];
        const ceiling = table?.[level + 1];
        if (floor === undefined || ceiling === undefined || !(ceiling > floor)) return 0;

        return Math.min(1, Math.max(0, ((Number(experience) || 0) - floor) / (ceiling - floor)));
    }

    /**
     * Levels with their part-finished fractions included.
     *
     * @param {Array<{name: string, level: number, experience: number}>} skills - Combat skills
     * @param {number[]} table - The game's cumulative experience table
     * @returns {Object<string, number>} Skill name → fractional level
     */
    function fractionalLevels(skills, table) {
        const levels = {};
        for (const skill of skills || []) {
            levels[skill.name] = skill.level + levelFraction(skill.experience, skill.level, table);
        }
        return levels;
    }

    /**
     * The fractional level a cumulative experience total sits at.
     *
     * The inverse of the table: 3,500 experience against thresholds of 3,000 and
     * 4,000 is level 3.5. At or past the last threshold it is the cap exactly, since
     * there is no next one to be part of the way towards.
     *
     * @param {number} experience - Cumulative experience
     * @param {number[]} table - The game's cumulative `levelExperienceTable`
     * @returns {number|null} The fractional level, or null without a usable table
     */
    function fractionalLevelOf(experience, table) {
        if (!Array.isArray(table) || table.length < 2) return null;

        const total = Number(experience) || 0;
        const cap = table.length - 1;
        if (total >= table[cap]) return cap;

        // Binary search rather than a scan: this is called inside the search below,
        // which calls it a few hundred times per answer
        let low = 1;
        let high = cap;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (table[middle] <= total) low = middle;
            else high = middle - 1;
        }

        const floor = table[low];
        const ceiling = table[low + 1];
        if (ceiling === undefined || !(ceiling > floor)) return low;

        return low + (total - floor) / (ceiling - floor);
    }

    /**
     * How long a target **combat** level is away.
     *
     * Combat level is not a skill, so there is no experience table to divide into —
     * it moves because two skills underneath it are moving, at different rates and
     * with different weights. The honest answer is to run the clock forward and ask
     * the formula, which is what this does.
     *
     * Combat level is non-decreasing in time, since every skill's level is, so the
     * time is found by doubling until the target is passed and then bisecting. That
     * is exact to the second in a few dozen evaluations, where a closed form would
     * need the weights to be constant — and they are not, because a skill overtaking
     * another changes what a level of it is worth partway through.
     *
     * @param {Object} input - What it needs
     * @param {Array<{name: string, experience: number}>} input.skills - Combat skills
     * @param {number[]} input.table - The game's cumulative experience table
     * @param {Object<string, number>} input.rates - Skill name → experience per hour
     * @param {number} input.target - Target combat level
     * @returns {number|null} Seconds, or null when nothing is moving or it is out of reach
     */
    function timeToCombatLevel({ skills, table, rates, target }) {
        /** The combat level after a given number of seconds at the current rates */
        const after = (seconds) => {
            const levels = {};
            for (const skill of skills || []) {
                const gained = ((rates?.[skill.name] || 0) * seconds) / 3600;
                levels[skill.name] = fractionalLevelOf(skill.experience + gained, table);
            }
            return combatLevel(levels).exact;
        };

        if (!Array.isArray(table) || table.length < 2) return null;
        if (after(0) >= target) return 0;
        if (!Object.values(rates || {}).some((rate) => rate > 0)) return null;

        // A century of idling is not an answer anybody wants, and it is the guard
        // against a target above what these rates can ever reach — the skills hit
        // the level cap and the combat level stops moving
        const LIMIT_SECONDS = 100 * 365 * 24 * 3600;
        let high = 3600;
        while (after(high) < target) {
            high *= 2;
            if (high > LIMIT_SECONDS) return null;
        }

        let low = 0;
        for (let step = 0; step < 60; step++) {
            const middle = (low + high) / 2;
            if (after(middle) >= target) high = middle;
            else low = middle;
        }
        return high;
    }

    /**
     * Experience between two levels.
     *
     * @param {number} from - Starting level
     * @param {number} to - Target level
     * @param {number[]} table - The game's cumulative `levelExperienceTable`
     * @returns {number|null} Experience needed, or null when either level is off the table
     */
    function experienceBetween(from, to, table) {
        const start = table?.[from];
        const end = table?.[to];
        if (start === undefined || end === undefined) return null;

        return Math.max(0, end - start);
    }

    /**
     * How long a target level is away at a given rate.
     *
     * @param {Object} input - What it needs
     * @param {number} input.experience - Cumulative experience now
     * @param {number} input.target - Target level
     * @param {number[]} input.table - The game's cumulative experience table
     * @param {number} input.perHour - Experience per hour
     * @returns {number|null} Seconds, or null when unknowable
     */
    function timeToTargetLevel({ experience, target, table, perHour }) {
        const goal = table?.[target];
        if (goal === undefined || !(perHour > 0)) return null;

        const remaining = goal - (Number(experience) || 0);
        // Already there is zero, not a negative countdown
        if (remaining <= 0) return 0;

        return (remaining / perHour) * 3600;
    }

    var combatLevel$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        COMBAT_SKILLS: COMBAT_SKILLS,
        DOUBLED_SKILLS: DOUBLED_SKILLS,
        OFFENSE_SKILLS: OFFENSE_SKILLS,
        bestDoubled: bestDoubled,
        bestOffense: bestOffense,
        cheapestRouteToNextCombat: cheapestRouteToNextCombat,
        combatLevel: combatLevel,
        combatValueOf: combatValueOf,
        experienceBetween: experienceBetween,
        fractionalLevelOf: fractionalLevelOf,
        fractionalLevels: fractionalLevels,
        highestOf: highestOf,
        levelFraction: levelFraction,
        levelsToNextCombat: levelsToNextCombat,
        timeToCombatLevel: timeToCombatLevel,
        timeToTargetLevel: timeToTargetLevel
    });

    /**
     * OPanel layout import and export
     *
     * Reading and writing MWI Combat Suite's OPanel configuration.
     *
     * A layout is worth an hour of fiddling and is then worth keeping. Someone
     * arriving from MCS has already spent that hour, and asking them to spend it
     * again is the main reason a second tool does not get used. The shapes are close
     * enough that this is mostly a rename.
     *
     * ## What does and does not survive
     *
     * Positions, sizes, text scales, order, which rows are on, the lock and the grid
     * all carry across unchanged — OPanel and this overlay measure them the same way.
     * Rows Toolasha has no equivalent for are **reported rather than dropped
     * silently**, because a layout that quietly arrives missing three tiles looks
     * like an import that half-worked.
     *
     * The panel's own position and size come across too, but separately: they live
     * in the geometry store rather than in the layout, so they are returned beside
     * it rather than inside it.
     *
     * ## Why the file also carries a Toolasha section
     *
     * OPanel names twenty rows. This overlay has half as many again — the watchlist,
     * charms, mana, the combat log, equipment savings — and OPanel has no key for
     * any of them. Written in OPanel's shape alone, a Toolasha layout comes back
     * missing every one of those, and rows that arrive with no position get laid out
     * wherever the packer puts them. Exporting from one character and importing on
     * another produced a jumble for exactly this reason.
     *
     * So the file carries **both**: `config` in OPanel's shape, which MCS reads and
     * this ignores when the other half is present, and `toolasha` carrying the
     * layout whole. MCS ignores keys it does not know, so the file stays readable by
     * both without either losing anything.
     *
     * Kept pure and apart from the panel so the mapping is testable without a DOM,
     * which is where a rename table's mistakes actually live.
     */

    /**
     * OPanel's row keys against ours.
     *
     * Most are the same word. The ones that are not carry the name of whichever
     * script the row came from — `kollectionNetWorth`, `ewatchCoins`, `gwhizTTL` —
     * which is history rather than description, so ours are named for what they show.
     */
    const ROW_KEY_MAP = {
        battleTimer: 'battleTimer',
        combatRevenue: 'combatRevenue',
        consumables: 'consumables',
        experiencePerHour: 'experiencePerHour',
        totalProfit: 'totalProfit',
        dps: 'dps',
        overExpected: 'overExpected',
        luck: 'luck',
        deathsPerHour: 'deathsPerHour',
        houses: 'houses',
        equipmentWatch: 'equipmentWatch',
        combatStatus: 'combatStatus',
        treasure: 'treasure',
        ntallyInventory: 'inventoryValue',
        kollectionBuildScore: 'buildScore',
        kollectionNetWorth: 'netWorth',
        ewatchCoins: 'coins',
        ewatchMarket: 'marketListings',
        skillBooks: 'skillBooks',
        gwhizTTL: 'timeToLevel',
    };

    /**
     * Bumped only when the section's shape changes in a way a reader must know
     * about. It is written and never yet read, which is the point of writing it.
     */
    const TOOLASHA_SECTION_VERSION = 1;

    /** Ours back to theirs, for writing a file MCS can read */
    const REVERSE_KEY_MAP = Object.fromEntries(Object.entries(ROW_KEY_MAP).map(([theirs, ours]) => [ours, theirs]));

    /**
     * Does this look like an OPanel configuration?
     *
     * Checked by shape rather than by a version field, which OPanel does not write.
     * A config with rows in a known order and a sizes map is one; anything else is
     * declined rather than half-read.
     *
     * @param {Object} json - Parsed file
     * @returns {boolean}
     */
    function isOPanelConfig(json) {
        const config = json?.config;
        return !!config && (Array.isArray(config.order) || !!config.sizes || !!config.positions);
    }

    /**
     * Read an OPanel configuration into overlay settings.
     *
     * @param {Object} json - Parsed OPanel config file
     * @returns {{settings: Object, geometry: Object|null, unknown: string[]}|null}
     *   `settings` merges into the overlay's own, `geometry` is the panel's frame,
     *   and `unknown` names every row of theirs we have nothing to map to. `native`
     *   says the layout came from this overlay's own section rather than from
     *   OPanel's, which is the difference between coordinates that can be used as
     *   they are and coordinates that have to be laid out again. Null when the file
     *   is not an OPanel config.
     */
    function fromOPanelConfig(json) {
        if (!isOPanelConfig(json)) return null;

        // Our own section wins when the file has one: it names every row rather than
        // the twenty OPanel knows, and a layout half of whose rows arrive without a
        // position is a layout the packer rearranges from scratch
        const native = readToolashaSection(json);
        if (native) return { settings: native, geometry: readGeometry(json), unknown: [], native: true };

        const config = json.config;
        const unknown = [];

        /**
         * @param {string} theirKey - An OPanel row key
         * @returns {string|null} Ours, recording the miss
         */
        const translate = (theirKey) => {
            const ours = ROW_KEY_MAP[theirKey];
            if (!ours && !unknown.includes(theirKey)) unknown.push(theirKey);
            return ours || null;
        };

        const visible = {};
        const positions = {};
        const sizes = {};
        const zoom = {};
        const order = [];

        for (const theirKey of config.order || []) {
            const ours = translate(theirKey);
            if (ours) order.push(ours);
        }

        // Visibility is a bare boolean beside the display sub-options in the same
        // object, so it is read from the key map rather than by walking the object —
        // `snapToGrid` is not a row
        for (const theirKey of Object.keys(ROW_KEY_MAP)) {
            if (typeof config[theirKey] === 'boolean') visible[ROW_KEY_MAP[theirKey]] = config[theirKey];
        }

        for (const [theirKey, value] of Object.entries(config.positions || {})) {
            const ours = translate(theirKey);
            if (ours && Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
                positions[ours] = { x: value.x, y: value.y };
            }
        }

        for (const [theirKey, value] of Object.entries(config.sizes || {})) {
            const ours = translate(theirKey);
            if (ours && value?.width > 0 && value?.height > 0) {
                sizes[ours] = { width: value.width, height: value.height };
            }
        }

        for (const [theirKey, value] of Object.entries(json.zoom_levels || {})) {
            const ours = translate(theirKey);
            if (ours && Number.isFinite(value)) zoom[ours] = value;
        }

        const settings = { visible, order, positions, sizes, zoom };
        if (typeof config.snapToGrid === 'boolean') settings.snapToGrid = config.snapToGrid;
        if (typeof json.is_locked === 'boolean') settings.locked = json.is_locked;

        return { settings, geometry: readGeometry(json), unknown, native: false };
    }

    /**
     * The layout as this overlay stores it, if the file carries one.
     *
     * Validated rather than trusted: a hand-edited or truncated file should be
     * declined so the OPanel half is read instead, which is worse but not wrong.
     *
     * @param {Object} json - Parsed file
     * @returns {Object|null} Settings, or null when there is no usable section
     */
    function readToolashaSection(json) {
        const saved = json?.toolasha?.settings;
        if (!saved || !Array.isArray(saved.order) || !saved.order.length) return null;

        const settings = {
            order: saved.order.filter((key) => typeof key === 'string'),
            visible: {},
            positions: {},
            sizes: {},
            zoom: {},
        };

        for (const [key, on] of Object.entries(saved.visible || {})) settings.visible[key] = !!on;

        for (const [key, value] of Object.entries(saved.positions || {})) {
            if (Number.isFinite(value?.x) && Number.isFinite(value?.y))
                settings.positions[key] = { x: value.x, y: value.y };
        }

        for (const [key, value] of Object.entries(saved.sizes || {})) {
            if (value?.width > 0 && value?.height > 0) settings.sizes[key] = { width: value.width, height: value.height };
        }

        for (const [key, value] of Object.entries(saved.zoom || {})) {
            if (Number.isFinite(value)) settings.zoom[key] = value;
        }

        if (typeof saved.snapToGrid === 'boolean') settings.snapToGrid = saved.snapToGrid;
        if (typeof saved.locked === 'boolean') settings.locked = saved.locked;
        if (typeof saved.separators === 'boolean') settings.separators = saved.separators;
        if (Number.isFinite(saved.textScale)) settings.textScale = saved.textScale;

        return settings;
    }

    /**
     * The panel's own frame, if the file carries one.
     * @param {Object} json - Parsed OPanel config
     * @returns {Object|null} `{left, top, width, height}`
     */
    function readGeometry(json) {
        const geometry = {};
        if (Number.isFinite(json?.position?.left)) geometry.left = Math.round(json.position.left);
        if (Number.isFinite(json?.position?.top)) geometry.top = Math.round(json.position.top);
        if (json?.size?.width > 0) geometry.width = Math.round(json.size.width);
        if (json?.size?.height > 0) geometry.height = Math.round(json.size.height);
        return Object.keys(geometry).length ? geometry : null;
    }

    /**
     * Write overlay settings out in OPanel's shape.
     *
     * Rows OPanel has no key for are left out — writing ours into their file would
     * produce something MCS reads as corrupt rather than as extended.
     *
     * @param {Object} settings - The overlay's settings
     * @param {Object} [geometry] - The panel's frame
     * @returns {Object} A file OPanel can read
     */
    function toOPanelConfig(settings, geometry = null) {
        const config = { order: [], sizes: {}, positions: {}, firstLoad: false };
        const zoomLevels = {};

        for (const ourKey of settings?.order || []) {
            const theirs = REVERSE_KEY_MAP[ourKey];
            if (theirs) config.order.push(theirs);
        }

        for (const [ourKey, on] of Object.entries(settings?.visible || {})) {
            const theirs = REVERSE_KEY_MAP[ourKey];
            if (theirs) config[theirs] = !!on;
        }

        for (const [ourKey, value] of Object.entries(settings?.positions || {})) {
            const theirs = REVERSE_KEY_MAP[ourKey];
            if (theirs) config.positions[theirs] = { x: value.x, y: value.y };
        }

        for (const [ourKey, value] of Object.entries(settings?.sizes || {})) {
            const theirs = REVERSE_KEY_MAP[ourKey];
            if (theirs) config.sizes[theirs] = { width: value.width, height: value.height };
        }

        for (const [ourKey, value] of Object.entries(settings?.zoom || {})) {
            const theirs = REVERSE_KEY_MAP[ourKey];
            if (theirs) zoomLevels[theirs] = value;
        }

        config.snapToGrid = settings?.snapToGrid !== false;

        return {
            config,
            is_locked: settings?.locked !== false,
            position: geometry ? { top: geometry.top ?? 0, left: geometry.left ?? 0 } : undefined,
            size: geometry?.width ? { width: geometry.width, height: geometry.height } : undefined,
            zoom_levels: zoomLevels,
            // The layout whole, beside the twenty rows OPanel has names for. MCS
            // ignores keys it does not know, so this costs it nothing and is the
            // difference between a Toolasha layout surviving a round trip and
            // arriving with a third of its rows unplaced.
            toolasha: { version: TOOLASHA_SECTION_VERSION, settings: nativeSection(settings) },
        };
    }

    /**
     * The layout as this overlay holds it, trimmed to what a file needs.
     *
     * Copied field by field rather than spread, so a future setting that has no
     * business in a layout file — a cache, a timestamp — does not silently start
     * travelling between characters.
     *
     * @param {Object} settings - The overlay's settings
     * @returns {Object}
     */
    function nativeSection(settings) {
        return {
            order: [...(settings?.order || [])],
            visible: { ...(settings?.visible || {}) },
            positions: { ...(settings?.positions || {}) },
            sizes: { ...(settings?.sizes || {}) },
            zoom: { ...(settings?.zoom || {}) },
            snapToGrid: settings?.snapToGrid !== false,
            locked: settings?.locked !== false,
            separators: settings?.separators !== false,
            textScale: settings?.textScale,
        };
    }

    var opanelConfig = /*#__PURE__*/Object.freeze({
        __proto__: null,
        ROW_KEY_MAP: ROW_KEY_MAP,
        fromOPanelConfig: fromOPanelConfig,
        isOPanelConfig: isOPanelConfig,
        toOPanelConfig: toOPanelConfig
    });

    /**
     * Skill Progress
     *
     * How long until the next level, from a rate you are actually achieving.
     *
     * The arithmetic is small but every part of it has a wrong answer that looks
     * right. Cumulative experience against per-level experience, a rate measured
     * over a window short enough to be noise, a skill at the cap that should say
     * nothing rather than "never" — each produces a plausible number. So it lives
     * here, apart from the DOM, with tests.
     */

    /** Below this a rate is one action's worth of luck rather than a measurement */
    const MIN_WINDOW_SECONDS = 20;

    /**
     * Experience per hour, from two readings of the same skill.
     *
     * Returns null rather than zero when there is nothing to measure. Zero is a
     * claim — that you are gaining no experience — and a window of two seconds
     * cannot support it.
     *
     * @param {{t: number, xp: number}} first - Earlier reading, `t` in ms
     * @param {{t: number, xp: number}} last - Later reading
     * @returns {number|null} Experience per hour, or null when unmeasurable
     */
    function experiencePerHour(first, last) {
        if (!first || !last) return null;

        const seconds = (last.t - first.t) / 1000;
        if (!(seconds >= MIN_WINDOW_SECONDS)) return null;

        const gained = last.xp - first.xp;
        // Experience going backwards is not a rate; it is a reset, a character
        // switch, or a reading from before a wipe
        if (!(gained > 0)) return null;

        return (gained / seconds) * 3600;
    }

    /**
     * Experience still owed for the next level.
     *
     * @param {number} experience - Cumulative experience in the skill
     * @param {number} level - Current level
     * @param {number[]} levelExperienceTable - Cumulative experience per level, indexed by level
     * @returns {number|null} Experience remaining, or null at the cap or without a table
     */
    function experienceToNextLevel(experience, level, levelExperienceTable) {
        const next = levelExperienceTable?.[level + 1];
        // Undefined means the table has run out, which is the level cap — not zero
        // experience remaining, which would read as "about to level"
        if (next === undefined || !Number.isFinite(experience)) return null;

        return Math.max(0, next - experience);
    }

    /**
     * How long the next level will take at the rate being achieved.
     *
     * @param {Object} input - What it needs
     * @param {number} input.experience - Cumulative experience
     * @param {number} input.level - Current level
     * @param {number[]} input.levelExperienceTable - The game's table
     * @param {number|null} input.xpPerHour - Measured rate
     * @returns {number|null} Seconds, or null when unknowable
     */
    function timeToNextLevel({ experience, level, levelExperienceTable, xpPerHour }) {
        if (!(xpPerHour > 0)) return null;

        const remaining = experienceToNextLevel(experience, level, levelExperienceTable);
        if (remaining === null) return null;

        return (remaining / xpPerHour) * 3600;
    }

    /**
     * Entries in `characterSkills` that are not skills you train.
     *
     * The game keeps the total level in the same list, and it gains experience
     * faster than anything else by definition — it is the sum of them all. Left in,
     * it always wins the "which is being trained" question and always reports no
     * next level, since there is no row for it in the experience table.
     */
    const NOT_A_SKILL = new Set(['/skills/total_level']);

    /**
     * Which skill is being trained, judged by which is gaining fastest.
     *
     * By rate rather than by the current action, because an action trains several
     * skills at once and the one you care about is the one moving. Ties go to
     * whichever is found first, which is stable for a stable input order.
     *
     * @param {Object<string, number>} ratesByHrid - Skill hrid → experience per hour
     * @returns {string|null} The skill hrid, or null when nothing is moving
     */
    function fastestGaining(ratesByHrid) {
        let best = null;
        let bestRate = 0;

        for (const [hrid, rate] of Object.entries(ratesByHrid || {})) {
            if (NOT_A_SKILL.has(hrid)) continue;
            if (rate > bestRate) {
                best = hrid;
                bestRate = rate;
            }
        }
        return best;
    }

    /**
     * A skill hrid as its name.
     * @param {string} skillHrid - e.g. `/skills/melee`
     * @returns {string} e.g. `Melee`
     */
    function skillName(skillHrid) {
        const last =
            String(skillHrid || '')
                .split('/')
                .pop() || '';
        return last.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
    }

    var skillProgress = /*#__PURE__*/Object.freeze({
        __proto__: null,
        experiencePerHour: experiencePerHour,
        experienceToNextLevel: experienceToNextLevel,
        fastestGaining: fastestGaining,
        skillName: skillName,
        timeToNextLevel: timeToNextLevel
    });

    /**
     * Skill history
     *
     * Two readings of a skill's experience, far enough apart to divide.
     *
     * A rate needs a memory, and a memory needs three decisions that each have a
     * wrong answer looking exactly like the right one: how often to read, how far
     * back to keep, and what to do when a reading makes no sense against the last.
     * That last one is where the bugs are, and it is why this is one module rather
     * than a loop copied into every feature that wants a rate.
     *
     * ## The two readings that are not progress
     *
     * **Experience below the previous reading** is a different character, not a
     * loss. A test server beside a live one is an ordinary thing to have, and the
     * difference between two characters' totals is a large negative number that
     * would otherwise be reported as a rate.
     *
     * **A clock that has gone backwards** — an NTP correction, a resume from sleep —
     * leaves readings stamped in the future. Nothing can be measured against those:
     * the window between them is negative, so every rate reads as unmeasurable until
     * real time catches up with the stale stamps, which after a long sleep is hours
     * of a panel quietly saying nothing. Starting again costs one window and is the
     * only answer that recovers.
     *
     * Each caller makes its own, so opening or closing one panel cannot reset
     * another's measurement.
     */


    /** Ten minutes back is long enough to be a measurement and short enough to be current */
    const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

    /** No point re-reading the skill list faster than anything redraws */
    const DEFAULT_SAMPLE_MS = 5000;

    /**
     * A private record of how fast each skill is going up.
     *
     * @param {Object} [options] - Tuning
     * @param {number} [options.windowMs] - How far back to measure over
     * @param {number} [options.sampleMs] - How often to take a reading
     * @returns {{sample: Function, rateFor: Function, rates: Function, readings: Function, clear: Function}}
     */
    function createSkillHistory({ windowMs = DEFAULT_WINDOW_MS, sampleMs = DEFAULT_SAMPLE_MS } = {}) {
        /** skillHrid → [{t, xp}], oldest first */
        const history = new Map();

        // Null rather than zero for "never read": zero is a real time, and against
        // it the first reading of a session looks like one taken a moment ago and
        // is refused. Under a real clock that is invisible, which is exactly the
        // kind of edge that survives to bite a test that sets its own time.
        let lastSampleAt = null;

        /**
         * Take a reading of every skill, if one is due.
         *
         * @param {Array<{skillHrid: string, experience: number}>} skills - The game's list
         * @param {number} [now] - Milliseconds since the epoch
         */
        function sample(skills, now = Date.now()) {
            if (lastSampleAt !== null) {
                if (now < lastSampleAt) history.clear();
                else if (now - lastSampleAt < sampleMs) return;
            }
            lastSampleAt = now;

            for (const skill of skills || []) {
                if (!skill?.skillHrid || !Number.isFinite(skill.experience)) continue;

                let readings = history.get(skill.skillHrid) || [];
                if (readings.length && skill.experience < readings[readings.length - 1].xp) readings = [];

                readings.push({ t: now, xp: skill.experience });
                // Drop everything that has fallen out of the window, but never the
                // last one before it — that reading is the far end of the measurement
                while (readings.length > 2 && readings[1].t < now - windowMs) readings.shift();
                history.set(skill.skillHrid, readings);
            }
        }

        /**
         * @param {string} skillHrid - Which skill
         * @returns {number|null} Experience per hour, or null when unmeasurable
         */
        function rateFor(skillHrid) {
            const readings = history.get(skillHrid) || [];
            return experiencePerHour(readings[0], readings[readings.length - 1]);
        }

        /**
         * Every skill that has a measurable rate.
         * @returns {Object<string, number>} Skill hrid → experience per hour
         */
        function rates() {
            const result = {};
            for (const skillHrid of history.keys()) {
                const rate = rateFor(skillHrid);
                if (rate) result[skillHrid] = rate;
            }
            return result;
        }

        /**
         * @param {string} skillHrid - Which skill
         * @returns {Array<{t: number, xp: number}>} Its readings, oldest first
         */
        function readings(skillHrid) {
            return history.get(skillHrid) || [];
        }

        /** Forget everything and start the measurement again */
        function clear() {
            history.clear();
            lastSampleAt = null;
        }

        return { sample, rateFor, rates, readings, clear };
    }

    var skillHistory = /*#__PURE__*/Object.freeze({
        __proto__: null,
        createSkillHistory: createSkillHistory
    });

    /**
     * Ability books
     *
     * How many books an ability level costs, and which level is the cheapest to buy.
     *
     * ## The book that teaches the ability
     *
     * An ability you have never learned is level 0, and the first book does not
     * grant experience towards level 1 — it teaches the ability. So a plan from
     * level 0 is one book more than the experience arithmetic says, and a
     * calculation that misses it is short by exactly one book every time, which is
     * the kind of error that only shows up when you are one book short.
     *
     * ## Cheapest is not fewest
     *
     * The ability closest to its next level is rarely the cheapest one to level:
     * books differ in experience granted and by orders of magnitude in price. So the
     * question worth answering is not "which is nearest" but "which costs least",
     * and that needs the market.
     *
     * The maths was already in `features/abilities/ability-book-calculator.js`, tied
     * to whichever book the Item Dictionary happened to be showing. It is here so
     * the panel and the dictionary cannot disagree about the same number.
     *
     * The model is BRead's, from MWI Combat Suite by Frotty (MIT) — see
     * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
     * Toolasha's own.
     */

    /** Where an ability's book lives — the game keeps the two under matching names */
    function bookItemFor(abilityHrid) {
        return String(abilityHrid || '').replace('/abilities/', '/items/');
    }

    /**
     * Books needed to take an ability to a target level.
     *
     * @param {Object} input - What it needs
     * @param {number} input.level - Current ability level; 0 means never learned
     * @param {number} input.experience - Current ability experience
     * @param {number} input.targetLevel - Level being aimed at
     * @param {number} input.perBookExperience - Experience one book grants
     * @param {number[]} input.table - The game's cumulative `levelExperienceTable`
     * @returns {number|null} Books needed, or null when it cannot be worked out
     */
    function booksToLevel({ level, experience, targetLevel, perBookExperience, table }) {
        const goal = table?.[targetLevel];
        if (goal === undefined || !(perBookExperience > 0)) return null;

        const owed = goal - (Number(experience) || 0);
        // Already past it is nothing to buy, not a negative order
        if (owed <= 0) return level === 0 ? 1 : 0;

        // The first book teaches the ability rather than levelling it
        return Math.ceil(owed / perBookExperience) + (level === 0 ? 1 : 0);
    }

    /**
     * Experience still owed to a level.
     *
     * @param {number[]} table - The game's cumulative `levelExperienceTable`
     * @param {number} targetLevel - Level being aimed at
     * @param {number} experience - Current ability experience
     * @returns {number|null} Nothing when the table does not go that far
     */
    function experienceOwed(table, targetLevel, experience) {
        const goal = table?.[targetLevel];
        if (goal === undefined) return null;
        // Past it is nothing left to earn, not a negative amount of experience
        return Math.max(0, goal - (Number(experience) || 0));
    }

    /**
     * One ability's plan: what the next level costs, and a chosen target.
     *
     * @param {Object} input - What it needs
     * @param {Object} input.ability - `{abilityHrid, level, experience}`
     * @param {number} input.perBookExperience - Experience one book grants
     * @param {number} input.bookPrice - What one book costs
     * @param {number[]} input.table - The game's cumulative experience table
     * @param {number} [input.targetLevel] - A level beyond the next one
     * @returns {Object|null} The plan, or null without a book to buy
     */
    function abilityPlan({ ability, perBookExperience, bookPrice, table, targetLevel }) {
        if (!ability?.abilityHrid || !(perBookExperience > 0)) return null;

        const level = Number(ability.level) || 0;
        const experience = Number(ability.experience) || 0;
        const price = Number(bookPrice) || 0;

        const next = booksToLevel({ level, experience, targetLevel: level + 1, perBookExperience, table });
        const target = targetLevel && targetLevel > level ? targetLevel : null;
        const toTarget = target ? booksToLevel({ level, experience, targetLevel: target, perBookExperience, table }) : null;

        return {
            abilityHrid: ability.abilityHrid,
            itemHrid: bookItemFor(ability.abilityHrid),
            level,
            experience,
            perBookExperience,
            bookPrice: price,
            // Experience rather than books, because a rate is measured in experience
            // and a time to a level cannot be got from a book count
            experienceToNext: experienceOwed(table, level + 1, experience),
            experienceToTarget: target === null ? null : experienceOwed(table, target, experience),
            booksToNext: next,
            // Nothing rather than zero when the book has no price: an ability whose
            // book is unpriced is not free to level, it is unknown
            costToNext: next === null || !price ? null : next * price,
            targetLevel: target,
            booksToTarget: toTarget,
            costToTarget: toTarget === null || !price ? null : toTarget * price,
        };
    }

    /**
     * The ability whose next level costs least.
     *
     * Plans with no price are not candidates — an unpriced book is unknown rather
     * than free, and treating it as zero would make it win every time.
     *
     * @param {Array<Object>} plans - From `abilityPlan`
     * @returns {Object|null}
     */
    function cheapestNextLevel(plans) {
        let best = null;
        for (const plan of plans || []) {
            if (!plan || plan.costToNext === null || !(plan.costToNext > 0)) continue;
            if (!best || plan.costToNext < best.costToNext) best = plan;
        }
        return best;
    }

    /**
     * What a whole set of plans would cost, each aimed where it is aimed.
     *
     * A total over a set where some abilities have a target and some do not cannot
     * come from one field: `costToTarget` is null on the ones with no target, and
     * `costToNext` ignores the targets that were set. It has to be per plan.
     *
     * @param {Array<Object>} plans - From `abilityPlan`
     * @returns {{books: number, cost: number, unpriced: number}}
     */
    function aimedTotals(plans) {
        return planTotals(
            (plans || []).map((plan) =>
                !plan || plan.targetLevel === null
                    ? plan
                    : { ...plan, booksToNext: plan.booksToTarget, costToNext: plan.costToTarget }
            )
        );
    }

    /**
     * What a whole set of plans would cost.
     *
     * @param {Array<Object>} plans - From `abilityPlan`
     * @param {string} [field] - `costToNext` or `costToTarget`
     * @returns {{books: number, cost: number, unpriced: number}} `unpriced` is how
     *   many abilities the total could not include, which is the difference between
     *   a total and a lower bound presented as one
     */
    function planTotals(plans, field = 'costToNext') {
        const booksField = field === 'costToTarget' ? 'booksToTarget' : 'booksToNext';
        let books = 0;
        let cost = 0;
        let unpriced = 0;

        for (const plan of plans || []) {
            if (!plan) continue;
            books += plan[booksField] || 0;
            if (plan[field] === null) unpriced++;
            else cost += plan[field];
        }
        return { books, cost, unpriced };
    }

    var abilityBooks = /*#__PURE__*/Object.freeze({
        __proto__: null,
        abilityPlan: abilityPlan,
        aimedTotals: aimedTotals,
        bookItemFor: bookItemFor,
        booksToLevel: booksToLevel,
        cheapestNextLevel: cheapestNextLevel,
        experienceOwed: experienceOwed,
        planTotals: planTotals
    });

    /**
     * Damage attribution
     *
     * Who hit what, derived from a payload that never says.
     *
     * `battle_updated` carries every unit's current state and no events. Working out
     * that "Bob crit the rat for 4,120" from two of those snapshots is the whole
     * problem, and there is no attribution field to read — the trick is elsewhere.
     *
     * ## An attack counter identifies the attacker
     *
     * Each player carries `atkCounter`, and it goes up when they attack. Across two
     * recorded runs it rose on **every** tick that dealt damage — sixty-nine of
     * sixty-nine — which makes it the join between a player and a monster's lost
     * health.
     *
     * It replaced mana, which was the original answer and a weaker one: only an
     * ability costs mana, so `cMP` falling identified the actor on eight of those
     * sixty-nine ticks. Mana is kept below the counter, for a payload that carries
     * no counter and for the tick where two people act at once and one of them cast.
     *
     * **In a party of two this changed nothing**, and it took five to show why it
     * mattered. `pMap` is a delta exactly as `mMap` is, so a character who did
     * nothing is not in the tick, and with two people "the only one here must be
     * them" is usually right — the old and new rules pick the same character on all
     * 137 damage ticks of a recorded pair.
     *
     * With five, one person tanks. The character a tick is about is then very often
     * the one being **hit**, not the one attacking: on 82 of 440 damage ticks the
     * lone character in the tick was there because their own health and damage
     * counter had moved. Crediting them handed 8,500 points of other people's
     * damage to whoever was holding aggro. That rung is now "the last character to
     * swing", because a swing and its damage are not always in the same tick —
     * 76 of those 82 had somebody else swinging one real tick earlier.
     *
     * ## Every payload arrives twice
     *
     * 757 of 1,465 `battle_updated` messages in that recording are byte-identical to
     * the one before. Nothing here has to care — a duplicate diffs to no change and
     * produces no events — but it is why the swing behind a hit looks two ticks back
     * rather than one.
     *
     * ## A counter distinguishes a hit from a tick
     *
     * Health falling is not sufficient — bleeds and regeneration move it too. A hit
     * is `dmgCounter` **rising**, and a crit is `critCounter` rising. Which also
     * gives the one case a health diff can never express: `dmgCounter` up with the
     * health unchanged is a **miss**, not a non-event.
     *
     * ## What it deliberately does not do
     *
     * It does not guess. A tick where several players act at once falls back to the
     * last mana drop, because the payload cannot separate them — and a tick that
     * names nobody at all credits nobody rather than the wrong body.
     *
     * The model is DPs' and the Floating Combat Text tool's, from MWI Combat Suite
     * by Frotty (MIT) — see `third-party/mwi-combat-suite/` and
     * `docs/THIRD-PARTY-LICENSES.md`. The code is Toolasha's own.
     */

    /**
     * A fresh set of the counters a tick is measured against.
     * @returns {Object}
     */
    function newAttributionState() {
        return {
            playersMP: {},
            playersAtk: {},
            party: {},
            lastSwing: null,
            monstersHP: {},
            dmgCounter: {},
            critCounter: {},
            actions: {},
        };
    }

    /**
     * Note what each player is preparing, so a hit can be labelled with an ability.
     *
     * The ability when one is mid-cast, `auto` when it is an auto-attack, and
     * `idle` otherwise — the same three cases MCS distinguishes, and what the
     * non-damaging filter keys off.
     *
     * ## Two spellings of the same field
     *
     * `new_battle` writes `preparingAbilityHrid` and `isPreparingAutoAttack`; the
     * per-tick `battle_updated` abbreviates them to `abilityHrid` and `isAutoAtk`.
     * Reading only the long pair means the label is whatever was being prepared
     * when the battle began and never changes again — which credits the entire
     * fight to one ability, and to the wrong one at that.
     *
     * ## When to call it
     *
     * **After attributing a tick, not before.** The hit that lands on a tick was
     * cast by what was being prepared *before* it; by the time the payload arrives
     * the player has already begun the next thing. Updating first credits every hit
     * to the ability that follows it.
     *
     * @param {Object} state - From `newAttributionState`, mutated
     * @param {Object} players - A `new_battle` player list or a tick's `pMap`
     */
    function noteActions(state, players) {
        for (const [index, player] of Object.entries(players || {})) {
            // A `new_battle` carries the whole roster, which is the only place the
            // party's size is stated — and it is what tells a solo run apart from a
            // party where one member happens to be alone in this tick
            state.party[index] = true;
            const ability = player?.preparingAbilityHrid || player?.abilityHrid;
            const auto = player?.isPreparingAutoAttack || player?.isAutoAtk;

            state.actions[index] = ability ? ability : auto ? 'auto' : 'idle';
        }
    }

    /**
     * Which player acted this tick.
     *
     * @param {Object} pMap - This tick's players
     * @param {Object} state - From `newAttributionState`, mutated
     * @returns {string|null} The player index, or null when nobody can be identified
     */
    function findCaster(pMap, state) {
        const indices = Object.keys(pMap || {});
        const swung = [];
        const spent = [];

        for (const index of indices) {
            const player = pMap[index];

            const attacks = Number(player?.atkCounter);
            const attacksBefore = state.playersAtk[index];
            if (Number.isFinite(attacks)) {
                if (attacksBefore !== undefined && attacks > attacksBefore) swung.push(index);
                state.playersAtk[index] = attacks;
            }

            const mana = Number(player?.cMP);
            if (Number.isFinite(mana)) {
                const before = state.playersMP[index];
                if (before !== undefined && mana < before) spent.push(index);
                state.playersMP[index] = mana;
            }
        }

        // `atkCounter` is what it sounds like, and it almost always names one person:
        // in a five-character party, two of them swung on the same tick three times
        // in fourteen hundred, one of which dealt damage. Rare enough to identify
        // by, not so rare that the tie can be pretended away.
        if (swung.length === 1) {
            state.lastSwing = swung[0];
            return swung[0];
        }

        // Two people acting at once. Mana at least separates a cast from a swing,
        // which is the older and worse answer rather than no answer.
        if (spent.length) return spent[spent.length - 1];

        // Nobody else it could have been. This is the rung that carries a solo run
        // on a payload with no attack counter at all.
        const party = Object.keys(state.party);
        if (party.length === 1) return party[0];
        if (!party.length && indices.length === 1) return indices[0];

        // The last character to swing. A swing and the damage it does are not always
        // in the same tick — see the note above — and the person the tick *is* about
        // is usually the one being hit, which is who this used to credit.
        return state.lastSwing;
    }

    /**
     * The hits in one tick.
     *
     * @param {Object} tick - A `battle_updated` payload
     * @param {Object} state - From `newAttributionState`, mutated
     * @returns {Array<Object>} Hits as
     *   `{playerIndex, monsterIndex, amount, isCrit, isMiss, isHeal, action}`, and
     *   deaths as `{monsterIndex, isKill}` — the two are separate events because a
     *   bleed can land the killing blow on a tick where no counter moved
     */
    function attributeTick(tick, state) {
        const { mMap, pMap } = tick || {};
        const caster = findCaster(pMap, state);
        const events = [];

        for (const [index, monster] of Object.entries(mMap || {})) {
            const health = Number(monster?.currentHitpoints ?? monster?.cHP);
            if (!Number.isFinite(health)) continue;

            const beforeHealth = state.monstersHP[index];
            const beforeDamage = state.dmgCounter[index];
            const beforeCrits = state.critCounter[index];

            const damageCount = Number(monster?.dmgCounter) || 0;
            const critCount = Number(monster?.critCounter) || 0;

            state.monstersHP[index] = health;
            state.dmgCounter[index] = damageCount;
            state.critCounter[index] = critCount;

            // First sighting of a monster is not a hit for its entire health bar
            if (beforeHealth === undefined) continue;

            // A death is its own event, separate from the hit that caused it.
            // Merging the two would lose every kill landed by a bleed — the health
            // reaches zero on a tick where no counter moved — and a kill counted
            // only when a hit lands undercounts exactly the fights that take
            // longest, which are the ones worth measuring.
            if (beforeHealth > 0 && health <= 0) {
                events.push({ monsterIndex: index, isKill: true });
            }

            // A hit is the counter rising. Health falling on its own is a bleed or
            // a tick of something, and crediting it to whoever last cast would
            // hand a damage-over-time effect to the wrong ability.
            const hit = beforeDamage !== undefined && damageCount > beforeDamage;
            if (!hit) continue;
            if (caster === null) continue;

            const change = beforeHealth - health;
            events.push({
                playerIndex: caster,
                monsterIndex: index,
                amount: Math.abs(change),
                isCrit: beforeCrits !== undefined && critCount > beforeCrits,
                // The one case a health diff cannot express on its own
                isMiss: change === 0,
                isHeal: change < 0,
                action: state.actions[caster] || 'idle',
            });
        }
        return events;
    }

    /** Abilities that deal no damage, so a hit credited during one is not theirs */
    const NON_DAMAGING = new Set(['idle']);

    /**
     * Whether an action should count towards damage.
     *
     * @param {string} action - From an event
     * @param {Set<string>} [nonDamaging] - Ability hrids known to deal no damage
     * @returns {boolean}
     */
    function isDamagingAction(action, nonDamaging = NON_DAMAGING) {
        return !nonDamaging.has(action);
    }

    /**
     * Fold events into a per-player tally.
     *
     * @param {Object} tally - `{}` or a previous return, mutated
     * @param {Array<Object>} events - From `attributeTick`
     * @param {Object} [options] - `{filterNonDamaging, nonDamaging, nameOf}`. `nameOf`
     *   turns a monster index into a name; without it the per-enemy split is skipped.
     * @returns {Object} Player index → `{damage, hits, crits, misses, byAbility, byEnemy}`
     */
    function foldEvents(tally, events, { filterNonDamaging = true, nonDamaging, nameOf } = {}) {
        for (const event of events || []) {
            // A death is not a swing, and counting it as one would add a phantom
            // hit to whoever happened to be casting
            if (event.isKill) continue;

            const player = (tally[event.playerIndex] = tally[event.playerIndex] || {
                damage: 0,
                hits: 0,
                crits: 0,
                misses: 0,
                byAbility: {},
                byEnemy: {},
            });

            // Counted before the filter: a miss is a swing that happened, and
            // dropping it would flatter the hit rate of whatever was cast
            if (event.isMiss) player.misses++;
            if (filterNonDamaging && !isDamagingAction(event.action, nonDamaging)) continue;

            if (!event.isMiss && !event.isHeal) {
                player.damage += event.amount;
                player.hits++;
                if (event.isCrit) player.crits++;
            }

            const ability = (player.byAbility[event.action] = player.byAbility[event.action] || {
                damage: 0,
                hits: 0,
                crits: 0,
                misses: 0,
            });
            if (event.isMiss) ability.misses++;
            else if (!event.isHeal) {
                ability.damage += event.amount;
                ability.hits++;
                if (event.isCrit) ability.crits++;
            }

            // The same split again, by what was being hit rather than by what was
            // swung. A party's enemy rows belong under the player who fought them —
            // one player kiting while another burns the boss is two different
            // fights, and a party-wide enemy total averages them into neither.
            const name = nameOf ? nameOf(event.monsterIndex) : null;
            if (!name) continue;

            const enemy = (player.byEnemy[name] = player.byEnemy[name] || {
                damage: 0,
                hits: 0,
                crits: 0,
                misses: 0,
                byAbility: {},
            });
            const against = (enemy.byAbility[event.action] = enemy.byAbility[event.action] || {
                damage: 0,
                hits: 0,
                crits: 0,
                misses: 0,
            });

            if (event.isMiss) {
                enemy.misses++;
                against.misses++;
            } else if (!event.isHeal) {
                enemy.damage += event.amount;
                enemy.hits++;
                against.damage += event.amount;
                against.hits++;
                if (event.isCrit) {
                    enemy.crits++;
                    against.crits++;
                }
            }
        }
        return tally;
    }

    /**
     * Fold events into a per-monster tally.
     *
     * The player table answers "who is doing the damage". This answers "to what",
     * which is the other half of a fight: a run that looks slow is often one zone's
     * worth of a single tanky monster rather than a rotation problem, and no
     * per-ability figure can say so.
     *
     * Keyed by name rather than by index, because an index is one spawn — a zone
     * cycles through dozens of them and the question is about the kind of monster,
     * not this particular rat.
     *
     * @param {Object} tally - `{}` or a previous return, mutated
     * @param {Array<Object>} events - From `attributeTick`
     * @param {Function} nameOf - `(monsterIndex) => string|null`
     * @returns {Object} Monster name → `{damage, hits, crits, misses, kills, byAbility}`
     */
    function foldEnemies(tally, events, nameOf) {
        for (const event of events || []) {
            const name = nameOf(event.monsterIndex);
            if (!name) continue;

            const enemy = (tally[name] = tally[name] || {
                damage: 0,
                hits: 0,
                crits: 0,
                misses: 0,
                kills: 0,
                byAbility: {},
            });

            if (event.isKill) {
                enemy.kills++;
                continue;
            }

            const ability = (enemy.byAbility[event.action] = enemy.byAbility[event.action] || {
                damage: 0,
                hits: 0,
                crits: 0,
                misses: 0,
            });

            if (event.isMiss) {
                enemy.misses++;
                ability.misses++;
            } else if (!event.isHeal) {
                enemy.damage += event.amount;
                enemy.hits++;
                ability.damage += event.amount;
                ability.hits++;
                if (event.isCrit) {
                    enemy.crits++;
                    ability.crits++;
                }
            }
        }
        return tally;
    }

    var damageAttribution = /*#__PURE__*/Object.freeze({
        __proto__: null,
        attributeTick: attributeTick,
        findCaster: findCaster,
        foldEnemies: foldEnemies,
        foldEvents: foldEvents,
        isDamagingAction: isDamagingAction,
        newAttributionState: newAttributionState,
        noteActions: noteActions
    });

    /**
     * Consent gate for the adopt-once migration.
     *
     * Legacy account-wide data is never silently claimed by whichever character
     * logs in first. The first time an adoptable value is found, one modal asks
     * which character should inherit the pre-scoping data; until the user
     * confirms, every legacy value stays where it is. The heuristics (game mode,
     * test names, networth history) only choose which character the dialog
     * preselects.
     *
     * The decision is stored account-wide under `adoptionTargetCharacterId` and
     * can be reopened from the console via `Toolasha.debug.chooseDataOwner()`.
     */

    const DECISION_KEY = 'adoptionTargetCharacterId';

    /** undefined = not read yet, null = undecided, string = chosen character id. */
    let cachedDecision;

    /** One prompt per session, shared by every concurrent readScoped call. */
    let promptPromise = null;

    /**
     * The character chosen to inherit legacy data, or null while undecided.
     * @returns {Promise<string|null>} Chosen character id
     */
    async function getAdoptionTargetId() {
        if (cachedDecision === undefined) {
            cachedDecision = await storage.get(DECISION_KEY, 'settings', null);
        }
        return cachedDecision;
    }

    /**
     * Record the choice.
     * @param {string} id - Character id that inherits legacy data
     * @returns {Promise<void>}
     */
    async function setAdoptionTargetId(id) {
        cachedDecision = id;
        await storage.set(DECISION_KEY, id, 'settings', true);
    }

    /**
     * Show the choose-a-character dialog (once per session).
     *
     * Fire-and-forget from data paths: callers must not await this before
     * returning a fallback, or a modal would block feature initialization.
     * @param {{recommendedId?: string|null}} [options] - Which character to preselect
     * @returns {Promise<string|null>} The chosen id, or null for "not now"
     */
    function requestAdoptionConsent(options = {}) {
        if (promptPromise) return promptPromise;
        if (typeof document === 'undefined' || !document.body) return Promise.resolve(null);

        promptPromise = (async () => {
            try {
                const names = (await storage.get('accountCharacterNames', 'settings', null)) || {};
                const currentId = dataManager.getCurrentCharacterId();
                const currentName = dataManager.getCurrentCharacterName?.() || '';
                const known = { ...names };
                if (currentId && !known[currentId]) known[currentId] = currentName || String(currentId);
                const recommended = options.recommendedId || currentId;
                const chosen = await showDialog(known, recommended, currentId);
                if (chosen) await setAdoptionTargetId(chosen);
                return chosen;
            } catch (error) {
                console.error('[AdoptionConsent] Prompt failed:', error);
                return null;
            }
        })();
        return promptPromise;
    }

    /**
     * The dialog itself. Resolves with a character id or null for "not now".
     * @param {Record<string, string>} characters - id → display name
     * @param {string|null} recommendedId - Preselected id
     * @param {string|null} currentId - The logged-in character, labeled as such
     * @returns {Promise<string|null>} Choice
     */
    function showDialog(characters, recommendedId, currentId) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            // Above every panel tier — this blocks a data migration, nothing may cover it
            overlay.style.cssText =
                'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:2147483600; ' +
                'display:flex; align-items:center; justify-content:center;';

            const ids = Object.keys(characters);
            const rows = ids
                .map((id) => {
                    const checked = id === recommendedId ? ' checked' : '';
                    const who = `${characters[id]}${id === currentId ? ' (this character)' : ''}`;
                    return (
                        `<label style="display:block; margin:4px 0; cursor:pointer;">` +
                        `<input type="radio" name="mwi-adopt-target" value="${id}"${checked}> ${who}</label>`
                    );
                })
                .join('');

            const card = document.createElement('div');
            card.style.cssText =
                'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:8px; ' +
                'padding:16px 20px; max-width:420px; font-size:13px; line-height:1.5;';
            card.innerHTML =
                `<div style="font-weight:700; font-size:14px; margin-bottom:8px;">Toolasha — who owns the saved data?</div>` +
                `<div style="color:#aaa; margin-bottom:10px;">Saved data from before per-character scoping was found ` +
                `(watchlist, savings targets, trackers, panel state…). Choose which character should inherit it — ` +
                `nothing moves until you confirm.</div>` +
                rows +
                `<div style="margin-top:12px; display:flex; gap:8px; justify-content:flex-end;">` +
                `<button id="mwi-adopt-later" style="background:#333; color:#ccc; border:1px solid #555; border-radius:4px; padding:4px 12px; cursor:pointer;">Not now</button>` +
                `<button id="mwi-adopt-confirm" style="background:#4a6fdc; color:#fff; border:none; border-radius:4px; padding:4px 12px; cursor:pointer;">Confirm</button>` +
                `</div>` +
                `<div style="color:#777; margin-top:8px; font-size:11px;">Applies as data is next read; reload to apply everywhere. ` +
                `Reopen later with Toolasha.debug.chooseDataOwner().</div>`;

            overlay.appendChild(card);
            document.body.appendChild(overlay);

            const done = (value) => {
                overlay.remove();
                resolve(value);
            };
            card.querySelector('#mwi-adopt-confirm').addEventListener('click', () => {
                const picked = card.querySelector('input[name="mwi-adopt-target"]:checked');
                done(picked ? picked.value : null);
            });
            card.querySelector('#mwi-adopt-later').addEventListener('click', () => done(null));
        });
    }

    /**
     * Append-only history, stored as records rather than as one array.
     *
     * ## The write amplification this exists to end
     *
     * A recorder that keeps its history in a single key does the same three things
     * on every event: read the whole array, push one entry, write the whole array
     * back. The cost of recording one loot drop is therefore the size of every loot
     * drop already recorded, and it grows for as long as the player keeps playing —
     * which is the shape of every quota failure this script has had. The loot log
     * rewrote five hundred entries per `loot_log_updated`; the alchemy trackers
     * rewrote every session ever, immediately, on every completed action.
     *
     * Splitting the array over several keys makes the write proportional to what
     * changed instead of to what is kept. A new entry lands in one record; the other
     * records are untouched, so IndexedDB never sees them.
     *
     * ## Chunks, not one key per entry
     *
     * A key per entry would make every write minimal, and would also put a thousand
     * keys per character into a store whose soft budget is measured in hundreds (see
     * `STORE_KEY_BUDGETS` in `core/storage.js`). Grouping entries by the hour, day or
     * month they belong to keeps both numbers small: the record written is the
     * current bucket, which holds the handful of entries recorded since the bucket
     * opened, and the key count grows with calendar time rather than with events.
     *
     * ## What the callers keep
     *
     * Nothing above this changes shape. A recorder still holds its history as one
     * array, still hands the whole array to `save()`, and still gets the whole array
     * back from `load()`. The diff against the last known state is what turns a
     * whole-array save into a one-record write, so the call sites did not have to
     * learn about chunking to stop paying for it.
     *
     * ## Migration, and what happens when the disk is full
     *
     * The legacy single-array key is split on the first read and then deleted. If
     * the split cannot be written — which on a full disk is exactly when it matters —
     * the legacy key is left alone and the recorder keeps using it. A migration that
     * bricked the history the moment storage filled up would be worse than the write
     * amplification it was meant to fix.
     */


    /**
     * The character ids a set of record keys names.
     *
     * Record keys are `<prefix>_<characterId>_<chunkId>`, so the id is the segment
     * between the prefix and the next underscore. Character ids are alphanumeric
     * (see `NETWORTH_SERIES_RE` in `utils/character-key.js`), which is what makes
     * that split unambiguous.
     *
     * @param {Array<string>} keys - Keys from one store
     * @param {string} prefix - The record prefix including its trailing underscore
     * @returns {Array<string>} Character ids, in key order, deduplicated
     */
    function idsFromRecordKeys(keys, prefix) {
        const ids = [];
        const seen = new Set();
        for (const key of keys || []) {
            if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const end = rest.indexOf('_');
            if (end <= 0) continue;
            const id = rest.slice(0, end);
            if (seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
        }
        return ids;
    }

    /**
     * Every record key in a store belonging to one character.
     *
     * @param {Array<string>} keys - Keys from one store
     * @param {string} prefix - The record prefix, without its trailing underscore
     * @param {string} charId - Whose records to pick out
     * @returns {Array<string>} Matching keys, in chunk-id order
     */
    function recordKeysFor(keys, prefix, charId) {
        const scoped = `${prefix}_${charId}_`;
        return (keys || []).filter((key) => typeof key === 'string' && key.startsWith(scoped)).sort();
    }

    /**
     * Per-character storage key helpers.
     *
     * Character-specific state stored under a bare key leaks between characters —
     * the market cow's watchlist shows up on the iron cow. Every feature that
     * persists per-character state should build its key through {@link characterKey}
     * and read through {@link readScoped}, which also handles one-time adoption of
     * the legacy global value.
     *
     * Adoption policy: a legacy global value almost always belongs to the account's
     * main character. It is adopted (moved to the scoped key, legacy deleted) only
     * by an adoption candidate — a non-ironcow character which, when several
     * characters have networth history, owns the longest series. Other characters
     * simply start clean and leave the legacy value in place for the main to claim.
     */

    const NETWORTH_SERIES_RE = /^networth_[0-9a-zA-Z]+$/;

    /**
     * The networth series after it was split into one record per month.
     *
     * A migrated character has no `networth_<id>` key at all, so the length
     * comparison below would see nothing and let every character adopt — including
     * the alts the policy exists to keep out.
     */
    const NETWORTH_RECORD_PREFIX = 'networthSeries';

    /** Per-character memo of the adoption decision, reset only on reload. */
    const adoptionDecisions = new Map();

    /**
     * A storage key scoped to the character now logged in.
     *
     * Uses the codebase's dominant `${base}_${charId}` idiom with a `'default'`
     * fallback before login, so account-view suffix parsing keeps working.
     * @param {string} base - The unscoped key
     * @returns {string} `base_<characterId>`, or `base_default` before login
     */
    function characterKey(base) {
        return `${base}_${dataManager.getCurrentCharacterId() || 'default'}`;
    }

    /**
     * How many networth points one character has recorded, either way it is stored.
     *
     * The pre-migration single key wins where it exists: its presence is what says
     * the split has not happened, so any records beside it are a half-finished
     * migration rather than the series.
     *
     * @param {Array<string>} keys - Every key in the networth store
     * @param {string} id - Whose series
     * @returns {Promise<number>} Points recorded
     */
    async function networthSeriesLength(keys, id) {
        const legacy = await storage.get(`networth_${id}`, 'networthHistory', null);
        if (Array.isArray(legacy) && legacy.length > 0) return legacy.length;

        let length = 0;
        for (const key of recordKeysFor(keys, NETWORTH_RECORD_PREFIX, id)) {
            const chunk = await storage.get(key, 'networthHistory', null);
            if (Array.isArray(chunk)) length += chunk.length;
        }
        return length;
    }

    /**
     * Whether the given character should inherit legacy (pre-scoping) global data.
     *
     * Iron cow characters never adopt — the legacy value was almost certainly
     * written by the market character. When several characters have networth
     * history, only the one with the longest series adopts. On any failure the
     * check errs toward adopting, so a solo-character install migrates cleanly.
     * @param {string} charId - The character considering adoption
     * @returns {Promise<boolean>} True when this character may claim legacy data
     */
    async function isAdoptionCandidate(charId) {
        if (adoptionDecisions.has(charId)) {
            return adoptionDecisions.get(charId);
        }

        let decision = true;
        try {
            // Same signal MCS reads: character.gameMode. 'standard' is the market
            // character; 'ironcow' and 'legacy_ironcow' never adopt.
            const gameMode = dataManager.getCurrentCharacterGameMode();
            const name =
                typeof dataManager.getCurrentCharacterName === 'function'
                    ? dataManager.getCurrentCharacterName() || ''
                    : '';
            if (typeof gameMode === 'string' && gameMode.includes('ironcow')) {
                decision = false;
            } else if (/test/i.test(name)) {
                // A test character is never the main, whatever its history says.
                decision = false;
            } else {
                const keys = await storage.getAllKeys('networthHistory');
                const ids = new Set([
                    ...keys
                        .filter((key) => typeof key === 'string' && NETWORTH_SERIES_RE.test(key))
                        .map((key) => key.slice('networth_'.length)),
                    ...idsFromRecordKeys(keys, `${NETWORTH_RECORD_PREFIX}_`),
                ]);

                if (ids.size > 0 && !ids.has(charId)) {
                    // Someone on this account has recorded history and this
                    // character has none — it is not the main. Skipping the
                    // comparison here is what once let a fresh alt adopt
                    // everything just by logging in first.
                    decision = false;
                } else if (ids.size > 1) {
                    let bestId = null;
                    let bestLength = -1;
                    for (const id of ids) {
                        const length = await networthSeriesLength(keys, id);
                        if (length > bestLength) {
                            bestLength = length;
                            bestId = id;
                        }
                    }
                    decision = bestId === null || bestId === charId;
                }
            }
        } catch (error) {
            console.error('[CharacterKey] Adoption check failed, adopting by default:', error);
            decision = true;
        }

        adoptionDecisions.set(charId, decision);
        return decision;
    }

    /**
     * Read a per-character key, migrating any legacy global value exactly once.
     *
     * Looks up `characterKey(base)` first. When absent and the legacy bare `base`
     * key exists, either adopts it (moves it to this character's key and deletes
     * the legacy copy — main character only, see module doc) or discards it
     * (deletes the legacy copy and starts clean), per `options.migrate`.
     *
     * Discard is for state derived from one character's gear or sim results, where
     * inheriting another character's data is worse than starting empty.
     * @param {string} base - The unscoped key
     * @param {string} [storeName] - Object store name (default: 'settings')
     * @param {*} [defaultValue] - Value returned when neither key exists
     * @param {{migrate?: 'adopt'|'discard'}} [options] - Legacy migration mode (default: 'adopt')
     * @returns {Promise<*>} The stored value or default
     */
    async function readScoped(base, storeName = 'settings', defaultValue = null, options = {}) {
        const { migrate = 'adopt' } = options;

        const scopedKey = characterKey(base);
        const scoped = await storage.get(scopedKey, storeName, null);
        if (scoped !== null) {
            return scoped;
        }

        const legacy = await storage.get(base, storeName, null);
        if (legacy === null) {
            return defaultValue;
        }

        if (migrate === 'discard') {
            await storage.delete(base, storeName);
            return defaultValue;
        }

        const charId = dataManager.getCurrentCharacterId();
        if (!charId) {
            return defaultValue;
        }

        // Adoption is user-confirmed, never automatic. The heuristics only pick
        // which character the dialog preselects.
        const targetId = await getAdoptionTargetId();
        if (targetId === null) {
            // Fire-and-forget: awaiting a modal here would hang feature init.
            isAdoptionCandidate(charId).then(
                (candidate) => requestAdoptionConsent({ recommendedId: candidate ? charId : null }),
                () => requestAdoptionConsent({})
            );
            return defaultValue;
        }
        if (targetId !== charId) {
            // Leave the legacy value in place for the chosen character to claim.
            return defaultValue;
        }

        await storage.set(scopedKey, legacy, storeName, true);
        await storage.delete(base, storeName);
        return legacy;
    }

    /**
     * Write a value under this character's scoped key.
     * @param {string} base - The unscoped key
     * @param {*} value - Value to store
     * @param {string} [storeName] - Object store name (default: 'settings')
     * @param {boolean} [immediate] - Skip write debouncing
     * @returns {Promise<boolean>} Success status
     */
    async function writeScoped(base, value, storeName = 'settings', immediate = false) {
        return storage.set(characterKey(base), value, storeName, immediate);
    }

    /**
     * Panel Geometry
     *
     * Where a floating panel was left, and how big it was left.
     *
     * Every panel in this script had its own answer to this, which is to say most of
     * them had none: they opened at a hardcoded corner at a hardcoded width, and a
     * panel you have to drag and resize on every page load is a panel you stop
     * opening. One store, keyed by panel, so a new panel gets the behaviour by
     * calling one function.
     *
     * The clamping is the part worth having apart from the DOM. A panel remembers
     * the window it was left in, and that window may since have been narrower — a
     * saved position restored blindly puts the panel somewhere you cannot reach it,
     * which looks exactly like a feature that stopped working.
     *
     * Geometry is deliberately shared by every character on the account: a panel
     * should sit where you put it whichever character you logged in as. Whether a
     * panel was *open* is not — the market character's eight open panels reopening
     * on top of the iron cow is the one part of this that is per-character, and it
     * lives in its own key, `panelOpenState_<characterId>`.
     */


    const STORAGE_KEY$1 = 'panelGeometry';
    /** Per-character open flags: `{ [panelKey]: boolean }` */
    const OPEN_KEY = 'panelOpenState';

    /** Cache of every panel's geometry, so opening a panel does not wait on storage */
    let cache = null;
    let loading = null;

    /**
     * Open flags per scoped key, so switching characters loads the new set rather
     * than reusing the old one — the key is derived at read time, never at import.
     */
    const openCache = new Map();
    const openLoading = new Map();

    /** Enough of a panel to see and grab, when the whole of it cannot be shown */
    const EDGE_KEEP = 30;

    /**
     * Hold a saved geometry inside the current window.
     *
     * Size is capped at the viewport, since a panel restored wider than the screen
     * cannot be resized back — its resize grip is off the edge. Position then puts
     * the panel *fully* on screen rather than merely leaving a strip of it: the
     * close button lives at the top right of every panel here, and a panel hanging
     * off the right edge of a phone is one you cannot close. Only a panel bigger
     * than the window falls back to showing as much as there is room for.
     *
     * @param {Object} geometry - `{left, top, width, height}` in pixels
     * @param {{width: number, height: number}} viewport - The window
     * @param {{width: number, height: number}} [min] - Smallest allowed size
     * @returns {Object|null} A usable geometry, or null when there is nothing to use
     */
    function clampGeometry(geometry, viewport, min = { width: 200, height: 80 }) {
        if (!geometry) return null;

        const result = {};

        // A minimum wider than the screen is not a minimum, it is the bug it was
        // written to prevent: the Treasure panel asks for 420px back on a 400px
        // phone and comes back wider than the phone.
        const minWidth = Math.min(min.width, viewport.width);
        const minHeight = Math.min(min.height, viewport.height);

        const width = Number(geometry.width);
        const height = Number(geometry.height);
        if (Number.isFinite(width)) {
            result.width = Math.max(minWidth, Math.min(width, viewport.width));
        }
        if (Number.isFinite(height)) {
            result.height = Math.max(minHeight, Math.min(height, viewport.height));
        }

        const left = Number(geometry.left);
        const top = Number(geometry.top);
        if (Number.isFinite(left) && Number.isFinite(top)) {
            // What the panel will actually occupy once the size above is applied
            const boxWidth = Math.min(result.width ?? minWidth, viewport.width);
            const boxHeight = Math.min(result.height ?? EDGE_KEEP, viewport.height);
            result.left = Math.min(Math.max(left, 0), Math.max(0, viewport.width - boxWidth));
            result.top = Math.min(Math.max(top, 0), Math.max(0, viewport.height - boxHeight));
        }

        return Object.keys(result).length ? result : null;
    }

    /**
     * Hold a panel that is already on screen inside the window it is on screen in.
     *
     * The saved-geometry clamp only ever ran on what was *stored*, so a panel that
     * had never been moved opened wherever it was written to open — 80px in from
     * the right of a desktop, which on a 400px phone is off the side — and stayed
     * there. This measures the panel as it stands instead, which covers the default
     * position, a width in `vw` that still overflows, and a window that has since
     * been resized, with one rule.
     *
     * Nothing is touched unless it is out of bounds: a panel that fits keeps sizing
     * and anchoring itself however it likes. Anchoring is what the two guards are
     * about — an absolutely positioned panel measures from its offset parent, and a
     * centred one is offset by its own transform, so a viewport-relative `left`
     * would move either of them somewhere nobody asked for.
     *
     * @param {HTMLElement} panel - The panel, already in the document
     * @param {{width: number, height: number}} [min] - Smallest allowed size
     * @returns {Object|null} What was changed, or null when nothing needed to be
     */
    function clampPanelToViewport(panel, min) {
        if (typeof window === 'undefined' || !panel?.isConnected) return null;

        const viewport = { width: window.innerWidth, height: window.innerHeight };
        if (!(viewport.width > 0) || !(viewport.height > 0)) return null;

        if (typeof getComputedStyle === 'function') {
            const computed = getComputedStyle(panel);
            if (computed.position !== 'fixed') return null;
            if (computed.transform && computed.transform !== 'none') return null;
        }

        const rect = panel.getBoundingClientRect();
        // Not laid out yet — in a test DOM it never will be, and guessing at a
        // position from zeroes would move every panel to the top left corner
        if (!(rect.width > 0) && !(rect.height > 0)) return null;

        const clamped = clampGeometry(
            { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            viewport,
            min
        );
        if (!clamped) return null;

        const applied = {};
        if (rect.width > viewport.width && clamped.width) {
            panel.style.width = `${clamped.width}px`;
            applied.width = clamped.width;
        }
        if (Math.round(clamped.left) !== Math.round(rect.left) || Math.round(clamped.top) !== Math.round(rect.top)) {
            panel.style.left = `${clamped.left}px`;
            panel.style.top = `${clamped.top}px`;
            // Anchored from the left from here on; a panel positioned from the right
            // edge would jump the moment the window is resized
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            applied.left = clamped.left;
            applied.top = clamped.top;
        }

        return Object.keys(applied).length ? applied : null;
    }

    /**
     * Every panel's saved geometry.
     * @returns {Promise<Object>} `{ [panelKey]: geometry }`
     */
    async function allGeometry() {
        // Module-scope callers run before the database is open, and an unguarded
        // read there comes back with the default — indistinguishable from nothing
        // having been stored
        await storage.ready;
        if (cache) return cache;
        if (!loading) {
            loading = storage
                .getJSON(STORAGE_KEY$1, 'settings', {})
                .then((saved) => {
                    cache = saved || {};
                    return cache;
                })
                .catch((error) => {
                    console.error('[PanelGeometry] Loading saved geometry failed:', error);
                    cache = {};
                    return cache;
                });
        }
        return loading;
    }

    /**
     * Remember a panel's geometry.
     * @param {string} panelKey - Which panel
     * @param {Object} geometry - `{left, top, width, height}`
     */
    async function saveGeometry(panelKey, geometry) {
        const all = await allGeometry();
        all[panelKey] = { ...all[panelKey], ...geometry };
        try {
            await storage.setJSON(STORAGE_KEY$1, all, 'settings');
        } catch (error) {
            console.error('[PanelGeometry] Saving geometry failed:', error);
        }
    }

    /**
     * Forget a panel's geometry, so it opens where it was designed to.
     * @param {string} panelKey - Which panel
     */
    async function clearGeometry(panelKey) {
        const all = await allGeometry();
        delete all[panelKey];
        try {
            await storage.setJSON(STORAGE_KEY$1, all, 'settings');
        } catch (error) {
            console.error('[PanelGeometry] Clearing geometry failed:', error);
        }
    }

    /**
     * Forget where a panel was, but not how big it was.
     *
     * For a panel that places itself and is only pinned by being moved: unpinning
     * has to drop the position, and dropping the size with it would be an unasked-for
     * second change.
     *
     * @param {string} panelKey - Which panel
     */
    async function clearPosition(panelKey) {
        const all = await allGeometry();
        if (!all[panelKey]) return;

        const { left: _left, top: _top, ...rest } = all[panelKey];
        all[panelKey] = rest;
        try {
            await storage.setJSON(STORAGE_KEY$1, all, 'settings');
        } catch (error) {
            console.error('[PanelGeometry] Clearing a panel position failed:', error);
        }
    }

    /**
     * Put a panel back where it was left.
     *
     * Applied after the panel is on screen rather than before, because the geometry
     * comes from storage and the alternative is holding every panel closed until a
     * database answers. Opening at the default and settling a frame later is the
     * lesser of the two.
     *
     * @param {HTMLElement} panel - The panel
     * @param {string} panelKey - Which panel
     * @param {{width: number, height: number}} [min] - Smallest allowed size
     * @param {Object} [options] - `position: false` to restore the size only, for a
     *   panel that places itself and only remembers how big it was
     * @returns {Promise<void>}
     */
    async function restoreGeometry(panel, panelKey, min, { position = true } = {}) {
        const all = await allGeometry();
        const clamped = clampGeometry(all[panelKey], { width: window.innerWidth, height: window.innerHeight }, min);
        if (!panel?.isConnected) return;

        if (clamped) {
            if (clamped.width) panel.style.width = `${clamped.width}px`;
            if (clamped.height) panel.style.height = `${clamped.height}px`;
            if (position && clamped.left !== undefined) {
                panel.style.left = `${clamped.left}px`;
                panel.style.top = `${clamped.top}px`;
                // Anchored from the left from here on; a panel positioned from the
                // right edge would jump the moment the window is resized
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
            }
        }

        // Whether or not anything was stored: a panel opening at the position it
        // was written to open at is off the side of a phone just as surely as one
        // restoring a position saved on a desktop.
        clampPanelToViewport(panel, min);
    }

    /**
     * Lift the `open` flags out of the shared geometry record, once.
     *
     * They used to live beside `left`/`top`, which is why every panel the market
     * character left open reopened on the iron cow. Moving them to the bare
     * `panelOpenState` key turns them into an ordinary legacy value, which
     * {@link readScoped} then hands to whichever character is entitled to adopt it —
     * the geometry stays exactly where it is, shared, which is what it should be.
     *
     * @returns {Promise<void>}
     */
    async function liftLegacyOpenFlags() {
        const all = await allGeometry();

        const flags = {};
        let found = false;
        for (const [panelKey, geometry] of Object.entries(all)) {
            if (geometry && typeof geometry === 'object' && 'open' in geometry) {
                found = true;
                flags[panelKey] = Boolean(geometry.open);
                const { open: _open, ...rest } = geometry;
                all[panelKey] = rest;
            }
        }
        if (!found) return;

        // An earlier character may have lifted a set already and not been allowed to
        // adopt it; that copy is the newer one and wins
        const waiting = await storage.get(OPEN_KEY, 'settings', null);
        await storage.set(OPEN_KEY, { ...flags, ...(waiting || {}) }, 'settings', true);
        await storage.setJSON(STORAGE_KEY$1, all, 'settings');
    }

    /**
     * This character's open flags, loaded once per character.
     * @returns {Promise<Object>} `{ [panelKey]: boolean }`
     */
    async function openFlags() {
        await storage.ready;

        const key = characterKey(OPEN_KEY);
        if (openCache.has(key)) return openCache.get(key);

        if (!openLoading.has(key)) {
            const load = (async () => {
                let flags = {};
                try {
                    await liftLegacyOpenFlags();
                    const saved = await readScoped(OPEN_KEY, 'settings', null, { migrate: 'adopt' });
                    if (saved && typeof saved === 'object') flags = saved;
                } catch (error) {
                    console.error('[PanelGeometry] Loading which panels were open failed:', error);
                }
                openCache.set(key, flags);
                return flags;
            })();
            openLoading.set(key, load);
        }
        return openLoading.get(key);
    }

    /**
     * Whether a panel was open when the page was last left.
     *
     * Per character, unlike the geometry: a panel belongs where you left it on every
     * character, but the eight panels one character had up are that character's. A
     * panel that has to be reopened after every refresh is a panel that gets opened
     * once and then not bothered with.
     *
     * @param {string} panelKey - The panel's key
     * @param {boolean} open - Whether it is open now
     * @returns {Promise<void>}
     */
    async function saveOpenState(panelKey, open) {
        try {
            const flags = await openFlags();
            flags[panelKey] = Boolean(open);
            await writeScoped(OPEN_KEY, flags, 'settings');
        } catch (error) {
            console.error('[PanelGeometry] Remembering whether a panel was open failed:', error);
        }
    }

    /**
     * @param {string} panelKey - The panel's key
     * @returns {Promise<boolean>} Whether it should be reopened
     */
    async function wasOpen(panelKey) {
        try {
            const flags = await openFlags();
            return Boolean(flags[panelKey]);
        } catch (error) {
            console.error('[PanelGeometry] Reading whether a panel was open failed:', error);
            return false;
        }
    }

    /**
     * Resolves once there is a `<body>` to append a panel to.
     *
     * The script runs at `document-start`, so at the moment these modules are
     * imported there is no body — a panel reopening itself then would throw on the
     * append and take the rest of the module's start-up with it.
     *
     * @returns {Promise<void>}
     */
    function bodyReady() {
        if (typeof document === 'undefined' || document.body) return Promise.resolve();
        return new Promise((resolve) => {
            document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
        });
    }

    /**
     * Resolves once there is a character to ask about.
     *
     * Panels ask at module scope, which is long before the websocket has said who
     * logged in — and asking then reads the *wrong character's* key, which comes
     * back empty and looks exactly like "nothing was left open". Waiting is the
     * difference between per-character open state working and never reopening
     * anything again.
     *
     * @returns {Promise<void>}
     */
    function characterReady() {
        if (dataManager.getCurrentCharacterId()) return Promise.resolve();
        return new Promise((resolve) => {
            const onInitialized = () => {
                dataManager.off('character_initialized', onInitialized);
                resolve();
            };
            dataManager.on('character_initialized', onInitialized);
        });
    }

    /**
     * Reopen a panel that was open when the page was last left.
     *
     * The waiting is the whole of it, and is why this is one function rather than a
     * `wasOpen` call in each panel. Panels ask at module scope, which is before the
     * database is open *and* before there is a body to draw into; asking then gets
     * the default back, which is indistinguishable from having been closed. That is
     * why remembering appeared to work and reopening never did. Which character is
     * logged in is the third thing not yet known at that moment, and now matters as
     * much as the other two.
     *
     * @param {string} panelKey - The panel's key
     * @param {Function} reopen - Called only if it was open
     * @returns {Promise<void>}
     */
    async function reopenIfLeftOpen(panelKey, reopen) {
        try {
            await characterReady();
            if (!(await wasOpen(panelKey))) return;
            await bodyReady();
            reopen();
        } catch (error) {
            console.error('[PanelGeometry] Reopening a panel failed:', error);
        }
    }

    /**
     * Test-only: forget the loaded geometry and open flags.
     */
    function _resetCaches() {
        cache = null;
        loading = null;
        openCache.clear();
        openLoading.clear();
    }

    var panelGeometry = /*#__PURE__*/Object.freeze({
        __proto__: null,
        _resetCaches: _resetCaches,
        allGeometry: allGeometry,
        clampGeometry: clampGeometry,
        clampPanelToViewport: clampPanelToViewport,
        clearGeometry: clearGeometry,
        clearPosition: clearPosition,
        reopenIfLeftOpen: reopenIfLeftOpen,
        restoreGeometry: restoreGeometry,
        saveGeometry: saveGeometry,
        saveOpenState: saveOpenState,
        wasOpen: wasOpen
    });

    /**
     * Floating Panel Z-Index Manager
     * Manages bring-to-front ordering for persistent floating panels.
     * All panels are capped below PANEL_Z_CAP (config.Z_FLOATING_PANEL + 99, i.e. 1199)
     * so they never cross the game's MUI modal layer (~1300).
     */


    const panels = new Set();

    /**
     * The highest z-index any registered floating panel may reach.
     *
     * Exported so anything that must sit above every panel — the choice dialog's
     * backdrop, for one — can derive its own z-index from this instead of
     * guessing a number that has to be kept in sync by hand.
     */
    const PANEL_Z_CAP = config.Z_FLOATING_PANEL + 99;

    /** How long to wait after the last resize event before re-clamping panels */
    const RESIZE_DEBOUNCE_MS = 200;

    /**
     * Register a floating panel element for z-index management.
     *
     * Every floating panel in the script comes through here, which makes it the one
     * place a viewport clamp reaches all of them — including the panels that open
     * at a hardcoded corner and never ask `restoreGeometry` for anything. The clamp
     * waits a frame because a panel is commonly registered in the same tick it is
     * appended, and an element the browser has not laid out yet measures as nothing.
     *
     * @param {HTMLElement} el - The panel element
     */
    function registerFloatingPanel(el) {
        panels.add(el);
        afterLayout(() => {
            try {
                if (panels.has(el)) clampPanelToViewport(el);
            } catch (error) {
                console.error('[PanelZIndex] Holding a panel inside the window failed:', error);
            }
        });
    }

    /**
     * Run something once the browser has had a chance to lay the page out.
     * @param {Function} run - What to run
     */
    function afterLayout(run) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
        else setTimeout(run, 0);
    }

    /**
     * Unregister a floating panel element
     * @param {HTMLElement} el - The panel element
     */
    function unregisterFloatingPanel(el) {
        panels.delete(el);
    }

    /**
     * Bring a panel to the front among all registered panels,
     * without exceeding PANEL_Z_CAP.
     * @param {HTMLElement} el - The panel to bring forward
     */
    function bringPanelToFront(el) {
        const base = config.Z_FLOATING_PANEL;
        const cap = PANEL_Z_CAP;

        let maxZ = base;
        for (const p of panels) {
            const z = parseInt(p.style.zIndex) || base;
            if (z > maxZ) maxZ = z;
        }

        const next = maxZ + 1;
        if (next > cap) {
            // Overflow — reassign all from base upward, put el last
            let i = base;
            for (const p of panels) {
                if (p !== el) p.style.zIndex = String(i++);
            }
            el.style.zIndex = String(i);
        } else {
            el.style.zIndex = String(next);
        }
    }

    /**
     * Nudge every registered panel that is now out of bounds back on screen.
     *
     * A panel remembers where it was left, and a resize does not go through
     * `restoreGeometry` — nothing was re-checking the saved position against a
     * window that has since shrunk, so a panel dragged toward the right edge was
     * stranded off-screen the moment the window got smaller. A phone rotating is
     * the same event, and the reason the size is re-checked here too and not only
     * the position. Only panels that are actually out of bounds are touched, and
     * the result is never persisted — the saved geometry is still what a larger
     * window restores to.
     */
    function reclampRegisteredPanels() {
        for (const panel of panels) {
            try {
                clampPanelToViewport(panel);
            } catch (error) {
                console.error('[PanelZIndex] Re-clamping a panel after a resize failed:', error);
            }
        }
    }

    let resizeTimer = null;

    function onWindowResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(reclampRegisteredPanels, RESIZE_DEBOUNCE_MS);
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('resize', onWindowResize);
    }

    var panelZIndex = /*#__PURE__*/Object.freeze({
        __proto__: null,
        PANEL_Z_CAP: PANEL_Z_CAP,
        bringPanelToFront: bringPanelToFront,
        registerFloatingPanel: registerFloatingPanel,
        unregisterFloatingPanel: unregisterFloatingPanel
    });

    /**
     * Choice Dialog
     *
     * A modal that asks a question and offers more than two answers.
     *
     * `window.confirm` offers exactly two, so a three-way choice has to be squeezed
     * into OK and Cancel with a paragraph explaining which is which — "OK to ADD,
     * Cancel to REPLACE" is a question you have to read twice and can still get
     * wrong, and getting it wrong overwrites a ledger. Buttons that say what they do
     * cannot be misread.
     *
     * Deliberately promise-based rather than callback-based so the calling code
     * reads as a decision rather than as a continuation.
     */


    const COLORS = {
        background: 'rgba(12, 15, 26, 0.98)',
        border: 'rgba(120, 160, 255, 0.35)',
        text: '#e8ecf5',
        textDim: 'rgba(232, 236, 245, 0.65)',
        accent: '#9ec4ff',
    };

    /**
     * Ask a question and wait for an answer.
     *
     * Escape and a click outside both resolve to null, matching what dismissing a
     * dialog means everywhere else: no, and nothing has happened.
     *
     * @param {Object} options - The question
     * @param {string} options.title - Heading
     * @param {string} [options.message] - Body text; newlines become line breaks
     * @param {Array<{value: string, label: string, hint?: string, tone?: string}>} options.choices -
     *   Buttons, in order. `tone` may be `'primary'`, `'danger'` or left off.
     * @returns {Promise<string|null>} The chosen value, or null when dismissed
     */
    function askChoice({ title, message = '', choices = [] }) {
        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            Object.assign(backdrop.style, {
                position: 'fixed',
                inset: '0',
                background: 'rgba(0, 0, 0, 0.55)',
                // Always above every floating panel, including one raised by
                // bringPanelToFront to PANEL_Z_CAP — this dialog is often opened
                // from that very panel and must never render behind it
                zIndex: String(PANEL_Z_CAP + 1),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            });

            const dialog = document.createElement('div');
            Object.assign(dialog.style, {
                minWidth: '320px',
                maxWidth: '460px',
                background: COLORS.background,
                border: `1px solid ${COLORS.border}`,
                borderRadius: '8px',
                boxShadow: '0 12px 48px rgba(0, 0, 0, 0.7)',
                color: COLORS.text,
                fontSize: '13px',
                padding: '14px 16px 12px',
            });

            const heading = document.createElement('div');
            heading.textContent = title;
            Object.assign(heading.style, { fontWeight: 'bold', color: COLORS.accent, marginBottom: '6px' });
            dialog.appendChild(heading);

            if (message) {
                const body = document.createElement('div');
                body.textContent = message;
                Object.assign(body.style, {
                    color: COLORS.textDim,
                    marginBottom: '12px',
                    lineHeight: '1.45',
                    whiteSpace: 'pre-wrap',
                });
                dialog.appendChild(body);
            }

            const buttons = document.createElement('div');
            Object.assign(buttons.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' });

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKeyDown, true);
                backdrop.remove();
                resolve(value);
            };

            const onKeyDown = (event) => {
                if (event.key !== 'Escape') return;
                // Captured, because the game listens for Escape too and would close
                // whatever is behind this dialog as well
                event.stopPropagation();
                event.preventDefault();
                finish(null);
            };

            for (const choice of choices) {
                const button = document.createElement('button');
                button.textContent = choice.label;
                if (choice.hint) button.title = choice.hint;

                const tone = choice.tone === 'danger' ? '#ff8080' : choice.tone === 'primary' ? COLORS.accent : COLORS.text;
                Object.assign(button.style, {
                    background: choice.tone === 'primary' ? 'rgba(158, 196, 255, 0.18)' : 'rgba(255, 255, 255, 0.07)',
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: '4px',
                    color: tone,
                    cursor: 'pointer',
                    fontSize: '13px',
                    padding: '5px 14px',
                });
                button.addEventListener('click', () => finish(choice.value));
                buttons.appendChild(button);
            }

            dialog.appendChild(buttons);
            backdrop.appendChild(dialog);

            backdrop.addEventListener('mousedown', (event) => {
                if (event.target === backdrop) finish(null);
            });
            document.addEventListener('keydown', onKeyDown, true);

            document.body.appendChild(backdrop);
            // Focused so Enter and Tab work from the keyboard, and so the dialog
            // takes focus away from whatever was behind it
            buttons.firstElementChild?.focus();
        });
    }

    var choiceDialog = /*#__PURE__*/Object.freeze({
        __proto__: null,
        askChoice: askChoice
    });

    /**
     * Floating Panel helpers
     *
     * The drag behaviour every floating panel needs, in one place.
     *
     * Written for the overlay shell, which has to remember where it was left. The
     * PFormance and Treasure panels each carry their own copy of this and could
     * adopt it; they are left alone here because moving working code is a separate
     * change from adding new code.
     */


    /**
     * Let a panel be dragged by one of its parts.
     *
     * Listeners live on the document rather than the handle, because a fast drag
     * outruns the element under the cursor and the panel would be left stuck to the
     * pointer. They are attached on mousedown and removed on mouseup, so nothing
     * stays bound while the panel sits still.
     *
     * @param {HTMLElement} panel - The thing that moves
     * @param {HTMLElement} handle - The part you grab
     * @param {Function} [onDrop] - Called with `{left, top}` once the panel has
     *   actually been moved. A click that never moved is not a drag.
     * @returns {Function} Detaches the handle's listener
     */
    function makeDraggable(panel, handle, onDrop) {
        let offsetX = 0;
        let offsetY = 0;
        let dragging = false;
        let moved = false;

        // Pointer events rather than mouse events, so a finger works the same as a
        // cursor — mousedown never fires on a touchscreen and every panel was
        // simply immovable there. touch-action:none is the half that is easy to
        // forget: without it the browser claims the gesture for scrolling and the
        // pointermove stream ends after a few pixels.
        handle.style.touchAction = 'none';

        const onPointerMove = (event) => {
            if (!dragging) return;
            moved = true;
            // Anchored left/top from here on: a panel positioned from the right edge
            // would jump the moment the window is resized
            panel.style.left = `${event.clientX - offsetX}px`;
            panel.style.top = `${event.clientY - offsetY}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        };

        const onPointerUp = () => {
            if (!dragging) return;
            dragging = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);

            // A press that never moved is a click, not a drag. Saving one is
            // harmless for a panel that only remembers where it is, and wrong for
            // the Treasure popup, where being moved is how you tell it to stop
            // following the chest dialog — clicking its header once silently
            // pinned it somewhere and auto-placement appeared to stop working.
            if (!moved) return;
            onDrop?.({ left: panel.style.left, top: panel.style.top });
        };

        const onPointerDown = (event) => {
            // Only the primary button, and never a click that was meant for a
            // control sitting in the handle
            if (event.button !== 0 || event.target.closest('button, input, select')) return;

            bringPanelToFront(panel);
            dragging = true;
            moved = false;
            const rect = panel.getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            // A touch interrupted by the system (notification, palm rejection)
            // cancels rather than lifts; without this the panel stays glued
            document.addEventListener('pointercancel', onPointerUp);
            event.preventDefault();
        };

        handle.addEventListener('pointerdown', onPointerDown);

        return () => {
            handle.removeEventListener('pointerdown', onPointerDown);
            onPointerUp();
        };
    }

    /**
     * Give a panel a corner you can drag to resize it.
     *
     * A grip rather than CSS `resize: both`, because the native handle needs the
     * element to scroll its own overflow — these panels hide theirs so the rounded
     * corners stay rounded — and it cannot be styled to be visible against a dark
     * panel. It also gives us the minimums, which the native handle does not
     * enforce below the content size.
     *
     * @param {HTMLElement} panel - The thing that resizes
     * @param {Object} [options] - Options
     * @param {number} [options.minWidth] - Smallest width
     * @param {number} [options.minHeight] - Smallest height
     * @param {Function} [options.onResize] - Called with `{width, height}` once the drag ends
     * @returns {Function} Removes the grip
     */
    function makeResizable(panel, { minWidth = 200, minHeight = 80, onResize } = {}) {
        const grip = document.createElement('div');
        grip.title = 'Drag to resize';
        Object.assign(grip.style, {
            position: 'absolute',
            right: '0',
            bottom: '0',
            width: '14px',
            height: '14px',
            cursor: 'nwse-resize',
            // Two hairlines reading as a corner, rather than an icon that would need
            // to be legible against whatever the panel's last row happens to be
            background:
                'linear-gradient(135deg, transparent 0 45%, rgba(158, 196, 255, 0.55) 45% 55%, transparent 55% 72%, ' +
                'rgba(158, 196, 255, 0.55) 72% 82%, transparent 82%)',
            zIndex: '2',
        });

        let startX = 0;
        let startY = 0;
        let startWidth = 0;
        let startHeight = 0;
        let resizing = false;

        // Same pointer-events story as the drag handle; and a 14px grip is a
        // mouse-sized target, so a coarse pointer gets a bigger one
        grip.style.touchAction = 'none';
        if (hasCoarsePointer()) {
            grip.style.width = '26px';
            grip.style.height = '26px';
        }

        const onPointerMove = (event) => {
            if (!resizing) return;
            panel.style.width = `${Math.max(minWidth, startWidth + event.clientX - startX)}px`;
            panel.style.height = `${Math.max(minHeight, startHeight + event.clientY - startY)}px`;
        };

        const onPointerUp = () => {
            if (!resizing) return;
            resizing = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);
            const rect = panel.getBoundingClientRect();
            onResize?.({ width: Math.round(rect.width), height: Math.round(rect.height) });
        };

        const onPointerDown = (event) => {
            if (event.button !== 0) return;
            resizing = true;
            const rect = panel.getBoundingClientRect();
            startX = event.clientX;
            startY = event.clientY;
            startWidth = rect.width;
            startHeight = rect.height;
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
            event.preventDefault();
            event.stopPropagation();
        };

        grip.addEventListener('pointerdown', onPointerDown);
        panel.appendChild(grip);

        return () => {
            grip.removeEventListener('pointerdown', onPointerDown);
            onPointerUp();
            grip.remove();
        };
    }

    // A `clampToViewport` lived here and had no callers. Panels are clamped by
    // `panel-geometry.js` on restore and by the overlay's own `_clampToViewport`,
    // both of which keep the whole panel on screen; this one kept a 40px strip of
    // it, on the reasoning that a strip is enough to grab and drag back. Nothing
    // agreed, so it was two rules and one of them was never applied.

    var floatingPanel = /*#__PURE__*/Object.freeze({
        __proto__: null,
        makeDraggable: makeDraggable,
        makeResizable: makeResizable
    });

    /**
     * Simple panel
     *
     * The floating-panel shell, once.
     *
     * Every panel in this script wants the same six things: a header you can drag
     * by, a close button, a scrolling body, a resize grip, a remembered position and
     * a refresh on a timer. Written out per panel that is six chances to open
     * somewhere unreachable, and it has already happened.
     *
     * What differs between panels is only what fills the body, so that is the only
     * thing a caller supplies.
     */


    const DEFAULT_REFRESH_MS = 3000;

    /**
     * @param {Object} definition - What makes this panel itself
     * @param {string} definition.id - DOM id and geometry key
     * @param {string} definition.title - Header text
     * @param {{width: number, height: number}} definition.size - Opening size
     * @param {Function} definition.draw - `(body, panel) => void`, called each refresh
     * @param {string} [definition.accent] - Header and title colour
     * @param {number} [definition.refreshMs] - How often to redraw
     * @returns {Object} A panel with `show`, `hide` and `toggle`
     */
    function createPanel({ id, title, size, draw, accent = '#8fb4ff', refreshMs = DEFAULT_REFRESH_MS }) {
        let panel = null;
        let bodyEl = null;
        let refreshId = null;
        let detachDrag = null;
        let detachResize = null;

        /** Draw, or say which panel could not be drawn */
        function render() {
            if (!bodyEl) return;
            bodyEl.replaceChildren();

            try {
                draw(bodyEl, panel);
            } catch (error) {
                console.error(`[Panel] ${title} could not be drawn:`, error);
                const failed = document.createElement('div');
                failed.textContent = `This could not be drawn: ${error.message}`;
                failed.style.color = ROW_COLORS.bad;
                bodyEl.appendChild(failed);
            }
        }

        /**
         * The timed redraw, which leaves a control being used alone.
         *
         * A refresh rebuilds the whole body, and rebuilding a `<select>` closes its
         * dropdown. Scroll through a long list of equipment for more than a few
         * seconds and the list shuts under the pointer — which reads as the panel
         * refusing to be used rather than as a redraw. A control the pointer or the
         * keyboard is in is a control somebody is in the middle of.
         */
        function refresh() {
            const active = document.activeElement;
            const busy = panel?.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
            if (busy) return;

            render();
        }

        function create() {
            panel = document.createElement('div');
            panel.id = `toolasha-${id}-panel`;
            Object.assign(panel.style, {
                position: 'fixed',
                top: '170px',
                left: '170px',
                zIndex: String(config.Z_FLOATING_PANEL),
                width: `${size.width}px`,
                height: `${size.height}px`,
                background: 'rgba(14, 16, 22, 0.97)',
                border: `1px solid ${accent}55`,
                borderRadius: '8px',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
                color: '#e8ecf5',
                fontSize: '12px',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
            });

            const header = document.createElement('div');
            Object.assign(header.style, {
                display: 'flex',
                alignItems: 'center',
                cursor: 'move',
                padding: '7px 8px 7px 11px',
                background: 'rgba(24, 24, 34, 0.9)',
                borderBottom: `1px solid ${accent}55`,
                userSelect: 'none',
                flex: '0 0 auto',
            });

            const heading = document.createElement('span');
            heading.textContent = title;
            Object.assign(heading.style, { fontWeight: 'bold', color: accent, flex: '1' });

            const close = document.createElement('button');
            close.textContent = '✕';
            Object.assign(close.style, {
                background: 'none',
                border: 'none',
                color: '#e8ecf5',
                cursor: 'pointer',
                fontSize: '13px',
                padding: '2px 4px',
            });
            close.addEventListener('click', (event) => {
                event.stopPropagation();
                api.hide();
            });

            header.append(heading, close);
            panel.appendChild(header);

            bodyEl = document.createElement('div');
            Object.assign(bodyEl.style, {
                flex: '1',
                overflow: 'auto',
                padding: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '7px',
                fontVariantNumeric: 'tabular-nums',
            });
            panel.appendChild(bodyEl);

            detachDrag = makeDraggable(panel, header, (position) => {
                saveGeometry(id, { left: parseFloat(position.left), top: parseFloat(position.top) });
            });
            detachResize = makeResizable(panel, {
                minWidth: 280,
                minHeight: 160,
                onResize: (next) => saveGeometry(id, next),
            });

            document.body.appendChild(panel);
            registerFloatingPanel(panel);
            restoreGeometry(panel, id, { width: 280, height: 160 });

            render();
            refreshId = setInterval(refresh, refreshMs);
        }

        const api = {
            show({ remember = true } = {}) {
                if (remember) saveOpenState(id, true);
                if (panel && document.body.contains(panel)) {
                    bringPanelToFront(panel);
                    return;
                }
                create();
            },
            hide({ remember = true } = {}) {
                if (remember) saveOpenState(id, false);
                clearInterval(refreshId);
                refreshId = null;
                detachDrag?.();
                detachResize?.();
                detachDrag = null;
                detachResize = null;

                if (!panel) return;
                unregisterFloatingPanel(panel);
                panel.remove();
                panel = null;
                bodyEl = null;
            },
            toggle() {
                if (panel) api.hide();
                else api.show();
            },
            render,
            get panel() {
                return panel;
            },
        };
        // Reopen if it was open when the page was last left. Fire and forget, since
        // this is module scope and a storage read has no business holding it up —
        // the panel appears a moment after the rest of the page, which is what a
        // remembered panel looks like anyway.
        reopenIfLeftOpen(id, () => api.show({ remember: false }));

        return api;
    }

    /**
     * A titled block to put lines in.
     *
     * @param {HTMLElement} body - Where it goes
     * @param {string} [title] - Heading
     * @param {string} [accent] - Heading colour
     * @returns {HTMLElement}
     */
    function panelCard(body, title, accent = '#8fb4ff') {
        const card = document.createElement('div');
        Object.assign(card.style, {
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid rgba(255, 255, 255, 0.10)',
            borderRadius: '6px',
            padding: '7px 9px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
        });

        if (title) {
            const heading = document.createElement('div');
            heading.textContent = title;
            Object.assign(heading.style, { color: accent, fontWeight: 'bold', marginBottom: '3px' });
            card.appendChild(heading);
        }
        body.appendChild(card);
        return card;
    }

    /**
     * A labelled figure on its own line.
     *
     * @param {string} label - What it is
     * @param {string} value - What it says
     * @param {string} [color] - Ink for the value
     * @param {string} [title] - Tooltip
     * @returns {HTMLElement}
     */
    function panelLine(label, value, color = '#e8ecf5', title = '') {
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', gap: '8px', alignItems: 'baseline' });

        const name = document.createElement('span');
        name.textContent = label;
        name.style.color = 'rgba(232, 236, 245, 0.5)';
        name.style.flex = '1';

        const figure = document.createElement('span');
        figure.textContent = value;
        figure.style.color = color;
        figure.style.whiteSpace = 'nowrap';

        if (title) line.title = title;
        line.append(name, figure);
        return line;
    }

    /**
     * Something to say when there is nothing to show.
     * @param {string} text - What to say
     * @returns {HTMLElement}
     */
    function panelNote(text) {
        const note = document.createElement('div');
        note.textContent = text;
        note.style.color = 'rgba(232, 236, 245, 0.5)';
        return note;
    }

    var simplePanel = /*#__PURE__*/Object.freeze({
        __proto__: null,
        createPanel: createPanel,
        panelCard: panelCard,
        panelLine: panelLine,
        panelNote: panelNote
    });

    /**
     * Consumable target
     *
     * How long the stock is supposed to last.
     *
     * One setting, in one place, because two things read it and they are in
     * different bundles. The Consumables panel measures every shortfall against it —
     * "buy for three days" is a different number from "buy for eight hours". The
     * overlay tile colours against it: a consumable lasting two days is fine if you
     * asked for one and is the thing to go and fix if you asked for three. A tile
     * and a panel disagreeing about that would be worse than either being wrong,
     * because you would have to work out which one to believe.
     *
     * Held in memory and mirrored to storage: the tile redraws every second and an
     * await per draw is not a thing to put behind a colour.
     */


    const STORAGE_KEY = 'consumablesSettings';

    /** The durations offered, in the order the header button cycles them */
    const TARGETS = [
        { label: '8 hours', seconds: 8 * 3600 },
        { label: '1 day', seconds: 86400 },
        { label: '3 days', seconds: 3 * 86400 },
        { label: '1 week', seconds: 7 * 86400 },
    ];

    const DEFAULT_INDEX = 1;
    let index = DEFAULT_INDEX;

    /**
     * @returns {{label: string, seconds: number}} The duration everything is
     *   measured against
     */
    function currentTarget() {
        return TARGETS[index] || TARGETS[DEFAULT_INDEX];
    }

    /** @returns {number} Which of `TARGETS` is selected */
    function targetIndex() {
        return index;
    }

    /**
     * Move to the next duration and remember it.
     * @returns {{label: string, seconds: number}} The new target
     */
    function cycleTarget() {
        index = (index + 1) % TARGETS.length;
        writeScoped(STORAGE_KEY, { targetSeconds: currentTarget().seconds }, 'settings').catch((error) => {
            console.error('[ConsumableTarget] Saving the target failed:', error);
        });
        return currentTarget();
    }

    /**
     * Read the target back at start-up.
     *
     * @param {Function} [onLoaded] - Called once the answer is in, for anything that
     *   has already drawn against the default
     * @returns {Promise<void>}
     */
    async function loadTarget(onLoaded) {
        try {
            // Waits for the database: it is opened after the libraries are
            // evaluated, so a read at module scope always returns the default
            await storage.ready;
            const saved = await readScoped(STORAGE_KEY, 'settings', null, { migrate: 'adopt' });
            const found = TARGETS.findIndex((target) => target.seconds === saved?.targetSeconds);
            // A value stored by an older list must not win over the code's
            index = found >= 0 ? found : DEFAULT_INDEX;
        } catch (error) {
            console.error('[ConsumableTarget] Reading the target failed:', error);
        }
        onLoaded?.(currentTarget());
    }

    // How much stock is enough is a question about one character's habits, so the
    // key is theirs — and nothing here re-runs on a switch unless it asks to be told
    dataManager.on('character_initialized', () => loadTarget());
    dataManager.on('character_switched', () => loadTarget());

    var consumableTarget = /*#__PURE__*/Object.freeze({
        __proto__: null,
        TARGETS: TARGETS,
        currentTarget: currentTarget,
        cycleTarget: cycleTarget,
        loadTarget: loadTarget,
        targetIndex: targetIndex
    });

    /**
     * Complex arithmetic and a radix-2 FFT.
     *
     * Exists for `drop-luck.js`, which works in the frequency domain: the value of a
     * session's drops is a sum of many independent random variables, and sums are
     * ugly in the value domain and a plain product in the frequency one. Getting a
     * distribution back out at the end is one inverse transform.
     *
     * Complex numbers are `[re, im]` pairs rather than objects or parallel typed
     * arrays. Pairs allocate more than typed arrays would, and if the luck analysis
     * ever needs to get faster this is the first place to look — but the transform
     * itself, which is where the array is longest, runs on plain number arrays.
     *
     * Ported from MWI Combat Suite by Frotty (MIT) — see
     * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`.
     */

    /** @typedef {[number, number]} Complex - A complex number as [real, imaginary] */

    /**
     * @param {Complex} a - Left
     * @param {Complex} b - Right
     * @returns {Complex} a × b
     */
    function cMul(a, b) {
        return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
    }

    /**
     * @param {Complex} a - Numerator
     * @param {Complex} b - Denominator
     * @returns {Complex} a ÷ b
     */
    function cDiv(a, b) {
        const magnitude = b[0] * b[0] + b[1] * b[1];
        return [(a[0] * b[0] + a[1] * b[1]) / magnitude, (a[1] * b[0] - a[0] * b[1]) / magnitude];
    }

    /**
     * A complex number to a real power, via polar form.
     * @param {Complex} c - Base
     * @param {number} x - Exponent
     * @returns {Complex} c^x
     */
    function cPow(c, x) {
        const argument = Math.atan2(c[1], c[0]) * x;
        const magnitude = Math.pow(c[0] * c[0] + c[1] * c[1], x / 2);
        return [magnitude * Math.cos(argument), magnitude * Math.sin(argument)];
    }

    /**
     * A vector of `n` copies of a real number.
     * @param {number} n - Length
     * @param {number} value - The real part; imaginary is zero
     * @returns {Complex[]} The vector
     */
    function vecConstant(n, value) {
        const vector = new Array(n);
        for (let i = 0; i < n; i++) vector[i] = [value, 0];
        return vector;
    }

    /**
     * Multiply a vector by another, in place.
     * @param {Complex[]} target - Mutated and returned
     * @param {Complex[]} other - Multiplier
     * @returns {Complex[]} target
     */
    function vecMulEq(target, other) {
        for (let i = 0; i < target.length; i++) {
            const re = target[i][0] * other[i][0] - target[i][1] * other[i][1];
            const im = target[i][0] * other[i][1] + target[i][1] * other[i][0];
            target[i][0] = re;
            target[i][1] = im;
        }
        return target;
    }

    /**
     * Scale a vector by a real number, in place.
     * @param {Complex[]} target - Mutated and returned
     * @param {number} scale - Multiplier
     * @returns {Complex[]} target
     */
    function vecScaleEq(target, scale) {
        for (let i = 0; i < target.length; i++) {
            target[i][0] *= scale;
            target[i][1] *= scale;
        }
        return target;
    }

    /**
     * Add the elementwise product of two vectors into a third, in place.
     * The inner step of the wave transition graph, where each state accumulates its
     * successors weighted by the monster that leads to them.
     * @param {Complex[]} target - Mutated and returned
     * @param {Complex[]} a - One factor
     * @param {Complex[]} b - The other
     * @returns {Complex[]} target
     */
    function vecAddMulEq(target, a, b) {
        for (let i = 0; i < target.length; i++) {
            target[i][0] += a[i][0] * b[i][0] - a[i][1] * b[i][1];
            target[i][1] += a[i][0] * b[i][1] + a[i][1] * b[i][0];
        }
        return target;
    }

    /**
     * Powers of a unit complex number: cos(k·angle) and sin(k·angle) for k = 0…n−1.
     *
     * Built by angle addition from earlier entries rather than by calling `Math.cos`
     * and `Math.sin` n times, which is the hot loop of the whole analysis — every
     * drop in a session builds one of these. The recurrence costs accuracy: error
     * compounds along the table, reaching a few parts in 1e13 by the far end of a
     * 4096-entry one rather than staying at machine epsilon. That is orders below the
     * sampling error of the transform it feeds, and `complex-fft.test.js` pins it so
     * a regression shows up as a failure rather than as a slightly wrong percentile.
     *
     * @param {number} angle - The base angle in radians
     * @param {number} n - How many powers; must be a positive multiple of 4
     * @returns {[number[], number[]]} [cosines, sines]
     */
    function unitPowers(angle, n) {
        if (!Number.isInteger(n) || n < 4 || n % 4 !== 0) {
            throw new Error(`unitPowers needs a positive multiple of 4, got ${n}`);
        }

        const cos = new Array(n);
        const sin = new Array(n);
        cos[0] = 1;
        sin[0] = 0;
        cos[1] = Math.cos(angle);
        sin[1] = Math.sin(angle);
        cos[2] = cos[1] * cos[1] - sin[1] * sin[1];
        sin[2] = 2 * sin[1] * cos[1];
        cos[3] = cos[1] * cos[2] - sin[1] * sin[2];
        sin[3] = sin[1] * cos[2] + cos[1] * sin[2];

        // Each block of four is built from two roughly-halfway entries, so the number
        // of additions any entry is removed from the seed grows like log(n) rather
        // than n — which is what keeps the compounding error down
        for (let i = 4; i < n; i += 4) {
            const j = i >> 1;
            const k = i - j;
            cos[i] = cos[j] * cos[k] - sin[j] * sin[k];
            sin[i] = sin[j] * cos[k] + cos[j] * sin[k];
            cos[i + 1] = cos[j] * cos[k + 1] - sin[j] * sin[k + 1];
            sin[i + 1] = sin[j] * cos[k + 1] + cos[j] * sin[k + 1];
            cos[i + 2] = cos[j + 1] * cos[k + 1] - sin[j + 1] * sin[k + 1];
            sin[i + 2] = sin[j + 1] * cos[k + 1] + cos[j + 1] * sin[k + 1];
            cos[i + 3] = cos[j + 1] * cos[k + 2] - sin[j + 1] * sin[k + 2];
            sin[i + 3] = sin[j + 1] * cos[k + 2] + cos[j + 1] * sin[k + 2];
        }

        return [cos, sin];
    }

    /**
     * In-place iterative radix-2 FFT.
     *
     * Decimation in time: the bit-reversal permutation first, then log₂(n) passes of
     * butterflies over doubling block sizes.
     *
     * @param {number[]} re - Real parts, mutated in place
     * @param {number[]} im - Imaginary parts, mutated in place; same length as `re`
     */
    function fftInPlace(re, im) {
        const n = re.length;
        if (n <= 1) return;
        if ((n & (n - 1)) !== 0) throw new Error(`fftInPlace needs a power-of-two length, got ${n}`);
        if (im.length !== n) throw new Error('fftInPlace needs matching real and imaginary lengths');

        for (let i = 0, j = 0; i < n; i++) {
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
            let k = n >> 1;
            while (k > 0 && k <= j) {
                j -= k;
                k >>= 1;
            }
            j += k;
        }

        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1;
            const step = (-2 * Math.PI) / len;
            const stepRe = Math.cos(step);
            const stepIm = Math.sin(step);

            for (let start = 0; start < n; start += len) {
                let wRe = 1;
                let wIm = 0;

                for (let offset = 0; offset < half; offset++) {
                    const lo = start + offset;
                    const hi = lo + half;
                    const tRe = wRe * re[hi] - wIm * im[hi];
                    const tIm = wRe * im[hi] + wIm * re[hi];

                    re[hi] = re[lo] - tRe;
                    im[hi] = im[lo] - tIm;
                    re[lo] += tRe;
                    im[lo] += tIm;

                    const nextWRe = wRe * stepRe - wIm * stepIm;
                    wIm = wRe * stepIm + wIm * stepRe;
                    wRe = nextWRe;
                }
            }
        }
    }

    /**
     * Binary search for the point where a monotonic function reaches a target.
     * @param {Function} f - Monotonically non-decreasing
     * @param {number} low - Lower bound
     * @param {number} high - Upper bound
     * @param {number} target - Value to reach
     * @param {number} [iterations] - Halvings; 60 takes a unit interval below 1e-18
     * @returns {number} The crossing point
     */
    function binarySearch(f, low, high, target, iterations = 60) {
        let lo = low;
        let hi = high;
        for (let i = 0; i < iterations; i++) {
            const mid = (lo + hi) / 2;
            if (f(mid) < target) lo = mid;
            else hi = mid;
        }
        return (lo + hi) / 2;
    }

    var complexFft = /*#__PURE__*/Object.freeze({
        __proto__: null,
        binarySearch: binarySearch,
        cDiv: cDiv,
        cMul: cMul,
        cPow: cPow,
        fftInPlace: fftInPlace,
        unitPowers: unitPowers,
        vecAddMulEq: vecAddMulEq,
        vecConstant: vecConstant,
        vecMulEq: vecMulEq,
        vecScaleEq: vecScaleEq
    });

    /**
     * Drop Luck
     *
     * Where a session's takings sit in the distribution of takings it could have had.
     *
     * "Expected value" answers the wrong question after a bad run. Toolasha already
     * computes what a zone pays on average — but a session that came in 30% under
     * average is either routine or remarkable depending on the shape of the tail, and
     * an average cannot tell the two apart. A zone whose income is mostly a common
     * drop and a zone whose income is mostly one rare drop have the same mean and
     * nothing else in common. This gives the percentile: the fraction of runs that
     * would have done worse.
     *
     * ## How
     *
     * Total income is a sum of independent contributions — every drop of every
     * monster in every wave. Summing distributions directly means convolving them,
     * which is quadratic and gets worse with every drop added. In the frequency
     * domain a convolution is a plain product, so each drop contributes one
     * characteristic function, they all multiply together, and one inverse transform
     * at the end turns the product back into a distribution. Repetition becomes a
     * power rather than a repeated convolution, which is what makes a thousand waves
     * cost the same as one.
     *
     * The awkward part is that the transform needs a finite window and the true
     * support of the sum is not known in advance. Too narrow and the far tail wraps
     * around onto the near one; too wide and the resolution is spent on income
     * nobody will ever see. `invertToCDF` searches for a window instead of guessing,
     * shrinking it until the distribution nearly fills it.
     *
     * ## What this file does not do
     *
     * Pure computation only — it takes drop tables and prices and returns numbers.
     * Reading the current zone, pricing items, and counting what actually dropped are
     * not here. Nothing in Toolasha calls this yet.
     *
     * Ported from MWI Combat Suite by Frotty (MIT) — see
     * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`.
     */


    /**
     * A characteristic function, as this file represents one: given a sample count
     * and a frequency scale, it returns the function evaluated at that many evenly
     * spaced frequencies.
     * @typedef {(samples: number, scale: number) => Array<[number, number]>} CharacteristicFunction
     */

    /** Knobs for the transform. Defaults chosen to be accurate rather than quick. */
    const LUCK_DEFAULTS = {
        /** Frequencies sampled for the final answer. Powers of two only. */
        samples: 4096,
        /** Frequencies sampled while searching for the window — cheap and rough. */
        searchSamples: 64,
        /** How much of the window the distribution should fill before the search stops */
        fillTarget: 0.9,
        /** Tail mass allowed outside the window */
        tailTolerance: 1e-4,
        /** Give up shrinking once a step buys less than this */
        shrinkTolerance: 1e-4,
        /** Cap on shrink steps */
        maxIterations: 30,
        /** Fraction of the transform reserved as a guard band against wrap-around */
        guardBand: 0.4,
    };

    /**
     * A characteristic function that is identically one — the sum of nothing.
     * @param {number} [value] - The constant
     * @returns {CharacteristicFunction}
     */
    function constantCF(value = 1) {
        return (samples) => vecConstant(samples, value);
    }

    /**
     * The characteristic function of a sum, which is the product of the parts.
     * @param {CharacteristicFunction[]} functions - The independent contributions
     * @returns {CharacteristicFunction}
     */
    function multiplyCFs(functions) {
        if (!functions.length) return constantCF(1);

        return (samples, scale) => {
            const product = functions[0](samples, scale);
            for (let i = 1; i < functions.length; i++) {
                vecMulEq(product, functions[i](samples, scale));
            }
            return product;
        };
    }

    /**
     * The characteristic function of `n` independent repeats of something.
     *
     * A power, not `n` multiplications — which is the whole reason a long session is
     * no more expensive to analyse than a short one. `n` need not be a whole number;
     * a fractional exponent interpolates between wave counts.
     *
     * @param {CharacteristicFunction} cf - One repeat
     * @param {number} n - How many
     * @returns {CharacteristicFunction}
     */
    function powCF(cf, n) {
        return (samples, scale) => {
            const values = cf(samples, scale);
            for (let i = 0; i < samples; i++) values[i] = cPow(values[i], n);
            return values;
        };
    }

    /**
     * The characteristic function of one drop's contribution to income.
     *
     * A drop is "with probability `dropRate`, a count uniform on [minCount, maxCount],
     * each worth `price`". The count is continuous in the game's data but only whole
     * items can drop, so the uniform range is first pushed onto the integers — mass
     * between two integers splits between them in proportion to how close it is,
     * which is what makes a range like 1.5–2.5 pay 2 on average rather than rounding
     * to a fixed 2.
     *
     * Three cases, because the arithmetic collapses differently in each:
     *
     * - The range spans no integer, or is a single point: the count is one of two
     *   adjacent integers, and the whole thing is two terms.
     * - The range spans exactly one integer: that integer plus a symmetric spill to
     *   its neighbours.
     * - The range spans several: the interior is a run of equally likely integers,
     *   which sums in closed form as a geometric series, plus a partial integer at
     *   each end.
     *
     * @param {Object} drop - `{ minCount, maxCount, dropRate, price }`
     * @returns {CharacteristicFunction}
     */
    function dropCF(drop) {
        const { minCount, maxCount, dropRate, price } = drop;
        const epsilon = 1e-8;
        const low = Math.ceil(minCount);
        const high = Math.floor(maxCount);
        const miss = 1 - dropRate;

        // No whole count strictly inside the range, so it is one of two neighbours
        if (low > high || maxCount - minCount < epsilon) {
            const fraction = (minCount + maxCount) / 2 - high;
            const upper = fraction * dropRate;
            const lower = (1 - fraction) * dropRate;

            return (samples, scale) => {
                const base = 2 * Math.PI * scale * price;
                const [cosHigh1, sinHigh1] = unitPowers(base * (high + 1), samples);
                const [cosHigh, sinHigh] = unitPowers(base * high, samples);

                const values = new Array(samples);
                for (let i = 0; i < samples; i++) {
                    values[i] = [cosHigh1[i] * upper + cosHigh[i] * lower + miss, sinHigh1[i] * upper + sinHigh[i] * lower];
                }
                return values;
            };
        }

        // Exactly one whole count inside, with a spill to each side
        if (low === high) {
            const spillLow = (dropRate * (low - minCount) * (low - minCount)) / ((maxCount - minCount) * 2);
            const spillHigh = (dropRate * (maxCount - high) * (maxCount - high)) / ((maxCount - minCount) * 2);

            return (samples, scale) => {
                const base = 2 * Math.PI * scale * price;
                const [cos, sin] = unitPowers(base, samples);
                const [cosHigh, sinHigh] = unitPowers(base * high, samples);

                const values = new Array(samples);
                for (let i = 0; i < samples; i++) {
                    const shape = [dropRate + (spillLow + spillHigh) * (cos[i] - 1), (spillHigh - spillLow) * sin[i]];
                    values[i] = cMul([cosHigh[i], sinHigh[i]], shape);
                    values[i][0] += miss;
                }
                return values;
            };
        }

        // A run of whole counts, plus a partial one at each end
        const lowPart = low - minCount;
        const highPart = maxCount - high;
        const lowPart2 = lowPart * lowPart;
        const highPart2 = highPart * highPart;
        const density = dropRate / (maxCount - minCount);

        return (samples, scale) => {
            const base = 2 * Math.PI * scale * price;
            const [cos, sin] = unitPowers(base, samples);
            const [cosHigh, sinHigh] = unitPowers(base * high, samples);
            const [cosLow, sinLow] = unitPowers(base * low, samples);

            const values = new Array(samples);
            for (let i = 0; i < samples; i++) {
                const halfCosStep = (cos[i] - 1) / 2;
                const halfSinStep = sin[i] / 2;
                const atLow = [cosLow[i], sinLow[i]];
                const atHigh = [cosHigh[i], sinHigh[i]];

                const endLow = cMul([lowPart + lowPart2 * halfCosStep, -lowPart2 * halfSinStep], atLow);
                const endHigh = cMul([highPart + highPart2 * halfCosStep, highPart2 * halfSinStep], atHigh);

                // The interior sums as a geometric series, except at zero frequency
                // where the ratio is one and the closed form divides by nothing
                const atZeroFrequency = halfCosStep > -epsilon && Math.abs(halfSinStep) < epsilon;
                const interior = atZeroFrequency
                    ? [(high - low) * atLow[0], (high - low) * (atLow[1] + halfSinStep * (high - low - 1))]
                    : cDiv([atHigh[0] - atLow[0], atHigh[1] - atLow[1]], [halfCosStep * 2, halfSinStep * 2]);
                const middle = cMul(interior, [1 + halfCosStep, halfSinStep]);

                values[i] = [
                    miss + density * (endLow[0] + endHigh[0] + middle[0]),
                    density * (endLow[1] + endHigh[1] + middle[1]),
                ];
            }
            return values;
        };
    }

    /**
     * Invert a characteristic function over a fixed window into a CDF on [0, 1].
     *
     * The transform is periodic, so probability past the end of the window reappears
     * at the start of it. A guard band leaves part of the window empty and the result
     * is re-based against it, which turns wrap-around into a known offset instead of
     * corruption at both ends.
     *
     * The three passes afterwards each fix something the transform does badly at its
     * own resolution: a short moving median removes the ringing that a hard window
     * edge puts into the tails, re-basing pins the guard band back to one, and a
     * running maximum restores monotonicity, since a CDF that dips is worse than a
     * CDF that is slightly wrong.
     *
     * @param {CharacteristicFunction} cf - What to invert
     * @param {number} samples - Frequencies to sample; a power of two
     * @param {number} scale - Reciprocal of the window width
     * @param {Object} [options] - Overrides for `LUCK_DEFAULTS`
     * @returns {(x: number) => number} CDF over the fraction of the window
     */
    function invertOverWindow(cf, samples, scale, options = {}) {
        const { guardBand } = { ...LUCK_DEFAULTS, ...options };
        const padding = 2;
        const n = samples * padding;

        const values = cf(samples, scale * (1 - guardBand));
        const re = new Array(n).fill(0);
        const im = new Array(n).fill(0);
        for (let i = 0; i < samples; i++) {
            if (!Number.isFinite(values[i][0]) || !Number.isFinite(values[i][1])) {
                throw new Error('Characteristic function produced a non-finite value');
            }
            re[i] = values[i][0];
            im[i] = values[i][1];
        }

        fftInPlace(re, im);

        // The zero frequency carries the whole mass and would swamp everything else;
        // removing a half from every bin is the discrete form of dropping it
        for (let i = 0; i < n; i++) re[i] -= 0.5;
        const total = re.reduce((sum, x) => sum + x, 0);
        if (Math.abs(total) < 1e-10) throw new Error('Transform came back empty');
        for (let i = 0; i < n; i++) re[i] /= total;

        const cdf = new Array(n);
        cdf[0] = (re[0] + re[n - 1]) / 2;
        for (let i = 1; i < n; i++) cdf[i] = cdf[i - 1] + (re[i] + re[i - 1]) / 2;

        const smoothed = circularMovingMedian(cdf, padding);
        const offset = smoothed[Math.floor(n * (1 - guardBand))] - 1;
        for (let i = 0; i < n; i++) smoothed[i] -= offset;
        for (let i = 1; i < n; i++) if (smoothed[i] < smoothed[i - 1]) smoothed[i] = smoothed[i - 1];

        return (x) => interpolateCDF(smoothed, x, guardBand);
    }

    /**
     * A moving median that wraps, treating the sequence as one period of something
     * that climbs by one each time round — which is what a CDF read off a periodic
     * transform is.
     * @param {number[]} values - The sequence
     * @param {number} radius - Half-width of the window
     * @returns {number[]} Smoothed copy
     */
    function circularMovingMedian(values, radius) {
        const n = values.length;
        const out = new Array(n);

        for (let i = 0; i < n; i++) {
            const window = [];
            for (let j = i - radius + 1; j <= i + radius; j++) {
                const wrapped = values[((j % n) + n) % n];
                window.push(j < 0 ? wrapped - 1 : j >= n ? wrapped + 1 : wrapped);
            }
            window.sort((a, b) => a - b);
            out[i] = (window[radius - 1] + window[radius]) / 2;
        }
        return out;
    }

    /**
     * Read a CDF between its samples.
     *
     * Cubic rather than linear because the answer is a percentile, and linear
     * interpolation of a curve this smooth leaves visible steps in one.
     *
     * @param {number[]} cdf - Sampled CDF
     * @param {number} x - Position in [0, 1] across the usable part of the window
     * @param {number} guardBand - Fraction reserved against wrap-around
     * @returns {number} Probability in [0, 1]
     */
    function interpolateCDF(cdf, x, guardBand) {
        if (x < 0) return 0;
        if (x >= 1) return 1;

        const n = cdf.length;
        const position = x * (1 - guardBand) * n - 0.5;
        const index = Math.round(position);
        const t = position - index;

        // Neighbours wrap, and a wrap crosses one whole step of the CDF
        const before = index - 1 < 0 ? cdf[index + n - 1] - 1 : cdf[index - 1];
        const after = index + 1 >= n ? cdf[index - n + 1] + 1 : cdf[index + 1];
        const midBefore = (cdf[index] + before) / 2;
        const midAfter = (cdf[index] + after) / 2;
        const slopeBefore = cdf[index] - before;
        const slopeAfter = after - cdf[index];

        const value =
            2 * (t + 1) * (t - 0.5) * (t - 0.5) * midBefore +
            2 * (1 - t) * (t + 0.5) * (t + 0.5) * midAfter +
            (t * t - 0.25) * ((t - 0.5) * slopeBefore + (t + 0.5) * slopeAfter);

        return value < 0 ? 0 : value > 1 ? 1 : value;
    }

    /**
     * Invert a characteristic function into a CDF over actual income.
     *
     * The window has to hold the distribution but not dwarf it, and its width is not
     * known before the distribution is computed. So a cheap, coarse inversion runs
     * first and reports where the mass actually ends; the window shrinks to that and
     * the check repeats. Each round is a few dozen samples, and the accurate
     * inversion runs once at the end.
     *
     * @param {CharacteristicFunction} cf - What to invert
     * @param {number} startingLimit - First guess at the largest plausible income
     * @param {Object} [options] - Overrides for `LUCK_DEFAULTS`
     * @returns {{limit: number, cdf: (income: number) => number}} The window that was
     *   settled on, and the CDF over income
     */
    function invertToCDF(cf, startingLimit, options = {}) {
        const settings = { ...LUCK_DEFAULTS, ...options };
        let limit = startingLimit;

        for (let i = 0; i < settings.maxIterations; i++) {
            const rough = invertOverWindow(cf, settings.searchSamples, 1 / limit, settings);

            // Already loose enough that the tail is nowhere near the edge
            if (rough(settings.fillTarget) < 1 - settings.tailTolerance) break;

            const reaches = binarySearch(rough, 0, 1, 1 - settings.tailTolerance);
            const shrink = reaches / settings.fillTarget;
            if (shrink > 1 - settings.shrinkTolerance) break;
            limit *= shrink;
        }

        const accurate = invertOverWindow(cf, settings.samples, 1 / limit, settings);
        return { limit, cdf: (income) => accurate(income / limit) };
    }

    /**
     * Every path a wave can take through its spawn table, as a graph.
     *
     * The same states as `spawn-expectation.js` — strength spent, monsters drawn —
     * but keeping the edges rather than just the totals, because the income of a wave
     * depends on which monsters appeared together and not only on how many of each
     * appeared on average.
     *
     * Each node records the probability the wave ends there, which is the weight of
     * the draws that would not fit.
     *
     * @param {Object} spawnInfo - `{ spawns, maxSpawnCount, maxTotalStrength }`
     * @returns {Array<{stop: number, edges: Array<{to: number, hrid: string}>}>} Nodes,
     *   with the starting state first
     */
    function spawnGraph(spawnInfo) {
        const { spawns, maxSpawnCount, maxTotalStrength } = spawnInfo;
        const ids = new Map();
        const nodes = [];

        const idFor = (strength, count) => {
            const key = strength * (maxSpawnCount + 1) + count;
            if (!ids.has(key)) {
                ids.set(key, nodes.length);
                nodes.push({ stop: 0, edges: [] });
            }
            return ids.get(key);
        };

        idFor(0, 0);
        for (let strength = 0; strength <= maxTotalStrength; strength++) {
            for (let count = 0; count <= maxSpawnCount; count++) {
                const key = strength * (maxSpawnCount + 1) + count;
                if (!ids.has(key)) continue;
                const id = ids.get(key);

                for (const monster of spawns) {
                    const nextStrength = strength + (monster.strength || 0);
                    const nextCount = count + 1;
                    if (nextStrength > maxTotalStrength || nextCount > maxSpawnCount) {
                        nodes[id].stop += monster.rate || 0;
                        continue;
                    }
                    nodes[id].edges.push({
                        to: idFor(nextStrength, nextCount),
                        hrid: monster.combatMonsterHrid || monster.hrid,
                    });
                }
            }
        }
        return nodes;
    }

    /**
     * The characteristic function of one wave's income.
     *
     * Walking the graph backwards means every node's successors are already solved
     * when it is reached, so the whole wave resolves in one pass: a node's value is
     * the chance it stops there, plus each outgoing draw weighted by that monster's
     * rate and its own drops.
     *
     * @param {Object} spawnInfo - `{ spawns, maxSpawnCount, maxTotalStrength }`
     * @param {Object<string, Object[]>} monsterDrops - Monster hrid → its drops
     * @returns {CharacteristicFunction}
     */
    function waveCF(spawnInfo, monsterDrops) {
        const spawns = spawnInfo?.spawns || [];
        if (!spawns.length) return constantCF(1);

        const totalWeight = spawns.reduce((sum, spawn) => sum + (spawn.rate || 0), 0);
        if (totalWeight <= 0) return constantCF(1);

        const perMonster = {};
        for (const monster of spawns) {
            const hrid = monster.combatMonsterHrid || monster.hrid;
            perMonster[hrid] = multiplyCFs((monsterDrops[hrid] || []).map(dropCF));
        }

        // Rates are weights, and the graph reads them as probabilities
        const normalised = {
            ...spawnInfo,
            spawns: spawns.map((spawn) => ({ ...spawn, rate: (spawn.rate || 0) / totalWeight })),
        };
        const graph = spawnGraph(normalised);
        const rateOf = new Map(normalised.spawns.map((spawn) => [spawn.combatMonsterHrid || spawn.hrid, spawn.rate]));

        return (samples, scale) => {
            const weighted = {};
            for (const hrid of Object.keys(perMonster)) {
                weighted[hrid] = vecScaleEq(perMonster[hrid](samples, scale), rateOf.get(hrid));
            }

            const values = new Array(graph.length);
            for (let id = graph.length - 1; id >= 0; id--) {
                values[id] = vecConstant(samples, graph[id].stop);
                for (const edge of graph[id].edges) {
                    vecAddMulEq(values[id], values[edge.to], weighted[edge.hrid]);
                }
            }
            return values[0];
        };
    }

    /**
     * The characteristic function of a whole session's income.
     * @param {Object} session - Session shape
     * @param {Object} session.spawnInfo - The zone's random spawn table
     * @param {Object<string, Object[]>} session.monsterDrops - Monster hrid → its drops
     * @param {Object<string, Object[]>} [session.bossDrops] - Boss key → its drops
     * @param {number} session.normalCount - Normal waves fought
     * @param {number} [session.bossCount] - Boss waves fought
     * @returns {CharacteristicFunction}
     */
    function sessionCF({ spawnInfo, monsterDrops, bossDrops = {}, normalCount, bossCount = 0 }) {
        const normal = powCF(waveCF(spawnInfo, monsterDrops), normalCount);
        const boss = powCF(multiplyCFs(Object.values(bossDrops).map((drops) => multiplyCFs(drops.map(dropCF)))), bossCount);
        return multiplyCFs([normal, boss]);
    }

    /**
     * How lucky a session's takings were.
     *
     * @param {Object} session - As `sessionCF` takes
     * @param {number} income - What the session actually paid
     * @param {Object} [options] - Overrides for `LUCK_DEFAULTS`
     * @returns {{percentile: number, limit: number, cdf: (income: number) => number}}
     *   `percentile` is the fraction of sessions that would have done worse — so 0.5
     *   is exactly typical, 0.99 is a session in a hundred, and 0.01 is a session in
     *   a hundred the other way. `cdf` answers the same question for any other
     *   income, and `limit` is the window that was settled on.
     */
    function sessionLuck(session, income, options = {}) {
        const waves = (session.normalCount || 0) + (session.bossCount || 0);

        // Opening guess: generous enough that the search shrinks onto the answer
        // rather than having to widen, which it cannot do
        const startingLimit = Math.max(1e8, 2e5 * Math.max(waves, 1));

        const { limit, cdf } = invertToCDF(sessionCF(session), startingLimit, options);
        return { percentile: cdf(income), limit, cdf };
    }

    var dropLuck = /*#__PURE__*/Object.freeze({
        __proto__: null,
        LUCK_DEFAULTS: LUCK_DEFAULTS,
        constantCF: constantCF,
        dropCF: dropCF,
        invertToCDF: invertToCDF,
        multiplyCFs: multiplyCFs,
        powCF: powCF,
        sessionCF: sessionCF,
        sessionLuck: sessionLuck,
        waveCF: waveCF
    });

    /**
     * Spawn Expectation
     *
     * How many of each monster a combat wave is expected to contain.
     *
     * A wave is not a fixed roster. The game draws monsters one at a time from a
     * weighted table and stops early when the next draw would push the wave past its
     * strength budget, so the roster is a distribution rather than a list. That makes
     * "this monster drops X at rate Y" not directly usable: to turn a drop rate into
     * an expectation you first need the expected number of that monster per wave, and
     * a monster's strength changes how often the wave has room for it at all — a
     * heavy monster is rarer than its weight suggests, and a light one is commoner.
     *
     * Solved exactly rather than sampled. `combat-sim/engine/zone.js` draws real
     * random encounters because a simulation needs one concrete wave at a time; this
     * needs the mean over all of them, and there are few enough states to enumerate
     * every one. The result is exact and takes no samples to converge.
     *
     * Ported from MWI Combat Suite by Frotty (MIT) — see
     * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`.
     */

    /**
     * Expected count of each monster in one wave of a random spawn table.
     *
     * The state is (strength spent so far, monsters drawn so far), and every state is
     * reachable only through draws that fit — a draw that would overflow the strength
     * budget ends the wave, so it contributes neither the monster that overflowed nor
     * anything after it. Walking the states in order of strength and then count means
     * a state is only ever read after every path into it has been added, so one pass
     * suffices.
     *
     * Spawn rates are treated as **weights and normalised**, which is what the game
     * itself does when it draws (`totalWeight * random()` in `engine/zone.js`). Read
     * as bare probabilities they only happen to work when the table sums to 1.
     *
     * @param {Object} randomSpawnInfo - `combatZoneInfo.fightInfo.randomSpawnInfo`, or an
     *   entry of a dungeon's `randomSpawnInfoMap`: `{ spawns, maxSpawnCount, maxTotalStrength }`
     * @returns {Object<string, number>} Monster hrid → expected count per wave. Empty when
     *   the table is missing, weightless, or allows no draws.
     */
    function expectedSpawnsPerWave(randomSpawnInfo) {
        const spawns = randomSpawnInfo?.spawns || [];
        const maxSpawnCount = randomSpawnInfo?.maxSpawnCount ?? 0;
        const maxTotalStrength = randomSpawnInfo?.maxTotalStrength ?? 0;

        const expected = {};
        if (!spawns.length || maxSpawnCount <= 0 || maxTotalStrength < 0) return expected;

        const totalWeight = spawns.reduce((sum, spawn) => sum + (spawn.rate || 0), 0);
        if (totalWeight <= 0) return expected;

        for (const spawn of spawns) {
            const hrid = spawn.combatMonsterHrid || spawn.hrid;
            if (hrid) expected[hrid] = 0;
        }

        // reached[strength][count] — the probability the wave is in exactly that state
        const reached = [];
        for (let strength = 0; strength <= maxTotalStrength; strength++) {
            reached.push(new Array(maxSpawnCount + 1).fill(0));
        }
        reached[0][0] = 1;

        for (let strength = 0; strength <= maxTotalStrength; strength++) {
            for (let count = 0; count < maxSpawnCount; count++) {
                const here = reached[strength][count];
                if (!here) continue;

                for (const spawn of spawns) {
                    const hrid = spawn.combatMonsterHrid || spawn.hrid;
                    if (!hrid) continue;

                    // A draw that does not fit ends the wave rather than being retried,
                    // so its share of the probability simply stops here
                    const nextStrength = strength + (spawn.strength || 0);
                    if (nextStrength > maxTotalStrength) continue;

                    const probability = here * ((spawn.rate || 0) / totalWeight);
                    reached[nextStrength][count + 1] += probability;
                    expected[hrid] += probability;
                }
            }
        }

        return expected;
    }

    /**
     * Expected count of each monster over a run of waves.
     *
     * Separate from the per-wave figure because the per-wave one is worth caching per
     * zone — it depends only on the spawn table — while the run length changes every
     * time you ask.
     *
     * @param {Object} randomSpawnInfo - Spawn table, as above
     * @param {number} waveCount - How many waves
     * @returns {Object<string, number>} Monster hrid → expected count over the run. Empty
     *   when the run length is not a count.
     */
    function expectedSpawnsOverWaves(randomSpawnInfo, waveCount) {
        if (!Number.isFinite(waveCount) || waveCount < 0) return {};

        const perWave = expectedSpawnsPerWave(randomSpawnInfo);
        const total = {};
        for (const [hrid, count] of Object.entries(perWave)) {
            total[hrid] = count * waveCount;
        }
        return total;
    }

    var spawnExpectation = /*#__PURE__*/Object.freeze({
        __proto__: null,
        expectedSpawnsOverWaves: expectedSpawnsOverWaves,
        expectedSpawnsPerWave: expectedSpawnsPerWave
    });

    /**
     * Combat Drop Model
     *
     * Turning the game's zone data into the shape `drop-luck.js` analyses.
     *
     * Kept apart from the feature that displays the result because this is where
     * being wrong is invisible. A drop rate read straight out of the data is not the
     * rate you experience: difficulty tier raises it, your combat drop stats raise it
     * again, party size divides the quantity, and a rare drop scales by a different
     * stat than a common one. Get any of those wrong and the luck percentile is still
     * a plausible-looking number — it just quietly says everyone with drop-rate gear
     * is permanently lucky. So the arithmetic lives here, on its own, with tests.
     *
     * ## The assumption worth knowing about
     *
     * Quantity bonuses give fractional counts — a 1-to-1 drop at +10% quantity is a
     * count of 1.1 — and only whole items can drop. This assumes the game settles
     * that **without losing the fraction**: 1 item nine times in ten and 2 the tenth,
     * so the average is the 1.1 it says. `drop-luck.js` discretises the same way, and
     * its "a fractional fixed count splits between its neighbours" test pins it.
     *
     * If the game instead truncates, every such bonus below the next whole item is
     * worth nothing and this model overstates income. That is not a rounding detail:
     * on a zone where a rare carries the value, the two readings differed by 5% of
     * total income in testing, because the rare is exactly the drop whose count is
     * small enough for the fraction to be most of the bonus.
     *
     * The multipliers and the discretisation are both Frotty's, read out of MWI
     * Combat Suite — see `third-party/mwi-combat-suite/` and
     * `docs/THIRD-PARTY-LICENSES.md`.
     */


    /** What the game gives every character before gear and buffs */
    const NO_DROP_BONUSES = { combatDropRate: 0, combatRareFind: 0, combatDropQuantity: 0 };

    /** Zones without their own figure send a boss every this many battles */
    const DEFAULT_BATTLES_PER_BOSS = 10;

    /** A dungeon hands its whole party this much more of each drop */
    const DUNGEON_QUANTITY_MULTIPLIER = 5;

    /**
     * The rate a drop actually lands at, for one player in one zone.
     *
     * Difficulty raises a drop's rate twice over: once by a flat per-tier step the
     * drop itself carries, and again by a tenth of the base for every tier. Drop-rate
     * gear then multiplies what is left — but rare drops answer to `combatRareFind`
     * and common ones to `combatDropRate`, so a rare-find build looks unlucky on
     * common drops and lucky on rares if the two are mixed up.
     *
     * @param {Object} drop - `{ dropRate, dropRatePerDifficultyTier, isRare }`
     * @param {number} tier - Difficulty tier
     * @param {Object} bonuses - `{ combatDropRate, combatRareFind }`
     * @returns {number} Rate in [0, 1]
     */
    function effectiveDropRate(drop, tier, bonuses = NO_DROP_BONUSES) {
        const base = drop.dropRate || 0;
        const perTier = drop.dropRatePerDifficultyTier || 0;
        const finder = drop.isRare ? bonuses.combatRareFind || 0 : bonuses.combatDropRate || 0;

        const rate = (base + tier * perTier) * (1 + tier * 0.1) * (1 + finder);
        return Math.min(Math.max(rate, 0), 1);
    }

    /**
     * How much a drop's count is scaled before it reaches you.
     *
     * Quantity bonuses raise the whole stack, party size splits it, and a dungeon
     * multiplies it — the last two nearly cancelling in a full party, which is why
     * neither can be left out on its own.
     *
     * @param {Object} bonuses - `{ combatDropQuantity }`
     * @param {number} partySize - How many are splitting the loot
     * @param {boolean} isDungeon - Whether the zone is a dungeon
     * @returns {number} Multiplier for min and max count
     */
    function dropQuantityMultiplier(bonuses = NO_DROP_BONUSES, partySize = 1, isDungeon = false) {
        const party = partySize > 0 ? partySize : 1;
        const dungeon = isDungeon ? DUNGEON_QUANTITY_MULTIPLIER : 1;
        return ((1 + (bonuses.combatDropQuantity || 0)) / party) * dungeon;
    }

    /**
     * Every drop a monster can give, as one list.
     *
     * The two tables are kept apart in the game's data because they scale by
     * different stats, so the rare flag has to survive the merge.
     *
     * @param {Object} monster - An entry of `combatMonsterDetailMap`
     * @returns {Array<Object>} Drops, each flagged `isRare`
     */
    function monsterDropList(monster) {
        const common = (monster?.dropTable || []).map((drop) => ({ ...drop, isRare: false }));
        const rare = (monster?.rareDropTable || []).map((drop) => ({ ...drop, isRare: true }));
        return [...common, ...rare];
    }

    /**
     * Split a run of battles into ordinary ones and boss ones.
     * @param {number} battles - Battles fought
     * @param {number} battlesPerBoss - How often a boss comes round; 0 for never
     * @returns {{normalCount: number, bossCount: number}}
     */
    function splitBattles(battles, battlesPerBoss) {
        const total = Math.max(battles || 0, 0);
        if (!battlesPerBoss || battlesPerBoss <= 0) return { normalCount: total, bossCount: 0 };

        const bossCount = Math.floor(total / battlesPerBoss);
        return { normalCount: total - bossCount, bossCount };
    }

    /**
     * Build the session `drop-luck.js` analyses from a zone and a run of battles.
     *
     * Priced here rather than downstream because the analysis works in coins, not
     * items — an item with no price contributes nothing and is dropped, which is the
     * honest thing to do: counting it as zero would make every session containing one
     * look unlucky.
     *
     * @param {Object} input - Everything the model needs
     * @param {Object} input.actionDetail - The zone's `actionDetailMap` entry
     * @param {Object} input.monsterDetailMap - The game's `combatMonsterDetailMap`
     * @param {number} input.battles - Battles fought, excluding any still in progress
     * @param {Function} input.priceOf - `(itemHrid) => number|null`
     * @param {number} [input.difficultyTier] - Zone difficulty
     * @param {Object} [input.bonuses] - `{ combatDropRate, combatRareFind, combatDropQuantity }`
     * @param {number} [input.partySize] - How many are splitting the loot
     * @returns {Object|null} A session for `sessionLuck`, or null when the zone cannot
     *   be modelled — a dungeon, a zone with no spawn table, or no battles fought
     */
    function buildCombatSession({
        actionDetail,
        monsterDetailMap,
        battles,
        priceOf,
        difficultyTier = 0,
        bonuses = NO_DROP_BONUSES,
        partySize = 1,
    }) {
        const zone = actionDetail?.combatZoneInfo;
        const fight = zone?.fightInfo;
        const spawnInfo = fight?.randomSpawnInfo;

        // Dungeons pay out of a reward table on completion rather than per monster,
        // which is a different distribution entirely. Better to show nothing than a
        // number built from the wrong model.
        if (!zone || zone.isDungeon) return null;
        if (!spawnInfo?.spawns?.length || !monsterDetailMap) return null;
        if (!(battles > 0)) return null;

        const quantity = dropQuantityMultiplier(bonuses, partySize, false);

        const priceDrop = (drop) => {
            const price = priceOf(drop.itemHrid);
            if (!(price > 0)) return null;

            const rate = effectiveDropRate(drop, difficultyTier, bonuses);
            if (rate <= 0) return null;

            return {
                // Carried through so a per-item expectation can be built from the
                // same priced drops the coin total is; two models of the same
                // session would disagree the moment either changed
                itemHrid: drop.itemHrid,
                minCount: (drop.minCount || 0) * quantity,
                maxCount: (drop.maxCount || 0) * quantity,
                dropRate: rate,
                price,
            };
        };
        const dropsFor = (hrid) => monsterDropList(monsterDetailMap[hrid]).map(priceDrop).filter(Boolean);

        const monsterDrops = {};
        for (const spawn of spawnInfo.spawns) {
            const hrid = spawn.combatMonsterHrid;
            if (hrid) monsterDrops[hrid] = dropsFor(hrid);
        }

        const bossDrops = {};
        for (const boss of fight.bossSpawns || []) {
            const hrid = boss.combatMonsterHrid;
            if (hrid) bossDrops[hrid] = dropsFor(hrid);
        }

        const battlesPerBoss = Object.keys(bossDrops).length ? fight.battlesPerBoss || DEFAULT_BATTLES_PER_BOSS : 0;
        const { normalCount, bossCount } = splitBattles(battles, battlesPerBoss);

        return { spawnInfo, monsterDrops, bossDrops, normalCount, bossCount };
    }

    /**
     * What a run of loot was worth, by the same prices the model used.
     *
     * Has to share the pricing with `buildCombatSession` or the comparison is
     * meaningless — an income counted at ask against a distribution built at bid
     * would read as luck.
     *
     * @param {Object<string, {itemHrid: string, count: number}>} lootMap - The game's `totalLootMap`
     * @param {Function} priceOf - `(itemHrid) => number|null`
     * @returns {number} Total value in coins
     */
    function lootValue(lootMap, priceOf) {
        let total = 0;
        for (const loot of Object.values(lootMap || {})) {
            const price = priceOf(loot.itemHrid);
            if (price > 0) total += price * (loot.count || 0);
        }
        return total;
    }

    /**
     * What one drop pays on average, counting the times it does not land.
     * @param {Object} drop - A priced drop from `buildCombatSession`
     * @returns {number} Coins per attempt
     */
    function dropMean(drop) {
        // The mean of the integerised count is the continuous mean it was built
        // from — the discretisation in `drop-luck.js` splits mass between neighbours
        // in proportion to distance, which is exactly what preserves it
        const meanCount = ((drop.minCount || 0) + (drop.maxCount || 0)) / 2;
        return drop.dropRate * meanCount * drop.price;
    }

    /**
     * What a session was owed on average.
     *
     * The percentile from `sessionLuck` says where a session sits among all the
     * sessions it could have been, which is the honest answer but not an intuitive
     * one — on a zone where a rare carries the value, a perfectly ordinary session
     * sits at the 30th percentile and reads as bad luck. This is the other half of
     * that: how far above or below par the takings actually were, in coins.
     *
     * Computed in closed form rather than from the distribution. The mean of a sum
     * is the sum of the means whatever the shape, so no inversion is needed and this
     * costs microseconds where the percentile costs a tenth of a second.
     *
     * @param {Object} session - As `buildCombatSession` returns
     * @returns {number} Expected income in coins
     */
    function sessionMean({ spawnInfo, monsterDrops, bossDrops = {}, normalCount, bossCount = 0 }) {
        let total = 0;

        const perWave = expectedSpawnsPerWave(spawnInfo);
        for (const [hrid, spawns] of Object.entries(perWave)) {
            const drops = monsterDrops?.[hrid];
            if (!drops?.length) continue;

            const perKill = drops.reduce((sum, drop) => sum + dropMean(drop), 0);
            total += perKill * spawns * (normalCount || 0);
        }

        // Every boss in the table turns up on a boss wave, so they are counted
        // outright rather than weighted by a spawn rate
        for (const drops of Object.values(bossDrops)) {
            const perKill = drops.reduce((sum, drop) => sum + dropMean(drop), 0);
            total += perKill * (bossCount || 0);
        }

        return total;
    }

    /**
     * What a session was owed, item by item.
     *
     * `sessionMean` answers the same question in coins, which is the right shape for
     * "was this run lucky" and the wrong one for "which drop is behind it". Both
     * walk the same priced drops in the same order, so they cannot disagree about
     * the session — one sums `rate × count × price`, this one sums `rate × count`
     * and keeps it under the item.
     *
     * @param {Object} session - From `buildCombatSession`
     * @returns {Object<string, number>} Item hrid → expected count
     */
    function expectedItemCounts({ spawnInfo, monsterDrops, bossDrops = {}, normalCount, bossCount = 0 }) {
        const counts = {};

        const add = (drops, kills) => {
            for (const drop of drops || []) {
                if (!drop?.itemHrid) continue;
                const meanCount = ((drop.minCount || 0) + (drop.maxCount || 0)) / 2;
                counts[drop.itemHrid] = (counts[drop.itemHrid] || 0) + drop.dropRate * meanCount * kills;
            }
        };

        const perWave = expectedSpawnsPerWave(spawnInfo);
        for (const [hrid, spawns] of Object.entries(perWave)) {
            add(monsterDrops?.[hrid], spawns * (normalCount || 0));
        }

        // Every boss in the table turns up on a boss wave, so they are counted
        // outright rather than weighted by a spawn rate
        for (const drops of Object.values(bossDrops)) add(drops, bossCount || 0);

        return counts;
    }

    /**
     * How far above or below par a figure landed, as a percentage.
     *
     * Signed against zero rather than expressed as a fraction of expectation:
     * "+36%" is read at a glance and "136%" is read twice. Nothing to compare
     * against is nothing, not a triumph — a zero expectation with drops in hand is
     * a model that does not cover this zone, not infinite luck.
     *
     * @param {number} actual - What happened
     * @param {number} expected - What was owed
     * @returns {number|null} Signed percentage, or null when there is nothing to say
     */
    function percentOfExpected(actual, expected) {
        if (!(expected > 0)) return null;
        return ((actual || 0) / expected - 1) * 100;
    }

    var combatDropModel = /*#__PURE__*/Object.freeze({
        __proto__: null,
        DEFAULT_BATTLES_PER_BOSS: DEFAULT_BATTLES_PER_BOSS,
        buildCombatSession: buildCombatSession,
        dropQuantityMultiplier: dropQuantityMultiplier,
        effectiveDropRate: effectiveDropRate,
        expectedItemCounts: expectedItemCounts,
        lootValue: lootValue,
        monsterDropList: monsterDropList,
        percentOfExpected: percentOfExpected,
        sessionMean: sessionMean,
        splitBattles: splitBattles
    });

    /**
     * Chest Tally
     *
     * What you actually got out of the chests you opened, against what they owed you.
     *
     * Toolasha already prices a chest before you open it — `expected-value-calculator.js`
     * says what one is worth on average, and that shows up in tooltips and net worth.
     * What it cannot say is whether the four hundred you have already opened paid out.
     * Expected value is a statement about the long run; this is the ledger that says
     * whether the long run has arrived.
     *
     * The comparison is deliberately made against **your own openings**, item by item,
     * rather than against a headline average. A chest that owes you one rare in two
     * hundred is not meaningfully behind after fifty, and the per-item breakdown is
     * what shows that the shortfall is one unlucky rare rather than something wrong
     * across the board.
     *
     * Pure, and separate from the panel that draws it, for the usual reason: an
     * expectation computed slightly wrong still renders as a confident percentage.
     *
     * The idea and the ledger shape come from TReasure in MWI Combat Suite by Frotty
     * (MIT) — see `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`.
     */

    /**
     * Fold one `loot_opened` message into the tally.
     *
     * Returns a new tally rather than mutating, so a caller can persist the result
     * without worrying about which copy is which.
     *
     * @param {Object} tally - `{ [chestHrid]: { opened, loot: { [itemHrid]: count } } }`
     * @param {string} chestHrid - What was opened
     * @param {number} count - How many
     * @param {Array<{itemHrid: string, count: number}>} gainedItems - What came out
     * @returns {Object} A new tally
     */
    function recordOpening(tally, chestHrid, count, gainedItems) {
        if (!chestHrid || !(count > 0)) return tally || {};

        const previous = (tally || {})[chestHrid] || { opened: 0, loot: {} };
        const loot = { ...previous.loot };
        const justNow = {};

        for (const item of gainedItems || []) {
            if (!item?.itemHrid) continue;
            loot[item.itemHrid] = (loot[item.itemHrid] || 0) + (item.count || 0);
            justNow[item.itemHrid] = (justNow[item.itemHrid] || 0) + (item.count || 0);
        }

        // `last` is the same shape as the running total, so anything that can judge
        // a lifetime can judge a single opening without a second code path
        return {
            ...tally,
            [chestHrid]: { opened: previous.opened + count, loot, last: { opened: count, loot: justNow } },
        };
    }

    /**
     * Forget one chest's history, or all of it.
     * @param {Object} tally - The tally
     * @param {string} [chestHrid] - Which chest; omit to clear everything
     * @returns {Object} A new tally
     */
    function resetTally(tally, chestHrid) {
        if (!chestHrid) return {};

        const next = { ...tally };
        delete next[chestHrid];
        return next;
    }

    /**
     * What one chest owes on average, per item.
     *
     * The midpoint of the count range times the rate — the same arithmetic the
     * expected-value calculator uses, kept here in item counts rather than collapsed
     * to a single coin figure, because the interesting question is which item came up
     * short and not just by how much.
     *
     * @param {Array<Object>} dropTable - An entry of `openableLootDropMap`
     * @returns {Object<string, number>} Item hrid → expected count per chest
     */
    function expectedLootPerChest(dropTable) {
        const expected = {};

        for (const drop of dropTable || []) {
            if (!drop?.itemHrid) continue;
            const rate = drop.dropRate ?? 0;
            const average = ((drop.minCount ?? 0) + (drop.maxCount ?? 0)) / 2;
            const count = rate * average;
            if (count > 0) expected[drop.itemHrid] = (expected[drop.itemHrid] || 0) + count;
        }
        return expected;
    }

    /**
     * How one chest has treated you.
     *
     * Items are returned whether they dropped or not: a rare that never came up is
     * the whole story on an unlucky chest, and leaving it out of the list would hide
     * exactly the row worth seeing.
     *
     * @param {Object} entry - `{ opened, loot }` for one chest
     * @param {Array<Object>} dropTable - That chest's drop table
     * @param {Function} priceOf - `(itemHrid) => number|null`
     * @returns {Object} `{ opened, actualValue, expectedValue, difference, ratio, items }`
     *   where `ratio` is null until something has been opened
     */
    function chestPerformance(entry, dropTable, priceOf) {
        const opened = entry?.opened || 0;
        const loot = entry?.loot || {};
        const perChest = expectedLootPerChest(dropTable);

        const hrids = new Set([...Object.keys(perChest), ...Object.keys(loot)]);
        const items = [];
        let actualValue = 0;
        let expectedValue = 0;

        for (const itemHrid of hrids) {
            const price = priceOf(itemHrid);
            // No price means no contribution to either side, which keeps the
            // comparison honest rather than counting the item as free. It is still
            // a row: an item that dropped and is simply not shown reads as a chest
            // that did not contain it, and a panel that quietly omits things is
            // worse than one that says it cannot price them.
            const priced = price > 0;

            const actualCount = loot[itemHrid] || 0;
            const expectedCount = (perChest[itemHrid] || 0) * opened;

            if (priced) {
                actualValue += actualCount * price;
                expectedValue += expectedCount * price;
            }

            items.push({
                itemHrid,
                actualCount,
                expectedCount,
                unpriced: !priced,
                actualValue: priced ? actualCount * price : 0,
                expectedValue: priced ? expectedCount * price : 0,
            });
        }

        // Sorted by how much of each the chest owes you, commonest first, and by
        // nothing else.
        //
        // It used to be sorted by what each was worth, which meant the rows moved
        // whenever a price moved and whenever the cape or cowbell valuation was
        // changed — a list you had learned the shape of rearranged itself for
        // reasons that had nothing to do with the chest. A drop table does not
        // change, so an order taken from it does not either. It is also the order
        // TReasure lists them in.
        //
        // An item that dropped but is not in the table is owed nothing and goes
        // last; the hrid tie-break is only there so that group has a fixed order
        // rather than the map's.
        items.sort((a, b) => b.expectedCount - a.expectedCount || a.itemHrid.localeCompare(b.itemHrid));

        return {
            opened,
            actualValue,
            expectedValue,
            difference: actualValue - expectedValue,
            ratio: expectedValue > 0 ? actualValue / expectedValue : null,
            items,
        };
    }

    /**
     * One chest's history in the three views the panel shows side by side.
     *
     * The same items appear in each column, in the same order, so a row can be read
     * across: what the last opening gave, what every opening has given, and what one
     * chest and the whole run were owed. Ordering them separately per column would
     * make the comparison a lookup rather than a glance.
     *
     * @param {Object} entry - `{ opened, loot, last }` for one chest
     * @param {Array<Object>} dropTable - That chest's drop table
     * @param {Function} priceOf - `(itemHrid) => number|null`
     * @returns {Object} `{ last, total, perChestValue, items }` where each item carries
     *   its last, total and expected figures together
     */
    function chestBreakdown(entry, dropTable, priceOf) {
        const total = chestPerformance(entry, dropTable, priceOf);
        const last = chestPerformance(entry?.last, dropTable, priceOf);
        const perChest = expectedLootPerChest(dropTable);

        const lastByItem = new Map(last.items.map((item) => [item.itemHrid, item]));
        const opened = entry?.opened || 0;

        const items = total.items.map((item) => {
            const price = priceOf(item.itemHrid) || 0;
            const perOne = perChest[item.itemHrid] || 0;
            const lastItem = lastByItem.get(item.itemHrid);
            const lastOpened = entry?.last?.opened || 0;
            const lastExpectedValue = perOne * lastOpened * price;

            return {
                itemHrid: item.itemHrid,
                price,
                unpriced: item.unpriced,
                lastCount: lastItem?.actualCount || 0,
                lastValue: lastItem?.actualValue || 0,
                lastRatio: lastExpectedValue > 0 ? (lastItem?.actualValue || 0) / lastExpectedValue : null,
                totalCount: item.actualCount,
                totalValue: item.actualValue,
                totalRatio: item.expectedValue > 0 ? item.actualValue / item.expectedValue : null,
                expectedPerChest: perOne,
                expectedPerChestValue: perOne * price,
                expectedTotal: perOne * opened,
                expectedTotalValue: item.expectedValue,
            };
        });

        // What one chest is worth on average, which is the figure beside its name
        const perChestValue = Object.entries(perChest).reduce(
            (sum, [itemHrid, count]) => sum + count * (priceOf(itemHrid) || 0),
            0
        );

        return { last, total, perChestValue, items };
    }

    /**
     * Every chest in the game, with whatever history you have for it.
     *
     * Unopened chests are listed too, priced but with no verdict, because the panel
     * is also the place to look up what a chest is worth before deciding to open it
     * — a list of only what you have already opened cannot answer that.
     *
     * Ordered by how far from expectation each sits, worst first, since the reason
     * to open the panel is usually to find out which chest let you down. Chests with
     * no history sort after those, by what one is worth, so the list stays useful
     * rather than alphabetical.
     *
     * @param {Object} tally - The tally
     * @param {Object} dropTables - `openableLootDropMap`
     * @param {Function} priceOf - `(itemHrid) => number|null`
     * @returns {Array<Object>} Performances, each with `chestHrid` and `perChestValue`
     */
    function summariseTally(tally, dropTables, priceOf) {
        // Every chest the game knows about, plus anything in the tally that the game
        // has since stopped listing — history should not vanish on a game update
        const chestHrids = new Set([...Object.keys(dropTables || {}), ...Object.keys(tally || {})]);

        const rows = [...chestHrids].map((chestHrid) => {
            const dropTable = dropTables?.[chestHrid];
            const performance = chestPerformance((tally || {})[chestHrid], dropTable, priceOf);
            const perChest = expectedLootPerChest(dropTable);
            const perChestValue = Object.entries(perChest).reduce(
                (sum, [itemHrid, count]) => sum + count * (priceOf(itemHrid) || 0),
                0
            );
            return { chestHrid, perChestValue, ...performance };
        });

        return sortSummary(rows);
    }

    /**
     * The orders the panel offers, in the order it offers them.
     *
     * `luck` is the default and the reason the panel exists. The rest are there
     * because it lists every chest in the game — sixty-odd rows — and a ranking by
     * how unlucky each was is the worst possible order for finding one chest you
     * have in mind. `name` is that: the row is where the alphabet says it is.
     */
    const SORT_MODES = [
        { key: 'luck', label: 'Luck (worst first)' },
        { key: 'name', label: 'Name (A–Z)' },
        { key: 'opened', label: 'Most opened' },
        { key: 'value', label: 'Chest value' },
        { key: 'profit', label: 'Coins up or down' },
    ];

    /**
     * Order the rows.
     *
     * Sorts a copy: the caller's array is usually the one on screen, and reordering
     * it underneath a half-drawn table is how a row ends up drawn twice.
     *
     * @param {Array<Object>} rows - From `summariseTally`
     * @param {string} [mode] - One of `SORT_MODES`
     * @param {Function} [nameOf] - `(chestHrid) => string`, for the name order
     * @returns {Array<Object>} A new, sorted array
     */
    function sortSummary(rows, mode = 'luck', nameOf = (chestHrid) => chestHrid) {
        const sorted = [...(rows || [])];

        if (mode === 'name') {
            // Every chest, opened or not, in one alphabet — splitting them would put
            // half the names in one place and half in another, which is the thing
            // this order exists to avoid
            sorted.sort((a, b) => String(nameOf(a.chestHrid)).localeCompare(String(nameOf(b.chestHrid))));
            return sorted;
        }

        sorted.sort((a, b) => {
            // A chest you have never opened has no verdict to rank, so it waits
            // behind the ones that do
            if (!a.opened !== !b.opened) return a.opened ? -1 : 1;
            if (!a.opened) return b.perChestValue - a.perChestValue;

            if (mode === 'opened') return b.opened - a.opened;
            if (mode === 'value') return b.perChestValue - a.perChestValue;
            if (mode === 'profit') {
                return b.actualValue - b.expectedValue - (a.actualValue - a.expectedValue);
            }
            return (a.ratio ?? Infinity) - (b.ratio ?? Infinity);
        });
        return sorted;
    }

    /**
     * The totals across every chest, since one chest running hot while another runs
     * cold is the common case and neither row answers "am I up or down".
     * @param {Array<Object>} rows - From `summariseTally`
     * @returns {Object} `{ opened, actualValue, expectedValue, difference, ratio }`
     */
    function tallyTotals(rows) {
        const totals = rows.reduce(
            (sum, row) => ({
                opened: sum.opened + row.opened,
                actualValue: sum.actualValue + row.actualValue,
                expectedValue: sum.expectedValue + row.expectedValue,
            }),
            { opened: 0, actualValue: 0, expectedValue: 0 }
        );

        return {
            ...totals,
            difference: totals.actualValue - totals.expectedValue,
            ratio: totals.expectedValue > 0 ? totals.actualValue / totals.expectedValue : null,
        };
    }

    var chestTally = /*#__PURE__*/Object.freeze({
        __proto__: null,
        SORT_MODES: SORT_MODES,
        chestBreakdown: chestBreakdown,
        chestPerformance: chestPerformance,
        expectedLootPerChest: expectedLootPerChest,
        recordOpening: recordOpening,
        resetTally: resetTally,
        sortSummary: sortSummary,
        summariseTally: summariseTally,
        tallyTotals: tallyTotals
    });

    /**
     * Enhancement Calculator Worker Manager
     * Manages a worker pool for parallel enhancement calculations
     */


    // Worker pool instance
    let workerPool$1 = null;

    // Worker script as inline string — this is the sole source of the worker code.
    // The chain itself is NOT written here: a blob worker cannot import a module, so the real
    // buildEnhancementMarkov is serialised in below. A hand-copied chain in this string is exactly
    // how the worker drifted from the calculator and lost the success-chance clamp.
    const WORKER_SCRIPT$1 = `
// Import math.js library from CDN
importScripts('https://cdnjs.cloudflare.com/ajax/libs/mathjs/12.4.2/math.js');

// Cache for enhancement calculation results
const calculationCache = new Map();

const BASE_SUCCESS_RATES = ${JSON.stringify(BASE_SUCCESS_RATES)};
const DEFAULT_BLESSED_TEA_CHANCE = ${BLESSED_TEA_BASE_CHANCE};
const buildEnhancementMarkov = ${buildEnhancementMarkov.toString()};

function getCacheKey(params) {
    const {enhancingLevel,toolBonus,itemLevel,targetLevel,protectFrom,blessedTea,guzzlingBonus,blessedTeaBonus,speedBonus} = params;
    return \`\${enhancingLevel}|\${toolBonus}|\${itemLevel}|\${targetLevel}|\${protectFrom}|\${blessedTea}|\${guzzlingBonus}|\${blessedTeaBonus}|\${speedBonus}\`;
}

function calculateSuccessMultiplier(params) {
    const { enhancingLevel, toolBonus, itemLevel } = params;
    let totalBonus;
    if (enhancingLevel >= itemLevel) {
        const levelAdvantage = 0.05 * (enhancingLevel - itemLevel);
        totalBonus = 1 + (toolBonus + levelAdvantage) / 100;
    } else {
        totalBonus = 1 - 0.5 * (1 - enhancingLevel / itemLevel) + toolBonus / 100;
    }
    return totalBonus;
}

function calculateEnhancement(params) {
    const {enhancingLevel,toolBonus,speedBonus=0,itemLevel,targetLevel,protectFrom=0,blessedTea=false,guzzlingBonus=1.0,blessedTeaBonus=DEFAULT_BLESSED_TEA_CHANCE} = params;

    if (targetLevel < 1 || targetLevel > 20) throw new Error('Target level must be between 1 and 20');
    if (protectFrom < 0 || protectFrom > targetLevel) throw new Error('Protection level must be between 0 and target level');

    const successMultiplier = calculateSuccessMultiplier({enhancingLevel,toolBonus,itemLevel});
    const markov = buildEnhancementMarkov(math, {
        baseSuccessRates: BASE_SUCCESS_RATES,
        successMultiplier,
        targetLevel,
        protectFrom,
        blessedTea,
        guzzlingBonus,
        blessedTeaBonus,
    });

    const Q = markov.subset(math.index(math.range(0, targetLevel), math.range(0, targetLevel)));
    const I = math.identity(targetLevel);
    const M = math.inv(math.subtract(I, Q));

    let attempts = 0;
    for (let i = 0; i < targetLevel; i++) {
        attempts += M.get([0, i]);
    }

    let protects = 0;
    if (protectFrom > 0 && protectFrom < targetLevel) {
        for (let i = protectFrom; i < targetLevel; i++) {
            const timesAtLevel = M.get([0, i]);
            const failureChance = markov.get([i, i - 1]);
            protects += timesAtLevel * failureChance;
        }
    }

    const baseActionTime = 12;
    let speedMultiplier;
    if (enhancingLevel > itemLevel) {
        speedMultiplier = 1 + (enhancingLevel - itemLevel + speedBonus) / 100;
    } else {
        speedMultiplier = 1 + speedBonus / 100;
    }

    const perActionTime = baseActionTime / speedMultiplier;
    const totalTime = perActionTime * attempts;

    return {
        attempts,
        attemptsRounded: Math.round(attempts),
        protectionCount: protects,
        perActionTime,
        totalTime,
        successMultiplier,
        successRates: BASE_SUCCESS_RATES.slice(0, targetLevel).map((base, i) => ({
            level: i + 1,
            baseRate: base,
            actualRate: Math.min(100, base * successMultiplier)
        }))
    };
}

self.onmessage = function (e) {
    const { taskId, data } = e.data;
    try {
        const { action, params } = data;
        if (action === 'calculate') {
            const cacheKey = getCacheKey(params);
            let result = calculationCache.get(cacheKey);
            if (!result) {
                result = calculateEnhancement(params);
                calculationCache.set(cacheKey, result);
                if (calculationCache.size > 1000) {
                    const firstKey = calculationCache.keys().next().value;
                    calculationCache.delete(firstKey);
                }
            }
            self.postMessage({taskId,result});
        } else if (action === 'clearCache') {
            calculationCache.clear();
            self.postMessage({taskId,result: { success: true, message: 'Cache cleared' }});
        } else {
            throw new Error(\`Unknown action: \${action}\`);
        }
    } catch (error) {
        self.postMessage({taskId,error: error.message || String(error)});
    }
};
`;

    /**
     * Get or create the worker pool instance
     */
    async function getWorkerPool$1() {
        if (workerPool$1) {
            return workerPool$1;
        }

        try {
            // Create worker blob from inline script
            const blob = new Blob([WORKER_SCRIPT$1], { type: 'application/javascript' });

            // Initialize worker pool with 2-4 workers
            workerPool$1 = new WorkerPool(blob);
            await workerPool$1.initialize();

            return workerPool$1;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Calculate enhancement path using worker pool
     * @param {Object} params - Enhancement parameters
     * @returns {Promise<Object>} Enhancement calculation results
     */
    async function calculateEnhancementAsync(params) {
        const pool = await getWorkerPool$1();

        return pool.execute({
            action: 'calculate',
            params,
        });
    }

    /**
     * Calculate multiple enhancements in parallel
     * @param {Array<Object>} paramsArray - Array of enhancement parameters
     * @returns {Promise<Array<Object>>} Array of enhancement results
     */
    async function calculateEnhancementBatch(paramsArray) {
        const pool = await getWorkerPool$1();

        const tasks = paramsArray.map((params) => ({
            action: 'calculate',
            params,
        }));

        return pool.executeAll(tasks);
    }

    /**
     * Clear the worker cache
     */
    async function clearEnhancementCache() {
        if (!workerPool$1) {
            return;
        }

        const pool = await getWorkerPool$1();
        return pool.execute({
            action: 'clearCache',
        });
    }

    /**
     * Get worker pool statistics
     */
    function getWorkerStats() {
        return workerPool$1 ? workerPool$1.getStats() : null;
    }

    /**
     * Terminate the worker pool
     */
    function terminateWorkerPool() {
        if (workerPool$1) {
            workerPool$1.terminate();
            workerPool$1 = null;
        }
    }

    var enhancementWorkerManager = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateEnhancementAsync: calculateEnhancementAsync,
        calculateEnhancementBatch: calculateEnhancementBatch,
        clearEnhancementCache: clearEnhancementCache,
        getWorkerStats: getWorkerStats,
        terminateWorkerPool: terminateWorkerPool
    });

    /**
     * Networth Item Valuation Worker Manager
     * Manages parallel item valuation calculations including enhancement paths
     */


    // Worker pool instance
    let workerPool = null;

    // Worker script as inline string.
    // The Markov chain is not written here: a blob worker cannot import a module, so the real
    // buildEnhancementMarkov is serialised in below and networth costs the same chain the tooltip
    // quotes, clamp and blessed-tea chance included.
    const WORKER_SCRIPT = `
// Import math.js library for enhancement calculations
importScripts('https://cdnjs.cloudflare.com/ajax/libs/mathjs/12.4.2/math.js');

// Cache for item valuations
const valuationCache = new Map();

// Enhancement calculation BASE_SUCCESS_RATES
const BASE_SUCCESS_RATES = ${JSON.stringify(BASE_SUCCESS_RATES)};
const DEFAULT_BLESSED_TEA_CHANCE = ${BLESSED_TEA_BASE_CHANCE};
const buildEnhancementMarkov = ${buildEnhancementMarkov.toString()};

/**
 * Calculate production cost from crafting/upgrading recipe
 * @param {string} itemHrid - Item HRID
 * @param {Object} priceMap - Price map
 * @param {Object} actionDetailMap - Action detail map from game data
 * @returns {number} Production cost
 */
function calculateProductionCost(itemHrid, priceMap, actionDetailMap) {
    // Find the action that produces this item
    let action = null;
    for (const actionHrid in actionDetailMap) {
        const actionData = actionDetailMap[actionHrid];
        if (actionData.outputItems && actionData.outputItems.length > 0) {
            if (actionData.outputItems[0].itemHrid === itemHrid) {
                action = actionData;
                break;
            }
        }
    }

    if (!action) {
        return 0;
    }

    let totalPrice = 0;

    // Sum up input material costs
    if (action.inputItems) {
        for (const input of action.inputItems) {
            // Match main thread: getItemPrice(input.itemHrid, { mode: 'ask' }) || 0
            let inputPrice = priceMap[input.itemHrid + ':0_ask'];
            if (inputPrice === undefined) inputPrice = priceMap[input.itemHrid + ':0'];
            if (inputPrice === null || inputPrice === undefined) inputPrice = 0;

            // Recursively calculate production cost if no market price (matches main thread)
            if (inputPrice === 0) {
                inputPrice = calculateProductionCost(input.itemHrid, priceMap, actionDetailMap);
            }

            totalPrice += inputPrice * input.count;
        }
    }

    // Apply Artisan Tea reduction (0.9x)
    totalPrice *= 0.9;

    // Add upgrade item cost if this is an upgrade recipe (for refined items)
    if (action.upgradeItemHrid) {
        // Match main thread: getItemPrice(action.upgradeItemHrid, { mode: 'ask' }) || 0
        let upgradePrice = priceMap[action.upgradeItemHrid + ':0_ask'];
        if (upgradePrice === undefined) upgradePrice = priceMap[action.upgradeItemHrid + ':0'];
        if (upgradePrice === null || upgradePrice === undefined) upgradePrice = 0;

        // Recursively calculate production cost if no market price (matches main thread)
        if (upgradePrice === 0) {
            upgradePrice = calculateProductionCost(action.upgradeItemHrid, priceMap, actionDetailMap);
        }

        totalPrice += upgradePrice;
    }

    return totalPrice;
}

/**
 * Calculate enhancement path cost using proper strategy optimization
 * @param {Object} params - Enhancement calculation parameters
 * @returns {number} Total cost
 */
function calculateEnhancementCost(params) {
    const { itemHrid, targetLevel, enhancementParams, itemDetails, priceMap, actionDetailMap } = params;

    if (!itemDetails.enhancementCosts || targetLevel < 1 || targetLevel > 20) {
        return null;
    }

    const itemLevel = itemDetails.itemLevel || 1;

    // Get base item cost using realistic pricing (matches main thread logic)
    const basePrice = getRealisticPrice(itemHrid, null, priceMap, actionDetailMap);

    // Build cost array for each level by testing all protection strategies
    const targetCosts = new Array(targetLevel + 1);
    targetCosts[0] = basePrice;

    for (let level = 1; level <= targetLevel; level++) {
        // Calculate per-attempt material cost (sum of ALL materials)
        let perAttemptMaterialCost = 0;
        if (itemDetails.enhancementCosts && itemDetails.enhancementCosts.length > 0) {
            for (const material of itemDetails.enhancementCosts) {
                let materialPrice = 0;

                // Special cases
                if (material.itemHrid.startsWith('/items/trainee_')) {
                    materialPrice = 250000; // Trainee charms are untradeable, fixed price
                } else if (material.itemHrid === '/items/coin') {
                    materialPrice = 1; // Coins have face value of 1
                } else {
                    // Get material details for sellPrice fallback
                    const materialDetail = itemDetails.enhancementCosts ?
                        (itemDetails.allItemDetails && itemDetails.allItemDetails[material.itemHrid]) : null;

                    // Try to get market price from priceMap
                    const hasMarketData = (material.itemHrid + ':0_ask') in priceMap || (material.itemHrid + ':0') in priceMap;

                    if (hasMarketData) {
                        let ask = priceMap[material.itemHrid + ':0_ask'];
                        if (ask === undefined) ask = priceMap[material.itemHrid + ':0'];
                        let bid = priceMap[material.itemHrid + ':0_bid'];

                        // Match MCS behavior: if one price is positive and other is negative, use positive for both
                        if (ask > 0 && bid < 0) {
                            bid = ask;
                        }
                        if (bid > 0 && ask < 0) {
                            ask = bid;
                        }

                        // MCS uses just ask for material prices (matches main thread)
                        materialPrice = ask || 0;
                    } else {
                        // Fallback to sellPrice if no market data (matches main thread)
                        materialPrice = materialDetail?.sellPrice || 0;
                    }
                }

                perAttemptMaterialCost += materialPrice * material.count;
            }
        }

        // Test no protection (protectFrom = 0)
        let minCost = Infinity;
        const noProtResult = calculateStrategyRealCost(
            enhancementParams,
            itemLevel,
            level,
            0,
            perAttemptMaterialCost,
            basePrice,
            priceMap,
            itemDetails,
            itemHrid,
            actionDetailMap
        );
        if (noProtResult < minCost) {
            minCost = noProtResult;
        }

        // Test protection from level 2 to current level
        for (let protectFrom = 2; protectFrom <= level; protectFrom++) {
            const protResult = calculateStrategyRealCost(
                enhancementParams,
                itemLevel,
                level,
                protectFrom,
                perAttemptMaterialCost,
                basePrice,
                priceMap,
                itemDetails,
                itemHrid,
                actionDetailMap
            );
            if (protResult < minCost) {
                minCost = protResult;
            }
        }

        targetCosts[level] = minCost;
    }

    // Apply Philosopher's Mirror optimization
    let mirrorPrice = priceMap['/items/philosophers_mirror:0'] || 0;
    if (mirrorPrice === 0) {
        mirrorPrice = calculateProductionCost('/items/philosophers_mirror', priceMap, actionDetailMap);
    }

    if (mirrorPrice > 0) {
        for (let level = 3; level <= targetLevel; level++) {
            const traditionalCost = targetCosts[level];
            const mirrorCost = targetCosts[level - 2] + targetCosts[level - 1] + mirrorPrice;
            if (mirrorCost < traditionalCost) {
                targetCosts[level] = mirrorCost;
            }
        }
    }

    return targetCosts[targetLevel];
}

/**
 * Calculate real cost for a specific protection strategy
 * Now includes support for Blessed Tea
 */
function calculateStrategyRealCost(
    enhancementParams,
    itemLevel,
    targetLevel,
    protectFrom,
    perAttemptMaterialCost,
    baseItemPrice,
    priceMap,
    itemDetails,
    itemHrid,
    actionDetailMap
) {
    const { enhancingLevel, toolBonus, blessedTea = false, guzzlingBonus = 1.0, blessedTeaBonus = DEFAULT_BLESSED_TEA_CHANCE } = enhancementParams;

    // Calculate success multiplier
    let totalBonus;
    if (enhancingLevel >= itemLevel) {
        const levelAdvantage = 0.05 * (enhancingLevel - itemLevel);
        totalBonus = 1 + (toolBonus + levelAdvantage) / 100;
    } else {
        totalBonus = 1 - 0.5 * (1 - enhancingLevel / itemLevel) + toolBonus / 100;
    }

    // Build Markov chain (shared with the main-thread calculator)
    const markov = buildEnhancementMarkov(math, {
        baseSuccessRates: BASE_SUCCESS_RATES,
        successMultiplier: totalBonus,
        targetLevel,
        protectFrom,
        blessedTea,
        guzzlingBonus,
        blessedTeaBonus,
    });

    // Solve for expected attempts and protections
    const Q = markov.subset(math.index(math.range(0, targetLevel), math.range(0, targetLevel)));
    const I = math.identity(targetLevel);
    const M = math.inv(math.subtract(I, Q));

    let attempts = 0;
    for (let i = 0; i < targetLevel; i++) {
        attempts += M.get([0, i]);
    }

    // Calculate expected protection uses
    let protections = 0;
    if (protectFrom > 0 && protectFrom < targetLevel) {
        for (let i = protectFrom; i < targetLevel; i++) {
            const timesAtLevel = M.get([0, i]);
            const failureChance = markov.get([i, i - 1]);
            protections += timesAtLevel * failureChance;
        }
    }

    // Get protection item price using realistic pricing (like main thread)
    let protectionPrice = 0;
    if (protections > 0) {
        protectionPrice = getRealisticPrice(itemHrid, baseItemPrice, priceMap, actionDetailMap);

        // Check mirror of protection
        const mirrorPrice = getRealisticPrice('/items/mirror_of_protection', null, priceMap, actionDetailMap);
        if (mirrorPrice > 0 && mirrorPrice < protectionPrice) {
            protectionPrice = mirrorPrice;
        }

        // Check specific protection items
        if (itemDetails.protectionItemHrids && itemDetails.protectionItemHrids.length > 0) {
            for (const protHrid of itemDetails.protectionItemHrids) {
                const protPrice = getRealisticPrice(protHrid, null, priceMap, actionDetailMap);
                if (protPrice > 0 && protPrice < protectionPrice) {
                    protectionPrice = protPrice;
                }
            }
        }
    }

    const materialCost = perAttemptMaterialCost * attempts;
    const protectionCost = protectionPrice * protections;

    return baseItemPrice + materialCost + protectionCost;
}

/**
 * Get realistic price for an item (matches main thread logic)
 * Handles inflation detection and fallbacks
 */
function getRealisticPrice(itemHrid, knownBasePrice, priceMap, actionDetailMap) {
    let ask = priceMap[itemHrid + ':0_ask'];
    if (ask === undefined) ask = priceMap[itemHrid + ':0'];
    if (ask === null || ask === undefined) ask = 0;

    let bid = priceMap[itemHrid + ':0_bid'];
    if (bid === null || bid === undefined) bid = 0;

    // Calculate production cost as fallback
    const productionCost = calculateProductionCost(itemHrid, priceMap, actionDetailMap);

    // If both ask and bid exist
    if (ask > 0 && bid > 0) {
        // If ask is significantly higher than bid (>30% markup), use max(bid, production)
        if (ask / bid > 1.3) {
            return Math.max(bid, productionCost);
        }
        // Otherwise use ask (normal market)
        return ask;
    }

    // If only ask exists
    if (ask > 0) {
        // If ask is inflated compared to production, use production
        if (productionCost > 0 && ask / productionCost > 1.3) {
            return productionCost;
        }
        // Otherwise use max of ask and production
        return Math.max(ask, productionCost);
    }

    // If only bid exists, use max(bid, production)
    if (bid > 0) {
        return Math.max(bid, productionCost);
    }

    // No market data - use production cost or known base price
    return productionCost > 0 ? productionCost : (knownBasePrice || 0);
}

/**
 * Calculate value for a single item
 * @param {Object} data - Item data
 * @returns {Object} {itemIndex, value}
 */
function calculateItemValue(data) {
    const { itemIndex, item, priceMap, useHighEnhancementCost, minLevel, enhancementParams, itemDetails, actionDetailMap } = data;
    const { itemHrid, enhancementLevel = 0, count = 1 } = item;

    let itemValue = 0;

    // For enhanced items (1+)
    if (enhancementLevel >= 1) {
        // For high enhancement levels, use cost instead of market price (if enabled)
        if (useHighEnhancementCost && enhancementLevel >= minLevel) {
            // Calculate enhancement cost
            const cost = calculateEnhancementCost({
                itemHrid,
                targetLevel: enhancementLevel,
                enhancementParams,
                itemDetails,
                priceMap,
                actionDetailMap
            });

            if (cost !== null && cost > 0) {
                itemValue = cost;
            } else {
                // Fallback to base item price or production cost
                let basePrice = priceMap[itemHrid + ':0'] || 0;
                if (basePrice === 0) {
                    basePrice = calculateProductionCost(itemHrid, priceMap, actionDetailMap);
                }
                itemValue = basePrice;
            }
        } else {
            // Normal logic: try market price first
            const marketPrice = priceMap[itemHrid + ':' + enhancementLevel] || 0;

            if (marketPrice > 0) {
                itemValue = marketPrice;
            } else {
                // No market data, calculate enhancement cost
                const cost = calculateEnhancementCost({
                    itemHrid,
                    targetLevel: enhancementLevel,
                    enhancementParams,
                    itemDetails,
                    priceMap,
                    actionDetailMap
                });

                if (cost !== null && cost > 0) {
                    itemValue = cost;
                } else {
                    let basePrice = priceMap[itemHrid + ':0'] || 0;
                    if (basePrice === 0) {
                        basePrice = calculateProductionCost(itemHrid, priceMap, actionDetailMap);
                    }
                    itemValue = basePrice;
                }
            }
        }
    } else {
        // Unenhanced items: use market price or production cost
        itemValue = priceMap[itemHrid + ':0'] || 0;
        if (itemValue === 0) {
            itemValue = calculateProductionCost(itemHrid, priceMap, actionDetailMap);
        }
    }

    return { itemIndex, value: itemValue * count };
}

/**
 * Calculate values for a batch of items
 * @param {Array} items - Array of item data objects
 * @returns {Array} Array of {itemIndex, value} results
 */
function calculateItemValueBatch(items) {
    const results = [];

    for (const itemData of items) {
        const result = calculateItemValue(itemData);
        results.push(result);
    }

    return results;
}

self.onmessage = function (e) {
    const { taskId, data } = e.data;
    try {
        const { action, params } = data;

        if (action === 'calculateBatch') {
            const results = calculateItemValueBatch(params.items);
            self.postMessage({ taskId, result: results });
        } else if (action === 'clearCache') {
            valuationCache.clear();
            self.postMessage({ taskId, result: { success: true, message: 'Cache cleared' } });
        } else {
            throw new Error(\`Unknown action: \${action}\`);
        }
    } catch (error) {
        self.postMessage({ taskId, error: error.message || String(error) });
    }
};
`;

    /**
     * Get or create the worker pool instance
     */
    async function getWorkerPool() {
        if (workerPool) {
            return workerPool;
        }

        try {
            // Create worker blob from inline script
            const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });

            // Initialize worker pool with 2-4 workers
            workerPool = new WorkerPool(blob);
            await workerPool.initialize();

            return workerPool;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Calculate values for multiple items in parallel
     * @param {Array} items - Array of item objects
     * @param {Object} priceMap - Price map for all items
     * @param {Object} config - Configuration options
     * @param {Object} gameData - Game data with item details
     * @returns {Promise<Array>} Array of values in same order as input
     */
    async function calculateItemValueBatch(items, priceMap, configOptions, gameData) {
        const pool = await getWorkerPool();

        // Prepare data for workers - need to include item details, material details, and actionDetailMap
        const itemsWithDetails = items.map((item, index) => {
            const itemDetails = gameData.itemDetailMap[item.itemHrid];

            // Include material item details for sellPrice fallback
            const allItemDetails = {};
            if (itemDetails && itemDetails.enhancementCosts) {
                for (const material of itemDetails.enhancementCosts) {
                    const materialDetail = gameData.itemDetailMap[material.itemHrid];
                    if (materialDetail) {
                        allItemDetails[material.itemHrid] = {
                            sellPrice: materialDetail.sellPrice,
                            name: materialDetail.name,
                        };
                    }
                }
            }

            return {
                itemIndex: index,
                item,
                priceMap,
                useHighEnhancementCost: configOptions.useHighEnhancementCost,
                minLevel: configOptions.minLevel,
                enhancementParams: configOptions.enhancementParams,
                itemDetails: itemDetails ? { ...itemDetails, allItemDetails } : {},
                actionDetailMap: gameData.actionDetailMap,
            };
        });

        // Split items into chunks for parallel processing
        const chunkSize = Math.ceil(itemsWithDetails.length / pool.getStats().poolSize);
        const chunks = [];

        for (let i = 0; i < itemsWithDetails.length; i += chunkSize) {
            chunks.push(itemsWithDetails.slice(i, i + chunkSize));
        }

        // Process chunks in parallel
        const tasks = chunks.map((chunk) => ({
            action: 'calculateBatch',
            params: { items: chunk },
        }));

        const results = await pool.executeAll(tasks);

        // Flatten results and sort by itemIndex to maintain order
        const flatResults = results.flat();
        flatResults.sort((a, b) => a.itemIndex - b.itemIndex);

        // Extract just the values
        return flatResults.map((r) => r.value);
    }

    /**
     * Clear the worker cache
     */
    async function clearItemValueCache() {
        if (!workerPool) {
            return;
        }

        const pool = await getWorkerPool();
        return pool.execute({
            action: 'clearCache',
        });
    }

    /**
     * Get worker pool statistics
     */
    function getItemValueWorkerStats() {
        return workerPool ? workerPool.getStats() : null;
    }

    /**
     * Terminate the worker pool
     */
    function terminateItemValueWorkerPool() {
        if (workerPool) {
            workerPool.terminate();
            workerPool = null;
        }
    }

    var networthWorkerManager = /*#__PURE__*/Object.freeze({
        __proto__: null,
        calculateItemValueBatch: calculateItemValueBatch,
        clearItemValueCache: clearItemValueCache,
        getItemValueWorkerStats: getItemValueWorkerStats,
        terminateItemValueWorkerPool: terminateItemValueWorkerPool
    });

    /**
     * Performance Monitor
     * Tracks execution time of features and DOM observer handlers
     * using a rolling window for CPU percentage calculations.
     */

    const WINDOW_MS = 5000;

    /**
     * When the script started, as the clock the rest of the timings are quoted
     * against. `performance.now()` is already relative to page navigation, but the
     * userscript runs at document-start and the difference matters when the
     * question is "what happened before my feature got a turn".
     */
    const BOOT_AT = typeof performance !== 'undefined' ? performance.now() : 0;

    class PerformanceMonitor {
        constructor() {
            this.measurements = new Map();
            this.snapshots = new Map();
            // Named moments on the startup timeline, in the order they happened
            this.marks = [];
            // Work that a snapshot was made of, broken into its parts
            this.spans = new Map();
            this.bootAt = BOOT_AT;
            this.windowMs = WINDOW_MS;
            this.enabled = false;
            this._onVisibilityChange = () => {
                this._tabVisible = !document.hidden;
            };
            this._tabVisible = true;
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', this._onVisibilityChange);
            }
        }

        /**
         * Record a timing measurement
         * @param {string} name - Metric name (e.g. "dom:MarketFilter", "init:tooltipPrices")
         * @param {number} durationMs - Duration in milliseconds
         */
        record(name, durationMs) {
            if (!this.enabled || !this._tabVisible) return;
            if (!this.measurements.has(name)) {
                this.measurements.set(name, []);
            }
            this.measurements.get(name).push({ time: Date.now(), duration: durationMs });
        }

        /**
         * Store a one-time snapshot measurement that persists beyond the rolling window
         *
         * `startedAt` is what makes a startup trace readable: a feature that took six
         * seconds is one fact, and whether it took them at second two or second
         * fourteen is a different one — and only the second says what else was
         * waiting behind it.
         *
         * @param {string} name - Metric name
         * @param {number} durationMs - Duration in milliseconds
         * @param {number} [startedAt] - Milliseconds since boot when it began
         */
        snapshot(name, durationMs, startedAt) {
            this.snapshots.set(name, {
                duration: durationMs,
                time: Date.now(),
                startedAt: startedAt ?? this.sinceBoot() - durationMs,
            });
        }

        /** @returns {number} Milliseconds since the script started */
        sinceBoot() {
            return (typeof performance !== 'undefined' ? performance.now() : 0) - this.bootAt;
        }

        /**
         * Note that something happened, and when.
         *
         * Marks answer the question a list of durations cannot: where did the gaps
         * go. Half of a slow start is usually spent waiting — for IndexedDB, for the
         * game's own data to arrive — and waiting shows up in nobody's duration.
         *
         * @param {string} name - What happened, e.g. `storage:open`
         * @param {Object} [detail] - Anything worth carrying alongside
         */
        mark(name, detail = null) {
            this.marks.push({ name, at: this.sinceBoot(), detail });
        }

        /**
         * Time a part of something already being timed.
         *
         * A feature that takes six seconds is a question, not an answer. Spans are
         * how the answer gets recorded — which call inside it was the six seconds —
         * and they are always on, because the run worth profiling is the one that
         * already happened.
         *
         * @param {string} name - Parent metric, e.g. `init:networth`
         * @param {string} part - What this piece is, e.g. `recalculate`
         * @returns {Function} Call it when the piece is done
         */
        startSpan(name, part) {
            const startedAt = this.sinceBoot();
            return () => {
                const duration = this.sinceBoot() - startedAt;
                if (!this.spans.has(name)) this.spans.set(name, []);
                this.spans.get(name).push({ part, duration, startedAt });
                return duration;
            };
        }

        /**
         * Run a function, recording how long its part took.
         *
         * @param {string} name - Parent metric
         * @param {string} part - What this piece is
         * @param {Function} fn - The work
         * @returns {*} Whatever the work returned
         */
        async span(name, part, fn) {
            const end = this.startSpan(name, part);
            try {
                return await fn();
            } finally {
                end();
            }
        }

        /** @returns {Array<Object>} The parts of one metric, longest first */
        getSpans(name) {
            return [...(this.spans.get(name) || [])].sort((a, b) => b.duration - a.duration);
        }

        /** @returns {Array<Object>} Every mark, in the order they happened */
        getMarks() {
            return [...this.marks].sort((a, b) => a.at - b.at);
        }

        /**
         * Wrap a function with automatic timing
         * @param {string} name - Metric name
         * @param {Function} fn - Function to wrap
         * @returns {Function} Wrapped function
         */
        wrap(name, fn) {
            const monitor = this;
            return function (...args) {
                if (!monitor.enabled || !monitor._tabVisible) return fn.apply(this, args);
                const start = performance.now();
                try {
                    const result = fn.apply(this, args);
                    if (result && typeof result.then === 'function') {
                        return result.finally(() => monitor.record(name, performance.now() - start));
                    }
                    monitor.record(name, performance.now() - start);
                    return result;
                } catch (error) {
                    monitor.record(name, performance.now() - start);
                    throw error;
                }
            };
        }

        /**
         * Get stats for a single metric within the rolling window
         * @param {string} name - Metric name
         * @returns {{ calls: number, totalMs: number, avgMs: number, cpuPercent: number } | null}
         */
        getStats(name) {
            const entries = this.measurements.get(name);
            if (!entries || entries.length === 0) return null;

            const cutoff = Date.now() - this.windowMs;
            let calls = 0;
            let totalMs = 0;

            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].time < cutoff) break;
                calls++;
                totalMs += entries[i].duration;
            }

            if (calls === 0) return null;

            return {
                calls,
                totalMs,
                avgMs: totalMs / calls,
                cpuPercent: Math.min((totalMs / this.windowMs) * 100, 100),
            };
        }

        /**
         * Get stats for all metrics, cleaning up stale data
         * @returns {Map<string, { calls: number, totalMs: number, avgMs: number, cpuPercent: number }>}
         */
        getAllStats() {
            this._cleanup();
            const result = new Map();

            for (const [name, entries] of this.measurements) {
                if (entries.length === 0) continue;
                const stats = this.getStats(name);
                if (stats) {
                    result.set(name, stats);
                }
            }

            return result;
        }

        /**
         * Remove measurements older than the rolling window
         * @private
         */
        _cleanup() {
            const cutoff = Date.now() - this.windowMs;
            for (const [name, entries] of this.measurements) {
                let firstValid = 0;
                while (firstValid < entries.length && entries[firstValid].time < cutoff) {
                    firstValid++;
                }
                if (firstValid > 0) {
                    entries.splice(0, firstValid);
                }
                if (entries.length === 0) {
                    this.measurements.delete(name);
                }
            }
        }

        /**
         * Get all snapshot measurements
         * @returns {Map<string, { duration: number, time: number }>}
         */
        getSnapshots() {
            return new Map(this.snapshots);
        }

        /**
         * Clear all measurements
         */
        reset() {
            this.measurements.clear();
            this.snapshots.clear();
            this.spans.clear();
            // Marks are the startup trace and cannot be taken again without a
            // reload, so resetting the rolling stats leaves them alone
        }
    }

    const performanceMonitor = new PerformanceMonitor();

    var performanceMonitor$1 = /*#__PURE__*/Object.freeze({
        __proto__: null,
        default: performanceMonitor
    });

    /**
     * Item Navigation Utilities
     * Handles Alt+click navigation to crafting/gathering actions or item dictionary
     */


    /**
     * Get game object via React fiber tree traversal
     * @returns {Object|null} Game component instance
     */
    function getGameObject$1() {
        const rootEl = document.getElementById('root');
        const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
        if (!rootFiber) return null;

        function find(fiber) {
            if (!fiber) return null;
            if (fiber.stateNode?.handleGoToMarketplace) return fiber.stateNode;
            return find(fiber.child) || find(fiber.sibling);
        }

        return find(rootFiber);
    }

    /**
     * Find which action produces a given item
     * Prioritizes production actions over gathering actions
     * @param {string} itemHrid - Item HRID to search for
     * @returns {Object|null} { actionHrid, type: 'production'|'gathering' } or null
     */
    function findActionForItem(itemHrid) {
        const gameData = dataManager.getInitClientData();
        if (!gameData?.actionDetailMap) {
            return null;
        }

        const itemSlug = itemHrid.split('/').pop();

        // First pass: Look for production actions (outputItems)
        const productionMatches = [];
        for (const [actionHrid, action] of Object.entries(gameData.actionDetailMap)) {
            if (action.outputItems?.some((item) => item.itemHrid === itemHrid)) {
                productionMatches.push(actionHrid);
            }
        }
        if (productionMatches.length > 0) {
            const exact = productionMatches.find((a) => a.split('/').pop() === itemSlug);
            return { actionHrid: exact || productionMatches[0], type: 'production' };
        }

        // Second pass: Look for gathering actions (dropTable)
        const gatheringMatches = [];
        for (const [actionHrid, action] of Object.entries(gameData.actionDetailMap)) {
            if (action.dropTable?.some((drop) => drop.itemHrid === itemHrid)) {
                gatheringMatches.push(actionHrid);
            }
        }
        if (gatheringMatches.length > 0) {
            const exact = gatheringMatches.find((a) => a.split('/').pop() === itemSlug);
            return { actionHrid: exact || gatheringMatches[0], type: 'gathering' };
        }

        return null;
    }

    /**
     * Open the game's Item Dictionary for an item.
     * @param {string} itemHrid - Item HRID to open
     * @returns {boolean} True if the dictionary was opened
     */
    function openItemDictionary(itemHrid) {
        const game = getGameObject$1();
        if (!game?.handleOpenItemDictionary) {
            return false;
        }
        // Validate HRID exists before passing to game (invalid HRIDs crash renderDescription)
        if (!dataManager.getItemDetails(itemHrid)) {
            return false;
        }
        game.handleOpenItemDictionary(itemHrid);
        return true;
    }

    /**
     * Open the game on an action.
     *
     * The same `handleGoToAction` {@link navigateToItem} already reaches for, exposed
     * on its own for callers that know the action rather than the item — a plan step
     * that says "Train Cheesesmithing 105 → 108 — Griffin Bulwark ★" knows exactly
     * which action it means, and re-deriving it from an item would be a guess.
     *
     * Enhancing has one action (`/actions/enhancing/enhance`), so the enhancing
     * screen is reached the same way rather than through a handler of its own.
     *
     * @param {string} actionHrid - Action HRID, e.g. `/actions/cheesesmithing/griffin_bulwark`
     * @returns {boolean} True if the game was navigated, false if it could not be
     */
    function navigateToAction(actionHrid) {
        if (typeof actionHrid !== 'string' || !actionHrid.startsWith('/actions/')) {
            return false;
        }

        const game = getGameObject$1();
        if (!game?.handleGoToAction) {
            return false;
        }

        game.handleGoToAction(actionHrid);
        return true;
    }

    /**
     * Navigate to the action page for an item, or item dictionary if no action found
     * @param {string} itemHrid - Item HRID to navigate to
     * @returns {boolean} True if navigation was attempted, false if game API unavailable
     */
    function navigateToItem(itemHrid) {
        const game = getGameObject$1();
        if (!game) {
            return false;
        }

        // Try to find action that produces this item
        const actionInfo = findActionForItem(itemHrid);

        if (actionInfo && game.handleGoToAction) {
            // Navigate to the action page
            game.handleGoToAction(actionInfo.actionHrid);
            return true;
        } else if (game.handleOpenItemDictionary) {
            // Validate HRID exists before passing to game (invalid HRIDs crash renderDescription)
            const itemDetails = dataManager.getItemDetails(itemHrid);
            if (!itemDetails) {
                return false;
            }
            game.handleOpenItemDictionary(itemHrid);
            return true;
        }

        return false;
    }

    var itemNavigation = /*#__PURE__*/Object.freeze({
        __proto__: null,
        findActionForItem: findActionForItem,
        navigateToAction: navigateToAction,
        navigateToItem: navigateToItem,
        openItemDictionary: openItemDictionary
    });

    /**
     * Marketplace Custom Tabs Utility
     * Provides shared functionality for creating and managing custom marketplace tabs
     * Used by missing materials features (actions, houses, etc.)
     */


    /**
     * Tabs currently watching their item for acquisition, keyed by the tab element,
     * value is the unsubscribe function returned by `webSocketHook.on('*', …)`.
     * A tab in here is a tab `watchTabForAcquisition` is still tracking; removing it
     * from the map is how every retirement path — auto, manual dismiss, "× All",
     * marketplace close — agrees the watch is over.
     */
    const acquisitionWatchers = new Map();

    /**
     * The "show a ✓ for a moment, then remove the tab" timeout for a tab that just
     * got retired, keyed by tab. Tracked separately from `acquisitionWatchers` so a
     * dismiss that lands during the brief ✓ window can cancel the pending removal
     * and `onRetire` call instead of racing them.
     */
    const pendingRetireTimeouts = new Map();

    /** How long the ✓ badge stays up before the tab is actually removed. */
    const ACQUIRED_BADGE_DELAY_MS = 900;

    /**
     * Create a custom material tab for the marketplace
     * @param {Object} material - Material data object
     * @param {string} material.itemHrid - Item HRID
     * @param {string} material.itemName - Display name for the item
     * @param {number} material.missing - Amount missing (0 if sufficient)
     * @param {number} [material.queued=0] - Amount reserved by queue
     * @param {boolean} material.isTradeable - Whether item can be traded
     * @param {HTMLElement} referenceTab - Tab element to clone structure from
     * @param {Function} onClickCallback - Callback when tab is clicked, receives (e, material)
     * @param {Object} [options] - Optional extras
     * @param {Function} [options.onDismiss] - Called with `material` when the tab's own
     *   dismiss (×) button is used, right before the tab is removed from the DOM. Lets a
     *   caller prune whatever list of its own it is keeping alongside the tab.
     * @returns {HTMLElement} Created tab element
     */
    function createMaterialTab(material, referenceTab, onClickCallback, options = {}) {
        // Clone reference tab structure
        const tab = referenceTab.cloneNode(true);

        // Mark as custom tab for later identification
        tab.setAttribute('data-mwi-custom-tab', 'true');
        tab.setAttribute('data-item-hrid', material.itemHrid);
        tab.setAttribute('data-missing-quantity', material.missing.toString());

        // Color coding:
        // - Red: Missing materials (missing > 0)
        // - Green: Sufficient materials (missing = 0)
        // - Gray: Not tradeable
        let statusColor;
        let statusText;

        if (!material.isTradeable) {
            statusColor = '#888888'; // Gray - not tradeable
            statusText = 'Not Tradeable';
        } else if (material.missing > 0) {
            statusColor = '#ef4444'; // Red - missing materials
            // Show queued amount if any materials are reserved by queue
            const queuedText = material.queued > 0 ? ` (${formatWithSeparator(material.queued)} Q'd)` : '';
            statusText = `Missing: ${formatWithSeparator(material.missing)}${queuedText}`;
        } else {
            statusColor = '#4ade80'; // Green - sufficient materials
            statusText = `Sufficient (${formatWithSeparator(material.required)})`;
        }

        // Update text content
        const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
        if (badgeSpan) {
            // Title case: capitalize first letter of each word
            const titleCaseName = material.itemName
                .split(' ')
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(' ');

            badgeSpan.innerHTML = `
            <div style="text-align: center;">
                <div>${titleCaseName}</div>
                <div style="font-size: 0.75em; color: ${statusColor};">
                    ${statusText}
                </div>
            </div>
        `;
        }

        // Gray out if not tradeable
        if (!material.isTradeable) {
            tab.style.opacity = '0.5';
            tab.style.cursor = 'not-allowed';
        }

        // Remove selected state
        tab.classList.remove('Mui-selected');
        tab.setAttribute('aria-selected', 'false');
        tab.setAttribute('tabindex', '-1');

        // Add click handler
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (!material.isTradeable) {
                // Not tradeable - do nothing
                return;
            }

            // Call the provided callback
            if (onClickCallback) {
                onClickCallback(e, material);
            }
        });

        attachDismissButton(tab, material, options.onDismiss);

        return tab;
    }

    /**
     * Pin a small × in the corner of a tab, visible on hover, that removes just that
     * tab. It never got one, which is why the fix for "I don't want this pinned
     * anymore" was always "wait for the whole strip to be replaced or the
     * marketplace to close" — the only two things that called `removeMaterialTabs`.
     *
     * @param {HTMLElement} tab - Tab element (mutated in place)
     * @param {Object} material - The material this tab represents, handed to `onDismiss`
     * @param {Function} [onDismiss] - Called with `material` right before the tab is removed
     */
    function attachDismissButton(tab, material, onDismiss) {
        // Absolute-positioned inside the tab, so the tab needs to anchor it. MUI tabs
        // are not positioned by default; only take over `position` when nothing else
        // already claimed it.
        if (!tab.style.position) {
            tab.style.position = 'relative';
        }

        const dismissBtn = document.createElement('span');
        dismissBtn.setAttribute('data-mwi-tab-dismiss', 'true');
        dismissBtn.title = 'Remove this tab';
        dismissBtn.textContent = '×';
        dismissBtn.style.cssText = `
        position: absolute;
        top: 1px;
        right: 1px;
        width: 14px;
        height: 14px;
        line-height: 13px;
        text-align: center;
        font-size: 12px;
        font-weight: 700;
        border-radius: 50%;
        color: #ddd;
        background: rgba(0, 0, 0, 0.45);
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.12s ease;
        z-index: 1;
    `;

        tab.addEventListener('mouseenter', () => {
            dismissBtn.style.opacity = '1';
        });
        tab.addEventListener('mouseleave', () => {
            dismissBtn.style.opacity = '0';
        });

        dismissBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            unwatchTabAcquisition(tab);
            if (onDismiss) onDismiss(material);
            tab.remove();
        });

        tab.appendChild(dismissBtn);
    }

    /**
     * Build a small "clear all" control shaped like the other tabs, so it sits in the
     * strip rather than floating above it. Clicking it removes every custom material
     * tab currently pinned (the same set `removeMaterialTabs` clears) — including
     * itself, since it is tagged `data-mwi-custom-tab` too.
     *
     * @param {HTMLElement} referenceTab - Tab element to clone structure from
     * @param {Function} [onClearAll] - Called after the tabs are removed, so a caller
     *   can prune whatever list of its own it was keeping alongside them
     * @returns {HTMLElement} The control element, not yet attached anywhere
     */
    function createClearAllTabsControl(referenceTab, onClearAll) {
        const control = referenceTab.cloneNode(true);

        control.setAttribute('data-mwi-custom-tab', 'true');
        control.setAttribute('data-mwi-clear-all-tab', 'true');
        control.classList.remove('Mui-selected');
        control.setAttribute('aria-selected', 'false');
        control.setAttribute('tabindex', '-1');
        control.title = 'Clear all pinned tabs';
        control.style.opacity = '0.7';
        control.style.flex = '0 0 auto';

        const badgeSpan = control.querySelector('[class*="TabsComponent_badge"]');
        if (badgeSpan) {
            badgeSpan.innerHTML = `
            <div style="text-align: center; font-weight: 700; font-size: 13px;">
                &times; All
            </div>
        `;
        }

        control.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeMaterialTabs();
            if (onClearAll) onClearAll();
        });

        return control;
    }

    /**
     * Append a `createClearAllTabsControl` to `container`, unless one is already
     * there. Kept idempotent so callers can invoke it every time they add tabs
     * without needing to track whether they already have one.
     *
     * @param {HTMLElement} container - The visible tab bar
     * @param {HTMLElement} referenceTab - Tab element to clone structure from
     * @param {Function} [onClearAll] - Forwarded to `createClearAllTabsControl`
     */
    function ensureClearAllTabsControl(container, referenceTab, onClearAll) {
        if (!container || container.querySelector('[data-mwi-clear-all-tab="true"]')) return;
        container.appendChild(createClearAllTabsControl(referenceTab, onClearAll));
    }

    /**
     * The marketplace tab bar you can actually see.
     *
     * There can be more than one. The marketplace opens as a popout over whatever
     * you were doing, and the full marketplace page keeps its own tab bar in the
     * document behind it — so `querySelector` returns whichever comes first, which
     * is frequently the hidden one. Tabs added there are added correctly and are
     * invisible, which is the worst shape a bug can take: nothing appears, and
     * visiting the real marketplace first "fixes" it by making the bar that was
     * already being picked the one on screen.
     *
     * Every candidate is checked and the displayed one wins.
     *
     * @param {string} [contains] - Text a tab must contain, to tell a marketplace bar
     *   from any other tab strip on the page
     * @returns {HTMLElement|null} The visible tab bar
     */
    function visibleTabsContainer(contains = 'My Listings') {
        for (const container of document.querySelectorAll('.MuiTabs-flexContainer[role="tablist"]')) {
            if (contains && !Array.from(container.children).some((tab) => tab.textContent.includes(contains))) continue;

            // `offsetParent` is null under any `display: none` ancestor, which is how
            // the game parks the panel you are not looking at
            if (container.offsetParent === null) continue;
            if (!container.getBoundingClientRect().width) continue;

            return container;
        }
        return null;
    }

    /**
     * Remove all custom material tabs from the marketplace
     */
    function removeMaterialTabs() {
        const customTabs = document.querySelectorAll('[data-mwi-custom-tab="true"]');
        customTabs.forEach((tab) => {
            unwatchTabAcquisition(tab);
            tab.remove();
        });
    }

    /**
     * Remove all shrine-specific material tabs from the marketplace
     */
    function removeShrineMarketTabs() {
        document.querySelectorAll('[data-mwi-shrine-tab="true"]').forEach((tab) => tab.remove());
    }

    /**
     * Update the badge content and quantity attribute on an existing material tab
     * @param {HTMLElement} tab - Tab element created by createMaterialTab
     * @param {Object} material - Updated material data
     * @param {string} material.itemName - Display name
     * @param {number} material.missing - Current missing quantity
     * @param {number} [material.required] - Total required quantity
     * @param {boolean} material.isTradeable - Whether tradeable
     * @param {number} [material.queued] - Queued quantity
     */
    function updateTabBadge(tab, material) {
        const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
        if (!badgeSpan) return;

        let statusColor;
        let statusText;

        if (!material.isTradeable) {
            statusColor = '#888888';
            statusText = 'Not Tradeable';
        } else if (material.missing > 0) {
            statusColor = '#ef4444';
            const queuedText = material.queued > 0 ? ` (${formatWithSeparator(material.queued)} Q'd)` : '';
            statusText = `Missing: ${formatWithSeparator(material.missing)}${queuedText}`;
        } else {
            statusColor = '#4ade80';
            statusText = `Sufficient (${formatWithSeparator(material.required)})`;
        }

        const titleCaseName = material.itemName
            .split(' ')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');

        badgeSpan.innerHTML = `
        <div style="text-align: center;">
            <div>${titleCaseName}</div>
            <div style="font-size: 0.75em; color: ${statusColor};">
                ${statusText}
            </div>
        </div>
    `;

        tab.setAttribute('data-missing-quantity', material.missing.toString());

        if (!material.isTradeable) {
            tab.style.opacity = '0.5';
            tab.style.cursor = 'not-allowed';
        } else {
            tab.style.opacity = '1';
            tab.style.cursor = 'pointer';
        }
    }

    /**
     * Setup marketplace cleanup observer
     * Watches for marketplace panel removal and calls cleanup callback
     * @param {Function} onCleanup - Callback when marketplace closes, receives no args
     * @param {Array} tabsArray - Array reference to track tabs (will be checked for length)
     * @returns {Function} Unregister function to stop observing
     */
    function setupMarketplaceCleanupObserver(onCleanup, tabsArray) {
        let pollInterval = null;

        function poll() {
            if (!tabsArray || tabsArray.length === 0) return;

            // If custom tabs were removed from DOM, clean up
            const hasCustomTabsInDOM = tabsArray.some((tab) => document.body.contains(tab));
            if (!hasCustomTabsInDOM) {
                if (onCleanup) onCleanup();
                return;
            }

            // If marketplace panel is hidden (navigated away), clean up
            const marketplacePanel = document.querySelector('.MarketplacePanel_marketplacePanel__21b7o');
            const subPanelContainer = marketplacePanel?.closest('.MainPanel_subPanelContainer__1i-H9');
            if (subPanelContainer && getComputedStyle(subPanelContainer).display === 'none') {
                if (onCleanup) onCleanup();
            }
        }

        pollInterval = setInterval(poll, 1000);

        return () => {
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        };
    }

    /**
     * Get game object via React fiber
     * @returns {Object|null} Game component instance
     */
    function getGameObject() {
        const rootEl = document.getElementById('root');
        const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
        if (!rootFiber) return null;

        function find(fiber) {
            if (!fiber) return null;
            if (fiber.stateNode?.handleGoToMarketplace) return fiber.stateNode;
            return find(fiber.child) || find(fiber.sibling);
        }

        return find(rootFiber);
    }

    /**
     * Navigate to marketplace for a specific item
     * @param {string} itemHrid - Item HRID to navigate to
     * @param {number} enhancementLevel - Enhancement level (default 0)
     */
    function navigateToMarketplace(itemHrid, enhancementLevel = 0) {
        const game = getGameObject();
        if (game?.handleGoToMarketplace) {
            game.handleGoToMarketplace(itemHrid, enhancementLevel);
        }
        // Silently fail if game API unavailable - feature still provides value without auto-navigation
    }

    /**
     * How many of `itemHrid` at `enhancementLevel` currently sit in inventory.
     *
     * `characterItems` rows carry an `enhancementLevel` field for anything that can
     * be enhanced (0/absent otherwise), the same field `material-calculator.js`
     * checks to tell raw stock apart from a copy the player already improved. That
     * makes an exact match possible here too — a pinned "+5" tab is only retired by
     * a +5 in inventory, not by three +0 copies sitting next to it.
     *
     * The one gap: if a future inventory row ever omitted `enhancementLevel`
     * entirely for an item that actually has one, this would read it as level 0 and
     * could retire a tab against the wrong copy. Nothing observed in
     * `data-manager.js` does that today, so this is a documented risk, not a known bug.
     *
     * @param {string} itemHrid - Item HRID to count
     * @param {number} enhancementLevel - Enhancement level to match exactly (0 for unenhanced)
     * @returns {number} Total count in inventory
     */
    function currentAcquiredCount(itemHrid, enhancementLevel) {
        const inventory = dataManager.getInventory?.() || [];
        return inventory
            .filter((item) => item.itemHrid === itemHrid && (item.enhancementLevel || 0) === (enhancementLevel || 0))
            .reduce((sum, item) => sum + (item.count || 0), 0);
    }

    /**
     * Swap a tab's badge to a brief "✓ Acquired" before it is removed, so retiring
     * a tab reads as "got it" rather than as the tab silently vanishing.
     * @param {HTMLElement} tab - Tab element
     * @param {string} itemName - Display name to keep on the badge
     */
    function showAcquiredBadge(tab, itemName) {
        const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
        if (badgeSpan) {
            badgeSpan.innerHTML = `
            <div style="text-align: center;">
                <div>${itemName}</div>
                <div style="font-size: 0.75em; color: #4ade80;">
                    ✓ Acquired
                </div>
            </div>
        `;
        }
        tab.style.opacity = '1';
        tab.style.cursor = 'default';
    }

    /**
     * Stop watching a tab for acquisition: cancel any pending retirement and drop
     * the websocket subscription. Safe to call on a tab that was never watched.
     *
     * Called automatically by `removeMaterialTabs` and the per-tab dismiss (×)
     * button, so callers of `watchTabForAcquisition` do not need to remember to
     * unwind it themselves on every removal path — only on paths that bypass both
     * (there are none in this module).
     *
     * @param {HTMLElement} tab - Tab element
     */
    function unwatchTabAcquisition(tab) {
        const pendingTimeout = pendingRetireTimeouts.get(tab);
        if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingRetireTimeouts.delete(tab);
        }

        const unsubscribe = acquisitionWatchers.get(tab);
        if (unsubscribe) {
            unsubscribe();
            acquisitionWatchers.delete(tab);
        }
    }

    /**
     * Auto-retire a pinned material tab once its item shows up in inventory.
     *
     * Reuses the exact mechanism `missing-materials-button.js` already uses to
     * notice inventory changes — a `webSocketHook.on('*', …)` listener filtered to
     * messages shaped like an inventory update (`type` containing "item",
     * "inventory", or "market", or a top-level `inventory`/`characterItems` field).
     * That filter is intentionally identical to the one in `missing-materials-button.js`
     * rather than a second guess at which message types matter — see that file's
     * `setupInventoryListener` for the original.
     *
     * @param {HTMLElement} tab - Tab element, e.g. one made by `createMaterialTab`
     * @param {Object} options
     * @param {string} options.itemHrid - Item HRID to watch for
     * @param {number} [options.enhancementLevel=0] - Enhancement level to match exactly
     *   (see `currentAcquiredCount` for how/when that match is exact)
     * @param {number} [options.requiredCount=1] - Quantity that counts as "acquired"
     * @param {string} [options.itemName] - Display name for badge updates; falls back to
     *   the game's item name lookup, then to the HRID's last path segment
     * @param {Function} [options.onRetire] - Called with `tab` right after it is removed
     *   from the DOM because the item was acquired. Not called on manual dismiss,
     *   "× All", or marketplace close — those retire the watch without this callback.
     * @returns {Function} Unwatch function. Also invoked automatically by the tab's own
     *   dismiss button, `removeMaterialTabs`, and therefore marketplace-close cleanup
     *   (both of which route through `removeMaterialTabs`).
     */
    function watchTabForAcquisition(tab, options) {
        const noop = () => {};
        if (!tab || !options?.itemHrid) return noop;

        const { itemHrid, enhancementLevel = 0, requiredCount = 1, onRetire } = options;

        // Re-registering (e.g. the same tab watched twice) replaces the old watch
        // rather than stacking a second subscription on top of it.
        unwatchTabAcquisition(tab);

        const itemName =
            options.itemName || dataManager.getItemDetails?.(itemHrid)?.name || itemHrid.split('/').pop() || itemHrid;

        const retire = () => {
            showAcquiredBadge(tab, itemName);
            // Stop listening immediately — only the DOM removal + onRetire are delayed,
            // so a second inventory event during the ✓ window can't retire it twice.
            const unsubscribe = acquisitionWatchers.get(tab);
            if (unsubscribe) {
                unsubscribe();
                acquisitionWatchers.delete(tab);
            }

            const retireTimeout = setTimeout(() => {
                pendingRetireTimeouts.delete(tab);
                tab.remove();
                if (onRetire) onRetire(tab);
            }, ACQUIRED_BADGE_DELAY_MS);
            pendingRetireTimeouts.set(tab, retireTimeout);
        };

        const check = () => {
            const acquired = currentAcquiredCount(itemHrid, enhancementLevel);
            if (acquired >= requiredCount) {
                retire();
            } else {
                updateTabBadge(tab, {
                    itemName,
                    missing: requiredCount - acquired,
                    required: requiredCount,
                    isTradeable: true,
                    queued: 0,
                });
            }
        };

        const handler = (data) => {
            if (
                data.type?.includes('item') ||
                data.type?.includes('inventory') ||
                data.type?.includes('market') ||
                data.inventory ||
                data.characterItems
            ) {
                check();
            }
        };

        webSocketHook.on('*', handler);
        acquisitionWatchers.set(tab, () => webSocketHook.off('*', handler));

        // Cover the case where the item was already sitting in inventory before
        // this tab started watching (e.g. a stale plan reopened after buying).
        check();

        return () => unwatchTabAcquisition(tab);
    }

    var marketplaceTabs = /*#__PURE__*/Object.freeze({
        __proto__: null,
        createClearAllTabsControl: createClearAllTabsControl,
        createMaterialTab: createMaterialTab,
        ensureClearAllTabsControl: ensureClearAllTabsControl,
        navigateToMarketplace: navigateToMarketplace,
        removeMaterialTabs: removeMaterialTabs,
        removeShrineMarketTabs: removeShrineMarketTabs,
        setupMarketplaceCleanupObserver: setupMarketplaceCleanupObserver,
        updateTabBadge: updateTabBadge,
        visibleTabsContainer: visibleTabsContainer,
        watchTabForAcquisition: watchTabForAcquisition
    });

    /**
     * Marketplace Buy Modal Autofill Utility
     * Provides shared functionality for auto-filling quantity in marketplace buy modals
     * Used by missing materials features (actions, houses, etc.)
     */


    /**
     * Find the quantity input in the buy modal
     * For equipment items, there are multiple number inputs (enhancement level + quantity)
     * We need to find the correct one by checking parent containers for label text
     * @param {HTMLElement} modal - Modal container element
     * @returns {HTMLInputElement|null} Quantity input element or null
     */
    function findQuantityInput(modal) {
        // Get all number inputs in the modal
        const allInputs = Array.from(modal.querySelectorAll('input[type="number"]'));

        if (allInputs.length === 0) {
            return null;
        }

        if (allInputs.length === 1) {
            // Only one input - must be quantity
            return allInputs[0];
        }

        // Multiple inputs - identify by checking CLOSEST parent first
        // Strategy 1: Check each parent level individually, prioritizing closer parents
        // This prevents matching on the outermost container that has all text
        for (let level = 0; level < 4; level++) {
            for (let i = 0; i < allInputs.length; i++) {
                const input = allInputs[i];
                let parent = input.parentElement;

                // Navigate to the specific level
                for (let j = 0; j < level && parent; j++) {
                    parent = parent.parentElement;
                }

                if (!parent) continue;

                const text = parent.textContent;

                // At this specific level, check if it contains "Quantity" but NOT "Enhancement Level"
                if (text.includes('Quantity') && !text.includes('Enhancement Level')) {
                    return input;
                }
            }
        }

        // Strategy 2: Exclude inputs that have "Enhancement Level" in close parents (level 0-2)
        for (let i = 0; i < allInputs.length; i++) {
            const input = allInputs[i];
            let parent = input.parentElement;
            let isEnhancementInput = false;

            // Check only the first 3 levels (not the outermost container)
            for (let j = 0; j < 3 && parent; j++) {
                const text = parent.textContent;

                if (text.includes('Enhancement Level') && !text.includes('Quantity')) {
                    isEnhancementInput = true;
                    break;
                }

                parent = parent.parentElement;
            }

            if (!isEnhancementInput) {
                return input;
            }
        }

        // Fallback: Return first input and log warning
        console.warn('[MarketplaceAutofill] Could not definitively identify quantity input, using first input');
        return allInputs[0];
    }

    /**
     * Handle buy modal appearance and auto-fill quantity if available
     * @param {HTMLElement} modal - Modal container element
     * @param {number|null} activeQuantity - Static quantity to auto-fill (null if using pending fn)
     * @param {Function|null} pendingCalculation - Lazy fn that returns current quantity (takes priority)
     */
    function handleBuyModal(modal, activeQuantity, pendingCalculation) {
        // Resolve quantity: prefer lazy recalculation over stored static value
        const quantity = pendingCalculation ? pendingCalculation() : activeQuantity;

        // Check if we have a quantity to fill
        if (!quantity || quantity <= 0) {
            return;
        }

        // Check if this is a "Buy Now" modal
        const header = modal.querySelector('div[class*="MarketplacePanel_header"]');
        if (!header) {
            return;
        }

        const headerText = header.textContent.trim();
        if (!headerText.includes('Buy Now') && !headerText.includes('Buy Listing')) {
            return;
        }

        // Find the quantity input - need to be specific to avoid enhancement level input
        const quantityInput = findQuantityInput(modal);
        if (!quantityInput) {
            return;
        }

        // Set the quantity value
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(quantityInput, quantity.toString());

        // Trigger input event to notify React
        const inputEvent = new Event('input', { bubbles: true });
        quantityInput.dispatchEvent(inputEvent);
    }

    /**
     * Create an autofill manager instance
     * Manages storing quantity to autofill and observing buy modals
     * @param {string} observerId - Unique ID for this observer (e.g., 'MissingMats-Actions')
     * @returns {Object} Autofill manager with methods: setQuantity, setPendingCalculation, clearQuantity, initialize, cleanup
     */
    function createAutofillManager(observerId) {
        let activeQuantity = null;
        let pendingCalculation = null;
        let observerUnregister = null;

        return {
            /**
             * Set a static quantity to auto-fill in the next buy modal
             * @param {number} quantity - Quantity to auto-fill
             */
            setQuantity(quantity) {
                activeQuantity = quantity;
                pendingCalculation = null;
            },

            /**
             * Set a lazy calculation function that is called each time a buy modal opens.
             * Takes priority over setQuantity — quantity is recomputed fresh on every modal open,
             * so subsequent purchases within the same session always autofill the remaining needed amount.
             * @param {Function} fn - Function returning the current quantity to fill
             */
            setPendingCalculation(fn) {
                pendingCalculation = fn;
                activeQuantity = null;
            },

            /**
             * Clear the stored quantity (cancel autofill)
             */
            clearQuantity() {
                activeQuantity = null;
                pendingCalculation = null;
            },

            /**
             * Get the current active quantity
             * @returns {number|null} Current quantity or null
             */
            getQuantity() {
                return pendingCalculation ? pendingCalculation() : activeQuantity;
            },

            /**
             * Initialize buy modal observer
             * Sets up watching for buy modals to appear and auto-fills them
             *
             * Idempotent. Callers reach for this defensively — the shopping list ran
             * `autofill.initialize?.()` on every open — and each call used to register
             * a second observer while dropping the previous unregister on the floor,
             * so the handler could never be taken away again. One live observer per
             * manager is all this needs: the quantity it fills is read fresh from the
             * closure every time, so a re-registered handler was not doing anything
             * the first one was not already doing.
             *
             * @returns {Function} The unregister function for the live observer
             */
            initialize() {
                if (observerUnregister) return observerUnregister;

                observerUnregister = domObserver.onClass(observerId, 'Modal_modalContainer', (modal) => {
                    handleBuyModal(modal, activeQuantity, pendingCalculation);
                    // Clear static quantity after use (one-shot) — pendingCalculation persists intentionally
                    if (activeQuantity !== null && !pendingCalculation) {
                        activeQuantity = null;
                    }
                });
                return observerUnregister;
            },

            /**
             * Cleanup observer
             * Stops watching for buy modals and clears quantity
             */
            cleanup() {
                if (observerUnregister) {
                    observerUnregister();
                    observerUnregister = null;
                }
                activeQuantity = null;
                pendingCalculation = null;
            },
        };
    }

    var marketplaceAutofill = /*#__PURE__*/Object.freeze({
        __proto__: null,
        createAutofillManager: createAutofillManager
    });

    /**
     * Shopping list
     *
     * A whole restock, as marketplace tabs.
     *
     * The Buy figure on a panel row sends one item to the marketplace, which is the
     * right gesture for topping up one thing. Restocking for a week is not that
     * gesture — it is six items, and doing it a row at a time means six trips back
     * to a panel that is behind the marketplace you are standing in.
     *
     * So the whole shortfall goes across at once, as the same "Missing: N" tabs the
     * missing-materials features put there. Each tab opens its item with the
     * quantity already filled in, and the row of tabs is the list: what is left to
     * buy is what is still red.
     *
     * ## Why this lives in utils rather than beside the panel that first wanted it
     *
     * It was `features/ui/consumables-shopping-list.js`, and then the goal planner
     * wanted the same hand-off. The planner is in the **actions** bundle and the
     * consumables panel is in the **ui** bundle, so rollup gave each of them its own
     * copy — and with it, its own `tabs` and `watchTimer`. Two lists opened inside
     * the six-second watch window then fought over the same tab bar: each copy's
     * interval saw tabs it had not built, tore them down and put its own back.
     *
     * The state below is module-level on purpose — there is one marketplace tab bar,
     * so there should be one list watching it. That is only true if there is one
     * module, which is what `Toolasha.Utils.shoppingList` in `rollup.config.js`
     * buys. The old path re-exports from here so nothing had to move to get it.
     *
     * ## There is more than one marketplace
     *
     * It opens as a popout over whatever you were doing, and the full marketplace
     * page keeps its own tab bar in the document behind it — so the tabs have to go
     * on the one being displayed rather than the one that comes first.
     * `visibleTabsContainer` handles that, and every feature that adds marketplace
     * tabs now goes through it.
     *
     * ## Reusing the missing-materials machinery
     *
     * Nothing here is new. `createMaterialTab` draws them, `createAutofillManager`
     * fills the quantity in, and `setupMarketplaceCleanupObserver` takes them away
     * when you leave — the same three pieces, given a different list. Which is the
     * point: a second implementation of marketplace tabs would be a second set of
     * bugs about where the game moved its tab bar.
     */


    /**
     * How long to keep putting the tabs back.
     *
     * Not just how long to wait for the tab bar — the bar is frequently already
     * there from a previous visit, so the tabs go in immediately and are then wiped
     * when React re-renders the marketplace for the item being navigated to. So the
     * check keeps running for a few seconds and re-adds them whenever they have
     * gone, which survives however many times the panel rebuilds itself.
     */
    const WATCH_MS = 6000;
    const WATCH_INTERVAL_MS = 150;

    const autofill = createAutofillManager('Shopping-List');
    let tabs = [];
    let cleanupObserver = null;
    let watchTimer = null;
    let heading = '';

    /**
     * Put a shopping list on the marketplace and go there.
     *
     * @param {Array<{itemHrid: string, name: string, count: number}>} items - What to buy
     * @param {Object} [options] - Options
     * @param {string} [options.heading] - What the row of tabs calls itself. The default counts
     *   the items; a caller whose counts are an estimate rather than a bill should say so here,
     *   because the marketplace is where somebody decides how many to actually buy.
     */
    function openShoppingList(items, { heading: headingText = '' } = {}) {
        const wanted = (items || []).filter((item) => item.itemHrid && item.count > 0);
        if (!wanted.length) return;

        // Idempotent since the observer leak was fixed: this used to register a
        // fresh DOM observer on every open and drop the previous unregister
        autofill.initialize?.();
        heading = headingText;

        // The first item opens the marketplace, and the tabs are put in behind it
        navigateToMarketplace(wanted[0].itemHrid, 0);
        autofill.setQuantity(wanted[0].count);
        watchForTabBar(wanted);
    }

    /** Take the tabs away, and stop watching for the marketplace to close */
    function clearShoppingList() {
        clearInterval(watchTimer);
        watchTimer = null;
        removeMaterialTabs();
        tabs = [];
        cleanupObserver?.();
        cleanupObserver = null;
        autofill.clearQuantity?.();
    }

    /**
     * Keep the tabs on the marketplace while it settles.
     *
     * React rebuilds the marketplace panel when it navigates to an item, and a tab
     * added a moment before that rebuild is gone a moment after it — which is why
     * adding them once, immediately, put them nowhere. This re-adds them whenever
     * they are missing, for long enough to outlast the rebuilds.
     *
     * @param {Array<Object>} items - What to buy
     */
    function watchForTabBar(items) {
        clearInterval(watchTimer);
        const until = Date.now() + WATCH_MS;

        watchTimer = setInterval(() => {
            const container = visibleTabsContainer();
            const reference =
                container && Array.from(container.children).find((tab) => tab.textContent.includes('My Listings'));

            // Judged on the item tabs rather than on having run: the heading alone
            // is what a failed build leaves behind, and counting that as success is
            // what let one bad attempt stand until something else rebuilt the bar
            const built = tabs.filter((tab) => tab.hasAttribute('data-item-hrid'));
            const present = built.length === items.length && built.every((tab) => document.body.contains(tab));
            if (reference && !present) addTabs(container, reference, items);

            if (Date.now() > until) {
                clearInterval(watchTimer);
                watchTimer = null;
            }
        }, WATCH_INTERVAL_MS);
    }

    /**
     * @param {HTMLElement} container - The game's tab bar
     * @param {HTMLElement} reference - A tab to clone the structure from
     * @param {Array<Object>} items - What to buy
     */
    function addTabs(container, reference, items) {
        removeMaterialTabs();
        tabs = [];

        // Several tabs will not fit on one line, and the game's bar does not wrap
        // on its own
        container.style.flexWrap = 'wrap';

        const title = document.createElement('div');
        // Marked as one of ours, or `removeMaterialTabs` leaves it behind and every
        // re-add stacks another heading beside the last
        title.setAttribute('data-mwi-custom-tab', 'true');
        title.textContent = heading || `Restock: ${items.length} item${items.length === 1 ? '' : 's'}`;
        Object.assign(title.style, {
            alignSelf: 'center',
            padding: '0 10px',
            color: '#7fd6a3',
            fontWeight: 'bold',
            fontSize: '1.2rem',
        });
        container.appendChild(title);
        tabs.push(title);

        for (const item of items) {
            // `itemName` rather than `name`: the tab helper reads that field, and
            // passing the wrong one threw on the first item, leaving the heading
            // standing alone above no tabs at all
            try {
                const tab = createMaterialTab(
                    {
                        itemHrid: item.itemHrid,
                        itemName: item.name,
                        missing: item.count,
                        required: item.count,
                        isTradeable: true,
                    },
                    reference,
                    handlerFor(item)
                );
                container.appendChild(tab);
                tabs.push(tab);
            } catch (error) {
                // One unbuildable tab must not cost the rest of the list. Logged
                // rather than swallowed, because a list that silently arrives short
                // is indistinguishable from one that had nothing to add.
                console.error(`[ShoppingList] Could not build a tab for ${item.itemHrid}:`, error);
            }
        }

        cleanupObserver?.();
        cleanupObserver = setupMarketplaceCleanupObserver(clearShoppingList, tabs);
    }

    /**
     * The click handler for one tab.
     *
     * Built outside the loop so the item it closes over is the tab's own, rather
     * than whichever the loop finished on.
     *
     * @param {Object} item - What that tab buys
     * @returns {Function}
     */
    function handlerFor(item) {
        return () => {
            autofill.setQuantity(item.count);
            navigateToMarketplace(item.itemHrid, 0);
        };
    }

    var shoppingList = /*#__PURE__*/Object.freeze({
        __proto__: null,
        clearShoppingList: clearShoppingList,
        openShoppingList: openShoppingList
    });

    /**
     * Scroll Buff Values
     * Hardcoded buff definitions for Labyrinth scrolls (formerly "Seals").
     * The game JSON has no consumableDetail for scroll items — values sourced from item descriptions.
     */

    const SCROLL_BUFF_VALUES = {
        '/buff_types/efficiency': 0.14,
        '/buff_types/gathering': 0.18,
        '/buff_types/wisdom': 0.2,
        '/buff_types/action_speed': 0.15,
        '/buff_types/rare_find': 0.6,
        '/buff_types/processing': 0.2,
        '/buff_types/gourmet': 0.16,
    };

    const SCROLL_BUFF_ITEMS = {
        '/buff_types/efficiency': 'seal_of_efficiency',
        '/buff_types/gathering': 'seal_of_gathering',
        '/buff_types/wisdom': 'seal_of_wisdom',
        '/buff_types/action_speed': 'seal_of_action_speed',
        '/buff_types/rare_find': 'seal_of_rare_find',
        '/buff_types/processing': 'seal_of_processing',
        '/buff_types/gourmet': 'seal_of_gourmet',
    };

    const SCROLL_BUFF_LABELS = {
        '/buff_types/efficiency': 'Scroll of Efficiency (+14%)',
        '/buff_types/gathering': 'Scroll of Gathering (+18%)',
        '/buff_types/wisdom': 'Scroll of Wisdom (+20%)',
        '/buff_types/action_speed': 'Scroll of Action Speed (+15%)',
        '/buff_types/rare_find': 'Scroll of Rare Find (+60%)',
        '/buff_types/processing': 'Scroll of Processing (+20%)',
        '/buff_types/gourmet': 'Scroll of Gourmet (+16%)',
    };

    var scrollBuffValues = /*#__PURE__*/Object.freeze({
        __proto__: null,
        SCROLL_BUFF_ITEMS: SCROLL_BUFF_ITEMS,
        SCROLL_BUFF_LABELS: SCROLL_BUFF_LABELS,
        SCROLL_BUFF_VALUES: SCROLL_BUFF_VALUES
    });

    /**
     * One toast, for the whole script.
     *
     * Two of these already existed and neither could be reused: the combat
     * simulator's is parented to its own panel, so it vanishes with the panel and
     * cannot say anything about the panel failing to open; the dungeon tracker's is
     * centred, modal-looking and `pointer-events: none`, so it cannot carry a
     * button and blocks nothing while it sits over the middle of the game.
     *
     * What is taken from each: the tracker's fade-and-remove lifetime and its use of
     * a real z-index constant rather than a guessed number, and the simulator's
     * per-kind colouring. What is added is the part both lack — a stack, so a second
     * message does not overwrite the first, a dismiss control, and an optional
     * action, because "N features failed to start" is only useful if you can get
     * from it to which ones.
     *
     * It sits one above `PANEL_Z_CAP` so it is over every floating panel, and still
     * under the game's own MUI modal layer (~1300) so it never covers a dialog the
     * player is trying to answer.
     */


    /** The stack's container, looked up by id so a stale copy is never orphaned */
    const TOAST_CONTAINER_ID = 'toolasha-toasts';

    /** Beyond this the oldest is dropped — a stack taller than this is noise */
    const MAX_TOASTS = 4;

    /** How long the fade before an expiring toast is removed */
    const FADE_MS = 180;

    /** Default lifetime; `duration: 0` means it stays until dismissed */
    const DEFAULT_DURATION_MS = 6000;

    const KINDS = {
        info: { border: 'rgba(74, 158, 255, 0.75)', background: 'rgba(12, 22, 38, 0.97)', text: '#cfe6ff' },
        warn: { border: 'rgba(255, 152, 0, 0.75)', background: 'rgba(30, 22, 10, 0.97)', text: '#ffcc80' },
        error: { border: 'rgba(255, 82, 82, 0.8)', background: 'rgba(36, 14, 14, 0.97)', text: '#ff9e9e' },
    };

    /** Live toasts, oldest first */
    const active = [];

    /**
     * The stack container, created on first use.
     * @returns {HTMLElement} The container element
     */
    function getContainer() {
        const existing = document.getElementById(TOAST_CONTAINER_ID);
        if (existing) return existing;

        const container = document.createElement('div');
        container.id = TOAST_CONTAINER_ID;
        Object.assign(container.style, {
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: '8px',
            // The container spans a column of empty space most of the time; only
            // the toasts themselves may take clicks
            pointerEvents: 'none',
            maxWidth: 'min(420px, 92vw)',
            zIndex: String(PANEL_Z_CAP + 1),
        });
        document.body.appendChild(container);
        return container;
    }

    /**
     * Drop a toast from the stack.
     * @param {Object} entry - Internal toast record
     * @param {boolean} animate - Fade it out rather than removing it at once
     */
    function remove(entry, animate) {
        const index = active.indexOf(entry);
        if (index === -1) return;
        active.splice(index, 1);

        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }

        if (!animate) {
            entry.element.remove();
            pruneContainer();
            return;
        }

        entry.element.style.transition = `opacity ${FADE_MS}ms ease`;
        entry.element.style.opacity = '0';
        setTimeout(() => {
            entry.element.remove();
            pruneContainer();
        }, FADE_MS);
    }

    /** Take the container away once nothing is in it, so it cannot swallow clicks */
    function pruneContainer() {
        const container = document.getElementById(TOAST_CONTAINER_ID);
        if (container && container.childElementCount === 0) container.remove();
    }

    /**
     * Show a message that does not stop what the player is doing.
     *
     * @param {string} message - What to say. Plain text; never HTML
     * @param {Object} [options] - Options
     * @param {'info'|'warn'|'error'} [options.kind='info'] - Colouring and urgency
     * @param {number} [options.duration] - Lifetime in ms; `0` stays until dismissed
     * @param {{label: string, onClick: Function}} [options.action] - Optional follow-up.
     *   The whole toast becomes clickable when this is given, because a small button
     *   is a poor target and the message itself is the obvious thing to press
     * @returns {{element: HTMLElement, dismiss: Function}|null} Handle, or null with no DOM
     */
    function showToast(message, { kind = 'info', duration, action } = {}) {
        if (typeof document === 'undefined' || !document.body) return null;

        const palette = KINDS[kind] || KINDS.info;
        const lifetime = duration === undefined ? DEFAULT_DURATION_MS : duration;

        const element = document.createElement('div');
        element.className = `toolasha-toast toolasha-toast-${kind}`;
        element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        element.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
        Object.assign(element.style, {
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            background: palette.background,
            border: `1px solid ${palette.border}`,
            borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
            padding: '10px 12px',
            color: palette.text,
            fontFamily: "'Segoe UI', sans-serif",
            fontSize: '13px',
            lineHeight: '1.35',
            maxWidth: '100%',
        });

        const body = document.createElement('div');
        body.style.flex = '1';

        const text = document.createElement('div');
        text.textContent = message;
        body.appendChild(text);

        const entry = { element, timer: null };

        if (action && typeof action.onClick === 'function') {
            const hint = document.createElement('div');
            hint.className = 'toolasha-toast-action';
            hint.textContent = action.label || 'Details';
            Object.assign(hint.style, {
                marginTop: '4px',
                fontWeight: '600',
                textDecoration: 'underline',
                fontSize: '12px',
            });
            body.appendChild(hint);

            element.style.cursor = 'pointer';
            element.addEventListener('click', (event) => {
                // The ✕ is inside the toast and must not also trigger the action
                if (event.target.closest('.toolasha-toast-dismiss')) return;
                try {
                    action.onClick();
                } catch (error) {
                    console.error('[Toast] Action failed:', error);
                }
                remove(entry, false);
            });
        }

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'toolasha-toast-dismiss';
        dismissBtn.type = 'button';
        dismissBtn.textContent = '✕';
        dismissBtn.title = 'Dismiss';
        dismissBtn.setAttribute('aria-label', 'Dismiss');
        Object.assign(dismissBtn.style, {
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: '12px',
            lineHeight: '1',
            opacity: '0.7',
            padding: '2px 4px',
        });
        dismissBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            remove(entry, false);
        });

        element.appendChild(body);
        element.appendChild(dismissBtn);

        getContainer().appendChild(element);
        active.push(entry);

        // Oldest first, so a burst of failures still leaves the newest readable
        while (active.length > MAX_TOASTS) {
            remove(active[0], false);
        }

        if (lifetime > 0) {
            entry.timer = setTimeout(() => remove(entry, true), lifetime);
        }

        return { element, dismiss: () => remove(entry, false) };
    }

    /**
     * Clear the stack — used on teardown, and by tests.
     */
    function dismissAllToasts() {
        while (active.length) {
            remove(active[0], false);
        }
        pruneContainer();
    }

    /**
     * How many toasts are up. Exported for tests rather than for callers.
     * @returns {number} Live toast count
     */
    function activeToastCount() {
        return active.length;
    }

    var toast = /*#__PURE__*/Object.freeze({
        __proto__: null,
        TOAST_CONTAINER_ID: TOAST_CONTAINER_ID,
        activeToastCount: activeToastCount,
        dismissAllToasts: dismissAllToasts,
        showToast: showToast
    });

    /**
     * Foundation Utils Library
     * All utility modules
     *
     * Exports to: window.Toolasha.Utils
     */


    // Export to global namespace
    const toolashaRoot = window.Toolasha || {};
    window.Toolasha = toolashaRoot;

    if (typeof unsafeWindow !== 'undefined') {
        unsafeWindow.Toolasha = toolashaRoot;
    }

    toolashaRoot.Utils = {
        formatters,
        efficiency: efficiency$1,
        profitHelpers: profitHelpers$1,
        profitConstants: profitConstants$1,
        dom: dom$1,
        mobile,
        domObserverHelpers,
        timerRegistry,
        bonusRevenueCalculator,
        enhancementMultipliers,
        experienceParser: experienceParser$1,
        marketListings,
        actionCalculator,
        actionPanelHelper,
        teaParser: teaParser$1,
        buffParser,
        selectors,
        houseEfficiency: houseEfficiency$1,
        experienceCalculator: experienceCalculator$1,
        marketData: marketData$1,
        abilityCalc,
        equipmentParser,
        uiComponents: uiComponents$1,
        enhancementConfig,
        enhancementGearDetector,
        reactInput,
        materialCalculator,
        tokenValuation,
        pricingHelper,
        cleanupRegistry,
        houseCostCalculator,
        enhancementCalculator,
        overlayRows,
        overlayLayout,
        overlayFormat,
        orderBook,
        combatLevel: combatLevel$1,
        opanelConfig,
        skillProgress,
        skillHistory,
        abilityBooks,
        damageAttribution,
        panelGeometry,
        choiceDialog,
        simplePanel,
        consumableTarget,
        dropLuck,
        complexFft,
        combatDropModel,
        spawnExpectation,
        chestTally,
        floatingPanel,
        workerPool: workerPool$3,
        evWorkerManager,
        enhancementWorkerManager,
        networthWorkerManager,
        panelZIndex,
        performanceMonitor: performanceMonitor$1,
        gameLookups,
        itemNavigation,
        marketplaceTabs,
        marketplaceAutofill,
        shoppingList,
        scrollBuffValues,
        toast,
    };

    console.log('[Toolasha] Utils library loaded');

})(Toolasha.Core.config, Toolasha.Core.dataManager, Toolasha.Core.webSocketHook, Toolasha.Core.storage, Toolasha.Core.marketAPI, Toolasha.Core.domObserver);
