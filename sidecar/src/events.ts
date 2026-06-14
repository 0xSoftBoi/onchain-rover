/**
 * Unified live event bus + SSE fan-out — the "what's actually happening" spine.
 *
 * Every layer (chain settlement, backend orchestration, robot HTTP calls,
 * on-device reasoning) emits into one ring buffer. Dashboards subscribe via
 * Server-Sent Events (GET /events/stream) and get pushed events instantly
 * instead of polling. A snapshot (GET /events) seeds late-joiners.
 *
 * Pending ops (in-flight on-chain txs, slow robot calls) are tracked separately
 * so the wall can show "settlement submitting…" before it confirms.
 */
import type { Request, Response } from "express";

export type Layer = "chain" | "backend" | "robot" | "reason";
export type Severity = "info" | "ok" | "warn" | "error";

export type BusEvent = {
  id: number;
  t: number;
  layer: Layer;
  kind: string;
  detail: string;
  severity: Severity;
  tx?: string;
  explorer?: string;
  chain?: string;       // "Arc" | "Sepolia" | "Mainnet"
  usdc?: number;
  ms?: number;          // wall-clock duration of the op
  gasUsdc?: number;     // gas cost in USDC (Arc pays gas in USDC)
  block?: number;       // confirmation block
  extra?: any;
};

const RING: BusEvent[] = [];
const MAX = 400;
let seq = 1;
const clients = new Set<Response>();

// In-flight operations (no terminal event yet). Keyed by the event id we
// emitted when the op started, so we can drop it when it resolves.
type Pending = { id: number; t: number; layer: Layer; kind: string; detail: string; usdc?: number };
const pending = new Map<number, Pending>();

export function emit(e: Omit<BusEvent, "id" | "t"> & { t?: number }): BusEvent {
  const evt: BusEvent = { ...e, severity: e.severity ?? "info", id: seq++, t: e.t ?? Date.now() };
  RING.unshift(evt);
  if (RING.length > MAX) RING.pop();
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { /* dropped client */ } }
  return evt;
}

/** Mark an operation as started/in-flight. Returns a handle for end(). */
export function begin(layer: Layer, kind: string, detail: string, usdc?: number): number {
  const evt = emit({ layer, kind, detail: `${detail} · …`, severity: "info", usdc, extra: { pending: true } });
  pending.set(evt.id, { id: evt.id, t: evt.t, layer, kind, detail, usdc });
  return evt.id;
}

/** Resolve a pending op. On error, emits a terminal error event. */
export function end(id: number, err?: string) {
  const p = pending.get(id);
  pending.delete(id);
  if (err) emit({ layer: p?.layer ?? "chain", kind: "ERROR", detail: `${p?.kind ?? "op"}: ${err}`, severity: "error" });
}

export function snapshot(limit = 150) {
  return {
    events: RING.slice(0, limit),
    pending: [...pending.values()].sort((a, b) => b.t - a.t),
  };
}

/** SSE handler: replays recent backlog, then streams live. */
export function sse(req: Request, res: Response) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  (res as any).flushHeaders?.();
  res.write("retry: 2000\n\n");
  // replay last ~80 events oldest-first so the wall fills immediately
  for (const e of RING.slice(0, 80).reverse()) res.write(`data: ${JSON.stringify(e)}\n\n`);
  clients.add(res);
  const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch { /* */ } }, 15000);
  req.on("close", () => { clearInterval(ka); clients.delete(res); });
}
