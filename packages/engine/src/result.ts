/**
 * Shared result type. Expected failures are returned as values, never thrown, so callers
 * (UI, worker, server) can show or log them instead of crashing.
 * Stateless; safe in Web Workers and on the server.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** O(1). */
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/** O(1). */
export const err = <T>(error: string): Result<T> => ({ ok: false, error });
