// ensureObserver must serialize per profile: its body awaits verifier RPCs and the configuration
// modal (unbounded), and DO input gates don't cover those awaits, so two concurrent opens for one
// profile would otherwise interleave -- most visibly, two concurrent *first* opens would each mint
// their own observerId and register both with the gatekeepers, while the last-written record
// forgets the other id ever existed (leaving it registered but unremovable).
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// git-migration-do.test.ts) so ensureObserver's private state is real; the gatekeeper facet and
// the client's User DO are the only fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  let promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function seedGatekeepers(impl: any): void {
  for (let id of [1, 2]) {
    impl.storage.gatekeepers.put({
      id,
      resourceTitle: `Connection ${id}`,
      class: {} as any,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "testvendor",
        resourceUrl: `https://example.com/${id}`,
        typeUrlPattern: "https://*",
      },
    });
  }
}

// A client User DO that always has the account and always mints a verifier.
const fakeClientUser = {
  getVerifier: async () => ({}),
} as any;

describe("ensureObserver per-profile serialization", () => {
  it("gives two concurrent first opens one shared observerId", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-serialization-first-opens");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);

      let registered: string[] = [];
      impl.getGatekeeperFacet = () => ({
        addObserver: async (observerId: string) => { registered.push(observerId); },
      });

      // Open A parks inside the configuration modal -- the unbounded window the serialization
      // exists for -- while open B arrives with its own (competing) account choices.
      let held = deferred();
      let configureA = {
        configure: async () => {
          await held.promise;
          return [{ gatekeeperId: 1, accountId: 10 }, { gatekeeperId: 2, accountId: 20 }];
        },
      } as any;
      let configureB = {
        configure: async () =>
          [{ gatekeeperId: 1, accountId: 11 }, { gatekeeperId: 2, accountId: 21 }],
      } as any;

      let openA = impl.ensureObserver("alice", fakeClientUser, "build", configureA);
      await tick();
      let openB = impl.ensureObserver("alice", fakeClientUser, "build", configureB);
      await tick();

      // B must not have verified anything while A is still parked in its modal.
      expect(registered).toHaveLength(0);

      held.resolve();
      await Promise.all([openA, openB]);

      // A registered both gatekeepers, then B re-verified both -- all under one id, which is the
      // id the persisted record carries. Without serialization, B minted a second id while A was
      // parked, and whichever record was written last orphaned the other id inside the
      // gatekeepers.
      expect(registered).toHaveLength(4);
      expect(new Set(registered).size).toBe(1);

      let record = impl.storage.observers.get("alice");
      expect(record.observerId).toBe(registered[0]);
      // B found A's committed record and re-verified A's choices rather than asking again.
      expect(record.accountChoices).toEqual({ 1: 10, 2: 20 });
    });
  });

  it("a failed check's coverage scrub survives a concurrent open", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-serialization-scrub");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      // Already-configured coverage for both gatekeepers, as a previous successful open left it.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      // Gatekeeper 1's first re-verification (open A's) parks, then succeeds; its second (open
      // B's) refuses -- the provider revoked access between the two.
      let held = deferred();
      let gk1Calls = 0;
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => {
          if (id === 1 && ++gk1Calls === 2) throw new Error("access revoked upstream");
          if (id === 1) await held.promise;
        },
        removeObserver: async () => {},
      });

      let openA = impl.ensureObserver("alice", fakeClientUser, "build");
      await tick();
      // B's re-prompt offer is declined, as a client with no way to repair would.
      let openB = impl.ensureObserver("alice", fakeClientUser, "build", {
        configure: async () => { throw new Error("cancelled"); },
      } as any);
      await tick();
      held.resolve();

      await expect(openA).resolves.toBeUndefined();
      await expect(openB).rejects.toThrow();

      // B's failure scrubbed gatekeeper 1 from persisted coverage, and A's success -- which ran
      // strictly before B under the per-profile lock -- cannot have resurrected it. Without the
      // lock, A's final put lands after B's scrub and restores coverage the live check just
      // refused, which the coverage guard would then trust.
      let record = impl.storage.observers.get("alice");
      expect(1 in record.accountChoices).toBe(false);
      expect(record.accountChoices[2]).toBe(20);
    });
  });

  it("a getVerifier rejection scrubs that gatekeeper's persisted coverage", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-serialization-getverifier-rejection");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      // Already-configured coverage for both gatekeepers, as a previous successful open left it.
      impl.storage.observers.put(
          { profileId: "alice", observerId: "obs-1", accountChoices: { 1: 10, 2: 20 } });

      let removed: number[] = [];
      impl.getGatekeeperFacet = (id: number) => ({
        addObserver: async () => {},
        removeObserver: async () => { removed.push(id); },
      });

      // Gatekeeper 1's verifier never materializes: the client's User DO *rejects* (the
      // deterministic vendor-mismatch throw, or any cross-worker transport failure) rather than
      // returning null.
      let failingClientUser = {
        getVerifier: async (accountId: number) => {
          if (accountId === 10) throw new Error("account is for a different vendor");
          return {};
        },
        describeConnectedAccount: async () => null,
      } as any;

      // No repair channel, so the failure is terminal -- and descriptive, not the raw RPC error.
      await expect(impl.ensureObserver("alice", failingClientUser, "build"))
          .rejects.toThrow(/could not confirm/);

      // The rejection went through fail(): gatekeeper 1's persisted coverage is scrubbed -- so
      // the coverage guard stops admitting its restricted reads to this collaborator's older
      // live sessions -- while gatekeeper 2's survives, and the refused registration was torn
      // down on the gatekeeper.
      let record = impl.storage.observers.get("alice");
      expect(1 in record.accountChoices).toBe(false);
      expect(record.accountChoices[2]).toBe(20);
      expect(removed).toEqual([1]);
    });
  });

  it("keeps distinct profiles concurrent", async () => {
    let stub = env.TEST_OVERSEER.getByName("observer-serialization-distinct-profiles");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      seedGatekeepers(impl);
      impl.getGatekeeperFacet = () => ({ addObserver: async () => {} });

      // Alice parks in her modal; Bob's open must complete anyway.
      let held = deferred();
      let configureAlice = {
        configure: async () => {
          await held.promise;
          return [{ gatekeeperId: 1, accountId: 10 }, { gatekeeperId: 2, accountId: 20 }];
        },
      } as any;
      let configureBob = {
        configure: async () =>
          [{ gatekeeperId: 1, accountId: 30 }, { gatekeeperId: 2, accountId: 40 }],
      } as any;

      let openAlice = impl.ensureObserver("alice", fakeClientUser, "build", configureAlice);
      await tick();
      await impl.ensureObserver("bob", fakeClientUser, "build", configureBob);
      expect(impl.storage.observers.get("bob")).toBeDefined();
      expect(impl.storage.observers.get("alice")).toBeUndefined();

      held.resolve();
      await openAlice;
      expect(impl.storage.observers.get("alice")).toBeDefined();
    });
  });
});
