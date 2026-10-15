"""Benchmark script comparing unoptimized Python list comprehension vs NumPy vectorized rounding."""

import time

import numpy as np


def benchmark_loop_vs_vectorized(
    n_channels: int = 672, n_beams: int = 16, iterations: int = 5000
) -> None:
    rng = np.random.default_rng(42)
    combined_db = rng.uniform(-60.0, 10.0, size=(n_channels, n_beams))

    # Baseline (unoptimized Python list comprehension loop)
    t0 = time.perf_counter()
    for _ in range(iterations):
        for b_idx in range(n_beams):
            spec_vals = [round(float(v), 2) for v in combined_db[:, b_idx]]
            spec_arr = np.array(spec_vals, dtype=np.float64)
            _ = spec_arr.tolist()
    t_baseline = time.perf_counter() - t0

    # Optimized (vectorized np.round and .tolist())
    t0 = time.perf_counter()
    for _ in range(iterations):
        rounded_db = np.round(combined_db, 2)
        for b_idx in range(n_beams):
            spec_arr = rounded_db[:, b_idx]
            _ = spec_arr.tolist()
    t_optimized = time.perf_counter() - t0

    speedup = t_baseline / t_optimized if t_optimized > 0 else 0.0

    print(
        f"=== Spectrometer Rounding Benchmark ({iterations} iterations, {n_channels}x{n_beams} shape) ==="
    )
    print(
        f"Baseline (Python list comprehension loop): {t_baseline:.4f} s ({t_baseline / iterations * 1e3:.3f} ms/iter)"
    )
    print(
        f"Optimized (NumPy np.round vectorized):   {t_optimized:.4f} s ({t_optimized / iterations * 1e3:.3f} ms/iter)"
    )
    print(f"Speedup: {speedup:.2f}x faster")


if __name__ == "__main__":
    benchmark_loop_vs_vectorized()
