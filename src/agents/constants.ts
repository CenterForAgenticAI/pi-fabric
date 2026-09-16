export const AGENT_STATUS_POLL_INTERVAL_MS = 250;
export const EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS = 2_000;
export const AGENT_STARTUP_MAX_ATTEMPTS = 3;
export const AGENT_STARTUP_RETRY_BASE_DELAY_MS = 500;
/** Relaunch attempts after an unexpected mid-run stop. An explicit stop (tool,
 *  dashboard, or session shutdown) is terminal and never resumed. */
export const AGENT_RESUME_MAX_ATTEMPTS = 3;
export const AGENT_RESUME_RETRY_BASE_DELAY_MS = 1_000;
