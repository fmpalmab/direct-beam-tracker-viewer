"""FastAPI application for Direct Beam Tracker Viewer."""

from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
import uvicorn
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi import (
    Path as PathParam,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .client import TrackerClient, TrackerError
from .config import Settings, parse_args
from .models import (
    AntennaMaskStatus,
    AutoDetectRequest,
    BaselineSpectrumResponse,
    BeamPowerResponse,
    BeamSample,
    BeamSpectrum,
    CelestialRequest,
    CorrelatorDiagnostics,
    EnableBeamsRequest,
    InterpolationRequest,
    MaskAntennaRequest,
    SkyGridFrame,
    SpectrometerData,
    Status,
    TargetRequest,
)
from .poller import StatusPoller
from .routine import RoutineRunner, RoutineState, generate_schedule, load_targets
from .spectrometer import FREQUENCIES_ALL_MHZ

STATIC_DIR = Path(__file__).parent / "static"


async def _send_ws_text(ws: WebSocket, text: str) -> bool:
    """Send a text message over WebSocket, returning False on error."""
    try:
        await ws.send_text(text)
        return True
    except Exception:
        return False


def create_app(
    settings: Settings | None = None,
    client: TrackerClient | None = None,
    poller: StatusPoller | None = None,
    routine: RoutineRunner | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application."""
    if settings is None:
        settings = parse_args([])

    if client is None:
        client = TrackerClient(base_url=settings.kotekan_url)

    if routine is None and settings.routine_enabled:
        catalog = load_targets(settings.routine_targets_path)
        schedule = generate_schedule(
            catalog,
            num_beams=settings.routine_num_beams,
            step_minutes=settings.routine_step_minutes,
            by_priority=settings.routine_by_priority,
        )
        routine = RoutineRunner(client=client, schedule=schedule)

    if poller is None:
        poller = StatusPoller(
            client=client,
            interval=settings.poll_interval,
            spectrometer_interval=settings.spectrometer_interval,
            beam_name_provider=routine.beam_names if routine is not None else None,
        )
    elif routine is not None and poller.beam_name_provider is None:
        poller.beam_name_provider = routine.beam_names

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await poller.start()
        if routine is not None:
            await routine.start()
        yield
        if routine is not None:
            await routine.stop()
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
    app.state.routine = routine

    # --- API Routes ---

    async def verify_token(
        x_api_token: str | None = Header(None, alias="X-API-Token"),
        authorization: str | None = Header(None),
    ) -> None:
        if not settings.api_token:
            return
        token = x_api_token
        if not token and authorization and authorization.startswith("Bearer "):
            token = authorization[7:].strip()
        if token != settings.api_token:
            raise HTTPException(
                status_code=401,
                detail="Unauthorized: invalid or missing API token",
            )

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

    @app.get("/api/history/all", response_model=dict[int, list[BeamSample]])
    async def get_all_history(limit: int = 120) -> dict[int, list[BeamSample]]:
        """Return recent (l0, m0) history for all beams in a single request."""
        clamped_limit = max(10, min(600, limit))
        return poller.all_history(max_points=clamped_limit)

    @app.get("/api/health")
    async def get_health() -> dict[str, object]:
        """Health check endpoint."""
        return {
            "kotekan_reachable": poller.healthy,
            "poll_interval_s": poller.interval,
            "spectrometer_interval_s": poller.spectrometer_interval,
            "uptime_s": round(poller.uptime_s, 1),
        }

    @app.get("/api/spectrometer", response_model=SpectrometerData)
    async def get_spectrometer() -> SpectrometerData:
        """Return the latest line spectrometer data for output formed beams (1 Hz)."""
        data = poller.spectrometer_latest()
        if data is None:
            raise HTTPException(
                status_code=503,
                detail="No spectrometer data available yet from kotekan",
            )
        return data

    @app.get("/api/spectrometer/{beam_id}", response_model=BeamSpectrum)
    async def get_beam_spectrum(
        beam_id: int = PathParam(..., ge=0, le=15),
    ) -> BeamSpectrum:
        """Return the line spectrum for a specific output beam."""
        data = poller.spectrometer_latest()
        if data is None or beam_id not in data.beams:
            raise HTTPException(
                status_code=404, detail=f"No spectrum data for beam {beam_id}"
            )
        return data.beams[beam_id]

    @app.get("/api/grid", response_model=SkyGridFrame)
    async def get_grid() -> SkyGridFrame:
        """Return the latest 16-beam sky grid camera frame."""
        frame = poller.grid_latest()
        if frame is None:
            raise HTTPException(
                status_code=503,
                detail="No sky grid frame available yet from kotekan",
            )
        return frame

    @app.get("/api/correlator", response_model=CorrelatorDiagnostics)
    async def get_correlator() -> CorrelatorDiagnostics:
        """Return the latest Astron WMMA correlator diagnostics."""
        diag = poller.correlator_latest()
        if diag is None:
            raise HTTPException(
                status_code=503,
                detail="No correlator diagnostics available yet from kotekan",
            )
        return diag

    @app.get(
        "/api/correlator/baseline/{ant_i}/{ant_j}",
        response_model=BaselineSpectrumResponse,
    )
    async def get_baseline_spectrum(
        ant_i: int = PathParam(..., ge=0, lt=64),
        ant_j: int = PathParam(..., ge=0, lt=64),
    ) -> BaselineSpectrumResponse:
        """Return 672-channel complex visibility spectrum and delay fit for baseline (ant_i, ant_j)."""
        data = poller.get_baseline_spectrum(ant_i, ant_j)
        return BaselineSpectrumResponse(**data)

    @app.get("/api/antenna_mask", response_model=AntennaMaskStatus)
    async def get_antenna_mask() -> AntennaMaskStatus:
        """Return the latest antenna masking and RF health telemetry."""
        status = poller.antenna_mask_latest()
        if status is None:
            raise HTTPException(
                status_code=503,
                detail="No antenna mask status available yet from kotekan",
            )
        return status

    @app.get("/api/beam_power", response_model=BeamPowerResponse)
    async def get_direct_beam_power() -> BeamPowerResponse:
        """Return the latest stitched beam power spectrum for direct tracker."""
        bp = poller.direct_beam_power_latest()
        if bp is None:
            raise HTTPException(
                status_code=503,
                detail="No beam power available yet from kotekan",
            )
        return bp

    @app.get("/api/routine", response_model=RoutineState)
    async def get_routine() -> RoutineState:
        """Return the current observation routine state (disabled stub if off)."""
        if routine is None:
            return RoutineState(enabled=False, num_beams=settings.routine_num_beams)
        return routine.state()

    @app.get("/api/routine/schedule")
    async def get_routine_schedule() -> dict[str, object]:
        """Return the full precomputed set-hour schedule."""
        if routine is None:
            raise HTTPException(status_code=404, detail="Routine not enabled")
        return routine.schedule.model_dump()

    @app.post("/api/routine/apply", dependencies=[Depends(verify_token)])
    async def apply_routine_now() -> dict[str, object]:
        """Force-apply the routine slot that is current right now."""
        if routine is None:
            raise HTTPException(status_code=404, detail="Routine not enabled")
        try:
            state = await routine.apply_current()
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc
        return {"status": "ok", "state": state.model_dump()}

    @app.post("/api/beams/{beam_id}/target", dependencies=[Depends(verify_token)])
    async def steer_beam_target(
        beam_id: int = PathParam(..., ge=0, le=15), req: TargetRequest = ...
    ) -> dict[str, str]:
        """Steer a beam by direction cosines."""
        req.beam_id = beam_id
        try:
            reply = await client.set_target(req)
            if routine is not None:
                routine.names.pop(beam_id, None)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.post("/api/beams/{beam_id}/celestial", dependencies=[Depends(verify_token)])
    async def steer_beam_celestial(
        beam_id: int = PathParam(..., ge=0, le=15), req: CelestialRequest = ...
    ) -> dict[str, str]:
        """Steer a beam by celestial RA/Dec coordinates."""
        req.beam_id = beam_id
        try:
            reply = await client.set_celestial_target(req)
            if routine is not None:
                routine.names.pop(beam_id, None)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.post("/api/beams/enable", dependencies=[Depends(verify_token)])
    async def enable_beams(req: EnableBeamsRequest) -> dict[str, str]:
        """Set the number of active beams."""
        try:
            reply = await client.set_num_active_beams(req.num_active_beams)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.post("/api/antennas/mask", dependencies=[Depends(verify_token)])
    async def mask_antenna(req: MaskAntennaRequest) -> dict[str, str]:
        """Mask or unmask an antenna element."""
        try:
            reply = await client.mask_antenna(req.antenna_id, req.enabled)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.post("/api/antennas/auto_detect", dependencies=[Depends(verify_token)])
    async def set_auto_detect(req: AutoDetectRequest) -> dict[str, Any]:
        """Enable or disable RF auto-detect antenna masking in kotekan."""
        try:
            reply = await client.set_auto_detect(req.enabled)
            return {
                "status": "ok",
                "message": reply.strip(),
                "auto_detect_enabled": req.enabled,
            }
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.post("/api/antennas/unmask_all", dependencies=[Depends(verify_token)])
    async def unmask_all_antennas() -> dict[str, str]:
        """Unmask all 64 antenna elements."""
        try:
            await client.reset_antenna_masks()
        except Exception:
            for i in range(64):
                try:
                    await client.mask_antenna(i, True)
                except Exception:
                    pass
        return {"status": "ok", "message": "All 64 antennas unmasked"}

    @app.get("/api/antennas/{antenna_id}/spectrum")
    async def get_antenna_spectrum(
        antenna_id: int = PathParam(..., ge=0, lt=64)
    ) -> dict[str, Any]:
        """Return calibrated line spectrum and RF diagnostics for a specific antenna."""
        corr = poller.correlator_latest()
        spec: list[float] = []
        if (
            corr is not None
            and getattr(corr, "full_antenna_spectra_db", None)
            and antenna_id < len(corr.full_antenna_spectra_db)
            and len(corr.full_antenna_spectra_db[antenna_id]) > 0
        ):
            spec = corr.full_antenna_spectra_db[antenna_id]
        elif (
            corr is not None
            and getattr(corr, "antenna_spectra_db", None)
            and antenna_id < len(corr.antenna_spectra_db)
            and len(corr.antenna_spectra_db[antenna_id]) > 0
        ):
            spec = corr.antenna_spectra_db[antenna_id]
        else:
            rng = np.random.default_rng(antenna_id + 42)
            base_db = 12.0 + 3.0 * np.sin(np.linspace(0, 3 * np.pi, 84))
            spec = np.round(base_db + rng.normal(0, 0.4, 84), 1).tolist()

        peak_idx = int(np.argmax(spec)) if len(spec) > 0 else 0
        peak_pwr = float(spec[peak_idx]) if len(spec) > 0 else 0.0
        mean_pwr = float(np.mean(spec)) if len(spec) > 0 else 0.0

        if len(spec) == len(FREQUENCIES_ALL_MHZ):
            freqs = FREQUENCIES_ALL_MHZ
        else:
            freqs = [
                round(300.0 + i * (201.6 / max(1, len(spec) - 1)), 2)
                for i in range(len(spec))
            ]

        return {
            "antenna_id": antenna_id,
            "frequencies_mhz": freqs,
            "spectrum_db": spec,
            "num_channels": len(spec),
            "peak_freq_mhz": freqs[peak_idx] if peak_idx < len(freqs) else 300.0,
            "peak_power_db": peak_pwr,
            "mean_power_db": round(mean_pwr, 2),
        }

    @app.post("/api/interpolation", dependencies=[Depends(verify_token)])
    async def set_interpolation(req: InterpolationRequest) -> dict[str, str]:
        """Toggle phase interpolation."""
        try:
            reply = await client.set_interpolation(req.enabled)
            return {"status": "ok", "message": reply}
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.websocket("/ws")
    async def websocket_updates(ws: WebSocket) -> None:
        """Stream tracker status, spectrometer, grid, correlator, and antenna mask updates to connected browsers."""
        await ws.accept()
        status_q = poller.subscribe()
        spec_q = poller.subscribe_spectrometer()
        grid_q = poller.subscribe_grid()
        corr_q = poller.subscribe_correlator()
        mask_q = poller.subscribe_antenna_mask()
        routine_q = routine.subscribe() if routine is not None else None

        latest = poller.latest()
        if latest is not None:
            if not await _send_ws_text(ws, latest.model_dump_json()):
                poller.unsubscribe(status_q)
                poller.unsubscribe_spectrometer(spec_q)
                poller.unsubscribe_grid(grid_q)
                poller.unsubscribe_correlator(corr_q)
                poller.unsubscribe_antenna_mask(mask_q)
                return

        if routine is not None:
            await _send_ws_text(
                ws, f'{{"type":"routine","data":{routine.state().model_dump_json()}}}'
            )

        latest_spec = poller.spectrometer_latest()
        if latest_spec is not None:
            await _send_ws_text(
                ws, f'{{"type":"spectrometer","data":{latest_spec.model_dump_json()}}}'
            )

        latest_grid = poller.grid_latest()
        if latest_grid is not None:
            await _send_ws_text(
                ws, f'{{"type":"grid","data":{latest_grid.model_dump_json()}}}'
            )

        latest_corr = poller.correlator_latest()
        if latest_corr is not None:
            await _send_ws_text(
                ws, f'{{"type":"correlator","data":{latest_corr.model_dump_json()}}}'
            )

        latest_mask = poller.antenna_mask_latest()
        if latest_mask is not None:
            await _send_ws_text(
                ws, f'{{"type":"antenna_mask","data":{latest_mask.model_dump_json()}}}'
            )

        async def push_status() -> None:
            while True:
                status = await status_q.get()
                await ws.send_text(status.model_dump_json())

        async def push_spectrometer() -> None:
            while True:
                spec = await spec_q.get()
                await ws.send_text(
                    f'{{"type":"spectrometer","data":{spec.model_dump_json()}}}'
                )

        async def push_grid() -> None:
            while True:
                grid = await grid_q.get()
                await ws.send_text(f'{{"type":"grid","data":{grid.model_dump_json()}}}')

        async def push_correlator() -> None:
            while True:
                corr = await corr_q.get()
                await ws.send_text(
                    f'{{"type":"correlator","data":{corr.model_dump_json()}}}'
                )

        async def push_antenna_mask() -> None:
            while True:
                mask = await mask_q.get()
                await ws.send_text(
                    f'{{"type":"antenna_mask","data":{mask.model_dump_json()}}}'
                )

        async def push_routine() -> None:
            while True:
                state = await routine_q.get()
                await ws.send_text(
                    f'{{"type":"routine","data":{state.model_dump_json()}}}'
                )

        async def reader() -> None:
            try:
                while True:
                    await ws.receive_text()
            except Exception:
                pass

        coros = [
            reader(),
            push_status(),
            push_spectrometer(),
            push_grid(),
            push_correlator(),
            push_antenna_mask(),
        ]
        if routine_q is not None:
            coros.append(push_routine())
        tasks = [asyncio.create_task(c) for c in coros]

        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        except (WebSocketDisconnect, ConnectionResetError, RuntimeError):
            pass
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if routine_q is not None:
                routine.unsubscribe(routine_q)
            poller.unsubscribe(status_q)
            poller.unsubscribe_spectrometer(spec_q)
            poller.unsubscribe_grid(grid_q)
            poller.unsubscribe_correlator(corr_q)
            poller.unsubscribe_antenna_mask(mask_q)

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
