"""Secret handling and environment checks for the local owner handoff."""
import importlib.util
import io
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-runtime-key.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
KEY = 'rk_test_' + 'T' * 32


class InstallRuntimeKeyTests(unittest.TestCase):
    def catalog(self):
        return {'livemode': False, 'apiVersion': '2026-09-30.endive', 'plans': {
            tier: {'product': 'femlab_' + tier, 'price': 'price_' + tier, 'amountUsdCents': amount,
                   'purchaseUses': {use: {'product': 'femlab_' + tier + '_' + use,
                                         'price': 'price_' + tier + '_' + use, 'taxCode': 'txcd_12345678'}
                                    for use in ('personal', 'business')}}
            for tier, amount in (('plus', 4900), ('pro', 14900), ('studio', 49900))}}

    def price_responses(self):
        return {'price_' + tier + suffix: {'id': 'price_' + tier + suffix, 'product': 'femlab_' + tier + suffix,
                                           'livemode': False, 'active': True, 'unit_amount': amount, 'currency': 'usd',
                                           'recurring': {'interval': 'month', 'interval_count': 1}}
                for tier, amount in (('plus', 4900), ('pro', 14900), ('studio', 49900))
                for suffix in ('', '_personal', '_business')}

    def test_secret_uses_stdin_and_scoped_identities(self):
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return SimpleNamespace(returncode=1 if argv[1:3] == ['secrets', 'describe'] else 0)
        self.assertEqual(installer.install(KEY, 'test', installer.ACCOUNT, run), 'femlab-app-staging')
        self.assertEqual(len(calls), 5)
        secret_call = next(item for item in calls if item[0][1:4] == ['secrets', 'versions', 'add'])
        self.assertEqual(secret_call[1]['input'], KEY.encode())
        for argv, _ in calls:
            self.assertNotIn(KEY, ' '.join(argv))
            self.assertIn('--account=' + installer.ACCOUNT, argv)
            self.assertIn('--project=femlab-app-staging', argv)
        bindings = [argv for argv, _ in calls if 'add-iam-policy-binding' in argv]
        self.assertIn('--member=serviceAccount:femlab-api@femlab-app-staging.iam.gserviceaccount.com', bindings[0])
        self.assertIn('--member=serviceAccount:femlab-jobs@femlab-app-staging.iam.gserviceaccount.com', bindings[1])

    def test_wrong_mode_or_owner_never_calls_google(self):
        def never(*args, **kwargs):
            self.fail('A rejected key or owner reached Google Cloud')
        for key, mode, account in [(KEY, 'live', installer.ACCOUNT), ('sk_test_' + 'T' * 32, 'test', installer.ACCOUNT), (KEY, 'test', 'someone@example.com')]:
            with self.assertRaises(ValueError):
                installer.install(key, mode, account, never)

    def test_cli_error_does_not_disclose_key(self):
        def fail(argv, **kwargs):
            return SimpleNamespace(returncode=1, stderr=KEY.encode())
        with self.assertRaises(RuntimeError) as error:
            installer.install(KEY, 'test', installer.ACCOUNT, fail)
        self.assertNotIn(KEY, str(error.exception))

    def test_price_preflight_refuses_other_catalog_or_mode(self):
        catalog = {'livemode': False, 'apiVersion': '2026-09-30.endive', 'plans': {'plus': {'price': 'price_test', 'product': 'femlab_plus', 'amountUsdCents': 4900}}}
        price = {'id': 'price_test', 'product': 'femlab_plus', 'livemode': False, 'active': True, 'unit_amount': 4900, 'currency': 'usd', 'recurring': {'interval': 'month', 'interval_count': 1}}
        def fetch(request, timeout):
            self.assertEqual(request.get_header('Authorization'), 'Bearer ' + KEY)
            return io.StringIO(json.dumps(price))
        installer.validate_prices(KEY, 'test', catalog, fetch)
        for field, value in [('product', 'another_product'), ('livemode', True), ('unit_amount', 1), ('active', False)]:
            changed = dict(price)
            changed[field] = value
            with self.assertRaises(ValueError):
                installer.validate_prices(KEY, 'test', catalog, lambda *args, **kwargs: io.StringIO(json.dumps(changed)))
        with self.assertRaises(ValueError):
            installer.validate_prices(KEY, 'live', catalog, fetch)

    def test_preflight_checks_all_legacy_and_purchase_use_prices_using_only_prices_read(self):
        requests = []
        prices = self.price_responses()

        def fetch(request, timeout):
            requests.append(request.full_url)
            self.assertEqual(request.get_header('Authorization'), 'Bearer ' + KEY)
            self.assertEqual(request.get_header('Stripe-version'), '2026-09-30.endive')
            self.assertEqual(timeout, 20)
            return io.StringIO(json.dumps(prices[request.full_url.rsplit('/', 1)[1]]))

        installer.validate_prices(KEY, 'test', self.catalog(), fetch)
        self.assertCountEqual(requests, ['https://api.stripe.com/v1/prices/' + price for price in prices])
        self.assertEqual(len(requests), 9)

    def test_purchase_use_price_ownership_and_inherited_terms_are_verified(self):
        changes = [('id', 'price_other'), ('product', 'femlab_other'), ('livemode', True), ('active', False),
                   ('currency', 'eur'), ('unit_amount', 1), ('recurring', {'interval': 'year', 'interval_count': 1}),
                   ('recurring', {'interval': 'month', 'interval_count': 2})]
        for use in ('personal', 'business'):
            for field, value in changes:
                with self.subTest(use=use, field=field, value=value):
                    prices = self.price_responses()
                    prices['price_plus_' + use][field] = value

                    def fetch(request, timeout):
                        return io.StringIO(json.dumps(prices[request.full_url.rsplit('/', 1)[1]]))

                    with self.assertRaisesRegex(ValueError, 'catalog verification failed'):
                        installer.validate_prices(KEY, 'test', self.catalog(), fetch)

    def test_invalid_purchase_use_catalog_never_reaches_stripe(self):
        mutations = [('unknown use', lambda plans: plans['plus']['purchaseUses'].update(other={})),
                     ('nonmapping uses', lambda plans: plans['plus'].update(purchaseUses=[])),
                     ('nonmapping entry', lambda plans: plans['plus']['purchaseUses'].update(personal=None)),
                     ('missing field', lambda plans: plans['plus']['purchaseUses']['personal'].pop('taxCode')),
                     ('variant amount override', lambda plans: plans['plus']['purchaseUses']['personal'].update(amountUsdCents=1)),
                     ('invalid price', lambda plans: plans['plus']['purchaseUses']['personal'].update(price='price_a/b')),
                     ('invalid product', lambda plans: plans['plus']['purchaseUses']['personal'].update(product='femlab/other')),
                     ('invalid tax code', lambda plans: plans['plus']['purchaseUses']['personal'].update(taxCode='txcd_1')),
                     ('alias collision', lambda plans: plans['plus']['purchaseUses']['business'].update(price='price_plus_personal')),
                     ('legacy collision', lambda plans: plans['plus']['purchaseUses']['business'].update(price='price_studio'))]
        for name, mutate in mutations:
            with self.subTest(mutation=name):
                catalog = self.catalog()
                mutate(catalog['plans'])

                def never(*args, **kwargs):
                    self.fail('Malformed catalog reached Stripe')

                with self.assertRaisesRegex(ValueError, 'Invalid Stripe|Duplicate Stripe'):
                    installer.validate_prices(KEY, 'test', catalog, never)


if __name__ == '__main__':
    unittest.main()
