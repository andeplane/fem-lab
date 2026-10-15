"""Network-free tests of the independent acquisition and numerical-oracle checks."""

import copy
import io
import json
import math
from pathlib import Path
import tarfile
import tempfile
import unittest

import corpus


PRINTED = """
 S T E P 1
 displacements (vx,vy,vz) for set OTHER and time 1.0
 7 9 9 9

 displacements (vx,vy,vz) for set NALL and time 1.000000D+00

 101 0.000000E+00 -2.000000E-02 0.000000E+00
 205 3.000000D-02 0.000000E+00 0.000000E+00

 forces (fx,fy,fz) for set NALL and time 1.0
 101 1.000000E+00 2.000000E+00 3.000000E+00
"""


class ReferenceTests(unittest.TestCase):
    def test_author_probe_uses_direct_u_and_checks_duplicate_attachments(self):
        source = "*PART,NAME=Beam\n*NODE\n7,1.5,2,3\n205,4,5,6\n*END PART\n"
        probe = """Variable: U, All direct
 BEAM-1 7 1.5 2 3 1.51 2.02 3.03
 BEAM-1 205 4 5 6 4.04 5.05 6.06
 Part Instance Node ID Attached elements           U, U1           U, U2           U, U3
 BEAM-1 7 1 0.001 0.002 0.003
 BEAM-1 7 2 0.001 0.002 0.003
 BEAM-1 205 2 0.004 0.005 0.006
"""
        self.assertEqual(corpus.abaqus_probe_reference(probe, "BEAM-1", source),
                         {7: [.001, .002, .003], 205: [.004, .005, .006]})
        for changed in [probe.replace("7 2 0.001", "7 2 0.009"),
                        probe.replace("205 4 5 6", "205 4 5 7"),
                        probe.replace("BEAM-1 205 2 0.004 0.005 0.006", ""),
                        probe.replace("7 1 0.001", "7 1 NaN")]:
            with self.assertRaises(ValueError):
                corpus.abaqus_probe_reference(changed, "BEAM-1", source)

    def test_observed_freecad_reference_is_pinned_to_the_executed_original(self):
        manifest = json.loads(corpus.MANIFEST.read_text())
        case = next(case for case in manifest["comparisons"] if case["id"] == "freecad-testcube")
        data = (corpus.ROOT / case["reference"]).read_bytes()
        original_hash = "76d7a103106122f6d7872d4c1124223bfcd1e10eb968ce27e8213e4647048eb5"
        rows = corpus.executed_reference(data, case["referenceIdentity"], original_hash)
        self.assertEqual(len(rows), 26)
        # These exact values were independently read from the retained CalculiX DAT.
        self.assertEqual(rows[2], [3.094636e-5, -5.444519e-6, -1.269312e-4])
        self.assertEqual(rows[1], [0, 0, 0])
        for field, value in [("unchangedBeforeAndAfterRun", False), ("sha256", "0" * 64)]:
            changed = json.loads(data)
            changed["input"][field] = value
            payload = json.dumps(changed).encode()
            with self.assertRaisesRegex(ValueError, "provenance"):
                corpus.executed_reference(payload, {"bytes": len(payload), "sha256": corpus.digest(payload)}, original_hash)
        changed = json.loads(data)
        changed["rawOutput"]["displacementUnit"] = "m"
        payload = json.dumps(changed).encode()
        with self.assertRaisesRegex(ValueError, "provenance"):
            corpus.executed_reference(payload, {"bytes": len(payload), "sha256": corpus.digest(payload)}, original_hash)

    def test_labels_units_and_block_identity_are_independent_of_dense_order(self):
        reference = corpus.reference_displacements(PRINTED, "NALL", 1)
        proof = corpus.compare_displacements([205, 101], [3e-5, 0, 0, 0, -2e-5, 0], reference, .001, 2e-6, 1e-13)
        self.assertEqual(proof["referenceNodes"], 2)
        self.assertLess(proof["errorMetres"], 1e-20)
        self.assertEqual(reference[101], [0, -.02, 0])

    def test_wrong_units_component_sign_or_label_mapping_fail(self):
        reference = corpus.reference_displacements(PRINTED, "NALL", 1)
        for values in [[.03, 0, 0, 0, -.02, 0], [3e-5, 0, 0, 0, 2e-5, 0],
                       [0, -2e-5, 0, 3e-5, 0, 0]]:
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, "displacement mismatch"):
                corpus.compare_displacements([205, 101], values, reference, .001, 2e-6, 1e-13)

    def test_missing_duplicate_nonfinite_or_additional_solved_nodes_fail(self):
        reference = corpus.reference_displacements(PRINTED, "NALL", 1)
        for labels, values in [([101], [0, -2e-5, 0]), ([101, 101], [0] * 6),
                               ([101, 205, 900], [0] * 9), ([101, 205], [math.nan] * 6)]:
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                corpus.compare_displacements(labels, values, reference, .001, 2e-6, 1e-13)

    def test_missing_or_duplicate_requested_reference_block_fails(self):
        for text in [PRINTED.replace("set NALL", "set MISSING"), PRINTED + PRINTED]:
            with self.assertRaisesRegex(ValueError, "exactly one"):
                corpus.reference_displacements(text, "NALL", 1)

    def test_duplicate_malformed_and_nonfinite_reference_rows_fail(self):
        for change in [PRINTED.replace(" 205 ", " 101 "),
                       PRINTED.replace(" 101 0.000000E+00", " malformed 0.000000E+00"),
                       PRINTED.replace("3.000000D-02", "NaN")]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                corpus.reference_displacements(change, "NALL", 1)

    def test_reaction_balance_rejects_dropped_load_and_wrong_force_units(self):
        field = {"components": 3, "unit": "N", "values": [0, -4, 0, 0, -5, 0]}
        self.assertEqual(corpus.total_reaction(field, [0, 9, 0]), [0, -9, 0])
        for changed in [{**field, "values": [0, -4, 0, 0, 0, 0]}, {**field, "unit": "kN"},
                        {**field, "values": [math.nan, -9, 0]}]:
            with self.assertRaises(ValueError):
                corpus.total_reaction(changed, [0, 9, 0])


class AcquisitionTests(unittest.TestCase):
    def test_export_inventory_requires_complete_mesh_keywords_and_provenance(self):
        text = "** Independent unit-test fixture; exporter=example\n*NODE\n"
        text += "".join(f"{label},0,0\n" for label in range(1, 11))
        text += "*ELEMENT,TYPE=C3D10\n25,1,2,3,4,5,6,7,8,9,10\n"
        case = {"id": "example-export", "deck": "example.inp", "element": "C3D10", "nodes": 10,
                "elements": 1, "keywords": ["NODE", "ELEMENT"], "metadataMarkers": ["exporter=example"]}
        manifest = {"artifacts": [], "comparisons": [], "exporterAdmissionCases": [case]}
        with tempfile.TemporaryDirectory(prefix="femlab-656-export-unit-") as directory:
            deck = Path(directory) / "example.inp"
            deck.write_text(text)
            self.assertEqual(corpus.check_sources(manifest, directory)[0]["elements"], 1)
            for changed in [text.replace("exporter=example", "exporter=other"), text + "*DLOAD\n25,P1,1\n",
                            text.replace("9,10", "9,999")]:
                deck.write_text(changed)
                with self.assertRaises(ValueError):
                    corpus.check_sources(manifest, directory)

    def test_sparse_element_labels_count_records_not_maximum_label(self):
        text = "*NODE\n" + "".join(f"{label},0,0\n" for label in range(101, 111))
        text += "*ELEMENT,TYPE=C3D10\n67,101,102,103,104,105,\n106,107,108,109,110\n"
        nodes, elements = corpus.flat_source_inventory(text, "C3D10")
        self.assertEqual(nodes, set(range(101, 111)))
        self.assertEqual(elements, [67])
        for changed in [text.replace(",110\n", "\n"), text.replace("109,110", "109,999")]:
            with self.assertRaises(ValueError):
                corpus.flat_source_inventory(changed, "C3D10")

    def test_corrupt_source_is_rejected_even_when_size_matches(self):
        original = b"independent source"
        expected = {"bytes": len(original), "sha256": corpus.digest(original)}
        self.assertEqual(corpus.checked(original, expected), original)
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            corpus.checked(b"Independent source", expected)
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            corpus.checked(original + b"\n", expected)

    def test_only_the_pinned_regular_archive_member_is_read(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:bz2") as archive:
            for name, payload in [("./official/deck.inp", b"*NODE\n1,0,0,0\n"), ("../../do-not-extract", b"unselected")]:
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
        payload = b"*NODE\n1,0,0,0\n"
        expected = {"name": "./official/deck.inp", "file": "deck.inp", "bytes": len(payload), "sha256": corpus.digest(payload)}
        self.assertEqual(corpus.selected_members(buffer.getvalue(), [expected]), {"deck.inp": payload})
        with self.assertRaises(ValueError):
            corpus.selected_members(buffer.getvalue(), [{**expected, "sha256": "0" * 64}])

    def test_archive_link_cannot_replace_an_attested_member(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:bz2") as archive:
            member = tarfile.TarInfo("./official/deck.inp")
            member.type, member.linkname = tarfile.SYMTYPE, "/etc/passwd"
            archive.addfile(member)
        expected = {"name": "./official/deck.inp", "file": "deck.inp", "bytes": 0, "sha256": corpus.digest(b"")}
        with self.assertRaisesRegex(ValueError, "unexpected archive member"):
            corpus.selected_members(buffer.getvalue(), [expected])

    def test_existing_evidence_is_immutable_and_downloads_stay_external(self):
        with tempfile.TemporaryDirectory(prefix="femlab-656-unit-") as directory:
            target = Path(directory) / "proof"
            corpus.write_once(target, b"original")
            corpus.write_once(target, b"original")
            with self.assertRaisesRegex(ValueError, "overwrite"):
                corpus.write_once(target, b"changed")
        with self.assertRaisesRegex(ValueError, "outside the checkout"):
            corpus.external(corpus.ROOT / "reference-downloads")


class AssemblyOracleTests(unittest.TestCase):
    def fields(self):
        positions, displacements, stresses, reactions = [], [], [], []
        # Hand-specified interface and tip answers, independent of the harness formula.
        for second in [False, True]:
            for x, axial in [(0, 0), (.5, 2.5e-7), (1, 7.5e-7)]:
                for y, z in [(0, 0), (.1, 0), (0, .1), (.1, .1)]:
                    positions.extend([-y, 2 + x, z] if second else [x, y, z])
                    displacements.extend([0, axial, 0] if second else [axial, 0, 0])
                    stresses.extend([0, 1e5, 0, 0, 0, 0] if second else [1e5, 0, 0, 0, 0, 0])
                    reactions.extend([0, -250, 0] if second and x == 0 else [-250, 0, 0] if x == 0 else [0, 0, 0])
        return ({"unit": "m", "nodeCount": 24, "positions": positions},
                {"values": displacements}, {"values": stresses},
                {"components": 3, "unit": "N", "values": reactions})

    def test_two_material_interface_and_transformed_tip_answers(self):
        proof = corpus.authored_oracle(*self.fields())
        self.assertEqual(proof["reactionNewtons"], [-1000, -1000, 0])

    def test_homogeneous_material_substitution_does_not_pass(self):
        fields = copy.deepcopy(self.fields())
        fields[1]["values"][24] = 5e-7  # First bar tip with E=200 GPa throughout.
        with self.assertRaisesRegex(ValueError, "displacement mismatch"):
            corpus.authored_oracle(*fields)

    def test_missing_instance_rotation_does_not_pass(self):
        fields = copy.deepcopy(self.fields())
        fields[2]["values"][72:78] = [1e5, 0, 0, 0, 0, 0]
        with self.assertRaisesRegex(ValueError, "stress mismatch"):
            corpus.authored_oracle(*fields)

    def test_duplicate_instance_positions_do_not_pass(self):
        fields = copy.deepcopy(self.fields())
        fields[0]["positions"][36:] = fields[0]["positions"][:36]
        with self.assertRaisesRegex(ValueError, "instance geometry"):
            corpus.authored_oracle(*fields)


if __name__ == "__main__":
    unittest.main()
