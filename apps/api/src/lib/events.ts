import type { KeyValue } from './kv.ts';

/**
 * Server-sent event fan-out.
 *
 * Locally: in-process listeners. With Redis: one subscription per channel, so
 * every API instance pushes the same events to its own clients (needed for the
 * lecturer screen when the API runs on more than one instance).
 */
export type EventListener = (payload: unknown) => void;

export class EventHub {
  private local = new Map<string, Set<EventListener>>();
  private subscriptions = new Map<string, () => void>();

  constructor(private readonly kv: KeyValue) {}

  private dispatch(channel: string, payload: unknown): void {
    for (const listener of this.local.get(channel) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        console.error('event listener failed', error);
      }
    }
  }

  async subscribe(channel: string, listener: EventListener): Promise<() => void> {
    const set = this.local.get(channel) ?? new Set<EventListener>();
    set.add(listener);
    this.local.set(channel, set);

    if (!this.subscriptions.has(channel)) {
      const unsubscribe = await this.kv.subscribe(channel, (message) => {
        try {
          this.dispatch(channel, JSON.parse(message));
        } catch {
          // Ignore malformed payloads rather than breaking the stream.
        }
      });
      this.subscriptions.set(channel, unsubscribe);
    }

    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.local.delete(channel);
        const unsubscribe = this.subscriptions.get(channel);
        if (unsubscribe) {
          unsubscribe();
          this.subscriptions.delete(channel);
        }
      }
    };
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.kv.publish(channel, JSON.stringify(payload));
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.local.clear();
  }
}

export const channels = {
  sessionQr: (sessionId: string): string => `sse:session:${sessionId}:qr`,
  sessionRoster: (sessionId: string): string => `sse:session:${sessionId}:roster`,
  institution: (institutionId: string): string => `sse:institution:${institutionId}`,
};
