"""Subtitle text classification — mirrors kiss-translator's subtitleTextClassification.js."""

import re

# Pure bracket segments are typically music/laughter etc sound descriptions.
_NON_SPEECH_SEGMENT_RE = re.compile(r"^(?:>>\s*)?(?:\[[^\]\r\n]+\]\s*)+$")


def is_non_speech_segment(text: str = "") -> bool:
    """Return True when the subtitle segment consists entirely of non-speech markers."""
    return bool(_NON_SPEECH_SEGMENT_RE.match(text.strip()))
