FROM node:20-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install

# Download the whisper model manually to avoid interactive TTY errors
# We place it in the default directory where whisper-node expects it
RUN mkdir -p ./node_modules/whisper-node/lib/whisper.cpp/models && \
    wget -O ./node_modules/whisper-node/lib/whisper.cpp/models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin

COPY . .

# Run the worker
CMD ["pnpm", "start"]
