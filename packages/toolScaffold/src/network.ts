import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  privateAddresses.addSubnet(address, prefix, "ipv6");
}
const lookups = new Map<string, Promise<LookupAddress[]>>();

export async function resolveWebAddresses(url: URL, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("仅支持不含账号密码的 HTTP/HTTPS 网页地址");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  let addresses: { address: string; family: number }[];
  if (family) addresses = [{ address: hostname, family }];
  else {
    let pending = lookups.get(hostname);
    if (!pending) {
      pending = lookup(hostname, { all: true, verbatim: true }).finally(() => { lookups.delete(hostname); });
      lookups.set(hostname, pending);
    }
    addresses = await pending;
  }
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some(item => privateAddresses.check(item.address, item.family === 4 ? "ipv4" : "ipv6"))) {
    throw new Error("默认禁止访问本机、内网及云元数据地址；如确有需要，请在工具配置中开启内网访问");
  }
  // ACT: 保留 198.18.0.0/15 以兼容 TUN Fake-IP；代理最终转发目标仍由代理自身控制。
  return addresses;
}
