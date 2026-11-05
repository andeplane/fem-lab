import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('manage_operator',Path(__file__).with_name('manage-operator.py'))
operator=importlib.util.module_from_spec(spec);spec.loader.exec_module(operator)

class AuthenticatedOperatorLauncher(unittest.TestCase):
    def invoke(self,action='debit',execution=None,email='operator@example.invalid',gcloud_fail=False):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);script=root/'packages/service/tools/manage-operator.ts';script.parent.mkdir(parents=True);script.write_text('// reviewed fixture')
            receipt=root/'receipt.json';operation='9E67B011-E843-4518-BCD4-6D61CF6AE380';calls=[]
            argv=['manage-operator.py','--environment','staging','--account','operator@example.invalid','--source',str(root),'--action',action,'--operation-id',operation,'--reason-ref','case-556','--receipt',str(receipt)]
            if action!='recover':argv += ['--port','55887','--account-id','00000000-0000-0000-0000-000000000001']
            if action=='debit':argv += ['--grant-id','00000000-0000-0000-0000-000000000002','--subcredits','100']
            def run(args,**kwargs):
                calls.append((args,kwargs))
                if args[0]=='gcloud':
                    if gcloud_fail:return SimpleNamespace(returncode=1,stdout='',stderr='private-token')
                    if args[1:3]==['config','get-value']:value='(unset)'
                    elif args[1:3]==['auth','print-access-token']:value='private-token'
                    elif args[1:4]==['secrets','versions','access']:value='private-password'
                    elif args[1:4]==['run','jobs','execute']:value=json.dumps(execution)
                    else:raise AssertionError('Unexpected gcloud operation')
                    return SimpleNamespace(returncode=0,stdout=value,stderr='')
                self.assertEqual(args[0:3],['node','--import','tsx'])
                actor=hashlib.sha256(email.encode()).hexdigest();self.assertEqual(kwargs['env']['FEMLAB_OPERATOR_ACTOR_REF'],actor)
                return SimpleNamespace(returncode=0,stdout=json.dumps({'event':'operator-action','action':action,'actorRef':actor,'operationId':operation.lower(),'result':{'id':operation.lower(),'replay':False},'unexpectedPrivateField':'private-password'}),stderr='')
            def urlopen(request,**kwargs):
                self.assertNotIn('private-token',request.full_url)
                self.assertEqual(request.get_header('Authorization'),'Bearer private-token')
                if request.full_url.endswith('/userinfo'):value={'email':email}
                else:value={'permissions':json.loads(request.data)['permissions']}
                return io.BytesIO(json.dumps(value).encode())
            with patch.object(operator.sys,'argv',argv),patch.object(operator.subprocess,'run',side_effect=run),patch.object(operator.urllib.request,'urlopen',side_effect=urlopen),contextlib.redirect_stdout(io.StringIO()) as stdout:
                status=operator.main()
            result=json.loads(receipt.read_text());self.assertNotIn('private-token',stdout.getvalue());self.assertNotIn('private-password',stdout.getvalue())
            self.assertEqual(receipt.stat().st_mode&0o777,0o600)
            return status,result,calls
    def test_uppercase_operation_receipt_is_canonical_and_secret_diagnostics_are_filtered(self):
        status,result,_=self.invoke();self.assertEqual(status,0);self.assertEqual(result['operationId'],'9e67b011-e843-4518-bcd4-6d61cf6ae380');self.assertEqual(result['result']['id'],result['operationId'])
    def test_wrong_authenticated_principal_cannot_reach_database_or_node(self):
        status,result,calls=self.invoke(email='different@example.invalid');self.assertEqual(status,1);self.assertEqual(result['code'],'operator-action-unavailable');self.assertFalse(any(x[0][0]=='node' for x in calls));self.assertFalse(any(x[0][1:4]==['secrets','versions','access'] for x in calls))
    def test_cloud_failure_diagnostics_cannot_expose_tokens(self):
        status,result,_=self.invoke(gcloud_fail=True);self.assertEqual(status,1);self.assertEqual(result['code'],'operator-action-unavailable')
    def test_recovery_requires_completed_success_not_only_cli_zero_exit(self):
        for execution in [{'metadata':{'name':'owned'},'status':{}},{'metadata':{'name':'owned'},'status':{'succeededCount':1,'failedCount':1}},{'status':{'succeededCount':1}}]:
            with self.subTest(execution=execution):
                status,result,_=self.invoke(action='recover',execution=execution);self.assertEqual(status,1);self.assertEqual(result['code'],'operator-action-unavailable')
    def test_recovery_saves_actual_named_successful_execution(self):
        status,result,_=self.invoke(action='recover',execution={'metadata':{'name':'owned-execution'},'status':{'succeededCount':1}});self.assertEqual(status,0);self.assertEqual(result['execution'],'owned-execution');self.assertEqual(result['succeeded'],1);self.assertEqual(result['failed'],0)

if __name__=='__main__':unittest.main()
