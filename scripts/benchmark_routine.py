"""Benchmark for RoutineRunner._apply_slot performance."""

import asyncio
import time

from viewer.models import CelestialRequest
from viewer.routine import BeamAssignment, RoutineRunner, RoutineSlot


class DelayedClient:
    def __init__(self, latency_s: float = 0.01) -> None:
        self.latency_s = latency_s

    async def set_num_active_beams(self, n: int) -> str:
        await asyncio.sleep(self.latency_s)
        return f"Active beams set to {n}"

    async def set_celestial_target(self, req: CelestialRequest) -> str:
        await asyncio.sleep(self.latency_s)
        return f"Beam {req.beam_id} celestial target updated"


async def main() -> None:
    num_beams = 10
    latency_s = 0.01  # 10ms per HTTP call
    client = DelayedClient(latency_s=latency_s)

    assignments = [
        BeamAssignment(
            beam_id=i,
            label=f"Target-{i}",
            ra_deg=10.0 * i,
            dec_deg=-20.0 + i,
            altitude_deg=45.0,
        )
        for i in range(num_beams)
    ]
    slot = RoutineSlot(time_local="12:00", assignments=assignments)

    # Schedule dummy
    runner = RoutineRunner(client=client, schedule=None)  # type: ignore

    # Warmup
    await runner._apply_slot(slot)

    # Measure 5 runs
    runs = 5
    start = time.perf_counter()
    for _ in range(runs):
        # Reset beam set state to test setting targets
        runner._active_beams_set = num_beams
        await runner._apply_slot(slot)
    total_time = time.perf_counter() - start

    avg_time = total_time / runs
    print(f"Number of beams: {num_beams}")
    print(f"Simulated latency per request: {latency_s * 1000:.1f} ms")
    print(f"Average _apply_slot duration: {avg_time * 1000:.2f} ms")


if __name__ == "__main__":
    asyncio.run(main())
