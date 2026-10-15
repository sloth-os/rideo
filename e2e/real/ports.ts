/** The real-model suite's ports (e2e/real/stack.ts), apart from the mock suite's (e2e/support/ports.ts). */
export const REAL_PORT = Number(process.env.RIDEO_REAL_PORT ?? 8827);

export const REAL_PORTS = {
  /** The studio. */
  studio: REAL_PORT,
  /** mm-gateway, when the suite starts it. */
  gateway: REAL_PORT + 1,
} as const;
