"""Start the MILO API on this machine only."""
from __future__ import annotations

import uvicorn

from main import app


if __name__ == "__main__":
    # Keep the privileged desktop API off LAN interfaces even if a launcher
    # or shell has different default bind settings.
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8765,
        ws_max_size=256 * 1024,
        server_header=False,
    )
