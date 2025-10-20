import 'dotenv/config';
import { StateGraph, START, END } from '@langchain/langgraph';
import { ChatOpenAI, DallEAPIWrapper } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import * as z from 'zod';
import axios from 'axios';

const openai = new ChatOpenAI({
  model: 'gpt-4o-mini',
  temperature: 0,
  apiKey: process.env.OPENAI_API_KEY,
});

const geminiVision = new ChatGoogleGenerativeAI({
  model: 'gemini-2.0-flash',
  temperature: 0,
  maxOutputTokens: 2048,
  apiKey: process.env.GOOGLE_API_KEY,
});

const dalle = new DallEAPIWrapper({
  model: 'dall-e-3',
  apiKey: process.env.OPENAI_API_KEY,
});

const ModerationState = z.object({
  type: z.string().optional(),
  content: z.string().optional(),
  imageUrl: z.string().optional(),
  imageDescription: z.string().optional(),
  decision: z.enum(['approved', 'flagged', 'rejected']).default('approved'),
  reasoning: z.string().optional(),

  shouldReplaceImage: z.boolean().default(false),
  generatedImageBase64: z.string().optional(),
  generatedImageMime: z.string().optional(),
  generatedImageUrl: z.string().optional(),

  technicalAnalysis: z
    .object({
      toxicity: z.number().min(0).max(1).optional(),
      nsfw_text: z.boolean().optional(),
      nsfw_image: z.boolean().optional(),
      violence: z.boolean().optional(),
      image_replaced_by_ai: z.boolean().default(false).optional(),
    })
    .optional(),
  textAnalysis: z
    .object({
      summary: z.string().optional(),
    })
    .optional(),
});

async function downloadImageAsBase64(url: string): Promise<string> {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
    });
    return Buffer.from(response.data).toString('base64');
  } catch (error) {
    console.error('Failed to download image:', error);
    throw new Error('Could not download image from URL');
  }
}

async function analyzeImageNode(state: z.infer<typeof ModerationState>) {
  if (!state.imageUrl) return state;

  try {
    const imageBase64 = await downloadImageAsBase64(state.imageUrl);
    const imagePrompt = [
      new HumanMessage({
        content: [
          {
            type: 'text',
            text: 'Describe this image in detail. Identify any NSFW, violent, or inappropriate content.',
          },
          {
            type: 'image_url',
            image_url: `data:image/jpeg;base64,${imageBase64}`,
          },
        ],
      }),
    ];

    const response = await geminiVision.invoke(imagePrompt);
    return { ...state, imageDescription: response.content.toString() };
  } catch (error) {
    console.error('Image analysis error:', error);
    return { ...state, imageDescription: 'Image analysis failed' };
  }
}

async function analyzeTextNode(state: z.infer<typeof ModerationState>) {
  if (!state.content) return state;

  const systemPrompt = new SystemMessage(`
    You are a content moderation AI. Analyze this text for toxicity, hate, or NSFW content.
    Return ONLY JSON:
    {
      "toxicity": 0.5,
      "nsfw_text": false,
      "summary": "Short description"
    }
  `);

  const userPrompt = new HumanMessage(`Analyze this text: "${state.content}"`);
  const response = await openai.invoke([systemPrompt, userPrompt]);
  const raw = response.content.toString();

  try {
    const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
    const parsed = JSON.parse(jsonStr);

    return {
      ...state,
      textAnalysis: { summary: parsed.summary ?? 'No summary' },
      technicalAnalysis: {
        ...(state.technicalAnalysis || {}),
        toxicity: parsed.toxicity ?? 0.5,
        nsfw_text: parsed.nsfw_text ?? false,
      },
    };
  } catch {
    console.error('Failed to parse text analysis response:', raw);
    return {
      ...state,
      textAnalysis: { summary: 'Parsing error' },
      technicalAnalysis: {
        ...(state.technicalAnalysis || {}),
        toxicity: 0.5,
        nsfw_text: false,
      },
    };
  }
}

async function makeDecisionNode(state: z.infer<typeof ModerationState>) {
  const systemPrompt = new SystemMessage(`
    Make a final moderation decision. Return JSON:
    {
      "decision": "approved",
      "summary": "Reasoning",
      "technicalAnalysis": {"nsfw_image": false, "violence": false}
    }
  `);

  const userPrompt = new HumanMessage(`
Text: ${state.content ?? 'none'}
Image: ${state.imageDescription ?? 'none'}
Toxicity: ${state.technicalAnalysis?.toxicity ?? 0}
NSFW Text: ${state.technicalAnalysis?.nsfw_text ?? false}
  `);

  const response = await openai.invoke([systemPrompt, userPrompt]);
  const raw = response.content.toString();

  try {
    const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
    const parsed = JSON.parse(jsonStr);

    return {
      ...state,
      decision: parsed.decision ?? 'flagged',
      textAnalysis: { summary: parsed.summary ?? 'No summary' },
      technicalAnalysis: {
        ...(state.technicalAnalysis || {}),
        nsfw_image: parsed.technicalAnalysis?.nsfw_image ?? false,
        violence: parsed.technicalAnalysis?.violence ?? false,
      },
    };
  } catch {
    console.error('Decision parse error:', raw);
    return { ...state, decision: 'flagged' };
  }
}

async function evaluateImageReplacementNode(
  state: z.infer<typeof ModerationState>,
) {
  const hasImageIssues =
    state.technicalAnalysis?.nsfw_image || state.technicalAnalysis?.violence;

  return {
    ...state,
    shouldReplaceImage: Boolean(hasImageIssues),
  };
}

async function generateImageNode(state: z.infer<typeof ModerationState>) {
  if (!state.shouldReplaceImage || !state.content || !state.imageUrl)
    return state;

  try {
    const prompt = sanitizePromptForImageGeneration(state.content);
    const imageURL = await dalle.invoke(prompt);

    return {
      ...state,
      imageUrl: imageURL,
      generatedImageUrl: imageURL,
      generatedImageMime: 'image/png',
      technicalAnalysis: {
        ...(state.technicalAnalysis || {}),
        image_replaced_by_ai: true,
        nsfw_image: false,
        violence: false,
      },
    };
  } catch (err) {
    console.error('generateImageNode (DALL·E) error:', err);

    return {
      ...state,
      shouldReplaceImage: false,
      decision: 'flagged',
      generatedImageUrl: undefined,
    };
  }
}

function sanitizePromptForImageGeneration(text: string): string {
  const cleaned = text
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .substring(0, 300)
    .trim();
  return `A professional, family-friendly image based on: "${cleaned}". Safe for all audiences.`;
}

const workflow = new StateGraph(ModerationState)
  .addNode('analyze_image', analyzeImageNode)
  .addNode('analyze_text', analyzeTextNode)
  .addNode('make_decision', makeDecisionNode)
  .addNode('evaluate_image_replacement', evaluateImageReplacementNode)
  .addNode('generate_image', generateImageNode)
  .addEdge(START, 'analyze_image')
  .addEdge('analyze_image', 'analyze_text')
  .addEdge('analyze_text', 'make_decision')
  .addEdge('make_decision', 'evaluate_image_replacement')
  .addEdge('evaluate_image_replacement', 'generate_image')
  .addEdge('generate_image', END);

export const moderationAgent = workflow.compile();
