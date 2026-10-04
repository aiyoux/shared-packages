/** Names for origin services. Context lock names remain owned by leaseOwner. */
export const serviceNames = {
 tabs: 'scratchpad:services:tabs',
 ops: 'scratchpad:services:ops',
 notifications: 'scratchpad:services:notifications',
 opsDb: 'scratchpad-ops',
 notificationsDb: 'scratchpad-notifications',
 connections: 'scratchpad:services:connections',
 connectionsDb: 'scratchpad-connections',
 /** One channel per device link: lanes the owner tab serves to the others. */
 link: (id: string) => `scratchpad:link:${id}`,
 recordStore: 'records',
 monitorLock: (profileId: string) => `scratchpad:monitor:${profileId}`,
 monitorBus: (profileId: string) => `scratchpad:monitor:${profileId}:bus`,
 landLock: (id: string) => `scratchpad:op:${id}:land`,
 /** Held while one tab sends a working copy back; queued tabs re-check after. */
 remoteCopy: (nodeId: string) => `scratchpad:remote-copy:${nodeId}`,
 remoteCopiesIndex: 'scratchpad:remote-copies:index',
 remoteCopiesBus: 'scratchpad:remote-copies'
} as const;
