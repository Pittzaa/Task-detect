export declare const DEFAULTS: { url: string; intervalMs: number; minIntervalMs: number; fullEveryMs: number; fastTimeoutMs: number; fullTimeoutMs: number; maxBackoffMs: number };
export declare function nextStep(o: { now: number; lastFullAt: number | null; fullEveryMs: number; intervalMs: number; failures: number; maxBackoffMs?: number }): { full: boolean; wait: number };
export declare function runPoller(o: {
  url?: string;
  secret: string;
  intervalMs?: number | string;
  fullEveryMs?: number | string;
  signal?: AbortSignal;
  maxLoops?: number;
  fetchImpl?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  log?: (message: string) => void;
}): Promise<{ url: string; status: number }[]>;
