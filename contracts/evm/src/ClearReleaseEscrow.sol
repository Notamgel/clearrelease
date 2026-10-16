// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReceiverTemplate} from "./ReceiverTemplate.sol";

/**
 * @title  ClearReleaseEscrow
 * @notice Milestone escrow for legal agreements where every movement of funds is gated by a
 *         sanctions-screening decision produced by a Chainlink CRE workflow.
 *
 *         Lifecycle
 *         ---------
 *           openEscrow()            -> AwaitingClearance   (onboarding screening requested)
 *           CRE report: CLEAR       -> Active
 *           approveRelease() (payer) or claimAfterDeadline() (payee)
 *                                   -> PendingRelease      (release screening requested)
 *           CRE report: CLEAR       -> Released            (funds credited, pull-payment)
 *           dispute()  (payer)      -> Disputed
 *           resolveDispute() (arbitrator = owner, sets the award split)
 *                                   -> PendingRelease      (release screening requested)
 *           CRE report: HIT         -> Frozen              (from any open state; funds stay blocked)
 *           requestReview() (owner) -> review screening requested; CLEAR restores the prior state
 *
 *         Design choices that matter legally
 *         ----------------------------------
 *         - Fail closed: funds never move without a CLEAR verdict that was produced AFTER the
 *           state change that requested it (checkedAt >= statusSince). A stale CLEAR cannot
 *           release funds.
 *         - Frozen funds are NOT auto-refunded to the payer. Blocked property must stay blocked;
 *           it can only be moved by the escrow agent (owner) with a recorded licence/authorisation
 *           reference, or unfrozen after a fresh CLEAR review (e.g. after a delisting).
 *         - Every decision stores an evidence hash that commits to the exact list snapshot
 *           (git commit + list hash) and oracle answers the DON reached consensus on.
 *         - The agreement itself is anchored by its SHA-256 (agreementHash); no document content
 *           is put on-chain.
 *
 *         Report format (abi-encoded by the workflow):
 *           (uint64 checkedAt, bytes32 evidenceHash, uint256[] ids, uint8[] verdicts)
 *           verdict 1 = CLEAR, 2 = HIT
 *
 * @dev    Educational / hackathon code. Not audited. Do not use in production without review.
 */
contract ClearReleaseEscrow is ReceiverTemplate {
    // ------------------------------------------------------------------ types

    enum Status {
        None, // 0
        AwaitingClearance, // 1
        Active, // 2
        PendingRelease, // 3
        Disputed, // 4
        Released, // 5
        Frozen // 6
    }

    enum Purpose {
        None, // 0
        Onboarding, // 1
        Release, // 2
        Review // 3
    }

    uint8 public constant VERDICT_CLEAR = 1;
    uint8 public constant VERDICT_HIT = 2;
    uint16 public constant BPS = 10_000;

    struct Escrow {
        address payer;
        address payee;
        uint128 amount; // wei
        uint16 payeeBps; // share of `amount` paid to payee on release (10000 = 100%)
        Status status;
        Status statusBeforeFreeze;
        uint64 releaseAfter; // unix time after which the payee may claim if no dispute
        uint64 statusSince; // timestamp of the last status change
        uint64 lastScreenedAt; // DON timestamp of the last applied screening
        bytes32 agreementHash; // sha256 of the signed agreement document
        bytes32 lastEvidence; // evidence hash of the last applied screening
    }

    // ------------------------------------------------------------------ storage

    uint256 public nextId = 1;
    mapping(uint256 => Escrow) private s_escrows;
    mapping(address => uint256) public withdrawable;

    // ------------------------------------------------------------------ events

    event EscrowOpened(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        bytes32 agreementHash,
        uint64 releaseAfter
    );
    /// @notice The CRE workflow listens to this event (EVM log trigger).
    event ScreeningRequested(uint256 indexed id, uint8 purpose, address payer, address payee);
    event StatusChanged(uint256 indexed id, Status from, Status to);
    event Screened(uint256 indexed id, uint8 verdict, bytes32 evidenceHash, uint64 checkedAt);
    event EscrowReleased(uint256 indexed id, uint256 toPayee, uint256 toPayer, bytes32 evidenceHash);
    event EscrowFrozen(uint256 indexed id, bytes32 evidenceHash, uint64 checkedAt);
    event Disputed(uint256 indexed id, bytes32 reasonHash);
    event DisputeResolved(uint256 indexed id, uint16 payeeBps, bytes32 rulingHash);
    event BlockedFundsTransferred(uint256 indexed id, address indexed to, uint256 amount, bytes32 licenceRef);
    event ReportItemSkipped(uint256 indexed id, string reason);
    event Withdrawn(address indexed account, uint256 amount);

    // ------------------------------------------------------------------ errors

    error InvalidParams();
    error NotPayer();
    error NotPayee();
    error WrongStatus(Status current);
    error TooEarly();
    error TooLate();
    error NothingToWithdraw();
    error TransferFailed();
    error LengthMismatch();

    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    // ------------------------------------------------------------------ parties

    /// @notice Lock ETH for `payee` under an agreement identified by its SHA-256 hash.
    function openEscrow(address payee, bytes32 agreementHash, uint64 releaseAfter)
        external
        payable
        returns (uint256 id)
    {
        if (payee == address(0) || payee == msg.sender || msg.value == 0 || msg.value > type(uint128).max) {
            revert InvalidParams();
        }
        if (agreementHash == bytes32(0) || releaseAfter <= block.timestamp) revert InvalidParams();

        id = nextId++;
        Escrow storage e = s_escrows[id];
        e.payer = msg.sender;
        e.payee = payee;
        e.amount = uint128(msg.value);
        e.payeeBps = BPS;
        e.releaseAfter = releaseAfter;
        e.agreementHash = agreementHash;

        emit EscrowOpened(id, msg.sender, payee, msg.value, agreementHash, releaseAfter);
        _setStatus(id, e, Status.AwaitingClearance);
        emit ScreeningRequested(id, uint8(Purpose.Onboarding), msg.sender, payee);
    }

    /// @notice Payer confirms the milestone was delivered.
    function approveRelease(uint256 id) external {
        Escrow storage e = s_escrows[id];
        if (msg.sender != e.payer) revert NotPayer();
        if (e.status != Status.Active) revert WrongStatus(e.status);
        _setStatus(id, e, Status.PendingRelease);
        emit ScreeningRequested(id, uint8(Purpose.Release), e.payer, e.payee);
    }

    /// @notice Payee claims after the review period if the payer did not dispute.
    function claimAfterDeadline(uint256 id) external {
        Escrow storage e = s_escrows[id];
        if (msg.sender != e.payee) revert NotPayee();
        if (e.status != Status.Active) revert WrongStatus(e.status);
        if (block.timestamp < e.releaseAfter) revert TooEarly();
        _setStatus(id, e, Status.PendingRelease);
        emit ScreeningRequested(id, uint8(Purpose.Release), e.payer, e.payee);
    }

    /// @notice Payer disputes before the release deadline. `reasonHash` = hash of the off-chain claim.
    function dispute(uint256 id, bytes32 reasonHash) external {
        Escrow storage e = s_escrows[id];
        if (msg.sender != e.payer) revert NotPayer();
        if (e.status != Status.Active) revert WrongStatus(e.status);
        if (block.timestamp >= e.releaseAfter) revert TooLate();
        _setStatus(id, e, Status.Disputed);
        emit Disputed(id, reasonHash);
    }

    /// @notice Pull payment: released funds are credited, then withdrawn by their owner.
    function withdraw() external {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ escrow agent / arbitrator

    /// @notice Arbitrator (owner) records an award. The award is paid only after a CLEAR screening.
    function resolveDispute(uint256 id, uint16 payeeBps, bytes32 rulingHash) external onlyOwner {
        Escrow storage e = s_escrows[id];
        if (e.status != Status.Disputed) revert WrongStatus(e.status);
        if (payeeBps > BPS) revert InvalidParams();
        e.payeeBps = payeeBps;
        emit DisputeResolved(id, payeeBps, rulingHash);
        _setStatus(id, e, Status.PendingRelease);
        emit ScreeningRequested(id, uint8(Purpose.Release), e.payer, e.payee);
    }

    /// @notice Ask the workflow to re-screen a frozen escrow (e.g. after a delisting).
    function requestReview(uint256 id) external onlyOwner {
        Escrow storage e = s_escrows[id];
        if (e.status != Status.Frozen) revert WrongStatus(e.status);
        emit ScreeningRequested(id, uint8(Purpose.Review), e.payer, e.payee);
    }

    /// @notice Move blocked funds only under a licence/authorisation, recorded on-chain by reference.
    function transferBlockedFunds(uint256 id, address to, bytes32 licenceRef) external onlyOwner {
        Escrow storage e = s_escrows[id];
        if (e.status != Status.Frozen) revert WrongStatus(e.status);
        if (to == address(0) || licenceRef == bytes32(0)) revert InvalidParams();
        uint256 amount = e.amount;
        _setStatus(id, e, Status.Released);
        withdrawable[to] += amount;
        emit BlockedFundsTransferred(id, to, amount, licenceRef);
    }

    // ------------------------------------------------------------------ CRE report handling

    /// @dev Called by ReceiverTemplate.onReport after the forwarder / workflow identity checks.
    function _processReport(bytes calldata report) internal override {
        (uint64 checkedAt, bytes32 evidenceHash, uint256[] memory ids, uint8[] memory verdicts) =
            abi.decode(report, (uint64, bytes32, uint256[], uint8[]));
        if (ids.length != verdicts.length) revert LengthMismatch();

        for (uint256 i = 0; i < ids.length; i++) {
            _applyVerdict(ids[i], verdicts[i], evidenceHash, checkedAt);
        }
    }

    function _applyVerdict(uint256 id, uint8 verdict, bytes32 evidenceHash, uint64 checkedAt) private {
        Escrow storage e = s_escrows[id];
        Status st = e.status;

        if (st == Status.None || st == Status.Released) {
            emit ReportItemSkipped(id, "closed-or-unknown");
            return;
        }
        if (verdict != VERDICT_CLEAR && verdict != VERDICT_HIT) {
            emit ReportItemSkipped(id, "bad-verdict");
            return;
        }
        if (checkedAt < e.lastScreenedAt) {
            emit ReportItemSkipped(id, "stale");
            return;
        }

        e.lastScreenedAt = checkedAt;
        e.lastEvidence = evidenceHash;
        emit Screened(id, verdict, evidenceHash, checkedAt);

        if (verdict == VERDICT_HIT) {
            if (st != Status.Frozen) {
                e.statusBeforeFreeze = st;
                _setStatus(id, e, Status.Frozen);
                emit EscrowFrozen(id, evidenceHash, checkedAt);
            }
            return;
        }

        // CLEAR verdicts can only advance state if the screening post-dates the request.
        if (checkedAt < e.statusSince) {
            emit ReportItemSkipped(id, "clear-predates-request");
            return;
        }

        if (st == Status.AwaitingClearance) {
            _setStatus(id, e, Status.Active);
        } else if (st == Status.PendingRelease) {
            _release(id, e, evidenceHash);
        } else if (st == Status.Frozen) {
            // A review CLEAR re-screened both parties after the freeze, so it also satisfies a
            // pending onboarding check. A pending release still gets its own fresh screening.
            Status restored = e.statusBeforeFreeze == Status.AwaitingClearance ? Status.Active : e.statusBeforeFreeze;
            _setStatus(id, e, restored);
            if (restored == Status.PendingRelease) {
                // the release still needs its own fresh screening
                emit ScreeningRequested(id, uint8(Purpose.Release), e.payer, e.payee);
            }
        }
        // Active / Disputed + CLEAR: periodic monitoring, evidence recorded above.
    }

    function _release(uint256 id, Escrow storage e, bytes32 evidenceHash) private {
        uint256 toPayee = (uint256(e.amount) * e.payeeBps) / BPS;
        uint256 toPayer = uint256(e.amount) - toPayee;
        _setStatus(id, e, Status.Released);
        if (toPayee > 0) withdrawable[e.payee] += toPayee;
        if (toPayer > 0) withdrawable[e.payer] += toPayer;
        emit EscrowReleased(id, toPayee, toPayer, evidenceHash);
    }

    function _setStatus(uint256 id, Escrow storage e, Status to) private {
        Status from = e.status;
        e.status = to;
        e.statusSince = uint64(block.timestamp);
        emit StatusChanged(id, from, to);
    }

    // ------------------------------------------------------------------ views

    function getEscrow(uint256 id) external view returns (Escrow memory) {
        return s_escrows[id];
    }

    /// @notice Escrows the periodic (cron) screening should look at: every open, non-frozen escrow.
    /// @dev    Paginated by id range so the workflow stays within CRE read limits.
    function listOpen(uint256 startId, uint256 maxItems)
        external
        view
        returns (uint256[] memory ids, address[] memory payers, address[] memory payees, uint8[] memory statuses)
    {
        uint256 end = nextId;
        uint256 count;
        for (uint256 i = startId; i < end && count < maxItems; i++) {
            if (_isMonitored(s_escrows[i].status)) count++;
        }
        ids = new uint256[](count);
        payers = new address[](count);
        payees = new address[](count);
        statuses = new uint8[](count);
        uint256 j;
        for (uint256 i = startId; i < end && j < count; i++) {
            Escrow storage e = s_escrows[i];
            if (_isMonitored(e.status)) {
                ids[j] = i;
                payers[j] = e.payer;
                payees[j] = e.payee;
                statuses[j] = uint8(e.status);
                j++;
            }
        }
    }

    function _isMonitored(Status s) private pure returns (bool) {
        return s == Status.AwaitingClearance || s == Status.Active || s == Status.PendingRelease
            || s == Status.Disputed;
    }
}
