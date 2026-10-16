const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const CLEAR = 1;
const HIT = 2;
const S = { None: 0, AwaitingClearance: 1, Active: 2, PendingRelease: 3, Disputed: 4, Released: 5, Frozen: 6 };
const METADATA = "0x" + "00".repeat(62); // forwarder metadata (not validated in these tests)
const coder = ethers.AbiCoder.defaultAbiCoder();
const AGREEMENT = ethers.sha256(ethers.toUtf8Bytes("Services Agreement v1 - signed PDF bytes"));
const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes("evidence"));

function report(checkedAt, ids, verdicts, evidence = EVIDENCE) {
  return coder.encode(["uint64", "bytes32", "uint256[]", "uint8[]"], [checkedAt, evidence, ids, verdicts]);
}

describe("ClearReleaseEscrow", function () {
  let escrow, owner, forwarder, payer, payee, other;
  const ONE = ethers.parseEther("1");

  beforeEach(async () => {
    [owner, forwarder, payer, payee, other] = await ethers.getSigners();
    const F = await ethers.getContractFactory("ClearReleaseEscrow");
    escrow = await F.deploy(forwarder.address);
  });

  async function open(amount = ONE) {
    const releaseAfter = (await time.latest()) + 7 * 24 * 3600;
    const tx = await escrow.connect(payer).openEscrow(payee.address, AGREEMENT, releaseAfter, { value: amount });
    return { tx, releaseAfter };
  }

  async function deliver(ids, verdicts, checkedAt) {
    const at = checkedAt ?? (await time.latest()) + 1;
    return escrow.connect(forwarder).onReport(METADATA, report(at, ids, verdicts));
  }

  it("opens in AwaitingClearance and requests onboarding screening", async () => {
    const { tx } = await open();
    await expect(tx).to.emit(escrow, "ScreeningRequested").withArgs(1, 1, payer.address, payee.address);
    expect((await escrow.getEscrow(1)).status).to.equal(S.AwaitingClearance);
  });

  it("happy path: CLEAR -> Active -> approve -> CLEAR -> Released -> withdraw", async () => {
    await open();
    await deliver([1], [CLEAR]);
    expect((await escrow.getEscrow(1)).status).to.equal(S.Active);

    await expect(escrow.connect(payer).approveRelease(1))
      .to.emit(escrow, "ScreeningRequested").withArgs(1, 2, payer.address, payee.address);
    expect((await escrow.getEscrow(1)).status).to.equal(S.PendingRelease);

    await expect(deliver([1], [CLEAR])).to.emit(escrow, "EscrowReleased").withArgs(1, ONE, 0, EVIDENCE);
    expect(await escrow.withdrawable(payee.address)).to.equal(ONE);
    await expect(escrow.connect(payee).withdraw()).to.changeEtherBalances([payee, escrow], [ONE, -ONE]);
  });

  it("a HIT at onboarding freezes the escrow and funds stay blocked (no auto-refund)", async () => {
    await open();
    await expect(deliver([1], [HIT])).to.emit(escrow, "EscrowFrozen");
    const e = await escrow.getEscrow(1);
    expect(e.status).to.equal(S.Frozen);
    expect(e.lastEvidence).to.equal(EVIDENCE);
    expect(await escrow.withdrawable(payer.address)).to.equal(0);
    await expect(escrow.connect(payer).approveRelease(1)).to.be.revertedWithCustomError(escrow, "WrongStatus");
  });

  it("a HIT while PendingRelease freezes instead of paying", async () => {
    await open();
    await deliver([1], [CLEAR]);
    await escrow.connect(payer).approveRelease(1);
    await deliver([1], [HIT]);
    expect((await escrow.getEscrow(1)).status).to.equal(S.Frozen);
    expect(await escrow.withdrawable(payee.address)).to.equal(0);
  });

  it("fails closed: a CLEAR computed before the release request cannot release funds", async () => {
    await open();
    await deliver([1], [CLEAR]);
    const before = await time.latest();
    await time.increase(60);
    await escrow.connect(payer).approveRelease(1);
    await expect(deliver([1], [CLEAR], before)).to.emit(escrow, "ReportItemSkipped");
    expect((await escrow.getEscrow(1)).status).to.equal(S.PendingRelease);
  });

  it("ignores stale reports older than the last applied screening", async () => {
    await open();
    const t = (await time.latest()) + 100;
    await deliver([1], [CLEAR], t);
    await expect(deliver([1], [HIT], t - 50)).to.emit(escrow, "ReportItemSkipped").withArgs(1, "stale");
    expect((await escrow.getEscrow(1)).status).to.equal(S.Active);
  });

  it("only the forwarder can deliver reports", async () => {
    await open();
    const r = report((await time.latest()) + 1, [1], [CLEAR]);
    await expect(escrow.connect(other).onReport(METADATA, r)).to.be.revertedWithCustomError(escrow, "InvalidSender");
  });

  it("dispute -> arbitrator award (70/30) -> CLEAR -> split payout", async () => {
    await open();
    await deliver([1], [CLEAR]);
    await expect(escrow.connect(payer).dispute(1, ethers.id("late delivery"))).to.emit(escrow, "Disputed");
    await expect(escrow.connect(payer).resolveDispute(1, 7000, ethers.id("ruling")))
      .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    await escrow.connect(owner).resolveDispute(1, 7000, ethers.id("ruling"));
    await deliver([1], [CLEAR]);
    expect(await escrow.withdrawable(payee.address)).to.equal(ethers.parseEther("0.7"));
    expect(await escrow.withdrawable(payer.address)).to.equal(ethers.parseEther("0.3"));
  });

  it("payee can claim after the deadline if there was no dispute", async () => {
    const { releaseAfter } = await open();
    await deliver([1], [CLEAR]);
    await expect(escrow.connect(payee).claimAfterDeadline(1)).to.be.revertedWithCustomError(escrow, "TooEarly");
    await time.increaseTo(releaseAfter);
    await escrow.connect(payee).claimAfterDeadline(1);
    await deliver([1], [CLEAR]);
    expect((await escrow.getEscrow(1)).status).to.equal(S.Released);
  });

  it("review after delisting: CLEAR on a frozen escrow restores it", async () => {
    await open();
    await deliver([1], [CLEAR]);
    await escrow.connect(payer).approveRelease(1);
    await deliver([1], [HIT]);
    await expect(escrow.connect(owner).requestReview(1)).to.emit(escrow, "ScreeningRequested").withArgs(1, 3, payer.address, payee.address);
    await expect(deliver([1], [CLEAR])).to.emit(escrow, "ScreeningRequested").withArgs(1, 2, payer.address, payee.address);
    expect((await escrow.getEscrow(1)).status).to.equal(S.PendingRelease);
    await deliver([1], [CLEAR]);
    expect((await escrow.getEscrow(1)).status).to.equal(S.Released);
  });

  it("blocked funds move only by the owner, with a licence reference", async () => {
    await open();
    await deliver([1], [HIT]);
    await expect(escrow.connect(owner).transferBlockedFunds(1, other.address, ethers.ZeroHash))
      .to.be.revertedWithCustomError(escrow, "InvalidParams");
    await expect(escrow.connect(owner).transferBlockedFunds(1, other.address, ethers.id("OFAC-LIC-123")))
      .to.emit(escrow, "BlockedFundsTransferred");
    expect(await escrow.withdrawable(other.address)).to.equal(ONE);
  });

  it("batch reports and listOpen pagination for periodic monitoring", async () => {
    await open();
    await open();
    await open();
    await deliver([1, 2, 3], [CLEAR, HIT, CLEAR]);
    const [ids, payers, payees, statuses] = await escrow.listOpen(1, 10);
    expect(ids.map(Number)).to.deep.equal([1, 3]);
    expect(payers[0]).to.equal(payer.address);
    expect(payees[1]).to.equal(payee.address);
    expect(statuses.map(Number)).to.deep.equal([S.Active, S.Active]);
    const [page] = await escrow.listOpen(1, 1);
    expect(page.map(Number)).to.deep.equal([1]);
  });

  it("skips unknown ids and bad verdicts without reverting the whole batch", async () => {
    await open();
    await expect(deliver([1, 99], [CLEAR, CLEAR])).to.emit(escrow, "ReportItemSkipped").withArgs(99, "closed-or-unknown");
    expect((await escrow.getEscrow(1)).status).to.equal(S.Active);
    await expect(deliver([1], [7])).to.emit(escrow, "ReportItemSkipped").withArgs(1, "bad-verdict");
  });

  it("rejects invalid escrow parameters", async () => {
    const t = (await time.latest()) + 1000;
    await expect(escrow.connect(payer).openEscrow(payer.address, AGREEMENT, t, { value: ONE })).to.be.revertedWithCustomError(escrow, "InvalidParams");
    await expect(escrow.connect(payer).openEscrow(payee.address, ethers.ZeroHash, t, { value: ONE })).to.be.revertedWithCustomError(escrow, "InvalidParams");
    await expect(escrow.connect(payer).openEscrow(payee.address, AGREEMENT, t, { value: 0 })).to.be.revertedWithCustomError(escrow, "InvalidParams");
  });
});
