import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { type AppRouter } from "../../server/src/server/api/root";
import superjson from "superjson";
import ffmpeg from "fluent-ffmpeg";
import { whisper } from "whisper-node";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import dotenv from "dotenv";

dotenv.config();

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("❌ REDIS_URL is required");
  process.exit(1);
}

// Validate R2 Credentials
const requiredR2Vars = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BUCKET_NAME",
  "S3_ENDPOINT"
];

for (const v of requiredR2Vars) {
  if (!process.env[v]) {
    console.error(`❌ Environment variable ${v} is MISSING in Railway settings!`);
  }
}

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "missing",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "missing",
  },
});

const getBackendUrl = () => {
  let url = (process.env.BACKEND_URL || "http://localhost:3001").trim();
  
  // Ensure the URL has a protocol
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  // Remove trailing slash if present
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  // Ensure it doesn't already end with /api/trpc before appending it
  if (!url.endsWith("/api/trpc")) {
    url = `${url}/api/trpc`;
  }
  
  return url;
};

const trpc = createTRPCProxyClient<AppRouter>({
  transformer: superjson,
  links: [
    httpBatchLink({
      url: getBackendUrl(),
    }),
  ],
});

console.log("Transcription Worker starting...");

const worker = new Worker(
  "transcription-queue",
  async (job: Job) => {
    const { botId, recordingKey } = job.data;
    console.log(`Processing transcription for Bot ID: ${botId}, Key: ${recordingKey}`);

    const tempDir = path.join(process.cwd(), "temp", job.id!);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const inputPath = path.join(tempDir, "input.mp4");
    const outputPath = path.join(tempDir, "output.wav");

    try {
      // 1. Update status to PROCESSING
      await trpc.bots.updateTranscriptionStatus.mutate({ id: botId, status: "PROCESSING" });

      // 2. Download from R2
      const bucketName = process.env.AWS_BUCKET_NAME!;
      console.log(`📥 Attempting to download from R2:`);
      console.log(`   - Bucket: ${bucketName}`);
      console.log(`   - Key: ${recordingKey}`);
      console.log(`   - Full simulated path: ${process.env.S3_ENDPOINT}/${bucketName}/${recordingKey}`);

      const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucketName,
        Key: recordingKey,
      }));

      const writeStream = fs.createWriteStream(inputPath);
      await new Promise((resolve, reject) => {
        (response.Body as Readable).pipe(writeStream)
          .on("finish", resolve)
          .on("error", reject);
      });

      // 3. Extract audio (WAV 16kHz Mono)
      console.log("Extracting audio with standard settings...");
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .toFormat("wav")
          .audioChannels(1)
          .audioFrequency(16000)
          .audioCodec('pcm_s16le') // Standard format for Whisper
          .on("end", resolve)
          .on("error", (err) => {
            console.error("FFmpeg Error:", err);
            reject(err);
          })
          .save(outputPath);
      });

      const stats = fs.statSync(outputPath);
      console.log(`📊 Generated WAV size: ${stats.size} bytes`);

      if (stats.size < 1000) {
        throw new Error("Extracted audio file is too small, likely empty.");
      }

      // 4. Transcribe with Whisper (Spanish - Small Model)
      console.log("Transcribing with Whisper (Small model)...");
      const transcriptions = await whisper(outputPath, {
        modelName: "small",
        whisperOptions: {
          language: "es",
          gen_file_txt: false,
          condition_on_previous_text: false,
          temperature: 0,
          // Initial prompt helps the model understand the context and language
          prompt: "Esta es una transcripción de una reunión grabada en español. Hablamos sobre temas de trabajo y proyectos.",
        }
      });

      if (!transcriptions || !Array.isArray(transcriptions)) {
        throw new Error("Whisper failed to return any transcription results");
      }

      const fullText = transcriptions.map(t => t.speech).join(" ");
      console.log(`Transcription completed for bot ${botId}`);

      // 5. Save transcription
      await trpc.bots.saveTranscription.mutate({
        id: botId,
        transcription: fullText,
      });

    } catch (error) {
      console.error(`Error processing transcription for bot ${botId}:`, error);
      await trpc.bots.updateTranscriptionStatus.mutate({ id: botId, status: "FAILED" });
      throw error;
    } finally {
      // Cleanup temp files
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  },
  {
    connection,
    concurrency: 1, // Whisper is CPU intensive, better 1 at a time
    lockDuration: 300000, // 5 minutes
  }
);

worker.on("failed", (job, err) => {
  console.error(`Transcription job ${job?.id} failed: ${err.message}`);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
