import { Injectable, Inject } from '@nestjs/common';
import { moderationAgent } from './moderation.agent';
import { SupabaseClient } from '@supabase/supabase-js';
import axios from 'axios';

@Injectable()
export class AgentService {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async runModerationAsync(submissionId: string) {
    try {
      await this.updateSubmissionStage(submissionId, 'analyzing');

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

      await this.updateSubmissionStage(submissionId, 'running_moderation');
      const invokeResult = await moderationAgent.invoke(payload);
      const finalState = invokeResult as any;

      const status = finalState.decision ?? 'approved';
      const summary = finalState.textAnalysis?.summary ?? 'No summary provided';
      const technicalAnalysis = finalState.technicalAnalysis ?? {
        toxicity: 0,
        nsfw_text: false,
        nsfw_image: false,
        violence: false,
        image_replaced_by_ai: false,
      };

      let finalImageUrl = row.image_url;
      const imageWasReplaced = technicalAnalysis.image_replaced_by_ai ?? false;

      if (imageWasReplaced && finalState.generatedImageUrl) {
        await this.updateSubmissionStage(
          submissionId,
          'uploading_generated_image',
        );
        finalImageUrl = await this.uploadGeneratedImage(
          finalState.generatedImageUrl,
        );
      }

      const reasoning = this.buildReasoning(status, technicalAnalysis);
      const finalStatus = this.determineFinalStatus(
        status,
        technicalAnalysis,
        imageWasReplaced,
      );

      await this.updateSubmissionStage(submissionId, 'finalizing');

      await this.supabase
        .from('submissions')
        .update({
          status: finalStatus,
          moderation_stage: 'completed',
          summary,
          reasoning,
          toxicity: technicalAnalysis.toxicity ?? 0,
          nsfw_text: technicalAnalysis.nsfw_text ?? false,
          nsfw_image: technicalAnalysis.nsfw_image ?? false,
          violence: technicalAnalysis.violence ?? false,
          image_replaced_by_ai: imageWasReplaced,
          image_url: finalImageUrl,
          completed_at: new Date().toISOString(),
        })
        .eq('id', submissionId);

      return {
        status: finalStatus,
        summary,
        reasoning,
        technicalAnalysis,
      };
    } catch (error) {
      console.error(`Moderation error for ${submissionId}:`, error);
      await this.supabase
        .from('submissions')
        .update({
          status: 'flagged',
          moderation_stage: 'error',
          reasoning: `Moderation error: ${error.message}`,
        })
        .eq('id', submissionId);
      throw error;
    }
  }

  private async updateSubmissionStage(
    submissionId: string,
    stage: string,
  ): Promise<void> {
    await this.supabase
      .from('submissions')
      .update({
        moderation_stage: stage,
        updated_at: new Date().toISOString(),
      })
      .eq('id', submissionId);
  }

  private async uploadGeneratedImage(imageUrl: string): Promise<string> {
    try {
      const imageBuffer = await this.downloadImage(imageUrl);

      const fileName = `ai-generated-${Date.now()}-${Math.random().toString(36).substring(2)}.png`;
      const { data: uploadData, error: uploadError } =
        await this.supabase.storage
          .from('images')
          .upload(fileName, imageBuffer, {
            contentType: 'image/png',
          });

      if (uploadError) {
        console.error('Failed to upload generated image:', uploadError);
        return imageUrl;
      }

      const { data: publicUrlData } = this.supabase.storage
        .from('images')
        .getPublicUrl(uploadData.path);

      return publicUrlData.publicUrl;
    } catch (error) {
      console.error('Image upload failed:', error);
      return imageUrl;
    }
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
    });
    return Buffer.from(response.data);
  }

  private determineFinalStatus(
    decision: string,
    analysis: any,
    imageReplaced: boolean,
  ): string {
    if (imageReplaced) {
      const toxicity = analysis.toxicity ?? 0;
      const hasIssues =
        analysis.nsfw_text || analysis.nsfw_image || analysis.violence;

      if (toxicity < 0.3 && !hasIssues) {
        return 'approved';
      } else if (toxicity > 0.7 || (hasIssues && toxicity > 0.5)) {
        return 'rejected';
      }
      return 'flagged';
    }

    return decision;
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
    if (analysis.image_replaced_by_ai) {
      parts.push('Image replaced by AI');
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
