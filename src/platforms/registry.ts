import type { PlatformAdapter } from './types';
import { tiktokAdapter } from './tiktok/adapter';

export interface PlatformRegistry {
  get(id: string): PlatformAdapter | undefined;
  all(): readonly PlatformAdapter[];
}

export function createRegistry(adapters: readonly PlatformAdapter[]): PlatformRegistry {
  const byId = new Map<string, PlatformAdapter>();
  for (const a of adapters) {
    if (byId.has(a.id)) throw new Error(`duplicate platform adapter "${a.id}"`);
    byId.set(a.id, a);
  }
  return { get: (id) => byId.get(id), all: () => [...byId.values()] };
}

/** Adding a platform = writing an adapter (docs/ADDING_A_PLATFORM.md) and listing it here. Nothing else changes. */
export const registry: PlatformRegistry = createRegistry([tiktokAdapter]);
