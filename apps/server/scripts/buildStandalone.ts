import { $ } from "bun";
import { readdir, rm } from "@toonflow/file";
import { resolve } from "node:path";
import { availableParallelism } from "node:os";

const projectDir = resolve(import.meta.dirname, "../../..");
// ACT: 最多并行四个独立构建，限制 Vite/Bun 的内存峰值；更高并发需按构建机内存实测。
const concurrency = Math.min(4, availableParallelism());

// ACT: Bun 1.3.14 在 Linux 的 --filter 会误读小驼峰目录；修复后可复用根目录的批量构建命令。
for (const group of ["nodes", "tools", "ext"]) {
  const groupDirectory = resolve(projectDir, "packages", group);
  await rm(resolve(projectDir, "build", group), { recursive: true, force: true });
  const entries = (await readdir(groupDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory());
  for (let offset = 0; offset < entries.length; offset += concurrency) {
    const results = await Promise.allSettled(entries.slice(offset, offset + concurrency).map(async entry => {
      const result = await $`${process.execPath} run build`.cwd(resolve(groupDirectory, entry.name))
        .env({ ...process.env, NODE_ENV: "production" }).quiet().nothrow();
      if (result.exitCode !== 0) {
        console.error(`[${group}/${entry.name}]\n${result.stdout.toString()}${result.stderr.toString()}`);
        throw new Error(`插件构建失败：${group}/${entry.name}`);
      }
    }));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "插件构建失败，已等待当前批次结束");
  }
}

await $`${process.execPath} run build`.cwd(resolve(projectDir, "apps/web"));
await $`${process.execPath} run build`.cwd(resolve(projectDir, "apps/server"));
