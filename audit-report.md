# 📋 Docs Audit Report

Generated: 2026-07-02T10:44 UTC

Found **54** item(s) to review:

## API Reference (openapi.json)

- [ ] Endpoint `POST /v1/predictions/`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/property/`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/utility/get-home-images`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/utility/deduplicate-images`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/rma/{param}/rush`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/rma/{param}/rush/approve`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/rma/{param}/rush/decline`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/rma/{param}/rush/remove`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `GET /v1/opportunities/{param}`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/rma/`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/weekly-updates/ai-generate`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/weekly-updates/ai-conversations`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `GET /v1/weekly-updates/ai-conversations`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `GET /v1/weekly-updates/ai-conversations/{param}`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/weekly-updates/ai-conversations/{param}/messages`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/weekly-updates/ai-conversations/{param}/apply`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `GET /v1/webhooks/hubspot/get-broken-phone-numbers`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/webhooks/hubspot/fix-broken-phone-numbers`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `GET /v1/meetings/available-calendars`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/brokerages/`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/avm/mortgage`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/avm/`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/property/{param}/generate-readable-features`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/reimagine/create-image`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/property/dashboard`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/property/neighborhood-dashboard`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/utility/check-home-images`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `GET /v1/estimates/{param}/proposal`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.
- [ ] Endpoint `POST /v1/rma/:rmaId/contract`` mentioned in release notes but not found in `openapi.json`. May need to be added to the API reference.

## Guides

- [ ] Release notes link to `/guides/health` ("Third-party status") but that guide doesn't exist.
- [ ] Guide `guides/intake-url-parameters.mdx` may need updating — release mentions "intake" in a new feature context.
- [ ] Guide `guides/ai-weekly-updates.mdx` may need updating — release mentions "weekly update" in a new feature context.

## Third-party integrations

- [ ] Integration doc `third-party-integrations/hubspot.mdx` may need updating — release mentions "HubSpot" in: "Public status page and health API."
- [ ] Integration doc `third-party-integrations/pandadoc.mdx` may need updating — release mentions "PandaDoc" in: "Public status page and health API."
- [ ] Integration doc `third-party-integrations/firebase.mdx` may need updating — release mentions "Firebase" in: "Public status page and health API."
- [ ] Integration doc `third-party-integrations/analytics-and-monitoring.mdx` may need updating — release mentions "Google Tag" in: "GTM tracking on intake sign-up."
- [ ] Integration doc `third-party-integrations/analytics-and-monitoring.mdx` may need updating — release mentions "GTM" in: "GTM tracking on intake sign-up."
- [ ] Integration doc `third-party-integrations/property-data.mdx` may need updating — release mentions "AnyProp" in: "Public status page and health API."
- [ ] Integration doc `third-party-integrations/property-data.mdx` may need updating — release mentions "ATTOM" in: "Public status page and health API."

## Field dictionary

- [ ] Field `operational` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `withMortgageData` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `materials` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `version` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `homeIncrease` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `valueOpportunity` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `agentCommission` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `sell360TransactionSummary.shared` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `firstCheckAmount` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `sell360TransactionSummary` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `slide4` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `slide9` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `caseStudies` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `slide10` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.
- [ ] Field `advisorNextSteps` appears to be new in this release but isn't in the field dictionary. Consider adding it to `guides/field-dictionary.mdx`.

---

**Next steps:** Review each item above. For each:
1. If the feature is genuinely new, update the relevant docs page.
2. If the endpoint is in the OpenAPI spec under a different path, no action needed — just verify.
3. If a guide reference is outdated or a provider has been removed, update or remove the reference.
