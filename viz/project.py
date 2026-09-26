"""Project an index's chunk vectors to 2D with UMAP (cosine), once per index build.

    uv run --with umap-learn python viz/project.py <cache-dir>

Reads vectors.i8 + scales.f32 + dim from the cache dir, writes coords.f32 (x, y per chunk).
"""
import sys
from pathlib import Path

import numpy as np
import umap

d = Path(sys.argv[1])
dim = int((d / "dim").read_text())
v = np.fromfile(d / "vectors.i8", dtype=np.int8).astype(np.float32).reshape(-1, dim)
v *= np.fromfile(d / "scales.f32", dtype=np.float32)[:, None]
v /= np.linalg.norm(v, axis=1, keepdims=True) + 1e-12
xy = umap.UMAP(n_neighbors=15, min_dist=0.1, metric="cosine", random_state=42, verbose=True).fit_transform(v)
xy.astype(np.float32).tofile(d / "coords.f32")
print(f"projected {len(v)} chunks")
