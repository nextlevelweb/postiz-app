import { initializeSentry } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
initializeSentry('orchestrator', true);
import 'source-map-support/register';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@gitroom/orchestrator/app.module';
import {
  TEMPORAL_MODULE_OPTIONS,
  TemporalOptions,
  TemporalWorkerManagerService,
} from 'nestjs-temporal-core';
import { CONTENT_STUDIO_CAPTURE_TASK_QUEUE } from '@gitroom/nestjs-libraries/temporal/content.studio.capture.queue';
import * as dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = process.env.ORCHESTRATOR_PORT || 3002;
  await app.listen(port);
  console.log(`Orchestrator health check listening on port ${port}`);

  // P8-C2: one line on the Content Studio capture Worker, from what was
  // configured and started (the Temporal logs only show errors)
  const capture = app
    .get<TemporalOptions>(TEMPORAL_MODULE_OPTIONS)
    .workers?.find(
      (worker) => worker.taskQueue === CONTENT_STUDIO_CAPTURE_TASK_QUEUE
    );
  if (!capture) {
    console.log(
      `Content Studio capture worker not run on this server (queue ${CONTENT_STUDIO_CAPTURE_TASK_QUEUE} excluded)`
    );
  } else if (
    app
      .get(TemporalWorkerManagerService)
      .getWorkerStatusByTaskQueue(CONTENT_STUDIO_CAPTURE_TASK_QUEUE)?.isRunning
  ) {
    console.log(
      `Content Studio capture worker started (queue ${CONTENT_STUDIO_CAPTURE_TASK_QUEUE}, ${capture.workerOptions?.maxConcurrentActivityTaskExecutions} at a time)`
    );
  } else {
    console.error(
      `Content Studio capture worker did not start (queue ${CONTENT_STUDIO_CAPTURE_TASK_QUEUE})`
    );
  }
}

bootstrap();
