import { Controller, Get, Post, Patch, Param, Query, Body, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { WhtService } from './wht.service';
import { TaxDocsPdfService } from './tax-docs-pdf.service';
import { IssueWhtBody, type IssueWhtDto } from './dto';

@Controller('api/wht/certificates')
export class WhtController {
  constructor(
    private readonly svc: WhtService,
    private readonly pdf: TaxDocsPdfService,
  ) {}

  @Post() @Permissions('creditors', 'ar')
  issue(@Body(new ZodValidationPipe(IssueWhtBody)) b: IssueWhtDto, @CurrentUser() u: JwtUser) {
    return this.svc.issue(b, u);
  }

  @Get() @Permissions('creditors', 'ar')
  list(@Query('pnd') pnd: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.list(u, pnd);
  }

  @Get(':docNo') @Permissions('creditors', 'ar')
  get(@Param('docNo') docNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.getByDocNo(u, docNo);
  }

  @Patch(':docNo/void') @Permissions('creditors', 'ar')
  void(@Param('docNo') docNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.void(u, docNo);
  }

  @Get(':docNo/pdf') @Permissions('creditors', 'ar')
  async pdfDoc(@Param('docNo') docNo: string, @Query('copy') copy: string | undefined, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const cert = await this.svc.getByDocNo(u, docNo);
    const c = (copy === 'copy2' || copy === 'copy3') ? copy : 'copy1';
    const html = this.pdf.whtCertificateHtml(cert, c as any);
    const buf = await this.pdf.renderToPdf(html, false);
    if (buf) {
      reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${docNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    } else {
      reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
    }
  }
}
