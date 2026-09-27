// Time-bucket helper shared by the recap and charts. Pure JS.

/** Bucket size in seconds for a time range, keeping ~≤ 300 points. */
export function bucketPeriod(rangeMs) {
  const h = rangeMs / 3_600_000;
  if (h <= 6) return 60;
  if (h <= 24) return 300;
  if (h <= 24 * 7) return 900;
  return 3600;
}
