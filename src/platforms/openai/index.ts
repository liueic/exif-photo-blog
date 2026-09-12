import { gateway, generateText, LanguageModel, Output, streamText } from 'ai';
import { createStreamableValue } from '@ai-sdk/rsc';
import { createOpenAI } from '@ai-sdk/openai';
import {
  AI_ACTIVE_TEXT_GENERATION_PROVIDER,
  AI_GATEWAY_MODEL,
  CLOUDBASE_AI_API_KEY,
  CLOUDBASE_AI_BASE_URL,
  CLOUDBASE_AI_MODEL,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
  OPENAI_SECRET_KEY,
} from '@/app/config';
import { removeBase64Prefix } from '@/utility/image';
import { cleanUpAiTextResponse } from '@/photo/ai';
import {
  checkRateLimitAndThrow as _checkRateLimitAndThrow,
} from '@/platforms/rate-limit';
import {
  OPENAI_MODEL_COMPATIBLE,
  OPENAI_MODEL_DEFAULT,
  OpenAIModel,
} from './models';
import {
  CLOUDBASE_AI_MODEL_DEFAULT,
  parsePromptJsonResponse,
} from '@/platforms/cloudbase-ai';
import { z } from 'zod';

const OPENAI_MODEL_ID: OpenAIModel = OPENAI_MODEL === 'compatible'
  ? OPENAI_MODEL_COMPATIBLE
  : (OPENAI_MODEL || OPENAI_MODEL_DEFAULT);

const checkRateLimitAndThrow = (isBatch?: boolean) =>
  _checkRateLimitAndThrow({
    identifier: 'ai-image-query',
    ...isBatch && { tokens: 1200, duration: '1d' },
  });

const openaiClient = OPENAI_SECRET_KEY
  ? createOpenAI({
    apiKey: OPENAI_SECRET_KEY,
    ...OPENAI_BASE_URL && { baseURL: OPENAI_BASE_URL },
  })
  : undefined;

// CloudBase AI speaks the OpenAI chat-completions protocol, so it reuses the
// same client factory — only credentials, base URL and model ids differ.
const cloudbaseAiClient = CLOUDBASE_AI_API_KEY && CLOUDBASE_AI_BASE_URL
  ? createOpenAI({
    apiKey: CLOUDBASE_AI_API_KEY,
    baseURL: CLOUDBASE_AI_BASE_URL,
  })
  : undefined;

// AI_ACTIVE_TEXT_GENERATION_PROVIDER (src/app/config.ts) is the single
// source of truth for which provider wins: explicit direct OpenAI when a
// secret key is set, else CloudBase AI when its key is present, else Vercel
// AI Gateway when a model is set, else off. `model` stays undefined when
// off, which is the no-auto-spend backstop below.
const model: LanguageModel | undefined =
  AI_ACTIVE_TEXT_GENERATION_PROVIDER === 'gateway' && AI_GATEWAY_MODEL
    ? gateway(AI_GATEWAY_MODEL)
    : AI_ACTIVE_TEXT_GENERATION_PROVIDER === 'openai'
      ? openaiClient?.(OPENAI_MODEL_ID)
      : AI_ACTIVE_TEXT_GENERATION_PROVIDER === 'cloudbase-ai'
        ? cloudbaseAiClient?.(
          CLOUDBASE_AI_MODEL || CLOUDBASE_AI_MODEL_DEFAULT,
        )
        : undefined;

// The CloudBase AI gateway does not implement `response_format:
// json_schema`, so structured generation falls back to a JSON contract in
// the prompt plus client-side schema validation.
// https://docs.cloudbase.net/ai/model/openai-sdk-access
const USE_PROMPT_JSON_OUTPUT =
  AI_ACTIVE_TEXT_GENERATION_PROVIDER === 'cloudbase-ai';

const getImageTextArgsForModel = (
  modelForQuery: LanguageModel,
  imageBase64: string,
  query: string,
): (
  Parameters<typeof streamText>[0] &
  Parameters<typeof generateText>[0]
) => ({
  model: modelForQuery,
  messages: [{
    'role': 'user',
    'content': [
      {
        'type': 'text',
        'text': query,
      }, {
        'type': 'file',
        'mediaType': 'image',
        'data': removeBase64Prefix(imageBase64),
      },
    ],
  }],
});

const getImageTextArgs = (
  imageBase64: string,
  query: string,
) => model
  ? getImageTextArgsForModel(model, imageBase64, query)
  : undefined;

export const streamOpenAiImageQuery = async (
  imageBase64: string,
  query: string,
) => {
  await checkRateLimitAndThrow();

  const stream = createStreamableValue('');

  const args = getImageTextArgs(imageBase64, query);

  if (args) {
    (async () => {
      const { textStream } = streamText(args);
      for await (const delta of textStream) {
        stream.update(cleanUpAiTextResponse(delta));
      }
      stream.done();
    })();
  }

  return stream.value;
};

export const generateOpenAiImageQuery = async (
  imageBase64: string,
  query: string,
  isBatch?: boolean,
) => {
  await checkRateLimitAndThrow(isBatch);

  const args = getImageTextArgs(imageBase64, query);

  if (args) {
    return generateText(args)
      .then(({ text }) => cleanUpAiTextResponse(text));
  }
};

const cleanUpObjectFields = <T extends z.ZodSchema>(
  output: z.infer<T>,
): z.infer<T> => Object.fromEntries(Object
  .entries(output || {})
  .map(([k, v]) => [k, cleanUpAiTextResponse(v as string)]),
) as z.infer<T>;

// Sole path to an object query, so the rate limit can't be skipped by a
// caller. Checked after the model is resolved to avoid spending a token
// on a request that was never going to be sent.
// Each mode lives in its own single-expression helper: contextual typing
// of the `output` generic relies on the call being the sole return value.
const generateImageObjectQueryViaSchema = async <T extends z.ZodSchema>(
  modelForQuery: LanguageModel,
  imageBase64: string,
  query: string,
  schema: T,
): Promise<z.infer<T>> =>
  generateText({
    ...getImageTextArgsForModel(modelForQuery, imageBase64, query),
    output: Output.object({ schema }),
    // Kept as a single tail-cast expression: the `output` generic infers
    // through this exact shape
  }).then(result => Object.fromEntries(Object
    .entries(result.output || {})
    .map(([k, v]) => [k, cleanUpAiTextResponse(v as string)]),
  ) as z.infer<T>);

const generateImageObjectQueryViaPromptJson = async <T extends z.ZodSchema>(
  modelForQuery: LanguageModel,
  imageBase64: string,
  query: string,
  schema: T,
): Promise<z.infer<T>> =>
  generateText({
    ...getImageTextArgsForModel(modelForQuery, imageBase64, [
      query,
      'Respond with ONLY a raw JSON object — no markdown fences, no '
      + 'commentary — conforming exactly to this JSON Schema:',
      JSON.stringify(z.toJSONSchema(schema)),
    ].join('\n\n')),
  }).then(({ text }) =>
    cleanUpObjectFields(parsePromptJsonResponse(text, schema)));

const generateImageObjectQuery = async <T extends z.ZodSchema>(
  modelForQuery: LanguageModel,
  imageBase64: string,
  query: string,
  schema: T,
  isBatch?: boolean,
): Promise<z.infer<T>> => {
  await checkRateLimitAndThrow(isBatch);

  return USE_PROMPT_JSON_OUTPUT
    ? generateImageObjectQueryViaPromptJson(
      modelForQuery,
      imageBase64,
      query,
      schema,
    )
    : generateImageObjectQueryViaSchema(
      modelForQuery,
      imageBase64,
      query,
      schema,
    );
};

export const generateOpenAiImageObjectQuery = async <T extends z.ZodSchema>(
  imageBase64: string,
  query: string,
  schema: T,
  isBatch?: boolean,
): Promise<z.infer<T>> => {
  if (model) {
    return generateImageObjectQuery(model, imageBase64, query, schema, isBatch);
  } else {
    throw new Error('No AI model configured');
  }
};

// Pins an explicit model id rather than the configured OPENAI_MODEL, so that
// models can be compared side-by-side. Requiring `openaiClient` keeps the
// no-auto-spend backstop intact: a secret key is what makes direct OpenAI the
// active provider in the first place. Rate limited as a batch, since a single
// comparison fans out across several models and photos.
export const generateOpenAiImageObjectQueryForModel = async <
  T extends z.ZodSchema,
>(
  imageBase64: string,
  query: string,
  schema: T,
  modelId: OpenAIModel,
): Promise<z.infer<T>> => {
  if (openaiClient) {
    return generateImageObjectQuery(
      openaiClient(modelId),
      imageBase64,
      query,
      schema,
      true,
    );
  } else {
    throw new Error('OPENAI_SECRET_KEY required to query a specific model');
  }
};

export const testOpenAiConnection = async () => {
  await checkRateLimitAndThrow();

  if (model) {
    return generateText({
      model,
      messages: [{
        'role': 'user',
        'content': [
          {
            'type': 'text',
            'text': 'Test connection',
          },
        ],
      }],
    });
  }
};
