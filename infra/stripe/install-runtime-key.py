#!/usr/bin/env python3
"""Prompt locally for a restricted Stripe key and send it directly to Secret Manager."""
import argparse
import getpass
import json
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

ACCOUNT = 'andershaf@gmail.com'
PROJECTS = {'test': 'femlab-app-staging', 'live': 'femlab-app'}
SECRET = 'stripe-api-key'
PLANS = ('plus', 'pro', 'studio')
PURCHASE_USES = ('personal', 'business')


def validate_key(key, mode):
    if not re.fullmatch(r'rk_' + mode + r'_[A-Za-z0-9]{16,}', key):
        raise ValueError('Expected a restricted ' + mode + ' key (rk_' + mode + '_…). Nothing was stored.')


def catalog_prices(catalog):
    """Validate public price roles without credentials and return their inherited prices."""
    plans = catalog.get('plans')
    if not isinstance(plans, dict) or not plans or set(plans) - set(PLANS):
        raise ValueError('Invalid Stripe catalog plans.')
    prices = {}
    seen = set()
    for name, plan in plans.items():
        if not isinstance(plan, dict) or type(plan.get('amountUsdCents')) is not int or plan['amountUsdCents'] <= 0:
            raise ValueError('Invalid Stripe tier amount.')
        uses = plan.get('purchaseUses', {})
        if not isinstance(uses, dict) or set(uses) - set(PURCHASE_USES):
            raise ValueError('Invalid Stripe purchaseUses mapping.')
        roles = [(name.upper(), plan)]
        for use, variant in uses.items():
            if not isinstance(variant, dict) or set(variant) != {'product', 'price', 'taxCode'}:
                raise ValueError('Invalid Stripe purchaseUses entry.')
            if not isinstance(variant['taxCode'], str) or not re.fullmatch(r'txcd_[0-9]{8}', variant['taxCode']):
                raise ValueError('Invalid Stripe purchase-use tax code identifier.')
            roles.append((name.upper() + '_' + use.upper(), variant))
        for role, entry in roles:
            price = entry.get('price')
            product = entry.get('product')
            if not isinstance(price, str) or not re.fullmatch(r'price_[A-Za-z0-9_]+', price):
                raise ValueError('Invalid Stripe price identifier.')
            if not isinstance(product, str) or not re.fullmatch(r'[A-Za-z0-9_]+', product):
                raise ValueError('Invalid Stripe product identifier.')
            if price in seen:
                raise ValueError('Duplicate Stripe price identifier across catalog roles.')
            seen.add(price)
            prices[role] = {'price': price, 'product': product, 'amountUsdCents': plan['amountUsdCents']}
    return prices


def validate_prices(key, mode, catalog, fetch=urllib.request.urlopen):
    if catalog['livemode'] != (mode == 'live'):
        raise ValueError('Catalog mode mismatch. Nothing was stored.')
    for plan in catalog_prices(catalog).values():
        request = urllib.request.Request('https://api.stripe.com/v1/prices/' + plan['price'],
                                        headers={'Authorization': 'Bearer ' + key, 'Stripe-Version': catalog['apiVersion']})
        try:
            with fetch(request, timeout=20) as response:
                price = json.load(response)
        except (urllib.error.URLError, ValueError):
            raise ValueError('Stripe price verification failed. Check the key account, mode and Prices read permission. Nothing was stored.') from None
        recurring = price.get('recurring') or {}
        if (price.get('id') != plan['price'] or price.get('livemode') != (mode == 'live') or
                price.get('product') != plan['product'] or not price.get('active') or
                price.get('currency') != 'usd' or price.get('unit_amount') != plan['amountUsdCents'] or
                recurring.get('interval') != 'month' or recurring.get('interval_count') != 1):
            raise ValueError('Stripe catalog verification failed. Nothing was stored.')


def install(key, mode, account, run=subprocess.run):
    if account != ACCOUNT:
        raise ValueError('Use the FEM Lab project owner account: ' + ACCOUNT)
    validate_key(key, mode)
    project = PROJECTS[mode]

    def gcloud(*args, secret_input=None, optional=False):
        result = run(['gcloud', *args, '--project=' + project, '--account=' + account, '--quiet'],
                     input=secret_input, capture_output=True)
        if result.returncode and not optional:
            # CLI diagnostics can include request material; never echo them for a secret operation.
            raise RuntimeError('Google Cloud operation failed (' + ' '.join(args[:3]) + '). No secret value was printed.')
        return result

    if gcloud('secrets', 'describe', SECRET, optional=True).returncode:
        gcloud('secrets', 'create', SECRET, '--replication-policy=user-managed', '--locations=europe-west3')
    gcloud('secrets', 'versions', 'add', SECRET, '--data-file=-', secret_input=key.encode())
    for role in ('api', 'jobs'):
        gcloud('secrets', 'add-iam-policy-binding', SECRET,
               '--member=serviceAccount:femlab-' + role + '@' + project + '.iam.gserviceaccount.com',
               '--role=roles/secretmanager.secretAccessor')
    return project


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=PROJECTS, required=True)
    parser.add_argument('--account', required=True)
    args = parser.parse_args()
    if args.account != ACCOUNT:
        parser.error('Use --account=' + ACCOUNT)
    catalog = json.loads(Path(__file__).with_name(args.mode + '.json').read_text())
    key = getpass.getpass('Paste the Stripe restricted ' + args.mode + ' key (hidden): ').strip()
    try:
        validate_key(key, args.mode)
        validate_prices(key, args.mode, catalog)
        project = install(key, args.mode, args.account)
    except (ValueError, RuntimeError) as error:
        parser.exit(1, str(error) + '\n')
    finally:
        key = ''
    print('Stored ' + SECRET + ' in ' + project + '; access is scoped to the API and recovery job. Checkout was not enabled.')


if __name__ == '__main__':
    main()
