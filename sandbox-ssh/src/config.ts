import path from "node:path";

export const DEFAULT_PORT = 22;
export const DEFAULT_WORKSPACE_ROOT = "/home/node/paperclip-sandbox";
export const DEFAULT_TIMEOUT_MS = 3_600_000;
export const MAX_TIMEOUT_MS = 86_400_000;

/** The driver config after validation. The host resolves `privateKey` from a secret before each call. */
export interface SshSandboxConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  knownHosts: string;
  workspaceRoot: string;
  timeoutMs: number;
}

/** JSON Schema of the driver config, shown in the environment form. */
export const configSchema = {
  type: "object",
  required: ["host", "username", "privateKey", "knownHosts"],
  properties: {
    host: {
      type: "string",
      description: "Host name or address of the SSH server that runs the commands.",
    },
    port: {
      type: "number",
      description: "SSH port.",
      default: DEFAULT_PORT,
    },
    username: {
      type: "string",
      description: "User to log in as. Every lease runs as this user.",
    },
    privateKey: {
      type: "string",
      format: "secret-ref",
      description:
        "Private key for the user (OpenSSH format). Paste a key or pick an existing Paperclip secret; saved environments store pasted keys as company secrets.",
    },
    knownHosts: {
      type: "string",
      description:
        "known_hosts lines for the server, for example `[host]:2222 ssh-ed25519 AAAA…`. The driver always checks the host key.",
    },
    workspaceRoot: {
      type: "string",
      description: "Absolute directory on the server. Each lease gets its own directory below it.",
      default: DEFAULT_WORKSPACE_ROOT,
    },
    timeoutMs: {
      type: "number",
      description: "Default time limit for one command, in milliseconds, when the host sets none.",
      default: DEFAULT_TIMEOUT_MS,
    },
  },
} as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Reads the raw config without throwing. `validateConfig` reports what is wrong with it. */
export function parseConfig(raw: Record<string, unknown>): SshSandboxConfig {
  const port = Number(raw.port ?? DEFAULT_PORT);
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const workspaceRoot = text(raw.workspaceRoot) || DEFAULT_WORKSPACE_ROOT;
  return {
    host: text(raw.host),
    port: Number.isFinite(port) ? Math.trunc(port) : Number.NaN,
    username: text(raw.username),
    // A key must end with a newline, or ssh refuses it as "invalid format".
    privateKey: text(raw.privateKey) ? `${text(raw.privateKey)}\n` : "",
    knownHosts: text(raw.knownHosts),
    workspaceRoot: workspaceRoot.length > 1 ? workspaceRoot.replace(/\/+$/, "") : workspaceRoot,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : Number.NaN,
  };
}

// The host and user go into one ssh argument. A leading "-" would make ssh read
// it as an option, so allow only plain name characters.
const HOST_PATTERN = /^[A-Za-z0-9.:_[\]-]+$/;
const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** Returns the errors in a config. An empty list means the config is valid. */
export function configErrors(config: SshSandboxConfig): string[] {
  const errors: string[] = [];
  if (!config.host || !HOST_PATTERN.test(config.host) || config.host.startsWith("-")) {
    errors.push("host must be a host name or an address.");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    errors.push("port must be a number from 1 to 65535.");
  }
  if (!USER_PATTERN.test(config.username)) {
    errors.push("username must be a plain user name.");
  }
  if (!config.privateKey) {
    errors.push("privateKey is required.");
  }
  if (!config.knownHosts) {
    errors.push("knownHosts is required: the driver never accepts an unknown host key.");
  }
  if (
    !path.posix.isAbsolute(config.workspaceRoot) ||
    path.posix.normalize(config.workspaceRoot) !== config.workspaceRoot ||
    config.workspaceRoot === "/"
  ) {
    errors.push("workspaceRoot must be a normalized absolute directory other than /.");
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > MAX_TIMEOUT_MS) {
    errors.push(`timeoutMs must be from 1 to ${MAX_TIMEOUT_MS}.`);
  }
  return errors;
}
