import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TempRoot {
  path: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export function makeTempRoot(prefix = "magi-next-test-"): TempRoot {
  // realpath the temp dir so the path matches what the code reports after its
  // own realpathSync (on macOS /var is a symlink to /private/var; without this
  // tests comparing cwd or reading hook-written files fail with /private/var).
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  return {
    path: root,
    env: {
      MAGI_CONFIG_DIR: root
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}
