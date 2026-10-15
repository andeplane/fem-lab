"""Billing cannot become active through a default release or cross-environment binding."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('billing_config', Path(__file__).with_name('billing_config.py'))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class BillingConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.calls = []
        self.missing_key = False
        for mode in ('test', 'live'):
            catalog = json.loads(Path(__file__).with_name(mode + '.json').read_text())
            catalog['taxMode'] = 'not_collecting'
            for gate in config.GATES + ('stagingCheckoutVerified', 'webhookVerified'):
                catalog[gate] = True
            (self.root / (mode + '.json')).write_text(json.dumps(catalog))

    def gcloud(self, *args, optional=False):
        self.calls.append(args)
        if args[:3] == ('secrets', 'versions', 'access'):
            return SimpleNamespace(returncode=0, stdout='rk_test_' + 'T' * 32)
        missing = self.missing_key and args[3] == 'stripe-api-key'
        return SimpleNamespace(returncode=1 if missing else 0, stdout='' if missing else '7\n')

    def test_unconfigured_remains_disabled_and_does_not_read_any_key(self):
        self.missing_key = True
        result = config.resolve('staging', 'femlab-app-staging', self.gcloud, root=self.root)
        self.assertEqual(result['env'], {'BILLING_ENABLED': 'false', 'BILLING_TAX_MODE': 'not_collecting'})
        self.assertEqual(result['secrets'], {})
        self.assertFalse(any('access' in args for args in self.calls))

    def test_configured_disabled_retains_recovery_and_webhook_bindings(self):
        verified = []
        result = config.resolve('staging', 'femlab-app-staging', self.gcloud, root=self.root,
                                verify=lambda key, mode, catalog: verified.append((mode, catalog['project'])))
        self.assertEqual(verified, [('test', 'femlab-app-staging')])
        self.assertEqual(result['env']['BILLING_ENABLED'], 'false')
        self.assertEqual(result['env']['BILLING_MODE'], 'test')
        self.assertEqual(result['env']['BILLING_TAX_MODE'], 'not_collecting')
        self.assertEqual(result['secrets'], {'STRIPE_SECRET_KEY': 'stripe-api-key:7', 'STRIPE_WEBHOOK_SECRET': 'stripe-webhook-secret:7'})
        self.assertNotIn('rk_test_', json.dumps(result))

    def test_default_release_preserves_activation_and_explicit_disable_works(self):
        for activation, expected in [('preserve', 'true'), ('disabled', 'false')]:
            result = config.resolve('staging', 'femlab-app-staging', self.gcloud, True, activation,
                                    self.root, verify=lambda *args: None)
            self.assertEqual(result['env']['BILLING_ENABLED'], expected)

    def test_missing_legal_or_acceptance_gate_blocks_before_secret_access(self):
        for gate in config.GATES + ('stagingCheckoutVerified', 'webhookVerified'):
            path = self.root / 'live.json'
            catalog = json.loads(path.read_text())
            catalog[gate] = False
            path.write_text(json.dumps(catalog))
            with self.assertRaisesRegex(ValueError, gate):
                config.resolve('production', 'femlab-app', self.gcloud, activation='enabled', root=self.root)
            catalog[gate] = True
            path.write_text(json.dumps(catalog))
        self.assertEqual(self.calls, [])

    def test_enabling_without_runtime_key_fails(self):
        self.missing_key = True
        with self.assertRaisesRegex(ValueError, 'both Stripe'):
            config.resolve('staging', 'femlab-app-staging', self.gcloud, activation='enabled', root=self.root)

    def test_cross_environment_and_wrong_key_mode_fail(self):
        with self.assertRaisesRegex(ValueError, 'project and mode'):
            config.resolve('production', 'femlab-app-staging', self.gcloud, root=self.root)
        with self.assertRaisesRegex(ValueError, 'restricted live'):
            config.resolve('production', 'femlab-app', self.gcloud, root=self.root)

    def test_pending_or_unknown_tax_decision_never_activates_billing(self):
        path = self.root / 'test.json'
        catalog = json.loads(path.read_text())
        for tax_mode in ('pending', 'unknown'):
            catalog['taxMode'] = tax_mode
            path.write_text(json.dumps(catalog))
            with self.assertRaisesRegex(ValueError, 'taxMode|tax mode'):
                config.resolve('staging', 'femlab-app-staging', self.gcloud, activation='enabled', root=self.root)
        catalog.pop('taxMode')
        path.write_text(json.dumps(catalog))
        with self.assertRaisesRegex(ValueError, 'explicit taxMode'):
            config.resolve('staging', 'femlab-app-staging', self.gcloud, activation='enabled', root=self.root)
        self.assertEqual(self.calls, [])

    def test_automatic_tax_requires_verified_registration(self):
        path = self.root / 'test.json'
        catalog = json.loads(path.read_text())
        catalog['taxMode'] = 'automatic'
        catalog['taxClassificationConfirmed'] = True
        path.write_text(json.dumps(catalog))
        with self.assertRaisesRegex(ValueError, 'activeTaxRegistrationVerified'):
            config.resolve('staging', 'femlab-app-staging', self.gcloud, activation='enabled', root=self.root)
        self.assertEqual(self.calls, [])
        catalog['activeTaxRegistrationVerified'] = True
        path.write_text(json.dumps(catalog))
        result = config.resolve('staging', 'femlab-app-staging', self.gcloud, activation='enabled', root=self.root, verify=lambda *args: None)
        self.assertEqual(result['env']['BILLING_TAX_MODE'], 'automatic')
        self.assertEqual(result['env']['BILLING_ENABLED'], 'true')

    def test_classification_is_required_only_when_collecting_automatic_tax(self):
        path = self.root / 'test.json'
        catalog = json.loads(path.read_text())
        catalog['taxClassificationConfirmed'] = False
        catalog['activeTaxRegistrationVerified'] = True
        catalog['taxMode'] = 'not_collecting'
        path.write_text(json.dumps(catalog))
        result = config.resolve('staging', 'femlab-app-staging', self.gcloud, activation='enabled', root=self.root, verify=lambda *args: None)
        self.assertEqual(result['env']['BILLING_TAX_MODE'], 'not_collecting')
        self.assertEqual(result['env']['BILLING_ENABLED'], 'true')
        self.calls.clear()
        catalog['taxMode'] = 'automatic'
        path.write_text(json.dumps(catalog))
        with self.assertRaisesRegex(ValueError, 'taxClassificationConfirmed'):
            config.resolve('staging', 'femlab-app-staging', self.gcloud, activation='enabled', root=self.root)
        self.assertEqual(self.calls, [])
        catalog['activeTaxRegistrationVerified'] = False
        catalog['taxMode'] = 'not_collecting'
        path.write_text(json.dumps(catalog))
        result = config.resolve('staging', 'femlab-app-staging', self.gcloud, activation='enabled', root=self.root, verify=lambda *args: None)
        self.assertEqual(result['env']['BILLING_TAX_MODE'], 'not_collecting')
        self.assertEqual(result['env']['BILLING_ENABLED'], 'true')


if __name__ == '__main__':
    unittest.main()
