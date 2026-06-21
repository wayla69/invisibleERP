import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  // CORS = explicit origins (เลิก wildcard "*" ของ V1)
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim());
  app.enableCors({ origin: origins, credentials: true });

  app.useGlobalFilters(new AllExceptionsFilter());

  const port = Number(process.env.PORT ?? 8000);
  await app.listen({ port, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`Invisible ERP V2 API listening on http://0.0.0.0:${port}`);
}

void bootstrap();
