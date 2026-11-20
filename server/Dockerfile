# syntax=docker/dockerfile:1.7
# Treehouse server image. Build from the repo root:
#   docker build -f server/Dockerfile -t treehouse .
# Configured only by environment variables (deploy/.env.example).

FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY server server
# The desktop app is a workspace member; cargo only needs a manifest and a stub to load it.
COPY desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.toml
RUN mkdir -p desktop/src-tauri/src \
 && echo 'fn main() {}' > desktop/src-tauri/src/main.rs \
 && touch desktop/src-tauri/src/lib.rs
ENV SQLX_OFFLINE=true
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p treehouse-server \
 && cp target/release/treehouse-server /usr/local/bin/treehouse

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home treehouse
COPY --from=build /usr/local/bin/treehouse /usr/local/bin/treehouse
USER treehouse
ENV BIND_ADDR=0.0.0.0:8080 LOG_FORMAT=json
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["treehouse", "healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "treehouse"]
CMD ["serve"]
