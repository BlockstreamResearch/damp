import manifest from "../../../../registry/fixtures/deployment.valid.json";
import policy from "../../../../registry/fixtures/policy.valid.json";
import {
  protocolId, registrySchema,
  type Deployment, type DeploymentManifest,
} from "../lib/domain";

// Shared synthetic inputs for Rust, registry-schema and web tests.
export function manifestFixture(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    ...manifest,
    schema: registrySchema,
    protocol: protocolId,
    verifierAssetAmount: 1,
    network: "elements-regtest",
    supplyMode: "fixed",
    ...overrides,
  };
}

export function deploymentFixture(overrides: Partial<Deployment> = {}): Deployment {
  return {
    ...manifestFixture(),
    deploymentId: policy.deploymentId,
    confirmations: 2,
    publication: "published",
    ...overrides,
  };
}
