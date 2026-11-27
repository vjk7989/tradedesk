FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY vibe_bt ./vibe_bt
RUN uv sync --frozen --no-dev
COPY bt_service ./bt_service
RUN useradd -r -u 1000 app && mkdir /runs && chown app /runs
USER app
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "bt_service.app:app", "--host", "0.0.0.0", "--port", "8000"]
