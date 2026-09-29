// Time-bucket helper shared by the recap and charts. Pure JS.

/**
 * Bucket size in seconds for a time range: 1 min up to 6 h, 5 min up to a day, 15 min up to a
 * week, then 1 h. That's at most 360 buckets up to a day, 672 up to a week, and 720 for the
 * 30 days Google keeps logs (the recap's limit). The recap's thresholds are tuned to these sizes.
 */
export function bucketPeriod(rangeMs) {
  const h = rangeMs / 3_600_000;
  if (h <= 6) return 60;
  if (h <= 24) return 300;
  if (h <= 24 * 7) return 900;
  return 3600;
}
