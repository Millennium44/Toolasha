/**
 * Shared, read-only filtering and ordering for the three alchemy history panes.
 * Viewer-owned profit caches and pagination remain with their viewers.
 */

/**
 * Return sessions matching the active date, item, and optional result-name filters.
 * Date bounds use local calendar days. The upper bound includes its whole day.
 *
 * @param {Array<Object>} sessions - Unfiltered history, in its original order
 * @param {Object} filters - Date bounds, selected input items, and optional resultsSearch
 * @param {Function} [getItemName] - Enables result-name search when supplied; coinify has none
 * @returns {Array<Object>} A new array retaining the original session objects
 */
export function filterAlchemyHistorySessions(sessions, filters, getItemName) {
    const hasDateFilter = !!(filters.dateFrom || filters.dateTo);
    let dateToEndOfDay = null;
    if (hasDateFilter && filters.dateTo) {
        dateToEndOfDay = new Date(filters.dateTo);
        dateToEndOfDay.setHours(23, 59, 59, 999);
    }

    const hasItemFilter = filters.selectedInputItems.length > 0;
    const itemFilterSet = hasItemFilter ? new Set(filters.selectedInputItems) : null;
    const resultsSearch = getItemName ? filters.resultsSearch.trim().toLowerCase() : '';

    return sessions.filter((session) => {
        if (hasDateFilter) {
            const date = new Date(session.startTime);
            if (filters.dateFrom && date < filters.dateFrom) return false;
            if (dateToEndOfDay && date > dateToEndOfDay) return false;
        }
        if (hasItemFilter && !itemFilterSet.has(session.inputItemHrid)) return false;
        if (resultsSearch) {
            const names = Object.keys(session.results || {}).map((hrid) => getItemName(hrid).toLowerCase());
            if (!names.some((name) => name.includes(resultsSearch))) return false;
        }
        return true;
    });
}

/**
 * Return a sorted copy without changing source history or cached profit records.
 *
 * @param {Array<Object>} sessions - Filtered sessions
 * @param {Object} options - Viewer sort state and read-only lookup dependencies
 * @param {string} options.sortColumn - Session property or the derived _profit column
 * @param {string} options.sortDirection - asc or desc
 * @param {Function} options.getItemName - Displayed item name lookup
 * @param {Map} options.profitCache - Already computed per-session profit records
 * @returns {Array<Object>} A new, stably ordered array
 */
export function sortAlchemyHistorySessions(sessions, { sortColumn, sortDirection, getItemName, profitCache }) {
    return [...sessions].sort((a, b) => {
        let aVal = a[sortColumn] ?? 0;
        let bVal = b[sortColumn] ?? 0;
        if (sortColumn === 'inputItemHrid') {
            aVal = getItemName(String(aVal));
            bVal = getItemName(String(bVal));
        } else if (sortColumn === '_profit') {
            aVal = profitCache.get(a.id)?.profit ?? 0;
            bVal = profitCache.get(b.id)?.profit ?? 0;
        }
        const cmp = typeof aVal === 'string' ? aVal.localeCompare(String(bVal)) : aVal - bVal;
        return sortDirection === 'asc' ? cmp : -cmp;
    });
}
