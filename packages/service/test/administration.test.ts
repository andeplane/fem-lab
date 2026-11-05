import {expect,it} from 'vitest';
import type {Sql} from '../src/accounts';
import {suspendAccount,type SuspensionIdentity} from '../src/administration';
import {ServiceFailure} from '../src/errors';

it('reports acknowledgement rather than guessing remote identity state after a lost disable response',async()=>{
  const sql:Sql={async query(){return {rows:[{firebase_uid:'qa-response-loss'}],rowCount:1};}};
  let remoteDisabled=false,revocations=0,loseResponse=true;
  const identity:SuspensionIdentity={
    async updateUser(){remoteDisabled=true;if(loseResponse)throw new Error('private response lost after remote commit');},
    async revokeRefreshTokens(){revocations++;},
  };
  let failure:unknown;
  try{await suspendAccount(sql,identity,'00000000-0000-4000-8000-000000000556');}catch(error){failure=error;}
  expect(remoteDisabled).toBe(true);expect(revocations).toBe(0);
  expect(failure).toBeInstanceOf(ServiceFailure);
  expect((failure as ServiceFailure).details).toEqual({disableConfirmed:false});
  loseResponse=false;
  expect(await suspendAccount(sql,identity,'00000000-0000-4000-8000-000000000556')).toMatchObject({disabled:true,sessionsRevoked:true});
  expect(revocations).toBe(1);
});
