import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('operations',Path(__file__).with_name('operations.py'))
operations=importlib.util.module_from_spec(spec)
spec.loader.exec_module(operations)

class OperationalDeployment(unittest.TestCase):
    def test_same_project_digest_and_numbered_secret_are_mandatory(self):
        image='europe-west3-docker.pkg.dev/femlab-app/femlab/service@sha256:'+'a'*64
        for project,bad_image,version in [('unrelated',image,'1'),('femlab-app-staging',image,'1'),('femlab-app',image.replace('@sha256:',':'),'1'),('femlab-app',image,'latest'),('femlab-app',image,'0')]:
            with self.subTest(project=project,image=bad_image,version=version),self.assertRaises(ValueError):
                operations.configuration(project,bad_image,version)
    def test_both_environments_have_readonly_database_and_no_provider_or_billing_secrets(self):
        for project,instance in [('femlab-app','femlab-production'),('femlab-app-staging','femlab-staging')]:
            image=f'europe-west3-docker.pkg.dev/{project}/femlab/service@sha256:'+('a'*64)
            config=operations.configuration(project,image,'7')
            job=config['job']
            self.assertIn('--args=service/main.mjs,--operations',job)
            self.assertIn(f'--set-cloudsql-instances={project}:europe-west3:{instance}',job)
            self.assertTrue(any('PGOPTIONS=-c default_transaction_read_only=on' in argument for argument in job))
            self.assertIn('--set-secrets=PGPASSWORD=database-jobs-password:7',job)
            self.assertEqual(sum(arg.startswith('--set-secrets=') for arg in job),1)
            self.assertNotIn('OPENAI',str(job));self.assertNotIn('STRIPE',str(job));self.assertNotIn('FIREBASE',str(job))
            self.assertIn('--max-retries=0',job);self.assertIn('--task-timeout=30s',job)
            self.assertEqual(config['scheduler_uri'],f'https://run.googleapis.com/v2/projects/{project}/locations/europe-west3/jobs/femlab-operations:run')
    def test_failures_and_alarms_use_same_durable_machine_channel(self):
        config=operations.configuration('femlab-app','europe-west3-docker.pkg.dev/femlab-app/femlab/service@sha256:'+'a'*64,'1')
        policy=operations.policy('femlab-app','projects/femlab-app/notificationChannels/1',config['filter'])
        self.assertEqual(policy['notificationChannels'],['projects/femlab-app/notificationChannels/1'])
        self.assertEqual(policy['conditions'][0]['conditionMatchedLog']['filter'],'resource.type="cloud_run_job" AND resource.labels.job_name="femlab-operations" AND severity>=ERROR')
        self.assertEqual(policy['alertStrategy']['notificationRateLimit']['period'],'900s')
        self.assertTrue(policy['enabled'])
    def test_signup_policy_is_positive_bounded_and_passed_only_to_operator_job(self):
        image='europe-west3-docker.pkg.dev/femlab-app/femlab/service@sha256:'+'a'*64
        for invalid in ['0','-1','1.5','','20private','1000001']:
            with self.subTest(limit=invalid),self.assertRaises(ValueError):operations.configuration('femlab-app',image,'1',invalid)
        config=operations.configuration('femlab-app',image,'1','25')
        self.assertTrue(any('OPERATIONS_SIGNUP_LIMIT=25' in value for value in config['job']))
    def test_provider_and_signup_have_distinct_machine_policies_and_fixed_source_filters(self):
        policies=operations.category_policies('femlab-app','projects/femlab-app/notificationChannels/1')
        self.assertEqual(set(policies),{'provider','signup'})
        self.assertNotEqual(policies['provider']['displayName'],policies['signup']['displayName'])
        provider=policies['provider']['conditions'][0]['conditionMatchedLog']['filter']
        self.assertIn('jsonPayload.event="service-provider-error"',provider)
        self.assertIn('resource.labels.service_name="femlab-api"',provider)
        self.assertNotIn('httpRequest.status',provider)
        signup=policies['signup']['conditions'][0]['conditionMatchedLog']['filter']
        self.assertIn('jsonPayload.alarms.code="signup-surge"',signup)
        for desired in policies.values():
            self.assertEqual(desired['notificationChannels'],['projects/femlab-app/notificationChannels/1'])
            self.assertEqual(desired['alertStrategy']['notificationRateLimit']['period'],'900s')
    def test_synthetic_drill_writes_logging_and_never_publishes_directly(self):
        class Fake:
            project='femlab-app-staging'
            calls=[]
            def api(self,*args):self.calls.append(args)
        cloud=Fake();receipt=operations.notification_drill(cloud,{'policy':'projects/femlab-app-staging/alertPolicies/1'})
        self.assertEqual(len(cloud.calls),1)
        service,path,payload,method=cloud.calls[0]
        self.assertEqual(method,'POST')
        self.assertEqual((service,path),('logging','v2/entries:write'))
        self.assertEqual(payload['entries'][0]['jsonPayload']['drillRun'],receipt['run'])
        self.assertTrue(payload['entries'][0]['jsonPayload']['synthetic'])
        self.assertEqual(payload['resource']['labels']['job_name'],'femlab-operations')

if __name__=='__main__':unittest.main()
