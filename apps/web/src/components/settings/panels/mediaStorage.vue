<template>
  <div class="mediaStorage">
    <p class="description">使用阿里云 OSS 存放视频参考素材。启用后，所选模型需要公网链接的本地图片和音频会在生成时自动上传；已有的 HTTPS 图片链接仍可直接使用。</p>
    <el-form labelPosition="top" :disabled="saving" @submit.prevent="save">
      <el-form-item label="自动上传本地参考素材">
        <el-switch v-model="form.enabled" aria-label="启用阿里云 OSS 自动上传" />
      </el-form-item>
      <div class="fieldGrid">
        <el-form-item label="地域（Region ID）">
          <el-input v-model="form.region" placeholder="cn-hangzhou" autocomplete="off" aria-label="OSS 地域" />
        </el-form-item>
        <el-form-item label="Bucket 名称">
          <el-input v-model="form.bucket" placeholder="你的存储空间名称" autocomplete="off" aria-label="OSS Bucket 名称" />
        </el-form-item>
      </div>
      <el-form-item label="公网 Endpoint（选填）">
        <el-input v-model="form.endpoint" placeholder="https://oss-cn-hangzhou.aliyuncs.com" autocomplete="off" aria-label="OSS 公网 Endpoint" />
        <p class="fieldHint">留空时按地域自动生成。填写 OSS 控制台显示的公网 HTTPS Endpoint，不包含 Bucket；目前不支持内网地址和自定义域名。</p>
      </el-form-item>
      <el-form-item label="AccessKey ID">
        <el-input v-model="form.accessKeyId" type="password" showPassword autocomplete="off" aria-label="OSS AccessKey ID" />
      </el-form-item>
      <el-form-item label="AccessKey Secret">
        <el-input v-model="form.accessKeySecret" type="password" showPassword autocomplete="new-password" aria-label="OSS AccessKey Secret" />
        <p class="fieldHint">填写仅授权该素材目录的 RAM 用户密钥。密钥保存在此应用的数据目录，由本地后端上传素材；视频供应商只收到限时下载链接。</p>
      </el-form-item>
      <div class="fieldGrid">
        <el-form-item label="素材目录">
          <el-input v-model="form.prefix" placeholder="toonflow/referenceImages" aria-label="OSS 素材目录" />
        </el-form-item>
        <el-form-item label="链接有效期（小时）">
          <el-input-number v-model="form.urlExpiryHours" :min="1" :max="168" :precision="0" controlsPosition="right" aria-label="OSS 链接有效期（小时）" />
        </el-form-item>
      </div>
      <p class="description">有效期必须覆盖视频排队和生成时间，默认 24 小时。仅上传本次引用的本地图片与音频，保持各类素材的引用顺序，引用数量以所选模型能力为准。图片支持 PNG、JPEG、WebP；音频支持 MP3、WAV、FLAC、MP4。单个本地素材最多 20 MiB，同次上传图片与音频合计最多 300 MiB，素材不压缩。</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon role="alert" />
      <div class="actions">
        <el-button type="primary" nativeType="submit" :loading="saving" :disabled="!dirty">保存设置</el-button>
        <span class="fieldHint">保存只校验配置格式；首次生成时才访问 OSS。</span>
      </div>
    </el-form>
    <el-collapse v-model="expandedSections" class="help">
      <el-collapse-item title="首次开通与权限说明" name="setup">
        <ol>
          <li>在阿里云 OSS 创建专用 Bucket，选择标准存储，访问权限设为私有。</li>
          <li>创建专用 RAM 用户，为此 Bucket 的素材目录授予 oss:PutObject 和 oss:GetObject 权限，再填写其 AccessKey。</li>
          <li>在 OSS 控制台给该素材目录配置生命周期清理。清理期限应大于链接有效期的两倍；默认 24 小时链接建议保留素材 7 天。</li>
        </ol>
        <p>链接过期不会删除云端素材。应用会缓存上传结果，在有效窗口内复用相同素材；云端文件被删除后会重新上传。OSS 按存储、请求和外网流量计费，视频生成费用由视频渠道另行收取。</p>
        <el-link href="https://help.aliyun.com/zh/oss/user-guide/share-objects" target="_blank" rel="noopener noreferrer" type="primary">查看 OSS 限时下载链接说明</el-link>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { defaultOssStorageSettings, ossStorageSchema, type OssStorageSettings } from "@toonflow/server/mediaStorage";
import { saveSettings, settings } from "@/stores/settings";
import { useExpandedKeys } from "@/lib/useTreeExpansion";

const expandedSections = useExpandedKeys("toonflow:mediaStorageSections");

const props = defineProps<{ visible: boolean }>();
const form = reactive<OssStorageSettings>({ ...defaultOssStorageSettings });
const saving = ref(false);
const error = ref("");
const saved = computed(() => ({ ...defaultOssStorageSettings, ...(settings.value.mediaStorage as Partial<OssStorageSettings> | undefined) }));
const dirty = computed(() => JSON.stringify(form) !== JSON.stringify(saved.value));

watch(() => props.visible, visible => {
  if (!visible || saving.value) return;
  Object.assign(form, saved.value);
  error.value = "";
}, { immediate: true });

async function save() {
  if (saving.value) return;
  const parsed = ossStorageSchema.safeParse(form);
  if (!parsed.success) { error.value = parsed.error.issues.map(issue => issue.message).join("；"); return; }
  saving.value = true;
  error.value = "";
  try {
    await saveSettings(() => ({ mediaStorage: parsed.data }));
    Object.assign(form, parsed.data);
    ElMessage.success("素材存储设置已保存");
  } catch {
    error.value = "素材存储设置保存失败，请检查应用连接后重试；输入内容已保留";
  } finally { saving.value = false; }
}
</script>

<style lang="scss" scoped>
.mediaStorage {
  max-width: 720px;

  .description, .fieldHint {
    color: var(--el-text-color-secondary);
    line-height: 1.7;
    margin: 0 0 16px;
  }

  .fieldHint {
    font-size: 12px;
    margin: 6px 0 0;
  }

  .fieldGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 16px 0 24px;
  }

  .help {
    line-height: 1.8;

    ol { padding-left: 24px; }
    li { margin-bottom: 8px; }
  }

  @media (max-width: 700px) {
    .fieldGrid { grid-template-columns: 1fr; gap: 0; }
  }
}
</style>
