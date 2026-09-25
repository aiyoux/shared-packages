/**
 * Every catalog engine holds `${CATALOG_SESSION_LOCK}${session}` for its whole
 * life, and the catalog worker queues on it when that session begins a
 * transaction. The worker serves one session at a time between BEGIN and
 * COMMIT, so a tab that dies mid-transaction would otherwise stall every other
 * tab forever; the lock's grant is the exact notice that the owner is gone, and
 * the worker rolls back then. Its own module so the worker can import the name
 * without pulling in the election.
 */
export const CATALOG_SESSION_LOCK = 'vfs-catalog-session:';
