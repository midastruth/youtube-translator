import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from youtube_ingest import cli


class DotenvTests(unittest.TestCase):
    def test_main_loads_dotenv_without_overriding_existing_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "WHISPER_API_KEY=from-dotenv\nWHISPER_MODEL=from-dotenv\n",
                encoding="utf-8",
            )

            old_cwd = Path.cwd()
            os.chdir(directory)
            try:
                with patch.dict(
                    os.environ,
                    {"WHISPER_MODEL": "from-environment"},
                    clear=True,
                ), patch.object(cli, "ingest", side_effect=RuntimeError("stop")):
                    with self.assertRaisesRegex(RuntimeError, "stop"):
                        cli.main(["https://www.youtube.com/watch?v=test"])

                    self.assertEqual(os.environ["WHISPER_API_KEY"], "from-dotenv")
                    self.assertEqual(os.environ["WHISPER_MODEL"], "from-environment")
            finally:
                os.chdir(old_cwd)


if __name__ == "__main__":
    unittest.main()
