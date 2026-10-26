/** Package entry: DSH loads the bundle patch, whose row names this module, and reads the default export. */
export { default } from './plugin.ts';
export { PET_PATH, PROTOCOL_VERSION, PetHub } from './pet-hub.ts';
export { AgentRegistry, noticeOf } from './session-watch.ts';
export { SessionDirectory, shortSessionId, titleText, looksLikeSessionQuery } from './sessions.ts';
export { LoopbackHost } from './server.ts';
export { assistantText, parsePetFrame, reasonText } from './protocol.ts';
export type { HostFrame, PetFrame, HostAck, HostSessions } from './protocol.ts';
export type { AgentFacts, OwnerActor } from './session-watch.ts';
export type { SessionEntry, SessionListing, SessionQueryLike } from './sessions.ts';
export type { SayResult } from './pet-hub.ts';
