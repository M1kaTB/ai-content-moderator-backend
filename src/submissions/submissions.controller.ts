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
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { AgentService } from 'src/agent/agent.service';
import { CreateSubmissionDto } from './dto/create-submission.dto';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('submissions')
export class SubmissionsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    @Inject() private readonly agentService: AgentService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('image'))
  async submit(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: CreateSubmissionDto,
    @Req() req,
  ) {
    let imageUrl: string | null = null;

    if (file) {
      const fileExt = file.originalname.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`;

      const { data: uploadData, error: uploadError } =
        await this.supabase.storage
          .from('images')
          .upload(fileName, file.buffer, {
            contentType: file.mimetype,
          });

      if (uploadError) {
        throw new BadRequestException(
          'Image upload failed: ' + uploadError.message,
        );
      }

      const { data: publicUrlData } = this.supabase.storage
        .from('images')
        .getPublicUrl(uploadData.path);

      imageUrl = publicUrlData.publicUrl;
    }

    const { data: submission } = await this.supabase
      .from('submissions')
      .insert([
        {
          user_id: req.user?.id || null,
          type: body.type,
          content: body.content,
          image_url: imageUrl,
        },
      ])
      .select()
      .single();

    const result = await this.agentService.runModeration(submission.id);

    await this.supabase
      .from('submissions')
      .update({
        status: result.status,
        summary: result.summary,
        reasoning: result.reasoning,
        langgraph_state: {
          technicalAnalysis: result.technicalAnalysis,
          needVisualization: result.needVisualization,
        },
      })
      .eq('id', submission.id);

    return {
      id: submission.id,
      status: result.status,
      summary: result.summary,
      reasoning: result.reasoning,
      technicalAnalysis: result.technicalAnalysis,
      needVisualization: result.needVisualization,
      imageUrl,
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
      imageUrl: data.image_url,
    };
  }
}
