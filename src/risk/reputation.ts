/**
 * Lightweight in-memory IP reputation list.
 * Supports exact IPv4 matches and CIDR blocks (/8 to /32).
 *
 * Compatible with MaxMind GeoLite2 anonymous IP CSV exports and any
 * newline-delimited list of IPs or CIDR ranges.
 */
export class ReputationList {
  private exact = new Set<string>();
  /** [networkInt, maskInt][] */
  private cidrs: Array<[number, number]> = [];

  add(entry: string): void {
    entry = entry.trim();
    if (!entry || entry.startsWith("#")) return;

    if (entry.includes("/")) {
      const parsed = parseCidr(entry);
      if (parsed) this.cidrs.push(parsed);
    } else {
      this.exact.add(entry);
    }
  }

  /** Load from a newline-delimited string (e.g. file contents) */
  loadText(text: string): void {
    for (const line of text.split("\n")) this.add(line);
  }

  contains(ip: string): boolean {
    if (this.exact.has(ip)) return true;
    const n = ipToInt(ip);
    if (n === null) return false;
    for (const [network, mask] of this.cidrs) {
      if (((n & mask) >>> 0) === network) return true;
    }
    return false;
  }

  size(): number {
    return this.exact.size + this.cidrs.length;
  }

  clear(): void {
    this.exact.clear();
    this.cidrs = [];
  }
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const byte = parseInt(p, 10);
    if (isNaN(byte) || byte < 0 || byte > 255) return null;
    n = (n << 8) | byte;
  }
  return n >>> 0;
}

function parseCidr(cidr: string): [number, number] | null {
  const [ipPart, prefixPart] = cidr.split("/");
  const prefix = parseInt(prefixPart, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  const n = ipToInt(ipPart);
  if (n === null) return null;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return [(n & mask) >>> 0, mask];
}
