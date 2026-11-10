/** Searchable, always-open Equipment Watch choices with the game's own item artwork. */
import { addStyles } from '../../utils/dom.js';
import { itemIcon } from '../../utils/overlay-format.js';

const CLASS_NAME = 'toolasha-equipment-item-picker';
const CSS = `
    .${CLASS_NAME} { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .${CLASS_NAME} input, .${CLASS_NAME} [role="listbox"] {
        box-sizing: border-box; width: 100%; min-width: 0;
        background: rgba(0, 0, 0, 0.35); color: #e8ecf5;
        border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 3px; font: inherit;
    }
    .${CLASS_NAME} input { padding: 5px 7px; }
    .${CLASS_NAME} [role="listbox"] { height: 240px; overflow: auto; padding: 2px; }
    .${CLASS_NAME} [role="option"] {
        display: flex; align-items: center; gap: 6px; min-height: 24px;
        padding: 3px 6px; cursor: pointer; overflow-wrap: anywhere;
    }
    .${CLASS_NAME} [role="option"]:hover { background: rgba(100, 149, 237, 0.15); }
    .${CLASS_NAME} [aria-selected="true"] { background: rgba(100, 149, 237, 0.3); font-weight: bold; }
    .${CLASS_NAME} [data-active="true"] { outline: 1px solid #9ec4ff; outline-offset: -1px; }
    .${CLASS_NAME} input:focus-visible, .${CLASS_NAME} [role="listbox"]:focus-visible {
        outline: 2px solid #9ec4ff; outline-offset: 1px;
    }
    @media (forced-colors: active) {
        .${CLASS_NAME} [aria-selected="true"] { background: Highlight; color: HighlightText; }
        .${CLASS_NAME} [data-active="true"] { outline-color: Highlight; }
    }
`;

/**
 * Create an inline list box. Filtering never changes the selected HRID or the enhancement level.
 * All listeners belong to these nodes, so rebuilding or closing the panel releases the picker.
 * @param {Object} options - Caller-owned form state and callbacks
 * @param {string} options.slot - Stable equipment slot, used to preserve focus through redraws
 * @param {string} options.label - Accessible name for the list and search
 * @param {{itemHrid: string, name: string}[]} options.items - Choices in caller-defined order
 * @param {string} options.value - Selected item HRID, or empty for no item
 * @param {string} options.query - Current search text
 * @param {Function} options.onSearch - Store search text without redrawing the panel
 * @param {Function} options.onChange - Select an item HRID (empty clears selection)
 * @returns {HTMLElement} Search, list box and result count
 */
export function createEquipmentItemPicker({ slot, label, items, value, query, onSearch, onChange }) {
    addStyles(CSS, `${CLASS_NAME}-styles`);
    const wrap = document.createElement('div');
    wrap.className = CLASS_NAME;
    wrap.style.fontSize = '11px';
    const id = `${CLASS_NAME}-${slot}`;

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search equipment…';
    search.value = query;
    search.dataset.pickSearch = 'true';
    search.dataset.panelControl = `${id}-search`;
    search.setAttribute('aria-label', `Search ${label}`);
    search.setAttribute('aria-controls', id);

    const list = document.createElement('div');
    list.id = id;
    list.tabIndex = 0;
    list.dataset.pickItem = 'true';
    list.dataset.panelControl = id;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', label);
    list.setAttribute('aria-describedby', `${id}-help`);

    const help = document.createElement('span');
    help.id = `${id}-help`;
    help.textContent = 'Type to search. Use arrow keys to choose an item. Escape returns to search.';
    help.style.color = 'rgba(232, 236, 245, 0.6)';

    const count = document.createElement('span');
    count.setAttribute('role', 'status');
    count.setAttribute('aria-live', 'polite');
    count.style.color = 'rgba(232, 236, 245, 0.6)';
    let selected = value;
    let rows = [];
    let active = -1;

    const markActive = () => {
        rows.forEach((row, index) => {
            row.dataset.active = String(index === active);
        });
        if (rows[active]) list.setAttribute('aria-activedescendant', rows[active].id);
        else list.removeAttribute('aria-activedescendant');
    };
    const choose = (index) => {
        if (!rows[index]) return;
        active = index;
        markActive();
        rows[index].scrollIntoView({ block: 'nearest' });
        const next = rows[index].dataset.itemHrid;
        if (next !== selected) {
            selected = next;
            for (const row of rows) row.setAttribute('aria-selected', String(row.dataset.itemHrid === selected));
            onChange(next);
        }
    };
    const filter = () => {
        const term = search.value.trim().toLocaleLowerCase();
        const visible = items.filter((item) => item.name.toLocaleLowerCase().includes(term));
        const choices = term ? visible : [{ itemHrid: '', name: '-- Select Item --' }, ...visible];
        list.replaceChildren();
        rows = choices.map((item, index) => {
            const row = document.createElement('div');
            row.id = `${id}-option-${index}`;
            row.dataset.itemHrid = item.itemHrid;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(item.itemHrid === selected));
            if (item.itemHrid) {
                const icon = itemIcon(item.itemHrid, 20);
                icon.setAttribute('aria-hidden', 'true');
                icon.setAttribute('focusable', 'false');
                row.appendChild(icon);
            }
            const name = document.createElement('span');
            name.textContent = item.name;
            row.appendChild(name);
            row.addEventListener('click', () => {
                list.focus({ preventScroll: true });
                choose(index);
            });
            list.appendChild(row);
            return row;
        });
        active = Math.max(
            0,
            choices.findIndex((item) => item.itemHrid === selected)
        );
        markActive();
        list.dataset.panelShape = JSON.stringify(choices.map((item) => item.itemHrid));
        count.textContent = visible.length
            ? `${visible.length} matching ${visible.length === 1 ? 'item' : 'items'}`
            : 'No matching equipment';
    };
    search.addEventListener('input', () => {
        onSearch(search.value);
        filter();
    });
    search.addEventListener('keydown', (event) => {
        event.stopPropagation();
        // Candidate navigation/confirmation belongs to the input method, not this picker.
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            list.focus({ preventScroll: true });
            choose(event.key === 'ArrowDown' ? 0 : rows.length - 1);
        }
    });
    list.addEventListener('keydown', (event) => {
        // Never also trigger a game hotkey, including when the list is empty.
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229) return;
        const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
        if (Object.hasOwn(steps, event.key) || ['Home', 'End', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            const next =
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? rows.length - 1
                      : Math.min(rows.length - 1, Math.max(0, active + (steps[event.key] || 0)));
            choose(next);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            search.focus({ preventScroll: true });
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            search.focus({ preventScroll: true });
            search.value += event.key;
            search.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
    filter();
    wrap.append(search, list, count, help);
    return wrap;
}
