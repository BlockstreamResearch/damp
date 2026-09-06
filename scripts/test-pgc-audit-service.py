#!/usr/bin/env python3
"""Focused fail-closed tests for the task-local DAMP audit service."""
import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT=pathlib.Path(__file__).resolve().parent.parent
SPEC=importlib.util.spec_from_file_location('pgc_audit_service',ROOT/'scripts/pgc-audit-service.py')
SERVICE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(SERVICE)
ASSET='11'*32
OWN='0014'+'22'*20
SCRIPT='5120'+'33'*32
PARENT_SCRIPT_HASH=__import__('hashlib').sha256(bytes.fromhex(SCRIPT)).hexdigest()
POLICY={'policyRoot':'44'*32,'sequence':0,'verifierScriptPubkey':SCRIPT}
SUCCESSOR={'parentPolicyRoot':POLICY['policyRoot'],'parentVerifierScriptHash':PARENT_SCRIPT_HASH,'sequence':1}

def tx(outputs=None,issuance=None):
    return {'outputs':outputs or [],'inputs':[{'issuance':issuance}]}

class GovernanceClassification(unittest.TestCase):
    def classify(self,transaction,successor=None,consumed=None):
        return SERVICE.classify_governance(transaction,POLICY,successor,OWN,consumed or [],ASSET)

    def test_expected_policy_update(self):
        self.assertEqual(self.classify(tx(),SUCCESSOR),'issuer-policy-update')

    def test_expected_reissuance_to_issuer(self):
        issuance={'asset':ASSET,'reissuance':True}
        self.assertEqual(self.classify(tx([{'asset':ASSET,'scriptPubkey':OWN}],issuance),POLICY),'issuer-reissuance')

    def test_wrong_recipient_or_regulated_input_is_unexpected(self):
        issuance={'asset':ASSET,'reissuance':True}
        wrong=tx([{'asset':ASSET,'scriptPubkey':'0014'+'55'*20}],issuance)
        self.assertEqual(self.classify(wrong,POLICY),'unexpected-governance')
        valid=tx([{'asset':ASSET,'scriptPubkey':OWN}],issuance)
        self.assertEqual(self.classify(valid,POLICY,[{'asset':ASSET}]),'unexpected-governance')

    def test_malformed_policy_successor_is_unexpected(self):
        wrong={**SUCCESSOR,'parentVerifierScriptHash':'66'*32}
        self.assertEqual(self.classify(tx(),wrong),'unexpected-governance')

class CredentialBoundary(unittest.TestCase):
    def test_service_rejects_mnemonic_and_open_permissions(self):
        class Chain:pass
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'credential'
            path.write_text('abandon '*11+'about')
            path.chmod(0o600)
            with self.assertRaisesRegex(ValueError,'restricted audit credentials'):
                SERVICE.Auditor(path,Chain())
            path.write_text(json.dumps({'schema':'damp-audit-credentials/v1'}))
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError,'owner-only'):
                SERVICE.Auditor(path,Chain())

class CacheBounds(unittest.TestCase):
    def test_transaction_cache_evicts_by_count_and_bytes(self):
        chain=object.__new__(SERVICE.Chain)
        chain.cache=__import__('collections').OrderedDict((str(i),'x') for i in range(1024))
        chain.cache_bytes=1024;chain.is_rpc=False
        chain.get=lambda path,json_value=False:'abcd'
        self.assertEqual(chain.raw('new'),'abcd')
        self.assertLessEqual(len(chain.cache),1024)
        self.assertEqual(chain.cache_bytes,sum(len(value) for value in chain.cache.values()))

    def test_rpc_outspend_check_does_not_mix_tip_with_older_snapshot(self):
        chain=object.__new__(SERVICE.Chain);chain.is_rpc=True
        chain.rpc=lambda method,params: (_ for _ in ()).throw(AssertionError('tip query must be skipped'))
        self.assertIsNone(chain.crosscheck_unspent('11'*32+':0',100,101))
        chain.rpc=lambda method,params: {'unspent':True}
        self.assertTrue(chain.crosscheck_unspent('11'*32+':0',101,101))

if __name__=='__main__':unittest.main()
