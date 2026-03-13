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
# Note: whisper-node will compile whisper.cpp during this step
RUN pnpm install

# Pre-download the whisper model (optional but recommended for speed)
# This uses the internal script of whisper-node if available or we manually triggers it
RUN npx tsx -e 'import { downloadModel } from "whisper-node"; downloadModel("base")'

COPY . .

# Run the worker
CMD ["pnpm", "start"]
