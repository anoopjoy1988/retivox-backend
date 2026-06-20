# Use a lightweight Node.js runtime as the base image
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /app

# Copy package configuration files
COPY package*.json ./

# Install all dependencies (including devDependencies for tsx and build scripts)
RUN npm ci

# Copy the remaining project files
COPY . .

# Declare build arguments for Vite compilation
ARG VITE_FCM_VAPID_KEY
ENV VITE_FCM_VAPID_KEY=$VITE_FCM_VAPID_KEY

# Build the client-side React code
RUN npm run build

# Expose port 8080 (Cloud Run targets this port by default)
EXPOSE 8080

# Define environment variables
ENV PORT=8080
ENV NODE_ENV=production

# Start the Express server using tsx to run the TypeScript entrypoint directly
CMD ["npx", "tsx", "server.ts"]
