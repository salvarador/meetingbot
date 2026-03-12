import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("REDIS_URL is required for the bot worker");
  process.exit(1);
}

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

console.log("Bot Worker starting and connecting to Redis...");

const worker = new Worker(
  "bot-queue",
  async (job: Job) => {
    const { config, platform } = job.data;
    console.log(`Processing bot job for ${platform}, Bot ID: ${config.id}`);

    return new Promise((resolve, reject) => {
      // We spawn a new process for each bot to ensure clean environment (XVFB, etc)
      // and better memory isolation.
      const botProcess = spawn("tsx", ["src/index.ts"], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          BOT_DATA: JSON.stringify(config),
          DOCKER_MEETING_PLATFORM: platform,
        },
      });

      botProcess.stdout.on("data", (data) => {
        console.log(`[Bot ${config.id}] ${data}`);
      });

      botProcess.stderr.on("data", (data) => {
        console.error(`[Bot ${config.id} ERR] ${data}`);
      });

      botProcess.on("close", (code) => {
        if (code === 0) {
          console.log(`Bot ${config.id} finished successfully`);
          resolve(true);
        } else {
          console.error(`Bot ${config.id} failed with code ${code}`);
          reject(new Error(`Bot exited with code ${code}`));
        }
      });
      
      botProcess.on("error", (err) => {
          console.error(`Bot ${config.id} process error:`, err);
          reject(err);
      });
    });
  },
  {
    connection,
    concurrency: 1, // Start with 1 to avoid memory issues on heavy bots
    lockDuration: 60 * 60 * 1000, // 1 hour lock for long meetings
  }
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed!`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed with ${err.message}`);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down worker...");
  await worker.close();
  process.exit(0);
});
