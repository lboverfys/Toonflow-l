import type { MarkdownFiles } from "@toonflow/node-shared/markdownContent";

export interface MarkdownProps {
  modelValue: string;
  path?: string;
  files?: MarkdownFiles;
  active?: boolean;
  readonly?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  openFile?: (path: string) => Promise<void>;
  writeClipboardText?: (text: string) => Promise<void>;
}
