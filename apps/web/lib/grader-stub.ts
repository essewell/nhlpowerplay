/**
 * Step 5 replaces this module with the real grader. Until then the Results screen gets an honest
 * "empty" report: no grades, no percentile, no made-up text.
 */
import type { GradeReport, RunSnapshot } from "./contracts.ts";

/** Always the empty report. O(1). `snapshot` is accepted so the Step 5 signature does not change. */
export function gradeRun(snapshot: RunSnapshot): Promise<GradeReport> {
  void snapshot;
  return Promise.resolve({ status: "empty", grades: null, percentile: null, looksLike: null, approx: false });
}
