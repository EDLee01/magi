import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TempRoot {
  path: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export function makeTempRoot(prefix = "magi-next-test-"): TempRoot {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: root,
    env: {
      MAGI_CONFIG_DIR: root
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}
