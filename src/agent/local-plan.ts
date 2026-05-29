export type LocalAction =
  | { type: "read-file"; filePath: string }
  | { type: "write-file"; filePath: string; content: string }
  | { type: "search"; query: string }
  | { type: "shell"; command: string }
  | { type: "git-status" };

export interface LocalPlan {
  actions: LocalAction[];
}

export function parseLocalPlan(prompt: string): LocalPlan | undefined {
  const text = prompt.trim();
  const write =
    /^(?:create|write) file (?:"([^"]+)"|(\S+)) with content (?:"([\s\S]*)"|([\s\S]*))$/i.exec(
      text
    );
  if (write) {
    return {
      actions: [
        {
          type: "write-file",
          filePath: write[1] ?? write[2],
          content: write[3] ?? write[4] ?? ""
        }
      ]
    };
  }

  const read = /^read file (?:"([^"]+)"|(\S+))$/i.exec(text);
  if (read) {
    return { actions: [{ type: "read-file", filePath: read[1] ?? read[2] }] };
  }

  const search = /^search (?:"([^"]+)"|(.+))$/i.exec(text);
  if (search) {
    return { actions: [{ type: "search", query: search[1] ?? search[2] }] };
  }

  const shell = /^(?:run command|run shell) (?:"([^"]+)"|([\s\S]+))$/i.exec(text);
  if (shell) {
    return { actions: [{ type: "shell", command: shell[1] ?? shell[2] }] };
  }

  if (/^git status$/i.test(text)) {
    return { actions: [{ type: "git-status" }] };
  }

  return undefined;
}
