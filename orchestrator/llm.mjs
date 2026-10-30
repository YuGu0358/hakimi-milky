import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {generateText} from 'ai';

const MAX_OUTPUT_TOKENS = 1000;

// Uses the same OpenAI-compatible settings as the starter's agent, read from the same variables.
export function createGenerate({
  baseURL = process.env.ZAI_BASE_URL,
  apiKey = process.env.ZAI_API_KEY,
  model = process.env.ZAI_MODEL,
} = {}) {
  if (!baseURL || !apiKey || !model) throw new Error('Set ZAI_BASE_URL, ZAI_API_KEY and ZAI_MODEL');
  const provider = createOpenAICompatible({name: 'planner', baseURL, apiKey});
  return async ({instructions, prompt}) => {
    const {text} = await generateText({
      model: provider.chatModel(model),
      instructions,
      prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    return text;
  };
}
