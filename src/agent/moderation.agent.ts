import 'dotenv/config';
import { StateGraph, START, END } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
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

const ModerationState = z.object({
  type: z.string().optional(),
  content: z.string().optional(),
  imageUrl: z.string().optional(),
  imageDescription: z.string().optional(),
  decision: z.enum(['approved', 'flagged', 'rejected']).default('approved'),
  reasoning: z.string().optional(),
  shouldReplaceImage: z.boolean().default(false),
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

async function analyzeImageNode(
  state: z.infer<typeof ModerationState>,
): Promise<z.infer<typeof ModerationState>> {
  if (!state.imageUrl) {
    return state;
  }

  try {
    const imageBase64 = await downloadImageAsBase64(state.imageUrl);

    const imagePrompt = [
      new HumanMessage({
        content: [
          {
            type: 'text',
            text: 'Describe this image in detail. What do you see? Identify any potentially problematic content (violence, NSFW, harmful elements). Keep description concise and factual.',
          },
          {
            type: 'image_url',
            image_url: `data:image/jpeg;base64,${imageBase64}`,
          },
        ],
      }),
    ];

    const response = await geminiVision.invoke(imagePrompt);
    const description = response.content.toString();

    return {
      ...state,
      imageDescription: description,
    };
  } catch (error) {
    console.error('Image analysis error:', error);
    return {
      ...state,
      imageDescription: 'Image analysis failed',
    };
  }
}

async function analyzeTextNode(
  state: z.infer<typeof ModerationState>,
): Promise<z.infer<typeof ModerationState>> {
  if (!state.content) {
    return state;
  }

  const systemPrompt = new SystemMessage(`
    You are a content moderation AI. Analyze the provided text for toxicity, profanity, hate speech, and harmful content.
    
    You MUST return ONLY this exact JSON format with no additional text:
    {
      "toxicity": 0.5,
      "nsfw_text": false,
      "summary": "Brief assessment of the text content"
    }
    
    IMPORTANT: Toxicity must be between 0 and 1.
    - 0-0.3: Safe content
    - 0.3-0.7: Questionable content
    - 0.7-1.0: Harmful content
  `);

  const userPrompt = new HumanMessage(
    `Analyze this text for moderation: "${state.content}"`,
  );

  const response = await openai.invoke([systemPrompt, userPrompt]);
  const raw = response.content.toString();

  let parsed: any = {};

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0] : raw;
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    console.error('Failed to parse text analysis response:', raw);
    parsed = {
      toxicity: 0.5,
      nsfw_text: false,
      summary: 'Text analysis error',
    };
  }

  return {
    ...state,
    textAnalysis: {
      summary: parsed.summary || 'No summary',
    },
    technicalAnalysis: {
      ...(state.technicalAnalysis || {}),
      toxicity: typeof parsed.toxicity === 'number' ? parsed.toxicity : 0.5,
      nsfw_text: Boolean(parsed.nsfw_text),
    },
  };
}

async function makeDecisionNode(
  state: z.infer<typeof ModerationState>,
): Promise<z.infer<typeof ModerationState>> {
  const systemPrompt = new SystemMessage(`
    You are a content moderation AI. Make a final decision based on all analysis.
    
    You MUST return ONLY this exact JSON format with no additional text:
    {
      "decision": "approved",
      "summary": "2-3 sentence detailed explanation of what was found and why the decision was made",
      "technicalAnalysis": {
        "nsfw_image": false,
        "violence": false
      }
    }
    
    Guidelines:
    - If toxicity < 0.3 AND no nsfw/violence = approved
    - If toxicity 0.3-0.7 OR nsfw/violence flagged = flagged
    - If toxicity > 0.7 OR nsfw/violence serious = rejected
    
    Summary should include:
    - What type of content was detected (text/image/both)
    - Key findings (what problematic elements were found, if any)
    - Why it received this decision
  `);

  const contentSummary = `
Submission Type: ${state.type || 'unknown'}

Text Content: ${state.content || '(no text provided)'}

Image Description: ${state.imageDescription || '(no image provided)'}

Current Text Analysis:
- Toxicity: ${state.technicalAnalysis?.toxicity ?? 0}
- NSFW Text: ${state.technicalAnalysis?.nsfw_text ?? false}
  `.trim();

  const userPrompt = new HumanMessage(contentSummary);

  const response = await openai.invoke([systemPrompt, userPrompt]);
  const raw = response.content.toString();

  let parsed: any = {};

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0] : raw;
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    console.error('Failed to parse final decision response:', raw);
    parsed = {
      decision: 'flagged',
      summary: 'Moderation error occurred',
      technicalAnalysis: {
        nsfw_image: false,
        violence: false,
      },
    };
  }

  const techAnalysis = parsed.technicalAnalysis || {
    nsfw_image: false,
    violence: false,
  };

  return {
    ...state,
    decision: parsed.decision || 'flagged',
    textAnalysis: {
      summary: parsed.summary || 'No summary provided',
    },
    technicalAnalysis: {
      toxicity: state.technicalAnalysis?.toxicity ?? 0.5,
      nsfw_text: state.technicalAnalysis?.nsfw_text ?? false,
      nsfw_image: Boolean(techAnalysis.nsfw_image),
      violence: Boolean(techAnalysis.violence),
    },
  };
}

async function evaluateImageReplacementNode(
  state: z.infer<typeof ModerationState>,
): Promise<z.infer<typeof ModerationState>> {
  if (!state.imageUrl) {
    return state;
  }

  const hasImageIssues =
    state.technicalAnalysis?.nsfw_image || state.technicalAnalysis?.violence;
  const textToxicity = state.technicalAnalysis?.toxicity ?? 0;

  if (hasImageIssues && textToxicity < 0.7) {
    return {
      ...state,
      shouldReplaceImage: true,
    };
  }

  return {
    ...state,
    shouldReplaceImage: false,
  };
}

async function generateImageNode(
  state: z.infer<typeof ModerationState>,
): Promise<z.infer<typeof ModerationState>> {
  if (!state.shouldReplaceImage || !state.content) {
    return state;
  }

  try {
    const sanitizedPrompt = sanitizePromptForImageGeneration(state.content);

    const response = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'dall-e-3',
        prompt: sanitizedPrompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      },
    );

    const generatedImageUrl = response.data.data[0].url;

    return {
      ...state,
      generatedImageUrl,
    };
  } catch (error) {
    console.error('Image generation failed:', error);
    return {
      ...state,
      shouldReplaceImage: false,
      generatedImageUrl: undefined,
    };
  }
}

async function reanalyzeGeneratedImageNode(
  state: z.infer<typeof ModerationState>,
): Promise<z.infer<typeof ModerationState>> {
  if (!state.generatedImageUrl || !state.shouldReplaceImage) {
    return state;
  }

  try {
    const imageBase64 = await downloadImageAsBase64(state.generatedImageUrl);

    const imagePrompt = [
      new HumanMessage({
        content: [
          {
            type: 'text',
            text: 'Analyze this AI-generated image. Check for any problematic content (violence, NSFW). This image was generated to replace an unsafe image. Keep analysis concise.',
          },
          {
            type: 'image_url',
            image_url: `data:image/jpeg;base64,${imageBase64}`,
          },
        ],
      }),
    ];

    const response = await geminiVision.invoke(imagePrompt);
    const analysis = response.content.toString();

    const isSafe =
      !analysis.toLowerCase().includes('nsfw') &&
      !analysis.toLowerCase().includes('violence') &&
      !analysis.toLowerCase().includes('harmful');

    if (isSafe) {
      return {
        ...state,
        technicalAnalysis: {
          ...(state.technicalAnalysis || {}),
          nsfw_image: false,
          violence: false,
          image_replaced_by_ai: true,
        },
      };
    } else {
      return {
        ...state,
        shouldReplaceImage: false,
        generatedImageUrl: undefined,
      };
    }
  } catch (error) {
    console.error('Re-analysis of generated image failed:', error);
    return {
      ...state,
      shouldReplaceImage: false,
      generatedImageUrl: undefined,
    };
  }
}

function sanitizePromptForImageGeneration(text: string): string {
  const cleaned = text
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .substring(0, 300)
    .trim();

  return `A professional, family-friendly illustration based on: "${cleaned}". Safe for all ages.`;
}

const workflow = new StateGraph(ModerationState)
  .addNode('analyze_image', analyzeImageNode)
  .addNode('analyze_text', analyzeTextNode)
  .addNode('make_decision', makeDecisionNode)
  .addNode('evaluate_image_replacement', evaluateImageReplacementNode)
  .addNode('generate_image', generateImageNode)
  .addNode('reanalyze_generated_image', reanalyzeGeneratedImageNode)
  .addEdge(START, 'analyze_image')
  .addEdge('analyze_image', 'analyze_text')
  .addEdge('analyze_text', 'make_decision')
  .addEdge('make_decision', 'evaluate_image_replacement')
  .addEdge('evaluate_image_replacement', 'generate_image')
  .addEdge('generate_image', 'reanalyze_generated_image')
  .addEdge('reanalyze_generated_image', END);

export const moderationAgent = workflow.compile();
