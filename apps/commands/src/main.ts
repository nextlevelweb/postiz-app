import { NestFactory } from '@nestjs/core';
import { CommandModule } from './command.module';
import { CommandService } from 'nestjs-command';

async function bootstrap() {
  // what providers print while they start goes to stderr: stdout is the
  // command's own (P8-R1B: a report printed as JSON is the JSON alone)
  const log = console.log;
  console.log = console.error;
  let app;
  try {
    app = await NestFactory.createApplicationContext(CommandModule, {
      logger: ['error'],
    });
  } finally {
    console.log = log;
  }

  try {
    await app.select(CommandModule).get(CommandService).exec();
    await app.close();
    // the Redis client and the Temporal worker connection outlive close(),
    // so leave once the command is done, with the exit code it set
    process.exit();
  } catch (error) {
    console.error(error);
    await app.close();
    process.exit(1);
  }
}

bootstrap();
