import type { RedisClient } from "../store/redis";

const CHANNEL = "guard:denylist";

export class Denylist {
  private blocked = new Set<string>();
  private subscribed = false;

  constructor(
    private client: RedisClient,
    private onError?: (err: unknown) => void
  ) {}

  async subscribe(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;
    await this.client.subscribe(CHANNEL, (message) => {
      this.blocked.add(message);
    });
  }

  /** Block a key locally and publish to all other nodes */
  async block(key: string): Promise<void> {
    this.blocked.add(key);
    try {
      await this.client.publish(CHANNEL, key);
    } catch (err) {
      this.onError?.(err);
    }
  }

  isBlocked(key: string): boolean {
    return this.blocked.has(key);
  }

  unblock(key: string): void {
    this.blocked.delete(key);
  }

  async destroy(): Promise<void> {
    try {
      await this.client.unsubscribe(CHANNEL);
    } catch (err) {
      this.onError?.(err);
    }
    this.blocked.clear();
  }
}
