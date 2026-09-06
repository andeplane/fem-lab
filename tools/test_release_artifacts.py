import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('release_artifacts', Path(__file__).with_name('release-artifacts.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseArtifacts(unittest.TestCase):
    def test_versions_and_tag_must_agree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'packages/mcp').mkdir(parents=True)
            (root / 'Cargo.toml').write_text('[workspace.package]\nversion="1.2.3"\n')
            manifest = root / 'packages/mcp/package.json'
            manifest.write_text(json.dumps({'version': '1.2.3'}))
            self.assertEqual(release.version(root, 'v1.2.3'), '1.2.3')
            with self.assertRaises(ValueError):
                release.version(root, 'v1.2.4')
            manifest.write_text(json.dumps({'version': '1.2.4'}))
            with self.assertRaises(ValueError):
                release.version(root)

    def test_archive_preserves_bytes_names_and_executable_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'binary'
            binary.write_bytes(b'actual executable bytes')
            binary.chmod(0o755)
            output = root / 'release/cli.zip'
            release.archive(output, [(binary, 'femlab')])
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), ['femlab'])
                self.assertEqual(archive.read('femlab'), binary.read_bytes())
                self.assertEqual((archive.getinfo('femlab').external_attr >> 16) & 0o777, 0o755)

    def test_checksums_cover_each_artifact_and_change_with_its_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'z.zip').write_bytes(b'zip')
            (root / 'a.tgz').write_bytes(b'npm')
            release.checksums(root)
            initial = (root / 'SHA256SUMS').read_text()
            self.assertEqual(initial, hashlib.sha256(b'npm').hexdigest() + '  a.tgz\n' +
                             hashlib.sha256(b'zip').hexdigest() + '  z.zip\n')
            (root / 'a.tgz').write_bytes(b'changed')
            release.checksums(root)
            self.assertNotEqual((root / 'SHA256SUMS').read_text(), initial)
            self.assertNotIn('SHA256SUMS', (root / 'SHA256SUMS').read_text())


if __name__ == '__main__':
    unittest.main()
