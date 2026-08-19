# `@shared-packages/crypto`

Lazy-loaded file hashing and encryption behind one API:

- **Web Crypto** — native SubtleCrypto (SHA-2, AES-256-GCM, PBKDF2)
- **libsodium** — WASM (SHA-2, BLAKE2b, XChaCha20-Poly1305, Argon2id)

Plus **`.spvault`**, a Scratch Pad–only container that is either a single
encrypted file or a small encrypted filesystem (path → bytes).

Product UI stays in the consumer.

## Usage

```ts
import {
  hashBytes,
  verifyHash,
  sealVault,
  openVault,
  isVaultBytes
} from '@shared-packages/crypto';

const { hex } = await hashBytes('webcrypto', bytes, 'sha256');
const check = await verifyHash('webcrypto', bytes, hex, 'sha256');

const vault = await sealVault('libsodium', [{ path: 'note.txt', data: bytes }], 'passphrase');
const opened = await openVault(vault.data, 'passphrase');
```

`listEngines()` is sync. `loadEngine` / `hashBytes` / `sealVault` dynamically
import libsodium only when that engine is used.

## Vault format (v1)

Fixed 64-byte header starting with magic `SPVLT01\n`, then ciphertext of an
inner single-file (`SPVLTsf1`) or tree (`SPVLTfs1`) payload. Not zip, age, or
7z — `isVaultBytes` rejects those.

## Local development

Consumers depend on this package via `file:`. Edit here and they HMR. Run
`npm install` in a consumer only when `exports` change.
