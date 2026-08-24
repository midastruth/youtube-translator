import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from youtube_ingest.youtube import build_yt_dlp_command, choose_subtitle, vtt_to_text


class YtDlpCommandTests(unittest.TestCase):
    @patch.dict("os.environ", {}, clear=True)
    def test_helpers_are_optional(self) -> None:
        command = build_yt_dlp_command(["--version"])
        self.assertEqual(command[1:], ["-m", "yt_dlp", "--version"])
        self.assertNotIn("--extractor-args", command)

    @patch.dict("os.environ", {
        "YTDLP_YOUTUBE_CLIENT": "android,mweb",
        "YTDLP_POT_PROVIDER_URL": "http://pot-provider:4416/",
    }, clear=True)
    def test_helpers_are_added_to_command(self) -> None:
        command = build_yt_dlp_command(["--version"])
        self.assertIn("youtube:player_client=android,mweb", command)
        self.assertIn(
            "youtubepot-bgutilhttp:base_url=http://pot-provider:4416",
            command,
        )
        self.assertEqual(command[-1], "--version")

    @patch.dict("os.environ", {"YTDLP_COOKIES_FILE": "/run/secrets/youtube-cookies.txt"}, clear=True)
    def test_cookie_file_is_added_to_command(self) -> None:
        command = build_yt_dlp_command(["--version"])
        self.assertIn("--cookies", command)
        self.assertIn("/run/secrets/youtube-cookies.txt", command)


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
