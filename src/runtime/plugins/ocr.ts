/**
 * OCR 插件（进程内 ddddocr + 工具 + 可观测状态）
 *
 * 识别本体在 `src/trader/captcha/worker.py`：需要时由 TS spawn 一次性进程（见 src/common/ocr.ts），
 * 没有 HTTP 服务、没有端口、没有远程模式。
 *
 * 本插件做三件事：
 *   1. 以服务形式暴露给运行时（ctx.get('ocr')）
 *   2. 注册 ocr_captcha 工具，供 Agent 直接识别验证码图片
 *   3. 提供健康状态（供自测与排障）
 */

import { defineTool } from '../../kernel/tools.js';
import { localOcrStatus, ocrPredict } from '../../common/ocr.js';

export type OcrService = {
  base: string;
  status(): Promise<{ ok: boolean; detail?: string }>;
  recognize(imageBase64: string): Promise<string>;
};

export function createOcrPlugin(out?: any[]) {
  return {
    name: 'ocr',
    inject: ['tools'],
    async apply(ctx: any) {
      const service: OcrService = {
        base: 'python://ddddocr',
        status() {
          return localOcrStatus();
        },
        recognize(imageBase64: string) {
          return ocrPredict(String(imageBase64), { expectedLength: 4 });
        },
      };

      ctx.provide('ocr', service);

      // 首次请求会加载模型 + 动态库（新环境可能几十秒），超时给足；之后每次约 1s
      const tool = defineTool({
        name: 'ocr_captcha',
        description:
          '识别验证码图片（base64，可带 data URL 前缀），返回识别出的文本。用于实盘登录等需要打码的场景。' +
          '本地 ddddocr 进程内识别，不需要额外启动服务。',
        parameters: {
          image_base64: { type: 'string', required: true, description: '验证码图片的 base64 编码' },
        },
        output: {
          schema: { text: { type: 'string', required: true } },
          render: (_a: unknown, v: any) => [{ type: 'text' as const, text: String(v?.text ?? '') }],
        },
        timeoutMs: 120_000,
        async execute(args: any) {
          const code = await service.recognize(String(args.image_base64));
          return { text: code };
        },
      });

      ctx.get('tools').register(tool);
      out?.push(tool);
    },
  };
}
