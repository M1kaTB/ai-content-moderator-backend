import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Req,
  Inject,
} from '@nestjs/common';
import { SubmissionsService } from './submissions.service';
import { SupabaseClient } from '@supabase/supabase-js';
import { AgentService } from 'src/agent/agent.service';
@Controller('submissions')
export class SubmissionsController {
  constructor(
    private readonly submissionsService: SubmissionsService,
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    @Inject() private readonly agentService: AgentService,
  ) {}

  @Post()
  async submit(@Body() body: { type: string; content: string }, @Req() req) {
    const { data: submission } = await this.supabase
      .from('submissions')
      .insert([
        {
          user_id: req.user?.id || null,
          type: body.type,
          content: body.content,
        },
      ])
      .select()
      .single();

    const result = await this.agentService.runModeration(submission.id);

    await this.supabase
      .from('submissions')
      .update({
        status: result.status,
        summary: result.summary || null,
        reasoning: result.reasoning || null,
        langgraph_state: {
          needVisualization: result.needVisualization,
        },
      })
      .eq('id', submission.id);

    return {
      id: submission.id,
      status: result.status,
      summary: result.summary,
      reasoning: result.reasoning,
      needVisualization: result.needVisualization,
    };
  }

  @Get(':id/status')
  async getStatus(@Param('id') id: string) {
    const { data, error } = await this.supabase
      .from('submissions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return { error: 'Submission not found' };
    }

    return {
      id: data.id,
      status: data.status,
      summary: data.summary,
      reasoning: data.reasoning,
      needVisualization: data.langgraph_state?.needVisualization ?? false,
    };
  }
}
