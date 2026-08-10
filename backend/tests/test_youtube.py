import tempfile
import unittest
from pathlib import Path

from youtube_ingest.youtube import choose_subtitle, vtt_to_text


class SubtitleSelectionTests(unittest.TestCase):
    def test_manual_subtitle_wins_over_automatic(self) -> None:
        metadata = {
            "subtitles": {"en": [{}]},
            "automatic_captions": {"zh-Hans": [{}]},
        }
        self.assertEqual(choose_subtitle(metadata, ["zh", "en"]), ("en", "manual"))

    def test_language_prefix_is_supported(self) -> None:
        metadata = {"subtitles": {"zh-Hant-TW": [{}]}}
        self.assertEqual(choose_subtitle(metadata, ["zh-Hant"]), ("zh-Hant-TW", "manual"))


class VttTests(unittest.TestCase):
    def test_vtt_is_cleaned_and_rolling_cues_are_collapsed(self) -> None:
        value = """WEBVTT

00:00:00.000 --> 00:00:01.000
Hello

00:00:01.000 --> 00:00:02.000
Hello world

00:00:02.000 --> 00:00:03.000
<c>Next &amp; final</c>

00:00:03.000 --> 00:00:04.000
1984
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.vtt"
            path.write_text(value, encoding="utf-8")
            self.assertEqual(vtt_to_text(path), "Hello world\nNext & final\n1984\n")


if __name__ == "__main__":
    unittest.main()
