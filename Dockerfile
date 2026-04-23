# Minimal runner image for subfit-ai.
# Mount your Claude history at /data and the image scans it with no Node
# install on the host:
#
#   docker build -t subfit-ai .
#   docker run --rm -v "$HOME/.claude:/data:ro" subfit-ai --path /data
#
# Or try it with no session data at all:
#
#   docker run --rm subfit-ai --demo
FROM node:20-alpine

WORKDIR /app

# Install tsx once into the image so runtime `npx tsx` does not re-fetch.
RUN npm install -g tsx@4

COPY package.json ./
COPY subfit-ai.ts ./
COPY config.json ./
COPY default-config.json ./
COPY examples ./examples

ENTRYPOINT ["tsx", "/app/subfit-ai.ts"]
CMD ["--help"]
