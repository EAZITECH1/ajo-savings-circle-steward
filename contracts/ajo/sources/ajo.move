// Copyright (c) 2026 Ajo Savings Circle Steward
// SPDX-License-Identifier: Apache-2.0

/// Ajo Rotating Savings and Credit Association (ROSCA) on Sui.
/// Enforces decentralized vault custody, fixed payout schedules,
/// wallet-signed member deposits, late contributions, and incremental claims in Move.
#[allow(lint(self_transfer), unused_const)]
module ajo::circle;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};

// === Status Constants ===
const STATUS_PENDING_ACCEPTANCE: u8 = 0;
const STATUS_ACTIVE: u8 = 1;
const STATUS_REFUNDING: u8 = 2;
const STATUS_COMPLETED: u8 = 3;

// === Error Codes ===
const E_INVALID_MEMBERS_COUNT: u64 = 1;
const E_INVALID_CONTRIBUTION_AMOUNT: u64 = 2;
const E_INVALID_CYCLE_DURATION: u64 = 3;
const E_INVALID_PAYOUT_ORDER: u64 = 4;
const E_DUPLICATE_MEMBER: u64 = 5;
const E_NOT_MEMBER: u64 = 6;
const E_ALREADY_ACCEPTED: u64 = 7;
const E_NOT_PENDING: u64 = 8;
const E_NOT_ACTIVE: u64 = 9;
const E_CYCLE_DEADLINE_PASSED: u64 = 10;
const E_ALREADY_FULLY_PAID: u64 = 11;
const E_EXCEEDS_OWED: u64 = 12;
const E_CYCLE_NOT_FULLY_FUNDED: u64 = 13;
const E_NOT_SCHEDULED_RECIPIENT: u64 = 14;
const E_NO_CLAIMABLE_FUNDS: u64 = 15;
const E_NOT_REFUNDING: u64 = 16;
const E_CANNOT_TRIGGER_REFUND: u64 = 17;
const E_NO_REFUND_DUE: u64 = 18;
const E_ZERO_DEPOSIT: u64 = 19;

// Public status accessors
public fun status_pending(): u8 { STATUS_PENDING_ACCEPTANCE }
public fun status_active(): u8 { STATUS_ACTIVE }
public fun status_refunding(): u8 { STATUS_REFUNDING }
public fun status_completed(): u8 { STATUS_COMPLETED }

// Public error code accessors for tests & clients
public fun err_not_recipient(): u64 { E_NOT_SCHEDULED_RECIPIENT }
public fun err_exceeds_owed(): u64 { E_EXCEEDS_OWED }
public fun err_cycle_not_fully_funded(): u64 { E_CYCLE_NOT_FULLY_FUNDED }
public fun err_no_claimable_funds(): u64 { E_NO_CLAIMABLE_FUNDS }

// === Table Key for Contribution Lookup ===
public struct ContributionKey has copy, drop, store {
    cycle: u64,
    member: address,
}

// === Circle Shared Object ===
public struct Circle<phantom T> has key {
    id: UID,
    name: String,
    creator: address,
    contribution_amount: u64,
    cycle_duration_ms: u64,
    current_cycle: u64,
    cycle_deadline_ms: u64,
    members: vector<address>,
    payout_order: vector<address>,
    accepted_members: vector<address>,
    vault: Balance<T>,
    cycle_contributions: Table<ContributionKey, u64>,
    cycle_claimed_amount: Table<u64, u64>,
    status: u8,
}

// === Events ===
public struct CircleCreatedEvent has copy, drop {
    circle_id: ID,
    creator: address,
    name: String,
    contribution_amount: u64,
    cycle_duration_ms: u64,
    member_count: u64,
}

public struct MemberAcceptedEvent has copy, drop {
    circle_id: ID,
    member: address,
    accepted_count: u64,
    total_members: u64,
}

public struct CircleActivatedEvent has copy, drop {
    circle_id: ID,
    cycle: u64,
    deadline_ms: u64,
}

public struct ContributionEvent has copy, drop {
    circle_id: ID,
    cycle: u64,
    member: address,
    amount_paid: u64,
    total_paid_in_cycle: u64,
    remaining_owed: u64,
    is_late: bool,
}

public struct CycleClaimedEvent has copy, drop {
    circle_id: ID,
    cycle: u64,
    recipient: address,
    amount_claimed: u64,
    total_claimed_in_cycle: u64,
    total_cycle_pot: u64,
}

public struct CycleAdvancedEvent has copy, drop {
    circle_id: ID,
    new_cycle: u64,
    new_deadline_ms: u64,
}

public struct CircleCompletedEvent has copy, drop {
    circle_id: ID,
    total_cycles: u64,
}

public struct RefundsEnabledEvent has copy, drop {
    circle_id: ID,
    cycle: u64,
}

public struct RefundClaimedEvent has copy, drop {
    circle_id: ID,
    cycle: u64,
    member: address,
    amount: u64,
}

// === Circle Creation ===
public fun create_circle<T>(
    name: String,
    contribution_amount: u64,
    cycle_duration_ms: u64,
    members: vector<address>,
    payout_order: vector<address>,
    ctx: &mut TxContext,
) {
    let member_len = members.length();
    assert!(member_len >= 2, E_INVALID_MEMBERS_COUNT);
    assert!(contribution_amount > 0, E_INVALID_CONTRIBUTION_AMOUNT);
    assert!(cycle_duration_ms > 0, E_INVALID_CYCLE_DURATION);
    assert!(payout_order.length() == member_len, E_INVALID_PAYOUT_ORDER);

    // Validate members list for uniqueness
    let mut i = 0;
    while (i < member_len) {
        let m = *members.borrow(i);
        let mut j = i + 1;
        while (j < member_len) {
            assert!(m != *members.borrow(j), E_DUPLICATE_MEMBER);
            j = j + 1;
        };
        // Verify every payout_order recipient is in members
        assert!(members.contains(payout_order.borrow(i)), E_INVALID_PAYOUT_ORDER);
        i = i + 1;
    };

    let creator = ctx.sender();
    let mut accepted_members = vector[];
    if (members.contains(&creator)) {
        accepted_members.push_back(creator);
    };

    let circle_uid = object::new(ctx);
    let circle_id = circle_uid.to_inner();

    let circle = Circle<T> {
        id: circle_uid,
        name,
        creator,
        contribution_amount,
        cycle_duration_ms,
        current_cycle: 1,
        cycle_deadline_ms: 0,
        members,
        payout_order,
        accepted_members,
        vault: balance::zero<T>(),
        cycle_contributions: table::new(ctx),
        cycle_claimed_amount: table::new(ctx),
        status: STATUS_PENDING_ACCEPTANCE,
    };

    event::emit(CircleCreatedEvent {
        circle_id,
        creator,
        name,
        contribution_amount,
        cycle_duration_ms,
        member_count: member_len,
    });

    transfer::share_object(circle);
}

// === Member Acceptance ===
public fun accept_circle<T>(
    circle: &mut Circle<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(circle.status == STATUS_PENDING_ACCEPTANCE, E_NOT_PENDING);
    let sender = ctx.sender();
    assert!(circle.members.contains(&sender), E_NOT_MEMBER);
    assert!(!circle.accepted_members.contains(&sender), E_ALREADY_ACCEPTED);

    circle.accepted_members.push_back(sender);
    let accepted_count = circle.accepted_members.length();
    let total_members = circle.members.length();

    event::emit(MemberAcceptedEvent {
        circle_id: circle.id.to_inner(),
        member: sender,
        accepted_count,
        total_members,
    });

    // If all listed members have accepted, activate circle
    if (accepted_count == total_members) {
        circle.status = STATUS_ACTIVE;
        let now = clock.timestamp_ms();
        circle.cycle_deadline_ms = now + circle.cycle_duration_ms;

        event::emit(CircleActivatedEvent {
            circle_id: circle.id.to_inner(),
            cycle: 1,
            deadline_ms: circle.cycle_deadline_ms,
        });
    };
}

// === Member Deposit / Contribution ===
// Supports on-time and late contributions into the active cycle.
public fun contribute<T>(
    circle: &mut Circle<T>,
    payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // If circle was pending acceptance, contributing activates it into cycle 1!
    if (circle.status == STATUS_PENDING_ACCEPTANCE) {
        circle.status = STATUS_ACTIVE;
        if (circle.cycle_deadline_ms == 0) {
            circle.cycle_deadline_ms = clock.timestamp_ms() + circle.cycle_duration_ms;
        };
        event::emit(CircleActivatedEvent {
            circle_id: circle.id.to_inner(),
            cycle: 1,
            deadline_ms: circle.cycle_deadline_ms,
        });
    };

    assert!(circle.status == STATUS_ACTIVE, E_NOT_ACTIVE);
    // Late contributions are accepted into the same cycle up to remaining amount owed!

    let sender = ctx.sender();
    assert!(circle.members.contains(&sender), E_NOT_MEMBER);

    let coin_val = payment.value();
    assert!(coin_val > 0, E_ZERO_DEPOSIT);

    let key = ContributionKey {
        cycle: circle.current_cycle,
        member: sender,
    };

    let already_paid = if (circle.cycle_contributions.contains(key)) {
        *circle.cycle_contributions.borrow(key)
    } else {
        0
    };

    assert!(already_paid < circle.contribution_amount, E_ALREADY_FULLY_PAID);
    let owed = circle.contribution_amount - already_paid;
    assert!(coin_val <= owed, E_EXCEEDS_OWED);

    let new_total = already_paid + coin_val;
    if (circle.cycle_contributions.contains(key)) {
        *circle.cycle_contributions.borrow_mut(key) = new_total;
    } else {
        circle.cycle_contributions.add(key, new_total);
    };

    // Deposit funds directly into vault
    circle.vault.join(payment.into_balance());

    let remaining = circle.contribution_amount - new_total;
    let is_late = clock.timestamp_ms() > circle.cycle_deadline_ms;

    event::emit(ContributionEvent {
        circle_id: circle.id.to_inner(),
        cycle: circle.current_cycle,
        member: sender,
        amount_paid: coin_val,
        total_paid_in_cycle: new_total,
        remaining_owed: remaining,
        is_late,
    });
}

// === Payout Claim by Scheduled Recipient (Supports Incremental Claims) ===
public fun claim_cycle<T>(
    circle: &mut Circle<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(circle.status == STATUS_ACTIVE, E_NOT_ACTIVE);

    let current_cycle = circle.current_cycle;
    let scheduled_recipient = *circle.payout_order.borrow(current_cycle - 1);
    assert!(ctx.sender() == scheduled_recipient, E_NOT_SCHEDULED_RECIPIENT);

    let available = circle.vault.value();
    assert!(available > 0, E_NO_CLAIMABLE_FUNDS);

    let now = clock.timestamp_ms();
    let is_fully_funded = is_cycle_fully_funded(circle, current_cycle);

    // Rule:
    // - Before deadline: claim allowed ONLY when cycle pot is fully funded.
    // - Once deadline passes: recipient may claim amount currently available in vault, even if incomplete.
    if (now <= circle.cycle_deadline_ms) {
        assert!(is_fully_funded, E_CYCLE_NOT_FULLY_FUNDED);
    };

    // Release payout coin to the scheduled recipient
    let payout_balance = circle.vault.split(available);
    let payout_coin = coin::from_balance(payout_balance, ctx);
    transfer::public_transfer(payout_coin, scheduled_recipient);

    let already_claimed = if (circle.cycle_claimed_amount.contains(current_cycle)) {
        *circle.cycle_claimed_amount.borrow(current_cycle)
    } else {
        0
    };

    let total_claimed = already_claimed + available;
    if (circle.cycle_claimed_amount.contains(current_cycle)) {
        *circle.cycle_claimed_amount.borrow_mut(current_cycle) = total_claimed;
    } else {
        circle.cycle_claimed_amount.add(current_cycle, total_claimed);
    };

    let member_count = circle.members.length();
    let total_cycle_pot = circle.contribution_amount * member_count;

    event::emit(CycleClaimedEvent {
        circle_id: circle.id.to_inner(),
        cycle: current_cycle,
        recipient: scheduled_recipient,
        amount_claimed: available,
        total_claimed_in_cycle: total_claimed,
        total_cycle_pot,
    });

    // Advance to next cycle ONLY when:
    // 1. Every member has contributed the full required amount for the current cycle, AND
    // 2. The recipient has claimed the entire cycle pot.
    if (is_fully_funded && total_claimed == total_cycle_pot) {
        if (current_cycle < member_count) {
            circle.current_cycle = current_cycle + 1;
            circle.cycle_deadline_ms = now + circle.cycle_duration_ms;

            event::emit(CycleAdvancedEvent {
                circle_id: circle.id.to_inner(),
                new_cycle: circle.current_cycle,
                new_deadline_ms: circle.cycle_deadline_ms,
            });
        } else {
            circle.status = STATUS_COMPLETED;
            event::emit(CircleCompletedEvent {
                circle_id: circle.id.to_inner(),
                total_cycles: member_count,
            });
        };
    };
}

// === Trigger Refund (Callable only for explicit refunding state) ===
public fun trigger_refund<T>(
    circle: &mut Circle<T>,
    _ctx: &TxContext,
) {
    // Requires status to be explicitly set to REFUNDING by governance/agreement
    assert!(circle.status == STATUS_REFUNDING, E_NOT_REFUNDING);

    event::emit(RefundsEnabledEvent {
        circle_id: circle.id.to_inner(),
        cycle: circle.current_cycle,
    });
}

// === Claim Member Refund ===
public fun claim_refund<T>(
    circle: &mut Circle<T>,
    ctx: &mut TxContext,
) {
    assert!(circle.status == STATUS_REFUNDING, E_NOT_REFUNDING);

    let sender = ctx.sender();
    let key = ContributionKey {
        cycle: circle.current_cycle,
        member: sender,
    };

    assert!(circle.cycle_contributions.contains(key), E_NO_REFUND_DUE);
    let amount = *circle.cycle_contributions.borrow(key);
    assert!(amount > 0, E_NO_REFUND_DUE);

    // Set record to 0 to prevent double refunds
    *circle.cycle_contributions.borrow_mut(key) = 0;

    // Refund exact deposited amount from vault
    let refund_balance = circle.vault.split(amount);
    let refund_coin = coin::from_balance(refund_balance, ctx);
    transfer::public_transfer(refund_coin, sender);

    event::emit(RefundClaimedEvent {
        circle_id: circle.id.to_inner(),
        cycle: circle.current_cycle,
        member: sender,
        amount,
    });
}

// === View & Inspection Functions ===

public fun is_cycle_fully_funded<T>(circle: &Circle<T>, cycle: u64): bool {
    let mut i = 0;
    let len = circle.members.length();
    while (i < len) {
        let member = *circle.members.borrow(i);
        let key = ContributionKey { cycle, member };
        let paid = if (circle.cycle_contributions.contains(key)) {
            *circle.cycle_contributions.borrow(key)
        } else {
            0
        };
        if (paid < circle.contribution_amount) {
            return false
        };
        i = i + 1;
    };
    true
}

public fun get_member_cycle_paid<T>(circle: &Circle<T>, cycle: u64, member: address): u64 {
    let key = ContributionKey { cycle, member };
    if (circle.cycle_contributions.contains(key)) {
        *circle.cycle_contributions.borrow(key)
    } else {
        0
    }
}

public fun get_member_cycle_owed<T>(circle: &Circle<T>, cycle: u64, member: address): u64 {
    let paid = get_member_cycle_paid(circle, cycle, member);
    if (paid >= circle.contribution_amount) {
        0
    } else {
        circle.contribution_amount - paid
    }
}

public fun get_current_recipient<T>(circle: &Circle<T>): address {
    *circle.payout_order.borrow(circle.current_cycle - 1)
}

public fun get_cycle_claimed_amount<T>(circle: &Circle<T>, cycle: u64): u64 {
    if (circle.cycle_claimed_amount.contains(cycle)) {
        *circle.cycle_claimed_amount.borrow(cycle)
    } else {
        0
    }
}

public fun is_cycle_claimed<T>(circle: &Circle<T>, cycle: u64): bool {
    let member_count = circle.members.length();
    let total_cycle_pot = circle.contribution_amount * member_count;
    get_cycle_claimed_amount(circle, cycle) >= total_cycle_pot
}

public fun get_claimable_amount<T>(circle: &Circle<T>, clock: &Clock): u64 {
    if (circle.status != STATUS_ACTIVE) {
        return 0
    };
    let now = clock.timestamp_ms();
    let is_funded = is_cycle_fully_funded(circle, circle.current_cycle);
    if (now <= circle.cycle_deadline_ms) {
        if (is_funded) {
            circle.vault.value()
        } else {
            0
        }
    } else {
        circle.vault.value()
    }
}

public fun status<T>(circle: &Circle<T>): u8 { circle.status }
public fun current_cycle<T>(circle: &Circle<T>): u64 { circle.current_cycle }
public fun cycle_deadline_ms<T>(circle: &Circle<T>): u64 { circle.cycle_deadline_ms }
public fun contribution_amount<T>(circle: &Circle<T>): u64 { circle.contribution_amount }
public fun cycle_duration_ms<T>(circle: &Circle<T>): u64 { circle.cycle_duration_ms }
public fun vault_balance<T>(circle: &Circle<T>): u64 { circle.vault.value() }
public fun members<T>(circle: &Circle<T>): vector<address> { circle.members }
public fun payout_order<T>(circle: &Circle<T>): vector<address> { circle.payout_order }
public fun accepted_members<T>(circle: &Circle<T>): vector<address> { circle.accepted_members }
