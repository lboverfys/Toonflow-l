import type { Request } from "express";
import { getMobileLinkDevice, isMobileLinkRequest } from "@/utils/mobileLink";

type PresenceState = { clientId: string; sessionId: string; panel: "canvas" | "document"; path: string; active: boolean; visible: boolean; leave?: boolean };
type Member = { id: string; name: string; panel: "canvas" | "document"; path: string; active: boolean; visible: boolean };
type Session = Member & { seenAt: number };
const workspaces = new Map<string, Map<string, Session>>();
const expiresAfter = 45000;

function removeExpired(now: number) {
  for (const [directory, sessions] of workspaces) {
    for (const [id, session] of sessions) if (now - session.seenAt >= expiresAfter) sessions.delete(id);
    if (!sessions.size) workspaces.delete(directory);
  }
}

// ACT: 在线状态只驻留单进程，心跳过期后回收；多进程部署时再迁移至共享存储。
setInterval(() => removeExpired(Date.now()), 15000).unref();

export function updatePresence(req: Request, directory: string, state: PresenceState) {
  const now = Date.now();
  removeExpired(now);
  const device = getMobileLinkDevice(req);
  if (isMobileLinkRequest(req) && !device) throw Object.assign(new Error("设备授权已撤销"), { status: 401 });
  const selfId = device ? `device:${device.id}` : `browser:${state.clientId}`;
  const key = process.platform === "win32" ? directory.toLowerCase() : directory;
  const sessions = workspaces.get(key) ?? new Map<string, Session>();
  const sessionId = `${selfId}:${state.sessionId}`;
  if (state.leave) sessions.delete(sessionId);
  else {
    if (!sessions.has(sessionId) && sessions.size >= 256) throw Object.assign(new Error("当前项目的在线会话过多，请关闭不使用的页面后重试"), { status: 429 });
    sessions.set(sessionId, {
      id: selfId,
      name: device?.name || `浏览器 ${state.clientId.slice(0, 4)}`,
      panel: state.panel,
      path: state.path,
      visible: state.visible,
      active: state.visible && state.active,
      seenAt: now,
    });
  }
  if (sessions.size) workspaces.set(key, sessions);
  else workspaces.delete(key);
  const members = new Map<string, Member>();
  // 优先显示仍在操作的页面，同一设备/浏览器的多个标签页合计一人。
  for (const session of [...sessions.values()].sort((a, b) => a.seenAt - b.seenAt)) {
    const { seenAt, ...member } = session;
    member.active &&= now - seenAt < 20000;
    const previous = members.get(member.id);
    if (!previous || member.active || (!previous.active && (member.visible || !previous.visible))) members.set(member.id, member);
  }
  return { selfId, members: [...members.values()] };
}
