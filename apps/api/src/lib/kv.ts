import { Redis } from 'ioredis';

/**
 * Key-value surface used for idempotency, rate-limit counters and one-time
 * nonces. Redis when REDIS_URL is set, otherwise an in-process map so a
 * developer can run the API without extra services (single instance only —
 * documented in docs/RUNBOOK.md).
 */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Set only when absent. Returns true when the key was created. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  delete(key: string): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<() => void>;
  close(): Promise<void>;
  kind: 'redis' | 'memory';
}

export class MemoryKeyValue implements KeyValue {
  readonly kind = 'memory' as const;
  private store = new Map<string, { value: string; expiresAt: number }>();
  private subscribers = new Map<string, Set<(message: string) => void>>();

  private live(key: string): { value: string; expiresAt: number } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const current = this.live(key);
    const next = (current ? Number.parseInt(current.value, 10) : 0) + 1;
    if (current) {
      this.store.set(key, { value: String(next), expiresAt: current.expiresAt });
    } else {
      await this.set(key, String(next), ttlSeconds);
    }
    return next;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async publish(channel: string, message: string): Promise<void> {
    for (const handler of this.subscribers.get(channel) ?? []) handler(message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    const set = this.subscribers.get(channel) ?? new Set();
    set.add(handler);
    this.subscribers.set(channel, set);
    return () => set.delete(handler);
  }

  async close(): Promise<void> {
    this.store.clear();
    this.subscribers.clear();
  }
}

export class RedisKeyValue implements KeyValue {
  readonly kind = 'redis' as const;
  private client: Redis;
  private subscribers = new Map<string, { handler: (message: string) => void; unsubscribe: () => void }>();

  constructor(url: string) {
    this.client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.client.incr(key);
    if (value === 1) await this.client.expire(key, ttlSeconds);
    return value;
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    const existing = this.subscribers.get(channel);
    if (existing) return () => undefined;
    const dedicated = this.client.duplicate();
    await dedicated.subscribe(channel);
    dedicated.on('message', (receivedChannel: string, message: string) => {
      if (receivedChannel === channel) handler(message);
    });
    this.subscribers.set(channel, { handler, unsubscribe: () => void dedicated.quit() });
    return () => {
      const entry = this.subscribers.get(channel);
      if (entry) {
        entry.unsubscribe();
        this.subscribers.delete(channel);
      }
    };
  }

  async close(): Promise<void> {
    for (const entry of this.subscribers.values()) entry.unsubscribe();
    this.subscribers.clear();
    await this.client.quit();
  }
}

export function createKeyValue(redisUrl?: string): KeyValue {
  if (redisUrl && redisUrl.length > 0) return new RedisKeyValue(redisUrl);
  return new MemoryKeyValue();
}
