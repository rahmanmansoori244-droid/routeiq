"""The API process must never load PyVRP's native library.

On Linux, PyVRP 0.14's native module in the same process as OR-Tools' crashed the solver API with
a segmentation fault (GitHub CI, PR #50). PyVRP now runs only in worker processes (the second route
search) and inside the unused legacy /optimize solve, which imports it lazily. Importing the API
module - what uvicorn does at startup - must not import it.
"""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap

SOLVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_importing_the_api_does_not_load_pyvrp():
    code = textwrap.dedent(
        """
        import sys
        import main  # noqa: F401 - the API module, as uvicorn loads it
        loaded = sorted(m for m in sys.modules if m == "pyvrp" or m.startswith("pyvrp."))
        print("LOADED=" + ",".join(loaded))
        """
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=SOLVER_DIR, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-3000:]
    assert "LOADED=\n" in r.stdout or r.stdout.strip().endswith("LOADED="), r.stdout[-2000:]


def test_legacy_solver_imports_pyvrp_only_when_used():
    code = textwrap.dedent(
        """
        import sys
        import solver
        before = "pyvrp" in sys.modules
        solver._pyvrp_params()
        after = "pyvrp" in sys.modules
        print(f"BEFORE={before} AFTER={after}")
        """
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=SOLVER_DIR, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-3000:]
    assert "BEFORE=False AFTER=True" in r.stdout, r.stdout[-2000:]
