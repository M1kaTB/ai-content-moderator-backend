import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateSubmissionDto {
  @IsEnum(['text', 'image'])
  type: 'text' | 'image';

  @IsString()
  @IsNotEmpty()
  content: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;
}
