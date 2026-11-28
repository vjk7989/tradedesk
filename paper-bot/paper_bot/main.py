import logging

import uvicorn

from .config import Config
from .web import create_app

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    cfg = Config.from_env()
    uvicorn.run(create_app(cfg), host="0.0.0.0", port=cfg.port)
