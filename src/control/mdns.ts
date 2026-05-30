/**
 * Minimal mDNS / DNS-SD responder + browser.
 *
 * Advertises a `_magi._tcp.local.` service on the LAN so phones and other
 * Magi instances can discover this daemon. Also browses for peers.
 *
 * This is a deliberately small implementation: it only handles the subset
 * of mDNS / DNS-SD needed to advertise and discover `_magi._tcp` services
 * with TXT records. It does not aim to be a full mDNS stack.
 */

import * as dgram from "node:dgram";
import { networkInterfaces } from "node:os";

const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE_TYPE = "_magi._tcp.local.";

export interface MdnsServiceRecord {
  /** Hostname (e.g. "alice-mac.local.") */
  hostname: string;
  /** Instance name (e.g. "alice-mac (magi)") */
  instanceName: string;
  /** TCP port the daemon listens on */
  port: number;
  /** TXT record key/value pairs (e.g. version, capabilities) */
  txt: Record<string, string>;
}

export interface DiscoveredPeer {
  hostname: string;
  instanceName: string;
  address: string;
  port: number;
  txt: Record<string, string>;
  lastSeen: number;
}

export interface MdnsAdvertiseHandle {
  stop: () => void;
}

export interface MdnsBrowserHandle {
  peers: () => DiscoveredPeer[];
  stop: () => void;
}

/**
 * Start advertising this daemon on the LAN.
 */
export function advertiseMdns(record: MdnsServiceRecord): MdnsAdvertiseHandle {
  const debug = process.env.MAGI_DEBUG_MDNS === "1";
  const log = (msg: string) => {
    if (debug) process.stderr.write(`[mdns:advertise] ${msg}\n`);
  };
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("error", (err) => {
    log(`socket error: ${err.message}`);
  });

  socket.on("message", (msg, rinfo) => {
    try {
      const query = parseDnsMessage(msg);
      if (
        !query.questions.some(
          (q) => q.name === SERVICE_TYPE && (q.type === 12 /* PTR */ || q.type === 255) /* ANY */
        )
      ) {
        return;
      }
      log(`got query from ${rinfo.address}:${rinfo.port}`);
      const reply = buildResponse(record);
      // Reply via unicast to the source port (not always 5353 — browsers may
      // use ephemeral ports). Also send to multicast for promiscuous browsers.
      socket.send(reply, rinfo.port, rinfo.address);
      socket.send(reply, MDNS_PORT, MDNS_ADDR);
    } catch (error) {
      log(`error handling query: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  socket.bind(MDNS_PORT, () => {
    try {
      socket.setMulticastLoopback(true);
      socket.addMembership(MDNS_ADDR);
      log(`bound to ${MDNS_PORT}, joined ${MDNS_ADDR}`);
      // Send unsolicited announcement (so peers discover us without querying)
      const announce = buildResponse(record);
      socket.send(announce, MDNS_PORT, MDNS_ADDR);
      // Re-announce a couple of times so late-joining browsers catch it
      const interval = setInterval(() => {
        try {
          socket.send(announce, MDNS_PORT, MDNS_ADDR);
        } catch {}
      }, 1000);
      interval.unref?.();
      socket.once("close", () => clearInterval(interval));
    } catch (error) {
      log(`bind/membership error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return {
    stop: () => {
      try {
        socket.close();
      } catch {}
    }
  };
}

/**
 * Browse for `_magi._tcp.local.` services on the LAN.
 *
 * The browser binds to a random port (not 5353) so it can coexist with a
 * running mDNS responder on the same host. It sends queries to the multicast
 * address and listens for responses on its own port.
 */
export function browseMdns(
  input: { onPeer?: (peer: DiscoveredPeer) => void } = {}
): MdnsBrowserHandle {
  const debug = process.env.MAGI_DEBUG_MDNS === "1";
  const log = (msg: string) => {
    if (debug) process.stderr.write(`[mdns:browse] ${msg}\n`);
  };
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const peers = new Map<string, DiscoveredPeer>();

  socket.on("error", (err) => {
    log(`socket error: ${err.message}`);
  });

  socket.on("message", (msg, rinfo) => {
    try {
      const parsed = parseDnsMessage(msg);
      const found = collectPeerFromAnswers(parsed, rinfo.address);
      if (!found) return;
      const key = `${found.instanceName}@${found.address}:${found.port}`;
      peers.set(key, { ...found, lastSeen: Date.now() });
      log(`found peer ${found.instanceName} at ${found.address}:${found.port}`);
      input.onPeer?.(peers.get(key)!);
    } catch (error) {
      log(
        `error handling response from ${rinfo.address}:${rinfo.port}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Bind to a random port (0). Multicast queries still go to 224.0.0.251:5353.
  socket.bind(0, () => {
    try {
      socket.setMulticastLoopback(true);
      // Send the PTR query to the mDNS multicast address.
      const query = buildPtrQuery(SERVICE_TYPE);
      const sendQuery = () => {
        for (const address of [MDNS_ADDR, ...localMdnsProbeAddresses()]) {
          socket.send(query, MDNS_PORT, address, (error) => {
            if (error) log(`query send to ${address} failed: ${error.message}`);
          });
        }
      };
      sendQuery();
      // Re-send a couple of times to catch peers that were briefly busy.
      const interval = setInterval(() => {
        try {
          sendQuery();
        } catch {}
      }, 750);
      interval.unref?.();
      socket.once("close", () => clearInterval(interval));
    } catch (error) {
      log(`bind/query error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return {
    peers: () => [...peers.values()],
    stop: () => {
      try {
        socket.close();
      } catch {}
    }
  };
}

/** Get this machine's likely hostname for advertisement. */
export function getLocalHostname(): string {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        // Use the first non-loopback IPv4 as a fallback hostname seed
        const base = (process.env.HOSTNAME || "").trim() || (process.env.HOST || "").trim();
        return base
          ? base.endsWith(".local.")
            ? base
            : `${base}.local.`
          : `magi-${iface.address.replace(/\./g, "-")}.local.`;
      }
    }
  }
  return "magi.local.";
}

// --- DNS message encoding/decoding ---

interface DnsQuestion {
  name: string;
  type: number;
  klass: number;
}

interface DnsRecord {
  name: string;
  type: number;
  klass: number;
  ttl: number;
  data: Buffer;
}

interface DnsMessage {
  id: number;
  flags: number;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
}

function parseDnsMessage(buf: Buffer): DnsMessage {
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const nsCount = buf.readUInt16BE(8);
  const arCount = buf.readUInt16BE(10);
  let off = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qdCount; i++) {
    const { name, offset } = readName(buf, off);
    const type = buf.readUInt16BE(offset);
    const klass = buf.readUInt16BE(offset + 2);
    questions.push({ name, type, klass });
    off = offset + 4;
  }
  const readRecords = (count: number): DnsRecord[] => {
    const records: DnsRecord[] = [];
    for (let i = 0; i < count; i++) {
      const { name, offset } = readName(buf, off);
      const type = buf.readUInt16BE(offset);
      const klass = buf.readUInt16BE(offset + 2);
      const ttl = buf.readUInt32BE(offset + 4);
      const rdLength = buf.readUInt16BE(offset + 8);
      const data = buf.slice(offset + 10, offset + 10 + rdLength);
      records.push({ name, type, klass, ttl, data });
      off = offset + 10 + rdLength;
    }
    return records;
  };
  const answers = readRecords(anCount);
  const authorities = readRecords(nsCount);
  const additionals = readRecords(arCount);
  return { id, flags, questions, answers, authorities, additionals };
}

function readName(buf: Buffer, offset: number): { name: string; offset: number } {
  const labels: string[] = [];
  let cursor = offset;
  let jumped = false;
  let originalCursor = offset;
  for (let i = 0; i < 256; i++) {
    if (cursor >= buf.length) break;
    const len = buf[cursor];
    if (len === 0) {
      cursor += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      // Pointer
      const ptr = ((len & 0x3f) << 8) | buf[cursor + 1];
      if (!jumped) originalCursor = cursor + 2;
      cursor = ptr;
      jumped = true;
      continue;
    }
    cursor += 1;
    labels.push(buf.slice(cursor, cursor + len).toString("utf8"));
    cursor += len;
  }
  return { name: labels.join(".") + ".", offset: jumped ? originalCursor : cursor };
}

function writeName(name: string): Buffer {
  // Strip trailing dot
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  if (!trimmed) return Buffer.from([0]);
  const labels = trimmed.split(".");
  const parts: Buffer[] = [];
  for (const label of labels) {
    const data = Buffer.from(label, "utf8");
    parts.push(Buffer.from([data.length]));
    parts.push(data);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function buildPtrQuery(serviceType: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id
  header.writeUInt16BE(0, 2); // flags (standard query)
  header.writeUInt16BE(1, 4); // qdcount
  // anCount, nsCount, arCount = 0
  const name = writeName(serviceType);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt16BE(12, 0); // type = PTR
  trailer.writeUInt16BE(1, 2); // class = IN
  return Buffer.concat([header, name, trailer]);
}

function buildResponse(record: MdnsServiceRecord): Buffer {
  const instanceFqdn = `${record.instanceName}.${SERVICE_TYPE}`;
  const hostname = record.hostname;
  // Header: response, AA bit set, qd=0, an=4 (PTR, SRV, TXT, A)
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8400, 2); // QR=1, AA=1
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(4, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const records: Buffer[] = [];

  // PTR _magi._tcp.local. -> instance
  records.push(buildRecord(SERVICE_TYPE, 12, 1, 4500, writeName(instanceFqdn)));

  // SRV instance -> host:port
  const srvData = Buffer.alloc(6);
  srvData.writeUInt16BE(0, 0); // priority
  srvData.writeUInt16BE(0, 2); // weight
  srvData.writeUInt16BE(record.port, 4);
  records.push(
    buildRecord(instanceFqdn, 33, 1, 4500, Buffer.concat([srvData, writeName(hostname)]))
  );

  // TXT
  const txtParts: Buffer[] = [];
  for (const [k, v] of Object.entries(record.txt)) {
    const entry = Buffer.from(`${k}=${v}`, "utf8");
    txtParts.push(Buffer.from([entry.length]));
    txtParts.push(entry);
  }
  if (txtParts.length === 0) {
    txtParts.push(Buffer.from([0]));
  }
  records.push(buildRecord(instanceFqdn, 16, 1, 4500, Buffer.concat(txtParts)));

  // A record (host -> IPv4)
  const ip = pickLocalIPv4();
  if (ip) {
    const octets = ip.split(".").map(Number);
    records.push(buildRecord(hostname, 1, 1, 120, Buffer.from(octets)));
  }

  return Buffer.concat([header, ...records]);
}

function buildRecord(name: string, type: number, klass: number, ttl: number, data: Buffer): Buffer {
  const nameBuf = writeName(name);
  const trailer = Buffer.alloc(10);
  trailer.writeUInt16BE(type, 0);
  trailer.writeUInt16BE(klass, 2);
  trailer.writeUInt32BE(ttl, 4);
  trailer.writeUInt16BE(data.length, 8);
  return Buffer.concat([nameBuf, trailer, data]);
}

function pickLocalIPv4(): string | undefined {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return undefined;
}

function localMdnsProbeAddresses(): string[] {
  const addresses = new Set<string>(["127.0.0.1"]);
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && iface.address !== "0.0.0.0") {
        addresses.add(iface.address);
      }
    }
  }
  return [...addresses];
}

function collectPeerFromAnswers(msg: DnsMessage, fallbackAddr: string): DiscoveredPeer | undefined {
  // Look for our service type in any record set.
  const all = [...msg.answers, ...msg.additionals, ...msg.authorities];
  let instanceName: string | undefined;
  let hostname: string | undefined;
  let port: number | undefined;
  let txt: Record<string, string> = {};
  let address: string | undefined;
  for (const rec of all) {
    if (rec.type === 12 /* PTR */ && rec.name === SERVICE_TYPE) {
      const { name } = readName(rec.data, 0);
      // name = "instance._magi._tcp.local."
      const stripped = name.replace(`.${SERVICE_TYPE}`, "");
      instanceName = stripped;
    }
    if (rec.type === 33 /* SRV */) {
      port = rec.data.readUInt16BE(4);
      const { name } = readName(rec.data, 6);
      hostname = name;
    }
    if (rec.type === 16 /* TXT */) {
      let off = 0;
      while (off < rec.data.length) {
        const len = rec.data[off];
        off += 1;
        const entry = rec.data.slice(off, off + len).toString("utf8");
        off += len;
        const eq = entry.indexOf("=");
        if (eq > 0) {
          txt[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      }
    }
    if (rec.type === 1 /* A */ && rec.data.length === 4) {
      address = `${rec.data[0]}.${rec.data[1]}.${rec.data[2]}.${rec.data[3]}`;
    }
  }
  if (!instanceName || !port) return undefined;
  return {
    hostname: hostname ?? "unknown.local.",
    instanceName,
    address: address ?? fallbackAddr,
    port,
    txt,
    lastSeen: Date.now()
  };
}
