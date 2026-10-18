import type { BucketState } from "../algorithms/token-bucket";
import type { WindowState } from "../algorithms/sliding-window";

export type AlgoState = BucketState | WindowState;

export interface Store {
  getOrCreate(
    key: string,
    algo: "token-bucket" | "sliding-window",
    capacity: number,
    windowMs: number,
    nowMs?: number
  ): AlgoState;
  touch(key: string, windowMs: number, nowMs?: number): void;
  evict(nowMs?: number): void;
  size(): number;
  destroy(): void;
}
