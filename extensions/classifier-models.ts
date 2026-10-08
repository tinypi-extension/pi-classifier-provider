/**
 * Pi extension entry: register TypeSafe System One classifier models from
 * `~/.pi/agent/classifier-models.json` (SPEC §6.2).
 *
 * - Loads the config at the fixed default path.
 * - Registers one pi provider per config entry.
 * - Missing file: warns and no-ops, so pi keeps starting.
 * - Invalid config: throws `<file>: <path>: <reason>` to fail loudly through pi.
 *
 * The optional second `configPath` parameter is a documented test seam; pi
 * calls the factory with only `pi`, so the fixed default applies.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFromConfig } from "../src/register.js";

export default async function classifierModels(
	pi: ExtensionAPI,
	configPath?: string,
): Promise<void> {
	await registerFromConfig(pi, configPath);
}
