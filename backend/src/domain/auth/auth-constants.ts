export const TOKEN_POLICY = {
  accessTtlSeconds: 15 * 60,
  refreshTtlSecondsCustomer: 30 * 24 * 60 * 60,
  refreshTtlSecondsStaff: 7 * 24 * 60 * 60,
  stepUpTtlSeconds: 5 * 60,
} as const;
