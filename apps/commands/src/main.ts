import { NestFactory } from '@nestjs/core';
import { CommandModule } from './command.module';
import { CommandService } from 'nestjs-command';

async function bootstrap() {
  // some comment again
  const app = await NestFactory.createApplicationContext(CommandModule, {
    logger: ['error'],
  });

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
