type Surface = "api" | "a2a_rpc";

export function recordRequestMetric(input: {
  surface: Surface;
  status: number;
  durationMs: number;
  requestId?: string;
  errorCode?: string;
}) {
  const entry = { event: "a2a.request", at: new Date().toISOString(), surface: input.surface,
    status: input.status, durationMs: Math.round(input.durationMs),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}) };
  const line = JSON.stringify(entry);
  if (input.status >= 500) console.error(line);
  else console.info(line);
}

export function recordSmartBatchMetric(counts: { processed: number; completed: number; failed: number; skipped: number },
  durationMs: number) {
  console.info(JSON.stringify({ event: "a2a.smart.batch", at: new Date().toISOString(),
    ...counts, durationMs: Math.round(durationMs) }));
}
