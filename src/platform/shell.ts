export interface ShellInvocation {
  executable: string;
  args: string[];
  displayName: string;
}

export function createShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform
): ShellInvocation {
  if (platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      displayName: "PowerShell"
    };
  }
  return {
    executable: "bash",
    args: ["-lc", command],
    displayName: "Bash"
  };
}

export function shellDisplayName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "PowerShell" : "Bash";
}

export function isWindowsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}
