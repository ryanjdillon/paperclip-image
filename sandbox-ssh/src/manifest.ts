import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { configSchema } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "ryanjdillon.sandbox-ssh",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "SSH Sandbox Provider",
  description:
    "Runs sandbox environments on an existing SSH server, so that agents which need a sandbox runner can use a fixed runner host.",
  author: "ryanjdillon",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "ssh-sandbox",
      kind: "sandbox_provider",
      displayName: "SSH host",
      description: "Runs each lease in its own directory on an existing SSH server, over ssh.",
      configSchema: configSchema as unknown as Record<string, unknown>,
    },
  ],
};

export default manifest;
