/**
 * Round-trip and failure behaviour of the payload encryption.
 *
 * The failures matter more than the round trip: a wrong passphrase must come
 * back as a clean, named error — never as garbage handed to the importer —
 * and a truncated or hand-edited gist must not decrypt at all.
 */
import { describe, test, expect } from 'vitest';
import { encryptText, decryptText, bytesToBase64, base64ToBytes, KDF_ITERATIONS } from './sync-crypto.js';
import { GistError } from './gist-client.js';

describe('encryptText / decryptText', () => {
    test('what was sealed is what comes back', async () => {
        const plaintext = '{"stores":{"settings":{"a":1}},"exportedAt":"2026-08-05"}';
        const sealed = await encryptText(plaintext, 'correct horse');
        expect(sealed.ciphertext).not.toContain('stores');
        expect(sealed.iterations).toBe(KDF_ITERATIONS);
        expect(sealed.algorithm).toBe('AES-256-GCM');

        await expect(decryptText(sealed, 'correct horse')).resolves.toBe(plaintext);
    });

    test('non-ASCII payloads survive the trip', async () => {
        const plaintext = JSON.stringify({ name: 'Mjölnir ⚒️', emoji: '🐄' });
        const sealed = await encryptText(plaintext, 'påss🔑');
        await expect(decryptText(sealed, 'påss🔑')).resolves.toBe(plaintext);
    });

    test('two seals of one plaintext share nothing — salt and IV are fresh', async () => {
        const first = await encryptText('{"same":1}', 'pass');
        const second = await encryptText('{"same":1}', 'pass');
        expect(first.ciphertext).not.toBe(second.ciphertext);
        expect(first.salt).not.toBe(second.salt);
        expect(first.iv).not.toBe(second.iv);
    });

    test('a wrong passphrase is a named failure, not garbage', async () => {
        const sealed = await encryptText('{"secret":true}', 'right');
        const failure = await decryptText(sealed, 'wrong').catch((error) => error);
        expect(failure).toBeInstanceOf(GistError);
        expect(failure.kind).toBe('passphrase');
    });

    test('a tampered ciphertext refuses to decrypt', async () => {
        const sealed = await encryptText('{"secret":true}', 'pass');
        const bytes = base64ToBytes(sealed.ciphertext);
        bytes[Math.floor(bytes.length / 2)] ^= 0xff;
        const failure = await decryptText({ ...sealed, ciphertext: bytesToBase64(bytes) }, 'pass').catch(
            (error) => error
        );
        expect(failure).toBeInstanceOf(GistError);
        expect(failure.kind).toBe('passphrase');
    });

    test('an incomplete encryption record is a parse failure with its own advice', async () => {
        const failure = await decryptText({ ciphertext: 'abc', salt: null, iv: 'a', iterations: 1 }, 'pass').catch(
            (error) => error
        );
        expect(failure).toBeInstanceOf(GistError);
        expect(failure.kind).toBe('parse');
    });
});

describe('base64 helpers', () => {
    test('round-trips bytes, including sizes past one fromCharCode slice', () => {
        const bytes = new Uint8Array(0x8000 * 2 + 7);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });
});
