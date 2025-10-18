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

    const invokeResult = await moderationAgent.invoke({
      content: row.content,
      type: row.type,
    });

    const finalState = invokeResult as any;

    const status = finalState.decision ?? 'pending';
    const reasoning = finalState.reasoning ?? '';
    const summary = finalState.analysis?.summary ?? '';
    const needVisualization = finalState.needVisualization ?? false;

    await this.supabase
      .from('submissions')
      .update({
        status,
        reasoning,
        langgraph_state: finalState,
      })
      .eq('id', submissionId);

    await this.supabase.from('audit_logs').insert([
      {
        submission_id: submissionId,
        action: 'moderated',
        details: finalState,
      },
    ]);

    return { status, reasoning, summary, needVisualization, finalState };
  }
}
