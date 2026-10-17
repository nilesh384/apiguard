import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../src/store/memory";

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    // Long eviction interval — we'll call evict() manually
    store = new MemoryStore(999_999);
  });

  afterEach(() => store.destroy());

  it("creates a new entry on first access", () => {
    store.getOrCreate("k1", "token-bucket", 10, 1000, 0);
    expect(store.size()).toBe(1);
  });

  it("returns the same state on subsequent access", () => {
    const s1 = store.getOrCreate("k1", "token-bucket", 10, 1000, 0);
    const s2 = store.getOrCreate("k1", "token-bucket", 10, 1000, 100);
    expect(s1).toBe(s2);
  });

  it("evicts expired entries", () => {
    store.getOrCreate("k1", "token-bucket", 10, 1000, 0);
    // expiresAt = 0 + 1000*2 = 2000; evict at t=3000
    store.evict(3000);
    expect(store.size()).toBe(0);
  });

  it("does not evict entries that are still alive", () => {
    store.getOrCreate("k1", "token-bucket", 10, 1000, 0);
    store.evict(1000); // expiresAt=2000, evicting at 1000 → still alive
    expect(store.size()).toBe(1);
  });

  it("touch extends TTL", () => {
    store.getOrCreate("k1", "token-bucket", 10, 1000, 0);
    store.touch("k1", 1000, 1500); // new expiresAt = 1500 + 2000 = 3500
    store.evict(3000); // would have expired at 2000 without touch
    expect(store.size()).toBe(1);
  });

  it("re-creates entry after expiry", () => {
    const s1 = store.getOrCreate("k1", "token-bucket", 10, 1000, 0);
    const s2 = store.getOrCreate("k1", "token-bucket", 10, 1000, 3000); // past expiresAt=2000
    expect(s1).not.toBe(s2);
  });
});
