import { describe, it, expect, vi } from "vitest";
import { Denylist } from "../src/sync/denylist";
import type { RedisClient } from "../src/store/redis";

function makeClient() {
  let handler: ((msg: string) => void) | null = null;
  const client: RedisClient = {
    subscribe: vi.fn(async (_ch: string, cb: (msg: string) => void) => { handler = cb; }),
    unsubscribe: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    eval: vi.fn(),
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    quit: vi.fn(async () => {}),
  };
  return { client, trigger: (msg: string) => handler?.(msg) };
}

describe("Denylist", () => {
  it("blocks a key locally and publishes to Redis", async () => {
    const { client } = makeClient();
    const dl = new Denylist(client);
    await dl.subscribe();
    await dl.block("k1");

    expect(dl.isBlocked("k1")).toBe(true);
    expect(client.publish).toHaveBeenCalledWith("guard:denylist", "k1");
  });

  it("blocks a key received via pub/sub", async () => {
    const { client, trigger } = makeClient();
    const dl = new Denylist(client);
    await dl.subscribe();

    trigger("k2");
    expect(dl.isBlocked("k2")).toBe(true);
  });

  it("unblock removes the key", async () => {
    const { client } = makeClient();
    const dl = new Denylist(client);
    await dl.subscribe();
    await dl.block("k3");
    dl.unblock("k3");
    expect(dl.isBlocked("k3")).toBe(false);
  });

  it("destroy unsubscribes and clears the set", async () => {
    const { client } = makeClient();
    const dl = new Denylist(client);
    await dl.subscribe();
    await dl.block("k4");
    await dl.destroy();

    expect(client.unsubscribe).toHaveBeenCalledWith("guard:denylist");
    expect(dl.isBlocked("k4")).toBe(false);
  });

  it("calls onError when publish fails", async () => {
    const { client } = makeClient();
    (client.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("net"));
    const errors: unknown[] = [];
    const dl = new Denylist(client, (e) => errors.push(e));
    await dl.subscribe();
    await dl.block("k5");
    expect(errors).toHaveLength(1);
  });
});
