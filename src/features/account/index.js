/**
 * Account view
 *
 * One place that treats the account as the account rather than as whichever
 * character happens to be logged in.
 *
 * Every store in this script is per character — `networth_<id>`,
 * `lootLog_<id>`, `tradeHistory_<id>`, one queue snapshot per character — which
 * is right for recording and useless for the questions that are actually about
 * the whole account: what is it all worth, and has one of the alts stopped.
 * This feature answers those by reading the other characters' own records back
 * out.
 *
 * The reading is in `account-data.js` and the drawing in `account-panel.js`;
 * this module is where they are put together and handed to the feature registry.
 */

import { accountPanel, registerAccountRow } from './account-panel.js';
import { clearAccountCache, rememberCurrentCharacter } from './account-data.js';

export { accountPanel };

export default {
    name: 'Account View',

    initialize: async () => {
        // Names are the one thing no store keeps against an id, so each login
        // records its own — that is what lets the other characters be named
        await rememberCurrentCharacter();

        // Features re-initialize on a character switch, and the cache is keyed
        // to nothing: what it holds is the previous character's idea of who is
        // "here". Dropping it makes the next draw read the account afresh.
        //
        // Deliberately not read here — a dozen IndexedDB reads on every login
        // for a panel nobody has opened is work paid for by everyone and used
        // by whoever opens it. The first draw asks for it instead.
        clearAccountCache();

        registerAccountRow();
    },

    cleanup: () => {
        accountPanel.hide({ remember: false });
        clearAccountCache();
    },
};
