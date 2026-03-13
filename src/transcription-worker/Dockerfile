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

COPY . .

# Run the worker
CMD ["pnpm", "start"]
