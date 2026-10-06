"""FastAPI application for Direct Beam Tracker Viewer."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import sys
from typing import AsyncIterator

from fastapi import (
    FastAPI,
    HTTPException,
    Path as PathParam,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from .client import TrackerClient, TrackerError
from .config import Settings, parse_args
from .models import (
    BeamSample,
    CelestialRequest,
    EnableBeamsRequest,
    InterpolationRequest,
    MaskAntennaRequest,
    Status,
    TargetRequest,
)
from .poller import StatusPoller

STATIC_DIR = Path(__file__).parent / "static"


def create_app(
    settings: Settings | None = None,
    client: TrackerClient | None = None,
    poller: StatusPoller | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application."""
    if settings is None:
        settings = parse_args([])

    if client is None:
        client = TrackerClient(base_url=settings.kotekan_url)

    if poller is None:
        poller = StatusPoller(
            client=client,
            interval=settings.poll_interval,
        )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await poller.start()
        yield
        await poller.stop()
        await client.aclose()

    app = FastAPI(
        title="Direct Beam Tracker Viewer",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.state.settings = settings
    app.state.client = client
    app.state.poller = poller

    # --- API Routes ---

    @app.get("/api/status", response_model=Status)
    async def get_status() -> Status:
        """Return the latest polled tracker status."""
        latest = poller.latest()
        if latest is None:
            raise HTTPException(
                status_code=503, detail="No status available yet from kotekan"
            )
        return latest

    @app.get("/api/history", response_model=list[BeamSample])
    async def get_history(beam_id: int = 0) -> list[BeamSample]:
        """Return the ring buffer history of (l0, m0) positions for a beam."""
        return poller.history(beam_id)

    @app.get("/api/health")
    async def get_health() -> dict[str, object]:
        """Health check endpoint."""
        return {
            "kotekan_reachable": poller.healthy,
            "poll_interval_s": poller.interval,
            "uptime_s": round(poller.uptime_s, 1),
        }

    @app.post("/api/beams/{beam_id}/target")
    async def steer_beam_target(
        beam_id: int = PathParam(..., ge=0, le=7), req: TargetRequest = ...
    ) -> dict[str, str]:
        """Steer a beam by direction cosines."""
        req.beam_id = beam_id
        try:
            reply = await client.set_target(req)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message)

    @app.post("/api/beams/{beam_id}/celestial")
    async def steer_beam_celestial(
        beam_id: int = PathParam(..., ge=0, le=7), req: CelestialRequest = ...
    ) -> dict[str, str]:
        """Steer a beam by celestial RA/Dec coordinates."""
        req.beam_id = beam_id
        try:
            reply = await client.set_celestial_target(req)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message)

    @app.post("/api/beams/enable")
    async def enable_beams(req: EnableBeamsRequest) -> dict[str, str]:
        """Set the number of active beams."""
        try:
            reply = await client.set_num_active_beams(req.num_active_beams)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message)

    @app.post("/api/antennas/mask")
    async def mask_antenna(req: MaskAntennaRequest) -> dict[str, str]:
        """Mask or unmask an antenna element."""
        try:
            reply = await client.mask_antenna(req.antenna_id, req.enabled)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message)

    @app.post("/api/interpolation")
    async def set_interpolation(req: InterpolationRequest) -> dict[str, str]:
        """Toggle phase interpolation."""
        try:
            reply = await client.set_interpolation(req.enabled)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message)

    @app.websocket("/ws")
    async def websocket_updates(ws: WebSocket) -> None:
        """Stream tracker status updates to connected browsers."""
        await ws.accept()
        q = poller.subscribe()

        latest = poller.latest()
        if latest is not None:
            try:
                await ws.send_text(latest.model_dump_json())
            except Exception:
                poller.unsubscribe(q)
                return

        async def reader() -> None:
            try:
                while True:
                    await ws.receive_text()
            except Exception:
                pass

        read_task = asyncio.create_task(reader())
        try:
            while True:
                status = await q.get()
                await ws.send_text(status.model_dump_json())
        except (WebSocketDisconnect, ConnectionResetError, RuntimeError):
            pass
        finally:
            read_task.cancel()
            poller.unsubscribe(q)

    # --- Static File Serving ---

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(STATIC_DIR / "index.html")

    return app


def main() -> None:
    """CLI entry point for the viewer command."""
    settings = parse_args(sys.argv[1:])
    app = create_app(settings)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
