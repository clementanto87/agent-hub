"""Backwards compatibility shim for fast_reply."""
from services.fast_reply import (
    ENABLED,
    PRIMARY_MODEL as MODEL,
    HANDOFF_TOKEN,
    warm_up,
    build_messages,
    stream_reply,
)
