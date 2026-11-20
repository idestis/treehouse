FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src src
COPY migrations migrations
COPY templates templates
COPY static static
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/target/release/treehouse-server /usr/local/bin/treehouse-server
RUN mkdir -p /app/data
ENV BIND_ADDR=127.0.0.1:8080 DATABASE_URL=sqlite:///app/data/treehouse.db
CMD ["treehouse-server"]
