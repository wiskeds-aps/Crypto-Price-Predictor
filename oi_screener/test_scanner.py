from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scanner import _classify, _score_signal


def test_classify_core_signals():
    assert _classify(1.0, 2.0) == "PUMP"
    assert _classify(-1.0, 2.0) == "DUMP"
    assert _classify(1.0, -2.0) == "SHORT_SQUEEZE"
    assert _classify(-1.0, -2.0) == "LONG_SQUEEZE"


def test_score_prefers_aligned_flow():
    pump_aligned = _score_signal(1.0, 3.0, 2.0, 0.7, "PUMP")
    pump_opposed = _score_signal(1.0, 3.0, 2.0, 0.3, "PUMP")
    dump_aligned = _score_signal(-1.0, 3.0, 2.0, 0.3, "DUMP")
    assert pump_aligned > pump_opposed
    assert dump_aligned > pump_opposed
