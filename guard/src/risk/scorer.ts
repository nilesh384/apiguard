import type { Signal, SignalContext } from "./signals";

export type RiskDecision = "allow" | "challenge" | "block";

export interface RiskResult {
  decision: RiskDecision;
  /** Final weighted score 0–1 */
  score: number;
  /** Per-signal breakdown for observability */
  breakdown: Record<string, number>;
}

export interface ScorerOptions {
  signals: Signal[];
  /** Score threshold above which the decision is "challenge" (default 0.5) */
  challengeThreshold?: number;
  /** Score threshold above which the decision is "block" (default 0.8) */
  blockThreshold?: number;
}

export class RiskScorer {
  private signals: Signal[];
  private challengeAt: number;
  private blockAt: number;

  constructor(opts: ScorerOptions) {
    this.signals = opts.signals;
    this.challengeAt = opts.challengeThreshold ?? 0.5;
    this.blockAt = opts.blockThreshold ?? 0.8;
  }

  evaluate(ctx: SignalContext): RiskResult {
    let weightedSum = 0;
    let totalWeight = 0;
    const breakdown: Record<string, number> = {};

    for (const signal of this.signals) {
      const w = signal.weight ?? 1;
      const s = Math.max(0, Math.min(1, signal.score(ctx)));
      breakdown[signal.name] = s;
      weightedSum += s * w;
      totalWeight += w;
    }

    const score = totalWeight === 0 ? 0 : weightedSum / totalWeight;

    let decision: RiskDecision = "allow";
    if (score >= this.blockAt) decision = "block";
    else if (score >= this.challengeAt) decision = "challenge";

    return { decision, score, breakdown };
  }
}
