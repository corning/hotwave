import "./env.js";
import { Model, stream, Context } from '@mariozechner/pi-ai';
import { ocrPredict } from './ocr.js';
export const getModelResult = async (promptText: string): Promise<string> => {
    return new Promise(async (resolve, reject) => {
        // 1. 配置 DeepSeek (使用 openai-completions 适配器)
        const model: Model<'openai-completions'> = {
            id: process.env.HOTWAVE_MODEL || "",             // 自定义 ID
            name: process.env.HOTWAVE_MODEL || "",             // 显示名称
            api: 'openai-completions',       // 【关键】使用 OpenAI 兼容协议
            provider: process.env.HOTWAVE_PROVIDER || "",              // 底层实现复用 openai 逻辑
            baseUrl: process.env.HOTWAVE_BASE_URL || "", // 【关键】替换为 DeepSeek 地址
            reasoning: false,
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000
        };

        const context: Context = {
            systemPrompt: '你是一个OCR识别验证码，请返回识别结果。',
            messages: [
                {
                    role: 'user',
                    content: [
                        { "type": "text", text: "这是登陆生成数字验证码，有简单的噪音干扰，里面是4位数字，无其他内容。" },
                        {
                            type: 'image', data: promptText, mimeType: 'image/png'
                        }
                    ],
                    timestamp: new Date().getTime()
                }
            ]
        };


        const s = stream(model, context, {
            apiKey: process.env.OPENAI_API_KEY || "",
            thinkingEnabled: false
        });

        for await (const event of s) {
            if (event.type === 'text_delta') {
                process.stdout.write(event.delta);
                resolve(event.delta)
            } else if (event.type === 'error') {
                // event.reason tells you if it was "error" or "aborted"
                console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
                reject(event.error)
            }
        }

        const resLLM = await s.result();

        if (resLLM.stopReason === 'aborted') {
            console.log('Request was aborted:', resLLM.errorMessage);
            console.log('Partial content received:', resLLM.content);
            console.log('Tokens used:', resLLM.usage);
            reject(resLLM.errorMessage)
        }

    });
}

// 识别结果（字段名沿用旧契约，调用方按 data.code 取值）
interface CaptchaResponse {
    success: boolean;
    code?: string;      // 识别出的验证码
    data?: any;
    msg?: string;   // 错误信息（可选）
}

/**
 * 识别验证码图片（进程内 ddddocr：spawn src/trader/captcha/worker.py，无 HTTP 服务、无端口）
 * @param base64Image - Base64 编码的图片（可带 data URL 前缀）
 * @returns 识别结果
 */
export async function recognizeCaptcha(base64Image: string): Promise<CaptchaResponse> {
    if (!base64Image || typeof base64Image !== 'string') {
        throw new Error('无效的 Base64 图片数据');
    }

    // 移除可能存在的 data URL 前缀（如 "data:image/jpeg;base64,"）
    const cleanBase64 = base64Image.replace(/^data:image\/[a-z]+;base64,/, '');

    try {
        const code = await ocrPredict(cleanBase64, { expectedLength: 4 });
        return { success: true, code, data: { code } };
    } catch (error) {
        console.error('💥 OCR 识别失败:', error instanceof Error ? error.message : String(error));
        throw error;
    }
}