"""Resolve public billing configuration and pinned Secret Manager references before release."""
import argparse
import importlib.util
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('stripe_key_installer', ROOT / 'install-runtime-key.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
GATES = ('taxCollectionDecisionConfirmed', 'policyUrlsConfirmed')
MANAGED_GATES = ('managedPaymentsAccountEnabled', 'managedPaymentsEligibilityConfirmed')


def resolve(environment, project, run, previous_enabled=False, activation='preserve', root=ROOT, verify=installer.validate_prices):
    if activation not in ('preserve', 'enabled', 'disabled'):
        raise ValueError('Unknown billing activation mode.')
    mode = 'test' if environment == 'staging' else 'live'
    catalog = json.loads((root / (mode + '.json')).read_text())
    if project != installer.PROJECTS[mode] or catalog['project'] != project or catalog['livemode'] != (mode == 'live'):
        raise ValueError('Billing project and mode must match the release environment.')
    if catalog['account'] != 'acct_1UQmBTAAtmJJ65hf':
        raise ValueError('Billing catalog must belong to the selected FEM Lab Stripe account.')
    tax_mode = catalog.get('taxMode', 'pending')
    if tax_mode not in ('pending', 'automatic', 'not_collecting'):
        raise ValueError('Invalid Stripe tax mode.')
    merchant_mode = catalog.get('merchantMode', 'pending')
    if merchant_mode not in ('pending', 'direct', 'managed'):
        raise ValueError('Invalid Stripe merchant mode.')
    enabled = activation == 'enabled' or (activation == 'preserve' and previous_enabled)
    if enabled:
        if merchant_mode == 'pending':
            raise ValueError('Billing activation requires an explicit merchantMode decision: direct or managed.')
        if tax_mode == 'pending':
            raise ValueError('Billing activation requires an explicit taxMode decision: automatic or not_collecting.')
        if merchant_mode == 'managed' and tax_mode != 'automatic':
            raise ValueError('Managed Payments requires taxMode=automatic.')
        gates = GATES + (('taxClassificationConfirmed',) if tax_mode == 'automatic' else ()) + (('stagingCheckoutVerified', 'webhookVerified') if mode == 'live' else ())
        if merchant_mode == 'managed':
            gates += MANAGED_GATES + (('managedPaymentsTermsAccepted', 'managedPaymentsCheckoutVerified') if mode == 'live' else ())
        missing = [gate for gate in gates if catalog.get(gate) is not True]
        if missing:
            raise ValueError('Billing activation requires recorded acceptance: ' + ', '.join(missing))
        if merchant_mode == 'direct' and tax_mode == 'automatic' and catalog.get('activeTaxRegistrationVerified') is not True:
            raise ValueError('Automatic tax activation requires activeTaxRegistrationVerified evidence.')
    versions = {}
    for secret in ('stripe-api-key', 'stripe-webhook-secret'):
        result = run('secrets', 'versions', 'list', secret, '--filter=state:ENABLED', '--sort-by=~createTime', '--limit=1', '--format=value(name)', optional=True)
        if result.returncode:
            continue
        version = result.stdout.strip().split('/')[-1]
        if re.fullmatch(r'[1-9][0-9]*', version):
            versions[secret] = version
    if len(versions) != 2:
        if enabled:
            raise ValueError('Billing activation requires both Stripe runtime and webhook secrets.')
        return {'env': {'BILLING_ENABLED': 'false', 'BILLING_TAX_MODE': tax_mode, 'BILLING_MERCHANT_MODE': merchant_mode}, 'secrets': {}, 'mode': mode}
    # This stdout remains in this process. Never include it in logs or release manifests.
    key = run('secrets', 'versions', 'access', versions['stripe-api-key'], '--secret=stripe-api-key').stdout.strip()
    try:
        installer.validate_key(key, mode)
        verify(key, mode, catalog)
    finally:
        key = ''
    variables = {'BILLING_ENABLED': str(enabled).lower(), 'BILLING_MODE': mode, 'BILLING_TAX_MODE': tax_mode, 'BILLING_MERCHANT_MODE': merchant_mode,
                 'STRIPE_PORTAL_CONFIGURATION': catalog['portalConfiguration']}
    for plan in ('plus', 'pro', 'studio'):
        price = catalog['plans'][plan]['price']
        if not re.fullmatch(r'price_[A-Za-z0-9_]+', price):
            raise ValueError('Invalid Stripe price identifier.')
        variables['STRIPE_PRICE_' + plan.upper()] = price
    return {'env': variables,
            'secrets': {'STRIPE_SECRET_KEY': 'stripe-api-key:' + versions['stripe-api-key'],
                        'STRIPE_WEBHOOK_SECRET': 'stripe-webhook-secret:' + versions['stripe-webhook-secret']},
            'mode': mode}


def main():
    parser = argparse.ArgumentParser(description=__doc__ + ' This command does not mutate Cloud Run.')
    parser.add_argument('--environment', choices=('staging', 'production'), required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--billing', choices=('disabled', 'enabled'), default='disabled')
    args = parser.parse_args()
    if args.account != installer.ACCOUNT:
        parser.error('Use --account=' + installer.ACCOUNT)
    project = installer.PROJECTS['test' if args.environment == 'staging' else 'live']

    def run(*argv, optional=False):
        result = subprocess.run(['gcloud', *argv, '--project=' + project, '--account=' + args.account, '--quiet'], text=True, capture_output=True)
        if result.returncode and not optional:
            raise RuntimeError('Google Cloud billing preflight failed; no secret value was printed.')
        return result
    try:
        print(json.dumps(resolve(args.environment, project, run, activation=args.billing), indent=2))
    except (ValueError, RuntimeError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
