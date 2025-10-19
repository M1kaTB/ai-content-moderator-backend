import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Inject,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { AgentService } from 'src/agent/agent.service';
import { CreateSubmissionDto } from './dto/create-submission.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { SupabaseAuthGuard } from 'src/auth/supabase-auth.guard';

@Controller('submissions')
export class SubmissionsController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    @Inject() private readonly agentService: AgentService,
  ) {}

  // Submit new post (authenticated)
  @Post()
  @UseGuards(SupabaseAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  async submit(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: CreateSubmissionDto,
    @Req() req,
  ) {
    // Your existing submission logic remains unchanged
    if (!req.user?.id) {
      throw new UnauthorizedException('User must be authenticated to submit');
    }

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

    // Create submission with user_id
    const { data: submission } = await this.supabase
      .from('submissions')
      .insert([
        {
          user_id: req.user.id,
          type: body.type,
          content: body.content,
          image_url: imageUrl,
          created_at: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    // Run moderation
    const result = await this.agentService.runModeration(submission.id);

    // Update submission with moderation results
    await this.supabase
      .from('submissions')
      .update({
        status: result.status,
        summary: result.summary,
        reasoning: result.reasoning,
        toxicity: result.technicalAnalysis.toxicity,
        nsfw_text: result.technicalAnalysis.nsfw_text,
        nsfw_image: result.technicalAnalysis.nsfw_image,
        violence: result.technicalAnalysis.violence,
      })
      .eq('id', submission.id);

    return {
      id: submission.id,
      status: result.status,
      summary: result.summary,
      reasoning: result.reasoning,
      imageUrl,
    };
  }

  // Public feed - only approved submissions
  @Get()
  async getAllSubmissions() {
    const { data, error } = await this.supabase
      .from('submissions')
      .select(
        `
  id,
  content,
  image_url,
  status,
  toxicity,
  nsfw_text,
  nsfw_image,
  violence,
  created_at,
  user_id
`,
      )

      .eq('status', 'approved') // ✅ show only approved posts
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException(
        'Failed to fetch submissions: ' + error.message,
      );
    }

    return data.map((submission: any) => ({
      id: submission.id,
      user: { id: submission.user_id },

      content: submission.content,
      imageUrl: submission.image_url || undefined,
      uploaded: submission.status,
      toxicity: submission.toxicity || 0,
      nsfw_content: submission.nsfw_text || submission.nsfw_image || false,
      violence: submission.violence || false,
      uploaddate: new Date(submission.created_at).toISOString(),
    }));
  }

  // Get user's submissions (authenticated)
  @Get('user/my-submissions')
  @UseGuards(SupabaseAuthGuard)
  async getUserSubmissions(@Req() req) {
    if (!req.user?.id) {
      throw new UnauthorizedException('User must be authenticated');
    }

    const { data, error } = await this.supabase
      .from('submissions')
      .select(
        `
  id,
  content,
  image_url,
  status,
  toxicity,
  nsfw_text,
  nsfw_image,
  violence,
  created_at,
  user_id
`,
      )

      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException(
        'Failed to fetch submissions: ' + error.message,
      );
    }

    return data.map((submission: any) => ({
      id: submission.id,
      user: { id: submission.user_id },

      content: submission.content,
      imageUrl: submission.image_url || undefined,
      uploaded: submission.status,
      summary: submission.summary,
      reasoning: submission.reasoning,
      toxicity: submission.toxicity || 0,
      nsfw_content: submission.nsfw_text || submission.nsfw_image || false,
      violence: submission.violence || false,
      uploaddate: new Date(submission.created_at).toISOString(),
    }));
  }

  // Check status of a single submission
  @Get(':id/status')
  @UseGuards(SupabaseAuthGuard)
  async getStatus(@Param('id') id: string, @Req() req) {
    const { data, error } = await this.supabase
      .from('submissions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new BadRequestException('Submission not found');
    }

    if (data.user_id !== req.user?.id && data.status !== 'approved') {
      throw new UnauthorizedException(
        'You can only view your own submissions or approved public submissions',
      );
    }

    return {
      id: data.id,
      status: data.status,
      summary: data.summary,
      reasoning: data.reasoning,
      toxicity: data.toxicity || 0,
      nsfw_content: data.nsfw_text || data.nsfw_image || false,
      violence: data.violence || false,
      imageUrl: data.image_url,
      uploaddate: new Date(data.created_at).toISOString(),
    };
  }
}
