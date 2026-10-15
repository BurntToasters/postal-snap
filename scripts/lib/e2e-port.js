const DEFAULT_PORT = 4173;

// Resolve the E2E dev-server port from POSTAL_SNAP_E2E_PORT.
export function resolveE2ePort(env = process.env) {
  const raw = env.POSTAL_SNAP_E2E_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `POSTAL_SNAP_E2E_PORT must be an integer from 1024 to 65535 (got "${raw}")`,
    );
  }
  return port;
}
