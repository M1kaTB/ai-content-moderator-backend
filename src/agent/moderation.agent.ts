import { StateGraph, START, END } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import * as z from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

const llm = new ChatOpenAI({
  model: 'gpt-4o-mini',
  temperature: 0,
  apiKey: process.env.OPENAI_API_KEY,
});

const ModerationState = z.object({
  content: z.string().optional(),
  type: z.enum(['text', 'image']).optional(),

  analysis: z
    .object({
      toxicity: z.number().optional(),
      nsfw: z.boolean().optional(),
      summary: z.string().optional(),
    })
    .optional(),

  decision: z
    .enum(['pending', 'approved', 'flagged', 'rejected'])
    .default('pending'),
  reasoning: z.string().optional(),
});

async function analyzeNode(state: z.infer<typeof ModerationState>) {
  const content = state.content ?? '';

  const prompt = [
    new SystemMessage(`
You are a content moderation model.
Return only valid JSON with these fields:
{
  "toxicity": number (0-1),
  "nsfw": boolean,
  "summary": string
}`),
    new HumanMessage(`Analyze this content:\n\n${content}`),
  ];

  const resp = await llm.invoke(prompt);
  let raw = resp.content.toString();
  let parsed: any = {};

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : JSON.parse(raw);
  } catch (err) {
    parsed = { toxicity: 0, nsfw: false, summary: 'Parsing failed' };
  }

  return {
    analysis: {
      toxicity: parsed.toxicity ?? 0,
      nsfw: parsed.nsfw ?? false,
      summary: parsed.summary ?? '',
    },
  };
}

async function classifyNode(state: z.infer<typeof ModerationState>) {
  const tox = state.analysis?.toxicity ?? 0;
  const nsfw = state.analysis?.nsfw ?? false;

  if (tox >= 0.9 || nsfw === true) {
    return { decision: 'rejected', reasoning: `tox: ${tox} nsfw: ${nsfw}` };
  }

  if (tox >= 0.6) {
    return { decision: 'flagged', reasoning: `tox: ${tox}` };
  }

  return { decision: 'approved', reasoning: `tox:${tox}` };
}

async function routeNode(state: z.infer<typeof ModerationState>) {
  const needViz = state.decision === 'flagged';
  return {
    ...state,
    needVisualization: needViz,
  };
}

export const moderationAgent = new StateGraph(ModerationState)
  .addNode('analyze', analyzeNode)
  .addNode('classify', classifyNode)
  .addNode('route', routeNode)
  .addEdge(START, 'analyze')
  .addEdge('analyze', 'classify')
  .addEdge('classify', 'route')
  .addEdge('route', END)
  .compile();
