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
        self.key_mode = 'test'
        for mode in ('test', 'live'):
            catalog = json.loads(Path(__file__).with_name(mode + '.json').read_text())
            catalog['taxMode'] = 'not_collecting'
            catalog['merchantMode'] = 'direct'
            for gate in ('taxCollectionDecisionConfirmed', 'policyUrlsConfirmed',
                         'stagingCheckoutVerified', 'webhookVerified'):
                catalog[gate] = True
            (self.root / (mode + '.json')).write_text(json.dumps(catalog))

    def update_catalog(self, mode='test', **changes):
        path = self.root / (mode + '.json')
        catalog = json.loads(path.read_text())
        catalog.update(changes)
        path.write_text(json.dumps(catalog))
        return catalog

    def managed_catalog(self, mode='test'):
        catalog = self.update_catalog(mode, merchantMode='managed', taxMode='automatic',
                                   taxClassificationConfirmed=True, activeTaxRegistrationVerified=False,
                                   taxCollectionDecisionConfirmed=True, policyUrlsConfirmed=True,
                                   stagingCheckoutVerified=True, webhookVerified=True,
                                   managedPaymentsAccountEnabled=True, managedPaymentsTermsAccepted=(mode == 'live'),
                                   managedPaymentsEligibilityConfirmed=True, managedPaymentsCheckoutVerified=(mode == 'live'))
        for name, plan in catalog['plans'].items():
            plan['purchaseUses'] = {use: {'product': 'femlab_' + name + '_' + use,
                                           'price': 'price_' + name + '_' + use,
                                           'taxCode': 'txcd_12345678'}
                                    for use in ('personal', 'business')}
        return self.update_catalog(mode, plans=catalog['plans'])

    def gcloud(self, *args, optional=False):
        self.calls.append(args)
        if args[:3] == ('secrets', 'versions', 'access'):
            return SimpleNamespace(returncode=0, stdout='rk_' + self.key_mode + '_' + 'T' * 32)
        missing = self.missing_key and args[3] == 'stripe-api-key'
        return SimpleNamespace(returncode=1 if missing else 0, stdout='' if missing else '7\n')

    def test_unconfigured_remains_disabled_and_does_not_read_any_key(self):
        self.missing_key = True
        result = config.resolve('staging', 'femlab-app-staging', self.gcloud, root=self.root)
        self.assertEqual(result['env'], {'BILLING_ENABLED': 'false', 'BILLING_TAX_MODE': 'not_collecting',
                                         'BILLING_MERCHANT_MODE': 'direct'})
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
        self.assertEqual(result['env']['BILLING_MERCHANT_MODE'], 'direct')
        self.assertEqual(result['secrets'], {'STRIPE_SECRET_KEY': 'stripe-api-key:7', 'STRIPE_WEBHOOK_SECRET': 'stripe-webhook-secret:7'})
        self.assertNotIn('rk_test_', json.dumps(result))

    def test_default_release_preserves_activation_and_explicit_disable_works(self):
        for activation, expected in [('preserve', 'true'), ('disabled', 'false')]:
            result = config.resolve('staging', 'femlab-app-staging', self.gcloud, True, activation,
                                    self.root, verify=lambda *args: None)
            self.assertEqual(result['env']['BILLING_ENABLED'], expected)

    def test_missing_legal_or_acceptance_gate_blocks_before_secret_access(self):
        for gate in ('taxCollectionDecisionConfirmed', 'policyUrlsConfirmed',
                     'stagingCheckoutVerified', 'webhookVerified'):
            path = self.root / 'live.json'
            catalog = json.loads(path.read_text())
            catalog[gate] = False
            path.write_text(json.dumps(catalog))
            with self.assertRaisesRegex(ValueError, gate):
                config.resolve('production', 'femlab-app', self.gcloud, activation='enabled', root=self.root)
            catalog[gate] = True
            path.write_text(json.dumps(catalog))
        self.assertEqual(self.calls, [])

    def test_pending_merchant_mode_keeps_disabled_webhook_and_recovery_bindings(self):
        for configured in (False, True):
            for merchant_mode in ('pending', None):
                with self.subTest(configured=configured, merchant_mode=merchant_mode):
                    catalog = self.update_catalog(merchantMode='pending', taxMode='pending')
                    if merchant_mode is None:
                        del catalog['merchantMode']
                        (self.root / 'test.json').write_text(json.dumps(catalog))
                    self.missing_key = not configured
                    self.calls.clear()
                    result = config.resolve('staging', 'femlab-app-staging', self.gcloud,
                                            activation='disabled', root=self.root, verify=lambda *args: None)
                    self.assertEqual(result['env']['BILLING_ENABLED'], 'false')
                    self.assertEqual(result['env']['BILLING_MERCHANT_MODE'], 'pending')
                    self.assertEqual(result['env']['BILLING_TAX_MODE'], 'pending')
                    if configured:
                        self.assertEqual(result['secrets'], {'STRIPE_SECRET_KEY': 'stripe-api-key:7',
                                                             'STRIPE_WEBHOOK_SECRET': 'stripe-webhook-secret:7'})
                    else:
                        self.assertEqual(result['secrets'], {})
                        self.assertFalse(any('access' in args for args in self.calls))

    def test_pending_or_absent_merchant_mode_never_activates_billing(self):
        for merchant_mode in ('pending', None):
            for activation in ('enabled', 'preserve'):
                with self.subTest(merchant_mode=merchant_mode, activation=activation):
                    catalog = self.update_catalog(merchantMode='pending')
                    if merchant_mode is None:
                        del catalog['merchantMode']
                        (self.root / 'test.json').write_text(json.dumps(catalog))
                    with self.assertRaisesRegex(ValueError, 'merchantMode|merchant mode'):
                        config.resolve('staging', 'femlab-app-staging', self.gcloud, previous_enabled=True,
                                       activation=activation, root=self.root)
                    self.assertEqual(self.calls, [])

    def test_unknown_merchant_mode_fails_even_while_disabled(self):
        self.update_catalog(merchantMode='unknown')
        for activation in ('enabled', 'disabled', 'preserve'):
            with self.subTest(activation=activation):
                with self.assertRaisesRegex(ValueError, 'merchantMode|merchant mode'):
                    config.resolve('staging', 'femlab-app-staging', self.gcloud,
                                   activation=activation, root=self.root)
                self.assertEqual(self.calls, [])

    def test_managed_payments_requires_automatic_tax_before_secret_access(self):
        self.managed_catalog()
        for tax_mode in ('pending', 'not_collecting'):
            with self.subTest(tax_mode=tax_mode):
                self.update_catalog(taxMode=tax_mode)
                with self.assertRaisesRegex(ValueError, 'taxMode|automatic'):
                    config.resolve('staging', 'femlab-app-staging', self.gcloud,
                                   activation='enabled', root=self.root)
                self.assertEqual(self.calls, [])

    def test_each_managed_gate_blocks_before_secret_access(self):
        gates = ('taxCollectionDecisionConfirmed', 'policyUrlsConfirmed', 'taxClassificationConfirmed',
                 'managedPaymentsAccountEnabled', 'managedPaymentsEligibilityConfirmed')
        for gate in gates:
            for value in (False, None):
                with self.subTest(gate=gate, value=value):
                    catalog = self.managed_catalog()
                    if value is None:
                        catalog.pop(gate)
                    else:
                        catalog[gate] = value
                    (self.root / 'test.json').write_text(json.dumps(catalog))
                    with self.assertRaisesRegex(ValueError, gate):
                        config.resolve('staging', 'femlab-app-staging', self.gcloud,
                                       activation='enabled', root=self.root)
                    self.assertEqual(self.calls, [])

    def test_live_managed_payments_requires_all_checkout_and_webhook_evidence(self):
        for gate in ('managedPaymentsTermsAccepted', 'managedPaymentsCheckoutVerified',
                     'stagingCheckoutVerified', 'webhookVerified'):
            with self.subTest(gate=gate):
                self.managed_catalog('live')
                self.update_catalog('live', **{gate: False})
                with self.assertRaisesRegex(ValueError, gate):
                    config.resolve('production', 'femlab-app', self.gcloud,
                                   activation='enabled', root=self.root)
                self.assertEqual(self.calls, [])

    def test_managed_activation_does_not_require_or_fabricate_owner_registration(self):
        for environment, project, mode in (('staging', 'femlab-app-staging', 'test'),
                                           ('production', 'femlab-app', 'live')):
            with self.subTest(environment=environment):
                catalog = self.managed_catalog(mode)
                self.key_mode = mode
                verified = []
                result = config.resolve(environment, project, self.gcloud, activation='enabled', root=self.root,
                                        verify=lambda key, key_mode, manifest: verified.append((key_mode, manifest.copy())))
                self.assertEqual(result['env']['BILLING_ENABLED'], 'true')
                self.assertEqual(result['env']['BILLING_MERCHANT_MODE'], 'managed')
                self.assertEqual(result['env']['BILLING_TAX_MODE'], 'automatic')
                self.assertEqual(verified, [(mode, catalog)])
                self.assertIs(verified[0][1]['activeTaxRegistrationVerified'], False)
                self.assertIs(verified[0][1]['managedPaymentsTermsAccepted'], mode == 'live')
                self.assertEqual(json.loads((self.root / (mode + '.json')).read_text()), catalog)

    def test_each_managed_purchase_use_is_required_before_secret_access(self):
        for tier in ('plus', 'pro', 'studio'):
            for use in ('personal', 'business'):
                with self.subTest(tier=tier, use=use):
                    catalog = self.managed_catalog()
                    del catalog['plans'][tier]['purchaseUses'][use]
                    self.update_catalog(plans=catalog['plans'])
                    with self.assertRaisesRegex(ValueError, 'purchaseUses.*' + tier.upper() + '_' + use.upper()):
                        config.resolve('staging', 'femlab-app-staging', self.gcloud,
                                       activation='enabled', root=self.root)
                    self.assertEqual(self.calls, [])

    def test_disabled_preparation_retains_partial_aliases_and_legacy_recovery_prices(self):
        catalog = self.managed_catalog()
        del catalog['plans']['pro']['purchaseUses']
        del catalog['plans']['studio']['purchaseUses']['business']
        self.update_catalog(plans=catalog['plans'])
        result = config.resolve('staging', 'femlab-app-staging', self.gcloud,
                                activation='disabled', root=self.root, verify=lambda *args: None)
        self.assertEqual(result['env']['BILLING_ENABLED'], 'false')
        for tier in ('plus', 'pro', 'studio'):
            self.assertEqual(result['env']['STRIPE_PRICE_' + tier.upper()], catalog['plans'][tier]['price'])
        self.assertEqual(result['env']['STRIPE_PRICE_PLUS_PERSONAL'], 'price_plus_personal')
        self.assertEqual(result['env']['STRIPE_PRICE_PLUS_BUSINESS'], 'price_plus_business')
        self.assertEqual(result['env']['STRIPE_PRICE_STUDIO_PERSONAL'], 'price_studio_personal')
        for role in ('PRO_PERSONAL', 'PRO_BUSINESS', 'STUDIO_BUSINESS'):
            self.assertNotIn('STRIPE_PRICE_' + role, result['env'])
        self.assertEqual(set(result['secrets']), {'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'})

    def test_invalid_or_ambiguous_purchase_use_never_accesses_secrets_even_when_disabled(self):
        mutations = [lambda plans: plans['plus']['purchaseUses'].update({'commercial': plans['plus']['purchaseUses']['personal']}),
                     lambda plans: plans['plus'].update(purchaseUses=None),
                     lambda plans: plans['plus']['purchaseUses']['personal'].update(product='../other'),
                     lambda plans: plans['plus']['purchaseUses']['personal'].update(taxCode='txcd_invalid'),
                     lambda plans: plans['plus']['purchaseUses']['personal'].update(price=plans['plus']['price']),
                     lambda plans: plans['studio']['purchaseUses']['business'].update(price=plans['pro']['purchaseUses']['personal']['price'])]
        for mutate in mutations:
            with self.subTest(mutation=mutations.index(mutate)):
                catalog = self.managed_catalog()
                mutate(catalog['plans'])
                self.update_catalog(plans=catalog['plans'])
                with self.assertRaisesRegex(ValueError, 'Invalid Stripe|Duplicate Stripe'):
                    config.resolve('staging', 'femlab-app-staging', self.gcloud,
                                   activation='disabled', root=self.root)
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
