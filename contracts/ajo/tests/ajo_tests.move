// Copyright (c) 2026 Ajo Savings Circle Steward
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module ajo::ajo_tests;

use std::string;
use sui::clock;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario as ts;
use ajo::circle::{
    Self,
    Circle,
};

const ALICE: address = @0xAAAA;
const BOB: address = @0xBBBB;
const CHARLIE: address = @0xCCCC;

const CONTRIBUTION_AMOUNT: u64 = 1_000_000_000; // 1 SUI
const CYCLE_DURATION_MS: u64 = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

#[test]
fun test_circle_lifecycle_end_to_end() {
    let mut scenario = ts::begin(ALICE);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clock, 1000);

    // 1. Alice creates the circle with Alice, Bob, Charlie
    let members = vector[ALICE, BOB, CHARLIE];
    let payout_order = vector[ALICE, BOB, CHARLIE];

    circle::create_circle<SUI>(
        string::utf8(b"Lagos Techies Savings Circle"),
        CONTRIBUTION_AMOUNT,
        CYCLE_DURATION_MS,
        members,
        payout_order,
        ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        assert!(circle::status(&circle) == circle::status_pending(), 101);
        assert!(circle::members(&circle).length() == 3, 102);
        assert!(circle::accepted_members(&circle).length() == 1, 103); // Alice auto-accepted as creator

        // Bob accepts
        circle::accept_circle(&mut circle, &clock, ts::ctx(&mut scenario));
        assert!(circle::status(&circle) == circle::status_pending(), 104);
        assert!(circle::accepted_members(&circle).length() == 2, 105);

        ts::return_shared(circle);
    };

    ts::next_tx(&mut scenario, CHARLIE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);

        // Charlie accepts -> All 3 accepted -> Circle activates!
        circle::accept_circle(&mut circle, &clock, ts::ctx(&mut scenario));
        assert!(circle::status(&circle) == circle::status_active(), 106);
        assert!(circle::cycle_deadline_ms(&circle) == 1000 + CYCLE_DURATION_MS, 107);
        assert!(circle::current_cycle(&circle) == 1, 108);

        ts::return_shared(circle);
    };

    // 2. Cycle 1 contributions: Alice, Bob, Charlie deposit 1 SUI each
    // Alice deposits
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        let payment: Coin<SUI> = coin::mint_for_testing(CONTRIBUTION_AMOUNT, ts::ctx(&mut scenario));

        circle::contribute(&mut circle, payment, &clock, ts::ctx(&mut scenario));
        assert!(circle::vault_balance(&circle) == CONTRIBUTION_AMOUNT, 109);
        assert!(circle::get_member_cycle_paid(&circle, 1, ALICE) == CONTRIBUTION_AMOUNT, 110);
        assert!(circle::get_member_cycle_owed(&circle, 1, ALICE) == 0, 111);
        assert!(!circle::is_cycle_fully_funded(&circle, 1), 112);

        ts::return_shared(circle);
    };

    // Bob deposits in two partial installments (0.4 SUI + 0.6 SUI)
    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        let part1 = coin::mint_for_testing(400_000_000, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, part1, &clock, ts::ctx(&mut scenario));

        assert!(circle::get_member_cycle_paid(&circle, 1, BOB) == 400_000_000, 113);
        assert!(circle::get_member_cycle_owed(&circle, 1, BOB) == 600_000_000, 114);

        let part2 = coin::mint_for_testing(600_000_000, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, part2, &clock, ts::ctx(&mut scenario));

        assert!(circle::get_member_cycle_paid(&circle, 1, BOB) == CONTRIBUTION_AMOUNT, 115);
        assert!(circle::get_member_cycle_owed(&circle, 1, BOB) == 0, 116);

        ts::return_shared(circle);
    };

    // Charlie deposits
    ts::next_tx(&mut scenario, CHARLIE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        let payment = coin::mint_for_testing(CONTRIBUTION_AMOUNT, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, payment, &clock, ts::ctx(&mut scenario));

        assert!(circle::vault_balance(&circle) == 3 * CONTRIBUTION_AMOUNT, 117);
        assert!(circle::is_cycle_fully_funded(&circle, 1), 118);

        ts::return_shared(circle);
    };

    // 3. Cycle 1 claim by scheduled recipient (ALICE is recipient 1)
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        assert!(circle::get_current_recipient(&circle) == ALICE, 119);

        circle::claim_cycle(&mut circle, &clock, ts::ctx(&mut scenario));

        assert!(circle::vault_balance(&circle) == 0, 120);
        assert!(circle::is_cycle_claimed(&circle, 1), 121);
        // Cycle automatically advanced to Cycle 2!
        assert!(circle::current_cycle(&circle) == 2, 122);
        assert!(circle::get_current_recipient(&circle) == BOB, 123);

        ts::return_shared(circle);
    };

    // Verify Alice received her 3 SUI pot
    ts::next_tx(&mut scenario, ALICE);
    {
        let pot = ts::take_from_sender<Coin<SUI>>(&scenario);
        assert!(coin::value(&pot) == 3 * CONTRIBUTION_AMOUNT, 124);
        coin::burn_for_testing(pot);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}



#[test]
fun test_late_contributions_and_incremental_claims() {
    let mut scenario = ts::begin(ALICE);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clock, 1000);

    let members = vector[ALICE, BOB, CHARLIE];
    let payout_order = vector[ALICE, BOB, CHARLIE];

    circle::create_circle<SUI>(
        string::utf8(b"Late Contributions & Incremental Claims Test"),
        CONTRIBUTION_AMOUNT,
        CYCLE_DURATION_MS,
        members,
        payout_order,
        ts::ctx(&mut scenario),
    );

    // Bob and Charlie accept
    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        circle::accept_circle(&mut circle, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    ts::next_tx(&mut scenario, CHARLIE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        circle::accept_circle(&mut circle, &clock, ts::ctx(&mut scenario));
        assert!(circle::status(&circle) == circle::status_active(), 301);
        ts::return_shared(circle);
    };

    // 1. Alice contributes 1 SUI on time before deadline
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        let p = coin::mint_for_testing(CONTRIBUTION_AMOUNT, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, p, &clock, ts::ctx(&mut scenario));
        assert!(circle::vault_balance(&circle) == CONTRIBUTION_AMOUNT, 302);
        ts::return_shared(circle);
    };

    // Bob and Charlie have NOT paid.
    // 2. Deadline passes! (7 days + 1000ms later)
    let deadline = 1000 + CYCLE_DURATION_MS;
    clock::set_for_testing(&mut clock, deadline + 5000);

    // Circle is NOT cancelled or refunded! It remains ACTIVE.
    // Alice (scheduled recipient) can claim whatever is in the vault (1 SUI partial pot)
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        assert!(circle::status(&circle) == circle::status_active(), 303);
        assert!(circle::current_cycle(&circle) == 1, 304);

        // Recipient claims the available 1 SUI after deadline
        circle::claim_cycle(&mut circle, &clock, ts::ctx(&mut scenario));

        assert!(circle::vault_balance(&circle) == 0, 305);
        assert!(circle::get_cycle_claimed_amount(&circle, 1) == CONTRIBUTION_AMOUNT, 306);
        // Circle does NOT advance yet because cycle is incomplete!
        assert!(circle::current_cycle(&circle) == 1, 307);
        assert!(circle::get_current_recipient(&circle) == ALICE, 308);

        ts::return_shared(circle);
    };

    // Alice burns the received 1 SUI
    ts::next_tx(&mut scenario, ALICE);
    {
        let claim1 = ts::take_from_sender<Coin<SUI>>(&scenario);
        assert!(coin::value(&claim1) == CONTRIBUTION_AMOUNT, 309);
        coin::burn_for_testing(claim1);
    };

    // 3. Bob makes a late contribution (1 SUI) after the deadline!
    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        let p_bob = coin::mint_for_testing(CONTRIBUTION_AMOUNT, ts::ctx(&mut scenario));

        // Contract accepts Bob's late contribution into cycle 1!
        circle::contribute(&mut circle, p_bob, &clock, ts::ctx(&mut scenario));

        assert!(circle::vault_balance(&circle) == CONTRIBUTION_AMOUNT, 310);
        assert!(circle::get_member_cycle_paid(&circle, 1, BOB) == CONTRIBUTION_AMOUNT, 311);
        assert!(circle::get_member_cycle_owed(&circle, 1, BOB) == 0, 312);

        ts::return_shared(circle);
    };

    // 4. Alice claims the incremental funds (Bob's 1 SUI)
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        circle::claim_cycle(&mut circle, &clock, ts::ctx(&mut scenario));

        assert!(circle::vault_balance(&circle) == 0, 313);
        assert!(circle::get_cycle_claimed_amount(&circle, 1) == 2 * CONTRIBUTION_AMOUNT, 314);
        // Cycle still does NOT advance because Charlie has not paid
        assert!(circle::current_cycle(&circle) == 1, 315);

        ts::return_shared(circle);
    };

    // Alice burns the second claim
    ts::next_tx(&mut scenario, ALICE);
    {
        let claim2 = ts::take_from_sender<Coin<SUI>>(&scenario);
        assert!(coin::value(&claim2) == CONTRIBUTION_AMOUNT, 316);
        coin::burn_for_testing(claim2);
    };

    // 5. Charlie makes his late contribution (1 SUI)
    ts::next_tx(&mut scenario, CHARLIE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        let p_charlie = coin::mint_for_testing(CONTRIBUTION_AMOUNT, ts::ctx(&mut scenario));

        circle::contribute(&mut circle, p_charlie, &clock, ts::ctx(&mut scenario));

        assert!(circle::vault_balance(&circle) == CONTRIBUTION_AMOUNT, 317);
        assert!(circle::is_cycle_fully_funded(&circle, 1), 318);

        ts::return_shared(circle);
    };

    // 6. Alice claims the final 1 SUI.
    // Now all 3 members have paid in full (3 SUI) AND all 3 SUI has been claimed!
    // The contract advances to Cycle 2!
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        circle::claim_cycle(&mut circle, &clock, ts::ctx(&mut scenario));

        assert!(circle::vault_balance(&circle) == 0, 319);
        assert!(circle::get_cycle_claimed_amount(&circle, 1) == 3 * CONTRIBUTION_AMOUNT, 320);
        assert!(circle::is_cycle_claimed(&circle, 1), 321);

        // Advanced to Cycle 2! BOB is now the recipient!
        assert!(circle::current_cycle(&circle) == 2, 322);
        assert!(circle::get_current_recipient(&circle) == BOB, 323);

        ts::return_shared(circle);
    };

    // Alice burns the third claim
    ts::next_tx(&mut scenario, ALICE);
    {
        let claim3 = ts::take_from_sender<Coin<SUI>>(&scenario);
        assert!(coin::value(&claim3) == CONTRIBUTION_AMOUNT, 324);
        coin::burn_for_testing(claim3);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}



#[test]
#[expected_failure(abort_code = 14)] // E_NOT_SCHEDULED_RECIPIENT = 14
fun test_cannot_claim_if_not_recipient() {
    let mut scenario = ts::begin(ALICE);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clock, 1000);

    let members = vector[ALICE, BOB];
    let payout_order = vector[ALICE, BOB];

    circle::create_circle<SUI>(
        string::utf8(b"Recipient Guard Test"),
        CONTRIBUTION_AMOUNT,
        CYCLE_DURATION_MS,
        members,
        payout_order,
        ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        circle::accept_circle(&mut circle, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    // Alice and Bob contribute
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        let p1 = coin::mint_for_testing(CONTRIBUTION_AMOUNT, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, p1, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };
    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        let p2 = coin::mint_for_testing(CONTRIBUTION_AMOUNT, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, p2, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    // Bob tries to claim cycle 1 (where ALICE is the scheduled recipient) -> Aborts with E_NOT_SCHEDULED_RECIPIENT (14)!
    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        circle::claim_cycle(&mut circle, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}



#[test]
#[expected_failure(abort_code = 13)] // E_CYCLE_NOT_FULLY_FUNDED = 13
fun test_cannot_claim_underfunded_before_deadline() {
    let mut scenario = ts::begin(ALICE);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clock, 1000);

    let members = vector[ALICE, BOB];
    let payout_order = vector[ALICE, BOB];

    circle::create_circle<SUI>(
        string::utf8(b"Before Deadline Guard"),
        CONTRIBUTION_AMOUNT,
        CYCLE_DURATION_MS,
        members,
        payout_order,
        ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        circle::accept_circle(&mut circle, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    // Only Alice contributes 1 SUI
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        let p1 = coin::mint_for_testing(CONTRIBUTION_AMOUNT, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, p1, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    // Before deadline, Alice tries to claim when Bob hasn't contributed -> Aborts with E_CYCLE_NOT_FULLY_FUNDED (13)!
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        circle::claim_cycle(&mut circle, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}



#[test]
#[expected_failure(abort_code = 12)] // E_EXCEEDS_OWED = 12
fun test_cannot_overpay() {
    let mut scenario = ts::begin(ALICE);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clock, 1000);

    let members = vector[ALICE, BOB];
    let payout_order = vector[ALICE, BOB];

    circle::create_circle<SUI>(
        string::utf8(b"Overpay Guard"),
        CONTRIBUTION_AMOUNT,
        CYCLE_DURATION_MS,
        members,
        payout_order,
        ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        circle::accept_circle(&mut circle, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<SUI>>(&scenario);
        // Tries to pay 2 SUI when contribution amount is 1 SUI -> Aborts with E_EXCEEDS_OWED (12)!
        let payment = coin::mint_for_testing(2 * CONTRIBUTION_AMOUNT, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, payment, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

// Test token witnesses for USDC and WAL
public struct TEST_USDC has drop {}
public struct TEST_WAL has drop {}

#[test]
fun test_multi_token_usdc_and_wal_support() {
    let mut scenario = ts::begin(ALICE);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clock, 1000);

    let members = vector[ALICE, BOB];
    let payout_order = vector[ALICE, BOB];

    // 1. USDC Testnet Circle: 0.1 USDC = 100,000 base units (6 decimals)
    let usdc_amount: u64 = 100_000;
    circle::create_circle<TEST_USDC>(
        string::utf8(b"USDC Testnet Savings Circle"),
        usdc_amount,
        CYCLE_DURATION_MS,
        members,
        payout_order,
        ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<TEST_USDC>>(&scenario);
        circle::accept_circle(&mut circle, &clock, ts::ctx(&mut scenario));
        assert!(circle::status(&circle) == circle::status_active(), 201);
        ts::return_shared(circle);
    };

    // Alice contributes 0.1 USDC
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<TEST_USDC>>(&scenario);
        let usdc_coin = coin::mint_for_testing<TEST_USDC>(usdc_amount, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, usdc_coin, &clock, ts::ctx(&mut scenario));
        assert!(circle::get_member_cycle_paid(&circle, 1, ALICE) == usdc_amount, 202);
        ts::return_shared(circle);
    };

    // Bob contributes 0.1 USDC
    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<TEST_USDC>>(&scenario);
        let usdc_coin = coin::mint_for_testing<TEST_USDC>(usdc_amount, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, usdc_coin, &clock, ts::ctx(&mut scenario));
        assert!(circle::get_member_cycle_paid(&circle, 1, BOB) == usdc_amount, 203);
        assert!(circle::is_cycle_fully_funded(&circle, 1), 204);
        assert!(circle::vault_balance(&circle) == 200_000, 205);
        ts::return_shared(circle);
    };

    // Alice claims the 0.2 USDC pot
    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<TEST_USDC>>(&scenario);
        circle::claim_cycle(&mut circle, &clock, ts::ctx(&mut scenario));
        assert!(circle::vault_balance(&circle) == 0, 206);
        ts::return_shared(circle);
    };

    // 2. WAL Testnet Circle: 1 WAL = 1,000,000,000 base units (9 decimals)
    let wal_amount: u64 = 1_000_000_000;
    circle::create_circle<TEST_WAL>(
        string::utf8(b"WAL Walrus Testnet Circle"),
        wal_amount,
        CYCLE_DURATION_MS,
        members,
        payout_order,
        ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<TEST_WAL>>(&scenario);
        circle::accept_circle(&mut circle, &clock, ts::ctx(&mut scenario));
        assert!(circle::status(&circle) == circle::status_active(), 207);
        ts::return_shared(circle);
    };

    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<TEST_WAL>>(&scenario);
        let wal_coin = coin::mint_for_testing<TEST_WAL>(wal_amount, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, wal_coin, &clock, ts::ctx(&mut scenario));
        ts::return_shared(circle);
    };

    ts::next_tx(&mut scenario, BOB);
    {
        let mut circle = ts::take_shared<Circle<TEST_WAL>>(&scenario);
        let wal_coin = coin::mint_for_testing<TEST_WAL>(wal_amount, ts::ctx(&mut scenario));
        circle::contribute(&mut circle, wal_coin, &clock, ts::ctx(&mut scenario));
        assert!(circle::vault_balance(&circle) == 2 * wal_amount, 208);
        ts::return_shared(circle);
    };

    ts::next_tx(&mut scenario, ALICE);
    {
        let mut circle = ts::take_shared<Circle<TEST_WAL>>(&scenario);
        circle::claim_cycle(&mut circle, &clock, ts::ctx(&mut scenario));
        assert!(circle::vault_balance(&circle) == 0, 209);
        ts::return_shared(circle);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}
