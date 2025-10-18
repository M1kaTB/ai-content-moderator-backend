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
  technicalAnalysis: z
    .object({
      toxicity: z.number().min(0).max(1).optional(),
      nsfw_text: z.boolean().optional(),
      nsfw_image: z.boolean().optional(),
      violence: z.boolean().optional(),
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
            text: 'Describe this image in detail. What do you see? Keep description concise and factual.',
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

async function makeDecisionNode(
  state: z.infer<typeof ModerationState>,
): Promise<z.infer<typeof ModerationState>> {
  const systemPrompt = new SystemMessage(`
    You are a content moderation AI. Analyze the provided content and decide if it should be approved, flagged, or rejected.
    
    You MUST return ONLY this exact JSON format with no additional text:
    {
      "decision": "approved",
      "summary": "2-3 sentence detailed explanation of what was found and why the decision was made",
      "technicalAnalysis": {
        "toxicity": 0.5,
        "nsfw_text": false,
        "nsfw_image": false,
        "violence": false
      }
    }
    
    IMPORTANT: All numeric values for toxicity must be between 0 and 1. Boolean values must be true or false.
    
    Guidelines:
    - toxicity < 0.3 = approved
    - toxicity 0.3-0.7 = flagged
    - toxicity > 0.7 OR any nsfw/violence true = rejected
    
    Summary should include:
    - What type of content was detected (text/image/both)
    - Key findings (what problematic elements were found, if any)
    - Why it received this decision
  `);

  const contentSummary = `
Submission Type: ${state.type || 'unknown'}

Text Content: ${state.content || '(no text provided)'}

Image Description: ${state.imageDescription || '(no image provided)'}
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
    console.error('Failed to parse OpenAI response:', raw);
    parsed = {
      decision: 'flagged',
      summary: 'Moderation error occurred',
      technicalAnalysis: {
        toxicity: 0.5,
        nsfw_text: false,
        nsfw_image: false,
        violence: false,
      },
    };
  }

  const techAnalysis = parsed.technicalAnalysis || {
    toxicity: 0.5,
    nsfw_text: false,
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
      toxicity:
        typeof techAnalysis.toxicity === 'number' ? techAnalysis.toxicity : 0.5,
      nsfw_text: Boolean(techAnalysis.nsfw_text),
      nsfw_image: Boolean(techAnalysis.nsfw_image),
      violence: Boolean(techAnalysis.violence),
    },
  };
}

const workflow = new StateGraph(ModerationState)
  .addNode('analyze_image', analyzeImageNode)
  .addNode('make_decision', makeDecisionNode)
  .addEdge(START, 'analyze_image')
  .addEdge('analyze_image', 'make_decision')
  .addEdge('make_decision', END);

export const moderationAgent = workflow.compile();
