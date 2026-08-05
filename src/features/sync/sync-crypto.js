/**
 * Passphrase encryption for the sync payload.
 *
 * What this protects, and what it cannot: a "secret" gist is unlisted, not
 * access-controlled — anyone holding the URL (or a leaked token) can read it,
 * and the payload is otherwise plain JSON of everything the script knows.
 * Encrypting with a passphrase makes the gist side unreadable without it. The
 * passphrase itself is a setting, stored in this browser's database in plain
 * text exactly like the token — so this is protection for the *GitHub* side,
 * not against something that can already read the page.
 *
 * AES-256-GCM under a PBKDF2-SHA-256 key. GCM because its auth tag turns a
 * wrong passphrase (or a tampered gist) into a clean failure instead of
 * plausible-looking garbage being fed to the importer. The KDF parameters ride
 * in the manifest so they can be raised later without stranding old gists.
 */

import { GistError } from './gist-client.js';

/** PBKDF2 rounds for newly written gists (OWASP's SHA-256 floor) */
export const KDF_ITERATIONS = 310_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;

/** The one WebCrypto handle, or null where the API is missing */
function subtle() {
    return globalThis.crypto?.subtle ?? null;
}

/**
 * Bytes to base64, in slices — `String.fromCharCode(...whole)` overflows the
 * argument limit on a payload of any real size.
 * @param {Uint8Array} bytes - Raw bytes
 * @returns {string} Base64 text
 */
export function bytesToBase64(bytes) {
    let binary = '';
    const SLICE = 0x8000;
    for (let start = 0; start < bytes.length; start += SLICE) {
        binary += String.fromCharCode(...bytes.subarray(start, start + SLICE));
    }
    return btoa(binary);
}

/**
 * Base64 to bytes.
 * @param {string} text - Base64 text
 * @returns {Uint8Array} Raw bytes
 */
export function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/**
 * Derive the AES key for one passphrase + salt.
 * @param {string} passphrase - The shared secret
 * @param {Uint8Array} salt - Random per-encryption salt
 * @param {number} iterations - PBKDF2 rounds
 * @returns {Promise<CryptoKey>} AES-GCM key
 */
async function deriveKey(passphrase, salt, iterations) {
    const api = subtle();
    if (!api) {
        throw new GistError('passphrase', 'This browser does not expose WebCrypto, so encrypted sync cannot run.');
    }
    const material = await api.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return api.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt a payload for upload.
 *
 * Salt and IV are fresh every time, so two pushes of identical plaintext
 * produce unrelated ciphertexts — which is also why change detection hashes
 * the plaintext, never this.
 *
 * @param {string} plaintext - The payload JSON
 * @param {string} passphrase - The shared secret
 * @returns {Promise<{ciphertext: string, salt: string, iv: string, iterations: number,
 *   algorithm: string, kdf: string}>} Everything the manifest needs, base64-encoded
 */
export async function encryptText(plaintext, passphrase) {
    return encryptBytes(new TextEncoder().encode(plaintext), passphrase);
}

/**
 * Encrypt raw bytes — the path a compressed payload takes, since gzip output
 * is not text. Same envelope as {@link encryptText}.
 * @param {Uint8Array} bytes - The payload bytes
 * @param {string} passphrase - The shared secret
 * @returns {Promise<{ciphertext: string, salt: string, iv: string, iterations: number,
 *   algorithm: string, kdf: string}>} Everything the manifest needs, base64-encoded
 */
export async function encryptBytes(bytes, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);

    const sealed = await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes);

    return {
        ciphertext: bytesToBase64(new Uint8Array(sealed)),
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        iterations: KDF_ITERATIONS,
        algorithm: 'AES-256-GCM',
        kdf: 'PBKDF2-SHA-256',
    };
}

/**
 * Decrypt a pulled payload.
 *
 * A wrong passphrase and a tampered gist are indistinguishable here — GCM's
 * auth check fails for both — so the error says to check the passphrase first,
 * that being overwhelmingly the actual cause.
 *
 * @param {{ciphertext: string, salt: string, iv: string, iterations: number}} sealed - From the manifest + chunks
 * @param {string} passphrase - The shared secret
 * @returns {Promise<string>} The payload JSON
 */
export async function decryptText(sealed, passphrase) {
    return new TextDecoder().decode(await decryptBytes(sealed, passphrase));
}

/**
 * Decrypt to raw bytes — what a compressed payload needs, since the plaintext
 * under the seal is gzip, not text. Same failure semantics as
 * {@link decryptText}.
 * @param {{ciphertext: string, salt: string, iv: string, iterations: number}} sealed - From the manifest + chunks
 * @param {string} passphrase - The shared secret
 * @returns {Promise<Uint8Array>} The payload bytes
 */
export async function decryptBytes(sealed, passphrase) {
    const { ciphertext, salt, iv } = sealed || {};
    const iterations = Number(sealed?.iterations);
    if (typeof ciphertext !== 'string' || typeof salt !== 'string' || typeof iv !== 'string' || !(iterations > 0)) {
        throw new GistError('parse', 'The sync gist’s encryption record is incomplete. Push again to replace it.');
    }

    let saltBytes, ivBytes, cipherBytes;
    try {
        saltBytes = base64ToBytes(salt);
        ivBytes = base64ToBytes(iv);
        cipherBytes = base64ToBytes(ciphertext);
    } catch {
        throw new GistError('parse', 'The sync gist’s encrypted payload is corrupt. Push again to replace it.');
    }

    const key = await deriveKey(passphrase, saltBytes, iterations);
    try {
        const opened = await subtle().decrypt({ name: 'AES-GCM', iv: ivBytes }, key, cipherBytes);
        return new Uint8Array(opened);
    } catch {
        throw new GistError(
            'passphrase',
            'The gist could not be decrypted — the sync passphrase here does not match the one it was pushed with.'
        );
    }
}

export default { KDF_ITERATIONS, encryptText, encryptBytes, decryptText, decryptBytes, bytesToBase64, base64ToBytes };
