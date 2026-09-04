export type DownlinkOwner = "none" | "realtime" | "play";

export type DownlinkSlot = {
  generation: number;
  owner: DownlinkOwner;
};

const STORE_KEY = Symbol.for("xiaozhi.downlink-owner");

function slots(): Map<string, DownlinkSlot> {
  const globalWithStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: Map<string, DownlinkSlot>;
  };
  if (!globalWithStore[STORE_KEY]) {
    globalWithStore[STORE_KEY] = new Map();
  }
  return globalWithStore[STORE_KEY];
}

export function getDownlink(sessionId: string): DownlinkSlot {
  return slots().get(sessionId) ?? { generation: 0, owner: "none" };
}

export function claimDownlink(sessionId: string, owner: DownlinkOwner): number {
  const next = getDownlink(sessionId).generation + 1;
  slots().set(sessionId, { generation: next, owner });
  return next;
}

export function isDownlinkOwner(
  sessionId: string,
  generation: number,
  owner: DownlinkOwner,
): boolean {
  const slot = getDownlink(sessionId);
  return slot.generation === generation && slot.owner === owner;
}

export function releaseDownlink(
  sessionId: string,
  generation: number,
  owner: DownlinkOwner,
): boolean {
  if (!isDownlinkOwner(sessionId, generation, owner)) return false;
  slots().set(sessionId, { generation, owner: "none" });
  return true;
}
