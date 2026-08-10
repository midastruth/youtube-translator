"""Tests for subtitle processing (segmentation) module."""

import unittest

from youtube_ingest.subtitle_processing import (
    FlatEvent,
    clean_timed_text,
    format_subtitles,
    intelligent_sentence_break,
    prepare_timed_text_events,
    split_events_into_chunks,
    builtin_segment,
)
from youtube_ingest.subtitle_text_classification import is_non_speech_segment


class CleanTimedTextTest(unittest.TestCase):
    def test_html_tags(self):
        self.assertEqual(clean_timed_text('<font color="red">Hello</font>'), "Hello")

    def test_zero_width_space(self):
        self.assertEqual(clean_timed_text("Hello\u200BWorld"), "HelloWorld")

    def test_collapse_whitespace(self):
        self.assertEqual(clean_timed_text(" 多个   空格 "), "多个 空格")

    def test_empty(self):
        self.assertEqual(clean_timed_text(""), "")
        self.assertEqual(clean_timed_text(), "")


class NonSpeechSegmentTest(unittest.TestCase):
    def test_music_bracket(self):
        self.assertTrue(is_non_speech_segment("[Music]"))

    def test_laughter(self):
        self.assertTrue(is_non_speech_segment("[Laughter]"))

    def test_multiple(self):
        self.assertTrue(is_non_speech_segment("[Music] [Applause]"))

    def test_speaker_arrow_music(self):
        self.assertTrue(is_non_speech_segment(">> [Music]"))

    def test_normal_text(self):
        self.assertFalse(is_non_speech_segment("Hello world"))
        self.assertFalse(is_non_speech_segment("Use [React] in this project"))


class PrepareTimedTextEventsTest(unittest.TestCase):
    def test_simple(self):
        raw = [
            {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "Hello", "tOffsetMs": 0}]},
        ]
        result = prepare_timed_text_events(raw)
        self.assertEqual(len(result["flat_events"]), 1)
        self.assertEqual(result["flat_events"][0].text, "Hello")
        self.assertEqual(result["flat_events"][0].start, 0)
        self.assertEqual(result["flat_events"][0].end, 500)

    def test_two_words_same_event(self):
        raw = [
            {
                "tStartMs": 0,
                "dDurationMs": 1000,
                "segs": [
                    {"utf8": "Hello", "tOffsetMs": 0},
                    {"utf8": " world.", "tOffsetMs": 100},
                ],
            },
        ]
        result = prepare_timed_text_events(raw)
        self.assertEqual(len(result["flat_events"]), 2)
        self.assertEqual(result["flat_events"][0].text, "Hello")
        self.assertEqual(result["flat_events"][1].text, "world.")

    def test_adjacent_duplicates_removed(self):
        raw = [
            {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "Hi", "tOffsetMs": 0}]},
            {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "Hi", "tOffsetMs": 0}]},
        ]
        result = prepare_timed_text_events(raw)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(len(result["flat_events"]), 1)

    def test_non_speech_filtered(self):
        raw = [
            {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "[Music]", "tOffsetMs": 0}]},
            {"tStartMs": 600, "dDurationMs": 800, "segs": [{"utf8": "Hello", "tOffsetMs": 0}]},
        ]
        result = prepare_timed_text_events(raw)
        self.assertEqual(len(result["flat_events"]), 1)
        self.assertEqual(result["flat_events"][0].text, "Hello")
        self.assertEqual(result["filtered_non_speech_count"], 1)


class FormatSubtitlesTest(unittest.TestCase):
    def test_cjk_simple(self):
        fe = [
            FlatEvent(text="你好", start=0, end=500),
            FlatEvent(text="世界。", start=550, end=1000),
        ]
        cues = format_subtitles(fe, lang="zh")
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0]["text"], "你好世界。")
        self.assertEqual(cues[0]["start"], 0)
        self.assertEqual(cues[0]["end"], 1000)

    def test_cjk_split_on_punctuation(self):
        fe = [
            FlatEvent(text="你好。", start=0, end=500),
            FlatEvent(text="世界！", start=600, end=1100),
        ]
        cues = format_subtitles(fe, lang="zh")
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0]["text"], "你好。")
        self.assertEqual(cues[1]["text"], "世界！")

    def test_cjk_pause_split(self):
        fe = [
            FlatEvent(text="你好", start=0, end=500),
            FlatEvent(text="世界", start=3000, end=3500),
        ]
        cues = format_subtitles(fe, lang="zh")
        self.assertEqual(len(cues), 2)

    def test_english_basic(self):
        fe = [
            FlatEvent(text="Hello", start=0, end=100),
            FlatEvent(text="world.", start=150, end=500),
            FlatEvent(text="This", start=600, end=700),
            FlatEvent(text="is", start=750, end=850),
            FlatEvent(text="a test.", start=900, end=1400),
        ]
        cues = format_subtitles(fe, lang="en")
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0]["text"], "Hello world.")
        self.assertEqual(cues[1]["text"], "This is a test.")

    def test_english_long_sentence_threshold(self):
        words = [FlatEvent(text=f"word{i}", start=i * 100, end=i * 100 + 80)
                  for i in range(50)]
        cues = format_subtitles(words, lang="en", long_sentence_threshold=120)
        # Should split the very long sequence
        self.assertGreater(len(cues), 1)


class SplitEventsIntoChunksTest(unittest.TestCase):
    def test_basic(self):
        fe = [FlatEvent(text="a" * 100, start=i * 100, end=i * 100 + 80)
              for i in range(30)]
        chunks = split_events_into_chunks(fe, chunk_length=500)
        self.assertGreater(len(chunks), 1)
        # All events should be accounted for
        total = sum(len(c) for c in chunks)
        self.assertEqual(total, 30)

    def test_single_event(self):
        fe = [FlatEvent(text="short", start=0, end=100)]
        chunks = split_events_into_chunks(fe)
        self.assertEqual(len(chunks), 1)

    def test_empty(self):
        self.assertEqual(split_events_into_chunks([]), [])


class IntelligentSentenceBreakTest(unittest.TestCase):
    def test_basic(self):
        data = {
            "events": [
                {
                    "tStartMs": 0,
                    "dDurationMs": 2000,
                    "segs": [
                        {"utf8": "Hello", "tOffsetMs": 0},
                        {"utf8": " world.", "tOffsetMs": 100},
                    ],
                },
                {
                    "tStartMs": 2100,
                    "dDurationMs": 3000,
                    "segs": [
                        {"utf8": "My", "tOffsetMs": 0},
                        {"utf8": " name", "tOffsetMs": 100},
                        {"utf8": " is Python.", "tOffsetMs": 200},
                    ],
                },
            ]
        }
        results = intelligent_sentence_break(data)
        self.assertGreater(len(results), 0)
        self.assertIn("Hello", results[0]["text"])
        self.assertIn("Python", results[-1]["text"])

    def test_empty(self):
        self.assertEqual(intelligent_sentence_break({}), [])
        self.assertEqual(intelligent_sentence_break({"events": []}), [])


class BuiltinSegmentTest(unittest.TestCase):
    def test_rule_mode(self):
        events = [
            {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "Hi there.", "tOffsetMs": 0}]},
        ]
        fe = [FlatEvent(text="Hi there.", start=0, end=500)]
        cues = builtin_segment(events, fe, from_lang="en", mode="rule")
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0]["text"], "Hi there.")

    def test_statistical_falls_back(self):
        events: list = []
        fe: list = []
        cues = builtin_segment(events, fe, from_lang="en", mode="statistical")
        self.assertEqual(cues, [])


if __name__ == "__main__":
    unittest.main()
