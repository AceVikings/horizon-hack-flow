import { describe, expect, it } from "vitest";
import { foreignOwnerLine, foreignOwnerOf, vaultOwnership } from "../src/renderer/views/setup/ownership";

const FLOW = "0x1111111111111111111111111111111111111111";
const DEPLOYER = "0xD000000000000000000000000000000000000001";
const V1 = "0xAaaa000000000000000000000000000000000001";
const V2 = "0xBbbb000000000000000000000000000000000002";

describe("vault ownership copy", () => {
  it("vaults Flow created: the Flow wallet owns them (case-insensitive), no other-wallet line", () => {
    const o = vaultOwnership(FLOW, [{ address: V1, owner: FLOW.toUpperCase().replace("0X", "0x") }, { address: V2, owner: FLOW }]);
    expect(o.allFlow).toBe(true);
    expect(o.foreign).toEqual([]);
    expect(foreignOwnerLine(o.foreign)).toBeNull();
    expect(foreignOwnerOf(o, FLOW, V1)).toBeNull();
  });
  it("vaults from 'I already have vaults': names the deployer and says only it can withdraw or resume", () => {
    const o = vaultOwnership(FLOW, [{ address: V1, owner: DEPLOYER }, { address: V2, owner: DEPLOYER }]);
    expect(o.allFlow).toBe(false);
    expect(o.foreign).toEqual([DEPLOYER]);
    expect(foreignOwnerLine(o.foreign)).toBe(`These vaults are owned by ${DEPLOYER} (another wallet). Only that wallet can withdraw or resume.`);
    expect(foreignOwnerOf(o, FLOW, V2.toLowerCase())).toBe(DEPLOYER);
  });
  it("unknown Flow wallet or unread owners claim nothing", () => {
    expect(vaultOwnership(null, [{ address: V1, owner: DEPLOYER }]).foreign).toEqual([]);
    expect(vaultOwnership(FLOW, [{ address: V1 }]).allFlow).toBe(false);
  });
});
