# Independent Python receipt delta review — 2026-09-13

Scope: current triage reconciliation against HEAD d47ee41 and pre-fixer d72cf40. No source, manifest, policy pin, or receipt edited. Both complete changed Python files, the complete candidate review policy, Group C assessment entries, and complete plans/009-CANDIDATE-GROUP-C.md were read. All 21 unique evidence-reference file hashes across 103 assessments were checked, but unchanged references were not independently rereviewed line by line in this bounded task.

## Exact reviewed bytes

- exchange_executor/tools/audit_derivatives_candidates.py SHA256 d83994aada8a56f82abda04d0a8a3016f297e186e5d62b8dbc2f01ed0ad6b56b; 24024 bytes. Existing inventory binds 34ee65bf13f4820d831e16f815c97151bec2e8f1b4af0e0f838075322d4e03a1.
- exchange_executor/tests/test_candidate_group_c_boundaries.py SHA256 904f3dfa25712f7bab71902b5f5a0d86492e44ee3d7debcf34ba93ef2f6a65bd. Existing five references bind 8b8fc20f58054e2c72aee39eae062c59e3db956adc4b72432d4bb2b8359ba3d3.
- plans/009-CANDIDATE-GROUP-C.md SHA256 4022873c666dd0fc5272c4f787b1d3b92f4effc570973c4b24b4b705640337fe, matching all five references.

## Semantic conclusions

The audit tool diff versus both references is solely except (ValueError, RecursionError) to except (RecursionError, ValueError). Both exception classes are still caught by the identical InventoryError wrapper; strict UTF8 decoding, duplicate-key rejection, nonfinite rejection, depth-error containment and bounded 8MiB input are unchanged. Constructor/source-only offline guard, source indexing, canonical serialization, Python3.12 and CCXT4.5.75 pins, full ID coverage and completion capability rules remain intact. No semantic regression found in this delta.

Group C test diff versus d72cf40 is solely @staticmethod plus removing unused self from test_weex_current_orders_are_split_between_normal_and_algo_endpoints. The coroutine remains asynchronous and unittest discovery invokes it without a receiver; no assertions, mocks, awaited calls, finally close, SDK source pins, fixture data or transport barriers changed. All ten tests passed using the exact locked Python3.12.14 runtime. The modified WEEX test was explicitly listed as executed. Its normal endpoint call and subsequent trigger/algo call still establish the endpoint-domain distinction. No semantic regression found.

The five affected complete assessments (modetrade, weex, woo, woofipro, xt) retain decision not_easy and both implementationVerified/providerAcceptanceVerified false. Group C source assertions continue supporting these unchanged reasons: WOO drops IOC and normalizes child-first identity/funding USD; Orderly variants lose IOC, reject stop batches and lack required mode/funding identity; WEEX attached SL lacks child identity and normal/algo reads remain separate; XT replaces entry and loses identity with inverted first tier interval. The original plan is a dated local scope/exclusion decision, not current provider acceptance. This review did not query provider endpoints or refresh its September4 web documentation claims.

## Fresh reconstruction and drift audit

build_inventory completed under its offline guard with the locked runtime. Canonically serialized exchange declarations are identical to the checked-in inventory (raw Python equality initially differed only because rebuilt tuples and parsed JSON lists differ). Source index differs only for the audit tool above; resulting sourceHash and inventoryHash must consequently change. No installed SDK-source drift observed.

Old inventoryHash: 5a76c0381e97811ce155f2eaa523570cabdd0bc0d8e81b72c8950f0d8f0dd69f.
Rebuilt inventoryHash for the exact reviewed bytes: 467ba4b7f8a9d72adc57d1aed80a1dee27af5087cbc9f37db016a8a82620a3c4.
All 103 assessments contain 21 unique evidence paths. Only Group C test file has byte drift; its five referring IDs are exactly the above five. Existing APPROVED_ASSESSMENTS_HASH is 251bf1783593245fe1f0eb3ca2b58ed4158e66e79ad8f33177691fff10f59395. Updating five reviewed evidence hashes will require a newly computed assessment digest; none was applied here.

## Renewal obligations

These deltas support incremental renewal of the offline inventory and the five unchanged Group C exclusions for the exact reviewed bytes. Regenerate the entire inventory through build_inventory; preserve reviewed assessment decisions/reasons/false flags, update only the five reviewed evidence references, and independently verify that no further changes appeared before committing fixed review commitments.

ccxt_candidate_reviews.py explicitly requires the complete assessment and every referenced repository file to have been reviewed before changing commitments. The current task supplies semantic delta review for the two changed files and unchanged-byte verification for the other20 unique evidence references; it is not a fresh line-by-line review of those20 references. Root must retain prior valid review provenance or complete the remaining review before claiming complete review renewal.

This does NOT renew existing profile implementation certification receipts. Those separately bind production source and require genuine implementation review; changing the inventory/assessment constants cannot make certification_result valid. Neither fixture mocks returning CertificationResult(True,None) nor a green policy format test prove those production receipts or provider acceptance.

Validation completed here: Group C10/10; strict inventory CLI test1/1 (rejects incomplete/public-markets, duplicate keys, nonfinite input, oversized input); offline reconstruction;21 reference hash checks. After legitimate renewal run full inventory verification, candidate review policy tests including tamper rejection, and complete Python suite. Full --verify-complete may still correctly reject independently stale existing-profile receipts.

## Integration follow-up

After this review, the root restored the original exception tuple order in audit_derivatives_candidates.py. That file now exactly matches integration HEAD d47ee41; the proposed rebuilt inventory hash above is historical and must not be applied. The Group C test change remains. Its five evidence references and assessment digest still require the reviewed renewal workflow. No existing-profile certification is renewed by this follow-up.
