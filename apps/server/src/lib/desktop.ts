import type { Request, Response, NextFunction } from "express";
import { error } from "@/lib/responseFormat";

export function isLocalSocket(req: Request) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
}

export function isLocalHost(req: Request) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname);
}

export function isSameOrigin(req: Request, protocol = req.protocol) {
  const localOrigin = `${protocol}://${req.get("host")}`;
  const origin = req.get("origin");
  // ACT: WebView2 可能省略 Origin；仅缺失时使用带路径分隔符的同源 Referer。
  return origin === undefined ? req.get("referer")?.startsWith(`${localOrigin}/`) === true : origin === localOrigin;
}

export default function desktopRequest(req: Request, res: Response, next: NextFunction) {
  if (!req.app.locals.desktop) return res.status(404).json(error("此接口仅在桌面客户端中可用", null, 404));
  if (req.method !== "POST") return next();
  // ACT: 桌面网关固定使用 HTTP 和 127.0.0.1，不放宽为独立服务的主机集合。
  if (req.hostname !== "127.0.0.1" || !isSameOrigin(req, "http") || req.get("x-toonflow-desktop") !== "1") {
    return res.status(403).json(error("仅允许桌面页面发起操作。", null, 403));
  }
  next();
}
