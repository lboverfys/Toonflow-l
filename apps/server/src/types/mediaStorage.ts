import { z } from "zod";

export const defaultOssStorageSettings = {
  enabled: false,
  region: "",
  bucket: "",
  endpoint: "",
  accessKeyId: "",
  accessKeySecret: "",
  prefix: "toonflow/referenceImages",
  urlExpiryHours: 24,
};

export const ossStorageSchema = z.strictObject({
  enabled: z.boolean(),
  region: z.string().trim().max(64).refine(value => !value || /^(?!oss-)[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(value), "地域请填写 cn-hangzhou 等 Region ID，不包含 oss-"),
  bucket: z.string().trim().max(63).refine(value => !value || /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value), "Bucket 名称须为 3～63 位小写字母、数字或短横线，首尾不能是短横线"),
  endpoint: z.string().trim().max(512).refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && /^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)
        && !url.hostname.endsWith("-internal.aliyuncs.com") && !url.port && url.pathname === "/"
        && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, "Endpoint 请填写 OSS 公网 HTTPS 地址，不包含 Bucket、路径或查询参数；不支持内网地址和自定义域名"),
  accessKeyId: z.string().trim().max(128).refine(value => !value || /^[a-zA-Z0-9]+$/.test(value), "AccessKey ID 不能包含空格或其他符号"),
  accessKeySecret: z.string().trim().max(256),
  prefix: z.string().trim().min(1).max(512).refine(value => !/[\\\u0000-\u001f\u007f]/.test(value)
    && value.split("/").every(part => part && part !== "." && part !== ".."), "素材目录不能以 / 开头或结尾，不能包含空目录、反斜线或 .."),
  urlExpiryHours: z.number().int().min(1).max(168),
}).superRefine((value, context) => {
  if (!value.enabled) return;
  for (const [field, label] of [["region", "地域"], ["bucket", "Bucket 名称"], ["accessKeyId", "AccessKey ID"], ["accessKeySecret", "AccessKey Secret"]] as const) {
    if (!value[field]) context.addIssue({ code: "custom", path: [field], message: `启用 OSS 前请填写${label}` });
  }
});

export type OssStorageSettings = z.infer<typeof ossStorageSchema>;
