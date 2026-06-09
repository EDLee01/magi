#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { sshFileRead, sshFileWrite } from "../dist/ssh/file.js";

const ssh = findExecutable("ssh");
const sshd = findExecutable("sshd");
const sshKeygen = findExecutable("ssh-keygen");
if (!ssh || !sshd || !sshKeygen) {
  throw new Error("ssh-localhost smoke requires ssh, sshd, and ssh-keygen");
}

const root = mkdtempSync(path.join(os.tmpdir(), "magi-real-ssh-"));
const binDir = path.join(root, "bin");
const clientKey = path.join(root, "id_ed25519");
const hostKey = path.join(root, "ssh_host_ed25519_key");
const authorizedKeys = path.join(root, "authorized_keys");
const knownHosts = path.join(root, "known_hosts");
const configFile = path.join(root, "sshd_config");
const logFile = path.join(root, "sshd.log");
const pidFile = path.join(root, "sshd.pid");
const port = await reservePort();
let daemon;
const previousPath = process.env.PATH;

try {
  mkdirSync(binDir, { mode: 0o700 });
  run(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
  run(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  copyFileSync(`${clientKey}.pub`, authorizedKeys);
  chmodSync(clientKey, 0o600);
  chmodSync(authorizedKeys, 0o600);

  writeFileSync(
    configFile,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      `PidFile ${pidFile}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "UsePAM no",
      "StrictModes no",
      "LogLevel ERROR",
      ""
    ].join("\n"),
    "utf8"
  );
  run(sshd, ["-t", "-f", configFile]);

  const sshWrapper = path.join(binDir, "ssh");
  writeFileSync(
    sshWrapper,
    [
      "#!/bin/sh",
      `exec ${quoteShell(ssh)} -i ${quoteShell(clientKey)} -o IdentitiesOnly=yes -o UserKnownHostsFile=${quoteShell(knownHosts)} "$@"`,
      ""
    ].join("\n"),
    "utf8"
  );
  chmodSync(sshWrapper, 0o700);
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  daemon = spawn(sshd, ["-D", "-f", configFile, "-E", logFile], {
    stdio: "ignore"
  });
  await waitForSsh({ wrapper: sshWrapper, port, user: os.userInfo().username, daemon });

  const remotePath = path.join(root, "remote-'$(touch injected).txt");
  writeFileSync(remotePath, "before\n", "utf8");
  const connection = {
    host: "127.0.0.1",
    user: os.userInfo().username,
    port
  };
  const read = await sshFileRead({ ...connection, path: remotePath });
  const content = "after 世界\n";
  const write = await sshFileWrite({ ...connection, path: remotePath, content });

  assert(read.content === "before\n", "remote read content mismatch");
  assert(read.sizeBytes === Buffer.byteLength("before\n"), "remote read byte count mismatch");
  assert(write.sizeBytes === Buffer.byteLength(content), "remote write byte count mismatch");
  assert(readFileSync(remotePath, "utf8") === content, "remote write content mismatch");
  assert(!existsSync(path.join(root, "injected")), "remote path executed shell substitution");

  console.log(
    JSON.stringify({
      status: "passed",
      protocol: "real-localhost-sshd",
      readBytes: read.sizeBytes,
      writeBytes: write.sizeBytes
    })
  );
} catch (error) {
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8").trim() : "";
  if (log) console.error(log);
  throw error;
} finally {
  process.env.PATH = previousPath;
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("exit", resolve));
  }
  rmSync(root, { recursive: true, force: true });
}

function findExecutable(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("failed to reserve a localhost port");
  return port;
}

async function waitForSsh({ wrapper, port, user, daemon }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (daemon.exitCode !== null) {
      throw new Error(`sshd exited before readiness with code ${daemon.exitCode}`);
    }
    const result = spawnSync(
      wrapper,
      [
        "-p",
        String(port),
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=1",
        `${user}@127.0.0.1`,
        "true"
      ],
      { encoding: "utf8" }
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("temporary localhost sshd did not become ready");
}

function quoteShell(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
