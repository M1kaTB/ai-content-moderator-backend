import { Module } from '@nestjs/common';
import { SubmissionsService } from './submissions.service';
import { SubmissionsController } from './submissions.controller';
import { AgentService } from 'src/agent/agent.service';

@Module({
  controllers: [SubmissionsController],
  providers: [SubmissionsService, AgentService],
})
export class SubmissionsModule {}
