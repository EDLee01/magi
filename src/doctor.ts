import { MagiConfig } from "./config.js";
import { MAGI_ENV_PREFIX, MagiPaths, RuntimeSettings } from "./paths.js";

export function formatDoctorReport(input: {
  paths: MagiPaths;
  runtime: RuntimeSettings;
  config: MagiConfig;
  legacyAccessDetected?: boolean;
}): string {
  return [
    "Magi Next doctor",
    `configRoot: ${input.paths.root}`,
    `configFile: ${input.paths.configFile}`,
    `stateRoot: ${input.paths.stateRoot}`,
    `sessionsRoot: ${input.paths.sessionsRoot}`,
    `logsRoot: ${input.paths.logsRoot}`,
    `cacheRoot: ${input.paths.cacheRoot}`,
    `pluginsRoot: ${input.paths.pluginsRoot}`,
    `skillsRoot: ${input.paths.skillsRoot}`,
    `devicesRoot: ${input.paths.devicesRoot}`,
    `controlBind: ${input.config.control.bind || input.runtime.controlBind}`,
    `controlPort: ${input.config.control.port || input.runtime.controlPort}`,
    `envPrefix: ${MAGI_ENV_PREFIX}`,
    `legacyAccessDetected: ${input.legacyAccessDetected ? "yes" : "no"}`,
    "packageBin: magi",
    ""
  ].join("\n");
}
