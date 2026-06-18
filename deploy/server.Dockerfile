FROM node:22-bookworm AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-bookworm AS rust-builder
WORKDIR /app
COPY Cargo.toml ./
COPY Cargo.lock ./
COPY server/Cargo.toml server/Cargo.toml
COPY agent/Cargo.toml agent/Cargo.toml
COPY server server
COPY agent agent
RUN cargo build --locked --release -p vps-monitor-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust-builder /app/target/release/vps-monitor-server /usr/local/bin/vps-monitor-server
COPY --from=web-builder /app/web/dist /app/web/dist
ENV BIND_ADDR=0.0.0.0:8080
ENV STATIC_DIR=/app/web/dist
EXPOSE 8080
CMD ["vps-monitor-server"]
