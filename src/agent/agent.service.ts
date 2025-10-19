// /src/agent/agent.service.ts
import { Injectable, Inject } from '@nestjs/common';
import { moderationAgent } from './moderation.agent';
import { SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class AgentService {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async runModeration(submissionId: string) {
    const { data: row } = await this.supabase
      .from('submissions')
      .select('*')
      .eq('id', submissionId)
      .single();

    if (!row) throw new Error('submission not found');

    const payload: any = {
      type: row.type,
      content: row.content ?? '',
    };

    if (row.image_url) {
      payload.imageUrl = row.image_url;
    }

    const invokeResult = await moderationAgent.invoke(payload);
    const finalState = invokeResult as any;

    const status = finalState.decision ?? 'approved';
    const summary = finalState.textAnalysis?.summary ?? 'No summary provided';
    const technicalAnalysis = finalState.technicalAnalysis ?? {
      toxicity: 0,
      nsfw_text: false,
      nsfw_image: false,
      violence: false,
    };

    const reasoning = this.buildReasoning(status, technicalAnalysis);

    return {
      status,
      summary,
      reasoning,
      technicalAnalysis,
    };
  }

  private buildReasoning(status: string, analysis: any): string {
    const parts: string[] = [];

    if (analysis.toxicity !== undefined) {
      parts.push(`Toxicity: ${(analysis.toxicity * 100).toFixed(1)}%`);
    }

    if (analysis.nsfw_text) {
      parts.push('NSFW text detected');
    }

    if (analysis.nsfw_image) {
      parts.push('NSFW image detected');
    }

    if (analysis.violence) {
      parts.push('Violence detected');
    }

    const prefix =
      status === 'approved'
        ? 'Content approved:'
        : status === 'flagged'
          ? 'Content flagged for review:'
          : 'Content rejected:';

    return parts.length > 0 ? `${prefix} ${parts.join(', ')}` : prefix;
  }
}
