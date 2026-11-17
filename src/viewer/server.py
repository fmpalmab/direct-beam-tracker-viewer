"""FastAPI application for Direct Beam Tracker Viewer."""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import anyio
import uvicorn
from fastapi import (
    Body,
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
    BeamPowerResponse,
    BeamSample,
    BeamSpectrum,
    CalibrationToggleRequest,
    CelestialRequest,
    EnableBeamsRequest,
    InterpolationRequest,
    MaskAntennaRequest,
    ReloadGainsRequest,
    RfiChannelsResponse,
    RfiConfigureRequest,
    RfiResetEmaRequest,
    RfiStatus,
    SefdSensitivitySummary,
    SpectrometerData,
    Status,
    TaperRequest,
    TargetRequest,
)
from .poller import StatusPoller
from .routine import RoutineRunner, RoutineState, generate_schedule, load_targets
from .sefd_utils import (
    SUBBAND0_START_HZ,
    SUBBAND1_START_HZ,
    compute_prewhitening_gains,
    prepare_gains_for_kotekan,
)

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
        version="0.2.0",
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

    @app.get("/api/rfi", response_model=RfiStatus)
    async def get_rfi() -> RfiStatus:
        """Return the latest real-time RFI mitigation status."""
        rfi = poller.rfi_latest()
        if rfi is None:
            raise HTTPException(
                status_code=503,
                detail="No RFI telemetry available yet from kotekan",
            )
        return rfi

    @app.get("/api/rfi/channels", response_model=RfiChannelsResponse)
    async def get_rfi_channels() -> RfiChannelsResponse:
        """Return the latest 672-channel RFI diagnostics."""
        chans = poller.rfi_channels_latest()
        if chans is None:
            raise HTTPException(
                status_code=503,
                detail="No RFI channel telemetry available yet from kotekan",
            )
        return chans

    @app.post("/api/rfi/configure", dependencies=[Depends(verify_token)])
    async def configure_rfi(req: RfiConfigureRequest) -> dict[str, Any]:
        """Update Kotekan RFI mitigation thresholds and toggles."""
        try:
            reply = await client.configure_rfi(req)
            return {"status": "ok", "message": reply.strip()}
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.post("/api/rfi/reset_ema", dependencies=[Depends(verify_token)])
    async def reset_rfi_ema(
        req: RfiResetEmaRequest = Body(default_factory=RfiResetEmaRequest),
    ) -> dict[str, Any]:
        """Reset persistent EMA baseline globally or for selected frequencies."""
        try:
            return await client.reset_rfi_ema(req)
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.post("/api/rfi/prewhiten", dependencies=[Depends(verify_token)])
    async def prewhiten_rfi() -> dict[str, Any]:
        """Compute smooth passband pre-whitening gains and push to Kotekan."""
        chans_resp = poller.rfi_channels_latest()
        if chans_resp is None or not chans_resp.channels:
            try:
                chans_resp = await client.get_rfi_channels()
            except TrackerError as exc:
                raise HTTPException(
                    status_code=exc.status_code, detail=exc.message
                ) from exc
            except Exception as exc:
                raise HTTPException(
                    status_code=503,
                    detail="No RFI channel telemetry available for pre-whitening",
                ) from exc

        try:
            g_sb0, g_sb1, meta = compute_prewhitening_gains(chans_resp.channels)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        replies: list[str] = []
        try:
            if g_sb0:
                r0 = await client.set_rfi_gains(SUBBAND0_START_HZ, g_sb0)
                replies.append(r0.strip())
            if g_sb1:
                r1 = await client.set_rfi_gains(SUBBAND1_START_HZ, g_sb1)
                replies.append(r1.strip())
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

        return {
            "status": "ok",
            "subbands_updated": len(replies),
            "meta": meta,
            "replies": replies,
        }

    @app.get("/api/sefd", response_model=SefdSensitivitySummary)
    async def get_sefd() -> SefdSensitivitySummary:
        """Return live SEFD, 4-bit quantizer, and radiometer sensitivity summary."""
        sefd = poller.sefd_latest()
        if sefd is None:
            raise HTTPException(
                status_code=503,
                detail="No SEFD sensitivity summary available yet",
            )
        return sefd

    @app.post("/api/taper", dependencies=[Depends(verify_token)])
    async def set_taper(req: TaperRequest) -> dict[str, str]:
        """Configure 2D spatial taper and weight normalization on Direct Tracker."""
        try:
            reply = await client.set_taper(req)
            return {"status": "ok", "message": reply.strip()}
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.post("/api/calibration/toggle", dependencies=[Depends(verify_token)])
    async def toggle_calibration(req: CalibrationToggleRequest) -> dict[str, str]:
        """Toggle complex calibration gains globally or per beam."""
        try:
            reply = await client.set_calibration(req)
            return {"status": "ok", "message": reply.strip()}
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

    @app.post("/api/calibration/reload", dependencies=[Depends(verify_token)])
    async def reload_calibration(req: ReloadGainsRequest) -> dict[str, Any]:
        """Convert (if .npz) and hot-reload calibration gains into Kotekan."""
        try:
            prep = prepare_gains_for_kotekan(
                req.gains_file, zero_flagged=req.zero_flagged
            )
        except (FileNotFoundError, ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        try:
            kotekan_reply = await client.reload_gains(prep["npy_path"])
        except TrackerError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.message
            ) from exc

        synced_notches: list[list[float]] = []
        if req.sync_rfi_notches and prep.get("static_notch_bands_mhz"):
            synced_notches = prep["static_notch_bands_mhz"]
            try:
                await client.configure_rfi(
                    RfiConfigureRequest(static_notch_bands_mhz=synced_notches)
                )
            except TrackerError as exc:
                raise HTTPException(
                    status_code=exc.status_code, detail=exc.message
                ) from exc

        return {
            "status": "ok",
            "gains_file": prep["npy_path"],
            "converted": bool(prep["converted"]),
            "active_antennas": prep.get("active_antennas", []),
            "synced_notches": synced_notches,
            "kotekan": kotekan_reply,
        }

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
        antenna_id: int = PathParam(..., ge=0, lt=64),
    ) -> dict[str, Any]:
        """Return 672-ch line spectrum for a specific antenna from cudaAntennaMaskCommand."""
        return poller.antenna_spectrum(antenna_id)

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
        """Stream status, spectrometer, RFI, SEFD, and antenna mask updates to browsers."""
        await ws.accept()
        status_q = poller.subscribe()
        spec_q = poller.subscribe_spectrometer()
        rfi_q = poller.subscribe_rfi()
        sefd_q = poller.subscribe_sefd()
        mask_q = poller.subscribe_antenna_mask()
        routine_q = routine.subscribe() if routine is not None else None

        latest = poller.latest()
        if latest is not None:
            if not await _send_ws_text(ws, latest.model_dump_json()):
                poller.unsubscribe(status_q)
                poller.unsubscribe_spectrometer(spec_q)
                poller.unsubscribe_rfi(rfi_q)
                poller.unsubscribe_sefd(sefd_q)
                poller.unsubscribe_antenna_mask(mask_q)
                if routine_q is not None:
                    routine.unsubscribe(routine_q)
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

        latest_rfi = poller.rfi_bundle_latest()
        if latest_rfi is not None:
            await _send_ws_text(
                ws, json.dumps({"type": "rfi", "data": latest_rfi})
            )

        latest_sefd = poller.sefd_latest()
        if latest_sefd is not None:
            await _send_ws_text(
                ws, f'{{"type":"sefd","data":{latest_sefd.model_dump_json()}}}'
            )

        latest_mask = poller.antenna_mask_latest()
        if latest_mask is not None:
            await _send_ws_text(
                ws, f'{{"type":"antenna_mask","data":{latest_mask.model_dump_json()}}}'
            )

        try:
            async with anyio.create_task_group() as tg:

                async def push_queue(
                    q: asyncio.Queue[Any],
                    formatter: Callable[[Any], str],
                ) -> None:
                    try:
                        while True:
                            item = await q.get()
                            await ws.send_text(formatter(item))
                    except Exception:
                        pass
                    finally:
                        tg.cancel_scope.cancel()

                async def reader() -> None:
                    try:
                        while True:
                            await ws.receive_text()
                    except Exception:
                        pass
                    finally:
                        tg.cancel_scope.cancel()

                tg.start_soon(reader)
                tg.start_soon(push_queue, status_q, lambda s: s.model_dump_json())
                tg.start_soon(
                    push_queue,
                    spec_q,
                    lambda spec: f'{{"type":"spectrometer","data":{spec.model_dump_json()}}}',
                )
                tg.start_soon(
                    push_queue,
                    rfi_q,
                    lambda b: json.dumps({"type": "rfi", "data": b}),
                )
                tg.start_soon(
                    push_queue,
                    sefd_q,
                    lambda sefd: f'{{"type":"sefd","data":{sefd.model_dump_json()}}}',
                )
                tg.start_soon(
                    push_queue,
                    mask_q,
                    lambda m: f'{{"type":"antenna_mask","data":{m.model_dump_json()}}}',
                )
                if routine_q is not None:
                    tg.start_soon(
                        push_queue,
                        routine_q,
                        lambda st: f'{{"type":"routine","data":{st.model_dump_json()}}}',
                    )
        except (WebSocketDisconnect, ConnectionResetError, RuntimeError):
            pass
        finally:
            if routine_q is not None:
                routine.unsubscribe(routine_q)
            poller.unsubscribe(status_q)
            poller.unsubscribe_spectrometer(spec_q)
            poller.unsubscribe_rfi(rfi_q)
            poller.unsubscribe_sefd(sefd_q)
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
