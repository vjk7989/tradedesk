FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY paper_bot ./paper_bot
RUN useradd -r -u 10001 bot && mkdir /data && chown bot /data
USER bot
ENV DATA_DIR=/data PATH="/app/.venv/bin:$PATH"
EXPOSE 8090
CMD ["python", "-m", "paper_bot.main"]
