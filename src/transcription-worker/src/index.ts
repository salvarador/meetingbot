import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { type AppRouter } from "../../server/src/server/api/root";
import superjson from "superjson";
import ffmpeg from "fluent-ffmpeg";
import { whisper } from "whisper-node";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
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

// Validate R2/Gemini Credentials
const requiredVars = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BUCKET_NAME",
  "S3_ENDPOINT",
  "GEMINI_API_KEY"
];

for (const v of requiredVars) {
  if (!process.env[v]) {
    console.error(`⚠️ Environment variable ${v} is MISSING!`);
  }
}

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY || "");

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
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }
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
    const { botId, recordingKey, transcriptionSettings } = job.data;
    const provider = transcriptionSettings?.provider || "whisper";
    const model = transcriptionSettings?.model || "small";

    console.log(`Processing transcription for Bot ID: ${botId}`);
    console.log(`   - Provider: ${provider}`);
    console.log(`   - Model: ${model}`);

    const tempDir = path.join(process.cwd(), "temp", job.id!);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const inputPath = path.join(tempDir, "input.mp4");
    const outputPath = path.join(tempDir, "output.wav");

    try {
      // 1. Update status to PROCESSING
      await trpc.bots.updateTranscriptionStatus.mutate({ id: botId, status: "PROCESSING" });

      // 2. Download from R2
      const bucketName = process.env.AWS_BUCKET_NAME!;
      console.log(`📥 Downloading from R2: ${recordingKey}`);

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

      // 3. Extract audio (WAV 16kHz Mono + Auto-Trim Silence)
      console.log("Extracting and cleaning audio...");
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .toFormat("wav")
          .audioChannels(1)
          .audioFrequency(16000)
          .audioCodec('pcm_s16le')
          // afftdn: FFT noise reduction
          // highpass/lowpass: Filter out everything except human speech frequencies (200Hz-3000Hz)
          // silenceremove: Strip all silence below -35dB
          .audioFilters('afftdn,highpass=f=200,lowpass=f=3000,silenceremove=start_periods=1:start_threshold=-35dB:start_silence=0.1,loudnorm')
          .on("end", resolve)
          .on("error", reject)
          .save(outputPath);
      });

      let fullText = "";

      if (provider === "gemini") {
        // --- GEMINI TRANSCRIPTION ---
        console.log(`Transcribing with Gemini (${model})...`);
        
        const uploadResponse = await fileManager.uploadFile(outputPath, {
          mimeType: "audio/wav",
          displayName: `Meeting ${botId}`,
        });

        let file = await fileManager.getFile(uploadResponse.file.name);
        while (file.state === "PROCESSING") {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          file = await fileManager.getFile(uploadResponse.file.name);
        }

        const genModel = genAI.getGenerativeModel({ model });
        const result = await genModel.generateContent([
          {
            fileData: {
              mimeType: file.mimeType,
              fileUri: file.uri,
            },
          },
          { text: "Por favor, transcribe esta reunión de trabajo en español. Identifica a los hablantes (Speaker 1, Speaker 2, etc.) si es posible y mantén la puntuación correcta." },
        ]);

        fullText = result.response.text();
        await fileManager.deleteFile(file.name);

      } else {
        // --- WHISPER LOCAL ---
        console.log(`Transcribing with local Whisper (${model})...`);
        const transcriptions = await whisper(outputPath, {
          modelName: model,
          whisperOptions: {
            language: "es",
            gen_file_txt: false,
            condition_on_previous_text: false,
            temperature: 0,
          }
        });

        if (!transcriptions || !Array.isArray(transcriptions)) {
          throw new Error("Whisper failed to return any transcription results");
        }

        fullText = transcriptions.map(t => t.speech).join(" ");
      }

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
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: 300000,
  }
);

worker.on("failed", (job, err) => {
  console.error(`Transcription job ${job?.id} failed: ${err.message}`);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
