# agentbench-relay: the meeting point for benches on different networks.
#
#   docker build -f packaging/relay/Dockerfile -t agentbench-relay src-tauri
#   docker run -d --restart unless-stopped -p 8480:8480 agentbench-relay
#
# Put it behind a TLS-terminating proxy (Caddy, Traefik, nginx) so benches can
# use wss://; see docs/relay.md. It keeps no state, so it needs no volume.

FROM rust:1.98-slim-bookworm AS build
WORKDIR /src
COPY . .
# --no-default-features drops Tauri and the speech models: the relay is a
# plain async server.
RUN cargo build --release --locked --no-default-features --bin agentbench-relay

FROM debian:bookworm-slim
RUN useradd --system --no-create-home relay
COPY --from=build /src/target/release/agentbench-relay /usr/local/bin/agentbench-relay
USER relay
ENV PORT=8480
EXPOSE 8480
HEALTHCHECK --interval=30s --timeout=3s CMD ["/usr/local/bin/agentbench-relay", "--version"]
ENTRYPOINT ["/usr/local/bin/agentbench-relay"]
