FROM rust:1-bookworm AS rust-builder
WORKDIR /app
COPY Cargo.toml ./
COPY Cargo.lock ./
COPY agent/Cargo.toml agent/Cargo.toml
COPY server/Cargo.toml server/Cargo.toml
COPY agent agent
COPY server server
RUN cargo build --locked --release -p vps-monitor-agent

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates iputils-ping \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /host/etc
COPY --from=rust-builder /app/target/release/vps-monitor-agent /usr/local/bin/vps-monitor-agent
ENV VPS_MONITOR_HOST_ROOT=/host
CMD ["vps-monitor-agent"]
