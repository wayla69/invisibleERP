import { Module } from '@nestjs/common';
import { BranchService } from './branch.service';
import { BranchController } from './branch.controller';

@Module({
  providers: [BranchService],
  controllers: [BranchController],
  exports: [BranchService],
})
export class BranchModule {}
