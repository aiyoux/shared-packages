export {
	HUB_VAULT_DB_NAME,
	HUB_VAULT_STORE,
	HUB_VAULT_META_KEY,
	HUB_VAULT_CHANNEL,
	VaultLockedError,
	VaultWrongPassphraseError,
	SecretUnavailableError,
	isVaultLockedError,
	isSecretUnavailableError,
	type SealedSecret,
	type SecretKind,
	type VaultMetaV1
} from './types.js';

export {
	closeVaultDbForTests,
	disableVault,
	enableVault,
	getVaultStatus,
	isVaultEnabled,
	isVaultUnlocked,
	lockVault,
	syncVaultFromIdb,
	unlockVault
} from './store.js';

export { setVaultKdfCostForTests } from './crypto.js';
export { resetVaultSessionForTests, subscribeVaultSession } from './session.js';
