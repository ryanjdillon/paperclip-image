import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

// The worker preset bundles the SDK, so dist/ needs no node_modules on the server.
const presets = createPluginBundlerPresets();
await Promise.all([esbuild.build(presets.esbuild.worker), esbuild.build(presets.esbuild.manifest)]);
