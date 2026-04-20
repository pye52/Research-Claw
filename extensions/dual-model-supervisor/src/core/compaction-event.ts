/**
 * Compaction event — one active compaction per session, decoupled from TurnState.
 */

import type { MemoryItem } from './types.js';

export interface CompactionEventState {
  sessionId: string;
  createdAt: number;
  preCompactionMemory: MemoryItem[];
}

export class CompactionEventRegistry {
  private readonly active = new Map<string, CompactionEventState>();

  begin(sessionId: string): CompactionEventState {
    const ev: CompactionEventState = {
      sessionId,
      createdAt: Date.now(),
      preCompactionMemory: [],
    };
    this.active.set(sessionId, ev);
    return ev;
  }

  current(sessionId: string): CompactionEventState | undefined {
    return this.active.get(sessionId);
  }

  end(sessionId: string): void {
    this.active.delete(sessionId);
  }

  /** Remove any active compaction state for a session (e.g. session_end). */
  dropAll(sessionId: string): void {
    this.active.delete(sessionId);
  }
}
