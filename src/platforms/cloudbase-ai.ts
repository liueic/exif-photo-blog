import type { OpenAIModel } from '@/platforms/openai/models';
import { z } from 'zod';

// CloudBase AI models are called through the OpenAI-compatible gateway
// (see src/platforms/openai) and are therefore typed with the same permissive
// model-id type: ids newer than this curated list stay valid at the type
// level and are only rejected by the gateway at runtime.
export type CloudbaseAiModel = OpenAIModel;

// `hy3` is the Hunyuan text model bundled with the environment's free AI
// resource pack (legacy hunyuan ids auto-switch to it) and is the only
// reliably available model on the gateway — hence the default.
//
// NOTE: hy3 is text-only. Every AI feature in this app is a vision task
// (photo → title/caption/tags/semantic), and per the multimodal docs a
// text model "ignores or errors" on image input — generation attempts fail
// gracefully (uploads are unaffected) until a vision model below is
// actually enabled for the environment in the CloudBase console.
// https://docs.cloudbase.net/ai/model/multimodal
export const CLOUDBASE_AI_MODEL_DEFAULT: CloudbaseAiModel = 'hy3';

// Vision-capable ids from the multimodal docs. Availability is governed by
// the console (several series carry offline notices) — verify before use.
export const CLOUDBASE_AI_MODELS_SELECTABLE: CloudbaseAiModel[] = [
  'hy3',
  'glm-5v-turbo',
  'qwen3.5-plus',
  'kimi-k2.6',
  'kimi-k2.5',
];

// The CloudBase AI gateway does not implement `response_format:
// json_schema`, so structured generation runs on a JSON contract in the
// prompt plus client-side schema validation. Markdown fences are tolerated
// because vision models frequently wrap JSON in them despite instructions.
// https://docs.cloudbase.net/ai/model/openai-sdk-access
export const parsePromptJsonResponse = <T extends z.ZodSchema>(
  raw: string,
  schema: T,
): z.infer<T> => {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(
      'AI provider returned non-JSON output for a structured query',
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `AI output failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
};
