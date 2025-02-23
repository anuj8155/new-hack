FROM ubuntu:focal

# Install dependencies without prompts
ENV DEBIAN_FRONTEND=noninteractive

# Update and install required packages
RUN apt-get update && \
    apt-get install -y \
    curl \
    ffmpeg \
    build-essential \
    python3 \
    git && \
    curl -sL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get update && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install nodemon globally
RUN npm install -g nodemon

# Create app directory
WORKDIR /home/app

# Install basic dependencies
COPY package*.json ./
RUN npm install || echo "No package.json found, skipping install"

# Expose port 
EXPOSE 4000

# Run with increased logging
CMD ["nodemon", "--inspect=0.0.0.0:9229", "index.js"]