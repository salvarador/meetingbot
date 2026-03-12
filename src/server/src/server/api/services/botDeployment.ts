import { type BotConfig, bots } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "~/server/db/schema";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "~/env";
import { Queue } from "bullmq";
import IORedis from "ioredis";

// Get the directory path using import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Redis connection for BullMQ
const redisConnection = env.REDIS_URL ? new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
}) : null;

const botQueue = redisConnection ? new Queue("bot-queue", {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
  connection: redisConnection as any,
}) : null;

export class BotDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotDeploymentError";
  }
}

export async function deployBot({
  botId,
  db,
}: {
  botId: number;
  db: PostgresJsDatabase<typeof schema>;
}) {
  const botResult = await db.select().from(bots).where(eq(bots.id, botId));
  if (!botResult[0]) {
    throw new Error("Bot not found");
  }
  const bot = botResult[0];
  const dev = env.NODE_ENV === "development";

  // First, update bot status to deploying
  await db.update(bots).set({ status: "DEPLOYING" }).where(eq(bots.id, botId));

  try {
    const config: BotConfig = {
      id: botId,
      userId: bot.userId,
      meetingTitle: bot.meetingTitle,
      meetingInfo: bot.meetingInfo,
      startTime: bot.startTime,
      endTime: bot.endTime,
      botDisplayName: bot.botDisplayName,
      botImage: bot.botImage ?? undefined,
      heartbeatInterval: bot.heartbeatInterval,
      automaticLeave: bot.automaticLeave,
      callbackUrl: bot.callbackUrl ?? undefined,
    };

    if (dev) {
      // Get the absolute path to the bots directory
      const botsDir = path.resolve(__dirname, "../../../../../bots");
      
      // Spawn the bot process locally for development
      const botProcess = spawn("pnpm", ["start"], {
        cwd: botsDir,
        env: {
          ...process.env,
          BOT_DATA: JSON.stringify(config),
        },
      });

      botProcess.stdout.on("data", (data) => console.log(`Bot ${botId}: ${data}`));
      botProcess.stderr.on("data", (data) => console.error(`Bot ${botId} ERR: ${data}`));
    } else {
      // RAILWAY / PRODUCTION: Add to BullMQ queue
      if (!botQueue) {
        throw new Error("Redis connection not available for bot deployment");
      }

      await botQueue.add(`bot-${botId}`, {
        config,
        platform: bot.meetingInfo.platform?.toLowerCase()
      }, {
        removeOnComplete: true,
        removeOnFail: false,
      });

      console.log(`Bot ${botId} queued in Redis`);
    }

    // Update status to joining call (or QUEUED if we want to be more precise)
    const result = await db
      .update(bots)
      .set({
        status: "JOINING_CALL",
        deploymentError: null,
      })
      .where(eq(bots.id, botId))
      .returning();

    if (!result[0]) {
      throw new BotDeploymentError("Bot not found");
    }

    return result[0];
  } catch (error) {
    await db
      .update(bots)
      .set({
        status: "FATAL",
        deploymentError: error instanceof Error ? error.message : "Unknown error",
      })
      .where(eq(bots.id, botId));

    throw error;
  }
}

export async function shouldDeployImmediately(
  startTime: Date | undefined | null,
): Promise<boolean> {
  if (!startTime) return true;
  const now = new Date();
  const deploymentBuffer = 5 * 60 * 1000; // 5 minutes
  return startTime.getTime() - now.getTime() <= deploymentBuffer;
}
