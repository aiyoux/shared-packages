/** Names for origin services. Context lock names remain owned by leaseOwner. */
export const serviceNames = {
 tabs: 'scratchpad:services:tabs',
 ops: 'scratchpad:services:ops',
 notifications: 'scratchpad:services:notifications',
 opsDb: 'scratchpad-ops',
 notificationsDb: 'scratchpad-notifications',
 recordStore: 'records',
 monitorLock: (profileId: string) => `scratchpad:monitor:${profileId}`,
 monitorBus: (profileId: string) => `scratchpad:monitor:${profileId}:bus`,
 landLock: (id: string) => `scratchpad:op:${id}:land`
} as const;
