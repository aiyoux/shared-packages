/** In-memory adapters for app-held PCs, alongside the workspace host. No keys or passcodes are stored here. */
export type HandoverLink = {
 linkId: string;
 recordId: string;
 connection: unknown;
 role: 'sequencer' | 'replica';
 sendControl(frame: Record<string, unknown> & { kind: string }): void;
 replace(next: unknown): boolean;
 release(): void;
 mark(on: boolean): void;
};
type Control = (frame: Record<string, unknown>, link: HandoverLink) => void;
function state() {
 const g = globalThis as typeof globalThis & { __handoverLinks__?: { links: Map<string, HandoverLink>; controls: Set<Control> } };
 return g.__handoverLinks__ ??= { links: new Map(), controls: new Set() };
}
export function registerHandoverLink(link: HandoverLink): () => void {
 state().links.set(link.linkId, link);
 return () => { if (state().links.get(link.linkId) === link) state().links.delete(link.linkId); };
}
export function handoverLink(id: string): HandoverLink | undefined { return state().links.get(id); }
export function externalLinkControl(frame: Record<string, unknown>, link: HandoverLink): void {
 for (const fn of state().controls) fn(frame, link);
}
export function onExternalLinkControl(fn: Control): () => void {
 state().controls.add(fn); return () => { state().controls.delete(fn); };
}
